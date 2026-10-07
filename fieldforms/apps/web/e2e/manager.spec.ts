import { expect, test, type Page } from '@playwright/test';

/*
 * The seed leaves the last site's day shift unclosed yesterday, so its staff show "Missing OUT".
 * A manager fixes one with a reason, then corrects an entry; originals are kept and audited.
 */

async function signInAsAdmin(page: Page) {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Office' }).click();
  await page.getByLabel('Email').fill('admin@fieldforms.local');
  await page.getByLabel('Password').fill('fieldforms-dev-admin');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const accept = page.getByRole('button', { name: /I have read and accept/ });
  await expect(accept.or(page.getByTestId('report'))).toBeVisible();
  if (await accept.isVisible()) await accept.click();
  await expect(page.getByTestId('report')).toBeVisible();
}

test('manager adds a missing clock-out and corrects an entry, with reasons and history', async ({ page }) => {
  await signInAsAdmin(page);
  const yesterday = await page.evaluate(() => {
    const d = new Date(Date.now() - 86_400_000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(d);
  });
  await page.getByLabel('From', { exact: true }).fill(yesterday);
  await page.getByLabel('To', { exact: true }).fill(yesterday);
  await page.getByLabel('Missing clock events only').check();

  const rows = page.getByTestId('report').locator('tbody > tr');
  await expect(rows.first()).toContainText('Missing OUT');
  const before = await rows.count();
  expect(before).toBeGreaterThan(5);

  const first = rows.first();
  const name = (await first.locator('td').nth(1).innerText()).split('\n')[0]!;
  await first.getByRole('button', { name: 'Add missing OUT' }).click();
  await page.getByPlaceholder('Reason (required)').fill('Site manager confirmed 16:00 finish');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(rows).toHaveCount(before - 1);
  await expect(page.getByTestId('report')).not.toContainText(name);

  // Open that employee's register and correct the start entry.
  await page.getByLabel('Missing clock events only').uncheck();
  const row = page.getByTestId('report').locator('tbody > tr', { hasText: name }).first();
  await expect(row).toContainText('16:00');
  await row.getByRole('link', { name: 'Register 1' }).click();
  const entry = page.locator('tr', { hasText: name }).first();
  await entry.getByRole('button', { name: 'Correct' }).click();
  await page.locator('form.inline-form select').first().selectOption('late');
  await page.getByPlaceholder('Minutes').fill('25');
  await page.getByPlaceholder('Reason for correction (required)').fill('Gate log shows a late arrival');
  await page.getByRole('button', { name: 'Save correction' }).click();
  await expect(entry).toContainText('late');
  await expect(entry).toContainText('Corrected');
  await entry.getByRole('button', { name: /History \(1\)/ }).click();
  await expect(page.getByText('Gate log shows a late arrival')).toBeVisible();

  // The audit log records the view, the manual event and the correction.
  await page.goto('/admin/audit');
  await expect(page.getByText('attendance.correct').first()).toBeVisible();
  await expect(page.getByText('register.manual_event').first()).toBeVisible();
  await expect(page.getByText('attendance.report_view').first()).toBeVisible();
});
