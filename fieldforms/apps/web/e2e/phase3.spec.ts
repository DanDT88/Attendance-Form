import { expect, test, type Page } from '@playwright/test';
import { signInOffice } from './helpers';

/**
 * Smoke test of the Phase 3 office screens against the real API: every screen opens, its API
 * calls succeed, and nothing shows an error. Deeper behaviour is covered by the API tests.
 */

/** Records every /api call that fails from now on (before sign-in, /api/me is a 401). */
function failedApiCalls(page: Page): string[] {
  const failed: string[] = [];
  page.on('response', (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith('/api/') && r.status() >= 400)
      failed.push(`${r.request().method()} ${url.pathname} → ${r.status()}`);
  });
  return failed;
}

test('every Phase 3 screen opens for an admin without errors', async ({ page }) => {
  await signInOffice(page, 'admin@fieldforms.local', 'fieldforms-dev-admin');
  const failed = failedApiCalls(page);

  const forms = (await (await page.request.get('/api/admin/forms')).json()) as {
    id: string;
    name: string;
  }[];
  const inspection = forms.find((f) => f.name === 'Site inspection');
  expect(inspection, 'the demo form').toBeTruthy();

  const screens: [string, string][] = [
    ['/admin/connections', 'Connections'],
    ['/admin/templates', 'Templates'],
    ['/admin/api-keys', 'API keys'],
    [`/admin/forms/${inspection!.id}/destinations`, 'Destinations'],
    [`/admin/forms/${inspection!.id}/documents`, 'Documents'],
    ['/admin/settings', 'Settings'],
    ['/admin/org', 'Companies'],
    ['/deliveries', 'Deliveries'],
  ];
  for (const [path, text] of screens) {
    await page.goto(path);
    await expect(page.getByText(text, { exact: false }).first(), path).toBeVisible();
    // Give queries time to settle, then nothing may show an error.
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.error'), path).toHaveCount(0);
  }
  // The demo email destination is listed on the form's destinations screen.
  await page.goto(`/admin/forms/${inspection!.id}/destinations`);
  await expect(page.getByText('Site report recipients').first()).toBeVisible();

  expect(failed).toEqual([]);
});

test('a manager sees the deliveries page but not the admin screens', async ({ page }) => {
  await signInOffice(page, 'manager@fieldforms.local', 'fieldforms-dev-manager');
  const failed = failedApiCalls(page);
  await page.goto('/deliveries');
  await expect(page.getByText('Deliveries').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.error')).toHaveCount(0);
  expect(failed).toEqual([]);
  expect((await page.request.get('/api/admin/connections')).status()).toBe(403);
});
