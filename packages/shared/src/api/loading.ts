import { z } from 'zod';
import { loadingIssueSchema } from '../entities/loading.ts';
import { loadingStatusSchema, parkingConstraintSchema } from '../enums.ts';
import { timestampSchema, uuidSchema, versionSchema } from '../primitives.ts';
import { tripOrderSummarySchema, tripVehicleSchema } from './trips.ts';

// Canonical stop order. The loader screen reverses this for display (SYSTEM_DESIGN §10.4).
export const loadingStopSchema = z.object({
  id: uuidSchema,
  seq: z.int().positive(),
  plannedArrival: timestampSchema,
  order: tripOrderSummarySchema,
  /** Cartons the loader has counted onto the vehicle for this stop. */
  loadedUnits: z.int().nonnegative().default(0),
  chilled: z.boolean(),
  access: parkingConstraintSchema,
});
export type LoadingStop = z.infer<typeof loadingStopSchema>;

export const loadingPlanSnapshotSchema = z.object({
  planVersion: versionSchema,
  tripVersion: versionSchema,
  stops: z.array(loadingStopSchema),
});

export const loadingStateSchema = z.object({
  tripId: uuidSchema,
  acceptedPlan: loadingPlanSnapshotSchema.nullable().optional(),
  status: loadingStatusSchema,
  loaderId: uuidSchema.nullable(),
  tripVersion: versionSchema,
  planVersion: versionSchema,
  acceptedTripVersion: versionSchema.nullable(),
  planStale: z.boolean(),
  verifiedAt: timestampSchema.nullable(),
  vehicle: tripVehicleSchema,
  stops: z.array(loadingStopSchema),
  issues: z.array(loadingIssueSchema),
});
export type LoadingState = z.infer<typeof loadingStateSchema>;
