import { expect, type Page } from '@playwright/test';

export async function acceptConsentIfAsked(page: Page, ready: ReturnType<Page['getByTestId']>) {
  const accept = page.getByRole('button', { name: /I have read and accept/ });
  await expect(accept.or(ready)).toBeVisible();
  if (await accept.isVisible()) await accept.click();
}

export async function signInAsSupervisor(page: Page, employeeNo = 'S001') {
  await page.goto('/login');
  await page.getByLabel('Employee number').fill(employeeNo);
  await page.getByLabel('PIN').fill('482915');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await acceptConsentIfAsked(page, page.getByTestId('site'));
  await expect(page.getByTestId('site')).toBeVisible();
  await expect(page.locator('[data-testid^="row-"]').first()).toBeVisible();
}

export async function signInOffice(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Office' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await acceptConsentIfAsked(page, page.getByTestId('report'));
  await expect(page.getByTestId('report')).toBeVisible();
}

/** Waits until the service worker controls the page, so a reload works with no network. */
export async function waitForServiceWorker(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
    await page.reload();
  }
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

/** Draws a stroke across a canvas with the pointer. */
export async function scribble(page: Page, testId: string) {
  const box = (await page.getByTestId(testId).boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.7, { steps: 8 });
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.4, { steps: 8 });
  await page.mouse.up();
}
