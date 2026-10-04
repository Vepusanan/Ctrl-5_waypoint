import type { Database } from '@waypoint/database';
import { notifications } from '@waypoint/database';
import type { EntityType, NotificationPriority, NotificationType } from '@waypoint/shared';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

type NotificationDb = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export interface NotificationRow {
  id: string;
  recipientId: string;
  type: NotificationType;
  priority: NotificationPriority;
  entityType: EntityType;
  entityId: string;
  createdAt: Date;
  readAt: Date | null;
  acknowledgedAt: Date | null;
}

export interface NotificationRepo {
  listForRecipient(db: NotificationDb, recipientId: string): Promise<NotificationRow[]>;
  lockForRecipient(
    db: NotificationDb,
    id: string,
    recipientId: string,
  ): Promise<NotificationRow | null>;
  markRead(db: NotificationDb, id: string, readAt: Date): Promise<NotificationRow | null>;
  acknowledge(
    db: NotificationDb,
    id: string,
    acknowledgedAt: Date,
  ): Promise<NotificationRow | null>;
}

const columns = {
  id: notifications.id,
  recipientId: notifications.recipientId,
  type: notifications.type,
  priority: notifications.priority,
  entityType: notifications.entityType,
  entityId: notifications.entityId,
  createdAt: notifications.createdAt,
  readAt: notifications.readAt,
  acknowledgedAt: notifications.acknowledgedAt,
};

// The bell polls this list, and a recipient's notifications only ever grow. The cap drops the
// oldest, lowest-priority rows first.
export const NOTIFICATION_LIST_LIMIT = 200;

// High, then medium, then info. Newest first inside a priority.
const priorityRank = sql`case ${notifications.priority} when 'high' then 0 when 'medium' then 1 else 2 end`;

export function createNotificationRepo(): NotificationRepo {
  return {
    async listForRecipient(db, recipientId) {
      return db
        .select(columns)
        .from(notifications)
        .where(eq(notifications.recipientId, recipientId))
        .orderBy(asc(priorityRank), desc(notifications.createdAt), desc(notifications.id))
        .limit(NOTIFICATION_LIST_LIMIT);
    },

    async lockForRecipient(db, id, recipientId) {
      const rows = await db
        .select(columns)
        .from(notifications)
        .where(and(eq(notifications.id, id), eq(notifications.recipientId, recipientId)))
        .limit(1)
        .for('update');
      return rows[0] ?? null;
    },

    async markRead(db, id, readAt) {
      const rows = await db
        .update(notifications)
        .set({ readAt })
        .where(and(eq(notifications.id, id), isNull(notifications.readAt)))
        .returning(columns);
      return rows[0] ?? null;
    },

    async acknowledge(db, id, acknowledgedAt) {
      const rows = await db
        .update(notifications)
        .set({ acknowledgedAt })
        .where(and(eq(notifications.id, id), isNull(notifications.acknowledgedAt)))
        .returning(columns);
      return rows[0] ?? null;
    },
  };
}
