import { expect, test, type Page } from '@playwright/test';
import { dayLabel, periodStart } from '../packages/core/src/planner';
import { shiftDate } from '../packages/core/src/parse';
import { apiLogin, farDate, login, pickList, resetPrefs, today, type Api } from './helpers';
import { OWNER, OWNER_NAME } from './people';

// Back to the month. A tap on a day of the Month opens that day on the Day view with a "Back to month" button in the top bar (state.openDay);
// Back returns to the Month that holds the day the Day is on by then; choosing a view by hand forgets it. It runs on the desktop project
// (the button stands beside the sidebar toggle) and, in a phone-sized page of the same project, where it takes the place of the menu button.
// Nothing here is stored: the Month and the Day of a far-away March are empty, so no cleanup is needed.
const MARCH = '2041-03-17', LAST = '2041-03-31', FIRST = '2041-04-01';
const back = (page: Page) => page.locator('#back-view');
const monthPanel = (page: Page) => page.locator('.wm-panel[data-panel="month"]');
const selected = (page: Page) => page.locator('#sidebar .date-row.selected');
const toggle = (page: Page, name: 'Month' | 'Week' | 'Day') => page.locator(`#sidebar [data-view="${name.toLowerCase()}"]`);
const cell = (page: Page, date: string) => page.locator(`.wm-day[data-date="${date}"]`);
/** The date number of a cell: the button that opens its day (a click on the cell's middle could land on a chore chip of that day, which writes). */
const number = (page: Page, date: string) => cell(page, date).locator('.wm-day-num');

/** Opens the Month that holds `date` with the sidebar's toggle and the date field (a desktop). */
async function openMonth(page: Page, date: string) {
  await toggle(page, 'Month').click();
  await page.locator('#jump-date').fill(date);
  await expect(monthPanel(page)).toBeVisible();
  await expect(selected(page)).toHaveAttribute('data-date', periodStart(date, 'month'));
}
/** The Day is on screen for `date` (a desktop: the date field and the sidebar's selected row say which). */
async function expectDay(page: Page, date: string) {
  await expect(page.locator('.day-panel')).toBeVisible();
  await expect(monthPanel(page)).toHaveCount(0);
  await expect(selected(page)).toHaveAttribute('data-date', date);
  await expect(toggle(page, 'Day')).toHaveAttribute('aria-pressed', 'true');
}
/** The Month of `date` is on screen again: its panel, its first of the month selected, and no Back. */
async function expectMonth(page: Page, date: string) {
  await expect(monthPanel(page)).toBeVisible();
  await expect(page.locator('.day-panel')).toHaveCount(0);
  await expect(selected(page)).toHaveAttribute('data-date', periodStart(date, 'month'));
  await expect(toggle(page, 'Month')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mode-heading')).toHaveText('Monthly planner');
  await expect(back(page)).toBeHidden();
}

test.describe('Back to month, desktop', () => {
  test('a day of the Month opens on the Day with "Back to month" beside the sidebar button; Back returns to that Month, and the Back is gone', async ({ page }) => {
    await login(page);
    await openMonth(page, MARCH);
    // The Month itself has no Back, and no day is open.
    await expect(back(page)).toBeHidden();
    await number(page, MARCH).click();
    await expectDay(page, MARCH);
    await expect(page.locator('#jump-date')).toHaveValue(MARCH);
    await expect(back(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back to month', exact: true })).toBeVisible();
    await expect(page.locator('#back-label')).toHaveText('Month');
    // It is a real button with an icon, beside the sidebar button: left of it, on the same line, and nothing else stands between them.
    const [b, t] = [(await back(page).boundingBox())!, (await page.locator('#sidebar-toggle').boundingBox())!];
    expect(b.x + b.width).toBeLessThanOrEqual(t.x + 0.5);
    expect(Math.abs((b.y + b.height / 2) - (t.y + t.height / 2))).toBeLessThanOrEqual(4);
    await expect(back(page).locator('svg')).toHaveCount(1);
    await expect(page.locator('#sidebar-toggle')).toBeVisible();

    await back(page).click();
    await expectMonth(page, MARCH);
    // The Back that had the focus is gone: a desktop draws no date pill, so the sidebar toggle takes the focus.
    await expect(page.locator('#sidebar-toggle')).toBeFocused();
    await expect(page.locator('#jump-date')).toHaveValue(periodStart(MARCH, 'month'));
    // Another trip shows the Back again, and it is not stuck: a second Back from the Month does not exist.
    await number(page, '2041-03-05').click();
    await expectDay(page, '2041-03-05');
    await expect(back(page)).toBeVisible();
    await back(page).click();
    await expectMonth(page, MARCH);
  });

  test('stepping to the next or the previous day first, then Back, returns to the Month of THAT day when it is in another month', async ({ page }) => {
    await login(page);
    await openMonth(page, LAST);
    await number(page, LAST).click();
    await expectDay(page, LAST);
    await page.locator('#next-day').click();
    await expectDay(page, FIRST);
    // Stepping is not choosing a view: the Back is still there, and it still says Month.
    await expect(back(page)).toBeVisible();
    await expect(back(page)).toHaveAttribute('aria-label', 'Back to month');
    await back(page).click();
    await expectMonth(page, FIRST);
    await expect(selected(page)).toHaveAttribute('data-date', '2041-04-01');

    // And the other way: the first of a month, one day back, is the month before.
    await number(page, FIRST).click();
    await expectDay(page, FIRST);
    await page.locator('#prev-day').click();
    await expectDay(page, LAST);
    await back(page).click();
    await expectMonth(page, LAST);
    await expect(selected(page)).toHaveAttribute('data-date', '2041-03-01');

    // Stepping within the month, and the date field, are the same: the month is the one the Day is on.
    await number(page, MARCH).click();
    await page.locator('#next-day').click();
    await page.locator('#next-day').click();
    await expectDay(page, '2041-03-19');
    await page.locator('#jump-date').fill('2041-05-09');
    await expectDay(page, '2041-05-09');
    await expect(back(page)).toBeVisible();
    await back(page).click();
    await expectMonth(page, '2041-05-09');
    await expect(selected(page)).toHaveAttribute('data-date', '2041-05-01');
  });

  test('a day of the neighbouring month shown in the grid returns to its own month', async ({ page }) => {
    await login(page);
    await openMonth(page, MARCH);
    // 27 February is in the first row of March 2041's grid, muted ("out").
    const feb = cell(page, '2041-02-27');
    await expect(feb).toHaveClass(/out/);
    await expect(feb).toBeVisible();
    await feb.locator('.wm-day-num').click();
    await expectDay(page, '2041-02-27');
    await back(page).click();
    await expectMonth(page, '2041-02-27');
    await expect(selected(page)).toHaveAttribute('data-date', '2041-02-01');
  });

  test('choosing Month, Week or Day with the sidebar toggle hides the Back', async ({ page }) => {
    await login(page);
    for (const choice of ['Month', 'Week', 'Day'] as const) {
      await openMonth(page, MARCH);
      await number(page, MARCH).click();
      await expectDay(page, MARCH);
      await expect(back(page)).toBeVisible();
      await toggle(page, choice).click();
      await expect(toggle(page, choice)).toHaveAttribute('aria-pressed', 'true');
      await expect(back(page), `after choosing ${choice}`).toBeHidden();
      if (choice === 'Day') {
        // The same Day, now reached by hand: it stays where it was, without the way back.
        await expectDay(page, MARCH);
      } else {
        await expect(page.locator(`.wm-panel[data-panel="${choice.toLowerCase()}"]`)).toBeVisible();
      }
    }
    // Coming back to the Day by hand after a Month, and a Month -> Day -> Month round trip, never brings the Back back.
    await openMonth(page, MARCH);
    await toggle(page, 'Day').click();
    await expect(page.locator('.day-panel')).toBeVisible();
    await expect(back(page)).toBeHidden();
  });

  test('a Day reached any other way has no Back: a fresh sign-in, the sidebar day list, the Today button, the date field and the arrows', async ({ page }) => {
    await login(page);
    await expect(page.locator('.day-panel')).toBeVisible();
    await expect(back(page)).toBeHidden();
    // A day of the sidebar list (the last row is not the selected one).
    const last = selected(page).locator('xpath=following-sibling::button[last()]');
    const lastDate = (await last.getAttribute('data-date'))!;
    await last.click();
    await expectDay(page, lastDate);
    await expect(back(page)).toBeHidden();
    await page.locator('#today').click();
    await expectDay(page, today());
    await expect(back(page)).toBeHidden();
    await page.locator('#jump-date').fill(farDate(900));
    await expectDay(page, farDate(900));
    await page.locator('#next-day').click();
    await expectDay(page, shiftDate(farDate(900), 1, 'day'));
    await expect(back(page)).toBeHidden();
    // A Month reached by hand and left by the toggle is the same.
    await openMonth(page, farDate(900));
    await expect(back(page)).toBeHidden();
    await toggle(page, 'Day').click();
    await expect(page.locator('.day-panel')).toBeVisible();
    await expect(back(page)).toBeHidden();
  });

  test('the date list is a list of days for the Day opened from the Month, and the Week chosen from there has no Back', async ({ page }) => {
    await login(page);
    await openMonth(page, MARCH);
    await number(page, MARCH).click();
    await expectDay(page, MARCH);
    // The date list is a list of days again, centred on the day that was opened.
    await expect(page.locator('#dates-heading')).toHaveText('Your days');
    await expect(selected(page).locator('.date-number')).toHaveText('17');
    await toggle(page, 'Week').click();
    await expect(page.locator('.wm-panel[data-panel="week"]')).toBeVisible();
    await expect(back(page)).toBeHidden();
    await expect(selected(page)).toHaveAttribute('data-date', periodStart(MARCH, 'week'));
  });
});

// The same page at the size of a phone (the phone project does not run this file). The Back takes the place of the menu button.
test.describe('Back to month, in a phone-sized page', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  /** A phone's way to a Month: the drawer's toggle, then the date field behind the pill. */
  async function openPhoneMonth(page: Page, date: string) {
    await page.getByRole('button', { name: 'Open menu', exact: true }).tap();
    await toggle(page, 'Month').tap();
    await page.keyboard.press('Escape');
    await page.locator('#pill-date').fill(date);
    await expect(monthPanel(page)).toBeVisible();
    await expect(selected(page)).toHaveAttribute('data-date', periodStart(date, 'month'));
  }
  const pill = (date: string) => dayLabel(date, { weekday: 'short', month: 'short', day: 'numeric' });

  test('#menu stays at the left of the bar while Back is shown (the menu holds the Day\'s AM/PM and CalMind choices), Back stands right after it, finger-sized; Back returns to the Month', async ({ page }) => {
    await login(page);
    await expect(page.locator('#menu')).toBeVisible();
    const menuBox = (await page.locator('#menu').boundingBox())!;
    await expect(back(page)).toBeHidden();
    await openPhoneMonth(page, MARCH);
    await expect(page.locator('#menu')).toBeVisible();
    await expect(back(page)).toBeHidden();
    await expect(page.locator('#date-pill')).toHaveText('March 2041');

    await cell(page, MARCH).tap();
    await expect(page.locator('.day-panel')).toBeVisible();
    await expect(page.locator('#date-pill')).toHaveText(pill(MARCH));
    await expect(back(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back to month', exact: true })).toBeVisible();
    await expect(page.locator('#back-label')).toHaveText('Month');
    await expect(page.locator('#menu')).toBeVisible();
    await expect(page.locator('header.topbar')).toHaveAttribute('data-back', '');
    // The menu has not moved, Back stands right after it and is as tall as a finger needs; the date pill and the arrows are still on screen.
    const b = (await back(page).boundingBox())!, m = (await page.locator('#menu').boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(43.5);
    expect(Math.abs(m.x - menuBox.x)).toBeLessThanOrEqual(8);
    expect(m.width).toBeGreaterThanOrEqual(39.5);
    expect(m.x + m.width).toBeLessThanOrEqual(b.x + 0.5);
    const prev = (await page.locator('#pill-prev').boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(prev.x + 0.5);
    await expect(page.locator('#date-pill')).toBeInViewport();
    await expect(page.locator('#pill-next')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);

    await back(page).tap();
    await expect(monthPanel(page)).toBeVisible();
    await expect(page.locator('#date-pill')).toHaveText('March 2041');
    await expect(back(page)).toBeHidden();
    // The Back that had the focus is gone: the date pill takes the focus.
    await expect(page.locator('#date-pill')).toBeFocused();
    await expect(page.locator('#menu')).toBeVisible();
    await expect(page.locator('header.topbar')).not.toHaveAttribute('data-back', '');
    // The menu works again.
    await page.locator('#menu').tap();
    await expect(page.locator('#sidebar')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#sidebar')).toBeHidden();
  });

  test('the arrows keep the Back, and Back goes to the Month of the day the Day is on then', async ({ page }) => {
    await login(page);
    await openPhoneMonth(page, LAST);
    await cell(page, LAST).tap();
    await expect(page.locator('#date-pill')).toHaveText(pill(LAST));
    await page.locator('#pill-next').tap();
    await expect(page.locator('#date-pill')).toHaveText(pill(FIRST));
    await expect(back(page)).toBeVisible();
    await expect(page.locator('#menu')).toBeVisible();
    await back(page).tap();
    await expect(monthPanel(page)).toBeVisible();
    await expect(page.locator('#date-pill')).toHaveText('April 2041');
    await expect(selected(page)).toHaveAttribute('data-date', '2041-04-01');
    await expect(page.locator('#menu')).toBeVisible();
  });

  test('a Day reached by hand has the menu and no Back; the drawer\'s toggle forgets a Back that is on', async ({ page }) => {
    await login(page);
    await expect(page.locator('#menu')).toBeVisible();
    await expect(back(page)).toBeHidden();
    await page.locator('#pill-date').fill(farDate(901));
    await expect(selected(page)).toHaveAttribute('data-date', farDate(901));
    await expect(back(page)).toBeHidden();
    await expect(page.locator('#menu')).toBeVisible();
    await openPhoneMonth(page, MARCH);
    await cell(page, MARCH).tap();
    await expect(back(page)).toBeVisible();
    // The menu button stays while Back is on, so the drawer is one tap away; choosing a view in it forgets the Back.
    await expect(page.locator('#menu')).toBeVisible();
    await page.locator('#menu').tap();
    await expect(page.locator('#sidebar')).toBeVisible();
    await toggle(page, 'Day').tap();
    await expect(back(page)).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator('#menu')).toBeVisible();
    await expect(page.locator('.day-panel')).toBeVisible();
  });
});

// The desktop's AM and PM switch (see day-half.spec.ts) opens on AM, the day as it always was: 7a to 9p is on the page, and an entry
// across noon is whole (the page ends at 9p, not at noon). This is the short check that a day opened from the Month is on AM too.
test.describe('the schedule on a desktop: AM is the 7a to 9p day', () => {
  let owner: Api;
  const date = farDate(902);
  test.beforeEach(async ({ baseURL }) => { owner = await apiLogin(baseURL!, OWNER); });
  test.afterEach(async ({ baseURL }) => {
    const snapshot = await owner.snapshot();
    for (const item of snapshot.events.filter((e: { date: string }) => e.date === date)) { await owner.post({ action: 'delete', id: item.id, revision: item.revision, confirm: true }); }
    await owner.dispose();
    await resetPrefs(baseURL!);
  });

  test('AM is the day 7a to 8p, and an entry across noon has both edges and both handles', async ({ page }) => {
    const id = crypto.randomUUID();
    const response = await owner.post({ action: 'add', kind: 'event', id, date, owners: [OWNER], text: 'Brunch', start: 690, length: 60 });
    expect(response.status(), JSON.stringify(await response.json())).toBe(200);
    await login(page);
    await pickList(page, OWNER_NAME);
    await page.locator('#jump-date').fill(date);
    await expect(selected(page)).toHaveAttribute('data-date', date);
    await expect(page.locator('.day-half button[data-half=am]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.day-sched')).toHaveAttribute('data-half', 'am');
    await expect(page.locator('.day-hours span')).toHaveText(['7a', '8a', '9a', '10a', '11a', '12p', '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p']);
    await expect(page.locator('.day-lanes')).toHaveAttribute('data-from', '420');
    await expect(page.locator('.day-lanes')).toHaveAttribute('data-to', '1260');
    await expect(page.locator('.day-lanes')).toHaveAttribute('data-span', '840');
    const block = page.getByRole('button', { name: `Brunch, 11:30a to 12:30p, ${OWNER_NAME}`, exact: true });
    await expect(block).toBeVisible();
    expect(await block.getAttribute('data-clip')).toBe('');
    await block.click();
    await expect(page.locator('.day-ev.day-editing')).toHaveCount(1);
    await expect(page.locator('.day-handle[data-edge=start]')).toBeVisible();
    await expect(page.locator('.day-handle[data-edge=end]')).toBeVisible();
  });
});
