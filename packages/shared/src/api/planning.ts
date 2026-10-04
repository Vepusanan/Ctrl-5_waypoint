import { z } from 'zod';
import { orderSchema } from '../entities/order.ts';
import { deferralSchema } from '../entities/planning.ts';
import { timeWindowSchema } from '../entities/reference.ts';
import {
  deferralTypeSchema,
  parkingConstraintSchema,
  reasonCodeSchema,
  temperatureRequirementSchema,
  tripStatusSchema,
} from '../enums.ts';
import {
  orderLiteSchema,
  planMetricsSchema,
  planResultSchema,
  violationSchema,
} from '../planning.ts';
import {
  depotIdSchema,
  districtSchema,
  isoDateSchema,
  outletIdSchema,
  timestampSchema,
  tripNoSchema,
  uuidSchema,
  vehicleIdSchema,
  versionSchema,
} from '../primitives.ts';
import { listResponseSchema } from './common.ts';

export const planningRunParamsSchema = z.object({ date: isoDateSchema });
export type PlanningRunParams = z.infer<typeof planningRunParamsSchema>;

const planningQueueOutletSchema = z.object({
  id: outletIdSchema,
  district: districtSchema,
  depotId: depotIdSchema,
  parkingConstraint: parkingConstraintSchema,
  window: timeWindowSchema,
  mallWindow: timeWindowSchema.nullable(),
});

const previousDeferralSchema = z.object({
  reasonCode: reasonCodeSchema,
  type: deferralTypeSchema,
  serviceDate: isoDateSchema,
});

// Queue rows carry outlet access, windows and deferral history (SRS FR-DEF-003).
export const planningQueueItemSchema = orderSchema
  .extend(orderLiteSchema.pick({ deferredYesterday: true, daysSinceLastServed: true }).shape)
  .extend({
    outlet: planningQueueOutletSchema,
    previousDeferral: previousDeferralSchema.nullable(),
  });
export type PlanningQueueItem = z.infer<typeof planningQueueItemSchema>;

// Stores can change orders until 4:00 PM on the operating day before the run (BR-001). Until then
// submitted orders are not in the queue yet, so the dispatcher is told how many are still to come.
export const runIntakeSchema = z.object({
  cutoffAt: timestampSchema,
  closed: z.boolean(),
  awaiting: z.int().nonnegative(),
});
export type RunIntake = z.infer<typeof runIntakeSchema>;

export const planningQueueResponseSchema = listResponseSchema(planningQueueItemSchema).extend({
  depotId: depotIdSchema,
  planVersion: versionSchema,
  intake: runIntakeSchema,
});
export type PlanningQueueResponse = z.infer<typeof planningQueueResponseSchema>;

export const draftPlanResponseSchema = planResultSchema.extend({
  planVersion: versionSchema,
});
export type DraftPlanResponse = z.infer<typeof draftPlanResponseSchema>;

export const autoAllocateResponseSchema = draftPlanResponseSchema.extend({});
export type AutoAllocateResponse = z.infer<typeof autoAllocateResponseSchema>;

export const allocationResponseSchema = draftPlanResponseSchema.extend({});
export type AllocationResponse = z.infer<typeof allocationResponseSchema>;

export const proposedTripSchema = z.object({
  vehicleId: vehicleIdSchema,
  tripNo: tripNoSchema,
  orderIds: z.array(uuidSchema).min(1),
});
export type ProposedTrip = z.infer<typeof proposedTripSchema>;

export const validatePlanRequestSchema = z.object({
  serviceDate: isoDateSchema,
  depotId: depotIdSchema,
  trips: z.array(proposedTripSchema),
});
export type ValidatePlanRequest = z.infer<typeof validatePlanRequestSchema>;

export const validatePlanResponseSchema = z.object({ violations: z.array(violationSchema) });
export type ValidatePlanResponse = z.infer<typeof validatePlanResponseSchema>;

// target null returns the order to the unallocated queue.
export const moveAllocationRequestSchema = z.object({
  orderId: uuidSchema,
  target: z.object({ vehicleId: vehicleIdSchema, tripNo: tripNoSchema }).nullable(),
});
export type MoveAllocationRequest = z.infer<typeof moveAllocationRequestSchema>;

export const publishPlanResponseSchema = z.object({
  planVersion: versionSchema,
  publishedAt: timestampSchema,
});
export type PublishPlanResponse = z.infer<typeof publishPlanResponseSchema>;

export const simulateChangeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('vehicle_unavailable'), vehicleId: vehicleIdSchema }),
  z.object({ type: z.literal('extra_reefer') }),
  z.object({ type: z.literal('fresh_demand'), factor: z.number().gt(1) }),
]);
export type SimulateChange = z.infer<typeof simulateChangeSchema>;

export const simulatePlanRequestSchema = z.object({
  changes: z.array(simulateChangeSchema).min(1),
});
export type SimulatePlanRequest = z.infer<typeof simulatePlanRequestSchema>;

export const simulatePlanResponseSchema = z.object({
  baseline: planMetricsSchema,
  scenario: planMetricsSchema,
});
export type SimulatePlanResponse = z.infer<typeof simulatePlanResponseSchema>;

export const createDeferralRequestSchema = z.object({
  orderId: uuidSchema,
  serviceDate: isoDateSchema,
  reasonCode: reasonCodeSchema,
  type: deferralTypeSchema,
  note: z.string().trim().min(1).optional(),
});
export type CreateDeferralRequest = z.infer<typeof createDeferralRequestSchema>;

export const listDeferralsQuerySchema = z.object({ outlet: outletIdSchema.optional() });
export type ListDeferralsQuery = z.infer<typeof listDeferralsQuerySchema>;

export const deferralListResponseSchema = listResponseSchema(deferralSchema);
export type DeferralListResponse = z.infer<typeof deferralListResponseSchema>;

// Replanning a published run (SRS §24, §42 "Vehicle unavailable"). Stops that have left the depot
// are never touched: only orders still at the depot can move or be deferred.

export const markVehicleUnavailableRequestSchema = z.object({
  date: isoDateSchema,
  reason: z.string().trim().min(1).max(200).optional(),
});
export type MarkVehicleUnavailableRequest = z.infer<typeof markVehicleUnavailableRequestSchema>;

export const vehicleUnavailableResponseSchema = z.object({
  vehicleId: vehicleIdSchema,
  date: isoDateSchema,
  /** Published trips of the vehicle that had not departed. Their orders wait for a replan. */
  blockedTripIds: z.array(uuidSchema),
  affectedOrderIds: z.array(uuidSchema),
});
export type VehicleUnavailableResponse = z.infer<typeof vehicleUnavailableResponseSchema>;

const replanTargetSchema = z.object({ vehicleId: vehicleIdSchema, tripNo: tripNoSchema });

export const replanMoveSchema = z.object({
  orderId: uuidSchema,
  /** The trip that takes the order. Null defers it to the next run. */
  target: replanTargetSchema.nullable(),
  /** Why the order is deferred. Required when `target` is null. */
  reasonCode: reasonCodeSchema.optional(),
});
export type ReplanMove = z.infer<typeof replanMoveSchema>;

export const replanRequestSchema = z.object({
  moves: z
    .array(replanMoveSchema)
    .min(1)
    .max(200)
    .refine((moves) => new Set(moves.map((move) => move.orderId)).size === moves.length, {
      message: 'An order can only be moved once',
    }),
  /** The dispatcher's reason for changing a published plan. Kept in the audit log. */
  note: z.string().trim().min(1, 'Say why the published plan is changing').max(500),
});
export type ReplanRequest = z.infer<typeof replanRequestSchema>;

export const replanResponseSchema = z.object({
  planVersion: versionSchema,
  movedOrderIds: z.array(uuidSchema),
  deferredOrderIds: z.array(uuidSchema),
  changedTripIds: z.array(uuidSchema),
});
export type ReplanResponse = z.infer<typeof replanResponseSchema>;

export const replanProposalSchema = z.object({
  serviceDate: isoDateSchema,
  vehicleId: vehicleIdSchema,
  planVersion: versionSchema,
  /** When the vehicle was marked unavailable, and the reason given. Null if it never was. */
  markedAt: timestampSchema.nullable(),
  reason: z.string().min(1).nullable(),
  /** Every order has a trip that passes the hard rules. */
  feasible: z.boolean(),
  orders: z.array(
    z.object({
      orderId: uuidSchema,
      outletId: outletIdSchema,
      temp: temperatureRequirementSchema,
      weightKg: z.number().positive(),
      from: replanTargetSchema.extend({ tripStatus: tripStatusSchema }),
      /** Where the validator lets the order go. Null when no trip can take it. */
      target: replanTargetSchema
        .extend({ newTrip: z.boolean(), loadPercent: z.number().nonnegative() })
        .nullable(),
      /** The rule that stopped the last candidate, when there is no target. */
      blockedBy: reasonCodeSchema.nullable(),
    }),
  ),
});
export type ReplanProposal = z.infer<typeof replanProposalSchema>;
