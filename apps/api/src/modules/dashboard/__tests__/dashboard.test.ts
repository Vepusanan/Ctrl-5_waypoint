import { randomBytes, randomUUID } from 'node:crypto';
import {
  auditLog,
  calendarDays,
  deferrals,
  depots,
  districtTravel,
  fuelLedger,
  issues,
  loadingIssues,
  loadingRecords,
  orders,
  outlets,
  planningRuns,
  stopEvents,
  syncConflicts,
  tripStops,
  trips,
  users,
  vehicleAvailability,
  vehicles,
} from '@waypoint/database';
import {
  auditTimelineSchema,
  currentUserResponseSchema,
  dashboardExceptionsSchema,
  dashboardStreamMessageSchema,
  dashboardSummarySchema,
  type User,
} from '@waypoint/shared';
import { argon2id } from 'hash-wasm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, cookiePair, SESSION_SECRET } from '../../../../test/http.ts';
import { createMigratedDatabase } from '../../../../test/postgres.ts';
import { buildApp } from '../../../app.ts';

const DATE = '2026-10-08';
const PREVIOUS = '2026-10-07';
const NOW = '2026-10-08T10:00:00.000+05:30';
const LIVE_SEEN = '2026-10-08T09:40:00.000+05:30';
const STALE_SEEN = '2026-10-08T09:12:00.000+05:30';
const EARLIER = '2026-10-08T09:11:00.000+05:30';
const FAILED_AT = '2026-10-08T08:30:00.000+05:30';
const TIGHT = '2026-10-08T07:50:00.000+05:30';
const EARLY = '2026-10-08T06:00:00.000+05:30';
const PASSWORD = 'waypoint-demo';
const OFFLINE_LABEL = 'Last seen 09:12 · may be offline';

describe('dispatcher dashboard', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
  let dispatcher: { cookie: string; user: User };
  let central: { cookie: string };
  let loader: { cookie: string };
  let driver: { cookie: string };
  let store: { cookie: string };
  let seed: Seed;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    const passwordHash = await hashPassword(PASSWORD);
    seed = await seedDay(passwordHash);
    app = await buildApp({
      db: database.db,
      logger: false,
      sessionSecret: SESSION_SECRET,
      secureCookies: false,
    });
    app.clock.pin(new Date(NOW));
    dispatcher = await login('dash.dispatcher@waypoint.test');
    central = await login('dash.central@waypoint.test');
    loader = await login('dash.loader@waypoint.test');
    driver = await login('dash.driver@waypoint.test');
    store = await login('dash.store@waypoint.test');
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it('gives the dispatcher a summary whose counts match the seeded day', async () => {
    const summary = dashboardSummarySchema.parse(await get(dispatcher.cookie, 'summary'));
    expect(summary.date).toBe(DATE);
    expect(summary.orders).toEqual({
      confirmed: 2,
      allocated: 1,
      deferred: 1,
      loading: 0,
      dispatched: 1,
      delivered: 1,
      failed: 1,
      receiptConfirmed: 0,
    });
    expect(summary.repeatDeferrals).toBe(1);
    expect(summary.loading).toEqual({
      notStarted: 1,
      inProgress: 1,
      exception: 0,
      ready: 0,
      departed: 1,
    });
    expect(summary.activeTrips).toBe(3);
    expect(summary.stops).toEqual({ pending: 1, arrived: 1, delivered: 1, failed: 1 });
    expect(summary.pendingLoadingIssues).toBe(1);
    expect(summary.pendingSyncConflicts).toBe(1);
    expect(summary.fleet).toEqual({ available: 3, unavailable: 1 });
    expect(summary.utilization.weight).toBeCloseTo(0.4, 5);
    expect(summary.utilization.volume).toBeCloseTo(0.4, 5);
    expect(summary.utilization.reefer).toBeCloseTo(0.5, 5);
    expect(summary.utilization.van).toBe(1);
    expect(summary.fuelUsedL).toBeCloseTo(20, 5);
    expect(summary.tightWindowStops).toBe(1);

    const live = summary.drivers.find((row) => row.tripId === seed.liveTripId);
    const offline = summary.drivers.find((row) => row.tripId === seed.staleTripId);
    expect(live).toMatchObject({
      presence: 'live',
      lastSeenAt: LIVE_SEEN,
      lastStopStatus: 'delivered',
      pendingSyncCount: 0,
    });
    expect(offline).toMatchObject({
      presence: 'offline',
      lastSeenAt: STALE_SEEN,
      label: OFFLINE_LABEL,
      pendingSyncCount: 1,
      driverName: 'Van Driver',
    });
    expect(offline).not.toHaveProperty('lastStopStatus');

    const wider = dashboardSummarySchema.parse(await get(central.cookie, 'summary'));
    expect(wider.orders.confirmed).toBe(3);
    expect(wider.fleet).toEqual({ available: 4, unavailable: 1 });
  });

  it('blocks every role other than dispatcher', async () => {
    const anonymous = await app.inject({
      method: 'GET',
      url: `/api/v1/dashboard/summary?date=${DATE}`,
    });
    expect(anonymous.statusCode).toBe(401);

    for (const cookie of [loader.cookie, driver.cookie, store.cookie]) {
      for (const path of ['summary', 'exceptions', 'stream']) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/dashboard/${path}?date=${DATE}`,
          headers: { cookie },
        });
        expect(response.statusCode).toBe(403);
      }
      const timeline = await app.inject({
        method: 'GET',
        url: `/api/v1/audit?entityType=order&entityId=${seed.confirmedOrderId}`,
        headers: { cookie },
      });
      expect(timeline.statusCode).toBe(403);
    }
  });

  it('lists loading shortfalls, failed stops, and sync conflicts as exceptions', async () => {
    const body = dashboardExceptionsSchema.parse(await get(dispatcher.cookie, 'exceptions'));
    const loading = body.items.find((item) => item.type === 'loading_shortfall');
    const failed = body.items.find((item) => item.type === 'failed_delivery');
    const conflict = body.items.find((item) => item.type === 'sync_conflict');
    const stale = body.items.find((item) => item.type === 'stale_driver');
    expect(loading).toMatchObject({
      severity: 'high',
      entityType: 'loading_issue',
      entityId: seed.loadingIssueId,
      title: 'Loading shortfall',
      reason: '2 cases short',
      action: { href: `/api/v1/trips/${seed.loadingTripId}/loading` },
    });
    expect(failed).toMatchObject({
      severity: 'high',
      entityType: 'stop',
      entityId: seed.failedStopId,
      reason: 'Store closed',
      action: { href: `/api/v1/stops/${seed.failedStopId}` },
    });
    expect(body.items.find((item) => item.type === 'late_delivery')).toMatchObject({
      severity: 'medium',
      entityType: 'stop',
      entityId: seed.lateStopId,
      title: 'Late arrival',
    });
    expect(conflict).toMatchObject({
      severity: 'medium',
      entityType: 'sync_conflict',
      entityId: seed.conflictId,
      reason: 'Stop was removed or reassigned',
      action: { href: `/api/v1/trips/${seed.staleTripId}` },
    });
    expect(stale).toMatchObject({
      severity: 'medium',
      entityType: 'trip',
      entityId: seed.staleTripId,
      reason: OFFLINE_LABEL,
    });
    expect(stale?.reason).not.toMatch(/delivered|arrived|live/i);
    expect(body.items.find((item) => item.entityId === 'VEH804')).toMatchObject({
      type: 'vehicle_unavailable',
      severity: 'high',
    });
    expect(body.items.some((item) => item.type === 'repeat_deferral')).toBe(true);
    expect(body.items.some((item) => item.type === 'receipt_discrepancy')).toBe(true);
    expect(body.items.some((item) => item.type === 'tight_window')).toBe(true);
    expect(body.total).toBe(body.items.length);
    const rank = { high: 0, medium: 1, low: 2 } as const;
    const ranks = body.items.map((item) => rank[item.severity]);
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
  });

  it('opens an entity timeline from the audit log and hides other depots', async () => {
    const timeline = auditTimelineSchema.parse(
      json(
        await app.inject({
          method: 'GET',
          url: `/api/v1/audit?entityType=order&entityId=${seed.confirmedOrderId}`,
          headers: { cookie: dispatcher.cookie },
        }),
        200,
      ),
    );
    expect(timeline.total).toBe(1);
    expect(timeline.items[0]).toMatchObject({
      action: 'order.confirmed',
      entityType: 'order',
      entityId: seed.confirmedOrderId,
      role: 'dispatcher',
    });

    const hidden = await app.inject({
      method: 'GET',
      url: `/api/v1/audit?entityType=order&entityId=${seed.otherDepotOrderId}`,
      headers: { cookie: dispatcher.cookie },
    });
    expect(hidden.statusCode).toBe(404);
  });

  it('streams a domain event and still serves the summary after the stream closes', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP port');
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/dashboard/stream`, {
      headers: { cookie: dispatcher.cookie },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('Expected a response stream');

    try {
      const opened = await readUntil(reader, '"type":"ready"');
      expect(opened).toContain('retry: 15000');
      const foreignId = '0192f5e8-7b3a-7c3e-9a1b-2c3d4e5f6a99';
      app.domainEvents.publish({
        type: 'trip.departed',
        actorId: dispatcher.user.id,
        occurredAt: NOW,
        tripId: foreignId,
        vehicleId: 'VEH811',
        depotId: 'Kandy',
        version: 1,
      });
      app.domainEvents.publish({
        type: 'trip.departed',
        actorId: dispatcher.user.id,
        occurredAt: NOW,
        tripId: seed.liveTripId,
        vehicleId: 'VEH801',
        depotId: 'Peliyagoda',
        version: 1,
      });
      const streamed = await readUntil(reader, seed.liveTripId);
      expect(streamed).not.toContain(foreignId);
      const message = frames(streamed).find(
        (frame) =>
          typeof frame === 'object' &&
          frame !== null &&
          'entityId' in frame &&
          frame.entityId === seed.liveTripId,
      );
      expect(dashboardStreamMessageSchema.parse(message)).toEqual({
        type: 'trip.departed',
        occurredAt: NOW,
        entityType: 'trip',
        entityId: seed.liveTripId,
      });
    } finally {
      controller.abort();
      reader.releaseLock();
    }

    const summary = await app.inject({
      method: 'GET',
      url: `/api/v1/dashboard/summary?date=${DATE}`,
      headers: { cookie: dispatcher.cookie },
    });
    expect(summary.statusCode).toBe(200);
    expect(dashboardSummarySchema.parse(summary.json()).activeTrips).toBe(3);
  });

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

  async function get(cookie: string, path: 'summary' | 'exceptions') {
    return json(
      await app.inject({
        method: 'GET',
        url: `/api/v1/dashboard/${path}?date=${DATE}`,
        headers: { cookie },
      }),
      200,
    );
  }

  async function seedDay(passwordHash: string): Promise<Seed> {
    const db = database.db;
    await db.insert(depots).values([
      { id: 'Peliyagoda', name: 'Peliyagoda' },
      { id: 'Kandy', name: 'Kandy' },
    ]);
    await db
      .insert(districtTravel)
      .values([travel('Colombo', 'Peliyagoda'), travel('Kandy', 'Kandy')]);
    await db
      .insert(outlets)
      .values([
        outlet('OUT801', 'Colombo', 'Peliyagoda'),
        outlet('OUT802', 'Colombo', 'Peliyagoda'),
        outlet('OUT803', 'Colombo', 'Peliyagoda'),
        outlet('OUT804', 'Colombo', 'Peliyagoda'),
        outlet('OUT811', 'Kandy', 'Kandy'),
      ]);
    await db
      .insert(vehicles)
      .values([
        vehicle('VEH801', 'Peliyagoda', 'van', 'reefer', 1000, 10),
        vehicle('VEH802', 'Peliyagoda', 'truck', 'reefer', 2000, 20),
        vehicle('VEH803', 'Peliyagoda', 'van', 'ambient', 800, 8),
        vehicle('VEH804', 'Peliyagoda', 'truck', 'ambient', 3000, 30),
        vehicle('VEH811', 'Kandy', 'truck', 'ambient', 2000, 20),
      ]);
    await db.insert(vehicleAvailability).values({
      vehicleId: 'VEH804',
      date: DATE,
      status: 'in_workshop',
    });
    await db.insert(calendarDays).values([calendar(PREVIOUS, 2), calendar(DATE, 3)]);
    const accounts = await db
      .insert(users)
      .values([
        account('Peliyagoda Dispatcher', 'dash.dispatcher@waypoint.test', passwordHash, {
          role: 'dispatcher',
          depotId: 'Peliyagoda',
        }),
        account('Central Dispatcher', 'dash.central@waypoint.test', passwordHash, {
          role: 'dispatcher',
          depotId: null,
        }),
        account('Peliyagoda Loader', 'dash.loader@waypoint.test', passwordHash, {
          role: 'loader',
          depotId: 'Peliyagoda',
        }),
        account('Van Driver', 'dash.driver@waypoint.test', passwordHash, {
          role: 'driver',
          vehicleId: 'VEH801',
        }),
        account('Store Manager', 'dash.store@waypoint.test', passwordHash, {
          role: 'store_manager',
          outletId: 'OUT801',
        }),
      ])
      .returning({ id: users.id, email: users.email });
    const dispatcherId = idOf(accounts, 'dash.dispatcher@waypoint.test');
    const loaderId = idOf(accounts, 'dash.loader@waypoint.test');

    const confirmed = await insertOrder(db, 'OUT801', 'confirmed', 10, 1);
    await insertOrder(db, 'OUT802', 'confirmed', 10, 1);
    const deliveredOrder = await insertOrder(db, 'OUT801', 'delivered', 300, 3);
    const failedOrder = await insertOrder(db, 'OUT801', 'failed', 200, 2);
    const allocatedOrder = await insertOrder(db, 'OUT803', 'allocated', 400, 4);
    const dispatchedOrder = await insertOrder(db, 'OUT803', 'dispatched', 200, 2);
    const deferredOrder = await insertOrder(db, 'OUT804', 'deferred', 10, 1);
    const yesterdayOrder = await insertOrder(db, 'OUT804', 'deferred', 10, 1, PREVIOUS);
    const otherOrder = await insertOrder(db, 'OUT811', 'confirmed', 10, 1);

    const todayRun = await insertRun(db, 'Peliyagoda', DATE);
    const yesterdayRun = await insertRun(db, 'Peliyagoda', PREVIOUS);
    const liveTrip = await insertTrip(db, todayRun, 'VEH801', 1, 'departed');
    const loadingTrip = await insertTrip(db, todayRun, 'VEH803', 1, 'loading');
    const staleTrip = await insertTrip(db, todayRun, 'VEH801', 2, 'departed');

    const deliveredStop = await insertStop(
      db,
      liveTrip,
      deliveredOrder,
      1,
      'delivered',
      EARLY,
      true,
    );
    const failedStop = await insertStop(db, liveTrip, failedOrder, 2, 'failed', EARLY);
    await insertStop(db, loadingTrip, allocatedOrder, 1, 'pending', TIGHT);
    const staleStop = await insertStop(db, staleTrip, dispatchedOrder, 1, 'arrived', EARLY);

    await db
      .insert(deferrals)
      .values([
        deferral(yesterdayOrder, yesterdayRun, dispatcherId, new Date(PREVIOUS)),
        deferral(deferredOrder, todayRun, dispatcherId, new Date(NOW)),
      ]);
    await db
      .insert(fuelLedger)
      .values([
        fuel(liveTrip, 'VEH801', 10),
        fuel(loadingTrip, 'VEH803', 6),
        fuel(staleTrip, 'VEH801', 4),
      ]);
    await db.insert(loadingRecords).values([
      {
        tripId: liveTrip,
        status: 'departed' as const,
        loaderId,
        acceptedTripVersion: 0,
      },
      {
        tripId: loadingTrip,
        status: 'in_progress' as const,
        loaderId,
        acceptedTripVersion: 0,
      },
    ]);
    const loadingIssue = first(
      await db
        .insert(loadingIssues)
        .values({
          tripId: loadingTrip,
          orderId: allocatedOrder,
          type: 'short',
          qty: 2,
          note: '2 cases short',
          loaderId,
          createdAt: new Date(NOW),
        })
        .returning({ id: loadingIssues.id }),
      'loading issue',
    );
    await db
      .insert(stopEvents)
      .values([
        event(deliveredStop, 'delivered', LIVE_SEEN, { podId: randomUUID() }),
        event(failedStop, 'failed', FAILED_AT, { reason: 'Store closed' }),
        event(staleStop, 'arrived', STALE_SEEN, {}),
      ]);
    const conflictEvent = first(
      await db
        .insert(stopEvents)
        .values(event(staleStop, 'arrived', EARLIER, {}))
        .returning({ id: stopEvents.id }),
      'conflict event',
    );
    const conflict = first(
      await db
        .insert(syncConflicts)
        .values({
          eventId: conflictEvent.id,
          reason: 'Stop was removed or reassigned',
          createdAt: new Date(EARLIER),
        })
        .returning({ id: syncConflicts.id }),
      'conflict',
    );
    await db.insert(issues).values({
      orderId: deliveredOrder,
      type: 'missing',
      note: 'Short delivery',
      status: 'open',
      createdBy: dispatcherId,
      createdAt: new Date(NOW),
    });
    await db.insert(auditLog).values([
      {
        actorId: dispatcherId,
        role: 'dispatcher',
        action: 'order.confirmed',
        entityType: 'order',
        entityId: confirmed,
        after: { status: 'confirmed' },
        createdAt: new Date(NOW),
      },
      {
        actorId: dispatcherId,
        role: 'dispatcher',
        action: 'order.confirmed',
        entityType: 'order',
        entityId: otherOrder,
        after: { status: 'confirmed' },
        createdAt: new Date(NOW),
      },
    ]);

    return {
      confirmedOrderId: confirmed,
      otherDepotOrderId: otherOrder,
      loadingIssueId: loadingIssue.id,
      loadingTripId: loadingTrip,
      failedStopId: failedStop,
      lateStopId: deliveredStop,
      conflictId: conflict.id,
      liveTripId: liveTrip,
      staleTripId: staleTrip,
    };
  }
});

interface Seed {
  confirmedOrderId: string;
  otherDepotOrderId: string;
  loadingIssueId: string;
  loadingTripId: string;
  failedStopId: string;
  lateStopId: string;
  conflictId: string;
  liveTripId: string;
  staleTripId: string;
}

function json(response: { statusCode: number; body: string; json: () => unknown }, status: number) {
  expect(response.statusCode, response.body).toBe(status);
  return response.json();
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pattern: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const next = await reader.read();
    if (next.value !== undefined) buffer += decoder.decode(next.value, { stream: true });
    if (buffer.includes(pattern)) return buffer;
    if (next.done) break;
  }
  throw new Error(`Timed out waiting for ${pattern}. Saw: ${buffer}`);
}

function frames(buffer: string): unknown[] {
  const payloads: unknown[] = [];
  for (const block of buffer.split('\n\n')) {
    const data = block
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice('data: '.length);
    if (data !== undefined) payloads.push(JSON.parse(data));
  }
  return payloads;
}

function travel(district: string, depotId: string) {
  return {
    district,
    depotId,
    roadClass: 'urban' as const,
    depotToDistrictKm: 12,
    depotToDistrictMin: 20,
    interStopKm: 3,
    interStopMin: 8,
  };
}

function outlet(id: string, district: string, depotId: string) {
  return {
    id,
    brand: 'Fresh' as const,
    district,
    depotId,
    dockType: 'street' as const,
    parkingConstraint: 'normal' as const,
    windowOpen: '05:00:00',
    windowClose: '08:00:00',
  };
}

function vehicle(
  id: string,
  depotId: string,
  type: 'van' | 'truck',
  temp: 'reefer' | 'ambient',
  weightCapKg: number,
  volumeCapM3: number,
) {
  return {
    id,
    type,
    temp,
    weightCapKg,
    volumeCapM3,
    fuelType: 'diesel',
    kmPerL: 10,
    weeklyFuelQuotaL: 200,
    depotId,
  };
}

function calendar(date: string, dow: number) {
  return {
    date,
    dow,
    isoYear: 2026,
    isoWeek: 41,
    isPayday: false,
    festival: null,
    festivalRamp: 0,
    isHoliday: false,
    monsoon: false,
    isOperating: true,
  };
}

function account(
  name: string,
  email: string,
  passwordHash: string,
  scope:
    | { role: 'dispatcher'; depotId: string | null }
    | { role: 'loader'; depotId: string }
    | { role: 'driver'; vehicleId: string }
    | { role: 'store_manager'; outletId: string },
) {
  return { name, email, passwordHash, ...scope };
}

async function insertOrder(
  db: Awaited<ReturnType<typeof createMigratedDatabase>>['db'],
  outletId: string,
  status: 'confirmed' | 'delivered' | 'failed' | 'allocated' | 'dispatched' | 'deferred',
  weightKg: number,
  volumeM3: number,
  requestedDate = DATE,
) {
  return first(
    await db
      .insert(orders)
      .values({
        outletId,
        brand: 'Fresh',
        temp: 'ambient',
        requestedDate,
        units: 1,
        weightKg,
        volumeM3,
        status,
      })
      .returning({ id: orders.id }),
    'order',
  ).id;
}

async function insertRun(
  db: Awaited<ReturnType<typeof createMigratedDatabase>>['db'],
  depotId: string,
  serviceDate: string,
) {
  return first(
    await db
      .insert(planningRuns)
      .values({ depotId, serviceDate })
      .returning({ id: planningRuns.id }),
    'run',
  ).id;
}

async function insertTrip(
  db: Awaited<ReturnType<typeof createMigratedDatabase>>['db'],
  runId: string,
  vehicleId: string,
  tripNo: 1 | 2,
  status: 'departed' | 'loading',
) {
  return first(
    await db
      .insert(trips)
      .values({
        runId,
        vehicleId,
        tripNo,
        brand: 'Fresh',
        district: 'Colombo',
        status,
        plannedMinutes: 40,
        plannedKm: 18,
      })
      .returning({ id: trips.id }),
    'trip',
  ).id;
}

async function insertStop(
  db: Awaited<ReturnType<typeof createMigratedDatabase>>['db'],
  tripId: string,
  orderId: string,
  seq: number,
  status: 'pending' | 'arrived' | 'delivered' | 'failed',
  plannedArrival: string,
  late = false,
) {
  return first(
    await db
      .insert(tripStops)
      .values({ tripId, orderId, seq, status, plannedArrival: new Date(plannedArrival), late })
      .returning({ id: tripStops.id }),
    'stop',
  ).id;
}

function deferral(orderId: string, runId: string, actorId: string, createdAt: Date) {
  return {
    orderId,
    runId,
    reasonCode: 'VOLUME_CAP' as const,
    type: 'prioritized' as const,
    actorId,
    createdAt,
  };
}

function fuel(tripId: string, vehicleId: string, litres: number) {
  return { tripId, vehicleId, litres, isoYear: 2026, isoWeek: 41 };
}

function event(
  stopId: string,
  type: 'arrived' | 'delivered' | 'failed',
  serverTime: string,
  payload: { podId: string } | { reason: string } | Record<string, never>,
) {
  return {
    clientEventId: randomUUID(),
    stopId,
    type,
    payload,
    clientTime: new Date(serverTime),
    serverTime: new Date(serverTime),
    tripVersion: 0,
  };
}

function idOf(rows: { id: string; email: string }[], email: string): string {
  const row = rows.find((item) => item.email === email);
  if (row === undefined) throw new Error(`Expected ${email}`);
  return row.id;
}

function first<T>(rows: T[], label: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`Expected ${label}`);
  return row;
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
