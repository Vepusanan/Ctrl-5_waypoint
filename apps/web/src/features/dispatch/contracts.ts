/**
 * Dispatcher page contracts taken from the Figma frames (section A).
 * Each schema is what one page needs from one request. Fields the API does not return yet are
 * listed as backend gaps in docs/IMPLEMENTATION.md §7. Reuse `@waypoint/shared` schemas wherever
 * an existing endpoint already covers the frame.
 */
import {
  brandSchema,
  deferralTypeSchema,
  isoDateSchema,
  reasonCodeSchema,
  runIntakeSchema,
  temperatureRequirementSchema,
  timestampSchema,
  timeWindowSchema,
  tripNoSchema,
  uuidSchema,
  vehicleIdSchema,
  vehicleTemperatureSchema,
  vehicleTypeSchema,
  versionSchema,
} from '@waypoint/shared';
import { z } from 'zod';

const count = z.int().nonnegative();
/** 0–100, and above 100 when over capacity. */
const percent = z.number().nonnegative();

/** `GET /dashboard/run?date=` — top-bar run context, publish window and sidebar counts. */
export const dispatchRunSchema = z.object({
  serviceDate: isoDateSchema,
  now: timestampSchema,
  depots: z.array(z.string().min(1)).min(1),
  planning: z.object({ opensAt: timestampSchema, publishBy: timestampSchema }),
  /** Order intake for this run: open until the cutoff, with the submitted orders still to join. */
  intake: runIntakeSchema,
  /** The run's plan is published: its version is the live plan, not a draft. */
  published: z.boolean(),
  counts: z.object({
    queue: count,
    hardViolations: count,
    deferrals: count,
    liveExceptions: count,
  }),
  unreadNotifications: count,
});
export type DispatchRun = z.infer<typeof dispatchRunSchema>;

const commandActionKindSchema = z.enum([
  'hard_violation',
  'repeat_deferral',
  'reefer_mismatch',
  'held_after_cutoff',
  'outlets_unconfirmed',
  'loading_shortfall',
  'failed_delivery',
  'late_delivery',
  'receipt_discrepancy',
  'sync_conflict',
  'vehicle_unavailable',
  'stale_driver',
  'tight_window',
]);
export type CommandActionKind = z.infer<typeof commandActionKindSchema>;

const orderBreakdownSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  bars: z.array(z.object({ name: z.string().min(1), orders: count })),
});

const riskSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  percent,
  /** Reference mark on the bar, for example a quota threshold. */
  markerPercent: percent.optional(),
});

/** `GET /dashboard/command-center?date=` — D01, planning view. */
export const commandCenterSchema = z.object({
  date: isoDateSchema,
  orders: z.object({
    total: count,
    /** Change against the previous run, in percent. */
    deltaPercent: z.number().nullable(),
    breakdowns: z.array(orderBreakdownSchema).min(1),
    insight: z.string().min(1).nullable(),
  }),
  unallocated: count,
  held: z.object({ count, delta: z.int().nullable() }),
  hardViolations: count,
  risks: z.object({
    /** Constraints the planner counts as close to their limit. */
    nearLimit: count,
    items: z.array(riskSchema),
    insight: z.string().min(1).nullable(),
  }),
  quality: z.object({
    score: z.int().min(0).max(100),
    delta: z.int().nullable(),
    onTimePercent: percent,
    fillPercent: percent,
    fairness: z.string().min(1),
  }),
  reefer: z.object({ percent, note: z.string().min(1).nullable() }),
  actions: z.array(
    z.object({
      id: z.string().min(1),
      kind: commandActionKindSchema,
      title: z.string().min(1),
      detail: z.string().min(1),
    }),
  ),
});
export type CommandCenter = z.infer<typeof commandCenterSchema>;

// D01 · Command center, operations view (prototype frame 2128:17913)

/** `GET /dashboard/operations?date=` — the delivery day so far, from recorded events. */
export const operationsSchema = z.object({
  date: isoDateSchema,
  stops: z.object({
    delivered: count,
    total: count,
    /** Change against the same weekday last week, in percent. */
    deltaPercent: z.number().nullable(),
    byHour: z.array(z.object({ hour: z.string().min(1), delivered: count })),
    insight: z.string().min(1).nullable(),
  }),
  loadingExceptions: z.object({ count, open: count }),
  driversOffline: count,
  deferred: z.object({ count, until: isoDateSchema.nullable() }),
  onTimePercent: percent,
  today: z.array(
    z.object({
      id: z.string().min(1),
      kind: z.enum(['plan', 'sync', 'shortage', 'queue']),
      title: z.string().min(1),
      detail: z.string().min(1),
      /** Finished or settled. Rows that still need attention are false. */
      done: z.boolean(),
    }),
  ),
});

// D02 · Planning queue (2038:1782) and D02a · Saved views (2106:10491)

const queueTagSchema = z.enum([
  'tight_window',
  'van_only',
  'repeat_deferral',
  'mall_window',
  'high_value',
  'fragile',
]);
export type QueueTag = z.infer<typeof queueTagSchema>;

const queueStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unallocated') }),
  z.object({ kind: z.literal('allocated'), vehicleId: vehicleIdSchema, tripNo: tripNoSchema }),
  /** Arrived after cutoff or deferred: waits for the run on `until`. */
  z.object({ kind: z.literal('held'), until: isoDateSchema }),
]);

const queueOrderSchema = z.object({
  id: uuidSchema,
  /** Display number, for example ORD-260926-0587. */
  reference: z.string().min(1),
  outlet: z.object({
    code: z.string().min(1),
    name: z.string().min(1),
    depot: z.string().min(1),
  }),
  brand: brandSchema,
  temp: temperatureRequirementSchema,
  weightKg: z.number().positive(),
  window: timeWindowSchema,
  tags: z.array(queueTagSchema),
  /** Last four runs, oldest first. True means the order was deferred in that run. */
  history: z.array(z.boolean()),
  state: queueStateSchema,
});
export type QueueOrder = z.infer<typeof queueOrderSchema>;

/** `GET /planning/runs/:date/queue` — D02. Counts on the page are derived from `items`. */
export const planningQueueSchema = z.object({
  date: isoDateSchema,
  cutoffAt: timestampSchema,
  /** Change in confirmed orders against the previous run, in percent. */
  deltaPercent: z.number().nullable(),
  items: z.array(queueOrderSchema),
  total: count,
});

const queueFiltersSchema = z.object({
  temp: temperatureRequirementSchema.optional(),
  state: z.enum(['unallocated', 'allocated', 'held']).optional(),
  tag: queueTagSchema.optional(),
  brand: brandSchema.optional(),
  depot: z.string().min(1).optional(),
});
export type QueueFilters = z.infer<typeof queueFiltersSchema>;

export const savedViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  audience: z.enum(['private', 'team']),
  /** Pinned views show as chips on the queue toolbar. */
  pinned: z.boolean(),
  filters: queueFiltersSchema,
});
export type SavedView = z.infer<typeof savedViewSchema>;

/** `GET /planning/views` — saved queue views, in the user's order. */
export const savedViewListSchema = z.object({ items: z.array(savedViewSchema), total: count });

// D03 · Allocation + advisor (2039:1225)

const boardTripSchema = z.object({
  tripNo: tripNoSchema,
  stops: z.array(z.object({ orderId: uuidSchema, name: z.string().min(1) })),
  /** Share of the binding capacity (weight or volume) in use. */
  loadPercent: percent,
});

const boardVehicleSchema = z.object({
  id: vehicleIdSchema,
  /** Display class, for example "Reefer van". */
  kind: z.string().min(1),
  driver: z.string().min(1).nullable(),
  depot: z.string().min(1),
  temp: vehicleTemperatureSchema,
  type: vehicleTypeSchema,
  trips: z.array(boardTripSchema),
});
export type BoardVehicle = z.infer<typeof boardVehicleSchema>;

/** `GET /planning/runs/:date/board` — the draft plan as lanes, plus what is left to place. */
export const allocationBoardSchema = z.object({
  date: isoDateSchema,
  planVersion: versionSchema,
  quality: z.object({ score: z.int().min(0).max(100), delta: z.int().nullable() }),
  orders: count,
  allocated: count,
  violations: count,
  risks: count,
  /** No vehicle has more than two trips. */
  tripLimitOk: z.boolean(),
  deferred: count,
  unallocated: z.array(queueOrderSchema),
  vehicles: z.array(boardVehicleSchema),
});

const candidateSchema = z.object({
  vehicleId: vehicleIdSchema,
  tripNo: tripNoSchema,
  /** Fit score, 0–100. Candidates arrive best first. */
  score: z.int().min(0).max(100),
  /** One line for the "Other feasible" list. */
  summary: z.string().min(1),
  factors: z.array(z.object({ ok: z.boolean(), text: z.string().min(1) })),
  /** Position the order would take in the trip. */
  seq: z.int().positive(),
  loadPercentAfter: percent,
});
export type Candidate = z.infer<typeof candidateSchema>;

/**
 * `GET /planning/runs/:date/advice?orderId=` — feasible candidates only, ranked; vehicles that
 * break a hard rule are listed apart with the rule that blocks them (SYSTEM_DESIGN §7.2, §7.5).
 */
export const adviceSchema = z.object({
  orderId: uuidSchema,
  candidates: z.array(candidateSchema),
  blocked: z.array(
    z.object({ vehicleId: vehicleIdSchema, rule: reasonCodeSchema, reason: z.string().min(1) }),
  ),
});

// D03a · Automatic allocation result (2106:11837)

/** `GET /planning/runs/:date/auto-run` — the last automatic run, or 404 when there is none. */
export const autoRunSchema = z.object({
  planVersion: versionSchema,
  finishedAt: timestampSchema,
  durationSeconds: z.number().nonnegative(),
  orders: count,
  placed: count,
  /** Why the remaining orders were left for a person, by blocking rule. */
  leftover: z.array(z.object({ rule: reasonCodeSchema, count })),
  quality: z.object({ score: z.int().min(0).max(100), note: z.string().min(1) }),
  changes: z.array(
    z.object({ id: z.string().min(1), title: z.string().min(1), detail: z.string().min(1) }),
  ),
});

// D04 · Fleet & trips (2040:1599)

const capacityRowSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  percent,
  /** Value after a pending change, drawn as a marker. */
  markerPercent: percent.optional(),
});

const inspectorTripSchema = z.object({
  tripNo: tripNoSchema,
  /** Where the trip is once the plan is published. Absent on a draft. */
  status: z.string().min(1).optional(),
  loadKg: z.number().nonnegative(),
  loadM3: z.number().nonnegative(),
  stops: z.array(
    z.object({
      orderId: uuidSchema,
      name: z.string().min(1),
      weightKg: z.number().nonnegative(),
      volumeM3: z.number().nonnegative(),
      plannedArrival: timestampSchema,
      /** Predicted unloading time, in minutes. */
      serviceMinutes: z.number().nonnegative(),
      /** Predicted chance of arriving late; null when not worth flagging. */
      lateRiskPercent: percent.nullable(),
    }),
  ),
  insight: z.string().min(1).nullable(),
  capacity: z.array(capacityRowSchema),
  capacityNote: z.string().min(1).nullable(),
  /** A ranked, already-validated move that clears this trip's violation. */
  fix: z
    .object({
      title: z.string().min(1),
      orderId: uuidSchema,
      target: z.object({ vehicleId: vehicleIdSchema, tripNo: tripNoSchema }),
      effects: z.array(z.object({ label: z.string().min(1), percent })),
      note: z.string().min(1),
      reasons: z.array(z.string().min(1)),
    })
    .nullable(),
});

/** `GET /planning/runs/:date/vehicles/:vehicleId` — one vehicle, its trips and whether they fit. */
export const vehicleInspectorSchema = z.object({
  vehicle: z.object({
    id: vehicleIdSchema,
    kind: z.string().min(1),
    depot: z.string().min(1),
    weightCapKg: z.number().positive(),
    volumeCapM3: z.number().positive(),
    kmPerL: z.number().positive(),
  }),
  fuel: z.object({ percent, afterPercent: percent, note: z.string().min(1) }),
  trips: z.array(inspectorTripSchema),
  /** The run is published, so changes go through a replan (SRS §24). */
  published: z.boolean().optional(),
  /** The vehicle is marked unavailable on this date. */
  unavailable: z.boolean().optional(),
});

/** `GET /planning/runs/:date/vehicles` — the picker on Fleet & trips. */
export const fleetListSchema = z.object({
  items: z.array(
    z.object({
      id: vehicleIdSchema,
      kind: z.string().min(1),
      depot: z.string().min(1),
      /** A trip on this vehicle breaks a hard rule. */
      violation: z.boolean(),
    }),
  ),
  total: count,
});

// D05 · Validation (2040:2166)

/** Rule families shown on the "By rule" chart. */
const ruleGroupSchema = z.enum([
  'capacity',
  'refrigeration',
  'access',
  'window',
  'time',
  'fuel',
  'grouping',
]);
export type RuleGroup = z.infer<typeof ruleGroupSchema>;

const hardViolationSchema = z.object({
  id: z.string().min(1),
  vehicleId: vehicleIdSchema,
  tripNo: tripNoSchema,
  rule: reasonCodeSchema,
  group: ruleGroupSchema,
  /** Short measured fact, for example "Weight 103%". */
  summary: z.string().min(1),
  detail: z.string().min(1),
  /** Orders that have to move to clear the violation. */
  orderIds: z.array(uuidSchema),
});
export type HardViolation = z.infer<typeof hardViolationSchema>;

const planRiskSchema = z.object({
  id: z.string().min(1),
  group: ruleGroupSchema,
  title: z.string().min(1),
  detail: z.string().min(1),
  /** Measured share of a limit, when the risk is a capacity. */
  percent: percent.nullable(),
  /** Predicted, never a fact. */
  lateRiskPercent: percent.nullable(),
  vehicleId: vehicleIdSchema.nullable(),
});

/**
 * `GET /planning/runs/:date/validation` — the last check of the draft plan.
 * `POST` to the same path re-runs the checks and returns the new report.
 * Violations block publishing; risks only inform (SYSTEM_DESIGN §7.2).
 */
export const validationSchema = z.object({
  planVersion: versionSchema,
  checkedAt: timestampSchema,
  orders: count,
  passing: count,
  violations: z.array(hardViolationSchema),
  risks: z.array(planRiskSchema),
  insight: z.string().min(1).nullable(),
});

// D06 · Deferral decision center (2102:6825) and D06a · Confirm deferrals (2040:3005)

const deferralCandidateSchema = z.object({
  orderId: uuidSchema,
  reference: z.string().min(1),
  outlet: z.object({ code: z.string().min(1), name: z.string().min(1) }),
  temp: temperatureRequirementSchema,
  weightKg: z.number().positive(),
  /** Why the order is hard to serve. `blocking` is a hard rule; `pressure` only makes it costly. */
  reasons: z.array(
    z.object({
      severity: z.enum(['blocking', 'pressure', 'neutral']),
      rule: reasonCodeSchema.nullable(),
      label: z.string().min(1),
    }),
  ),
  /** The same facts as sentences, for the decision panel. `ok` facts favour deferring. */
  facts: z.array(z.object({ ok: z.boolean(), text: z.string().min(1) })),
  /** Last four runs, oldest first. True means deferred in that run. */
  history: z.array(z.boolean()),
  daysSinceServed: z.int().nonnegative(),
  lastServed: isoDateSchema,
  /** 1 = defer first. */
  rank: z.int().positive(),
  /** Priority to be served, 0–100. */
  priorityPercent: percent,
  advice: z.enum(['defer', 'serve']),
  /** Deferred in the previous run as well, so a further deferral needs its own justification. */
  repeat: z.boolean(),
  suggestedReason: reasonCodeSchema,
  suggestedType: deferralTypeSchema,
  /** The notice the store will read, written from the reason (SYSTEM_DESIGN §7.5). */
  notice: z.string().min(1),
});
export type DeferralCandidate = z.infer<typeof deferralCandidateSchema>;

/** `GET /planning/runs/:date/deferral-candidates?policy=` — who waits when capacity runs out. */
export const deferralBoardSchema = z.object({
  planVersion: versionSchema,
  /** The run the deferred orders move to. */
  nextRun: isoDateSchema,
  shortage: z
    .object({
      label: z.string().min(1),
      count,
      detail: z.string().min(1),
      neededPercent: percent,
      capacityPercent: percent,
      capacityLabel: z.string().min(1),
    })
    .nullable(),
  unallocated: count,
  policy: z.object({
    id: z.string().min(1),
    weights: z.array(z.object({ label: z.string().min(1), percent })),
  }),
  policies: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })),
  candidates: z.array(deferralCandidateSchema),
});

// D07 · What-if simulator (2040:3236)

const scenarioMetricSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  value: z.number().nonnegative(),
  unit: z.enum(['', '%']),
});
export type ScenarioMetric = z.infer<typeof scenarioMetricSchema>;

const leverSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['hire_vehicle', 'second_trip', 'remove_vehicle', 'shift_cutoff', 'demand']),
  title: z.string().min(1),
  detail: z.string().min(1),
});
export type Lever = z.infer<typeof leverSchema>;

/** `GET /planning/runs/:date/scenario` — the levers on offer and the live plan's scorecard. */
export const scenarioSetupSchema = z.object({
  planVersion: versionSchema,
  levers: z.array(leverSchema),
  baseline: z.array(scenarioMetricSchema),
});

/**
 * `POST /planning/runs/:date/simulate` with `{ levers }` — the same engine on a copy of the plan
 * (SYSTEM_DESIGN §7.6). It never writes. `POST …/simulate/apply` copies the levers into the draft.
 */
export const scenarioResultSchema = z.object({
  scenario: z.array(scenarioMetricSchema),
  extraCost: z.object({
    amount: z.number(),
    currency: z.string().min(1),
    deltaPercent: z.number(),
  }),
  insight: z.string().min(1).nullable(),
});

export const scenarioAppliedSchema = z.object({ planVersion: versionSchema });

// D08 · Review & publish (2040:3555) and D08a · Plan published (2040:3969)

const progressSchema = z.object({ done: count, total: count, note: z.string().min(1) });

const publishedSchema = z.object({
  at: timestampSchema,
  by: z.string().min(1),
  trips: count,
  drivers: progressSchema.extend({
    /** Acknowledgements in the last few minutes, for the "+12 in 5 min" badge. */
    recent: z.object({ count, minutes: z.int().positive() }).nullable(),
  }),
  loaders: progressSchema,
  stores: progressSchema,
  /** Milestones of the run, in order. */
  timeline: z.array(
    z.object({
      key: z.enum(['loading', 'departures', 'first_stops', 'last_stop']),
      at: timestampSchema,
      label: z.string().min(1),
    }),
  ),
  timelineNote: z.string().min(1).nullable(),
  versions: z.array(
    z.object({
      version: versionSchema,
      at: timestampSchema,
      summary: z.string().min(1),
      live: z.boolean(),
    }),
  ),
});

/** `GET /planning/runs/:date/review` — the last screen before publishing, and the tracker after. */
export const planReviewSchema = z.object({
  planVersion: versionSchema,
  orders: count,
  trips: count,
  deferred: count,
  quality: z.object({
    score: z.int().min(0).max(100),
    delta: z.int().nullable(),
    previousVersion: versionSchema.nullable(),
    factors: z.array(z.object({ key: z.string().min(1), label: z.string().min(1), percent })),
    note: z.string().min(1).nullable(),
  }),
  /** `fail` blocks publishing. `warn` is acknowledged and never blocks. */
  checks: z.array(
    z.object({
      key: z.string().min(1),
      state: z.enum(['pass', 'warn', 'fail']),
      title: z.string().min(1),
      detail: z.string().min(1),
    }),
  ),
  /** One entry per trip. True means the model predicts a late-arrival risk. */
  lateRisk: z.object({ trips: z.array(z.boolean()), model: z.string().min(1) }),
  notify: z.array(
    z.object({
      key: z.enum(['loaders', 'drivers', 'stores', 'deferrals']),
      label: z.string().min(1),
      count,
    }),
  ),
  windowNote: z.string().min(1),
  /** Null until the plan is published. */
  published: publishedSchema.nullable(),
});

// D09 · Live operations (2041:2931)

const spanSchema = z.object({ start: timestampSchema, end: timestampSchema });

const liveLaneSchema = z.object({
  tripId: z.string().min(1),
  vehicleId: vehicleIdSchema,
  tripNo: tripNoSchema,
  depot: z.string().min(1),
  status: z.enum([
    'allocated',
    'not_started',
    'loading',
    'loading_exception',
    'ready',
    'departed',
    'completed',
  ]),
  planned: spanSchema,
  /** From the first to the last recorded event. Nothing is drawn between events. */
  recorded: spanSchema.nullable(),
  /** Model estimate for the rest of the trip. Never drawn as progress. */
  predicted: spanSchema.nullable(),
  lateRisk: z.boolean(),
  /** An open loading exception on this trip. */
  exceptionId: z.string().min(1).nullable(),
  /** Set when no event has arrived for 30 minutes (SYSTEM_DESIGN §8.5). */
  staleSince: timestampSchema.nullable(),
  /** What the trip is doing, in a few words, for example "4 of 6 stops · on time". */
  summary: z.string().min(1).nullable(),
});
export type LiveLane = z.infer<typeof liveLaneSchema>;

/** `GET /dashboard/live?date=` — built from recorded events only: loading, departure, arrival, POD. */
export const liveBoardSchema = z.object({
  now: timestampSchema,
  axis: spanSchema,
  trips: count,
  departed: count,
  loading: count,
  loadingExceptions: count,
  lateRisk: count,
  stops: z.object({
    delivered: count,
    total: count,
    /** Against the plan for this time of day, in percent. */
    deltaPercent: z.number().nullable(),
    note: z.string().min(1).nullable(),
  }),
  lanes: z.array(liveLaneSchema),
  /** The one exception that needs the dispatcher first. */
  alert: z
    .object({
      exceptionId: z.string().min(1),
      blocking: z.boolean(),
      title: z.string().min(1),
      facts: z.array(z.string().min(1)),
      note: z.string().min(1),
    })
    .nullable(),
  anomaly: z
    .object({
      where: z.string().min(1),
      title: z.string().min(1),
      /** History bars, oldest first; the last bar is the current value. */
      bars: z.array(z.object({ label: z.string().min(1), value: z.number().nonnegative() })),
      evidence: z.string().min(1),
    })
    .nullable(),
});

// D09a · Shortfall + recovery (2042:3151), D09b · Recovery applied (2042:3683),
// D09c · Minor exception · acknowledge (2106:12161)

const factSchema = z.object({
  tone: z.enum(['ok', 'warn', 'bad', 'predict']),
  text: z.string().min(1),
});

const recoveryOptionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  detail: z.string().min(1).nullable(),
  recommended: z.boolean(),
  facts: z.array(factSchema),
  /** Capacity the option consumes on another vehicle, shown before it is applied. */
  effects: z.array(capacityRowSchema),
  reasons: z.array(z.string().min(1)),
});

const recoverySchema = z.object({
  optionId: z.string().min(1),
  by: z.string().min(1),
  at: timestampSchema,
  versionFrom: z.string().min(1),
  versionTo: z.string().min(1),
  summary: z.string().min(1),
  notice: z.object({ title: z.string().min(1), body: z.string().min(1) }),
  acknowledgements: z.array(
    z.object({
      name: z.string().min(1),
      role: z.string().min(1),
      channel: z.enum(['phone', 'tablet', 'store']),
      /** Null while the person has not opened the change. */
      at: timestampSchema.nullable(),
    }),
  ),
  changes: z.array(
    z.object({
      vehicleId: vehicleIdSchema,
      tripNo: tripNoSchema,
      stops: z.array(
        z.object({ label: z.string().min(1), change: z.enum(['none', 'removed', 'added']) }),
      ),
    }),
  ),
  audit: z.array(
    z.object({ title: z.string().min(1), at: timestampSchema, actor: z.string().min(1) }),
  ),
});

/**
 * `GET /loading/issues/:id` — one loading exception with its evidence and feasible ways out.
 * Only chilled or high-value lines block Ready; everything else warns and needs an acknowledgement.
 */
export const loadingExceptionSchema = z.object({
  id: z.string().min(1),
  vehicleId: vehicleIdSchema,
  tripNo: tripNoSchema,
  blocking: z.boolean(),
  status: z.enum(['open', 'recovered', 'acknowledged']),
  reportedAt: timestampSchema,
  place: z.string().min(1),
  plannedDeparture: timestampSchema,
  dock: z.object({ name: z.string().min(1), phone: z.string().min(1).nullable() }),
  evidence: z.object({
    item: z.string().min(1),
    destination: z.string().min(1),
    /** Negative for a shortfall. */
    quantity: z.int(),
    unit: z.string().min(1),
    temp: temperatureRequirementSchema,
    reporter: z.string().min(1),
    reporterPlace: z.string().min(1),
    note: z.string().min(1),
    hasPhoto: z.boolean(),
  }),
  timeline: z.array(
    z.object({
      at: timestampSchema,
      label: z.string().min(1),
      state: z.enum(['done', 'issue', 'now', 'upcoming']),
    }),
  ),
  departure: z.object({ label: z.string().min(1), detail: z.string().min(1) }),
  /** Why this case does or does not block departure, in one line. */
  ruleVerdict: z.string().min(1),
  options: z.array(recoveryOptionSchema),
  /** Other open exceptions that do not block departure. */
  waiting: z.array(
    z.object({ id: z.string().min(1), title: z.string().min(1), detail: z.string().min(1) }),
  ),
  recovery: recoverySchema.nullable(),
});
export type LoadingException = z.infer<typeof loadingExceptionSchema>;

// D10 · Analytics & forecast (2043:3551)

/** `GET /analytics/forecast?date=&class=&depot=` — trips needed per week against what the fleet can run. */
export const forecastSchema = z.object({
  vehicleClass: z.enum(['reefer', 'dry']),
  /** The weekday the series is for, for example "Saturday". */
  weekday: z.string().min(1),
  depots: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })),
  /** Trips the fleet can run in one day. */
  capacity: z.number().nonnegative(),
  weeks: z.array(
    z.object({
      week: z.string().min(1),
      trips: z.number().nonnegative(),
      /** False for observed weeks. Predicted values are shown with "~" and never as fact. */
      predicted: z.boolean(),
    }),
  ),
  /** Calendar context for the weeks it explains. */
  events: z.array(
    z.object({
      week: z.string().min(1),
      label: z.string().min(1),
      kind: z.enum(['payday', 'calendar']),
    }),
  ),
  insight: z.string().min(1).nullable(),
  gap: z
    .object({ week: z.string().min(1), trips: z.number().positive(), detail: z.string().min(1) })
    .nullable(),
  balance: z.object({
    week: z.string().min(1),
    rows: z.array(
      z.object({
        key: z.string().min(1),
        label: z.string().min(1),
        value: z.number().nonnegative(),
        predicted: z.boolean(),
      }),
    ),
  }),
  actions: z.array(
    z.object({ id: z.string().min(1), title: z.string().min(1), detail: z.string().min(1) }),
  ),
  anomaly: z
    .object({
      week: z.string().min(1),
      title: z.string().min(1),
      /** Actual demand as a percentage of forecast, per week. */
      bars: z.array(z.object({ week: z.string().min(1), percent })),
      evidence: z.string().min(1),
    })
    .nullable(),
});

// D11 · Orders & audit (2043:4172)

/** `GET /orders?date=&q=&vehicle=` — the picker on Orders & audit. */
export const orderIndexSchema = z.object({
  items: z.array(
    z.object({
      id: uuidSchema,
      reference: z.string().min(1),
      outletName: z.string().min(1),
      outletCode: z.string().min(1),
    }),
  ),
  total: count,
});

const lifecycleStepSchema = z.enum([
  'submitted',
  'confirmed',
  'planned',
  'allocated',
  'loaded',
  'departed',
  'arrived',
  'delivered',
  'received',
  'completed',
]);
export type LifecycleStep = z.infer<typeof lifecycleStepSchema>;

const auditEventSchema = z.object({
  /** Row identity. A replayed event repeats `eventId`, so that cannot be the key. */
  id: z.string().min(1),
  at: timestampSchema,
  title: z.string().min(1),
  actor: z.string().min(1),
  actorRole: z.string().min(1),
  source: z.enum(['phone', 'tablet', 'web', 'offline', 'replay', 'auto']),
  /** Client event id. An offline replay with a known id is ignored, not applied twice. */
  eventId: z.string().min(1),
  result: z.enum(['synced', 'duplicate', 'conflict', 'pending']),
  syncedAt: timestampSchema.nullable(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

/** `GET /orders/:id/audit` — one order's full story: lifecycle, event log, POD and receipt. */
export const orderAuditSchema = z.object({
  id: uuidSchema,
  reference: z.string().min(1),
  outlet: z.object({ code: z.string().min(1), name: z.string().min(1) }),
  weightKg: z.number().positive(),
  temp: temperatureRequirementSchema,
  /** The step the order is on. Steps before it are done. */
  step: lifecycleStepSchema,
  deferred: z.boolean(),
  events: z.array(auditEventSchema),
  pod: z
    .object({
      recipient: z.string().min(1),
      photoUrl: z.string().min(1).nullable(),
      signatureUrl: z.string().min(1).nullable(),
      capturedAt: timestampSchema,
      capturedOffline: z.boolean(),
      syncedAt: timestampSchema.nullable(),
    })
    .nullable(),
  receipt: z
    .object({
      received: count,
      expected: count,
      unit: z.string().min(1),
      note: z.string().min(1).nullable(),
    })
    .nullable(),
});

// D13 · Outlets (2106:7017)

const outletAccessSchema = z.enum(['van_only', 'mall_window', 'tight_window', 'high_value']);
export type OutletAccess = z.infer<typeof outletAccessSchema>;

const outletRowSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  brand: brandSchema,
  depot: z.string().min(1),
  window: timeWindowSchema,
  /** The one access rule that matters most for planning, if the outlet has any. */
  access: outletAccessSchema.nullable(),
  /** Last eight arrivals, oldest first. True means the vehicle arrived inside the window. */
  arrivals: z.array(z.boolean()),
  /** Last four runs, oldest first. True means the outlet's order was deferred in that run. */
  deferrals: z.array(z.boolean()),
});
export type OutletRow = z.infer<typeof outletRowSchema>;

/**
 * `GET /outlets/directory?depot=&q=&brand=&access=&limit=` — the outlet list with its delivery
 * history. The existing `GET /outlets` returns reference data only, so this is a separate view.
 */
export const outletDirectorySchema = z.object({
  /** Every outlet the dispatcher can see, before any filter. */
  total: count,
  depots: z.array(z.string().min(1)),
  /** Outlets that match the filters. `items` holds the first `limit` of them. */
  matching: count,
  items: z.array(outletRowSchema),
});

const outletDeliverySchema = z.object({
  serviceDate: isoDateSchema,
  orderId: uuidSchema,
  state: z.enum(['unallocated', 'allocated', 'deferred', 'departed', 'arrived', 'received']),
  arrivedAt: timestampSchema.nullable(),
  vehicleId: vehicleIdSchema.nullable(),
  tripNo: tripNoSchema.nullable(),
  /** Short follow-up, for example "7 of 10 · top-up 09:50". */
  note: z.string().min(1).nullable(),
});
export type OutletDelivery = z.infer<typeof outletDeliverySchema>;

/** `GET /outlets/:code/profile?date=` — one outlet's profile, history and next delivery. */
export const outletProfileSchema = z.object({
  code: z.string().min(1),
  /** Full trading name, for example "Waypoint Fresh Gampola". */
  name: z.string().min(1),
  brand: brandSchema,
  depot: z.string().min(1),
  manager: z.string().min(1).nullable(),
  phone: z.string().min(1).nullable(),
  window: timeWindowSchema,
  onTime: z.object({ arrivals: count, of: count }),
  deferred: z.object({ count, runs: count }),
  avgUnloadMinutes: count.nullable(),
  notes: z.array(
    z.object({ kind: z.enum(['access', 'receiving', 'storage']), text: z.string().min(1) }),
  ),
  volume: z.object({
    /** Weekday of the run, so the chart compares like with like. */
    weekday: z.string().min(1),
    weeks: z.array(z.object({ week: z.string().min(1), kg: z.number().nonnegative() })),
    insight: z.string().min(1).nullable(),
  }),
  nextDelivery: outletDeliverySchema.nullable(),
});

// D12 · Vehicle unavailable · replan (2044:3828)

/**
 * `GET /planning/runs/:date/replans/:vehicleId` — where the orders of a lost vehicle can go.
 * The proposal is validated before it is offered. `POST .../replans/:vehicleId/publish` accepts
 * it and publishes the next plan version in one step, and returns this same shape.
 */
export const replanSchema = z.object({
  vehicleId: vehicleIdSchema,
  markedAt: timestampSchema,
  /** Why and when it was lost, for example "workshop" and "before loading". */
  reason: z.string().min(1),
  phase: z.string().min(1),
  /** The published version the vehicle was on, and the version this replan creates. */
  planVersion: versionSchema,
  nextVersion: versionSchema,
  orders: count,
  /** Every order has a valid new trip. When false the plan cannot be published from here. */
  feasible: z.boolean(),
  moves: z.array(
    z.object({
      vehicleId: vehicleIdSchema,
      tripNo: tripNoSchema,
      orders: count,
      /** The fullest capacity of that trip once the orders are on it. */
      loadPercent: percent,
    }),
  ),
  insight: z.string().min(1).nullable(),
  impact: z.object({ tripsRemoved: count, deferred: count, secondTrips: count }),
  checks: z.array(
    z.object({
      key: z.string().min(1),
      label: z.string().min(1),
      state: z.enum(['pass', 'warn', 'fail']),
    }),
  ),
  lateRisk: z.object({ before: count, after: count, note: z.string().min(1).nullable() }),
  /** Who must acknowledge the new version. `acknowledged` counts up after publishing. */
  acknowledge: z.array(
    z.object({
      key: z.enum(['loaders', 'drivers', 'stores']),
      label: z.string().min(1),
      count,
      acknowledged: count,
    }),
  ),
  published: z.object({ at: timestampSchema, by: z.string().min(1) }).nullable(),
});

// D04a · Trip record · view only (2106:11293)

const recordStopStateSchema = z.enum(['not-started', 'arrived', 'delivered', 'failed', 'conflict']);

/**
 * `GET /planning/runs/:date/vehicles/:vehicleId/trips/:tripNo/record` — what the loader and the
 * driver recorded for one trip. The dispatcher may read it but not change it (RBAC: View).
 */
export const tripRecordSchema = z.object({
  vehicleId: vehicleIdSchema,
  tripNo: tripNoSchema,
  loading: z.object({
    loader: z.string().min(1).nullable(),
    dock: z.string().min(1).nullable(),
    state: z.enum(['not-started', 'loading', 'loading-exception', 'ready', 'departed']),
    readyAt: timestampSchema.nullable(),
    stops: z.array(
      z.object({
        seq: z.int().positive(),
        outlet: z.object({ code: z.string().min(1), name: z.string().min(1) }),
        planned: count,
        loaded: count.nullable(),
        /** Short label for a loading exception on this stop, for example "3 short · v4.1". */
        exception: z.string().min(1).nullable(),
      }),
    ),
  }),
  owners: z.array(
    z.object({
      name: z.string().min(1),
      role: z.string().min(1),
      permission: z.string().min(1),
      /** Events this person recorded on the trip. Null for people who cannot record. */
      events: count.nullable(),
      /** The signed-in user. */
      you: z.boolean(),
    }),
  ),
  delivery: z.object({
    driver: z.string().min(1).nullable(),
    stops: z.array(
      z.object({
        seq: z.int().positive(),
        outletName: z.string().min(1),
        state: recordStopStateSchema,
        note: z.string().min(1),
        signature: z.boolean(),
        photo: z.boolean(),
      }),
    ),
    /** Recorded values, shown as locked fields with where each one came from. */
    fields: z.array(
      z.object({
        key: z.string().min(1),
        label: z.string().min(1),
        value: z.string().min(1),
        hint: z.string().min(1).nullable(),
      }),
    ),
  }),
});
export type RecordStopState = z.infer<typeof recordStopStateSchema>;

/** `POST .../record/corrections` — asks the record's owner to fix it. Written to the audit log. */
export const correctionRequestSchema = z.object({
  target: z.enum(['loading', 'delivery']),
  note: z.string().trim().min(1).max(500),
});
export const correctionResponseSchema = z.object({
  id: z.string().min(1),
  sentTo: z.string().min(1),
  at: timestampSchema,
});

// Store issues · the dispatcher reads and resolves what store managers report (SRS §28).

/** `GET /issues/board` — every store issue in the dispatcher's depot, newest first. */
export const issueBoardSchema = z.object({
  items: z.array(
    z.object({
      id: uuidSchema,
      orderId: uuidSchema,
      reference: z.string().min(1),
      outlet: z.object({ code: z.string().min(1), name: z.string().min(1) }),
      type: z.enum(['missing', 'damaged', 'incorrect']),
      note: z.string().min(1).nullable(),
      status: z.enum(['open', 'resolved']),
      reportedAt: timestampSchema,
      resolvedAt: timestampSchema.nullable(),
      resolution: z.string().min(1).nullable(),
      /** The delivery the issue is about, with what the driver captured there. */
      delivery: z
        .object({
          vehicleId: vehicleIdSchema,
          tripNo: tripNoSchema,
          recipient: z.string().min(1).nullable(),
          signatureUrl: z.string().min(1).nullable(),
          photoUrl: z.string().min(1).nullable(),
        })
        .nullable(),
    }),
  ),
  total: count,
});
export type StoreIssueRow = z.infer<typeof issueBoardSchema>['items'][number];
