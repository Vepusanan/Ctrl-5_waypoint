import { randomBytes } from 'node:crypto';
import {
  auditLog,
  depots,
  districtTravel,
  issues,
  notifications,
  orders,
  outlets,
  planningRuns,
  receipts,
  tripStops,
  trips,
  users,
  vehicles,
} from '@waypoint/database';
import {
  currentUserResponseSchema,
  issueListResponseSchema,
  issueSchema,
  type OrderStatus,
  receiptSchema,
  type StopStatus,
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
const PINNED = '2026-10-08T09:15:00.000+05:30';
const PASSWORD = 'waypoint-demo';

describe('receipts and store issues', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
  let dispatcher: { cookie: string; user: User };
  let store: { cookie: string; user: User };
  let otherStore: { cookie: string; user: User };
  let loaderCookie: string;
  let driverCookie: string;
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
    dispatcher = await login('receipt.dispatcher@waypoint.test');
    store = await login('receipt.store@waypoint.test');
    otherStore = await login('receipt.other-store@waypoint.test');
    loaderCookie = (await login('receipt.loader@waypoint.test')).cookie;
    driverCookie = (await login('receipt.driver@waypoint.test')).cookie;
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  beforeEach(async () => {
    tripNo = 0;
    await database.db.delete(notifications);
    await database.db.delete(issues);
    await database.db.delete(receipts);
    await database.db.delete(tripStops);
    await database.db.delete(trips);
    await database.db.delete(orders);
    await database.db.delete(planningRuns);
    app.clock.pin(new Date(PINNED));
  });

  it('confirms receipt for the store manager’s own delivered stop', async () => {
    const delivery = await insertDelivery({
      outletId: 'OUT501',
      stopStatus: 'delivered',
      orderStatus: 'delivered',
    });
    const seen: DomainEvent[] = [];
    const stopListening = app.domainEvents.subscribe((event) => {
      seen.push(event);
    });
    const response = await postReceipt(store.cookie, delivery.stopId);
    stopListening();
    const receipt = receiptSchema.parse(json(response, 201));
    expect(receipt).toMatchObject({
      stopId: delivery.stopId,
      confirmedBy: store.user.id,
      confirmedAt: PINNED,
    });

    const storedOrders = await database.db.select().from(orders);
    expect(storedOrders).toHaveLength(1);
    expect(storedOrders[0]).toMatchObject({ id: delivery.orderId, status: 'receipt_confirmed' });
    expect(storedOrders[0]?.version).toBe(1);

    const storedReceipts = await database.db.select().from(receipts);
    expect(storedReceipts).toHaveLength(1);
    expect(storedReceipts[0]?.confirmedBy).toBe(store.user.id);

    const audits = await database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, delivery.orderId));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: store.user.id,
      role: 'store_manager',
      action: 'receipt.confirmed',
      entityType: 'order',
      entityId: delivery.orderId,
      before: { status: 'delivered', stopStatus: 'delivered' },
      after: {
        status: 'receipt_confirmed',
        stopId: delivery.stopId,
        receiptId: receipt.id,
        confirmedBy: store.user.id,
        confirmedAt: PINNED,
      },
    });
    expect(seen).toEqual([
      {
        type: 'receipt.confirmed',
        actorId: store.user.id,
        occurredAt: PINNED,
        receiptId: receipt.id,
        stopId: delivery.stopId,
        orderId: delivery.orderId,
        outletId: 'OUT501',
        depotId: 'Peliyagoda',
      },
    ]);

    expect((await postReceipt(loaderCookie, delivery.stopId)).statusCode).toBe(403);
    expect((await postReceipt(driverCookie, delivery.stopId)).statusCode).toBe(403);
    expect((await postReceipt(dispatcher.cookie, delivery.stopId)).statusCode).toBe(403);
  });

  it('returns 404 when a store manager confirms another outlet’s stop', async () => {
    const delivery = await insertDelivery({
      outletId: 'OUT502',
      stopStatus: 'delivered',
      orderStatus: 'delivered',
    });
    const response = await postReceipt(store.cookie, delivery.stopId);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(await database.db.select().from(receipts)).toHaveLength(0);
    const stored = await database.db.select().from(orders).where(eq(orders.id, delivery.orderId));
    expect(stored[0]?.status).toBe('delivered');
  });

  it('refuses to confirm a stop that has not been delivered', async () => {
    const pending = await insertDelivery({
      outletId: 'OUT501',
      stopStatus: 'pending',
      orderStatus: 'dispatched',
    });
    const response = await postReceipt(store.cookie, pending.stopId);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'CONSTRAINT_VIOLATION' } });
    expect(await database.db.select().from(receipts)).toHaveLength(0);
    const stored = await database.db.select().from(orders).where(eq(orders.id, pending.orderId));
    expect(stored[0]?.status).toBe('dispatched');

    const failed = await insertDelivery({
      outletId: 'OUT501',
      stopStatus: 'failed',
      orderStatus: 'failed',
    });
    const rejected = await postReceipt(store.cookie, failed.stopId);
    expect(rejected.statusCode).toBe(422);
    expect(await database.db.select().from(receipts)).toHaveLength(0);
  });

  it('refuses a discrepancy for an order that has not been delivered', async () => {
    const pending = await insertDelivery({
      outletId: 'OUT501',
      stopStatus: 'pending',
      orderStatus: 'dispatched',
    });
    const response = await postIssue(store.cookie, { orderId: pending.orderId, type: 'missing' });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'CONSTRAINT_VIOLATION' } });
    expect(await database.db.select().from(issues)).toHaveLength(0);
  });

  it('returns the existing receipt when confirmation is repeated', async () => {
    const delivery = await insertDelivery({
      outletId: 'OUT501',
      stopStatus: 'delivered',
      orderStatus: 'delivered',
    });
    const seen: DomainEvent[] = [];
    const stopListening = app.domainEvents.subscribe((event) => {
      seen.push(event);
    });
    const first = receiptSchema.parse(json(await postReceipt(store.cookie, delivery.stopId), 201));
    const second = receiptSchema.parse(json(await postReceipt(store.cookie, delivery.stopId), 200));
    stopListening();
    expect(second).toEqual(first);
    expect(await database.db.select().from(receipts)).toHaveLength(1);
    expect(
      await database.db.select().from(auditLog).where(eq(auditLog.entityId, delivery.orderId)),
    ).toHaveLength(1);
    expect(seen).toHaveLength(1);
    const stored = await database.db.select().from(orders).where(eq(orders.id, delivery.orderId));
    expect(stored[0]?.status).toBe('receipt_confirmed');
    expect(stored[0]?.version).toBe(1);
  });

  it('records a discrepancy against the store’s order', async () => {
    const delivery = await insertDelivery({
      outletId: 'OUT501',
      stopStatus: 'delivered',
      orderStatus: 'delivered',
    });
    const response = await postIssue(store.cookie, {
      orderId: delivery.orderId,
      type: 'missing',
      note: 'Two crates short',
    });
    const issue = issueSchema.parse(json(response, 201));
    expect(issue).toMatchObject({
      orderId: delivery.orderId,
      type: 'missing',
      note: 'Two crates short',
      status: 'open',
      createdBy: store.user.id,
      createdAt: PINNED,
    });
    const stored = await database.db.select().from(issues);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      orderId: delivery.orderId,
      type: 'missing',
      note: 'Two crates short',
      status: 'open',
      createdBy: store.user.id,
    });
    const order = await database.db.select().from(orders).where(eq(orders.id, delivery.orderId));
    expect(order[0]?.status).toBe('delivered');

    expect(
      (
        await postIssue(loaderCookie, {
          orderId: delivery.orderId,
          type: 'damaged',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await postIssue(driverCookie, {
          orderId: delivery.orderId,
          type: 'incorrect',
        })
      ).statusCode,
    ).toBe(403);
  });

  it('lets the dispatcher resolve an issue once, with a note the store can read', async () => {
    const delivery = await insertDelivery({
      outletId: 'OUT501',
      stopStatus: 'delivered',
      orderStatus: 'delivered',
    });
    const issue = issueSchema.parse(
      json(await postIssue(store.cookie, { orderId: delivery.orderId, type: 'damaged' }), 201),
    );
    const resolve = (cookie: string, resolution: string) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/issues/${issue.id}/resolve`,
        headers: { cookie },
        payload: { resolution },
      });
    expect((await resolve(store.cookie, 'Closed by the store')).statusCode).toBe(403);
    expect((await resolve(dispatcher.cookie, '   ')).statusCode).toBe(400);

    const resolved = issueSchema.parse(
      json(await resolve(dispatcher.cookie, 'Credit note raised'), 200),
    );
    expect(resolved).toMatchObject({
      id: issue.id,
      status: 'resolved',
      resolution: 'Credit note raised',
      resolvedBy: dispatcher.user.id,
      resolvedAt: PINNED,
    });
    expect((await resolve(dispatcher.cookie, 'Again')).statusCode).toBe(422);

    const seen = issueListResponseSchema.parse(json(await listIssues(store.cookie), 200));
    expect(seen.items[0]).toMatchObject({ status: 'resolved', resolution: 'Credit note raised' });
    const notes = await database.db.select().from(notifications);
    expect(notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipientId: store.user.id,
          type: 'issue_resolved',
          entityId: issue.id,
        }),
      ]),
    );
    const audit = await database.db.select().from(auditLog);
    expect(audit.map((row) => row.action)).toContain('issue.resolved');
  });

  it('lets the dispatcher read an issue and hides it from another store', async () => {
    const delivery = await insertDelivery({
      outletId: 'OUT501',
      stopStatus: 'delivered',
      orderStatus: 'delivered',
    });
    const created = issueSchema.parse(
      json(
        await postIssue(store.cookie, {
          orderId: delivery.orderId,
          type: 'damaged',
          note: 'Crushed carton',
        }),
        201,
      ),
    );

    const detail = issueSchema.parse(json(await getIssue(dispatcher.cookie, created.id), 200));
    expect(detail).toEqual(created);
    const list = issueListResponseSchema.parse(json(await listIssues(dispatcher.cookie), 200));
    expect(list.total).toBe(1);
    expect(list.items).toEqual([created]);

    const hidden = await getIssue(otherStore.cookie, created.id);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    const otherList = issueListResponseSchema.parse(json(await listIssues(otherStore.cookie), 200));
    expect(otherList).toEqual({ items: [], total: 0 });

    const ownList = issueListResponseSchema.parse(json(await listIssues(store.cookie), 200));
    expect(ownList.items.map((item) => item.id)).toEqual([created.id]);

    expect((await getIssue(loaderCookie, created.id)).statusCode).toBe(403);
    expect((await listIssues(driverCookie)).statusCode).toBe(403);
    const foreign = await postIssue(store.cookie, {
      orderId: (
        await insertDelivery({
          outletId: 'OUT502',
          stopStatus: 'delivered',
          orderStatus: 'delivered',
        })
      ).orderId,
      type: 'incorrect',
      note: 'Wrong SKU',
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('audits the report and notifies the depot dispatcher', async () => {
    const delivery = await insertDelivery({
      outletId: 'OUT501',
      stopStatus: 'delivered',
      orderStatus: 'delivered',
    });
    const seen: DomainEvent[] = [];
    const stopListening = app.domainEvents.subscribe((event) => {
      seen.push(event);
    });
    const issue = issueSchema.parse(
      json(
        await postIssue(store.cookie, {
          orderId: delivery.orderId,
          type: 'incorrect',
          note: 'Ambient sent as chilled',
        }),
        201,
      ),
    );
    stopListening();

    const audits = await database.db.select().from(auditLog).where(eq(auditLog.entityId, issue.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: store.user.id,
      role: 'store_manager',
      action: 'issue.reported',
      entityType: 'issue',
      entityId: issue.id,
      after: {
        orderId: delivery.orderId,
        stopId: delivery.stopId,
        type: 'incorrect',
        note: 'Ambient sent as chilled',
        status: 'open',
        createdBy: store.user.id,
        createdAt: PINNED,
      },
    });
    expect(seen).toEqual([
      {
        type: 'issue.reported',
        actorId: store.user.id,
        occurredAt: PINNED,
        issueId: issue.id,
        orderId: delivery.orderId,
        outletId: 'OUT501',
        depotId: 'Peliyagoda',
        stopId: delivery.stopId,
      },
    ]);
    const notes = await database.db.select().from(notifications);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      recipientId: dispatcher.user.id,
      type: 'receipt_discrepancy',
      priority: 'high',
      entityType: 'issue',
      entityId: issue.id,
    });
  });

  async function postReceipt(cookie: string, stopId: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/stops/${stopId}/receipt`,
      headers: { cookie },
    });
  }

  async function postIssue(
    cookie: string,
    body: { orderId: string; type: 'missing' | 'damaged' | 'incorrect'; note?: string },
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/issues',
      headers: { cookie },
      payload: body,
    });
  }

  async function getIssue(cookie: string, issueId: string) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/issues/${issueId}`,
      headers: { cookie },
    });
  }

  async function listIssues(cookie: string) {
    return app.inject({
      method: 'GET',
      url: '/api/v1/issues',
      headers: { cookie },
    });
  }

  async function insertDelivery(options: {
    outletId: string;
    stopStatus: StopStatus;
    orderStatus: OrderStatus;
  }): Promise<{ stopId: string; orderId: string }> {
    tripNo += 1;
    if (tripNo !== 1 && tripNo !== 2) throw new Error('A vehicle can only have two trips');
    const runId = await ensureRun();
    const created = await database.db
      .insert(trips)
      .values({
        runId,
        vehicleId: 'VEH501',
        tripNo,
        brand: 'Fresh',
        district: 'Colombo',
        status: 'departed',
        plannedMinutes: 40,
        plannedKm: 12,
      })
      .returning({ id: trips.id });
    const tripId = created[0]?.id;
    if (tripId === undefined) throw new Error('Expected a trip id');
    const order = await database.db
      .insert(orders)
      .values({
        outletId: options.outletId,
        brand: 'Fresh',
        temp: 'ambient',
        requestedDate: SERVICE_DATE,
        units: 4,
        weightKg: 12,
        volumeM3: 0.4,
        status: options.orderStatus,
      })
      .returning({ id: orders.id });
    const orderId = order[0]?.id;
    if (orderId === undefined) throw new Error('Expected an order id');
    const inserted = await database.db
      .insert(tripStops)
      .values({
        tripId,
        orderId,
        seq: 1,
        plannedArrival: new Date(`${SERVICE_DATE}T07:10:00.000+05:30`),
        status: options.stopStatus,
      })
      .returning({ id: tripStops.id });
    const stopId = inserted[0]?.id;
    if (stopId === undefined) throw new Error('Expected a stop id');
    return { stopId, orderId };
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
      .values({ depotId: 'Peliyagoda', serviceDate: SERVICE_DATE })
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
    await database.db
      .insert(outlets)
      .values([outlet('OUT501', 'Peliyagoda'), outlet('OUT502', 'Peliyagoda')]);
    await database.db.insert(vehicles).values({
      id: 'VEH501',
      type: 'van',
      temp: 'reefer',
      weightCapKg: 1500,
      volumeCapM3: 8,
      fuelType: 'diesel',
      kmPerL: 10,
      weeklyFuelQuotaL: 200,
      depotId: 'Peliyagoda',
    });
    await database.db.insert(users).values([
      {
        name: 'Peliyagoda Dispatcher',
        email: 'receipt.dispatcher@waypoint.test',
        passwordHash,
        role: 'dispatcher',
        depotId: 'Peliyagoda',
      },
      {
        name: 'Kandy Dispatcher',
        email: 'receipt.kandy@waypoint.test',
        passwordHash,
        role: 'dispatcher',
        depotId: 'Kandy',
      },
      {
        name: 'Peliyagoda Loader',
        email: 'receipt.loader@waypoint.test',
        passwordHash,
        role: 'loader',
        depotId: 'Peliyagoda',
      },
      {
        name: 'Van Driver',
        email: 'receipt.driver@waypoint.test',
        passwordHash,
        role: 'driver',
        vehicleId: 'VEH501',
      },
      {
        name: 'Store Manager',
        email: 'receipt.store@waypoint.test',
        passwordHash,
        role: 'store_manager',
        outletId: 'OUT501',
      },
      {
        name: 'Other Store Manager',
        email: 'receipt.other-store@waypoint.test',
        passwordHash,
        role: 'store_manager',
        outletId: 'OUT502',
      },
    ]);
  }
});

function outlet(id: string, depotId: string) {
  return {
    id,
    brand: 'Fresh' as const,
    district: 'Colombo',
    depotId,
    dockType: 'street' as const,
    parkingConstraint: 'normal' as const,
    windowOpen: '05:00:00',
    windowClose: '08:00:00',
  };
}

function json(response: { statusCode: number; json: () => unknown }, status: number): unknown {
  expect(response.statusCode).toBe(status);
  return response.json();
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
