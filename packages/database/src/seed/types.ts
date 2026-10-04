import type {
  Brand,
  DockType,
  ParkingConstraint,
  RoadClass,
  TemperatureRequirement,
  VehicleTemperature,
  VehicleType,
} from '@waypoint/shared';

export interface DepotRecord {
  id: string;
  name: string;
}

export interface OutletRecord {
  id: string;
  brand: Brand;
  district: string;
  depotId: string;
  dockType: DockType;
  parkingConstraint: ParkingConstraint;
  mallWindowOpen: string | null;
  mallWindowClose: string | null;
  windowOpen: string;
  windowClose: string;
}

export interface VehicleRecord {
  id: string;
  type: VehicleType;
  temp: VehicleTemperature;
  weightCapKg: number;
  volumeCapM3: number;
  fuelType: string;
  kmPerL: number;
  weeklyFuelQuotaL: number;
  depotId: string;
}

export interface CalendarDayRecord {
  date: string;
  dow: number;
  isoYear: number;
  isoWeek: number;
  isPayday: boolean;
  festival: string | null;
  festivalRamp: number;
  isHoliday: boolean;
  monsoon: boolean;
  isOperating: boolean;
}

export interface DistrictTravelRecord {
  district: string;
  depotId: string;
  roadClass: RoadClass;
  depotToDistrictKm: number;
  depotToDistrictMin: number;
  interStopKm: number;
  interStopMin: number;
}

export interface ServiceAllowanceRecord {
  brand: Brand;
  dockType: DockType;
  minutes: number;
}

export interface OrderSizeRecord {
  brand: Brand;
  temp: TemperatureRequirement;
  units: number;
  weightKg: number;
  volumeM3: number;
}

/** One day's demand for a depot and brand, from the order history (requested date). */
export interface DemandHistoryRecord {
  date: string;
  depotId: string;
  brand: Brand;
  orders: number;
  volumeM3: number;
  chilledVolumeM3: number;
}

type ReferenceSource = 'dataset' | 'synthetic';

export interface ReferenceData {
  source: ReferenceSource;
  depots: DepotRecord[];
  outlets: OutletRecord[];
  vehicles: VehicleRecord[];
  calendarDays: CalendarDayRecord[];
  districtTravel: DistrictTravelRecord[];
  serviceAllowances: ServiceAllowanceRecord[];
  orderSizes: OrderSizeRecord[];
  demandHistory: DemandHistoryRecord[];
}
