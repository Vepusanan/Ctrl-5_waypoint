import {
  districtTravelListResponseSchema,
  outletListResponseSchema,
  type PlanningQueueItem,
  planningQueueResponseSchema,
  type ReasonCode,
  serviceAllowanceListResponseSchema,
  type TripDetail,
  tripListResponseSchema,
  type VehicleReference,
  type Violation,
  vehicleListResponseSchema,
} from '@waypoint/shared';
import { api as http } from '../../../../lib/api';
import { orderName } from '../../../store/shared';
import type { QueueOrder, QueueTag, RuleGroup } from '../../contracts';
import { draftsOf, inspectDraft, planningInput, slotsFromTrips, type TripSlot } from '../../engine';
import { nextRun, session } from '../context';

/** Everything the planning pages read for one run, loaded from the real API in one go. */
export interface Snapshot {
  date: string;
  depotId: string;
  version: number;
  published: boolean;
  items: PlanningQueueItem[];
  byId: Map<string, PlanningQueueItem>;
  vehicles: VehicleReference[];
  trips: TripDetail[];
  /** The saved plan: two slots per available vehicle. */
  slots: TripSlot[];
  inputs: ReturnType<typeof planningInput>;
  /** Hard violations of the saved plan, from the planning package's validator. */
  violations: Violation[];
  inputError: string | null;
}

// Several pages and the sidebar ask for the same run within a moment of each other.
const FRESH_MS = 1500;
const cache = new Map<string, { at: number; value: Promise<Snapshot> }>();

/** Call after every write, so the next read sees the saved plan. */
export function forgetPlans() {
  cache.clear();
}

export function plan(date: string): Promise<Snapshot> {
  const key = `${session.depotId}:${date}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.value;
  const value = load(date, session.depotId);
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

async function load(date: string, depotId: string): Promise<Snapshot> {
  const [queue, vehicles, outlets, travel, allowances, trips] = await Promise.all([
    http(`/planning/runs/${date}/queue`, planningQueueResponseSchema),
    http(`/vehicles?depot=${depotId}&date=${date}`, vehicleListResponseSchema),
    http(`/outlets?depot=${depotId}`, outletListResponseSchema),
    http(`/district-travel?depot=${depotId}`, districtTravelListResponseSchema),
    http('/service-allowances', serviceAllowanceListResponseSchema),
    http(`/trips?date=${date}`, tripListResponseSchema),
  ]);
  const slots = slotsFromTrips(trips.items, vehicles.items);
  // Once a plan is published its orders leave the open queue. They are still the plan, so the
  // pages read them back from the trips: names, loads and counts stay whole after publishing.
  const queued = new Set(queue.items.map((item) => item.id));
  const outletById = new Map(outlets.items.map((outlet) => [outlet.id, outlet]));
  const planned: PlanningQueueItem[] = trips.items.flatMap((trip) =>
    trip.stops.flatMap((stop) => {
      const outlet = outletById.get(stop.order.outletId);
      if (queued.has(stop.order.id) || !outlet) return [];
      return [
        {
          ...stop.order,
          submittedAt: null,
          lockedAt: null,
          version: 0,
          deferredYesterday: false,
          daysSinceLastServed: 0,
          previousDeferral: null,
          outlet: {
            id: outlet.id,
            district: outlet.district,
            depotId: outlet.depotId,
            parkingConstraint: outlet.parkingConstraint,
            window: outlet.window,
            mallWindow: outlet.mallWindow,
          },
        },
      ];
    }),
  );
  const items = [...queue.items, ...planned];
  const inputs = planningInput(
    date,
    depotId,
    items,
    vehicles.items,
    outlets.items,
    travel.items,
    allowances.items,
  );
  const check = inspectDraft(inputs.validator, draftsOf(slots));
  return {
    date,
    depotId,
    version: queue.planVersion,
    published: trips.items.some((trip) => trip.run.status === 'published'),
    items,
    byId: new Map(items.map((item) => [item.id, item])),
    vehicles: vehicles.items,
    trips: trips.items,
    slots,
    inputs,
    violations: check.violations,
    inputError: check.inputError,
  };
}

/** Orders that already sit on a trip. */
export const placedIds = (slots: readonly TripSlot[]) =>
  new Set(slots.flatMap((slot) => slot.orderIds));

/** Orders still waiting for a trip: confirmed and not on any slot. */
export function unallocated(snapshot: Snapshot): PlanningQueueItem[] {
  const placed = placedIds(snapshot.slots);
  return snapshot.items.filter((item) => item.status === 'confirmed' && !placed.has(item.id));
}

const minutes = (time: string) => {
  const [hours = '0', mins = '0'] = time.split(':');
  return Number(hours) * 60 + Number(mins);
};

/** A delivery window of two hours or less leaves little room on a route. */
const TIGHT_WINDOW_MIN = 120;

// The API has no outlet names, so pages show brand and district beside the outlet code.
const outletLabel = (brand: string, district: string) => `${brand} ${district}`;

function queueTags(item: PlanningQueueItem): QueueTag[] {
  const { outlet } = item;
  const window = outlet.mallWindow ?? outlet.window;
  const tags: QueueTag[] = [];
  if (minutes(window.close) - minutes(window.open) <= TIGHT_WINDOW_MIN) tags.push('tight_window');
  if (outlet.parkingConstraint === 'van_only') tags.push('van_only');
  if (item.deferredYesterday || item.previousDeferral) tags.push('repeat_deferral');
  if (outlet.mallWindow) tags.push('mall_window');
  return tags;
}

/** The API reports the previous run only, so the three older runs read as served. */
export const deferralHistory = (item: PlanningQueueItem) => [
  false,
  false,
  false,
  item.deferredYesterday,
];

export function toQueueOrder(item: PlanningQueueItem, snapshot: Snapshot): QueueOrder {
  const slot = snapshot.slots.find((candidate) => candidate.orderIds.includes(item.id));
  return {
    id: item.id,
    reference: orderName(item.id),
    outlet: {
      code: item.outletId,
      name: outletLabel(item.brand, item.outlet.district),
      depot: item.outlet.depotId,
    },
    brand: item.brand,
    temp: item.temp,
    weightKg: item.weightKg,
    window: item.outlet.mallWindow ?? item.outlet.window,
    tags: queueTags(item),
    history: deferralHistory(item),
    state: slot
      ? { kind: 'allocated', vehicleId: slot.vehicleId, tripNo: slot.tripNo }
      : item.status === 'deferred'
        ? { kind: 'held', until: nextRun(snapshot.date) }
        : { kind: 'unallocated' },
  };
}

export const vehicleKind = (vehicle: { type: string; temp: string }) =>
  `${vehicle.temp === 'reefer' ? 'Reefer' : 'Dry'} ${vehicle.type}`;

/** Weight and volume on one slot, and the fuller of the two as a share of the vehicle. */
export function slotLoad(snapshot: Snapshot, slot: TripSlot, orderIds = slot.orderIds) {
  const vehicle = snapshot.vehicles.find((item) => item.id === slot.vehicleId);
  let kg = 0;
  let m3 = 0;
  for (const id of orderIds) {
    const order = snapshot.byId.get(id) ?? stopOrder(snapshot, id);
    kg += order?.weightKg ?? 0;
    m3 += order?.volumeM3 ?? 0;
  }
  const weightPercent = vehicle ? (kg / vehicle.weightCapKg) * 100 : 0;
  const volumePercent = vehicle ? (m3 / vehicle.volumeCapM3) * 100 : 0;
  return {
    kg,
    m3,
    weightPercent: Math.round(weightPercent),
    volumePercent: Math.round(volumePercent),
    percent: Math.round(Math.max(weightPercent, volumePercent)),
  };
}

/** An order as its trip stop carries it, for orders that have left the queue. */
function stopOrder(snapshot: Snapshot, orderId: string) {
  for (const trip of snapshot.trips) {
    const stop = trip.stops.find((item) => item.orderId === orderId);
    if (stop) return { ...stop.order, district: trip.district };
  }
  return undefined;
}

/** Display name of the stop for an order, wherever the order is known from. */
export function stopName(snapshot: Snapshot, orderId: string): string {
  const item = snapshot.byId.get(orderId);
  if (item) return `${item.outletId} · ${item.outlet.district}`;
  const order = stopOrder(snapshot, orderId);
  return order ? `${order.outletId} · ${order.district}` : orderName(orderId);
}

/** The slot a violation points at, from its trip key (VEH031-1), vehicle or order. */
export function violationSlot(snapshot: Snapshot, violation: Violation) {
  if (violation.tripKey) {
    const [vehicleId = '', trip] = violation.tripKey.split('-');
    return { vehicleId, tripNo: trip === '2' ? (2 as const) : (1 as const) };
  }
  const slot = violation.orderId
    ? snapshot.slots.find((item) => item.orderIds.includes(violation.orderId ?? ''))
    : snapshot.slots.find(
        (item) => item.vehicleId === violation.vehicleId && item.orderIds.length > 0,
      );
  if (slot) return { vehicleId: slot.vehicleId, tripNo: slot.tripNo };
  return violation.vehicleId ? { vehicleId: violation.vehicleId, tripNo: 1 as const } : null;
}

export const ruleGroups: Record<ReasonCode, RuleGroup> = {
  WEIGHT_CAP: 'capacity',
  VOLUME_CAP: 'capacity',
  REEFER_REQUIRED: 'refrigeration',
  VAN_REQUIRED: 'access',
  WINDOW_MISSED: 'window',
  FRESH_TIME_BUDGET: 'time',
  DAY_TIME_BUDGET: 'time',
  TRIP_LIMIT: 'time',
  FUEL_QUOTA: 'fuel',
  MIXED_BRAND_DISTRICT: 'grouping',
  WRONG_DEPOT: 'grouping',
  VEHICLE_UNAVAILABLE: 'grouping',
};

/** Identity of a violation, to tell the ones a change adds from the ones already there. */
export const violationKey = (violation: Violation) =>
  `${violation.rule}:${violation.tripKey ?? ''}:${violation.vehicleId ?? ''}:${violation.orderId ?? ''}`;

/**
 * Plan quality, 0–100. The API has no quality model yet, so this is a plain measure: mostly the
 * share of orders on a trip, then how full the trips are, less a penalty for hard violations.
 */
export function qualityScore(snapshot: Snapshot): number {
  const active = snapshot.items.filter((item) => item.status !== 'deferred');
  const placed = placedIds(snapshot.slots);
  const served = active.length
    ? active.filter((item) => placed.has(item.id)).length / active.length
    : 0;
  const used = snapshot.slots.filter((slot) => slot.orderIds.length > 0);
  const fill = used.length
    ? used.reduce((sum, slot) => sum + Math.min(100, slotLoad(snapshot, slot).percent), 0) /
      used.length /
      100
    : 0;
  const penalty = Math.min(20, snapshot.violations.length * 5);
  return Math.max(0, Math.min(100, Math.round(70 * served + 30 * fill - penalty)));
}
