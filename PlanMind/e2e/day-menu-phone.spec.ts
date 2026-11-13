import { expect, test, type Page } from '@playwright/test';
import { apiLogin, farDate, login, resetPrefs } from './helpers';
import { OWNER } from './people';

// The Day's CalMind toggle and AM/PM switch live in the menu behind the hamburger on a phone (the owner, 2026-11-10: the row of two pills under the
// date "looks ridiculous"). The row is gone, so the lane names sit right under the date bar; the page says which half it shows in the corner
// of the lane names; choosing closes the menu and the focus goes back to the hamburger. The CalMind choice is kept per account as before;
// the half is session state and the page opens on AM, as before. Phone project (375x812).
const DAY = farDate(490);
const menu = (page: Page) => page.locator('#menu');
const open = async (page: Page) => { await menu(page).click(); await expect(page.locator('#sidebar')).toBeVisible(); };

test.afterEach(async ({ baseURL }) => {
  await resetPrefs(baseURL!);
  const api = await apiLogin(baseURL!, OWNER);
  await api.post({ action: 'setCalmind', hidden: false });
  await api.dispose();
});
const goDay = async (page: Page) => {
  await login(page, OWNER);
  await page.locator('#pill-date').fill(DAY);
  await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', DAY);
  await expect(page.locator('.day-sched')).toBeVisible();
};

test('the row of pills is gone: the lane names sit directly under the date bar, and the schedule got the height', async ({ page }) => {
  await goDay(page);
  for (const gone of ['.day-schedtools', '.day-half', '.day-calbtn']) { await expect(page.locator(gone)).toHaveCount(0); }
  const at = await page.evaluate(() => {
    const top = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    return { bar: top('.topbar').bottom, lanes: top('.day-lanehead'), grid: top('.day-timeline'), tabs: top('.day-tabs') };
  });
  // Lane names within a few pixels of the bar's rule (the panel's 6px top padding), the grid right under them and above the tab bar.
  expect(at.lanes.top - at.bar).toBeLessThan(14);
  expect(at.grid.top - at.lanes.bottom).toBeLessThan(6);
  expect(at.grid.bottom).toBeLessThanOrEqual(at.tabs.top + 0.5);
  // The state stays visible without the menu: the corner of the lane names says AM, over the hour labels, and no wider than they are.
  const corner = page.locator('.day-lanehead .day-corner');
  await expect(corner).toHaveText('AM');
  const c = (await corner.boundingBox())!, firstLane = (await page.locator('.day-lane').first().boundingBox())!;
  expect(c.x + c.width).toBeLessThanOrEqual(firstLane.x + 0.5);
  expect(c.y).toBeGreaterThanOrEqual(at.bar);
  // A screen reader gets it from the schedule's heading.
  await expect(page.getByRole('heading', { name: 'Schedule, AM' })).toHaveCount(1);
});

test('the menu holds an AM/PM two-option item and a CalMind switch, in the drawer\'s own looks, with their state', async ({ page }) => {
  await goDay(page);
  await expect(page.locator('#day-tools')).toBeHidden();
  await open(page);
  const tools = page.locator('#day-tools');
  await expect(tools).toBeVisible();
  await expect(tools.getByRole('group', { name: 'Part of the day' })).toBeVisible();
  await expect(tools.getByRole('button', { name: 'AM', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(tools.getByRole('button', { name: 'PM', exact: true })).toHaveAttribute('aria-pressed', 'false');
  const sw = tools.getByRole('switch', { name: 'CalMind events' });
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  // Finger-sized, inside the drawer, and the same segmented look as the Month | Week | Day switch.
  for (const target of [tools.getByRole('button', { name: 'AM', exact: true }), tools.getByRole('button', { name: 'PM', exact: true }), sw]) {
    const b = (await target.boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(43.5);
    expect(b.x + b.width).toBeLessThanOrEqual(await page.evaluate(() => document.querySelector('#sidebar')!.getBoundingClientRect().right) + 0.5);
  }
  expect(await tools.locator('.view-switch').evaluate(e => getComputedStyle(e).borderRadius)).toBe(await page.locator('#sidebar > .view-switch').evaluate(e => getComputedStyle(e).borderRadius));
  // The menu still has everything it had: the view switch, Today, the dates, the account.
  await expect(page.locator('#sidebar [data-view=day]')).toBeVisible();
  await expect(page.locator('#sidebar #today')).toBeVisible();
  await expect(page.locator('#sidebar .account-button')).toBeVisible();
});

test('choosing PM closes the menu, returns the focus to the hamburger, draws the PM page and says PM in the corner; AM comes back', async ({ page }) => {
  await goDay(page);
  await open(page);
  await page.locator('#day-tools').getByRole('button', { name: 'PM', exact: true }).click();
  await expect(page.locator('#sidebar')).toBeHidden();
  await expect(menu(page)).toBeFocused();
  await expect(page.locator('.day-sched')).toHaveAttribute('data-half', 'pm');
  await expect(page.locator('.day-corner')).toHaveText('PM');
  await expect(page.locator('.day-hours span').first()).toHaveText('9p');
  await expect(page.getByRole('heading', { name: 'Schedule, PM' })).toHaveCount(1);
  await expect(page.locator('#live')).toContainText('PM');
  await open(page);
  await expect(page.locator('#day-tools').getByRole('button', { name: 'PM', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#day-tools').getByRole('button', { name: 'AM', exact: true }).click();
  await expect(page.locator('.day-corner')).toHaveText('AM');
  await expect(page.locator('.day-hours span').first()).toHaveText('7a');
  // The page opens on AM again after a reload, as before.
  await open(page);
  await page.locator('#day-tools').getByRole('button', { name: 'PM', exact: true }).click();
  await page.reload();
  await expect(page.locator('.day-sched')).toHaveAttribute('data-half', 'am');
});

test('the CalMind switch hides and shows the events, closes the menu, and the choice is kept across a reload', async ({ page, baseURL }) => {
  await goDay(page);
  await open(page);
  await page.getByRole('switch', { name: 'CalMind events' }).click();
  await expect(page.locator('#sidebar')).toBeHidden();
  await expect(menu(page)).toBeFocused();
  await expect(page.locator('#live')).toContainText('CalMind events hidden');
  await expect.poll(async () => { const api = await apiLogin(baseURL!, OWNER); const v = (await api.snapshot()).calmind; await api.dispose(); return v; }).toBe('hidden');
  await page.reload();
  await expect(page.locator('.day-sched')).toBeVisible();
  await open(page);
  await expect(page.getByRole('switch', { name: 'CalMind events' })).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('switch', { name: 'CalMind events' }).click();
  await expect.poll(async () => { const api = await apiLogin(baseURL!, OWNER); const v = (await api.snapshot()).calmind; await api.dispose(); return v; }).toBe('shown');
});

test('by keyboard: Tab reaches the choices inside the open menu, Space or Enter chooses, Escape closes and returns to the hamburger', async ({ page }) => {
  await goDay(page);
  await menu(page).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#sidebar')).toBeVisible();
  await page.locator('#day-tools').getByRole('button', { name: 'PM', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.day-sched')).toHaveAttribute('data-half', 'pm');
  await expect(menu(page)).toBeFocused();
  await page.keyboard.press('Enter');
  const sw = page.getByRole('switch', { name: 'CalMind events' });
  await sw.focus();
  await expect(sw).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#sidebar')).toBeHidden();
  await expect(menu(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await expect(page.locator('#sidebar')).toBeHidden();
  await expect(menu(page)).toBeFocused();
});

test('the choices are in the menu only on the Day\'s Schedule tab, not on the other tabs, the Week or the Month', async ({ page }) => {
  await goDay(page);
  await page.getByRole('tab', { name: 'To-do', exact: true }).tap();
  await open(page);
  await expect(page.locator('#day-tools')).toBeHidden();
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Schedule', exact: true }).tap();
  await open(page);
  await expect(page.locator('#day-tools')).toBeVisible();
  await page.locator('#sidebar [data-view=week]').click();
  await expect(page.locator('#day-tools')).toBeHidden();
  await page.keyboard.press('Escape');
  await open(page);
  await expect(page.locator('#day-tools')).toBeHidden();
  await page.locator('#sidebar [data-view=month]').click();
  await expect(page.locator('#day-tools')).toBeHidden();
});

test('a Day opened from the Month keeps the hamburger beside Back, so the choices are reachable there too', async ({ page }) => {
  await login(page, OWNER);
  await open(page);
  await page.locator('#sidebar [data-view=month]').click();
  await page.keyboard.press('Escape');
  await page.locator('.wm-day[data-date]').first().tap();
  await expect(page.locator('#back-view')).toBeVisible();
  await expect(menu(page)).toBeVisible();
  await open(page);
  await expect(page.locator('#day-tools')).toBeVisible();
});
