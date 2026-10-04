import { randomBytes } from 'node:crypto';
import {
  auditLog,
  calendarDays,
  deferrals,
  depots,
  districtTravel,
  fuelLedger,
  notifications,
  orders,
  outlets,
  planningRuns,
  serviceAllowances,
  tripStops,
  trips,
  users,
  vehicleAvailability,
  vehicles,
} from '@waypoint/database';
import {
  autoAllocateResponseSchema,
  currentUserResponseSchema,
  deferralSchema,
  draftPlanResponseSchema,
  planningQueueResponseSchema,
  publishPlanResponseSchema,
  simulatePlanResponseSchema,
  type User,
} from '@waypoint/shared';
import { and, count, eq } from 'drizzle-orm';
import { argon2id } from 'hash-wasm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { client, cookiePair, SESSION_SECRET } from '../../../../test/http.ts';
import { createMigratedDatabase } from '../../../../test/postgres.ts';
import { buildApp } from '../../../app.ts';
import type { DomainEvent } from '../../../plugins/domain-events.ts';
import { createPlanningRepo, type PlanningRepo } from '../repo.ts';
import { createPlanningService } from '../service.ts';

const SERVICE_DATE = '2026-10-07';
const PINNED = '2026-10-06T10:00:00.000+05:30';
const PASSWORD = 'waypoint-demo';

describe('planning', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
  let dispatcher: { cookie: string; user: User };
  let loaderCookie: string;
  let driverCookie: string;
  let storeCookie: string;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    const passwordHash = await hashPassword(PASSWORD);
    await seedReference(passwordHash);
    app = await buildApp({
      db: database.db,
      logger: false,
      sessionSecret: SESSION_SECRET,
      secureCookies: false,
    });
    dispatcher = await login('planning.dispatcher@waypoint.test');
    loaderCookie = (await login('planning.loader@waypoint.test')).cookie;
    driverCookie = (await login('planning.driver@waypoint.test')).cookie;
    storeCookie = (await login('planning.store@waypoint.test')).cookie;
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  beforeEach(async () => {
    await database.db.delete(fuelLedger);
    await database.db.delete(tripStops);
    await database.db.delete(deferrals);
    await database.db.delete(trips);
    await database.db.delete(planningRuns);
    await database.db.delete(notifications);
    await database.db.delete(orders);
    await database.db.delete(vehicleAvailability);
    app.clock.pin(new Date(PINNED));
  });

  it('gives the dispatcher confirmed and carried-over deferred orders for the depot and date', async () => {
    const served = await insertOrder({
      requestedDate: '2026-10-01',
      status: 'delivered',
    });
    const previous = await insertOrder({ requestedDate: '2026-10-06', status: 'deferred' });
    const run = await database.db
      .insert(planningRuns)
      .values({ depotId: 'Peliyagoda', serviceDate: '2026-10-06' })
      .returning({ id: planningRuns.id });
    const runId = run[0]?.id;
    if (runId === undefined) throw new Error('Expected a history run');
    await database.db.insert(deferrals).values({
      orderId: previous,
      runId,
      reasonCode: 'WEIGHT_CAP',
      type: 'unavoidable',
      note: 'Skipped yesterday',
      actorId: dispatcher.user.id,
    });
    const ready = await insertOrder();
    const submitted = await insertOrder({ status: 'submitted' });
    const otherDepot = await insertOrder({ outletId: 'OUT211' });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/planning/runs/${SERVICE_DATE}/queue`,
      headers: { cookie: dispatcher.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = planningQueueResponseSchema.parse(response.json());
    expect(body.depotId).toBe('Peliyagoda');
    expect(body.planVersion).toBe(0);
    expect(body.total).toBe(body.items.length);
    // The order deferred by the previous run returns to this run's queue.
    expect(body.items.map((item) => item.id).sort()).toEqual([ready, previous].sort());
    expect(body.items.map((item) => item.id)).not.toContain(submitted);
    expect(body.items.map((item) => item.id)).not.toContain(otherDepot);
    expect(body.items.map((item) => item.id)).not.toContain(served);
    const item = body.items[0];
    expect(item).toMatchObject({
      brand: 'Fresh',
      temp: 'ambient',
      weightKg: 100,
      volumeM3: 1,
      deferredYesterday: true,
      daysSinceLastServed: 6,
      outlet: {
        id: 'OUT201',
        district: 'Colombo',
        depotId: 'Peliyagoda',
        parkingConstraint: 'normal',
        window: { open: '05:00', close: '18:00' },
        mallWindow: { open: '06:00', close: '11:00' },
      },
      previousDeferral: {
        reasonCode: 'WEIGHT_CAP',
        type: 'unavoidable',
        serviceDate: '2026-10-06',
      },
    });
  });

  it('confirms submitted orders into the queue once the 4 PM cutoff has passed', async () => {
    const submitted = await insertOrder({ status: 'submitted' });
    const queue = () =>
      app.inject({
        method: 'GET',
        url: `/api/v1/planning/runs/${SERVICE_DATE}/queue`,
        headers: { cookie: dispatcher.cookie },
      });

    // PINNED is 10:00 on the cutoff day, so the order is still open to the store.
    const before = planningQueueResponseSchema.parse(json(await queue(), 200));
    expect(before.items.map((item) => item.id)).not.toContain(submitted);

    app.clock.pin(new Date('2026-10-06T16:00:00.000+05:30'));
    const after = planningQueueResponseSchema.parse(json(await queue(), 200));
    expect(after.items.map((item) => item.id)).toEqual([submitted]);
    expect(after.items[0]).toMatchObject({
      status: 'confirmed',
      lockedAt: '2026-10-06T16:00:00.000+05:30',
    });

    // A second read does not confirm or notify again.
    planningQueueResponseSchema.parse(json(await queue(), 200));
    const store = await database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'planning.store@waypoint.test'));
    const notes = await database.db
      .select()
      .from(notifications)
      .where(eq(notifications.entityId, submitted));
    expect(notes).toEqual([
      expect.objectContaining({
        recipientId: store[0]?.id,
        type: 'order_confirmed',
        entityType: 'order',
      }),
    ]);
  });

  it('rejects every other role', async () => {
    const orderId = '00000000-0000-4000-8000-000000000099';
    const calls = [
      { method: 'GET' as const, url: `/api/v1/planning/runs/${SERVICE_DATE}/queue` },
      {
        method: 'POST' as const,
        url: `/api/v1/planning/runs/${SERVICE_DATE}/auto-allocate`,
        headers: { 'if-match': '0' },
      },
      {
        method: 'POST' as const,
        url: '/api/v1/planning/validate',
        payload: { serviceDate: SERVICE_DATE, depotId: 'Peliyagoda', trips: [] },
      },
      {
        method: 'PUT' as const,
        url: `/api/v1/planning/runs/${SERVICE_DATE}/allocations`,
        headers: { 'if-match': '0' },
        payload: { orderId, target: null },
      },
      {
        method: 'POST' as const,
        url: '/api/v1/deferrals',
        headers: { 'if-match': '0' },
        payload: {
          orderId,
          serviceDate: SERVICE_DATE,
          reasonCode: 'WEIGHT_CAP',
          type: 'unavoidable',
        },
      },
      {
        method: 'POST' as const,
        url: `/api/v1/planning/runs/${SERVICE_DATE}/simulate`,
        payload: { changes: [{ type: 'extra_reefer' }] },
      },
      {
        method: 'POST' as const,
        url: `/api/v1/planning/runs/${SERVICE_DATE}/publish`,
        headers: { 'if-match': '0' },
      },
    ];
    for (const cookie of [loaderCookie, driverCookie, storeCookie]) {
      for (const call of calls) {
        const response = await app.inject({
          ...call,
          headers: { ...call.headers, cookie },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      }
    }
    const anonymous = await app.inject({
      method: 'GET',
      url: `/api/v1/planning/runs/${SERVICE_DATE}/queue`,
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('accepts a manual assignment, a move, and a return to the queue', async () => {
    const orderId = await insertOrder();
    const assigned = draftPlanResponseSchema.parse(
      json(
        await allocate(0, {
          orderId,
          target: { vehicleId: 'VEH201', tripNo: 1 },
        }),
        200,
      ),
    );
    expect(assigned.planVersion).toBe(1);
    expect(assigned.trips).toEqual([
      expect.objectContaining({
        vehicleId: 'VEH201',
        tripNo: 1,
        stops: [expect.objectContaining({ orderId, seq: 1 })],
      }),
    ]);
    expect(assigned.deferred).toEqual([]);

    const moved = draftPlanResponseSchema.parse(
      json(
        await allocate(1, {
          orderId,
          target: { vehicleId: 'VEH202', tripNo: 1 },
        }),
        200,
      ),
    );
    expect(moved.planVersion).toBe(2);
    expect(moved.trips.map((trip) => trip.vehicleId)).toEqual(['VEH202']);

    const removed = draftPlanResponseSchema.parse(
      json(await allocate(2, { orderId, target: null }), 200),
    );
    expect(removed.planVersion).toBe(3);
    expect(removed.trips).toEqual([]);
    expect(removed.deferred.map((item) => item.orderId)).toEqual([orderId]);
    const row = await database.db.select().from(orders).where(eq(orders.id, orderId));
    expect(row[0]?.status).toBe('confirmed');
  });

  it('rejects a chilled order on a dry vehicle', async () => {
    const orderId = await insertOrder({ temp: 'chilled' });
    await expectRule(orderId, 'VEH201', 'REEFER_REQUIRED');
  });

  it('rejects a van-only outlet on a truck', async () => {
    const orderId = await insertOrder({ outletId: 'OUT202' });
    await expectRule(orderId, 'VEH201', 'VAN_REQUIRED');
  });

  it('rejects a trip that exceeds vehicle weight', async () => {
    const orderId = await insertOrder({ weightKg: 5_000 });
    await expectRule(orderId, 'VEH201', 'WEIGHT_CAP');
  });

  it('rejects a trip that exceeds vehicle volume', async () => {
    const orderId = await insertOrder({ volumeM3: 40 });
    await expectRule(orderId, 'VEH201', 'VOLUME_CAP');
  });

  it('rejects a vehicle from the wrong depot', async () => {
    const orderId = await insertOrder();
    await expectRule(orderId, 'VEH211', 'WRONG_DEPOT');
  });

  it('rejects a third trip for one vehicle', async () => {
    const first = await insertOrder();
    const second = await insertOrder();
    const third = await insertOrder();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/planning/validate',
      headers: { cookie: dispatcher.cookie },
      payload: {
        serviceDate: SERVICE_DATE,
        depotId: 'Peliyagoda',
        trips: [
          { vehicleId: 'VEH201', tripNo: 1, orderIds: [first] },
          { vehicleId: 'VEH201', tripNo: 2, orderIds: [second] },
          { vehicleId: 'VEH201', tripNo: 1, orderIds: [third] },
        ],
      },
    });
    expectViolation(response, 'TRIP_LIMIT');
    expect(await tripCount()).toBe(0);
  });

  it('rejects a trip that exceeds the weekly fuel quota', async () => {
    const orderId = await insertOrder();
    await expectRule(orderId, 'VEH205', 'FUEL_QUOTA');
  });

  it('returns only feasible trips from the auto allocator', async () => {
    const chilled = await insertOrder({ temp: 'chilled' });
    const ambient = await insertOrder();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/planning/runs/${SERVICE_DATE}/auto-allocate`,
      headers: { cookie: dispatcher.cookie, 'if-match': '0' },
    });
    expect(response.statusCode).toBe(200);
    const body = autoAllocateResponseSchema.parse(response.json());
    const chilledTrip = body.trips.find((trip) =>
      trip.stops.some((stop) => stop.orderId === chilled),
    );
    const ambientTrip = body.trips.find((trip) =>
      trip.stops.some((stop) => stop.orderId === ambient),
    );
    expect(chilledTrip?.vehicleId).toBe('VEH202');
    expect(ambientTrip?.vehicleId).not.toBeUndefined();
    expect(body.deferred.map((item) => item.orderId)).not.toContain(chilled);
    expect(body.deferred.map((item) => item.orderId)).not.toContain(ambient);
    expect(body.metrics.servedOrders).toBe(2);
    const run = await database.db.select().from(planningRuns);
    expect(run[0]?.status).toBe('open');
    expect(await database.db.select().from(fuelLedger)).toEqual([]);
    expect(await database.db.select().from(deferrals)).toEqual([]);
    const stored = await database.db.select({ status: orders.status }).from(orders);
    expect(stored.every((row) => row.status === 'confirmed')).toBe(true);
  });

  it('runs what-if scenarios without writing', async () => {
    await database.db.insert(vehicleAvailability).values({
      vehicleId: 'VEH202',
      date: SERVICE_DATE,
      status: 'in_workshop',
    });
    const chilled = await insertOrder({ temp: 'chilled', volumeM3: 1, weightKg: 100 });
    const ambient = await insertOrder({ volumeM3: 8, weightKg: 100 });
    const before = await snapshot();

    const unavailable = simulatePlanResponseSchema.parse(
      json(
        await app.inject({
          method: 'POST',
          url: `/api/v1/planning/runs/${SERVICE_DATE}/simulate`,
          headers: { cookie: dispatcher.cookie },
          payload: {
            changes: [
              { type: 'vehicle_unavailable', vehicleId: 'VEH201' },
              { type: 'vehicle_unavailable', vehicleId: 'VEH203' },
              { type: 'vehicle_unavailable', vehicleId: 'VEH205' },
            ],
          },
        }),
        200,
      ),
    );
    expect(unavailable.scenario.servedOrders).toBe(0);
    expect(unavailable.scenario.deferredOrders).toBe(2);

    const extra = simulatePlanResponseSchema.parse(
      json(
        await app.inject({
          method: 'POST',
          url: `/api/v1/planning/runs/${SERVICE_DATE}/simulate`,
          headers: { cookie: dispatcher.cookie },
          payload: { changes: [{ type: 'extra_reefer' }] },
        }),
        200,
      ),
    );
    expect(extra.baseline.deferredOrders).toBeGreaterThan(extra.scenario.deferredOrders);
    expect(extra.scenario.servedOrders).toBe(2);

    const demand = simulatePlanResponseSchema.parse(
      json(
        await app.inject({
          method: 'POST',
          url: `/api/v1/planning/runs/${SERVICE_DATE}/simulate`,
          headers: { cookie: dispatcher.cookie },
          payload: { changes: [{ type: 'fresh_demand', factor: 1.5 }] },
        }),
        200,
      ),
    );
    expect(demand.scenario.servedOrders).toBeLessThan(demand.baseline.servedOrders);

    expect(await snapshot()).toEqual(before);
    const stored = await database.db.select({ id: orders.id, status: orders.status }).from(orders);
    expect(stored.map((row) => row.id).sort()).toEqual([ambient, chilled].sort());
    expect(stored.every((row) => row.status === 'confirmed')).toBe(true);
  });

  it('publishes trips, stops, deferrals and fuel in one transaction', async () => {
    const { served, deferred, published } = await publishDay();
    expect(published.planVersion).toBe(2);
    expect(published.publishedAt).toBe(PINNED);
    const run = await database.db.select().from(planningRuns);
    expect(run[0]?.status).toBe('published');
    expect(run[0]?.publishedBy).toBe(dispatcher.user.id);
    const tripRows = await database.db.select().from(trips);
    expect(tripRows.every((trip) => trip.status === 'published')).toBe(true);
    expect(tripRows.length).toBeGreaterThan(0);
    const stops = await database.db.select().from(tripStops);
    expect(stops.map((stop) => stop.orderId)).toContain(served);
    expect(stops.map((stop) => stop.orderId)).not.toContain(deferred);
    const skipped = await database.db.select().from(deferrals);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      orderId: deferred,
      actorId: dispatcher.user.id,
      reasonCode: 'WEIGHT_CAP',
      type: 'unavoidable',
    });
    expect(skipped[0]?.note?.length).toBeGreaterThan(0);
    expect(skipped[0]?.createdAt?.getTime()).toBe(new Date(PINNED).getTime());
    const fuel = await database.db.select().from(fuelLedger);
    expect(fuel.length).toBe(tripRows.length);
    expect(fuel.every((row) => row.litres > 0)).toBe(true);
    const notes = await database.db.select().from(notifications);
    const store = await database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'planning.store@waypoint.test'));
    expect(notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipientId: store[0]?.id,
          type: 'order_deferred',
          priority: 'high',
          entityType: 'order',
          entityId: deferred,
        }),
        expect.objectContaining({
          type: 'plan_published',
          priority: 'high',
          entityType: 'trip',
        }),
      ]),
    );
    const statuses = await database.db
      .select({ id: orders.id, status: orders.status })
      .from(orders);
    expect(statuses).toEqual(
      expect.arrayContaining([
        { id: served, status: 'allocated' },
        { id: deferred, status: 'deferred' },
      ]),
    );
  });

  it('serves an order deferred by the previous run when this run is published', async () => {
    const carried = await insertOrder({ requestedDate: '2026-10-06', status: 'deferred' });
    const history = await database.db
      .insert(planningRuns)
      .values({ depotId: 'Peliyagoda', serviceDate: '2026-10-06' })
      .returning({ id: planningRuns.id });
    const historyRunId = history[0]?.id;
    if (historyRunId === undefined) throw new Error('Expected a history run');
    await database.db.insert(deferrals).values({
      orderId: carried,
      runId: historyRunId,
      reasonCode: 'WEIGHT_CAP',
      type: 'prioritized',
      note: 'Skipped yesterday',
      actorId: dispatcher.user.id,
    });
    const allocated = await app.inject({
      method: 'POST',
      url: `/api/v1/planning/runs/${SERVICE_DATE}/auto-allocate`,
      headers: { cookie: dispatcher.cookie, 'if-match': '0' },
    });
    expect(allocated.statusCode).toBe(200);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/planning/runs/${SERVICE_DATE}/publish`,
      headers: { cookie: dispatcher.cookie, 'if-match': '1' },
    });
    expect(response.statusCode).toBe(200);
    const stored = await database.db.select().from(orders).where(eq(orders.id, carried));
    expect(stored[0]?.status).toBe('allocated');
    const stops = await database.db.select().from(tripStops);
    expect(stops.map((stop) => stop.orderId)).toContain(carried);
  });

  it('rolls back a failed publish', async () => {
    const orderId = await insertOrder();
    await app.inject({
      method: 'POST',
      url: `/api/v1/planning/runs/${SERVICE_DATE}/auto-allocate`,
      headers: { cookie: dispatcher.cookie, 'if-match': '0' },
    });
    await database.db.insert(vehicleAvailability).values(
      ['VEH201', 'VEH202', 'VEH203', 'VEH205'].map((vehicleId) => ({
        vehicleId,
        date: SERVICE_DATE,
        status: 'in_workshop' as const,
      })),
    );
    const seen: DomainEvent[] = [];
    const stop = app.domainEvents.subscribe((event) => {
      seen.push(event);
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/planning/runs/${SERVICE_DATE}/publish`,
      headers: { cookie: dispatcher.cookie, 'if-match': '1' },
    });
    stop();
    expectViolation(response, 'VEHICLE_UNAVAILABLE');
    expect(seen).toEqual([]);
    const run = await database.db.select().from(planningRuns);
    expect(run[0]?.status).toBe('open');
    expect(run[0]?.planVersion).toBe(1);
    expect(await database.db.select().from(fuelLedger)).toEqual([]);
    expect(await database.db.select().from(deferrals)).toEqual([]);
    expect(await database.db.select().from(notifications)).toEqual([]);
    const publishedAudit = (await database.db.select().from(auditLog)).filter(
      (row) => row.entityId === run[0]?.id && row.action === 'plan.published',
    );
    expect(publishedAudit).toEqual([]);
    const tripRows = await database.db.select({ status: trips.status }).from(trips);
    expect(tripRows.every((trip) => trip.status === 'planned')).toBe(true);
    const order = await database.db.select({ status: orders.status }).from(orders);
    expect(order[0]?.status).toBe('confirmed');
    expect(orderId).toBeTruthy();
  });

  it('rolls back trips, stops, deferrals and fuel when publish fails after they are staged', async () => {
    const orderId = await insertOrder();
    const allocated = await app.inject({
      method: 'POST',
      url: `/api/v1/planning/runs/${SERVICE_DATE}/auto-allocate`,
      headers: { cookie: dispatcher.cookie, 'if-match': '0' },
    });
    expect(allocated.statusCode).toBe(200);
    const before = await snapshot();
    const tripIds = (await database.db.select({ id: trips.id }).from(trips)).map((row) => row.id);
    const base = createPlanningRepo();
    const failing: PlanningRepo = {
      ...base,
      async insertFuel(db, rows) {
        await base.insertFuel(db, rows);
        throw new Error('forced publish failure');
      },
    };
    const service = createPlanningService(
      database.db,
      app.audit,
      app.domainEvents,
      app.clock,
      failing,
    );
    const seen: DomainEvent[] = [];
    const stop = app.domainEvents.subscribe((event) => {
      seen.push(event);
    });
    await expect(service.publish(dispatcher.user, SERVICE_DATE, 1)).rejects.toThrow(
      'forced publish failure',
    );
    stop();
    expect(seen).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect((await database.db.select({ id: trips.id }).from(trips)).map((row) => row.id)).toEqual(
      tripIds,
    );
    const run = await database.db.select().from(planningRuns);
    expect(run[0]?.status).toBe('open');
    expect(run[0]?.planVersion).toBe(1);
    expect(await database.db.select().from(fuelLedger)).toEqual([]);
    expect(await database.db.select().from(deferrals)).toEqual([]);
    expect(await database.db.select().from(notifications)).toEqual([]);
    const stored = await database.db.select({ id: orders.id, status: orders.status }).from(orders);
    expect(stored).toEqual([{ id: orderId, status: 'confirmed' }]);
    const tripRows = await database.db.select({ status: trips.status }).from(trips);
    expect(tripRows.every((trip) => trip.status === 'planned')).toBe(true);
  });

  it('records a dispatcher deferral from the planning engine and leaves the queue', async () => {
    const orderId = await insertOrder({ weightKg: 5_000 });
    const kept = await insertOrder();
    const assigned = await allocate(0, {
      orderId: kept,
      target: { vehicleId: 'VEH201', tripNo: 1 },
    });
    expect(assigned.statusCode).toBe(200);
    const mismatched = await app.inject({
      method: 'POST',
      url: '/api/v1/deferrals',
      headers: { cookie: dispatcher.cookie, 'if-match': '1' },
      payload: {
        orderId,
        serviceDate: SERVICE_DATE,
        reasonCode: 'FUEL_QUOTA',
        type: 'prioritized',
      },
    });
    expectViolation(mismatched, 'WEIGHT_CAP');
    expect(await database.db.select().from(deferrals)).toEqual([]);
    expect(await database.db.select().from(notifications)).toEqual([]);

    const seen: DomainEvent[] = [];
    const stop = app.domainEvents.subscribe((event) => {
      seen.push(event);
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/deferrals',
      headers: { cookie: dispatcher.cookie, 'if-match': '1' },
      payload: {
        orderId,
        serviceDate: SERVICE_DATE,
        reasonCode: 'WEIGHT_CAP',
        type: 'unavoidable',
        note: 'Hold for tomorrow',
      },
    });
    stop();
    expect(response.statusCode).toBe(200);
    const body = deferralSchema.parse(response.json());
    const store = await database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'planning.store@waypoint.test'));
    expect(body).toMatchObject({
      orderId,
      reasonCode: 'WEIGHT_CAP',
      type: 'unavoidable',
      actorId: dispatcher.user.id,
      createdAt: PINNED,
    });
    expect(body.note).toContain('Hold for tomorrow');
    const stored = await database.db.select().from(deferrals);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.orderId).toBe(orderId);
    const statuses = await database.db
      .select({ id: orders.id, status: orders.status })
      .from(orders);
    expect(statuses).toEqual(
      expect.arrayContaining([
        { id: orderId, status: 'deferred' },
        { id: kept, status: 'confirmed' },
      ]),
    );
    const keptStops = await database.db.select({ orderId: tripStops.orderId }).from(tripStops);
    expect(keptStops.map((stopRow) => stopRow.orderId)).toEqual([kept]);
    const run = await database.db.select().from(planningRuns);
    expect(run[0]?.status).toBe('open');
    expect(run[0]?.planVersion).toBe(2);
    expect(await database.db.select().from(fuelLedger)).toEqual([]);
    const notes = await database.db.select().from(notifications);
    expect(notes).toEqual([
      expect.objectContaining({
        recipientId: store[0]?.id,
        type: 'order_deferred',
        priority: 'high',
        entityId: orderId,
      }),
    ]);
    const audit = await database.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'order.deferred'), eq(auditLog.entityId, orderId)));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.after).toMatchObject({ reasonCode: 'WEIGHT_CAP', type: 'unavoidable' });
    expect(seen.map((event) => event.type)).toEqual(['order.deferred']);
    const queue = planningQueueResponseSchema.parse(
      json(
        await app.inject({
          method: 'GET',
          url: `/api/v1/planning/runs/${SERVICE_DATE}/queue`,
          headers: { cookie: dispatcher.cookie },
        }),
        200,
      ),
    );
    expect(queue.items.map((item) => item.id)).toEqual([kept]);
    expect(queue.planVersion).toBe(2);

    const stale = await app.inject({
      method: 'POST',
      url: '/api/v1/deferrals',
      headers: { cookie: dispatcher.cookie, 'if-match': '1' },
      payload: {
        orderId: kept,
        serviceDate: SERVICE_DATE,
        reasonCode: 'VOLUME_CAP',
        type: 'prioritized',
      },
    });
    expect(stale.statusCode).toBe(409);
  });

  it('returns 409 when the plan version is stale', async () => {
    await insertOrder();
    await app.inject({
      method: 'POST',
      url: `/api/v1/planning/runs/${SERVICE_DATE}/auto-allocate`,
      headers: { cookie: dispatcher.cookie, 'if-match': '0' },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/planning/runs/${SERVICE_DATE}/publish`,
      headers: { cookie: dispatcher.cookie, 'if-match': '0' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
    const run = await database.db.select().from(planningRuns);
    expect(run[0]?.status).toBe('open');
    expect(run[0]?.planVersion).toBe(1);
    expect(await database.db.select().from(fuelLedger)).toEqual([]);
  });

  it('keeps every eligible order served or explicitly deferred', async () => {
    const { served, deferred } = await publishDay();
    const statuses = await database.db
      .select({ id: orders.id, status: orders.status })
      .from(orders);
    const servedIds = statuses.filter((row) => row.status === 'allocated').map((row) => row.id);
    const deferredIds = statuses.filter((row) => row.status === 'deferred').map((row) => row.id);
    expect(servedIds).toEqual([served]);
    expect(deferredIds).toEqual([deferred]);
    expect([...servedIds, ...deferredIds].sort()).toEqual([served, deferred].sort());
    const reasons = await database.db.select({ orderId: deferrals.orderId }).from(deferrals);
    expect(reasons.map((row) => row.orderId)).toEqual(deferredIds);
  });

  it('writes audit events for allocation and publish', async () => {
    const existing = await database.db.select({ id: auditLog.id }).from(auditLog);
    const seen = new Set(existing.map((row) => row.id));
    const { deferred } = await publishDay();
    const rows = (await database.db.select().from(auditLog)).filter((row) => !seen.has(row.id));
    const actions = rows.map((row) => row.action);
    expect(actions).toContain('plan.auto_allocated');
    expect(actions).toContain('plan.published');
    expect(actions).toContain('order.deferred');
    for (const row of rows) {
      expect(row.actorId).toBe(dispatcher.user.id);
      expect(row.role).toBe('dispatcher');
      expect(row.createdAt?.getTime()).toBe(new Date(PINNED).getTime());
    }
    const deferredAudit = rows.find((row) => row.action === 'order.deferred');
    expect(deferredAudit?.entityType).toBe('order');
    expect(deferredAudit?.entityId).toBe(deferred);
    expect(deferredAudit?.after).toMatchObject({ reasonCode: 'WEIGHT_CAP', type: 'unavoidable' });
    const publishedAudit = rows.find((row) => row.action === 'plan.published');
    expect(publishedAudit?.entityType).toBe('planning_run');
    expect(publishedAudit?.before).toMatchObject({ status: 'open' });
    expect(publishedAudit?.after).toMatchObject({ status: 'published' });
  });

  async function publishDay(): Promise<{
    served: string;
    deferred: string;
    published: { planVersion: number; publishedAt: string };
  }> {
    const served = await insertOrder();
    const deferred = await insertOrder({ weightKg: 5_000 });
    const allocated = await app.inject({
      method: 'POST',
      url: `/api/v1/planning/runs/${SERVICE_DATE}/auto-allocate`,
      headers: { cookie: dispatcher.cookie, 'if-match': '0' },
    });
    expect(allocated.statusCode).toBe(200);
    expect(await database.db.select().from(fuelLedger)).toEqual([]);
    expect(await database.db.select().from(deferrals)).toEqual([]);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/planning/runs/${SERVICE_DATE}/publish`,
      headers: { cookie: dispatcher.cookie, 'if-match': '1' },
    });
    expect(response.statusCode).toBe(200);
    return { served, deferred, published: publishPlanResponseSchema.parse(response.json()) };
  }

  async function expectRule(orderId: string, vehicleId: string, rule: string): Promise<void> {
    const response = await allocate(0, {
      orderId,
      target: { vehicleId, tripNo: 1 },
    });
    expectViolation(response, rule);
    expect(await tripCount()).toBe(0);
    const queue = planningQueueResponseSchema.parse(
      json(
        await app.inject({
          method: 'GET',
          url: `/api/v1/planning/runs/${SERVICE_DATE}/queue`,
          headers: { cookie: dispatcher.cookie },
        }),
        200,
      ),
    );
    expect(queue.planVersion).toBe(0);
  }

  function allocate(version: number, payload: Record<string, unknown>) {
    return app.inject({
      method: 'PUT',
      url: `/api/v1/planning/runs/${SERVICE_DATE}/allocations`,
      headers: { cookie: dispatcher.cookie, 'if-match': String(version) },
      payload,
    });
  }

  async function insertOrder(
    overrides: {
      outletId?: string;
      temp?: 'ambient' | 'chilled';
      requestedDate?: string;
      weightKg?: number;
      volumeM3?: number;
      status?: 'confirmed' | 'submitted' | 'delivered' | 'deferred';
    } = {},
  ): Promise<string> {
    const outletId = overrides.outletId ?? 'OUT201';
    const rows = await database.db
      .insert(orders)
      .values({
        outletId,
        brand: 'Fresh',
        temp: overrides.temp ?? 'ambient',
        requestedDate: overrides.requestedDate ?? SERVICE_DATE,
        units: 4,
        weightKg: overrides.weightKg ?? 100,
        volumeM3: overrides.volumeM3 ?? 1,
        status: overrides.status ?? 'confirmed',
      })
      .returning({ id: orders.id });
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('Expected an order id');
    return id;
  }

  async function tripCount(): Promise<number> {
    const rows = await database.db.select({ total: count() }).from(trips);
    return Number(rows[0]?.total ?? 0);
  }

  async function snapshot(): Promise<Record<string, number>> {
    const tables = [planningRuns, trips, tripStops, deferrals, fuelLedger, auditLog, notifications];
    const totals: number[] = [];
    for (const table of tables) {
      const rows = await database.db.select({ total: count() }).from(table);
      totals.push(Number(rows[0]?.total ?? 0));
    }
    return {
      runs: totals[0] ?? 0,
      trips: totals[1] ?? 0,
      stops: totals[2] ?? 0,
      deferrals: totals[3] ?? 0,
      fuel: totals[4] ?? 0,
      audits: totals[5] ?? 0,
      notifications: totals[6] ?? 0,
    };
  }

  async function login(email: string): Promise<{ cookie: string; user: User }> {
    const response = await app.inject({
      ...client(),
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return {
      cookie: cookiePair(response),
      user: currentUserResponseSchema.parse(response.json()).user,
    };
  }

  async function seedReference(passwordHash: string): Promise<void> {
    await database.db.insert(depots).values([
      { id: 'Peliyagoda', name: 'Peliyagoda' },
      { id: 'Kandy', name: 'Kandy' },
    ]);
    await database.db.insert(districtTravel).values([
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
    await database.db
      .insert(outlets)
      .values([
        outlet('OUT201', 'Colombo', 'Peliyagoda', 'normal', '06:00:00', '11:00:00'),
        outlet('OUT202', 'Colombo', 'Peliyagoda', 'van_only', null, null),
        outlet('OUT211', 'Kandy', 'Kandy', 'normal', null, null),
      ]);
    await database.db
      .insert(vehicles)
      .values([
        vehicle('VEH201', 'Peliyagoda', 'truck', 'ambient', 2_000, 10, 200),
        vehicle('VEH202', 'Peliyagoda', 'truck', 'reefer', 2_000, 10, 200),
        vehicle('VEH203', 'Peliyagoda', 'van', 'ambient', 800, 4, 100),
        vehicle('VEH205', 'Peliyagoda', 'truck', 'ambient', 2_000, 10, 0.01),
        vehicle('VEH211', 'Kandy', 'truck', 'ambient', 2_000, 10, 200),
      ]);
    const brands = ['Fresh', 'Style', 'Tech'] as const;
    const docks = ['street', 'rear_dock', 'mall_bay'] as const;
    await database.db
      .insert(serviceAllowances)
      .values(
        brands.flatMap((brand) => docks.map((dockType) => ({ brand, dockType, minutes: 15 }))),
      );
    const days = [];
    let cursor = '2026-09-28';
    while (cursor <= '2026-10-12') {
      days.push(calendarRow(cursor));
      cursor = addIsoDays(cursor, 1);
    }
    await database.db.insert(calendarDays).values(days);
    await database.db.insert(users).values([
      {
        name: 'Peliyagoda Dispatcher',
        email: 'planning.dispatcher@waypoint.test',
        passwordHash,
        role: 'dispatcher' as const,
        depotId: 'Peliyagoda',
      },
      {
        name: 'Peliyagoda Loader',
        email: 'planning.loader@waypoint.test',
        passwordHash,
        role: 'loader' as const,
        depotId: 'Peliyagoda',
      },
      {
        name: 'Van Driver',
        email: 'planning.driver@waypoint.test',
        passwordHash,
        role: 'driver' as const,
        vehicleId: 'VEH201',
      },
      {
        name: 'Store Manager',
        email: 'planning.store@waypoint.test',
        passwordHash,
        role: 'store_manager' as const,
        outletId: 'OUT201',
      },
    ]);
  }
});

function json(response: { statusCode: number; json: () => unknown }, status: number): unknown {
  expect(response.statusCode).toBe(status);
  return response.json();
}

function expectViolation(
  response: { statusCode: number; json: () => unknown },
  rule: string,
): void {
  expect(response.statusCode).toBe(422);
  const body = response.json() as { error: { code: string; violations?: { rule: string }[] } };
  expect(body.error.code).toBe('CONSTRAINT_VIOLATION');
  expect(body.error.violations?.some((item) => item.rule === rule)).toBe(true);
}

function outlet(
  id: string,
  district: string,
  depotId: string,
  parkingConstraint: 'normal' | 'van_only',
  mallOpen: string | null,
  mallClose: string | null,
) {
  return {
    id,
    brand: 'Fresh' as const,
    district,
    depotId,
    dockType: 'street' as const,
    parkingConstraint,
    windowOpen: '05:00:00',
    windowClose: '18:00:00',
    mallWindowOpen: mallOpen,
    mallWindowClose: mallClose,
  };
}

function vehicle(
  id: string,
  depotId: string,
  type: 'truck' | 'van',
  temp: 'ambient' | 'reefer',
  weightCapKg: number,
  volumeCapM3: number,
  weeklyFuelQuotaL: number,
) {
  return {
    id,
    type,
    temp,
    weightCapKg,
    volumeCapM3,
    fuelType: 'diesel',
    kmPerL: 10,
    weeklyFuelQuotaL,
    depotId,
  };
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

function addIsoDays(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Expected an ISO date, received ${iso}`);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function calendarRow(iso: string) {
  const [year, month, day] = iso.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Expected an ISO date, received ${iso}`);
  }
  const utc = new Date(Date.UTC(year, month - 1, day));
  const jsDay = utc.getUTCDay();
  const dow = jsDay === 0 ? 6 : jsDay - 1;
  const isoWeekday = jsDay === 0 ? 7 : jsDay;
  const thursday = new Date(utc);
  thursday.setUTCDate(utc.getUTCDate() + 4 - isoWeekday);
  const isoYear = thursday.getUTCFullYear();
  const weekOne = new Date(Date.UTC(isoYear, 0, 4));
  const weekOneDow = weekOne.getUTCDay() || 7;
  weekOne.setUTCDate(weekOne.getUTCDate() - (weekOneDow - 1));
  const isoWeek = Math.round((thursday.getTime() - weekOne.getTime()) / 86_400_000 / 7) + 1;
  return {
    date: iso,
    dow,
    isoYear,
    isoWeek,
    isPayday: false,
    festival: null,
    festivalRamp: 0,
    isHoliday: false,
    monsoon: false,
    isOperating: dow <= 5,
  };
}
