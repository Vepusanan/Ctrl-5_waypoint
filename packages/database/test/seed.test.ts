import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/client.ts';
import { loadDatabaseEnv } from '../src/env.ts';
import { auditLog } from '../src/schema/cross-cutting.ts';
import { users } from '../src/schema/identity.ts';
import { orders } from '../src/schema/orders.ts';
import { planningRuns } from '../src/schema/planning.ts';
import { outlets } from '../src/schema/reference.ts';
import { seedMeta } from '../src/schema/seed-meta.ts';
import { DEMO_SERVICE_DATE } from '../src/seed/constants.ts';
import { parseCsv } from '../src/seed/csv.ts';
import { loadReference, referenceRoots } from '../src/seed/load-reference.ts';
import { verifySeedPassword } from '../src/seed/password.ts';
import { seedDatabase } from '../src/seed/run.ts';
import { syntheticReference } from '../src/seed/synthetic.ts';

const TEST_DATABASE = 'waypoint_test';

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

describe('csv reference import', () => {
  it('reads a fixture directory and ignores a directory with no challenge files', async () => {
    const root = path.join(tmpdir(), `waypoint-seed-${Date.now()}`);
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, 'outlets.csv'),
      [
        'outlet_id,brand,district,depot,dock_type,parking_constraint,mall_window,window_open_time,window_close_time',
        'OUT002,Fresh,Colombo,Peliyagoda,rear_dock,normal,,05:00,08:00',
        'OUT009,Style,Colombo,Peliyagoda,mall_bay,mall_dock,09:00-11:00,09:00,11:00',
        'OUT001,Fresh,Colombo,Peliyagoda,street,van_only,,05:00,08:00',
        'OUT011,Fresh,Kandy,Kandy,street,normal,,05:00,08:00',
      ].join('\n'),
    );
    await writeFile(
      path.join(root, 'vehicles.csv'),
      [
        'vehicle_id,type,temp,weight_cap_kg,volume_cap_m3,fuel_type,km_per_l,weekly_fuel_quota_l,depot',
        'VEH005,van,ambient,1400,11,diesel,11,180,Peliyagoda',
        'VEH001,van,reefer,1200,10,diesel,11,180,Peliyagoda',
        'VEH002,truck,reefer,4000,20,diesel,5,400,Peliyagoda',
      ].join('\n'),
    );
    await writeFile(
      path.join(root, 'calendar.csv'),
      [
        'date,dow,dow_name,is_weekend,iso_year,iso_week,is_payday,festival,festival_ramp,is_holiday,monsoon,is_operating',
        '2026-06-25,3,Thu,0,2026,26,0,,0.0,0,0,1',
        '2026-06-26,4,Fri,0,2026,26,0,,0.0,0,0,1',
      ].join('\n'),
    );
    await writeFile(
      path.join(root, 'district_travel.csv'),
      [
        'district,depot,road_class,free_flow_kmh,depot_to_district_km,depot_to_district_freeflow_min,inter_stop_km,inter_stop_freeflow_min',
        'Colombo,Peliyagoda,urban,30,10,20,3,7',
        'Kandy,Kandy,hill,40,6,15,2,6',
      ].join('\n'),
    );
    await writeFile(
      path.join(root, 'service_allowance.csv'),
      [
        'brand,dock_type,service_allowance_min',
        'Fresh,rear_dock,12',
        'Fresh,street,14',
        'Fresh,mall_bay,20',
        'Style,rear_dock,22',
        'Style,street,28',
        'Style,mall_bay,36',
        'Tech,rear_dock,24',
        'Tech,street,32',
        'Tech,mall_bay,40',
      ].join('\n'),
    );
    await writeFile(
      path.join(root, 'deliveries_train.csv'),
      [
        'brand,temp_requirement,order_units,order_weight_kg,order_volume_m3',
        'Fresh,ambient,10,30,0.7',
        'Fresh,chilled,14,2000,12',
        'Style,ambient,6,22,1.4',
      ].join('\n'),
    );

    const loaded = await loadReference([path.join(root, 'missing'), root]);
    expect(loaded.source).toBe('dataset');
    expect(loaded.outlets).toHaveLength(4);
    expect(loaded.outlets.find((outlet) => outlet.id === 'OUT009')?.mallWindowOpen).toBe(
      '09:00:00',
    );
    expect(loaded.outlets.find((outlet) => outlet.id === 'OUT002')?.mallWindowOpen).toBeNull();
    expect(loaded.depots.map((depot) => depot.id).sort()).toEqual(['Kandy', 'Peliyagoda']);
    expect(loaded.orderSizes).toHaveLength(3);
    expect(loaded.calendarDays.every((day) => day.isOperating)).toBe(true);

    const empty = await loadReference([path.join(root, 'missing')]);
    expect(empty.source).toBe('synthetic');
    expect(parseCsv('a,b\n1,2\n').map((row) => row.a)).toEqual(['1']);
  });

  it('searches DATA_DIR, the working directory, then the repository data folder', () => {
    const roots = referenceRoots('/data', '/tmp/waypoint-app');
    expect(roots.slice(0, 2)).toEqual(['/data', path.resolve('/tmp/waypoint-app/data')]);
    expect(roots.at(-1)?.endsWith(`${path.sep}data`)).toBe(true);
    expect(new Set(roots).size).toBe(roots.length);
  });
});

describe('database seed', () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const adminUrl = databaseUrl();
    const url = new URL(adminUrl);
    url.pathname = `/${TEST_DATABASE}`;
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
        [TEST_DATABASE],
      );
      await client.query(`drop database if exists ${TEST_DATABASE}`);
      await client.query(`create database ${TEST_DATABASE}`);
    } finally {
      await client.end();
    }
    const connection = createDatabase(url.toString(), { onPoolError: () => undefined });
    db = connection.db;
    close = connection.close;
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
  });

  afterAll(async () => {
    await close?.();
  });

  it('restores a dataset seed on a host that does not have the CSVs', async () => {
    // Stands in for the dataset: the hosted container is seeded from it but never holds the files.
    const dataset = {
      ...syntheticReference,
      source: 'dataset' as const,
      outlets: syntheticReference.outlets.map((outlet, index) =>
        index === 0 ? { ...outlet, windowClose: '09:45:00' } : outlet,
      ),
    };
    const seeded = await seedDatabase(db, {
      reset: true,
      password: 'waypoint-demo',
      reference: dataset,
      demoDate: DEMO_SERVICE_DATE,
    });
    expect(seeded.source).toBe('dataset');
    const snapshot = async () => ({
      orders: (await db.select().from(orders)).sort((a, b) => a.id.localeCompare(b.id)),
      outlets: (await db.select().from(outlets)).sort((a, b) => a.id.localeCompare(b.id)),
      users: (await db.select({ id: users.id, email: users.email }).from(users)).sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
      runs: (await db.select().from(planningRuns)).sort((a, b) => a.id.localeCompare(b.id)),
      meta: (await db.select().from(seedMeta)).map((row) => [row.serviceDate, row.source]),
    });
    const before = await snapshot();

    // A demo ran: orders moved on.
    await db.update(orders).set({ status: 'cancelled' });

    const nowhere = path.join(tmpdir(), `waypoint-no-data-${Date.now()}`);
    for (let round = 0; round < 2; round += 1) {
      const reset = await seedDatabase(db, {
        reset: true,
        password: 'waypoint-demo',
        roots: [nowhere],
      });
      expect(reset).toMatchObject({ applied: true, source: 'dataset' });
      expect(reset.serviceDate).toBe(DEMO_SERVICE_DATE);
      expect(await snapshot()).toEqual(before);
    }
  });

  it('refuses to replace a dataset seed that kept no baseline with the synthetic fixture', async () => {
    // The audit log is append-only, so a database seeded before baselines existed is modelled
    // by emptying it.
    await db.execute(sql`truncate table audit_log`);
    const before = await db.select().from(orders);
    await expect(
      seedDatabase(db, {
        reset: true,
        password: 'waypoint-demo',
        roots: [path.join(tmpdir(), `waypoint-no-data-${Date.now()}`)],
      }),
    ).rejects.toThrow(/pnpm db:seed --reset/);
    expect(await db.select().from(orders)).toHaveLength(before.length);
    expect((await db.select().from(seedMeta))[0]?.source).toBe('dataset');
  });

  it('is idempotent, and a reset restores the same operational ids', async () => {
    const first = await seedDatabase(db, {
      reset: true,
      password: 'waypoint-demo',
      reference: syntheticReference,
      demoDate: DEMO_SERVICE_DATE,
    });
    expect(first.applied).toBe(true);
    expect(first.serviceDate).toBe(DEMO_SERVICE_DATE);
    expect(first.source).toBe('synthetic');
    expect(first.accounts.length).toBeGreaterThanOrEqual(4);

    const before = await db.select().from(orders);
    const second = await seedDatabase(db, {
      password: 'waypoint-demo',
      reference: syntheticReference,
    });
    expect(second.applied).toBe(false);
    expect(await db.select().from(orders)).toHaveLength(before.length);
    expect(await db.select().from(seedMeta)).toHaveLength(1);

    const reset = await seedDatabase(db, {
      reset: true,
      password: 'waypoint-demo',
      reference: syntheticReference,
      demoDate: DEMO_SERVICE_DATE,
    });
    expect(reset.applied).toBe(true);
    const after = await db.select().from(orders);
    expect(after.map((order) => `${order.id}:${order.status}:${order.outletId}`).sort()).toEqual(
      before.map((order) => `${order.id}:${order.status}:${order.outletId}`).sort(),
    );

    // No baseline is kept for a synthetic seed: a reset rebuilds it from the fixture.
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, 'seed.baseline')),
    ).toHaveLength(0);

    const dispatcher = await db
      .select()
      .from(users)
      .where(eq(users.email, 'dispatcher@waypoint.test'));
    const row = dispatcher[0];
    expect(row?.role).toBe('dispatcher');
    await expect(verifySeedPassword('waypoint-demo', row?.passwordHash ?? '')).resolves.toBe(true);
  });
});
