import { auditLog, calendarDays, orders, users } from '@waypoint/database';
import {
  currentUserResponseSchema,
  type Order,
  orderListResponseSchema,
  orderSchema,
  type User,
} from '@waypoint/shared';
import { eq, notInArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthFixture } from '../../../../test/fixture.ts';
import { seedAuthFixture } from '../../../../test/fixture.ts';
import { client, cookiePair, SESSION_SECRET } from '../../../../test/http.ts';
import { createMigratedDatabase } from '../../../../test/postgres.ts';
import { buildApp } from '../../../app.ts';
import type { DomainEvent } from '../../../plugins/domain-events.ts';
import { createOrderService } from '../service.ts';

const SIBLING_EMAIL = 'sibling.store@waypoint.test';
const OPEN = '2026-10-01T15:00:00.000+05:30';
const JUST_BEFORE = '2026-10-01T15:59:59.000+05:30';
const CUTOFF = '2026-10-01T16:00:00.000+05:30';
const AFTER_CUTOFF = '2026-10-01T16:00:01.000+05:30';
const FRIDAY = '2026-10-02';
const SATURDAY = '2026-10-03';

describe('orders', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
  let fixture: AuthFixture;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    fixture = await seedAuthFixture(database.db);
    await seedCalendar();
    await seedSiblingManager();
    app = await buildApp({
      db: database.db,
      logger: false,
      sessionSecret: SESSION_SECRET,
      secureCookies: false,
    });
    currentApp = app;
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  beforeEach(async () => {
    await database.db
      .delete(orders)
      .where(
        notInArray(orders.id, [
          fixture.orders.home,
          fixture.orders.sibling,
          fixture.orders.otherDepot,
        ]),
      );
    app.clock.pin(at(OPEN));
  });

  it('lets a store manager create an order for their own outlet', async () => {
    const store = await login(fixture.emails.storeManager);
    const { seen, stop } = captureEvents();
    try {
      const order = await createdOrder(store.cookie);
      expect(order.outletId).toBe('OUT002');
      expect(order.brand).toBe('Fresh');
      expect(order.status).toBe('submitted');
      expect(order.version).toBe(0);
      expect(order.requestedDate).toBe(FRIDAY);
      expect(order.submittedAt).toBe(OPEN);
      expect(order.lockedAt).toBeNull();
      expect(order.units).toBe(4);
      expect(order.weightKg).toBe(12.5);
      expect(order.volumeM3).toBe(0.4);
      expect(seen).toEqual([
        expect.objectContaining({
          type: 'order.submitted',
          orderId: order.id,
          outletId: 'OUT002',
          actorId: store.user.id,
          occurredAt: OPEN,
        }),
      ]);

      const list = await app.inject({
        method: 'GET',
        url: '/api/v1/orders',
        headers: { cookie: store.cookie },
      });
      expect(list.statusCode).toBe(200);
      const body = orderListResponseSchema.parse(list.json());
      expect(body.total).toBe(body.items.length);
      expect(body.items.some((item) => item.id === order.id)).toBe(true);
      expect(body.items.every((item) => item.outletId === 'OUT002')).toBe(true);

      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/orders/${order.id}`,
        headers: { cookie: store.cookie },
      });
      expect(detail.statusCode).toBe(200);
      expect(orderSchema.parse(detail.json()).id).toBe(order.id);
    } finally {
      stop();
    }
  });

  it('keeps a store manager from creating an order for another outlet', async () => {
    const store = await login(fixture.emails.storeManager);
    const sibling = await login(SIBLING_EMAIL);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { cookie: store.cookie },
      payload: { ...baseOrder(), outletId: 'OUT011', brand: 'Tech' },
    });
    const order = created(response);
    expect(order.outletId).toBe('OUT002');
    expect(order.brand).toBe('Fresh');

    const hidden = await app.inject({
      method: 'GET',
      url: `/api/v1/orders/${order.id}`,
      headers: { cookie: sibling.cookie },
    });
    expectError(hidden, 404, 'NOT_FOUND');

    const siblingOrder = await createdOrder(sibling.cookie);
    expect(siblingOrder.outletId).toBe('OUT003');
    const cross = await app.inject({
      method: 'GET',
      url: `/api/v1/orders/${siblingOrder.id}`,
      headers: { cookie: store.cookie },
    });
    expectError(cross, 404, 'NOT_FOUND');
  });

  it('lets a dispatcher read orders inside their depot', async () => {
    const store = await login(fixture.emails.storeManager);
    const dispatcher = await login(fixture.emails.dispatcher);
    const central = await login(fixture.emails.central);
    const order = await createdOrder(store.cookie);

    const allowed = await app.inject({
      method: 'GET',
      url: `/api/v1/orders/${order.id}`,
      headers: { cookie: dispatcher.cookie },
    });
    expect(allowed.statusCode).toBe(200);

    const outside = await app.inject({
      method: 'GET',
      url: `/api/v1/orders/${fixture.orders.otherDepot}`,
      headers: { cookie: dispatcher.cookie },
    });
    expectError(outside, 404, 'NOT_FOUND');

    const centralView = await app.inject({
      method: 'GET',
      url: `/api/v1/orders/${fixture.orders.otherDepot}`,
      headers: { cookie: central.cookie },
    });
    expect(centralView.statusCode).toBe(200);

    const list = orderListResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/orders',
          headers: { cookie: dispatcher.cookie },
        })
      ).json(),
    );
    expect(list.items.every((item) => item.outletId !== 'OUT011')).toBe(true);
    expect(list.items.some((item) => item.id === order.id)).toBe(true);

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { cookie: dispatcher.cookie },
      payload: baseOrder(),
    });
    expectError(create, 403, 'FORBIDDEN');
  });

  it('refuses order management for a loader', async () => {
    const loader = await login(fixture.emails.loader);
    await expectNoOrderAccess(loader.cookie, fixture.orders.home);
  });

  it('refuses order management for a driver', async () => {
    const driver = await login(fixture.emails.driver);
    await expectNoOrderAccess(driver.cookie, fixture.orders.home);
  });

  it('lets a store manager edit before the 4:00 PM cutoff', async () => {
    const store = await login(fixture.emails.storeManager);
    const order = await createdOrder(store.cookie);
    app.clock.pin(at(JUST_BEFORE));
    const { seen, stop } = captureEvents();
    try {
      const response = await patch(store.cookie, order.id, order.version, {
        units: 8,
        status: 'delivered',
      });
      expect(response.statusCode).toBe(200);
      const edited = orderSchema.parse(response.json());
      expect(edited.units).toBe(8);
      expect(edited.status).toBe('submitted');
      expect(edited.version).toBe(1);
      expect(seen.map((event) => event.type)).toEqual(['order.changed']);
    } finally {
      stop();
    }
  });

  it('submits a saved draft the first time the store manager saves it', async () => {
    const store = await login(fixture.emails.storeManager);
    const order = await createdOrder(store.cookie);
    await database.db
      .update(orders)
      .set({ status: 'draft', submittedAt: null })
      .where(eq(orders.id, order.id));
    app.clock.pin(at(JUST_BEFORE));
    const { seen, stop } = captureEvents();
    try {
      const response = await patch(store.cookie, order.id, order.version, { units: 9 });
      expect(response.statusCode).toBe(200);
      const sent = orderSchema.parse(response.json());
      expect(sent.status).toBe('submitted');
      expect(sent.submittedAt).not.toBeNull();
      expect(sent.units).toBe(9);
      expect(seen.map((event) => event.type)).toEqual(['order.submitted']);
      const audit = await database.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, order.id));
      expect(audit.map((row) => row.action)).toContain('order.submitted');
    } finally {
      stop();
    }
  });

  it('rejects an edit at and after the 4:00 PM cutoff', async () => {
    const store = await login(fixture.emails.storeManager);
    const order = await createdOrder(store.cookie);

    app.clock.pin(at(CUTOFF));
    const atCutoff = await patch(store.cookie, order.id, 0, { units: 9 });
    expectError(atCutoff, 422, 'CUTOFF_PASSED');

    app.clock.pin(at(AFTER_CUTOFF));
    const after = await patch(store.cookie, order.id, 0, { units: 10 });
    expectError(after, 422, 'CUTOFF_PASSED');

    const current = orderSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/orders/${order.id}`,
          headers: { cookie: store.cookie },
        })
      ).json(),
    );
    expect(current.units).toBe(4);
    expect(current.version).toBe(0);
    expect(current.status).toBe('submitted');
  });

  it('holds an order received after cutoff for the following run', async () => {
    const store = await login(fixture.emails.storeManager);
    const dispatcher = await login(fixture.emails.dispatcher);
    app.clock.pin(at(CUTOFF));
    const order = await createdOrder(store.cookie, { temp: 'chilled', requestedDate: FRIDAY });
    expect(order.requestedDate).toBe(SATURDAY);
    expect(order.status).toBe('submitted');

    const locked = await createOrderService(
      database.db,
      app.audit,
      app.domainEvents,
      app.clock,
    ).lockConfirmedOrdersForRun(dispatcher.user, FRIDAY);
    expect(locked).toEqual([]);

    const current = orderSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/orders/${order.id}`,
          headers: { cookie: store.cookie },
        })
      ).json(),
    );
    expect(current.requestedDate).toBe(SATURDAY);
    expect(current.status).toBe('submitted');
    expect(current.lockedAt).toBeNull();
  });

  it('allows fresh ambient and chilled orders for the same outlet and day', async () => {
    const store = await login(fixture.emails.storeManager);
    const ambient = await createdOrder(store.cookie, { temp: 'ambient' });
    const chilled = await createdOrder(store.cookie, { temp: 'chilled' });
    expect(ambient.requestedDate).toBe(FRIDAY);
    expect(chilled.requestedDate).toBe(FRIDAY);
    expect(ambient.id).not.toBe(chilled.id);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { cookie: store.cookie },
      payload: baseOrder({ temp: 'ambient' }),
    });
    expectError(duplicate, 400, 'VALIDATION_ERROR');

    const list = orderListResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/orders?requestedDate=${FRIDAY}`,
          headers: { cookie: store.cookie },
        })
      ).json(),
    );
    expect(list.total).toBe(2);
  });

  it('cancels an order before it is locked', async () => {
    const store = await login(fixture.emails.storeManager);
    const order = await createdOrder(store.cookie);
    const { seen, stop } = captureEvents();
    try {
      const response = await cancel(store.cookie, order.id, order.version);
      expect(response.statusCode).toBe(200);
      const cancelled = orderSchema.parse(response.json());
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.version).toBe(1);
      expect(seen.map((event) => event.type)).toEqual(['order.cancelled']);
    } finally {
      stop();
    }
  });

  it('rejects cancellation after the order is locked', async () => {
    const store = await login(fixture.emails.storeManager);
    const current = orderSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/orders/${fixture.orders.home}`,
          headers: { cookie: store.cookie },
        })
      ).json(),
    );
    expect(current.status).toBe('confirmed');
    const response = await cancel(store.cookie, current.id, current.version);
    expectError(response, 422, 'CUTOFF_PASSED');

    const after = orderSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/orders/${current.id}`,
          headers: { cookie: store.cookie },
        })
      ).json(),
    );
    expect(after.status).toBe('confirmed');
    expect(after.version).toBe(current.version);
  });

  it('returns 409 when If-Match is stale', async () => {
    const store = await login(fixture.emails.storeManager);
    const order = await createdOrder(store.cookie);
    const first = await patch(store.cookie, order.id, 0, { units: 6 });
    expect(first.statusCode).toBe(200);
    expect(orderSchema.parse(first.json()).version).toBe(1);

    const stale = await patch(store.cookie, order.id, 0, { units: 9 });
    expectError(stale, 409, 'VERSION_CONFLICT');

    const current = orderSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/orders/${order.id}`,
          headers: { cookie: store.cookie },
        })
      ).json(),
    );
    expect(current.units).toBe(6);
    expect(current.version).toBe(1);
  });

  it('returns 400 for an invalid payload', async () => {
    const store = await login(fixture.emails.storeManager);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { cookie: store.cookie },
      payload: {
        requestedDate: '02-10-2026',
        temp: 'frozen',
        units: 0,
        weightKg: -1,
        volumeM3: 0,
      },
    });
    expectError(invalid, 400, 'VALIDATION_ERROR');

    const sunday = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { cookie: store.cookie },
      payload: baseOrder({ requestedDate: '2026-10-04' }),
    });
    expectError(sunday, 400, 'VALIDATION_ERROR');
  });

  it('returns 404 for an order outside the caller scope', async () => {
    const store = await login(fixture.emails.storeManager);
    const dispatcher = await login(fixture.emails.dispatcher);
    const sibling = await app.inject({
      method: 'GET',
      url: `/api/v1/orders/${fixture.orders.sibling}`,
      headers: { cookie: store.cookie },
    });
    const otherDepot = await app.inject({
      method: 'GET',
      url: `/api/v1/orders/${fixture.orders.otherDepot}`,
      headers: { cookie: store.cookie },
    });
    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/orders/00000000-0000-7000-8000-000000000099',
      headers: { cookie: store.cookie },
    });
    const dispatcherMiss = await app.inject({
      method: 'GET',
      url: `/api/v1/orders/${fixture.orders.otherDepot}`,
      headers: { cookie: dispatcher.cookie },
    });
    for (const response of [sibling, otherDepot, missing, dispatcherMiss]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Order not found' } });
    }

    const list = orderListResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/orders?outletId=OUT011',
          headers: { cookie: store.cookie },
        })
      ).json(),
    );
    expect(list).toEqual({ items: [], total: 0 });
  });

  it('writes an audit row in the same flow as the mutation', async () => {
    const store = await login(fixture.emails.storeManager);
    const order = await createdOrder(store.cookie);
    const rows = await database.db.select().from(auditLog).where(eq(auditLog.entityId, order.id));
    expect(rows).toHaveLength(1);
    const entry = rows[0];
    if (entry === undefined) throw new Error('Expected an audit row');
    expect(entry.actorId).toBe(store.user.id);
    expect(entry.role).toBe('store_manager');
    expect(entry.action).toBe('order.created');
    expect(entry.entityType).toBe('order');
    expect(entry.entityId).toBe(order.id);
    expect(entry.before).toBeNull();
    expect(entry.after).toMatchObject({
      id: order.id,
      outletId: 'OUT002',
      status: 'submitted',
      requestedDate: FRIDAY,
    });
    expect(entry.createdAt?.getTime()).toBe(at(OPEN).getTime());
  });

  it('applies the cutoff in Asia/Colombo', async () => {
    const store = await login(fixture.emails.storeManager);
    const dispatcher = await login(fixture.emails.dispatcher);
    // 10:29:59Z is 15:59:59 in Colombo, still before the 16:00 close.
    app.clock.pin(new Date('2026-10-01T10:29:59.000Z'));
    const order = await createdOrder(store.cookie);
    expect(order.requestedDate).toBe(FRIDAY);
    expect(order.submittedAt).toBe('2026-10-01T15:59:59.000+05:30');

    const earlyLock = await createOrderService(
      database.db,
      app.audit,
      app.domainEvents,
      app.clock,
    ).lockConfirmedOrdersForRun(dispatcher.user, FRIDAY);
    expect(earlyLock).toEqual([]);

    const edited = await patch(store.cookie, order.id, 0, { units: 7 });
    expect(edited.statusCode).toBe(200);

    // 10:30:00Z is exactly 16:00:00 in Colombo, so the Friday run is closed.
    app.clock.pin(new Date('2026-10-01T10:30:00.000Z'));
    const rejected = await patch(store.cookie, order.id, 1, { units: 8 });
    expectError(rejected, 422, 'CUTOFF_PASSED');

    const held = await createdOrder(store.cookie, { temp: 'chilled', requestedDate: FRIDAY });
    expect(held.requestedDate).toBe(SATURDAY);

    const { seen, stop } = captureEvents();
    try {
      const locked = await createOrderService(
        database.db,
        app.audit,
        app.domainEvents,
        app.clock,
      ).lockConfirmedOrdersForRun(dispatcher.user, FRIDAY);
      expect(locked.map((item) => item.id)).toEqual([order.id]);
      expect(locked[0]?.status).toBe('confirmed');
      expect(locked[0]?.lockedAt).toBe('2026-10-01T16:00:00.000+05:30');
      expect(seen).toEqual([
        expect.objectContaining({
          type: 'order.confirmed',
          orderId: order.id,
          occurredAt: '2026-10-01T16:00:00.000+05:30',
        }),
      ]);
    } finally {
      stop();
    }

    const heldAfter = orderSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/orders/${held.id}`,
          headers: { cookie: store.cookie },
        })
      ).json(),
    );
    expect(heldAfter.status).toBe('submitted');
    expect(heldAfter.requestedDate).toBe(SATURDAY);

    const audits = await database.db.select().from(auditLog).where(eq(auditLog.entityId, order.id));
    const confirmed = audits.find((entry) => entry.action === 'order.confirmed');
    expect(confirmed?.actorId).toBe(dispatcher.user.id);
    expect(confirmed?.role).toBe('dispatcher');
    expect(confirmed?.before).toMatchObject({ status: 'submitted' });
    expect(confirmed?.after).toMatchObject({
      status: 'confirmed',
      reason: '4:00 PM Asia/Colombo cutoff',
    });
    expect(confirmed?.createdAt?.getTime()).toBe(new Date('2026-10-01T10:30:00.000Z').getTime());
  });

  async function seedCalendar(): Promise<void> {
    const rows = [];
    let cursor = '2026-09-28';
    while (cursor <= '2026-10-12') {
      rows.push(calendarRow(cursor));
      cursor = addIsoDays(cursor, 1);
    }
    await database.db.insert(calendarDays).values(rows);
  }

  async function seedSiblingManager(): Promise<void> {
    const managers = await database.db
      .select()
      .from(users)
      .where(eq(users.email, fixture.emails.storeManager))
      .limit(1);
    const manager = managers[0];
    if (manager === undefined) throw new Error('Expected the store manager');
    await database.db.insert(users).values({
      name: 'Sibling Store Manager',
      email: SIBLING_EMAIL,
      passwordHash: manager.passwordHash,
      role: 'store_manager',
      outletId: 'OUT003',
    });
  }

  async function login(email: string): Promise<{ cookie: string; user: User }> {
    const response = await app.inject({
      ...client(),
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: fixture.password },
    });
    expect(response.statusCode).toBe(200);
    return {
      cookie: cookiePair(response),
      user: currentUserResponseSchema.parse(response.json()).user,
    };
  }

  function captureEvents(): { seen: DomainEvent[]; stop: () => void } {
    const seen: DomainEvent[] = [];
    const stop = app.domainEvents.subscribe((event) => {
      seen.push(event);
    });
    return { seen, stop };
  }

  async function createdOrder(
    cookie: string,
    overrides: Record<string, unknown> = {},
  ): Promise<Order> {
    return created(
      await app.inject({
        method: 'POST',
        url: '/api/v1/orders',
        headers: { cookie },
        payload: baseOrder(overrides),
      }),
    );
  }

  async function expectNoOrderAccess(cookie: string, orderId: string): Promise<void> {
    expectError(
      await app.inject({ method: 'GET', url: '/api/v1/orders', headers: { cookie } }),
      403,
      'FORBIDDEN',
    );
    expectError(
      await app.inject({ method: 'GET', url: `/api/v1/orders/${orderId}`, headers: { cookie } }),
      403,
      'FORBIDDEN',
    );
    expectError(
      await app.inject({
        method: 'POST',
        url: '/api/v1/orders',
        headers: { cookie },
        payload: baseOrder(),
      }),
      403,
      'FORBIDDEN',
    );
    expectError(
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/orders/${orderId}`,
        headers: { cookie, 'if-match': '0' },
        payload: { units: 5 },
      }),
      403,
      'FORBIDDEN',
    );
    expectError(
      await app.inject({
        method: 'POST',
        url: `/api/v1/orders/${orderId}/cancel`,
        headers: { cookie, 'if-match': '0' },
      }),
      403,
      'FORBIDDEN',
    );
  }
});

function created(response: { statusCode: number; json: () => unknown }): Order {
  expect(response.statusCode).toBe(201);
  return orderSchema.parse(response.json());
}

function baseOrder(overrides: Record<string, unknown> = {}) {
  return {
    requestedDate: FRIDAY,
    temp: 'ambient' as const,
    units: 4,
    weightKg: 12.5,
    volumeM3: 0.4,
    ...overrides,
  };
}

function patch(cookie: string, id: string, version: number, payload: Record<string, unknown>) {
  return appInject(cookie, 'PATCH', `/api/v1/orders/${id}`, payload, version);
}

function cancel(cookie: string, id: string, version: number) {
  return appInject(cookie, 'POST', `/api/v1/orders/${id}/cancel`, undefined, version);
}

function appInject(
  cookie: string,
  method: 'PATCH' | 'POST',
  url: string,
  payload: Record<string, unknown> | undefined,
  version: number,
) {
  return currentApp.inject({
    method,
    url,
    headers: { cookie, 'if-match': String(version) },
    ...(payload !== undefined ? { payload } : {}),
  });
}

let currentApp: Awaited<ReturnType<typeof buildApp>>;

function expectError(
  response: { statusCode: number; json: () => unknown },
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.json()).toMatchObject({ error: { code } });
}

function at(value: string): Date {
  return new Date(value);
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
