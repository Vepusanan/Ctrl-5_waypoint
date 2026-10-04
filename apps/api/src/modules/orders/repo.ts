import type { Database } from '@waypoint/database';
import { calendarDays, notifications, orders, outlets, users } from '@waypoint/database';
import type {
  EntityType,
  NotificationPriority,
  NotificationType,
  OrderStatus,
  TemperatureRequirement,
} from '@waypoint/shared';
import { and, asc, desc, eq, gt, inArray, lt, ne, type SQL, sql } from 'drizzle-orm';
import { ApiError } from '../../plugins/errors.ts';
import type { OrderRow } from './serialize.ts';

export type OrderDb = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export interface OrderListFilter {
  status?: OrderStatus;
  requestedDate?: string;
  outletId?: string;
}

export interface OrderFieldChanges {
  requestedDate?: string;
  temp?: TemperatureRequirement;
  units?: number;
  weightKg?: number;
  volumeM3?: number;
  /** Set when saving sends a draft: the order becomes submitted at this instant. */
  submittedAt?: Date;
}

interface OrderDraft {
  outletId: string;
  brand: OrderRow['brand'];
  temp: TemperatureRequirement;
  requestedDate: string;
  units: number;
  weightKg: number;
  volumeM3: number;
  submittedAt: Date;
}

export interface OrderSlot {
  outletId: string;
  requestedDate: string;
  temp: TemperatureRequirement;
}

interface CalendarDay {
  date: string;
  isOperating: boolean;
}

export interface OrderRepo {
  findById(db: OrderDb, id: string): Promise<OrderRow | null>;
  findForUserScope(
    db: OrderDb,
    id: string,
    userScope: SQL,
    lock: boolean,
  ): Promise<OrderRow | null>;
  list(db: OrderDb, userScope: SQL, filter: OrderListFilter): Promise<OrderRow[]>;
  findOutlet(
    db: OrderDb,
    outletId: string,
  ): Promise<{ id: string; brand: OrderRow['brand'] } | null>;
  findCalendarDay(db: OrderDb, date: string): Promise<CalendarDay | null>;
  nextOperatingDate(db: OrderDb, afterDate: string): Promise<string | null>;
  previousOperatingDate(db: OrderDb, beforeDate: string): Promise<string | null>;
  findActiveDuplicate(db: OrderDb, slot: OrderSlot, excludeId?: string): Promise<OrderRow | null>;
  lockOrderSlot(db: OrderDb, slot: OrderSlot): Promise<void>;
  create(db: OrderDb, draft: OrderDraft): Promise<OrderRow>;
  update(
    db: OrderDb,
    id: string,
    expectedVersion: number,
    changes: OrderFieldChanges,
  ): Promise<OrderRow | null>;
  markCancelled(db: OrderDb, id: string, expectedVersion: number): Promise<OrderRow | null>;
  markConfirmed(
    db: OrderDb,
    id: string,
    expectedVersion: number,
    lockedAt: Date,
  ): Promise<OrderRow | null>;
  listSubmittedForServiceDate(
    db: OrderDb,
    serviceDate: string,
    userScope: SQL,
  ): Promise<OrderRow[]>;
  listStoreManagers(
    db: OrderDb,
    outletIds: readonly string[],
  ): Promise<{ id: string; outletId: string }[]>;
  insertNotifications(db: OrderDb, rows: readonly OrderNotificationDraft[]): Promise<void>;
}

interface OrderNotificationDraft {
  recipientId: string;
  type: NotificationType;
  priority: NotificationPriority;
  entityType: EntityType;
  entityId: string;
  createdAt: Date;
}

function first<T>(rows: T[]): T | null {
  return rows[0] ?? null;
}

function listWhere(userScope: SQL, filter: OrderListFilter): SQL {
  const parts: SQL[] = [userScope];
  if (filter.status !== undefined) parts.push(eq(orders.status, filter.status));
  if (filter.requestedDate !== undefined) {
    parts.push(eq(orders.requestedDate, filter.requestedDate));
  }
  if (filter.outletId !== undefined) parts.push(eq(orders.outletId, filter.outletId));
  const where = and(...parts);
  return where ?? userScope;
}

export function createOrderRepo(): OrderRepo {
  return {
    async findById(db, id) {
      const rows = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
      return first(rows);
    },

    async findForUserScope(db, id, userScope, lock) {
      const query = db
        .select()
        .from(orders)
        .where(and(eq(orders.id, id), userScope))
        .limit(1);
      const rows = lock ? await query.for('update') : await query;
      return first(rows);
    },

    async list(db, userScope, filter) {
      return db
        .select()
        .from(orders)
        .where(listWhere(userScope, filter))
        .orderBy(asc(orders.requestedDate), asc(orders.id));
    },

    async findOutlet(db, outletId) {
      const rows = await db
        .select({ id: outlets.id, brand: outlets.brand })
        .from(outlets)
        .where(eq(outlets.id, outletId))
        .limit(1);
      return first(rows);
    },

    async findCalendarDay(db, date) {
      const rows = await db
        .select({ date: calendarDays.date, isOperating: calendarDays.isOperating })
        .from(calendarDays)
        .where(eq(calendarDays.date, date))
        .limit(1);
      return first(rows);
    },

    async nextOperatingDate(db, afterDate) {
      const rows = await db
        .select({ date: calendarDays.date })
        .from(calendarDays)
        .where(and(gt(calendarDays.date, afterDate), eq(calendarDays.isOperating, true)))
        .orderBy(asc(calendarDays.date))
        .limit(1);
      return first(rows)?.date ?? null;
    },

    async previousOperatingDate(db, beforeDate) {
      const rows = await db
        .select({ date: calendarDays.date })
        .from(calendarDays)
        .where(and(lt(calendarDays.date, beforeDate), eq(calendarDays.isOperating, true)))
        .orderBy(desc(calendarDays.date))
        .limit(1);
      return first(rows)?.date ?? null;
    },

    async findActiveDuplicate(db, slot, excludeId) {
      const parts: SQL[] = [
        eq(orders.outletId, slot.outletId),
        eq(orders.requestedDate, slot.requestedDate),
        eq(orders.temp, slot.temp),
        ne(orders.status, 'cancelled'),
      ];
      if (excludeId !== undefined) parts.push(ne(orders.id, excludeId));
      const where = and(...parts);
      if (where === undefined) return null;
      const rows = await db.select().from(orders).where(where).limit(1);
      return first(rows);
    },

    async lockOrderSlot(db, slot) {
      const key = `${slot.outletId}|${slot.requestedDate}|${slot.temp}`;
      await db.execute(sql`select pg_advisory_xact_lock(hashtext(${key})::bigint)`);
    },

    async create(db, draft) {
      const rows = await db
        .insert(orders)
        .values({
          outletId: draft.outletId,
          brand: draft.brand,
          temp: draft.temp,
          requestedDate: draft.requestedDate,
          units: draft.units,
          weightKg: draft.weightKg,
          volumeM3: draft.volumeM3,
          status: 'submitted',
          submittedAt: draft.submittedAt,
        })
        .returning();
      const row = first(rows);
      if (row === null) throw new ApiError('INTERNAL_ERROR', 'Could not create the order');
      return row;
    },

    async update(db, id, expectedVersion, changes) {
      const rows = await db
        .update(orders)
        .set({
          ...(changes.requestedDate !== undefined ? { requestedDate: changes.requestedDate } : {}),
          ...(changes.temp !== undefined ? { temp: changes.temp } : {}),
          ...(changes.units !== undefined ? { units: changes.units } : {}),
          ...(changes.weightKg !== undefined ? { weightKg: changes.weightKg } : {}),
          ...(changes.volumeM3 !== undefined ? { volumeM3: changes.volumeM3 } : {}),
          ...(changes.submittedAt !== undefined
            ? { status: 'submitted' as const, submittedAt: changes.submittedAt }
            : {}),
          version: expectedVersion + 1,
        })
        .where(and(eq(orders.id, id), eq(orders.version, expectedVersion)))
        .returning();
      return first(rows);
    },

    async markCancelled(db, id, expectedVersion) {
      const rows = await db
        .update(orders)
        .set({ status: 'cancelled', version: expectedVersion + 1 })
        .where(and(eq(orders.id, id), eq(orders.version, expectedVersion)))
        .returning();
      return first(rows);
    },

    async markConfirmed(db, id, expectedVersion, lockedAt) {
      const rows = await db
        .update(orders)
        .set({ status: 'confirmed', lockedAt, version: expectedVersion + 1 })
        .where(and(eq(orders.id, id), eq(orders.version, expectedVersion)))
        .returning();
      return first(rows);
    },

    async listSubmittedForServiceDate(db, serviceDate, userScope) {
      return db
        .select()
        .from(orders)
        .where(
          and(eq(orders.requestedDate, serviceDate), eq(orders.status, 'submitted'), userScope),
        )
        .for('update');
    },

    async listStoreManagers(db, outletIds) {
      if (outletIds.length === 0) return [];
      const rows = await db
        .select({ id: users.id, outletId: users.outletId })
        .from(users)
        .where(and(eq(users.role, 'store_manager'), inArray(users.outletId, [...outletIds])));
      const managers: { id: string; outletId: string }[] = [];
      for (const row of rows) {
        if (row.outletId === null) continue;
        managers.push({ id: row.id, outletId: row.outletId });
      }
      return managers;
    },

    async insertNotifications(db, rows) {
      if (rows.length === 0) return;
      await db.insert(notifications).values([...rows]);
    },
  };
}
