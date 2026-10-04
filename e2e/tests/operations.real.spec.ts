import { type Browser, expect, type Page, test } from '@playwright/test';

// Operations after the plan exists, against the real stack: the empty-plan guard, a vehicle lost
// after publish and its replan, a second driver, loader counts that survive a reload, and the
// pages that read recorded data (analytics, outlets, saved views). It resets the demo data first.
const password = process.env.SEED_PASSWORD ?? 'waypoint-demo';

async function signIn(
  browser: Browser,
  account: string,
  viewport: { width: number; height: number },
): Promise<Page> {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(`${account}@waypoint.test`);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
  return page;
}

const desktop = { width: 1440, height: 900 };

test('a published plan survives a lost vehicle, and each driver sees only their own trips', async ({
  browser,
}) => {
  test.skip(process.env.E2E_REAL_STACK !== 'true', 'Requires the real seeded stack');
  test.setTimeout(240_000);

  let dispatcher = await signIn(browser, 'dispatcher', desktop);
  expect(
    (await dispatcher.request.post('/api/v1/admin/reset', { data: { confirm: true } })).status(),
  ).toBe(200);
  await dispatcher.context().close();
  dispatcher = await signIn(browser, 'dispatcher', desktop);
  await dispatcher.getByRole('button', { name: 'Account menu' }).click();
  await dispatcher.getByRole('button', { name: 'After cutoff', exact: true }).click();

  // An empty plan cannot be published: the button is off and the check says why.
  await dispatcher.goto('/dispatcher/review');
  await expect(dispatcher.getByText(/No order is on a trip/)).toBeVisible();
  await expect(dispatcher.getByRole('button', { name: /Publish plan/ })).toBeDisabled();
  const run = (await dispatcher.request.get('/api/v1/calendar')).status();
  expect(run).toBe(200);

  // A saved queue view is kept on the server.
  await dispatcher.goto('/dispatcher/queue');
  await dispatcher.getByRole('button', { name: 'Save view' }).click();
  const sheet = dispatcher.getByRole('dialog');
  await sheet.getByRole('textbox').first().fill('Chilled first');
  await sheet.locator('select').first().selectOption('temp:chilled');
  await sheet.getByRole('button', { name: 'Save view' }).click();
  await expect(sheet).toHaveCount(0);
  await dispatcher.reload();
  await expect(dispatcher.getByText('Chilled first').first()).toBeVisible();

  // Allocate and publish.
  await dispatcher.goto('/dispatcher/allocate');
  await dispatcher.getByText('Automatic', { exact: true }).click();
  await dispatcher.getByRole('button', { name: 'Run automatic allocation' }).click();
  await expect(dispatcher.getByText('Automatic run finished')).toBeVisible();
  await dispatcher.goto('/dispatcher/review');
  await dispatcher.getByRole('button', { name: /Publish plan/ }).click();
  await dispatcher
    .getByRole('dialog')
    .getByRole('button', { name: /Publish/ })
    .last()
    .click();
  await expect(dispatcher.getByText(/Plan v\d+ is live/)).toBeVisible();

  // A dry truck with stops breaks down before it leaves.
  const listed = await dispatcher.request.get('/api/v1/trips');
  const trips = (
    (await listed.json()) as {
      items: {
        id: string;
        vehicleId: string;
        run: { serviceDate: string };
        vehicle: { type: string; temp: string };
        stops: { orderId: string }[];
      }[];
    }
  ).items;
  const date = trips[0]?.run.serviceDate ?? '';
  expect(date).not.toBe('');
  const lost = trips.find(
    (trip) =>
      trip.vehicle.temp === 'ambient' && trip.vehicle.type === 'truck' && trip.stops.length > 1,
  );
  if (!lost) throw new Error('Expected a dry truck with at least two stops');
  const stranded = trips
    .filter((trip) => trip.vehicleId === lost.vehicleId)
    .flatMap((trip) => trip.stops.map((stop) => stop.orderId));

  await dispatcher.goto(`/dispatcher/vehicles/${lost.vehicleId}?date=${date}`);
  await dispatcher.getByRole('button', { name: 'Mark unavailable' }).click();
  await dispatcher.getByRole('dialog').getByRole('textbox').fill('Brake failure');
  await dispatcher.getByRole('dialog').getByRole('button', { name: 'Mark unavailable' }).click();
  await expect(dispatcher).toHaveURL(new RegExp(`/vehicles/${lost.vehicleId}/replan`));
  await expect(dispatcher.getByText(/Brake failure/)).toBeVisible();
  await dispatcher.getByRole('button', { name: /Publish plan/ }).click();
  await dispatcher
    .getByRole('dialog')
    .getByRole('button', { name: /Publish/ })
    .last()
    .click();
  await expect(dispatcher.getByText(/Plan v\d+ is published/)).toBeVisible();

  // Every stranded order is on another vehicle or deferred, and the lost truck carries nothing.
  const after = (
    (await (await dispatcher.request.get(`/api/v1/trips?date=${date}`)).json()) as {
      items: { vehicleId: string; stops: { orderId: string }[] }[];
    }
  ).items;
  expect(after.some((trip) => trip.vehicleId === lost.vehicleId && trip.stops.length > 0)).toBe(
    false,
  );
  for (const orderId of stranded) {
    const moved = after.some((trip) => trip.stops.some((stop) => stop.orderId === orderId));
    const order = (await (await dispatcher.request.get(`/api/v1/orders/${orderId}`)).json()) as {
      status: string;
    };
    expect(moved || order.status === 'deferred').toBe(true);
  }

  // One published stop is deferred with a reason, as a new plan version.
  const open = after.find((trip) => trip.vehicleId !== 'VEH035' && trip.stops.length > 1);
  if (!open) throw new Error('Expected an open trip with two stops');
  await dispatcher.goto(`/dispatcher/vehicles/${open.vehicleId}?date=${date}`);
  await dispatcher
    .getByRole('button', { name: /^Move or defer/ })
    .first()
    .click();
  await dispatcher.getByText('Defer to next run', { exact: true }).click();
  await dispatcher.getByRole('dialog').getByRole('button', { name: 'Publish the change' }).click();
  await expect(dispatcher.getByText(/Write the reason/)).toBeVisible();
  await dispatcher.getByRole('dialog').getByRole('textbox').fill('Store asked to skip today');
  await dispatcher.getByRole('dialog').getByRole('button', { name: 'Publish the change' }).click();
  await expect(dispatcher.getByRole('dialog')).toHaveCount(0);

  // The loader's count is kept by the server: it is still there after a reload.
  const loader = await signIn(browser, 'loader', { width: 1180, height: 820 });
  await loader
    .getByRole('link', { name: /VEH035/ })
    .first()
    .click();
  await loader.getByRole('button', { name: 'Start loading' }).click();
  await loader.getByRole('button', { name: /Mark all \d+ units loaded/ }).click();
  await loader.getByRole('button', { name: 'One less' }).click();
  const counted = loader.getByText(/^\d+ of \d+ units$/).first();
  await expect(counted).not.toHaveText(/^0 of/);
  const before = await counted.textContent();
  await loader.reload();
  await expect(loader.getByText(/^\d+ of \d+ units$/).first()).toHaveText(before ?? '');

  // Two drivers, two vehicles: each sees only their own trips, and cannot open the other's.
  const second = after.find((trip) => trip.vehicleId !== 'VEH035' && trip.stops.length > 0);
  if (!second) throw new Error('Expected a second vehicle with a trip');
  const vanDriver = await signIn(browser, 'driver', { width: 390, height: 844 });
  const truckDriver = await signIn(browser, `driver.${second.vehicleId.toLowerCase()}`, {
    width: 390,
    height: 844,
  });
  const own = async (page: Page) =>
    (
      (await (await page.request.get(`/api/v1/trips?date=${date}`)).json()) as {
        items: { id: string; vehicleId: string }[];
      }
    ).items;
  const vanTrips = await own(vanDriver);
  const truckTrips = await own(truckDriver);
  expect(vanTrips.length).toBeGreaterThan(0);
  expect(vanTrips.every((trip) => trip.vehicleId === 'VEH035')).toBe(true);
  expect(truckTrips.length).toBeGreaterThan(0);
  expect(truckTrips.every((trip) => trip.vehicleId === second.vehicleId)).toBe(true);
  expect((await vanDriver.request.get(`/api/v1/trips/${truckTrips[0]?.id}`)).status()).toBe(404);
  expect((await truckDriver.request.get(`/api/v1/trips/${vanTrips[0]?.id}`)).status()).toBe(404);
  await expect(truckDriver.getByRole('heading', { name: 'My trips' })).toBeVisible();
  await expect(truckDriver.getByText(second.vehicleId).first()).toBeVisible();

  // Analytics and outlets read recorded data, not samples.
  await dispatcher.goto(`/dispatcher/analytics?date=${date}`);
  await expect(dispatcher.getByText(/weeks observed, 10 weeks predicted/)).toBeVisible();
  await dispatcher.goto(`/dispatcher/outlets?date=${date}`);
  await expect(dispatcher.getByRole('table').getByText('OUT001')).toBeVisible();
});
