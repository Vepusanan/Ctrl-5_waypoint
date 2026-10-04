import { randomBytes, randomUUID } from 'node:crypto';
import {
  auditLog,
  depots,
  districtTravel,
  notifications,
  orders,
  outlets,
  planningRuns,
  pods,
  stopEvents,
  syncConflicts,
  tripStops,
  trips,
  users,
  vehicles,
} from '@waypoint/database';
import {
  currentUserResponseSchema,
  deliveryStopSchema,
  podSchema,
  stopEventSchema,
  type User,
} from '@waypoint/shared';
import { eq } from 'drizzle-orm';
import { argon2id } from 'hash-wasm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { client, cookiePair, SESSION_SECRET } from '../../../../test/http.ts';
import { createMigratedDatabase } from '../../../../test/postgres.ts';
import { buildApp } from '../../../app.ts';
import type { DomainEvent } from '../../../plugins/domain-events.ts';
import { MAX_IMAGE_BYTES } from '../images.ts';

const SERVICE_DATE = '2026-10-08';
const PINNED = '2026-10-08T07:00:00.000+05:30';
const ON_TIME = '2026-10-08T07:20:00.000+05:30';
const LATE = '2026-10-08T08:30:00.000+05:30';
const PASSWORD = 'waypoint-demo';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describe('deliveries', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
  let dispatcher: { cookie: string; user: User };
  let driver: { cookie: string; user: User };
  let otherDriverCookie: string;
  let loaderCookie: string;
  let store: { cookie: string; user: User };
  let tripNo = 0;

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
    dispatcher = await login('delivery.dispatcher@waypoint.test');
    driver = await login('delivery.driver@waypoint.test');
    otherDriverCookie = (await login('delivery.other-driver@waypoint.test')).cookie;
    loaderCookie = (await login('delivery.loader@waypoint.test')).cookie;
    store = await login('delivery.store@waypoint.test');
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  beforeEach(async () => {
    tripNo = 0;
    await database.db.delete(notifications);
    await database.db.delete(syncConflicts);
    await database.db.delete(stopEvents);
    await database.db.delete(pods);
    await database.db.delete(tripStops);
    await database.db.delete(trips);
    await database.db.delete(orders);
    await database.db.delete(planningRuns);
    app.clock.pin(new Date(PINNED));
  });

  it('lets the assigned driver record arrival', async () => {
    const trip = await insertTrip();
    const stopId = trip.stopIds[0] ?? missing('stop');
    const response = await postEvent(driver.cookie, stopId, {
      type: 'arrived',
      clientTime: ON_TIME,
    });
    const event = stopEventSchema.parse(json(response, 201));
    expect(event).toMatchObject({
      type: 'arrived',
      stopId,
      clientTime: ON_TIME,
      serverTime: PINNED,
      payload: {},
      tripVersion: 0,
    });

    const stop = deliveryStopSchema.parse(json(await getStop(driver.cookie, stopId), 200));
    expect(stop.status).toBe('arrived');
    expect(stop.late).toBe(false);
    expect(stop.eta).toBe(stop.plannedArrival);
    expect(stop.order.status).toBe('dispatched');
    const stored = await database.db.select().from(tripStops);
    expect(stored[0]).toMatchObject({ status: 'arrived', late: false });
  });

  it('returns 404 when another driver records the stop', async () => {
    const trip = await insertTrip();
    const stopId = trip.stopIds[0] ?? missing('stop');
    const response = await postEvent(otherDriverCookie, stopId, { type: 'arrived' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    const stored = await database.db.select().from(tripStops);
    expect(stored[0]?.status).toBe('pending');

    const pod = await postPod(otherDriverCookie, stopId);
    expect(pod.statusCode).toBe(404);
    const idle = await insertTrip({ status: 'published', orderStatus: 'allocated' });
    const hidden = await postEvent(driver.cookie, idle.stopIds[0] ?? missing('stop'), {
      type: 'arrived',
    });
    expect(hidden.statusCode).toBe(404);
  });

  it('sets late when arrival is after the outlet window and shifts the next ETA', async () => {
    const trip = await insertTrip({
      stops: [
        { seq: 1, plannedArrival: '07:10:00' },
        { seq: 2, plannedArrival: '07:40:00' },
      ],
    });
    const first = trip.stopIds[0] ?? missing('stop');
    const second = trip.stopIds[1] ?? missing('stop');
    const before = deliveryStopSchema.parse(json(await getStop(driver.cookie, second), 200));
    expect(before.eta).toBe(before.plannedArrival);
    const response = await postEvent(driver.cookie, first, { type: 'arrived', clientTime: LATE });
    expect(response.statusCode).toBe(201);
    const arrived = deliveryStopSchema.parse(json(await getStop(driver.cookie, first), 200));
    expect(arrived.late).toBe(true);
    expect(arrived.windowClose).toBe('08:00');
    const next = deliveryStopSchema.parse(json(await getStop(driver.cookie, second), 200));
    expect(next.eta).toBe('2026-10-08T09:00:00.000+05:30');
    expect(next.plannedArrival).toBe('2026-10-08T07:40:00.000+05:30');
    expect(next.late).toBe(false);
  });

  it('lets a late arrival still be delivered', async () => {
    const trip = await insertTrip();
    const stopId = trip.stopIds[0] ?? missing('stop');
    await postEvent(driver.cookie, stopId, { type: 'arrived', clientTime: LATE });
    const pod = podSchema.parse(json(await postPod(driver.cookie, stopId), 201));
    const response = await postEvent(driver.cookie, stopId, {
      type: 'delivered',
      clientTime: LATE,
      podId: pod.id,
    });
    expect(response.statusCode).toBe(201);
    const stop = deliveryStopSchema.parse(json(await getStop(driver.cookie, stopId), 200));
    expect(stop.status).toBe('delivered');
    expect(stop.late).toBe(true);
    expect(stop.order.status).toBe('delivered');
  });

  it('delivers a stop that has arrived and has proof of delivery', async () => {
    const trip = await insertTrip();
    const stopId = trip.stopIds[0] ?? missing('stop');
    await postEvent(driver.cookie, stopId, { type: 'arrived' });
    const pod = podSchema.parse(json(await postPod(driver.cookie, stopId), 201));
    const response = await postEvent(driver.cookie, stopId, { type: 'delivered', podId: pod.id });
    const event = stopEventSchema.parse(json(response, 201));
    expect(event.type).toBe('delivered');
    expect(event.payload).toEqual({ podId: pod.id });
    const stop = deliveryStopSchema.parse(json(await getStop(dispatcher.cookie, stopId), 200));
    expect(stop.status).toBe('delivered');
    expect(stop.late).toBe(false);
    expect(stop.order.status).toBe('delivered');
    expect(stop.pod?.id).toBe(pod.id);
  });

  it('completes the trip when its last stop has an outcome', async () => {
    const trip = await insertTrip();
    for (const [index, stopId] of trip.stopIds.entries()) {
      const before = await database.db.select().from(trips).where(eq(trips.id, trip.tripId));
      expect(before[0]?.status).toBe('departed');
      await postEvent(driver.cookie, stopId, { type: 'arrived' });
      if (index === 0) {
        const pod = podSchema.parse(json(await postPod(driver.cookie, stopId), 201));
        json(await postEvent(driver.cookie, stopId, { type: 'delivered', podId: pod.id }), 201);
      } else {
        json(
          await postEvent(driver.cookie, stopId, { type: 'failed', reason: 'Outlet closed' }),
          201,
        );
      }
    }
    const after = await database.db.select().from(trips).where(eq(trips.id, trip.tripId));
    expect(after[0]?.status).toBe('completed');
    const audit = await database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, trip.tripId));
    expect(audit.map((row) => row.action)).toContain('trip.completed');
    // The driver can still open a stop on the finished trip.
    const stopId = trip.stopIds[0] ?? missing('stop');
    expect((await getStop(driver.cookie, stopId)).statusCode).toBe(200);
  });

  it('requires a reason before a delivery can fail', async () => {
    const trip = await insertTrip();
    const stopId = trip.stopIds[0] ?? missing('stop');
    await postEvent(driver.cookie, stopId, { type: 'arrived' });
    const missingReason = await app.inject({
      method: 'POST',
      url: `/api/v1/stops/${stopId}/events`,
      headers: { cookie: driver.cookie },
      payload: {
        clientEventId: randomUUID(),
        stopId,
        clientTime: ON_TIME,
        tripVersion: 0,
        type: 'failed',
        payload: {},
      },
    });
    expect(missingReason.statusCode).toBe(400);
    expect(missingReason.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const response = await postEvent(driver.cookie, stopId, {
      type: 'failed',
      reason: 'Outlet closed',
    });
    expect(response.statusCode).toBe(201);
    const stop = deliveryStopSchema.parse(json(await getStop(dispatcher.cookie, stopId), 200));
    expect(stop.status).toBe('failed');
    expect(stop.failureReason).toBe('Outlet closed');
    expect(stop.order.status).toBe('failed');
  });

  it('rejects an illegal stop transition', async () => {
    const trip = await insertTrip();
    const stopId = trip.stopIds[0] ?? missing('stop');
    const delivered = await postEvent(driver.cookie, stopId, {
      type: 'delivered',
      podId: randomUUID(),
    });
    expect(delivered.statusCode).toBe(422);
    expect(delivered.json()).toMatchObject({
      error: {
        code: 'CONSTRAINT_VIOLATION',
        message: 'Stop cannot move from pending to delivered',
      },
    });
    const failed = await postEvent(driver.cookie, stopId, { type: 'failed', reason: 'Closed' });
    expect(failed.statusCode).toBe(422);
    expect(failed.json()).toMatchObject({
      error: { code: 'CONSTRAINT_VIOLATION', message: 'Stop cannot move from pending to failed' },
    });
    expect((await postEvent(driver.cookie, stopId, { type: 'arrived' })).statusCode).toBe(201);
    const again = await postEvent(driver.cookie, stopId, { type: 'arrived' });
    expect(again.statusCode).toBe(422);
    expect(again.json()).toMatchObject({
      error: { code: 'CONSTRAINT_VIOLATION', message: 'Stop cannot move from arrived to arrived' },
    });
    const rows = await database.db.select().from(stopEvents);
    expect(rows).toHaveLength(1);
  });

  it('requires a recipient name and a signature image', async () => {
    const trip = await insertTrip();
    const stopId = trip.stopIds[0] ?? missing('stop');
    const noName = await postPod(driver.cookie, stopId, { recipientName: '   ' });
    expect(noName.statusCode).toBe(400);
    expect(noName.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    const noSignature = await postPod(driver.cookie, stopId, { signature: null });
    expect(noSignature.statusCode).toBe(400);
    expect(noSignature.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', message: 'Signature is required' },
    });
    const stored = await database.db.select().from(pods);
    expect(stored).toHaveLength(0);
  });

  it('accepts an optional photo and refuses a replacement', async () => {
    const trip = await insertTrip();
    const stopId = trip.stopIds[0] ?? missing('stop');
    const created = podSchema.parse(
      json(
        await postPod(driver.cookie, stopId, {
          photo: { data: JPEG, contentType: 'application/octet-stream' },
        }),
        201,
      ),
    );
    expect(created.hasPhoto).toBe(true);
    expect(created.recipientName).toBe('K. Silva');
    const stop = deliveryStopSchema.parse(json(await getStop(driver.cookie, stopId), 200));
    expect(stop.pod).toMatchObject({ id: created.id, hasPhoto: true });

    const replacement = await postPod(driver.cookie, stopId, {
      signature: Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
    });
    expect(replacement.statusCode).toBe(422);
    expect(replacement.json()).toMatchObject({ error: { code: 'CONSTRAINT_VIOLATION' } });
    const rows = await database.db.select({ signature: pods.signature }).from(pods);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.signature.equals(PNG)).toBe(true);
  });

  it('rejects an oversized or non-image upload', async () => {
    const trip = await insertTrip();
    const stopId = trip.stopIds[0] ?? missing('stop');
    const text = await postPod(driver.cookie, stopId, {
      signature: Buffer.from('not an image'),
      signatureType: 'image/png',
    });
    expect(text.statusCode).toBe(400);
    expect(text.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    PNG.copy(oversized);
    const huge = await postPod(driver.cookie, stopId, { signature: oversized });
    expect(huge.statusCode).toBe(400);
    expect(huge.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(await database.db.select().from(pods)).toHaveLength(0);
  });

  it('emits dispatcher event hooks and keeps mutation on the driver', async () => {
    const trip = await insertTrip();
    const stopId = trip.stopIds[0] ?? missing('stop');
    const seen: DomainEvent[] = [];
    const stopListening = app.domainEvents.subscribe((event) => {
      seen.push(event);
    });
    expect((await postEvent(driver.cookie, stopId, { type: 'arrived' })).statusCode).toBe(201);
    expect(
      (await postEvent(driver.cookie, stopId, { type: 'failed', reason: 'Refused' })).statusCode,
    ).toBe(201);
    stopListening();

    expect(seen.map((event) => event.type)).toEqual(['stop.arrived', 'stop.failed']);
    expect(seen[1]).toMatchObject({
      type: 'stop.failed',
      stopId,
      tripId: trip.tripId,
      depotId: 'Peliyagoda',
      outletId: 'OUT401',
      actorId: driver.user.id,
      occurredAt: PINNED,
    });
    const notes = await database.db.select().from(notifications);
    expect(notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipientId: dispatcher.user.id,
          type: 'delivery_failed',
          priority: 'high',
          entityType: 'stop',
          entityId: stopId,
        }),
      ]),
    );
    const read = await getStop(dispatcher.cookie, stopId);
    expect(deliveryStopSchema.parse(json(read, 200)).status).toBe('failed');
    expect((await postEvent(dispatcher.cookie, stopId, { type: 'arrived' })).statusCode).toBe(403);
    expect((await postEvent(loaderCookie, stopId, { type: 'arrived' })).statusCode).toBe(403);
    expect((await postPod(dispatcher.cookie, stopId)).statusCode).toBe(403);
  });

  it('updates the order and notifies the store without a driver endpoint', async () => {
    const trip = await insertTrip({
      stops: [
        { seq: 1, plannedArrival: '07:10:00' },
        { seq: 2, plannedArrival: '07:40:00' },
      ],
    });
    const deliveredStop = trip.stopIds[0] ?? missing('stop');
    const failedStop = trip.stopIds[1] ?? missing('stop');
    await postEvent(driver.cookie, deliveredStop, { type: 'arrived' });
    const pod = podSchema.parse(json(await postPod(driver.cookie, deliveredStop), 201));
    expect(
      (await postEvent(driver.cookie, deliveredStop, { type: 'delivered', podId: pod.id }))
        .statusCode,
    ).toBe(201);
    await postEvent(driver.cookie, failedStop, { type: 'arrived' });
    expect(
      (await postEvent(driver.cookie, failedStop, { type: 'failed', reason: 'No receiver' }))
        .statusCode,
    ).toBe(201);

    const storedOrders = await database.db.select().from(orders);
    const byId = new Map(storedOrders.map((order) => [order.id, order.status]));
    expect(byId.get(trip.orderIds[0] ?? missing('order'))).toBe('delivered');
    expect(byId.get(trip.orderIds[1] ?? missing('order'))).toBe('failed');

    const notes = await database.db.select().from(notifications);
    expect(notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipientId: store.user.id,
          type: 'delivered',
          priority: 'info',
          entityId: deliveredStop,
        }),
        expect.objectContaining({
          recipientId: store.user.id,
          type: 'delivery_failed',
          priority: 'high',
          entityId: failedStop,
        }),
      ]),
    );
    expect(
      notes.some((note) => note.type === 'delivered' && note.recipientId === dispatcher.user.id),
    ).toBe(false);
    expect((await getStop(store.cookie, deliveredStop)).statusCode).toBe(403);
    expect((await postEvent(store.cookie, failedStop, { type: 'arrived' })).statusCode).toBe(403);
  });

  it('writes an audit row for the stop outcome', async () => {
    const trip = await insertTrip();
    const stopId = trip.stopIds[0] ?? missing('stop');
    const response = await postEvent(driver.cookie, stopId, {
      type: 'arrived',
      clientTime: ON_TIME,
    });
    const event = stopEventSchema.parse(json(response, 201));
    const rows = await database.db.select().from(auditLog).where(eq(auditLog.entityId, stopId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: driver.user.id,
      role: 'driver',
      action: 'stop.arrived',
      entityType: 'stop',
      entityId: stopId,
      before: { status: 'pending', late: false, orderStatus: 'dispatched' },
      after: {
        status: 'arrived',
        late: false,
        orderStatus: 'dispatched',
        stopId,
        tripId: trip.tripId,
        orderId: trip.orderIds[0],
        clientEventId: event.clientEventId,
        clientTime: ON_TIME,
        serverTime: PINNED,
        clockSkew: false,
        tripVersion: 0,
        eventId: event.id,
      },
    });
  });

  it('does not apply the same client event twice', async () => {
    const trip = await insertTrip();
    const stopId = trip.stopIds[0] ?? missing('stop');
    const body = eventBody(stopId, { type: 'arrived' });
    expect((await postRaw(driver.cookie, stopId, body)).statusCode).toBe(201);
    const seen: DomainEvent[] = [];
    const stopListening = app.domainEvents.subscribe((event) => {
      seen.push(event);
    });
    const replay = await postRaw(driver.cookie, stopId, body);
    stopListening();
    expect(replay.statusCode).toBe(200);
    expect(stopEventSchema.parse(replay.json()).clientEventId).toBe(body.clientEventId);
    expect(seen).toEqual([]);
    expect(await database.db.select().from(stopEvents)).toHaveLength(1);
    expect(
      await database.db.select().from(auditLog).where(eq(auditLog.entityId, stopId)),
    ).toHaveLength(1);
    expect(await database.db.select().from(notifications)).toHaveLength(0);
  });

  it('accepts a skewed client clock and records the flag', async () => {
    const trip = await insertTrip();
    const stopId = trip.stopIds[0] ?? missing('stop');
    const skewed = '2026-10-07T17:00:00.000+05:30';
    const response = await postEvent(driver.cookie, stopId, {
      type: 'arrived',
      clientTime: skewed,
    });
    const event = stopEventSchema.parse(json(response, 201));
    const stop = deliveryStopSchema.parse(json(await getStop(driver.cookie, stopId), 200));
    expect(stop.status).toBe('arrived');
    expect(stop.late).toBe(false);
    const rows = await database.db.select().from(auditLog).where(eq(auditLog.entityId, stopId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.after).toMatchObject({
      clientEventId: event.clientEventId,
      clientTime: skewed,
      serverTime: PINNED,
      clockSkew: true,
      status: 'arrived',
    });
  });

  it('applies only one of two concurrent copies of the same client event', async () => {
    const trip = await insertTrip();
    const stopId = trip.stopIds[0] ?? missing('stop');
    const body = eventBody(stopId, { type: 'arrived' });
    const seen: DomainEvent[] = [];
    const stopListening = app.domainEvents.subscribe((event) => {
      seen.push(event);
    });
    const [first, second] = await Promise.all([
      postRaw(driver.cookie, stopId, body),
      postRaw(driver.cookie, stopId, body),
    ]);
    stopListening();
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 201]);
    const stored = stopEventSchema.parse(first.statusCode === 201 ? first.json() : second.json());
    expect(stored.clientEventId).toBe(body.clientEventId);
    expect(seen).toEqual([expect.objectContaining({ type: 'stop.arrived', stopId })]);
    expect(await database.db.select().from(stopEvents)).toHaveLength(1);
    expect(
      await database.db.select().from(auditLog).where(eq(auditLog.entityId, stopId)),
    ).toHaveLength(1);
    expect(await database.db.select().from(notifications)).toHaveLength(0);
    const stop = deliveryStopSchema.parse(json(await getStop(driver.cookie, stopId), 200));
    expect(stop.status).toBe('arrived');
  });

  it('rejects delivery until proof of delivery exists for that stop', async () => {
    const trip = await insertTrip();
    const stopId = trip.stopIds[0] ?? missing('stop');
    expect((await postEvent(driver.cookie, stopId, { type: 'arrived' })).statusCode).toBe(201);
    const response = await postEvent(driver.cookie, stopId, {
      type: 'delivered',
      podId: randomUUID(),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: 'CONSTRAINT_VIOLATION', message: 'Delivery requires proof of delivery' },
    });
    const stop = deliveryStopSchema.parse(json(await getStop(driver.cookie, stopId), 200));
    expect(stop.status).toBe('arrived');
    expect(stop.order.status).toBe('dispatched');
    expect(await database.db.select().from(notifications)).toHaveLength(0);
  });

  it('accepts a JPEG signature even when the declared type is PNG', async () => {
    const trip = await insertTrip();
    const stopId = trip.stopIds[0] ?? missing('stop');
    const response = await postPod(driver.cookie, stopId, {
      signature: JPEG,
      signatureType: 'image/png',
    });
    const pod = podSchema.parse(json(response, 201));
    expect(pod.hasPhoto).toBe(false);
    const rows = await database.db.select({ signature: pods.signature }).from(pods);
    expect(rows[0]?.signature.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
  });

  async function postEvent(
    cookie: string,
    stopId: string,
    input: {
      type: 'arrived' | 'delivered' | 'failed';
      clientTime?: string;
      podId?: string;
      reason?: string;
    },
  ) {
    return postRaw(cookie, stopId, eventBody(stopId, input));
  }

  async function postRaw(cookie: string, stopId: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/stops/${stopId}/events`,
      headers: { cookie },
      payload,
    });
  }

  async function postPod(
    cookie: string,
    stopId: string,
    options: {
      recipientName?: string;
      signature?: Buffer | null;
      signatureType?: string;
      photo?: { data: Buffer; contentType: string };
    } = {},
  ) {
    const fields: Record<string, string> = { clientTime: ON_TIME };
    if (options.recipientName !== undefined) fields.recipientName = options.recipientName;
    else fields.recipientName = 'K. Silva';
    const files = [];
    if (options.signature !== null) {
      files.push({
        name: 'signature',
        filename: 'signature.png',
        contentType: options.signatureType ?? 'image/png',
        data: options.signature ?? PNG,
      });
    }
    if (options.photo !== undefined) {
      files.push({
        name: 'photo',
        filename: 'photo.jpg',
        contentType: options.photo.contentType,
        data: options.photo.data,
      });
    }
    const body = multipartBody(fields, files);
    return app.inject({
      method: 'POST',
      url: `/api/v1/stops/${stopId}/pod`,
      headers: { cookie, 'content-type': body.contentType },
      payload: body.payload,
    });
  }

  async function getStop(cookie: string, stopId: string) {
    return app.inject({ method: 'GET', url: `/api/v1/stops/${stopId}`, headers: { cookie } });
  }

  async function insertTrip(
    options: {
      vehicleId?: string;
      status?: 'departed' | 'published';
      orderStatus?: 'dispatched' | 'allocated';
      stops?: { seq: number; plannedArrival: string }[];
    } = {},
  ): Promise<{ tripId: string; orderIds: string[]; stopIds: string[] }> {
    const vehicleId = options.vehicleId ?? 'VEH401';
    tripNo += 1;
    if (tripNo !== 1 && tripNo !== 2) throw new Error('A vehicle can only have two trips');
    const runId = await ensureRun();
    const created = await database.db
      .insert(trips)
      .values({
        runId,
        vehicleId,
        tripNo,
        brand: 'Fresh',
        district: 'Colombo',
        status: options.status ?? 'departed',
        version: 0,
        plannedMinutes: 40,
        plannedKm: 12,
      })
      .returning({ id: trips.id });
    const tripId = created[0]?.id;
    if (tripId === undefined) throw new Error('Expected a trip id');
    const plan = options.stops ?? [{ seq: 1, plannedArrival: '07:10:00' }];
    const orderIds: string[] = [];
    const stopIds: string[] = [];
    for (const stop of plan) {
      const order = await database.db
        .insert(orders)
        .values({
          outletId: 'OUT401',
          brand: 'Fresh',
          temp: 'ambient',
          requestedDate: SERVICE_DATE,
          units: 4,
          weightKg: 12,
          volumeM3: 0.4,
          status: options.orderStatus ?? 'dispatched',
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
          plannedArrival: new Date(`${SERVICE_DATE}T${stop.plannedArrival}.000+05:30`),
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

  async function ensureRun(): Promise<string> {
    const existing = await database.db
      .select({ id: planningRuns.id })
      .from(planningRuns)
      .where(eq(planningRuns.depotId, 'Peliyagoda'));
    const found = existing[0]?.id;
    if (found !== undefined) return found;
    const inserted = await database.db
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
    await database.db.insert(districtTravel).values({
      district: 'Colombo',
      depotId: 'Peliyagoda',
      roadClass: 'urban',
      depotToDistrictKm: 12,
      depotToDistrictMin: 24,
      interStopKm: 4,
      interStopMin: 8,
    });
    await database.db.insert(outlets).values({
      id: 'OUT401',
      brand: 'Fresh',
      district: 'Colombo',
      depotId: 'Peliyagoda',
      dockType: 'street',
      parkingConstraint: 'normal',
      windowOpen: '05:00:00',
      windowClose: '08:00:00',
    });
    await database.db
      .insert(vehicles)
      .values([vehicle('VEH401', 'Peliyagoda'), vehicle('VEH402', 'Peliyagoda')]);
    await database.db.insert(users).values([
      {
        name: 'Peliyagoda Dispatcher',
        email: 'delivery.dispatcher@waypoint.test',
        passwordHash,
        role: 'dispatcher',
        depotId: 'Peliyagoda',
      },
      {
        name: 'Peliyagoda Loader',
        email: 'delivery.loader@waypoint.test',
        passwordHash,
        role: 'loader',
        depotId: 'Peliyagoda',
      },
      {
        name: 'Van Driver',
        email: 'delivery.driver@waypoint.test',
        passwordHash,
        role: 'driver',
        vehicleId: 'VEH401',
      },
      {
        name: 'Other Driver',
        email: 'delivery.other-driver@waypoint.test',
        passwordHash,
        role: 'driver',
        vehicleId: 'VEH402',
      },
      {
        name: 'Store Manager',
        email: 'delivery.store@waypoint.test',
        passwordHash,
        role: 'store_manager',
        outletId: 'OUT401',
      },
    ]);
  }
});

function eventBody(
  stopId: string,
  input: {
    type: 'arrived' | 'delivered' | 'failed';
    clientTime?: string;
    podId?: string;
    reason?: string;
  },
) {
  const base = {
    clientEventId: randomUUID(),
    stopId,
    clientTime: input.clientTime ?? ON_TIME,
    tripVersion: 0,
  };
  if (input.type === 'arrived') return { ...base, type: 'arrived' as const, payload: {} };
  if (input.type === 'delivered') {
    return { ...base, type: 'delivered' as const, payload: { podId: input.podId ?? randomUUID() } };
  }
  return { ...base, type: 'failed' as const, payload: { reason: input.reason ?? 'Closed' } };
}

function multipartBody(
  fields: Record<string, string>,
  files: { name: string; filename: string; contentType: string; data: Buffer }[],
): { payload: Buffer; contentType: string } {
  const boundary = '----WaypointPod';
  const chunks: Buffer[] = [];
  const push = (value: string) => {
    chunks.push(Buffer.from(value));
  };
  for (const [name, value] of Object.entries(fields)) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  for (const file of files) {
    push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    );
    chunks.push(file.data);
    push('\r\n');
  }
  push(`--${boundary}--\r\n`);
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function json(response: { statusCode: number; json: () => unknown }, status: number): unknown {
  expect(response.statusCode).toBe(status);
  return response.json();
}

function missing(label: string): never {
  throw new Error(`Expected a ${label}`);
}

function vehicle(id: string, depotId: string) {
  return {
    id,
    type: 'van' as const,
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
