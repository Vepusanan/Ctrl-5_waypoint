import { auditLog, sessions, users } from '@waypoint/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { SESSION_TTL_MS } from '../src/modules/auth/cookies.ts';
import { type AuthFixture, seedAuthFixture } from './fixture.ts';
import { client, cookiePair, logCapture, SESSION_SECRET, setCookieHeader } from './http.ts';
import { createMigratedDatabase } from './postgres.ts';

describe('authentication', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let close: (() => Promise<void>) | undefined;
  let fixture: AuthFixture;
  const logs = logCapture();

  function logEntries(): Record<string, unknown>[] {
    return logs.lines
      .flatMap((chunk) => chunk.split('\n'))
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  beforeAll(async () => {
    const database = await createMigratedDatabase();
    close = database.close;
    fixture = await seedAuthFixture(database.db);
    app = await buildApp({
      db: database.db,
      logger: logs.logger,
      sessionSecret: SESSION_SECRET,
      secureCookies: false,
    });
    app.get('/api/client-address', (request) => ({
      ip: request.ip,
      protocol: request.protocol,
    }));
  });

  afterAll(async () => {
    await app.close();
    await close?.();
  });

  it('serves Swagger and reports readiness once migrations are applied', async () => {
    const docs = await app.inject({ method: 'GET', url: '/api/docs/' });
    expect(docs.statusCode).toBe(200);
    expect(docs.body.toLowerCase()).toContain('swagger');

    const ready = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ok', database: 'up', migrations: 'applied' });

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok', database: 'up' });
  });

  it('trusts forwarded headers only from a loopback or private proxy', async () => {
    const spoofed = {
      'x-forwarded-for': '198.51.100.9',
      'x-forwarded-proto': 'https',
    };
    const direct = await app.inject({
      method: 'GET',
      url: '/api/client-address',
      remoteAddress: '203.0.113.7',
      headers: spoofed,
    });
    expect(direct.statusCode).toBe(200);
    expect(direct.json()).toEqual({ ip: '203.0.113.7', protocol: 'http' });

    const proxied = await app.inject({
      method: 'GET',
      url: '/api/client-address',
      remoteAddress: '127.0.0.1',
      headers: spoofed,
    });
    expect(proxied.statusCode).toBe(200);
    expect(proxied.json()).toEqual({ ip: '198.51.100.9', protocol: 'https' });
  });

  it('rejects an oversized JSON body without treating it as an image', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: 'x'.repeat(1024 * 1024 + 1),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'Request body is too large' },
    });
  });

  it('logs each request with reqId, user, route and latency', async () => {
    await app.inject({ method: 'GET', url: '/api/health' });
    const entry = logEntries().find(
      (line) => line.msg === 'request' && line.route === '/api/health',
    );
    expect(entry).toMatchObject({ userId: null, role: null, statusCode: 200 });
    expect(typeof entry?.reqId).toBe('string');
    expect(typeof entry?.latency).toBe('number');
  });

  it('rejects an invalid login body', async () => {
    const response = await app.inject({
      ...client(),
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'not-an-email', password: '' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('email'),
      },
    });
  });

  it('resolves role and scope for each seeded account', async () => {
    const accounts = [
      {
        email: fixture.emails.dispatcher,
        user: {
          name: 'Peliyagoda Dispatcher',
          email: fixture.emails.dispatcher,
          role: 'dispatcher',
          depotId: 'Peliyagoda',
        },
      },
      {
        email: fixture.emails.loader,
        user: {
          name: 'Peliyagoda Loader',
          email: fixture.emails.loader,
          role: 'loader',
          depotId: 'Peliyagoda',
        },
      },
      {
        email: fixture.emails.driver,
        user: {
          name: 'Van Driver',
          email: fixture.emails.driver,
          role: 'driver',
          vehicleId: 'VEH001',
        },
      },
      {
        email: fixture.emails.storeManager,
        user: {
          name: 'Store Manager',
          email: fixture.emails.storeManager,
          role: 'store_manager',
          outletId: 'OUT002',
        },
      },
    ];

    for (const account of accounts) {
      const login = await signIn(app, account.email, fixture.password);
      const body = JSON.stringify(login.json());
      expect(body).not.toContain('password');
      expect(body).not.toContain('argon2');
      expect(login.json()).toEqual({ user: { id: expect.any(String), ...account.user } });

      const cookie = cookiePair(login);
      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { cookie },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toEqual(login.json());

      const logout = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { cookie },
      });
      expect(logout.statusCode).toBe(204);
    }
  });

  it('rejects an unknown password and logs auth.login_failed', async () => {
    const response = await app.inject({
      ...client(),
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: fixture.emails.dispatcher, password: 'wrong-password' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Invalid email or password' },
    });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(logs.lines.join('\n')).toContain('auth.login_failed');
    expect(logs.lines.join('\n')).not.toContain('wrong-password');
  });

  it('signs in with an httpOnly session cookie and returns the current user', async () => {
    const login = await app.inject({
      ...client(),
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'Dispatcher@Waypoint.Test', password: fixture.password },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({
      user: {
        id: expect.any(String),
        name: 'Peliyagoda Dispatcher',
        email: fixture.emails.dispatcher,
        role: 'dispatcher',
        depotId: 'Peliyagoda',
      },
    });
    expect(JSON.stringify(login.json())).not.toContain('password');
    expect(JSON.stringify(login.json())).not.toContain('argon2');

    const header = setCookieHeader(login);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toMatch(/Path=\//);
    expect(header).toMatch(/Max-Age=43200/);
    expect(header).not.toMatch(/(?:^|;)\s*Secure(?:;|$)/i);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: cookiePair(login) },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual(login.json());
    const userId = (login.json() as { user: { id: string } }).user.id;
    expect(logEntries().find((entry) => entry.route === '/api/v1/auth/me')).toMatchObject({
      userId,
      role: 'dispatcher',
      statusCode: 200,
    });

    const session = await app.db.select().from(sessions).where(eq(sessions.userId, userId));
    const row = session[0];
    expect(row).toBeDefined();
    const expiresAt = row?.expiresAt.getTime() ?? 0;
    expect(expiresAt).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 5_000);
    expect(expiresAt).toBeLessThan(Date.now() + SESSION_TTL_MS + 5_000);

    const audit = await app.db.select().from(auditLog).where(eq(auditLog.action, 'auth.login'));
    expect(audit.some((entry) => entry.actorId === userId && entry.entityId === row?.id)).toBe(
      true,
    );
  });

  it('slides a live session forward by 12 hours', async () => {
    const login = await signIn(app, fixture.emails.loader, fixture.password);
    const userId = (login.json() as { user: { id: string } }).user.id;
    await app.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(sessions.userId, userId));

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: cookiePair(login) },
    });
    expect(me.statusCode).toBe(200);

    const session = await app.db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(session[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 11 * 60 * 60 * 1000);
  });

  it('rejects an expired or tampered cookie', async () => {
    const login = await signIn(app, fixture.emails.driver, fixture.password);
    const userId = (login.json() as { user: { id: string } }).user.id;
    await app.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(sessions.userId, userId));

    const expired = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: cookiePair(login) },
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Sign in required' },
    });
    expect(await app.db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(0);

    const tampered = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: `${cookiePair(login)}x` },
    });
    expect(tampered.statusCode).toBe(401);
  });

  it('logs out by deleting the session and clearing the cookie', async () => {
    const login = await signIn(app, fixture.emails.storeManager, fixture.password);
    const userId = (login.json() as { user: { id: string } }).user.id;
    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: cookiePair(login) },
    });
    expect(logout.statusCode).toBe(204);
    expect(logout.body).toBe('');
    const cleared = setCookieHeader(logout);
    expect(cleared).toMatch(/HttpOnly/i);
    expect(cleared).toMatch(/SameSite=Lax/i);
    expect(cleared).toMatch(/Max-Age=0/);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: cookiePair(login) },
    });
    expect(me.statusCode).toBe(401);
    expect(await app.db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(0);
    const audit = await app.db.select().from(auditLog).where(eq(auditLog.action, 'auth.logout'));
    expect(audit.some((entry) => entry.actorId === userId)).toBe(true);
  });

  it('locks a deactivated account out of sign-in and of its open sessions', async () => {
    const login = await signIn(app, fixture.emails.loader, fixture.password);
    const cookie = cookiePair(login);
    const me = () => app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect((await me()).statusCode).toBe(200);

    await app.db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.email, fixture.emails.loader));
    try {
      // The session that was open stops working on its next request.
      expect((await me()).statusCode).toBe(401);
      const work = await app.inject({ method: 'GET', url: '/api/v1/trips', headers: { cookie } });
      expect(work.statusCode).toBe(401);

      // A fresh sign-in is refused with the same answer as a wrong password.
      const again = await app.inject({
        ...client(),
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: fixture.emails.loader, password: fixture.password },
      });
      expect(again.statusCode).toBe(401);
      expect(again.json()).toEqual({
        error: { code: 'UNAUTHENTICATED', message: 'Invalid email or password' },
      });
    } finally {
      await app.db
        .update(users)
        .set({ disabledAt: null })
        .where(eq(users.email, fixture.emails.loader));
    }
    await signIn(app, fixture.emails.loader, fixture.password);
  });

  it('requires a session to log out', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/logout' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Sign in required' },
    });
  });

  it('rate limits login to 10 attempts per minute per IP', async () => {
    const remoteAddress = '10.9.9.9';
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress,
        payload: { email: 'nobody@waypoint.test', password: 'nope' },
      });
      statuses.push(response.statusCode);
      if (attempt === 10) {
        expect(response.json()).toEqual({
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many login attempts. Try again in a minute.',
          },
        });
      }
    }
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('marks the session cookie Secure in production', async () => {
    const secureApp = await buildApp({
      db: app.db,
      logger: false,
      sessionSecret: SESSION_SECRET,
      secureCookies: true,
    });
    try {
      const login = await secureApp.inject({
        ...client(),
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: fixture.emails.central, password: fixture.password },
      });
      expect(login.statusCode).toBe(200);
      expect(setCookieHeader(login)).toMatch(/(?:^|;)\s*Secure(?:;|$)/i);
    } finally {
      await secureApp.close();
    }
  });
});

async function signIn(app: Awaited<ReturnType<typeof buildApp>>, email: string, password: string) {
  const response = await app.inject({
    ...client(),
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  expect(response.statusCode).toBe(200);
  return response;
}
