import { randomBytes } from 'node:crypto';
import {
  auditLog,
  depots,
  districtTravel,
  loadingCounts,
  loadingIssues,
  loadingRecords,
  notifications,
  orders,
  outlets,
  planningRuns,
  tripStops,
  trips,
  users,
  vehicles,
} from '@waypoint/database';
import {
  currentUserResponseSchema,
  loadingIssueSchema,
  loadingStateSchema,
  type User,
} from '@waypoint/shared';
import { eq } from 'drizzle-orm';
import { argon2id } from 'hash-wasm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { client, cookiePair, SESSION_SECRET } from '../../../../test/http.ts';
import { createMigratedDatabase } from '../../../../test/postgres.ts';
import { buildApp } from '../../../app.ts';
import type { DomainEvent } from '../../../plugins/domain-events.ts';

const SERVICE_DATE = '2026-10-08';
const PINNED = '2026-10-07T09:30:00.000+05:30';
const PASSWORD = 'waypoint-demo';

describe('loading', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
  let dispatcher: { cookie: string; user: User };
  let loader: { cookie: string; user: User };
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
    dispatcher = await login('loading.dispatcher@waypoint.test');
    loader = await login('loading.loader@waypoint.test');
    driverCookie = (await login('loading.driver@waypoint.test')).cookie;
    storeCookie = (await login('loading.store@waypoint.test')).cookie;
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  beforeEach(async () => {
    await database.db.delete(notifications);
    await database.db.delete(loadingIssues);
    await database.db.delete(loadingRecords);
    await database.db.delete(tripStops);
    await database.db.delete(trips);
    await database.db.delete(orders);
    await database.db.delete(planningRuns);
    app.clock.pin(new Date(PINNED));
  });

  it('lets a loader start the load for their own depot', async () => {
    const trip = await insertTrip({
      stops: [
        { outletId: 'OUT301', temp: 'ambient', seq: 1 },
        { outletId: 'OUT302', temp: 'chilled', seq: 2 },
      ],
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${trip.tripId}/loading/start`,
      headers: { cookie: loader.cookie, 'if-match': '0' },
    });
    const state = loadingStateSchema.parse(json(response, 201));
    expect(state.status).toBe('in_progress');
    expect(state.loaderId).toBe(loader.user.id);
    expect(state.tripVersion).toBe(0);
    expect(state.planVersion).toBe(2);
    expect(state.acceptedTripVersion).toBe(0);
    expect(state.planStale).toBe(false);
    expect(state.acceptedPlan).toMatchObject({
      tripVersion: state.tripVersion,
      planVersion: state.planVersion,
    });
    expect(state.vehicle).toMatchObject({ id: 'VEH301', type: 'van' });
    expect(state.stops.map((stop) => stop.seq)).toEqual([1, 2]);
    expect(state.stops[0]).toMatchObject({
      chilled: false,
      access: 'normal',
      order: { id: trip.orderIds[0], units: 6, weightKg: 120, volumeM3: 1.5, temp: 'ambient' },
    });
    expect(state.stops[1]).toMatchObject({
      chilled: true,
      access: 'van_only',
      order: { id: trip.orderIds[1], temp: 'chilled', units: 6 },
    });

    const storedTrip = await database.db.select().from(trips).where(eq(trips.id, trip.tripId));
    expect(storedTrip[0]?.status).toBe('loading');
    const storedStops = await database.db
      .select({ seq: tripStops.seq })
      .from(tripStops)
      .where(eq(tripStops.tripId, trip.tripId));
    expect(storedStops.map((stop) => stop.seq).sort()).toEqual([1, 2]);
    const storedOrders = await database.db.select({ status: orders.status }).from(orders);
    expect(storedOrders.every((order) => order.status === 'loading')).toBe(true);

    const driver = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${trip.tripId}/loading/start`,
      headers: { cookie: driverCookie, 'if-match': '0' },
    });
    expect(driver.statusCode).toBe(403);
    const store = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${trip.tripId}/loading`,
      headers: { cookie: storeCookie },
    });
    expect(store.statusCode).toBe(403);
  });

  it('hides another depot trip from the loader', async () => {
    const trip = await insertTrip({ vehicleId: 'VEH311', district: 'Kandy', outletId: 'OUT311' });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${trip.tripId}/loading/start`,
      headers: { cookie: loader.cookie, 'if-match': '0' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    const stored = await database.db.select().from(trips).where(eq(trips.id, trip.tripId));
    expect(stored[0]?.status).toBe('published');
  });

  it('persists loading verification against the current plan', async () => {
    const trip = await insertTrip();
    await start(trip.tripId);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${trip.tripId}/loading/verify`,
      headers: { cookie: loader.cookie, 'if-match': '0' },
    });
    const state = loadingStateSchema.parse(json(response, 200));
    expect(state.verifiedAt).toBe(PINNED);
    expect(state.planStale).toBe(false);
    expect(state.status).toBe('in_progress');
    const rows = await database.db.select().from(loadingRecords);
    expect(rows[0]?.verifiedAt?.getTime()).toBe(new Date(PINNED).getTime());
    expect(rows[0]?.acceptedTripVersion).toBe(0);
  });

  it('records a missing issue', async () => {
    const issue = await recordIssue('missing', 'Crate missing');
    expect(issue.type).toBe('missing');
    expect(issue.qty).toBe(1);
    expect(issue.note).toBe('Crate missing');
  });

  it('records a damaged issue', async () => {
    const issue = await recordIssue('damaged', 'Crushed carton');
    expect(issue.type).toBe('damaged');
  });

  it('records a short issue', async () => {
    const issue = await recordIssue('short', 'Two units short');
    expect(issue.type).toBe('short');
  });

  it('notifies the dispatcher when a loading issue is recorded', async () => {
    const trip = await insertTrip();
    await start(trip.tripId);
    const seen: DomainEvent[] = [];
    const stop = app.domainEvents.subscribe((event) => {
      seen.push(event);
    });
    const orderId = trip.orderIds[0] ?? missing('order');
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${trip.tripId}/loading/issues`,
      headers: { cookie: loader.cookie, 'if-match': '0' },
      payload: { orderId, type: 'short', qty: 2, note: 'Short on the dock' },
    });
    stop();
    const state = loadingStateSchema.parse(json(response, 201));
    const issue = state.issues[0];
    if (issue === undefined) throw new Error('Expected a loading issue');
    expect(seen).toEqual([
      expect.objectContaining({
        type: 'loading.issue_recorded',
        tripId: trip.tripId,
        depotId: 'Peliyagoda',
        issueId: issue.id,
        tripVersion: 0,
        occurredAt: PINNED,
      }),
    ]);
    const notes = await database.db.select().from(notifications);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      recipientId: dispatcher.user.id,
      type: 'loading_shortfall',
      priority: 'high',
      entityType: 'loading_issue',
      entityId: issue.id,
    });
  });

  it('refuses to let the loader acknowledge an issue', async () => {
    const trip = await insertTrip();
    await start(trip.tripId);
    const created = await postIssue(trip.tripId, trip.orderIds[0] ?? missing('order'), 'missing');
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/loading/issues/${created.id}/ack`,
      headers: { cookie: loader.cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    const rows = await database.db.select().from(loadingIssues);
    expect(rows[0]?.acknowledgedBy).toBeNull();
  });

  it('lets the dispatcher acknowledge an issue and keeps it', async () => {
    const trip = await insertTrip();
    await start(trip.tripId);
    const created = await postIssue(trip.tripId, trip.orderIds[0] ?? missing('order'), 'damaged');
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/loading/issues/${created.id}/ack`,
      headers: { cookie: dispatcher.cookie },
    });
    const issue = loadingIssueSchema.parse(json(response, 200));
    expect(issue.acknowledgedBy).toBe(dispatcher.user.id);
    expect(issue.acknowledgedAt).toBe(PINNED);
    expect(issue.id).toBe(created.id);
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/loading/issues/${created.id}/ack`,
      headers: { cookie: dispatcher.cookie },
    });
    expect(again.statusCode).toBe(422);
    const rows = await database.db.select().from(loadingIssues);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.acknowledgedBy).toBe(dispatcher.user.id);
    const view = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${trip.tripId}/loading`,
      headers: { cookie: dispatcher.cookie },
    });
    const state = loadingStateSchema.parse(json(view, 200));
    expect(state.status).toBe('in_progress');
    expect(state.issues).toHaveLength(1);
  });

  it('keeps the loader count on the server and validates it', async () => {
    const trip = await insertTrip();
    const orderId = trip.orderIds[0] ?? missing('order');
    const count = (cookie: string, payload: Record<string, unknown>) =>
      app.inject({
        method: 'PUT',
        url: `/api/v1/trips/${trip.tripId}/loading/counts`,
        headers: { cookie },
        payload,
      });
    // Counting starts with loading.
    expect((await count(loader.cookie, { orderId, units: 1 })).statusCode).toBe(422);
    await start(trip.tripId);

    const saved = loadingStateSchema.parse(
      json(await count(loader.cookie, { orderId, units: 2 }), 200),
    );
    expect(saved.stops.find((stop) => stop.order.id === orderId)?.loadedUnits).toBe(2);
    const units = saved.stops.find((stop) => stop.order.id === orderId)?.order.units ?? 0;
    expect((await count(loader.cookie, { orderId, units: units + 1 })).statusCode).toBe(422);
    expect((await count(loader.cookie, { orderId, units: -1 })).statusCode).toBe(400);
    expect((await count(dispatcher.cookie, { orderId, units: 1 })).statusCode).toBe(403);
    expect(
      (await count(loader.cookie, { orderId: '00000000-0000-7000-8000-000000000000', units: 1 }))
        .statusCode,
    ).toBe(422);

    // A fresh read, as after a reload or on another tablet, still has the count.
    const view = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${trip.tripId}/loading`,
      headers: { cookie: loader.cookie },
    });
    const state = loadingStateSchema.parse(json(view, 200));
    expect(state.stops.find((stop) => stop.order.id === orderId)?.loadedUnits).toBe(2);
    expect(await database.db.select().from(loadingCounts)).toHaveLength(1);
  });

  it('blocks Ready while a loading issue is unacknowledged', async () => {
    const trip = await insertTrip();
    await start(trip.tripId);
    await postIssue(trip.tripId, trip.orderIds[0] ?? missing('order'), 'short');
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${trip.tripId}/loading/ready`,
      headers: { cookie: loader.cookie, 'if-match': '0' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: 'CONSTRAINT_VIOLATION', message: expect.stringContaining('acknowledged') },
    });
    const stored = await database.db.select().from(loadingRecords);
    expect(stored[0]?.status).toBe('exception');
    const tripRow = await database.db.select().from(trips).where(eq(trips.id, trip.tripId));
    expect(tripRow[0]?.status).toBe('loading');
  });

  it('marks Ready only after the issue is acknowledged and the load is verified', async () => {
    const trip = await insertTrip();
    await start(trip.tripId);
    const created = await postIssue(trip.tripId, trip.orderIds[0] ?? missing('order'), 'missing');
    const ack = await app.inject({
      method: 'POST',
      url: `/api/v1/loading/issues/${created.id}/ack`,
      headers: { cookie: dispatcher.cookie },
    });
    expect(ack.statusCode).toBe(200);
    const unverified = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${trip.tripId}/loading/ready`,
      headers: { cookie: loader.cookie, 'if-match': '0' },
    });
    expect(unverified.statusCode).toBe(422);
    expect(unverified.json()).toMatchObject({
      error: { code: 'CONSTRAINT_VIOLATION', message: expect.stringContaining('Verify') },
    });
    const verified = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${trip.tripId}/loading/verify`,
      headers: { cookie: loader.cookie, 'if-match': '0' },
    });
    expect(verified.statusCode).toBe(200);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${trip.tripId}/loading/ready`,
      headers: { cookie: loader.cookie, 'if-match': '0' },
    });
    const state = loadingStateSchema.parse(json(response, 200));
    expect(state.status).toBe('ready');
    expect(state.issues[0]?.acknowledgedBy).toBe(dispatcher.user.id);
    const tripRow = await database.db.select().from(trips).where(eq(trips.id, trip.tripId));
    expect(tripRow[0]?.status).toBe('ready');
    const orderRows = await database.db.select({ status: orders.status }).from(orders);
    expect(orderRows[0]?.status).toBe('loading');
  });

  it('blocks Ready when the trip version changed during loading', async () => {
    const trip = await insertTrip();
    await start(trip.tripId);
    await database.db.update(trips).set({ version: 1 }).where(eq(trips.id, trip.tripId));

    const view = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${trip.tripId}/loading`,
      headers: { cookie: loader.cookie },
    });
    const staleView = loadingStateSchema.parse(json(view, 200));
    expect(staleView.tripVersion).toBe(1);
    expect(staleView.planStale).toBe(true);
    expect(staleView.acceptedPlan?.tripVersion).toBe(staleView.acceptedTripVersion);
    expect(staleView.acceptedPlan?.stops).toHaveLength(staleView.stops.length);

    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${trip.tripId}/loading/ready`,
      headers: { cookie: loader.cookie, 'if-match': '0' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });

    const current = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${trip.tripId}/loading/ready`,
      headers: { cookie: loader.cookie, 'if-match': '1' },
    });
    expect(current.statusCode).toBe(409);
    expect(current.json()).toMatchObject({
      error: { code: 'VERSION_CONFLICT', message: expect.stringContaining('Verify') },
    });

    const verified = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${trip.tripId}/loading/verify`,
      headers: { cookie: loader.cookie, 'if-match': '1' },
    });
    const accepted = loadingStateSchema.parse(json(verified, 200));
    expect(accepted.planStale).toBe(false);
    expect(accepted.acceptedPlan?.tripVersion).toBe(accepted.tripVersion);
    expect(accepted.acceptedTripVersion).toBe(1);

    const ready = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${trip.tripId}/loading/ready`,
      headers: { cookie: loader.cookie, 'if-match': '1' },
    });
    const state = loadingStateSchema.parse(json(ready, 200));
    expect(state.status).toBe('ready');
  });

  it('writes an audit entry for each loading action', async () => {
    const seen = new Set(
      (await database.db.select({ id: auditLog.id }).from(auditLog)).map((row) => row.id),
    );
    const trip = await insertTrip();
    await start(trip.tripId);
    await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${trip.tripId}/loading/verify`,
      headers: { cookie: loader.cookie, 'if-match': '0' },
    });
    const created = await postIssue(trip.tripId, trip.orderIds[0] ?? missing('order'), 'short');
    await app.inject({
      method: 'POST',
      url: `/api/v1/loading/issues/${created.id}/ack`,
      headers: { cookie: dispatcher.cookie },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${trip.tripId}/loading/ready`,
      headers: { cookie: loader.cookie, 'if-match': '0' },
    });

    const rows = (await database.db.select().from(auditLog)).filter((row) => !seen.has(row.id));
    expect(rows.map((row) => row.action).sort()).toEqual([
      'loading.issue_acknowledged',
      'loading.issue_recorded',
      'loading.ready',
      'loading.started',
      'loading.verified',
    ]);
    for (const row of rows) {
      expect(row.createdAt?.getTime()).toBe(new Date(PINNED).getTime());
      expect(row.entityId.length).toBeGreaterThan(0);
    }
    const started = rows.find((row) => row.action === 'loading.started');
    expect(started).toMatchObject({
      actorId: loader.user.id,
      role: 'loader',
      entityType: 'trip',
      entityId: trip.tripId,
    });
    const acknowledged = rows.find((row) => row.action === 'loading.issue_acknowledged');
    expect(acknowledged).toMatchObject({
      actorId: dispatcher.user.id,
      role: 'dispatcher',
      entityType: 'loading_issue',
      entityId: created.id,
    });
    expect(acknowledged?.before).toMatchObject({ acknowledgedBy: null });
    expect(acknowledged?.after).toMatchObject({
      acknowledgedBy: dispatcher.user.id,
      acknowledgedAt: PINNED,
    });
  });

  async function start(tripId: string): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/loading/start`,
      headers: { cookie: loader.cookie, 'if-match': '0' },
    });
    expect(response.statusCode).toBe(201);
  }

  async function postIssue(
    tripId: string,
    orderId: string,
    type: 'missing' | 'damaged' | 'short',
  ): Promise<{
    id: string;
    type: 'missing' | 'damaged' | 'short';
    qty: number;
    note: string | null;
  }> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/loading/issues`,
      headers: { cookie: loader.cookie, 'if-match': '0' },
      payload: { orderId, type, qty: 1, note: `${type} goods` },
    });
    const state = loadingStateSchema.parse(json(response, 201));
    const issue = state.issues[0];
    if (issue === undefined) throw new Error('Expected a loading issue');
    expect(issue.tripId).toBe(tripId);
    expect(issue.loaderId).toBe(loader.user.id);
    expect(issue.acknowledgedBy).toBeNull();
    expect(state.status).toBe('exception');
    return issue;
  }

  async function recordIssue(
    type: 'missing' | 'damaged' | 'short',
    note: string,
  ): Promise<{ type: 'missing' | 'damaged' | 'short'; qty: number; note: string | null }> {
    const trip = await insertTrip();
    await start(trip.tripId);
    const orderId = trip.orderIds[0] ?? missing('order');
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${trip.tripId}/loading/issues`,
      headers: { cookie: loader.cookie, 'if-match': '0' },
      payload: { orderId, type, qty: 1, note },
    });
    const state = loadingStateSchema.parse(json(response, 201));
    const issue = state.issues[0];
    if (issue === undefined) throw new Error('Expected a loading issue');
    const rows = await database.db.select().from(loadingIssues);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tripId: trip.tripId,
      orderId,
      type,
      qty: 1,
      note,
      loaderId: loader.user.id,
      acknowledgedBy: null,
      acknowledgedAt: null,
    });
    return issue;
  }

  async function insertTrip(
    options: {
      vehicleId?: string;
      district?: string;
      outletId?: string;
      stops?: { outletId: string; temp: 'ambient' | 'chilled'; seq: number }[];
    } = {},
  ): Promise<{ tripId: string; orderIds: string[]; stopIds: string[] }> {
    const vehicleId = options.vehicleId ?? 'VEH301';
    const district = options.district ?? 'Colombo';
    const depotId = vehicleId === 'VEH311' ? 'Kandy' : 'Peliyagoda';
    const runId = await ensureRun(depotId);
    const created = await database.db
      .insert(trips)
      .values({
        runId,
        vehicleId,
        tripNo: 1,
        brand: 'Fresh',
        district,
        status: 'published',
        version: 0,
        plannedMinutes: 40,
        plannedKm: 12,
      })
      .returning({ id: trips.id });
    const tripId = created[0]?.id;
    if (tripId === undefined) throw new Error('Expected a trip id');
    const plan = options.stops ?? [
      { outletId: options.outletId ?? 'OUT301', temp: 'ambient' as const, seq: 1 },
    ];
    const orderIds: string[] = [];
    const stopIds: string[] = [];
    for (const stop of plan) {
      const order = await database.db
        .insert(orders)
        .values({
          outletId: stop.outletId,
          brand: 'Fresh',
          temp: stop.temp,
          requestedDate: SERVICE_DATE,
          units: 6,
          weightKg: 120,
          volumeM3: 1.5,
          status: 'allocated',
        })
        .returning({ id: orders.id });
      const orderId = order[0]?.id;
      if (orderId === undefined) throw new Error('Expected an order id');
      const inserted = await database.db
        .insert(tripStops)
        .values({
          tripId,
          orderId,
          seq: stop.seq,
          plannedArrival: new Date(`${SERVICE_DATE}T05:00:00.000+05:30`),
          status: 'pending',
        })
        .returning({ id: tripStops.id });
      const stopId = inserted[0]?.id;
      if (stopId === undefined) throw new Error('Expected a stop id');
      orderIds.push(orderId);
      stopIds.push(stopId);
    }
    return { tripId, orderIds, stopIds };
  }

  async function ensureRun(depotId: string): Promise<string> {
    const existing = await database.db
      .select({ id: planningRuns.id })
      .from(planningRuns)
      .where(eq(planningRuns.depotId, depotId));
    const found = existing[0]?.id;
    if (found !== undefined) return found;
    const inserted = await database.db
      .insert(planningRuns)
      .values({
        depotId,
        serviceDate: SERVICE_DATE,
        status: 'published',
        publishedAt: new Date(PINNED),
        publishedBy: dispatcher.user.id,
        planVersion: 2,
      })
      .returning({ id: planningRuns.id });
    const id = inserted[0]?.id;
    if (id === undefined) throw new Error('Expected a planning run');
    return id;
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
        outlet('OUT301', 'Colombo', 'Peliyagoda', 'normal'),
        outlet('OUT302', 'Colombo', 'Peliyagoda', 'van_only'),
        outlet('OUT311', 'Kandy', 'Kandy', 'normal'),
      ]);
    await database.db
      .insert(vehicles)
      .values([vehicle('VEH301', 'Peliyagoda', 'van'), vehicle('VEH311', 'Kandy', 'truck')]);
    await database.db.insert(users).values([
      {
        name: 'Peliyagoda Dispatcher',
        email: 'loading.dispatcher@waypoint.test',
        passwordHash,
        role: 'dispatcher' as const,
        depotId: 'Peliyagoda',
      },
      {
        name: 'Peliyagoda Loader',
        email: 'loading.loader@waypoint.test',
        passwordHash,
        role: 'loader' as const,
        depotId: 'Peliyagoda',
      },
      {
        name: 'Van Driver',
        email: 'loading.driver@waypoint.test',
        passwordHash,
        role: 'driver' as const,
        vehicleId: 'VEH301',
      },
      {
        name: 'Store Manager',
        email: 'loading.store@waypoint.test',
        passwordHash,
        role: 'store_manager' as const,
        outletId: 'OUT301',
      },
    ]);
  }
});

function json(response: { statusCode: number; json: () => unknown }, status: number): unknown {
  expect(response.statusCode).toBe(status);
  return response.json();
}

function missing(label: string): never {
  throw new Error(`Expected a ${label}`);
}

function outlet(
  id: string,
  district: string,
  depotId: string,
  parkingConstraint: 'normal' | 'van_only',
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
  };
}

function vehicle(id: string, depotId: string, type: 'van' | 'truck') {
  return {
    id,
    type,
    temp: 'reefer' as const,
    weightCapKg: 1500,
    volumeCapM3: 8,
    fuelType: 'diesel',
    kmPerL: 10,
    weeklyFuelQuotaL: 200,
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
