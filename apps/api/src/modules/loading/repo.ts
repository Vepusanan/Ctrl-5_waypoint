import type { Database } from '@waypoint/database';
import {
  and,
  asc,
  auditLog,
  desc,
  eq,
  inArray,
  isNull,
  loadingCounts,
  loadingIssues,
  loadingRecords,
  notifications,
  or,
  orders,
  outlets,
  planningRuns,
  type SQL,
  sql,
  tripStops,
  trips,
  users,
  vehicles,
} from '@waypoint/database';
import type {
  Brand,
  EntityType,
  LoadingIssueType,
  LoadingStatus,
  NotificationPriority,
  NotificationType,
  OrderStatus,
  ParkingConstraint,
  TemperatureRequirement,
  TripStatus,
  VehicleTemperature,
  VehicleType,
} from '@waypoint/shared';
import { type LoadingState, loadingPlanSnapshotSchema } from '@waypoint/shared';

// Both the database and a transaction expose these repository operations.
export type LoadingDb = Pick<Database, 'select' | 'insert' | 'update'>;

export interface LockedTrip {
  id: string;
  status: TripStatus;
  version: number;
  depotId: string;
  planVersion: number;
  runStatus: 'open' | 'published';
}

interface LoadingRecordRow {
  id: string;
  tripId: string;
  status: LoadingStatus;
  loaderId: string;
  acceptedTripVersion: number;
  verifiedAt: Date | null;
}

interface LoadingStopRow {
  id: string;
  seq: number;
  plannedArrival: Date;
  orderId: string;
  outletId: string;
  brand: Brand;
  temp: TemperatureRequirement;
  requestedDate: string;
  units: number;
  weightKg: number;
  volumeM3: number;
  orderStatus: OrderStatus;
  parkingConstraint: ParkingConstraint;
  loadedUnits: number;
}

export interface LoadingIssueRow {
  id: string;
  tripId: string;
  orderId: string;
  type: LoadingIssueType;
  qty: number;
  note: string | null;
  loaderId: string;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
  createdAt: Date;
}

interface LoadingVehicleRow {
  id: string;
  type: VehicleType;
  temp: VehicleTemperature;
  depotId: string;
}

export interface LoadingBundle {
  acceptedPlan?: LoadingState['acceptedPlan'];
  trip: LockedTrip;
  vehicle: LoadingVehicleRow;
  record: LoadingRecordRow | null;
  stops: LoadingStopRow[];
  issues: LoadingIssueRow[];
}

interface NotificationDraft {
  recipientId: string;
  type: NotificationType;
  priority: NotificationPriority;
  entityType: EntityType;
  entityId: string;
  createdAt: Date;
}

export interface LoadingRepo {
  lockTrip(db: LoadingDb, userScope: SQL, id: string): Promise<LockedTrip | null>;
  load(db: LoadingDb, userScope: SQL, id: string): Promise<LoadingBundle | null>;
  lockLoading(db: LoadingDb, tripId: string): Promise<LoadingRecordRow | null>;
  insertLoading(
    db: LoadingDb,
    tripId: string,
    loaderId: string,
    acceptedTripVersion: number,
  ): Promise<LoadingRecordRow>;
  setLoadingStatus(
    db: LoadingDb,
    tripId: string,
    from: LoadingStatus,
    to: LoadingStatus,
  ): Promise<boolean>;
  acceptPlan(
    db: LoadingDb,
    tripId: string,
    tripVersion: number,
    verifiedAt: Date,
  ): Promise<boolean>;
  setTripStatus(
    db: LoadingDb,
    tripId: string,
    from: TripStatus,
    to: TripStatus,
    version: number,
  ): Promise<boolean>;
  lockOrders(
    db: LoadingDb,
    orderIds: readonly string[],
  ): Promise<{ id: string; status: OrderStatus; units: number }[]>;
  markOrderLoading(db: LoadingDb, orderId: string): Promise<boolean>;
  orderOnTrip(db: LoadingDb, tripId: string, orderId: string): Promise<{ units: number } | null>;
  saveCount(
    db: LoadingDb,
    count: { tripId: string; orderId: string; units: number; loaderId: string; at: Date },
  ): Promise<void>;
  insertIssue(
    db: LoadingDb,
    issue: {
      tripId: string;
      orderId: string;
      type: LoadingIssueType;
      qty: number;
      note: string | null;
      loaderId: string;
      createdAt: Date;
    },
  ): Promise<LoadingIssueRow>;
  locateIssue(db: LoadingDb, userScope: SQL, id: string): Promise<{ tripId: string } | null>;
  lockIssue(db: LoadingDb, id: string): Promise<LoadingIssueRow | null>;
  acknowledgeIssue(
    db: LoadingDb,
    id: string,
    acknowledgedBy: string,
    acknowledgedAt: Date,
  ): Promise<LoadingIssueRow | null>;
  countOpenIssues(db: LoadingDb, tripId: string): Promise<number>;
  listDispatchers(db: LoadingDb, depotId: string): Promise<{ id: string }[]>;
  insertNotifications(db: LoadingDb, rows: readonly NotificationDraft[]): Promise<void>;
}

export function createLoadingRepo(): LoadingRepo {
  return {
    async lockTrip(db, userScope, id) {
      const rows = await db
        .select({
          id: trips.id,
          status: trips.status,
          version: trips.version,
          depotId: planningRuns.depotId,
          planVersion: planningRuns.planVersion,
          runStatus: planningRuns.status,
        })
        .from(trips)
        .innerJoin(planningRuns, eq(planningRuns.id, trips.runId))
        .where(and(eq(trips.id, id), userScope))
        .limit(1)
        .for('update');
      return rows[0] ?? null;
    },

    async load(db, userScope, id) {
      const header = await db
        .select({
          id: trips.id,
          status: trips.status,
          version: trips.version,
          depotId: planningRuns.depotId,
          planVersion: planningRuns.planVersion,
          runStatus: planningRuns.status,
          vehicleId: vehicles.id,
          vehicleType: vehicles.type,
          vehicleTemp: vehicles.temp,
          vehicleDepotId: vehicles.depotId,
        })
        .from(trips)
        .innerJoin(planningRuns, eq(planningRuns.id, trips.runId))
        .innerJoin(vehicles, eq(vehicles.id, trips.vehicleId))
        .where(and(eq(trips.id, id), userScope))
        .limit(1);
      const trip = header[0];
      if (trip === undefined) return null;
      const [record] = await db
        .select(recordColumns)
        .from(loadingRecords)
        .where(eq(loadingRecords.tripId, id))
        .limit(1);
      const [accepted] = await db
        .select({ after: auditLog.after })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.entityId, id),
            eq(auditLog.entityType, 'trip'),
            inArray(auditLog.action, ['loading.started', 'loading.verified']),
            sql`${auditLog.after}->'acceptedPlan'->>'tripVersion' = ${String(record?.acceptedTripVersion ?? '')}`,
          ),
        )
        .orderBy(desc(auditLog.createdAt))
        .limit(1);
      const snapshot = loadingPlanSnapshotSchema.safeParse(accepted?.after?.acceptedPlan);
      return {
        acceptedPlan: snapshot.success ? snapshot.data : null,
        trip: {
          id: trip.id,
          status: trip.status,
          version: trip.version,
          depotId: trip.depotId,
          planVersion: trip.planVersion,
          runStatus: trip.runStatus,
        },
        vehicle: {
          id: trip.vehicleId,
          type: trip.vehicleType,
          temp: trip.vehicleTemp,
          depotId: trip.vehicleDepotId,
        },
        record: record ?? null,
        stops: await listStops(db, id),
        issues: await listIssues(db, id),
      };
    },

    async lockLoading(db, tripId) {
      const rows = await db
        .select(recordColumns)
        .from(loadingRecords)
        .where(eq(loadingRecords.tripId, tripId))
        .limit(1)
        .for('update');
      return rows[0] ?? null;
    },

    async insertLoading(db, tripId, loaderId, acceptedTripVersion) {
      const rows = await db
        .insert(loadingRecords)
        .values({ tripId, loaderId, status: 'in_progress', acceptedTripVersion })
        .returning(recordColumns);
      const created = rows[0];
      if (created === undefined) throw new Error('Expected a loading record');
      return created;
    },

    async setLoadingStatus(db, tripId, from, to) {
      const rows = await db
        .update(loadingRecords)
        .set({ status: to })
        .where(and(eq(loadingRecords.tripId, tripId), eq(loadingRecords.status, from)))
        .returning({ id: loadingRecords.id });
      return rows.length === 1;
    },

    async acceptPlan(db, tripId, tripVersion, verifiedAt) {
      const rows = await db
        .update(loadingRecords)
        .set({ acceptedTripVersion: tripVersion, verifiedAt })
        .where(eq(loadingRecords.tripId, tripId))
        .returning({ id: loadingRecords.id });
      return rows.length === 1;
    },

    async setTripStatus(db, tripId, from, to, version) {
      const rows = await db
        .update(trips)
        .set({ status: to })
        .where(and(eq(trips.id, tripId), eq(trips.status, from), eq(trips.version, version)))
        .returning({ id: trips.id });
      return rows.length === 1;
    },

    async lockOrders(db, orderIds) {
      if (orderIds.length === 0) return [];
      return db
        .select({ id: orders.id, status: orders.status, units: orders.units })
        .from(orders)
        .where(inArray(orders.id, [...orderIds]))
        .for('update');
    },

    async markOrderLoading(db, orderId) {
      const rows = await db
        .update(orders)
        .set({ status: 'loading', version: sql`${orders.version} + 1` })
        .where(and(eq(orders.id, orderId), eq(orders.status, 'allocated')))
        .returning({ id: orders.id });
      return rows.length === 1;
    },

    async orderOnTrip(db, tripId, orderId) {
      const rows = await db
        .select({ units: orders.units })
        .from(tripStops)
        .innerJoin(orders, eq(orders.id, tripStops.orderId))
        .where(and(eq(tripStops.tripId, tripId), eq(tripStops.orderId, orderId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async saveCount(db, count) {
      await db
        .insert(loadingCounts)
        .values({
          tripId: count.tripId,
          orderId: count.orderId,
          units: count.units,
          updatedBy: count.loaderId,
          updatedAt: count.at,
        })
        .onConflictDoUpdate({
          target: [loadingCounts.tripId, loadingCounts.orderId],
          set: { units: count.units, updatedBy: count.loaderId, updatedAt: count.at },
        });
    },

    async insertIssue(db, issue) {
      const rows = await db
        .insert(loadingIssues)
        .values({
          tripId: issue.tripId,
          orderId: issue.orderId,
          type: issue.type,
          qty: issue.qty,
          note: issue.note,
          loaderId: issue.loaderId,
          createdAt: issue.createdAt,
        })
        .returning(issueColumns);
      const created = rows[0];
      if (created === undefined) throw new Error('Expected a loading issue');
      return created;
    },

    async locateIssue(db, userScope, id) {
      const rows = await db
        .select({ tripId: loadingIssues.tripId })
        .from(loadingIssues)
        .innerJoin(trips, eq(trips.id, loadingIssues.tripId))
        .where(and(eq(loadingIssues.id, id), userScope))
        .limit(1);
      return rows[0] ?? null;
    },

    async lockIssue(db, id) {
      const rows = await db
        .select(issueColumns)
        .from(loadingIssues)
        .where(eq(loadingIssues.id, id))
        .limit(1)
        .for('update');
      return rows[0] ?? null;
    },

    async acknowledgeIssue(db, id, acknowledgedBy, acknowledgedAt) {
      const rows = await db
        .update(loadingIssues)
        .set({ acknowledgedBy, acknowledgedAt })
        .where(and(eq(loadingIssues.id, id), isNull(loadingIssues.acknowledgedBy)))
        .returning(issueColumns);
      return rows[0] ?? null;
    },

    async countOpenIssues(db, tripId) {
      const rows = await db
        .select({ id: loadingIssues.id })
        .from(loadingIssues)
        .where(and(eq(loadingIssues.tripId, tripId), isNull(loadingIssues.acknowledgedBy)));
      return rows.length;
    },

    async listDispatchers(db, depotId) {
      return db
        .select({ id: users.id })
        .from(users)
        .where(
          and(eq(users.role, 'dispatcher'), or(eq(users.depotId, depotId), isNull(users.depotId))),
        );
    },

    async insertNotifications(db, rows) {
      if (rows.length === 0) return;
      await db.insert(notifications).values([...rows]);
    },
  };
}

const recordColumns = {
  id: loadingRecords.id,
  tripId: loadingRecords.tripId,
  status: loadingRecords.status,
  loaderId: loadingRecords.loaderId,
  acceptedTripVersion: loadingRecords.acceptedTripVersion,
  verifiedAt: loadingRecords.verifiedAt,
};

const issueColumns = {
  id: loadingIssues.id,
  tripId: loadingIssues.tripId,
  orderId: loadingIssues.orderId,
  type: loadingIssues.type,
  qty: loadingIssues.qty,
  note: loadingIssues.note,
  loaderId: loadingIssues.loaderId,
  acknowledgedBy: loadingIssues.acknowledgedBy,
  acknowledgedAt: loadingIssues.acknowledgedAt,
  createdAt: loadingIssues.createdAt,
};

async function listStops(db: LoadingDb, tripId: string): Promise<LoadingStopRow[]> {
  return db
    .select({
      id: tripStops.id,
      seq: tripStops.seq,
      plannedArrival: tripStops.plannedArrival,
      orderId: orders.id,
      outletId: orders.outletId,
      brand: orders.brand,
      temp: orders.temp,
      requestedDate: orders.requestedDate,
      units: orders.units,
      weightKg: orders.weightKg,
      volumeM3: orders.volumeM3,
      orderStatus: orders.status,
      parkingConstraint: outlets.parkingConstraint,
      loadedUnits: sql<number>`coalesce(${loadingCounts.units}, 0)`,
    })
    .from(tripStops)
    .innerJoin(orders, eq(orders.id, tripStops.orderId))
    .innerJoin(outlets, eq(outlets.id, orders.outletId))
    .leftJoin(
      loadingCounts,
      and(eq(loadingCounts.tripId, tripStops.tripId), eq(loadingCounts.orderId, tripStops.orderId)),
    )
    .where(eq(tripStops.tripId, tripId))
    .orderBy(asc(tripStops.seq));
}

async function listIssues(db: LoadingDb, tripId: string): Promise<LoadingIssueRow[]> {
  return db
    .select(issueColumns)
    .from(loadingIssues)
    .where(eq(loadingIssues.tripId, tripId))
    .orderBy(asc(loadingIssues.createdAt), asc(loadingIssues.id));
}
