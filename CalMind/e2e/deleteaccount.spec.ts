/**
 * Delete account — reachable in the app, guarded, offers a copy first, and
 * really gone afterwards (#81; App Store 5.1.1(v) wants deletion IN the app).
 *
 * The server half (every file and log line the account touched) is
 * server/tools/test.php's; this proves the path a person walks: Settings →
 * Delete account → the confirmation names what goes and offers the export →
 * the button stays dead until the username is typed → the app returns to
 * sign-in → the same login no longer works.
 */
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { API } from './port';

test('delete account: offered a copy, guarded by the username, and the login is gone', async ({ page }) => {
  test.setTimeout(120_000);
  const user = `del${Date.now()}`;
  await page.goto('.');
  await page.getByText('Sign up', { exact: true }).click();
  await page.getByPlaceholder('Username').fill(user);
  await page.getByPlaceholder('Email').fill(`${user}@example.com`);
  await page.getByPlaceholder('Password', { exact: true }).fill('e2epassword');
  await page.getByPlaceholder('Confirm password').fill('e2epassword');
  await page.getByText('Sign up', { exact: true }).click();
  await expect(page.getByTestId('tab-reminders')).toBeVisible({ timeout: 20_000 });

  await page.getByTestId('tab-reminders').click();
  await page.getByTestId('secadd-General').first().click();
  await page.getByTestId('rem-add-field').fill('something worth keeping');
  await page.getByTestId('rem-add-field').press('Enter');
  await expect(page.getByTestId('rem-row').filter({ hasText: 'something worth keeping' })).toBeVisible();

  await page.getByTestId('topbar-sync').click();
  await page.getByText('Settings', { exact: true }).click();
  await page.getByTestId('delete-account-start').click();
  const box = page.getByTestId('delete-account-confirm');
  await expect(box).toContainText('cannot be undone');
  await expect(box).toContainText('ChefMind');

  // The copy, offered right where it matters.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('delete-account-export').click(),
  ]);
  const file = JSON.parse(await readFile(await download.path(), 'utf8')) as {
    account: string; records: { type: string; payload: { text?: string } }[];
  };
  expect(file.account).toBe(user);
  expect(file.records.some((r) => r.type === 'reminder' && r.payload.text === 'something worth keeping')).toBe(true);

  // Dead until the username is typed exactly.
  const confirm = page.getByTestId('delete-account-confirm-button');
  await page.getByTestId('delete-account-username').fill(user + 'x');
  await confirm.click({ force: true, timeout: 1_500 }).catch(() => {});
  await expect(box, 'a wrong username deletes nothing').toBeVisible();
  await page.getByTestId('delete-account-username').fill(user);
  await confirm.click();

  // Back at sign-in, and the same login is refused.
  await expect(page.getByText('Sign up', { exact: true })).toBeVisible({ timeout: 20_000 });
  const res = await page.request.post(API, {
    data: { action: 'login', username: user, password: 'e2epassword' },
    failOnStatusCode: false,
  });
  expect(res.status(), 'the account no longer exists').not.toBe(200);
});
