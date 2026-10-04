import { randomBytes, randomUUID } from 'node:crypto';
import {
  calendarDays,
  deferrals,
  depots,
  districtTravel,
  fuelLedger,
  loadingIssues,
  loadingRecords,
  notifications,
  orders,
  outlets,
  planningRuns,
  serviceAllowances,
  stopEvents,
  syncConflicts,
  tripStops,
  trips,
  users,
  vehicleAvailability,
  vehicles,
} from '@waypoint/database';
import {
  currentUserResponseSchema,
  notificationFeedItemSchema,
  notificationListResponseSchema,
  syncEventsResponseSchema,
  type User,
} from '@waypoint/shared';
import { eq } from 'drizzle-orm';
import { argon2id } from 'hash-wasm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { client, cookiePair, SESSION_SECRET } from '../../../../test/http.ts';
import { createMigratedDatabase } from '../../../../test/postgres.ts';
import { buildApp } from '../../../app.ts';
import { createOrderService } from '../../orders/service.ts';
import { NOTIFICATION_LIST_LIMIT } from '../repo.ts';

const SERVICE_DATE = '2026-10-07';
const PINNED = '2026-10-06T10:00:00.000+05:30';
const CUTOFF = '2026-10-06T16:00:00.000+05:30';
const SYNC_NOW = '2026-10-07T07:00:00.000+05:30';
const SYNC_CLIENT = '2026-10-07T07:20:00.000+05:30';
const PASSWORD = 'waypoint-demo';

describe('notifications', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
  let dispatcher: { cookie: string; user: User };
  let loader: { cookie: string; user: User };
  let kandyLoader: { cookie: string; user: User };
  let driver: { cookie: string; user: User };
  let store: { cookie: string; user: User };
  let otherStore: { cookie: string; user: User };

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
    dispatcher = await login('notes.dispatcher@waypoint.test');
    loader = await login('notes.loader@waypoint.test');
    kandyLoader = await login('notes.kandy.loader@waypoint.test');
    driver = await login('notes.driver@waypoint.test');
    store = await login('notes.store@waypoint.test');
    otherStore = await login('notes.other.store@waypoint.test');
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  beforeEach(async () => {
    await database.db.delete(notifications);
    await database.db.delete(syncConflicts);
    await database.db.delete(stopEvents);
    await database.db.delete(loadingIssues);
    await database.db.delete(loadingRecords);
    await database.db.delete(tripStops);
    await database.db.delete(deferrals);
    await database.db.delete(fuelLedger);
    await database.db.delete(trips);
    await database.db.delete(orders);
    await database.db.delete(planningRuns);
    await database.db.delete(vehicleAvailability);
    app.clock.pin(new Date(PINNED));
  });

  it('shows a user only their own notifications, high priority first', async () => {
    const olderHigh = await insertNote(dispatcher.user.id, {
      type: 'loading_shortfall',
      priority: 'high',
      createdAt: new Date('2026-10-06T08:00:00.000+05:30'),
    });
    const newerHigh = await insertNote(dispatcher.user.id, {
      type: 'delivery_issue',
      priority: 'high',
      createdAt: new Date('2026-10-06T10:00:00.000+05:30'),
    });
    const medium = await insertNote(dispatcher.user.id, {
      type: 'sync_conflict',
      priority: 'medium',
      entityType: 'sync_conflict',
      createdAt: new Date('2026-10-06T09:00:00.000+05:30'),
    });
    const info = await insertNote(dispatcher.user.id, {
      type: 'order_confirmed',
      priority: 'info',
      createdAt: new Date('2026-10-06T11:00:00.000+05:30'),
    });
    const hidden = await insertNote(store.user.id, {
      type: 'order_deferred',
      priority: 'high',
      createdAt: new Date('2026-10-06T12:00:00.000+05:30'),
    });

    const feed = await list(dispatcher.cookie);
    expect(feed.total).toBe(feed.items.length);
    expect(feed.items.map((item) => item.id)).toEqual([newerHigh, olderHigh, medium, info]);
    expect(feed.items.map((item) => item.priority)).toEqual(['high', 'high', 'medium', 'info']);
    expect(feed.items.map((item) => item.type)).toEqual([
      'delivery_issue',
      'loading_shortfall',
      'sync_conflict',
      'order_confirmed',
    ]);
    expect(feed.items.map((item) => item.recipientId)).toEqual([
      dispatcher.user.id,
      dispatcher.user.id,
      dispatcher.user.id,
      dispatcher.user.id,
    ]);
    expect(feed.items[0]).toMatchObject({
      actionRequired: true,
      readAt: null,
      acknowledgedAt: null,
      createdAt: '2026-10-06T10:00:00.000+05:30',
    });
    expect(feed.items.map((item) => item.id)).not.toContain(hidden);

    const storeFeed = await list(store.cookie);
    expect(storeFeed.items.map((item) => item.id)).toEqual([hidden]);
    expect((await list(loader.cookie)).items).toEqual([]);

    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/notifications' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('caps the feed and keeps the action-required notices in it', async () => {
    const urgent = await insertNote(dispatcher.user.id, {
      type: 'loading_shortfall',
      priority: 'high',
      // Older than every routine notice below.
      createdAt: new Date('2026-10-01T08:00:00.000+05:30'),
    });
    await database.db.insert(notifications).values(
      Array.from({ length: NOTIFICATION_LIST_LIMIT + 25 }, (_, index) => ({
        recipientId: dispatcher.user.id,
        type: 'delivered' as const,
        priority: 'info' as const,
        entityType: 'stop' as const,
        entityId: randomUUID(),
        createdAt: new Date(Date.parse('2026-10-05T08:00:00.000+05:30') + index * 1000),
      })),
    );

    const feed = await list(dispatcher.cookie);
    expect(feed.items).toHaveLength(NOTIFICATION_LIST_LIMIT);
    expect(feed.items[0]?.id).toBe(urgent);
  });

  it('marks a notification read without clearing an action-required acknowledgement', async () => {
    const id = await insertNote(dispatcher.user.id, {
      type: 'loading_shortfall',
      priority: 'high',
      createdAt: new Date(PINNED),
    });
    const info = await insertNote(dispatcher.user.id, {
      type: 'delivered',
      priority: 'info',
      entityType: 'stop',
      createdAt: new Date('2026-10-06T09:00:00.000+05:30'),
    });

    const read = notificationFeedItemSchema.parse(
      json(await post(dispatcher.cookie, `/api/v1/notifications/${id}/read`), 200),
    );
    expect(read).toMatchObject({
      id,
      readAt: PINNED,
      acknowledgedAt: null,
      actionRequired: true,
    });

    app.clock.pin(new Date(CUTOFF));
    const again = notificationFeedItemSchema.parse(
      json(await post(dispatcher.cookie, `/api/v1/notifications/${id}/read`), 200),
    );
    expect(again.readAt).toBe(PINNED);
    expect(again.actionRequired).toBe(true);

    const acknowledged = notificationFeedItemSchema.parse(
      json(await post(dispatcher.cookie, `/api/v1/notifications/${id}/acknowledge`), 200),
    );
    expect(acknowledged).toMatchObject({
      readAt: PINNED,
      acknowledgedAt: CUTOFF,
      actionRequired: false,
    });
    const repeated = notificationFeedItemSchema.parse(
      json(await post(dispatcher.cookie, `/api/v1/notifications/${id}/acknowledge`), 200),
    );
    expect(repeated.acknowledgedAt).toBe(CUTOFF);

    const refused = await post(dispatcher.cookie, `/api/v1/notifications/${info}/acknowledge`);
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: { code: 'CONSTRAINT_VIOLATION' } });
    const infoRow = await database.db
      .select()
      .from(notifications)
      .where(eq(notifications.id, info));
    expect(infoRow[0]?.acknowledgedAt).toBeNull();
  });

  it('refuses to read or acknowledge another user’s notification', async () => {
    const id = await insertNote(dispatcher.user.id, {
      type: 'receipt_discrepancy',
      priority: 'high',
      entityType: 'issue',
      createdAt: new Date(PINNED),
    });
    const missing = '00000000-0000-4000-8000-000000000099';

    for (const path of ['read', 'acknowledge'] as const) {
      const response = await post(store.cookie, `/api/v1/notifications/${id}/${path}`);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      const unknown = await post(dispatcher.cookie, `/api/v1/notifications/${missing}/${path}`);
      expect(unknown.statusCode).toBe(404);
    }

    const row = await database.db.select().from(notifications).where(eq(notifications.id, id));
    expect(row[0]?.readAt).toBeNull();
    expect(row[0]?.acknowledgedAt).toBeNull();
    expect((await list(store.cookie)).items).toEqual([]);
  });

  it('confirms an order into a store notification in the same transaction', async () => {
    const orderId = await insertOrder({ status: 'submitted', requestedDate: SERVICE_DATE });
    app.clock.pin(new Date(CUTOFF));
    const locked = await createOrderService(
      database.db,
      app.audit,
      app.domainEvents,
      app.clock,
    ).lockConfirmedOrdersForRun(dispatcher.user, SERVICE_DATE);
    expect(locked.map((order) => order.id)).toEqual([orderId]);

    const feed = await list(store.cookie);
    expect(feed.items).toEqual([
      expect.objectContaining({
        recipientId: store.user.id,
        type: 'order_confirmed',
        priority: 'info',
        entityType: 'order',
        entityId: orderId,
        actionRequired: false,
      }),
    ]);
    expect((await list(dispatcher.cookie)).items).toEqual([]);
    expect((await list(otherStore.cookie)).items).toEqual([]);
  });

  it('creates a dispatcher notification when a loader records a shortfall', async () => {
    const trip = await insertPublishedTrip();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/trips/${trip.tripId}/loading/start`,
          headers: { cookie: loader.cookie, 'if-match': '0' },
        })
      ).statusCode,
    ).toBe(201);
    const recorded = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${trip.tripId}/loading/issues`,
      headers: { cookie: loader.cookie, 'if-match': '0' },
      payload: { orderId: trip.orderId, type: 'short', qty: 1, note: 'Short on the dock' },
    });
    expect(recorded.statusCode).toBe(201);

    const feed = await list(dispatcher.cookie);
    expect(feed.items).toEqual([
      expect.objectContaining({
        recipientId: dispatcher.user.id,
        type: 'loading_shortfall',
        priority: 'high',
        entityType: 'loading_issue',
        actionRequired: true,
      }),
    ]);
    expect((await list(loader.cookie)).items).toEqual([]);
    expect((await list(store.cookie)).items).toEqual([]);
  });

  it('notifies the store on deferral and the loader and driver on publish', async () => {
    // A plan can only be published once the 4:00 PM cutoff has closed the run.
    app.clock.pin(new Date('2026-10-06T16:00:00.000+05:30'));
    const served = await insertOrder({ weightKg: 100 });
    const deferred = await insertOrder({ weightKg: 5_000 });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/planning/runs/${SERVICE_DATE}/auto-allocate`,
          headers: { cookie: dispatcher.cookie, 'if-match': '0' },
        })
      ).statusCode,
    ).toBe(200);
    const published = await app.inject({
      method: 'POST',
      url: `/api/v1/planning/runs/${SERVICE_DATE}/publish`,
      headers: { cookie: dispatcher.cookie, 'if-match': '1' },
    });
    expect(published.statusCode).toBe(200);

    const storeFeed = await list(store.cookie);
    expect(storeFeed.items).toEqual([
      expect.objectContaining({
        type: 'order_deferred',
        priority: 'high',
        entityType: 'order',
        entityId: deferred,
        actionRequired: true,
      }),
    ]);
    expect(storeFeed.items.map((item) => item.entityId)).not.toContain(served);

    const tripRows = await database.db.select().from(trips);
    expect(tripRows).toHaveLength(1);
    const trip = tripRows[0];
    if (trip === undefined) throw new Error('Expected a published trip');
    expect(trip.vehicleId).toBe('VEH701');

    const loaderFeed = await list(loader.cookie);
    expect(loaderFeed.items).toEqual([
      expect.objectContaining({
        type: 'plan_published',
        priority: 'high',
        entityType: 'trip',
        entityId: trip.id,
        actionRequired: true,
      }),
    ]);
    const driverFeed = await list(driver.cookie);
    expect(driverFeed.items).toEqual([
      expect.objectContaining({
        type: 'plan_published',
        priority: 'high',
        entityType: 'trip',
        entityId: trip.id,
        recipientId: driver.user.id,
      }),
    ]);
    expect((await list(kandyLoader.cookie)).items).toEqual([]);
    expect((await list(dispatcher.cookie)).items).toEqual([]);
    expect((await list(otherStore.cookie)).items).toEqual([]);

    const stops = await database.db
      .select({ id: tripStops.id })
      .from(tripStops)
      .where(eq(tripStops.tripId, trip.id));
    const changed = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${trip.id}/resequence`,
      headers: { cookie: dispatcher.cookie, 'if-match': String(trip.version) },
      payload: { stopIds: stops.map((stop) => stop.id) },
    });
    expect(changed.statusCode).toBe(200);
    expect((await list(loader.cookie)).items.map((item) => item.type)).toContain('plan_changed');
    expect((await list(driver.cookie)).items.map((item) => item.type)).toContain('plan_changed');
    expect((await list(kandyLoader.cookie)).items).toEqual([]);
  });

  it('notifies the driver and dispatcher once for a duplicate offline conflict', async () => {
    app.clock.pin(new Date(SYNC_NOW));
    const own = await insertDepartedTrip('VEH701', 1);
    const other = await insertDepartedTrip('VEH702', 1);
    await database.db
      .update(tripStops)
      .set({ tripId: other.tripId, seq: 2 })
      .where(eq(tripStops.id, own.stopId));
    await database.db.update(trips).set({ version: 1 }).where(eq(trips.id, own.tripId));

    const event = {
      clientEventId: randomUUID(),
      stopId: own.stopId,
      type: 'arrived' as const,
      payload: {},
      clientTime: SYNC_CLIENT,
      tripVersion: 0,
    };
    const first = syncEventsResponseSchema.parse(json(await postSync(driver.cookie, [event]), 200));
    expect(first.results).toEqual([
      expect.objectContaining({ clientEventId: event.clientEventId, status: 'conflict' }),
    ]);
    const second = syncEventsResponseSchema.parse(
      json(await postSync(driver.cookie, [event]), 200),
    );
    expect(second.results).toEqual([
      expect.objectContaining({ clientEventId: event.clientEventId, status: 'conflict' }),
    ]);

    const stored = await database.db.select().from(notifications);
    expect(stored).toHaveLength(2);
    expect(stored.map((note) => note.recipientId).sort()).toEqual(
      [dispatcher.user.id, driver.user.id].sort(),
    );
    expect(stored.every((note) => note.type === 'sync_conflict')).toBe(true);
    expect(new Set(stored.map((note) => note.entityId)).size).toBe(1);

    const driverFeed = await list(driver.cookie);
    const dispatcherFeed = await list(dispatcher.cookie);
    expect(driverFeed.items).toHaveLength(1);
    expect(dispatcherFeed.items).toHaveLength(1);
    expect(driverFeed.items[0]).toMatchObject({
      type: 'sync_conflict',
      priority: 'medium',
      actionRequired: false,
      recipientId: driver.user.id,
    });
    expect(dispatcherFeed.items[0]).toMatchObject({
      type: 'sync_conflict',
      priority: 'medium',
      recipientId: dispatcher.user.id,
      entityId: driverFeed.items[0]?.entityId,
    });
    expect((await list(store.cookie)).items).toEqual([]);
  });

  async function list(cookie: string) {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: { cookie },
    });
    return notificationListResponseSchema.parse(json(response, 200));
  }

  function post(cookie: string, url: string) {
    return app.inject({ method: 'POST', url, headers: { cookie } });
  }

  function postSync(cookie: string, events: unknown[]) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/sync/events',
      headers: { cookie },
      payload: { events },
    });
  }

  async function insertNote(
    recipientId: string,
    input: {
      type:
        | 'loading_shortfall'
        | 'delivery_issue'
        | 'sync_conflict'
        | 'order_confirmed'
        | 'order_deferred'
        | 'delivered'
        | 'receipt_discrepancy';
      priority: 'high' | 'medium' | 'info';
      entityType?: 'order' | 'stop' | 'loading_issue' | 'issue' | 'sync_conflict';
      createdAt: Date;
    },
  ): Promise<string> {
    const rows = await database.db
      .insert(notifications)
      .values({
        recipientId,
        type: input.type,
        priority: input.priority,
        entityType: input.entityType ?? 'order',
        entityId: randomUUID(),
        createdAt: input.createdAt,
      })
      .returning({ id: notifications.id });
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('Expected a notification');
    return id;
  }

  async function insertOrder(
    overrides: {
      weightKg?: number;
      status?: 'confirmed' | 'submitted';
      requestedDate?: string;
    } = {},
  ): Promise<string> {
    const rows = await database.db
      .insert(orders)
      .values({
        outletId: 'OUT701',
        brand: 'Fresh',
        temp: 'ambient',
        requestedDate: overrides.requestedDate ?? SERVICE_DATE,
        units: 4,
        weightKg: overrides.weightKg ?? 100,
        volumeM3: 1,
        status: overrides.status ?? 'confirmed',
      })
      .returning({ id: orders.id });
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('Expected an order');
    return id;
  }

  async function insertPublishedTrip(): Promise<{ tripId: string; orderId: string }> {
    const orderId = await insertOrder({ status: 'confirmed' });
    const run = await database.db
      .insert(planningRuns)
      .values({
        depotId: 'Peliyagoda',
        serviceDate: SERVICE_DATE,
        status: 'published',
        publishedAt: new Date(PINNED),
        publishedBy: dispatcher.user.id,
        planVersion: 1,
      })
      .returning({ id: planningRuns.id });
    const runId = run[0]?.id;
    if (runId === undefined) throw new Error('Expected a planning run');
    const created = await database.db
      .insert(trips)
      .values({
        runId,
        vehicleId: 'VEH701',
        tripNo: 1,
        brand: 'Fresh',
        district: 'Colombo',
        status: 'published',
        version: 0,
        plannedMinutes: 40,
        plannedKm: 12,
      })
      .returning({ id: trips.id });
    const tripId = created[0]?.id;
    if (tripId === undefined) throw new Error('Expected a trip');
    await database.db.insert(tripStops).values({
      tripId,
      orderId,
      seq: 1,
      plannedArrival: new Date(`${SERVICE_DATE}T07:10:00.000+05:30`),
      status: 'pending',
    });
    await database.db.update(orders).set({ status: 'allocated' }).where(eq(orders.id, orderId));
    return { tripId, orderId };
  }

  async function insertDepartedTrip(
    vehicleId: string,
    tripNo: 1 | 2,
  ): Promise<{ tripId: string; stopId: string }> {
    const existing = await database.db
      .select({ id: planningRuns.id })
      .from(planningRuns)
      .where(eq(planningRuns.depotId, 'Peliyagoda'));
    let runId = existing[0]?.id;
    if (runId === undefined) {
      const inserted = await database.db
        .insert(planningRuns)
        .values({
          depotId: 'Peliyagoda',
          serviceDate: SERVICE_DATE,
          status: 'published',
          publishedAt: new Date(SYNC_NOW),
          publishedBy: dispatcher.user.id,
          planVersion: 1,
        })
        .returning({ id: planningRuns.id });
      runId = inserted[0]?.id;
    }
    if (runId === undefined) throw new Error('Expected a planning run');
    const order = await database.db
      .insert(orders)
      .values({
        outletId: 'OUT701',
        brand: 'Fresh',
        temp: 'ambient',
        requestedDate: SERVICE_DATE,
        units: 4,
        weightKg: 12,
        volumeM3: 0.4,
        status: 'dispatched',
      })
      .returning({ id: orders.id });
    const orderId = order[0]?.id;
    if (orderId === undefined) throw new Error('Expected an order');
    const created = await database.db
      .insert(trips)
      .values({
        runId,
        vehicleId,
        tripNo,
        brand: 'Fresh',
        district: 'Colombo',
        status: 'departed',
        version: 0,
        plannedMinutes: 40,
        plannedKm: 12,
      })
      .returning({ id: trips.id });
    const tripId = created[0]?.id;
    if (tripId === undefined) throw new Error('Expected a trip');
    const stop = await database.db
      .insert(tripStops)
      .values({
        tripId,
        orderId,
        seq: 1,
        plannedArrival: new Date(`${SERVICE_DATE}T07:10:00.000+05:30`),
        status: 'pending',
      })
      .returning({ id: tripStops.id });
    const stopId = stop[0]?.id;
    if (stopId === undefined) throw new Error('Expected a stop');
    return { tripId, stopId };
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
    await database.db.insert(outlets).values([
      {
        id: 'OUT701',
        brand: 'Fresh',
        district: 'Colombo',
        depotId: 'Peliyagoda',
        dockType: 'street',
        parkingConstraint: 'normal',
        windowOpen: '05:00:00',
        windowClose: '18:00:00',
      },
      {
        id: 'OUT711',
        brand: 'Fresh',
        district: 'Kandy',
        depotId: 'Kandy',
        dockType: 'street',
        parkingConstraint: 'normal',
        windowOpen: '05:00:00',
        windowClose: '18:00:00',
      },
    ]);
    await database.db
      .insert(vehicles)
      .values([vehicle('VEH701', 'Peliyagoda'), vehicle('VEH702', 'Peliyagoda')]);
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
        email: 'notes.dispatcher@waypoint.test',
        passwordHash,
        role: 'dispatcher',
        depotId: 'Peliyagoda',
      },
      {
        name: 'Peliyagoda Loader',
        email: 'notes.loader@waypoint.test',
        passwordHash,
        role: 'loader',
        depotId: 'Peliyagoda',
      },
      {
        name: 'Kandy Loader',
        email: 'notes.kandy.loader@waypoint.test',
        passwordHash,
        role: 'loader',
        depotId: 'Kandy',
      },
      {
        name: 'Van Driver',
        email: 'notes.driver@waypoint.test',
        passwordHash,
        role: 'driver',
        vehicleId: 'VEH701',
      },
      {
        name: 'Store Manager',
        email: 'notes.store@waypoint.test',
        passwordHash,
        role: 'store_manager',
        outletId: 'OUT701',
      },
      {
        name: 'Other Store Manager',
        email: 'notes.other.store@waypoint.test',
        passwordHash,
        role: 'store_manager',
        outletId: 'OUT711',
      },
    ]);
  }
});

function vehicle(id: string, depotId: string) {
  return {
    id,
    type: 'truck' as const,
    temp: 'ambient' as const,
    weightCapKg: 2_000,
    volumeCapM3: 10,
    fuelType: 'diesel',
    kmPerL: 10,
    weeklyFuelQuotaL: 200,
    depotId,
  };
}

function json(response: { statusCode: number; json: () => unknown }, status: number): unknown {
  expect(response.statusCode).toBe(status);
  return response.json();
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
