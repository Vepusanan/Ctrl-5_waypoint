import { and, desc, eq, sql } from 'drizzle-orm';
import { addCalendarDays, CALENDAR_HORIZON_DAYS, withCalendarHorizon } from '../calendar.ts';
import type { Database } from '../client.ts';
import { auditLog } from '../schema/cross-cutting.ts';
import { users } from '../schema/identity.ts';
import { orders } from '../schema/orders.ts';
import { deferrals, planningRuns } from '../schema/planning.ts';
import {
  calendarDays,
  demandHistory,
  depots,
  districtTravel,
  outlets,
  serviceAllowances,
  vehicleAvailability,
  vehicles,
} from '../schema/reference.ts';
import { seedMeta } from '../schema/seed-meta.ts';
import { RNG_SEED, SEED_META_ID, SEED_VERSION } from './constants.ts';
import { buildDemoDay, type DemoDay, resolveServiceDate } from './demo-day.ts';
import { seedUuid } from './ids.ts';
import { loadReference, referenceRoots } from './load-reference.ts';
import { hashSeedPassword } from './password.ts';
import type { ReferenceData } from './types.ts';

const SEEDED_TABLES = [
  'demand_history',
  'saved_views',
  'loading_counts',
  'sync_conflicts',
  'audit_log',
  'notifications',
  'issues',
  'receipts',
  'pods',
  'stop_events',
  'loading_issues',
  'loading_records',
  'fuel_ledger',
  'deferrals',
  'trip_stops',
  'trips',
  'planning_runs',
  'orders',
  'sessions',
  'vehicle_availability',
  'users',
  'service_allowances',
  'outlets',
  'district_travel',
  'vehicles',
  'calendar_days',
  'depots',
  'seed_meta',
] as const;

interface SeedAccountReport {
  role: string;
  name: string;
  email: string;
  scope: string;
}

export interface SeedResult {
  applied: boolean;
  serviceDate: string;
  source: 'dataset' | 'synthetic';
  password: string;
  accounts: SeedAccountReport[];
}

export interface SeedOptions {
  reset?: boolean;
  dataDir?: string;
  cwd?: string;
  demoDate?: string;
  password: string;
  reference?: ReferenceData;
  /** Folders searched for the source CSVs, in place of DATA_DIR and the repository data folder. */
  roots?: readonly string[];
}

export async function seedDatabase(db: Database, options: SeedOptions): Promise<SeedResult> {
  if (options.reset !== true) {
    const existing = await db.select().from(seedMeta).where(eq(seedMeta.id, SEED_META_ID));
    const row = existing[0];
    if (row !== undefined) {
      return {
        applied: false,
        serviceDate: row.serviceDate,
        source: row.source === 'synthetic' ? 'synthetic' : 'dataset',
        password: options.password,
        accounts: await accountReports(db),
      };
    }
  }

  const loaded =
    options.reference ??
    (await loadReference(
      options.roots ?? referenceRoots(options.dataDir, options.cwd ?? process.cwd()),
    ));
  // A host without the source CSVs (the hosted container) must not turn a database seeded from
  // the dataset into the synthetic fixture on reset. It restores the day that seed stored.
  const kept =
    options.reference === undefined && options.reset === true && loaded.source === 'synthetic'
      ? await datasetBaseline(db)
      : null;
  const { reference, day } = kept ?? freshSeed(loaded, options.demoDate);
  const passwordHash = await hashSeedPassword(options.password);

  const applied = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${RNG_SEED})`);
    const existing = await tx.select().from(seedMeta).where(eq(seedMeta.id, SEED_META_ID));
    if (existing[0] !== undefined && options.reset !== true) return false;
    await tx.execute(
      sql.raw(`truncate table ${SEEDED_TABLES.join(', ')} restart identity cascade`),
    );
    await tx.insert(depots).values(reference.depots);
    await tx.insert(districtTravel).values(reference.districtTravel);
    await tx.insert(outlets).values(reference.outlets);
    await tx.insert(vehicles).values(reference.vehicles);
    for (let start = 0; start < reference.calendarDays.length; start += 500) {
      await tx.insert(calendarDays).values(reference.calendarDays.slice(start, start + 500));
    }
    await tx.insert(serviceAllowances).values(reference.serviceAllowances);
    for (let start = 0; start < reference.demandHistory.length; start += 1000) {
      await tx.insert(demandHistory).values(reference.demandHistory.slice(start, start + 1000));
    }
    await tx.insert(users).values(
      day.accounts.map((account) => ({
        id: seedUuid(account.key),
        name: account.name,
        email: account.email,
        passwordHash,
        role: account.role,
        depotId: account.depotId ?? null,
        outletId: account.outletId ?? null,
        vehicleId: account.vehicleId ?? null,
      })),
    );
    await tx.insert(vehicleAvailability).values(day.vehicleAvailability);
    await tx.insert(orders).values(day.orders);
    await tx.insert(planningRuns).values(day.planningRuns);
    await tx.insert(deferrals).values(day.deferral);
    await tx.insert(auditLog).values(day.audit);
    if (reference.source === 'dataset') {
      await tx.insert(auditLog).values({
        actorId: day.audit.actorId,
        role: day.audit.role,
        action: BASELINE_ACTION,
        entityType: 'seed',
        entityId: 'waypoint',
        after: JSON.parse(JSON.stringify(day)),
        createdAt: day.audit.createdAt,
      });
    }
    await tx.insert(seedMeta).values({
      id: SEED_META_ID,
      seedVersion: SEED_VERSION,
      serviceDate: day.serviceDate,
      source: reference.source,
      rngSeed: RNG_SEED,
      seededAt: day.audit.createdAt,
    });
    return true;
  });

  if (!applied) {
    const existing = await db.select().from(seedMeta).where(eq(seedMeta.id, SEED_META_ID));
    const row = existing[0];
    if (row === undefined) throw new Error('Seed disappeared during insert');
    return {
      applied: false,
      serviceDate: row.serviceDate,
      source: row.source === 'synthetic' ? 'synthetic' : 'dataset',
      password: options.password,
      accounts: await accountReports(db),
    };
  }

  return {
    applied: true,
    serviceDate: day.serviceDate,
    source: reference.source,
    password: options.password,
    accounts: day.accounts.map((account) => ({
      role: account.role,
      name: account.name,
      email: account.email,
      scope: scopeLabel(account),
    })),
  };
}

function freshSeed(
  loaded: ReferenceData,
  demoDate: string | undefined,
): { reference: ReferenceData; day: DemoDay } {
  // The demo day may sit at, or past, the end of the supplied calendar. Days after it are
  // generated, so there is always a next run to order for.
  const lastLoaded = loaded.calendarDays.reduce(
    (latest, day) => (day.date > latest ? day.date : latest),
    '',
  );
  const anchor = [lastLoaded, demoDate ?? ''].sort().at(-1) ?? lastLoaded;
  const reference = {
    ...loaded,
    calendarDays: withCalendarHorizon(
      loaded.calendarDays,
      addCalendarDays(anchor, CALENDAR_HORIZON_DAYS),
    ),
  };
  const serviceDate = resolveServiceDate(reference.calendarDays, demoDate);
  return { reference, day: buildDemoDay(reference, serviceDate) };
}

// The seeded demo day, kept beside a dataset seed so a reset can rebuild it without the CSVs.
const BASELINE_ACTION = 'seed.baseline';
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * The dataset-seeded day read back from this database: reference tables as they are, and the
 * demo day the seed stored. Null when the database was not seeded from the dataset, so the
 * synthetic fixture applies as before.
 */
async function datasetBaseline(
  db: Database,
): Promise<{ reference: ReferenceData; day: DemoDay } | null> {
  const [meta] = await db.select().from(seedMeta).where(eq(seedMeta.id, SEED_META_ID));
  if (meta?.source !== 'dataset') return null;
  const [stored] = await db
    .select({ after: auditLog.after })
    .from(auditLog)
    .where(and(eq(auditLog.action, BASELINE_ACTION), eq(auditLog.entityType, 'seed')))
    .orderBy(desc(auditLog.id))
    .limit(1);
  if (stored?.after == null) {
    throw new Error(
      'This database was seeded from the dataset before resets could run without it. Seed it once more from a machine that has the CSVs: pnpm db:seed --reset',
    );
  }
  // JSON turned the timestamps into strings; date-only columns stay strings.
  const day = JSON.parse(JSON.stringify(stored.after), (_key, value) =>
    typeof value === 'string' && TIMESTAMP.test(value) ? new Date(value) : value,
  ) as DemoDay;
  return {
    day,
    reference: {
      source: 'dataset',
      depots: await db.select().from(depots),
      outlets: await db.select().from(outlets),
      vehicles: await db.select().from(vehicles),
      calendarDays: await db.select().from(calendarDays),
      districtTravel: await db.select().from(districtTravel),
      serviceAllowances: await db.select().from(serviceAllowances),
      demandHistory: await db.select().from(demandHistory),
      // Only the generator reads order sizes, and the stored day replaces it.
      orderSizes: [],
    },
  };
}

async function accountReports(db: Database): Promise<SeedAccountReport[]> {
  const rows = await db.select().from(users);
  return rows
    .sort((left, right) => left.email.localeCompare(right.email))
    .map((row) => ({
      role: row.role,
      name: row.name,
      email: row.email,
      scope: scopeLabel(row),
    }));
}

function scopeLabel(account: {
  depotId?: string | null;
  vehicleId?: string | null;
  outletId?: string | null;
}): string {
  if (account.outletId != null && account.outletId.length > 0) return `outlet ${account.outletId}`;
  if (account.vehicleId != null && account.vehicleId.length > 0) {
    return `vehicle ${account.vehicleId}`;
  }
  if (account.depotId != null && account.depotId.length > 0) return `depot ${account.depotId}`;
  return 'unscoped';
}
