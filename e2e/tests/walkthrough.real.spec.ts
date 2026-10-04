import { type Browser, expect, type Page, test } from '@playwright/test';

// The judge walkthrough (SRS §51) across the four seeded accounts, against the real stack:
// order -> cutoff -> plan -> deferral -> publish -> load -> shortfall -> deliver (one stop offline)
// -> receipt -> issue resolved -> audit. It resets the demo data first, so never point it at data worth keeping.
const password = process.env.SEED_PASSWORD ?? 'waypoint-demo';

async function signIn(
  browser: Browser,
  account: string,
  viewport: { width: number; height: number },
): Promise<Page> {
  // No service worker, so going offline reaches the app's own outbox and not a cached shell.
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
const tablet = { width: 1180, height: 820 };
const phone = { width: 390, height: 844 };

async function clockPreset(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name, exact: true }).click();
}

test('one order travels from the store to a confirmed receipt across all four roles', async ({
  browser,
}) => {
  test.skip(process.env.E2E_REAL_STACK !== 'true', 'Requires the real seeded stack');
  test.setTimeout(240_000);

  // Start from the seeded day.
  let dispatcher = await signIn(browser, 'dispatcher', desktop);
  const reset = await dispatcher.request.post('/api/v1/admin/reset', { data: { confirm: true } });
  expect(reset.status()).toBe(200);
  await dispatcher.context().close();

  // 1. Store manager places the dry order next to the open chilled one.
  const store = await signIn(browser, 'store.manager', desktop);
  await store.goto('/store/orders/new');
  await store.getByRole('tab', { name: /Dry/ }).click();
  for (let count = 0; count < 3; count += 1) {
    await store.getByRole('button', { name: 'More: Samba rice 5 kg' }).click();
  }
  await store.getByRole('button', { name: /^Submit/ }).click();
  await expect(store.getByRole('heading', { name: 'Order received' })).toBeVisible();

  // 2. Dispatcher closes the run, allocates, records the deferral and publishes.
  dispatcher = await signIn(browser, 'dispatcher', desktop);
  await clockPreset(dispatcher, 'After cutoff');
  await dispatcher.goto('/dispatcher/allocate');
  await dispatcher.getByText('Automatic', { exact: true }).click();
  await dispatcher.getByRole('button', { name: 'Run automatic allocation' }).click();
  await expect(dispatcher.getByText('Automatic run finished')).toBeVisible();

  await dispatcher.goto('/dispatcher/deferrals');
  await dispatcher.getByRole('checkbox').first().check({ force: true });
  await dispatcher
    .getByRole('textbox', { name: /Final justification/ })
    .fill('Heavier than any van. First in the next run.');
  await dispatcher
    .getByRole('button', { name: /Confirm 1 deferral/ })
    .first()
    .click();
  await dispatcher.getByRole('dialog').getByRole('button', { name: 'Confirm deferrals' }).click();
  await expect(dispatcher.getByText('1 deferral recorded')).toBeVisible();

  await dispatcher.goto('/dispatcher/review');
  await dispatcher.getByRole('button', { name: /Publish plan/ }).click();
  await dispatcher
    .getByRole('dialog')
    .getByRole('button', { name: /Publish/ })
    .last()
    .click();
  await expect(dispatcher.getByText(/Plan v\d+ is live/)).toBeVisible();

  // 3. Loader starts the van's load and reports a shortfall. Ready waits for the dispatcher.
  const loader = await signIn(browser, 'loader', tablet);
  await loader
    .getByRole('link', { name: /VEH035/ })
    .first()
    .click();
  await loader.getByRole('button', { name: 'Start loading' }).click();
  await loader.getByRole('link', { name: 'Report shortfall' }).click();
  await loader.getByText('Damaged', { exact: true }).click();
  await loader.getByRole('button', { name: 'Send to dispatcher' }).click();
  await expect(loader.getByText('Dispatcher is deciding')).toBeVisible();

  await dispatcher.goto('/dispatcher/live');
  await dispatcher.locator('a[href*="/live/exceptions/"]').first().click();
  await dispatcher.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dispatcher.getByText('Recovery applied')).toBeVisible();

  await loader.goto('/loader');
  await loader
    .getByRole('link', { name: /VEH035/ })
    .first()
    .click();
  for (let stop = 0; stop < 2; stop += 1) {
    await loader.getByRole('button', { name: /Mark all \d+ units loaded/ }).click();
    const next = loader.getByRole('button', { name: /Next stop/ });
    if (await next.count()) await next.click();
  }
  await loader.getByRole('button', { name: 'Verify load' }).click();
  await loader.getByRole('button', { name: 'Confirm verification' }).click();
  await loader.getByRole('button', { name: 'Mark Ready' }).click();
  await expect(loader.getByRole('button', { name: 'Confirm departure' })).toBeVisible();

  // 4. Driver delivers the first stop online and records the second one with no signal.
  await clockPreset(dispatcher, 'Service morning');
  const driver = await signIn(browser, 'driver', phone);
  await driver.getByRole('button', { name: 'Start trip' }).click();
  await driver.locator('a[href*="/driver/stops/"]').first().click();
  await driver.getByRole('button', { name: "I've arrived" }).click();
  await driver.getByRole('link', { name: 'Record delivery' }).click();
  const complete = driver.getByRole('button', { name: 'Complete delivery' });
  await expect(complete).toBeDisabled();
  await driver.getByRole('textbox').first().fill('K. Silva');
  const pad = driver.locator('canvas').first();
  await pad.scrollIntoViewIfNeeded();
  const box = await pad.boundingBox();
  if (box === null) throw new Error('Signature pad is not on screen');
  await driver.mouse.move(box.x + 20, box.y + 30);
  await driver.mouse.down();
  await driver.mouse.move(box.x + 90, box.y + 60, { steps: 5 });
  await driver.mouse.move(box.x + 160, box.y + 25, { steps: 5 });
  await driver.mouse.up();
  await complete.click();
  await expect(driver.getByText(/Received by K\. Silva/)).toBeVisible();

  await driver.getByRole('link', { name: /Next stop/ }).click();
  await driver.context().setOffline(true);
  await driver.getByRole('button', { name: "I've arrived" }).click();
  await driver.getByRole('link', { name: 'Record delivery' }).click();
  await driver.getByText('Failed', { exact: true }).click();
  await driver.getByText('Outlet closed', { exact: true }).click();
  await driver.getByRole('button', { name: 'Record failed delivery' }).click();
  await expect(driver.getByText(/2 pending/)).toBeVisible();

  await driver.context().setOffline(false);
  await driver.evaluate(() => window.dispatchEvent(new Event('online')));
  await driver.goto('/driver/sync');
  await expect(driver.getByText('All synced')).toBeVisible({ timeout: 30_000 });
  await driver.goto('/driver');
  await expect(driver.getByText(/All stops done/)).toBeVisible();

  // 5. Store manager reports a damaged carton and confirms the receipt.
  await store.goto('/store/receipts');
  await expect(store.getByText(/K\. Silva/)).toBeVisible();
  await store.locator('main').getByRole('link', { name: 'Issue', exact: true }).first().click();
  await store.getByText('Damaged', { exact: true }).first().click();
  await store.getByRole('button', { name: /^More/ }).first().click();
  await store.getByRole('button', { name: 'Submit issue' }).click();
  await expect(store.getByText('Issue sent to planning')).toBeVisible();
  await store.goto('/store/receipts');
  await store
    .getByRole('button', { name: /^Confirm/ })
    .first()
    .click();
  await expect(store.getByText(/Receipt confirmed/).first()).toBeVisible();

  // 6. Dispatcher resolves the store's issue, with the driver's proof beside it.
  await dispatcher.goto('/dispatcher/issues');
  await expect(dispatcher.getByRole('img', { name: 'Recipient signature' })).toBeVisible();
  await dispatcher.getByRole('button', { name: 'Resolve issue' }).click();
  await expect(dispatcher.getByText(/Write what was decided/)).toBeVisible();
  await dispatcher
    .getByRole('textbox', { name: /Resolution/ })
    .fill('Credit note raised. Replacement carton on the next run.');
  await dispatcher.getByRole('button', { name: 'Resolve issue' }).click();
  await expect(dispatcher.getByText('Issue resolved', { exact: true })).toBeVisible();
  await store.goto('/store/issues');
  await expect(store.getByText(/Credit note raised/).first()).toBeVisible();

  // 7. Dispatcher sees the whole story in the audit trail.
  const received = await dispatcher.request.get('/api/v1/orders?status=receipt_confirmed');
  expect(received.status()).toBe(200);
  const { items } = (await received.json()) as { items: { id: string }[] };
  expect(items).toHaveLength(1);
  await dispatcher.goto(`/dispatcher/orders?order=${items[0]?.id}`);
  const log = dispatcher.locator('main');
  for (const event of [
    'Plan published',
    'Load ready',
    'Departed',
    'Delivered',
    'Receipt issue reported',
    'Receipt confirmed',
    'Receipt issue resolved',
  ]) {
    await expect(log.getByRole('cell', { name: event, exact: true }).first()).toBeVisible();
  }
  await expect(log.getByText('K. Silva').first()).toBeVisible();
});
