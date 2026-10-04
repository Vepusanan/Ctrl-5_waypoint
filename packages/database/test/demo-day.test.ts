import { describe, expect, it } from 'vitest';
import { DEMO_SERVICE_DATE, DEMO_USERS } from '../src/seed/constants.ts';
import { buildDemoDay } from '../src/seed/demo-day.ts';
import { syntheticReference } from '../src/seed/synthetic.ts';

const day = buildDemoDay(syntheticReference, DEMO_SERVICE_DATE);

describe('demo day', () => {
  it('is stable for a fixed seed', () => {
    expect(buildDemoDay(syntheticReference, DEMO_SERVICE_DATE)).toEqual(day);
  });

  it('seeds the four roles against Peliyagoda', () => {
    expect([...new Set(day.accounts.map((account) => account.role))].sort()).toEqual([
      'dispatcher',
      'driver',
      'loader',
      'store_manager',
    ]);
    expect(day.accounts.map((account) => account.email)).toEqual(
      expect.arrayContaining([
        DEMO_USERS.dispatcher.email,
        DEMO_USERS.driver.email,
        DEMO_USERS.loader.email,
        DEMO_USERS.storeManager.email,
      ]),
    );
    // One driver per vehicle at the home depot, each bound to a different vehicle.
    const drivers = day.accounts.filter((account) => account.role === 'driver');
    const homeVehicles = syntheticReference.vehicles.filter(
      (vehicle) => vehicle.depotId === day.homeDepotId,
    );
    expect(drivers).toHaveLength(homeVehicles.length);
    expect(new Set(drivers.map((account) => account.vehicleId)).size).toBe(drivers.length);
    const driver = day.accounts.find((account) => account.role === 'driver');
    expect(driver?.vehicleId).toMatch(/^VEH\d{3}$/);
    const store = day.accounts.find((account) => account.role === 'store_manager');
    expect(store?.outletId).toMatch(/^OUT\d{3}$/);
  });

  it('gives the store manager an editable order before cutoff, drafts, and a free slot', () => {
    const store = day.accounts.find((account) => account.role === 'store_manager');
    const storeOrders = day.orders.filter((order) => order.outletId === store?.outletId);
    const thisRun = storeOrders.filter((order) => order.requestedDate === DEMO_SERVICE_DATE);
    // Still open at the 15:50 demo start; the 4 PM cutoff confirms it into this run.
    expect(thisRun).toEqual([
      expect.objectContaining({ temp: 'chilled', status: 'submitted', lockedAt: null }),
    ]);
    // The walkthrough places the store's Fresh dry order for this run.
    expect(thisRun.some((order) => order.temp === 'ambient')).toBe(false);
    const drafts = storeOrders.filter((order) => order.status === 'draft');
    expect(drafts.map((order) => order.temp).sort()).toEqual(['ambient', 'chilled']);
    expect(drafts.every((order) => order.requestedDate > DEMO_SERVICE_DATE)).toBe(true);
    expect(drafts.every((order) => order.submittedAt === null && order.lockedAt === null)).toBe(
      true,
    );
  });

  it('never places two active orders in one outlet, date and temperature slot', () => {
    const slots = day.orders
      .filter((order) => order.status !== 'cancelled')
      .map((order) => `${order.outletId}|${order.requestedDate}|${order.temp}`);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it('includes a van-only stop, a Style mall order, workshop vehicles, and a prior deferral', () => {
    const vanOnlyIds = new Set(
      syntheticReference.outlets
        .filter((outlet) => outlet.parkingConstraint === 'van_only')
        .map((outlet) => outlet.id),
    );
    expect(day.orders.some((order) => vanOnlyIds.has(order.outletId))).toBe(true);

    const mallIds = new Set(
      syntheticReference.outlets
        .filter((outlet) => outlet.brand === 'Style' && outlet.mallWindowOpen !== null)
        .map((outlet) => outlet.id),
    );
    expect(day.orders.some((order) => mallIds.has(order.outletId) && order.brand === 'Style')).toBe(
      true,
    );

    expect(day.vehicleAvailability.some((row) => row.status === 'in_workshop')).toBe(true);
    expect(day.orders.some((order) => order.status === 'deferred')).toBe(true);
    expect(day.deferral.reasonCode).toBe('VOLUME_CAP');
    expect(day.deferral.orderId).toBe(day.orders.find((order) => order.status === 'deferred')?.id);
  });

  it('asks for more chilled freight than the reefers still available can carry', () => {
    const workshop = new Set(
      day.vehicleAvailability
        .filter((row) => row.status === 'in_workshop')
        .map((row) => row.vehicleId),
    );
    const capacity = syntheticReference.vehicles
      .filter(
        (vehicle) =>
          vehicle.depotId === 'Peliyagoda' &&
          vehicle.temp === 'reefer' &&
          !workshop.has(vehicle.id),
      )
      .reduce(
        (total, vehicle) => ({
          weightKg: total.weightKg + vehicle.weightCapKg,
          volumeM3: total.volumeM3 + vehicle.volumeCapM3,
        }),
        { weightKg: 0, volumeM3: 0 },
      );
    const demand = day.orders
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
    expect(demand.volumeM3).toBeGreaterThan(capacity.volumeM3);
    expect(demand.weightKg).toBeGreaterThan(capacity.weightKg);
    expect(capacity.volumeM3).toBeGreaterThan(0);
  });
});
