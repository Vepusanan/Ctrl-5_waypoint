import { expect, test } from '@playwright/test';
import {
  currentUserResponseSchema,
  orderListResponseSchema,
  storeWorkspaceSchema,
  type TripDetail,
  tripListResponseSchema,
} from '../../packages/shared/src/index.ts';

// Enable only against a seeded API + Postgres + Caddy stack, never API mocks.
test('four accounts share login, preserve cookies, enforce routes and server scope', async ({
  page,
}, testInfo) => {
  test.skip(process.env.E2E_REAL_STACK !== 'true', 'Requires the real seeded stack');
  test.setTimeout(120_000);
  const accounts = [
    {
      email: 'store.manager@waypoint.test',
      home: '/store',
      heading: /Welcome back|Store home|Good|Your store/,
    },
    { email: 'dispatcher@waypoint.test', home: '/dispatcher', heading: /Command/ },
    { email: 'loader@waypoint.test', home: '/loader', heading: /Assigned loads/ },
    { email: 'driver@waypoint.test', home: '/driver', heading: /My trips/ },
  ];
  let foreignOrder = '';
  let storeOutlet = '';

  let operationalTrips: TripDetail[] = [];
  for (const account of accounts) {
    await page.goto('/login');
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill(process.env.SEED_PASSWORD ?? 'waypoint-demo');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${account.home}$`));
    const response = await page.request.get('/api/v1/auth/me');
    expect(response.status()).toBe(200);
    const { user } = currentUserResponseSchema.parse(await response.json());
    const cookies = await page.context().cookies();
    expect(cookies.find((cookie) => cookie.name === 'session')?.httpOnly).toBe(true);
    if (user.role === 'store_manager') {
      storeOutlet = user.outletId;
      const workspace = storeWorkspaceSchema.parse(
        await (await page.request.get('/api/v1/store/workspace')).json(),
      );
      expect(workspace.eligibleServiceDate).not.toBeNull();
      expect(workspace.orders.some((item) => item.editable)).toBe(true);
      const orders = orderListResponseSchema.parse(
        await (await page.request.get('/api/v1/orders')).json(),
      );
      expect(orders.items.length).toBeGreaterThan(0);
      expect(orders.items.every((order) => order.outletId === user.outletId)).toBe(true);
      await expect(
        page.getByRole('link', { name: 'Place order', exact: true }).first(),
      ).toBeVisible();
      expect((await page.request.get('/api/v1/trips')).status()).toBe(403);
      const other = await page.request.get('/api/v1/orders?outletId=OUT999');
      expect(other.status()).toBe(200);
      expect(orderListResponseSchema.parse(await other.json()).items).toHaveLength(0);
    } else if (user.role === 'dispatcher') {
      // The service date lives in the account menu at the foot of the sidebar.
      await page.getByRole('button', { name: 'Account menu' }).click();
      await expect(page.getByLabel('Service date')).toBeVisible();
      const date = await page.getByLabel('Service date').inputValue();
      expect(date).toBeTruthy();
      await page.keyboard.press('Escape');
      expect((await page.request.get(`/api/v1/planning/runs/${date}/queue`)).status()).toBe(200);
      await page.goto(`/dispatcher/queue?date=${date}`);
      await expect(page.getByRole('heading', { name: /Planning queue/i })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Place order', exact: true })).toHaveCount(0);
      const orders = orderListResponseSchema.parse(
        await (await page.request.get('/api/v1/orders')).json(),
      );
      foreignOrder = orders.items.find((order) => order.outletId !== storeOutlet)?.id ?? '';
      operationalTrips = tripListResponseSchema.parse(
        await (await page.request.get('/api/v1/trips')).json(),
      ).items;
    } else {
      const trips = tripListResponseSchema.parse(
        await (await page.request.get('/api/v1/trips')).json(),
      );
      expect(
        trips.items.every((trip) =>
          user.role === 'loader'
            ? trip.vehicle.depotId === user.depotId
            : trip.vehicleId === user.vehicleId,
        ),
      ).toBe(true);
      expect(
        (
          await page.request.post('/api/v1/planning/runs/2026-06-26/auto-allocate', {
            headers: { 'If-Match': '1' },
          })
        ).status(),
      ).toBe(403);
      await expect(page.getByRole('heading', { name: account.heading })).toBeVisible();
      if (user.role === 'driver') {
        const foreignTrip = operationalTrips.find((trip) => trip.vehicleId !== user.vehicleId)?.id;
        await page.goto('/driver/trips');
        await page.reload();
        await expect(page.getByRole('heading', { name: 'My trips' })).toBeVisible();
        if (foreignTrip)
          expect(
            (
              await page.request.post(`/api/v1/trips/${foreignTrip}/depart`, {
                headers: { 'If-Match': '1' },
              })
            ).status(),
          ).toBe(404);
      }
    }
    await page.screenshot({ path: testInfo.outputPath(`${user.role}.png`), fullPage: true });
    const wrongHome = account.home === '/dispatcher' ? '/store/orders/new' : '/dispatcher/allocate';
    await page.goto(wrongHome);
    await expect(page).toHaveURL(new RegExp(`${account.home}$`));
    await page.goto('/login');
    await expect(page).toHaveURL(new RegExp(`${account.home}$`));
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`${account.home}$`));
    // Each workspace keeps Sign out where its Figma shell puts it.
    if (user.role === 'dispatcher') {
      await page.getByRole('button', { name: 'Account menu' }).click();
    } else if (user.role === 'store_manager') {
      await page.getByRole('button', { name: 'Account', exact: true }).click();
    } else if (user.role === 'loader') {
      await page.goto('/loader/switch');
    } else {
      await page.goto('/driver/account');
    }
    await page
      .getByRole('button', { name: /^Sign out|Someone else/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/login$/);
    expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401);
  }
  // Revisit the store after dispatcher data has occupied this same browser cache.
  await page.getByLabel('Email').fill(accounts[0]?.email ?? '');
  await page.getByLabel('Password').fill(process.env.SEED_PASSWORD ?? 'waypoint-demo');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/store$/);
  if (foreignOrder)
    expect((await page.request.get(`/api/v1/orders/${foreignOrder}`)).status()).toBe(404);
});
