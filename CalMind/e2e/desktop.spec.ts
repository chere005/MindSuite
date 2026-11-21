import { expect, test, type Page } from '@playwright/test';

/**
 * The app at DESKTOP width.
 *
 * Every other spec runs at 420×900, so the only width the suite used to see was
 * a phone's — while the Tauri shell ships a window at 1280×820 around this
 * exact bundle, and the owner uses the site in a browser. From 900 px the app
 * is the wide layout: a sidebar, the section's own screen at full width, and a
 * detail pane that holds the item editor (the phone's modal form, inline).
 * Below 900 it is the phone column and tab bar, unchanged.
 *
 * This is about SHAPE, not pixels: what is on screen, what a click opens, what
 * closes it, and that nothing overflows sideways.
 */
const WIDE = { width: 1280, height: 820 };
const NARROW_WIDE = { width: 1000, height: 800 };
const PHONE = { width: 420, height: 900 };

let seq = 0;
async function signup(page: Page): Promise<string> {
  const user = `desk${Date.now()}${seq++}`;
  await page.goto('.');
  await page.getByText('Sign up', { exact: true }).click();
  await page.getByPlaceholder('Username').fill(user);
  await page.getByPlaceholder('Email').fill(user + '@example.com');
  await page.getByPlaceholder('Password', { exact: true }).fill('e2epassword');
  await page.getByPlaceholder('Confirm password').fill('e2epassword');
  await page.getByText('Sign up', { exact: true }).click();
  // The sidebar's section items carry the tab bar's test ids.
  await expect(page.getByTestId('tab-reminders')).toBeVisible({ timeout: 10_000 });
  return user;
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** An event for today, filed through the wide layout's own quick-add field. */
async function quickAddEvent(page: Page, line: string) {
  await page.getByTestId('quick-kind-event').click();
  await page.getByTestId('quick-add').fill(line);
  await page.getByTestId('quick-add').press('Enter');
  await expect(page.getByTestId('cell-line').filter({ hasText: line.split(' ')[0]! }).first()).toBeVisible({ timeout: 10_000 });
}

test('at 1280×820 the sidebar and a detail pane with the edit form', async ({ page }) => {
  await page.setViewportSize(WIDE);
  await signup(page);

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // A sidebar, not a tab bar and not a 640px column.
  await expect(page.getByTestId('wide-sidebar')).toBeVisible();
  await expect(page.getByTestId('tab-add'), 'Add is not a section on wide').toHaveCount(0);
  const main = (await page.getByTestId('wide-main').boundingBox())!;
  const grid = (await page.getByTestId('cal-grid').boundingBox())!;
  expect(grid.width, 'the month grid fills the main pane').toBeGreaterThan(main.width - 40);
  expect(await overflow(page), 'no sideways scroll at desktop width').toBeLessThanOrEqual(0);
  await expect(page.getByTestId('pick-calendar'), 'the picker is still drawn').toBeVisible();

  // Quick-add files through the Add tab's parser; the line shows in its cell.
  await quickAddEvent(page, 'Dentist 2pm');
  await expect(page.getByTestId('wide-detail')).toHaveCount(0);

  // Clicking the item opens its editor in the detail pane — the phone's form.
  await page.getByTestId('cell-line').filter({ hasText: 'Dentist' }).first().click();
  const pane = page.getByTestId('wide-detail');
  await expect(pane).toBeVisible();
  await expect(pane.getByPlaceholder(/What\?/)).toHaveValue('Dentist');
  await expect(pane.getByTestId('item-date')).toBeVisible();
  await expect(pane.getByTestId('item-dest')).toBeVisible();
  await expect(pane.getByText('Save', { exact: true })).toBeVisible();
  await expect(pane.getByText('Cancel', { exact: true })).toBeVisible();
  await expect(pane.getByText('Delete', { exact: true })).toBeVisible();
  // Nothing stretched: the text field is a normal field inside a 380px pane.
  const paneBox = (await pane.boundingBox())!;
  expect(paneBox.width).toBeLessThanOrEqual(400);
  const field = (await pane.getByPlaceholder(/What\?/).boundingBox())!;
  expect(field.height, 'a normal-size text field').toBeLessThanOrEqual(48);
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  // Save closes it; Esc closes it; the edit landed.
  await pane.getByPlaceholder(/What\?/).fill('Dentist checkup');
  await pane.getByText('Save', { exact: true }).click();
  await expect(pane).toHaveCount(0);
  await expect(page.getByTestId('cell-line').filter({ hasText: 'Dentist checkup' }).first()).toBeVisible();
  await page.getByTestId('cell-line').filter({ hasText: 'Dentist checkup' }).first().click();
  await expect(pane).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);

  // Habits keeps its in-screen editor in the main pane, and earns the whole week.
  await page.getByTestId('tab-habits').click();
  await expect(pane).toHaveCount(0);
  await page.getByTestId('habit-add-Habits').first().click();
  await page.getByTestId('habit-name-field').fill('stretch');
  await page.getByTestId('habit-save').click();
  await expect.poll(() => page.getByTestId('habit-daycol').count()).toBe(7);

  // Every section opens wide without throwing; Reminders gets the full width.
  for (const tab of ['tab-notes', 'tab-reminders', 'tab-calendar']) {
    await page.getByTestId(tab).click();
    await page.waitForTimeout(250);
  }
  expect(errors, 'no page errors at desktop width').toEqual([]);
});

test('at 1000×800 the detail pane opens over the main pane and the backdrop closes it', async ({ page }) => {
  await page.setViewportSize(NARROW_WIDE);
  await signup(page);
  await expect(page.getByTestId('wide-sidebar')).toBeVisible();
  await quickAddEvent(page, 'Haircut 3pm');

  await page.getByTestId('cell-line').filter({ hasText: 'Haircut' }).first().click();
  const pane = page.getByTestId('wide-detail');
  await expect(pane).toBeVisible();
  await expect(pane.getByPlaceholder(/What\?/)).toHaveValue('Haircut');
  // Over, not beside: the main pane keeps its full width underneath.
  const main = (await page.getByTestId('wide-main').boundingBox())!;
  const paneBox = (await pane.boundingBox())!;
  expect(paneBox.x + paneBox.width).toBeGreaterThanOrEqual(NARROW_WIDE.width - 2);
  expect(main.x + main.width, 'the pane overlays the main pane').toBeGreaterThanOrEqual(paneBox.x + paneBox.width - 2);
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  // The backdrop (the dimmed main pane, left of the pane) closes it.
  await page.mouse.click(main.x + 40, main.y + main.height / 2);
  await expect(pane).toHaveCount(0);
});

test('at 420 wide the phone column and the tab bar are still there', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await signup(page);
  await expect(page.getByTestId('tab-add')).toBeVisible();
  await expect(page.getByTestId('wide-sidebar')).toHaveCount(0);
  await expect(page.getByTestId('quick-add')).toHaveCount(0);
  const grid = (await page.getByTestId('cal-grid').boundingBox())!;
  expect(grid.width, 'the calendar is the phone column').toBeLessThanOrEqual(PHONE.width);
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  // Crossing 900 px swaps the frames live, with no reload.
  await page.setViewportSize(WIDE);
  await expect(page.getByTestId('wide-sidebar')).toBeVisible();
  await expect(page.getByTestId('tab-add')).toHaveCount(0);
  await page.setViewportSize(PHONE);
  await expect(page.getByTestId('tab-add')).toBeVisible();
});
