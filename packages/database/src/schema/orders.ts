import { sql } from 'drizzle-orm';
import { check, date, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { eventTimestamp, operationalId, quantity } from './columns.ts';
import { brandEnum, orderStatusEnum, temperatureRequirementEnum } from './enums.ts';
import { outlets } from './reference.ts';

export const orders = pgTable(
  'orders',
  {
    id: operationalId(),
    outletId: text('outlet_id')
      .notNull()
      .references(() => outlets.id),
    brand: brandEnum('brand').notNull(),
    temp: temperatureRequirementEnum('temp').notNull(),
    requestedDate: date('requested_date').notNull(),
    units: integer('units').notNull(),
    weightKg: quantity('weight_kg').notNull(),
    volumeM3: quantity('volume_m3').notNull(),
    status: orderStatusEnum('status').notNull().default('draft'),
    submittedAt: eventTimestamp('submitted_at'),
    lockedAt: eventTimestamp('locked_at'),
    version: integer('version').notNull().default(0),
  },
  (table) => [
    index('orders_outlet_requested_date').on(table.outletId, table.requestedDate),
    index('orders_status_requested_date').on(table.status, table.requestedDate),
    check(
      'orders_size_positive',
      sql`${table.units} > 0 and ${table.weightKg} > 0 and ${table.volumeM3} > 0`,
    ),
    check('orders_version_nonnegative', sql`${table.version} >= 0`),
    // BR-020: only Fresh has chilled goods.
    check('orders_chilled_fresh_only', sql`${table.temp} = 'ambient' or ${table.brand} = 'Fresh'`),
  ],
);
