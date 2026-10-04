import type { TripDraft, ValidatorInput } from '@waypoint/planning';
import type {
  Outlet,
  PlanInput,
  ServiceAllowanceKey,
  VehicleAvailabilityStatus,
  VehicleLite,
} from '@waypoint/shared';
import { defaultPriorityWeights } from '@waypoint/shared';
import type { SQL } from 'drizzle-orm';
import { ApiError } from '../../plugins/errors.ts';
import type { EligibleOrder, PlanningDb, PlanningRepo, VehicleRow } from './repo.ts';

export interface PlanningContext {
  serviceDate: string;
  depotId: string;
  isoYear: number;
  isoWeek: number;
  orders: EligibleOrder[];
  plan: PlanInput;
  availability: Record<string, VehicleAvailabilityStatus>;
  vehiclesById: Map<string, VehicleRow>;
}

export async function loadPlanningContext(
  repo: PlanningRepo,
  db: PlanningDb,
  depotId: string,
  serviceDate: string,
  userScope: SQL,
  /** Plan around these orders instead of the run's open queue (replanning a published run). */
  orderOverride?: EligibleOrder[],
): Promise<PlanningContext> {
  const day = await repo.findCalendarDay(db, serviceDate);
  if (day === null) throw new ApiError('VALIDATION_ERROR', 'Service date is not on the calendar');
  if (!day.isOperating) {
    throw new ApiError('VALIDATION_ERROR', 'Service date is not an operating day');
  }

  const orders =
    orderOverride ?? (await repo.listEligibleOrders(db, depotId, serviceDate, userScope));
  const outletIds = unique(orders.map((order) => order.outletId));
  const districts = unique(orders.map((order) => order.district));
  const travelRows = await repo.listDistrictTravel(db, districts);
  const allowanceRows = await repo.listServiceAllowances(db);
  const depotVehicles = await repo.listDepotVehicles(db, depotId);
  const availabilityRows = await repo.listAvailability(
    db,
    depotVehicles.map((vehicle) => vehicle.id),
    serviceDate,
  );
  const used = await repo.fuelUsedLitres(
    db,
    depotVehicles.map((vehicle) => vehicle.id),
    day.isoYear,
    day.isoWeek,
  );

  const availability: Record<string, VehicleAvailabilityStatus> = {};
  const vehiclesById = new Map<string, VehicleRow>();
  const available: VehicleLite[] = [];
  const fuelRemainingL: Record<string, number> = {};
  for (const vehicle of depotVehicles) {
    vehiclesById.set(vehicle.id, vehicle);
    const status = availabilityRows.get(vehicle.id) ?? 'available';
    availability[vehicle.id] = status;
    fuelRemainingL[vehicle.id] = vehicle.weeklyFuelQuotaL - (used.get(vehicle.id) ?? 0);
    if (status === 'available') available.push(toVehicleLite(vehicle));
  }

  const previous = await repo.previousOperatingDate(db, serviceDate);
  const deferredYesterday =
    previous === null ? new Set<string>() : await repo.outletsDeferredOn(db, outletIds, previous);
  const lastServed = await repo.lastServedDates(db, outletIds, serviceDate);

  const outlets: PlanInput['outlets'] = {};
  for (const order of orders) {
    if (outlets[order.outletId] === undefined) outlets[order.outletId] = toOutlet(order);
  }

  const districtTravel: PlanInput['districtTravel'] = {};
  for (const row of travelRows) districtTravel[row.district] = row;
  for (const district of districts) {
    if (districtTravel[district] === undefined) {
      throw new ApiError('INTERNAL_ERROR', `No district travel for ${district}`);
    }
  }

  const serviceAllowance = {} as PlanInput['serviceAllowance'];
  for (const row of allowanceRows) {
    const key: ServiceAllowanceKey = `${row.brand}:${row.dockType}`;
    serviceAllowance[key] = row.minutes;
  }
  for (const order of orders) {
    const key: ServiceAllowanceKey = `${order.brand}:${order.dockType}`;
    if (serviceAllowance[key] === undefined) {
      throw new ApiError('INTERNAL_ERROR', `No service allowance for ${key}`);
    }
  }

  return {
    serviceDate,
    depotId,
    isoYear: day.isoYear,
    isoWeek: day.isoWeek,
    orders,
    availability,
    vehiclesById,
    plan: {
      serviceDate,
      depotId,
      orders: orders.map((order) => ({
        id: order.id,
        outletId: order.outletId,
        brand: order.brand,
        temp: order.temp,
        weightKg: order.weightKg,
        volumeM3: order.volumeM3,
        deferredYesterday: deferredYesterday.has(order.outletId),
        daysSinceLastServed: daysSince(lastServed.get(order.outletId), serviceDate),
      })),
      vehicles: available,
      outlets,
      districtTravel,
      serviceAllowance,
      fuelRemainingL,
      policy: defaultPriorityWeights,
    },
  };
}

export function validatorInput(
  context: PlanningContext,
  extras: readonly VehicleRow[] = [],
): ValidatorInput {
  const vehicles = [...context.plan.vehicles];
  const seen = new Set(vehicles.map((vehicle) => vehicle.id));
  const fuelRemainingL = { ...context.plan.fuelRemainingL };
  const availability: Record<string, VehicleAvailabilityStatus> = {};
  for (const vehicle of vehicles) {
    availability[vehicle.id] = context.availability[vehicle.id] ?? 'available';
  }
  for (const extra of extras) {
    fuelRemainingL[extra.id] = context.plan.fuelRemainingL[extra.id] ?? extra.weeklyFuelQuotaL;
    availability[extra.id] = context.availability[extra.id] ?? 'available';
    if (seen.has(extra.id)) continue;
    seen.add(extra.id);
    vehicles.push(toVehicleLite(extra));
  }
  return {
    serviceDate: context.plan.serviceDate,
    orders: context.plan.orders,
    vehicles,
    outlets: context.plan.outlets,
    districtTravel: context.plan.districtTravel,
    serviceAllowance: context.plan.serviceAllowance,
    fuelRemainingL,
    availability,
  };
}

export function draftsReferencing(
  context: PlanningContext,
  drafts: readonly TripDraft[],
): VehicleRow[] {
  const extras: VehicleRow[] = [];
  for (const draft of drafts) {
    const vehicle = context.vehiclesById.get(draft.vehicleId);
    if (vehicle) extras.push(vehicle);
  }
  return extras;
}

function toVehicleLite(vehicle: VehicleRow): VehicleLite {
  return {
    id: vehicle.id,
    type: vehicle.type,
    temp: vehicle.temp,
    weightCapKg: vehicle.weightCapKg,
    volumeCapM3: vehicle.volumeCapM3,
    kmPerL: vehicle.kmPerL,
    depotId: vehicle.depotId,
  };
}

function toOutlet(order: EligibleOrder): Outlet {
  const mallOpen = order.mallWindowOpen;
  const mallClose = order.mallWindowClose;
  return {
    id: order.outletId,
    brand: order.outletBrand,
    district: order.district,
    depotId: order.depotId,
    dockType: order.dockType,
    parkingConstraint: order.parkingConstraint,
    window: { open: timeOfDay(order.windowOpen), close: timeOfDay(order.windowClose) },
    mallWindow:
      mallOpen !== null && mallClose !== null
        ? { open: timeOfDay(mallOpen), close: timeOfDay(mallClose) }
        : null,
  };
}

function timeOfDay(value: string): string {
  const match = /^([01]\d|2[0-3]):([0-5]\d)/.exec(value);
  const hour = match?.[1];
  const minute = match?.[2];
  if (hour === undefined || minute === undefined) {
    throw new ApiError('INTERNAL_ERROR', 'Stored window is invalid');
  }
  return `${hour}:${minute}`;
}

function daysSince(servedOn: string | undefined, serviceDate: string): number {
  if (servedOn === undefined) return 0;
  const earlier = dateUtc(servedOn);
  const later = dateUtc(serviceDate);
  const days = Math.round((later - earlier) / 86_400_000);
  return days > 0 ? days : 0;
}

function dateUtc(iso: string): number {
  const [year, month, day] = iso.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new ApiError('INTERNAL_ERROR', 'Stored service date is invalid');
  }
  return Date.UTC(year, month - 1, day);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
