import { z } from 'zod';
import { loadingIssueSchema } from '../entities/loading.ts';
import { orderSchema } from '../entities/order.ts';
import { planningRunSchema, tripSchema, tripStopSchema } from '../entities/planning.ts';
import { vehicleSchema } from '../entities/reference.ts';
import { loadingStatusSchema } from '../enums.ts';
import {
  isoDateSchema,
  timestampSchema,
  uuidSchema,
  vehicleIdSchema,
  versionSchema,
} from '../primitives.ts';
import { listResponseSchema } from './common.ts';

export const listTripsQuerySchema = z.object({
  date: isoDateSchema.optional(),
  vehicle: vehicleIdSchema.optional(),
});
export type ListTripsQuery = z.infer<typeof listTripsQuerySchema>;

export const tripRunSchema = planningRunSchema.pick({
  id: true,
  depotId: true,
  serviceDate: true,
  status: true,
  planVersion: true,
});
export type TripRun = z.infer<typeof tripRunSchema>;

export const tripVehicleSchema = vehicleSchema.pick({
  id: true,
  type: true,
  temp: true,
  depotId: true,
});
export type TripVehicle = z.infer<typeof tripVehicleSchema>;

export const tripOrderSummarySchema = orderSchema.pick({
  id: true,
  outletId: true,
  brand: true,
  temp: true,
  requestedDate: true,
  units: true,
  weightKg: true,
  volumeM3: true,
  status: true,
});
export type TripOrderSummary = z.infer<typeof tripOrderSummarySchema>;

export const tripStopDetailSchema = tripStopSchema.extend({
  order: tripOrderSummarySchema,
});
export type TripStopDetail = z.infer<typeof tripStopDetailSchema>;

export const tripLastEventSchema = z.object({
  serverTime: timestampSchema,
  tripVersion: versionSchema,
});
export type TripLastEvent = z.infer<typeof tripLastEventSchema>;

export const tripDetailSchema = tripSchema.extend({
  run: tripRunSchema,
  vehicle: tripVehicleSchema,
  stops: z.array(tripStopDetailSchema),
  loadingStatus: loadingStatusSchema,
  exceptions: z.array(loadingIssueSchema),
  lastEvent: tripLastEventSchema.nullable(),
});
export type TripDetail = z.infer<typeof tripDetailSchema>;

export const tripListResponseSchema = listResponseSchema(tripDetailSchema);
export type TripListResponse = z.infer<typeof tripListResponseSchema>;

export const resequenceTripRequestSchema = z.object({
  stopIds: z
    .array(uuidSchema)
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Stop ids must be unique' }),
});
export type ResequenceTripRequest = z.infer<typeof resequenceTripRequestSchema>;

export const setLoadingCountRequestSchema = z.object({
  orderId: uuidSchema,
  units: z.int().nonnegative(),
});
export type SetLoadingCountRequest = z.infer<typeof setLoadingCountRequestSchema>;

export const createLoadingIssueRequestSchema = loadingIssueSchema
  .pick({ orderId: true, type: true, qty: true })
  .extend({ note: z.string().trim().min(1).optional() });
export type CreateLoadingIssueRequest = z.infer<typeof createLoadingIssueRequestSchema>;
