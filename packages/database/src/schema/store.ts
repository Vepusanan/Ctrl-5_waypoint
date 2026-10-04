import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { eventTimestamp, operationalId } from './columns.ts';
import { issueStatusEnum, issueTypeEnum } from './enums.ts';
import { users } from './identity.ts';
import { orders } from './orders.ts';
import { tripStops } from './planning.ts';

export const receipts = pgTable(
  'receipts',
  {
    id: operationalId(),
    stopId: uuid('stop_id')
      .notNull()
      .references(() => tripStops.id),
    confirmedBy: uuid('confirmed_by')
      .notNull()
      .references(() => users.id),
    confirmedAt: eventTimestamp('confirmed_at').notNull(),
  },
  (table) => [
    unique('receipts_stop_id').on(table.stopId),
    index('receipts_confirmed_by').on(table.confirmedBy),
  ],
);

export const issues = pgTable(
  'issues',
  {
    id: operationalId(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    type: issueTypeEnum('type').notNull(),
    note: text('note'),
    status: issueStatusEnum('status').notNull().default('open'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: eventTimestamp('created_at').notNull().defaultNow(),
    // Set together when the dispatcher closes the issue.
    resolvedBy: uuid('resolved_by').references(() => users.id),
    resolvedAt: eventTimestamp('resolved_at'),
    resolution: text('resolution'),
  },
  (table) => [
    index('issues_order_id').on(table.orderId),
    index('issues_created_by').on(table.createdBy),
    check(
      'issues_resolution',
      sql`(
        (${table.status} = 'open' and ${table.resolvedBy} is null and ${table.resolvedAt} is null)
        or (${table.status} = 'resolved' and ${table.resolvedBy} is not null and ${table.resolvedAt} is not null)
      )`,
    ),
  ],
);
