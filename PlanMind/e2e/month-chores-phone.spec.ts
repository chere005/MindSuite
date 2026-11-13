import { expect, test, type Page } from '@playwright/test';
import { MIN_CONTRAST } from '../packages/core/src/planner';
import { THEMES, type ThemeName } from '../app/theme';
import { MIN_NON_TEXT_CONTRAST, apiLogin, login, pickList, resetChores, resetPrefs, showTheme, textContrast, type Api } from './helpers';
import { OWNER, OWNER_NAME, PARTNER_NAME } from './people';

// The planner's Month on a phone (375x812, phone project only): the Calendar tab is the uniform grid with a thin bar in each cell for each chore of that day (three at most and "+n"),
// the month's chores as the Chores page lists them under the grid, all in one scroll, and a tap on a day opens it. The picker has "The rhythm…" on the Day and the Month and not on the Week,
// and never a Chores row. The store is shared by the whole run, so each test fixes the browser's clock to March 2027 (no other spec goes there) and puts back every mark and every rule it made.
// March 2027: Mon Mar 1 starts a Week B; Mon Mar 8 a Week A, whose Sunday (the 14th) has Kitchen towels, Bedding and Couch blankets, whose Wednesday (the 10th) has Kitchen wipe-down.
const THU = '2027-03-11', SUN = '2027-03-14';
const noon = (date: string) => new Date(`${date}T12:00:00-06:00`);
let owner: Api;
test.beforeEach(async ({ baseURL }) => { owner = await apiLogin(baseURL!, OWNER); await resetChores(owner, '2027-03'); });
test.afterEach(async ({ baseURL }) => { await resetChores(owner, '2027-03'); await owner.dispose(); await resetPrefs(baseURL!); });

const marks = async () => (await owner.snapshot()).choreMarks.filter((m: { date: string }) => m.date.startsWith('2027-03'));
const cell = (page: Page, date: string) => page.locator(`.wm-day[data-date="${date}"]`);
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
async function openMonth(page: Page, date = THU) {
  await page.clock.install({ time: noon(THU) });
  await login(page);
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.locator('#pill-date').fill(date);
  await expect(page.locator('.wm-panel[data-panel=month]')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Calendar', exact: true })).toHaveAttribute('aria-selected', 'true');
}
const token = (page: Page, name: string) => page.evaluate(n => { const probe = document.createElement('i'); probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(n); document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; }, name);

test('Calendar tab: the uniform grid (A weeks tinted, Saturday hatched, no dots) with a bar in its owner\'s color for each chore of a day, three at most and "+n" for the rest', async ({ page }) => {
  // Two more Week A Sunday rules make five turns on Mar 14: three bars and "+2".
  for (const title of ['E2E extra one', 'E2E extra two']) {
    expect((await owner.post({ action: 'saveChore', id: crypto.randomUUID(), title, owners: [OWNER], cadence: { kind: 'weekly', day: 0, weeks: 'A' }, revision: 0 })).status()).toBe(200);
  }
  await openMonth(page);
  await expect(page.locator('.wm-day')).toHaveCount(42);
  await expect(page.locator('.wm-dot, .wm-dots, .wm-day-count')).toHaveCount(0);
  await expect(page.locator('.wm-day .ch-row')).toHaveCount(0);
  const bars = (date: string) => cell(page, date).locator('.wm-bar');
  await expect(bars(SUN)).toHaveCount(3);
  await expect(cell(page, SUN).locator('.wm-more')).toHaveText('+2');
  await expect(cell(page, SUN).locator('.wm-day-num')).toHaveAttribute('aria-label', 'Sunday, March 14, 2027, 5 chores');
  await expect(bars('2027-03-10')).toHaveCount(1);
  await expect(cell(page, '2027-03-10').locator('.wm-more')).toHaveCount(0);
  await expect(cell(page, '2027-03-10').locator('.wm-day-num')).toHaveAttribute('aria-label', 'Wednesday, March 10, 2027, 1 chore');
  await expect(bars('2027-03-12')).toHaveCount(0);
  // The color of a bar is its owner's: the partner's yellow, the owner's green, drawn thin and rounded.
  expect(await bars(SUN).evaluateAll(list => list.map(el => (el as HTMLElement).dataset.c))).toEqual(['yellow', 'yellow', 'yellow']);
  expect(await bars('2027-03-10').first().evaluate(el => (el as HTMLElement).dataset.c)).toBe('green');
  // Painted in the tint's text color, the one the themes hold well above 3:1 against a cell (the tint's own line color is not).
  expect(await bars(SUN).first().evaluate(el => getComputedStyle(el).backgroundColor)).toBe(await token(page, '--c-yellow-fg'));
  const bar = (await bars(SUN).first().boundingBox())!, box = (await cell(page, SUN).boundingBox())!;
  expect(bar.height).toBeLessThanOrEqual(6);
  expect(bar.width).toBeGreaterThan(box.width - 16);
  // Equal columns (Saturday included), cells that hold their bars, and the page that fits the width.
  const widths = await page.locator('.wm-day').evaluateAll(cells => cells.map(el => el.getBoundingClientRect().width));
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  expect(box.width).toBeGreaterThan(48);
  for (const el of await page.locator('.wm-day').all()) { await expect(el).toBeInViewport(); }
  expect(await noHorizontalScroll(page)).toBe(true);
  // A weeks are the tinted rows, B weeks plain, a day outside the month none; a Saturday hatched in or out of the month.
  const background = (date: string) => cell(page, date).evaluate(el => getComputedStyle(el).backgroundColor);
  expect(await background('2027-03-09')).not.toBe(await background('2027-03-02'));
  expect(await background('2027-03-16')).toBe(await background('2027-03-02'));
  expect(await background('2027-04-01')).toBe(await token(page, '--bg'));
  for (const date of ['2027-03-13', '2027-03-06', '2027-04-03']) { expect(await cell(page, date).evaluate(el => getComputedStyle(el).backgroundImage), date).toContain('repeating-linear-gradient'); }
  expect(await cell(page, '2027-03-12').evaluate(el => getComputedStyle(el).backgroundImage)).toBe('none');
  // Today is a filled accent circle; the weekday heads are the one letters.
  expect(await cell(page, THU).locator('.wm-day-num').evaluate(el => getComputedStyle(el).backgroundColor)).toBe(await token(page, '--accent'));
  await expect(page.locator('.wm-dow-letter')).toHaveText(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
});

test('under the grid: the month\'s chores as the Chores page lists them (Monthly, then each week), scrolling with the tab; a circle checks one (its bar fades), the title cycles its owner, the date opens that day', async ({ page }) => {
  await openMonth(page);
  const list = page.locator('.wm-chorelist');
  await expect(list).toBeVisible();
  const [grid, below] = [(await page.locator('.wm-days').boundingBox())!, (await list.boundingBox())!];
  expect(below.y, 'the list is under the grid').toBeGreaterThanOrEqual(grid.y + grid.height - 1);
  const labels = await list.locator('.ch-label').allTextContents();
  expect(labels[0]).toBe('Monthly');
  expect(labels.slice(1).every(label => /^[A-Z][a-z]{2} \d+–(?:[A-Z][a-z]{2} )?\d+ · Week [AB]$/.test(label))).toBe(true);
  // Every turn of the month, a date chip on each: the same set the cells draw bars for (a cell's bars are the first three of its turns).
  const dates = await list.locator('.ch-row').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.date!));
  expect(dates.length).toBeGreaterThan(8);
  expect(dates.every(date => date.startsWith('2027-03'))).toBe(true);
  for (const date of new Set(dates)) { expect(await cell(page, date).locator('.wm-bar').count(), date).toBe(Math.min(3, dates.filter(d => d === date).length)); }
  // One scroll for the tab: the body scrolls, the bar stays where it is, nothing else moves.
  const body = page.locator('.wm-body'), bar = page.locator('.wm-tabs');
  const barAt = (await bar.boundingBox())!;
  expect(await body.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(list.locator('.ch-row').last()).toBeInViewport();
  expect(await bar.boundingBox()).toEqual(barAt);
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
  expect(await noHorizontalScroll(page)).toBe(true);
  await body.evaluate(el => { el.scrollTop = 0; });
  // The circle: the row is struck through and the cell's bar fades; the write is one mark. The grid keeps its place.
  const bars = cell(page, THU).locator('.wm-bar');
  await expect(bars).toHaveCount(1);
  await expect(bars).toHaveAttribute('data-state', /upcoming|today|missed|open/);
  const strong = await bars.evaluate(el => getComputedStyle(el).opacity);
  await page.getByRole('checkbox', { name: 'Complete Litter box deep clean', exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole('checkbox', { name: 'Complete Litter box deep clean', exact: true }).click();
  await expect(list.locator('.ch-row.ch-done')).toHaveCount(1);
  await expect(bars).toHaveAttribute('data-state', 'done');
  expect(Number(await bars.evaluate(el => getComputedStyle(el).opacity))).toBeLessThan(Number(strong));
  await expect.poll(async () => (await marks()).map((m: { date: string; state: string }) => [m.date, m.state])).toEqual([[THU, 'done']]);
  await page.getByRole('checkbox', { name: 'Reopen Litter box deep clean', exact: true }).click();
  await expect.poll(marks).toEqual([]);
  // The title cycles that one turn's owner, and the bar takes its color.
  await page.getByRole('button', { name: `Litter box deep clean, for ${PARTNER_NAME}. Tap to make it for ${OWNER_NAME}`, exact: true }).click();
  await expect(bars).toHaveAttribute('data-c', 'green');
  await expect.poll(async () => (await marks()).map((m: { owners: string[] }) => m.owners)).toEqual([[OWNER]]);
  await page.getByRole('button', { name: `Litter box deep clean, for ${OWNER_NAME}. Tap to make it for Both`, exact: true }).click();
  await page.getByRole('button', { name: `Litter box deep clean, for Both. Tap to make it for ${PARTNER_NAME}`, exact: true }).click();
  await expect(bars).toHaveAttribute('data-c', 'yellow');
  await expect.poll(marks).toEqual([]);
  // The date chip opens that day on the Day, with Back to month where the menu was.
  await page.getByRole('button', { name: 'Open Sun 21', exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Open Sun 21', exact: true }).tap();
  await expect(page.locator('.day-panel')).toBeVisible();
  await expect(page.locator('#date-pill')).toHaveText('Sun, Mar 21');
  await expect(page.getByRole('button', { name: 'Back to month', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to month', exact: true }).tap();
  await expect(page.locator('.wm-panel[data-panel=month]')).toBeVisible();
  await expect(page.locator('#date-pill')).toHaveText('March 2027');
});

test('a tap on a day opens it (the number, a bar or the empty part of its cell), as it does today; the other tabs and the Chores tab are as they were', async ({ page }) => {
  await openMonth(page);
  for (const [date, where] of [[SUN, 'the cell'], ['2027-03-16', 'an empty day'], ['2027-04-01', 'a day outside the month']] as const) {
    await cell(page, date).tap();
    await expect(page.locator('.day-panel'), where).toBeVisible();
    await expect(page.locator('#date-pill')).toHaveText(new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }));
    await expect(page.getByRole('button', { name: 'Back to month', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back to month', exact: true }).tap();
    await expect(page.locator('.wm-panel[data-panel=month]')).toBeVisible();
  }
  // A day of the next month shown in the grid takes Back to that month: April.
  await expect(page.locator('#date-pill')).toHaveText('April 2027');
  await page.getByRole('button', { name: 'Previous month', exact: true }).tap();
  await expect(page.locator('#date-pill')).toHaveText('March 2027');
  await cell(page, SUN).locator('.wm-day-num').tap();
  await expect(page.locator('.day-panel')).toBeVisible();
  await page.getByRole('button', { name: 'Back to month', exact: true }).tap();
  // Tabs: Calendar | Priorities | To-do | Notes | Chores. The list belongs to the Calendar tab only.
  const tabs = page.getByRole('tablist', { name: 'Month sections' });
  await expect(tabs.getByRole('tab')).toHaveCount(5);
  await expect(tabs.getByRole('tab').evaluateAll(list => list.map(el => el.getAttribute('aria-label')))).resolves.toEqual(['Calendar', 'Priorities', 'To-do', 'Notes', 'Chores']);
  await expect(page.locator('.wm-chorelist')).toBeVisible();
  for (const name of ['Priorities', 'To-do', 'Notes']) {
    await tabs.getByRole('tab', { name, exact: true }).tap();
    await expect(page.locator('.wm-chorelist'), name).toBeHidden();
    await expect(page.locator('.wm-days'), name).toBeHidden();
  }
  await tabs.getByRole('tab', { name: 'Calendar', exact: true }).tap();
  await expect(page.locator('.wm-chorelist')).toBeVisible();
  // The Chores tab is the Chores view's Month: the same list, on a page of its own with the Month's bar.
  await tabs.getByRole('tab', { name: 'Chores', exact: true }).tap();
  await expect(page.locator('.ch-view[data-period=month] .ch-month')).toBeVisible();
  await expect(page.locator('.wm-days')).toHaveCount(0);
  await tabs.getByRole('tab', { name: 'Calendar', exact: true }).tap();
  await expect(page.locator('.wm-days')).toBeVisible();
});

test('the chores ignore the picker on the Calendar tab, and its menu has "The rhythm…" on the Day and the Month, not on the Week, and no Chores row anywhere', async ({ page }) => {
  await openMonth(page);
  const bars = () => page.locator('.wm-bar').evaluateAll(list => list.length);
  const all = await bars();
  expect(all).toBeGreaterThan(5);
  await pickList(page, PARTNER_NAME);
  expect(await bars(), `${PARTNER_NAME}'s list alone`).toBe(all);
  await pickList(page, 'Both');
  const menu = page.getByRole('group', { name: 'Lists', exact: true });
  const rhythm = page.getByRole('button', { name: 'The rhythm…', exact: true });
  const probe = async (view: 'Day' | 'Week' | 'Month', present: boolean) => {
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await page.getByRole('button', { name: view, exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Lists: / }).tap();
    await expect(menu).toBeVisible();
    await expect(rhythm, view).toHaveCount(present ? 1 : 0);
    await expect(page.getByRole('switch'), view).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Chores', exact: true }), view).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Manage lists…', exact: true }), view).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  };
  await probe('Day', true);
  await probe('Week', false);
  await probe('Month', true);
});

test('the "+n", the date numbers and the bars clear AA in all four themes, on the tinted rows, the plain rows, the hatch and today', async ({ page }) => {
  for (const title of ['E2E extra one', 'E2E extra two']) {
    expect((await owner.post({ action: 'saveChore', id: crypto.randomUUID(), title, owners: [OWNER], cadence: { kind: 'weekly', day: 0, weeks: 'A' }, revision: 0 })).status()).toBe(200);
  }
  await openMonth(page);
  await expect(page.locator('.wm-more').first()).toBeVisible();
  for (const theme of Object.keys(THEMES) as ThemeName[]) {
    await showTheme(page, theme, { tints: true });
    for (const selector of ['.wm-more', '.wm-day.out .wm-day-num', '.wm-day:not(.out):not(.today) .wm-day-num', '.wm-day.today .wm-day-num', '.wm-day[data-sat]:not(.out) .wm-day-num', '.wm-dow-letter', '.wm-chorelist .ch-label', '.wm-chorelist .ch-title', '.wm-chorelist .ch-date']) {
      const seen = await textContrast(page, selector);
      expect(seen.length, `${theme} ${selector}`).toBeGreaterThan(0);
      for (const { text, ratio } of seen) { expect(ratio, `${theme} ${selector} "${text}"`).toBeGreaterThanOrEqual(MIN_CONTRAST); }
    }
    // A bar is the only sign of a chore in its cell: an open (or missed) one is 3:1 against the cell it is on (WCAG 1.4.11), the partner's yellow and the owner's green, on a tinted row, a plain row and today's cell. The faded bars of done, sent away and let go turns are decoration beside the list below.
    const open = '.wm-bar:not([data-state=done]):not([data-state=letgo]):not([data-state=moved])';
    const colors = new Set<string>();
    for (const date of ['2027-03-14', '2027-03-10', '2027-03-17', THU]) {
      const seen = await textContrast(page, `.wm-day[data-date="${date}"] ${open}`, 'backgroundColor');
      expect(seen.length, `${theme} ${date} bars`).toBeGreaterThan(0);
      for (const { ratio } of seen) { expect(ratio, `${theme} ${date} bar`).toBeGreaterThanOrEqual(MIN_NON_TEXT_CONTRAST); }
      for (const c of await page.locator(`.wm-day[data-date="${date}"] ${open}`).evaluateAll(els => els.map(el => (el as HTMLElement).dataset.c!))) { colors.add(c); }
    }
    expect([...colors].sort(), 'both owners\' colors were measured').toEqual(expect.arrayContaining(['green', 'yellow']));
  }
});
