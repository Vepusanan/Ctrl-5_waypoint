import { calendarDays, demandHistory } from '@waypoint/database';
import {
  demandInsightSchema,
  outletHistoryListSchema,
  outletProfileFactsSchema,
  savedViewListSchema,
  savedViewSchema,
} from '@waypoint/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthFixture } from '../../../../test/fixture.ts';
import { seedAuthFixture } from '../../../../test/fixture.ts';
import { client, cookiePair, SESSION_SECRET } from '../../../../test/http.ts';
import { createMigratedDatabase } from '../../../../test/postgres.ts';
import { buildApp } from '../../../app.ts';

// Analytics, outlet history and saved views: read models and one small CRUD, all dispatcher-only.
describe('insights and saved views', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
  let fixture: AuthFixture;
  let dispatcher: string;
  let central: string;
  let loader: string;
  let store: string;

  // Fridays: four observed weeks, then the service date.
  const SERVICE_DATE = '2026-10-02';
  const OBSERVED = ['2026-09-04', '2026-09-11', '2026-09-18', '2026-09-25'];

  beforeAll(async () => {
    database = await createMigratedDatabase();
    fixture = await seedAuthFixture(database.db);
    const days = [];
    for (let offset = -40; offset <= 80; offset += 1) {
      const date = new Date(Date.UTC(2026, 9, 2 + offset));
      const iso = date.toISOString().slice(0, 10);
      days.push({
        date: iso,
        dow: (date.getUTCDay() + 6) % 7,
        isoYear: 2026,
        isoWeek: 1 + (Math.floor((offset + 40) / 7) % 52),
        // One payday inside the forecast horizon.
        isPayday: iso === '2026-10-30',
        festival: null,
        festivalRamp: 0,
        isHoliday: false,
        monsoon: false,
        isOperating: date.getUTCDay() !== 0,
      });
    }
    await database.db.insert(calendarDays).values(days);
    await database.db.insert(demandHistory).values(
      OBSERVED.map((date) => ({
        date,
        depotId: 'Peliyagoda',
        brand: 'Fresh' as const,
        orders: 10,
        volumeM3: 100,
        chilledVolumeM3: 20,
      })),
    );
    app = await buildApp({
      db: database.db,
      logger: false,
      sessionSecret: SESSION_SECRET,
      secureCookies: false,
    });
    dispatcher = await login(fixture.emails.dispatcher);
    central = await login(fixture.emails.central);
    loader = await login(fixture.emails.loader);
    store = await login(fixture.emails.storeManager);
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it('projects demand from the latest same-weekday history', async () => {
    const response = await get(dispatcher, `/api/v1/analytics/demand?date=${SERVICE_DATE}`);
    expect(response.statusCode).toBe(200);
    const insight = demandInsightSchema.parse(response.json());
    expect(insight.depotId).toBe('Peliyagoda');
    expect(insight.history.map((day) => day.date)).toEqual(OBSERVED);
    expect(insight.forecast).toHaveLength(10);
    // No payday in the history, so nothing lifts the baseline.
    expect(insight.paydayUplift).toBe(1);
    expect(insight.forecast[0]).toMatchObject({
      date: '2026-10-09',
      volumeM3: 100,
      chilledVolumeM3: 20,
    });
    expect(insight.forecast.find((day) => day.date === '2026-10-30')?.isPayday).toBe(true);
    expect(insight.fleet.dry.vehicles + insight.fleet.reefer.vehicles).toBe(1);
  });

  it('keeps analytics and outlet history to dispatchers', async () => {
    for (const cookie of [loader, store]) {
      expect((await get(cookie, `/api/v1/analytics/demand?date=${SERVICE_DATE}`)).statusCode).toBe(
        403,
      );
      expect((await get(cookie, '/api/v1/outlets/history')).statusCode).toBe(403);
      expect((await get(cookie, '/api/v1/planning/views')).statusCode).toBe(403);
    }
    expect((await get('', '/api/v1/outlets/history')).statusCode).toBe(401);
    expect((await get(dispatcher, '/api/v1/analytics/demand?date=not-a-date')).statusCode).toBe(
      400,
    );
  });

  it('scopes outlet history and profiles to the dispatcher depot', async () => {
    const history = outletHistoryListSchema.parse(
      (await get(dispatcher, '/api/v1/outlets/history')).json(),
    );
    expect(history.items.map((item) => item.outletId).sort()).toEqual(['OUT002', 'OUT003']);
    const everywhere = outletHistoryListSchema.parse(
      (await get(central, '/api/v1/outlets/history')).json(),
    );
    expect(everywhere.items.map((item) => item.outletId)).toContain('OUT011');

    const own = await get(dispatcher, `/api/v1/outlets/OUT002/profile?date=${SERVICE_DATE}`);
    expect(own.statusCode).toBe(200);
    const profile = outletProfileFactsSchema.parse(own.json());
    expect(profile).toMatchObject({ outletId: 'OUT002', managerName: 'Store Manager' });
    expect(profile.onTime.arrivals).toBeLessThanOrEqual(profile.onTime.of);
    // Another depot's outlet reads as missing.
    expect(
      (await get(dispatcher, `/api/v1/outlets/OUT011/profile?date=${SERVICE_DATE}`)).statusCode,
    ).toBe(404);
  });

  it('stores saved views per dispatcher, shares team views and keeps their order', async () => {
    const create = (cookie: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/v1/planning/views', headers: { cookie }, payload });
    const mine = savedViewSchema.parse(
      (
        await create(dispatcher, {
          name: 'Chilled',
          audience: 'private',
          pinned: true,
          filters: { temp: 'chilled' },
        })
      ).json(),
    );
    const shared = savedViewSchema.parse(
      (
        await create(dispatcher, {
          name: 'Van only',
          audience: 'team',
          pinned: false,
          filters: { tag: 'van_only' },
        })
      ).json(),
    );
    expect((await create(dispatcher, { name: '', audience: 'private' })).statusCode).toBe(400);

    // A second dispatcher sees the team view only, and cannot change or delete it.
    const others = savedViewListSchema.parse((await get(central, '/api/v1/planning/views')).json());
    expect(others.items.map((view) => view.id)).toEqual([shared.id]);
    const foreign = await app.inject({
      method: 'PATCH',
      url: `/api/v1/planning/views/${shared.id}`,
      headers: { cookie: central },
      payload: { name: 'Renamed' },
    });
    expect(foreign.statusCode).toBe(404);

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/planning/views/${mine.id}`,
      headers: { cookie: dispatcher },
      payload: { name: 'Chilled first' },
    });
    expect(savedViewSchema.parse(renamed.json())).toMatchObject({
      name: 'Chilled first',
      filters: { temp: 'chilled' },
    });
    const ordered = await app.inject({
      method: 'PUT',
      url: '/api/v1/planning/views/order',
      headers: { cookie: dispatcher },
      payload: { ids: [shared.id, mine.id] },
    });
    expect(savedViewListSchema.parse(ordered.json()).items.map((view) => view.id)).toEqual([
      shared.id,
      mine.id,
    ]);
    // A new session reads the same list: the views live on the server.
    const again = await login(fixture.emails.dispatcher);
    expect(
      savedViewListSchema
        .parse((await get(again, '/api/v1/planning/views')).json())
        .items.map((view) => view.name),
    ).toEqual(['Van only', 'Chilled first']);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/planning/views/${mine.id}`,
      headers: { cookie: dispatcher },
    });
    expect(removed.statusCode).toBe(204);
    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/v1/planning/views/${mine.id}`,
      headers: { cookie: dispatcher },
    });
    expect(missing.statusCode).toBe(404);
  });

  function get(cookie: string, url: string) {
    return app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
  }

  async function login(email: string): Promise<string> {
    const response = await app.inject({
      ...client(),
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: fixture.password },
    });
    expect(response.statusCode).toBe(200);
    return cookiePair(response);
  }
});
