/** Dispatcher fixtures. Values are copied from Figma section A so pages can be compared 1:1. */
import type { z } from 'zod';
import type { CommandCenter, DispatchRun, operationsSchema } from '../../contracts';
import { analyticsRoutes } from './analytics';
import { auditRoutes } from './audit';
import { deferralRoutes } from './deferrals';
import { dispatcher } from './guard';
import { liveRoutes } from './live';
import { NEXT_RUN, state } from './orders';
import { outletRoutes } from './outlets';
import { planningRoutes } from './planning';
import { recordRoutes } from './record';
import { replanRoutes } from './replan';
import { createMockFetch, hasRoute, type MockRoute } from './router';
import { SERVICE_DATE, scenarioNow } from './session';
import { report } from './validation';

type Operations = z.infer<typeof operationsSchema>;

const run = (): DispatchRun => ({
  serviceDate: SERVICE_DATE,
  now: scenarioNow(),
  depots: ['Peliyagoda DC', 'Kandy hub'],
  planning: { opensAt: '2026-09-25T16:00:00+05:30', publishBy: '2026-09-25T18:00:00+05:30' },
  counts: {
    queue: state.orders.length,
    hardViolations: report().violations.length,
    deferrals: 11 + state.confirmedDeferrals,
    liveExceptions: 3,
  },
  unreadNotifications: 1,
});

// D01 operations view (prototype frame 2128:17913), with this run's names in place of the frame's.
const operations = (): Operations => ({
  date: SERVICE_DATE,
  stops: {
    delivered: 124,
    total: 127,
    deltaPercent: 2,
    byHour: [
      { hour: '06', delivered: 9 },
      { hour: '07', delivered: 21 },
      { hour: '08', delivered: 28 },
      { hour: '09', delivered: 24 },
      { hour: '10', delivered: 19 },
      { hour: '11', delivered: 14 },
      { hour: '12', delivered: 9 },
    ],
    insight: 'Deliveries peaked 08:00–09:00; the three open stops are on VEH019 (running late).',
  },
  loadingExceptions: { count: 1, open: 0 },
  driversOffline: 0,
  deferred: { count: 2 + state.confirmedDeferrals, until: NEXT_RUN },
  onTimePercent: 96,
  today: [
    {
      id: 'plan',
      kind: 'plan',
      title: `Plan v${state.planVersion} · 58 trips`,
      detail: '55 completed · 3 returning',
      done: true,
    },
    {
      id: 'VEH012',
      kind: 'sync',
      title: 'VEH012 synced 07:44',
      detail: '4 events · 1 duplicate ignored',
      done: true,
    },
    {
      id: 'WF-F071',
      kind: 'shortage',
      title: 'WF-F071 short by 3',
      detail: 'Store told · top-up on VEH007',
      done: false,
    },
    {
      id: 'queue',
      kind: 'queue',
      title: 'Mon 28 queue opens 16:00',
      detail: 'ORD-260926-0587 prioritised',
      done: false,
    },
  ],
});

// D01 · Command center (2037:496)
const commandCenter = (): CommandCenter => ({
  date: SERVICE_DATE,
  orders: {
    total: state.orders.length,
    deltaPercent: 9,
    breakdowns: [
      {
        key: 'cluster',
        label: 'By cluster',
        bars: [
          { name: 'Colombo N', orders: 24 },
          { name: 'Colombo S', orders: 21 },
          { name: 'Gampaha', orders: 19 },
          { name: 'Kandy', orders: 28 },
          { name: 'Gampola', orders: 14 },
          { name: 'Kurunegala', orders: 16 },
          { name: 'Negombo', orders: 12 },
          { name: 'Matale', orders: 12 },
        ],
      },
    ],
    insight: 'Kandy corridor carries the most orders tonight (28), mostly chilled.',
  },
  unallocated: state.orders.filter((order) => order.state.kind === 'unallocated').length,
  held: { count: state.orders.filter((order) => order.state.kind === 'held').length, delta: 2 },
  hardViolations: report().violations.length,
  risks: {
    nearLimit: 3,
    items: [
      { key: 'reefer', label: 'Reefer', percent: 94 },
      { key: 'weight-t2', label: 'Weight T2', percent: 103 },
      { key: 'fuel', label: 'Fuel', percent: 88, markerPercent: 80 },
      { key: 'van-slots', label: 'Van slots', percent: 72 },
    ],
    insight: 'One trip is over weight; reefer is the next bottleneck.',
  },
  quality: { score: 86, delta: 4, onTimePercent: 92, fillPercent: 81, fairness: 'A' },
  reefer: { percent: 94, note: '2 chilled orders fit only if VEH007 runs a second trip.' },
  actions: [
    {
      id: 'VEH014-2',
      kind: 'hard_violation',
      title: 'VEH014 trip 2 over weight',
      detail: '103% · blocks publish',
    },
    {
      id: 'WF-F023',
      kind: 'repeat_deferral',
      title: 'WF-F023 deferred twice',
      detail: 'Repeat deferral · needs reason',
    },
    {
      id: 'VEH052',
      kind: 'reefer_mismatch',
      title: 'VEH052 is not reefer',
      detail: '2 chilled orders on it',
    },
    {
      id: 'cutoff',
      kind: 'held_after_cutoff',
      title: '7 orders after cutoff',
      detail: 'Held for Mon 28 Sep',
    },
    {
      id: 'unconfirmed',
      kind: 'outlets_unconfirmed',
      title: '3 outlets not confirmed',
      detail: 'Reminder sent 15:30',
    },
  ],
});

// Saved queue views are stored on the server (`/planning/views`), so they have no fixture.

const dispatchRoutes: MockRoute[] = [
  ...planningRoutes,
  ...deferralRoutes,
  ...liveRoutes,
  ...analyticsRoutes,
  ...auditRoutes,
  ...outletRoutes,
  ...replanRoutes,
  ...recordRoutes,
  ['GET', '/dashboard/run', dispatcher(run)],
  ['GET', '/dashboard/command-center', dispatcher(commandCenter)],
  ['GET', '/dashboard/operations', dispatcher(operations)],
  [
    'GET',
    '/planning/runs/:date/queue',
    dispatcher(() => ({
      date: SERVICE_DATE,
      cutoffAt: '2026-09-25T16:00:00+05:30',
      deltaPercent: 9,
      items: state.orders,
      total: state.orders.length,
    })),
  ],
];

export const fixtureFetch = createMockFetch(dispatchRoutes);
export const hasFixture = (method: string, pathname: string) =>
  hasRoute(dispatchRoutes, method, pathname);
