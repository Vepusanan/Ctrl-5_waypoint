import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { eventTimestamp, operationalId } from './columns.ts';
import { roleEnum } from './enums.ts';
import { depots, outlets, vehicles } from './reference.ts';

export const users = pgTable(
  'users',
  {
    id: operationalId(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    role: roleEnum('role').notNull(),
    outletId: text('outlet_id').references(() => outlets.id),
    depotId: text('depot_id').references(() => depots.id),
    vehicleId: text('vehicle_id').references(() => vehicles.id),
    // Set when the account is deactivated. Users are never deleted: orders, deliveries and the
    // audit log refer to them. A deactivated user cannot sign in or keep a session.
    disabledAt: eventTimestamp('disabled_at'),
  },
  (table) => [
    index('users_outlet_id').on(table.outletId),
    index('users_depot_id').on(table.depotId),
    index('users_vehicle_id').on(table.vehicleId),
    // Scope columns follow the shared user union: each role carries only its own scope.
    check(
      'users_role_scope',
      sql`(
        (
          ${table.role} = 'dispatcher'
          and ${table.outletId} is null
          and ${table.vehicleId} is null
        )
        or (
          ${table.role} = 'loader'
          and ${table.depotId} is not null
          and ${table.outletId} is null
          and ${table.vehicleId} is null
        )
        or (
          ${table.role} = 'driver'
          and ${table.vehicleId} is not null
          and ${table.outletId} is null
          and ${table.depotId} is null
        )
        or (
          ${table.role} = 'store_manager'
          and ${table.outletId} is not null
          and ${table.depotId} is null
          and ${table.vehicleId} is null
        )
      )`,
    ),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: operationalId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: eventTimestamp('expires_at').notNull(),
  },
  (table) => [
    index('sessions_user_id').on(table.userId),
    index('sessions_expires_at').on(table.expiresAt),
  ],
);
