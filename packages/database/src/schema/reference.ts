import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
} from 'drizzle-orm/pg-core';
import { quantity } from './columns.ts';
import {
  brandEnum,
  dockTypeEnum,
  parkingConstraintEnum,
  roadClassEnum,
  vehicleAvailabilityStatusEnum,
  vehicleTemperatureEnum,
  vehicleTypeEnum,
} from './enums.ts';

export const depots = pgTable('depots', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
});

export const districtTravel = pgTable(
  'district_travel',
  {
    district: text('district').primaryKey(),
    depotId: text('depot_id')
      .notNull()
      .references(() => depots.id),
    roadClass: roadClassEnum('road_class').notNull(),
    depotToDistrictKm: quantity('depot_to_district_km').notNull(),
    depotToDistrictMin: quantity('depot_to_district_min').notNull(),
    interStopKm: quantity('inter_stop_km').notNull(),
    interStopMin: quantity('inter_stop_min').notNull(),
  },
  (table) => [
    index('district_travel_depot_id').on(table.depotId),
    check(
      'district_travel_nonnegative',
      sql`${table.depotToDistrictKm} >= 0 and ${table.depotToDistrictMin} >= 0 and ${table.interStopKm} >= 0 and ${table.interStopMin} >= 0`,
    ),
  ],
);

export const outlets = pgTable(
  'outlets',
  {
    id: text('id').primaryKey(),
    brand: brandEnum('brand').notNull(),
    district: text('district')
      .notNull()
      .references(() => districtTravel.district),
    depotId: text('depot_id')
      .notNull()
      .references(() => depots.id),
    dockType: dockTypeEnum('dock_type').notNull(),
    parkingConstraint: parkingConstraintEnum('parking_constraint').notNull(),
    mallWindowOpen: time('mall_window_open'),
    mallWindowClose: time('mall_window_close'),
    windowOpen: time('window_open').notNull(),
    windowClose: time('window_close').notNull(),
  },
  (table) => [
    index('outlets_depot_id').on(table.depotId),
    index('outlets_district').on(table.district),
    check('outlets_id_shape', sql`${table.id} ~ '^OUT[0-9]{3}$'`),
    check('outlets_window_order', sql`${table.windowOpen} < ${table.windowClose}`),
    check(
      'outlets_mall_window_pair',
      sql`(
        (${table.mallWindowOpen} is null and ${table.mallWindowClose} is null)
        or (
          ${table.mallWindowOpen} is not null
          and ${table.mallWindowClose} is not null
          and ${table.mallWindowOpen} < ${table.mallWindowClose}
        )
      )`,
    ),
  ],
);

export const vehicles = pgTable(
  'vehicles',
  {
    id: text('id').primaryKey(),
    type: vehicleTypeEnum('type').notNull(),
    temp: vehicleTemperatureEnum('temp').notNull(),
    weightCapKg: quantity('weight_cap_kg').notNull(),
    volumeCapM3: quantity('volume_cap_m3').notNull(),
    fuelType: text('fuel_type').notNull(),
    kmPerL: quantity('km_per_l').notNull(),
    weeklyFuelQuotaL: quantity('weekly_fuel_quota_l').notNull(),
    depotId: text('depot_id')
      .notNull()
      .references(() => depots.id),
  },
  (table) => [
    index('vehicles_depot_id').on(table.depotId),
    check('vehicles_id_shape', sql`${table.id} ~ '^VEH[0-9]{3}$'`),
    check(
      'vehicles_caps_positive',
      sql`${table.weightCapKg} > 0 and ${table.volumeCapM3} > 0 and ${table.kmPerL} > 0 and ${table.weeklyFuelQuotaL} >= 0`,
    ),
  ],
);

export const calendarDays = pgTable(
  'calendar_days',
  {
    date: date('date').primaryKey(),
    // calendar.csv numbers Monday as 0. This is not PostgreSQL's Sunday = 0.
    dow: smallint('dow').notNull(),
    isoYear: integer('iso_year').notNull(),
    isoWeek: smallint('iso_week').notNull(),
    isPayday: boolean('is_payday').notNull(),
    festival: text('festival'),
    festivalRamp: numeric('festival_ramp', { precision: 4, scale: 3, mode: 'number' }).notNull(),
    isHoliday: boolean('is_holiday').notNull(),
    monsoon: boolean('monsoon').notNull(),
    isOperating: boolean('is_operating').notNull(),
  },
  (table) => [
    index('calendar_days_iso_week').on(table.isoYear, table.isoWeek),
    check('calendar_days_dow', sql`${table.dow} between 0 and 6`),
    check('calendar_days_iso_week', sql`${table.isoWeek} between 1 and 53`),
    check(
      'calendar_days_festival_ramp',
      sql`${table.festivalRamp} >= 0 and ${table.festivalRamp} <= 1`,
    ),
  ],
);

export const serviceAllowances = pgTable(
  'service_allowances',
  {
    brand: brandEnum('brand').notNull(),
    dockType: dockTypeEnum('dock_type').notNull(),
    minutes: integer('minutes').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.brand, table.dockType] }),
    check('service_allowances_minutes_nonnegative', sql`${table.minutes} >= 0`),
  ],
);

export const vehicleAvailability = pgTable(
  'vehicle_availability',
  {
    vehicleId: text('vehicle_id')
      .notNull()
      .references(() => vehicles.id),
    date: date('date').notNull(),
    status: vehicleAvailabilityStatusEnum('status').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.vehicleId, table.date] }),
    index('vehicle_availability_date').on(table.date),
  ],
);

// Daily demand by depot and brand, aggregated from the supplied order history at seed time.
// Analytics reads it for the weeks before the platform's own orders exist. Each order counts
// once, on the day the store asked for (SRS BR-017, BR-018).
export const demandHistory = pgTable(
  'demand_history',
  {
    date: date('date').notNull(),
    depotId: text('depot_id')
      .notNull()
      .references(() => depots.id),
    brand: brandEnum('brand').notNull(),
    orders: integer('orders').notNull(),
    volumeM3: quantity('volume_m3').notNull(),
    chilledVolumeM3: quantity('chilled_volume_m3').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.date, table.depotId, table.brand] }),
    check(
      'demand_history_nonnegative',
      sql`${table.orders} >= 0 and ${table.volumeM3} >= 0 and ${table.chilledVolumeM3} >= 0`,
    ),
  ],
);
