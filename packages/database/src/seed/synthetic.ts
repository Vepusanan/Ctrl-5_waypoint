import type { ReferenceData } from './types.ts';

// Invented reference data for CI and machines without the confidential CSVs.
// These figures are not taken from the competition datasets.
export const syntheticReference: ReferenceData = {
  source: 'synthetic',
  depots: [
    { id: 'Peliyagoda', name: 'Peliyagoda' },
    { id: 'Kandy', name: 'Kandy' },
  ],
  districtTravel: [
    {
      district: 'Colombo',
      depotId: 'Peliyagoda',
      roadClass: 'urban',
      depotToDistrictKm: 10,
      depotToDistrictMin: 20,
      interStopKm: 3,
      interStopMin: 7,
    },
    {
      district: 'Negombo',
      depotId: 'Peliyagoda',
      roadClass: 'suburban',
      depotToDistrictKm: 18,
      depotToDistrictMin: 30,
      interStopKm: 4,
      interStopMin: 9,
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
  ],
  outlets: [
    outlet('OUT001', 'Fresh', 'Colombo', 'Peliyagoda', 'street', 'van_only', '05:00', '08:00'),
    outlet('OUT002', 'Fresh', 'Colombo', 'Peliyagoda', 'rear_dock', 'normal', '05:00', '08:00'),
    outlet('OUT003', 'Fresh', 'Colombo', 'Peliyagoda', 'street', 'normal', '05:30', '08:00'),
    outlet('OUT004', 'Fresh', 'Colombo', 'Peliyagoda', 'rear_dock', 'normal', '04:00', '07:30'),
    outlet('OUT005', 'Fresh', 'Negombo', 'Peliyagoda', 'street', 'normal', '05:00', '08:00'),
    outlet('OUT006', 'Fresh', 'Negombo', 'Peliyagoda', 'rear_dock', 'normal', '05:00', '07:45'),
    outlet('OUT007', 'Fresh', 'Colombo', 'Peliyagoda', 'street', 'normal', '04:30', '07:30'),
    outlet('OUT008', 'Fresh', 'Colombo', 'Peliyagoda', 'rear_dock', 'normal', '05:00', '08:00'),
    outlet(
      'OUT009',
      'Style',
      'Colombo',
      'Peliyagoda',
      'mall_bay',
      'mall_dock',
      '09:00',
      '11:00',
      '09:00',
      '11:00',
    ),
    outlet('OUT010', 'Tech', 'Colombo', 'Peliyagoda', 'rear_dock', 'normal', '09:00', '17:00'),
    outlet('OUT011', 'Fresh', 'Kandy', 'Kandy', 'street', 'normal', '05:00', '08:00'),
  ],
  vehicles: [
    vehicle('VEH001', 'van', 'reefer', 1_200, 10, 'Peliyagoda'),
    vehicle('VEH002', 'truck', 'reefer', 4_000, 20, 'Peliyagoda'),
    vehicle('VEH003', 'truck', 'reefer', 4_000, 20, 'Peliyagoda'),
    vehicle('VEH004', 'truck', 'ambient', 5_000, 28, 'Peliyagoda'),
    vehicle('VEH005', 'van', 'ambient', 1_400, 11, 'Peliyagoda'),
    vehicle('VEH006', 'truck', 'ambient', 5_000, 28, 'Peliyagoda'),
    vehicle('VEH007', 'truck', 'reefer', 3_500, 16, 'Kandy'),
    vehicle('VEH008', 'van', 'ambient', 1_400, 11, 'Kandy'),
  ],
  calendarDays: [
    day('2026-06-22', 0),
    day('2026-06-23', 1),
    day('2026-06-24', 2),
    day('2026-06-25', 3),
    day('2026-06-26', 4),
    day('2026-06-27', 5),
  ],
  serviceAllowances: [
    { brand: 'Fresh', dockType: 'rear_dock', minutes: 12 },
    { brand: 'Fresh', dockType: 'street', minutes: 14 },
    { brand: 'Fresh', dockType: 'mall_bay', minutes: 20 },
    { brand: 'Style', dockType: 'rear_dock', minutes: 22 },
    { brand: 'Style', dockType: 'street', minutes: 28 },
    { brand: 'Style', dockType: 'mall_bay', minutes: 36 },
    { brand: 'Tech', dockType: 'rear_dock', minutes: 24 },
    { brand: 'Tech', dockType: 'street', minutes: 32 },
    { brand: 'Tech', dockType: 'mall_bay', minutes: 40 },
  ],
  orderSizes: [
    { brand: 'Fresh', temp: 'ambient', units: 10, weightKg: 30, volumeM3: 0.7 },
    { brand: 'Fresh', temp: 'ambient', units: 18, weightKg: 48, volumeM3: 1.1 },
    { brand: 'Fresh', temp: 'chilled', units: 8, weightKg: 36, volumeM3: 1 },
    { brand: 'Fresh', temp: 'chilled', units: 14, weightKg: 2_000, volumeM3: 12 },
    { brand: 'Style', temp: 'ambient', units: 6, weightKg: 22, volumeM3: 1.4 },
    { brand: 'Tech', temp: 'ambient', units: 4, weightKg: 16, volumeM3: 0.4 },
  ],
  // Four earlier Fridays, so analytics has a same-weekday series without the confidential data.
  demandHistory: ['2026-05-29', '2026-06-05', '2026-06-12', '2026-06-19'].flatMap((date, week) => [
    {
      date,
      depotId: 'Peliyagoda',
      brand: 'Fresh' as const,
      orders: 6 + week,
      volumeM3: 14 + week * 2,
      chilledVolumeM3: 5 + week,
    },
    {
      date,
      depotId: 'Peliyagoda',
      brand: 'Style' as const,
      orders: 2,
      volumeM3: 3,
      chilledVolumeM3: 0,
    },
  ]),
};

function outlet(
  id: string,
  brand: ReferenceData['outlets'][number]['brand'],
  district: string,
  depotId: string,
  dockType: ReferenceData['outlets'][number]['dockType'],
  parkingConstraint: ReferenceData['outlets'][number]['parkingConstraint'],
  windowOpen: string,
  windowClose: string,
  mallWindowOpen: string | null = null,
  mallWindowClose: string | null = null,
): ReferenceData['outlets'][number] {
  return {
    id,
    brand,
    district,
    depotId,
    dockType,
    parkingConstraint,
    mallWindowOpen: mallWindowOpen === null ? null : clock(mallWindowOpen),
    mallWindowClose: mallWindowClose === null ? null : clock(mallWindowClose),
    windowOpen: clock(windowOpen),
    windowClose: clock(windowClose),
  };
}

function vehicle(
  id: string,
  type: ReferenceData['vehicles'][number]['type'],
  temp: ReferenceData['vehicles'][number]['temp'],
  weightCapKg: number,
  volumeCapM3: number,
  depotId: string,
): ReferenceData['vehicles'][number] {
  return {
    id,
    type,
    temp,
    weightCapKg,
    volumeCapM3,
    fuelType: 'diesel',
    kmPerL: type === 'van' ? 11 : 5,
    weeklyFuelQuotaL: type === 'van' ? 180 : 400,
    depotId,
  };
}

function day(date: string, dow: number): ReferenceData['calendarDays'][number] {
  return {
    date,
    dow,
    isoYear: 2026,
    isoWeek: 26,
    isPayday: false,
    festival: null,
    festivalRamp: 0,
    isHoliday: false,
    monsoon: false,
    isOperating: true,
  };
}

function clock(value: string): string {
  return `${value}:00`;
}
