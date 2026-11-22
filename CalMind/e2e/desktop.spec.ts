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

  // The other sections still host their quick-add field under the top bar.
  for (const tab of ['reminders', 'notes', 'habits']) {
    await page.getByTestId(`tab-${tab}`).click();
    await expect(page.getByTestId('quick-add')).toHaveCount(1);
    const bar = (await page.getByTestId('wide-main').getByTestId('suite-topbar').first().boundingBox())!;
    const add = (await page.getByTestId('quick-add').boundingBox())!;
    expect(add.y, `${tab}: quick add under the top bar`).toBeGreaterThan(bar.y + bar.height);
  }
  await page.getByTestId('tab-calendar').click();
  await expect(page.getByTestId('pick-calendar'), 'the picker is still drawn').toBeVisible();
  await expect(page.getByTestId('wide-rest').getByTestId('quick-add')).toBeVisible();
  await expect(page.getByTestId('wide-main').getByTestId('quick-add')).toHaveCount(0);

  // Quick-add files through the Add tab's parser; the line shows in its cell.
  await quickAddEvent(page, 'Dentist 2pm');
  await expect(page.getByTestId('wide-detail')).toHaveCount(0);

  // Clicking the item opens its editor in the detail pane — the phone's form.
  await page.getByTestId('cell-line').filter({ hasText: 'Dentist' }).first().click();
  const pane = page.getByTestId('wide-detail');
  await expect(pane).toBeVisible();
  await expect(pane.getByTestId('quick-add')).toBeVisible();
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

  // Switching section closes an open item (the editor belongs to the screen it
  // was opened from); Habits then keeps its in-screen editor in the main pane
  // and earns the whole week.
  await page.getByTestId('cell-line').filter({ hasText: 'Dentist checkup' }).first().click();
  await expect(pane).toBeVisible();
  await page.getByTestId('tab-habits').click();
  await expect(pane, 'switching section closes the pane').toHaveCount(0);
  await page.getByTestId('habit-add-Habits').first().click();
  await page.getByTestId('habit-name-field').fill('stretch');
  await page.getByTestId('habit-save').click();
  await expect.poll(() => page.getByTestId('habit-daycol').count()).toBe(7);

  // The capped habits grid and its control bar centre in the main pane as one
  // block: no dead strip on the right (the week grid ends at its last day
  // column), and the bar's content edges are the grid's. 900 is the narrowest
  // wide pane, where a classic scrollbar's gutter narrows the scroll but not
  // the bar (Habits.tsx scrollWide).
  {
    const m = (await page.getByTestId('wide-main').boundingBox())!;
    const grid = (await page.getByTestId('habits-pan').boundingBox())!;
    expect(grid.width, 'the grid is capped narrower than the pane').toBeLessThan(m.width - 100);
  }
  const misaligned = async (week: boolean) => {
    const m = (await page.getByTestId('wide-main').boundingBox())!;
    const grid = (await page.getByTestId('habits-pan').boundingBox())!;
    const bar = (await page.getByTestId('habits-controls').boundingBox())!;
    const gridR = grid.x + grid.width;
    const off: Record<string, number> = {
      centred: (grid.x - m.x) - (m.x + m.width - gridR),
      barLeft: bar.x + 16 - grid.x,
      barRight: bar.x + bar.width - 16 - gridR,
    };
    if (week) {
      const last = (await page.getByTestId('habit-daycol').last().boundingBox())!;
      off.lastDay = last.x + last.width - gridR;
    }
    return Object.entries(off).filter(([, v]) => Math.abs(v) > 2).map(([k, v]) => `${k} ${Math.round(v)}`);
  };
  for (const [vp, view] of [[WIDE, 'Week'], [NARROW_WIDE, 'Week'], [{ width: 900, height: 800 }, 'Week'], [WIDE, 'Month']] as const) {
    await page.setViewportSize(vp);
    await page.getByTestId('habits-controls').getByText(view, { exact: true }).click();
    await expect.poll(() => misaligned(view === 'Week'), `habits ${view} block at ${vp.width} px`).toEqual([]);
  }
  await page.getByTestId('habits-controls').getByText('Week', { exact: true }).click();

  // Every section opens wide without throwing; Reminders gets the full width.
  for (const tab of ['tab-notes', 'tab-reminders', 'tab-calendar']) {
    await page.getByTestId(tab).click();
    await page.waitForTimeout(250);
  }
  expect(errors, 'no page errors at desktop width').toEqual([]);
});

test('calendar quick add stays above the selected day and the scrolling upcoming section', async ({ page }) => {
  await page.setViewportSize({ ...WIDE, height: 480 });
  await signup(page);

  const pane = page.getByTestId('wide-rest');
  const addSection = pane.getByTestId('cal-pane-add');
  const add = addSection.getByTestId('quick-add');
  const selectedDay = pane.getByTestId('cal-pane-day');
  const upcoming = pane.getByTestId('cal-pane-upcoming');
  const agenda = upcoming.getByTestId('cal-up-scroll');
  for (let i = 1; i <= 12; i++) {
    await add.fill(`Appointment ${i} tomorrow at 2pm`);
    await add.press('Enter');
    await expect(add).toHaveValue('');
  }

  await expect(upcoming.getByRole('heading', { name: 'Coming up' })).toBeVisible();
  await expect(addSection).toHaveCSS('border-top-width', '1px');
  await expect(selectedDay).toHaveCSS('border-top-width', '1px');
  await expect(upcoming).toHaveCSS('border-top-width', '1px');
  const addBox = (await addSection.boundingBox())!;
  const dayBox = (await selectedDay.boundingBox())!;
  expect(dayBox.y).toBeGreaterThan(addBox.y + addBox.height);
  expect((await upcoming.boundingBox())!.y).toBeGreaterThan(dayBox.y + dayBox.height);

  await agenda.hover();
  await page.mouse.wheel(0, 250);
  await expect.poll(() => agenda.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await expect(add).toBeInViewport();
  expect((await addSection.boundingBox())!.y).toBe(addBox.y);

  for (const view of ['week', 'list', 'month']) {
    await page.getByTestId(`cal-view-${view}`).click();
    await expect(add).toBeVisible();
  }
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
