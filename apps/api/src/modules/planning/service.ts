import type { Database } from '@waypoint/database';
import {
  allocate,
  describeAssignment,
  InfeasiblePlanError,
  PlanningInputError,
  type TripDraft,
  validatePlan,
} from '@waypoint/planning';
import type {
  AllocationResponse,
  AutoAllocateResponse,
  CreateDeferralRequest,
  Deferral,
  MoveAllocationRequest,
  PlanInput,
  PlanningQueueResponse,
  PlanResult,
  PublishPlanResponse,
  SimulateChange,
  SimulatePlanRequest,
  SimulatePlanResponse,
  User,
  ValidatePlanRequest,
  ValidatePlanResponse,
  Violation,
} from '@waypoint/shared';
import { orderStateMachine, tripStateMachine } from '@waypoint/shared';
import type { AuditRecorder } from '../../plugins/audit.ts';
import type { OperatingClock } from '../../plugins/clock.ts';
import type { DomainEventBus, PlanningDomainEvent } from '../../plugins/domain-events.ts';
import { ApiError } from '../../plugins/errors.ts';
import { scope } from '../../plugins/rbac.ts';
import { formatColomboTimestamp } from '../orders/cutoff.ts';
import { createOrderService, type OrderService } from '../orders/service.ts';
import {
  draftsReferencing,
  loadPlanningContext,
  type PlanningContext,
  validatorInput,
} from './assemble.ts';
import {
  createPlanningRepo,
  type DraftTrip,
  type EligibleOrder,
  type PlanningDb,
  type PlanningRepo,
  type PlanningRunRow,
  type StoredTrip,
} from './repo.ts';

const STALE = 'Plan version is stale';
const PUBLISHED = 'Planning run is already published';
const MISSING_ORDER = 'Order not found';
const MISSING_VEHICLE = 'Vehicle not found';
const MISSING_RUN = 'Planning run not found';
const UNACCOUNTED = 'The plan does not account for every eligible order';

type Dispatcher = Extract<User, { role: 'dispatcher' }>;

export interface PlanningService {
  queue(user: User | null, serviceDate: string): Promise<PlanningQueueResponse>;
  autoAllocate(
    user: User | null,
    serviceDate: string,
    version: number,
  ): Promise<AutoAllocateResponse>;
  validate(user: User | null, input: ValidatePlanRequest): Promise<ValidatePlanResponse>;
  move(
    user: User | null,
    serviceDate: string,
    version: number,
    input: MoveAllocationRequest,
  ): Promise<AllocationResponse>;
  defer(user: User | null, version: number, input: CreateDeferralRequest): Promise<Deferral>;
  simulate(
    user: User | null,
    serviceDate: string,
    input: SimulatePlanRequest,
  ): Promise<SimulatePlanResponse>;
  publish(user: User | null, serviceDate: string, version: number): Promise<PublishPlanResponse>;
}

export function createPlanningService(
  db: Database,
  audit: AuditRecorder,
  events: DomainEventBus,
  clock: OperatingClock,
  repo: PlanningRepo = createPlanningRepo(),
  orders: OrderService = createOrderService(db, audit, events, clock),
): PlanningService {
  return {
    async queue(user, serviceDate) {
      const dispatcher = assertDispatcher(user);
      const depotId = requireDepot(dispatcher);
      await orders.lockConfirmedOrdersForRun(dispatcher, serviceDate);
      const context = await loadPlanningContext(
        repo,
        db,
        depotId,
        serviceDate,
        scope(dispatcher).orders,
      );
      const run = await repo.findRun(db, depotId, serviceDate);
      const history = await repo.latestDeferrals(
        db,
        context.orders.map((order) => order.outletId),
      );
      const lite = new Map(context.plan.orders.map((order) => [order.id, order]));
      const items = context.orders.map((order) => {
        const planning = lite.get(order.id);
        const outlet = context.plan.outlets[order.outletId];
        const previous = history.get(order.outletId);
        if (planning === undefined || outlet === undefined) {
          throw new ApiError('INTERNAL_ERROR', 'Planning queue is incomplete');
        }
        return {
          id: order.id,
          outletId: order.outletId,
          brand: order.brand,
          temp: order.temp,
          requestedDate: order.requestedDate,
          units: order.units,
          weightKg: order.weightKg,
          volumeM3: order.volumeM3,
          status: order.status,
          submittedAt:
            order.submittedAt === null ? null : formatColomboTimestamp(order.submittedAt),
          lockedAt: order.lockedAt === null ? null : formatColomboTimestamp(order.lockedAt),
          version: order.version,
          deferredYesterday: planning.deferredYesterday,
          daysSinceLastServed: planning.daysSinceLastServed,
          outlet: {
            id: outlet.id,
            district: outlet.district,
            depotId: outlet.depotId,
            parkingConstraint: outlet.parkingConstraint,
            window: outlet.window,
            mallWindow: outlet.mallWindow,
          },
          previousDeferral: previous
            ? {
                reasonCode: previous.reasonCode,
                type: previous.type,
                serviceDate: previous.serviceDate,
              }
            : null,
        };
      });
      return { items, total: items.length, depotId, planVersion: run?.planVersion ?? 0 };
    },

    async autoAllocate(user, serviceDate, version) {
      return withOpenRun(
        db,
        repo,
        orders,
        events,
        clock,
        user,
        serviceDate,
        version,
        async (tx, dispatcher, run, context, pending, now) => {
          const previous = await repo.listDrafts(tx, run.id);
          const result = planFromEngine(() => allocate(context.plan));
          const drafts = toDrafts(result);
          const violations = validatePlan(validatorInput(context), drafts);
          if (violations.length > 0) throw constraint(violations);
          await repo.replaceTrips(tx, run.id, storedFrom(result, 'planned'));
          const next = await bump(repo, tx, run);
          await audit.record(tx, {
            actorId: dispatcher.id,
            role: dispatcher.role,
            action: 'plan.auto_allocated',
            entityType: 'planning_run',
            entityId: run.id,
            before: { planVersion: run.planVersion, ...draftSnapshot(previous) },
            after: {
              planVersion: next.planVersion,
              deferred: result.deferred.map((item) => item.orderId),
              ...draftSnapshot(drafts),
            },
            createdAt: now,
          });
          pending.push(planningEvent('allocation.changed', dispatcher.id, now, context, run.id));
          return { ...result, planVersion: next.planVersion };
        },
      );
    },

    async validate(user, input) {
      const dispatcher = assertDispatcher(user);
      const depotId = requireDepot(dispatcher);
      if (input.depotId !== depotId) throw new ApiError('NOT_FOUND', MISSING_RUN);
      await orders.lockConfirmedOrdersForRun(dispatcher, input.serviceDate);
      const context = await loadPlanningContext(
        repo,
        db,
        depotId,
        input.serviceDate,
        scope(dispatcher).orders,
      );
      const drafts = input.trips.map((trip) => ({
        vehicleId: trip.vehicleId,
        tripNo: trip.tripNo,
        orderIds: trip.orderIds,
      }));
      assertKnownOrders(drafts, eligibleIds(context), 'missing');
      rejectSplits(drafts);
      await ensureVehicles(
        repo,
        db,
        context,
        drafts.map((trip) => trip.vehicleId),
      );
      const violations = validatePlan(
        validatorInput(context, draftsReferencing(context, drafts)),
        drafts,
      );
      if (violations.length > 0) throw constraint(violations);
      return { violations: [] };
    },

    async move(user, serviceDate, version, input) {
      return withOpenRun(
        db,
        repo,
        orders,
        events,
        clock,
        user,
        serviceDate,
        version,
        async (tx, dispatcher, run, context, pending, now) => {
          const eligible = eligibleIds(context);
          if (!eligible.has(input.orderId)) throw new ApiError('NOT_FOUND', MISSING_ORDER);
          const current = await repo.listDrafts(tx, run.id);
          assertKnownOrders(current, eligible, 'changed');
          const drafts = applyMove(current, input.orderId, input.target);
          rejectSplits(drafts);
          if (input.target !== null)
            await ensureVehicles(repo, db, context, [input.target.vehicleId]);
          const violations = validatePlan(
            validatorInput(context, draftsReferencing(context, drafts)),
            drafts,
          );
          if (violations.length > 0) throw constraint(violations);
          const result = planFromEngine(() => describeAssignment(context.plan, drafts));
          await repo.replaceTrips(tx, run.id, storedFrom(result, 'planned'));
          const next = await bump(repo, tx, run);
          await audit.record(tx, {
            actorId: dispatcher.id,
            role: dispatcher.role,
            action: 'allocation.changed',
            entityType: 'planning_run',
            entityId: run.id,
            before: { planVersion: run.planVersion, ...draftSnapshot(current) },
            after: {
              planVersion: next.planVersion,
              orderId: input.orderId,
              target: input.target,
              ...draftSnapshot(drafts),
            },
            createdAt: now,
          });
          pending.push(planningEvent('allocation.changed', dispatcher.id, now, context, run.id));
          return { ...result, planVersion: next.planVersion };
        },
      );
    },

    async defer(user, version, input) {
      return withOpenRun(
        db,
        repo,
        orders,
        events,
        clock,
        user,
        input.serviceDate,
        version,
        async (tx, dispatcher, run, context, pending, now) => {
          const order = context.orders.find((row) => row.id === input.orderId);
          if (order === undefined) throw new ApiError('NOT_FOUND', MISSING_ORDER);
          const current = await repo.listDrafts(tx, run.id);
          assertKnownOrders(current, eligibleIds(context), 'changed');
          const drafts = applyMove(current, input.orderId, null);
          rejectSplits(drafts);
          const violations = validatePlan(
            validatorInput(context, draftsReferencing(context, drafts)),
            drafts,
          );
          if (violations.length > 0) throw constraint(violations);
          const result = planFromEngine(() => describeAssignment(context.plan, drafts));
          const classified = result.deferred.find((item) => item.orderId === input.orderId);
          if (classified === undefined) {
            throw new ApiError('INTERNAL_ERROR', 'Planning engine did not defer the order');
          }
          if (classified.reason !== input.reasonCode || classified.type !== input.type) {
            throw new ApiError('CONSTRAINT_VIOLATION', classified.explain, [
              {
                rule: classified.reason,
                orderId: classified.orderId,
                detail: classified.explain,
              },
            ]);
          }
          await repo.replaceTrips(tx, run.id, storedFrom(result, 'planned'));
          const note =
            input.note === undefined ? classified.explain : `${classified.explain} ${input.note}`;
          const ids = await repo.insertDeferrals(tx, run.id, [
            {
              orderId: order.id,
              reasonCode: classified.reason,
              type: classified.type,
              note,
              actorId: dispatcher.id,
              createdAt: now,
            },
          ]);
          const deferralId = ids[0];
          if (deferralId === undefined) {
            throw new ApiError('INTERNAL_ERROR', 'Deferral was not created');
          }
          orderStateMachine.assertTransition('confirmed', 'deferred');
          await repo.markOrders(tx, [{ id: order.id, status: 'deferred' }]);
          const managers = await repo.listStoreManagers(tx, [order.outletId]);
          await repo.insertNotifications(
            tx,
            managers.map((manager) => ({
              recipientId: manager.id,
              type: 'order_deferred' as const,
              priority: 'high' as const,
              entityType: 'order' as const,
              entityId: order.id,
              createdAt: now,
            })),
          );
          const next = await bump(repo, tx, run);
          await audit.record(tx, {
            actorId: dispatcher.id,
            role: dispatcher.role,
            action: 'order.deferred',
            entityType: 'order',
            entityId: order.id,
            before: {
              status: 'confirmed',
              planVersion: run.planVersion,
              ...draftSnapshot(current),
            },
            after: {
              status: 'deferred',
              planVersion: next.planVersion,
              reasonCode: classified.reason,
              type: classified.type,
              explain: classified.explain,
              runId: run.id,
            },
            createdAt: now,
          });
          if (!sameDrafts(current, drafts)) {
            pending.push(planningEvent('allocation.changed', dispatcher.id, now, context, run.id));
          }
          pending.push({
            ...planningEvent('order.deferred', dispatcher.id, now, context, run.id),
            type: 'order.deferred',
            orderId: order.id,
            outletId: order.outletId,
          });
          return {
            id: deferralId,
            orderId: order.id,
            runId: run.id,
            reasonCode: classified.reason,
            type: classified.type,
            note,
            actorId: dispatcher.id,
            createdAt: formatColomboTimestamp(now),
          };
        },
      );
    },

    async simulate(user, serviceDate, input) {
      const dispatcher = assertDispatcher(user);
      const depotId = requireDepot(dispatcher);
      await orders.lockConfirmedOrdersForRun(dispatcher, serviceDate);
      const context = await loadPlanningContext(
        repo,
        db,
        depotId,
        serviceDate,
        scope(dispatcher).orders,
      );
      const baseline = planFromEngine(() => allocate(context.plan));
      const scenario = planFromEngine(() => allocate(applyScenario(context, input.changes)));
      return { baseline: baseline.metrics, scenario: scenario.metrics };
    },

    async publish(user, serviceDate, version) {
      return withOpenRun(
        db,
        repo,
        orders,
        events,
        clock,
        user,
        serviceDate,
        version,
        async (tx, dispatcher, run, context, pending, now) => {
          const drafts = await repo.listDrafts(tx, run.id);
          assertKnownOrders(drafts, eligibleIds(context), 'changed');
          const violations = validatePlan(
            validatorInput(context, draftsReferencing(context, drafts)),
            drafts,
          );
          if (violations.length > 0) throw constraint(violations);
          const result = planFromEngine(() => describeAssignment(context.plan, drafts));
          assertAccounted(context.orders, result);
          const locked = await repo.lockOrders(
            tx,
            context.orders.map((order) => order.id),
          );
          for (const order of context.orders) {
            const status = locked.get(order.id);
            // Confirmed for this run, or deferred by an earlier run and carried into this one.
            if (status !== 'confirmed' && status !== 'deferred') {
              throw new ApiError('VERSION_CONFLICT', 'Order changed during publish');
            }
          }
          const stored = storedFrom(result, 'published');
          const tripIds = await repo.replaceTrips(tx, run.id, stored);
          await repo.insertDeferrals(
            tx,
            run.id,
            result.deferred.map((item) => ({
              orderId: item.orderId,
              reasonCode: item.reason,
              type: item.type,
              note: item.explain,
              actorId: dispatcher.id,
              createdAt: now,
            })),
          );
          await repo.insertFuel(
            tx,
            stored.map((trip, index) => {
              const tripId = tripIds[index];
              if (tripId === undefined)
                throw new ApiError('INTERNAL_ERROR', 'Trip was not created');
              return {
                vehicleId: trip.vehicleId,
                isoYear: context.isoYear,
                isoWeek: context.isoWeek,
                tripId,
                litres: trip.litres,
              };
            }),
          );
          const served = new Set(stored.flatMap((trip) => trip.stops.map((stop) => stop.orderId)));
          orderStateMachine.assertTransition('confirmed', 'allocated');
          orderStateMachine.assertTransition('confirmed', 'deferred');
          orderStateMachine.assertTransition('deferred', 'allocated');
          await repo.markOrders(tx, [
            ...[...served].map((id) => ({ id, status: 'allocated' as const })),
            ...result.deferred.map((item) => ({ id: item.orderId, status: 'deferred' as const })),
          ]);
          await notifyPublished(repo, tx, context, result, stored, tripIds, now);
          await audit.record(tx, {
            actorId: dispatcher.id,
            role: dispatcher.role,
            action: 'plan.published',
            entityType: 'planning_run',
            entityId: run.id,
            before: { status: 'open', planVersion: run.planVersion },
            after: {
              status: 'published',
              planVersion: run.planVersion + 1,
              servedOrderIds: [...served],
              deferredOrderIds: result.deferred.map((item) => item.orderId),
            },
            createdAt: now,
          });
          for (const item of result.deferred) {
            await audit.record(tx, {
              actorId: dispatcher.id,
              role: dispatcher.role,
              action: 'order.deferred',
              entityType: 'order',
              entityId: item.orderId,
              after: {
                reasonCode: item.reason,
                type: item.type,
                explain: item.explain,
                runId: run.id,
              },
              createdAt: now,
            });
          }
          const published = await repo.markPublished(
            tx,
            run.id,
            run.planVersion,
            now,
            dispatcher.id,
          );
          if (published === null) throw new ApiError('VERSION_CONFLICT', STALE);
          pending.push(planningEvent('plan.published', dispatcher.id, now, context, run.id));
          for (const item of result.deferred) {
            const order = context.orders.find((row) => row.id === item.orderId);
            const event: PlanningDomainEvent = {
              ...planningEvent('order.deferred', dispatcher.id, now, context, run.id),
              type: 'order.deferred',
            };
            if (order !== undefined) {
              event.orderId = order.id;
              event.outletId = order.outletId;
            }
            pending.push(event);
          }
          if (published.publishedAt === null) {
            throw new ApiError('INTERNAL_ERROR', 'Published plan has no timestamp');
          }
          return {
            planVersion: published.planVersion,
            publishedAt: formatColomboTimestamp(published.publishedAt),
          };
        },
      );
    },
  };
}

async function withOpenRun<T>(
  db: Database,
  repo: PlanningRepo,
  orders: OrderService,
  events: DomainEventBus,
  clock: OperatingClock,
  user: User | null,
  serviceDate: string,
  version: number,
  work: (
    tx: PlanningDb,
    dispatcher: Dispatcher,
    run: PlanningRunRow,
    context: PlanningContext,
    pending: PlanningDomainEvent[],
    now: Date,
  ) => Promise<T>,
): Promise<T> {
  const dispatcher = assertDispatcher(user);
  const depotId = requireDepot(dispatcher);
  // SYSTEM_DESIGN §2.1: orders submitted before the 4 PM cutoff become Confirmed and join
  // the run. The orders module owns that transition; planning only triggers it.
  await orders.lockConfirmedOrdersForRun(dispatcher, serviceDate);
  const now = clock.now();
  const pending: PlanningDomainEvent[] = [];
  const result = await db.transaction(async (tx) => {
    const run = await repo.lockRun(tx, depotId, serviceDate);
    if (run.status !== 'open') throw new ApiError('VERSION_CONFLICT', PUBLISHED);
    if (run.planVersion !== version) throw new ApiError('VERSION_CONFLICT', STALE);
    const context = await loadPlanningContext(
      repo,
      tx,
      depotId,
      serviceDate,
      scope(dispatcher).orders,
    );
    return work(tx, dispatcher, run, context, pending, now);
  });
  for (const event of pending) events.publish(event);
  return result;
}

function assertDispatcher(user: User | null): Dispatcher {
  if (user === null) throw new ApiError('UNAUTHENTICATED', 'Sign in required');
  if (user.role !== 'dispatcher') {
    throw new ApiError('FORBIDDEN', 'You do not have access to this action');
  }
  return user;
}

function requireDepot(user: Dispatcher): string {
  if (user.depotId === null) throw new ApiError('NOT_FOUND', MISSING_RUN);
  return user.depotId;
}

function eligibleIds(context: PlanningContext): Set<string> {
  return new Set(context.orders.map((order) => order.id));
}

function assertKnownOrders(
  drafts: readonly TripDraft[],
  eligible: ReadonlySet<string>,
  kind: 'missing' | 'changed',
): void {
  for (const draft of drafts) {
    for (const orderId of draft.orderIds) {
      if (eligible.has(orderId)) continue;
      if (kind === 'missing') throw new ApiError('NOT_FOUND', MISSING_ORDER);
      throw new ApiError('VERSION_CONFLICT', 'Order changed during planning');
    }
  }
}

function rejectSplits(drafts: readonly TripDraft[]): void {
  const seen = new Set<string>();
  for (const draft of drafts) {
    for (const orderId of draft.orderIds) {
      if (seen.has(orderId)) {
        throw new ApiError('VALIDATION_ERROR', 'An order cannot be split across trips');
      }
      seen.add(orderId);
    }
  }
}

function applyMove(
  drafts: readonly DraftTrip[],
  orderId: string,
  target: MoveAllocationRequest['target'],
): TripDraft[] {
  const next: TripDraft[] = [];
  for (const draft of drafts) {
    const orderIds = draft.orderIds.filter((id) => id !== orderId);
    if (orderIds.length === 0) continue;
    next.push({ vehicleId: draft.vehicleId, tripNo: draft.tripNo, orderIds });
  }
  if (target === null) return next;
  const index = next.findIndex(
    (draft) => draft.vehicleId === target.vehicleId && draft.tripNo === target.tripNo,
  );
  const existing = index >= 0 ? next[index] : undefined;
  if (existing) {
    next[index] = { ...existing, orderIds: [...existing.orderIds, orderId] };
    return next;
  }
  next.push({ vehicleId: target.vehicleId, tripNo: target.tripNo, orderIds: [orderId] });
  return next;
}

async function ensureVehicles(
  repo: PlanningRepo,
  db: PlanningDb,
  context: PlanningContext,
  ids: readonly string[],
): Promise<void> {
  const missing = [...new Set(ids)].filter((id) => !context.vehiclesById.has(id));
  if (missing.length === 0) return;
  const rows = await repo.listVehiclesByIds(db, missing);
  const found = new Set(rows.map((row) => row.id));
  for (const id of missing) {
    if (!found.has(id)) throw new ApiError('NOT_FOUND', MISSING_VEHICLE);
  }
  const used = await repo.fuelUsedLitres(db, missing, context.isoYear, context.isoWeek);
  const availability = await repo.listAvailability(db, missing, context.serviceDate);
  for (const row of rows) {
    context.vehiclesById.set(row.id, row);
    context.availability[row.id] = availability.get(row.id) ?? 'available';
    context.plan.fuelRemainingL[row.id] = row.weeklyFuelQuotaL - (used.get(row.id) ?? 0);
  }
}

function assertAccounted(orders: readonly EligibleOrder[], result: PlanResult): void {
  const remaining = new Set(orders.map((order) => order.id));
  for (const trip of result.trips) {
    for (const stop of trip.stops) {
      if (!remaining.delete(stop.orderId)) throw new ApiError('CONSTRAINT_VIOLATION', UNACCOUNTED);
    }
  }
  for (const item of result.deferred) {
    if (!remaining.delete(item.orderId)) throw new ApiError('CONSTRAINT_VIOLATION', UNACCOUNTED);
  }
  if (remaining.size > 0) throw new ApiError('CONSTRAINT_VIOLATION', UNACCOUNTED);
}

function storedFrom(result: PlanResult, status: 'planned' | 'published'): StoredTrip[] {
  if (status === 'published') tripStateMachine.assertTransition('planned', 'published');
  return result.trips.map((trip) => ({
    vehicleId: trip.vehicleId,
    tripNo: trip.tripNo,
    brand: trip.brand,
    district: trip.district,
    status,
    version: status === 'published' ? 1 : 0,
    plannedMinutes: trip.minutes,
    plannedKm: trip.km,
    litres: trip.litres,
    stops: trip.stops.map((stop) => ({
      orderId: stop.orderId,
      seq: stop.seq,
      plannedArrival: arrivalDate(stop.plannedArrival),
    })),
  }));
}

function toDrafts(result: PlanResult): TripDraft[] {
  return result.trips.map((trip) => ({
    vehicleId: trip.vehicleId,
    tripNo: trip.tripNo,
    orderIds: trip.stops.map((stop) => stop.orderId),
  }));
}

async function bump(
  repo: PlanningRepo,
  db: PlanningDb,
  run: PlanningRunRow,
): Promise<PlanningRunRow> {
  const next = await repo.bumpVersion(db, run.id, run.planVersion);
  if (next === null) throw new ApiError('VERSION_CONFLICT', STALE);
  return next;
}

async function notifyPublished(
  repo: PlanningRepo,
  db: PlanningDb,
  context: PlanningContext,
  result: PlanResult,
  stored: readonly StoredTrip[],
  tripIds: readonly string[],
  now: Date,
): Promise<void> {
  const outletIds: string[] = [];
  for (const item of result.deferred) {
    const outletId = context.orders.find((order) => order.id === item.orderId)?.outletId;
    if (outletId !== undefined && !outletIds.includes(outletId)) outletIds.push(outletId);
  }
  const loaders = await repo.listUserIds(db, { role: 'loader', depotId: context.depotId });
  const drivers = await repo.listUserIds(db, {
    role: 'driver',
    vehicleIds: stored.map((trip) => trip.vehicleId),
  });
  const managers = await repo.listStoreManagers(db, outletIds);
  const notes: Parameters<PlanningRepo['insertNotifications']>[1][number][] = [];
  for (const loader of loaders) {
    if (tripIds.length === 0) {
      const orderId = result.deferred[0]?.orderId;
      if (orderId !== undefined) {
        notes.push({
          recipientId: loader.id,
          type: 'plan_published',
          priority: 'high',
          entityType: 'order',
          entityId: orderId,
          createdAt: now,
        });
      }
      continue;
    }
    for (const tripId of tripIds) {
      notes.push({
        recipientId: loader.id,
        type: 'plan_published',
        priority: 'high',
        entityType: 'trip',
        entityId: tripId,
        createdAt: now,
      });
    }
  }
  for (const driver of drivers) {
    stored.forEach((trip, index) => {
      const tripId = tripIds[index];
      if (tripId === undefined || driver.vehicleId !== trip.vehicleId) return;
      notes.push({
        recipientId: driver.id,
        type: 'plan_published',
        priority: 'high',
        entityType: 'trip',
        entityId: tripId,
        createdAt: now,
      });
    });
  }
  for (const item of result.deferred) {
    const outletId = context.orders.find((order) => order.id === item.orderId)?.outletId;
    if (outletId === undefined) continue;
    for (const manager of managers) {
      if (manager.outletId !== outletId) continue;
      notes.push({
        recipientId: manager.id,
        type: 'order_deferred',
        priority: 'high',
        entityType: 'order',
        entityId: item.orderId,
        createdAt: now,
      });
    }
  }
  await repo.insertNotifications(db, notes);
}

function planningEvent(
  type: PlanningDomainEvent['type'],
  actorId: string,
  now: Date,
  context: PlanningContext,
  runId: string,
): PlanningDomainEvent {
  return {
    type,
    actorId,
    occurredAt: formatColomboTimestamp(now),
    depotId: context.depotId,
    serviceDate: context.serviceDate,
    runId,
  };
}

function sameDrafts(left: readonly TripDraft[], right: readonly TripDraft[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((trip, index) => {
    const other = right[index];
    if (other === undefined) return false;
    return (
      trip.vehicleId === other.vehicleId &&
      trip.tripNo === other.tripNo &&
      trip.orderIds.length === other.orderIds.length &&
      trip.orderIds.every((orderId, stop) => orderId === other.orderIds[stop])
    );
  });
}

function draftSnapshot(drafts: readonly TripDraft[]): Record<string, unknown> {
  return {
    trips: drafts.map((trip) => ({
      vehicleId: trip.vehicleId,
      tripNo: trip.tripNo,
      orderIds: [...trip.orderIds],
    })),
  };
}

function constraint(violations: readonly Violation[]): ApiError {
  const first = violations[0];
  const message =
    first === undefined
      ? 'The plan breaks a hard constraint'
      : violations.length === 1
        ? first.detail
        : `${first.detail} (+${violations.length - 1} more)`;
  return new ApiError('CONSTRAINT_VIOLATION', message, violations);
}

function planFromEngine(run: () => PlanResult): PlanResult {
  try {
    return run();
  } catch (error) {
    if (error instanceof InfeasiblePlanError) throw constraint(error.violations);
    if (error instanceof PlanningInputError) {
      if (error.message.startsWith('Unknown order')) throw new ApiError('NOT_FOUND', MISSING_ORDER);
      if (error.message.startsWith('Unknown vehicle')) {
        throw new ApiError('NOT_FOUND', MISSING_VEHICLE);
      }
      if (error.message.includes('split')) {
        throw new ApiError('VALIDATION_ERROR', 'An order cannot be split across trips');
      }
      if (error.message.startsWith('Duplicate trip')) {
        throw new ApiError('VALIDATION_ERROR', 'A vehicle trip is listed more than once');
      }
      const wrapped = new ApiError('INTERNAL_ERROR', 'Planning input is incomplete');
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }
}

function applyScenario(context: PlanningContext, changes: readonly SimulateChange[]): PlanInput {
  const used = new Set<string>([
    ...context.plan.vehicles.map((vehicle) => vehicle.id),
    ...context.vehiclesById.keys(),
  ]);
  const next = clonePlan(context.plan);
  for (const change of changes) {
    if (change.type === 'vehicle_unavailable') {
      next.vehicles = next.vehicles.filter((vehicle) => vehicle.id !== change.vehicleId);
      const fuelRemainingL = { ...next.fuelRemainingL };
      delete fuelRemainingL[change.vehicleId];
      next.fuelRemainingL = fuelRemainingL;
      continue;
    }
    if (change.type === 'extra_reefer') {
      const template =
        next.vehicles.find((vehicle) => vehicle.temp === 'reefer') ?? next.vehicles[0];
      if (template === undefined) {
        throw new ApiError(
          'VALIDATION_ERROR',
          'No vehicle is available to clone as an extra reefer',
        );
      }
      const id = spareVehicleId(used);
      used.add(id);
      const remaining = next.fuelRemainingL[template.id] ?? 0;
      next.vehicles = [
        ...next.vehicles,
        { ...template, id, temp: 'reefer', depotId: next.depotId },
      ];
      next.fuelRemainingL = { ...next.fuelRemainingL, [id]: remaining };
      continue;
    }
    next.orders = next.orders.map((order) =>
      order.brand === 'Fresh'
        ? {
            ...order,
            weightKg: order.weightKg * change.factor,
            volumeM3: order.volumeM3 * change.factor,
          }
        : order,
    );
  }
  return next;
}

function clonePlan(input: PlanInput): PlanInput {
  return {
    serviceDate: input.serviceDate,
    depotId: input.depotId,
    orders: input.orders.map((order) => ({ ...order })),
    vehicles: input.vehicles.map((vehicle) => ({ ...vehicle })),
    outlets: input.outlets,
    districtTravel: input.districtTravel,
    serviceAllowance: input.serviceAllowance,
    fuelRemainingL: { ...input.fuelRemainingL },
    policy: input.policy,
  };
}

function spareVehicleId(used: ReadonlySet<string>): string {
  for (let number = 1; number <= 999; number += 1) {
    const id = `VEH${number.toString().padStart(3, '0')}`;
    if (!used.has(id)) return id;
  }
  throw new ApiError('VALIDATION_ERROR', 'No spare vehicle id for an extra reefer');
}

function arrivalDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError('INTERNAL_ERROR', 'Planned arrival is invalid');
  }
  return parsed;
}
