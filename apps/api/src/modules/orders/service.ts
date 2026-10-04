import type { Database } from '@waypoint/database';
import type {
  CreateOrderRequest,
  ListOrdersQuery,
  Order,
  OrderListResponse,
  UpdateOrderRequest,
  User,
} from '@waypoint/shared';
import { notificationPriorityByType, orderStateMachine } from '@waypoint/shared';
import type { SQL } from 'drizzle-orm';
import type { AuditRecorder } from '../../plugins/audit.ts';
import type { OperatingClock } from '../../plugins/clock.ts';
import type { DomainEvent, DomainEventBus, OrderDomainEvent } from '../../plugins/domain-events.ts';
import { ApiError } from '../../plugins/errors.ts';
import { scope } from '../../plugins/rbac.ts';
import {
  colomboCutoffReached,
  colomboDate,
  formatColomboTimestamp,
  isAtOrAfterCutoff,
} from './cutoff.ts';
import {
  createOrderRepo,
  type OrderDb,
  type OrderFieldChanges,
  type OrderListFilter,
  type OrderRepo,
  type OrderSlot,
} from './repo.ts';
import { type OrderRow, orderSnapshot, toOrder } from './serialize.ts';

const MISSING = 'Order not found';
const STALE = 'Order version is stale';
const LOCKED = 'Order is locked and cannot be changed';
const CUTOFF = 'The 4:00 PM cutoff has passed';

export interface OrderService {
  list(user: User | null, query: ListOrdersQuery): Promise<OrderListResponse>;
  get(user: User | null, id: string): Promise<Order>;
  create(user: User | null, input: CreateOrderRequest): Promise<Order>;
  update(user: User | null, id: string, version: number, input: UpdateOrderRequest): Promise<Order>;
  cancel(user: User | null, id: string, version: number): Promise<Order>;
  lockConfirmedOrdersForRun(actor: User, serviceDate: string): Promise<Order[]>;
}

export function createOrderService(
  db: Database,
  audit: AuditRecorder,
  events: DomainEventBus,
  clock: OperatingClock,
  repo: OrderRepo = createOrderRepo(),
): OrderService {
  return {
    async list(user, query) {
      const reader = assertReader(user);
      const rows = await repo.list(db, scope(reader).orders, listFilter(query));
      const items = rows.map(toOrder);
      return { items, total: items.length };
    },

    async get(user, id) {
      const reader = assertReader(user);
      const row = await repo.findForUserScope(db, id, scope(reader).orders, false);
      if (row === null) throw new ApiError('NOT_FOUND', MISSING);
      return toOrder(row);
    },

    async create(user, input) {
      const manager = assertStoreManager(user);
      const now = clock.now();
      const pending: DomainEvent[] = [];
      const order = await db.transaction(async (tx) => {
        const outlet = await repo.findOutlet(tx, manager.outletId);
        if (outlet === null) throw new ApiError('NOT_FOUND', 'Outlet not found');
        orderStateMachine.assertTransition('draft', 'submitted');
        const assigned = await assignServiceDate(repo, tx, input.requestedDate, now);
        const slot: OrderSlot = {
          outletId: outlet.id,
          requestedDate: assigned.serviceDate,
          temp: input.temp,
        };
        await lockSlots(repo, tx, [slot]);
        await rejectDuplicate(repo, tx, slot);
        const row = await repo.create(tx, {
          outletId: outlet.id,
          brand: outlet.brand,
          temp: input.temp,
          requestedDate: assigned.serviceDate,
          units: input.units,
          weightKg: input.weightKg,
          volumeM3: input.volumeM3,
          submittedAt: now,
        });
        const created = toOrder(row);
        const after = orderSnapshot(created);
        if (assigned.held) {
          after.reason = 'Held for the following run after the 4:00 PM cutoff';
          after.requestedFor = input.requestedDate;
        }
        await audit.record(tx, {
          actorId: manager.id,
          role: manager.role,
          action: 'order.created',
          entityType: 'order',
          entityId: created.id,
          after,
          createdAt: now,
        });
        pending.push(domainEvent('order.submitted', created, manager.id, now));
        return created;
      });
      publish(events, pending);
      return order;
    },

    async update(user, id, version, input) {
      const manager = assertStoreManager(user);
      const now = clock.now();
      const pending: DomainEvent[] = [];
      const order = await db.transaction(async (tx) => {
        const current = await lockedOrder(repo, tx, id, scope(manager).orders, version);
        await assertMutable(repo, tx, current, now);
        const changes = fieldChanges(input);
        // A saved draft is sent the first time the store manager saves it (FR-ORD-002).
        const submitting = current.status === 'draft';
        if (submitting) {
          orderStateMachine.assertTransition('draft', 'submitted');
          changes.submittedAt = now;
        }
        const nextDate = changes.requestedDate ?? current.requestedDate;
        const nextTemp = changes.temp ?? current.temp;
        if (
          changes.requestedDate !== undefined &&
          changes.requestedDate !== current.requestedDate
        ) {
          await assertOpenServiceDate(repo, tx, changes.requestedDate, now);
        }
        const slot: OrderSlot = {
          outletId: current.outletId,
          requestedDate: nextDate,
          temp: nextTemp,
        };
        await lockSlots(repo, tx, [
          { outletId: current.outletId, requestedDate: current.requestedDate, temp: current.temp },
          slot,
        ]);
        await rejectDuplicate(repo, tx, slot, current.id);
        const row = await repo.update(tx, current.id, current.version, changes);
        if (row === null) throw await conflictOrMissing(repo, tx, current.id);
        const updated = toOrder(row);
        await audit.record(tx, {
          actorId: manager.id,
          role: manager.role,
          action: submitting ? 'order.submitted' : 'order.edited',
          entityType: 'order',
          entityId: updated.id,
          before: orderSnapshot(toOrder(current)),
          after: orderSnapshot(updated),
          createdAt: now,
        });
        pending.push(
          domainEvent(submitting ? 'order.submitted' : 'order.changed', updated, manager.id, now),
        );
        return updated;
      });
      publish(events, pending);
      return order;
    },

    async cancel(user, id, version) {
      const manager = assertStoreManager(user);
      const now = clock.now();
      const pending: DomainEvent[] = [];
      const order = await db.transaction(async (tx) => {
        const current = await lockedOrder(repo, tx, id, scope(manager).orders, version);
        await assertMutable(repo, tx, current, now);
        if (!orderStateMachine.canTransition(current.status, 'cancelled')) {
          throw new ApiError('CUTOFF_PASSED', LOCKED);
        }
        const row = await repo.markCancelled(tx, current.id, current.version);
        if (row === null) throw await conflictOrMissing(repo, tx, current.id);
        const cancelled = toOrder(row);
        await audit.record(tx, {
          actorId: manager.id,
          role: manager.role,
          action: 'order.cancelled',
          entityType: 'order',
          entityId: cancelled.id,
          before: orderSnapshot(toOrder(current)),
          after: orderSnapshot(cancelled),
          createdAt: now,
        });
        pending.push(domainEvent('order.cancelled', cancelled, manager.id, now));
        return cancelled;
      });
      publish(events, pending);
      return order;
    },

    async lockConfirmedOrdersForRun(actor, serviceDate) {
      if (actor.role !== 'dispatcher') {
        throw new ApiError('FORBIDDEN', 'You do not have access to this action');
      }
      const now = clock.now();
      const day = await repo.findCalendarDay(db, serviceDate);
      if (day === null || !day.isOperating) {
        throw new ApiError('VALIDATION_ERROR', 'Service date is not an operating day');
      }
      const previous = await repo.previousOperatingDate(db, serviceDate);
      if (previous === null) {
        throw new ApiError('VALIDATION_ERROR', 'Service date has no previous operating day');
      }
      if (!isAtOrAfterCutoff(now, previous)) return [];

      const pending: DomainEvent[] = [];
      const locked: Order[] = [];
      await db.transaction(async (tx) => {
        const rows = await repo.listSubmittedForServiceDate(tx, serviceDate, scope(actor).orders);
        for (const row of rows) {
          if (row.lockedAt !== null || !orderStateMachine.canTransition(row.status, 'confirmed')) {
            continue;
          }
          const before = toOrder(row);
          const updated = await repo.markConfirmed(tx, row.id, row.version, now);
          if (updated === null) throw await conflictOrMissing(repo, tx, row.id);
          const confirmed = toOrder(updated);
          const after = orderSnapshot(confirmed);
          after.reason = '4:00 PM Asia/Colombo cutoff';
          await audit.record(tx, {
            actorId: actor.id,
            role: actor.role,
            action: 'order.confirmed',
            entityType: 'order',
            entityId: confirmed.id,
            before: orderSnapshot(before),
            after,
            createdAt: now,
          });
          pending.push(domainEvent('order.confirmed', confirmed, actor.id, now));
          locked.push(confirmed);
        }
        const outletIds = [...new Set(locked.map((order) => order.outletId))];
        const managers = await repo.listStoreManagers(tx, outletIds);
        const notes: Parameters<OrderRepo['insertNotifications']>[1][number][] = [];
        for (const order of locked) {
          for (const manager of managers) {
            if (manager.outletId !== order.outletId) continue;
            notes.push({
              recipientId: manager.id,
              type: 'order_confirmed',
              priority: notificationPriorityByType.order_confirmed,
              entityType: 'order',
              entityId: order.id,
              createdAt: now,
            });
          }
        }
        await repo.insertNotifications(tx, notes);
      });
      publish(events, pending);
      return locked;
    },
  };
}

function assertReader(user: User | null): User {
  if (user === null) throw new ApiError('UNAUTHENTICATED', 'Sign in required');
  if (user.role !== 'dispatcher' && user.role !== 'store_manager') {
    throw new ApiError('FORBIDDEN', 'You do not have access to this action');
  }
  return user;
}

function assertStoreManager(user: User | null): Extract<User, { role: 'store_manager' }> {
  if (user === null) throw new ApiError('UNAUTHENTICATED', 'Sign in required');
  if (user.role !== 'store_manager') {
    throw new ApiError('FORBIDDEN', 'You do not have access to this action');
  }
  return user;
}

function listFilter(query: ListOrdersQuery): OrderListFilter {
  const filter: OrderListFilter = {};
  if (query.status !== undefined) filter.status = query.status;
  if (query.requestedDate !== undefined) filter.requestedDate = query.requestedDate;
  if (query.outletId !== undefined) filter.outletId = query.outletId;
  return filter;
}

function fieldChanges(input: UpdateOrderRequest): OrderFieldChanges {
  const changes: OrderFieldChanges = {};
  if (input.requestedDate !== undefined) changes.requestedDate = input.requestedDate;
  if (input.temp !== undefined) changes.temp = input.temp;
  if (input.units !== undefined) changes.units = input.units;
  if (input.weightKg !== undefined) changes.weightKg = input.weightKg;
  if (input.volumeM3 !== undefined) changes.volumeM3 = input.volumeM3;
  return changes;
}

async function assignServiceDate(
  repo: OrderRepo,
  db: OrderDb,
  requestedDate: string,
  now: Date,
): Promise<{ serviceDate: string; held: boolean }> {
  await assertOperatingDay(repo, db, requestedDate);
  const eligible = await nextEligibleServiceDate(repo, db, now);
  if (requestedDate < eligible) return { serviceDate: eligible, held: true };
  return { serviceDate: requestedDate, held: false };
}

async function assertOpenServiceDate(
  repo: OrderRepo,
  db: OrderDb,
  requestedDate: string,
  now: Date,
): Promise<void> {
  await assertOperatingDay(repo, db, requestedDate);
  const eligible = await nextEligibleServiceDate(repo, db, now);
  if (requestedDate < eligible) throw new ApiError('CUTOFF_PASSED', CUTOFF);
}

async function assertOperatingDay(repo: OrderRepo, db: OrderDb, date: string): Promise<void> {
  const day = await repo.findCalendarDay(db, date);
  if (day === null) {
    throw new ApiError('VALIDATION_ERROR', 'Requested date is not on the calendar');
  }
  if (!day.isOperating) {
    throw new ApiError('VALIDATION_ERROR', 'Requested date is not an operating day');
  }
}

export async function nextEligibleServiceDate(
  repo: OrderRepo,
  db: OrderDb,
  now: Date,
): Promise<string> {
  const today = colomboDate(now);
  const todayRow = await repo.findCalendarDay(db, today);
  if (todayRow === null) {
    throw new ApiError('VALIDATION_ERROR', 'Operating date is not on the calendar');
  }
  const upcoming = await repo.nextOperatingDate(db, today);
  if (upcoming === null) {
    throw new ApiError('VALIDATION_ERROR', 'No upcoming operating day is on the calendar');
  }
  // Before 16:00 on an operating day the next run is still open. Otherwise it has closed.
  if (todayRow.isOperating && !colomboCutoffReached(now)) return upcoming;
  const following = await repo.nextOperatingDate(db, upcoming);
  if (following === null) {
    throw new ApiError('VALIDATION_ERROR', 'No following operating day is on the calendar');
  }
  return following;
}

async function assertMutable(
  repo: OrderRepo,
  db: OrderDb,
  row: OrderRow,
  now: Date,
): Promise<void> {
  if (!orderStateMachine.canTransition(row.status, 'cancelled') || row.lockedAt !== null) {
    throw new ApiError('CUTOFF_PASSED', LOCKED);
  }
  const previous = await repo.previousOperatingDate(db, row.requestedDate);
  if (previous === null || isAtOrAfterCutoff(now, previous)) {
    throw new ApiError('CUTOFF_PASSED', CUTOFF);
  }
}

async function lockedOrder(
  repo: OrderRepo,
  db: OrderDb,
  id: string,
  userScope: SQL,
  version: number,
): Promise<OrderRow> {
  const row = await repo.findForUserScope(db, id, userScope, true);
  if (row === null) throw new ApiError('NOT_FOUND', MISSING);
  if (row.version !== version) throw new ApiError('VERSION_CONFLICT', STALE);
  return row;
}

async function rejectDuplicate(
  repo: OrderRepo,
  db: OrderDb,
  slot: OrderSlot,
  excludeId?: string,
): Promise<void> {
  const existing = await repo.findActiveDuplicate(db, slot, excludeId);
  if (existing === null) return;
  throw new ApiError(
    'VALIDATION_ERROR',
    `This outlet already has a ${slot.temp} order for ${slot.requestedDate}`,
  );
}

async function lockSlots(repo: OrderRepo, db: OrderDb, slots: OrderSlot[]): Promise<void> {
  const unique = new Map<string, OrderSlot>();
  for (const slot of slots) unique.set(slotKey(slot), slot);
  const ordered = [...unique.values()].sort((left, right) =>
    slotKey(left).localeCompare(slotKey(right)),
  );
  for (const slot of ordered) await repo.lockOrderSlot(db, slot);
}

function slotKey(slot: OrderSlot): string {
  return `${slot.outletId}|${slot.requestedDate}|${slot.temp}`;
}

async function conflictOrMissing(repo: OrderRepo, db: OrderDb, id: string): Promise<ApiError> {
  const row = await repo.findById(db, id);
  if (row === null) return new ApiError('NOT_FOUND', MISSING);
  return new ApiError('VERSION_CONFLICT', STALE);
}

function domainEvent(
  type: OrderDomainEvent['type'],
  order: Order,
  actorId: string,
  now: Date,
): OrderDomainEvent {
  return {
    type,
    orderId: order.id,
    outletId: order.outletId,
    actorId,
    occurredAt: formatColomboTimestamp(now),
  };
}

function publish(events: DomainEventBus, pending: DomainEvent[]): void {
  for (const event of pending) events.publish(event);
}
