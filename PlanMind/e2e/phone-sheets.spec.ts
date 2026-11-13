import { test, expect, type Page } from '@playwright/test';
import { dayLabel, periodStart, shiftPeriod } from '../packages/core/src/planner';
import { MIN_CONTRAST } from '../packages/core/src/planner';
import { weekRange } from '../app/dates';
import { THEMES, type ThemeName } from '../app/theme';
import { apiLogin, browserStorage, hitSizes, login, showHalf, showTheme, textContrast, today } from './helpers';
import { OWNER, OWNER_NAME } from './people';

// Phone project only (the file name says phone), all of it in the real app against the real server:
// 1. The date sheet: the date in the top bar opens a calendar (Day), a week list (Week) or a month grid (Month).
// 2. The phone tab bars the panels draw themselves: Schedule, To-do, Notes, Chores on Day; Priorities, To-do, Chores on Week; Calendar,
//    Priorities, To-do, Notes, Chores on Month.
const monthTitle = (date: string) => dayLabel(date, { month: 'long', year: 'numeric' });
const pillDay = (date: string) => dayLabel(date, { weekday: 'short', month: 'short', day: 'numeric' });
const pill = (page: Page) => page.locator('#date-pill');
const sheetOf = (page: Page, name: string) => page.getByRole('dialog', { name, exact: true });
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
async function switchView(page: Page, view: 'Day' | 'Week' | 'Month') {
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await page.getByRole('button', { name: view, exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/drawer-open/);
}

test.describe('date sheet in the app', () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test('Day: a calendar of the open month; stepping only browses, picking opens that day and closes the sheet', async ({ page }) => {
    const now = today(), month = periodStart(now, 'month');
    await pill(page).click();
    const sheet = sheetOf(page, 'Choose a day');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.sheet-title')).toHaveText(monthTitle(now));
    // The open day is marked, and so is today's name.
    await expect(sheet.locator(`[data-date="${now}"]`)).toHaveAttribute('aria-current', 'date');
    await expect(sheet.locator(`[data-date="${now}"]`)).toHaveAttribute('aria-label', /, Today$/);
    // One-letter weekday heads, Monday first, as the wireframe's calendar draws them.
    expect((await sheet.locator('.ds-weekday').allTextContents()).join('')).toBe('MTWTFSS');
    // Browsing a month does not move the page.
    await sheet.getByRole('button', { name: 'Next month', exact: true }).click();
    const next = shiftPeriod(month, 1, 'month');
    await expect(sheet.locator('.sheet-title')).toHaveText(monthTitle(next));
    await expect(pill(page)).toHaveText(pillDay(now));
    // The open day is marked wherever the grid shows it (it can be a trailing day of this month), and nowhere else.
    await expect(sheet.locator(`[aria-current=date]:not([data-date="${now}"])`)).toHaveCount(0);
    const pick = `${next.slice(0, 7)}-15`;
    await sheet.locator(`[data-date="${pick}"]`).click();
    await expect(sheet).toBeHidden();
    await expect(pill(page)).toHaveText(pillDay(pick));
    // The sheet opens on the day now open, and Today brings the page back.
    await pill(page).click();
    await expect(sheet.locator('.sheet-title')).toHaveText(monthTitle(pick));
    await expect(sheet.locator(`[data-date="${pick}"]`)).toHaveAttribute('aria-current', 'date');
    await sheet.getByRole('button', { name: 'Today', exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(pill(page)).toHaveText(pillDay(now));
  });

  test('Day: Close, Escape and a tap on the page behind all close it, and focus goes back to the date', async ({ page }) => {
    const sheet = sheetOf(page, 'Choose a day');
    for (const close of [() => sheet.getByRole('button', { name: 'Close', exact: true }).click(), () => page.keyboard.press('Escape'), () => page.mouse.click(180, 40)]) {
      await pill(page).click();
      await expect(sheet).toBeVisible();
      await close();
      await expect(sheet).toBeHidden();
      await expect(pill(page)).toBeFocused();
      await expect(pill(page)).toHaveText(pillDay(today()));
    }
    await pill(page).click();
    await expect(sheet.locator('.sheet-body')).toBeVisible();
    // A tap inside the sheet that picks nothing leaves it open.
    await sheet.locator('.sheet-title').click();
    await expect(sheet).toBeVisible();
  });

  test('Day: arrow keys move between days, PageUp changes month, Enter picks', async ({ page }) => {
    const now = today(), sheet = sheetOf(page, 'Choose a day');
    await pill(page).click();
    const focused = () => sheet.locator('[data-date]:focus');
    await expect(focused()).toHaveAttribute('data-date', now);
    await page.keyboard.press('ArrowRight');
    await expect(focused()).toHaveAttribute('data-date', shiftPeriod(now, 1, 'day'));
    await page.keyboard.press('ArrowDown');
    await expect(focused()).toHaveAttribute('data-date', shiftPeriod(now, 8, 'day'));
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowUp');
    await expect(focused()).toHaveAttribute('data-date', now);
    // Past the last row of the month the sheet browses to the next one.
    for (let i = 0; i < 6; i++) { await page.keyboard.press('ArrowDown'); }
    const later = shiftPeriod(now, 42, 'day');
    await expect(focused()).toHaveAttribute('data-date', later);
    await expect(sheet.locator('.sheet-title')).toHaveText(monthTitle(later));
    await page.keyboard.press('PageUp');
    const back = shiftPeriod(later, -1, 'month');
    await expect(focused()).toHaveAttribute('data-date', back);
    await page.keyboard.press('Enter');
    await expect(sheet).toBeHidden();
    await expect(pill(page)).toHaveText(pillDay(back));
  });

  test('Week: Monday-to-Sunday rows around the open week, the arrows move five weeks, a pick opens that week', async ({ page }) => {
    await switchView(page, 'Week');
    const monday = periodStart(today(), 'week'), sheet = sheetOf(page, 'Choose a week');
    await expect(pill(page)).toHaveText(weekRange(monday));
    await pill(page).click();
    const rows = sheet.locator('.ds-week');
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(2)).toHaveAttribute('data-date', monday);
    await expect(rows.nth(2)).toHaveAttribute('aria-current', 'date');
    await expect(rows.nth(2)).toContainText('This week');
    await expect(rows.nth(2)).toHaveAttribute('aria-label', `${weekRange(monday)}, ${monday.slice(0, 4)}, Monday to Sunday, This week`);
    await expect(rows.nth(0)).toHaveAttribute('data-date', shiftPeriod(monday, -2, 'week'));
    await sheet.getByRole('button', { name: 'Later weeks', exact: true }).click();
    await expect(rows.nth(2)).toHaveAttribute('data-date', shiftPeriod(monday, 5, 'week'));
    await expect(sheet.locator('[aria-current=date]')).toHaveCount(0);
    const pick = shiftPeriod(monday, 6, 'week');
    await rows.nth(3).click();
    await expect(sheet).toBeHidden();
    await expect(pill(page)).toHaveText(weekRange(pick));
    await expect(page.locator('.date-row.selected')).toHaveAttribute('data-date', pick);
    await pill(page).click();
    await expect(rows.nth(2)).toHaveAttribute('data-date', pick);
    await sheet.getByRole('button', { name: 'This week', exact: true }).click();
    await expect(pill(page)).toHaveText(weekRange(monday));
    // Arrow keys walk the rows and the list follows past its end.
    await pill(page).click();
    await expect(rows.nth(2)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(sheet.locator('[data-date]:focus')).toHaveAttribute('data-date', shiftPeriod(monday, 3, 'week'));
    await expect(rows.nth(4)).toHaveAttribute('data-date', shiftPeriod(monday, 3, 'week'));
  });

  test('Month: twelve months of a year, the arrows change the year, a pick opens that month', async ({ page }) => {
    await switchView(page, 'Month');
    const first = periodStart(today(), 'month'), year = Number(first.slice(0, 4)), sheet = sheetOf(page, 'Choose a month');
    await expect(pill(page)).toHaveText(monthTitle(first));
    await pill(page).click();
    await expect(sheet.locator('.sheet-title')).toHaveText(String(year));
    await expect(sheet.locator('.ds-month')).toHaveText(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
    await expect(sheet.locator(`[data-date="${first}"]`)).toHaveAttribute('aria-current', 'date');
    await sheet.getByRole('button', { name: 'Next year', exact: true }).click();
    await expect(sheet.locator('.sheet-title')).toHaveText(String(year + 1));
    await expect(pill(page)).toHaveText(monthTitle(first));
    await sheet.locator('.ds-month').nth(2).click();
    await expect(sheet).toBeHidden();
    await expect(pill(page)).toHaveText(monthTitle(`${year + 1}-03-01`));
    await pill(page).click();
    await expect(sheet.locator(`[data-date="${year + 1}-03-01"]`)).toHaveAttribute('aria-current', 'date');
    await sheet.getByRole('button', { name: 'This month', exact: true }).click();
    await expect(pill(page)).toHaveText(monthTitle(first));
  });

  test('every sheet fits the smallest phone, sits on the bottom edge and uses no inline styles', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    for (const [view, name] of [['Day', 'Choose a day'], ['Week', 'Choose a week'], ['Month', 'Choose a month']] as const) {
      await switchView(page, view);
      await pill(page).click();
      const sheet = sheetOf(page, name);
      await expect(sheet).toBeVisible();
      const box = (await sheet.boundingBox())!;
      expect(box.x, name).toBe(0);
      expect(box.width, name).toBe(320);
      expect(box.y + box.height, name).toBe(568);
      expect(box.y, name).toBeGreaterThan(0);
      expect(await sheet.locator('[style]').count(), name).toBe(0);
      expect(await noHorizontalScroll(page), name).toBe(true);
      // Every target is a full finger tall.
      for (const target of await sheet.locator('[data-date]:not([disabled])').all()) { expect((await target.boundingBox())!.height, name).toBeGreaterThanOrEqual(36); }
      await page.keyboard.press('Escape');
    }
    expect(await browserStorage(page)).toEqual({ local: 0, session: 0, indexedDB: 0, caches: 0 });
  });
});

test.describe('date sheet range', () => {
  test('the sheets stay inside the years 2000 to 2099', async ({ page }) => {
    await login(page);
    // The phone has no jump-date field in the page header, so the top bar's own date input (the one behind the date) moves the page.
    for (const [date, step] of [['2099-12-15', 'Next month'], ['2000-01-15', 'Previous month']] as const) {
      await page.locator('#pill-date').fill(date);
      await expect(page.locator('.date-row.selected')).toHaveAttribute('data-date', date);
      await pill(page).click();
      const sheet = sheetOf(page, 'Choose a day');
      await expect(sheet.locator('.sheet-title')).toHaveText(monthTitle(date));
      await expect(sheet.getByRole('button', { name: step, exact: true })).toBeDisabled();
      // Days of the neighbouring year are shown but cannot be picked.
      const outside = sheet.locator('[data-date]:disabled');
      expect(await outside.count()).toBeGreaterThan(0);
      for (const d of await outside.evaluateAll(list => list.map(el => (el as HTMLElement).dataset.date!))) { expect(d < '2000-01-01' || d > '2099-12-31').toBe(true); }
      await page.keyboard.press('Escape');
    }
    await switchView(page, 'Month');
    await page.locator('#pill-date').fill('2099-06-15');
    await pill(page).click();
    await expect(sheetOf(page, 'Choose a month').getByRole('button', { name: 'Next year', exact: true })).toBeDisabled();
  });
});

const BARS = { Day: 'Day sections', Week: 'Week sections', Month: 'Month sections' } as const;
const bar = (page: Page, view: keyof typeof BARS) => page.getByRole('tablist', { name: BARS[view] });
const tabOf = (page: Page, view: keyof typeof BARS, name: string) => bar(page, view).getByRole('tab', { name, exact: true });

test.describe('phone tab bars in the app', () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test('Day: Schedule, To-do, Notes, Chores; Schedule opens first; a tap, the arrow keys, Home, End and Enter switch and keep the focus on the tab; the tab survives a new day', async ({ page }) => {
    const tab = (name: string) => tabOf(page, 'Day', name);
    await expect(bar(page, 'Day').getByRole('tab')).toHaveText(['Schedule', 'To-do', 'Notes', 'Chores']);
    await expect(tab('Schedule')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.day-sched')).toBeVisible();
    await expect(page.locator('.day-todo')).toHaveCount(0);
    await tab('To-do').tap();
    await expect(tab('To-do')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: 'To-do', exact: true })).toBeVisible();
    await expect(page.locator('.day-todo')).toBeVisible();
    await expect(page.locator('.day-sched')).toHaveCount(0);
    // One stop in the bar for Tab: the chosen tab.
    await expect(tab('To-do')).toHaveAttribute('tabindex', '0');
    await expect(tab('Schedule')).toHaveAttribute('tabindex', '-1');
    // Arrow keys move one tab and wrap at the ends; the focus goes with the choice although the panel is redrawn.
    await tab('To-do').focus();
    await page.keyboard.press('ArrowRight');
    await expect(tab('Notes')).toBeFocused();
    await expect(tab('Notes')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.day-notes')).toBeVisible();
    // Chores is not a section of the Day: its tab hands the page to the Chores view, which draws the same bar with Chores chosen.
    await page.keyboard.press('ArrowRight');
    await expect(tab('Chores')).toBeFocused();
    await expect(tab('Chores')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.ch-view')).toBeVisible();
    await expect(page.locator('.day-panel')).toHaveCount(0);
    await page.keyboard.press('ArrowRight');
    await expect(tab('Schedule')).toBeFocused();
    await expect(tab('Schedule')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.day-sched')).toBeVisible();
    await expect(page.locator('.ch-view')).toHaveCount(0);
    await page.keyboard.press('ArrowLeft');
    await expect(tab('Chores')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(tab('Schedule')).toBeFocused();
    await expect(tab('Schedule')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(tab('Chores')).toBeFocused();
    // Enter on a focused tab chooses it and keeps the focus there too.
    await tab('To-do').focus();
    await page.keyboard.press('Enter');
    await expect(tab('To-do')).toBeFocused();
    await expect(tab('To-do')).toHaveAttribute('aria-selected', 'true');
    // The tab stays chosen when the day changes.
    await page.getByRole('button', { name: 'Next day', exact: true }).tap();
    await expect(tab('To-do')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.day-todo')).toBeVisible();
  });

  test('Week: Priorities, To-do and Chores; a tap and the arrow keys switch; the choice stays on another week', async ({ page }) => {
    await switchView(page, 'Week');
    const tab = (name: string) => tabOf(page, 'Week', name);
    await expect(bar(page, 'Week').getByRole('tab')).toHaveText(['Priorities', 'To-do', 'Chores']);
    await expect(tab('Priorities')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-sec=priorities]')).toBeVisible();
    await expect(page.locator('[data-sec=todo]')).toBeHidden();
    await tab('To-do').tap();
    await expect(tab('To-do')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-sec=todo]')).toBeVisible();
    await expect(page.locator('[data-sec=priorities]')).toBeHidden();
    // Chores takes over the page (the Week's own bar, Chores chosen); the other tabs bring the Week back.
    await page.keyboard.press('ArrowRight');
    await expect(tab('Chores')).toBeFocused();
    await expect(tab('Chores')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.ch-view[data-period=week]')).toBeVisible();
    await expect(page.locator('.wm-panel')).toHaveCount(0);
    await page.keyboard.press('ArrowRight');
    await expect(tab('Priorities')).toBeFocused();
    await expect(page.locator('[data-sec=priorities]')).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(tab('Chores')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(tab('To-do')).toBeFocused();
    await expect(page.locator('[data-sec=todo]')).toBeVisible();
    await page.getByRole('button', { name: 'Next week', exact: true }).tap();
    await expect(tab('To-do')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-sec=todo]')).toBeVisible();
  });

  test('Month: five tabs, only the chosen one shows its label, and each shows its own part of the page', async ({ page }) => {
    await switchView(page, 'Month');
    const tab = (name: string) => tabOf(page, 'Month', name);
    await expect(bar(page, 'Month').getByRole('tab')).toHaveCount(5);
    await expect(tab('Calendar')).toHaveAttribute('aria-selected', 'true');
    await expect(tab('Calendar').locator('span')).toBeVisible();
    await expect(page.locator('.wm-days')).toBeVisible();
    for (const name of ['Priorities', 'To-do', 'Notes', 'Chores']) {
      // Still there, and named, for a screen reader.
      await expect(tab(name)).toBeVisible();
      await expect(tab(name).locator('span')).toBeHidden();
    }
    await tab('Notes').tap();
    await expect(tab('Notes').locator('span')).toBeVisible();
    await expect(tab('Calendar').locator('span')).toBeHidden();
    await expect(page.locator('[data-sec=notes]')).toBeVisible();
    await expect(page.locator('.wm-days')).toBeHidden();
    await tab('Priorities').tap();
    await expect(page.locator('[data-sec=priorities]')).toBeVisible();
    await expect(page.locator('[data-sec=notes]')).toBeHidden();
  });
});

test('phone: the tab bars and the date button keep AA contrast in all four themes, the chosen tab included', async ({ page }) => {
  await login(page);
  for (const view of ['Day', 'Week', 'Month'] as const) {
    if (view !== 'Day') { await switchView(page, view); }
    const tabs = view === 'Day' ? '.day-tab' : '.wm-tabs [role=tab]';
    for (const theme of Object.keys(THEMES) as ThemeName[]) {
      await showTheme(page, theme);
      for (const selector of ['#date-pill', `${tabs}[aria-selected=true] span`, `${tabs}[aria-selected=false]`]) {
        const seen = await textContrast(page, selector);
        for (const { text, ratio } of seen) { expect(ratio, `${theme} ${view} ${selector} "${text}"`).toBeGreaterThanOrEqual(MIN_CONTRAST); }
      }
    }
    expect((await textContrast(page, `${tabs}[aria-selected=true] span`)).length, view).toBe(1);
  }
});

test('phone: the controls used every day are 44px targets', async ({ page, baseURL }) => {
  await login(page);
  // Each group is looked at where it is on screen; a target must be 44px each way (a wide one only needs the height; `tall` lowers that for the one control drawn smaller on purpose).
  const reach = async (label: string, selector: string, wide = false, tall = 44) => {
    await expect(page.locator(selector).first(), `${label} ${selector}`).toBeVisible();
    const found = await hitSizes(page, selector);
    expect(found.length, `${label} ${selector} is on the page`).toBeGreaterThan(0);
    for (const { name, width, height } of found) {
      expect(height, `${label} "${name}" height`).toBeGreaterThanOrEqual(tall);
      if (!wide) { expect(width, `${label} "${name}" width`).toBeGreaterThanOrEqual(44); }
    }
  };
  await reach('top bar', '#menu, #pill-prev, #pill-next, .picker-button');
  await reach('top bar', '#date-pill', true);
  // The AM and PM switch and the CalMind switch are in the menu behind the hamburger on the Schedule tab, which a phone opens on.
  await showHalf(page, 'am');
  await page.getByRole('button', { name: 'Open menu', exact: true }).tap();
  await page.waitForFunction(() => document.getElementById('sidebar')!.getBoundingClientRect().left >= 0);
  await reach('menu schedule choices', '#day-tools button');
  await page.keyboard.press('Escape');
  // A schedule entry is deleted by a swipe to the left and a tap on the Delete it shows at the right end of its block (nothing hangs over the
  // schedule while it is edited): that Delete is finger-sized. The entry is made through the API so nothing is left behind.
  const owner = await apiLogin(baseURL!, OWNER), id = crypto.randomUUID();
  expect((await owner.post({ id, action: 'add', kind: 'event', date: today(), owners: [OWNER], text: 'Reach check', start: 540, length: 60 })).status()).toBe(200);
  try {
    await page.reload();
    await showHalf(page, 'am');
    // A finger's swipe: down on the entry's right part, 8 steps 90px to the left, up.
    const box = (await page.getByRole('button', { name: `Reach check, 9a to 10a, ${OWNER_NAME}`, exact: true }).boundingBox())!, cdp = await page.context().newCDPSession(page);
    const from = { x: box.x + box.width - 14, y: box.y + box.height / 2 };
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    await touch('touchStart', from.x, from.y);
    for (let i = 1; i <= 8; i++) { await touch('touchMove', from.x - (90 * i) / 8, from.y); }
    await touch('touchEnd');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await reach('entry swipe', '.day-ev-del');
    await expect(page.locator('.day-ev-del')).toHaveAccessibleName('Delete Reach check');
    await expect(page.locator('.day-ev-strip, .day-ev.day-editing')).toHaveCount(0);
  } finally {
    const stored = (await owner.snapshot()).events.find((e: { id: string }) => e.id === id);
    if (stored) { await owner.post({ action: 'delete', id, revision: stored.revision, confirm: true }); }
    await owner.dispose();
  }
  // The Notes tab (Both view: two lanes, so the lane switch is there).
  await tabOf(page, 'Day', 'Notes').tap();
  await reach('notes', '.day-segbtn, .day-note-save', true);
  // The drawer.
  await page.getByRole('button', { name: 'Open menu', exact: true }).tap();
  // Wait for the slide to end: until then the scrim is what is under the controls.
  await page.waitForFunction(() => document.getElementById('sidebar')!.getBoundingClientRect().left >= 0);
  await reach('drawer', '#drawer-close, #earlier, #later');
  await reach('drawer', '.view-switch button, #today, .drawer-account .account-button', true);
  await page.keyboard.press('Escape');
  // Week and Month text blocks and the to-do box.
  await switchView(page, 'Week');
  // The drawer is still sliding away for a moment after it closes, and covers what is under it until it has gone.
  await expect(page.locator('#sidebar')).toBeHidden();
  await reach('week', '.wm-lane [data-act=save]', true);
  await tabOf(page, 'Week', 'To-do').tap();
  // The to-do list is ruled like the Day's: the add field is on the first blank line, and its Add button shows once there is text. The button
  // is the small inline one of the Day's list (28px high on a phone, Enter adds too), not a 44px box.
  await page.getByRole('textbox', { name: 'New to-do', exact: true }).fill('Reach check');
  await reach('week to-do', '.wm-add-go', true, 28);
});
