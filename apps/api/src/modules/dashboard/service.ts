import type { Database } from '@waypoint/database';
import { buildPlanMetrics, calculateUtilization, TIGHT_WINDOW_SLACK_MIN } from '@waypoint/planning';
import type {
  AuditTimeline,
  AuditTimelineItem,
  DashboardDriver,
  DashboardException,
  DashboardExceptions,
  DashboardLoadingCounts,
  DashboardOrderCounts,
  DashboardStopCounts,
  DashboardSummary,
  LoadingStatus,
  OrderStatus,
  StopStatus,
  TripPlan,
  TripStatus,
  User,
  VehicleLite,
} from '@waypoint/shared';
import { DRIVER_STALE_AFTER_MS, stopStatusAfterEvent, uuidSchema } from '@waypoint/shared';
import type { OperatingClock } from '../../plugins/clock.ts';
import { ApiError } from '../../plugins/errors.ts';
import { scope } from '../../plugins/rbac.ts';
import { formatColomboTimestamp } from '../orders/cutoff.ts';
import {
  createDashboardRepo,
  type DashboardRepo,
  type DashboardScope,
  type DaySnapshot,
  type DeferredOrder,
  type FieldEventFact,
  type StopFact,
} from './repo.ts';

const MISSING = 'Entity not found';
const NO_FIELD_EVENTS = 'No field events · may be offline';
const WAITING = 'Waiting for a field event';

// Planned drafts, completed trips, and blocked vehicles are not in motion.
const ACTIVE_TRIPS = new Set<TripStatus>(['published', 'loading', 'ready', 'departed']);

const ORDER_FIELDS = {
  confirmed: 'confirmed',
  allocated: 'allocated',
  deferred: 'deferred',
  loading: 'loading',
  dispatched: 'dispatched',
  delivered: 'delivered',
  failed: 'failed',
  receipt_confirmed: 'receiptConfirmed',
} as const satisfies Partial<Record<OrderStatus, keyof DashboardOrderCounts>>;

type Dispatcher = Extract<User, { role: 'dispatcher' }>;

export interface DashboardService {
  summary(user: User | null, date: string): Promise<DashboardSummary>;
  exceptions(user: User | null, date: string): Promise<DashboardExceptions>;
  timeline(user: User | null, entityType: string, entityId: string): Promise<AuditTimeline>;
  outletIds(user: User | null): Promise<ReadonlySet<string> | null>;
}

export function createDashboardService(
  db: Database,
  clock: OperatingClock,
  repo: DashboardRepo = createDashboardRepo(),
): DashboardService {
  return {
    async summary(user, date) {
      const dispatcher = assertDispatcher(user);
      const day = await repo.load(db, dashboardScope(dispatcher), date);
      return toSummary(day, date, clock.now());
    },

    async exceptions(user, date) {
      const dispatcher = assertDispatcher(user);
      const day = await repo.load(db, dashboardScope(dispatcher), date);
      const items = toExceptions(day, date, clock.now());
      return { date, items, total: items.length };
    },

    async timeline(user, entityType, entityId) {
      const dispatcher = assertDispatcher(user);
      if (!uuidSchema.safeParse(entityId).success) throw new ApiError('NOT_FOUND', MISSING);
      const visible = await repo.entityVisible(
        db,
        dashboardScope(dispatcher),
        entityType,
        entityId,
      );
      if (!visible) throw new ApiError('NOT_FOUND', MISSING);
      const rows = await repo.listAudit(db, entityType, entityId);
      const items = rows.flatMap((row) => {
        if (row.createdAt === null) return [];
        const item: AuditTimelineItem = {
          id: row.id,
          actorId: row.actorId,
          role: row.role,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          before: jsonRecord(row.before),
          after: jsonRecord(row.after),
          createdAt: formatColomboTimestamp(row.createdAt),
        };
        return [item];
      });
      return { items, total: items.length };
    },

    async outletIds(user) {
      const dispatcher = assertDispatcher(user);
      if (dispatcher.depotId === null) return null;
      return new Set(await repo.listOutletIds(db, dispatcher.depotId));
    },
  };
}

function toSummary(day: DaySnapshot, date: string, now: Date): DashboardSummary {
  const orders = emptyOrders();
  for (const row of day.orderCounts) {
    const field = ORDER_FIELDS[row.status as keyof typeof ORDER_FIELDS];
    if (field !== undefined) orders[field] = row.total;
  }
  const loading = emptyLoading();
  const loadingByTrip = new Map(day.loading.map((row) => [row.tripId, row.status]));
  for (const trip of day.trips) {
    const status = loadingByTrip.get(trip.id) ?? 'not_started';
    loading[loadingField(status)] += 1;
  }
  const stops = emptyStops();
  let tightWindowStops = 0;
  for (const stop of day.stops) {
    stops[stop.status] += 1;
    if (isTight(stop)) tightWindowStops += 1;
  }
  const metrics = scorecard(day, tightWindowStops);
  const drivers = driverPresence(day, now);
  return {
    date,
    orders,
    repeatDeferrals: metrics.repeatDeferrals,
    loading,
    activeTrips: day.trips.filter((trip) => ACTIVE_TRIPS.has(trip.status)).length,
    stops,
    pendingLoadingIssues: day.loadingIssues.length,
    pendingSyncConflicts: day.conflicts.length,
    fleet: {
      available: day.vehicles.filter((vehicle) => vehicle.availability === 'available').length,
      unavailable: day.vehicles.filter((vehicle) => vehicle.availability === 'in_workshop').length,
    },
    utilization: {
      weight: metrics.avgWeightUtilization,
      volume: metrics.avgVolumeUtilization,
      reefer: metrics.reeferUtilization,
      van: metrics.vanUtilization,
    },
    fuelUsedL: metrics.fuelUsedL,
    tightWindowStops: metrics.tightWindowStops,
    drivers,
  };
}

function toExceptions(day: DaySnapshot, date: string, now: Date): DashboardException[] {
  const items: DashboardException[] = [];
  for (const issue of day.loadingIssues) {
    const detail = issue.note ?? `${issue.type} ${issue.qty}`;
    items.push(
      exception({
        severity: 'high',
        type: 'loading_shortfall',
        entityType: 'loading_issue',
        entityId: issue.id,
        title: 'Loading shortfall',
        reason: detail,
        occurredAt: issue.createdAt,
        href: `/api/v1/trips/${issue.tripId}/loading`,
      }),
    );
  }
  for (const stop of day.stops) {
    if (stop.status !== 'failed') continue;
    const failed = latestEvent(day.events, stop.id, 'failed');
    items.push(
      exception({
        severity: 'high',
        type: 'failed_delivery',
        entityType: 'stop',
        entityId: stop.id,
        title: 'Delivery failed',
        reason: failureReason(failed?.payload) ?? 'Delivery failed',
        occurredAt: failed?.serverTime ?? stop.plannedArrival,
        href: `/api/v1/stops/${stop.id}`,
      }),
    );
  }
  // An arrival after the window closed is an observed fact, not a prediction (SRS §42).
  for (const stop of day.stops) {
    if (!stop.late || stop.status === 'failed') continue;
    const arrived = latestEvent(day.events, stop.id, 'arrived');
    items.push(
      exception({
        severity: 'medium',
        type: 'late_delivery',
        entityType: 'stop',
        entityId: stop.id,
        title: 'Late arrival',
        reason: `Arrived after the window closed at ${stop.windowClose.slice(0, 5)}`,
        occurredAt: arrived?.serverTime ?? stop.plannedArrival,
        href: `/api/v1/stops/${stop.id}`,
      }),
    );
  }
  for (const issue of day.issues) {
    items.push(
      exception({
        severity: 'high',
        type: 'receipt_discrepancy',
        entityType: 'issue',
        entityId: issue.id,
        title: 'Receipt discrepancy',
        reason: issue.note ?? issue.type,
        occurredAt: issue.createdAt,
        href: `/api/v1/issues/${issue.id}`,
      }),
    );
  }
  for (const vehicle of day.vehicles) {
    if (vehicle.availability !== 'in_workshop') continue;
    items.push({
      severity: 'high',
      type: 'vehicle_unavailable',
      entityType: 'vehicle',
      entityId: vehicle.id,
      title: `${vehicle.id} is unavailable`,
      reason: 'in_workshop',
      occurredAt: `${date}T00:00:00.000+05:30`,
      action: { href: `/api/v1/planning/runs/${date}/queue` },
    });
  }
  const repeats = new Set(day.repeatOutletIds);
  for (const deferral of day.deferrals) {
    if (!repeats.has(deferral.outletId)) continue;
    items.push(
      exception({
        severity: 'high',
        type: 'repeat_deferral',
        entityType: 'deferral',
        entityId: deferral.id,
        title: 'Repeat deferral',
        reason: deferral.reasonCode,
        occurredAt: deferral.createdAt,
        href: `/api/v1/planning/runs/${date}/queue`,
      }),
    );
  }
  for (const conflict of day.conflicts) {
    items.push(
      exception({
        severity: 'medium',
        type: 'sync_conflict',
        entityType: 'sync_conflict',
        entityId: conflict.id,
        title: 'Sync conflict',
        reason: conflict.reason,
        occurredAt: conflict.createdAt,
        href: `/api/v1/trips/${conflict.tripId}`,
      }),
    );
  }
  for (const driver of driverPresence(day, now)) {
    if (driver.presence !== 'offline') continue;
    const who = driver.driverName ?? driver.vehicleId;
    items.push({
      severity: 'medium',
      type: 'stale_driver',
      entityType: 'trip',
      entityId: driver.tripId,
      title: `${who} may be offline`,
      reason: driver.label,
      occurredAt: driver.lastSeenAt ?? `${date}T00:00:00.000+05:30`,
      action: { href: `/api/v1/trips/${driver.tripId}` },
    });
  }
  for (const stop of day.stops) {
    if ((stop.status !== 'pending' && stop.status !== 'arrived') || !isTight(stop)) continue;
    items.push(
      exception({
        severity: 'low',
        type: 'tight_window',
        entityType: 'stop',
        entityId: stop.id,
        title: 'Tight delivery window',
        reason: 'Planned arrival is within 15 minutes of window close',
        occurredAt: stop.plannedArrival,
        href: `/api/v1/trips/${stop.tripId}`,
      }),
    );
  }
  const rank = { high: 0, medium: 1, low: 2 } as const;
  items.sort((left, right) => {
    const bySeverity = rank[left.severity] - rank[right.severity];
    if (bySeverity !== 0) return bySeverity;
    if (left.occurredAt !== right.occurredAt) return left.occurredAt < right.occurredAt ? 1 : -1;
    return left.type < right.type ? -1 : left.type > right.type ? 1 : 0;
  });
  return items;
}

function driverPresence(day: DaySnapshot, now: Date): DashboardDriver[] {
  const stopsById = new Map(day.stops.map((stop) => [stop.id, stop]));
  const latestByTrip = new Map<string, FieldEventFact>();
  for (const event of day.events) {
    const current = latestByTrip.get(event.tripId);
    if (current === undefined || event.serverTime.getTime() > current.serverTime.getTime()) {
      latestByTrip.set(event.tripId, event);
    }
  }
  const departedAt = new Map<string, Date>();
  for (const row of day.departures) {
    const current = departedAt.get(row.tripId);
    if (current === undefined || row.departedAt.getTime() > current.getTime()) {
      departedAt.set(row.tripId, row.departedAt);
    }
  }
  const driverByVehicle = new Map<string, { id: string; name: string }>();
  for (const driver of day.drivers) {
    if (driver.vehicleId !== null && !driverByVehicle.has(driver.vehicleId)) {
      driverByVehicle.set(driver.vehicleId, { id: driver.id, name: driver.name });
    }
  }
  const pendingByTrip = new Map<string, number>();
  for (const conflict of day.conflicts) {
    pendingByTrip.set(conflict.tripId, (pendingByTrip.get(conflict.tripId) ?? 0) + 1);
  }
  const rows: DashboardDriver[] = [];
  for (const trip of day.trips) {
    if (trip.status !== 'departed') continue;
    const driver = driverByVehicle.get(trip.vehicleId);
    const latest = latestByTrip.get(trip.id);
    const eventAt = latest?.serverTime ?? null;
    const departure = departedAt.get(trip.id) ?? null;
    const anchor = later(eventAt, departure);
    const eventFresh =
      eventAt !== null && now.getTime() - eventAt.getTime() < DRIVER_STALE_AFTER_MS;
    const stale = anchor === null || now.getTime() - anchor.getTime() >= DRIVER_STALE_AFTER_MS;
    const identity = {
      tripId: trip.id,
      vehicleId: trip.vehicleId,
      driverId: driver?.id ?? null,
      driverName: driver?.name ?? null,
      pendingSyncCount: pendingByTrip.get(trip.id) ?? 0,
    };
    if (eventFresh && latest !== undefined && eventAt !== null) {
      rows.push({
        ...identity,
        presence: 'live',
        lastSeenAt: formatColomboTimestamp(eventAt),
        lastStopStatus: stopStatus(stopsById.get(latest.stopId), latest),
      });
      continue;
    }
    if (stale) {
      rows.push({
        ...identity,
        presence: 'offline',
        lastSeenAt: anchor === null ? null : formatColomboTimestamp(anchor),
        label: anchor === null ? NO_FIELD_EVENTS : offlineLabel(anchor),
      });
      continue;
    }
    rows.push({
      ...identity,
      presence: 'waiting',
      lastSeenAt: anchor === null ? null : formatColomboTimestamp(anchor),
      label: WAITING,
    });
  }
  const rank = { offline: 0, waiting: 1, live: 2 } as const;
  rows.sort((left, right) => {
    const byPresence = rank[left.presence] - rank[right.presence];
    if (byPresence !== 0) return byPresence;
    if (left.tripId === right.tripId) return 0;
    return left.tripId < right.tripId ? -1 : 1;
  });
  return rows;
}

// SYSTEM_DESIGN §7.6. Ratios and fleet shares come from the planning scorecard.
function scorecard(day: DaySnapshot, tightWindowStops: number) {
  const fuelByTrip = new Map(day.fuel.map((row) => [row.tripId, row.litres]));
  const stopsByTrip = new Map<string, StopFact[]>();
  for (const stop of day.stops) {
    const list = stopsByTrip.get(stop.tripId);
    if (list === undefined) stopsByTrip.set(stop.tripId, [stop]);
    else list.push(stop);
  }
  const trips: TripPlan[] = [];
  for (const trip of day.trips) {
    const stops = stopsByTrip.get(trip.id) ?? [];
    if (stops.length === 0) continue;
    const tripNo = asTripNo(trip.tripNo);
    trips.push({
      vehicleId: trip.vehicleId,
      tripNo,
      brand: trip.brand,
      district: trip.district,
      stops: stops.map((stop) => ({
        orderId: stop.orderId,
        seq: stop.seq,
        plannedArrival: formatColomboTimestamp(stop.plannedArrival),
      })),
      minutes: trip.plannedMinutes,
      km: trip.plannedKm,
      litres: fuelByTrip.get(trip.id) ?? 0,
      utilization: calculateUtilization({
        weightKg: trip.weightKg,
        weightCapKg: trip.weightCapKg,
        volumeM3: trip.volumeM3,
        volumeCapM3: trip.volumeCapM3,
      }),
    });
  }
  const deferred = uniqueDeferred(day.deferrals);
  const repeatOutlets = new Set(day.repeatOutletIds);
  return buildPlanMetrics({
    orders: deferred.map((order) => ({
      id: order.orderId,
      outletId: order.outletId,
      brand: order.brand,
      temp: order.temp,
      weightKg: order.weightKg,
      volumeM3: order.volumeM3,
      deferredYesterday: repeatOutlets.has(order.outletId),
      daysSinceLastServed: 0,
    })),
    servedOrderIds: new Set<string>(),
    deferredOrderIds: deferred.map((order) => order.orderId),
    trips,
    fleet: day.vehicles
      .filter((vehicle) => vehicle.availability === 'available')
      .map(toVehicleLite),
    tightWindowStops,
  });
}

function uniqueDeferred(rows: readonly DeferredOrder[]): DeferredOrder[] {
  const byOrder = new Map<string, DeferredOrder>();
  for (const row of rows) {
    if (!byOrder.has(row.orderId)) byOrder.set(row.orderId, row);
  }
  return [...byOrder.values()];
}

function toVehicleLite(vehicle: DaySnapshot['vehicles'][number]): VehicleLite {
  return {
    id: vehicle.id,
    type: vehicle.type,
    temp: vehicle.temp,
    weightCapKg: vehicle.weightCapKg,
    volumeCapM3: vehicle.volumeCapM3,
    kmPerL: vehicle.kmPerL,
    depotId: vehicle.depotId,
  };
}

function isTight(stop: StopFact): boolean {
  const arrival = colomboMinutes(stop.plannedArrival);
  if (withinSlack(clockMinutes(stop.windowClose) - arrival)) return true;
  if (stop.mallWindowClose !== null && withinSlack(clockMinutes(stop.mallWindowClose) - arrival)) {
    return true;
  }
  return false;
}

function withinSlack(slack: number): boolean {
  return slack >= 0 && slack <= TIGHT_WINDOW_SLACK_MIN;
}

function colomboMinutes(instant: Date): number {
  return clockMinutes(formatColomboTimestamp(instant).slice(11, 19));
}

function clockMinutes(value: string): number {
  const [hour, minute] = value.split(':');
  if (hour === undefined || minute === undefined) return 0;
  return Number(hour) * 60 + Number(minute);
}

function offlineLabel(lastSeen: Date): string {
  const hhmm = formatColomboTimestamp(lastSeen).slice(11, 16);
  return `Last seen ${hhmm} · may be offline`;
}

function later(left: Date | null, right: Date | null): Date | null {
  if (left === null) return right;
  if (right === null) return left;
  return left.getTime() >= right.getTime() ? left : right;
}

function stopStatus(stop: StopFact | undefined, event: FieldEventFact): StopStatus {
  return stop?.status ?? stopStatusAfterEvent[event.type];
}

function latestEvent(
  events: readonly FieldEventFact[],
  stopId: string,
  type: FieldEventFact['type'],
): FieldEventFact | undefined {
  let latest: FieldEventFact | undefined;
  for (const event of events) {
    if (event.stopId !== stopId || event.type !== type) continue;
    if (latest === undefined || event.serverTime.getTime() > latest.serverTime.getTime()) {
      latest = event;
    }
  }
  return latest;
}

function failureReason(payload: FieldEventFact['payload'] | undefined): string | null {
  if (payload === undefined || !('reason' in payload)) return null;
  return payload.reason;
}

function exception(input: {
  severity: DashboardException['severity'];
  type: DashboardException['type'];
  entityType: DashboardException['entityType'];
  entityId: string;
  title: string;
  reason: string;
  occurredAt: Date;
  href: string;
}): DashboardException {
  return {
    severity: input.severity,
    type: input.type,
    entityType: input.entityType,
    entityId: input.entityId,
    title: input.title,
    reason: input.reason,
    occurredAt: formatColomboTimestamp(input.occurredAt),
    action: { href: input.href },
  };
}

function emptyOrders(): DashboardOrderCounts {
  return {
    confirmed: 0,
    allocated: 0,
    deferred: 0,
    loading: 0,
    dispatched: 0,
    delivered: 0,
    failed: 0,
    receiptConfirmed: 0,
  };
}

function emptyLoading(): DashboardLoadingCounts {
  return { notStarted: 0, inProgress: 0, exception: 0, ready: 0, departed: 0 };
}

function emptyStops(): DashboardStopCounts {
  return { pending: 0, arrived: 0, delivered: 0, failed: 0 };
}

function loadingField(status: LoadingStatus): keyof DashboardLoadingCounts {
  switch (status) {
    case 'not_started':
      return 'notStarted';
    case 'in_progress':
      return 'inProgress';
    case 'exception':
      return 'exception';
    case 'ready':
      return 'ready';
    case 'departed':
      return 'departed';
  }
}

function asTripNo(value: number): 1 | 2 {
  if (value === 1 || value === 2) return value;
  throw new ApiError('INTERNAL_ERROR', 'Trip number is invalid');
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function dashboardScope(user: Dispatcher): DashboardScope {
  return { orders: scope(user).orders, trips: scope(user).trips, depotId: user.depotId };
}

function assertDispatcher(user: User | null): Dispatcher {
  if (user === null) throw new ApiError('UNAUTHENTICATED', 'Sign in required');
  if (user.role !== 'dispatcher') {
    throw new ApiError('FORBIDDEN', 'You do not have access to this action');
  }
  return user;
}
