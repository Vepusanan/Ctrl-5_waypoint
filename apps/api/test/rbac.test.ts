import { orders, trips } from '@waypoint/database';
import type { User } from '@waypoint/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../src/app.ts';
import { ApiError } from '../src/plugins/errors.ts';
import { scope } from '../src/plugins/rbac.ts';
import type { AuthFixture } from './fixture.ts';
import { seedAuthFixture } from './fixture.ts';
import { client, cookiePair, SESSION_SECRET } from './http.ts';
import { createMigratedDatabase } from './postgres.ts';

const orderParams = z.object({ id: z.uuid() });
const orderBody = z.object({ id: z.uuid(), outletId: z.string() });

describe('RBAC', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let close: (() => Promise<void>) | undefined;
  let fixture: AuthFixture;
  let db: Awaited<ReturnType<typeof createMigratedDatabase>>['db'];

  beforeAll(async () => {
    const database = await createMigratedDatabase();
    close = database.close;
    db = database.db;
    fixture = await seedAuthFixture(database.db);
    app = await buildApp({
      db: database.db,
      logger: false,
      sessionSecret: SESSION_SECRET,
      secureCookies: false,
    });

    // Orders owns GET /orders/:id. This probe stays separate so loader and driver
    // scope checks are not hidden behind that module's role gate.
    app.get(
      '/api/v1/probes/orders/:id',
      {
        preValidation: app.requireRole('dispatcher', 'loader', 'driver', 'store_manager'),
        schema: { params: orderParams, response: { 200: orderBody } },
      },
      async (request) => {
        const user = request.user;
        if (user === null) throw new ApiError('UNAUTHENTICATED', 'Sign in required');
        const row = await readOrder(app, user, request.params.id);
        if (row === null) throw new ApiError('NOT_FOUND', 'Order not found');
        return row;
      },
    );

    app.get(
      '/api/v1/probes/dispatcher',
      { preValidation: app.requireRole('dispatcher') },
      async () => ({ ok: true }),
    );
  });

  afterAll(async () => {
    await app.close();
    await close?.();
  });

  it('returns 401 without a session and 403 for the wrong role', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/probes/dispatcher' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Sign in required' },
    });

    const driver = await login(app, fixture.emails.driver, fixture.password);
    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/v1/probes/dispatcher',
      headers: { cookie: driver },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({
      error: { code: 'FORBIDDEN', message: 'You do not have access to this action' },
    });

    const dispatcher = await login(app, fixture.emails.dispatcher, fixture.password);
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/v1/probes/dispatcher',
      headers: { cookie: dispatcher },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('checks the session and role before it validates the request', async () => {
    // A malformed request must not tell a caller without access what the endpoint expects.
    const invalid = [
      { method: 'POST', url: '/api/v1/orders', payload: { units: 'many' } },
      { method: 'GET', url: '/api/v1/orders/not-a-uuid' },
      { method: 'POST', url: '/api/v1/planning/runs/tomorrow/publish' },
      { method: 'POST', url: '/api/v1/deferrals', payload: {} },
      { method: 'POST', url: '/api/v1/sync/events', payload: { events: 'none' } },
    ] as const;
    const driver = await login(app, fixture.emails.driver, fixture.password);
    const loader = await login(app, fixture.emails.loader, fixture.password);
    for (const request of invalid) {
      const anonymous = await app.inject(request);
      expect(anonymous.statusCode, `${request.method} ${request.url}`).toBe(401);
      expect(anonymous.json()).toEqual({
        error: { code: 'UNAUTHENTICATED', message: 'Sign in required' },
      });
      // The loader has none of these actions; the driver only sync.
      const cookie = request.url.includes('/sync/') ? loader : driver;
      const wrongRole = await app.inject({ ...request, headers: { cookie } });
      expect(wrongRole.statusCode, `${request.method} ${request.url}`).toBe(403);
      expect(wrongRole.json()).toEqual({
        error: { code: 'FORBIDDEN', message: 'You do not have access to this action' },
      });
    }

    // With access, the same request is told what is wrong with it.
    const store = await login(app, fixture.emails.storeManager, fixture.password);
    const allowed = await app.inject({ ...invalid[0], headers: { cookie: store } });
    expect(allowed.statusCode).toBe(400);
    expect(allowed.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('hides orders outside the caller scope with 404', async () => {
    const store = await login(app, fixture.emails.storeManager, fixture.password);
    const loader = await login(app, fixture.emails.loader, fixture.password);
    const dispatcher = await login(app, fixture.emails.dispatcher, fixture.password);
    const central = await login(app, fixture.emails.central, fixture.password);
    const driver = await login(app, fixture.emails.driver, fixture.password);

    expect(await orderStatus(app, store, fixture.orders.home)).toBe(200);
    expect(await orderStatus(app, store, fixture.orders.sibling)).toBe(404);
    expect(await orderStatus(app, store, fixture.orders.otherDepot)).toBe(404);

    expect(await orderStatus(app, loader, fixture.orders.home)).toBe(200);
    expect(await orderStatus(app, loader, fixture.orders.sibling)).toBe(200);
    expect(await orderStatus(app, loader, fixture.orders.otherDepot)).toBe(404);

    expect(await orderStatus(app, dispatcher, fixture.orders.sibling)).toBe(200);
    expect(await orderStatus(app, dispatcher, fixture.orders.otherDepot)).toBe(404);
    expect(await orderStatus(app, central, fixture.orders.otherDepot)).toBe(200);

    expect(await orderStatus(app, driver, fixture.orders.home)).toBe(404);

    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/orders/00000000-0000-7000-8000-000000000099',
      headers: { cookie: central },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Order not found' } });
  });

  it('enforces scope and mutations on the actual workspace endpoints', async () => {
    const store = await login(app, fixture.emails.storeManager, fixture.password);
    const driver = await login(app, fixture.emails.driver, fixture.password);
    const loader = await login(app, fixture.emails.loader, fixture.password);
    const dispatcher = await login(app, fixture.emails.dispatcher, fixture.password);
    const own = await app.inject({
      method: 'GET',
      url: '/api/v1/store/workspace',
      headers: { cookie: store },
    });
    expect(own.statusCode).toBe(200);
    expect(
      own
        .json()
        .orders.every((item: { order: { outletId: string } }) => item.order.outletId === 'OUT002'),
    ).toBe(true);
    for (const id of [fixture.orders.sibling, fixture.orders.otherDepot]) {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v1/store/orders/${id}`,
            headers: { cookie: store },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v1/orders/${id}`,
            headers: { cookie: store },
          })
        ).statusCode,
      ).toBe(404);
    }
    const filtered = await app.inject({
      method: 'GET',
      url: '/api/v1/orders?outletId=OUT011',
      headers: { cookie: store },
    });
    expect(filtered.json().items).toEqual([]);
    const depart = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${fixture.trips.otherDepot}/depart`,
      headers: { cookie: driver, 'if-match': '1' },
    });
    expect(depart.statusCode).toBe(404);
    const planning = await app.inject({
      method: 'POST',
      url: '/api/v1/planning/runs/2026-10-03/auto-allocate',
      headers: { cookie: loader, 'if-match': '1' },
    });
    expect(planning.statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/store/workspace',
          headers: { cookie: dispatcher },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('hides trips outside the caller scope with 404', async () => {
    const driver = await login(app, fixture.emails.driver, fixture.password);
    const loader = await login(app, fixture.emails.loader, fixture.password);
    const dispatcher = await login(app, fixture.emails.dispatcher, fixture.password);
    const store = await login(app, fixture.emails.storeManager, fixture.password);

    expect(await tripStatus(app, driver, fixture.trips.home)).toBe(200);
    expect(await tripStatus(app, driver, fixture.trips.otherDepot)).toBe(404);
    expect(await tripStatus(app, loader, fixture.trips.home)).toBe(200);
    expect(await tripStatus(app, loader, fixture.trips.otherDepot)).toBe(404);
    expect(await tripStatus(app, dispatcher, fixture.trips.otherDepot)).toBe(404);
    // Internal trip detail is not a store tracking API.
    expect(await tripStatus(app, store, fixture.trips.home)).toBe(403);
    expect(await tripStatus(app, store, fixture.trips.otherDepot)).toBe(403);
  });

  it('keeps draft trips from the loader and driver until the plan is published', async () => {
    const driver = await login(app, fixture.emails.driver, fixture.password);
    const loader = await login(app, fixture.emails.loader, fixture.password);
    const dispatcher = await login(app, fixture.emails.dispatcher, fixture.password);
    await db.update(trips).set({ status: 'planned' }).where(eq(trips.id, fixture.trips.home));
    try {
      expect(await tripStatus(app, driver, fixture.trips.home)).toBe(404);
      expect(await tripStatus(app, loader, fixture.trips.home)).toBe(404);
      expect(await tripStatus(app, dispatcher, fixture.trips.home)).toBe(200);
    } finally {
      await db.update(trips).set({ status: 'published' }).where(eq(trips.id, fixture.trips.home));
    }
  });
});

async function login(
  app: Awaited<ReturnType<typeof buildApp>>,
  email: string,
  password: string,
): Promise<string> {
  const response = await app.inject({
    ...client(),
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  expect(response.statusCode).toBe(200);
  return cookiePair(response);
}

async function orderStatus(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  id: string,
): Promise<number> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/probes/orders/${id}`,
    headers: { cookie },
  });
  return response.statusCode;
}

async function tripStatus(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  id: string,
): Promise<number> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/trips/${id}`,
    headers: { cookie },
  });
  return response.statusCode;
}

async function readOrder(app: Awaited<ReturnType<typeof buildApp>>, user: User, id: string) {
  const rows = await app.db
    .select({ id: orders.id, outletId: orders.outletId })
    .from(orders)
    .where(and(eq(orders.id, id), scope(user).orders))
    .limit(1);
  return rows[0] ?? null;
}
