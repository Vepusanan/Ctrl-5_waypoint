import { z } from 'zod';
import { podSchema } from '../entities/field.ts';
import { notificationSchema } from '../entities/notification.ts';
import { orderSchema } from '../entities/order.ts';
import { outletSchema } from '../entities/reference.ts';
import { issueSchema, receiptSchema } from '../entities/store.ts';
import {
  deferralTypeSchema,
  reasonCodeSchema,
  stopStatusSchema,
  tripStatusSchema,
} from '../enums.ts';
import { isoDateSchema, timestampSchema, uuidSchema, vehicleIdSchema } from '../primitives.ts';
import { listResponseSchema } from './common.ts';

export const notificationFeedItemSchema = notificationSchema.extend({
  actionRequired: z.boolean(),
});
export type NotificationFeedItem = z.infer<typeof notificationFeedItemSchema>;

export const createIssueRequestSchema = issueSchema
  .pick({ orderId: true, type: true })
  .extend({ note: z.string().trim().min(1).optional() });
export type CreateIssueRequest = z.infer<typeof createIssueRequestSchema>;

// What the dispatcher did about the issue. The store manager reads it on the issue.
export const resolveIssueRequestSchema = z.object({
  resolution: z.string().trim().min(1, 'Say how the issue was resolved').max(500),
});
export type ResolveIssueRequest = z.infer<typeof resolveIssueRequestSchema>;

export const issueListResponseSchema = listResponseSchema(issueSchema);
export type IssueListResponse = z.infer<typeof issueListResponseSchema>;

export const notificationListResponseSchema = listResponseSchema(notificationFeedItemSchema);
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>;

// Store-only read models. Scope is taken from the authenticated session.
export const storeOrderSchema = z.object({
  order: orderSchema,
  cutoffAt: timestampSchema.nullable(),
  editable: z.boolean(),
});
export type StoreOrder = z.infer<typeof storeOrderSchema>;
export const storeWorkspaceSchema = z.object({
  serverNow: timestampSchema,
  outlet: outletSchema,
  cutoffAt: timestampSchema.nullable(),
  nextServiceDate: isoDateSchema.nullable(),
  eligibleServiceDate: isoDateSchema.nullable(),
  serviceDates: z.array(z.object({ date: isoDateSchema, cutoffAt: timestampSchema.nullable() })),
  orders: z.array(storeOrderSchema),
  issues: z.array(issueSchema),
});
export type StoreWorkspace = z.infer<typeof storeWorkspaceSchema>;
export const storeOrderDetailSchema = storeOrderSchema.extend({
  serverNow: timestampSchema,
  outlet: outletSchema,
  delivery: z
    .object({
      stopId: uuidSchema,
      vehicleId: vehicleIdSchema,
      tripStatus: tripStatusSchema,
      status: stopStatusSchema,
      serviceDate: isoDateSchema,
      plannedArrival: timestampSchema,
      eta: timestampSchema,
      late: z.boolean(),
      publishedAt: timestampSchema,
      lastUpdatedAt: timestampSchema,
      updateDelayed: z.boolean(),
      deliveredAt: timestampSchema.nullable(),
      failureReason: z.string().nullable(),
      pod: podSchema.nullable(),
      receipt: receiptSchema.nullable(),
    })
    .nullable(),
  deferral: z
    .object({
      reasonCode: reasonCodeSchema,
      type: deferralTypeSchema,
      note: z.string().nullable(),
      createdAt: timestampSchema,
      serviceDate: isoDateSchema,
      nextEligibleDate: isoDateSchema.nullable(),
    })
    .nullable(),
  issues: z.array(issueSchema),
});
export type StoreOrderDetail = z.infer<typeof storeOrderDetailSchema>;
