import {
  type DemandDay,
  demandInsightSchema,
  type Outlet,
  outletHistoryListSchema,
  outletListResponseSchema,
  outletProfileFactsSchema,
} from '@waypoint/shared';
import type { z } from 'zod';
import { HttpError, api as http } from '../../../../lib/api';
import type {
  forecastSchema,
  OutletAccess,
  OutletDelivery,
  OutletRow,
  outletDirectorySchema,
  outletProfileSchema,
} from '../../contracts';
import type { Source } from '../client';

// D10 · Analytics & forecast and D13 · Outlets, read from recorded demand, runs and stop events.

type Forecast = z.infer<typeof forecastSchema>;

/** Planners load a trip to about four fifths, so that is what one trip is taken to carry. */
const TARGET_FILL = 0.8;
const TRIPS_PER_VEHICLE = 2;
/** A day this far from the recent average is worth pointing out. */
const ANOMALY_PERCENT = 15;
const OBSERVED_WEEKS = 4;

const weekdayName = (date: string) =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(`${date}T12:00:00Z`),
  );
const weekLabel = (day: DemandDay) => `W${day.isoWeek}`;

async function forecast(query: URLSearchParams): Promise<Forecast> {
  const date = query.get('date') ?? '';
  const vehicleClass = query.get('class') === 'dry' ? 'dry' : 'reefer';
  const data = await http(`/analytics/demand?date=${date}`, demandInsightSchema);
  const label = vehicleClass === 'reefer' ? 'reefer' : 'dry';
  // Chilled goods need a reefer; everything else is planned onto the dry fleet first.
  const volumeOf = (day: DemandDay, kind: 'reefer' | 'dry') =>
    kind === 'reefer' ? day.chilledVolumeM3 : Math.max(0, day.volumeM3 - day.chilledVolumeM3);
  const tripsOf = (day: DemandDay, kind: 'reefer' | 'dry') => {
    const perTrip = data.fleet[kind].avgVolumeCapM3 * TARGET_FILL;
    return perTrip > 0 ? Math.ceil(volumeOf(day, kind) / perTrip) : 0;
  };
  const capacityOf = (kind: 'reefer' | 'dry') => data.fleet[kind].available * TRIPS_PER_VEHICLE;
  const capacity = capacityOf(vehicleClass);

  const observed = data.history.slice(-OBSERVED_WEEKS);
  const weeks = [
    ...observed.map((day) => ({
      week: weekLabel(day),
      trips: tripsOf(day, vehicleClass),
      predicted: false,
    })),
    ...data.forecast.map((day) => ({
      week: weekLabel(day),
      trips: tripsOf(day, vehicleClass),
      predicted: true,
    })),
  ];
  const over = data.forecast.filter((day) => tripsOf(day, vehicleClass) > capacity);
  const worst = [...over].sort(
    (left, right) => tripsOf(right, vehicleClass) - tripsOf(left, vehicleClass),
  )[0];
  const names = over.map(weekLabel);
  const focus = worst ?? data.forecast[0];
  const idle = data.fleet[vehicleClass].vehicles - data.fleet[vehicleClass].available;

  // The latest observed day against the weeks before it.
  const latest = data.history.at(-1);
  const earlier = data.history.slice(0, -1);
  const mean =
    earlier.length === 0
      ? 0
      : earlier.reduce((sum, day) => sum + volumeOf(day, vehicleClass), 0) / earlier.length;
  const drift =
    latest && mean > 0 ? Math.round((volumeOf(latest, vehicleClass) / mean - 1) * 100) : 0;

  return {
    vehicleClass,
    weekday: weekdayName(date),
    depots: [{ id: 'all', name: data.depotId }],
    capacity,
    weeks,
    events: data.forecast.flatMap((day) => [
      ...(day.isPayday
        ? [{ week: weekLabel(day), label: `${weekLabel(day)} payday`, kind: 'payday' as const }]
        : []),
      ...(day.festival
        ? [
            {
              week: weekLabel(day),
              label: `${weekLabel(day)} ${day.festival}`,
              kind: 'calendar' as const,
            },
          ]
        : []),
    ]),
    insight:
      data.history.length === 0
        ? 'There is no order history yet, so the forecast has nothing to project from.'
        : names.length === 0
          ? 'No week goes above what the fleet can run.'
          : `${names.length === 1 ? 'One week goes' : `${names.length} weeks go`} above what the fleet can run: ${
              names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]
            }.`,
    gap: worst
      ? {
          week: weekLabel(worst),
          trips: tripsOf(worst, vehicleClass) - capacity,
          detail: `${weekLabel(worst)} · predicted ${tripsOf(worst, vehicleClass)} ${label} trips vs ${capacity} the fleet can run.`,
        }
      : null,
    balance: {
      week: focus ? weekLabel(focus) : '—',
      rows: focus
        ? [
            {
              key: 'reefer-needed',
              label: 'Reefer needed',
              value: tripsOf(focus, 'reefer'),
              predicted: true,
            },
            {
              key: 'reefer-available',
              label: 'Reefer available',
              value: capacityOf('reefer'),
              predicted: false,
            },
            {
              key: 'dry-needed',
              label: 'Dry needed',
              value: tripsOf(focus, 'dry'),
              predicted: true,
            },
            {
              key: 'dry-available',
              label: 'Dry available',
              value: capacityOf('dry'),
              predicted: false,
            },
          ]
        : [],
    },
    // Suggestions follow from the numbers above; the dispatcher decides.
    actions: [
      ...(worst && idle > 0
        ? [
            {
              id: 'workshop',
              title: `Return ${idle === 1 ? 'the' : `${idle}`} ${label} ${idle === 1 ? 'vehicle' : 'vehicles'} in the workshop`,
              detail: `Each adds ${TRIPS_PER_VEHICLE} trips a day · needed by ${weekLabel(worst)}`,
            },
          ]
        : []),
      ...(worst
        ? [
            {
              id: 'cover',
              title: `Cover ${tripsOf(worst, vehicleClass) - capacity} more ${label} ${tripsOf(worst, vehicleClass) - capacity === 1 ? 'trip' : 'trips'}`,
              detail: `${weekLabel(worst)} · hire, or move demand to a quieter day`,
            },
          ]
        : []),
    ],
    anomaly:
      latest && Math.abs(drift) >= ANOMALY_PERCENT
        ? {
            week: weekLabel(latest),
            title: `${label === 'reefer' ? 'Chilled' : 'Dry'} demand ran ${Math.abs(drift)}% ${drift > 0 ? 'above' : 'below'} the recent average`,
            bars: data.history.slice(-OBSERVED_WEEKS).map((day) => ({
              week: weekLabel(day),
              percent: Math.round((volumeOf(day, vehicleClass) / mean) * 100),
            })),
            evidence: `Evidence: ${Math.round(volumeOf(latest, vehicleClass))} m³ on ${latest.date} against a ${earlier.length}-week average of ${Math.round(mean)} m³ for the same weekday.`,
          }
        : null,
  };
}

const minutes = (value: string) => {
  const [hours = 0, mins = 0] = value.split(':').map(Number);
  return hours * 60 + mins;
};
/** A receiving window under three hours leaves little room for a late start. */
const TIGHT_WINDOW_MIN = 180;

function accessOf(outlet: Outlet): OutletAccess | null {
  if (outlet.parkingConstraint === 'van_only') return 'van_only';
  if (outlet.mallWindow !== null) return 'mall_window';
  if (minutes(outlet.window.close) - minutes(outlet.window.open) < TIGHT_WINDOW_MIN) {
    return 'tight_window';
  }
  return null;
}

const outletName = (outlet: Outlet) => `${outlet.brand} ${outlet.district}`;
const list = (value: string | null) => value?.split(',').filter(Boolean) ?? [];

async function directory(query: URLSearchParams): Promise<z.infer<typeof outletDirectorySchema>> {
  const [outlets, history] = await Promise.all([
    http('/outlets', outletListResponseSchema),
    http('/outlets/history', outletHistoryListSchema),
  ]);
  const past = new Map(history.items.map((item) => [item.outletId, item]));
  const rows: OutletRow[] = outlets.items.map((outlet) => ({
    code: outlet.id,
    name: outletName(outlet),
    brand: outlet.brand,
    depot: outlet.depotId,
    window: outlet.window,
    access: accessOf(outlet),
    arrivals: past.get(outlet.id)?.arrivals ?? [],
    deferrals: past.get(outlet.id)?.deferrals ?? [],
  }));
  const depot = query.get('depot');
  const term = query.get('q')?.trim().toLowerCase() ?? '';
  const brands = list(query.get('brand'));
  const access = list(query.get('access'));
  const limit = Number(query.get('limit')) || 50;
  const matching = rows.filter(
    (row) =>
      (!depot || row.depot === depot) &&
      (term === '' || `${row.code} ${row.name}`.toLowerCase().includes(term)) &&
      (brands.length === 0 || brands.includes(row.brand)) &&
      (access.length === 0 || (row.access !== null && access.includes(row.access))),
  );
  return {
    total: rows.length,
    depots: [...new Set(rows.map((row) => row.depot))].sort(),
    matching: matching.length,
    items: matching.slice(0, limit),
  };
}

const dockNotes: Record<Outlet['dockType'], string> = {
  rear_dock: 'Unload at the rear dock',
  street: 'Street-side unloading',
  mall_bay: 'Unload in the mall bay',
};

async function profile(
  code: string,
  query: URLSearchParams,
): Promise<z.infer<typeof outletProfileSchema>> {
  const date = query.get('date') ?? '';
  const [outlets, facts] = await Promise.all([
    http('/outlets', outletListResponseSchema),
    http(`/outlets/${code}/profile?date=${date}`, outletProfileFactsSchema),
  ]);
  const outlet = outlets.items.find((item) => item.id === code);
  if (!outlet) throw new HttpError(404, 'NOT_FOUND', 'This outlet is not in your depot.');
  const next = facts.nextDelivery;
  const state: OutletDelivery['state'] | null =
    next === null
      ? null
      : next.orderStatus === 'deferred'
        ? 'deferred'
        : next.orderStatus === 'receipt_confirmed'
          ? 'received'
          : next.stopStatus === 'arrived' || next.stopStatus === 'delivered'
            ? 'arrived'
            : next.orderStatus === 'dispatched'
              ? 'departed'
              : next.vehicleId
                ? 'allocated'
                : 'unallocated';
  const kilos = facts.volume.map((week) => week.kg);
  return {
    code: outlet.id,
    name: `Waypoint ${outletName(outlet)}`,
    brand: outlet.brand,
    depot: outlet.depotId,
    manager: facts.managerName,
    // The API holds no outlet phone number.
    phone: null,
    window: outlet.window,
    onTime: facts.onTime,
    deferred: facts.deferred,
    avgUnloadMinutes: facts.avgUnloadMinutes === null ? null : Math.round(facts.avgUnloadMinutes),
    notes: [
      {
        kind: 'access',
        text: `${dockNotes[outlet.dockType]}${outlet.parkingConstraint === 'van_only' ? ' · vans only' : ''}`,
      },
      {
        kind: 'receiving',
        text: outlet.mallWindow
          ? `Mall access ${outlet.mallWindow.open}–${outlet.mallWindow.close}`
          : `Receives ${outlet.window.open}–${outlet.window.close}`,
      },
    ],
    volume: {
      weekday: weekdayName(date),
      weeks: facts.volume.map((week) => ({ week: week.date.slice(5), kg: week.kg })),
      insight:
        kilos.length === 0
          ? 'No orders on this weekday yet.'
          : kilos.length === 1
            ? `${Math.round(kilos[0] ?? 0)} kg ordered on the one ${weekdayName(date)} on record.`
            : `Between ${Math.round(Math.min(...kilos))} and ${Math.round(Math.max(...kilos))} kg over ${kilos.length} ${weekdayName(date)}s.`,
    },
    nextDelivery:
      next === null || state === null
        ? null
        : {
            serviceDate: next.serviceDate,
            orderId: next.orderId,
            state,
            arrivedAt: next.arrivedAt,
            vehicleId: next.vehicleId,
            tripNo: next.tripNo,
            note: null,
          },
  };
}

export const insightSources: readonly Source[] = [
  ['GET', '/analytics/forecast', ({ query }) => forecast(query)],
  ['GET', '/outlets/directory', ({ query }) => directory(query)],
  ['GET', '/outlets/:code/profile', ({ params, query }) => profile(params.code ?? '', query)],
];
