import { z } from 'zod';
import {
  entityTypeSchema,
  type NotificationPriority,
  type NotificationType,
  notificationPrioritySchema,
  notificationTypeSchema,
} from '../enums.ts';
import { timestampSchema, uuidSchema } from '../primitives.ts';

// SYSTEM_DESIGN §11.1. plan_changed and delivery_issue stay distinct from the first
// publish and from a failed stop so each event keeps its own feed entry.
export const notificationPriorityByType = {
  order_confirmed: 'info',
  order_deferred: 'high',
  plan_published: 'high',
  plan_changed: 'high',
  loading_shortfall: 'high',
  delivery_failed: 'high',
  delivery_issue: 'high',
  delivered: 'info',
  receipt_discrepancy: 'high',
  sync_conflict: 'medium',
  issue_resolved: 'info',
} as const satisfies Record<NotificationType, NotificationPriority>;

export const notificationSchema = z.object({
  id: uuidSchema,
  recipientId: uuidSchema,
  type: notificationTypeSchema,
  priority: notificationPrioritySchema,
  entityType: entityTypeSchema,
  entityId: z.string().min(1),
  createdAt: timestampSchema,
  readAt: timestampSchema.nullable(),
  acknowledgedAt: timestampSchema.nullable(),
});
export type Notification = z.infer<typeof notificationSchema>;

// High-priority items need an acknowledgement. Reading one does not clear that.
export function notificationRequiresAction(
  priority: NotificationPriority,
  acknowledgedAt: string | null,
): boolean {
  return priority === 'high' && acknowledgedAt === null;
}
