import { z } from 'zod';

// Reference-data values match the source datasets exactly (for example Brand is 'Fresh', not 'fresh').

export const roleSchema = z.enum(['dispatcher', 'loader', 'driver', 'store_manager']);
export type Role = z.infer<typeof roleSchema>;

export const brandSchema = z.enum(['Fresh', 'Style', 'Tech']);
export type Brand = z.infer<typeof brandSchema>;

export const temperatureRequirementSchema = z.enum(['ambient', 'chilled']);
export type TemperatureRequirement = z.infer<typeof temperatureRequirementSchema>;

export const vehicleTypeSchema = z.enum(['truck', 'van']);
export type VehicleType = z.infer<typeof vehicleTypeSchema>;

export const vehicleTemperatureSchema = z.enum(['ambient', 'reefer']);
export type VehicleTemperature = z.infer<typeof vehicleTemperatureSchema>;

export const dockTypeSchema = z.enum(['rear_dock', 'street', 'mall_bay']);
export type DockType = z.infer<typeof dockTypeSchema>;

export const parkingConstraintSchema = z.enum(['normal', 'van_only', 'mall_dock']);
export type ParkingConstraint = z.infer<typeof parkingConstraintSchema>;

export const roadClassSchema = z.enum(['urban', 'suburban', 'highway', 'hill']);
export type RoadClass = z.infer<typeof roadClassSchema>;

export const vehicleAvailabilityStatusSchema = z.enum(['available', 'in_workshop']);
export type VehicleAvailabilityStatus = z.infer<typeof vehicleAvailabilityStatusSchema>;

// Lifecycle states (SYSTEM_DESIGN §5.3). Allowed moves live in state-machines.ts.

export const orderStatusSchema = z.enum([
  'draft',
  'submitted',
  'confirmed',
  'allocated',
  'deferred',
  'loading',
  'dispatched',
  'delivered',
  'failed',
  'receipt_confirmed',
  'cancelled',
]);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

export const tripStatusSchema = z.enum([
  'planned',
  'published',
  'loading',
  'ready',
  'departed',
  'completed',
  'blocked',
]);
export type TripStatus = z.infer<typeof tripStatusSchema>;

export const stopStatusSchema = z.enum(['pending', 'arrived', 'delivered', 'failed']);
export type StopStatus = z.infer<typeof stopStatusSchema>;

export const loadingStatusSchema = z.enum([
  'not_started',
  'in_progress',
  'exception',
  'ready',
  'departed',
]);
export type LoadingStatus = z.infer<typeof loadingStatusSchema>;

export const syncStatusSchema = z.enum(['local', 'queued', 'syncing', 'synced', 'conflict']);
export type SyncStatus = z.infer<typeof syncStatusSchema>;

export const transitionEntitySchema = z.enum(['order', 'trip', 'stop', 'loading', 'sync_event']);
export type TransitionEntity = z.infer<typeof transitionEntitySchema>;

export const syncEventResultStatusSchema = z.enum(['applied', 'duplicate', 'conflict', 'rejected']);
export type SyncEventResultStatus = z.infer<typeof syncEventResultStatusSchema>;

export const planningRunStatusSchema = z.enum(['open', 'published']);
export type PlanningRunStatus = z.infer<typeof planningRunStatusSchema>;

// Hard-constraint rules (SYSTEM_DESIGN §7.2). Used for validator violations and deferral reasons.
export const reasonCodeSchema = z.enum([
  'MIXED_BRAND_DISTRICT',
  'REEFER_REQUIRED',
  'VAN_REQUIRED',
  'WRONG_DEPOT',
  'VEHICLE_UNAVAILABLE',
  'WEIGHT_CAP',
  'VOLUME_CAP',
  'TRIP_LIMIT',
  'FRESH_TIME_BUDGET',
  'DAY_TIME_BUDGET',
  'WINDOW_MISSED',
  'FUEL_QUOTA',
]);
export type ReasonCode = z.infer<typeof reasonCodeSchema>;

export const deferralTypeSchema = z.enum(['unavoidable', 'prioritized']);
export type DeferralType = z.infer<typeof deferralTypeSchema>;

export const loadingIssueTypeSchema = z.enum(['missing', 'damaged', 'short']);
export type LoadingIssueType = z.infer<typeof loadingIssueTypeSchema>;

export const stopEventTypeSchema = z.enum(['arrived', 'delivered', 'failed']);
export type StopEventType = z.infer<typeof stopEventTypeSchema>;

export const issueTypeSchema = z.enum(['missing', 'damaged', 'incorrect']);
export type IssueType = z.infer<typeof issueTypeSchema>;

export const issueStatusSchema = z.enum(['open', 'resolved']);
export type IssueStatus = z.infer<typeof issueStatusSchema>;

export const notificationTypeSchema = z.enum([
  'order_confirmed',
  'order_deferred',
  'plan_published',
  'loading_shortfall',
  'delivery_failed',
  'delivered',
  'receipt_discrepancy',
  'sync_conflict',
  'plan_changed',
  'delivery_issue',
  'issue_resolved',
]);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

export const notificationPrioritySchema = z.enum(['info', 'medium', 'high']);
export type NotificationPriority = z.infer<typeof notificationPrioritySchema>;

export const entityTypeSchema = z.enum([
  'order',
  'trip',
  'stop',
  'loading_issue',
  'issue',
  'sync_conflict',
]);
export type EntityType = z.infer<typeof entityTypeSchema>;
