import { expect, test, type Page } from '@playwright/test';
import { CAPS } from '../packages/core/src/planner';
import { apiLogin, field, login, resetPrefs, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// A desktop window shows the Day view whole: no scroll bar of the page, none inside the panel, as long as the window is tall
// enough for what is on the page at its smallest. Realistic content: five typed priorities, 13 open to-dos (CAPS.dayTodosPerList,
// the most a list may hold), notes, several schedule entries, on the Both selection (two lanes) and on a single list, in a
// light and a dark theme. Week and Month follow the same rule where only spacing and flex changes were needed.
const DAY = '2043-03-09', WEEK = '2043-03-09', MONTH = '2043-03-01';
const add = async (api: Api, body: Record<string, unknown>) => {
  const response = await api.post({ id: crypto.randomUUID(), ...body });
  expect(response.status(), JSON.stringify(await response.json())).toBe(200);
};
const clear = async (api: Api) => {
  const snapshot = await api.snapshot();
  for (const item of [...snapshot.tasks, ...snapshot.priorities, ...snapshot.events].filter((i: { date: string }) => [DAY, '2043-03-08', MONTH].includes(i.date))) { await api.post({ action: 'delete', id: item.id, revision: item.revision, confirm: true }); }
};
async function seed(api: Api, mode: 'both' | 'single') {
  const owner = [OWNER], partner = [PARTNER], both = [OWNER, PARTNER];
  if (mode === 'single') {
    for (let line = 1; line <= 5; line++) { await add(api, { action: 'add', kind: 'priority', date: DAY, owners: owner, slots: { [OWNER]: line }, text: `Priority ${line} typed` }); }
    for (let n = 1; n <= CAPS.dayTodosPerList; n++) { await add(api, { action: 'add', kind: 'todo', scope: 'day', date: DAY, owners: owner, title: `A to-do, number ${n}` }); }
    for (const [i, start] of [480, 570, 660, 780, 915, 1020].entries()) { await add(api, { action: 'add', kind: 'event', date: DAY, owners: owner, text: `Entry ${i + 1}`, start, length: 60 }); }
  } else {
    for (let line = 1; line <= 5; line++) {
      if (line <= 2) { await add(api, { action: 'add', kind: 'priority', date: DAY, owners: both, slots: { [PARTNER]: line, [OWNER]: line }, text: `Shared ${line}` }); }
      else { await add(api, { action: 'add', kind: 'priority', date: DAY, owners: owner, slots: { [OWNER]: line }, text: `${OWNER_NAME} ${line}` }); await add(api, { action: 'add', kind: 'priority', date: DAY, owners: partner, slots: { [PARTNER]: line }, text: `${PARTNER_NAME} ${line}` }); }
    }
    for (let n = 1; n <= CAPS.dayTodosPerList; n++) { await add(api, { action: 'add', kind: 'todo', scope: 'day', date: DAY, owners: n % 3 === 0 ? both : n % 3 === 1 ? owner : partner, title: `A to-do, number ${n}` }); }
    for (const [i, [owners, start, length]] of [[owner, 480, 60], [partner, 540, 90], [both, 660, 60], [owner, 780, 60], [partner, 870, 60], [owner, 960, 90]].entries() as Iterable<[number, [string[], number, number]]>) {
      await add(api, { action: 'add', kind: 'event', date: DAY, owners, text: `Entry ${i + 1}`, start, length });
    }
  }
  for (const listId of [OWNER, PARTNER]) { await api.post({ action: 'saveNote', scope: 'day', period: DAY, listId, field: 'notes', text: `Pick up ${PARTNER_NAME} at 2p. Ask about the dentist invoice.`, revision: 0 }); }
}
/** Notes of real length: nine lines, more than the compact box in the sixth row of the Month shows, so it scrolls inside itself. */
const MONTH_NOTE = ['The plumber on the 12th', 'Passport photos', 'Call the bank', 'Book the dentist', 'Order the paint', 'Renew the parking permit', 'Return the library books', 'Ask about the invoice', 'Pick up the parcel'].join('\n');
/** Writes the Month's notes of both lanes (over what seedPeriods saved). */
async function monthNotes(api: Api, text: string) {
  for (const listId of [OWNER, PARTNER]) {
    const kept = (await api.snapshot()).notes.find((n: { key: string }) => n.key === `month:${MONTH}:${listId}:notes`);
    expect((await api.post({ action: 'saveNote', scope: 'month', period: MONTH, listId, field: 'notes', text, revision: kept?.revision ?? 0 })).status()).toBe(200);
  }
}
async function seedPeriods(api: Api) {
  for (const [scope, date] of [['week', WEEK], ['month', MONTH]] as const) {
    for (let n = 1; n <= 6; n++) { await add(api, { action: 'add', kind: 'todo', scope, date, owners: n % 2 ? [OWNER] : [PARTNER], title: `${scope} to-do ${n}` }); }
  }
  for (const listId of [OWNER, PARTNER]) {
    await api.post({ action: 'saveNote', scope: 'week', period: WEEK, listId, field: 'priorities', text: 'Renew passport\nBook the dentist\nPlan the trip', revision: 0 });
    await api.post({ action: 'saveNote', scope: 'month', period: MONTH, listId, field: 'priorities', text: 'Taxes\nFamily visit', revision: 0 });
    await api.post({ action: 'saveNote', scope: 'month', period: MONTH, listId, field: 'notes', text: 'The plumber on the 12th', revision: 0 });
  }
}

/** What scrolls besides the schedule timeline, whose scale and scrolling are covered by entry-look.spec.ts. */
const scrolls = (page: Page, panel: string) => page.evaluate(selector => {
  const doc = document.scrollingElement!, found: string[] = [];
  const root = document.querySelector(selector), host = document.querySelector('#period-panel');
  for (const el of [host, root, ...(root ? root.querySelectorAll('*') : [])]) {
    if (el && !el.matches('.day-timeline') && ['auto', 'scroll'].includes(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight) { found.push(`${el.tagName.toLowerCase()}.${(el as HTMLElement).className || (el as HTMLElement).id}: ${el.scrollHeight - el.clientHeight}px`); }
  }
  return { page: doc.scrollHeight - innerHeight, sideways: doc.scrollWidth - innerWidth, found };
}, panel);
async function open(page: Page, view: 'day' | 'week' | 'month', date: string) {
  await page.locator('#jump-date').fill(date);
  // The view switch lives in the sidebar, which may be hidden: the click is made on the element itself.
  await page.locator(`.view-switch button[data-view=${view}]`).evaluate(el => (el as HTMLButtonElement).click());
  await expect(page.locator('#sidebar .date-row.selected, #day-title').first()).toBeAttached();
  await expect(page.locator(view === 'day' ? '.day-panel' : '.wm-panel')).toBeVisible();
  await page.waitForTimeout(100);
}
const setup = async (baseURL: string, theme: string, selection: string, sidebar: 'shown' | 'hidden' = 'shown') => {
  const owner = await apiLogin(baseURL, OWNER);
  await owner.post({ action: 'setTheme', theme });
  await owner.post({ action: 'savePrefs', selection: { base: selection, overlays: [] }, sidebar });
  return owner;
};
const reset = async (baseURL: string) => { await resetPrefs(baseURL); const owner = await apiLogin(baseURL, OWNER); await owner.post({ action: 'setTheme', theme: 'midnight' }); await owner.dispose(); };

test.describe('the Day view on a desktop fits the window', () => {
  let owner: Api;
  test.beforeAll(async ({ baseURL }) => { owner = await apiLogin(baseURL!, OWNER); await clear(owner); await seed(owner, 'both'); });
  test.afterAll(async ({ baseURL }) => { await clear(owner); await owner.dispose(); await reset(baseURL!); });

  for (const selection of ['both', OWNER] as const) {
    for (const theme of ['midnight', 'sage'] as const) {
      for (const [width, height] of [[1360, 900], [1440, 900], [1728, 1117], [1280, 800]] as const) {
        test(`${selection} selection, ${theme}, ${width}x${height}: the panel and timeline fit`, async ({ page, baseURL }) => {
          // The two selections are two seeds of the same day: Both has 13 to-dos in all, a single list its own 13.
          await clear(owner); await seed(owner, selection === 'both' ? 'both' : 'single');
          await setup(baseURL!, theme, selection);
          await page.setViewportSize({ width, height });
          await login(page);
          await open(page, 'day', DAY);
          expect(await scrolls(page, '.day-panel'), `${selection} ${theme} ${width}x${height}`).toEqual({ page: 0, sideways: 0, found: [] });
          // Every section is on screen whole: 13 to-dos, five priority lines, the notes and the schedule's 14 rows.
          await expect(page.locator('.day-task')).toHaveCount(CAPS.dayTodosPerList);
          await expect(page.locator('.day-prow')).toHaveCount(5);
          const bottom = await page.evaluate(() => Math.max(...['.day-tasks > li:last-child', '.day-notes', '.day-timeline'].map(s => { const el = [...document.querySelectorAll(s)].at(-1)!; return el.getBoundingClientRect().bottom; })));
          expect(bottom).toBeLessThanOrEqual(height);
          // These windows fit the whole schedule at the compact scale.
          const rows = await page.locator('.day-hours span').evaluateAll(spans => spans.map(span => span.getBoundingClientRect().height));
          expect(rows).toHaveLength(14);
          expect(Math.min(...rows)).toBeGreaterThanOrEqual(32);
          expect(await page.locator('.day-timeline').evaluate(el => el.scrollHeight - el.clientHeight)).toBe(0);
        });
      }
    }
  }

  // R9: the 13 slots are drawn whatever the day holds, so a nearly empty day is as tall as a full one and fits the same way.
  for (const [width, height] of [[1360, 900], [1440, 900], [1728, 1117], [1280, 800]] as const) {
    test(`${width}x${height}: a day with three to-dos still draws 13 ruled slots and nothing scrolls`, async ({ page, baseURL }) => {
      await clear(owner); await seed(owner, 'single');
      for (const task of (await owner.snapshot()).tasks.filter((t: { date: string; title: string }) => t.date === DAY && !/number [123]$/.test(t.title))) { await owner.post({ action: 'delete', id: task.id, revision: task.revision, confirm: true }); }
      await setup(baseURL!, 'midnight', OWNER);
      await page.setViewportSize({ width, height });
      await login(page);
      await open(page, 'day', DAY);
      expect(await scrolls(page, '.day-panel'), `${width}x${height}`).toEqual({ page: 0, sideways: 0, found: [] });
      await expect(page.locator('.day-task')).toHaveCount(3);
      await expect(page.locator('.day-free')).toHaveCount(CAPS.dayTodosPerList - 3);
      const bottom = await page.evaluate(() => Math.max(...['.day-tasks > li:last-child', '.day-notes', '.day-timeline'].map(s => [...document.querySelectorAll(s)].at(-1)!.getBoundingClientRect().bottom)));
      expect(bottom).toBeLessThanOrEqual(height);
      // Typing in the add field, and its counter, leave the fit alone too.
      await page.getByLabel('New task', { exact: true }).fill('x'.repeat(40));
      await expect(page.locator('.day-msg')).toHaveText('Keep it to 36 characters.');
      expect(await scrolls(page, '.day-panel'), `${width}x${height} with a message`).toEqual({ page: 0, sideways: 0, found: [] });
    });
  }

  // A save the server or the network refuses is said in the shell's banner, which lies over the page header's title and date (not over the panel): the
  // panel keeps its size and place, so a Day that fits the window still fits, nothing on the page moves, and no control of the panel or of the header is under it.
  for (const [width, height] of [[1360, 900], [1280, 800]] as const) {
    test(`${width}x${height}: a refused save's banner lies over the page header, so the Day still fits, nothing moves and every control stays in reach`, async ({ page, baseURL }) => {
      await clear(owner); await seed(owner, 'both');
      await setup(baseURL!, 'midnight', 'both');
      await page.setViewportSize({ width, height });
      await login(page);
      await open(page, 'day', DAY);
      const boxes = () => page.evaluate(() => Object.fromEntries(['#period-panel', '.day-panel', '.day-grid', '.day-tasks', '.page-header', '.topbar'].map(s => { const r = document.querySelector(s)!.getBoundingClientRect(); return [s, [r.x, r.y, r.width, r.height]]; })));
      const before = await boxes();
      expect(await scrolls(page, '.day-panel')).toEqual({ page: 0, sideways: 0, found: [] });
      // Every write is cut off: completing a to-do cannot be saved.
      await page.route(url => url.pathname.endsWith('/api.php'), route => (route.request().method() === 'GET' ? route.continue() : route.abort('failed')));
      await page.getByRole('checkbox', { name: 'Complete A to-do, number 1', exact: true }).click();
      const banner = page.locator('#error');
      await expect(banner).toBeVisible();
      await expect(banner).toHaveAttribute('role', 'alert');
      await expect(page.locator('#error-message')).toContainText('may have saved');
      // Nothing of the page moved or changed size, and nothing scrolls.
      expect(await boxes()).toEqual(before);
      expect(await scrolls(page, '.day-panel'), `${width}x${height} with the banner`).toEqual({ page: 0, sideways: 0, found: [] });
      // The banner is under the top bar, inside the page's width, in front of the header's title, and ends where the panel begins: nothing of the panel is covered.
      const [box, panel, topbar, actions] = [(await banner.boundingBox())!, (await page.locator('#period-panel').boundingBox())!, (await page.locator('.topbar').boundingBox())!, (await page.locator('.header-actions').boundingBox())!];
      expect(box.y).toBeGreaterThanOrEqual(topbar.y + topbar.height);
      expect(box.y + box.height, 'the banner ends where the panel begins').toBeLessThanOrEqual(panel.y + 0.5);
      expect(box.x).toBeGreaterThanOrEqual(panel.x);
      expect(box.x + box.width, 'the arrows and the date jump are clear of it').toBeLessThanOrEqual(actions.x);
      expect(await page.evaluate(([x, y]) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('#error') !== null, [box.x + 20, box.y + box.height / 2])).toBe(true);
      // Every button, field and switch of the header and of the panel is the topmost thing at its middle: none is under the banner.
      const covered = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.page-header :is(button, input), #period-panel :is(button, input, textarea, select)')]
        .filter(el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')
        .filter(el => { const r = el.getBoundingClientRect(); return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('#error'); })
        .map(el => el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName));
      expect(covered, 'controls under the banner').toEqual([]);
      // Dismissed as before: Refresh reads again and takes it away; the page is as it was.
      await page.unroute(url => url.pathname.endsWith('/api.php'));
      await banner.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(banner).toBeHidden();
      expect(await boxes()).toEqual(before);
    });
  }

  // An item is edited where it stands, so opening one (with its message showing, its strip of controls out) must not make the page or
  // the panel scroll in a window that fits the day.
  for (const [width, height] of [[1360, 900], [1440, 900], [1728, 1117], [1280, 800]] as const) {
    test(`${width}x${height}: editing a to-do, a priority, an entry in the first and the last hour, or a new one at 8p, with a message showing, makes nothing scroll`, async ({ page, baseURL }) => {
      await clear(owner); await seed(owner, 'both');
      await setup(baseURL!, 'midnight', 'both');
      await page.setViewportSize({ width, height });
      await login(page);
      await open(page, 'day', DAY);
      const still = async (what: string) => expect(await scrolls(page, '.day-panel'), `${width}x${height} ${what}`).toEqual({ page: 0, sideways: 0, found: [] });
      const leave = async () => { await page.keyboard.press('Escape'); await expect(page.locator('[data-editing]')).toHaveCount(0); };
      // A to-do with its day and Delete, and a message under it (the title is over its cap).
      await page.getByRole('button', { name: 'Edit A to-do, number 1', exact: true }).click();
      await expect(field(page, 'Edit task: A to-do, number 1')).toBeFocused();
      await still('to-do');
      await field(page, 'Edit task: A to-do, number 1').fill('x'.repeat(40));
      await expect(page.locator('.day-task.day-editing .ip-error')).toHaveText('Keep it to 36 characters.');
      await still('to-do with a message');
      await leave();
      // A priority cell with Move up, Move down and Delete, and its message hanging under it.
      await page.getByRole('button', { name: 'Priority 1: Shared 1, Both', exact: true }).click();
      await expect(field(page, 'Edit priority 1: Shared 1')).toBeFocused();
      await field(page, 'Edit priority 1: Shared 1').fill('y'.repeat(30));
      await expect(page.locator('.day-cell.day-editing .ip-error')).toHaveText('Keep it to 18 characters.');
      await still('priority with a message');
      await leave();
      await page.getByRole('button', { name: new RegExp(String.raw`^Priority 5: ${OWNER_NAME} 5`) }).click();
      await expect(page.locator('[data-editing] input[data-ip=text]')).toBeFocused();
      await still('priority 5');
      await leave();
      // Entries: the strip hangs beside the handles and stays inside the schedule.
      await page.getByRole('button', { name: /^Entry 1, / }).click();
      await expect(page.locator('[data-editing] input[data-ip=text]')).toBeFocused();
      await still('first entry');
      await leave();
      await page.getByRole('button', { name: /^Entry 6, / }).click();
      await expect(page.locator('[data-editing] input[data-ip=text]')).toBeFocused();
      await still('last entry');
      await leave();
      await page.getByRole('button', { name: `Add to ${OWNER_NAME} at 8p`, exact: true }).click({ position: { x: 20, y: 5 } });
      await expect(field(page, 'New entry')).toBeFocused();
      await still('new entry at 8p');
      await leave();
    });
  }

  // Completed to-dos stay in the to-do list, crossed out, stacked at the bottom under the blank lines, and use up lines. While the open and
  // the done rows fit the 13 lines nothing scrolls; beyond them only the list scrolls inside itself, and no row shrinks below 28px. The page and
  // the panel never scroll, however many were completed: the day fits the window.
  for (const [width, height] of [[1280, 800], [1360, 900], [1440, 900]] as const) {
    for (const done of [4, 8, 14]) {
      for (const selection of [OWNER, 'both'] as const) {
        test(`${width}x${height}, ${selection} selection: three open to-dos and ${done} done ones in one list${done > 10 ? ', which scrolls inside itself' : ' keep the 13 lines and nothing scrolls'}`, async ({ page, baseURL }) => {
          await clear(owner); await seed(owner, selection === 'both' ? 'both' : 'single');
          const snapshot = await owner.snapshot();
          for (const task of snapshot.tasks.filter((t: { date: string; title: string }) => t.date === DAY && !/number [123]$/.test(t.title))) { await owner.post({ action: 'delete', id: task.id, revision: task.revision, confirm: true }); }
          for (let n = 1; n <= done; n++) {
            const id = crypto.randomUUID();
            await add(owner, { id, action: 'add', kind: 'todo', scope: 'day', date: DAY, owners: selection === 'both' ? [OWNER, PARTNER] : [OWNER], title: `Finished ${n}` });
            expect((await owner.post({ action: 'complete', id, revision: 1, done: true })).status()).toBe(200);
          }
          await setup(baseURL!, 'midnight', selection);
          await page.setViewportSize({ width, height });
          await login(page);
          await open(page, 'day', DAY);
          const seen = await scrolls(page, '.day-panel');
          expect(seen, `${width}x${height} ${selection} ${done} done`).toMatchObject({ page: 0, sideways: 0 });
          // Beyond the 13 lines only the list scrolls; within them nothing does.
          if (3 + done >= CAPS.dayTodosPerList) { expect(seen.found.map(item => item.split(':')[0]), 'only the list scrolls').toEqual(['ul.day-tasks']); } else { expect(seen.found, 'nothing scrolls').toEqual([]); }
          await expect(page.locator('.day-task:not(.day-done)')).toHaveCount(3);
          await expect(page.locator('.day-task.day-done')).toHaveCount(done);
          // The blank lines are what the 13 lines have left, the add line being at least one; there is no list of its own for the done rows.
          await expect(page.locator('.day-free')).toHaveCount(Math.max(1, CAPS.dayTodosPerList - 3 - done));
          await expect(page.locator('.day-donelist, ul[aria-label="Done"]')).toHaveCount(0);
          // One list in order: the open rows, the blank lines (the add line first), then the done rows as the last lines.
          const order = await page.evaluate(() => [...document.querySelectorAll('.day-tasks > li')].map(li => li.classList.contains('day-done') ? 'done' : li.classList.contains('day-free') ? 'free' : 'open').join(' '));
          expect(order).toBe([...Array(3).fill('open'), ...Array(Math.max(1, CAPS.dayTodosPerList - 3 - done)).fill('free'), ...Array(done).fill('done')].join(' '));
          // The list ends inside the window and no row is squeezed below its 28px minimum.
          const ends = await page.evaluate(() => { const list = document.querySelector('.day-tasks')!; return { bottom: list.getBoundingClientRect().bottom, rows: [...list.children].map(li => li.getBoundingClientRect().height) }; });
          expect(ends.bottom).toBeLessThanOrEqual(height);
          expect(Math.min(...ends.rows)).toBeGreaterThanOrEqual(27.9);
        });
      }
    }
  }

  for (const [width, height] of [[1280, 800], [1360, 900]] as const) {
    test(`${width}x${height}: a message under a to-do being edited hangs below its line, so the line keeps its height and the next one its place`, async ({ page, baseURL }) => {
      await clear(owner); await seed(owner, 'single');
      await setup(baseURL!, 'midnight', OWNER);
      await page.setViewportSize({ width, height });
      await login(page);
      await open(page, 'day', DAY);
      const lines = page.locator('.day-tasks > li');
      const [before, nextBefore] = [(await lines.nth(4).boundingBox())!, (await lines.nth(5).boundingBox())!];
      await page.getByRole('button', { name: 'Edit A to-do, number 5', exact: true }).click();
      await field(page, 'Edit task: A to-do, number 5').fill('x'.repeat(40));
      const error = page.locator('.day-task.day-editing .ip-error');
      await expect(error).toHaveText('Keep it to 36 characters.');
      const [after, nextAfter, message] = [(await lines.nth(4).boundingBox())!, (await lines.nth(5).boundingBox())!, (await error.boundingBox())!];
      expect(after.height).toBeCloseTo(before.height, 0);
      expect(nextAfter.y).toBeCloseTo(nextBefore.y, 0);
      // The message is under the line, not on its rule.
      expect(message.y).toBeGreaterThanOrEqual(after.y + after.height - 0.5);
      expect(await scrolls(page, '.day-panel')).toEqual({ page: 0, sideways: 0, found: [] });
    });
  }

  test('a window too short for the content scrolls the panel, and only the panel: the page stays put and nothing is cut off', async ({ page, baseURL }) => {
    await clear(owner); await seed(owner, 'single');
    await setup(baseURL!, 'midnight', OWNER);
    await page.setViewportSize({ width: 1000, height: 680 });
    await login(page);
    await open(page, 'day', DAY);
    const now = await scrolls(page, '.day-panel');
    // At 1000x680 the right column (5 priorities, the full message and 13 ruled rows) is about 40px taller than the window leaves:
    // the panel scrolls by exactly that, the page does not, and the last to-do and the notes can be reached.
    expect(now.page).toBe(0);
    expect(now.found).toHaveLength(1);
    expect(now.found[0]).toMatch(/^div\.?#?period-panel|period-panel/);
    const over = Number(now.found[0].match(/(\d+)px/)![1]);
    expect(over).toBeGreaterThan(0);
    expect(over).toBeLessThanOrEqual(60);
    await page.locator('.day-task').last().scrollIntoViewIfNeeded();
    await expect(page.locator('.day-task').last()).toBeInViewport();
    await page.locator('.day-notes').scrollIntoViewIfNeeded();
    await expect(page.locator('.day-notes')).toBeInViewport();
    // Much shorter: the schedule keeps its time scale and the panel scrolls further.
    await page.setViewportSize({ width: 1360, height: 560 });
    await expect.poll(async () => (await scrolls(page, '.day-panel')).found.length).toBe(1);
    expect((await scrolls(page, '.day-panel')).page).toBe(0);
    const rows = await page.locator('.day-hours span').evaluateAll(spans => spans.map(span => span.getBoundingClientRect().height));
    expect(Math.min(...rows)).toBeGreaterThanOrEqual(32);
  });

  test('the top bar and page header are compact, and Notes sits under the schedule', async ({ page, baseURL }) => {
    await clear(owner); await seed(owner, 'single');
    await setup(baseURL!, 'midnight', OWNER);
    await login(page);
    await open(page, 'day', DAY);
    expect((await page.locator('.topbar').boundingBox())!.height).toBe(46);
    const header = (await page.locator('.page-header').boundingBox())!;
    expect(header.height).toBeLessThanOrEqual(40);
    const [title, date] = [(await page.locator('#day-title').boundingBox())!, (await page.locator('#full-date').boundingBox())!];
    expect(Math.abs((title.y + title.height / 2) - (date.y + date.height / 2)), 'the title and the date share a row').toBeLessThanOrEqual(8);
    expect(date.x).toBeGreaterThan(title.x + title.width - 1);
    expect((await page.locator('.page').boundingBox())!.y, 'the page starts under the top bar').toBeLessThanOrEqual(46 + 12);
    const [sched, notes, prio, todo] = await Promise.all(['.day-sched', '.day-notes', '.day-prio', '.day-todo'].map(async s => (await page.locator(s).boundingBox())!));
    expect(notes.y).toBeGreaterThanOrEqual(sched.y + sched.height - 2);
    expect(Math.abs(notes.x - sched.x)).toBeLessThan(2);
    expect(todo.y).toBeGreaterThanOrEqual(prio.y + prio.height - 2);
    // The two columns balance: neither ends more than a screenful short of the other.
    const [left, right] = [notes.y + notes.height, todo.y + todo.height];
    expect(Math.abs(left - right), 'the columns end together, give or take the to-do list').toBeLessThan(260);
  });
});

const NOTE = `Pick up ${PARTNER_NAME} at 2p. Ask about the dentist invoice and the plumber; also order the paint for the hallway and call the school. `.repeat(4);
const saveNotes = async (api: Api, text: string) => {
  for (const listId of [OWNER, PARTNER]) {
    const current = (await api.snapshot()).notes.find((n: { key: string }) => n.key === `day:${DAY}:${listId}:notes`);
    expect((await api.post({ action: 'saveNote', scope: 'day', period: DAY, listId, field: 'notes', text, revision: current?.revision ?? 0 })).status()).toBe(200);
  }
};

test.describe('the Day view with notes of real length and with three or four lanes', () => {
  let owner: Api;
  const lists: Array<{ id: string; name: string }> = [];
  test.beforeAll(async ({ baseURL }) => {
    owner = await apiLogin(baseURL!, OWNER); await clear(owner); await seed(owner, 'both');
    for (const prefix of ['Camp', 'Gard']) {
      const id = crypto.randomUUID(), name = `${prefix} ${crypto.randomUUID().slice(0, 4)}`;
      expect((await owner.post({ action: 'saveList', id, name, color: prefix === 'Camp' ? 'blue' : 'red', revision: 0 })).status()).toBe(200);
      lists.push({ id, name });
    }
  });
  test.afterAll(async ({ baseURL }) => {
    await clear(owner);
    for (const { id } of lists) { const list = (await owner.snapshot()).lists.find((l: { id: string }) => l.id === id); if (list) { await owner.post({ action: 'deleteList', id, revision: list.revision, confirm: true }); } }
    await owner.dispose(); await reset(baseURL!);
  });

  // Notes grow by a few lines. Only an individual textarea can scroll if it reaches its height limit.
  for (const [lanes, overlays] of [[2, 0], [3, 1], [4, 2]] as const) {
    for (const length of [90, 400]) {
      for (const [width, height] of [[1360, 900], [1440, 900], [1728, 1117]] as const) {
        test(`${lanes} lanes, a note of ${length} characters, ${width}x${height}: notes keep their footer and leave room for the schedule`, async ({ page }) => {
          await saveNotes(owner, NOTE.slice(0, length));
          await owner.post({ action: 'savePrefs', selection: { base: 'both', overlays: lists.slice(0, overlays).map(l => l.id) }, sidebar: 'shown' });
          await page.setViewportSize({ width, height });
          await login(page);
          await open(page, 'day', DAY);
          await expect(page.locator('.day-note')).toHaveCount(lanes);
          const overflow = await scrolls(page, '.day-panel');
          expect({ ...overflow, found: overflow.found.filter(item => !item.startsWith('textarea.day-note-text:')) }).toEqual({ page: 0, sideways: 0, found: [] });
          // Nothing of a footer pokes out of its box or lies over its neighbour: every part is inside the box that holds it.
          const out = await page.locator('.day-note').evaluateAll(boxes => boxes.flatMap(box => {
            const b = box.getBoundingClientRect();
            return [...box.querySelectorAll('.day-note-foot *')].filter(el => !(el as HTMLElement).hidden && el.getClientRects().length).map(el => { const r = el.getBoundingClientRect(); return r.left < b.left - 0.5 || r.right > b.right + 0.5 || r.bottom > b.bottom + 0.5 ? (el.className || el.tagName) : ''; }).filter(Boolean);
          }));
          expect(out, 'footer parts outside their box').toEqual([]);
          const textareas = await page.locator('.day-note-text').evaluateAll(areas => areas.map(a => ({ height: a.clientHeight, overflow: a.scrollHeight - a.clientHeight, scroll: getComputedStyle(a).overflowY })));
          for (const a of textareas) {
            expect(a.height).toBeGreaterThanOrEqual(52);
            expect(a.height).toBeLessThanOrEqual(124);
            if (a.overflow > 0) { expect(a).toMatchObject({ height: 124, scroll: 'auto' }); }
          }
        });
      }
    }
  }

  test('typing a long note caps its height, keeps the tail reachable and saves the full text', async ({ page }) => {
    await saveNotes(owner, '');
    await owner.post({ action: 'savePrefs', selection: { base: 'both', overlays: [] }, sidebar: 'shown' });
    await login(page);
    await open(page, 'day', DAY);
    const notes = page.getByRole('textbox', { name: `Notes for ${OWNER_NAME}` });
    const save = page.locator('.day-note').filter({ has: notes }).getByRole('button', { name: 'Save', exact: true });
    expect(await notes.evaluate(a => a.clientHeight)).toBe(52);
    const long = Array.from({ length: 14 }, (_, n) => `Line ${n + 1} of the note`).join('\n');
    await notes.fill(long);
    const scrolled = await notes.evaluate(a => { a.scrollTop = a.scrollHeight; return [a.clientHeight, a.scrollTop]; });
    expect(scrolled[0]).toBe(124);
    expect(scrolled[1]).toBeGreaterThan(0);
    await save.click();
    await expect.poll(async () => (await owner.snapshot()).notes.find((note: { period: string; listId: string }) => note.period === DAY && note.listId === OWNER)?.text).toBe(long);
    await notes.fill('Short again');
    expect(await notes.evaluate(a => a.clientHeight)).toBe(52);
  });

  test('the two columns of a tall window end together: the right column\'s rows take the free height up to a limit', async ({ page }) => {
    await saveNotes(owner, NOTE.slice(0, 90));
    await owner.post({ action: 'savePrefs', selection: { base: 'both', overlays: [] }, sidebar: 'shown' });
    await page.setViewportSize({ width: 1728, height: 1117 });
    await login(page);
    await open(page, 'day', DAY);
    const [left, right] = await Promise.all(['.day-notes', '.day-tasks > li:last-child'].map(async s => { const box = (await page.locator(s).last().boundingBox())!; return box.y + box.height; }));
    expect(Math.abs(left - right), 'the left column ends with the notes, the right with the last to-do').toBeLessThanOrEqual(40);
    const row = await page.locator('.day-task').first().boundingBox();
    expect(row!.height, 'a to-do row stretches, but never past 44px').toBeLessThanOrEqual(44.5);
  });
});

test.describe('Week and Month on a desktop', () => {
  let owner: Api;
  test.beforeAll(async ({ baseURL }) => { owner = await apiLogin(baseURL!, OWNER); await clear(owner); await seedPeriods(owner); });
  test.afterAll(async ({ baseURL }) => { await clear(owner); await owner.dispose(); await reset(baseURL!); });

  for (const sidebar of ['shown', 'hidden'] as const) {
    for (const view of ['week', 'month'] as const) {
      for (const [width, height] of [[1360, 900], [1440, 900]] as const) {
        test(`${view}, sidebar ${sidebar}, ${width}x${height}: no scroll bar`, async ({ page, baseURL }) => {
          await setup(baseURL!, 'midnight', 'both', sidebar);
          await page.setViewportSize({ width, height });
          await login(page);
          await open(page, view, view === 'week' ? WEEK : MONTH);
          expect(await scrolls(page, '.wm-panel')).toEqual({ page: 0, sideways: 0, found: [] });
        });
      }
    }
  }

  test('Month with more to-dos than the side column holds: the to-do list scrolls inside itself, the column, the calendar and the panel stay put; the weekday row keeps its height', async ({ page, baseURL }) => {
    for (let n = 7; n <= 13; n++) { await add(owner, { action: 'add', kind: 'todo', scope: 'month', date: MONTH, owners: [OWNER], title: `month to-do extra ${n}` }); }
    await setup(baseURL!, 'midnight', 'both');
    await page.setViewportSize({ width: 1360, height: 900 });
    await login(page);
    await open(page, 'month', MONTH);
    const now = await scrolls(page, '.wm-panel');
    expect(now.page).toBe(0);
    expect(now.found.filter(line => !line.startsWith('textarea')).map(line => line.split(':')[0])).toEqual(['ul.wm-todos']);
    const rows = await page.locator('.wm-grid').evaluate(grid => getComputedStyle(grid).gridTemplateRows.split(' ').map(Number.parseFloat));
    expect(rows[0], 'the weekday row is a text line, not a band').toBeLessThanOrEqual(34);
    expect(Math.max(...rows.slice(1, 6)) - Math.min(...rows.slice(1, 6)), 'the date rows share the height').toBeLessThanOrEqual(1);
    // Everything in it can be reached: scrolled to the end, the last to-do is in view.
    await page.locator('ul.wm-todos').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(page.locator('.wm-todo').last()).toBeInViewport();
    const kept = await owner.snapshot();
    for (const task of kept.tasks.filter((t: { title: string }) => t.title.startsWith('month to-do extra'))) { await owner.post({ action: 'delete', id: task.id, revision: task.revision, confirm: true }); }
  });

  test('1280x800: Week and Month fit: no scroll bar of the page, the panel or the side column (the priorities boxes are as tall as their words, in at most two thirds of it); the Month has six equal rows and notes of nine lines scroll inside their compact boxes', async ({ page, baseURL }) => {
    await setup(baseURL!, 'midnight', 'both');
    await monthNotes(owner, MONTH_NOTE);
    await page.setViewportSize({ width: 1280, height: 800 });
    await login(page);
    await open(page, 'week', WEEK);
    expect(await scrolls(page, '.wm-panel')).toEqual({ page: 0, sideways: 0, found: [] });
    await open(page, 'month', MONTH);
    const month = await scrolls(page, '.wm-panel');
    expect(month.page).toBe(0);
    expect(month.sideways).toBe(0);
    // Only the text areas of the Notes cells (nine lines of words in a box of about two) scroll inside themselves; nothing else does, and no row is made taller by them.
    expect(month.found.filter(line => !line.startsWith('textarea'))).toEqual([]);
    expect(month.found.filter(line => line.startsWith('textarea')).length, 'the Notes boxes scroll inside themselves').toBeGreaterThanOrEqual(2);
    const rows = await page.locator('.wm-grid').evaluate(grid => getComputedStyle(grid).gridTemplateRows.split(' ').map(Number.parseFloat).slice(1));
    expect(Math.max(...rows) - Math.min(...rows), `six equal rows ${rows.join(', ')}`).toBeLessThanOrEqual(1);
    const [notes, row] = [(await page.locator('.wm-notes').boundingBox())!, rows[5]];
    expect(Math.abs(notes.height - row), 'the Notes are one row tall').toBeLessThanOrEqual(1);
    for (const person of [OWNER_NAME, PARTNER_NAME]) {
      const box = (await page.getByLabel(`${person} notes`, { exact: true }).boundingBox())!;
      expect(box.y + box.height, `${person}'s box ends inside the Notes row`).toBeLessThanOrEqual(notes.y + notes.height);
      expect(box.height, `${person}'s box shows about two lines`).toBeGreaterThanOrEqual(39);
    }
    await monthNotes(owner, 'The plumber on the 12th');
  });
});

test.describe('the Day view with the sidebar hidden', () => {
  test.afterAll(async ({ baseURL }) => { await reset(baseURL!); });
  for (const [width, height] of [[1360, 900], [1440, 900]] as const) {
    test(`${width}x${height}: no scroll bar, and the account menu still opens fully on screen`, async ({ page, baseURL }) => {
      const owner = await setup(baseURL!, 'midnight', 'both', 'hidden');
      await clear(owner); await seed(owner, 'both');
      await page.setViewportSize({ width, height });
      try {
        await login(page);
        await open(page, 'day', DAY);
        expect(await scrolls(page, '.day-panel')).toEqual({ page: 0, sideways: 0, found: [] });
        await page.locator('#account-button-bar').click();
        const menu = (await page.getByRole('menu').boundingBox())!;
        expect(menu.x).toBeGreaterThanOrEqual(0);
        expect(menu.x + menu.width).toBeLessThanOrEqual(width);
        expect(menu.y + menu.height).toBeLessThanOrEqual(height);
        await page.keyboard.press('Escape');
      } finally { await clear(owner); await owner.dispose(); }
    });
  }
});
