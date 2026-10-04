import { expect, test } from '@playwright/test';

// Every list is empty, and the demo clock is absent as it is outside DEMO_MODE.
function apiStub(url: string) {
  if (url.includes('/admin/clock')) {
    return { status: 404, json: { error: { code: 'NOT_FOUND', message: 'Route not found' } } };
  }
  return { json: { items: [], total: 0 } };
}

const driver = {
  id: '00000000-0000-7000-8000-000000000001',
  name: 'Test Driver',
  email: 'driver@example.com',
  role: 'driver',
  vehicleId: 'VEH001',
};

test('session check gates rendering, redirects wrong roles, and survives refresh', async ({
  page,
}) => {
  let release: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/**', async (route) => {
    if (route.request().url().endsWith('/auth/me')) {
      await ready;
      await route.fulfill({ json: { user: driver } });
    } else await route.fulfill(apiStub(route.request().url()));
  });
  await page.goto('/dispatcher/allocate');
  await expect(page.getByText('Checking your session…')).toBeVisible();
  await expect(page.getByLabel('Password')).toHaveCount(0);
  release();
  await expect(page).toHaveURL(/\/driver$/);
  await expect(page.getByRole('heading', { name: 'My trips' })).toBeVisible();
  await page.goto('/driver/trips');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'My trips' })).toBeVisible();
  await page.goto('/login');
  await expect(page).toHaveURL(/\/driver$/);
  await expect(page.getByRole('link', { name: 'Planning queue' })).toHaveCount(0);
});

test('one login shows credential and server errors and verifies the cookie with auth/me', async ({
  page,
}) => {
  let signedIn = false;
  let status = 401;
  let meRequests = 0;
  await page.route('**/api/v1/**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('/auth/me')) {
      meRequests++;
      await route.fulfill(
        signedIn
          ? { json: { user: driver } }
          : {
              status: 401,
              json: { error: { code: 'UNAUTHENTICATED', message: 'Sign in required' } },
            },
      );
    } else if (url.endsWith('/auth/login')) {
      if (status === 200) {
        signedIn = true;
        await route.fulfill({ json: { user: driver } });
      } else
        await route.fulfill({
          status,
          json: {
            error: {
              code: 'UNAUTHENTICATED',
              message: status === 401 ? 'Invalid email or password' : 'private server stack',
            },
          },
        });
    } else if (url.endsWith('/auth/logout')) {
      signedIn = false;
      await route.fulfill({ status: 204 });
    } else await route.fulfill(apiStub(url));
  });
  await page.goto('/store/orders/new');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Email').fill(driver.email);
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid email or password');
  status = 500;
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('The server could not complete');
  await expect(page.getByText('private server stack')).toHaveCount(0);
  status = 200;
  const before = meRequests;
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/driver$/);
  expect(meRequests).toBeGreaterThan(before);
  // Sign out lives on the driver's Account tab.
  await page.getByRole('link', { name: 'Account' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/login$/);
});

test('expired session clears the workspace; logout failure keeps the session visible', async ({
  page,
}) => {
  let expired = false;
  await page.route('**/api/v1/**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('/auth/me')) await route.fulfill({ json: { user: driver } });
    else if (url.endsWith('/auth/logout'))
      await route.fulfill({
        status: 503,
        json: { error: { code: 'INTERNAL_ERROR', message: 'hidden' } },
      });
    else if (expired)
      await route.fulfill({
        status: 401,
        json: { error: { code: 'UNAUTHENTICATED', message: 'Sign in required' } },
      });
    else await route.fulfill(apiStub(url));
  });
  await page.goto('/driver/account');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('alert')).toContainText('The server could not complete');
  await expect(page).toHaveURL(/\/driver\/account$/);
  expired = true;
  await page.getByRole('link', { name: 'Notices' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText('Test Driver')).toHaveCount(0);
});
