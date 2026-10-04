import {
  type DashboardException,
  dashboardExceptionsSchema,
  dashboardSummarySchema,
  type LoadingIssue,
  loadingIssueSchema,
  type TripDetail,
} from '@waypoint/shared';
import type { z } from 'zod';
import { HttpError, api as http } from '../../../../lib/api';
import { clock } from '../../../../lib/format';
import { orderName } from '../../../store/shared';
import type {
  CommandCenter,
  DispatchRun,
  LiveLane,
  LoadingException,
  liveBoardSchema,
  operationsSchema,
} from '../../contracts';
import type { Source } from '../client';
import { nextRun, previousDay, serverNow, session } from '../context';
import { forgetPlans, placedIds, plan, qualityScore, type Snapshot, unallocated } from './plan';

const summaryOf = (date: string) => http(`/dashboard/summary?date=${date}`, dashboardSummarySchema);
const exceptionsOf = (date: string) =>
  http(`/dashboard/exceptions?date=${date}`, dashboardExceptionsSchema);

const percent = (ratio: number) => Math.round(ratio * 100);

/** Exceptions that belong to the delivery day, not to planning. */
const LIVE: readonly DashboardException['type'][] = [
  'loading_shortfall',
  'failed_delivery',
  'late_delivery',
  'receipt_discrepancy',
  'sync_conflict',
  'stale_driver',
];

// Shell · run context and sidebar counts

async function run(date: string): Promise<DispatchRun> {
  const [snapshot, summary, exceptions] = await Promise.all([
    plan(date),
    summaryOf(date),
    exceptionsOf(date),
  ]);
  const cutoffDay = previousDay(date);
  return {
    serviceDate: date,
    now: serverNow(),
    depots: [snapshot.depotId],
    // Orders close at 16:00 the day before (SYSTEM_DESIGN §4). The API has no publish deadline,
    // so the Figma planning window of two hours stands in.
    planning: {
      opensAt: `${cutoffDay}T16:00:00+05:30`,
      publishBy: `${cutoffDay}T18:00:00+05:30`,
    },
    counts: {
      queue: snapshot.items.length,
      hardViolations: snapshot.violations.length,
      deferrals: summary.orders.deferred,
      liveExceptions: exceptions.items.filter((item) => LIVE.includes(item.type)).length,
    },
    // The bell reads the real notification feed; this count is not used for it.
    unreadNotifications: 0,
  };
}

// D01 · Command center

function countBy(snapshot: Snapshot, key: (item: Snapshot['items'][number]) => string) {
  const counts = new Map<string, number>();
  for (const item of snapshot.items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts]
    .map(([name, orders]) => ({ name, orders }))
    .sort((left, right) => right.orders - left.orders);
}

async function commandCenter(date: string): Promise<CommandCenter> {
  const [snapshot, summary, exceptions] = await Promise.all([
    plan(date),
    summaryOf(date),
    exceptionsOf(date),
  ]);
  const { utilization } = summary;
  const hard = snapshot.violations.length;
  const risks = [
    { key: 'reefer', label: 'Reefer capacity', percent: percent(utilization.reefer) },
    { key: 'van', label: 'Van-only slots', percent: percent(utilization.van) },
    { key: 'weight', label: 'Weight', percent: percent(utilization.weight) },
    { key: 'volume', label: 'Volume', percent: percent(utilization.volume) },
  ];
  const placed = placedIds(snapshot.slots).size;
  return {
    date,
    orders: {
      total: snapshot.items.length,
      deltaPercent: null,
      breakdowns: [
        {
          key: 'district',
          label: 'By district',
          bars: countBy(snapshot, (item) => item.outlet.district).slice(0, 8),
        },
        { key: 'brand', label: 'By brand', bars: countBy(snapshot, (item) => item.brand) },
        {
          key: 'temp',
          label: 'By temperature',
          bars: countBy(snapshot, (item) => (item.temp === 'chilled' ? 'Chilled' : 'Dry')),
        },
      ],
      insight: null,
    },
    unallocated: unallocated(snapshot).length,
    held: { count: summary.orders.deferred, delta: null },
    hardViolations: hard,
    risks: {
      nearLimit: risks.filter((item) => item.percent >= 90).length,
      items: risks,
      insight: null,
    },
    quality: {
      score: qualityScore(snapshot),
      delta: null,
      // No arrival predictions yet: the share of stops that are not tight on their window.
      onTimePercent: placed
        ? Math.max(0, Math.round((1 - summary.tightWindowStops / placed) * 100))
        : 0,
      fillPercent: percent(Math.max(utilization.weight, utilization.volume)),
      fairness:
        summary.repeatDeferrals === 0
          ? 'No repeat deferrals'
          : `${summary.repeatDeferrals} repeat deferrals`,
    },
    reefer: { percent: percent(utilization.reefer), note: null },
    actions: [
      ...(hard
        ? [
            {
              id: 'plan',
              kind: 'hard_violation' as const,
              title: `${hard} hard violations`,
              detail: snapshot.violations[0]?.detail ?? 'The plan cannot be published',
            },
          ]
        : []),
      ...exceptions.items.map((item) => ({
        id: item.entityId,
        kind: item.type,
        title: item.title,
        detail: item.reason,
      })),
    ],
  };
}

// D01 · Command center, operations view

const todayKind = (type: DashboardException['type']) =>
  type === 'sync_conflict' || type === 'stale_driver'
    ? ('sync' as const)
    : type === 'loading_shortfall' || type === 'receipt_discrepancy'
      ? ('shortage' as const)
      : type === 'repeat_deferral'
        ? ('queue' as const)
        : ('plan' as const);

async function operations(date: string): Promise<z.infer<typeof operationsSchema>> {
  const [snapshot, summary, exceptions] = await Promise.all([
    plan(date),
    summaryOf(date),
    exceptionsOf(date),
  ]);
  const { stops } = summary;
  const total = stops.pending + stops.arrived + stops.delivered + stops.failed;
  const closed = stops.delivered + stops.failed;
  return {
    date,
    stops: {
      delivered: stops.delivered,
      total,
      deltaPercent: null,
      // The API reports stop totals, not when each stop was delivered.
      byHour: [],
      insight: null,
    },
    loadingExceptions: {
      count: summary.loading.exception,
      open: summary.pendingLoadingIssues,
    },
    driversOffline: summary.drivers.filter((driver) => driver.presence === 'offline').length,
    deferred: {
      count: summary.orders.deferred,
      until: summary.orders.deferred ? nextRun(date) : null,
    },
    // Stops delivered out of stops closed; arrival against the window is not reported yet.
    onTimePercent: closed ? Math.round((stops.delivered / closed) * 100) : 0,
    today: [
      {
        id: 'plan',
        kind: 'plan',
        title: `Plan v${snapshot.version} · ${snapshot.trips.length} trips`,
        detail: `${summary.loading.departed} departed · ${summary.loading.ready} ready · ${summary.loading.inProgress} loading`,
        done: snapshot.published,
      },
      ...exceptions.items.map((item) => ({
        id: `${item.type}:${item.entityId}`,
        kind: todayKind(item.type),
        title: item.title,
        detail: item.reason,
        done: false,
      })),
    ],
  };
}

// D09 · Live operations

const iso = (ms: number) => new Date(ms).toISOString();

/** The trip's planned time on the road, from its stop arrivals and planned minutes. */
function plannedSpan(trip: TripDetail, date: string) {
  const arrivals = trip.stops.map((stop) => Date.parse(stop.plannedArrival));
  const first = arrivals.length ? Math.min(...arrivals) : Date.parse(`${date}T06:00:00+05:30`);
  const last = arrivals.length ? Math.max(...arrivals) : first;
  const start = Math.min(first, last - trip.plannedMinutes * 60_000);
  return { start: iso(start), end: iso(Math.max(last, start + trip.plannedMinutes * 60_000)) };
}

function laneStatus(trip: TripDetail): LiveLane['status'] {
  if (trip.status === 'completed') return 'completed';
  if (trip.status === 'departed') return 'departed';
  if (trip.loadingStatus === 'exception' || trip.status === 'blocked') return 'loading_exception';
  if (trip.loadingStatus === 'in_progress') return 'loading';
  if (trip.loadingStatus === 'ready') return 'ready';
  return trip.status === 'planned' ? 'allocated' : 'not_started';
}

const openIssue = (trip: TripDetail) =>
  trip.exceptions.find((issue) => issue.acknowledgedAt === null) ?? null;

const issueTitle = (trip: TripDetail, issue: LoadingIssue) =>
  `${trip.vehicleId} · Trip ${trip.tripNo} · ${issue.qty} ${issue.type}`;

async function live(date: string): Promise<z.infer<typeof liveBoardSchema>> {
  const [snapshot, summary] = await Promise.all([plan(date), summaryOf(date)]);
  const trips = snapshot.trips;
  const lanes: LiveLane[] = trips.map((trip) => {
    const planned = plannedSpan(trip, date);
    const driver = summary.drivers.find((item) => item.tripId === trip.id);
    const delivered = trip.stops.filter((stop) => stop.status === 'delivered').length;
    const failed = trip.stops.filter((stop) => stop.status === 'failed').length;
    return {
      tripId: trip.id,
      vehicleId: trip.vehicleId,
      tripNo: trip.tripNo,
      depot: trip.vehicle.depotId,
      status: laneStatus(trip),
      planned,
      // Only the latest event time is reported, so the bar runs from the planned start to it.
      recorded: trip.lastEvent
        ? {
            start: iso(Math.min(Date.parse(planned.start), Date.parse(trip.lastEvent.serverTime))),
            end: trip.lastEvent.serverTime,
          }
        : null,
      predicted: null,
      lateRisk: false,
      exceptionId: openIssue(trip)?.id ?? null,
      staleSince: driver?.presence === 'offline' ? driver.lastSeenAt : null,
      summary: `${delivered} of ${trip.stops.length} stops${failed ? ` · ${failed} failed` : ''}`,
    };
  });
  const starts = lanes.map((lane) => Date.parse(lane.planned.start));
  const ends = lanes.map((lane) => Date.parse(lane.planned.end));
  const stops = trips.flatMap((trip) => trip.stops);
  const blocked = trips.find((trip) => openIssue(trip));
  const issue = blocked ? openIssue(blocked) : null;
  return {
    now: serverNow(),
    axis: lanes.length
      ? { start: iso(Math.min(...starts)), end: iso(Math.max(...ends)) }
      : { start: `${date}T03:30:00+05:30`, end: `${date}T16:00:00+05:30` },
    trips: trips.length,
    departed: lanes.filter((lane) => lane.status === 'departed' || lane.status === 'completed')
      .length,
    loading: lanes.filter((lane) => lane.status === 'loading').length,
    loadingExceptions: lanes.filter((lane) => lane.status === 'loading_exception').length,
    lateRisk: 0,
    stops: {
      delivered: stops.filter((stop) => stop.status === 'delivered').length,
      total: stops.length,
      deltaPercent: null,
      note: null,
    },
    lanes,
    alert:
      blocked && issue
        ? {
            exceptionId: issue.id,
            blocking: true,
            title: issueTitle(blocked, issue),
            facts: [
              `Order ${orderName(issue.orderId)}`,
              ...(issue.note ? [issue.note] : []),
              `Reported ${clock(issue.createdAt)}`,
            ],
            note: 'The loader cannot mark this load ready until the shortfall is acknowledged.',
          }
        : null,
    anomaly: null,
  };
}

// D09a–c · Loading exception. The API can acknowledge an issue; it cannot replan around one.

const ACKNOWLEDGE = 'acknowledge';

async function exception(id: string): Promise<LoadingException> {
  const date = session.date;
  const snapshot = await plan(date);
  const trip = snapshot.trips.find((item) => item.exceptions.some((issue) => issue.id === id));
  const issue = trip?.exceptions.find((item) => item.id === id);
  if (!trip || !issue) {
    throw new HttpError(404, 'NOT_FOUND', 'That loading exception is not on this run.');
  }
  const stop = trip.stops.find((item) => item.orderId === issue.orderId);
  const planned = plannedSpan(trip, date);
  const done = issue.acknowledgedAt !== null;
  const version = `v${trip.run.planVersion}`;
  return {
    id,
    vehicleId: trip.vehicleId,
    tripNo: trip.tripNo,
    // Every shortfall holds the load until a dispatcher acknowledges it.
    blocking: true,
    status: done ? 'acknowledged' : 'open',
    reportedAt: issue.createdAt,
    place: trip.vehicle.depotId,
    plannedDeparture: planned.start,
    dock: { name: `${trip.vehicle.depotId} dock`, phone: null },
    evidence: {
      item: stop
        ? `${stop.order.brand} order ${orderName(issue.orderId)}`
        : orderName(issue.orderId),
      destination: stop ? `${stop.order.outletId} · ${trip.district}` : trip.district,
      quantity: -issue.qty,
      unit: issue.type === 'damaged' ? 'units damaged' : 'units',
      temp: stop?.order.temp ?? 'ambient',
      reporter: 'Loader',
      reporterPlace: trip.vehicle.depotId,
      note: issue.note ?? `${issue.qty} ${issue.type} at loading`,
      hasPhoto: false,
    },
    timeline: [
      { at: issue.createdAt, label: 'Shortfall reported', state: 'issue' },
      ...(issue.acknowledgedAt
        ? [{ at: issue.acknowledgedAt, label: 'Acknowledged', state: 'done' as const }]
        : []),
      { at: planned.start, label: 'Planned departure', state: done ? 'upcoming' : 'now' },
    ],
    departure: done
      ? { label: 'Load can continue', detail: 'The loader may mark the load ready.' }
      : { label: 'Held at the dock', detail: 'The load cannot be marked ready yet.' },
    ruleVerdict: 'A loading shortfall holds the load until a dispatcher acknowledges it.',
    options: done
      ? []
      : [
          {
            id: ACKNOWLEDGE,
            title: 'Acknowledge and send short',
            detail: 'The loader continues with what is on the dock.',
            recommended: true,
            facts: [
              { tone: 'ok', text: 'The trip keeps its departure time' },
              { tone: 'warn', text: `The store receives ${issue.qty} fewer units` },
            ],
            effects: [],
            reasons: ['It is the action the server supports for a loading shortfall.'],
          },
        ],
    waiting: snapshot.trips.flatMap((other) =>
      other.exceptions
        .filter((item) => item.acknowledgedAt === null && item.id !== id)
        .map((item) => ({
          id: item.id,
          title: issueTitle(other, item),
          detail: item.note ?? orderName(item.orderId),
        })),
    ),
    recovery:
      done && issue.acknowledgedAt
        ? {
            optionId: ACKNOWLEDGE,
            by: issue.acknowledgedBy ? 'Dispatcher' : session.name,
            at: issue.acknowledgedAt,
            versionFrom: version,
            versionTo: version,
            summary: 'Shortfall acknowledged. The plan is unchanged.',
            notice: {
              title: 'The loader can continue',
              body: 'The load can now be marked ready and leave with what is on the dock.',
            },
            acknowledgements: [],
            changes: [],
            audit: [
              { title: 'Shortfall reported', at: issue.createdAt, actor: 'Loader' },
              { title: 'Shortfall acknowledged', at: issue.acknowledgedAt, actor: 'Dispatcher' },
            ],
          }
        : null,
  };
}

async function acknowledge(id: string) {
  await http(`/loading/issues/${id}/ack`, loadingIssueSchema, { method: 'POST' }).finally(
    forgetPlans,
  );
  return exception(id);
}

const dateOf = (query: URLSearchParams) => query.get('date') ?? session.date;

export const dashboardSources: Source[] = [
  ['GET', '/dashboard/run', ({ query }) => run(dateOf(query))],
  ['GET', '/dashboard/command-center', ({ query }) => commandCenter(dateOf(query))],
  ['GET', '/dashboard/operations', ({ query }) => operations(dateOf(query))],
  ['GET', '/dashboard/live', ({ query }) => live(dateOf(query))],
  ['GET', '/loading/issues/:id', ({ params }) => exception(params.id ?? '')],
  ['POST', '/loading/issues/:id/ack', ({ params }) => acknowledge(params.id ?? '')],
  ['POST', '/loading/issues/:id/recovery', ({ params }) => acknowledge(params.id ?? '')],
  [
    'DELETE',
    '/loading/issues/:id/recovery',
    async () => {
      throw new HttpError(409, 'NOT_AVAILABLE', 'An acknowledgement cannot be undone.');
    },
  ],
];
