import {
  auditTimelineSchema,
  replanProposalSchema,
  replanResponseSchema,
  tripListResponseSchema,
  vehicleListResponseSchema,
  vehicleUnavailableResponseSchema,
} from '@waypoint/shared';
import type { z } from 'zod';
import { HttpError, api as http } from '../../../../lib/api';
import type { replanSchema } from '../../contracts';
import { ruleLabels } from '../../rules';
import type { Source } from '../client';
import { nextRun, serverNow, session } from '../context';
import { forgetPlans } from './plan';

// Replanning a published run (SRS §24, §42). The server proposes a validated home for every
// order on a lost vehicle and applies the moves as the next plan version.

type Replan = z.infer<typeof replanSchema>;
type Proposal = z.infer<typeof replanProposalSchema>;

const proposalOf = (date: string, vehicleId: string) =>
  http(`/planning/runs/${date}/replans/${vehicleId}`, replanProposalSchema);

/** The published run's id and version, read from any of its trips. */
async function runOf(date: string): Promise<{ id: string; planVersion: number } | null> {
  const trips = await http(`/trips?date=${date}`, tripListResponseSchema);
  const run = trips.items.find((trip) => trip.run.status === 'published')?.run;
  return run ? { id: run.id, planVersion: run.planVersion } : null;
}

const noteFor = (vehicleId: string, reason: string | null) =>
  `${vehicleId} unavailable${reason ? ` · ${reason}` : ''}`;

function fromProposal(date: string, proposal: Proposal): Replan {
  const placed = proposal.orders.filter((order) => order.target !== null);
  const stranded = proposal.orders.length - placed.length;
  const groups = new Map<
    string,
    { vehicleId: string; tripNo: 1 | 2; orders: number; load: number }
  >();
  for (const order of placed) {
    if (order.target === null) continue;
    const name = `${order.target.vehicleId}#${order.target.tripNo}`;
    const group = groups.get(name) ?? {
      vehicleId: order.target.vehicleId,
      tripNo: order.target.tripNo,
      orders: 0,
      load: 0,
    };
    group.orders += 1;
    // Each placement reports the trip's load with it on board, so the highest is the final one.
    group.load = Math.max(group.load, order.target.loadPercent);
    groups.set(name, group);
  }
  const blockers = [
    ...new Set(proposal.orders.flatMap((order) => (order.target ? [] : (order.blockedBy ?? [])))),
  ];
  const phase = proposal.orders.some((order) => order.from.tripStatus === 'loading')
    ? 'during loading'
    : 'before departure';
  return {
    vehicleId: proposal.vehicleId,
    markedAt: proposal.markedAt ?? serverNow(),
    reason: proposal.reason ?? 'Marked unavailable',
    phase,
    planVersion: proposal.planVersion,
    nextVersion: proposal.planVersion + 1,
    orders: proposal.orders.length,
    // An order no vehicle can take is deferred with its reason, which is still a valid plan.
    feasible: proposal.orders.length > 0,
    moves: [...groups.values()].map((group) => ({
      vehicleId: group.vehicleId,
      tripNo: group.tripNo,
      orders: group.orders,
      loadPercent: group.load,
    })),
    insight:
      stranded > 0
        ? `${stranded} ${stranded === 1 ? 'order has' : 'orders have'} no vehicle that passes the hard rules (${blockers.map((rule) => ruleLabels[rule]).join(', ')}). ${stranded === 1 ? 'It moves' : 'They move'} to the run on ${nextRun(date)} with that reason.`
        : proposal.orders.length === 0
          ? 'No order is waiting on this vehicle.'
          : null,
    impact: {
      tripsRemoved: new Set(proposal.orders.map((order) => order.from.tripNo)).size,
      deferred: stranded,
      secondTrips: new Set(
        placed.flatMap((order) =>
          order.target?.newTrip && order.target.tripNo === 2 ? [order.target.vehicleId] : [],
        ),
      ).size,
    },
    checks: [
      { key: 'hard', label: 'Every move passes the hard rules', state: 'pass' },
      {
        key: 'deferred',
        label: stranded > 0 ? `${stranded} deferred with a reason` : 'No order is deferred',
        state: stranded > 0 ? 'warn' : 'pass',
      },
      {
        key: 'departed',
        label: 'Departed trips and recorded stops are not changed',
        state: 'pass',
      },
    ],
    lateRisk: { before: 0, after: 0, note: null },
    acknowledge: [
      { key: 'loaders', label: 'Loads to re-check', count: groups.size, acknowledged: 0 },
      {
        key: 'drivers',
        label: 'Drivers with a changed route',
        count: new Set([...groups.values()].map((group) => group.vehicleId)).size,
        acknowledged: 0,
      },
      { key: 'stores', label: 'Stores told', count: proposal.orders.length, acknowledged: 0 },
    ],
    published: null,
  };
}

/** After the replan is applied the proposal is empty, so the page reads what was published. */
async function applied(date: string, vehicleId: string, base: Replan): Promise<Replan> {
  const run = await runOf(date);
  if (run === null) return base;
  const timeline = await http(
    `/audit?entityType=planning_run&entityId=${run.id}`,
    auditTimelineSchema,
  ).catch(() => null);
  const row = timeline?.items
    .filter(
      (item) =>
        item.action === 'plan.replanned' &&
        typeof item.after?.note === 'string' &&
        item.after.note.startsWith(vehicleId),
    )
    .at(-1);
  if (!row) return base;
  const moves = Array.isArray(row.after?.moves) ? row.after.moves : [];
  const groups = new Map<string, number>();
  const sources = new Set<string>();
  let deferred = 0;
  for (const move of moves) {
    const { to, from } = move as { to?: unknown; from?: unknown };
    if (typeof from === 'string') sources.add(from);
    if (typeof to === 'string') groups.set(to, (groups.get(to) ?? 0) + 1);
    else deferred += 1;
  }
  // The trips as they are now give the load each one carries after the replan.
  const [trips, vehicles] = await Promise.all([
    http(`/trips?date=${date}`, tripListResponseSchema),
    http(`/vehicles?date=${date}`, vehicleListResponseSchema),
  ]);
  const loadOf = (vehicleId: string, tripNo: number) => {
    const trip = trips.items.find((item) => item.vehicleId === vehicleId && item.tripNo === tripNo);
    const vehicle = vehicles.items.find((item) => item.id === vehicleId);
    if (!trip || !vehicle) return 0;
    const kg = trip.stops.reduce((sum, stop) => sum + stop.order.weightKg, 0);
    const m3 = trip.stops.reduce((sum, stop) => sum + stop.order.volumeM3, 0);
    return Math.round(Math.max(kg / vehicle.weightCapKg, m3 / vehicle.volumeCapM3) * 100);
  };
  const version =
    typeof row.after?.planVersion === 'number' ? row.after.planVersion : run.planVersion;
  return {
    ...base,
    planVersion: version - 1,
    nextVersion: version,
    orders: moves.length,
    feasible: true,
    moves: [...groups].flatMap(([name, orders]) => {
      const [id = '', trip] = name.split('#');
      const tripNo = trip === '2' ? 2 : 1;
      return /^VEH\d{3}$/.test(id)
        ? [{ vehicleId: id, tripNo, orders, loadPercent: loadOf(id, tripNo) } as const]
        : [];
    }),
    insight: deferred > 0 ? `${deferred} deferred to the run on ${nextRun(date)}.` : null,
    impact: { ...base.impact, tripsRemoved: sources.size, deferred },
    published: { at: row.createdAt, by: session.name || 'Dispatcher' },
  };
}

async function read(date: string, vehicleId: string): Promise<Replan> {
  const proposal = await proposalOf(date, vehicleId);
  const base = fromProposal(date, proposal);
  return proposal.orders.length === 0 ? applied(date, vehicleId, base) : base;
}

async function publish(date: string, vehicleId: string): Promise<Replan> {
  const proposal = await proposalOf(date, vehicleId);
  if (proposal.orders.length === 0) {
    throw new HttpError(409, 'NOTHING_TO_REPLAN', 'No order is waiting on this vehicle.');
  }
  await http(`/planning/runs/${date}/replan`, replanResponseSchema, {
    method: 'POST',
    headers: { 'If-Match': String(proposal.planVersion) },
    body: JSON.stringify({
      note: noteFor(vehicleId, proposal.reason),
      moves: proposal.orders.map((order) =>
        order.target
          ? {
              orderId: order.orderId,
              target: { vehicleId: order.target.vehicleId, tripNo: order.target.tripNo },
            }
          : {
              orderId: order.orderId,
              target: null,
              reasonCode: order.blockedBy ?? 'VEHICLE_UNAVAILABLE',
            },
      ),
    }),
  }).finally(forgetPlans);
  return read(date, vehicleId);
}

/** One order moved or deferred on a published plan. The plan version comes from the run. */
async function change(date: string, body: unknown) {
  const run = await runOf(date);
  if (run === null) {
    throw new HttpError(409, 'NOT_PUBLISHED', 'This plan is not published yet. Change the draft.');
  }
  return http(`/planning/runs/${date}/replan`, replanResponseSchema, {
    method: 'POST',
    headers: { 'If-Match': String(run.planVersion) },
    body: JSON.stringify(body),
  }).finally(forgetPlans);
}

export const replanSources: readonly Source[] = [
  [
    'POST',
    '/vehicles/:id/unavailable',
    ({ params, body }) =>
      http(`/vehicles/${params.id}/unavailable`, vehicleUnavailableResponseSchema, {
        method: 'POST',
        body: JSON.stringify(body),
      }).finally(forgetPlans),
  ],
  [
    'GET',
    '/planning/runs/:date/replans/:vehicleId',
    ({ params }) => read(params.date ?? '', params.vehicleId ?? ''),
  ],
  [
    'POST',
    '/planning/runs/:date/replans/:vehicleId/publish',
    ({ params }) => publish(params.date ?? '', params.vehicleId ?? ''),
  ],
  ['POST', '/planning/runs/:date/replan', ({ params, body }) => change(params.date ?? '', body)],
];
