import { expect, test, type Page } from '@playwright/test';

/**
 * A note too long to save can be SPLIT, not only shortened by hand (#75).
 *
 * toolong.spec.ts proves the refusal is said out loud; this proves the way out
 * from both places it is offered — the Settings line that names the note, and
 * the editor of the note itself — and that afterwards everything is saved: the
 * parts are in the list, titled (1/2) and (2/2), and the app is synced again.
 */
const PARA = 'All happy families are alike; each unhappy family is unhappy in its own way. ';
// ~78KB in paragraphs: over the 64KB a record may carry, under two parts' worth.
const BODY = Array.from({ length: 100 }, (_, i) => `${i} ${PARA.repeat(10)}`).join('\n\n');

async function writeLongNote(page: Page, title: string) {
  const user = `split${Date.now()}`;
  await page.goto('.');
  await page.getByText('Sign up', { exact: true }).click();
  await page.getByPlaceholder('Username').fill(user);
  await page.getByPlaceholder('Email').fill(user + '@example.com');
  await page.getByPlaceholder('Password', { exact: true }).fill('e2epassword');
  await page.getByPlaceholder('Confirm password').fill('e2epassword');
  await page.getByText('Sign up', { exact: true }).click();
  await expect(page.getByTestId('tab-reminders')).toBeVisible({ timeout: 20_000 });

  await page.getByTestId('tab-notes').click();
  await page.getByTestId('secadd-General').first().click();
  await page.getByTestId('note-title').fill(title);
  await page.getByTestId('note-body-view').click();
  await page.getByTestId('note-body-edit').fill(BODY);
}

async function expectSynced(page: Page) {
  await page.getByTestId('topbar-sync').click();
  await page.getByText('Settings', { exact: true }).click();
  await expect(page.getByText('Online — synced'), 'both parts were accepted').toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/too long to save/)).toHaveCount(0);
}

test('split from Settings: the refused note becomes two that both sync', async ({ page }) => {
  test.setTimeout(120_000);
  await writeLongNote(page, 'Anna Karenina');
  await page.getByTestId('note-back').click();
  await page.waitForTimeout(3_000);

  await page.getByTestId('topbar-sync').click();
  await page.getByText('Settings', { exact: true }).click();
  await expect(page.getByText(/too long to save/)).toBeVisible({ timeout: 20_000 });
  const split = page.getByTestId('split-refused-note');
  await expect(split).toContainText('2 notes');
  await split.click();
  await expect(page.getByText('Split into 2 notes.', { exact: true })).toBeVisible();
  await expect(page.getByText('Online — synced'), 'the refusal clears once the parts sync').toBeVisible({ timeout: 20_000 });
});

test('split from the editor: says how far over, splits, and the list holds both parts', async ({ page }) => {
  test.setTimeout(120_000);
  await writeLongNote(page, 'Anna Karenina');
  // Stay in the editor: the refusal arrives with the next sync, and the
  // editor says so where the note is.
  const banner = page.getByTestId('note-toolong');
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await expect(banner).toContainText(/Too long to sync — \d+ KB/);
  await page.getByTestId('note-split').click();

  await expect(page.getByText('Anna Karenina (1/2)')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Anna Karenina (2/2)')).toBeVisible();
  await expectSynced(page);
});
