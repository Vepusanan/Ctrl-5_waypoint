import {
  auditLog,
  calendarDays,
  DEFAULT_SEED_PASSWORD,
  DEMO_USERS,
  orders,
  seedDatabase,
  seedMeta,
  users,
} from '@waypoint/database';
import {
  currentUserResponseSchema,
  operatingClockSchema,
  orderListResponseSchema,
  orderSchema,
  storeWorkspaceSchema,
} from '@waypoint/shared';
import { and, desc, eq, lt } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  client,
  cookiePair,
  logCapture,
  SESSION_SECRET,
  setCookieHeader,
} from '../../../../test/http.ts';
import { createMigratedDatabase } from '../../../../test/postgres.ts';
import { buildApp } from '../../../app.ts';
import { createAdminRepo } from '../repo.ts';
import { startDemoClock } from '../service.ts';

const PASSWORD = DEFAULT_SEED_PASSWORD;

describe('demo admin', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let close: (() => Promise<void>) | undefined;
  const logs = logCapture();

  beforeAll(async () => {
    const database = await createMigratedDatabase();
    close = database.close;
    await seedDatabase(database.db, { reset: true, password: PASSWORD });
    app = await buildApp({
      db: database.db,
      logger: logs.logger,
      sessionSecret: SESSION_SECRET,
      secureCookies: false,
      demoMode: true,
      seed: { password: PASSWORD },
    });
  });

  afterAll(async () => {
    await app.close();
    await close?.();
  });

  it('starts the seeded demo before cutoff so store ordering is usable', async () => {
    const store = await signIn(app, DEMO_USERS.storeManager.email);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/store/workspace',
      headers: { cookie: store },
    });
    expect(response.statusCode).toBe(200);
    const workspace = storeWorkspaceSchema.parse(response.json());
    const [seed] = await app.db.select().from(seedMeta);
    expect(workspace.eligibleServiceDate).toBe(seed?.serviceDate);
    expect(workspace.orders.some((item) => item.editable)).toBe(true);
  });

  it('lets the dispatcher read and set the operating clock', async () => {
    const dispatcher = await signIn(app, DEMO_USERS.dispatcher.email);
    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/clock',
      headers: { cookie: dispatcher },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ now: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });

    const morning = '2026-06-26T06:00:00.000+05:30';
    const updated = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/clock',
      headers: { cookie: dispatcher },
      payload: { now: morning },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ now: morning });

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/clock',
      headers: { cookie: dispatcher },
    });
    expect(after.json()).toEqual({ now: morning });
  });

  it('rejects a clock update that is not a timestamp', async () => {
    const dispatcher = await signIn(app, DEMO_USERS.dispatcher.email);
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/clock',
      headers: { cookie: dispatcher },
      payload: { now: 'tomorrow' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('lets the driver read the clock but not move it or reset the seed', async () => {
    const driver = await signIn(app, DEMO_USERS.driver.email);
    const read = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/clock',
      headers: { cookie: driver },
    });
    expect(read.statusCode).toBe(200);
    expect(operatingClockSchema.parse(read.json()).now).toMatch(/\+05:30$/);
    for (const call of [
      {
        method: 'PUT' as const,
        url: '/api/v1/admin/clock',
        payload: { now: '2026-06-26T06:00:00.000+05:30' },
      },
      { method: 'POST' as const, url: '/api/v1/admin/reset', payload: { confirm: true } },
    ]) {
      const response = await app.inject({ ...call, headers: { cookie: driver } });
      expect(response.statusCode).toBe(403);
    }
  });

  it('refuses the clock and reset to every other role', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/admin/clock' });
    expect(anonymous.statusCode).toBe(401);

    for (const email of [DEMO_USERS.loader.email, DEMO_USERS.storeManager.email]) {
      const cookie = await signIn(app, email);
      for (const call of [
        { method: 'GET' as const, url: '/api/v1/admin/clock' },
        {
          method: 'PUT' as const,
          url: '/api/v1/admin/clock',
          payload: { now: '2026-06-26T06:00:00.000+05:30' },
        },
        { method: 'POST' as const, url: '/api/v1/admin/reset', payload: { confirm: true } },
      ]) {
        const response = await app.inject({ ...call, headers: { cookie } });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({
          error: { code: 'FORBIDDEN', message: 'You do not have access to this action' },
        });
      }
    }
  });

  it('changes the 4:00 PM cutoff when the operating clock moves', async () => {
    const dispatcher = await signIn(app, DEMO_USERS.dispatcher.email);
    const store = await signIn(app, DEMO_USERS.storeManager.email);
    const listed = orderListResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/orders?status=submitted',
          headers: { cookie: store },
        })
      ).json(),
    );
    const order = listed.items.find((item) => item.lockedAt === null);
    if (order === undefined) throw new Error('Expected an editable submitted order');
    // The seed keeps one active order per slot, so only the cutoff can reject this edit.

    const previous = await previousOperatingDate(app, order.requestedDate);
    const beforeCutoff = `${previous}T15:30:00.000+05:30`;
    const afterCutoff = `${previous}T16:00:00.000+05:30`;
    const serviceMorning = `${order.requestedDate}T06:00:00.000+05:30`;
    const nextUnits = order.units + 1;

    await setClock(app, dispatcher, beforeCutoff);
    const open = await patchOrder(app, store, order.id, order.version, nextUnits);
    expect(open.statusCode).toBe(200);
    const edited = orderSchema.parse(open.json());
    expect(edited.units).toBe(nextUnits);
    expect(edited.status).toBe('submitted');
    expect(edited.requestedDate).toBe(order.requestedDate);

    await setClock(app, dispatcher, afterCutoff);
    const closed = await patchOrder(app, store, order.id, edited.version, nextUnits + 1);
    expect(closed.statusCode).toBe(422);
    expect(closed.json()).toMatchObject({ error: { code: 'CUTOFF_PASSED' } });

    await setClock(app, dispatcher, serviceMorning);
    const morning = await patchOrder(app, store, order.id, edited.version, nextUnits + 1);
    expect(morning.statusCode).toBe(422);
    expect(morning.json()).toMatchObject({ error: { code: 'CUTOFF_PASSED' } });
    const clock = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/clock',
      headers: { cookie: dispatcher },
    });
    expect(clock.json()).toEqual({ now: serviceMorning });
  });

  it('does not change the operating system clock', async () => {
    const dispatcher = await signIn(app, DEMO_USERS.dispatcher.email);
    const wallBefore = Date.now();
    await setClock(app, dispatcher, '2030-01-01T08:00:00.000+05:30');
    const wallAfter = Date.now();
    expect(wallAfter).toBeGreaterThanOrEqual(wallBefore);
    expect(wallAfter - wallBefore).toBeLessThan(10_000);
    expect(new Date().getUTCFullYear()).toBeLessThan(2030);
    expect(app.clock.now().getUTCFullYear()).toBe(2030);
  });

  it('rejects a seed reset without an explicit confirmation', async () => {
    const dispatcher = await signIn(app, DEMO_USERS.dispatcher.email);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/reset',
      headers: { cookie: dispatcher },
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    const declined = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/reset',
      headers: { cookie: dispatcher },
      payload: { confirm: false },
    });
    expect(declined.statusCode).toBe(400);
    expect(declined.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('restores the deterministic demo seed and audits the reset', async () => {
    const primed = await signIn(app, DEMO_USERS.dispatcher.email);
    const first = await reset(app, primed);
    expect(first.statusCode).toBe(200);
    const expected = await fingerprint(app);
    const meta = await app.db.select().from(seedMeta);
    expect(first.json()).toEqual({
      serviceDate: meta[0]?.serviceDate,
      source: meta[0]?.source,
    });
    expect(JSON.stringify(first.json())).not.toContain('password');
    expect(setCookieHeader(first)).toMatch(/Max-Age=0/);
    const signedOut = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: primed },
    });
    expect(signedOut.statusCode).toBe(401);

    await app.db
      .update(users)
      .set({ name: 'Mutated Dispatcher' })
      .where(eq(users.email, DEMO_USERS.dispatcher.email));
    const sample = expected.orders[0];
    if (sample === undefined) throw new Error('Expected a seeded order');
    await app.db
      .update(orders)
      .set({ units: sample.units + 1 })
      .where(eq(orders.id, sample.id));
    expect(await fingerprint(app)).not.toEqual(expected);

    const again = await signIn(app, DEMO_USERS.dispatcher.email);
    const restored = await reset(app, again);
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toEqual(first.json());
    expect(await fingerprint(app)).toEqual(expected);

    const third = await signIn(app, DEMO_USERS.dispatcher.email);
    const repeated = await reset(app, third);
    expect(repeated.json()).toEqual(first.json());
    expect(await fingerprint(app)).toEqual(expected);

    const audits = await app.db.select().from(auditLog).where(eq(auditLog.action, 'seed.reset'));
    expect(audits.length).toBeGreaterThan(0);
    const latest = audits.at(-1);
    expect(latest?.role).toBe('dispatcher');
    expect(latest?.entityType).toBe('seed');
    expect(JSON.stringify(latest)).not.toMatch(/password/i);
    expect(logs.lines.join('\n')).toContain('seed.reset');

    for (const account of Object.values(DEMO_USERS)) {
      const login = await signIn(app, account.email);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { cookie: login },
      });
      const body = currentUserResponseSchema.parse(response.json());
      expect(body.user.role).toBe(account.role);
      expect(body.user.email).toBe(account.email);
      const encoded = JSON.stringify(body);
      expect(encoded).not.toContain('passwordHash');
      expect(encoded).not.toContain('argon2');
    }
  }, 90_000);

  it('starts the demo clock before the cutoff, and restores a moved clock after a restart', async () => {
    const [meta] = await app.db.select().from(seedMeta);
    if (meta === undefined) throw new Error('Expected seed metadata');
    const [cutoffDay] = await app.db
      .select({ date: calendarDays.date })
      .from(calendarDays)
      .where(and(lt(calendarDays.date, meta.serviceDate), eq(calendarDays.isOperating, true)))
      .orderBy(desc(calendarDays.date))
      .limit(1);
    const start = `${cutoffDay?.date}T15:50:00.000+05:30`;
    const readClock = async (cookie: string) =>
      (await app.inject({ method: 'GET', url: '/api/v1/admin/clock', headers: { cookie } })).json();

    // Earlier tests moved the clock; a fresh seed has no recorded move.
    const first = await signIn(app, DEMO_USERS.dispatcher.email);
    expect((await reset(app, first)).statusCode).toBe(200);
    expect(await startDemoClock(createAdminRepo(app.db), app.clock)).toBe(start);
    const dispatcher = await signIn(app, DEMO_USERS.dispatcher.email);
    expect(await readClock(dispatcher)).toEqual({ now: start });

    // A restart loses the in-memory pin. The last recorded move wins, even a move back in time.
    const afterCutoff = `${cutoffDay?.date}T16:05:00.000+05:30`;
    await setClock(app, dispatcher, `${meta.serviceDate}T03:30:00.000+05:30`);
    await setClock(app, dispatcher, afterCutoff);
    app.clock.unpin();
    expect(await startDemoClock(createAdminRepo(app.db), app.clock)).toBe(afterCutoff);
    expect(await readClock(dispatcher)).toEqual({ now: afterCutoff });

    expect((await reset(app, dispatcher)).statusCode).toBe(200);
    const again = await signIn(app, DEMO_USERS.dispatcher.email);
    expect(await readClock(again)).toEqual({ now: start });
  }, 90_000);

  it('leaves the admin endpoints unregistered when demo mode is off', async () => {
    const disabled = await buildApp({
      db: app.db,
      logger: false,
      sessionSecret: SESSION_SECRET,
      secureCookies: false,
      demoMode: false,
    });
    try {
      const dispatcher = await signIn(app, DEMO_USERS.dispatcher.email);
      for (const call of [
        { method: 'GET' as const, url: '/api/v1/admin/clock' },
        {
          method: 'PUT' as const,
          url: '/api/v1/admin/clock',
          payload: { now: '2026-06-26T06:00:00.000+05:30' },
        },
        { method: 'POST' as const, url: '/api/v1/admin/reset', payload: { confirm: true } },
      ]) {
        const hidden = await disabled.inject({ ...call, headers: { cookie: dispatcher } });
        expect(hidden.statusCode).toBe(404);
        expect(hidden.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
      }
      expect(Math.abs(disabled.clock.now().getTime() - Date.now())).toBeLessThan(5_000);
      const anonymous = await disabled.inject({ method: 'POST', url: '/api/v1/admin/reset' });
      expect(anonymous.statusCode).toBe(404);
    } finally {
      await disabled.close();
    }
  });
});

async function signIn(app: Awaited<ReturnType<typeof buildApp>>, email: string): Promise<string> {
  const response = await app.inject({
    ...client(),
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  return cookiePair(response);
}

async function setClock(app: Awaited<ReturnType<typeof buildApp>>, cookie: string, now: string) {
  const response = await app.inject({
    method: 'PUT',
    url: '/api/v1/admin/clock',
    headers: { cookie },
    payload: { now },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ now });
}

function patchOrder(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  id: string,
  version: number,
  units: number,
) {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/orders/${id}`,
    headers: { cookie, 'if-match': String(version) },
    payload: { units },
  });
}

function reset(app: Awaited<ReturnType<typeof buildApp>>, cookie: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/admin/reset',
    headers: { cookie },
    payload: { confirm: true },
  });
}

async function previousOperatingDate(
  app: Awaited<ReturnType<typeof buildApp>>,
  serviceDate: string,
): Promise<string> {
  const rows = await app.db
    .select({ date: calendarDays.date })
    .from(calendarDays)
    .where(and(lt(calendarDays.date, serviceDate), eq(calendarDays.isOperating, true)))
    .orderBy(desc(calendarDays.date))
    .limit(1);
  const date = rows[0]?.date;
  if (date === undefined) throw new Error(`No operating day before ${serviceDate}`);
  return date;
}

async function fingerprint(app: Awaited<ReturnType<typeof buildApp>>) {
  const orderRows = await app.db
    .select({
      id: orders.id,
      status: orders.status,
      units: orders.units,
      version: orders.version,
      requestedDate: orders.requestedDate,
    })
    .from(orders);
  const userRows = await app.db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role })
    .from(users);
  return {
    orders: orderRows.sort((left, right) => left.id.localeCompare(right.id)),
    users: userRows.sort((left, right) => left.email.localeCompare(right.email)),
  };
}
