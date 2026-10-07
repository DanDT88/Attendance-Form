import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { e2eUrl } from './env';
import { scribble, signInAsSupervisor, signInOffice, waitForServiceWorker } from './helpers';

const PHOTO = fileURLToPath(new URL('../public/icon-512.png', import.meta.url));
const QR = fileURLToPath(new URL('./qr-asset-00042.png', import.meta.url));

let db: pg.Client;
test.beforeAll(async () => {
  db = new pg.Client({ connectionString: e2eUrl('owner') });
  await db.connect();
});
test.afterAll(async () => db?.end());

const submissionsFor = async (title: string) =>
  (
    await db.query<{
      id: string;
      data: Record<string, any>;
      dispatch_id: string | null;
      files: number;
    }>(
      `SELECT s.id, s.data, s.dispatch_id, (SELECT count(*)::int FROM form_submission_files f WHERE f.submission_id = s.id) AS files
       FROM form_submissions s JOIN forms fm ON fm.id = s.form_id WHERE fm.name = $1 ORDER BY s.server_received_at`,
      [title],
    )
  ).rows;

test('fill a form offline: draft survives a reload, calculations, photo markup and signature, sent once', async ({
  page,
  context,
}) => {
  const before = (await submissionsFor('Site inspection')).length;
  await signInAsSupervisor(page);
  await waitForServiceWorker(page);
  await page.getByRole('link', { name: 'Forms', exact: true }).click();
  await expect(page.getByTestId('form').filter({ hasText: 'Site inspection' })).toBeVisible();

  await context.setOffline(true);
  await page
    .getByTestId('form')
    .filter({ hasText: 'Site inspection' })
    .getByRole('button', { name: 'Fill in' })
    .click();

  await page.getByLabel('Area inspected').selectOption('kitchen');
  await page.getByLabel('Inspection date').fill('2026-10-07');
  await page.getByLabel('Floors').check();
  await page.getByRole('button', { name: 'Add item' }).click();
  await page.locator('[id="items[0].item"]').fill('Bleach');
  await page.getByLabel('Quantity').fill('4');
  await page.getByLabel('Unit price (R)').fill('49.99');
  await expect(page.getByTestId('calc-items[0].line_total')).toHaveText('199.96');
  await expect(page.getByTestId('calc-order_total')).toHaveText('199.96');

  // Follow-up questions appear only when needed.
  await expect(page.getByLabel('Follow up by')).toHaveCount(0);
  await page.getByRole('radio', { name: 'Yes' }).click();
  await page.getByLabel('Follow up by').fill('2026-10-01');

  await page.getByTestId('photo-fault_photo').setInputFiles(PHOTO);
  await page.getByRole('button', { name: 'Mark up' }).click();
  await scribble(page, 'annotation-canvas');
  await page.getByRole('button', { name: 'Save markup' }).click();
  await expect(page.getByRole('button', { name: 'Edit markup' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await scribble(page, 'signature-canvas');
  await page.getByRole('button', { name: 'Save signature' }).click();
  await expect(page.getByAltText('Signature')).toBeVisible();

  // Scanning works offline: the WebAssembly decoder is precached with the app.
  await page.getByTestId('scan-asset_tag').setInputFiles(QR);
  await expect(page.locator('[id="asset_tag"]')).toHaveValue('ASSET-00042', { timeout: 15_000 });
  await expect(page.getByTestId('autosave')).toHaveText('Draft saved on this phone');

  // Still offline: the app reopens and the draft is there with everything in it.
  await page.reload();
  await expect(page.getByText('You are offline')).toBeVisible();
  await expect(page.getByTestId('calc-order_total')).toHaveText('199.96');
  await page.getByRole('link', { name: 'Forms', exact: true }).click();
  await page.getByTestId('draft').getByRole('link', { name: 'Continue' }).click();
  await expect(page.getByLabel('Area inspected')).toHaveValue('kitchen');

  // A validation rule stops a follow-up date before the inspection.
  await page.getByTestId('form-submit').click();
  await expect(page.getByText('Must be on or after the inspection date')).toBeVisible();
  await page.getByLabel('Follow up by').fill('2026-10-14');
  await page.getByTestId('form-submit').click();

  await expect(page).toHaveURL(/\/outbox$/);
  await expect(page.getByTestId('outbox-item').first()).toHaveAttribute(
    'data-status',
    /pending|syncing/,
  );
  expect((await submissionsFor('Site inspection')).length).toBe(before);

  await context.setOffline(false);
  await expect(page.getByTestId('outbox-item').first()).toHaveAttribute('data-status', 'synced', {
    timeout: 20_000,
  });
  await page.getByTestId('sync-now').click();
  await page.waitForTimeout(1000);

  const rows = await submissionsFor('Site inspection');
  expect(rows.length).toBe(before + 1);
  const s = rows.at(-1)!;
  expect(s.data).toMatchObject({
    asset_tag: 'ASSET-00042',
    area: 'kitchen',
    order_total: 199.96,
    needs_followup: 'yes',
    followup_by: '2026-10-14',
  });
  expect(s.data.items[0]).toMatchObject({ item: 'Bleach', qty: 4, line_total: 199.96 });
  expect(s.data.fault_photo[0].annotationBlobId).toBeTruthy();
  expect(s.files).toBe(3); // photo, markup layer, signature
});

test('an admin builds, checks and publishes a form', async ({ page, request }) => {
  await signInOffice(page, 'admin@fieldforms.local', 'fieldforms-dev-admin');
  await page.goto('/admin/forms');
  await page.getByPlaceholder('New form name').fill('Vehicle check');
  await page.getByRole('button', { name: 'Create form' }).click();
  await expect(page.getByTestId('form-title')).toHaveValue('Vehicle check');

  await page.getByTestId('add-field').selectOption('number');
  await page.getByTestId('prop-label').fill('Odometer (km)');
  await page.getByTestId('prop-id').fill('odometer');
  await page.getByTestId('prop-required').selectOption('yes');

  await page.getByTestId('add-field').selectOption('calculated');
  await page.getByTestId('prop-label').fill('Distance this month');
  await page.getByTestId('prop-expression').fill('odometr - 1000');
  await expect(page.getByTestId('issue-count')).toContainText('1 problem');
  await expect(page.getByText('"odometr" is not a field in this form').first()).toBeVisible();
  await page.getByTestId('prop-expression').fill('odometer - 1000');
  await expect(page.getByTestId('issue-count')).toHaveText('Ready to publish');

  await page.getByRole('button', { name: 'Preview' }).click();
  await page.getByLabel('Odometer (km)').fill('1500');
  await expect(page.getByTestId('preview').getByText('500', { exact: true })).toBeVisible();

  await page.getByTestId('publish').click();
  await expect(page.getByText('Published as version 1')).toBeVisible();

  const forms = await (await page.context().request.get('/api/forms')).json();
  const vehicle = forms.find((f: { name: string }) => f.name === 'Vehicle check');
  expect(vehicle).toMatchObject({ version: 1 });
  expect(vehicle.definition.fields.map((f: { id: string }) => f.id)).toEqual([
    'notes',
    'odometer',
    'calc_1',
  ]);
  void request;
});

test('a manager sends a pre-filled task to a group; a member completes it', async ({ browser }) => {
  const managerCtx = await browser.newContext();
  const manager = await managerCtx.newPage();
  await signInOffice(manager, 'manager@fieldforms.local', 'fieldforms-dev-manager');
  await manager.getByRole('link', { name: 'Forms', exact: true }).click();
  await manager
    .getByTestId('form')
    .filter({ hasText: 'Site inspection' })
    .getByRole('link', { name: 'Send as task' })
    .click();
  await manager.getByLabel('Title').fill('Kitchen follow-up');
  await manager.getByTestId('assignee').selectOption({ label: 'Gauteng supervisors' });
  await manager.getByTestId('dispatch-site').selectOption({ label: 'Sandton City' });
  await manager.getByLabel('Area inspected').selectOption('kitchen');
  await manager.getByTestId('send-task').click();
  await expect(manager.getByText('Sent. It is now in their inbox.')).toBeVisible();

  const supCtx = await browser.newContext({
    geolocation: { latitude: -26.1077, longitude: 28.0568 },
    permissions: ['geolocation'],
  });
  const sup = await supCtx.newPage();
  await signInAsSupervisor(sup);
  await sup.getByRole('link', { name: 'Forms', exact: true }).click();
  const task = sup.getByTestId('task').filter({ hasText: 'Kitchen follow-up' });
  await expect(task).toBeVisible();
  await task.getByRole('button', { name: 'Start' }).click();
  await expect(sup.getByLabel('Area inspected')).toHaveValue('kitchen');
  await sup.getByLabel('Inspection date').fill('2026-10-07');
  await sup.getByRole('radio', { name: 'No' }).click();
  await sup.getByRole('button', { name: 'Sign', exact: true }).click();
  await scribble(sup, 'signature-canvas');
  await sup.getByRole('button', { name: 'Save signature' }).click();
  await sup.getByTestId('form-submit').click();
  await expect(sup.getByTestId('outbox-item').first()).toHaveAttribute('data-status', 'synced', {
    timeout: 20_000,
  });

  await manager.goto('/tasks');
  await manager.getByRole('combobox').selectOption('completed');
  await expect(manager.getByTestId('tasks').getByText('Kitchen follow-up')).toBeVisible();
  const rows = await submissionsFor('Site inspection');
  expect(rows.filter((r) => r.dispatch_id)).toHaveLength(1);
  await managerCtx.close();
  await supCtx.close();
});
