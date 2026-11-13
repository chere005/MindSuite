import { expect, test, type Browser, type Page } from '@playwright/test';
import { MIN_CONTRAST, weekLetter } from '../packages/core/src/planner';
import { THEMES, type ThemeName } from '../app/theme';
import { CHORE_ANCHOR, MIN_NON_TEXT_CONTRAST, apiLogin, hitSizes, login, pickList, resetChores, resetPrefs, showTheme, textContrast, unique, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// The chores on a phone (375px, phone project only): the Chores tab of the Day, Week and Month bars takes the whole page over (the Chores view,
// the period's bar still at the bottom, the picker a grey locked house) and the other tabs bring the planner back. The store is shared by the whole run, so every test fixes the browser's clock to March 2027 (no other spec goes there), and removes every
// mark it makes and every rule it adds. In that month Mon Mar 8 starts a Week A (the rhythm's anchor is Nov 2 2026, 18 weeks earlier), so
// Thu Mar 11 is the 2nd Thursday of a Week A: its own chores are Dishes, Trash & recycling, Wipe the table, Cat bowls, Fresh litter + liner
// and Litter box deep clean, and what the week missed since Sunday is Laundry, Vacuum, Dust then vacuum, Clutter reset, Mail & papers,
// Fridge clean-out, Bins to the curb and Kitchen wipe-down (a daily chore missed is let go the next day, and Monday's Cat bowls once Thursday's comes).
const SUN = '2027-03-07', THU = '2027-03-11', FRI = '2027-03-12', SAT = '2027-03-13';
const noon = (date: string) => new Date(`${date}T12:00:00-06:00`);
const TODAY_OWN = ['Dishes', 'Trash & recycling', 'Wipe the table', 'Cat bowls', 'Fresh litter + liner', 'Litter box deep clean'];
const MISSED = ['Laundry', 'Vacuum', 'Dust, then vacuum', 'Clutter reset', 'Mail & papers', 'Fridge clean-out', 'Bins to the curb', 'Kitchen wipe-down'];

const reset = (api: Api) => resetChores(api, '2027-03');
const marks = async (api: Api) => (await api.snapshot()).choreMarks.filter((m: { date: string }) => m.date.startsWith('2027-03'));
/** The id of the seeded rule with this title (on this weekday when two share it, as Cat bowls does on Monday and Thursday). */
const ruleId = async (api: Api, title: string, day?: number) =>
  (await api.snapshot()).chores.find((r: { title: string; cadence: { day?: number } }) => r.title === title && (day === undefined || r.cadence.day === day)).id as string;

let owner: Api;
test.beforeEach(async ({ baseURL }) => { owner = await apiLogin(baseURL!, OWNER); await reset(owner); });
test.afterEach(async ({ baseURL }) => { await reset(owner); await owner.dispose(); await resetPrefs(baseURL!); });

const rows = (page: Page) => page.locator('.ch-view .ch-row');
const titles = (page: Page) => page.locator('.ch-view .ch-row .ch-title').allTextContents();
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
/** The Day's Chores tab on `date`, with the browser's clock on `today`. */
async function openChores(page: Page, today: string, date = today) {
  await page.clock.install({ time: noon(today) });
  await login(page);
  await page.locator('#pill-date').fill(date);
  await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', date);
  await page.getByRole('tab', { name: 'Chores', exact: true }).tap();
  await expect(page.locator('.ch-view[data-period=day]')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Chores', exact: true })).toHaveAttribute('aria-selected', 'true');
}
async function switchView(page: Page, view: 'Day' | 'Week' | 'Month') {
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await page.getByRole('button', { name: view, exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/drawer-open/);
}

/** Every row is one line: its title never wraps (it gives way to the badge with an ellipsis), its badge and buttons stay inside the row and in order, and
 *  the tab still fits one screen: the list does not scroll, the tab bar is on the screen and nothing scrolls sideways or down the page. */
async function oneLine(page: Page, label: string) {
  const seen = await rows(page).evaluateAll(list => list.map(row => {
    const box = (selector: string) => row.querySelector(selector)?.getBoundingClientRect() ?? null, line = row.getBoundingClientRect();
    const title = row.querySelector<HTMLElement>('.ch-title')!, badge = box('.ch-badge'), buttons = [...row.querySelectorAll('.ch-btn')].map(b => b.getBoundingClientRect());
    const after = [badge, ...buttons].filter((b): b is DOMRect => !!b);
    // The title's own text, line by line: a title cut by its ellipsis is one line, a wrapped one would be two.
    const range = document.createRange();
    range.selectNodeContents(title);
    return {
      name: title.textContent!, lines: new Set([...range.getClientRects()].map(q => Math.round(q.top))).size, height: line.height, right: Math.max(...after.map(b => b.right), 0) - line.right,
      ordered: after.every((b, i) => i === 0 || after[i - 1].right <= b.left + 0.5), badgeAfterTitle: !badge || badge.left >= title.getBoundingClientRect().right - 0.5,
    };
  }));
  for (const row of seen) {
    expect(row.lines, `${label} ${row.name} wraps`).toBe(1);
    expect(row.height, `${label} ${row.name} height`).toBeLessThanOrEqual(34.1);
    expect(row.right, `${label} ${row.name} runs out of the row`).toBeLessThanOrEqual(0.5);
    expect(row.ordered, `${label} ${row.name} badge, then buttons`).toBe(true);
    expect(row.badgeAfterTitle, `${label} ${row.name} badge after its title`).toBe(true);
  }
  expect(await noHorizontalScroll(page), `${label} sideways`).toBe(true);
  const fit = await page.evaluate(() => {
    const list = document.querySelector('.ch-view .ch-list')!, bar = document.querySelector('.day-tabs')!.getBoundingClientRect();
    return { list: list.scrollHeight - list.clientHeight, bar: bar.bottom - innerHeight, page: document.documentElement.scrollHeight - innerHeight };
  });
  expect(fit.list, `${label} list scrolls`).toBeLessThanOrEqual(1);
  expect(fit.bar, `${label} tab bar off the screen`).toBeLessThanOrEqual(0.5);
  expect(fit.page, `${label} page scrolls`).toBeLessThanOrEqual(0);
}

test('the week letters of the days used here are what the spec above says', () => {
  expect(weekLetter(THU, CHORE_ANCHOR)).toBe('A');
  expect(weekLetter('2027-03-01', CHORE_ANCHOR)).toBe('B');
});

test('the tab bars: Day has four tabs, Week three (every label shown), Month five (the chosen label alone); all fit 375px and are finger-sized, in the planner and in the Chores view alike', async ({ page }) => {
  await page.clock.install({ time: noon(THU) });
  await login(page);
  const day = page.getByRole('tablist', { name: 'Day sections' });
  await expect(day.getByRole('tab')).toHaveText(['Schedule', 'To-do', 'Notes', 'Chores']);
  for (const tab of await day.getByRole('tab').all()) { await expect(tab.locator('span')).toBeVisible(); }
  // The drawer that switched the view may still be closing: the size is read once nothing covers the tab.
  const target = async (selector: string, count: number) => {
    await expect.poll(async () => {
      const found = await hitSizes(page, selector);
      return found.length === count ? Math.min(...found.flatMap(({ width, height }) => [width, height])) : -1;
    }, { message: `${selector}: ${count} targets, each at least 44px each way` }).toBeGreaterThanOrEqual(44);
  };
  /** The bar's tabs as the planner draws them, then as the Chores view draws them: the same names, labels, sizes and place. */
  const same = async (name: string, tabs: string, count: number, labels: string[]) => {
    const bar = page.getByRole('tablist', { name });
    const planner = (await bar.boundingBox())!, chosen = await bar.locator('[aria-selected=true]').innerText();
    await target(tabs, count);
    expect(planner.x + planner.width).toBeLessThanOrEqual(375);
    expect(await noHorizontalScroll(page)).toBe(true);
    await bar.getByRole('tab', { name: 'Chores', exact: true }).tap();
    await expect(page.locator('.ch-view')).toBeVisible();
    await expect(bar.getByRole('tab', { name: 'Chores', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(bar.getByRole('tab')).toHaveCount(count);
    await expect(bar.locator('span:visible')).toHaveText(labels);
    const view = (await bar.boundingBox())!;
    expect([view.x, view.y, view.width, view.height], `${name} in the Chores view is where the planner draws it`).toEqual([planner.x, planner.y, planner.width, planner.height]);
    await target(tabs, count);
    expect(await noHorizontalScroll(page)).toBe(true);
    // Back by the tab the planner had chosen.
    await bar.getByRole('tab').filter({ hasText: chosen }).first().tap();
    await expect(page.locator('.ch-view')).toHaveCount(0);
  };
  await same('Day sections', '.day-tab', 4, ['Schedule', 'To-do', 'Notes', 'Chores']);

  await switchView(page, 'Week');
  const week = page.getByRole('tablist', { name: 'Week sections' });
  await expect(week.getByRole('tab')).toHaveText(['Priorities', 'To-do', 'Chores']);
  for (const tab of await week.getByRole('tab').all()) { await expect(tab.locator('span')).toBeVisible(); }
  await same('Week sections', '.wm-tabs [role=tab]', 3, ['Priorities', 'To-do', 'Chores']);

  await switchView(page, 'Month');
  const month = page.getByRole('tablist', { name: 'Month sections' });
  await expect(month.getByRole('tab')).toHaveCount(5);
  await expect(month.locator('span:visible')).toHaveText(['Calendar']);
  await same('Month sections', '.wm-tabs [role=tab]', 5, ['Chores']);
});

test('a tab names only a section that is on the page (aria-controls): the planner\'s Chores tab controls none, the Chores view\'s bar controls just the Chores page', async ({ page }) => {
  await page.clock.install({ time: noon(THU) });
  await login(page);
  /** Each tab of the bar: its label, what it controls (null for nothing) and whether that is an element of the page. */
  const controls = (name: string) => page.getByRole('tablist', { name }).getByRole('tab').evaluateAll(tabs => tabs.map(tab => {
    const id = tab.getAttribute('aria-controls');
    return { tab: tab.getAttribute('aria-label') ?? tab.textContent!.trim(), id, there: id === null ? null : document.getElementById(id) !== null };
  }));
  const check = async (name: string, labels: string[]) => {
    const planner = await controls(name);
    expect(planner.map(c => c.tab), `${name}: the tabs`).toEqual(labels);
    for (const c of planner) {
      if (c.tab === 'Chores') { expect(c.id, `${name}: the Chores tab of the planner controls nothing`).toBeNull(); } else { expect(c.there, `${name}: ${c.tab} controls a section that is there (${c.id})`).toBe(true); }
    }
    const bar = page.getByRole('tablist', { name });
    await bar.getByRole('tab', { name: 'Chores', exact: true }).tap();
    await expect(page.locator('.ch-view')).toBeVisible();
    for (const c of await controls(name)) {
      if (c.tab === 'Chores') { expect(c.there, `${name}: in the Chores view the Chores tab controls its page (${c.id})`).toBe(true); } else { expect(c.id, `${name}: ${c.tab} has no section in the Chores view`).toBeNull(); }
    }
    await bar.getByRole('tab').first().tap();
    await expect(page.locator('.ch-view')).toHaveCount(0);
  };
  await check('Day sections', ['Schedule', 'To-do', 'Notes', 'Chores']);
  await switchView(page, 'Week');
  await check('Week sections', ['Priorities', 'To-do', 'Chores']);
  await switchView(page, 'Month');
  await check('Month sections', ['Calendar', 'Priorities', 'To-do', 'Notes', 'Chores']);
});

test('Chores takes the whole page over: the planner has no chore markup, the picker is a grey locked house, and another tab brings the planner back', async ({ page }) => {
  await page.clock.install({ time: noon(THU) });
  await login(page);
  const picker = page.getByRole('button', { name: /^Lists: / });
  // The planner's Day and Week: no chore markup anywhere, no Chores row in the picker menu. The Month's calendar carries the month's chores (bars in its cells, the list under
  // its grid: see month-chores-phone.spec.ts), and is still the planner: no Chores page.
  const chorey = () => page.locator('.ch-view, .ch-row, .ch-list, .wm-chore, [class*="chore"]');
  await expect(chorey()).toHaveCount(0);
  await picker.tap();
  await expect(page.getByRole('button', { name: 'Chores', exact: true })).toHaveCount(0);
  await expect(page.getByRole('switch')).toHaveCount(0);
  await expect(page.locator('.picker-row[data-kind=chores]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await switchView(page, 'Week');
  await expect(chorey()).toHaveCount(0);
  await switchView(page, 'Month');
  await expect(page.locator('.ch-view')).toHaveCount(0);
  await expect(page.locator('.wm-bar').first()).toBeVisible();
  await expect(page.locator('.wm-chorelist .ch-row').first()).toBeVisible();
  await switchView(page, 'Day');

  await page.getByRole('tab', { name: 'Chores', exact: true }).tap();
  await expect(page.locator('.ch-view[data-layout=phone][data-period=day]')).toBeVisible();
  await expect(page.locator('.day-panel')).toHaveCount(0);
  // The round picker is a grey, locked Chores button: named, not expandable, and a tap on it does nothing.
  const locked = page.getByRole('button', { name: 'Chores', exact: true }).first();
  await expect(page.locator('#picker-button')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#picker-button')).toHaveAccessibleName('Chores');
  await expect(page.locator('#picker-button')).not.toHaveAttribute('aria-expanded', /.*/);
  await expect(locked).toBeVisible();
  // (force: Playwright waits for an aria-disabled control to be enabled; a finger just taps.)
  await page.locator('#picker-button').tap({ force: true });
  await expect(page.locator('#picker-menu')).toBeHidden();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await hitSizes(page, '#picker-button'))[0].width).toBeGreaterThanOrEqual(44);

  // Changing the period (the arrows, the date sheet, the drawer's Day / Week / Month) stays on Chores.
  const pillText = () => page.locator('#date-pill').innerText();
  const before = await pillText();
  await page.getByRole('button', { name: 'Next day', exact: true }).tap();
  await expect(page.locator('.ch-view[data-period=day]')).toBeVisible();
  expect(await pillText()).not.toBe(before);
  await page.getByRole('button', { name: 'Previous day', exact: true }).tap();
  await page.locator('#date-pill').tap();
  const sheet = page.getByRole('dialog', { name: 'Choose a day', exact: true });
  await sheet.locator('[data-date="2027-03-16"]').tap();
  await expect(sheet).toBeHidden();
  await expect(page.locator('.ch-view[data-period=day]')).toBeVisible();
  await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', '2027-03-16');
  await switchView(page, 'Week');
  await expect(page.locator('.ch-view[data-period=week]')).toBeVisible();
  await expect(page.locator('#picker-button')).toHaveAttribute('aria-disabled', 'true');
  await switchView(page, 'Month');
  await expect(page.locator('.ch-view[data-period=month]')).toBeVisible();
  await switchView(page, 'Day');
  await expect(page.locator('.ch-view[data-period=day]')).toBeVisible();

  // Another tab leaves: that tab of the planner, and the normal picker.
  await page.getByRole('tab', { name: 'Notes', exact: true }).tap();
  await expect(page.locator('.ch-view')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Notes', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.day-notes')).toBeVisible();
  await expect(page.locator('#picker-button')).not.toHaveAttribute('aria-disabled', /.*/);
  await expect(picker).toBeVisible();
  await page.getByRole('tab', { name: 'Chores', exact: true }).tap();
  await expect(page.locator('.ch-view')).toBeVisible();
  await page.getByRole('tab', { name: 'To-do', exact: true }).tap();
  await expect(page.getByRole('tab', { name: 'To-do', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.day-todo')).toBeVisible();
});

test(`always both: ${OWNER_NAME}'s picker, ${PARTNER_NAME}'s account and a custom list all show every chore, and entering Chores leaves the stored selection alone`, async ({ page, browser, baseURL }) => {
  const id = crypto.randomUUID(), name = unique('E2E list').slice(0, 20);
  expect((await owner.post({ action: 'saveList', id, name, color: 'blue', revision: 0 })).status()).toBe(200);
  const partner = await partnerPage(browser, baseURL!, THU);
  try {
    await openChores(page, THU);
    await expect.poll(() => titles(page).then(list => list.length)).toBe(TODAY_OWN.length + MISSED.length);
    await page.getByRole('tab', { name: 'To-do', exact: true }).tap();
    for (const who of [OWNER_NAME, PARTNER_NAME, name]) {
      await pickList(page, who);
      await page.getByRole('tab', { name: 'Chores', exact: true }).tap();
      await expect(page.locator('.ch-view')).toBeVisible();
      expect(await titles(page), `with ${who} picked`).toEqual([...TODAY_OWN, ...MISSED]);
      await page.getByRole('tab', { name: 'To-do', exact: true }).tap();
      // The pick was not changed by being on Chores.
      await expect(page.getByRole('button', { name: `Lists: ${who}`, exact: true })).toBeVisible();
    }
    // The partner's own account lists the owner's chores too.
    expect(await partner.locator('.ch-view .ch-row .ch-title').allTextContents()).toEqual([...TODAY_OWN, ...MISSED]);
  } finally {
    await partner.context().close();
    await owner.post({ action: 'savePrefs', selection: { base: 'both', overlays: [] } });
    const list = (await owner.snapshot()).lists.find((l: { id: string }) => l.id === id);
    if (list) { await owner.post({ action: 'deleteList', id, revision: list.revision, confirm: true }); }
  }
});

test.describe('the Day in the Chores view', () => {
  test('lists the day\'s own chores, then what the week missed; a circle in the owner\'s color checks one off and a tap again takes it back', async ({ page }) => {
    await openChores(page, THU);
    await expect(page.locator('.ch-view .ch-label')).toHaveText(['Missed']);
    expect(await titles(page)).toEqual([...TODAY_OWN, ...MISSED]);
    // The chips on the Day are the cadence badge, "from ...", "→ Fri" and "Let go": Dishes is daily, so it carries none; Kitchen wipe-down is a Week A chore.
    await expect(rows(page).filter({ hasText: 'Dishes' }).locator('.ch-chip')).toHaveCount(0);
    await expect(rows(page).filter({ hasText: 'Kitchen wipe-down' }).locator('.ch-chip')).toHaveText(['Week A']);
    // Owner colors: Dishes is the owner's (green), Trash & recycling the partner's (yellow), Mail & papers is for both of us (purple).
    await expect(rows(page).filter({ hasText: 'Dishes' })).toHaveAttribute('data-c', 'green');
    await expect(rows(page).filter({ hasText: 'Trash & recycling' })).toHaveAttribute('data-c', 'yellow');
    await expect(rows(page).filter({ hasText: 'Mail & papers' })).toHaveAttribute('data-c', 'purple');
    // No add line, no title edit, no delete on the Day.
    await expect(page.locator('.ch-view input:not([type=checkbox]), .ch-view .ch-add, .ch-view .ip-del')).toHaveCount(0);

    const dishes = page.getByRole('checkbox', { name: 'Complete Dishes', exact: true });
    await dishes.click();
    const done = rows(page).filter({ hasText: 'Dishes' });
    await expect(done).toHaveClass(/ch-done/);
    await expect(page.getByRole('checkbox', { name: 'Reopen Dishes', exact: true })).toBeChecked();
    // The done pile is the last of the list, after what was missed too.
    expect((await titles(page)).at(-1)).toBe('Dishes');
    const stored = await marks(owner);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ ruleId: await ruleId(owner, 'Dishes'), date: THU, state: 'done', moved: false });
    await page.getByRole('checkbox', { name: 'Reopen Dishes', exact: true }).click();
    await expect(rows(page).filter({ hasText: 'Dishes' })).not.toHaveClass(/ch-done/);
    expect((await titles(page)).slice(0, 3)).toEqual(['Dishes', 'Trash & recycling', 'Wipe the table']);
    await expect.poll(() => marks(owner)).toEqual([]);
  });

  test('a weekly, Week A / Week B or monthly row wears a quiet badge before its other chips, a daily row has none, and no title wraps or leaves the 375px screen', async ({ page }) => {
    await openChores(page, THU);
    const badges = () => rows(page).evaluateAll(list => list.map(row => [row.querySelector('.ch-title')!.textContent, row.querySelector('.ch-badge')?.textContent ?? null]));
    // Thu Mar 11 (a Week A, the 2nd Thursday): daily, weekly, monthly and Week A rows, today's own and the week's missed ones.
    expect(await badges()).toEqual([
      ['Dishes', null], ['Trash & recycling', null], ['Wipe the table', null], ['Cat bowls', 'Weekly'], ['Fresh litter + liner', 'Weekly'], ['Litter box deep clean', 'Monthly'],
      ['Laundry', 'Weekly'], ['Vacuum', 'Weekly'], ['Dust, then vacuum', 'Monthly'], ['Clutter reset', 'Weekly'], ['Mail & papers', 'Weekly'], ['Fridge clean-out', 'Weekly'], ['Bins to the curb', 'Weekly'], ['Kitchen wipe-down', 'Week A'],
    ]);
    await expect(page.locator('.ch-view .ch-chip:text-is("A")')).toHaveCount(0);
    await oneLine(page, 'Thursday');
    // The title is the part that gives: the longest title of the day still reads in full next to its badge and buttons here (Missed rows have Fri and Let go).
    expect(await rows(page).evaluateAll(list => list.filter(row => { const title = row.querySelector<HTMLElement>('.ch-title')!; return title.scrollWidth > title.clientWidth + 1; }).length)).toBe(0);
    // Friday's Catch-up rows have a badge, a "from" chip and Let go: the longest row of the page.
    await page.getByRole('button', { name: 'Next day', exact: true }).tap();
    await expect(page.locator('.ch-view .ch-label')).toHaveText(['Catch-up']);
    await expect(rows(page).filter({ hasText: 'Kitchen wipe-down' }).locator('.ch-chip')).toHaveText(['Week A', 'from Wed']);
    await oneLine(page, 'Friday');
    // Sun Mar 14 (Week A) and Wed Mar 17 (Week B).
    await page.locator('#pill-date').fill('2027-03-14');
    expect(await badges()).toEqual([
      ['Dishes', null], ['Trash & recycling', null], ['Wipe the table', null], ['Laundry', 'Weekly'], ['Vacuum', 'Weekly'], ['Kitchen towels', 'Week A'], ['Bedding', 'Week A'], ['Couch blankets', 'Week A'],
    ]);
    await oneLine(page, 'Sunday');
    await page.locator('#pill-date').fill('2027-03-17');
    expect(await badges()).toEqual([
      ['Dishes', null], ['Trash & recycling', null], ['Wipe the table', null], ['Fridge clean-out', 'Weekly'], ['Bins to the curb', 'Weekly'], ['Bathroom wipe-down', 'Week B'],
    ]);
    await oneLine(page, 'Wednesday');
  });

  test('a long title gives way to its badge: cut with an ellipsis on a Missed row and on a Catch-up row, the badge and buttons staying inside the row', async ({ page }) => {
    // 36 characters, the longest a rule may have; the 2nd Tuesday of the month (Mar 9) is missed on Thursday and caught up on Friday.
    const title = 'E2E Deep clean the fridge shelves ok';
    expect(title).toHaveLength(36);
    expect((await owner.post({ action: 'saveChore', id: crypto.randomUUID(), title, owners: [OWNER, PARTNER], cadence: { kind: 'monthly', nth: 2, day: 2, months: 'every' }, revision: 0 })).status()).toBe(200);
    const cut = () => rows(page).filter({ hasText: title }).locator('.ch-title').evaluate(el => ({ cut: el.scrollWidth > el.clientWidth + 1, clipped: getComputedStyle(el).textOverflow }));
    await openChores(page, THU);
    const row = rows(page).filter({ hasText: title });
    await expect(row).toHaveAttribute('data-kind', 'missed');
    await expect(row.locator('.ch-chip')).toHaveText(['Monthly']);
    await expect(row.locator('.ch-btn')).toHaveText(['Fri', 'Let go']);
    expect(await cut()).toEqual({ cut: true, clipped: 'ellipsis' });
    await oneLine(page, 'Thursday long title');
    await page.getByRole('button', { name: 'Next day', exact: true }).tap();
    await expect(row).toHaveAttribute('data-kind', 'catchup');
    await expect(row.locator('.ch-chip')).toHaveText(['Monthly', 'from Tue']);
    await expect(row.locator('.ch-btn')).toHaveText(['Let go']);
    expect(await cut()).toEqual({ cut: true, clipped: 'ellipsis' });
    await oneLine(page, 'Friday long title');
  });

  test(`a tap on a title hands that one turn to the next owner (${PARTNER_NAME}, ${OWNER_NAME}, Both, ${PARTNER_NAME}) and the other person sees it; the rule keeps its own owner`, async ({ page, browser, baseURL }) => {
    await openChores(page, THU);
    const partner = await partnerPage(browser, baseURL!, THU);
    try {
      const title = (name: string) => page.getByRole('button', { name, exact: true });
      await expect(title(`Cat bowls, for ${PARTNER_NAME}. Tap to make it for ${OWNER_NAME}`)).toBeVisible();
      await title(`Cat bowls, for ${PARTNER_NAME}. Tap to make it for ${OWNER_NAME}`).tap();
      await expect(title(`Cat bowls, for ${OWNER_NAME}. Tap to make it for Both`)).toBeVisible();
      await expect(rows(page).filter({ hasText: 'Cat bowls' })).toHaveAttribute('data-c', 'green');
      await title(`Cat bowls, for ${OWNER_NAME}. Tap to make it for Both`).tap();
      await expect(title(`Cat bowls, for Both. Tap to make it for ${PARTNER_NAME}`)).toBeVisible();
      await expect(rows(page).filter({ hasText: 'Cat bowls' })).toHaveAttribute('data-c', 'purple');
      // Stored for that turn alone, as both of us.
      const turn = (await marks(owner)).filter((m: { date: string }) => m.date === THU);
      expect(turn).toHaveLength(1);
      expect(turn[0]).toMatchObject({ ruleId: await ruleId(owner, 'Cat bowls', 4), owners: [OWNER, PARTNER] });
      // The partner's own browser, on her next poll, shows the same.
      await expect.poll(async () => { await partner.clock.runFor(13000); return partner.getByRole('button', { name: `Cat bowls, for Both. Tap to make it for ${PARTNER_NAME}`, exact: true }).count(); }).toBe(1);
      // The third tap is the rule's own owner again: the mark is not kept.
      await title(`Cat bowls, for Both. Tap to make it for ${PARTNER_NAME}`).tap();
      await expect(title(`Cat bowls, for ${PARTNER_NAME}. Tap to make it for ${OWNER_NAME}`)).toBeVisible();
      await expect.poll(() => marks(owner)).toEqual([]);
    } finally { await partner.context().close(); }
  });

  test('Missed: Fri sends a turn to the catch-up Friday and Let go lets it go; on Friday the Catch-up group lists them with "from" chips, and a check there keeps the chip', async ({ page }) => {
    await openChores(page, THU);
    const missed = page.locator('.ch-view .ch-row[data-kind=missed]');
    await expect(missed).toHaveCount(8);
    for (const row of await missed.all()) { await expect(row.locator('.ch-btn')).toHaveText(['Fri', 'Let go']); }
    await page.getByRole('button', { name: 'Move Mail & papers to Friday', exact: true }).tap();
    await page.getByRole('button', { name: 'Let go of Bins to the curb', exact: true }).tap();
    await expect(missed).toHaveCount(6);
    expect(await titles(page)).not.toContain('Mail & papers');
    expect(await titles(page)).not.toContain('Bins to the curb');
    const stored = await marks(owner);
    expect(stored.map((m: { date: string; state: string; moved: boolean }) => [m.date, m.state, m.moved]).sort()).toEqual([['2027-03-09', 'open', true], ['2027-03-10', 'letgo', false]]);

    // Friday, a day ahead: its own three daily chores, then the Catch-up group of what is still open from Sunday to Wednesday (Thursday's own turns are today's).
    await page.getByRole('button', { name: 'Next day', exact: true }).tap();
    await expect(page.locator('.ch-view .ch-label')).toHaveText(['Catch-up']);
    expect((await titles(page)).slice(0, 3)).toEqual(['Dishes', 'Trash & recycling', 'Wipe the table']);
    const catchup = page.locator('.ch-view .ch-row[data-kind=catchup]');
    await expect(catchup).toHaveCount(7);
    for (const row of await catchup.all()) { await expect(row.locator('.ch-btn')).toHaveText(['Let go']); }
    await expect(catchup.filter({ hasText: 'Mail & papers' }).locator('.ch-chip')).toHaveText(['Weekly', 'from Tue']);
    await expect(catchup.filter({ hasText: 'Laundry' }).locator('.ch-chip')).toHaveText(['Weekly', 'from Sun']);
    await expect(catchup.filter({ hasText: 'Kitchen wipe-down' }).locator('.ch-chip')).toHaveText(['Week A', 'from Wed']);
    await expect(catchup.filter({ hasText: 'Bins to the curb' })).toHaveCount(0);
    // Made up on Friday: done, still saying where it was from, in the pile at the bottom.
    await page.getByRole('checkbox', { name: 'Complete Mail & papers', exact: true }).click();
    const madeUp = rows(page).last();
    await expect(madeUp).toHaveClass(/ch-done/);
    await expect(madeUp).toContainText('Mail & papers');
    await expect(madeUp.locator('.ch-chip')).toHaveText(['Weekly', 'from Tue']);
    await expect.poll(async () => (await marks(owner)).find((m: { date: string }) => m.date === '2027-03-09')).toMatchObject({ state: 'done', moved: true });
    await page.getByRole('button', { name: 'Let go of Laundry', exact: true }).tap();

    // Back on Thursday: Laundry is let go (it is the Sunday's, so it is not listed there at all) and Mail & papers is no longer missed.
    await page.getByRole('button', { name: 'Previous day', exact: true }).tap();
    expect(await titles(page)).toEqual([...TODAY_OWN, ...MISSED.filter(name => !['Mail & papers', 'Bins to the curb', 'Laundry'].includes(name))]);
    // Tuesday itself shows the turn made up on Friday as done; Wednesday shows Bins to the curb let go by hand, dim, with the chip that takes that back.
    await page.locator('#pill-date').fill('2027-03-09');
    await expect(rows(page).filter({ hasText: 'Mail & papers' })).toHaveClass(/ch-done/);
    await page.locator('#pill-date').fill('2027-03-10');
    const letgo = rows(page).filter({ hasText: 'Bins to the curb' });
    await expect(letgo).toHaveClass(/ch-letgo/);
    await expect(letgo.locator('.ch-chip')).toHaveText(['Weekly', 'Let go']);
    await letgo.getByRole('button', { name: 'Bins to the curb was let go. Undo', exact: true }).tap();
    await expect(rows(page).filter({ hasText: 'Bins to the curb' })).toHaveClass(/ch-open/);
  });

  test('a turn sent to Friday is dim on its own day with a "→ Fri" chip that takes it back', async ({ page }) => {
    await openChores(page, THU);
    await page.getByRole('button', { name: 'Move Clutter reset to Friday', exact: true }).tap();
    await expect(page.locator('.ch-view .ch-row[data-kind=missed]')).toHaveCount(7);
    await page.locator('#pill-date').fill('2027-03-08');
    const moved = rows(page).filter({ hasText: 'Clutter reset' });
    await expect(moved).toHaveClass(/ch-moved/);
    await expect(moved.locator('.ch-circle')).toHaveCount(0);
    await expect(moved.locator('.ch-chip')).toHaveText(['Weekly', '→ Fri']);
    await moved.getByRole('button', { name: 'Clutter reset was sent to Friday. Undo', exact: true }).tap();
    await expect(rows(page).filter({ hasText: 'Clutter reset' })).toHaveClass(/ch-open/);
    await expect.poll(() => marks(owner)).toEqual([]);
  });

  test('on Friday itself the group is Catch-up (never Missed), listing what is left of Sunday to Thursday, each with a Let go and no Fri', async ({ page }) => {
    await openChores(page, FRI);
    await expect(page.locator('.ch-view .ch-label')).toHaveText(['Catch-up']);
    await expect(page.locator('.ch-view .ch-row[data-kind=missed]')).toHaveCount(0);
    const catchup = page.locator('.ch-view .ch-row[data-kind=catchup]');
    await expect(catchup.locator('.ch-title')).toHaveText(['Laundry', 'Vacuum', 'Dust, then vacuum', 'Clutter reset', 'Mail & papers', 'Fridge clean-out', 'Bins to the curb', 'Kitchen wipe-down', 'Cat bowls', 'Fresh litter + liner', 'Litter box deep clean']);
    await expect(page.getByRole('button', { name: /^Move .* to Friday$/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Let go of Clutter reset', exact: true }).tap();
    await expect(catchup).toHaveCount(10);
    await page.locator('#pill-date').fill('2027-03-08');
    await expect(rows(page).filter({ hasText: 'Clutter reset' })).toHaveClass(/ch-letgo/);
  });

  test('Saturday is a day off: one dim line and nothing else', async ({ page }) => {
    await openChores(page, THU, SAT);
    await expect(page.locator('.ch-view .ch-off')).toHaveText('Day off');
    await expect(page.locator('.ch-view .ch-row, .ch-view .ch-label')).toHaveCount(0);
  });

  for (const [width, height] of [[375, 812], [375, 667]] as const) {
    test(`at ${width}x${height} the tab fits one screen on the busiest day: rows 34px shrinking to 30px, and only the list scrolls inside itself when they no longer fit`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      const extra: string[] = [];
      try {
        await openChores(page, THU);
        const fit = () => page.evaluate(() => {
          const host = document.querySelector('#period-panel')!, body = document.querySelector('.ch-body')!, list = document.querySelector('.ch-view .ch-list')!;
          const bar = document.querySelector('.day-tabs')!.getBoundingClientRect(), rows = [...list.querySelectorAll('.ch-row')].map(r => r.getBoundingClientRect().height);
          return {
            host: host.scrollHeight - host.clientHeight, body: body.scrollHeight - body.clientHeight, page: document.documentElement.scrollHeight - innerHeight, sideways: document.documentElement.scrollWidth - innerWidth,
            barOnScreen: bar.bottom <= innerHeight + 0.5, listScrolls: list.scrollHeight > list.clientHeight + 1, min: Math.min(...rows), max: Math.max(...rows), count: rows.length,
          };
        });
        // Fifteen rows and a label: the rows keep their 34px where there is room, never under 30px.
        let seen = await fit();
        expect(seen, 'the day as it is').toMatchObject({ host: 0, body: 0, page: 0, sideways: 0, barOnScreen: true, count: 14 });
        expect(seen.min).toBeGreaterThanOrEqual(29.9);
        expect(seen.max).toBeLessThanOrEqual(34.1);
        // A dozen more chores for Thursday: the rows shrink to 30px, and then only the list scrolls.
        for (let n = 0; n < 14; n++) {
          const title = unique('E2E Thu').slice(0, 30);
          extra.push(title);
          expect((await owner.post({ action: 'saveChore', id: crypto.randomUUID(), title, owners: [OWNER, PARTNER], cadence: { kind: 'weekly', day: 4, weeks: 'every' }, revision: 0 })).status()).toBe(200);
        }
        await page.clock.runFor(13000);
        await expect.poll(async () => (await fit()).count).toBe(28);
        seen = await fit();
        expect(seen, 'a day with 14 more').toMatchObject({ host: 0, body: 0, page: 0, sideways: 0, barOnScreen: true, listScrolls: true });
        expect(seen.min).toBeGreaterThanOrEqual(29.9);
        expect(seen.min).toBeLessThanOrEqual(30.1);
        // The last row of the list can be reached by scrolling it, and the tab bar did not move.
        await page.locator('.ch-view .ch-list').evaluate(el => { el.scrollTop = el.scrollHeight; });
        await expect(rows(page).last()).toBeInViewport();
        expect(await fit()).toMatchObject({ host: 0, body: 0, page: 0, sideways: 0, barOnScreen: true });
      } finally { await reset(owner); }
    });
  }

  test('the controls on a row are 44px wide targets (the circle and the small buttons) and every row, circle and title is named for a screen reader', async ({ page }) => {
    await openChores(page, THU);
    for (const selector of ['.ch-view .ch-circle', '.ch-view .ch-btn']) {
      const found = await hitSizes(page, selector);
      expect(found.length, selector).toBeGreaterThan(0);
      for (const { name, width, height } of found) {
        expect(width, `${selector} "${name}" width`).toBeGreaterThanOrEqual(44);
        expect(height, `${selector} "${name}" height`).toBeGreaterThanOrEqual(29.5);
      }
    }
    // Every title button says who it is for and what a tap does; every circle is a named checkbox.
    for (const button of await page.locator('.ch-view .ch-title').all()) { await expect(button).toHaveAttribute('aria-label', new RegExp(String.raw`^.+, for (${PARTNER_NAME}|${OWNER_NAME}|Both)\. Tap to make it for (${PARTNER_NAME}|${OWNER_NAME}|Both)$`)); }
    for (const box of await page.locator('.ch-view .ch-circle').all()) { await expect(box).toHaveAttribute('aria-label', /^(Complete|Reopen) .+/); }
  });
});

test.describe('Week and Month Chores on a phone', () => {
  test('Week: the head line, the grid of the daily chores with today marked, a tap on a past cell toggles done, then each day\'s own chores with Friday labelled Catch-up and Saturday a day off', async ({ page }) => {
    await page.clock.install({ time: noon(THU) });
    await login(page);
    await switchView(page, 'Week');
    await page.locator('#pill-date').fill(THU);
    await page.getByRole('tab', { name: 'Chores', exact: true }).tap();
    await expect(page.locator('.ch-weekhead')).toHaveText('Week A');
    expect(await page.locator('.ch-grid thead th').allTextContents()).toEqual(['MMonday', 'TTuesday', 'WWednesday', 'TThursday', 'FFriday', 'SSaturday', 'SSunday']);
    await expect(page.locator('.ch-grid tbody tr')).toHaveCount(3);
    const dishes = page.locator('.ch-grid tbody tr', { hasText: 'Dishes' });
    // Mon to Wed were let go by time, Thu is today (○), Fri is ahead (·), Saturday is a day off (–).
    await expect(dishes.locator('td')).toHaveText(['–', '–', '–', '○', '·', '–', '·']);
    await expect(dishes.locator('td').nth(3)).toHaveClass(/today/);
    await page.getByRole('button', { name: 'Dishes, Thu 11: to do today. Tap to mark it done', exact: true }).tap();
    await expect(dishes.locator('td').nth(3)).toHaveText('✓');
    await expect.poll(async () => (await marks(owner)).map((m: { date: string; state: string }) => [m.date, m.state])).toEqual([[THU, 'done']]);
    await page.getByRole('button', { name: 'Dishes, Thu 11: done. Tap to mark it not done', exact: true }).tap();
    await expect(dishes.locator('td').nth(3)).toHaveText('○');
    await expect.poll(() => marks(owner)).toEqual([]);
    // Ahead and the day off are not buttons.
    await expect(page.getByRole('button', { name: /Dishes, Fri 12/ })).toHaveCount(0);
    const groups = await page.locator('.ch-dg:visible .ch-label').allTextContents();
    expect(groups.map(g => g.replace(/\s+/g, ' ').trim())).toEqual(['Mon 8', 'Tue 9', 'Wed 10', 'Thu 11today', 'Fri 12 · Catch-up', 'Sat 13', 'Sun 14']);
    await expect(page.locator('.ch-dg[data-date="2027-03-13"] .ch-off')).toHaveText('Day off');
    // Rows are finger-sized on the Week page.
    for (const circle of (await page.locator('.ch-view .ch-circle').all()).slice(0, 4)) {
      await circle.scrollIntoViewIfNeeded();
      for (const { name, width, height } of await hitSizes(page, circle)) { expect(Math.min(width, height), name).toBeGreaterThanOrEqual(44); }
    }
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test('Month: a Monthly group with a day button on each chip, then a group for each week with its Week A / Week B chores; the Calendar tab of the planner draws a bar for each of them (month-chores-phone.spec.ts), and its day names count them', async ({ page }) => {
    await page.clock.install({ time: noon(THU) });
    await login(page);
    await switchView(page, 'Month');
    await page.locator('#pill-date').fill(THU);
    await expect(page.locator('.wm-day.today')).toHaveAttribute('data-date', THU);
    // The Calendar tab is the planner's: a bar in each cell for each chore (Thu 11 has Litter box deep clean) and no chip of them there; the name of a day counts them.
    await expect(page.locator('.wm-day .ch-row')).toHaveCount(0);
    await expect(page.locator(`.wm-day[data-date="${THU}"] .wm-bar`)).toHaveCount(1);
    await expect(page.locator(`.wm-day[data-date="${THU}"] .wm-day-num`)).toHaveAttribute('aria-label', 'Thursday, March 11, 2027, 1 chore');
    await page.getByRole('tab', { name: 'Chores', exact: true }).tap();
    await expect(page.locator('.wm-days')).toHaveCount(0);
    const labels = await page.locator('.ch-month .ch-label').allTextContents();
    // Turns the week let go of by time (Mar 1's Furnace filter, Mar 3's Bathroom wipe-down) are not listed.
    expect(labels).toEqual(['Monthly', 'Mar 8–14 · Week A', 'Mar 15–21 · Week B', 'Mar 22–28 · Week A', 'Mar 29–Apr 4 · Week B']);
    const monthly = page.locator('.ch-month .ch-list').first().locator('.ch-row');
    await expect(monthly.locator('.ch-title')).toHaveText(['Dust, then vacuum', 'Litter box deep clean', 'Vacuum, then mop']);
    await expect(monthly.locator('.ch-date')).toHaveText(['Sun 7', 'Thu 11', 'Sun 21']);
    await expect(monthly.locator('button.ch-date')).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Open Sun 7', exact: true })).toBeVisible();
    // Every row is a chip: tinted by its owner (the partner's yellow), rounded, and a turn that was missed (Sun 7, still open this chore week) has a thin warning edge.
    const dust = monthly.filter({ hasText: 'Dust, then vacuum' }), litter = monthly.filter({ hasText: 'Litter box deep clean' });
    await expect(dust).toHaveAttribute('data-c', 'yellow');
    await expect(dust).toHaveAttribute('data-state', 'missed');
    expect(await dust.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    expect(parseFloat(await dust.evaluate(el => getComputedStyle(el).borderTopLeftRadius))).toBeGreaterThanOrEqual(8);
    expect(await dust.evaluate(el => getComputedStyle(el).boxShadow)).toMatch(/ 3px 0px 0px 0px inset$/);
    expect(await litter.evaluate(el => getComputedStyle(el).boxShadow)).toBe('none');
    // Finger-sized: the circle, the title (the owner button) and the date button are 44px each way on every row.
    for (const row of await monthly.all()) {
      await row.scrollIntoViewIfNeeded();
      for (const selector of ['.ch-circle', '.ch-title', '.ch-date']) {
        for (const { name, width, height } of await hitSizes(page, row.locator(selector))) { expect(Math.min(width, height), `${selector} "${name}"`).toBeGreaterThanOrEqual(43.5); }
      }
    }
    // The same row: the circle checks it (the chip is crossed out and its circle filled), the title cycles its owner.
    await page.getByRole('checkbox', { name: 'Complete Litter box deep clean', exact: true }).click();
    await expect(litter).toHaveClass(/ch-done/);
    expect(await litter.locator('.ch-title').evaluate(el => getComputedStyle(el).textDecorationLine)).toBe('line-through');
    await expect.poll(async () => (await marks(owner)).map((m: { date: string; state: string }) => [m.date, m.state])).toEqual([[THU, 'done']]);
    await page.getByRole('checkbox', { name: 'Reopen Litter box deep clean', exact: true }).click();
    await page.getByRole('button', { name: `Litter box deep clean, for ${PARTNER_NAME}. Tap to make it for ${OWNER_NAME}`, exact: true }).click();
    await expect(litter).toHaveAttribute('data-c', 'green');
    await expect.poll(async () => (await marks(owner)).map((m: { owners: string[] }) => m.owners)).toEqual([[OWNER]]);
    // The date button opens that Day's Chores, with Back to month in place of the menu; Back returns to this list.
    await page.getByRole('button', { name: 'Open Sun 21', exact: true }).tap();
    await expect(page.locator('.ch-view[data-period=day]')).toBeVisible();
    await expect(page.locator('#date-pill')).toHaveText('Sun, Mar 21');
    await expect(page.getByRole('tab', { name: 'Chores', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.ch-view .ch-title', { hasText: 'Vacuum, then mop' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to month', exact: true }).tap();
    await expect(page.locator('.ch-view[data-period=month] .ch-month')).toBeVisible();
    await expect(page.locator('#date-pill')).toHaveText('March 2027');
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test('Month: the chips clear AA in all four themes, open, missed, done and let go', async ({ page }) => {
    const rule = async (title: string) => (await owner.snapshot()).chores.find((r: { title: string }) => r.title === title).id;
    for (const [title, date, state] of [['Vacuum, then mop', '2027-03-21', 'done'], ['Bedding', '2027-03-14', 'letgo']]) {
      expect((await owner.post({ action: 'markChore', ruleId: await rule(title), date, state, moved: false, revision: 0 })).status()).toBe(200);
    }
    await page.clock.install({ time: noon(THU) });
    await login(page);
    await switchView(page, 'Month');
    await page.locator('#pill-date').fill(THU);
    await page.getByRole('tab', { name: 'Chores', exact: true }).tap();
    await expect(page.locator('.ch-month .ch-row.ch-done')).toHaveCount(1);
    await expect(page.locator('.ch-month .ch-row.ch-letgo')).toHaveCount(1);
    const selectors = ['.ch-month .ch-label', '.ch-month .ch-row .ch-title', '.ch-month .ch-row[data-state=missed] .ch-title', '.ch-month .ch-row.ch-done .ch-title', '.ch-month .ch-row.ch-letgo .ch-title', '.ch-month .ch-row.ch-letgo .ch-undo', '.ch-month .ch-row .ch-date', '.ch-month .ch-row.ch-done .ch-date'];
    for (const theme of Object.keys(THEMES) as ThemeName[]) {
      await showTheme(page, theme, { tints: true });
      for (const selector of selectors) {
        const seen = await textContrast(page, selector);
        expect(seen.length, `${theme} ${selector}`).toBeGreaterThan(0);
        for (const { text, ratio } of seen) { expect(ratio, `${theme} ${selector} "${text}"`).toBeGreaterThanOrEqual(MIN_CONTRAST); }
      }
      // The open check circle is the chip's main control: its ring needs 3:1 against the chip's tint.
      const rings = await textContrast(page, '.ch-month .ch-row:not(.ch-done) .ch-circle', 'borderTopColor');
      expect(rings.length, `${theme} rings`).toBeGreaterThan(0);
      for (const { text, ratio } of rings) { expect(ratio, `${theme} ring "${text}"`).toBeGreaterThanOrEqual(MIN_NON_TEXT_CONTRAST); }
    }
  });
});

test('The rhythm on a phone: its circles, days, weeks and add line are finger-sized, and nothing runs off the screen', async ({ page }) => {
  await page.clock.install({ time: noon(THU) });
  await login(page);
  await page.getByRole('button', { name: /^Lists: / }).tap();
  await page.getByRole('button', { name: 'The rhythm…', exact: true }).tap();
  const dialog = page.getByRole('dialog', { name: 'The rhythm', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { level: 3 })).toHaveText(['Daily (Sun–Fri)', 'Weekly', 'Week A', 'Week B', 'Monthly', 'This week is']);
  const reach = async (selector: string, limit = 3) => {
    const all = await dialog.locator(selector).all();
    expect(all.length, selector).toBeGreaterThan(0);
    for (const control of all.slice(0, limit)) {
      await control.scrollIntoViewIfNeeded();
      for (const { name, width, height } of await hitSizes(page, control)) {
        expect(height, `${selector} "${name}" height`).toBeGreaterThanOrEqual(43.5);
        expect(width, `${selector} "${name}" width`).toBeGreaterThanOrEqual(43.5);
      }
    }
  };
  await reach('.rhythm-owner');
  await dialog.getByRole('button', { name: 'Edit Furnace filter', exact: true }).tap();
  await reach('[data-editing] .rhythm-owner, [data-editing] .rhythm-chip, [data-editing] .manager-trash', 20);
  for (const selector of ['.rhythm-add input', '.rhythm-add .primary']) {
    const control = dialog.locator(selector).last();
    await control.scrollIntoViewIfNeeded();
    for (const { name, height } of await hitSizes(page, control)) { expect(height, `${selector} "${name}" height`).toBeGreaterThanOrEqual(43.5); }
  }
  const frame = (await dialog.boundingBox())!;
  expect(frame.x).toBeGreaterThanOrEqual(0);
  expect(frame.x + frame.width).toBeLessThanOrEqual(375);
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

/** The partner's own browser on the same day, in its own context. */
async function partnerPage(browser: Browser, baseURL: string, today: string) {
  const context = await browser.newContext({ baseURL, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.clock.install({ time: noon(today) });
  await login(page, PARTNER);
  await page.getByRole('tab', { name: 'Chores', exact: true }).tap();
  await expect(page.getByRole('button', { name: `Cat bowls, for ${PARTNER_NAME}. Tap to make it for ${OWNER_NAME}`, exact: true })).toBeVisible();
  return page;
}
