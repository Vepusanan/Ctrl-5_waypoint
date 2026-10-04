import { z } from 'zod';
import { roleSchema, stopStatusSchema } from '../enums.ts';
import { isoDateSchema, timestampSchema, uuidSchema, vehicleIdSchema } from '../primitives.ts';
import { listResponseSchema } from './common.ts';

/** SYSTEM_DESIGN §11.2. REST polling interval when the event stream is down. */
export const DASHBOARD_POLL_INTERVAL_MS = 15_000;

/** SYSTEM_DESIGN §8.5. A departed trip with no newer activity is offline, not live progress. */
export const DRIVER_STALE_AFTER_MS = 30 * 60 * 1000;

export const dashboardDateQuerySchema = z.object({ date: isoDateSchema });
export type DashboardDateQuery = z.infer<typeof dashboardDateQuerySchema>;

// Status names match the state machines. A delivered stop is a completed stop.
export const dashboardOrderCountsSchema = z.object({
  confirmed: z.int().nonnegative(),
  allocated: z.int().nonnegative(),
  deferred: z.int().nonnegative(),
  loading: z.int().nonnegative(),
  dispatched: z.int().nonnegative(),
  delivered: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  receiptConfirmed: z.int().nonnegative(),
});
export type DashboardOrderCounts = z.infer<typeof dashboardOrderCountsSchema>;

export const dashboardLoadingCountsSchema = z.object({
  notStarted: z.int().nonnegative(),
  inProgress: z.int().nonnegative(),
  exception: z.int().nonnegative(),
  ready: z.int().nonnegative(),
  departed: z.int().nonnegative(),
});
export type DashboardLoadingCounts = z.infer<typeof dashboardLoadingCountsSchema>;

export const dashboardStopCountsSchema = z.object({
  pending: z.int().nonnegative(),
  arrived: z.int().nonnegative(),
  delivered: z.int().nonnegative(),
  failed: z.int().nonnegative(),
});
export type DashboardStopCounts = z.infer<typeof dashboardStopCountsSchema>;

const driverIdentity = {
  tripId: uuidSchema,
  vehicleId: vehicleIdSchema,
  driverId: uuidSchema.nullable(),
  driverName: z.string().min(1).nullable(),
  lastSeenAt: timestampSchema.nullable(),
  pendingSyncCount: z.int().nonnegative(),
};

// `live` is the only shape that carries stop progress. Offline and waiting omit it.
export const dashboardDriverSchema = z.discriminatedUnion('presence', [
  z.object({
    ...driverIdentity,
    presence: z.literal('live'),
    lastSeenAt: timestampSchema,
    lastStopStatus: stopStatusSchema,
  }),
  z.object({
    ...driverIdentity,
    presence: z.literal('offline'),
    label: z.string().min(1),
  }),
  z.object({
    ...driverIdentity,
    presence: z.literal('waiting'),
    label: z.string().min(1),
  }),
]);
export type DashboardDriver = z.infer<typeof dashboardDriverSchema>;

export const dashboardSummarySchema = z.object({
  date: isoDateSchema,
  orders: dashboardOrderCountsSchema,
  repeatDeferrals: z.int().nonnegative(),
  loading: dashboardLoadingCountsSchema,
  activeTrips: z.int().nonnegative(),
  stops: dashboardStopCountsSchema,
  pendingLoadingIssues: z.int().nonnegative(),
  pendingSyncConflicts: z.int().nonnegative(),
  fleet: z.object({
    available: z.int().nonnegative(),
    unavailable: z.int().nonnegative(),
  }),
  utilization: z.object({
    weight: z.number().nonnegative(),
    volume: z.number().nonnegative(),
    reefer: z.number().nonnegative(),
    van: z.number().nonnegative(),
  }),
  fuelUsedL: z.number().nonnegative(),
  tightWindowStops: z.int().nonnegative(),
  drivers: z.array(dashboardDriverSchema),
});
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;

export const dashboardExceptionSeveritySchema = z.enum(['high', 'medium', 'low']);
export type DashboardExceptionSeverity = z.infer<typeof dashboardExceptionSeveritySchema>;

export const dashboardExceptionTypeSchema = z.enum([
  'loading_shortfall',
  'failed_delivery',
  'receipt_discrepancy',
  'sync_conflict',
  'vehicle_unavailable',
  'repeat_deferral',
  'stale_driver',
  'tight_window',
]);
export type DashboardExceptionType = z.infer<typeof dashboardExceptionTypeSchema>;

export const dashboardExceptionEntityTypeSchema = z.enum([
  'order',
  'trip',
  'stop',
  'loading_issue',
  'issue',
  'sync_conflict',
  'vehicle',
  'deferral',
]);
export type DashboardExceptionEntityType = z.infer<typeof dashboardExceptionEntityTypeSchema>;

export const dashboardExceptionSchema = z.object({
  severity: dashboardExceptionSeveritySchema,
  type: dashboardExceptionTypeSchema,
  entityType: dashboardExceptionEntityTypeSchema,
  entityId: z.string().min(1),
  title: z.string().min(1),
  reason: z.string().min(1),
  occurredAt: timestampSchema,
  action: z.object({ href: z.string().min(1) }),
});
export type DashboardException = z.infer<typeof dashboardExceptionSchema>;

export const dashboardExceptionsSchema = z.object({
  date: isoDateSchema,
  items: z.array(dashboardExceptionSchema),
  total: z.int().nonnegative(),
});
export type DashboardExceptions = z.infer<typeof dashboardExceptionsSchema>;

// Every domain event the dispatcher stream forwards (SYSTEM_DESIGN §11.2). The client listens for
// each by name, so this list is the contract between the API emitter and the web client.
export const dashboardStreamEventTypeSchema = z.enum([
  'order.submitted',
  'order.confirmed',
  'order.cancelled',
  'order.changed',
  'order.deferred',
  'plan.published',
  'allocation.changed',
  'trip.changed',
  'trip.departed',
  'loading.started',
  'loading.verified',
  'loading.issue_recorded',
  'loading.issue_acknowledged',
  'loading.ready',
  'stop.arrived',
  'stop.delivered',
  'stop.failed',
  'stop.pod_recorded',
  'receipt.confirmed',
  'issue.reported',
  'issue.resolved',
  'sync.conflict',
]);
export type DashboardStreamEventType = z.infer<typeof dashboardStreamEventTypeSchema>;

export const dashboardStreamEntityTypeSchema = z.enum([
  'order',
  'planning_run',
  'trip',
  'loading_issue',
  'stop',
  'receipt',
  'issue',
  'sync_conflict',
]);
export type DashboardStreamEntityType = z.infer<typeof dashboardStreamEntityTypeSchema>;

// Lightweight invalidation hint. The client refetches; the payload is not a dashboard snapshot.
export const dashboardStreamMessageSchema = z.object({
  type: dashboardStreamEventTypeSchema,
  occurredAt: timestampSchema,
  entityType: dashboardStreamEntityTypeSchema,
  entityId: z.string().min(1),
});
export type DashboardStreamMessage = z.infer<typeof dashboardStreamMessageSchema>;

export const dashboardStreamReadySchema = z.object({
  type: z.literal('ready'),
  pollIntervalMs: z.literal(DASHBOARD_POLL_INTERVAL_MS),
});
export type DashboardStreamReady = z.infer<typeof dashboardStreamReadySchema>;

export const auditTimelineQuerySchema = z.object({
  entityType: z.string().trim().min(1),
  entityId: z.string().trim().min(1),
});
export type AuditTimelineQuery = z.infer<typeof auditTimelineQuerySchema>;

export const auditTimelineItemSchema = z.object({
  id: uuidSchema,
  actorId: uuidSchema,
  role: roleSchema,
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  createdAt: timestampSchema,
});
export type AuditTimelineItem = z.infer<typeof auditTimelineItemSchema>;

export const auditTimelineSchema = listResponseSchema(auditTimelineItemSchema);
export type AuditTimeline = z.infer<typeof auditTimelineSchema>;
