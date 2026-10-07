import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { e2eUrl } from './env';

/*
 * The Phase 1 acceptance test, and its harder variants:
 *   airplane mode → capture a register → reconnect → it appears on the server exactly once.
 * Each test uses its own work date so their records can be counted independently.
 */

let db: pg.Client;
test.beforeAll(async () => {
  db = new pg.Client({ connectionString: e2eUrl('owner') });
  await db.connect();
});
test.afterAll(async () => db?.end());

async function serverCounts(workDate: string) {
  const r = await db.query<{ submissions: number; entries: number; distinct_employees: number }>(
    `SELECT count(DISTINCT r.id)::int AS submissions, count(e.id)::int AS entries, count(DISTINCT e.employee_id)::int AS distinct_employees
     FROM register_submissions r LEFT JOIN attendance_entries e ON e.submission_id = r.id
     WHERE r.work_date = $1 AND r.source = 'app'`,
    [workDate],
  );
  return r.rows[0]!;
}

async function signInAsSupervisor(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Employee number').fill('S001');
  await page.getByLabel('PIN').fill('482915');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const accept = page.getByRole('button', { name: /I have read and accept/ });
  const site = page.getByTestId('site');
  await expect(accept.or(site)).toBeVisible();
  if (await accept.isVisible()) await accept.click();
  await expect(page.getByTestId('site')).toBeVisible();
  // The roster has been downloaded to the device.
  await expect(page.locator('[data-testid^="row-"]').first()).toBeVisible();
}

/** Waits until the service worker controls the page, so a reload works with no network. */
async function waitForServiceWorker(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
    await page.reload();
    await expect(page.getByTestId('site')).toBeVisible();
  }
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

async function fillStartRegister(page: Page, workDate: string) {
  await page.getByTestId('work-date').fill(workDate);
  const rows = page.locator('[data-testid^="row-"]');
  await expect(rows).toHaveCount(18);
  // One late arrival and one absence, so the register is not all defaults.
  await rows.nth(0).getByRole('button', { name: 'Late' }).click();
  await rows.nth(0).getByPlaceholder('Minutes late').fill('15');
  await rows.nth(1).getByRole('button', { name: 'Absent' }).click();
  await rows.nth(1).getByPlaceholder('Reason').fill('Sick');
}

test('airplane mode: clock in offline, reconnect, the record appears exactly once', async ({ page, context }) => {
  const workDate = '2026-03-02';
  await signInAsSupervisor(page);
  await waitForServiceWorker(page);

  await context.setOffline(true);
  await fillStartRegister(page, workDate);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('submit-message')).toContainText('Saved');
  await expect(page.getByTestId('submit-message')).toContainText('when you have signal');

  await page.getByRole('link', { name: 'Outbox' }).first().click();
  const item = page.getByTestId('outbox-item');
  await expect(item).toHaveCount(1);
  await expect(item).toHaveAttribute('data-status', /pending|syncing/);
  expect((await serverCounts(workDate)).submissions).toBe(0);

  // Still offline: the app reopens from the service worker cache and the register is still queued.
  await page.reload();
  await expect(page.getByText('You are offline')).toBeVisible();
  await expect(page.getByTestId('outbox-item')).toHaveCount(1);
  await expect(page.getByTestId('sync-chip')).toContainText('1 pending');

  // Back online: it syncs on its own.
  await context.setOffline(false);
  await expect(page.getByTestId('outbox-item')).toHaveAttribute('data-status', 'synced', { timeout: 20_000 });
  await expect(page.getByTestId('sync-chip')).toContainText('All synced');

  // Asking again changes nothing.
  await page.getByTestId('sync-now').click();
  await page.waitForTimeout(1500);
  const counts = await serverCounts(workDate);
  expect(counts).toEqual({ submissions: 1, entries: 18, distinct_employees: 18 });

  // And the manager's report shows each employee once for that day.
  const mgr = await page.context().request.post('/api/auth/password', {
    headers: { 'x-fieldforms': '1' },
    data: { email: 'manager@fieldforms.local', password: 'fieldforms-dev-manager' },
  });
  expect(mgr.status()).toBe(200);
  const report = await page.context().request.get(`/api/reports/daily?from=${workDate}&to=${workDate}`);
  const rows = (await report.json()).rows as { employeeId: string; status: string }[];
  expect(rows).toHaveLength(18);
  expect(new Set(rows.map((r) => r.employeeId)).size).toBe(18);
  expect(rows.filter((r) => r.status === 'late')).toHaveLength(1);
  expect(rows.filter((r) => r.status === 'absent')).toHaveLength(1);
});

test.describe('with the network intercepted', () => {
  // Requests a service worker makes are invisible to page.route, so keep it out of these tests.
  test.use({ serviceWorkers: 'block' });

  test('a response lost after the server stored the register is retried and stored once', async ({ page }) => {
    const workDate = '2026-03-03';
    await signInAsSupervisor(page);

    let posts = 0;
    await page.route('**/api/registers', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posts++;
      if (posts === 1) {
        // The server receives and stores it, but the phone never hears back.
        await route.fetch();
        return route.abort('connectionreset');
      }
      return route.continue();
    });

    await fillStartRegister(page, workDate);
    await page.getByTestId('submit').click();
    await expect(page.getByTestId('submit-message')).toContainText('Saved');
    await expect.poll(async () => (await serverCounts(workDate)).submissions).toBe(1);

    await page.getByRole('link', { name: 'Outbox' }).first().click();
    // Retry after the backoff (2-4 s for the first retry).
    await expect(async () => {
      await page.getByTestId('sync-now').click();
      await expect(page.getByTestId('outbox-item')).toHaveAttribute('data-status', 'synced', { timeout: 1000 });
    }).toPass({ timeout: 20_000 });

    expect(posts).toBeGreaterThanOrEqual(2);
    expect(await serverCounts(workDate)).toEqual({ submissions: 1, entries: 18, distinct_employees: 18 });
  });

  test('a server outage keeps the register queued and visible until it recovers', async ({ page }) => {
    const workDate = '2026-03-04';
    await signInAsSupervisor(page);

    let down = true;
    await page.route('**/api/registers', (route) =>
      down && route.request().method() === 'POST' ? route.fulfill({ status: 503, body: '{}' }) : route.continue(),
    );

    await fillStartRegister(page, workDate);
    await page.getByTestId('submit').click();
    await page.getByRole('link', { name: 'Outbox' }).first().click();
    await expect(page.getByTestId('outbox-item')).toHaveAttribute('data-status', 'pending');
    await expect(page.getByText('Server busy (503)')).toBeVisible();
    expect((await serverCounts(workDate)).submissions).toBe(0);

    down = false;
    await expect(async () => {
      await page.getByTestId('sync-now').click();
      await expect(page.getByTestId('outbox-item')).toHaveAttribute('data-status', 'synced', { timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    expect((await serverCounts(workDate)).submissions).toBe(1);
  });
});
