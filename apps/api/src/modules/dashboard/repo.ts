import type { Database } from '@waypoint/database';
import {
  auditLog,
  calendarDays,
  deferrals,
  fuelLedger,
  issues,
  loadingIssues,
  loadingRecords,
  orders,
  outlets,
  planningRuns,
  stopEvents,
  syncConflicts,
  tripStops,
  trips,
  users,
  vehicleAvailability,
  vehicles,
} from '@waypoint/database';
import type {
  Brand,
  IssueType,
  LoadingIssueType,
  LoadingStatus,
  OrderStatus,
  ReasonCode,
  Role,
  StopEvent,
  StopStatus,
  TemperatureRequirement,
  TripStatus,
  VehicleAvailabilityStatus,
  VehicleTemperature,
  VehicleType,
} from '@waypoint/shared';
import { and, asc, desc, eq, inArray, isNull, lt, type SQL, sql } from 'drizzle-orm';

export interface DashboardScope {
  orders: SQL;
  trips: SQL;
  depotId: string | null;
}

interface OrderCount {
  status: OrderStatus;
  total: number;
}

export interface DeferredOrder {
  id: string;
  orderId: string;
  outletId: string;
  brand: Brand;
  temp: TemperatureRequirement;
  weightKg: number;
  volumeM3: number;
  reasonCode: ReasonCode;
  createdAt: Date;
}

interface TripFact {
  id: string;
  vehicleId: string;
  tripNo: number;
  brand: Brand;
  district: string;
  status: TripStatus;
  plannedMinutes: number;
  plannedKm: number;
  weightCapKg: number;
  volumeCapM3: number;
  vehicleType: VehicleType;
  vehicleTemp: VehicleTemperature;
  kmPerL: number;
  depotId: string;
  weightKg: number;
  volumeM3: number;
}

export interface StopFact {
  id: string;
  tripId: string;
  orderId: string;
  seq: number;
  status: StopStatus;
  plannedArrival: Date;
  late: boolean;
  windowClose: string;
  mallWindowClose: string | null;
}

export interface FieldEventFact {
  tripId: string;
  stopId: string;
  serverTime: Date;
  type: StopEvent['type'];
  payload: StopEvent['payload'];
}

interface LoadingIssueFact {
  id: string;
  tripId: string;
  orderId: string;
  type: LoadingIssueType;
  qty: number;
  note: string | null;
  createdAt: Date;
}

interface ConflictFact {
  id: string;
  reason: string;
  createdAt: Date;
  tripId: string;
  stopId: string;
}

interface OpenIssueFact {
  id: string;
  orderId: string;
  type: IssueType;
  note: string | null;
  createdAt: Date;
}

interface VehicleFact {
  id: string;
  type: VehicleType;
  temp: VehicleTemperature;
  weightCapKg: number;
  volumeCapM3: number;
  kmPerL: number;
  depotId: string;
  availability: VehicleAvailabilityStatus;
}

interface DriverFact {
  id: string;
  name: string;
  vehicleId: string | null;
}

interface FuelFact {
  tripId: string;
  litres: number;
}

interface DepartureFact {
  tripId: string;
  departedAt: Date;
}

interface LoadingFact {
  tripId: string;
  status: LoadingStatus;
}

export interface DaySnapshot {
  orderCounts: OrderCount[];
  deferrals: DeferredOrder[];
  repeatOutletIds: string[];
  trips: TripFact[];
  stops: StopFact[];
  events: FieldEventFact[];
  loading: LoadingFact[];
  loadingIssues: LoadingIssueFact[];
  conflicts: ConflictFact[];
  issues: OpenIssueFact[];
  vehicles: VehicleFact[];
  drivers: DriverFact[];
  fuel: FuelFact[];
  departures: DepartureFact[];
}

interface AuditFact {
  id: string;
  actorId: string;
  role: Role;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  createdAt: Date;
}

export interface DashboardRepo {
  load(db: Database, scope: DashboardScope, date: string): Promise<DaySnapshot>;
  listOutletIds(db: Database, depotId: string): Promise<string[]>;
  entityVisible(
    db: Database,
    scope: DashboardScope,
    entityType: string,
    entityId: string,
  ): Promise<boolean>;
  listAudit(db: Database, entityType: string, entityId: string): Promise<AuditFact[]>;
}

export function createDashboardRepo(): DashboardRepo {
  return {
    async load(db, scope, date) {
      const previous = await previousOperatingDate(db, date);
      const [orderCounts, deferralRows, repeatOutletIds, tripRows, stopRows, eventRows] =
        await Promise.all([
          listOrderCounts(db, scope.orders, date),
          listDeferrals(db, scope.orders, date),
          previous === null
            ? Promise.resolve([] as string[])
            : outletsDeferredOn(db, scope.orders, previous),
          listTrips(db, scope.trips, date),
          listStops(db, scope.trips, date),
          listEvents(db, scope.trips, date),
        ]);
      const tripIds = tripRows.map((trip) => trip.id);
      const [loading, loadingIssues, conflicts, openIssues, vehicleRows, driverRows, fuel] =
        await Promise.all([
          listLoading(db, scope.trips, date),
          listLoadingIssues(db, scope.trips, date),
          listConflicts(db, scope.trips, date),
          listOpenIssues(db, scope.orders, date),
          listVehicles(db, scope.depotId, date),
          listDrivers(db),
          listFuel(db, scope.trips, date),
        ]);
      const departures = await listDepartures(db, tripIds);
      return {
        orderCounts,
        deferrals: deferralRows,
        repeatOutletIds,
        trips: tripRows,
        stops: stopRows,
        events: eventRows,
        loading,
        loadingIssues,
        conflicts,
        issues: openIssues,
        vehicles: vehicleRows,
        drivers: driverRows,
        fuel,
        departures,
      };
    },

    async listOutletIds(db, depotId) {
      const rows = await db
        .select({ id: outlets.id })
        .from(outlets)
        .where(eq(outlets.depotId, depotId));
      return rows.map((row) => row.id);
    },

    entityVisible(db, scope, entityType, entityId) {
      return entityInScope(db, scope, entityType, entityId);
    },

    async listAudit(db, entityType, entityId) {
      return db
        .select({
          id: auditLog.id,
          actorId: auditLog.actorId,
          role: auditLog.role,
          action: auditLog.action,
          entityType: auditLog.entityType,
          entityId: auditLog.entityId,
          before: auditLog.before,
          after: auditLog.after,
          createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .where(
          entityType === 'order'
            ? orderStory(entityId)
            : and(eq(auditLog.entityType, entityType), eq(auditLog.entityId, entityId)),
        )
        .orderBy(asc(auditLog.createdAt), asc(auditLog.id));
    },
  };
}

// An order's story spans several audited entities (SRS FR-AUD-001): the order itself, the plan
// that served or deferred it, its trip and loading, its stop, and any issue raised against it.
function orderStory(orderId: string): SQL {
  return sql`(
    (${auditLog.entityType} = 'order' and ${auditLog.entityId} = ${orderId})
    or (${auditLog.entityType} = 'stop' and ${auditLog.entityId} in (
      select ${tripStops.id}::text from ${tripStops} where ${tripStops.orderId}::text = ${orderId}
    ))
    or (${auditLog.entityType} = 'trip' and ${auditLog.entityId} in (
      select ${tripStops.tripId}::text from ${tripStops} where ${tripStops.orderId}::text = ${orderId}
    ))
    or (${auditLog.entityType} in ('issue', 'loading_issue')
      and ${auditLog.after} ->> 'orderId' = ${orderId})
    or (${auditLog.action} = 'plan.published' and (
      ${auditLog.after} -> 'servedOrderIds' ? ${orderId}
      or ${auditLog.after} -> 'deferredOrderIds' ? ${orderId}
    ))
    or (${auditLog.action} = 'plan.replanned' and (
      ${auditLog.after} -> 'movedOrderIds' ? ${orderId}
      or ${auditLog.after} -> 'deferredOrderIds' ? ${orderId}
    ))
  )`;
}

function onDate(date: string, tripScope: SQL): SQL {
  return and(eq(planningRuns.serviceDate, date), tripScope) ?? tripScope;
}

async function previousOperatingDate(db: Database, beforeDate: string): Promise<string | null> {
  const rows = await db
    .select({ date: calendarDays.date })
    .from(calendarDays)
    .where(and(lt(calendarDays.date, beforeDate), eq(calendarDays.isOperating, true)))
    .orderBy(desc(calendarDays.date))
    .limit(1);
  return rows[0]?.date ?? null;
}

async function listOrderCounts(db: Database, orderScope: SQL, date: string): Promise<OrderCount[]> {
  const rows = await db
    .select({ status: orders.status, total: sqlCount() })
    .from(orders)
    .where(and(eq(orders.requestedDate, date), orderScope))
    .groupBy(orders.status);
  return rows.map((row) => ({ status: row.status, total: asNumber(row.total) }));
}

async function listDeferrals(
  db: Database,
  orderScope: SQL,
  date: string,
): Promise<DeferredOrder[]> {
  const rows = await db
    .select({
      id: deferrals.id,
      orderId: orders.id,
      outletId: orders.outletId,
      brand: orders.brand,
      temp: orders.temp,
      weightKg: orders.weightKg,
      volumeM3: orders.volumeM3,
      reasonCode: deferrals.reasonCode,
      createdAt: deferrals.createdAt,
    })
    .from(deferrals)
    .innerJoin(orders, eq(orders.id, deferrals.orderId))
    .innerJoin(planningRuns, eq(planningRuns.id, deferrals.runId))
    .where(and(eq(planningRuns.serviceDate, date), orderScope));
  return rows;
}

async function outletsDeferredOn(db: Database, orderScope: SQL, date: string): Promise<string[]> {
  const rows = await db
    .select({ outletId: orders.outletId })
    .from(deferrals)
    .innerJoin(orders, eq(orders.id, deferrals.orderId))
    .innerJoin(planningRuns, eq(planningRuns.id, deferrals.runId))
    .where(and(eq(planningRuns.serviceDate, date), orderScope));
  return rows.map((row) => row.outletId);
}

async function listTrips(db: Database, tripScope: SQL, date: string): Promise<TripFact[]> {
  const rows = await db
    .select({
      id: trips.id,
      vehicleId: trips.vehicleId,
      tripNo: trips.tripNo,
      brand: trips.brand,
      district: trips.district,
      status: trips.status,
      plannedMinutes: trips.plannedMinutes,
      plannedKm: trips.plannedKm,
      weightCapKg: vehicles.weightCapKg,
      volumeCapM3: vehicles.volumeCapM3,
      vehicleType: vehicles.type,
      vehicleTemp: vehicles.temp,
      kmPerL: vehicles.kmPerL,
      depotId: vehicles.depotId,
      weightKg: sql<number>`coalesce(sum(${orders.weightKg}), 0)::float8`,
      volumeM3: sql<number>`coalesce(sum(${orders.volumeM3}), 0)::float8`,
    })
    .from(trips)
    .innerJoin(planningRuns, eq(planningRuns.id, trips.runId))
    .innerJoin(vehicles, eq(vehicles.id, trips.vehicleId))
    .leftJoin(tripStops, eq(tripStops.tripId, trips.id))
    .leftJoin(orders, eq(orders.id, tripStops.orderId))
    .where(onDate(date, tripScope))
    .groupBy(trips.id, vehicles.id);
  return rows.map((row) => ({
    ...row,
    plannedMinutes: asNumber(row.plannedMinutes),
    plannedKm: asNumber(row.plannedKm),
    weightCapKg: asNumber(row.weightCapKg),
    volumeCapM3: asNumber(row.volumeCapM3),
    kmPerL: asNumber(row.kmPerL),
    weightKg: asNumber(row.weightKg),
    volumeM3: asNumber(row.volumeM3),
  }));
}

async function listStops(db: Database, tripScope: SQL, date: string): Promise<StopFact[]> {
  return db
    .select({
      id: tripStops.id,
      tripId: tripStops.tripId,
      orderId: tripStops.orderId,
      seq: tripStops.seq,
      status: tripStops.status,
      plannedArrival: tripStops.plannedArrival,
      late: tripStops.late,
      windowClose: outlets.windowClose,
      mallWindowClose: outlets.mallWindowClose,
    })
    .from(tripStops)
    .innerJoin(trips, eq(trips.id, tripStops.tripId))
    .innerJoin(planningRuns, eq(planningRuns.id, trips.runId))
    .innerJoin(orders, eq(orders.id, tripStops.orderId))
    .innerJoin(outlets, eq(outlets.id, orders.outletId))
    .where(onDate(date, tripScope));
}

async function listEvents(db: Database, tripScope: SQL, date: string): Promise<FieldEventFact[]> {
  return db
    .select({
      tripId: trips.id,
      stopId: stopEvents.stopId,
      serverTime: stopEvents.serverTime,
      type: stopEvents.type,
      payload: stopEvents.payload,
    })
    .from(stopEvents)
    .innerJoin(tripStops, eq(tripStops.id, stopEvents.stopId))
    .innerJoin(trips, eq(trips.id, tripStops.tripId))
    .innerJoin(planningRuns, eq(planningRuns.id, trips.runId))
    .where(onDate(date, tripScope));
}

async function listLoading(db: Database, tripScope: SQL, date: string): Promise<LoadingFact[]> {
  return db
    .select({ tripId: loadingRecords.tripId, status: loadingRecords.status })
    .from(loadingRecords)
    .innerJoin(trips, eq(trips.id, loadingRecords.tripId))
    .innerJoin(planningRuns, eq(planningRuns.id, trips.runId))
    .where(onDate(date, tripScope));
}

async function listLoadingIssues(
  db: Database,
  tripScope: SQL,
  date: string,
): Promise<LoadingIssueFact[]> {
  return db
    .select({
      id: loadingIssues.id,
      tripId: loadingIssues.tripId,
      orderId: loadingIssues.orderId,
      type: loadingIssues.type,
      qty: loadingIssues.qty,
      note: loadingIssues.note,
      createdAt: loadingIssues.createdAt,
    })
    .from(loadingIssues)
    .innerJoin(trips, eq(trips.id, loadingIssues.tripId))
    .innerJoin(planningRuns, eq(planningRuns.id, trips.runId))
    .where(and(onDate(date, tripScope), isNull(loadingIssues.acknowledgedAt)));
}

async function listConflicts(db: Database, tripScope: SQL, date: string): Promise<ConflictFact[]> {
  return db
    .select({
      id: syncConflicts.id,
      reason: syncConflicts.reason,
      createdAt: syncConflicts.createdAt,
      tripId: trips.id,
      stopId: tripStops.id,
    })
    .from(syncConflicts)
    .innerJoin(stopEvents, eq(stopEvents.id, syncConflicts.eventId))
    .innerJoin(tripStops, eq(tripStops.id, stopEvents.stopId))
    .innerJoin(trips, eq(trips.id, tripStops.tripId))
    .innerJoin(planningRuns, eq(planningRuns.id, trips.runId))
    .where(and(onDate(date, tripScope), isNull(syncConflicts.resolvedBy)));
}

async function listOpenIssues(
  db: Database,
  orderScope: SQL,
  date: string,
): Promise<OpenIssueFact[]> {
  return db
    .select({
      id: issues.id,
      orderId: issues.orderId,
      type: issues.type,
      note: issues.note,
      createdAt: issues.createdAt,
    })
    .from(issues)
    .innerJoin(orders, eq(orders.id, issues.orderId))
    .where(and(eq(orders.requestedDate, date), eq(issues.status, 'open'), orderScope));
}

async function listVehicles(
  db: Database,
  depotId: string | null,
  date: string,
): Promise<VehicleFact[]> {
  const availability = and(
    eq(vehicleAvailability.vehicleId, vehicles.id),
    eq(vehicleAvailability.date, date),
  );
  const query = db
    .select({
      id: vehicles.id,
      type: vehicles.type,
      temp: vehicles.temp,
      weightCapKg: vehicles.weightCapKg,
      volumeCapM3: vehicles.volumeCapM3,
      kmPerL: vehicles.kmPerL,
      depotId: vehicles.depotId,
      availability: vehicleAvailability.status,
    })
    .from(vehicles)
    .leftJoin(vehicleAvailability, availability);
  const rows = await (depotId === null ? query : query.where(eq(vehicles.depotId, depotId)));
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    temp: row.temp,
    weightCapKg: asNumber(row.weightCapKg),
    volumeCapM3: asNumber(row.volumeCapM3),
    kmPerL: asNumber(row.kmPerL),
    depotId: row.depotId,
    availability: row.availability ?? 'available',
  }));
}

async function listDrivers(db: Database): Promise<DriverFact[]> {
  return db
    .select({ id: users.id, name: users.name, vehicleId: users.vehicleId })
    .from(users)
    .where(eq(users.role, 'driver'));
}

async function listFuel(db: Database, tripScope: SQL, date: string): Promise<FuelFact[]> {
  const rows = await db
    .select({ tripId: fuelLedger.tripId, litres: fuelLedger.litres })
    .from(fuelLedger)
    .innerJoin(trips, eq(trips.id, fuelLedger.tripId))
    .innerJoin(planningRuns, eq(planningRuns.id, trips.runId))
    .where(onDate(date, tripScope));
  return rows.map((row) => ({ tripId: row.tripId, litres: asNumber(row.litres) }));
}

async function listDepartures(db: Database, tripIds: readonly string[]): Promise<DepartureFact[]> {
  if (tripIds.length === 0) return [];
  const rows = await db
    .select({ tripId: auditLog.entityId, departedAt: auditLog.createdAt })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, 'trip.departed'),
        eq(auditLog.entityType, 'trip'),
        inArray(auditLog.entityId, [...tripIds]),
      ),
    );
  return rows.flatMap((row) =>
    row.departedAt === null ? [] : [{ tripId: row.tripId, departedAt: row.departedAt }],
  );
}

async function entityInScope(
  db: Database,
  scope: DashboardScope,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  switch (entityType) {
    case 'order':
      return exists(
        db
          .select({ id: orders.id })
          .from(orders)
          .where(and(eq(orders.id, entityId), scope.orders))
          .limit(1),
      );
    case 'trip':
      return exists(
        db
          .select({ id: trips.id })
          .from(trips)
          .where(and(eq(trips.id, entityId), scope.trips))
          .limit(1),
      );
    case 'stop':
      return exists(
        db
          .select({ id: tripStops.id })
          .from(tripStops)
          .innerJoin(trips, eq(trips.id, tripStops.tripId))
          .where(and(eq(tripStops.id, entityId), scope.trips))
          .limit(1),
      );
    case 'loading_issue':
      return exists(
        db
          .select({ id: loadingIssues.id })
          .from(loadingIssues)
          .innerJoin(trips, eq(trips.id, loadingIssues.tripId))
          .where(and(eq(loadingIssues.id, entityId), scope.trips))
          .limit(1),
      );
    case 'issue':
      return exists(
        db
          .select({ id: issues.id })
          .from(issues)
          .innerJoin(orders, eq(orders.id, issues.orderId))
          .where(and(eq(issues.id, entityId), scope.orders))
          .limit(1),
      );
    case 'sync_conflict':
      return exists(
        db
          .select({ id: syncConflicts.id })
          .from(syncConflicts)
          .innerJoin(stopEvents, eq(stopEvents.id, syncConflicts.eventId))
          .innerJoin(tripStops, eq(tripStops.id, stopEvents.stopId))
          .innerJoin(trips, eq(trips.id, tripStops.tripId))
          .where(and(eq(syncConflicts.id, entityId), scope.trips))
          .limit(1),
      );
    case 'planning_run':
      return exists(
        db
          .select({ id: planningRuns.id })
          .from(planningRuns)
          .where(
            and(
              eq(planningRuns.id, entityId),
              scope.depotId === null ? undefined : eq(planningRuns.depotId, scope.depotId),
            ),
          )
          .limit(1),
      );
    case 'deferral':
      return exists(
        db
          .select({ id: deferrals.id })
          .from(deferrals)
          .innerJoin(orders, eq(orders.id, deferrals.orderId))
          .where(and(eq(deferrals.id, entityId), scope.orders))
          .limit(1),
      );
    default:
      return false;
  }
}

async function exists(query: PromiseLike<readonly unknown[]>): Promise<boolean> {
  const rows = await query;
  return rows.length > 0;
}

function sqlCount() {
  return sql<number>`count(*)::int`;
}

function asNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
