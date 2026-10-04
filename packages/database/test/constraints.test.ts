import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/client.ts';
import { loadDatabaseEnv } from '../src/env.ts';
import { auditLog } from '../src/schema/cross-cutting.ts';
import { stopEvents } from '../src/schema/field.ts';
import { users } from '../src/schema/identity.ts';
import { orders } from '../src/schema/orders.ts';
import { deferrals, planningRuns, tripStops, trips } from '../src/schema/planning.ts';
import {
  calendarDays,
  depots,
  districtTravel,
  outlets,
  vehicles,
} from '../src/schema/reference.ts';

const TEST_DATABASE = 'waypoint_test';
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARRIVAL = new Date('2026-10-03T03:30:00.000+05:30');

const TABLES = [
  'demand_history',
  'loading_counts',
  'saved_views',
  'depots',
  'outlets',
  'vehicles',
  'calendar_days',
  'district_travel',
  'service_allowances',
  'vehicle_availability',
  'users',
  'sessions',
  'orders',
  'planning_runs',
  'trips',
  'trip_stops',
  'deferrals',
  'fuel_ledger',
  'loading_records',
  'loading_issues',
  'stop_events',
  'pods',
  'receipts',
  'issues',
  'notifications',
  'audit_log',
  'sync_conflicts',
  'seed_meta',
] as const;

function databaseUrl(): string {
  if (process.env.DATABASE_URL === undefined) {
    const file = readFileSync(new URL('../../../.env', import.meta.url), 'utf8');
    for (const line of file.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator === -1) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
  return loadDatabaseEnv(process.env).DATABASE_URL;
}

function withDatabase(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function postgresCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    if (
      'code' in current &&
      typeof current.code === 'string' &&
      /^[0-9A-Z]{5}$/.test(current.code)
    ) {
      return current.code;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

async function expectCode(run: () => Promise<unknown>, code: string) {
  try {
    await run();
  } catch (error) {
    const actual = postgresCode(error);
    if (actual !== code) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Expected PostgreSQL ${code} but got ${actual ?? 'no code'}: ${message}`, {
        cause: error,
      });
    }
    return;
  }
  throw new Error(`Expected PostgreSQL error ${code}`);
}

async function recreateTestDatabase(adminUrl: string) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(
      `select pg_terminate_backend(pid)
       from pg_stat_activity
       where datname = $1 and pid <> pg_backend_pid()`,
      [TEST_DATABASE],
    );
    await client.query(`drop database if exists ${TEST_DATABASE}`);
    await client.query(`create database ${TEST_DATABASE}`);
  } finally {
    await client.end();
  }
}

interface Fixture {
  actorId: string;
  orderId: string;
  runId: string;
  tripId: string;
  stopId: string;
}

async function seed(db: Database): Promise<Fixture> {
  await db.insert(depots).values({ id: 'Peliyagoda', name: 'Peliyagoda' });
  await db.insert(districtTravel).values({
    district: 'Colombo',
    depotId: 'Peliyagoda',
    roadClass: 'urban',
    depotToDistrictKm: 12,
    depotToDistrictMin: 24,
    interStopKm: 4,
    interStopMin: 8,
  });
  await db.insert(outlets).values({
    id: 'OUT001',
    brand: 'Fresh',
    district: 'Colombo',
    depotId: 'Peliyagoda',
    dockType: 'street',
    parkingConstraint: 'normal',
    windowOpen: '05:00:00',
    windowClose: '08:00:00',
  });
  await db.insert(vehicles).values({
    id: 'VEH014',
    type: 'van',
    temp: 'reefer',
    weightCapKg: 1500,
    volumeCapM3: 8,
    fuelType: 'diesel',
    kmPerL: 10.5,
    weeklyFuelQuotaL: 200,
    depotId: 'Peliyagoda',
  });
  await db.insert(calendarDays).values({
    date: '2026-10-03',
    dow: 5,
    isoYear: 2026,
    isoWeek: 40,
    isPayday: false,
    festivalRamp: 0,
    isHoliday: false,
    monsoon: false,
    isOperating: true,
  });
  const actor = await db
    .insert(users)
    .values({
      name: 'Dispatcher',
      email: 'dispatcher@example.com',
      passwordHash: 'hash',
      role: 'dispatcher',
      depotId: 'Peliyagoda',
    })
    .returning({ id: users.id });
  const actorRow = actor[0];
  if (actorRow === undefined) throw new Error('Expected a dispatcher id');

  const order = await db
    .insert(orders)
    .values({
      outletId: 'OUT001',
      brand: 'Fresh',
      temp: 'chilled',
      requestedDate: '2026-10-03',
      units: 4,
      weightKg: 12.5,
      volumeM3: 0.4,
      status: 'confirmed',
    })
    .returning({ id: orders.id });
  const orderRow = order[0];
  if (orderRow === undefined) throw new Error('Expected an order id');

  const run = await db
    .insert(planningRuns)
    .values({ depotId: 'Peliyagoda', serviceDate: '2026-10-03' })
    .returning({ id: planningRuns.id });
  const runRow = run[0];
  if (runRow === undefined) throw new Error('Expected a planning run id');

  const trip = await db
    .insert(trips)
    .values({
      runId: runRow.id,
      vehicleId: 'VEH014',
      tripNo: 1,
      brand: 'Fresh',
      district: 'Colombo',
      plannedMinutes: 40,
      plannedKm: 16,
    })
    .returning({ id: trips.id });
  const tripRow = trip[0];
  if (tripRow === undefined) throw new Error('Expected a trip id');

  const stop = await db
    .insert(tripStops)
    .values({
      tripId: tripRow.id,
      orderId: orderRow.id,
      seq: 1,
      plannedArrival: ARRIVAL,
    })
    .returning({ id: tripStops.id });
  const stopRow = stop[0];
  if (stopRow === undefined) throw new Error('Expected a stop id');

  return {
    actorId: actorRow.id,
    orderId: orderRow.id,
    runId: runRow.id,
    tripId: tripRow.id,
    stopId: stopRow.id,
  };
}

describe('database constraints', () => {
  let db!: Database;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const adminUrl = databaseUrl();
    const testUrl = withDatabase(adminUrl, TEST_DATABASE);
    if (new URL(testUrl).pathname !== `/${TEST_DATABASE}`) {
      throw new Error('Refusing to migrate a database other than waypoint_test');
    }
    await recreateTestDatabase(adminUrl);
    const connection = createDatabase(testUrl, { onPoolError: () => undefined });
    db = connection.db;
    close = connection.close;
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
  });

  afterAll(async () => {
    await close?.();
  });

  beforeEach(async () => {
    await db.execute(sql.raw(`truncate table ${TABLES.join(', ')} restart identity cascade`));
  });

  it('creates the design tables and the seed_meta marker', async () => {
    const result = await db.execute<{ table_name: string }>(sql`
      select table_name
      from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
    `);
    expect(result.rows.map((row) => row.table_name).sort()).toEqual([...TABLES].sort());
  });

  it('stores windows as time and operational events as timestamptz', async () => {
    const result = await db.execute<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(sql`
      select table_name, column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and (
          (table_name = 'outlets' and column_name in ('window_open', 'window_close', 'mall_window_open'))
          or (table_name = 'stop_events' and column_name in ('client_time', 'server_time'))
          or (table_name = 'deferrals' and column_name = 'reason_code')
          or (table_name = 'pods' and column_name in ('signature', 'photo'))
          or (table_name = 'orders' and column_name = 'id')
          or (table_name = 'outlets' and column_name = 'id')
          or (table_name = 'trip_stops' and column_name = 'planned_arrival')
        )
    `);
    const types = new Map(
      result.rows.map((row) => [`${row.table_name}.${row.column_name}`, row] as const),
    );
    expect(types.get('outlets.window_open')).toMatchObject({
      data_type: 'time without time zone',
      is_nullable: 'NO',
    });
    expect(types.get('outlets.mall_window_open')).toMatchObject({
      data_type: 'time without time zone',
      is_nullable: 'YES',
    });
    expect(types.get('stop_events.client_time')?.data_type).toBe('timestamp with time zone');
    expect(types.get('stop_events.server_time')?.data_type).toBe('timestamp with time zone');
    expect(types.get('trip_stops.planned_arrival')?.data_type).toBe('timestamp with time zone');
    expect(types.get('deferrals.reason_code')).toMatchObject({
      data_type: 'USER-DEFINED',
      is_nullable: 'NO',
    });
    expect(types.get('pods.signature')).toMatchObject({ data_type: 'bytea', is_nullable: 'NO' });
    expect(types.get('pods.photo')).toMatchObject({ data_type: 'bytea', is_nullable: 'YES' });
    expect(types.get('orders.id')?.data_type).toBe('uuid');
    expect(types.get('outlets.id')?.data_type).toBe('text');
  });

  it('keeps dataset ids and generates uuidv7 operational ids', async () => {
    const fixture = await seed(db);
    expect(fixture.orderId).toMatch(UUID_V7);
    expect(fixture.tripId).toMatch(UUID_V7);
    const outlet = await db.select({ id: outlets.id }).from(outlets);
    const vehicle = await db.select({ id: vehicles.id }).from(vehicles);
    expect(outlet.map((row) => row.id)).toEqual(['OUT001']);
    expect(vehicle.map((row) => row.id)).toEqual(['VEH014']);
  });

  it('rejects an outlet or vehicle id that is not a dataset key', async () => {
    await db.insert(depots).values({ id: 'Peliyagoda', name: 'Peliyagoda' });
    await db.insert(districtTravel).values({
      district: 'Colombo',
      depotId: 'Peliyagoda',
      roadClass: 'urban',
      depotToDistrictKm: 1,
      depotToDistrictMin: 1,
      interStopKm: 1,
      interStopMin: 1,
    });
    await expectCode(
      () =>
        db.insert(outlets).values({
          id: 'OUT1',
          brand: 'Fresh',
          district: 'Colombo',
          depotId: 'Peliyagoda',
          dockType: 'street',
          parkingConstraint: 'normal',
          windowOpen: '05:00:00',
          windowClose: '08:00:00',
        }),
      '23514',
    );
    await expectCode(
      () =>
        db.insert(vehicles).values({
          id: 'VEH14',
          type: 'van',
          temp: 'ambient',
          weightCapKg: 1000,
          volumeCapM3: 4,
          fuelType: 'diesel',
          kmPerL: 10,
          weeklyFuelQuotaL: 100,
          depotId: 'Peliyagoda',
        }),
      '23514',
    );
  });

  it('rejects a delivery window that is inverted or only half set', async () => {
    await db.insert(depots).values({ id: 'Peliyagoda', name: 'Peliyagoda' });
    await db.insert(districtTravel).values({
      district: 'Colombo',
      depotId: 'Peliyagoda',
      roadClass: 'urban',
      depotToDistrictKm: 1,
      depotToDistrictMin: 1,
      interStopKm: 1,
      interStopMin: 1,
    });
    const base = {
      id: 'OUT001',
      brand: 'Fresh' as const,
      district: 'Colombo',
      depotId: 'Peliyagoda',
      dockType: 'street' as const,
      parkingConstraint: 'normal' as const,
    };
    await expectCode(
      () =>
        db.insert(outlets).values({
          ...base,
          windowOpen: '08:00:00',
          windowClose: '05:00:00',
        }),
      '23514',
    );
    await expectCode(
      () =>
        db.insert(outlets).values({
          ...base,
          id: 'OUT002',
          windowOpen: '05:00:00',
          windowClose: '08:00:00',
          mallWindowOpen: '09:00:00',
        }),
      '23514',
    );
  });

  it('enforces one order per stop, one trip number per vehicle, and trip numbers 1 or 2', async () => {
    const fixture = await seed(db);
    const second = await db
      .insert(orders)
      .values({
        outletId: 'OUT001',
        brand: 'Fresh',
        temp: 'ambient',
        requestedDate: '2026-10-03',
        units: 1,
        weightKg: 2,
        volumeM3: 0.1,
      })
      .returning({ id: orders.id });
    const secondOrder = second[0];
    if (secondOrder === undefined) throw new Error('Expected a second order');

    await expectCode(
      () =>
        db.insert(tripStops).values({
          tripId: fixture.tripId,
          orderId: fixture.orderId,
          seq: 2,
          plannedArrival: ARRIVAL,
        }),
      '23505',
    );

    await db.insert(trips).values({
      runId: fixture.runId,
      vehicleId: 'VEH014',
      tripNo: 2,
      brand: 'Fresh',
      district: 'Colombo',
      plannedMinutes: 30,
      plannedKm: 12,
    });
    await expectCode(
      () =>
        db.insert(trips).values({
          runId: fixture.runId,
          vehicleId: 'VEH014',
          tripNo: 1,
          brand: 'Fresh',
          district: 'Colombo',
          plannedMinutes: 10,
          plannedKm: 4,
        }),
      '23505',
    );
    await expectCode(
      () =>
        db.insert(trips).values({
          runId: fixture.runId,
          vehicleId: 'VEH014',
          tripNo: 3,
          brand: 'Fresh',
          district: 'Colombo',
          plannedMinutes: 10,
          plannedKm: 4,
        }),
      '23514',
    );

    await expectCode(
      () =>
        db.insert(tripStops).values({
          tripId: fixture.tripId,
          orderId: secondOrder.id,
          seq: 1,
          plannedArrival: ARRIVAL,
        }),
      '23505',
    );
  });

  it('accepts a chilled order for the Fresh brand only', async () => {
    await seed(db);
    const chilled = (brand: 'Fresh' | 'Style' | 'Tech') =>
      db.insert(orders).values({
        outletId: 'OUT001',
        brand,
        temp: 'chilled',
        requestedDate: '2026-10-03',
        units: 1,
        weightKg: 2,
        volumeM3: 0.1,
      });
    // BR-020. PostgreSQL 23514 is a check violation.
    await expectCode(() => chilled('Style'), '23514');
    await expectCode(() => chilled('Tech'), '23514');
    await chilled('Fresh');
  });

  it('makes stop sync idempotent and requires a deferral reason', async () => {
    const fixture = await seed(db);
    const clientEventId = '018f3b2e-7c1a-7b2c-8d3e-4f5a6b7c8d9e';
    await db.insert(stopEvents).values({
      clientEventId,
      stopId: fixture.stopId,
      type: 'arrived',
      payload: {},
      clientTime: ARRIVAL,
      serverTime: ARRIVAL,
      tripVersion: 1,
    });
    await expectCode(
      () =>
        db.insert(stopEvents).values({
          clientEventId,
          stopId: fixture.stopId,
          type: 'arrived',
          payload: {},
          clientTime: ARRIVAL,
          serverTime: ARRIVAL,
          tripVersion: 1,
        }),
      '23505',
    );

    await db.insert(deferrals).values({
      orderId: fixture.orderId,
      runId: fixture.runId,
      reasonCode: 'WEIGHT_CAP',
      type: 'unavoidable',
      actorId: fixture.actorId,
    });
    await expectCode(
      () =>
        db.execute(sql`
          insert into deferrals (order_id, run_id, type, actor_id)
          values (
            ${fixture.orderId}::uuid,
            ${fixture.runId}::uuid,
            'prioritized',
            ${fixture.actorId}::uuid
          )
        `),
      '23502',
    );
  });

  it('rejects foreign keys and role scopes that do not match the model', async () => {
    const fixture = await seed(db);
    await expectCode(
      () =>
        db.insert(orders).values({
          outletId: 'OUT999',
          brand: 'Fresh',
          temp: 'ambient',
          requestedDate: '2026-10-03',
          units: 1,
          weightKg: 1,
          volumeM3: 0.1,
        }),
      '23503',
    );
    await expectCode(
      () =>
        db.insert(users).values({
          name: 'Loader',
          email: 'loader@example.com',
          passwordHash: 'hash',
          role: 'loader',
        }),
      '23514',
    );
    await expectCode(
      () =>
        db.insert(users).values({
          name: 'Driver',
          email: 'driver@example.com',
          passwordHash: 'hash',
          role: 'driver',
          vehicleId: 'VEH014',
          depotId: 'Peliyagoda',
        }),
      '23514',
    );
    await db.insert(users).values({
      name: 'Store',
      email: 'store@example.com',
      passwordHash: 'hash',
      role: 'store_manager',
      outletId: 'OUT001',
    });
    expect(fixture.actorId).toMatch(UUID_V7);
  });

  it('keeps the audit log append-only', async () => {
    const fixture = await seed(db);
    const inserted = await db
      .insert(auditLog)
      .values({
        actorId: fixture.actorId,
        role: 'dispatcher',
        action: 'order.lock',
        entityType: 'order',
        entityId: fixture.orderId,
        after: { status: 'confirmed' },
      })
      .returning({ id: auditLog.id });
    const row = inserted[0];
    if (row === undefined) throw new Error('Expected an audit row');

    await expectCode(
      () => db.update(auditLog).set({ action: 'order.edit' }).where(eq(auditLog.id, row.id)),
      'P0001',
    );
    await expectCode(() => db.delete(auditLog).where(eq(auditLog.id, row.id)), 'P0001');
  });
});
