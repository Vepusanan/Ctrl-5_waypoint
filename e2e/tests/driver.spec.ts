import { expect, test } from '@playwright/test';
import type { DeliveryStop, StopEventInput } from '../../packages/shared/src/index.ts';

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const driver = {
  id: uid(1),
  name: 'First Driver',
  email: 'first@example.com',
  role: 'driver',
  vehicleId: 'VEH001',
};
const other = {
  ...driver,
  id: uid(2),
  name: 'Second Driver',
  email: 'second@example.com',
  vehicleId: 'VEH002',
};

test('driver records offline, keeps the outbox until it syncs, uploads POD and syncs once', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  let user: typeof driver | null = driver;
  let allowSync = false;
  const applied: string[] = [];
  const calls: string[] = [];
  let stop: DeliveryStop = {
    id: uid(5),
    tripId: uid(4),
    tripStatus: 'departed',
    tripVersion: 1,
    seq: 1,
    plannedArrival: '2026-10-03T07:00:00+05:30',
    eta: '2026-10-03T07:00:00+05:30',
    status: 'pending',
    late: false,
    windowClose: '08:00',
    failureReason: null,
    pod: null,
    order: {
      id: uid(6),
      outletId: 'OUT001',
      brand: 'Fresh',
      temp: 'chilled',
      requestedDate: '2026-10-03',
      units: 4,
      weightKg: 20,
      volumeM3: 1,
      status: 'dispatched',
    },
  };
  const trip = () => ({
    id: uid(4),
    runId: uid(3),
    vehicleId: 'VEH001',
    tripNo: 1,
    brand: 'Fresh',
    district: 'Colombo',
    status: 'departed',
    version: 1,
    plannedMinutes: 60,
    plannedKm: 20,
    run: {
      id: uid(3),
      depotId: 'Peliyagoda',
      serviceDate: '2026-10-03',
      status: 'published',
      planVersion: 1,
    },
    vehicle: { id: 'VEH001', type: 'van', temp: 'reefer', depotId: 'Peliyagoda' },
    stops: [
      {
        id: stop.id,
        tripId: stop.tripId,
        orderId: stop.order.id,
        seq: 1,
        plannedArrival: stop.plannedArrival,
        status: stop.status,
        order: stop.order,
      },
    ],
    loadingStatus: 'departed',
    exceptions: [],
    lastEvent: null,
  });
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/api/v1', '');
    if (path === '/auth/me')
      await route.fulfill(
        user
          ? { json: { user } }
          : {
              status: 401,
              json: { error: { code: 'UNAUTHENTICATED', message: 'Sign in required' } },
            },
      );
    else if (path === '/auth/login') {
      user = route.request().postDataJSON().email === driver.email ? driver : other;
      await route.fulfill({ json: { user } });
    } else if (path === '/auth/logout') {
      user = null;
      await route.fulfill({ status: 204 });
    } else if (path === '/trips')
      await route.fulfill({
        json: {
          items: user?.id === driver.id ? [trip()] : [],
          total: user?.id === driver.id ? 1 : 0,
        },
      });
    else if (path === `/trips/${stop.tripId}`) await route.fulfill({ json: trip() });
    else if (path === `/stops/${stop.id}`) await route.fulfill({ json: stop });
    else if (path.startsWith('/sync/trips/'))
      await route.fulfill({ json: { changed: false, tripId: stop.tripId, version: 1 } });
    else if (path === `/stops/${stop.id}/pod`) {
      expect(user?.id).toBe(driver.id);
      expect(route.request().headers()['content-type']).toContain('multipart/form-data');
      calls.push('pod');
      stop = {
        ...stop,
        pod: {
          id: uid(8),
          stopId: stop.id,
          recipientName: 'Recipient',
          hasPhoto: false,
          clientTime: '2026-10-03T07:00:00+05:30',
        },
      };
      await route.fulfill({ status: 201, json: stop.pod });
    } else if (path === '/sync/events') {
      if (!allowSync) {
        await route.abort();
        return;
      }
      expect(user?.id).toBe(driver.id);
      const events: StopEventInput[] = route.request().postDataJSON().events;
      for (const event of events) {
        expect(applied).not.toContain(event.clientEventId);
        applied.push(event.clientEventId);
        calls.push(event.type);
        if (event.type === 'delivered') expect(event.payload.podId).toBe(stop.pod?.id);
        stop = { ...stop, status: event.type };
      }
      await route.fulfill({
        json: {
          results: events.map((event) => ({
            clientEventId: event.clientEventId,
            status: 'applied',
          })),
        },
      });
    } else if (path === '/admin/clock')
      // Outside DEMO_MODE there is no demo clock, and the app follows the device clock.
      await route.fulfill({
        status: 404,
        json: { error: { code: 'NOT_FOUND', message: 'Route not found' } },
      });
    else await route.fulfill({ json: { items: [], total: 0 } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/driver');
  await page.getByRole('link', { name: 'Continue trip' }).click();
  await page.locator('a[href*="/driver/stops/"]').first().click();
  const arrive = page.getByRole('button', { name: "I've arrived" });
  await expect(arrive).toBeVisible();

  // No signal: the stop is recorded on the phone and counted as pending.
  await context.setOffline(true);
  await arrive.click();
  await expect(page.getByText(/1 pending/)).toBeVisible();
  await page.getByRole('link', { name: 'Record delivery' }).click();
  const complete = page.getByRole('button', { name: 'Complete delivery' });
  // Proof of delivery is required before the stop can be completed (SRS AC-12).
  await expect(complete).toBeDisabled();
  await page.getByRole('textbox').first().fill('Recipient');
  const canvas = page.locator('canvas').first();
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Signature canvas not visible');
  await page.mouse.move(box.x + 10, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 50, { steps: 8 });
  await page.mouse.up();
  await complete.click();
  await expect(page.getByText(/2 pending/)).toBeVisible();
  expect(applied).toHaveLength(0);

  // Back online, but the server is unreachable: nothing is lost and sign-out stays locked, so
  // another driver cannot take over a phone that still holds unsent records.
  await context.setOffline(false);
  await page.goto('/driver/account');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeDisabled();
  expect(applied).toHaveLength(0);

  // The server answers again: the proof uploads first, then each event is applied once.
  allowSync = true;
  await page.goto('/driver/sync');
  // Opening the app starts a sync by itself. The button is the manual way, when it is free.
  await page
    .getByRole('button', { name: 'Sync now' })
    .click({ timeout: 3_000 })
    .catch(() => undefined);
  await expect(page.getByText('All synced')).toBeVisible({ timeout: 30_000 });
  expect(calls).toEqual(['arrived', 'pod', 'delivered']);
  // Reopening the app does not send them again.
  await page.reload();
  await expect(page.getByText('All synced')).toBeVisible();
  expect(applied).toHaveLength(2);

  // With nothing pending the driver can hand the phone over, and the next driver starts clean.
  await page.goto('/driver/account');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Email').fill(other.email);
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/driver$/);
  await expect(page.getByText('No published trips')).toBeVisible();
  await page.getByRole('link', { name: 'Sync' }).click();
  await expect(page.getByText(/pending/)).toHaveCount(0);
  expect(applied).toHaveLength(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
