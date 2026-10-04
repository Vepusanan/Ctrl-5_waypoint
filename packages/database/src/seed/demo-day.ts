import type { Brand, OrderStatus, Role, TemperatureRequirement } from '@waypoint/shared';
import { DEMO_SERVICE_DATE, DEMO_USERS, HOME_DEPOT_ID, RNG_SEED } from './constants.ts';
import { colombo, previousCalendarDate, seedUuid } from './ids.ts';
import { createRng } from './rng.ts';
import type {
  CalendarDayRecord,
  OrderSizeRecord,
  OutletRecord,
  ReferenceData,
  VehicleRecord,
} from './types.ts';

interface DemoAccount {
  key: string;
  role: Role;
  name: string;
  email: string;
  depotId?: string;
  vehicleId?: string;
  outletId?: string;
}

interface DemoOrder {
  id: string;
  outletId: string;
  brand: Brand;
  temp: TemperatureRequirement;
  requestedDate: string;
  units: number;
  weightKg: number;
  volumeM3: number;
  status: OrderStatus;
  submittedAt: Date | null;
  lockedAt: Date | null;
  version: number;
}

export interface DemoDay {
  serviceDate: string;
  previousOperatingDate: string;
  homeDepotId: string;
  accounts: DemoAccount[];
  vehicleAvailability: { vehicleId: string; date: string; status: 'available' | 'in_workshop' }[];
  orders: DemoOrder[];
  planningRuns: {
    id: string;
    depotId: string;
    serviceDate: string;
    status: 'open' | 'published';
    publishedAt: Date | null;
    publishedBy: string | null;
    planVersion: number;
  }[];
  deferral: {
    id: string;
    orderId: string;
    runId: string;
    reasonCode: 'VOLUME_CAP';
    type: 'unavoidable';
    note: string;
    actorId: string;
    createdAt: Date;
  };
  audit: {
    id: string;
    actorId: string;
    role: 'dispatcher';
    action: string;
    entityType: string;
    entityId: string;
    after: Record<string, unknown>;
    createdAt: Date;
  };
}

export function buildDemoDay(reference: ReferenceData, serviceDate: string): DemoDay {
  const home = HOME_DEPOT_ID;
  const fresh = reference.outlets
    .filter((outlet) => outlet.depotId === home && outlet.brand === 'Fresh')
    .sort(byId);
  const driverVan = reference.vehicles
    .filter((vehicle) => vehicle.depotId === home && vehicle.type === 'van')
    .sort(byId)[0];
  const vanOnlyFresh = fresh.find((outlet) => outlet.parkingConstraint === 'van_only');
  // The four demo accounts must be able to finish one order end to end. A chilled order for a
  // van_only outlet can only ride the one reefer van kept available, which is the driver's, so
  // the store manager gets that outlet whenever the reference data has one.
  const linked = vanOnlyFresh !== undefined && driverVan?.temp === 'reefer';
  const store = linked
    ? vanOnlyFresh
    : fresh.find((outlet) => outlet.parkingConstraint === 'normal');
  const vanOnly =
    vanOnlyFresh ??
    reference.outlets
      .filter((outlet) => outlet.depotId === home && outlet.parkingConstraint === 'van_only')
      .sort(byId)[0];
  const styleMall = reference.outlets
    .filter(
      (outlet) =>
        outlet.depotId === home && outlet.brand === 'Style' && outlet.mallWindowOpen !== null,
    )
    .sort(byId)[0];
  if (
    store === undefined ||
    vanOnly === undefined ||
    styleMall === undefined ||
    driverVan === undefined
  ) {
    throw new Error(
      `Reference data at ${home} needs a Fresh outlet, a van_only outlet, a Style mall outlet, and a van`,
    );
  }
  if (fresh.length === 0) throw new Error(`No Fresh outlets at ${home}`);

  const previousOperatingDate = previousOperatingDay(reference.calendarDays, serviceDate);
  const lockDate = previousCalendarDate(serviceDate);
  const lockedAt = colombo(lockDate, '16:00:00');
  const submittedAt = colombo(lockDate, '15:00:00');
  const editableSubmittedAt = colombo(lockDate, '14:00:00');
  const rng = createRng(RNG_SEED);

  const deferredOutlet =
    fresh.find((outlet) => outlet.id !== store.id && outlet.id !== vanOnly.id) ?? store;
  const orders: DemoOrder[] = [];
  const storeTemp = linked ? 'chilled' : 'ambient';

  // The API allows one active order per outlet, date and temperature, so the seed keeps every
  // slot distinct. The store manager's own outlet holds the walkthrough's moves: one order for
  // this run is still open at the 15:50 demo start and is confirmed at the 4 PM cutoff, and the
  // other temperature's slot is left free for the order the walkthrough places. The open order
  // is the chilled one when the outlet is tied to the driver's reefer van.
  for (const outlet of fresh) {
    if (outlet.id === store.id) {
      orders.push(
        orderRow(
          `order:${serviceDate}:submitted:${outlet.id}`,
          outlet,
          storeTemp,
          serviceDate,
          pickSize(reference.orderSizes, 'Fresh', storeTemp, rng),
          'submitted',
          editableSubmittedAt,
          null,
          1,
        ),
      );
      continue;
    }
    orders.push(
      confirmedOrder(
        `order:${serviceDate}:ambient:${outlet.id}`,
        outlet,
        'ambient',
        serviceDate,
        reference,
        rng,
        submittedAt,
        lockedAt,
      ),
    );
  }
  if (vanOnly.id !== store.id) {
    orders.push(
      confirmedOrder(
        `order:${serviceDate}:chilled:${vanOnly.id}`,
        vanOnly,
        'chilled',
        serviceDate,
        reference,
        rng,
        submittedAt,
        lockedAt,
      ),
    );
  }
  const deferred = orderRow(
    `order:${serviceDate}:deferred:${deferredOutlet.id}`,
    deferredOutlet,
    'chilled',
    serviceDate,
    pickSize(reference.orderSizes, 'Fresh', 'chilled', rng),
    'deferred',
    submittedAt,
    lockedAt,
    1,
  );
  orders.push(deferred);
  orders.push(
    confirmedOrder(
      `order:${serviceDate}:style:${styleMall.id}`,
      styleMall,
      'ambient',
      serviceDate,
      reference,
      rng,
      submittedAt,
      lockedAt,
    ),
  );

  const availability = vehicleAvailability(reference.vehicles, driverVan.id, serviceDate);
  const capacity = availableReeferCapacity(reference.vehicles, availability, home);
  // Extra chilled demand goes to outlets with no chilled order yet, never the store's free slot.
  const chilledTaken = new Set(
    orders.filter((order) => order.temp === 'chilled').map((order) => order.outletId),
  );
  const extraOutlets = fresh.filter(
    (outlet) => outlet.id !== store.id && !chilledTaken.has(outlet.id),
  );
  let extra = 0;
  while (!chilledExceeds(orders, capacity) && extra < extraOutlets.length) {
    const outlet = extraOutlets[extra];
    if (outlet === undefined) break;
    const demand = chilledDemand(orders);
    const size = largestSize(
      reference.orderSizes,
      'Fresh',
      'chilled',
      demand.volumeM3 <= capacity.volumeM3 ? 'volumeM3' : 'weightKg',
    );
    orders.push(
      orderRow(
        `order:${serviceDate}:chilled-extra:${extra}`,
        outlet,
        'chilled',
        serviceDate,
        size,
        'confirmed',
        submittedAt,
        lockedAt,
        1,
      ),
    );
    extra += 1;
  }
  if (!chilledExceeds(orders, capacity)) {
    throw new Error('Could not build more chilled demand than available reefer capacity');
  }

  // Unsubmitted drafts for the next run, one per temperature, so each can still be submitted.
  const nextRun = nextOperatingDay(reference.calendarDays, serviceDate);
  if (nextRun !== undefined) {
    for (const temp of ['ambient', 'chilled'] as const) {
      orders.push(
        orderRow(
          `order:${serviceDate}:draft:${temp}`,
          store,
          temp,
          nextRun,
          pickSize(reference.orderSizes, 'Fresh', temp, rng),
          'draft',
          null,
          null,
          0,
        ),
      );
    }
  }
  assertDistinctSlots(orders);

  const dispatcherId = seedUuid(DEMO_USERS.dispatcher.key);
  const yesterdayRunId = seedUuid(`run:${previousOperatingDate}:${home}`);
  const todayRunId = seedUuid(`run:${serviceDate}:${home}`);
  return {
    serviceDate,
    previousOperatingDate,
    homeDepotId: home,
    accounts: [
      { ...DEMO_USERS.dispatcher, depotId: home },
      { ...DEMO_USERS.loader, depotId: home },
      { ...DEMO_USERS.driver, vehicleId: driverVan.id },
      { ...DEMO_USERS.storeManager, outletId: store.id },
      // Every other vehicle at the depot has a driver too, so any published trip can be run.
      ...reference.vehicles
        .filter((vehicle) => vehicle.depotId === home && vehicle.id !== driverVan.id)
        .sort(byId)
        .map((vehicle) => fleetDriver(vehicle.id)),
    ],
    vehicleAvailability: availability,
    orders,
    planningRuns: [
      {
        id: yesterdayRunId,
        depotId: home,
        serviceDate: previousOperatingDate,
        status: 'published',
        publishedAt: colombo(previousOperatingDate, '17:00:00'),
        publishedBy: dispatcherId,
        planVersion: 1,
      },
      {
        id: todayRunId,
        depotId: home,
        serviceDate,
        status: 'open',
        publishedAt: null,
        publishedBy: null,
        planVersion: 0,
      },
    ],
    deferral: {
      id: seedUuid(`deferral:${deferred.id}`),
      orderId: deferred.id,
      runId: yesterdayRunId,
      reasonCode: 'VOLUME_CAP',
      type: 'unavoidable',
      note: 'Deferred on the previous operating day.',
      actorId: dispatcherId,
      createdAt: colombo(previousOperatingDate, '18:00:00'),
    },
    audit: {
      id: seedUuid(`audit:seed:${serviceDate}`),
      actorId: dispatcherId,
      role: 'dispatcher',
      action: 'seed.apply',
      entityType: 'seed',
      entityId: 'waypoint',
      after: { serviceDate, source: reference.source },
      createdAt: lockedAt,
    },
  };
}

/** The account that drives one vehicle: driver.veh012@waypoint.test for VEH012. */
function fleetDriver(vehicleId: string): DemoAccount {
  return {
    key: `user:driver:${vehicleId}`,
    role: 'driver',
    name: `Driver ${vehicleId}`,
    email: `driver.${vehicleId.toLowerCase()}@waypoint.test`,
    vehicleId,
  };
}

export function resolveServiceDate(
  calendar: CalendarDayRecord[],
  requested: string | undefined,
): string {
  if (requested !== undefined) {
    const day = calendar.find((entry) => entry.date === requested);
    if (day === undefined) throw new Error(`DEMO_DATE ${requested} is not in the calendar`);
    if (!day.isOperating) throw new Error(`DEMO_DATE ${requested} is not an operating day`);
    return requested;
  }
  const preferred = calendar.find((entry) => entry.date === DEMO_SERVICE_DATE && entry.isOperating);
  if (preferred !== undefined) return DEMO_SERVICE_DATE;
  const operating = calendar
    .filter((entry) => entry.isOperating)
    .sort((left, right) => left.date.localeCompare(right.date));
  const last = operating.at(-1);
  if (last === undefined) throw new Error('Calendar has no operating day');
  return last.date;
}

function confirmedOrder(
  key: string,
  outlet: OutletRecord,
  temp: TemperatureRequirement,
  serviceDate: string,
  reference: ReferenceData,
  rng: () => number,
  submittedAt: Date,
  lockedAt: Date,
): DemoOrder {
  return orderRow(
    key,
    outlet,
    temp,
    serviceDate,
    pickSize(reference.orderSizes, outlet.brand, temp, rng),
    'confirmed',
    submittedAt,
    lockedAt,
    1,
  );
}

function orderRow(
  key: string,
  outlet: OutletRecord,
  temp: TemperatureRequirement,
  serviceDate: string,
  size: OrderSizeRecord,
  status: OrderStatus,
  submittedAt: Date | null,
  lockedAt: Date | null,
  version: number,
): DemoOrder {
  return {
    id: seedUuid(key),
    outletId: outlet.id,
    brand: outlet.brand,
    temp,
    requestedDate: serviceDate,
    units: size.units,
    weightKg: size.weightKg,
    volumeM3: size.volumeM3,
    status,
    submittedAt,
    lockedAt,
    version,
  };
}

function vehicleAvailability(vehicles: VehicleRecord[], driverVanId: string, serviceDate: string) {
  const homeVehicles = vehicles.filter((vehicle) => vehicle.depotId === HOME_DEPOT_ID).sort(byId);
  const reefers = homeVehicles.filter((vehicle) => vehicle.temp === 'reefer');
  const kept = new Set<string>();
  const driver = homeVehicles.find((vehicle) => vehicle.id === driverVanId);
  if (driver?.temp === 'reefer') kept.add(driver.id);
  const truck = reefers.find((vehicle) => vehicle.type === 'truck' && !kept.has(vehicle.id));
  if (truck !== undefined) kept.add(truck.id);
  for (const reefer of reefers) {
    if (kept.size >= 2) break;
    kept.add(reefer.id);
  }
  const workshopTrucks = homeVehicles
    .filter(
      (vehicle) =>
        vehicle.type === 'truck' && vehicle.temp === 'ambient' && vehicle.id !== driverVanId,
    )
    .slice(0, 2)
    .map((vehicle) => vehicle.id);
  const workshop = new Set<string>([
    ...reefers.filter((vehicle) => !kept.has(vehicle.id)).map((vehicle) => vehicle.id),
    ...workshopTrucks,
  ]);
  return vehicles.map((vehicle) => ({
    vehicleId: vehicle.id,
    date: serviceDate,
    status: workshop.has(vehicle.id) ? ('in_workshop' as const) : ('available' as const),
  }));
}

function availableReeferCapacity(
  vehicles: VehicleRecord[],
  availability: { vehicleId: string; status: 'available' | 'in_workshop' }[],
  depotId: string,
) {
  const workshop = new Set(
    availability.filter((row) => row.status === 'in_workshop').map((row) => row.vehicleId),
  );
  return vehicles
    .filter(
      (vehicle) =>
        vehicle.depotId === depotId && vehicle.temp === 'reefer' && !workshop.has(vehicle.id),
    )
    .reduce(
      (total, vehicle) => ({
        weightKg: total.weightKg + vehicle.weightCapKg,
        volumeM3: total.volumeM3 + vehicle.volumeCapM3,
      }),
      { weightKg: 0, volumeM3: 0 },
    );
}

function chilledDemand(orders: DemoOrder[]): { weightKg: number; volumeM3: number } {
  return orders
    .filter(
      (order) =>
        order.temp === 'chilled' && (order.status === 'confirmed' || order.status === 'deferred'),
    )
    .reduce(
      (total, order) => ({
        weightKg: total.weightKg + order.weightKg,
        volumeM3: total.volumeM3 + order.volumeM3,
      }),
      { weightKg: 0, volumeM3: 0 },
    );
}

function chilledExceeds(
  orders: DemoOrder[],
  capacity: { weightKg: number; volumeM3: number },
): boolean {
  const demand = chilledDemand(orders);
  return demand.volumeM3 > capacity.volumeM3 && demand.weightKg > capacity.weightKg;
}

function pickSize(
  sizes: OrderSizeRecord[],
  brand: Brand,
  temp: TemperatureRequirement,
  rng: () => number,
): OrderSizeRecord {
  const matches = sizes.filter((size) => size.brand === brand && size.temp === temp);
  const index = Math.floor(rng() * matches.length);
  const size = matches[index];
  if (size === undefined) throw new Error(`No ${brand} ${temp} order size is available`);
  return size;
}

function largestSize(
  sizes: OrderSizeRecord[],
  brand: Brand,
  temp: TemperatureRequirement,
  metric: 'volumeM3' | 'weightKg',
): OrderSizeRecord {
  const matches = sizes.filter((size) => size.brand === brand && size.temp === temp);
  const largest = matches.reduce<OrderSizeRecord | undefined>((best, size) => {
    if (best === undefined || size[metric] > best[metric]) return size;
    return best;
  }, undefined);
  if (largest === undefined) throw new Error(`No ${brand} ${temp} order size is available`);
  return largest;
}

function previousOperatingDay(calendar: CalendarDayRecord[], serviceDate: string): string {
  const prior = calendar
    .filter((day) => day.date < serviceDate && day.isOperating)
    .sort((left, right) => left.date.localeCompare(right.date));
  const day = prior.at(-1);
  if (day === undefined) throw new Error(`No operating day before ${serviceDate}`);
  return day.date;
}

function nextOperatingDay(calendar: CalendarDayRecord[], serviceDate: string): string | undefined {
  return calendar
    .filter((day) => day.date > serviceDate && day.isOperating)
    .sort((left, right) => left.date.localeCompare(right.date))[0]?.date;
}

/** Mirrors the API rule: at most one order per outlet, date and temperature that is not cancelled. */
function assertDistinctSlots(orders: DemoOrder[]): void {
  const seen = new Set<string>();
  for (const order of orders) {
    if (order.status === 'cancelled') continue;
    const slot = `${order.outletId}|${order.requestedDate}|${order.temp}`;
    if (seen.has(slot)) throw new Error(`Demo seed places two active orders in slot ${slot}`);
    seen.add(slot);
  }
}

function byId<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}
