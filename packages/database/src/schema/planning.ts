import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { eventTimestamp, operationalId, quantity } from './columns.ts';
import {
  brandEnum,
  deferralTypeEnum,
  planningRunStatusEnum,
  reasonCodeEnum,
  stopStatusEnum,
  tripStatusEnum,
} from './enums.ts';
import { users } from './identity.ts';
import { orders } from './orders.ts';
import { depots, districtTravel, vehicles } from './reference.ts';

export const planningRuns = pgTable(
  'planning_runs',
  {
    id: operationalId(),
    depotId: text('depot_id')
      .notNull()
      .references(() => depots.id),
    serviceDate: date('service_date').notNull(),
    status: planningRunStatusEnum('status').notNull().default('open'),
    publishedAt: eventTimestamp('published_at'),
    publishedBy: uuid('published_by').references(() => users.id),
    planVersion: integer('plan_version').notNull().default(0),
  },
  (table) => [
    unique('planning_runs_depot_service_date').on(table.depotId, table.serviceDate),
    index('planning_runs_published_by').on(table.publishedBy),
    check('planning_runs_plan_version_nonnegative', sql`${table.planVersion} >= 0`),
    check(
      'planning_runs_publish_fields',
      sql`(
        (${table.status} = 'open' and ${table.publishedAt} is null and ${table.publishedBy} is null)
        or (
          ${table.status} = 'published'
          and ${table.publishedAt} is not null
          and ${table.publishedBy} is not null
        )
      )`,
    ),
  ],
);

export const trips = pgTable(
  'trips',
  {
    id: operationalId(),
    runId: uuid('run_id')
      .notNull()
      .references(() => planningRuns.id),
    vehicleId: text('vehicle_id')
      .notNull()
      .references(() => vehicles.id),
    tripNo: smallint('trip_no').notNull(),
    brand: brandEnum('brand').notNull(),
    district: text('district')
      .notNull()
      .references(() => districtTravel.district),
    status: tripStatusEnum('status').notNull().default('planned'),
    version: integer('version').notNull().default(0),
    plannedMinutes: quantity('planned_minutes').notNull(),
    plannedKm: quantity('planned_km').notNull(),
  },
  (table) => [
    unique('trips_run_vehicle_trip_no').on(table.runId, table.vehicleId, table.tripNo),
    index('trips_vehicle_id').on(table.vehicleId),
    check('trips_trip_no', sql`${table.tripNo} in (1, 2)`),
    check(
      'trips_plan_nonnegative',
      sql`${table.plannedMinutes} >= 0 and ${table.plannedKm} >= 0 and ${table.version} >= 0`,
    ),
  ],
);

export const tripStops = pgTable(
  'trip_stops',
  {
    id: operationalId(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    seq: integer('seq').notNull(),
    plannedArrival: eventTimestamp('planned_arrival').notNull(),
    status: stopStatusEnum('status').notNull().default('pending'),
    // Late is a flag on an arrived stop, not a separate outcome (SYSTEM_DESIGN §5.3).
    late: boolean('late').notNull().default(false),
  },
  (table) => [
    unique('trip_stops_order_id').on(table.orderId),
    unique('trip_stops_trip_seq').on(table.tripId, table.seq),
    check('trip_stops_seq_positive', sql`${table.seq} > 0`),
  ],
);

export const deferrals = pgTable(
  'deferrals',
  {
    id: operationalId(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    runId: uuid('run_id')
      .notNull()
      .references(() => planningRuns.id),
    reasonCode: reasonCodeEnum('reason_code').notNull(),
    type: deferralTypeEnum('type').notNull(),
    note: text('note'),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id),
    createdAt: eventTimestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('deferrals_order_id').on(table.orderId),
    index('deferrals_run_id').on(table.runId),
    index('deferrals_actor_id').on(table.actorId),
  ],
);

export const fuelLedger = pgTable(
  'fuel_ledger',
  {
    id: operationalId(),
    vehicleId: text('vehicle_id')
      .notNull()
      .references(() => vehicles.id),
    isoYear: integer('iso_year').notNull(),
    isoWeek: smallint('iso_week').notNull(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id),
    litres: quantity('litres').notNull(),
  },
  (table) => [
    unique('fuel_ledger_trip_id').on(table.tripId),
    index('fuel_ledger_vehicle_week').on(table.vehicleId, table.isoYear, table.isoWeek),
    check('fuel_ledger_iso_week', sql`${table.isoWeek} between 1 and 53`),
    check('fuel_ledger_litres_nonnegative', sql`${table.litres} >= 0`),
  ],
);

// Saved planning-queue views. A private view belongs to its owner; a team view is shared with
// every dispatcher. `filters` is the queue's own filter object, stored as the client sent it.
export const savedViews = pgTable(
  'saved_views',
  {
    id: operationalId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    audience: text('audience').notNull().default('private'),
    pinned: boolean('pinned').notNull().default(false),
    filters: jsonb('filters').$type<Record<string, unknown>>().notNull(),
    position: integer('position').notNull().default(0),
    createdAt: eventTimestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('saved_views_user_id').on(table.userId),
    check('saved_views_name_present', sql`${table.name} <> ''`),
    check('saved_views_audience', sql`${table.audience} in ('private', 'team')`),
  ],
);
