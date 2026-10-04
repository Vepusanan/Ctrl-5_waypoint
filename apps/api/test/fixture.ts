import { randomBytes } from 'node:crypto';
import type { Database } from '@waypoint/database';
import {
  depots,
  districtTravel,
  orders,
  outlets,
  planningRuns,
  tripStops,
  trips,
  users,
  vehicles,
} from '@waypoint/database';
import { argon2id } from 'hash-wasm';

const DEMO_PASSWORD = 'waypoint-demo';

export interface AuthFixture {
  password: string;
  emails: {
    dispatcher: string;
    central: string;
    loader: string;
    driver: string;
    storeManager: string;
  };
  orders: { home: string; sibling: string; otherDepot: string };
  trips: { home: string; otherDepot: string };
}

async function hashPassword(password: string): Promise<string> {
  return argon2id({
    password,
    salt: randomBytes(16),
    parallelism: 1,
    iterations: 2,
    memorySize: 19_456,
    hashLength: 32,
    outputType: 'encoded',
  });
}

function first<T>(rows: T[], label: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`Expected ${label}`);
  return row;
}

export async function seedAuthFixture(db: Database): Promise<AuthFixture> {
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  await db.insert(depots).values([
    { id: 'Peliyagoda', name: 'Peliyagoda' },
    { id: 'Kandy', name: 'Kandy' },
  ]);
  await db.insert(districtTravel).values([
    {
      district: 'Colombo',
      depotId: 'Peliyagoda',
      roadClass: 'urban',
      depotToDistrictKm: 12,
      depotToDistrictMin: 24,
      interStopKm: 4,
      interStopMin: 8,
    },
    {
      district: 'Kandy',
      depotId: 'Kandy',
      roadClass: 'hill',
      depotToDistrictKm: 6,
      depotToDistrictMin: 15,
      interStopKm: 2,
      interStopMin: 6,
    },
  ]);
  await db
    .insert(outlets)
    .values([
      outlet('OUT002', 'Colombo', 'Peliyagoda'),
      outlet('OUT003', 'Colombo', 'Peliyagoda'),
      outlet('OUT011', 'Kandy', 'Kandy'),
    ]);
  await db.insert(vehicles).values([vehicle('VEH001', 'Peliyagoda'), vehicle('VEH008', 'Kandy')]);

  const emails = {
    dispatcher: 'dispatcher@waypoint.test',
    central: 'central.dispatcher@waypoint.test',
    loader: 'loader@waypoint.test',
    driver: 'driver@waypoint.test',
    storeManager: 'store.manager@waypoint.test',
  };
  await db.insert(users).values([
    account('Peliyagoda Dispatcher', emails.dispatcher, passwordHash, {
      role: 'dispatcher',
      depotId: 'Peliyagoda',
    }),
    account('Central Dispatcher', emails.central, passwordHash, {
      role: 'dispatcher',
      depotId: null,
    }),
    account('Peliyagoda Loader', emails.loader, passwordHash, {
      role: 'loader',
      depotId: 'Peliyagoda',
    }),
    account('Van Driver', emails.driver, passwordHash, { role: 'driver', vehicleId: 'VEH001' }),
    account('Store Manager', emails.storeManager, passwordHash, {
      role: 'store_manager',
      outletId: 'OUT002',
    }),
  ]);

  const homeOrder = first(
    await db.insert(orders).values(order('OUT002')).returning({ id: orders.id }),
    'home order',
  );
  const siblingOrder = first(
    await db.insert(orders).values(order('OUT003')).returning({ id: orders.id }),
    'sibling order',
  );
  const otherOrder = first(
    await db.insert(orders).values(order('OUT011')).returning({ id: orders.id }),
    'other depot order',
  );

  const homeRun = first(
    await db
      .insert(planningRuns)
      .values({ depotId: 'Peliyagoda', serviceDate: '2026-10-03' })
      .returning({ id: planningRuns.id }),
    'home run',
  );
  const otherRun = first(
    await db
      .insert(planningRuns)
      .values({ depotId: 'Kandy', serviceDate: '2026-10-03' })
      .returning({ id: planningRuns.id }),
    'other run',
  );
  const homeTrip = first(
    await db
      .insert(trips)
      .values(trip(homeRun.id, 'VEH001', 'Colombo'))
      .returning({ id: trips.id }),
    'home trip',
  );
  const otherTrip = first(
    await db
      .insert(trips)
      .values(trip(otherRun.id, 'VEH008', 'Kandy'))
      .returning({ id: trips.id }),
    'other trip',
  );
  await db
    .insert(tripStops)
    .values([stop(homeTrip.id, homeOrder.id), stop(otherTrip.id, otherOrder.id)]);

  return {
    password: DEMO_PASSWORD,
    emails,
    orders: { home: homeOrder.id, sibling: siblingOrder.id, otherDepot: otherOrder.id },
    trips: { home: homeTrip.id, otherDepot: otherTrip.id },
  };
}

function outlet(id: string, district: string, depotId: string) {
  return {
    id,
    brand: 'Fresh' as const,
    district,
    depotId,
    dockType: 'street' as const,
    parkingConstraint: 'normal' as const,
    windowOpen: '05:00:00',
    windowClose: '08:00:00',
  };
}

function vehicle(id: string, depotId: string) {
  return {
    id,
    type: 'van' as const,
    temp: 'reefer' as const,
    weightCapKg: 1500,
    volumeCapM3: 8,
    fuelType: 'diesel',
    kmPerL: 10.5,
    weeklyFuelQuotaL: 200,
    depotId,
  };
}

function account(
  name: string,
  email: string,
  passwordHash: string,
  scope:
    | { role: 'dispatcher'; depotId: string | null }
    | { role: 'loader'; depotId: string }
    | {
        role: 'driver';
        vehicleId: string;
      }
    | { role: 'store_manager'; outletId: string },
) {
  return { name, email, passwordHash, ...scope };
}

function order(outletId: string) {
  return {
    outletId,
    brand: 'Fresh' as const,
    temp: 'ambient' as const,
    requestedDate: '2026-10-03',
    units: 4,
    weightKg: 12.5,
    volumeM3: 0.4,
    status: 'confirmed' as const,
  };
}

function trip(runId: string, vehicleId: string, district: string) {
  return {
    runId,
    vehicleId,
    tripNo: 1 as const,
    brand: 'Fresh' as const,
    district,
    // Loader and driver only see trips once the plan is published.
    status: 'published' as const,
    plannedMinutes: 40,
    plannedKm: 16,
  };
}

function stop(tripId: string, orderId: string) {
  return {
    tripId,
    orderId,
    seq: 1,
    plannedArrival: new Date('2026-10-03T03:30:00.000+05:30'),
  };
}
