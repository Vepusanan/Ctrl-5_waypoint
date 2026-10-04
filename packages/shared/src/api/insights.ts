import { z } from 'zod';
import { orderStatusSchema, stopStatusSchema } from '../enums.ts';
import {
  depotIdSchema,
  isoDateSchema,
  outletIdSchema,
  timestampSchema,
  tripNoSchema,
  uuidSchema,
  vehicleIdSchema,
} from '../primitives.ts';
import { listResponseSchema } from './common.ts';

// Decision support read from recorded data (SRS FR-PRED-003, UI-D10). Every forecast value is a
// projection from history and the calendar, never an observed fact.

export const demandQuerySchema = z.object({ date: isoDateSchema });
export type DemandQuery = z.infer<typeof demandQuerySchema>;

const demandDaySchema = z.object({
  /** The day the figure is for: the same weekday as the requested date, one per week. */
  date: isoDateSchema,
  isoYear: z.int(),
  isoWeek: z.int(),
  orders: z.number().nonnegative(),
  volumeM3: z.number().nonnegative(),
  chilledVolumeM3: z.number().nonnegative(),
  isPayday: z.boolean(),
  festival: z.string().min(1).nullable(),
  festivalRamp: z.number().nonnegative(),
});
export type DemandDay = z.infer<typeof demandDaySchema>;

const fleetClassSchema = z.object({
  vehicles: z.int().nonnegative(),
  /** Not in the workshop on the requested date. */
  available: z.int().nonnegative(),
  avgVolumeCapM3: z.number().nonnegative(),
});

export const demandInsightSchema = z.object({
  serviceDate: isoDateSchema,
  depotId: depotIdSchema,
  fleet: z.object({ reefer: fleetClassSchema, dry: fleetClassSchema }),
  /** Observed days, oldest first. The last entry is the requested date when it has orders. */
  history: z.array(demandDaySchema),
  /** The next ten weeks, projected. */
  forecast: z.array(demandDaySchema),
  /** How much more a payday day carries than an ordinary one, from history. 1 means no lift. */
  paydayUplift: z.number().positive(),
});
export type DemandInsight = z.infer<typeof demandInsightSchema>;

export const outletHistoryItemSchema = z.object({
  outletId: outletIdSchema,
  /** Latest eight arrivals, oldest first. True means inside the delivery window. */
  arrivals: z.array(z.boolean()),
  /** Latest four published runs, oldest first. True means an order was deferred in that run. */
  deferrals: z.array(z.boolean()),
});
export const outletHistoryListSchema = listResponseSchema(outletHistoryItemSchema);
export type OutletHistoryList = z.infer<typeof outletHistoryListSchema>;

export const outletProfileQuerySchema = z.object({ date: isoDateSchema });

export const outletProfileFactsSchema = z.object({
  outletId: outletIdSchema,
  managerName: z.string().min(1).nullable(),
  onTime: z.object({ arrivals: z.int().nonnegative(), of: z.int().nonnegative() }),
  deferred: z.object({ count: z.int().nonnegative(), runs: z.int().nonnegative() }),
  avgUnloadMinutes: z.number().nonnegative().nullable(),
  /** Ordered weight on the same weekday, oldest first. */
  volume: z.array(z.object({ date: isoDateSchema, kg: z.number().nonnegative() })),
  nextDelivery: z
    .object({
      serviceDate: isoDateSchema,
      orderId: uuidSchema,
      orderStatus: orderStatusSchema,
      stopStatus: stopStatusSchema.nullable(),
      arrivedAt: timestampSchema.nullable(),
      vehicleId: vehicleIdSchema.nullable(),
      tripNo: tripNoSchema.nullable(),
    })
    .nullable(),
});
export type OutletProfileFacts = z.infer<typeof outletProfileFactsSchema>;

// Saved planning-queue views. `filters` is the queue page's own filter object.
export const savedViewSchema = z.object({
  id: uuidSchema,
  name: z.string().trim().min(1).max(60),
  audience: z.enum(['private', 'team']),
  pinned: z.boolean(),
  filters: z.record(z.string(), z.unknown()),
});
export type SavedView = z.infer<typeof savedViewSchema>;

export const createSavedViewRequestSchema = savedViewSchema.omit({ id: true });
export const updateSavedViewRequestSchema = createSavedViewRequestSchema.partial();
export const orderSavedViewsRequestSchema = z.object({ ids: z.array(uuidSchema).max(200) });
export const savedViewListSchema = listResponseSchema(savedViewSchema);
