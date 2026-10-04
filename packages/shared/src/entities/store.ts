import { z } from 'zod';
import { issueStatusSchema, issueTypeSchema } from '../enums.ts';
import { timestampSchema, uuidSchema } from '../primitives.ts';

export const receiptSchema = z.object({
  id: uuidSchema,
  stopId: uuidSchema,
  confirmedBy: uuidSchema,
  confirmedAt: timestampSchema,
});
export type Receipt = z.infer<typeof receiptSchema>;

export const issueSchema = z.object({
  id: uuidSchema,
  orderId: uuidSchema,
  type: issueTypeSchema,
  note: z.string().trim().min(1).nullable(),
  status: issueStatusSchema,
  createdBy: uuidSchema,
  createdAt: timestampSchema,
  // Null until the dispatcher resolves the issue.
  resolvedBy: uuidSchema.nullable(),
  resolvedAt: timestampSchema.nullable(),
  resolution: z.string().trim().min(1).nullable(),
});
export type Issue = z.infer<typeof issueSchema>;
