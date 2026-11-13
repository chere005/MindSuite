import { expect, test, type Locator, type Page } from '@playwright/test';
import { MIN_CONTRAST } from '../packages/core/src/planner';
import { THEMES, type ThemeName } from '../app/theme';
import { CHORE_ANCHOR, MIN_NON_TEXT_CONTRAST, apiLogin, field, hitSizes, login, overlayList, pickList, resetChores, resetPrefs, showTheme, textContrast, todo, unique, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// The chores on a desktop (1360x900, desktop project only). There is no page of their own: the Day's picker menu has a Chores switch that swaps the To-do section
// (the right column under Priorities) for the day's chores, and the Month's calendar always carries the month's chores in its cells; the Week has none. Also "The rhythm…" under
// "Manage lists…" and the editor it opens. The store is shared by the whole run, so each test fixes the browser's clock to March 2027 (no other spec goes there), and puts back
// every mark, every rule and the rhythm it touched. Thu Mar 11 2027 is the 2nd Thursday of a Week A (the rhythm's anchor is Nov 2 2026): see chores-phone.spec.ts for what the day holds.
const THU = '2027-03-11', SAT = '2027-03-13';
const noon = (date: string) => new Date(`${date}T12:00:00-06:00`);
const TODAY_OWN = ['Dishes', 'Trash & recycling', 'Wipe the table', 'Cat bowls', 'Fresh litter + liner', 'Litter box deep clean'];
const MISSED = ['Laundry', 'Vacuum', 'Dust, then vacuum', 'Clutter reset', 'Mail & papers', 'Fridge clean-out', 'Bins to the curb', 'Kitchen wipe-down'];
let owner: Api;
test.beforeEach(async ({ baseURL }) => { owner = await apiLogin(baseURL!, OWNER); await resetChores(owner, '2027-03'); });
test.afterEach(async ({ baseURL }) => { await resetChores(owner, '2027-03'); await owner.dispose(); await resetPrefs(baseURL!); });

const marks = async () => (await owner.snapshot()).choreMarks.filter((m: { date: string }) => m.date.startsWith('2027-03'));
const stored = async () => (await marks()).map((m: { date: string; state: string }) => [m.date, m.state]);
async function open(page: Page, view: 'day' | 'week' | 'month', date = THU) {
  await page.clock.install({ time: noon(THU) });
  await login(page);
  await page.locator('#jump-date').fill(date);
  await page.locator(`.view-switch button[data-view=${view}]`).click();
  await expect(page.locator(view === 'day' ? '.day-panel' : '.wm-panel')).toBeVisible();
}
const picker = (page: Page) => page.getByRole('button', { name: /^Lists: / });
const menu = (page: Page) => page.getByRole('group', { name: 'Lists', exact: true });
/** The Chores switch of the picker menu (a desktop Day's only). */
const choresSwitch = (page: Page) => menu(page).getByRole('switch', { name: 'Chores', exact: true });
/** Flips the Day's Chores switch (turning it on or off saves nothing: it is not a list). */
async function flip(page: Page) {
  await picker(page).click();
  await choresSwitch(page).click();
  await expect(menu(page)).toBeHidden();
}
async function openChores(page: Page, date = THU) { await open(page, 'day', date); await flip(page); await expect(page.locator('.day-chores')).toBeVisible(); }
const titles = (page: Page) => page.locator('.day-chores .ch-row .ch-title').allTextContents();
const rowOf = (page: Page, title: string) => page.locator('.day-chores .ch-row', { hasText: title });
/** A scroll bar of the page or the panel under the top bar: the Day and the Month fit a desktop window, so there is none. */
const overflow = (page: Page) => page.evaluate(() => { const doc = document.scrollingElement!, host = document.querySelector('#period-panel')!; return { page: doc.scrollHeight - innerHeight, sideways: doc.scrollWidth - innerWidth, panel: host.scrollHeight - host.clientHeight }; });

test.describe('the Chores switch of the Day', () => {
  test('the Day\'s picker menu ends its list rows with a Chores switch (a house, off), before Manage lists… and The rhythm…; the Week has no switch and no rhythm, the Month a rhythm and no switch', async ({ page }) => {
    await open(page, 'day');
    await picker(page).click();
    const sw = choresSwitch(page);
    const [lists, chores, manage, rhythm] = await Promise.all([menu(page).getByRole('button', { name: OWNER_NAME, exact: true }), sw, menu(page).getByRole('button', { name: 'Manage lists…', exact: true }), menu(page).getByRole('button', { name: 'The rhythm…', exact: true })].map(async b => (await b.boundingBox())!));
    expect(chores.y, 'after the list rows').toBeGreaterThan(lists.y + lists.height - 1);
    expect(manage.y, 'before Manage lists…').toBeGreaterThan(chores.y + chores.height - 1);
    expect(rhythm.y).toBeGreaterThan(manage.y);
    await expect(sw.locator('.picker-house svg')).toBeVisible();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(sw).not.toHaveAttribute('aria-current', 'true');
    // A switch, not a list: no list row is replaced, and the one chosen is still Both.
    await expect(menu(page).getByRole('button', { name: 'Both', exact: true })).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('Escape');
    // The Week: no Chores row, no rhythm (the chores are not on it); the Month: the rhythm, no switch (its calendar always shows them).
    await page.locator('.view-switch button[data-view=week]').click();
    await expect(page.locator('.wm-panel[data-panel=week]')).toBeVisible();
    await picker(page).click();
    await expect(menu(page).getByRole('switch')).toHaveCount(0);
    await expect(menu(page).getByRole('button', { name: 'Chores', exact: true })).toHaveCount(0);
    await expect(menu(page).getByRole('button', { name: 'The rhythm…', exact: true })).toHaveCount(0);
    await expect(menu(page).getByRole('button', { name: 'Manage lists…', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('.view-switch button[data-view=month]').click();
    await expect(page.locator('.wm-panel[data-panel=month]')).toBeVisible();
    await picker(page).click();
    await expect(menu(page).getByRole('switch')).toHaveCount(0);
    await expect(menu(page).getByRole('button', { name: 'The rhythm…', exact: true })).toBeVisible();
    // The menu shown while the view changes follows it.
    await page.keyboard.press('Escape');
    await page.locator('.view-switch button[data-view=day]').click();
    await picker(page).click();
    await expect(choresSwitch(page)).toBeVisible();
    await expect(menu(page).getByRole('button', { name: 'The rhythm…', exact: true })).toBeVisible();
  });

  test('the menu is a menu: the arrow keys walk the lists, the switch, Manage lists… and The rhythm…, and Enter on the switch turns it on and puts the keyboard back on the picker', async ({ page }) => {
    await open(page, 'day');
    await picker(page).click();
    await expect(menu(page).getByRole('button', { name: 'Both', exact: true })).toBeFocused();
    for (const name of [PARTNER_NAME, OWNER_NAME]) {
      await page.keyboard.press('ArrowDown');
      await expect(menu(page).getByRole('button', { name, exact: true })).toBeFocused();
    }
    await page.keyboard.press('ArrowDown');
    await expect(choresSwitch(page)).toBeFocused();
    for (const name of ['Manage lists…', 'The rhythm…']) {
      await page.keyboard.press('ArrowDown');
      await expect(menu(page).getByRole('button', { name, exact: true })).toBeFocused();
    }
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
    await expect(choresSwitch(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.day-chores')).toBeVisible();
    await expect(menu(page)).toBeHidden();
    await expect(picker(page)).toBeFocused();
    // The menu opens on the chosen list, the switch says it is on, and Enter turns it off again.
    await picker(page).click();
    await expect(menu(page).getByRole('button', { name: 'Both', exact: true })).toBeFocused();
    await expect(choresSwitch(page)).toHaveAttribute('aria-checked', 'true');
    await choresSwitch(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.day-todo')).toBeVisible();
    await expect(page.locator('.day-chores')).toHaveCount(0);
  });

  test('on: the To-do section becomes Chores in the same box, the same height, in the same place under Priorities; the picker still names the lists and the stored selection is untouched; off: the to-dos come back', async ({ page }) => {
    const mine = todo({ date: THU, title: unique('Stamp') });
    expect((await owner.post(mine)).status()).toBe(200);
    try {
      await open(page, 'day');
      await expect(page.getByRole('button', { name: `Edit ${mine.title}`, exact: true })).toBeVisible();
      await expect(page.locator('.day-todo .day-label')).toHaveText('To-do');
      const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
      const [todoBox, listBox, prioBox] = [await box('.day-todo'), await box('.day-todo > .day-tasks'), await box('.day-prio')];
      const before = await owner.snapshot();
      await flip(page);
      await expect(page.locator('.day-chores .day-label')).toHaveText('Chores');
      await expect(page.locator('.day-todo')).toHaveCount(0);
      await expect(page.getByRole('button', { name: `Edit ${mine.title}`, exact: true })).toHaveCount(0);
      await expect(page.locator('.ch-view')).toHaveCount(0);
      const [choresBox, chores] = [await box('.day-chores'), await box('.day-chores > .ch-list')];
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(choresBox[key] - todoBox[key]), `the section's ${key}`).toBeLessThanOrEqual(1.5);
        expect(Math.abs(chores[key] - listBox[key]), `the list's ${key}`).toBeLessThanOrEqual(1.5);
      }
      expect(Math.abs((await box('.day-prio')).height - prioBox.height), 'Priorities keep their height').toBeLessThanOrEqual(1);
      expect(choresBox.y).toBeGreaterThan(prioBox.y + prioBox.height - 1);
      expect(await titles(page)).toEqual([...TODAY_OWN, ...MISSED]);
      await expect(page.locator('.day-chores .ch-label')).toHaveText(['Missed']);
      // The picker is the lists' (the pie and its names), not a house; nothing was saved for the switch.
      await expect(picker(page)).toHaveAccessibleName('Lists: Both');
      await expect(page.locator('#picker-button .picker-house')).toHaveCount(0);
      await expect(page.locator('#picker-button')).not.toHaveAttribute('data-chores', /.*/);
      await picker(page).click();
      await expect(choresSwitch(page)).toHaveAttribute('aria-checked', 'true');
      await expect(menu(page).locator('.picker-row.selected')).toHaveCount(1);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(700);
      expect((await owner.snapshot()).prefs).toEqual(before.prefs);
      expect((await owner.snapshot()).revision).toBe(before.revision);
      // The topbar and the header are the Day's.
      await expect(page.locator('#mode-heading')).toHaveText('Daily planner');
      await expect(page.locator('#full-date')).toHaveText('March 11, 2027');
      // Off: the to-dos, the add field and the title, in the same box.
      await flip(page);
      await expect(page.locator('.day-chores')).toHaveCount(0);
      await expect(page.locator('.day-todo .day-label')).toHaveText('To-do');
      await expect(page.getByRole('button', { name: `Edit ${mine.title}`, exact: true })).toBeVisible();
      await expect(page.getByLabel('New task', { exact: true })).toBeVisible();
      const again = await box('.day-todo');
      expect(Math.abs(again.height - todoBox.height) + Math.abs(again.y - todoBox.y)).toBeLessThanOrEqual(2);
    } finally { await owner.post({ action: 'delete', id: mine.id, revision: (await owner.snapshot()).tasks.find((t: { id: string }) => t.id === mine.id)?.revision ?? 1, confirm: true }); }
  });

  test('the list is the box of the to-dos: it scrolls inside itself when long, and the page and the panel do not scroll; no row is cut by the box', async ({ page }) => {
    // 14 rows and a label: more than the box holds in a window of 800px high (at 900 it all shows).
    await page.setViewportSize({ width: 1280, height: 800 });
    await openChores(page);
    const list = page.locator('.day-chores > .ch-list');
    const scroller = await list.evaluate(el => ({ overflow: getComputedStyle(el).overflowY, more: el.scrollHeight - el.clientHeight, client: el.clientHeight }));
    expect(scroller.overflow).toBe('auto');
    expect(scroller.client, 'at least the 13 lines of the to-do list').toBeGreaterThanOrEqual(13 * 28 - 2);
    // 14 rows and a label are more than the box: the last row is reached by scrolling the list.
    expect(scroller.more).toBeGreaterThan(0);
    expect(await overflow(page)).toEqual({ page: 0, sideways: 0, panel: 0 });
    await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(rowOf(page, 'Kitchen wipe-down')).toBeInViewport();
    const [row, box] = [(await rowOf(page, 'Kitchen wipe-down').boundingBox())!, (await list.boundingBox())!];
    expect(row.y + row.height, 'the last row ends inside the box').toBeLessThanOrEqual(box.y + box.height + 1);
    // A check redraws the page and the list keeps its place (the done row goes to the bottom of the list, which is where it is scrolled to).
    await page.getByRole('checkbox', { name: 'Complete Litter box deep clean', exact: true }).click();
    await expect(rowOf(page, 'Litter box deep clean')).toHaveClass(/ch-done/);
    expect(await list.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await expect(rowOf(page, 'Litter box deep clean')).toBeInViewport();
    await expect.poll(stored).toEqual([[THU, 'done']]);
  });

  for (const [width, height] of [[1360, 900], [1280, 800]]) {
    test(`a day with chores still fits a window of ${width}x${height}: no scroll bar of the page, the panel or anything else but the chores list itself`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      // A day ahead of the clock (a quiet one: its daily chores and its own) and Thursday with all its Missed rows.
      await openChores(page);
      for (const date of ['2027-03-16', THU]) {
        await page.locator('#jump-date').fill(date);
        await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', date);
        await expect(page.locator('.day-chores')).toBeVisible();
        expect(await overflow(page), date).toEqual({ page: 0, sideways: 0, panel: 0 });
        const scrolling = await page.locator('.day-panel').evaluate(panel => [...panel.querySelectorAll<HTMLElement>('*')].filter(el => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight).map(el => el.className));
        expect(scrolling.filter((name: string) => !name.includes('ch-list') && !name.includes('day-note') && !name.includes('textarea')), date).toEqual([]);
      }
    });
  }

  test('the Schedule, Priorities and Notes are what they were and keep following the list selection; the chores ignore it: every pick shows every chore', async ({ page, browser, baseURL }) => {
    const id = crypto.randomUUID(), name = unique('E2E list').slice(0, 20);
    expect((await owner.post({ action: 'saveList', id, name, color: 'blue', revision: 0 })).status()).toBe(200);
    const context = await browser.newContext({ baseURL, viewport: { width: 1360, height: 900 } });
    const partner = await context.newPage();
    try {
      await open(page, 'day');
      const left = () => page.locator('.day-col').first().innerHTML(), prio = () => page.locator('.day-prio').innerHTML();
      const [leftOff, prioOff] = [await left(), await prio()];
      await flip(page);
      expect(await left(), 'Schedule and Notes').toBe(leftOff);
      expect(await prio(), 'Priorities').toBe(prioOff);
      await expect.poll(async () => (await titles(page)).length).toBe(TODAY_OWN.length + MISSED.length);
      for (const who of [OWNER_NAME, PARTNER_NAME, name, 'Both']) {
        await pickList(page, who);
        await expect(picker(page)).toHaveAccessibleName(`Lists: ${who}`);
        // The lanes of the day's other sections are the pick's (one lane for a single list), the chores are everyone's.
        await expect(page.locator('.day-prio .day-lanehead .day-lane')).toHaveCount(who === 'Both' ? 2 : 1);
        await expect(page.locator('.day-notelanes .day-note')).toHaveCount(who === 'Both' ? 2 : 1);
        expect(await titles(page), `with ${who} picked`).toEqual([...TODAY_OWN, ...MISSED]);
        await expect(page.locator('.day-chores')).toBeVisible();
      }
      // The same Day in the partner's own account has the owner's chores too (Dishes is his, Trash & recycling hers) once she turns the switch on.
      await partner.clock.install({ time: noon(THU) });
      await login(partner, PARTNER);
      await partner.locator('.view-switch button[data-view=day]').click();
      await flip(partner);
      expect(await titles(partner)).toEqual([...TODAY_OWN, ...MISSED]);
      await expect(rowOf(partner, 'Dishes')).toHaveAttribute('data-c', 'green');
      await expect(rowOf(partner, 'Trash & recycling')).toHaveAttribute('data-c', 'yellow');
    } finally {
      await context.close();
      await owner.post({ action: 'savePrefs', selection: { base: 'both', overlays: [] } });
      const list = (await owner.snapshot()).lists.find((l: { id: string }) => l.id === id);
      if (list) { await owner.post({ action: 'deleteList', id, revision: list.revision, confirm: true }); }
    }
  });

  test('the switch is the session\'s: it stays on across days, the Week and the Month (which show no switch) and the sidebar, and a reload is the to-dos again', async ({ page }) => {
    await openChores(page);
    await page.locator('#next-day').click();
    await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', '2027-03-12');
    await expect(page.locator('.day-chores')).toBeVisible();
    await page.locator('#jump-date').fill('2027-03-16');
    await expect(page.locator('.day-chores')).toBeVisible();
    await page.locator(`#sidebar .date-row[data-date="2027-03-17"]`).click();
    await expect(page.locator('.day-chores')).toBeVisible();
    // The Week has no chores, with the switch on or off; the Month always has them. Neither draws a page of its own.
    await page.locator('.view-switch button[data-view=week]').click();
    await expect(page.locator('.wm-panel[data-panel=week]')).toBeVisible();
    await expect(page.locator('.ch-row, .ch-view, .ch-list')).toHaveCount(0);
    await page.locator('.view-switch button[data-view=month]').click();
    await expect(page.locator('.wm-panel[data-panel=month]')).toBeVisible();
    await expect(page.locator('.ch-view')).toHaveCount(0);
    await expect(page.locator('.wm-day .ch-row').first()).toBeVisible();
    await page.locator('.view-switch button[data-view=day]').click();
    await expect(page.locator('.day-chores')).toBeVisible();
    // Navigating the Day by the sidebar's Today, the arrows and the jump keeps it as well.
    await page.locator('#today').click();
    await expect(page.locator('.day-chores')).toBeVisible();
    await page.reload();
    await expect(page.locator('#sidebar .date-row.selected')).toBeAttached();
    await expect(page.locator('.day-todo')).toBeVisible();
    await expect(page.locator('.day-chores')).toHaveCount(0);
  });

  test('there is no full-page Chores view on a desktop: not in the picker, not from a Chores tab; a window narrowed to a phone shows the phone\'s Chores view and widened again lands on the planner Day with the switch on', async ({ page }) => {
    await open(page, 'day');
    await expect(page.locator('.ch-view')).toHaveCount(0);
    await expect(page.getByRole('tab')).toHaveCount(0);
    // From the phone width: its Chores tab turns Chores on (a page of its own at that width).
    await page.setViewportSize({ width: 700, height: 900 });
    await expect(page.locator('.day-panel[data-layout=phone]')).toBeVisible();
    await page.getByRole('tab', { name: 'Chores', exact: true }).click();
    await expect(page.locator('.ch-view[data-layout=phone][data-period=day]')).toBeVisible();
    await expect(page.locator('#picker-button')).toHaveAccessibleName('Chores');
    await expect(page.locator('#picker-button')).toHaveAttribute('data-locked', '');
    // Widened past 760px: the planner, the Day with its switch on and the rows in place of the to-dos.
    await page.setViewportSize({ width: 1360, height: 900 });
    await expect(page.locator('.day-panel[data-layout=wide]')).toBeVisible();
    await expect(page.locator('.ch-view')).toHaveCount(0);
    await expect(page.locator('.day-chores .ch-row').first()).toBeVisible();
    await expect(picker(page)).toHaveAccessibleName('Lists: Both');
    await picker(page).click();
    await expect(choresSwitch(page)).toHaveAttribute('aria-checked', 'true');
    await choresSwitch(page).click();
    await expect(page.locator('.day-todo')).toBeVisible();
    // The same from the Week's and the Month's Chores tabs (which turn it on again): the planner is back with no chores page, and the Day has the switch on.
    for (const view of ['week', 'month'] as const) {
      await page.locator(`.view-switch button[data-view=${view}]`).click();
      await page.setViewportSize({ width: 700, height: 900 });
      await page.getByRole('tab', { name: 'Chores', exact: true }).click();
      await expect(page.locator(`.ch-view[data-period=${view}]`)).toBeVisible();
      await page.setViewportSize({ width: 1360, height: 900 });
      await expect(page.locator(`.wm-panel[data-panel=${view}]`)).toBeVisible();
      await expect(page.locator('.ch-view')).toHaveCount(0);
    }
    await page.locator('.view-switch button[data-view=day]').click();
    await expect(page.locator('.day-chores')).toBeVisible();
  });

  test('the Day\'s switch is the Day\'s alone: with it on, a window narrowed to a phone shows the Chores view on the Day and the planner on the Week and the Month, picker open to its lists', async ({ page }) => {
    await open(page, 'day');
    await flip(page);
    await expect(page.locator('.day-chores')).toBeVisible();
    for (const view of ['week', 'month'] as const) {
      await page.locator(`.view-switch button[data-view=${view}]`).click();
      await expect(page.locator(`.wm-panel[data-panel=${view}]`)).toBeVisible();
      await page.setViewportSize({ width: 700, height: 900 });
      await expect(page.locator(`.wm-panel[data-panel=${view}][data-tab]`)).toBeVisible();
      await expect(page.locator('.ch-view')).toHaveCount(0);
      await expect(page.locator('#picker-button')).not.toHaveAttribute('data-locked', '');
      await expect(page.locator('#picker-button')).toHaveAccessibleName(/^Lists: /);
      await expect(page.locator('#full-date')).not.toContainText('Week A');
      await page.setViewportSize({ width: 1360, height: 900 });
      await expect(page.locator(`.wm-panel[data-panel=${view}]`)).toBeVisible();
    }
    // The Day is the one that takes it: the phone's Chores view, its picker locked, and the planner Day again once widened.
    await page.locator('.view-switch button[data-view=day]').click();
    await page.setViewportSize({ width: 700, height: 900 });
    await expect(page.locator('.ch-view[data-layout=phone][data-period=day]')).toBeVisible();
    await expect(page.locator('#picker-button')).toHaveAttribute('data-locked', '');
    await page.setViewportSize({ width: 1360, height: 900 });
    await expect(page.locator('.day-chores .ch-row').first()).toBeVisible();
  });
});

test.describe('the Day\'s chores', () => {
  test('today\'s chores, then Missed with Fri and Let go, in the to-do box: rows about 32px, the cadence badge and no title field, no add line, no delete', async ({ page }) => {
    await openChores(page);
    expect(await titles(page)).toEqual([...TODAY_OWN, ...MISSED]);
    await expect(page.locator('.day-chores .ch-label')).toHaveText(['Missed']);
    for (const row of await page.locator('.day-chores .ch-row').all()) { const { height } = (await row.boundingBox())!; expect(height).toBeGreaterThanOrEqual(31.5); expect(height).toBeLessThanOrEqual(44); }
    for (const row of await page.locator('.day-chores .ch-row[data-kind=missed]').all()) { await expect(row.locator('.ch-btn')).toHaveText(['Fri', 'Let go']); }
    await expect(rowOf(page, 'Kitchen wipe-down').locator('.ch-chip')).toHaveText(['Week A']);
    await expect(rowOf(page, 'Dishes').locator('.ch-chip')).toHaveCount(0);
    await expect(page.locator('.day-chores input:not([type=checkbox]), .day-chores .ch-add, .day-chores .ip-del')).toHaveCount(0);
  });

  test('a weekly, Week A / Week B or monthly row wears a quiet badge at its right end, before its other chips and buttons; a daily row has none; the Month\'s chips have none', async ({ page }) => {
    await openChores(page);
    const badges = () => page.locator('.day-chores .ch-row').evaluateAll(rows => rows.map(row => [row.querySelector('.ch-title')!.textContent, row.querySelector('.ch-badge')?.textContent ?? null]));
    // Thu Mar 11 (a Week A, the 2nd Thursday) lists daily, weekly, monthly and Week A rows, today's own and the week's missed ones.
    expect(await badges()).toEqual([
      ['Dishes', null], ['Trash & recycling', null], ['Wipe the table', null], ['Cat bowls', 'Weekly'], ['Fresh litter + liner', 'Weekly'], ['Litter box deep clean', 'Monthly'],
      ['Laundry', 'Weekly'], ['Vacuum', 'Weekly'], ['Dust, then vacuum', 'Monthly'], ['Clutter reset', 'Weekly'], ['Mail & papers', 'Weekly'], ['Fridge clean-out', 'Weekly'], ['Bins to the curb', 'Weekly'], ['Kitchen wipe-down', 'Week A'],
    ]);
    // The badge is not a control and wears no owner color (dim text like the labels, a thin border).
    await expect(page.locator('.day-chores .ch-chip:text-is("A")')).toHaveCount(0);
    await expect(page.locator('.day-chores .ch-badge:is(button, [role=button], [data-act])')).toHaveCount(0);
    expect(await page.evaluate(() => {
      const badge = getComputedStyle(document.querySelector('.ch-badge')!), label = getComputedStyle(document.querySelector('.ch-label')!);
      return { dim: badge.color === label.color, border: badge.borderTopWidth };
    })).toEqual({ dim: true, border: '1px' });
    // At the row's right end on an open row (after the title); on a missed row before Fri and Let go.
    const box = async (locator: Locator) => (await locator.boundingBox())!;
    const cat = rowOf(page, 'Cat bowls');
    const [row, title, badge] = [await box(cat), await box(cat.locator('.ch-title')), await box(cat.locator('.ch-badge'))];
    expect(badge.x).toBeGreaterThanOrEqual(title.x + title.width - 1);
    expect(row.x + row.width - (badge.x + badge.width)).toBeLessThanOrEqual(2);
    const mail = rowOf(page, 'Mail & papers');
    const [mailBadge, fri, letGo] = [await box(mail.locator('.ch-badge')), await box(mail.getByRole('button', { name: 'Move Mail & papers to Friday', exact: true })), await box(mail.getByRole('button', { name: 'Let go of Mail & papers', exact: true }))];
    expect(mailBadge.x + mailBadge.width).toBeLessThanOrEqual(fri.x);
    expect(fri.x + fri.width).toBeLessThanOrEqual(letGo.x);
    // The badge stays on a done row, and rows keep their accessible names.
    await page.getByRole('checkbox', { name: 'Complete Cat bowls', exact: true }).click();
    await expect(rowOf(page, 'Cat bowls')).toHaveClass(/ch-done/);
    await expect(rowOf(page, 'Cat bowls').locator('.ch-badge')).toHaveText('Weekly');
    await page.getByRole('checkbox', { name: 'Reopen Cat bowls', exact: true }).click();
    await expect.poll(marks).toEqual([]);
    // Sun Mar 14, a Week A: Laundry and Vacuum are weekly, the three Sunday rules of Week A say so. Wed Mar 17, a Week B: its own rule says so.
    await page.locator('#jump-date').fill('2027-03-14');
    expect(await badges()).toEqual([
      ['Dishes', null], ['Trash & recycling', null], ['Wipe the table', null], ['Laundry', 'Weekly'], ['Vacuum', 'Weekly'], ['Kitchen towels', 'Week A'], ['Bedding', 'Week A'], ['Couch blankets', 'Week A'],
    ]);
    await page.locator('#jump-date').fill('2027-03-17');
    expect(await badges()).toEqual([
      ['Dishes', null], ['Trash & recycling', null], ['Wipe the table', null], ['Fridge clean-out', 'Weekly'], ['Bins to the curb', 'Weekly'], ['Bathroom wipe-down', 'Week B'],
    ]);
    // The Month's chips carry no badge and no letter.
    await page.locator('.view-switch button[data-view=month]').click();
    await expect(page.locator('.wm-day .ch-row').first()).toBeVisible();
    await expect(page.locator('.wm-day .ch-badge')).toHaveCount(0);
    await expect(page.locator('.wm-day .ch-chip:not(.ch-undo)')).toHaveCount(0);
  });

  test('a circle checks a chore (the row goes crossed out to the bottom) and a tap again takes it back; a tap on the title hands that one turn to the next owner, and the rule keeps its own', async ({ page }) => {
    await openChores(page);
    await page.getByRole('checkbox', { name: 'Complete Dishes', exact: true }).click();
    await expect(rowOf(page, 'Dishes')).toHaveClass(/ch-done/);
    expect((await titles(page)).at(-1)).toBe('Dishes');
    await expect.poll(stored).toEqual([[THU, 'done']]);
    await page.getByRole('checkbox', { name: 'Reopen Dishes', exact: true }).click();
    await expect.poll(marks).toEqual([]);
    const cat = (who: string, next: string) => page.getByRole('button', { name: `Cat bowls, for ${who}. Tap to make it for ${next}`, exact: true });
    await cat(PARTNER_NAME, OWNER_NAME).click();
    await expect(cat(OWNER_NAME, 'Both')).toBeVisible();
    await expect(rowOf(page, 'Cat bowls')).toHaveAttribute('data-c', 'green');
    await cat(OWNER_NAME, 'Both').click();
    await expect(rowOf(page, 'Cat bowls')).toHaveAttribute('data-c', 'purple');
    await expect.poll(async () => (await marks()).map((m: { owners: string[] }) => m.owners)).toEqual([[OWNER, PARTNER]]);
    await cat('Both', PARTNER_NAME).click();
    await expect(cat(PARTNER_NAME, OWNER_NAME)).toBeVisible();
    await expect.poll(marks).toEqual([]);
  });

  test('Missed: Fri sends a turn to the catch-up Friday and Let go lets it go; on Friday they are the Catch-up group with "from" chips; Saturday is a day off', async ({ page }) => {
    await openChores(page);
    await page.getByRole('button', { name: 'Move Mail & papers to Friday', exact: true }).click();
    await page.getByRole('button', { name: 'Let go of Bins to the curb', exact: true }).click();
    await expect(page.locator('.day-chores .ch-row[data-kind=missed]')).toHaveCount(6);
    await expect.poll(async () => (await marks()).map((m: { date: string; state: string; moved: boolean }) => [m.date, m.state, m.moved]).sort()).toEqual([['2027-03-09', 'open', true], ['2027-03-10', 'letgo', false]]);
    await page.locator('#next-day').click();
    await expect(page.locator('.day-chores .ch-label')).toHaveText(['Catch-up']);
    const catchup = page.locator('.day-chores .ch-row[data-kind=catchup]');
    await expect(catchup).toHaveCount(7);
    await expect(catchup.filter({ hasText: 'Mail & papers' }).locator('.ch-chip')).toHaveText(['Weekly', 'from Tue']);
    await page.getByRole('checkbox', { name: 'Complete Mail & papers', exact: true }).click();
    await expect(page.locator('.day-chores .ch-row').last()).toHaveClass(/ch-done/);
    await expect(page.locator('.day-chores .ch-row').last().locator('.ch-chip')).toHaveText(['Weekly', 'from Tue']);
    await page.locator('#next-day').click();
    await expect(page.locator('.day-chores .ch-off')).toHaveText('Day off');
    await expect(page.locator('.day-chores .ch-row, .day-chores .ch-label')).toHaveCount(0);
    // Let go by hand on its own day shows dim with a chip that takes it back.
    await page.locator('#jump-date').fill('2027-03-10');
    const letgo = rowOf(page, 'Bins to the curb');
    await expect(letgo).toHaveClass(/ch-letgo/);
    await letgo.getByRole('button', { name: 'Bins to the curb was let go. Undo', exact: true }).click();
    await expect(rowOf(page, 'Bins to the curb')).toHaveClass(/ch-open/);
  });

  test('the Day off is a quiet line in the same box', async ({ page }) => {
    await openChores(page, SAT);
    await expect(page.locator('.day-chores .ch-off')).toHaveText('Day off');
    await expect(page.locator('.day-chores .day-label')).toHaveText('Chores');
    expect(await overflow(page)).toEqual({ page: 0, sideways: 0, panel: 0 });
  });
});

test.describe('the Month: the calendar of the month\'s chores', () => {
  const grid = (page: Page) => page.locator('.wm-grid');
  const cell = (page: Page, date: string) => page.locator(`.wm-day[data-date="${date}"]`);
  const background = (locator: Locator) => locator.evaluate(el => getComputedStyle(el).backgroundColor);
  /** A color token of the open theme as the browser computes it. */
  const token = (page: Page, name: string) => page.evaluate(n => { const probe = document.createElement('i'); probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(n); document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; }, name);
  /** The seeded rule with this title, for the marks a test writes through the API. */
  const ruleOf = async (title: string) => (await owner.snapshot()).chores.find((r: { title: string }) => r.title === title);
  const markTurn = async (title: string, date: string, over: Record<string, unknown>) => expect((await owner.post({ action: 'markChore', ruleId: (await ruleOf(title)).id, date, state: 'open', moved: false, revision: 0, ...over })).status()).toBe(200);
  const cellTitles = (page: Page, date: string) => cell(page, date).locator('.ch-title').allTextContents();

  test('42 days in a uniform grid: seven equal columns (Saturday as wide as Friday), six equal rows (the Notes sit in the sixth, compact), no dots, no counts, no A / B column, no letters, no legend and no "Day off" in a cell', async ({ page }) => {
    await open(page, 'month');
    await expect(page.locator('#day-title')).toHaveText('March');
    await expect(page.locator('.wm-day')).toHaveCount(42);
    await expect(page.locator('.wm-dot, .wm-dots, .wm-day-count')).toHaveCount(0);
    await expect(page.locator('.ch-cal, .ch-cal-pill, .ch-cal-week, [data-letter] .wm-letter')).toHaveCount(0);
    await expect(page.locator('.wm-days')).not.toContainText(/Week [AB]|Day off|\bA\b.*\bB\b/);
    // Columns: each weekday's cells are as wide as another's, Saturday included (a hatch is all that sets it apart).
    const widths = await page.locator('.wm-day:not([data-covered])').evaluateAll(cells => cells.map(el => ({ date: (el as HTMLElement).dataset.date!, width: el.getBoundingClientRect().width })));
    const sat = widths.find(c => c.date === '2027-03-13')!, fri = widths.find(c => c.date === '2027-03-12')!;
    expect(Math.abs(sat.width - fri.width), 'Saturday as wide as Friday').toBeLessThanOrEqual(1);
    expect(Math.max(...widths.map(c => c.width)) - Math.min(...widths.map(c => c.width))).toBeLessThanOrEqual(1);
    const dow = await page.locator('.wm-dow').evaluateAll(heads => heads.map(el => el.getBoundingClientRect().width));
    expect(Math.max(...dow) - Math.min(...dow)).toBeLessThanOrEqual(1);
    // Rows: all six are the same height (the Notes in the sixth take no height from it), and a cell is as tall as its row, whatever it holds.
    const rows = await grid(page).evaluate(el => getComputedStyle(el).gridTemplateRows.split(' ').map(Number.parseFloat));
    expect(rows).toHaveLength(7);
    expect(Math.max(...rows.slice(1)) - Math.min(...rows.slice(1)), 'six equal rows').toBeLessThanOrEqual(1);
    const heights = await page.locator('.wm-day:not([data-covered])').evaluateAll(cells => cells.map(el => el.getBoundingClientRect().height));
    expect(Math.max(...heights) - Math.min(...heights), 'every cell is as tall as its row').toBeLessThanOrEqual(1);
    expect(Math.abs((await page.locator('.wm-notes').boundingBox())!.height - rows[6]), 'the Notes are as tall as the sixth row, no taller').toBeLessThanOrEqual(1);
    // The side column is the 0.14.0 one (Priorities and To-do), and the Notes are in the cells after the last day.
    await expect(page.locator('.wm-side .wm-sec')).toHaveCount(2);
    await expect(page.locator('.wm-notes')).toBeVisible();
    expect(await overflow(page)).toEqual({ page: 0, sideways: 0, panel: 0 });
  });

  test('Week A rows carry a light highlight on the days of the month, Week B rows stay plain, days outside the month have none; a Saturday is hatched, in the month or not', async ({ page }) => {
    await open(page, 'month');
    const [b, a] = [await background(cell(page, '2027-03-02')), await background(cell(page, '2027-03-09'))];
    expect(a, 'Week A is tinted').not.toBe(b);
    expect(await background(cell(page, '2027-03-10')), 'the tint runs across the row').toBe(a);
    expect(await background(cell(page, '2027-03-16')), 'Week B stays plain').toBe(b);
    expect(b, 'plain is the page background').toBe(await token(page, '--bg'));
    expect(await background(cell(page, '2027-04-01')), 'a day outside the month has no tint, only the page background').toBe(await token(page, '--bg'));
    await expect(page.locator('.wm-day.out')).toHaveCount(42 - 31);
    const color = (selector: string) => page.locator(selector).first().evaluate(el => getComputedStyle(el).color);
    expect(await color('.wm-day.out .wm-day-num'), 'an outside day is muted').not.toBe(await color('.wm-day:not(.out):not(.today) .wm-day-num'));
    const hatch = (date: string) => cell(page, date).evaluate(el => getComputedStyle(el).backgroundImage);
    for (const date of ['2027-03-06', '2027-03-13', '2027-03-20', '2027-03-27', '2027-04-03']) { expect(await hatch(date), date).toContain('repeating-linear-gradient'); }
    for (const date of ['2027-03-05', '2027-03-07', '2027-03-12', '2027-04-01']) { expect(await hatch(date), date).toBe('none'); }
    await expect(page.locator('.wm-day[data-sat]')).toHaveCount(6);
    // The hatch is quiet: a Saturday's number and chips read as any day's.
    expect(await cell(page, '2027-03-13').locator('.wm-day-num').evaluate(el => getComputedStyle(el).color)).toBe(await cell(page, '2027-03-12').locator('.wm-day-num').evaluate(el => getComputedStyle(el).color));
    // Today: its cell keeps the highlight, its number is a filled accent circle.
    const num = cell(page, THU).getByRole('button', { name: 'Thursday, March 11, 2027', exact: true });
    await expect(cell(page, THU)).toHaveClass(/today/);
    await expect(num).toHaveAttribute('aria-current', 'date');
    await expect(page.locator('.wm-day.today')).toHaveCount(1);
    const box = (await num.boundingBox())!;
    expect(Math.abs(box.width - box.height), 'a circle').toBeLessThanOrEqual(1);
    expect(await background(num), 'filled with the accent').toBe(await token(page, '--accent'));
    expect(await background(cell(page, '2027-03-17').getByRole('button', { name: 'Wednesday, March 17, 2027', exact: true }))).toBe('rgba(0, 0, 0, 0)');
    expect(await cell(page, THU).evaluate(el => getComputedStyle(el).boxShadow), 'today is tinted, with no accent bar').toBe('none');
    // The keyboard focus ring of today's number stands off its fill.
    await page.keyboard.press('Shift');
    await num.focus();
    expect(await num.evaluate(el => el.matches(':focus-visible'))).toBe(true);
    expect(parseFloat(await num.evaluate(el => getComputedStyle(el).outlineOffset))).toBeGreaterThanOrEqual(2);
    // ...and the whole ring is inside its cell, which clips what hangs outside it (the number sits far enough from the cell's top and left edge).
    const ring = await num.evaluate(el => {
      const style = getComputedStyle(el), reach = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
      const [at, frame] = [el.getBoundingClientRect(), el.closest('.wm-day')!.getBoundingClientRect()];
      return { top: at.top - reach - frame.top, left: at.left - reach - frame.left, right: frame.right - (at.right + reach), bottom: frame.bottom - (at.bottom + reach) };
    });
    expect(ring.top, 'ring clear of the cell\'s top').toBeGreaterThanOrEqual(0);
    expect(ring.left, 'ring clear of the cell\'s left edge').toBeGreaterThanOrEqual(0);
    expect(ring.right).toBeGreaterThanOrEqual(0);
    expect(ring.bottom).toBeGreaterThanOrEqual(0);
    // A date number is a target of 24px at least (WCAG 2.2 AA 2.5.8), today's and any other day's.
    for (const size of await hitSizes(page, '.wm-day:not([data-covered]) .wm-day-num')) { expect(size.width, size.name).toBeGreaterThanOrEqual(24); expect(size.height, size.name).toBeGreaterThanOrEqual(24); }
  });

  test('a month before the rhythm starts has no chips, and the days of a month before it begins are plain and empty', async ({ page }) => {
    await open(page, 'month', '2026-11-12');
    // Nov 2026: Nov 1 is a day of the month before the rhythm starts; Nov 2 starts Week A.
    await expect(cell(page, '2026-11-01').locator('.ch-row')).toHaveCount(0);
    expect(await cell(page, '2026-11-01').getAttribute('data-letter')).toBeNull();
    await expect(cell(page, '2026-11-02')).toHaveAttribute('data-letter', 'A');
    await expect(cell(page, '2026-11-09')).toHaveAttribute('data-letter', 'B');
    await page.locator('#jump-date').fill('2026-10-14');
    await expect(page.locator('#day-title')).toHaveText('October');
    await expect(page.locator('.wm-day .ch-row')).toHaveCount(0);
    await expect(page.locator('.wm-day')).toHaveCount(42);
  });

  test('each day lists its monthly and Week A / Week B turns as chips as wide as the cell, tinted by their owner; the chores of every day or week are on the Day only', async ({ page }) => {
    await open(page, 'month');
    // Mar 1 and Mar 3 were let go by time; the rest is the month's list as the phone draws it.
    expect(await cellTitles(page, '2027-03-01')).toEqual([]);
    expect(await cellTitles(page, '2027-03-03')).toEqual([]);
    expect(await cellTitles(page, '2027-03-07')).toEqual(['Dust, then vacuum']);
    expect(await cellTitles(page, '2027-03-10')).toEqual(['Kitchen wipe-down']);
    expect(await cellTitles(page, THU)).toEqual(['Litter box deep clean']);
    expect(await cellTitles(page, '2027-03-14')).toEqual(['Kitchen towels', 'Bedding', 'Couch blankets']);
    expect(await cellTitles(page, '2027-03-17')).toEqual(['Bathroom wipe-down']);
    expect(await cellTitles(page, '2027-03-21')).toEqual(['Vacuum, then mop']);
    expect(await cellTitles(page, '2027-03-31')).toEqual(['Bathroom wipe-down']);
    expect(await cellTitles(page, '2027-03-12')).toEqual([]);
    const all = await page.locator('.wm-day .ch-title').allTextContents();
    expect(all).not.toContain('Dishes');
    expect(all).not.toContain('Cat bowls');
    const chip = cell(page, THU).locator('.ch-row');
    const [chipBox, cellBox] = [(await chip.boundingBox())!, (await cell(page, THU).boundingBox())!];
    expect(chipBox.width).toBeGreaterThan(cellBox.width - 20);
    expect(chipBox.height, 'slim: one line').toBeLessThanOrEqual(22);
    await expect(chip).toHaveAttribute('data-c', 'yellow');
    expect(await background(chip)).not.toBe('rgba(0, 0, 0, 0)');
    // Mar 14: three chips in one cell, and the cell is as tall as every other (the rows are equal).
    expect((await cell(page, '2027-03-14').boundingBox())!.height).toBeCloseTo((await cell(page, '2027-03-12').boundingBox())!.height, 0);
  });

  test('the circle checks a chip (struck through, its tint faded) and the title cycles the owner of that turn; both write one mark and nothing opens the day', async ({ page }) => {
    await open(page, 'month');
    const chip = cell(page, THU).locator('.ch-row');
    const yellow = await background(chip);
    await cell(page, THU).getByRole('checkbox', { name: 'Complete Litter box deep clean', exact: true }).click();
    await expect(chip).toHaveClass(/ch-done/);
    await expect.poll(stored).toEqual([[THU, 'done']]);
    expect(await chip.locator('.ch-title').evaluate(el => getComputedStyle(el).textDecorationLine)).toBe('line-through');
    expect(await background(chip), 'the tint fades').not.toBe(yellow);
    await expect(chip.locator('.ch-circle')).toBeChecked();
    await cell(page, THU).getByRole('checkbox', { name: 'Reopen Litter box deep clean', exact: true }).click();
    await expect.poll(marks).toEqual([]);
    await cell(page, THU).getByRole('button', { name: `Litter box deep clean, for ${PARTNER_NAME}. Tap to make it for ${OWNER_NAME}`, exact: true }).click();
    await expect(chip).toHaveAttribute('data-c', 'green');
    expect(await background(chip)).not.toBe(yellow);
    await expect.poll(async () => (await marks()).map((m: { owners: string[] }) => m.owners)).toEqual([[OWNER]]);
    await cell(page, THU).getByRole('button', { name: `Litter box deep clean, for ${OWNER_NAME}. Tap to make it for Both`, exact: true }).click();
    await expect(chip).toHaveAttribute('data-c', 'purple');
    await cell(page, THU).getByRole('button', { name: `Litter box deep clean, for Both. Tap to make it for ${PARTNER_NAME}`, exact: true }).click();
    await expect(chip).toHaveAttribute('data-c', 'yellow');
    await expect.poll(marks).toEqual([]);
    // Still the Month, and the chips ignore the picker: the owner's list alone shows the partner's chip.
    await expect(page.locator('.wm-panel[data-panel=month]')).toBeVisible();
    await pickList(page, OWNER_NAME);
    await expect(cell(page, THU).locator('.ch-row')).toHaveCount(1);
    await expect(cell(page, '2027-03-14').locator('.ch-row')).toHaveCount(3);
    await pickList(page, 'Both');
    expect(await overflow(page)).toEqual({ page: 0, sideways: 0, panel: 0 });
  });

  test('the date number is a button that opens that day (with Back to month) and so does the empty part of a cell; a chip never does; there is no button inside a button', async ({ page }) => {
    await open(page, 'month');
    // Not one big button: every cell is a plain box with its number for a button, and nothing interactive is nested in anything interactive.
    expect(await page.locator('.wm-day').evaluateAll(cells => cells.map(el => el.tagName))).toEqual(Array(42).fill('DIV'));
    expect(await page.locator('.wm-days button, .wm-days input, .wm-days a, .wm-days [role=button]').evaluateAll(els => els.filter(el => el.parentElement?.closest('button, a, [role=button], label')).length)).toBe(0);
    await expect(page.locator('.wm-day-num')).toHaveCount(42);
    // The number.
    const other = cell(page, '2027-03-17').getByRole('button', { name: 'Wednesday, March 17, 2027', exact: true });
    await other.click();
    await expect(page.locator('.day-panel')).toBeVisible();
    await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', '2027-03-17');
    await expect(page.getByRole('button', { name: 'Back to month', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back to month', exact: true }).click();
    await expect(page.locator('.wm-panel[data-panel=month]')).toBeVisible();
    await expect(page.locator('#day-title')).toHaveText('March');
    // The empty part of a cell (a day with nothing in it, away from its number).
    const quiet = cell(page, '2027-03-16'), size = (await quiet.boundingBox())!;
    await quiet.click({ position: { x: size.width - 10, y: size.height - 10 } });
    await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', '2027-03-16');
    await expect(page.getByRole('button', { name: 'Back to month', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back to month', exact: true }).click();
    // The empty part of a cell that has chips is the cell too; a chip itself is not.
    const busy = cell(page, '2027-03-14'), busyBox = (await busy.boundingBox())!;
    await busy.getByRole('button', { name: `Kitchen towels, for ${PARTNER_NAME}. Tap to make it for ${OWNER_NAME}`, exact: true }).click();
    await expect(page.locator('.wm-panel[data-panel=month]')).toBeVisible();
    await expect(busy.locator('.ch-row').first()).toHaveAttribute('data-c', 'green');
    await busy.getByRole('button', { name: `Kitchen towels, for ${OWNER_NAME}. Tap to make it for Both`, exact: true }).click();
    await busy.getByRole('button', { name: `Kitchen towels, for Both. Tap to make it for ${PARTNER_NAME}`, exact: true }).click();
    await expect.poll(marks).toEqual([]);
    await busy.click({ position: { x: busyBox.width - 4, y: busyBox.height - 4 } });
    await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', '2027-03-14');
    await page.getByRole('button', { name: 'Back to month', exact: true }).click();
    // A day outside the month opens its Day too.
    await cell(page, '2027-04-01').getByRole('button', { name: 'Thursday, April 1, 2027', exact: true }).click();
    await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', '2027-04-01');
    // Back is to the month that holds the day.
    await page.getByRole('button', { name: 'Back to month', exact: true }).click();
    await expect(page.locator('#day-title')).toHaveText('April');
    await page.locator('#prev-day').click();
    await expect(page.locator('#day-title')).toHaveText('March');
    // The keyboard's way in is the number: Tab reaches it, Enter opens the day.
    await cell(page, '2027-03-02').getByRole('button').first().focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', '2027-03-02');
  });

  test('a title that does not fit ends in an ellipsis on its one line; a cell with more chips than fit scrolls inside itself while the rows and the page stay put', async ({ page }) => {
    const long = 'E2E a chore with a very long title that cannot fit';
    for (const [n, title] of [long, 'E2E two', 'E2E three', 'E2E four', 'E2E five', 'E2E six'].entries()) {
      expect((await owner.post({ action: 'saveChore', id: crypto.randomUUID(), title: title.slice(0, 36), owners: [n % 2 ? OWNER : PARTNER], cadence: { kind: 'weekly', day: 3, weeks: 'A' }, revision: 0 })).status()).toBe(200);
    }
    await open(page, 'month');
    // Wed Mar 10 is a Week A Wednesday: Kitchen wipe-down and the six new rules.
    const busy = cell(page, '2027-03-10'), list = busy.locator('.wm-chores');
    await expect(busy.locator('.ch-row')).toHaveCount(7);
    const title = busy.locator('.ch-title', { hasText: 'E2E a chore with a very long' });
    const clipped = await title.evaluate(el => ({ ellipsis: getComputedStyle(el).textOverflow, nowrap: getComputedStyle(el).whiteSpace, cut: el.scrollWidth > el.clientWidth, height: el.getBoundingClientRect().height }));
    expect(clipped).toMatchObject({ ellipsis: 'ellipsis', nowrap: 'nowrap', cut: true });
    expect(clipped.height, 'one line').toBeLessThanOrEqual(20);
    // Seven chips are more than a cell holds: its list scrolls, to the last one, and nothing else does.
    const scroller = await list.evaluate(el => ({ overflow: getComputedStyle(el).overflowY, more: el.scrollHeight - el.clientHeight }));
    expect(scroller.overflow).toBe('auto');
    expect(scroller.more).toBeGreaterThan(20);
    expect(await overflow(page)).toEqual({ page: 0, sideways: 0, panel: 0 });
    const heights = [(await cell(page, '2027-03-10').boundingBox())!.height, (await cell(page, '2027-03-12').boundingBox())!.height];
    expect(Math.abs(heights[0] - heights[1]), 'the busy cell is as tall as the others').toBeLessThanOrEqual(1);
    await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
    const six = busy.locator('.ch-title', { hasText: 'E2E six' });
    await expect(six).toBeInViewport();
    const [chip, frame] = [(await busy.locator('.ch-row').last().boundingBox())!, (await busy.boundingBox())!];
    expect(chip.y + chip.height, 'the last chip ends inside its cell').toBeLessThanOrEqual(frame.y + frame.height + 1);
    // A check there is a normal one and the cell keeps its scroll.
    await busy.getByRole('checkbox', { name: 'Complete E2E six', exact: true }).click();
    await expect(busy.locator('.ch-row.ch-done')).toHaveCount(1);
    expect(await list.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  });

  // Aug 2027, Jan 2028 and Jul 2028 are the tallest months: six weeks, three of them with a Week A Sunday of three or four chips. They are all ahead of the fixed clock, so nothing is missed or let go.
  for (const [width, height] of [[1280, 800], [1360, 900]]) {
    test(`a busy month fits a window of ${width}x${height} with the sidebar shown: neither the page nor the panel scrolls, and the days of three chips show them all`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await open(page, 'month', '2027-08-15');
      for (const date of ['2027-08-15', '2028-01-15', '2028-07-15']) {
        await page.locator('#jump-date').fill(date);
        await expect(cell(page, date)).toBeVisible();
        expect(await overflow(page), date).toEqual({ page: 0, sideways: 0, panel: 0 });
        const table = (await grid(page).boundingBox())!;
        expect(table.y + table.height, date).toBeLessThanOrEqual(height);
        // Three chips (a Week A Sunday) are whole in their cell: nothing of them scrolls at these sizes.
        const cut = await page.locator('.wm-chores').evaluateAll(lists => lists.filter(el => el.children.length <= 3 && el.scrollHeight > el.clientHeight + 1).length);
        expect(cut, `${date}: cells that scroll`).toBe(0);
      }
    });
  }

  // The owner (2026-11-02): "make the size of the calendar uniform". Whatever the month (a 4-row February with two rows of the next month, a 5-week March, November 2026 and the busy August 2027, both six rows), the six week rows
  // are one height and the Notes in the sixth are no taller than it: the page does not scroll and the Notes' own box scrolls instead.
  for (const [width, height] of [[1280, 800], [1360, 900]]) {
    test(`six equal week rows at ${width}x${height} in every month shape, with the Notes in the sixth and no scroll bar`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await open(page, 'month', '2026-11-15');
      for (const date of ['2026-11-15', '2027-02-15', '2027-03-15', '2027-08-15', '2028-01-15']) {
        await page.locator('#jump-date').fill(date);
        await expect(cell(page, date)).toBeVisible();
        const rows = await grid(page).evaluate(el => getComputedStyle(el).gridTemplateRows.split(' ').map(Number.parseFloat));
        expect(rows, date).toHaveLength(7);
        expect(Math.max(...rows.slice(1)) - Math.min(...rows.slice(1)), `${date}: six equal rows ${rows.slice(1).join(', ')}`).toBeLessThanOrEqual(1);
        const cells = await page.locator('.wm-day:not([data-covered])').evaluateAll(list => list.map(el => el.getBoundingClientRect().height));
        expect(Math.max(...cells) - Math.min(...cells), `${date}: every cell as tall as its row`).toBeLessThanOrEqual(1);
        const [notes, table] = [(await page.locator('.wm-notes').boundingBox())!, (await grid(page).boundingBox())!];
        expect(Math.abs(notes.height - rows[6]), `${date}: the Notes fill the sixth row and no more`).toBeLessThanOrEqual(1);
        expect(notes.y + notes.height, `${date}: the Notes end with the calendar`).toBeLessThanOrEqual(table.y + table.height + 1);
        expect(await overflow(page), date).toEqual({ page: 0, sideways: 0, panel: 0 });
      }
    });
  }

  for (const [width, height] of [[1280, 800], [1360, 900]]) {
    test(`a let go or sent to Friday chip keeps its title readable at ${width}x${height}: the title has room, and the chip that takes the choice back is whole beside or under it`, async ({ page }) => {
      await markTurn('Bedding', '2027-03-14', { state: 'letgo' });
      await markTurn('Kitchen wipe-down', '2027-03-10', { state: 'open', moved: true });
      await page.setViewportSize({ width, height });
      await open(page, 'month');
      for (const [date, kind, title, undo] of [['2027-03-14', 'letgo', 'Bedding', 'Bedding was let go. Undo'], ['2027-03-10', 'moved', 'Kitchen wipe-down', 'Kitchen wipe-down was sent to Friday. Undo']]) {
        const row = cell(page, date).locator(`.ch-row.ch-${kind}`);
        await expect(row).toHaveCount(1);
        const words = row.locator('.ch-title'), back = row.getByRole('button', { name: undo, exact: true });
        const [at, chip, frame] = [(await words.boundingBox())!, (await back.boundingBox())!, (await cell(page, date).boundingBox())!];
        expect(at.width, `${title}: room for the title (4em at least)`).toBeGreaterThanOrEqual(48);
        // The words that fit are whole; the rest ends in an ellipsis, never in a sliver.
        expect(await words.evaluate(el => getComputedStyle(el).textOverflow)).toBe('ellipsis');
        expect(chip.x + chip.width, `${title}: the chip stays inside its cell`).toBeLessThanOrEqual(frame.x + frame.width);
        // A chip that is not on the title's line is under it, and does not overlap it.
        if (chip.y > at.y + at.height - 1) { expect(chip.y).toBeGreaterThanOrEqual(at.y + at.height - 1); } else { expect(chip.x, 'beside it: after the title').toBeGreaterThanOrEqual(at.x + at.width - 1); }
      }
      // The chip still takes it back.
      await cell(page, '2027-03-14').getByRole('button', { name: 'Bedding was let go. Undo', exact: true }).click();
      await expect(cell(page, '2027-03-14').locator('.ch-row.ch-letgo')).toHaveCount(0);
    });
  }

  test('a chip\'s title button says the whole title on hover (a title attribute), since a cell cuts it down to a word or two; the Day\'s list does not need it', async ({ page }) => {
    await markTurn('Bedding', '2027-03-14', { state: 'letgo' });
    await open(page, 'month');
    const tips = await page.locator('.wm-day .ch-row .ch-title').evaluateAll(els => els.map(el => [el.getAttribute('title'), (el.textContent ?? '').trim()]));
    expect(tips.length).toBeGreaterThan(3);
    for (const [tip, words] of tips) { expect(tip).toBe(words); }
    await expect(cell(page, '2027-03-10').locator('button.ch-title', { hasText: 'Kitchen wipe-down' })).toHaveAttribute('title', 'Kitchen wipe-down');
    await page.locator('.view-switch button[data-view=day]').click();
    await picker(page).click();
    await choresSwitch(page).click();
    await expect(page.locator('.day-chores .ch-title').first()).toBeVisible();
    await expect(page.locator('.day-chores .ch-title[title]')).toHaveCount(0);
  });

  test('a missed turn keeps its color with a warning edge, a let go turn is dimmed without a strike, and its chip takes it back', async ({ page }) => {
    await markTurn('Bedding', '2027-03-14', { state: 'letgo' });
    await open(page, 'month');
    const edge = (date: string, index = 0) => cell(page, date).locator('.ch-row').nth(index).evaluate(el => getComputedStyle(el).boxShadow);
    // Mar 7 and Mar 10 are past turns of this chore week, still open; Mar 14 is ahead.
    await expect(cell(page, '2027-03-07').locator('.ch-row')).toHaveAttribute('data-state', 'missed');
    expect(await edge('2027-03-07'), 'a thin left edge').toMatch(/ 3px 0px 0px 0px inset$/);
    expect(await edge('2027-03-10')).toMatch(/ 3px 0px 0px 0px inset$/);
    expect(await edge('2027-03-14')).toBe('none');
    await expect(cell(page, '2027-03-07').locator('.ch-row')).toHaveAttribute('data-c', 'yellow');
    expect(await background(cell(page, '2027-03-07').locator('.ch-row'))).not.toBe('rgba(0, 0, 0, 0)');
    const letgo = cell(page, '2027-03-14').locator('.ch-row.ch-letgo');
    await expect(letgo).toHaveCount(1);
    expect(await letgo.locator('.ch-title').evaluate(el => getComputedStyle(el).textDecorationLine)).toBe('none');
    expect(await letgo.locator('.ch-title').evaluate(el => getComputedStyle(el).color), 'dimmed by the dim color, not by opacity').toBe(await token(page, '--dim'));
    expect(await letgo.evaluate(el => getComputedStyle(el).opacity)).toBe('1');
    await letgo.getByRole('button', { name: 'Bedding was let go. Undo', exact: true }).click();
    await expect(cell(page, '2027-03-14').locator('.ch-row.ch-letgo')).toHaveCount(0);
    await expect.poll(marks).toEqual([]);
  });
});

test('small text of the Day\'s chores and the Month\'s chips clears AA in all four themes (the chips in every state)', async ({ page }) => {
  // The Month needs a done chip and a let go chip next to the missed and open ones; the chips are painted in the owners' tints of each theme.
  const rule = async (title: string) => (await owner.snapshot()).chores.find((r: { title: string }) => r.title === title).id;
  for (const [title, date, state] of [['Dust, then vacuum', '2027-03-07', 'done'], ['Bedding', '2027-03-14', 'letgo']]) {
    expect((await owner.post({ action: 'markChore', ruleId: await rule(title), date, state, moved: false, revision: 0 })).status()).toBe(200);
  }
  await openChores(page);
  await page.getByRole('button', { name: 'Move Mail & papers to Friday', exact: true }).click();
  await expect.poll(async () => (await stored()).filter(([date]: string[]) => date === '2027-03-09')).toEqual([['2027-03-09', 'open']]);
  const SHELL = ['#mode-heading', '#full-date', '#picker-button .picker-name', '.date-row:not(.selected) .date-label', '.date-row.selected .date-label'];
  const VIEWS = {
    day: [...SHELL, '.day-chores .day-label', '.day-chores .ch-title', '.day-chores .ch-label', '.day-chores .ch-chip', '.day-chores .ch-badge', '.day-chores .ch-btn', '.ch-row.ch-moved .ch-title', '.ch-row.ch-moved .ch-undo'],
    month: [
      ...SHELL, '.wm-dow-full', '.wm-day.out .wm-day-num', '.wm-day:not(.out):not(.today) .wm-day-num', '.wm-day.today .wm-day-num',
      '.wm-day .ch-row .ch-title', '.wm-day .ch-row[data-state=missed] .ch-title', '.wm-day .ch-row.ch-done .ch-title', '.wm-day .ch-row.ch-letgo .ch-title', '.wm-day .ch-row.ch-letgo .ch-undo',
    ],
  } as const;
  /** What the check needs on the page, then every selector in every theme. */
  const check = async (label: string, present: readonly string[], selectors: readonly string[], rings: readonly string[] = []) => {
    for (const selector of present) { await expect(page.locator(selector).first(), `${label} ${selector}`).toBeAttached(); }
    for (const theme of Object.keys(THEMES) as ThemeName[]) {
      await showTheme(page, theme, { tints: true });
      for (const selector of selectors) {
        for (const { text, ratio } of await textContrast(page, selector)) { expect(ratio, `${theme} ${label} ${selector} "${text}"`).toBeGreaterThanOrEqual(MIN_CONTRAST); }
      }
      // A check circle is the chip's main control: its ring needs 3:1 against the chip's tint (WCAG 1.4.11), not only the words.
      for (const selector of rings) {
        const seen = await textContrast(page, selector, 'borderTopColor');
        expect(seen.length, `${theme} ${label} ${selector}`).toBeGreaterThan(0);
        for (const { text, ratio } of seen) { expect(ratio, `${theme} ${label} ring ${selector} "${text}"`).toBeGreaterThanOrEqual(MIN_NON_TEXT_CONTRAST); }
      }
    }
  };
  await check('day', ['.day-chores .ch-chip', '.day-chores .ch-badge', '.day-chores .ch-btn', '.day-chores .ch-label'], VIEWS.day);
  // Tuesday shows the row that was sent to Friday: dim, with the chip that takes that back.
  await page.locator('#jump-date').fill('2027-03-09');
  await expect(page.locator('.ch-row.ch-moved')).toBeVisible();
  await check('day (sent to Friday)', ['.ch-row.ch-moved .ch-undo'], VIEWS.day);
  await page.locator('#jump-date').fill(THU);
  await page.locator('.view-switch button[data-view=month]').click();
  await expect(page.locator('.wm-panel[data-panel=month]')).toBeVisible();
  await check('month', ['.wm-day.out', '.wm-day.today', '.wm-day .ch-row[data-state=missed]', '.wm-day .ch-row.ch-done', '.wm-day .ch-row.ch-letgo'], VIEWS.month, ['.wm-day .ch-row:not(.ch-done) .ch-circle']);
  // Pointer targets: the small buttons of the Day keep a comfortable hit area on a desktop too.
  await page.locator('.view-switch button[data-view=day]').click();
  for (const { name, height } of await hitSizes(page, '.day-chores .ch-btn')) { expect(height, name).toBeGreaterThanOrEqual(24); }
});

test.describe('The rhythm', () => {
  const dialogOf = (page: Page) => page.getByRole('dialog', { name: 'The rhythm', exact: true });
  async function openRhythm(page: Page) {
    await page.getByRole('button', { name: /^Lists: / }).click();
    await page.getByRole('button', { name: 'The rhythm…', exact: true }).click();
    await expect(dialogOf(page)).toBeVisible();
    return dialogOf(page);
  }
  const group = (dialog: ReturnType<typeof dialogOf>, index: number) => dialog.locator('.manager-lists').nth(index);
  const rulesOf = (api: Api, title: string) => api.snapshot().then(s => s.chores.filter((r: { title: string }) => r.title === title));

  test('is the item under Manage lists… in the picker menu, reachable by the arrow keys', async ({ page }) => {
    await open(page, 'day');
    await page.getByRole('button', { name: /^Lists: / }).click();
    const manage = page.getByRole('button', { name: 'Manage lists…', exact: true }), rhythm = page.getByRole('button', { name: 'The rhythm…', exact: true });
    const [a, b] = [(await manage.boundingBox())!, (await rhythm.boundingBox())!];
    expect(b.y, 'right under Manage lists').toBeGreaterThanOrEqual(a.y + a.height - 1);
    expect(b.y).toBeLessThanOrEqual(a.y + a.height + 8);
    await manage.focus();
    await page.keyboard.press('ArrowDown');
    await expect(rhythm).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialogOf(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialogOf(page)).toBeHidden();
    await expect(page.getByRole('button', { name: /^Lists: / })).toBeFocused();
  });

  test('five groups holding the 21 seeded rules, and a labelled "This week is" switch; no For control and no explanatory text', async ({ page }) => {
    await open(page, 'day');
    const dialog = await openRhythm(page);
    await expect(dialog.getByRole('heading', { level: 3 })).toHaveText(['Daily (Sun–Fri)', 'Weekly', 'Week A', 'Week B', 'Monthly', 'This week is']);
    for (const [index, count] of [3, 9, 4, 1, 4].entries()) { await expect(group(dialog, index).locator('.rhythm-rule'), `group ${index}`).toHaveCount(count); }
    await expect(dialog.getByRole('button', { name: 'Week A', exact: true }).last()).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByText(/^For$/)).toHaveCount(0);
    await expect(dialog.locator('p:not(.error):not(.manager-row-message)')).toHaveCount(0);
  });

  test('add: a new rule goes to its group, for both of us whatever the picker shows, starting on today\'s weekday', async ({ page }) => {
    await open(page, 'day');
    await pickList(page, OWNER_NAME);
    const title = unique('E2E add');
    const dialog = await openRhythm(page);
    await dialog.getByLabel('New chore in Weekly', { exact: true }).fill(title);
    await expect(dialog.locator('[data-count="add:weekly"]')).toHaveText(`${title.length} / 36`);
    await dialog.getByLabel('New chore in Weekly', { exact: true }).press('Enter');
    const row = group(dialog, 1).locator('.rhythm-rule', { hasText: title });
    await expect(row).toBeVisible();
    // Thursday, as the browser's clock says, and for Both (purple) although the owner's list is what the picker shows.
    await expect(row.locator('.rhythm-text')).toHaveText('Thu');
    await expect(row.getByRole('button', { name: `${title}, for Both. Tap to make it for ${PARTNER_NAME}`, exact: true })).toBeVisible();
    await expect(row.locator('.swatch')).toHaveAttribute('data-c', 'purple');
    expect(await rulesOf(owner, title)).toMatchObject([{ owners: [OWNER, PARTNER], cadence: { kind: 'weekly', day: 4, weeks: 'every' } }]);
    // The add line is empty again and keeps the keyboard; the other groups start the way their name says.
    await expect(dialog.getByLabel('New chore in Weekly', { exact: true })).toHaveValue('');
    await dialog.getByLabel('New chore in Week B', { exact: true }).fill(`${title} b`);
    await dialog.getByLabel('New chore in Week B', { exact: true }).press('Enter');
    await expect(group(dialog, 3).locator('.rhythm-rule', { hasText: `${title} b` })).toBeVisible();
    await dialog.getByLabel('New chore in Monthly', { exact: true }).fill(`${title} m`);
    await dialog.getByLabel('New chore in Monthly', { exact: true }).locator('xpath=following::button[@type="submit"][1]').click();
    await expect(group(dialog, 4).locator('.rhythm-rule', { hasText: `${title} m` })).toBeVisible();
    await dialog.getByLabel('New chore in Daily (Sun–Fri)', { exact: true }).fill(`${title} d`);
    await dialog.getByLabel('New chore in Daily (Sun–Fri)', { exact: true }).press('Enter');
    await expect(group(dialog, 0).locator('.rhythm-rule', { hasText: `${title} d` })).toBeVisible();
    await expect.poll(async () => (await owner.snapshot()).chores.filter((r: { title: string }) => r.title.startsWith(title)).map((r: { title: string; cadence: unknown; owners: string[] }) => [r.title.slice(title.length), r.cadence, r.owners]))
      .toEqual([['', { kind: 'weekly', day: 4, weeks: 'every' }, [OWNER, PARTNER]], [' b', { kind: 'weekly', day: 4, weeks: 'B' }, [OWNER, PARTNER]], [' m', { kind: 'monthly', nth: 1, day: 4, months: 'every' }, [OWNER, PARTNER]], [' d', { kind: 'daily' }, [OWNER, PARTNER]]]);
    // The partner's list picked, or the Day's Chores switch on: still for both of us.
    await page.keyboard.press('Escape');
    await pickList(page, PARTNER_NAME);
    const partner = await openRhythm(page);
    await partner.getByLabel('New chore in Week A', { exact: true }).fill(`${title} ${PARTNER}`);
    await partner.getByLabel('New chore in Week A', { exact: true }).press('Enter');
    await expect.poll(async () => (await rulesOf(owner, `${title} ${PARTNER}`))[0]?.owners).toEqual([OWNER, PARTNER]);
    await page.keyboard.press('Escape');
    await flip(page);
    const inChores = await openRhythm(page);
    await inChores.getByLabel('New chore in Week B', { exact: true }).fill(`${title} chores`);
    await inChores.getByLabel('New chore in Week B', { exact: true }).press('Enter');
    await expect.poll(async () => (await rulesOf(owner, `${title} chores`))[0]?.owners).toEqual([OWNER, PARTNER]);
    await page.keyboard.press('Escape');
    await pickList(page, 'Both');
  });

  test('edit a title in place: Enter saves, Escape cancels, and leaving the row saves', async ({ page }) => {
    await open(page, 'day');
    const title = unique('E2E edit');
    expect((await owner.post({ action: 'saveChore', id: crypto.randomUUID(), title, owners: [OWNER], cadence: { kind: 'daily' }, revision: 0 })).status()).toBe(200);
    await page.reload();
    const dialog = await openRhythm(page);
    await dialog.getByRole('button', { name: `Edit ${title}`, exact: true }).click();
    const input = field(page, `Edit chore: ${title}`);
    await expect(input).toBeFocused();
    await input.fill('x'.repeat(40));
    await expect(dialog.locator('.manager-row-message')).toHaveText('');
    await input.press('Enter');
    await expect(dialog.locator('.manager-row-message')).toHaveText('Keep it to 36 characters.');
    await input.fill(`${title} two`);
    await input.press('Escape');
    await expect(dialog.getByRole('button', { name: `Edit ${title}`, exact: true })).toBeVisible();
    expect(await rulesOf(owner, `${title} two`)).toEqual([]);
    await dialog.getByRole('button', { name: `Edit ${title}`, exact: true }).click();
    await field(page, `Edit chore: ${title}`).fill(`${title} two`);
    await field(page, `Edit chore: ${title}`).press('Enter');
    await expect(dialog.getByRole('button', { name: `Edit ${title} two`, exact: true })).toBeVisible();
    await expect.poll(async () => (await rulesOf(owner, `${title} two`)).length).toBe(1);
    // The focus leaving the row saves as Enter would.
    await dialog.getByRole('button', { name: `Edit ${title} two`, exact: true }).click();
    await field(page, `Edit chore: ${title} two`).fill(`${title} three`);
    await dialog.getByRole('heading', { name: 'The rhythm', exact: true }).click();
    await expect.poll(async () => (await rulesOf(owner, `${title} three`)).length).toBe(1);
    await expect(dialog.getByRole('button', { name: `Edit ${title} three`, exact: true })).toBeVisible();
  });

  test('when: the days, the weeks (a rule that changes week moves to that group) and, for a monthly rule, the 1st to Last, the day and the months', async ({ page }) => {
    await open(page, 'day');
    const title = unique('E2E when');
    expect((await owner.post({ action: 'saveChore', id: crypto.randomUUID(), title, owners: [PARTNER], cadence: { kind: 'weekly', day: 2, weeks: 'every' }, revision: 0 })).status()).toBe(200);
    expect((await owner.post({ action: 'saveChore', id: crypto.randomUUID(), title: `${title} m`, owners: [PARTNER], cadence: { kind: 'monthly', nth: 1, day: 1, months: 'every' }, revision: 0 })).status()).toBe(200);
    await page.reload();
    const dialog = await openRhythm(page);
    await dialog.getByRole('button', { name: `Edit ${title}`, exact: true }).click();
    // The choices of the open row (the "This week is" switch below has a Week A and a Week B of its own).
    const chip = (name: string) => dialog.locator('[data-editing]').getByRole('button', { name, exact: true });
    await expect(chip('Tuesday')).toHaveAttribute('aria-pressed', 'true');
    await expect(chip('Every week')).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByRole('group', { name: 'Which months' })).toHaveCount(0);
    await expect(dialog.locator('[data-editing]').getByRole('group')).toHaveCount(2);
    await chip('Friday').click();
    await expect(chip('Friday')).toHaveAttribute('aria-pressed', 'true');
    await expect(chip('Tuesday')).toHaveAttribute('aria-pressed', 'false');
    await chip('Week B').click();
    // It moved to the Week B group and the row is still open, its title still a field.
    await expect(group(dialog, 3).locator('[data-editing] [data-field=edit]')).toHaveValue(title);
    await expect(group(dialog, 1).locator('[data-editing]')).toHaveCount(0);
    await expect.poll(async () => (await rulesOf(owner, title))[0]?.cadence).toEqual({ kind: 'weekly', day: 5, weeks: 'B' });
    await page.keyboard.press('Escape');
    await expect(group(dialog, 3).locator('.rhythm-rule', { hasText: title }).locator('.rhythm-text')).toHaveText('Fri');
    // A monthly rule: the 2nd Friday of odd months.
    await dialog.getByRole('button', { name: `Edit ${title} m`, exact: true }).click();
    await expect(chip('1st')).toHaveAttribute('aria-pressed', 'true');
    await chip('2nd').click();
    await chip('Friday').click();
    await chip('Odd months').click();
    await expect(chip('Odd months')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await rulesOf(owner, `${title} m`))[0]?.cadence).toEqual({ kind: 'monthly', nth: 2, day: 5, months: 'odd' });
    await chip('Last').click();
    await expect.poll(async () => (await rulesOf(owner, `${title} m`))[0]?.cadence).toMatchObject({ nth: -1 });
    await page.keyboard.press('Escape');
    await expect(group(dialog, 4).locator('.rhythm-rule', { hasText: `${title} m` }).locator('.rhythm-text')).toHaveText('Last Fri · odd');
  });

  test(`the circle cycles a rule's own owner (${PARTNER_NAME}, ${OWNER_NAME}, Both, ${PARTNER_NAME}) and saves each time`, async ({ page }) => {
    await open(page, 'day');
    const title = unique('E2E owner');
    expect((await owner.post({ action: 'saveChore', id: crypto.randomUUID(), title, owners: [PARTNER], cadence: { kind: 'daily' }, revision: 0 })).status()).toBe(200);
    await page.reload();
    const dialog = await openRhythm(page);
    const circle = (who: string, next: string) => dialog.getByRole('button', { name: `${title}, for ${who}. Tap to make it for ${next}`, exact: true });
    await circle(PARTNER_NAME, OWNER_NAME).click();
    await expect(circle(OWNER_NAME, 'Both')).toBeVisible();
    await expect.poll(async () => (await rulesOf(owner, title))[0].owners).toEqual([OWNER]);
    await circle(OWNER_NAME, 'Both').click();
    await expect(circle('Both', PARTNER_NAME)).toBeVisible();
    await expect(circle('Both', PARTNER_NAME).locator('.swatch')).toHaveAttribute('data-c', 'purple');
    await expect.poll(async () => (await rulesOf(owner, title))[0].owners).toEqual([OWNER, PARTNER]);
    await circle('Both', PARTNER_NAME).click();
    await expect(circle(PARTNER_NAME, OWNER_NAME)).toBeVisible();
    await expect.poll(async () => (await rulesOf(owner, title))[0].owners).toEqual([PARTNER]);
  });

  test('delete is the red icon on its second press (it says what goes with the rule), and the first press is forgotten when the focus moves on', async ({ page }) => {
    await open(page, 'day');
    const title = unique('E2E del'), id = crypto.randomUUID();
    expect((await owner.post({ action: 'saveChore', id, title, owners: [OWNER], cadence: { kind: 'daily' }, revision: 0 })).status()).toBe(200);
    expect((await owner.post({ action: 'markChore', ruleId: id, date: THU, state: 'done', moved: false, revision: 0 })).status()).toBe(200);
    await page.reload();
    const dialog = await openRhythm(page);
    await dialog.getByRole('button', { name: `Edit ${title}`, exact: true }).click();
    const trash = dialog.getByRole('button', { name: `Delete chore: ${title}`, exact: true });
    await trash.click();
    await expect(dialog.getByRole('button', { name: 'Confirm delete', exact: true })).toBeVisible();
    await expect(dialog.locator('.manager-del[data-armed]')).toHaveCount(1);
    await expect(dialog.locator('.manager-row-message')).toHaveText(`Delete ${title} with 1 mark?`);
    expect(await rulesOf(owner, title)).toHaveLength(1);
    // Moving on to another part of the row forgets the first press.
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.locator('.manager-del[data-armed]')).toHaveCount(0);
    await expect(dialog.locator('.manager-row-message')).toHaveText('');
    expect(await rulesOf(owner, title)).toHaveLength(1);
    await dialog.getByRole('button', { name: `Delete chore: ${title}`, exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Confirm delete', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Confirm delete', exact: true }).click();
    await expect(dialog.getByRole('button', { name: `Edit ${title}`, exact: true })).toHaveCount(0);
    await expect.poll(async () => (await rulesOf(owner, title)).length).toBe(0);
    // Its marks went with it.
    await expect.poll(marks).toEqual([]);
  });

  test('"This week is" A or B moves the rhythm\'s anchor: this Monday for A, last Monday for B, and the Day\'s chores follow', async ({ page }) => {
    await openChores(page);
    const title = (name: string) => page.locator('.day-chores .ch-title', { hasText: name });
    await expect(title('Kitchen wipe-down')).toHaveCount(1);
    const dialog = await openRhythm(page);
    const letter = (name: string) => dialog.getByRole('group', { name: 'This week is' }).getByRole('button', { name, exact: true });
    await expect(letter('Week A')).toHaveAttribute('aria-pressed', 'true');
    await letter('Week B').click();
    await expect(letter('Week B')).toHaveAttribute('aria-pressed', 'true');
    await expect(letter('Week A')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await owner.snapshot()).rhythm.anchor).toBe('2027-03-01');
    await page.keyboard.press('Escape');
    await expect(dialogOf(page)).toBeHidden();
    // The Missed group now has Wednesday's Week B chore, and no Week A one.
    await expect(title('Bathroom wipe-down')).toHaveCount(1);
    await expect(title('Kitchen wipe-down')).toHaveCount(0);
    const again = await openRhythm(page);
    await again.getByRole('group', { name: 'This week is' }).getByRole('button', { name: 'Week A', exact: true }).click();
    await expect.poll(async () => (await owner.snapshot()).rhythm.anchor).toBe('2027-03-08');
    await expect(title('Kitchen wipe-down')).toHaveCount(1);
    await resetChores(owner, '2027-03');
    expect((await owner.snapshot()).rhythm.anchor).toBe(CHORE_ANCHOR);
  });

  test('the picker\'s overlay box and the rhythm do not disturb each other: an overlay list stays ticked after the dialog closes', async ({ page }) => {
    const id = crypto.randomUUID(), name = unique('E2E ov').slice(0, 20);
    expect((await owner.post({ action: 'saveList', id, name, color: 'teal', revision: 0 })).status()).toBe(200);
    try {
      await open(page, 'day');
      await overlayList(page, name);
      await openRhythm(page);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: /^Lists: / }).click();
      await expect(page.getByRole('checkbox', { name: `Show ${name}`, exact: true })).toBeChecked();
    } finally {
      await owner.post({ action: 'savePrefs', selection: { base: 'both', overlays: [] } });
      const list = (await owner.snapshot()).lists.find((l: { id: string }) => l.id === id);
      if (list) { await owner.post({ action: 'deleteList', id, revision: list.revision, confirm: true }); }
    }
  });
});
