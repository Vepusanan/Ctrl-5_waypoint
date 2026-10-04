import {
  describeAssignment,
  PlanningInputError,
  scoreOrder,
  validateVehicleDay,
} from '@waypoint/planning';
import {
  allocationResponseSchema,
  autoAllocateResponseSchema,
  createDeferralRequestSchema,
  defaultPriorityWeights,
  deferralSchema,
  moveAllocationRequestSchema,
  type PlanMetrics,
  type PlanningQueueItem,
  publishPlanResponseSchema,
  type ReasonCode,
  type SimulateChange,
  simulatePlanResponseSchema,
  type Violation,
  validatePlanResponseSchema,
} from '@waypoint/shared';
import type { z } from 'zod';
import { HttpError, api as http } from '../../../../lib/api';
import { clock } from '../../../../lib/format';
import { orderName, reasonText } from '../../../store/shared';
import type {
  adviceSchema,
  allocationBoardSchema,
  autoRunSchema,
  Candidate,
  DeferralCandidate,
  deferralBoardSchema,
  fleetListSchema,
  HardViolation,
  Lever,
  planningQueueSchema,
  planReviewSchema,
  ScenarioMetric,
  scenarioResultSchema,
  scenarioSetupSchema,
  tripRecordSchema,
  validationSchema,
  vehicleInspectorSchema,
} from '../../contracts';
import { draftsOf, inspectDraft, placeOrder, type TripSlot } from '../../engine';
import { ruleLabels } from '../../rules';
import type { Source } from '../client';
import { nextRun, serverNow, session } from '../context';
import {
  deferralHistory,
  forgetPlans,
  placedIds,
  plan,
  qualityScore,
  ruleGroups,
  type Snapshot,
  slotLoad,
  stopName,
  toQueueOrder,
  unallocated,
  vehicleKind,
  violationKey,
  violationSlot,
} from './plan';

type Target = { vehicleId: string; tripNo: 1 | 2 };

const sameSlot = (slot: TripSlot, target: Target) =>
  slot.vehicleId === target.vehicleId && slot.tripNo === target.tripNo;

const usedSlots = (snapshot: Snapshot) => snapshot.slots.filter((slot) => slot.orderIds.length > 0);

/** Orders with a trip, as a share of the orders still in play. */
function servedPercent(snapshot: Snapshot) {
  const active = snapshot.items.filter((item) => item.status !== 'deferred');
  const placed = placedIds(snapshot.slots);
  return active.length
    ? Math.round((active.filter((item) => placed.has(item.id)).length / active.length) * 100)
    : 0;
}

function averageLoad(snapshot: Snapshot) {
  const used = usedSlots(snapshot);
  return used.length
    ? Math.round(
        used.reduce((sum, slot) => sum + slotLoad(snapshot, slot).percent, 0) / used.length,
      )
    : 0;
}

// D02 · Planning queue

async function queue(date: string): Promise<z.infer<typeof planningQueueSchema>> {
  const snapshot = await plan(date);
  return {
    date,
    // Orders close at 16:00 on the operating day before the run (SYSTEM_DESIGN §4).
    cutoffAt: snapshot.intake.cutoffAt,
    deltaPercent: null,
    items: snapshot.items.map((item) => toQueueOrder(item, snapshot)),
    total: snapshot.items.length,
  };
}

// D03 · Allocation + advisor

async function board(date: string): Promise<z.infer<typeof allocationBoardSchema>> {
  const snapshot = await plan(date);
  const waiting = unallocated(snapshot);
  return {
    date,
    planVersion: snapshot.version,
    quality: { score: qualityScore(snapshot), delta: null },
    orders: snapshot.items.length,
    allocated: placedIds(snapshot.slots).size,
    violations: snapshot.violations.length,
    risks: usedSlots(snapshot).filter((slot) => {
      const load = slotLoad(snapshot, slot).percent;
      return load >= 90 && load <= 100;
    }).length,
    tripLimitOk: !snapshot.violations.some((item) => item.rule === 'TRIP_LIMIT'),
    deferred: snapshot.items.filter((item) => item.status === 'deferred').length,
    unallocated: waiting.map((item) => toQueueOrder(item, snapshot)),
    vehicles: snapshot.vehicles
      .filter((vehicle) => snapshot.slots.some((slot) => slot.vehicleId === vehicle.id))
      .map((vehicle) => ({
        id: vehicle.id,
        kind: vehicleKind(vehicle),
        // GET /trips carries no driver, so the lane shows the vehicle only.
        driver: null,
        depot: vehicle.depotId,
        temp: vehicle.temp,
        type: vehicle.type,
        trips: snapshot.slots
          .filter((slot) => slot.vehicleId === vehicle.id)
          .map((slot) => ({
            tripNo: slot.tripNo,
            stops: slot.orderIds.map((orderId) => ({
              orderId,
              name: stopName(snapshot, orderId),
            })),
            loadPercent: slotLoad(snapshot, slot).percent,
          })),
      })),
  };
}

/** Hard violations one vehicle would have with `orderId` placed on `target`. */
function vehicleCheck(snapshot: Snapshot, orderId: string, target: Target): Violation[] | null {
  const next = placeOrder(snapshot.slots, orderId, target);
  const drafts = draftsOf(next.filter((slot) => slot.vehicleId === target.vehicleId));
  try {
    return validateVehicleDay(snapshot.inputs.validator, target.vehicleId, drafts);
  } catch (cause) {
    if (cause instanceof PlanningInputError) return null;
    throw cause;
  }
}

/** Every slot that takes the order without adding a hard violation, and why the others cannot. */
function options(snapshot: Snapshot, orderId: string) {
  const known = new Set(snapshot.violations.map(violationKey));
  const feasible: TripSlot[] = [];
  const blocked = new Map<string, Violation>();
  for (const slot of snapshot.slots) {
    if (slot.orderIds.includes(orderId)) continue;
    const found = vehicleCheck(snapshot, orderId, slot);
    const added = found?.filter((item) => !known.has(violationKey(item))) ?? [];
    if (found && added.length === 0) feasible.push(slot);
    else if (added[0] && !blocked.has(slot.vehicleId)) blocked.set(slot.vehicleId, added[0]);
  }
  for (const slot of feasible) blocked.delete(slot.vehicleId);
  return { feasible, blocked };
}

async function advice(date: string, orderId: string): Promise<z.infer<typeof adviceSchema>> {
  const snapshot = await plan(date);
  const item = snapshot.byId.get(orderId);
  if (!item) throw new HttpError(404, 'NOT_FOUND', 'That order is not in this run.');
  const { feasible, blocked } = options(snapshot, orderId);
  const candidates: Candidate[] = feasible.map((slot) => {
    const load = slotLoad(snapshot, slot, [...slot.orderIds, orderId]);
    const vehicle = snapshot.vehicles.find((entry) => entry.id === slot.vehicleId);
    return {
      vehicleId: slot.vehicleId,
      tripNo: slot.tripNo,
      // A fuller trip is the better fit: it keeps other vehicles free.
      score: Math.min(100, load.percent),
      summary: `${load.percent}% full · ${slot.orderIds.length + 1} stops`,
      factors: [
        { ok: true, text: 'Passes every hard rule' },
        {
          ok: true,
          text:
            item.temp === 'chilled'
              ? 'Refrigerated, as a chilled order needs'
              : `${vehicle ? vehicleKind(vehicle) : 'Vehicle'} suits the order`,
        },
        { ok: load.percent <= 90, text: `Load ${load.percent}% after this order` },
        {
          ok: slot.orderIds.length > 0,
          text: slot.orderIds.length
            ? `Joins ${slot.orderIds.length} stops already on the trip`
            : 'Opens a new trip',
        },
      ],
      seq: slot.orderIds.length + 1,
      loadPercentAfter: load.percent,
    };
  });
  candidates.sort((left, right) => right.score - left.score);
  return {
    orderId,
    candidates: candidates.slice(0, 6),
    blocked: [...blocked].map(([vehicleId, violation]) => ({
      vehicleId,
      rule: violation.rule,
      reason: violation.detail,
    })),
  };
}

/** The violations a change would add; the ones already on the plan do not count against it. */
const added = (found: readonly Violation[], snapshot: Snapshot) => {
  const known = new Set(snapshot.violations.map(violationKey));
  return found.filter((item) => !known.has(violationKey(item)));
};

const rejected = (violations: readonly Violation[]) =>
  new HttpError(
    422,
    'HARD_CONSTRAINT',
    violations[0]?.detail ?? 'This placement breaks a hard constraint.',
    [...violations],
  );

/** Moves one order: checked here, checked again by the server, then saved (as on main). */
async function move(date: string, body: unknown) {
  const { orderId, target } = moveAllocationRequestSchema.parse(body);
  const snapshot = await plan(date);
  if (snapshot.published) {
    throw new HttpError(409, 'RUN_PUBLISHED', 'This run is published. Its plan is closed.');
  }
  const next = placeOrder(snapshot.slots, orderId, target);
  // Taking an order off a trip cannot break a hard rule, so only placements are checked.
  if (target) {
    const local = inspectDraft(snapshot.inputs.validator, draftsOf(next));
    if (local.inputError) throw new HttpError(422, 'PLANNING_INPUT', local.inputError);
    const fresh = added(local.violations, snapshot);
    if (fresh.length > 0) throw rejected(fresh);
    const confirmed = await http('/planning/validate', validatePlanResponseSchema, {
      method: 'POST',
      body: JSON.stringify({ serviceDate: date, depotId: snapshot.depotId, trips: draftsOf(next) }),
    }).catch((cause: unknown) => {
      // The server reports hard violations as a 422 with the list attached.
      if (cause instanceof HttpError && cause.violations.length > 0) {
        return { violations: cause.violations };
      }
      throw cause;
    });
    const refused = added(confirmed.violations, snapshot);
    if (refused.length > 0) throw rejected(refused);
  }
  try {
    await http(`/planning/runs/${date}/allocations`, allocationResponseSchema, {
      method: 'PUT',
      headers: { 'If-Match': String(snapshot.version) },
      body: JSON.stringify({ orderId, target }),
    });
  } finally {
    forgetPlans();
  }
}

// D03a · Automatic allocation. The server keeps no record of a run, so the last one is held here.

type AutoRun = z.infer<typeof autoRunSchema>;
const autoRuns = new Map<string, { result: AutoRun; placed: string[] }>();

async function autoAllocate(date: string): Promise<AutoRun> {
  const before = await plan(date);
  if (before.published) {
    throw new HttpError(409, 'RUN_PUBLISHED', 'A published run cannot be auto-allocated.');
  }
  const started = performance.now();
  const response = await http(`/planning/runs/${date}/auto-allocate`, autoAllocateResponseSchema, {
    method: 'POST',
    headers: { 'If-Match': String(before.version) },
  }).finally(forgetPlans);
  const after = await plan(date);
  const already = placedIds(before.slots);
  const leftover = new Map<ReasonCode, number>();
  for (const item of response.deferred) {
    leftover.set(item.reason, (leftover.get(item.reason) ?? 0) + 1);
  }
  const result: AutoRun = {
    planVersion: response.planVersion,
    finishedAt: serverNow(),
    durationSeconds: Math.round((performance.now() - started) / 100) / 10,
    orders: response.metrics.servedOrders + response.metrics.deferredOrders,
    placed: response.metrics.servedOrders,
    leftover: [...leftover].map(([rule, count]) => ({ rule, count })),
    quality: {
      score: qualityScore(after),
      note: `${response.trips.length} trips · ${Math.round(response.metrics.avgWeightUtilization * 100)}% average weight fill`,
    },
    // The server returns the finished plan, not a list of single moves that could be undone.
    changes: [],
  };
  autoRuns.set(date, {
    result,
    placed: [...placedIds(after.slots)].filter((id) => !already.has(id)),
  });
  return result;
}

/** Takes the orders the run placed back off their trips, one saved move at a time. */
async function undoAutoRun(date: string) {
  const record = autoRuns.get(date);
  if (!record) throw new HttpError(404, 'NOT_FOUND', 'There is no automatic run to undo.');
  let { version } = await plan(date);
  try {
    for (const orderId of record.placed) {
      const saved = await http(`/planning/runs/${date}/allocations`, allocationResponseSchema, {
        method: 'PUT',
        headers: { 'If-Match': String(version) },
        body: JSON.stringify({ orderId, target: null }),
      });
      version = saved.planVersion;
    }
    autoRuns.delete(date);
  } finally {
    forgetPlans();
  }
}

// D05 · Validation

function toHardViolation(snapshot: Snapshot, violation: Violation, index: number): HardViolation {
  const slot = violationSlot(snapshot, violation);
  const onTrip = slot ? snapshot.slots.find((item) => sameSlot(item, slot)) : undefined;
  const measured =
    violation.actual !== undefined && violation.limit
      ? ` ${Math.round((violation.actual / violation.limit) * 100)}%`
      : '';
  return {
    id: `${violationKey(violation)}:${index}`,
    vehicleId: slot?.vehicleId ?? violation.vehicleId ?? 'VEH000',
    tripNo: slot?.tripNo ?? 1,
    rule: violation.rule,
    group: ruleGroups[violation.rule],
    summary: `${ruleLabels[violation.rule]}${measured}`,
    detail: violation.detail,
    orderIds: violation.orderId ? [violation.orderId] : (onTrip?.orderIds ?? []),
  };
}

function report(
  snapshot: Snapshot,
  violations: readonly Violation[],
): z.infer<typeof validationSchema> {
  const hard = violations.map((item, index) => toHardViolation(snapshot, item, index));
  const failing = new Set(hard.flatMap((item) => item.orderIds));
  const placed = placedIds(snapshot.slots);
  return {
    planVersion: snapshot.version,
    checkedAt: serverNow(),
    orders: placed.size,
    passing: [...placed].filter((id) => !failing.has(id)).length,
    violations: hard,
    // A trip between 90% and 100% of a capacity is allowed, and worth a look.
    risks: usedSlots(snapshot).flatMap((slot) => {
      const load = slotLoad(snapshot, slot);
      if (load.percent < 90 || load.percent > 100) return [];
      const weight = load.weightPercent >= load.volumePercent;
      return [
        {
          id: `load:${slot.vehicleId}:${slot.tripNo}`,
          group: 'capacity' as const,
          title: `${slot.vehicleId} · Trip ${slot.tripNo} is ${load.percent}% full`,
          detail: `${weight ? 'Weight' : 'Volume'} is close to the vehicle's limit.`,
          percent: load.percent,
          lateRiskPercent: null,
          vehicleId: slot.vehicleId,
        },
      ];
    }),
    insight: snapshot.inputError,
  };
}

async function validation(date: string, recheck: boolean) {
  if (recheck) forgetPlans();
  const snapshot = await plan(date);
  if (!recheck) return report(snapshot, snapshot.violations);
  // Re-run asks the server as well; it reports hard violations as a 422 with the list attached.
  const server = await http('/planning/validate', validatePlanResponseSchema, {
    method: 'POST',
    body: JSON.stringify({
      serviceDate: date,
      depotId: snapshot.depotId,
      trips: draftsOf(snapshot.slots),
    }),
  }).catch((cause: unknown) => {
    if (cause instanceof HttpError && cause.violations.length > 0) {
      return { violations: cause.violations };
    }
    throw cause;
  });
  const known = new Set(snapshot.violations.map(violationKey));
  return report(snapshot, [
    ...snapshot.violations,
    ...server.violations.filter((item) => !known.has(violationKey(item))),
  ]);
}

// D04 · Fleet & trips

async function fleet(date: string): Promise<z.infer<typeof fleetListSchema>> {
  const snapshot = await plan(date);
  const failing = new Set(
    snapshot.violations.map((item) => violationSlot(snapshot, item)?.vehicleId),
  );
  return {
    items: snapshot.vehicles.map((vehicle) => ({
      id: vehicle.id,
      kind: vehicleKind(vehicle),
      depot: vehicle.depotId,
      violation: failing.has(vehicle.id),
    })),
    total: snapshot.vehicles.length,
  };
}

async function inspector(
  date: string,
  vehicleId: string,
): Promise<z.infer<typeof vehicleInspectorSchema>> {
  const snapshot = await plan(date);
  const vehicle = snapshot.vehicles.find((item) => item.id === vehicleId);
  if (!vehicle) {
    throw new HttpError(404, 'NOT_FOUND', 'This vehicle is not in the depot fleet for the date.');
  }
  const recorded = snapshot.trips.filter((trip) => trip.vehicleId === vehicleId);
  const litres = recorded.reduce((sum, trip) => sum + trip.plannedKm / vehicle.kmPerL, 0);
  const quota = vehicle.weeklyFuelQuotaL;
  const slots = snapshot.slots.filter((slot) => slot.vehicleId === vehicleId);
  return {
    vehicle: {
      id: vehicle.id,
      kind: vehicleKind(vehicle),
      depot: vehicle.depotId,
      weightCapKg: vehicle.weightCapKg,
      volumeCapM3: vehicle.volumeCapM3,
      kmPerL: vehicle.kmPerL,
    },
    // The API gives the weekly quota but not the fuel already used this week.
    fuel: {
      percent: 0,
      afterPercent: quota > 0 ? Math.round((litres / quota) * 100) : 0,
      note:
        vehicle.availability && vehicle.availability.status !== 'available'
          ? 'In the workshop on this date'
          : `${litres.toFixed(1)} L planned on this run · weekly quota ${quota} L`,
    },
    trips: slots.map((slot) => {
      const load = slotLoad(snapshot, slot);
      const trip = recorded.find((item) => item.tripNo === slot.tripNo);
      const hard = snapshot.violations.filter((item) => {
        const at = violationSlot(snapshot, item);
        return at ? sameSlot(slot, at) : false;
      });
      return {
        tripNo: slot.tripNo,
        ...(trip && snapshot.published ? { status: trip.status } : {}),
        loadKg: Math.round(load.kg),
        loadM3: Math.round(load.m3 * 10) / 10,
        stops: slot.orderIds.map((orderId) => {
          const item = snapshot.byId.get(orderId);
          const stop = trip?.stops.find((entry) => entry.orderId === orderId);
          const outlet = item ? snapshot.inputs.plan.outlets[item.outletId] : undefined;
          return {
            orderId,
            name: stopName(snapshot, orderId),
            weightKg: item?.weightKg ?? stop?.order.weightKg ?? 0,
            volumeM3: item?.volumeM3 ?? stop?.order.volumeM3 ?? 0,
            plannedArrival: stop?.plannedArrival ?? `${date}T00:00:00+05:30`,
            serviceMinutes:
              item && outlet
                ? (snapshot.inputs.plan.serviceAllowance[`${item.brand}:${outlet.dockType}`] ?? 0)
                : 0,
            lateRiskPercent: null,
          };
        }),
        insight: trip
          ? `${Math.round(trip.plannedKm)} km · ${Math.round(trip.plannedMinutes)} min planned`
          : null,
        capacity: [
          { key: 'weight', label: 'Weight', percent: load.weightPercent },
          { key: 'volume', label: 'Volume', percent: load.volumePercent },
        ],
        capacityNote: hard[0]?.detail ?? null,
        // A ranked fix needs the advisor on the server; the page offers Allocation instead.
        fix: null,
      };
    }),
    published: snapshot.published,
    unavailable: vehicle.availability?.status === 'in_workshop',
  };
}

// D06 · Deferral decision center

const POLICY = [
  { label: 'Deferred in the last run', points: defaultPriorityWeights.deferredYesterday },
  { label: 'Days since last served', points: defaultPriorityWeights.daysSinceLastServedMax },
  { label: 'Chilled order', points: defaultPriorityWeights.chilled },
  { label: 'Fresh before 08:00', points: defaultPriorityWeights.freshBefore8 },
  { label: 'Tight window', points: defaultPriorityWeights.tightWindowMax },
];
const POLICY_POINTS = POLICY.reduce((sum, item) => sum + item.points, 0);

const daysBefore = (date: string, days: number) => {
  const at = new Date(`${date}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() - days);
  return at.toISOString().slice(0, 10);
};

function priority(snapshot: Snapshot, item: PlanningQueueItem) {
  const outlet = snapshot.inputs.plan.outlets[item.outletId];
  if (!outlet) return 0;
  const lite = {
    id: item.id,
    outletId: item.outletId,
    brand: item.brand,
    temp: item.temp,
    weightKg: item.weightKg,
    volumeM3: item.volumeM3,
    deferredYesterday: item.deferredYesterday,
    daysSinceLastServed: item.daysSinceLastServed,
  };
  return scoreOrder(lite, outlet, defaultPriorityWeights).total;
}

async function deferrals(date: string): Promise<z.infer<typeof deferralBoardSchema>> {
  const snapshot = await plan(date);
  const until = nextRun(date);
  const waiting = unallocated(snapshot).map((item) => {
    const { feasible, blocked } = options(snapshot, item.id);
    const block = feasible.length === 0 ? [...blocked.values()][0] : undefined;
    return { item, fits: feasible.length > 0, block, score: priority(snapshot, item) };
  });
  // Orders no trip can take come first, then the lowest priority.
  waiting.sort((left, right) => Number(left.fits) - Number(right.fits) || left.score - right.score);
  // POST /deferrals only accepts the reason and type the planning engine gives the order, so the
  // suggestion comes from the same engine. A draft that breaks a hard rule cannot be described.
  const engine = new Map<string, { reason: ReasonCode; type: 'unavoidable' | 'prioritized' }>();
  try {
    const described = describeAssignment(snapshot.inputs.plan, draftsOf(snapshot.slots));
    for (const row of described.deferred) engine.set(row.orderId, row);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
  const candidates: DeferralCandidate[] = waiting.map(({ item, fits, block, score }, index) => {
    const decided = engine.get(item.id);
    const rule = decided?.reason ?? block?.rule ?? 'WEIGHT_CAP';
    return {
      orderId: item.id,
      reference: orderName(item.id),
      outlet: { code: item.outletId, name: `${item.brand} ${item.outlet.district}` },
      temp: item.temp,
      weightKg: item.weightKg,
      reasons: [
        fits
          ? { severity: 'neutral' as const, rule: null, label: 'A trip can still take it' }
          : { severity: 'blocking' as const, rule, label: ruleLabels[rule] },
        ...(item.deferredYesterday
          ? [{ severity: 'pressure' as const, rule: null, label: 'Deferred in the last run' }]
          : []),
      ],
      facts: [
        {
          ok: !fits,
          text: fits
            ? 'A trip in this plan can still take the order'
            : (block?.detail ?? 'No trip in this plan can take the order'),
        },
        {
          ok: !item.deferredYesterday,
          text: item.deferredYesterday
            ? 'Already deferred in the last run'
            : 'Not deferred in the last run',
        },
        {
          ok: item.daysSinceLastServed <= 1,
          text: `${item.daysSinceLastServed} days since the outlet was last served`,
        },
      ],
      history: deferralHistory(item),
      daysSinceServed: item.daysSinceLastServed,
      lastServed: daysBefore(date, item.daysSinceLastServed),
      rank: index + 1,
      priorityPercent: Math.min(100, Math.round((score / POLICY_POINTS) * 100)),
      advice: fits ? 'serve' : 'defer',
      repeat: item.deferredYesterday,
      suggestedReason: rule,
      suggestedType: decided?.type ?? (fits ? 'prioritized' : 'unavoidable'),
      notice: `${reasonText[rule]} Your order moves to the run on ${until}.`,
    };
  });
  const chilled = waiting.filter(({ item, fits }) => item.temp === 'chilled' && !fits);
  const reefers = snapshot.vehicles.filter(
    (vehicle) =>
      vehicle.temp === 'reefer' && snapshot.slots.some((s) => s.vehicleId === vehicle.id),
  );
  const reeferKg = reefers.reduce((sum, vehicle) => sum + vehicle.weightCapKg * 2, 0);
  const chilledKg = snapshot.items
    .filter((item) => item.temp === 'chilled' && item.status !== 'deferred')
    .reduce((sum, item) => sum + item.weightKg, 0);
  return {
    planVersion: snapshot.version,
    nextRun: until,
    shortage:
      chilled.length > 0 && reeferKg > 0
        ? {
            label: 'Chilled orders without reefer space',
            count: chilled.length,
            detail: `${chilled.length} chilled ${chilled.length === 1 ? 'order does' : 'orders do'} not fit on the refrigerated fleet`,
            neededPercent: Math.round((chilledKg / reeferKg) * 100),
            capacityPercent: 100,
            capacityLabel: `${reefers.length} reefers · 2 trips each`,
          }
        : null,
    unallocated: waiting.length,
    policy: {
      id: 'standard',
      weights: POLICY.map((item) => ({
        label: item.label,
        percent: Math.round((item.points / POLICY_POINTS) * 100),
      })),
    },
    policies: [{ id: 'standard', name: 'Standard priority' }],
    candidates,
  };
}

async function defer(body: unknown) {
  const request = createDeferralRequestSchema.parse(body);
  const snapshot = await plan(request.serviceDate);
  await http('/deferrals', deferralSchema, {
    method: 'POST',
    headers: { 'If-Match': String(snapshot.version) },
    body: JSON.stringify(request),
  }).finally(forgetPlans);
}

// D07 · What-if simulator. The server simulates three kinds of change (SYSTEM_DESIGN §7.6).

const metrics = (value: PlanMetrics): ScenarioMetric[] => [
  { key: 'deferred', label: 'Orders deferred', value: value.deferredOrders, unit: '' },
  {
    key: 'reefer',
    label: 'Reefer capacity used',
    value: Math.round(value.reeferUtilization * 100),
    unit: '%',
  },
  { key: 'tight', label: 'Tight-window stops', value: value.tightWindowStops, unit: '' },
  {
    key: 'weight',
    label: 'Average weight fill',
    value: Math.round(value.avgWeightUtilization * 100),
    unit: '%',
  },
];

function levers(snapshot: Snapshot): Lever[] {
  const busy = [...new Set(usedSlots(snapshot).map((slot) => slot.vehicleId))];
  const removable = (busy.length ? busy : snapshot.slots.map((slot) => slot.vehicleId)).slice(0, 2);
  return [
    {
      id: 'extra_reefer',
      kind: 'hire_vehicle',
      title: 'Hire 1 reefer',
      detail: `+1 vehicle · ${snapshot.depotId}`,
    },
    ...[...new Set(removable)].map((vehicleId) => ({
      id: `remove:${vehicleId}`,
      kind: 'remove_vehicle' as const,
      title: `Remove ${vehicleId}`,
      detail: 'Unavailable on the day',
    })),
    { id: 'demand:1.1', kind: 'demand', title: 'Fresh demand +10%', detail: 'Fresh orders' },
    { id: 'demand:1.2', kind: 'demand', title: 'Fresh demand +20%', detail: 'Fresh orders' },
  ];
}

function changesFor(ids: readonly string[]): SimulateChange[] {
  const changes: SimulateChange[] = [];
  let factor = 1;
  for (const id of ids) {
    const [kind, value = ''] = id.split(':');
    if (kind === 'extra_reefer') changes.push({ type: 'extra_reefer' });
    else if (kind === 'remove') changes.push({ type: 'vehicle_unavailable', vehicleId: value });
    else if (kind === 'demand') factor = Math.max(factor, Number(value) || 1);
  }
  if (factor > 1) changes.push({ type: 'fresh_demand', factor });
  return changes;
}

const simulate = (date: string, changes: SimulateChange[]) =>
  http(`/planning/runs/${date}/simulate`, simulatePlanResponseSchema, {
    method: 'POST',
    body: JSON.stringify({ changes }),
  });

async function scenario(date: string): Promise<z.infer<typeof scenarioSetupSchema>> {
  const snapshot = await plan(date);
  // The baseline scorecard comes back with any simulation, so the smallest one is asked for.
  const { baseline } = await simulate(date, [{ type: 'extra_reefer' }]);
  return { planVersion: snapshot.version, levers: levers(snapshot), baseline: metrics(baseline) };
}

async function runScenario(
  date: string,
  body: unknown,
): Promise<z.infer<typeof scenarioResultSchema>> {
  const ids = (body as { levers?: string[] } | null)?.levers ?? [];
  const changes = changesFor(ids);
  if (changes.length === 0) throw new HttpError(400, 'NO_CHANGE', 'Choose a change to simulate.');
  const result = await simulate(date, changes);
  const fuel = result.scenario.fuelUsedL - result.baseline.fuelUsedL;
  const more = result.scenario.deferredOrders - result.baseline.deferredOrders;
  return {
    scenario: metrics(result.scenario),
    // The API prices nothing, so the cost of a scenario is its extra fuel.
    extraCost: {
      amount: Math.round(fuel),
      currency: 'L fuel',
      deltaPercent: result.baseline.fuelUsedL
        ? Math.round((fuel / result.baseline.fuelUsedL) * 1000) / 10
        : 0,
    },
    insight:
      more === 0
        ? 'This change leaves the number of deferred orders as it is.'
        : more < 0
          ? `${-more} fewer orders would be deferred.`
          : `${more} more orders would be deferred.`,
  };
}

// D08 · Review & publish

const PUBLISHED_KEY = 'waypoint.dispatch.published';

function publishedAt(date: string): string | null {
  try {
    return window.sessionStorage.getItem(`${PUBLISHED_KEY}.${date}`);
  } catch {
    return null;
  }
}

function rememberPublished(date: string, at: string) {
  try {
    window.sessionStorage.setItem(`${PUBLISHED_KEY}.${date}`, at);
  } catch {
    // Storage can be blocked; the time then comes from the clock on the next read.
  }
}

async function review(date: string): Promise<z.infer<typeof planReviewSchema>> {
  const snapshot = await plan(date);
  const used = usedSlots(snapshot);
  const waiting = unallocated(snapshot).length;
  const deferred = snapshot.items.filter((item) => item.status === 'deferred').length;
  const repeat = snapshot.items.filter(
    (item) => item.status === 'deferred' && item.deferredYesterday,
  ).length;
  const hard = snapshot.violations.length;
  const outlets = new Set(
    used.flatMap((slot) => slot.orderIds.map((id) => snapshot.byId.get(id)?.outletId ?? id)),
  );
  const reefers = used.filter(
    (slot) => snapshot.vehicles.find((vehicle) => vehicle.id === slot.vehicleId)?.temp === 'reefer',
  );
  const reeferLoad = reefers.length
    ? Math.round(
        reefers.reduce((sum, slot) => sum + slotLoad(snapshot, slot).percent, 0) / reefers.length,
      )
    : 0;
  const stops = snapshot.trips.flatMap((trip) => trip.stops);
  const arrivals = stops.map((stop) => stop.plannedArrival).sort();
  // The trip list does not carry the publish time; it is kept from this browser's own publish.
  const at = publishedAt(date) ?? serverNow();
  if (snapshot.published) rememberPublished(date, at);
  return {
    planVersion: snapshot.version,
    orders: snapshot.items.length,
    trips: used.length,
    deferred,
    quality: {
      score: qualityScore(snapshot),
      delta: null,
      previousVersion: null,
      factors: [
        { key: 'served', label: 'Orders on a trip', percent: servedPercent(snapshot) },
        { key: 'fill', label: 'Average trip load', percent: averageLoad(snapshot) },
        { key: 'reefer', label: 'Reefer trip load', percent: reeferLoad },
      ],
      note: null,
    },
    checks: [
      // The server refuses this publish too: these orders would be left out of the run.
      ...(!snapshot.intake.closed && snapshot.intake.awaiting > 0
        ? [
            {
              key: 'intake',
              state: 'fail' as const,
              title: 'Order cutoff',
              detail: `Orders stay open until ${snapshot.intake.cutoffAt.slice(11, 16)}. ${snapshot.intake.awaiting} submitted ${snapshot.intake.awaiting === 1 ? 'order joins' : 'orders join'} the run at the cutoff.`,
            },
          ]
        : []),
      {
        key: 'hard',
        state: hard || snapshot.inputError ? 'fail' : 'pass',
        title: 'Hard constraints',
        detail:
          snapshot.inputError ??
          (hard ? `${hard} hard violations block publishing` : 'No trip breaks a hard rule'),
      },
      // The server refuses an empty plan too: it would defer the whole run without a decision.
      {
        key: 'trips',
        state: used.length > 0 ? 'pass' : waiting > 0 || deferred === 0 ? 'fail' : 'warn',
        title: 'Orders on trips',
        detail:
          used.length > 0
            ? `${used.length} ${used.length === 1 ? 'trip carries' : 'trips carry'} orders`
            : waiting > 0
              ? `No order is on a trip. Publishing would defer all ${waiting}. Allocate them, or defer each one with a reason.`
              : deferred > 0
                ? 'Every order was deferred with a reason. Publishing sends the deferral notices only.'
                : 'There are no orders or deferrals to publish.',
      },
      {
        key: 'unallocated',
        state: waiting ? 'warn' : 'pass',
        title: 'Unallocated orders',
        detail: waiting
          ? `${waiting} ${waiting === 1 ? 'order has' : 'orders have'} no trip and no deferral yet`
          : 'Every order has a trip or a deferral',
      },
      {
        key: 'repeat',
        state: repeat ? 'warn' : 'pass',
        title: 'Repeat deferrals',
        detail: repeat
          ? `${repeat} ${repeat === 1 ? 'order is' : 'orders are'} deferred for a second run in a row`
          : 'No order is deferred twice in a row',
      },
    ],
    // The server has no late-arrival model yet, so no trip is marked.
    lateRisk: { trips: used.map(() => false), model: 'No late-arrival prediction yet' },
    notify: [
      { key: 'loaders', label: 'Loads to prepare', count: used.length },
      {
        key: 'drivers',
        label: 'Vehicles on the road',
        count: new Set(used.map((slot) => slot.vehicleId)).size,
      },
      { key: 'stores', label: 'Stores receiving', count: outlets.size },
      { key: 'deferrals', label: 'Deferral notices', count: deferred },
    ],
    windowNote: `Publishing sends plan v${snapshot.version} to loaders, drivers and store managers.`,
    published: snapshot.published
      ? {
          at,
          by: session.name,
          trips: snapshot.trips.length,
          drivers: {
            done: snapshot.trips.filter(
              (trip) => trip.status === 'departed' || trip.status === 'completed',
            ).length,
            total: snapshot.trips.length,
            note: 'Trips departed',
            recent: null,
          },
          loaders: {
            done: snapshot.trips.filter(
              (trip) => trip.loadingStatus === 'ready' || trip.loadingStatus === 'departed',
            ).length,
            total: snapshot.trips.length,
            note: 'Loads marked ready',
          },
          stores: {
            done: stops.filter((stop) => stop.status === 'delivered').length,
            total: stops.length,
            note: 'Stops delivered',
          },
          timeline: [
            ...(arrivals[0]
              ? [{ key: 'first_stops' as const, at: arrivals[0], label: 'First stops' }]
              : []),
            ...(arrivals.length > 1
              ? [{ key: 'last_stop' as const, at: arrivals.at(-1) ?? at, label: 'Last stop' }]
              : []),
          ],
          timelineNote: null,
          versions: [
            {
              version: snapshot.version,
              at,
              summary: `${snapshot.trips.length} trips · ${stops.length} stops`,
              live: true,
            },
          ],
        }
      : null,
  };
}

/** Publish, as on main: the saved plan is validated by the server, then published in one step. */
async function publish(date: string) {
  const snapshot = await plan(date);
  if (snapshot.inputError) throw new HttpError(422, 'PLANNING_INPUT', snapshot.inputError);
  if (snapshot.violations.length > 0) {
    throw new HttpError(422, 'HARD_CONSTRAINT', 'Hard violations must be cleared before publish.');
  }
  const confirmed = await http('/planning/validate', validatePlanResponseSchema, {
    method: 'POST',
    body: JSON.stringify({
      serviceDate: date,
      depotId: snapshot.depotId,
      trips: draftsOf(snapshot.slots),
    }),
  });
  if (confirmed.violations.length > 0) throw rejected(confirmed.violations);
  const response = await http(`/planning/runs/${date}/publish`, publishPlanResponseSchema, {
    method: 'POST',
    headers: { 'If-Match': String(snapshot.version) },
  }).finally(forgetPlans);
  rememberPublished(date, response.publishedAt);
  return response;
}

// D04a · Trip record, from what the loader and the driver recorded on the trip

const LOADING_STATE = {
  not_started: 'not-started',
  in_progress: 'loading',
  exception: 'loading-exception',
  ready: 'ready',
  departed: 'departed',
} as const;

const STOP_STATE = {
  pending: 'not-started',
  arrived: 'arrived',
  delivered: 'delivered',
  failed: 'failed',
} as const;

async function tripRecord(
  date: string,
  vehicleId: string,
  tripNo: string,
): Promise<z.infer<typeof tripRecordSchema>> {
  const snapshot = await plan(date);
  const trip = snapshot.trips.find(
    (item) => item.vehicleId === vehicleId && String(item.tripNo) === tripNo,
  );
  if (!trip) throw new HttpError(404, 'NOT_FOUND', 'That trip is not saved in this run yet.');
  const stops = [...trip.stops].sort((left, right) => left.seq - right.seq);
  const loaded = trip.loadingStatus === 'ready' || trip.loadingStatus === 'departed';
  return {
    vehicleId: trip.vehicleId,
    tripNo: trip.tripNo,
    loading: {
      // GET /trips names neither the loader nor the dock.
      loader: null,
      dock: null,
      state: LOADING_STATE[trip.loadingStatus],
      readyAt: null,
      stops: stops.map((stop) => {
        const issues = trip.exceptions.filter((issue) => issue.orderId === stop.orderId);
        const short = issues.reduce((sum, issue) => sum + issue.qty, 0);
        return {
          seq: stop.seq,
          outlet: { code: stop.order.outletId, name: `${stop.order.brand} ${trip.district}` },
          planned: stop.order.units,
          loaded: loaded ? Math.max(0, stop.order.units - short) : null,
          exception: issues[0] ? `${short} ${issues[0].type}` : null,
        };
      }),
    },
    owners: [
      {
        name: 'Loader',
        role: 'Loader',
        permission: 'Records loading',
        events: trip.exceptions.length,
        you: false,
      },
      {
        name: 'Driver',
        role: 'Driver',
        permission: 'Records delivery',
        events: stops.filter((stop) => stop.status !== 'pending').length,
        you: false,
      },
      { name: session.name, role: 'Dispatcher', permission: 'View only', events: null, you: true },
    ],
    delivery: {
      driver: null,
      stops: stops.map((stop) => ({
        seq: stop.seq,
        outletName: `${stop.order.outletId} · ${trip.district}`,
        state: STOP_STATE[stop.status],
        note: `Planned ${clock(stop.plannedArrival)}`,
        // Proof of delivery is not part of the trip list.
        signature: false,
        photo: false,
      })),
      fields: [
        { key: 'status', label: 'Trip status', value: trip.status, hint: 'From the trip record' },
        ...(trip.lastEvent
          ? [
              {
                key: 'last',
                label: 'Last event',
                value: clock(trip.lastEvent.serverTime),
                hint: 'Server time',
              },
            ]
          : []),
      ],
    },
  };
}

const dated = (params: Record<string, string>) => params.date ?? '';

export const planningSources: Source[] = [
  ['GET', '/planning/runs/:date/queue', ({ params }) => queue(dated(params))],
  ['GET', '/planning/runs/:date/board', ({ params }) => board(dated(params))],
  [
    'GET',
    '/planning/runs/:date/advice',
    ({ params, query }) => advice(dated(params), query.get('orderId') ?? ''),
  ],
  ['PUT', '/planning/runs/:date/allocations', ({ params, body }) => move(dated(params), body)],
  [
    'GET',
    '/planning/runs/:date/auto-run',
    async ({ params }) => {
      const record = autoRuns.get(dated(params));
      if (!record) throw new HttpError(404, 'NOT_FOUND', 'No automatic run yet.');
      return record.result;
    },
  ],
  ['POST', '/planning/runs/:date/auto-allocate', ({ params }) => autoAllocate(dated(params))],
  ['DELETE', '/planning/runs/:date/auto-run', ({ params }) => undoAutoRun(dated(params))],
  ['GET', '/planning/runs/:date/validation', ({ params }) => validation(dated(params), false)],
  ['POST', '/planning/runs/:date/validation', ({ params }) => validation(dated(params), true)],
  ['GET', '/planning/runs/:date/vehicles', ({ params }) => fleet(dated(params))],
  [
    'GET',
    '/planning/runs/:date/vehicles/:vehicleId',
    ({ params }) => inspector(dated(params), params.vehicleId ?? ''),
  ],
  [
    'GET',
    '/planning/runs/:date/vehicles/:vehicleId/trips/:tripNo/record',
    ({ params }) => tripRecord(dated(params), params.vehicleId ?? '', params.tripNo ?? ''),
  ],
  [
    'POST',
    '/planning/runs/:date/vehicles/:vehicleId/trips/:tripNo/record/corrections',
    async () => {
      throw new HttpError(
        409,
        'NOT_AVAILABLE',
        'The server cannot send correction requests yet. Call the depot instead.',
      );
    },
  ],
  ['GET', '/planning/runs/:date/deferral-candidates', ({ params }) => deferrals(dated(params))],
  ['POST', '/deferrals', ({ body }) => defer(body)],
  ['GET', '/planning/runs/:date/scenario', ({ params }) => scenario(dated(params))],
  ['POST', '/planning/runs/:date/simulate', ({ params, body }) => runScenario(dated(params), body)],
  [
    'POST',
    '/planning/runs/:date/simulate/apply',
    async () => {
      throw new HttpError(
        409,
        'NOT_AVAILABLE',
        'The server cannot copy a scenario into the draft yet. Make the change on Allocation.',
      );
    },
  ],
  ['GET', '/planning/runs/:date/review', ({ params }) => review(dated(params))],
  ['POST', '/planning/runs/:date/publish', ({ params }) => publish(dated(params))],
];
