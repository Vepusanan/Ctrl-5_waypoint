import type { Database } from '@waypoint/database';
import {
  calendarDays,
  deferrals,
  districtTravel,
  fuelLedger,
  notifications,
  orders,
  outlets,
  planningRuns,
  serviceAllowances,
  tripStops,
  trips,
  users,
  vehicleAvailability,
  vehicles,
} from '@waypoint/database';
import type {
  Brand,
  DeferralType,
  DockType,
  NotificationType,
  OrderStatus,
  ParkingConstraint,
  ReasonCode,
  RoadClass,
  TemperatureRequirement,
  TripNo,
  TripStatus,
  VehicleAvailabilityStatus,
  VehicleTemperature,
  VehicleType,
} from '@waypoint/shared';
import { and, asc, desc, eq, inArray, lt, lte, or, type SQL, sql } from 'drizzle-orm';
import { ApiError } from '../../plugins/errors.ts';

export type PlanningDb = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

interface CalendarDay {
  date: string;
  isOperating: boolean;
  isoYear: number;
  isoWeek: number;
}

export interface EligibleOrder {
  id: string;
  outletId: string;
  brand: Brand;
  temp: TemperatureRequirement;
  requestedDate: string;
  units: number;
  weightKg: number;
  volumeM3: number;
  status: OrderStatus;
  submittedAt: Date | null;
  lockedAt: Date | null;
  version: number;
  district: string;
  depotId: string;
  outletBrand: Brand;
  dockType: DockType;
  parkingConstraint: ParkingConstraint;
  windowOpen: string;
  windowClose: string;
  mallWindowOpen: string | null;
  mallWindowClose: string | null;
}

export interface VehicleRow {
  id: string;
  type: VehicleType;
  temp: VehicleTemperature;
  weightCapKg: number;
  volumeCapM3: number;
  kmPerL: number;
  weeklyFuelQuotaL: number;
  depotId: string;
}

interface DistrictTravelRow {
  district: string;
  depotId: string;
  roadClass: RoadClass;
  depotToDistrictKm: number;
  depotToDistrictMin: number;
  interStopKm: number;
  interStopMin: number;
}

interface ServiceAllowanceRow {
  brand: Brand;
  dockType: DockType;
  minutes: number;
}

export interface PlanningRunRow {
  id: string;
  depotId: string;
  serviceDate: string;
  status: 'open' | 'published';
  publishedAt: Date | null;
  publishedBy: string | null;
  planVersion: number;
}

export interface DraftTrip {
  vehicleId: string;
  tripNo: TripNo;
  orderIds: string[];
}

interface StoredStop {
  orderId: string;
  seq: number;
  plannedArrival: Date;
}

export interface StoredTrip {
  vehicleId: string;
  tripNo: TripNo;
  brand: Brand;
  district: string;
  status: TripStatus;
  version: number;
  plannedMinutes: number;
  plannedKm: number;
  litres: number;
  stops: StoredStop[];
}

interface DeferralDraft {
  orderId: string;
  reasonCode: ReasonCode;
  type: DeferralType;
  note: string;
  actorId: string;
  createdAt: Date;
}

interface PreviousDeferral {
  outletId: string;
  reasonCode: ReasonCode;
  type: DeferralType;
  serviceDate: string;
}

interface FuelWrite {
  vehicleId: string;
  isoYear: number;
  isoWeek: number;
  tripId: string;
  litres: number;
}

interface OrderStatusWrite {
  id: string;
  status: 'allocated' | 'deferred';
}

interface NotificationDraft {
  recipientId: string;
  type: NotificationType;
  priority: 'high';
  entityType: 'order' | 'trip';
  entityId: string;
  createdAt: Date;
}

export interface PlanningRepo {
  findCalendarDay(db: PlanningDb, date: string): Promise<CalendarDay | null>;
  previousOperatingDate(db: PlanningDb, beforeDate: string): Promise<string | null>;
  listOrdersByIds(
    db: PlanningDb,
    orderIds: readonly string[],
    userScope: SQL,
  ): Promise<EligibleOrder[]>;
  listEligibleOrders(
    db: PlanningDb,
    depotId: string,
    serviceDate: string,
    userScope: SQL,
  ): Promise<EligibleOrder[]>;
  outletsDeferredOn(
    db: PlanningDb,
    outletIds: readonly string[],
    serviceDate: string,
  ): Promise<Set<string>>;
  latestDeferrals(
    db: PlanningDb,
    outletIds: readonly string[],
  ): Promise<Map<string, PreviousDeferral>>;
  lastServedDates(
    db: PlanningDb,
    outletIds: readonly string[],
    beforeDate: string,
  ): Promise<Map<string, string>>;
  listDepotVehicles(db: PlanningDb, depotId: string): Promise<VehicleRow[]>;
  listVehiclesByIds(db: PlanningDb, ids: readonly string[]): Promise<VehicleRow[]>;
  listAvailability(
    db: PlanningDb,
    vehicleIds: readonly string[],
    serviceDate: string,
  ): Promise<Map<string, VehicleAvailabilityStatus>>;
  listDistrictTravel(db: PlanningDb, districts: readonly string[]): Promise<DistrictTravelRow[]>;
  listServiceAllowances(db: PlanningDb): Promise<ServiceAllowanceRow[]>;
  fuelUsedLitres(
    db: PlanningDb,
    vehicleIds: readonly string[],
    isoYear: number,
    isoWeek: number,
  ): Promise<Map<string, number>>;
  findRun(db: PlanningDb, depotId: string, serviceDate: string): Promise<PlanningRunRow | null>;
  lockRun(db: PlanningDb, depotId: string, serviceDate: string): Promise<PlanningRunRow>;
  listDrafts(db: PlanningDb, runId: string): Promise<DraftTrip[]>;
  replaceTrips(db: PlanningDb, runId: string, trips: readonly StoredTrip[]): Promise<string[]>;
  insertDeferrals(db: PlanningDb, runId: string, rows: readonly DeferralDraft[]): Promise<string[]>;
  countDeferrals(db: PlanningDb, runId: string): Promise<number>;
  insertFuel(db: PlanningDb, rows: readonly FuelWrite[]): Promise<void>;
  lockOrders(db: PlanningDb, ids: readonly string[]): Promise<Map<string, OrderStatus>>;
  markOrders(db: PlanningDb, rows: readonly OrderStatusWrite[]): Promise<void>;
  markPublished(
    db: PlanningDb,
    runId: string,
    expectedVersion: number,
    publishedAt: Date,
    publishedBy: string,
  ): Promise<PlanningRunRow | null>;
  bumpVersion(
    db: PlanningDb,
    runId: string,
    expectedVersion: number,
  ): Promise<PlanningRunRow | null>;
  listUserIds(
    db: PlanningDb,
    filter: { role: 'loader'; depotId: string } | { role: 'driver'; vehicleIds: readonly string[] },
  ): Promise<{ id: string; vehicleId: string | null }[]>;
  listStoreManagers(
    db: PlanningDb,
    outletIds: readonly string[],
  ): Promise<{ id: string; outletId: string }[]>;
  insertNotifications(db: PlanningDb, rows: readonly NotificationDraft[]): Promise<void>;
}

function first<T>(rows: T[]): T | null {
  return rows[0] ?? null;
}

function tripNo(value: number): TripNo {
  if (value === 1 || value === 2) return value;
  throw new ApiError('INTERNAL_ERROR', 'Stored trip number is invalid');
}

export function createPlanningRepo(): PlanningRepo {
  return {
    async findCalendarDay(db, date) {
      const rows = await db
        .select({
          date: calendarDays.date,
          isOperating: calendarDays.isOperating,
          isoYear: calendarDays.isoYear,
          isoWeek: calendarDays.isoWeek,
        })
        .from(calendarDays)
        .where(eq(calendarDays.date, date))
        .limit(1);
      return first(rows);
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

    async listOrdersByIds(db, orderIds, userScope) {
      if (orderIds.length === 0) return [];
      return db
        .select(eligibleOrderColumns)
        .from(orders)
        .innerJoin(outlets, eq(orders.outletId, outlets.id))
        .where(and(inArray(orders.id, [...orderIds]), userScope))
        .orderBy(asc(outlets.id), asc(orders.id));
    },

    async listEligibleOrders(db, depotId, serviceDate, userScope) {
      return db
        .select(eligibleOrderColumns)
        .from(orders)
        .innerJoin(outlets, eq(orders.outletId, outlets.id))
        .where(
          and(
            or(
              and(eq(orders.requestedDate, serviceDate), eq(orders.status, 'confirmed')),
              // A deferred order returns to the next run's queue (SYSTEM_DESIGN §5.3). It waits
              // for the first run after the one that deferred it.
              and(
                eq(orders.status, 'deferred'),
                lte(orders.requestedDate, serviceDate),
                sql`not exists (
                  select 1 from ${deferrals}
                  inner join ${planningRuns} on ${planningRuns.id} = ${deferrals.runId}
                  where ${deferrals.orderId} = ${orders.id}
                    and ${planningRuns.serviceDate} >= ${serviceDate}
                )`,
              ),
            ),
            eq(outlets.depotId, depotId),
            userScope,
          ),
        )
        .orderBy(asc(outlets.id), asc(orders.id));
    },

    async outletsDeferredOn(db, outletIds, serviceDate) {
      if (outletIds.length === 0) return new Set();
      const rows = await db
        .select({ outletId: orders.outletId })
        .from(deferrals)
        .innerJoin(planningRuns, eq(deferrals.runId, planningRuns.id))
        .innerJoin(orders, eq(deferrals.orderId, orders.id))
        .where(
          and(eq(planningRuns.serviceDate, serviceDate), inArray(orders.outletId, [...outletIds])),
        );
      return new Set(rows.map((row) => row.outletId));
    },

    async latestDeferrals(db, outletIds) {
      const latest = new Map<string, PreviousDeferral>();
      if (outletIds.length === 0) return latest;
      const rows = await db
        .select({
          outletId: orders.outletId,
          reasonCode: deferrals.reasonCode,
          type: deferrals.type,
          serviceDate: planningRuns.serviceDate,
        })
        .from(deferrals)
        .innerJoin(orders, eq(deferrals.orderId, orders.id))
        .innerJoin(planningRuns, eq(deferrals.runId, planningRuns.id))
        .where(inArray(orders.outletId, [...outletIds]))
        .orderBy(desc(planningRuns.serviceDate), desc(deferrals.createdAt));
      for (const row of rows) {
        if (!latest.has(row.outletId)) latest.set(row.outletId, row);
      }
      return latest;
    },

    async lastServedDates(db, outletIds, beforeDate) {
      const served = new Map<string, string>();
      if (outletIds.length === 0) return served;
      const rows = await db
        .select({
          outletId: orders.outletId,
          requestedDate: sql<string>`max(${orders.requestedDate})`,
        })
        .from(orders)
        .where(
          and(
            inArray(orders.outletId, [...outletIds]),
            lt(orders.requestedDate, beforeDate),
            inArray(orders.status, [
              'allocated',
              'loading',
              'dispatched',
              'delivered',
              'receipt_confirmed',
            ]),
          ),
        )
        .groupBy(orders.outletId);
      for (const row of rows) served.set(row.outletId, row.requestedDate);
      return served;
    },

    async listDepotVehicles(db, depotId) {
      return db
        .select(vehicleColumns)
        .from(vehicles)
        .where(eq(vehicles.depotId, depotId))
        .orderBy(asc(vehicles.id));
    },

    async listVehiclesByIds(db, ids) {
      if (ids.length === 0) return [];
      return db
        .select(vehicleColumns)
        .from(vehicles)
        .where(inArray(vehicles.id, [...ids]))
        .orderBy(asc(vehicles.id));
    },

    async listAvailability(db, vehicleIds, serviceDate) {
      const statuses = new Map<string, VehicleAvailabilityStatus>();
      if (vehicleIds.length === 0) return statuses;
      const rows = await db
        .select({ vehicleId: vehicleAvailability.vehicleId, status: vehicleAvailability.status })
        .from(vehicleAvailability)
        .where(
          and(
            eq(vehicleAvailability.date, serviceDate),
            inArray(vehicleAvailability.vehicleId, [...vehicleIds]),
          ),
        );
      for (const row of rows) statuses.set(row.vehicleId, row.status);
      return statuses;
    },

    async listDistrictTravel(db, districts) {
      if (districts.length === 0) return [];
      return db
        .select({
          district: districtTravel.district,
          depotId: districtTravel.depotId,
          roadClass: districtTravel.roadClass,
          depotToDistrictKm: districtTravel.depotToDistrictKm,
          depotToDistrictMin: districtTravel.depotToDistrictMin,
          interStopKm: districtTravel.interStopKm,
          interStopMin: districtTravel.interStopMin,
        })
        .from(districtTravel)
        .where(inArray(districtTravel.district, [...districts]));
    },

    async listServiceAllowances(db) {
      return db
        .select({
          brand: serviceAllowances.brand,
          dockType: serviceAllowances.dockType,
          minutes: serviceAllowances.minutes,
        })
        .from(serviceAllowances);
    },

    async fuelUsedLitres(db, vehicleIds, isoYear, isoWeek) {
      const used = new Map<string, number>();
      if (vehicleIds.length === 0) return used;
      const rows = await db
        .select({
          vehicleId: fuelLedger.vehicleId,
          litres: sql<string>`coalesce(sum(${fuelLedger.litres}), 0)`,
        })
        .from(fuelLedger)
        .where(
          and(
            inArray(fuelLedger.vehicleId, [...vehicleIds]),
            eq(fuelLedger.isoYear, isoYear),
            eq(fuelLedger.isoWeek, isoWeek),
          ),
        )
        .groupBy(fuelLedger.vehicleId);
      for (const row of rows) used.set(row.vehicleId, Number(row.litres));
      return used;
    },

    async findRun(db, depotId, serviceDate) {
      const rows = await db
        .select()
        .from(planningRuns)
        .where(and(eq(planningRuns.depotId, depotId), eq(planningRuns.serviceDate, serviceDate)))
        .limit(1);
      return first(rows);
    },

    async lockRun(db, depotId, serviceDate) {
      await db
        .insert(planningRuns)
        .values({ depotId, serviceDate })
        .onConflictDoNothing({ target: [planningRuns.depotId, planningRuns.serviceDate] });
      const rows = await db
        .select()
        .from(planningRuns)
        .where(and(eq(planningRuns.depotId, depotId), eq(planningRuns.serviceDate, serviceDate)))
        .limit(1)
        .for('update');
      const row = first(rows);
      if (row === null) throw new ApiError('INTERNAL_ERROR', 'Planning run was not created');
      return row;
    },

    async listDrafts(db, runId) {
      const tripRows = await db
        .select({ id: trips.id, vehicleId: trips.vehicleId, tripNo: trips.tripNo })
        .from(trips)
        .where(eq(trips.runId, runId))
        .orderBy(asc(trips.vehicleId), asc(trips.tripNo));
      if (tripRows.length === 0) return [];
      const stopRows = await db
        .select({ tripId: tripStops.tripId, orderId: tripStops.orderId, seq: tripStops.seq })
        .from(tripStops)
        .where(
          inArray(
            tripStops.tripId,
            tripRows.map((trip) => trip.id),
          ),
        )
        .orderBy(asc(tripStops.seq));
      const ordersByTrip = new Map<string, string[]>();
      for (const stop of stopRows) {
        const list = ordersByTrip.get(stop.tripId);
        if (list) list.push(stop.orderId);
        else ordersByTrip.set(stop.tripId, [stop.orderId]);
      }
      const drafts: DraftTrip[] = [];
      for (const trip of tripRows) {
        const orderIds = ordersByTrip.get(trip.id) ?? [];
        if (orderIds.length === 0) continue;
        drafts.push({ vehicleId: trip.vehicleId, tripNo: tripNo(trip.tripNo), orderIds });
      }
      return drafts;
    },

    async replaceTrips(db, runId, next) {
      const existing = await db.select({ id: trips.id }).from(trips).where(eq(trips.runId, runId));
      if (existing.length > 0) {
        const ids = existing.map((trip) => trip.id);
        await db.delete(tripStops).where(inArray(tripStops.tripId, ids));
        await db.delete(trips).where(eq(trips.runId, runId));
      }
      const ids: string[] = [];
      for (const trip of next) {
        const inserted = first(
          await db
            .insert(trips)
            .values({
              runId,
              vehicleId: trip.vehicleId,
              tripNo: trip.tripNo,
              brand: trip.brand,
              district: trip.district,
              status: trip.status,
              version: trip.version,
              plannedMinutes: trip.plannedMinutes,
              plannedKm: trip.plannedKm,
            })
            .returning({ id: trips.id }),
        );
        if (inserted === null) throw new ApiError('INTERNAL_ERROR', 'Trip was not created');
        ids.push(inserted.id);
        if (trip.stops.length === 0) continue;
        await db.insert(tripStops).values(
          trip.stops.map((stop) => ({
            tripId: inserted.id,
            orderId: stop.orderId,
            seq: stop.seq,
            plannedArrival: stop.plannedArrival,
          })),
        );
      }
      return ids;
    },

    async countDeferrals(db, runId) {
      const rows = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(deferrals)
        .where(eq(deferrals.runId, runId));
      return rows[0]?.total ?? 0;
    },

    async insertDeferrals(db, runId, rows) {
      if (rows.length === 0) return [];
      const inserted = await db
        .insert(deferrals)
        .values(
          rows.map((row) => ({
            orderId: row.orderId,
            runId,
            reasonCode: row.reasonCode,
            type: row.type,
            note: row.note,
            actorId: row.actorId,
            createdAt: row.createdAt,
          })),
        )
        .returning({ id: deferrals.id });
      return inserted.map((row) => row.id);
    },

    async insertFuel(db, rows) {
      if (rows.length === 0) return;
      await db.insert(fuelLedger).values([...rows]);
    },

    async lockOrders(db, ids) {
      const statuses = new Map<string, OrderStatus>();
      if (ids.length === 0) return statuses;
      const ordered = [...ids].sort();
      const rows = await db
        .select({ id: orders.id, status: orders.status })
        .from(orders)
        .where(inArray(orders.id, ordered))
        .orderBy(asc(orders.id))
        .for('update');
      for (const row of rows) statuses.set(row.id, row.status);
      return statuses;
    },

    async markOrders(db, rows) {
      for (const row of rows) {
        const updated = await db
          .update(orders)
          .set({ status: row.status, version: sql`${orders.version} + 1` })
          .where(and(eq(orders.id, row.id), inArray(orders.status, ['confirmed', 'deferred'])))
          .returning({ id: orders.id });
        if (updated.length === 0) {
          throw new ApiError('VERSION_CONFLICT', 'Order changed during publish');
        }
      }
    },

    async markPublished(db, runId, expectedVersion, publishedAt, publishedBy) {
      const rows = await db
        .update(planningRuns)
        .set({
          status: 'published',
          publishedAt,
          publishedBy,
          planVersion: expectedVersion + 1,
        })
        .where(and(eq(planningRuns.id, runId), eq(planningRuns.planVersion, expectedVersion)))
        .returning();
      return first(rows);
    },

    async bumpVersion(db, runId, expectedVersion) {
      const rows = await db
        .update(planningRuns)
        .set({ planVersion: expectedVersion + 1 })
        .where(
          and(
            eq(planningRuns.id, runId),
            eq(planningRuns.planVersion, expectedVersion),
            eq(planningRuns.status, 'open'),
          ),
        )
        .returning();
      return first(rows);
    },

    async listUserIds(db, filter) {
      if (filter.role === 'loader') {
        return db
          .select({ id: users.id, vehicleId: users.vehicleId })
          .from(users)
          .where(and(eq(users.role, 'loader'), eq(users.depotId, filter.depotId)));
      }
      if (filter.vehicleIds.length === 0) return [];
      return db
        .select({ id: users.id, vehicleId: users.vehicleId })
        .from(users)
        .where(and(eq(users.role, 'driver'), inArray(users.vehicleId, [...filter.vehicleIds])));
    },

    async insertNotifications(db, rows) {
      if (rows.length === 0) return;
      await db.insert(notifications).values([...rows]);
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
  };
}

const eligibleOrderColumns = {
  id: orders.id,
  outletId: orders.outletId,
  brand: orders.brand,
  temp: orders.temp,
  requestedDate: orders.requestedDate,
  units: orders.units,
  weightKg: orders.weightKg,
  volumeM3: orders.volumeM3,
  status: orders.status,
  submittedAt: orders.submittedAt,
  lockedAt: orders.lockedAt,
  version: orders.version,
  district: outlets.district,
  depotId: outlets.depotId,
  outletBrand: outlets.brand,
  dockType: outlets.dockType,
  parkingConstraint: outlets.parkingConstraint,
  windowOpen: outlets.windowOpen,
  windowClose: outlets.windowClose,
  mallWindowOpen: outlets.mallWindowOpen,
  mallWindowClose: outlets.mallWindowClose,
};

const vehicleColumns = {
  id: vehicles.id,
  type: vehicles.type,
  temp: vehicles.temp,
  weightCapKg: vehicles.weightCapKg,
  volumeCapM3: vehicles.volumeCapM3,
  kmPerL: vehicles.kmPerL,
  weeklyFuelQuotaL: vehicles.weeklyFuelQuotaL,
  depotId: vehicles.depotId,
};
