import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  brandSchema,
  dockTypeSchema,
  parkingConstraintSchema,
  roadClassSchema,
  temperatureRequirementSchema,
  vehicleTemperatureSchema,
  vehicleTypeSchema,
} from '@waypoint/shared';
import { parseCsv, requireCell } from './csv.ts';
import { syntheticReference } from './synthetic.ts';
import type {
  CalendarDayRecord,
  DemandHistoryRecord,
  DepotRecord,
  DistrictTravelRecord,
  OrderSizeRecord,
  OutletRecord,
  ReferenceData,
  ServiceAllowanceRecord,
  VehicleRecord,
} from './types.ts';

const REFERENCE_FILES = [
  'outlets.csv',
  'vehicles.csv',
  'calendar.csv',
  'district_travel.csv',
  'service_allowance.csv',
] as const;

const HISTORICAL_ORDERS_FILE = 'deliveries_train.csv';

export async function loadReference(roots: readonly string[]): Promise<ReferenceData> {
  for (const root of roots) {
    const files = await findReferenceFiles(root);
    if (files !== undefined) {
      return readDataset(files);
    }
  }
  return syntheticReference;
}

export function referenceRoots(dataDir: string | undefined, cwd: string): string[] {
  const roots: string[] = [];
  const add = (candidate: string) => {
    const resolved = path.resolve(candidate);
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  if (dataDir !== undefined && dataDir.length > 0) add(dataDir);
  add(path.join(cwd, 'data'));
  add(repositoryDataDir());
  return roots;
}

function repositoryDataDir(): string {
  return fileURLToPath(new URL('../../../../data/', import.meta.url));
}

async function findReferenceFiles(root: string): Promise<Map<string, string> | undefined> {
  let entries: string[];
  try {
    entries = await walkFiles(root);
  } catch {
    return undefined;
  }
  const found = new Map<string, string>();
  for (const filePath of entries) {
    const base = path.basename(filePath);
    if (REFERENCE_FILES.some((name) => name === base) || base === HISTORICAL_ORDERS_FILE) {
      if (!found.has(base)) found.set(base, filePath);
    }
  }
  if (!REFERENCE_FILES.every((name) => found.has(name))) return undefined;
  return found;
}

async function walkFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) found.push(full);
    }
  }
  return found;
}

async function readDataset(files: Map<string, string>): Promise<ReferenceData> {
  const outlets = parseOutlets(await readTable('outlets.csv', files));
  const vehicles = parseVehicles(await readTable('vehicles.csv', files));
  const districtTravel = parseDistrictTravel(await readTable('district_travel.csv', files));
  const depots = depotsFrom(outlets, vehicles, districtTravel);
  const historical = files.get(HISTORICAL_ORDERS_FILE);
  const historicalRows =
    historical === undefined ? null : parseCsv(await readFile(historical, 'utf8'));
  const orderSizes =
    historicalRows === null ? syntheticReference.orderSizes : parseOrderSizes(historicalRows);
  const knownDepots = new Set(depots.map((depot) => depot.id));
  const demandHistory =
    historicalRows === null
      ? syntheticReference.demandHistory
      : parseDemandHistory(historicalRows).filter((row) => knownDepots.has(row.depotId));
  return {
    source: 'dataset',
    depots,
    outlets,
    vehicles,
    calendarDays: parseCalendar(await readTable('calendar.csv', files)),
    districtTravel,
    serviceAllowances: parseAllowances(await readTable('service_allowance.csv', files)),
    orderSizes,
    demandHistory,
  };
}

async function readTable(
  name: string,
  files: Map<string, string>,
): Promise<Record<string, string>[]> {
  const filePath = files.get(name);
  if (filePath === undefined) throw new Error(`Missing ${name}`);
  return parseCsv(await readFile(filePath, 'utf8'));
}

function parseOutlets(rows: Record<string, string>[]): OutletRecord[] {
  return rows.map((row) => {
    const mall = splitMallWindow(requireCell(row, 'mall_window', 'outlets.csv'));
    return {
      id: requireCell(row, 'outlet_id', 'outlets.csv'),
      brand: oneOf(
        requireCell(row, 'brand', 'outlets.csv'),
        brandSchema.options,
        'outlets.csv brand',
      ),
      district: requireCell(row, 'district', 'outlets.csv'),
      depotId: requireCell(row, 'depot', 'outlets.csv'),
      dockType: oneOf(
        requireCell(row, 'dock_type', 'outlets.csv'),
        dockTypeSchema.options,
        'outlets.csv dock_type',
      ),
      parkingConstraint: oneOf(
        requireCell(row, 'parking_constraint', 'outlets.csv'),
        parkingConstraintSchema.options,
        'outlets.csv parking_constraint',
      ),
      mallWindowOpen: mall.open,
      mallWindowClose: mall.close,
      windowOpen: clock(requireCell(row, 'window_open_time', 'outlets.csv')),
      windowClose: clock(requireCell(row, 'window_close_time', 'outlets.csv')),
    };
  });
}

function parseVehicles(rows: Record<string, string>[]): VehicleRecord[] {
  return rows.map((row) => ({
    id: requireCell(row, 'vehicle_id', 'vehicles.csv'),
    type: oneOf(
      requireCell(row, 'type', 'vehicles.csv'),
      vehicleTypeSchema.options,
      'vehicles.csv type',
    ),
    temp: oneOf(
      requireCell(row, 'temp', 'vehicles.csv'),
      vehicleTemperatureSchema.options,
      'vehicles.csv temp',
    ),
    weightCapKg: numberCell(row, 'weight_cap_kg', 'vehicles.csv'),
    volumeCapM3: numberCell(row, 'volume_cap_m3', 'vehicles.csv'),
    fuelType: requireCell(row, 'fuel_type', 'vehicles.csv'),
    kmPerL: numberCell(row, 'km_per_l', 'vehicles.csv'),
    weeklyFuelQuotaL: numberCell(row, 'weekly_fuel_quota_l', 'vehicles.csv'),
    depotId: requireCell(row, 'depot', 'vehicles.csv'),
  }));
}

function parseCalendar(rows: Record<string, string>[]): CalendarDayRecord[] {
  return rows.map((row) => {
    const festival = requireCell(row, 'festival', 'calendar.csv');
    return {
      date: requireCell(row, 'date', 'calendar.csv'),
      dow: integerCell(row, 'dow', 'calendar.csv'),
      isoYear: integerCell(row, 'iso_year', 'calendar.csv'),
      isoWeek: integerCell(row, 'iso_week', 'calendar.csv'),
      isPayday: flag(requireCell(row, 'is_payday', 'calendar.csv')),
      festival: festival.length === 0 ? null : festival,
      festivalRamp: numberCell(row, 'festival_ramp', 'calendar.csv'),
      isHoliday: flag(requireCell(row, 'is_holiday', 'calendar.csv')),
      monsoon: flag(requireCell(row, 'monsoon', 'calendar.csv')),
      isOperating: flag(requireCell(row, 'is_operating', 'calendar.csv')),
    };
  });
}

function parseDistrictTravel(rows: Record<string, string>[]): DistrictTravelRecord[] {
  return rows.map((row) => ({
    district: requireCell(row, 'district', 'district_travel.csv'),
    depotId: requireCell(row, 'depot', 'district_travel.csv'),
    roadClass: oneOf(
      requireCell(row, 'road_class', 'district_travel.csv'),
      roadClassSchema.options,
      'district_travel.csv road_class',
    ),
    depotToDistrictKm: numberCell(row, 'depot_to_district_km', 'district_travel.csv'),
    depotToDistrictMin: numberCell(row, 'depot_to_district_freeflow_min', 'district_travel.csv'),
    interStopKm: numberCell(row, 'inter_stop_km', 'district_travel.csv'),
    interStopMin: numberCell(row, 'inter_stop_freeflow_min', 'district_travel.csv'),
  }));
}

function parseAllowances(rows: Record<string, string>[]): ServiceAllowanceRecord[] {
  return rows.map((row) => ({
    brand: oneOf(
      requireCell(row, 'brand', 'service_allowance.csv'),
      brandSchema.options,
      'service_allowance.csv brand',
    ),
    dockType: oneOf(
      requireCell(row, 'dock_type', 'service_allowance.csv'),
      dockTypeSchema.options,
      'service_allowance.csv dock_type',
    ),
    minutes: integerCell(row, 'service_allowance_min', 'service_allowance.csv'),
  }));
}

function parseOrderSizes(rows: Record<string, string>[]): OrderSizeRecord[] {
  const sizes: OrderSizeRecord[] = [];
  for (const row of rows) {
    const units = Math.round(numberCell(row, 'order_units', 'deliveries_train.csv'));
    const weightKg = round3(numberCell(row, 'order_weight_kg', 'deliveries_train.csv'));
    const volumeM3 = round3(numberCell(row, 'order_volume_m3', 'deliveries_train.csv'));
    if (units <= 0 || weightKg <= 0 || volumeM3 <= 0) continue;
    sizes.push({
      brand: oneOf(
        requireCell(row, 'brand', 'deliveries_train.csv'),
        brandSchema.options,
        'deliveries_train.csv brand',
      ),
      temp: oneOf(
        requireCell(row, 'temp_requirement', 'deliveries_train.csv'),
        temperatureRequirementSchema.options,
        'deliveries_train.csv temp_requirement',
      ),
      units,
      weightKg,
      volumeM3,
    });
  }
  if (sizes.length === 0) {
    throw new Error('deliveries_train.csv has no usable order sizes');
  }
  return sizes;
}

// Every order counts once on its requested date, whatever happened to it afterwards.
function parseDemandHistory(rows: Record<string, string>[]): DemandHistoryRecord[] {
  const days = new Map<string, DemandHistoryRecord>();
  for (const row of rows) {
    // A cut-down history file without dates still gives order sizes; it has no demand series.
    const date = row.order_date?.trim() ?? '';
    const depotId = row.depot?.trim() ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || depotId === '') continue;
    const brand = oneOf(
      requireCell(row, 'brand', 'deliveries_train.csv'),
      brandSchema.options,
      'deliveries_train.csv brand',
    );
    const volume = numberCell(row, 'order_volume_m3', 'deliveries_train.csv');
    if (!(volume > 0)) continue;
    const name = `${date}|${depotId}|${brand}`;
    const day = days.get(name) ?? {
      date,
      depotId,
      brand,
      orders: 0,
      volumeM3: 0,
      chilledVolumeM3: 0,
    };
    day.orders += 1;
    day.volumeM3 += volume;
    if (requireCell(row, 'temp_requirement', 'deliveries_train.csv') === 'chilled') {
      day.chilledVolumeM3 += volume;
    }
    days.set(name, day);
  }
  return [...days.values()].map((day) => ({
    ...day,
    volumeM3: round3(day.volumeM3),
    chilledVolumeM3: round3(day.chilledVolumeM3),
  }));
}

function depotsFrom(
  outlets: OutletRecord[],
  vehicles: VehicleRecord[],
  travel: DistrictTravelRecord[],
): DepotRecord[] {
  const ids = new Set<string>();
  for (const outlet of outlets) ids.add(outlet.depotId);
  for (const vehicle of vehicles) ids.add(vehicle.depotId);
  for (const row of travel) ids.add(row.depotId);
  return [...ids].sort().map((id) => ({ id, name: id }));
}

function splitMallWindow(value: string): { open: string | null; close: string | null } {
  if (value.length === 0) return { open: null, close: null };
  const [open, close] = value.split('-');
  if (open === undefined || close === undefined || open.length === 0 || close.length === 0) {
    throw new Error('outlets.csv mall_window must be empty or HH:MM-HH:MM');
  }
  return { open: clock(open), close: clock(close) };
}

function clock(value: string): string {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (match === null) throw new Error(`Expected HH:MM, received ${value}`);
  return `${match[1]}:${match[2]}:${match[3] ?? '00'}`;
}

function flag(value: string): boolean {
  if (value === '1') return true;
  if (value === '0') return false;
  throw new Error(`Expected 0 or 1, received ${value}`);
}

function numberCell(row: Record<string, string>, column: string, file: string): number {
  const parsed = Number(requireCell(row, column, file));
  if (!Number.isFinite(parsed)) throw new Error(`${file} column ${column} is not a number`);
  return parsed;
}

function integerCell(row: Record<string, string>, column: string, file: string): number {
  const parsed = numberCell(row, column, file);
  if (!Number.isInteger(parsed)) throw new Error(`${file} column ${column} is not an integer`);
  return parsed;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${label} has an unexpected value`);
  }
  return value as T;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
