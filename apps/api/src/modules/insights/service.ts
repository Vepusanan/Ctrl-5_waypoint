import type { Database } from '@waypoint/database';
import {
  addCalendarDays,
  and,
  asc,
  calendarDays,
  deferrals,
  demandHistory,
  desc,
  eq,
  inArray,
  orders,
  outlets,
  planningRuns,
  sql,
  stopEvents,
  tripStops,
  trips,
  users,
  vehicleAvailability,
  vehicles,
} from '@waypoint/database';
import type {
  DemandDay,
  DemandInsight,
  OutletHistoryList,
  OutletProfileFacts,
  TripNo,
  User,
} from '@waypoint/shared';
import { ApiError } from '../../plugins/errors.ts';
import { formatColomboTimestamp } from '../orders/cutoff.ts';

// Read-only decision support for the dispatcher (SRS UI-D10, UI-D13). Everything here is
// computed from recorded orders, runs and stop events, plus the seeded order history.

const HISTORY_WEEKS = 8;
const FORECAST_WEEKS = 10;
const ARRIVALS = 8;
const RUNS = 4;
/** Orders that count as demand: a draft or a cancelled order was never asked of the fleet. */
const NOT_DEMAND = ['draft', 'cancelled'] as const;

type Dispatcher = Extract<User, { role: 'dispatcher' }>;

export interface InsightService {
  demand(user: User | null, date: string): Promise<DemandInsight>;
  outletHistory(user: User | null): Promise<OutletHistoryList>;
  outletProfile(user: User | null, outletId: string, date: string): Promise<OutletProfileFacts>;
}

export function createInsightService(db: Database): InsightService {
  return {
    async demand(user, date) {
      const dispatcher = assertDispatcher(user);
      const depotId = depotOf(dispatcher);

      const fleetRows = await db
        .select({
          temp: vehicles.temp,
          volumeCapM3: vehicles.volumeCapM3,
          status: vehicleAvailability.status,
        })
        .from(vehicles)
        .leftJoin(
          vehicleAvailability,
          and(eq(vehicleAvailability.vehicleId, vehicles.id), eq(vehicleAvailability.date, date)),
        )
        .where(eq(vehicles.depotId, depotId));
      const fleetClass = (temp: 'reefer' | 'ambient') => {
        const rows = fleetRows.filter((row) => row.temp === temp);
        return {
          vehicles: rows.length,
          available: rows.filter((row) => row.status !== 'in_workshop').length,
          avgVolumeCapM3:
            rows.length === 0
              ? 0
              : round(rows.reduce((sum, row) => sum + row.volumeCapM3, 0) / rows.length),
        };
      };

      // The same weekday, one day per week: the latest observed weeks, then ten weeks ahead.
      // The supplied order history can end well before the service date, so the observed weeks
      // are the most recent ones that exist, not a fixed window.
      const sameWeekday = sql`extract(isodow from ${demandHistory.date}) = extract(isodow from ${date}::date)`;
      const seeded = await db
        .select({
          date: demandHistory.date,
          orders: sql<number>`sum(${demandHistory.orders})::int`,
          volumeM3: sql<number>`sum(${demandHistory.volumeM3})::float8`,
          chilledVolumeM3: sql<number>`sum(${demandHistory.chilledVolumeM3})::float8`,
        })
        .from(demandHistory)
        .where(
          and(
            eq(demandHistory.depotId, depotId),
            sameWeekday,
            sql`${demandHistory.date} <= ${date}`,
          ),
        )
        .groupBy(demandHistory.date)
        .orderBy(desc(demandHistory.date))
        .limit(HISTORY_WEEKS + 1);
      const recorded = await db
        .select({
          date: orders.requestedDate,
          orders: sql<number>`count(*)::int`,
          volumeM3: sql<number>`sum(${orders.volumeM3})::float8`,
          chilledVolumeM3: sql<number>`coalesce(sum(${orders.volumeM3}) filter (where ${orders.temp} = 'chilled'), 0)::float8`,
        })
        .from(orders)
        .innerJoin(outlets, eq(outlets.id, orders.outletId))
        .where(
          and(
            eq(outlets.depotId, depotId),
            sql`extract(isodow from ${orders.requestedDate}) = extract(isodow from ${date}::date)`,
            sql`${orders.requestedDate} <= ${date}`,
            sql`${orders.status} not in ${NOT_DEMAND}`,
          ),
        )
        .groupBy(orders.requestedDate)
        .orderBy(desc(orders.requestedDate))
        .limit(HISTORY_WEEKS + 1);
      // The platform's own orders are the truth for a day once it has any.
      const observed = new Map(seeded.map((row) => [row.date, row]));
      for (const row of recorded) observed.set(row.date, row);
      const past = [...observed.keys()].sort().slice(-(HISTORY_WEEKS + 1));
      const future = Array.from({ length: FORECAST_WEEKS }, (_, index) =>
        addCalendarDays(date, 7 * (index + 1)),
      );
      const calendar = new Map(
        (
          await db
            .select()
            .from(calendarDays)
            .where(inArray(calendarDays.date, [...past, ...future]))
        ).map((row) => [row.date, row]),
      );

      const day = (
        at: string,
        figures: { orders: number; volumeM3: number; chilledVolumeM3: number },
      ): DemandDay | null => {
        const row = calendar.get(at);
        if (row === undefined) return null;
        return {
          date: at,
          isoYear: row.isoYear,
          isoWeek: row.isoWeek,
          orders: round(figures.orders),
          volumeM3: round(figures.volumeM3),
          chilledVolumeM3: round(figures.chilledVolumeM3),
          isPayday: row.isPayday,
          festival: row.festival,
          festivalRamp: row.festivalRamp,
        };
      };
      const history = past.flatMap((at) => {
        const figures = observed.get(at);
        const entry = figures === undefined ? null : day(at, figures);
        return entry === null ? [] : [entry];
      });

      const uplift = await paydayUplift(db, depotId);
      // Payday and festival days are lifted out of the baseline so they are not counted twice.
      const baseline = history.map((entry) => {
        const factor = (entry.isPayday ? uplift : 1) * (1 + entry.festivalRamp);
        return {
          orders: entry.orders / factor,
          volumeM3: entry.volumeM3 / factor,
          chilledVolumeM3: entry.chilledVolumeM3 / factor,
        };
      });
      const mean = (pick: (row: (typeof baseline)[number]) => number) =>
        baseline.length === 0
          ? 0
          : baseline.reduce((sum, row) => sum + pick(row), 0) / baseline.length;
      const base = {
        orders: mean((row) => row.orders),
        volumeM3: mean((row) => row.volumeM3),
        chilledVolumeM3: mean((row) => row.chilledVolumeM3),
      };
      const forecast = future.flatMap((at) => {
        const row = calendar.get(at);
        if (row === undefined) return [];
        const factor = (row.isPayday ? uplift : 1) * (1 + row.festivalRamp);
        const entry = day(at, {
          orders: base.orders * factor,
          volumeM3: base.volumeM3 * factor,
          chilledVolumeM3: base.chilledVolumeM3 * factor,
        });
        return entry === null ? [] : [entry];
      });

      return {
        serviceDate: date,
        depotId,
        fleet: { reefer: fleetClass('reefer'), dry: fleetClass('ambient') },
        history,
        forecast,
        paydayUplift: uplift,
      };
    },

    async outletHistory(user) {
      const dispatcher = assertDispatcher(user);
      const scoped = await db
        .select({ id: outlets.id, depotId: outlets.depotId })
        .from(outlets)
        .where(dispatcher.depotId === null ? sql`true` : eq(outlets.depotId, dispatcher.depotId))
        .orderBy(asc(outlets.id));
      const ids = scoped.map((row) => row.id);
      if (ids.length === 0) return { items: [], total: 0 };

      const arrivalRows = await db
        .select({
          outletId: orders.outletId,
          late: tripStops.late,
          plannedArrival: tripStops.plannedArrival,
        })
        .from(tripStops)
        .innerJoin(orders, eq(orders.id, tripStops.orderId))
        .where(
          and(inArray(orders.outletId, ids), inArray(tripStops.status, ['arrived', 'delivered'])),
        )
        .orderBy(desc(tripStops.plannedArrival));
      const arrivals = new Map<string, boolean[]>();
      for (const row of arrivalRows) {
        const list = arrivals.get(row.outletId) ?? [];
        if (list.length < ARRIVALS) list.unshift(!row.late);
        arrivals.set(row.outletId, list);
      }

      const runs = await db
        .select({ id: planningRuns.id, depotId: planningRuns.depotId })
        .from(planningRuns)
        .where(eq(planningRuns.status, 'published'))
        .orderBy(desc(planningRuns.serviceDate));
      const deferredRows = await db
        .select({ runId: deferrals.runId, outletId: orders.outletId })
        .from(deferrals)
        .innerJoin(orders, eq(orders.id, deferrals.orderId))
        .where(inArray(orders.outletId, ids));
      const deferredIn = new Set(deferredRows.map((row) => `${row.runId}|${row.outletId}`));

      const items = scoped.map((outlet) => {
        const own = runs.filter((run) => run.depotId === outlet.depotId).slice(0, RUNS);
        return {
          outletId: outlet.id,
          arrivals: arrivals.get(outlet.id) ?? [],
          deferrals: own.map((run) => deferredIn.has(`${run.id}|${outlet.id}`)).reverse(),
        };
      });
      return { items, total: items.length };
    },

    async outletProfile(user, outletId, date) {
      const dispatcher = assertDispatcher(user);
      const [outlet] = await db
        .select({ id: outlets.id, depotId: outlets.depotId })
        .from(outlets)
        .where(eq(outlets.id, outletId))
        .limit(1);
      // Another depot's outlet reads as missing (SYSTEM_DESIGN §6.1).
      if (
        outlet === undefined ||
        (dispatcher.depotId !== null && outlet.depotId !== dispatcher.depotId)
      ) {
        throw new ApiError('NOT_FOUND', 'Outlet not found');
      }
      const [manager] = await db
        .select({ name: users.name })
        .from(users)
        .where(and(eq(users.role, 'store_manager'), eq(users.outletId, outletId)))
        .limit(1);

      const stops = await db
        .select({ id: tripStops.id, status: tripStops.status, late: tripStops.late })
        .from(tripStops)
        .innerJoin(orders, eq(orders.id, tripStops.orderId))
        .where(eq(orders.outletId, outletId));
      const reached = stops.filter(
        (stop) => stop.status === 'arrived' || stop.status === 'delivered',
      );

      const deferredRows = await db
        .select({ runId: deferrals.runId })
        .from(deferrals)
        .innerJoin(orders, eq(orders.id, deferrals.orderId))
        .where(eq(orders.outletId, outletId));
      const [runCount] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(planningRuns)
        .where(and(eq(planningRuns.depotId, outlet.depotId), eq(planningRuns.status, 'published')));

      // Unload time is arrival to delivery on the driver's own clock.
      const events =
        stops.length === 0
          ? []
          : await db
              .select({
                stopId: stopEvents.stopId,
                type: stopEvents.type,
                clientTime: stopEvents.clientTime,
              })
              .from(stopEvents)
              .where(
                inArray(
                  stopEvents.stopId,
                  stops.map((stop) => stop.id),
                ),
              );
      const unload: number[] = [];
      for (const stop of stops) {
        const arrived = events.find((row) => row.stopId === stop.id && row.type === 'arrived');
        const done = events.find((row) => row.stopId === stop.id && row.type === 'delivered');
        if (arrived && done) {
          const minutes = (done.clientTime.getTime() - arrived.clientTime.getTime()) / 60_000;
          if (minutes >= 0) unload.push(minutes);
        }
      }

      const weekdays = Array.from({ length: 6 }, (_, index) =>
        addCalendarDays(date, -7 * (5 - index)),
      );
      const volumeRows = await db
        .select({
          date: orders.requestedDate,
          kg: sql<number>`sum(${orders.weightKg})::float8`,
        })
        .from(orders)
        .where(
          and(
            eq(orders.outletId, outletId),
            inArray(orders.requestedDate, weekdays),
            sql`${orders.status} not in ${NOT_DEMAND}`,
          ),
        )
        .groupBy(orders.requestedDate)
        .orderBy(asc(orders.requestedDate));

      const [next] = await db
        .select({
          orderId: orders.id,
          requestedDate: orders.requestedDate,
          orderStatus: orders.status,
          stopId: tripStops.id,
          stopStatus: tripStops.status,
          vehicleId: trips.vehicleId,
          tripNo: trips.tripNo,
          serviceDate: planningRuns.serviceDate,
        })
        .from(orders)
        .leftJoin(tripStops, eq(tripStops.orderId, orders.id))
        .leftJoin(trips, eq(trips.id, tripStops.tripId))
        .leftJoin(planningRuns, eq(planningRuns.id, trips.runId))
        .where(
          and(
            eq(orders.outletId, outletId),
            sql`${orders.requestedDate} >= ${date}`,
            sql`${orders.status} not in ${NOT_DEMAND}`,
          ),
        )
        .orderBy(asc(orders.requestedDate), asc(orders.id))
        .limit(1);
      const arrivedAt =
        next?.stopId == null
          ? null
          : (events.find((row) => row.stopId === next.stopId && row.type === 'arrived')
              ?.clientTime ?? null);

      return {
        outletId,
        managerName: manager?.name ?? null,
        onTime: { arrivals: reached.filter((stop) => !stop.late).length, of: reached.length },
        deferred: { count: deferredRows.length, runs: runCount?.total ?? 0 },
        avgUnloadMinutes:
          unload.length === 0
            ? null
            : round(unload.reduce((sum, value) => sum + value, 0) / unload.length),
        volume: volumeRows.map((row) => ({ date: row.date, kg: round(row.kg) })),
        nextDelivery:
          next === undefined
            ? null
            : {
                serviceDate: next.serviceDate ?? next.requestedDate,
                orderId: next.orderId,
                orderStatus: next.orderStatus,
                stopStatus: next.stopStatus ?? null,
                arrivedAt: arrivedAt === null ? null : formatColomboTimestamp(arrivedAt),
                vehicleId: next.vehicleId ?? null,
                tripNo: next.tripNo == null ? null : asTripNo(next.tripNo),
              },
      };
    },
  };
}

function assertDispatcher(user: User | null): Dispatcher {
  if (user === null) throw new ApiError('UNAUTHENTICATED', 'Sign in required');
  if (user.role !== 'dispatcher') {
    throw new ApiError('FORBIDDEN', 'You do not have access to this action');
  }
  return user;
}

function depotOf(dispatcher: Dispatcher): string {
  if (dispatcher.depotId !== null) return dispatcher.depotId;
  throw new ApiError('VALIDATION_ERROR', 'This dispatcher has no depot to report on');
}

/** Mean payday-day volume over mean ordinary-day volume in the order history, never below 1. */
async function paydayUplift(db: Database, depotId: string): Promise<number> {
  const rows = await db
    .select({
      payday: calendarDays.isPayday,
      volume: sql<number>`avg(day.volume)::float8`,
    })
    .from(
      db
        .select({
          date: demandHistory.date,
          volume: sql<number>`sum(${demandHistory.volumeM3})`.as('volume'),
        })
        .from(demandHistory)
        .where(eq(demandHistory.depotId, depotId))
        .groupBy(demandHistory.date)
        .as('day'),
    )
    .innerJoin(calendarDays, eq(calendarDays.date, sql`day.date`))
    .groupBy(calendarDays.isPayday);
  const payday = rows.find((row) => row.payday)?.volume;
  const ordinary = rows.find((row) => !row.payday)?.volume;
  if (!payday || !ordinary) return 1;
  return Math.min(2, Math.max(1, round(payday / ordinary)));
}

function asTripNo(value: number): TripNo {
  if (value === 1 || value === 2) return value;
  throw new ApiError('INTERNAL_ERROR', 'Trip number is invalid');
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
