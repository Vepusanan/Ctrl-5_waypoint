import type { Database } from '@waypoint/database';
import {
  notifications,
  orders,
  outlets,
  planningRuns,
  pods,
  stopEvents,
  tripStops,
  trips,
  users,
} from '@waypoint/database';
import type {
  Brand,
  EntityType,
  NotificationPriority,
  NotificationType,
  OrderStatus,
  StopEvent,
  StopStatus,
  TemperatureRequirement,
  TripStatus,
} from '@waypoint/shared';
import { and, asc, eq, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import type { ArrivalFact, EtaStop } from './eta.ts';

export type DeliveryDb = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

type StopEventPayload = StopEvent['payload'];

export interface DeliveryStopRow {
  id: string;
  tripId: string;
  tripStatus: TripStatus;
  tripVersion: number;
  depotId: string;
  serviceDate: string;
  orderId: string;
  orderStatus: OrderStatus;
  outletId: string;
  brand: Brand;
  temp: TemperatureRequirement;
  requestedDate: string;
  units: number;
  weightKg: number;
  volumeM3: number;
  seq: number;
  plannedArrival: Date;
  status: StopStatus;
  late: boolean;
  windowClose: string;
}

export interface StopEventRow {
  id: string;
  clientEventId: string;
  stopId: string;
  type: StopEvent['type'];
  payload: StopEventPayload;
  clientTime: Date;
  serverTime: Date;
  tripVersion: number;
}

export interface PodRow {
  id: string;
  stopId: string;
  recipientName: string;
  hasPhoto: boolean;
  clientTime: Date;
}

interface NotificationDraft {
  recipientId: string;
  type: NotificationType;
  priority: NotificationPriority;
  entityType: EntityType;
  entityId: string;
  createdAt: Date;
}

interface InsertStopEvent {
  clientEventId: string;
  stopId: string;
  type: StopEvent['type'];
  payload: StopEventPayload;
  clientTime: Date;
  serverTime: Date;
  tripVersion: number;
}

interface InsertPod {
  stopId: string;
  recipientName: string;
  signature: Buffer;
  photo?: Buffer;
  clientTime: Date;
}

export interface DeliveryRepo {
  findStop(
    db: DeliveryDb,
    userScope: SQL,
    stopId: string,
    activeOnly: boolean,
  ): Promise<DeliveryStopRow | null>;
  lockStop(db: DeliveryDb, userScope: SQL, stopId: string): Promise<DeliveryStopRow | null>;
  listStops(db: DeliveryDb, tripId: string): Promise<EtaStop[]>;
  listArrivals(db: DeliveryDb, tripId: string): Promise<ArrivalFact[]>;
  findEvent(db: DeliveryDb, clientEventId: string): Promise<StopEventRow | null>;
  insertEvent(db: DeliveryDb, row: InsertStopEvent): Promise<StopEventRow | null>;
  markArrived(db: DeliveryDb, stopId: string, late: boolean): Promise<boolean>;
  markStop(db: DeliveryDb, stopId: string, from: StopStatus, to: StopStatus): Promise<boolean>;
  markOrder(db: DeliveryDb, orderId: string, to: 'delivered' | 'failed'): Promise<boolean>;
  /** Departed -> completed once no stop on the trip is still pending or arrived. */
  completeTripIfDone(db: DeliveryDb, tripId: string): Promise<boolean>;
  findPod(db: DeliveryDb, stopId: string): Promise<PodRow | null>;
  failureReason(db: DeliveryDb, stopId: string): Promise<string | null>;
  insertPod(db: DeliveryDb, row: InsertPod): Promise<PodRow>;
  listDispatchers(db: DeliveryDb, depotId: string): Promise<{ id: string }[]>;
  listStoreManagers(db: DeliveryDb, outletId: string): Promise<{ id: string }[]>;
  insertNotifications(db: DeliveryDb, rows: readonly NotificationDraft[]): Promise<void>;
}

const stopColumns = {
  id: tripStops.id,
  tripId: trips.id,
  tripStatus: trips.status,
  tripVersion: trips.version,
  depotId: planningRuns.depotId,
  serviceDate: planningRuns.serviceDate,
  orderId: orders.id,
  orderStatus: orders.status,
  outletId: orders.outletId,
  brand: orders.brand,
  temp: orders.temp,
  requestedDate: orders.requestedDate,
  units: orders.units,
  weightKg: orders.weightKg,
  volumeM3: orders.volumeM3,
  seq: tripStops.seq,
  plannedArrival: tripStops.plannedArrival,
  status: tripStops.status,
  late: tripStops.late,
  windowClose: outlets.windowClose,
};

const eventColumns = {
  id: stopEvents.id,
  clientEventId: stopEvents.clientEventId,
  stopId: stopEvents.stopId,
  type: stopEvents.type,
  payload: stopEvents.payload,
  clientTime: stopEvents.clientTime,
  serverTime: stopEvents.serverTime,
  tripVersion: stopEvents.tripVersion,
};

export function createDeliveryRepo(): DeliveryRepo {
  return {
    async findStop(db, userScope, stopId, activeOnly) {
      const rows = await joinedStops(db)
        .where(stopWhere(userScope, stopId, activeOnly))
        .limit(1);
      return rows[0] ?? null;
    },

    async lockStop(db, userScope, stopId) {
      const rows = await joinedStops(db)
        .where(stopWhere(userScope, stopId, false))
        .limit(1)
        .for('update');
      return rows[0] ?? null;
    },

    async listStops(db, tripId) {
      return db
        .select({
          id: tripStops.id,
          seq: tripStops.seq,
          plannedArrival: tripStops.plannedArrival,
        })
        .from(tripStops)
        .where(eq(tripStops.tripId, tripId))
        .orderBy(asc(tripStops.seq));
    },

    async listArrivals(db, tripId) {
      return db
        .select({ stopId: stopEvents.stopId, clientTime: stopEvents.clientTime })
        .from(stopEvents)
        .innerJoin(tripStops, eq(tripStops.id, stopEvents.stopId))
        .where(and(eq(tripStops.tripId, tripId), eq(stopEvents.type, 'arrived')));
    },

    async findEvent(db, clientEventId) {
      const rows = await db
        .select(eventColumns)
        .from(stopEvents)
        .where(eq(stopEvents.clientEventId, clientEventId))
        .limit(1);
      return rows[0] ?? null;
    },

    async insertEvent(db, row) {
      const rows = await db
        .insert(stopEvents)
        .values(row)
        .onConflictDoNothing({ target: stopEvents.clientEventId })
        .returning(eventColumns);
      return rows[0] ?? null;
    },

    async markArrived(db, stopId, late) {
      const rows = await db
        .update(tripStops)
        .set({ status: 'arrived', late })
        .where(and(eq(tripStops.id, stopId), eq(tripStops.status, 'pending')))
        .returning({ id: tripStops.id });
      return rows.length === 1;
    },

    async markStop(db, stopId, from, to) {
      const rows = await db
        .update(tripStops)
        .set({ status: to })
        .where(and(eq(tripStops.id, stopId), eq(tripStops.status, from)))
        .returning({ id: tripStops.id });
      return rows.length === 1;
    },

    async markOrder(db, orderId, to) {
      const rows = await db
        .update(orders)
        .set({ status: to, version: sql`${orders.version} + 1` })
        .where(and(eq(orders.id, orderId), eq(orders.status, 'dispatched')))
        .returning({ id: orders.id });
      return rows.length === 1;
    },

    async completeTripIfDone(db, tripId) {
      const rows = await db
        .update(trips)
        .set({ status: 'completed' })
        .where(
          and(
            eq(trips.id, tripId),
            eq(trips.status, 'departed'),
            sql`not exists (
              select 1 from ${tripStops}
              where ${tripStops.tripId} = ${tripId}
                and ${tripStops.status} in ('pending', 'arrived')
            )`,
          ),
        )
        .returning({ id: trips.id });
      return rows.length === 1;
    },

    async findPod(db, stopId) {
      const rows = await db
        .select({
          id: pods.id,
          stopId: pods.stopId,
          recipientName: pods.recipientName,
          hasPhoto: sql<boolean>`${pods.photo} is not null`,
          clientTime: pods.clientTime,
        })
        .from(pods)
        .where(eq(pods.stopId, stopId))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return { ...row, hasPhoto: row.hasPhoto === true };
    },

    async failureReason(db, stopId) {
      const rows = await db
        .select({ payload: stopEvents.payload })
        .from(stopEvents)
        .where(and(eq(stopEvents.stopId, stopId), eq(stopEvents.type, 'failed')))
        .limit(1);
      const payload = rows[0]?.payload;
      if (payload === undefined || !('reason' in payload)) return null;
      return payload.reason;
    },

    async insertPod(db, row) {
      const rows = await db
        .insert(pods)
        .values({
          stopId: row.stopId,
          recipientName: row.recipientName,
          signature: row.signature,
          clientTime: row.clientTime,
          ...(row.photo !== undefined ? { photo: row.photo } : {}),
        })
        .returning({
          id: pods.id,
          stopId: pods.stopId,
          recipientName: pods.recipientName,
          clientTime: pods.clientTime,
        });
      const created = rows[0];
      if (created === undefined) throw new Error('Expected a proof of delivery');
      return { ...created, hasPhoto: row.photo !== undefined };
    },

    async listDispatchers(db, depotId) {
      return db
        .select({ id: users.id })
        .from(users)
        .where(
          and(eq(users.role, 'dispatcher'), or(eq(users.depotId, depotId), isNull(users.depotId))),
        );
    },

    async listStoreManagers(db, outletId) {
      return db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, 'store_manager'), eq(users.outletId, outletId)));
    },

    async insertNotifications(db, rows) {
      if (rows.length === 0) return;
      await db.insert(notifications).values([...rows]);
    },
  };
}

function joinedStops(db: DeliveryDb) {
  return db
    .select(stopColumns)
    .from(tripStops)
    .innerJoin(trips, eq(trips.id, tripStops.tripId))
    .innerJoin(planningRuns, eq(planningRuns.id, trips.runId))
    .innerJoin(orders, eq(orders.id, tripStops.orderId))
    .innerJoin(outlets, eq(outlets.id, orders.outletId));
}

function stopWhere(userScope: SQL, stopId: string, activeOnly: boolean): SQL | undefined {
  const filters = [eq(tripStops.id, stopId), userScope];
  if (activeOnly) filters.push(inArray(trips.status, ['departed', 'completed']));
  return and(...filters);
}
