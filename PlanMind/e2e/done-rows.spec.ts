import { expect, test, type Locator, type Page } from '@playwright/test';
import { CAPS, periodStart } from '../packages/core/src/planner';
import { shiftDate } from '../packages/core/src/parse';
import { addTodo, apiLogin, farDate, field, inside, leaveField, listTop, login, middleRow, noWindow, pickList, removeTodos, resetPrefs, scrollList, today, todo, unique, walkRings, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// Done to-dos are never hidden and never behind a button or a heading: they stay in the same list as the open ones, crossed out (and dim), and
// STACK AT THE BOTTOM of it. The ruled page is the open rows from the top, then the blank lines (the add field the first of them), then the done
// rows as its last lines. Checking a row moves it to the bottom, unchecking brings it back up among the open ones (above the blank lines). The Day's
// 13 slots limit the OPEN rows of a list; done rows use up the last blank lines and never count against that cap. Beyond 13 lines nothing is hidden
// (the add line is then the one blank line between the open and the done rows) and the Day's list scrolls inside itself (a desktop: the page never
// scrolls; the phone: the tab never does, see done-rows-phone.spec.ts); the Week's and the Month's list simply grows. Desktop project (1360x900);
// the Week and Month on a phone-sized page are at the end.
test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });
const MAX = CAPS.dayTodosPerList;

const openDay = async (page: Page, date: string) => {
  await page.locator('#jump-date').fill(date);
  await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', date);
};
async function clearDay(api: Api, date: string) {
  const snapshot = await api.snapshot();
  for (const item of [...snapshot.tasks, ...snapshot.priorities, ...snapshot.events].filter((i: { date: string }) => i.date === date)) {
    await api.post({ action: 'delete', id: item.id, revision: item.revision, confirm: true });
  }
}
async function clearPeriod(api: Api, scope: 'week' | 'month', date: string) {
  for (const task of (await api.snapshot()).tasks.filter((t: { scope: string; date: string }) => t.scope === scope && t.date === date)) {
    await api.post({ action: 'delete', id: task.id, revision: task.revision, confirm: true });
  }
}
/** Adds a to-do through the API (and completes it when `done`); returns what the test needs to find it. */
async function make(api: Api, over: Record<string, unknown>, done = false) {
  const body = todo(over);
  const response = await api.post(body);
  expect(response.status(), JSON.stringify(await response.json())).toBe(200);
  if (done) { expect((await api.post({ action: 'complete', id: body.id, revision: 1, done: true })).status()).toBe(200); }
  return { id: body.id as string, title: body.title as string };
}

/** What each line of the Day's To-do list is, top to bottom: an open row, a done row, or a blank line (the add field's line is blank too). */
const kinds = (page: Page) => page.locator('.day-tasks > li').evaluateAll(lis => lis.map(li => (li.classList.contains('day-done') ? 'done' : li.classList.contains('day-task') ? 'open' : 'free')));
const same = (kind: string, n: number) => Array<string>(n).fill(kind);
/** The page top to bottom: `open` open rows, `free` blank lines (the first is the add field), `done` crossed-out rows as the last lines. */
const stack = (open: number, free: number, done: number) => [...same('open', open), ...same('free', free), ...same('done', done)];
/** The same for a Week's or a Month's list. */
const wmKinds = (page: Page) => page.locator('ul.wm-todos > li').evaluateAll(lis => lis.map(li => (li.classList.contains('done') ? 'done' : li.classList.contains('wm-todo') ? 'open' : 'free')));
/** Nothing in the page says Done: no heading, no button with a count, no list of that name, no block of the old kind. */
async function noDoneUi(page: Page) {
  await expect(page.getByRole('button', { name: /^Done \(/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /^Done/ })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Done' })).toHaveCount(0);
  await expect(page.getByText(/^Done \(\d+\)$/)).toHaveCount(0);
  await expect(page.locator('.day-donelist, .wm-done, [data-list=done]')).toHaveCount(0);
}
const slot = (page: Page, n: number) => page.locator(`.day-tasks > li[data-slot="${n}"]`);
const ghost = (page: Page) => page.locator('.day-newcell');
const along = async (line: Locator, across: number) => { const box = (await line.boundingBox())!; return { box, x: box.x + box.width * across, y: box.y + box.height / 2 }; };

test.describe('Day to-do, desktop: done rows stack at the bottom of the list', () => {
  test('a done to-do is crossed out in the same list and is one of the last lines of the page, under the blank lines; checking moves it to the bottom, unchecking brings it back up; no Done list, heading or button', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(760);
    const [a, b, c] = [await make(owner, { date, title: unique('Alpha') }), await make(owner, { date, title: unique('Bravo') }), await make(owner, { date, title: unique('Charlie') })];
    const [d, e] = [await make(owner, { date, title: unique('Delta') }, true), await make(owner, { date, title: unique('Echo') }, true)];
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      const lines = page.locator('.day-tasks > li'), list = page.getByRole('list', { name: 'To do', exact: true });
      // Three open rows from the top, the blank lines (the add field the first), and the two done rows as the LAST two of the 13 lines.
      await expect(lines).toHaveCount(MAX);
      expect(await kinds(page)).toEqual(stack(3, MAX - 5, 2));
      await expect(list.locator('.day-task.day-done')).toHaveCount(2);
      await expect(lines.nth(MAX - 2)).toContainText(d.title);
      await expect(lines.nth(MAX - 1)).toContainText(e.title);
      await expect(page.locator('.day-free')).toHaveCount(MAX - 5);
      await expect(lines.nth(3).getByLabel('New task', { exact: true }), 'the add field is the first blank line, right under the last open row').toBeVisible();
      await noDoneUi(page);
      await expect(page.locator('.day-todo [data-kind=todos]'), 'done rows are not counted against the 13').toHaveText(`3 of ${MAX}`);
      // Quietly finished: crossed out and dim, the circle checked and named for reopening it.
      const [open, closed] = [page.locator('.day-tasks .day-task:not(.day-done) .day-task-title').first(), page.locator('.day-tasks .day-task.day-done .day-task-title').first()];
      await expect(open).toHaveCSS('text-decoration-line', 'none');
      await expect(closed).toHaveCSS('text-decoration-line', 'line-through');
      expect(await closed.evaluate(el => getComputedStyle(el).color)).not.toBe(await open.evaluate(el => getComputedStyle(el).color));
      await expect(page.getByRole('checkbox', { name: `Reopen ${d.title}`, exact: true })).toBeChecked();
      // The rows are one list on one rule: the 13 lines follow each other, as tall as each other, and the last done row ends the list.
      const boxes = await lines.evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { y: r.y, height: r.height }; }));
      for (let i = 1; i < boxes.length; i++) { expect(Math.abs(boxes[i].y - (boxes[i - 1].y + boxes[i - 1].height)), `line ${i + 1} follows line ${i}`).toBeLessThanOrEqual(1); }
      expect(Math.max(...boxes.map(r => r.height)) - Math.min(...boxes.map(r => r.height))).toBeLessThanOrEqual(1);
      const frame = (await page.locator('.day-tasks').boundingBox())!, last = boxes[boxes.length - 1];
      expect(frame.y + frame.height - (last.y + last.height), 'the done rows end the list: nothing is under them').toBeLessThanOrEqual(2);
      // The blank lines are above the done rows, never between or under them.
      const [blank, done] = [(await lines.nth(MAX - 3).boundingBox())!, (await lines.nth(MAX - 2).boundingBox())!];
      expect(done.y).toBeGreaterThanOrEqual(blank.y + blank.height - 1);

      // Checking the first open row sends it to the bottom pile (the done rows keep the core's order, the order the rows were made in).
      await page.getByRole('checkbox', { name: `Complete ${a.title}`, exact: true }).click();
      await expect(page.getByRole('checkbox', { name: `Reopen ${a.title}`, exact: true })).toBeChecked();
      expect(await kinds(page)).toEqual(stack(2, MAX - 5, 3));
      await expect(lines.nth(0)).toContainText(b.title);
      await expect(lines.nth(1)).toContainText(c.title);
      await expect(lines.nth(MAX - 3)).toContainText(a.title);
      await expect(lines.nth(MAX - 1)).toContainText(e.title);
      await expect(page.locator('.day-free'), 'the blank lines are what the rows leave: moving a row frees none').toHaveCount(MAX - 5);
      await expect(page.locator('.day-todo [data-kind=todos]')).toHaveText(`2 of ${MAX}`);
      await noDoneUi(page);
      // Unchecking it brings it back up among the open ones, first again (its own place in the order), above the blank lines.
      await page.getByRole('checkbox', { name: `Reopen ${a.title}`, exact: true }).click();
      await expect(page.getByRole('checkbox', { name: `Complete ${a.title}`, exact: true })).not.toBeChecked();
      expect(await kinds(page)).toEqual(stack(3, MAX - 5, 2));
      await expect(lines.nth(0)).toContainText(a.title);
      await expect(lines.nth(3), 'the add field is right under the last open row again').toHaveClass(/day-free-add/);
      // The last open row, finished and reopened, comes back just after the last open row: the line under it is the add field again.
      await page.getByRole('checkbox', { name: `Complete ${c.title}`, exact: true }).click();
      await expect(page.getByRole('checkbox', { name: `Reopen ${c.title}`, exact: true })).toBeChecked();
      expect(await kinds(page)).toEqual(stack(2, MAX - 5, 3));
      await expect(lines.nth(2), 'the add field moved up under the open rows').toHaveClass(/day-free-add/);
      await page.getByRole('checkbox', { name: `Reopen ${c.title}`, exact: true }).click();
      await expect(page.getByRole('checkbox', { name: `Complete ${c.title}`, exact: true })).not.toBeChecked();
      expect(await kinds(page)).toEqual(stack(3, MAX - 5, 2));
      await expect(lines.nth(2)).toContainText(c.title);
      await expect(lines.nth(3)).toHaveClass(/day-free-add/);
      // Done rows tell a screen reader the same: the list is one list, and the row's state is its checked circle.
      await expect(list.getByRole('checkbox')).toHaveCount(5);
      await expect(list.getByRole('checkbox', { checked: true })).toHaveCount(2);
      // Finishing every open row leaves only the blank lines on top and the pile under them.
      for (const row of [a, b, c]) { await page.getByRole('checkbox', { name: `Complete ${row.title}`, exact: true }).click(); await expect(page.getByRole('checkbox', { name: `Reopen ${row.title}`, exact: true })).toBeChecked(); }
      expect(await kinds(page)).toEqual(stack(0, MAX - 5, 5));
      await expect(lines.nth(0)).toHaveClass(/day-free-add/);
      await expect(page.locator('.day-todo [data-kind=todos]')).toHaveText(`0 of ${MAX}`);
      await noWindow(page);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the page keeps its 13 lines: each row added takes a blank line from between the open rows and the pile, and the done rows stay the last lines', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(766);
    await make(owner, { date, title: 'First open' });
    await make(owner, { date, title: 'Finished one' }, true);
    await make(owner, { date, title: 'Finished two' }, true);
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      const lines = page.locator('.day-tasks > li');
      expect(await kinds(page)).toEqual(stack(1, MAX - 3, 2));
      for (const [n, title] of [[2, 'Second open'], [3, 'Third open'], [4, 'Fourth open']] as const) {
        await addTodo(page, title);
        await expect(lines, 'always the same 13 lines').toHaveCount(MAX);
        expect(await kinds(page)).toEqual(stack(n, MAX - n - 2, 2));
        await expect(lines.nth(n - 1)).toContainText(title);
        await expect(lines.nth(n), 'the add field is the first blank line, right under the last open row').toHaveClass(/day-free-add/);
        await expect(lines.nth(MAX - 2)).toContainText('Finished one');
        await expect(lines.nth(MAX - 1)).toContainText('Finished two');
      }
      // Finishing the third takes it to the bottom of the pile (made later than the other two done rows, it is the last), and frees no line.
      await page.getByRole('checkbox', { name: 'Complete Third open', exact: true }).click();
      await expect(page.getByRole('checkbox', { name: 'Reopen Third open', exact: true })).toBeChecked();
      expect(await kinds(page)).toEqual(stack(3, MAX - 6, 3));
      await expect(lines.nth(MAX - 1)).toContainText('Third open');
      await expect(page.locator('.day-todo [data-kind=todos]')).toHaveText(`3 of ${MAX}`);
      await noDoneUi(page);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('done rows use up blank lines and never count against the 13: 13 open rows still fill their 13 slots, the done rows follow them, and the add field is the line between', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(761);
    await make(owner, { date, title: 'Done early' }, true);
    for (let n = 1; n <= MAX; n++) { await make(owner, { date, title: `Open ${String(n).padStart(2, '0')}` }); }
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      // 13 open (the list is full: no add field, the reason) and the done row under them: 14 rows, no blank line.
      await expect(page.locator('.day-todo [data-kind=todos]')).toHaveText(`${MAX} of ${MAX}`);
      expect(await kinds(page)).toEqual(stack(MAX, 0, 1));
      await expect(page.getByLabel('New task', { exact: true })).toHaveCount(0);
      await expect(page.locator('.day-msg')).toHaveText(`${OWNER_NAME} already has ${MAX} things to do that day.`);
      await expect(page.getByRole('button', { name: /more$/ })).toHaveCount(0);
      // Finishing one open row makes room for a new one: the add field comes back as the one line between the 12 open rows and the 2 done ones.
      await page.getByRole('checkbox', { name: 'Complete Open 13', exact: true }).click();
      await expect(page.getByRole('checkbox', { name: 'Reopen Open 13', exact: true })).toBeChecked();
      expect(await kinds(page)).toEqual(stack(MAX - 1, 1, 2));
      await expect(page.locator('.day-todo [data-kind=todos]')).toHaveText(`${MAX - 1} of ${MAX}`);
      await expect(page.locator('.day-free').getByLabel('New task', { exact: true })).toBeVisible();
      await expect(page.locator('.day-tasks > li').nth(MAX - 1)).toHaveClass(/day-free-add/);
      await expect(page.locator('.day-msg')).toBeHidden();
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('more rows than lines (open and done): the add line stays between the open rows and the pile, the list scrolls inside itself, the page and the panel never do, no row is squeezed', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(762);
    for (let n = 1; n <= 3; n++) { await make(owner, { date, title: `Open ${n}` }); }
    for (let n = 1; n <= 16; n++) { await make(owner, { date, title: `Finished ${String(n).padStart(2, '0')}` }, true); }
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      const lines = page.locator('.day-tasks > li'), add = page.getByLabel('New task', { exact: true });
      // 19 rows and the add line: no blank line is left; the add field is the one line between the 3 open rows and the 16 done ones.
      expect(await kinds(page)).toEqual(stack(3, 1, 16));
      await expect(page.locator('.day-free')).toHaveCount(1);
      await expect(lines.nth(3)).toHaveClass(/day-free-add/);
      const measure = () => page.evaluate(() => {
        const list = document.querySelector<HTMLElement>('.day-tasks')!, host = document.querySelector<HTMLElement>('#period-panel')!, doc = document.scrollingElement!;
        return {
          page: doc.scrollHeight - innerHeight, sideways: doc.scrollWidth - innerWidth, panel: host.scrollHeight - host.clientHeight,
          overflow: getComputedStyle(list).overflowY, client: list.clientHeight, scroll: list.scrollHeight, bottom: list.getBoundingClientRect().bottom,
          rows: [...list.children].map(li => li.getBoundingClientRect().height),
        };
      });
      let m = await measure();
      expect(m.page, 'the page does not scroll').toBe(0);
      expect(m.sideways).toBe(0);
      expect(m.panel, 'the panel does not scroll').toBe(0);
      expect(m.overflow).toBe('auto');
      expect(m.scroll, 'the list has more than it shows').toBeGreaterThan(m.client + 20);
      expect(m.bottom, 'it ends inside the window').toBeLessThanOrEqual(900);
      expect(Math.min(...m.rows), 'no row below its minimum').toBeGreaterThanOrEqual(27.9);
      // The add field is under the open rows, in view at the top of the list with no scrolling; the pile is reached by scrolling the list.
      await expect(add).toBeInViewport();
      const [inner, box] = [(await page.locator('.day-tasks').boundingBox())!, (await add.boundingBox())!];
      expect(box.y, 'the add field is inside the list').toBeGreaterThanOrEqual(inner.y - 1);
      expect(box.y + box.height).toBeLessThanOrEqual(inner.y + inner.height + 1);
      await add.fill('Brand new');
      await add.press('Enter');
      await expect(page.getByRole('button', { name: 'Edit Brand new', exact: true })).toBeVisible();
      // The new open row goes after the open ones, above the add line and the done rows; the add field is the line under it, focused and in view.
      expect(await kinds(page)).toEqual(stack(4, 1, 16));
      await expect(lines.nth(3)).toContainText('Brand new');
      await expect(lines.nth(4)).toHaveClass(/day-free-add/);
      await expect(lines.nth(5)).toContainText('Finished 01');
      await expect(add).toBeFocused();
      await expect(add).toBeInViewport();
      m = await measure();
      expect([m.page, m.sideways, m.panel], 'still nothing but the list scrolls').toEqual([0, 0, 0]);
      // Scrolled to the very end, the last row is whole (the last done row) and the first is reachable again at the top.
      await page.locator('.day-tasks').evaluate(el => { el.scrollTop = el.scrollHeight; });
      await expect(lines.last()).toContainText('Finished 16');
      expect((await lines.last().boundingBox())!.y + (await lines.last().boundingBox())!.height).toBeLessThanOrEqual((await page.locator('.day-tasks').boundingBox())!.y + (await page.locator('.day-tasks').boundingBox())!.height + 1);
      await page.locator('.day-tasks').evaluate(el => { el.scrollTop = 0; });
      await expect(page.getByRole('button', { name: 'Edit Open 1', exact: true })).toBeInViewport();
      // A row near the list's bottom edge being edited with a message under it: the message is brought into the list's view (it hangs past the row's own
      // line), and nothing else scrolls.
      await page.getByRole('button', { name: 'Edit Finished 13', exact: true }).click();
      await field(page, 'Edit task: Finished 13').fill('x'.repeat(40));
      const message = page.locator('.day-task.day-editing .ip-error');
      await expect(message).toHaveText('Keep it to 36 characters.');
      const [hint, frame] = [(await message.boundingBox())!, (await page.locator('.day-tasks').boundingBox())!];
      expect(hint.y, 'the message is inside the list, top').toBeGreaterThanOrEqual(frame.y - 1);
      expect(hint.y + hint.height, 'the message is inside the list, bottom').toBeLessThanOrEqual(frame.y + frame.height + 1);
      m = await measure();
      expect([m.page, m.panel]).toEqual([0, 0]);
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-editing]')).toHaveCount(0);
      // The last done row, edited at the very bottom of the list: its message hangs above it, inside the list.
      await scrollList(page, 'end');
      await page.getByRole('button', { name: 'Edit Finished 16', exact: true }).click();
      await field(page, 'Edit task: Finished 16').fill('y'.repeat(40));
      await expect(message).toHaveText('Keep it to 36 characters.');
      const [low, row, edge] = [(await message.boundingBox())!, (await page.locator('.day-task.day-editing').boundingBox())!, (await page.locator('.day-tasks').boundingBox())!];
      expect(low.y + low.height, 'above its row, not under the list').toBeLessThanOrEqual(row.y + 1);
      expect(low.y, 'inside the list').toBeGreaterThanOrEqual(edge.y - 1);
      m = await measure();
      expect([m.page, m.panel]).toEqual([0, 0]);
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-editing]')).toHaveCount(0);
      // A done row far down the list is reopened where it stands: it goes up among the open rows (above the add line), and the page still does not move.
      await page.getByRole('checkbox', { name: 'Reopen Finished 16', exact: true }).click();
      await expect(page.getByRole('checkbox', { name: 'Complete Finished 16', exact: true })).not.toBeChecked();
      expect(await kinds(page)).toEqual(stack(5, 1, 15));
      m = await measure();
      expect([m.page, m.panel]).toEqual([0, 0]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('Both view: a done row keeps its owner color and a linked one is one row; the blank lines between the open rows and the pile are still cut in thirds, and a new to-do lands under the open rows, above the blank lines', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(763);
    await make(owner, { date, owners: [OWNER], title: 'Open mine' });
    await make(owner, { date, owners: [PARTNER], title: 'Open hers' });
    await make(owner, { date, owners: [OWNER, PARTNER], title: 'Open ours' });
    await make(owner, { date, owners: [OWNER], title: 'Done mine' }, true);
    await make(owner, { date, owners: [PARTNER], title: 'Done hers' }, true);
    await make(owner, { date, owners: [OWNER, PARTNER], title: 'Done ours' }, true);
    await make(owner, { date, owners: [OWNER], title: 'Done mine too' }, true);
    try {
      await login(page); await openDay(page, date);
      const lines = page.locator('.day-tasks > li'), done = page.locator('.day-tasks .day-task.day-done');
      // The linked to-do is one row (not one for each lane), the owner colors are the circles': the owner green, the partner yellow, both purple.
      expect(await kinds(page)).toEqual(stack(3, MAX - 7, 4));
      expect(await done.locator('.day-circle').evaluateAll(els => els.map(el => (el as HTMLElement).dataset.c))).toEqual(['green', 'yellow', 'purple', 'green']);
      await expect(done.locator('.day-who')).toHaveText([OWNER_NAME, PARTNER_NAME, 'Both', OWNER_NAME]);
      await expect(page.locator('.day-task', { hasText: 'Done ours' })).toHaveCount(1);
      await noDoneUi(page);
      // One list shown: the other person's done row is not there.
      await pickList(page, PARTNER_NAME);
      await expect(done.locator('.day-task-title')).toHaveText(['Done hers', 'Done ours']);
      await pickList(page, 'Both');
      await expect(done).toHaveCount(4);

      // The blank lines that remain, between the open rows and the pile, are the thirds' places: the add field is the first of them (line 4: three rows above it).
      await expect(slot(page, 4).getByLabel('New task', { exact: true })).toBeVisible();
      await expect(lines.nth(3)).toHaveClass(/day-free-add/);
      for (const [across, color, side] of [[0.12, 'green', 'left'], [0.5, 'purple', 'both'], [0.9, 'yellow', 'right']] as const) {
        const spot = await along(slot(page, 7), across);
        await page.mouse.move(spot.x, spot.y);
        await expect(ghost(page)).toHaveAttribute('data-c', color);
        await expect(ghost(page)).toHaveAttribute('data-side', side);
      }
      const spot = await along(slot(page, 7), 0.5);
      // The line is a blank one with open rows above it and done rows below it.
      expect(await lines.nth(6).evaluate(li => li.classList.contains('day-free'))).toBe(true);
      expect(await lines.nth(MAX - 5).evaluate(li => li.classList.contains('day-done'))).toBe(false);
      expect(await lines.nth(MAX - 4).evaluate(li => li.classList.contains('day-done'))).toBe(true);
      await page.mouse.click(spot.x, spot.y);
      const fresh = field(page, `New to-do for ${OWNER_NAME} and ${PARTNER_NAME}`);
      await expect(fresh).toBeFocused();
      const editing = (await page.locator('.day-task.day-new').boundingBox())!;
      expect(Math.abs(editing.y - spot.box.y), 'it opens on the line that was clicked').toBeLessThanOrEqual(2);
      await fresh.fill('Linked new');
      await fresh.press('Enter');
      await expect(page.getByRole('checkbox', { name: 'Complete Linked new', exact: true })).toHaveAttribute('data-c', 'purple');
      // The new open row is the fourth open one, right under the others (not on the line it was written on); the blank lines shrank by one and
      // the add field is still the first of them, and the pile did not move.
      expect(await kinds(page)).toEqual(stack(4, MAX - 8, 4));
      await expect(lines.nth(3)).toContainText('Linked new');
      await expect(lines.nth(4).getByLabel('New task', { exact: true })).toBeVisible();
      await expect(lines.nth(MAX - 4)).toContainText('Done mine');
      await expect(page.locator('.day-new')).toHaveCount(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a to-do written on a blank line and left for the notes (where the panel cannot be drawn again) is put under the last open row at once, ahead of the blank lines and the pile', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(765);
    await make(owner, { date, title: unique('Still open') });
    await make(owner, { date, title: unique('Finished') }, true);
    await make(owner, { date, title: unique('Finished too') }, true);
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      const lines = page.locator('.day-tasks > li');
      expect(await kinds(page)).toEqual(stack(1, MAX - 3, 2));
      // A click on the seventh line (a blank one, well under the open row) writes a to-do there; a click into the Notes box saves it with the focus in that box, so the list is not redrawn.
      await slot(page, 7).click();
      const fresh = field(page, `New to-do for ${OWNER_NAME}`);
      await expect(fresh).toBeFocused();
      await fresh.fill('Swapped in');
      const notes = page.getByLabel(`Notes for ${OWNER_NAME}`, { exact: true });
      await notes.click();
      await expect(notes).toBeFocused();
      await expect(page.getByRole('button', { name: 'Edit Swapped in', exact: true })).toBeVisible();
      // It is the second open row, the add field is still the first blank line, and the pile is untouched at the bottom.
      expect(await kinds(page)).toEqual(stack(2, MAX - 4, 2));
      await expect(lines.nth(1)).toContainText('Swapped in');
      await expect(lines.nth(2)).toHaveClass(/day-free-add/);
      await expect(page.locator('.day-new')).toHaveCount(0);
      expect((await owner.snapshot()).tasks.find((t: { title: string }) => t.title === 'Swapped in')).toMatchObject({ date, done: false });
      // Leaving the Notes box lets the list be drawn again: it comes out as it is.
      await leaveField(page);
      await expect(page.getByRole('button', { name: 'Edit Swapped in', exact: true })).toBeVisible();
      expect(await kinds(page)).toEqual(stack(2, MAX - 4, 2));
      await expect(lines.nth(1)).toContainText('Swapped in');
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a to-do written on the add line itself and left for the notes lands as the last open row, and the blank lines under it are the add line first', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(767);
    await make(owner, { date, title: unique('One') });
    await make(owner, { date, title: unique('Two') });
    await make(owner, { date, title: unique('Finished') }, true);
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      const lines = page.locator('.day-tasks > li');
      expect(await kinds(page)).toEqual(stack(2, MAX - 3, 1));
      await page.getByLabel('New task', { exact: true }).click();
      const fresh = field(page, `New to-do for ${OWNER_NAME}`);
      await expect(fresh).toBeFocused();
      await fresh.fill('From the add line');
      const notes = page.getByLabel(`Notes for ${OWNER_NAME}`, { exact: true });
      await notes.click();
      await expect(page.getByRole('button', { name: 'Edit From the add line', exact: true })).toBeVisible();
      // The row took the add line's place, which is just under the open rows: third open row, then the blank lines, then the pile.
      expect(await kinds(page)).toEqual([...same('open', 3), ...same('free', MAX - 4), 'done']);
      await expect(lines.nth(2)).toContainText('From the add line');
      await expect(lines.nth(MAX - 1)).toHaveClass(/day-done/);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('an open row being edited that the other person finishes meanwhile, left for the notes (no redraw), is put among the done rows at the bottom at once', async ({ page, baseURL }) => {
    await page.clock.install();
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER), date = farDate(768);
    const [held] = [await make(owner, { date, title: unique('Held') })];
    await make(owner, { date, title: unique('Other open') });
    await make(owner, { date, title: unique('Finished') }, true);
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      const lines = page.locator('.day-tasks > li');
      expect(await kinds(page)).toEqual(stack(2, MAX - 3, 1));
      await page.getByRole('button', { name: `Edit ${held.title}`, exact: true }).click();
      const input = field(page, `Edit task: ${held.title}`);
      await expect(input).toBeFocused();
      // The other person finishes it; the poll brings that in, but never redraws under the row being edited.
      expect((await partner.post({ action: 'complete', id: held.id, revision: 1, done: true })).status()).toBe(200);
      const polled = page.waitForResponse(response => response.url().includes('api.php?since='));
      await page.clock.runFor(13000);
      await polled;
      await expect(input).toBeFocused();
      expect(await kinds(page)).toEqual(stack(2, MAX - 3, 1));
      // Leaving for the notes saves nothing (nothing was changed) and puts the row where the next drawing will: in the pile, at the bottom, with its crossed-out look.
      await page.getByLabel(`Notes for ${OWNER_NAME}`, { exact: true }).click();
      await expect(page.getByLabel(`Notes for ${OWNER_NAME}`, { exact: true })).toBeFocused();
      await expect(page.locator('[data-editing]')).toHaveCount(0);
      expect(await kinds(page)).toEqual(stack(1, MAX - 3, 2));
      await expect(lines.nth(MAX - 2)).toContainText(held.title);
      await expect(lines.nth(MAX - 2)).toHaveClass(/day-done/);
      await expect(page.getByRole('checkbox', { name: `Reopen ${held.title}`, exact: true })).toBeChecked();
      // And the drawing that follows agrees.
      await leaveField(page);
      await expect(page.getByRole('checkbox', { name: `Reopen ${held.title}`, exact: true })).toBeChecked();
      expect(await kinds(page)).toEqual(stack(1, MAX - 3, 2));
      await expect(lines.nth(MAX - 2)).toContainText(held.title);
    } finally { await clearDay(owner, date); await owner.dispose(); await partner.dispose(); }
  });

  test('a done row is edited and deleted like an open one, where it stands, and stays crossed out', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(764);
    await make(owner, { date, title: unique('Still open') });
    const done = await make(owner, { date, title: unique('Finished') }, true);
    const other = await make(owner, { date, title: unique('Finished too') }, true);
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      const lines = page.locator('.day-tasks > li'), row = lines.nth(MAX - 2);
      await expect(row).toContainText(done.title);
      const was = (await row.boundingBox())!;
      await page.getByRole('button', { name: `Edit ${done.title}`, exact: true }).click();
      const edit = field(page, `Edit task: ${done.title}`);
      await expect(edit).toBeFocused();
      await noWindow(page);
      const now = (await row.boundingBox())!;
      expect(Math.abs(now.y - was.y) + Math.abs(now.height - was.height), 'the row does not move or change size').toBeLessThanOrEqual(1);
      const renamed = unique('Renamed');
      await edit.fill(renamed);
      await edit.press('Enter');
      await expect(edit).toHaveCount(0);
      await expect(page.getByRole('button', { name: `Edit ${renamed}`, exact: true })).toBeFocused();
      await expect(lines.nth(MAX - 2)).toHaveClass(/day-done/);
      await expect(lines.nth(MAX - 2)).toContainText(renamed);
      await expect(page.getByRole('checkbox', { name: `Reopen ${renamed}`, exact: true })).toBeChecked();
      await expect(lines.nth(MAX - 2).locator('.day-task-title')).toHaveCSS('text-decoration-line', 'line-through');
      expect((await owner.snapshot()).tasks.find((t: { id: string }) => t.id === done.id)).toMatchObject({ title: renamed, done: true });
      // Delete: two presses on the icon in the row, the first turns it red; the row goes and the pile shrinks (the line it had is a blank one now).
      await page.getByRole('button', { name: `Edit ${renamed}`, exact: true }).click();
      await page.getByRole('button', { name: `Delete task: ${renamed}`, exact: true }).click();
      await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
      await expect(page.locator('.day-task')).toHaveCount(2);
      expect(await kinds(page)).toEqual(stack(1, MAX - 2, 1));
      await expect(lines.nth(MAX - 1)).toContainText(other.title);
      expect((await owner.snapshot()).tasks.some((t: { id: string }) => t.id === done.id)).toBe(false);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a carried-over to-do ticked on today is a crossed-out row of today\'s pile with its chip, and its own day shows it unchecked, pointing at today', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), then = shiftDate(today(), -3, 'day');
    const carried = await make(owner, { date: then, title: unique('Carried') });
    const own = await make(owner, { date: today(), title: unique('Own') });
    const ownDone = await make(owner, { date: today(), title: unique('Own done') }, true);
    try {
      await login(page);
      await pickList(page, OWNER_NAME);
      const mark = async (title: string) => (await page.getByRole('button', { name: `Edit ${title}`, exact: true }).boundingBox())!;
      // Today: the carried row (with its chip) and today's open row, then the add line, and today's own done row at the bottom, under the blank lines.
      await expect(page.locator('.day-task', { hasText: carried.title }).locator('.day-from')).toBeVisible();
      const [c, o, d] = [await mark(carried.title), await mark(own.title), await mark(ownDone.title)];
      const addLine = (await page.locator('.day-free-add').boundingBox())!;
      expect(c.y).toBeLessThan(o.y);
      expect(o.y).toBeLessThan(addLine.y);
      expect(addLine.y).toBeLessThan(d.y);
      await expect(page.locator('.day-tasks > li').last(), 'the done row is the last line of the page').toHaveClass(/day-done/);
      await expect(page.locator('.day-task', { hasText: ownDone.title })).toHaveClass(/day-done/);
      await expect(page.locator('.day-task', { hasText: ownDone.title }).locator('.day-from')).toHaveCount(0);
      // Tick the carried one: it is done on today, so it sits in today's pile (crossed out, its chip kept), the carried ones first, above today's own done row.
      await page.getByRole('checkbox', { name: `Complete ${carried.title}`, exact: true }).click();
      await expect(page.locator('.day-task.day-done', { hasText: carried.title })).toHaveCount(1);
      expect((await owner.snapshot()).tasks.find((t: { id: string }) => t.id === carried.id)).toMatchObject({ date: then, done: true, doneOn: today() });
      await expect(page.locator('.day-task', { hasText: carried.title }).locator('.day-from')).toHaveText(/^from /);
      await expect(page.getByRole('checkbox', { name: `Reopen ${carried.title}`, exact: true })).toBeChecked();
      expect(await page.locator('.day-tasks > li.day-done .day-task-title').allTextContents()).toEqual([carried.title, ownDone.title]);
      await expect(page.locator('.day-tasks > li').last(), 'the last line of the page is still a done row').toHaveClass(/day-done/);
      // Its own day shows it unchecked, in the open rows, with no cross-out and a chip pointing at today (done-on.spec.ts: the whole rule).
      await openDay(page, then);
      const row = page.locator('.day-task', { hasText: carried.title });
      await expect(row).toHaveCount(1);
      await expect(row).not.toHaveClass(/day-done/);
      await expect(row.locator('.day-from')).toHaveText(/^→ /);
      await noDoneUi(page);
    } finally { await removeTodos(owner, [carried.id, own.id, ownDone.id]); await owner.dispose(); }
  });
});

// ---- the Day's list is a scroll area: it keeps its keyboard rings and its place ----------------------------------------------------------

test.describe('Day to-do, desktop: the list that scrolls keeps its keyboard rings and its place', () => {
  test('the keyboard ring of every control in the list lies whole inside the list: first row, last row, the add field and a row being edited', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(920);
    for (let n = 1; n <= 3; n++) { await make(owner, { date, title: `Open ${n}` }); }
    for (let n = 1; n <= 16; n++) { await make(owner, { date, title: `Finished ${String(n).padStart(2, '0')}` }, true); }
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      // From the first circle by the keyboard to the last control of the list: the circles (at the list's left edge), the titles (at its right edge), the add field
      // (under the open rows, before the pile) and the last row, the last done one.
      await page.getByRole('checkbox', { name: 'Complete Open 1', exact: true }).focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      const stops = await walkRings(page, '.day-tasks', 60);
      expect(stops.length, '19 circles, 19 titles and the add field').toBe(39);
      expect(stops[0]).toContain('Complete Open 1');
      expect(stops[6], 'the add field comes after the three open rows').toContain('New task');
      expect(stops[7]).toContain('Reopen Finished 01');
      expect(stops.at(-1)).toContain('Edit Finished 16');
      expect(await listTop(page), 'the walk scrolled the list to the last row').toBeGreaterThan(20);
      // A row being edited: its field, its date and its delete icon, the last row of a list scrolled to the end.
      await scrollList(page, 'end');
      await page.getByRole('button', { name: 'Edit Finished 16', exact: true }).click();
      await expect(field(page, 'Edit task: Finished 16')).toBeFocused();
      expect((await walkRings(page, '.day-tasks', 8)).length, 'the field, the date, the delete icon').toBeGreaterThanOrEqual(3);
      await page.keyboard.press('Escape');
      // The add field, with the pile under it, is as whole as the first row.
      await scrollList(page, 0);
      await page.getByRole('checkbox', { name: 'Complete Open 1', exact: true }).focus();
      await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
      expect((await walkRings(page, '.day-tasks', 2)).length).toBe(2);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a redraw keeps the list where it was scrolled: opening and cancelling an edit, saving it with Enter, reopening a row; the touched row stays under the pointer and the keyboard stays in view', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(921);
    for (let n = 1; n <= 3; n++) { await make(owner, { date, title: `Open ${n}` }); }
    for (let n = 1; n <= 20; n++) { await make(owner, { date, title: `Done ${n}` }, true); }
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      const list = page.locator('.day-tasks'), ids = new Map((await owner.snapshot()).tasks.map((t: { id: string; title: string }) => [t.title, t.id]));
      const rowY = async (title: string) => (await page.locator(`.day-task[data-id="${ids.get(title)}"]`).boundingBox())!.y;
      const top = await scrollList(page, 186);
      expect(top, 'the list is scrolled').toBeGreaterThan(150);
      const was = await rowY('Done 13');
      // Open an edit on a row in the middle of the view: it opens where it was, the list stays scrolled.
      await page.getByRole('button', { name: 'Edit Done 13', exact: true }).click();
      await expect(field(page, 'Edit task: Done 13')).toBeFocused();
      expect(await listTop(page)).toBeCloseTo(top, 0);
      expect(Math.abs((await rowY('Done 13')) - was), 'the row did not move under the pointer').toBeLessThanOrEqual(1);
      // Escape cancels it: the same place, the row's button has the keyboard and is in view.
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-editing]')).toHaveCount(0);
      expect(await listTop(page)).toBeCloseTo(top, 0);
      expect(Math.abs((await rowY('Done 13')) - was)).toBeLessThanOrEqual(1);
      await expect(page.getByRole('button', { name: 'Edit Done 13', exact: true })).toBeFocused();
      await inside(page, page.getByRole('button', { name: 'Edit Done 13', exact: true }));
      // Enter saves it: the same.
      await page.getByRole('button', { name: 'Edit Done 13', exact: true }).click();
      await field(page, 'Edit task: Done 13').fill('Done 13 renamed');
      await field(page, 'Edit task: Done 13').press('Enter');
      await expect(page.getByRole('button', { name: 'Edit Done 13 renamed', exact: true })).toBeFocused();
      expect(await listTop(page)).toBeCloseTo(top, 0);
      expect(Math.abs((await rowY('Done 13')) - was)).toBeLessThanOrEqual(1);
      await inside(page, page.getByRole('button', { name: 'Edit Done 13 renamed', exact: true }));
      // Reopening a row in view takes it up among the open rows; the list does not jump to its top.
      await page.getByRole('checkbox', { name: 'Reopen Done 14', exact: true }).click();
      await expect(page.getByRole('checkbox', { name: 'Complete Done 14', exact: true })).not.toBeChecked();
      expect(await listTop(page)).toBeCloseTo(top, 0);
      // The last rows: a list scrolled to its end stays there for an edit that is saved.
      const end = await scrollList(page, 'end');
      await page.getByRole('button', { name: 'Edit Done 20', exact: true }).click();
      await field(page, 'Edit task: Done 20').fill('Last one');
      await field(page, 'Edit task: Done 20').press('Enter');
      await expect(page.getByRole('button', { name: 'Edit Last one', exact: true })).toBeFocused();
      expect(await listTop(page)).toBeCloseTo(end, 0);
      await inside(page, page.getByRole('button', { name: 'Edit Last one', exact: true }));
      // A day that is another day starts at the top (the position is kept for the same day only).
      await openDay(page, farDate(924));
      expect(await listTop(page)).toBe(0);
      await expect(list).toBeVisible();
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a to-do written from the add line of a list longer than its box: the add field comes back focused and in view, one line lower, and the list stays where it was', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(922);
    for (let n = 1; n <= 3; n++) { await make(owner, { date, title: `Open ${n}` }); }
    for (let n = 1; n <= 20; n++) { await make(owner, { date, title: `Done ${n}` }, true); }
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      const add = page.locator('[data-key="todo:add"]'), lines = page.locator('.day-tasks > li');
      // The add line is under the three open rows, with the pile under it; the list is scrolled a little so the first row is out of view and the add line is near the top.
      const at = await scrollList(page, 56);
      expect(at, 'the list is scrolled').toBeGreaterThan(40);
      await expect(add).toBeInViewport();
      // A click on the empty add line starts the to-do on it, in place; Enter saves it and the keyboard goes back to the add field, one line lower.
      await add.click();
      const fresh = field(page, `New to-do for ${OWNER_NAME}`);
      await expect(fresh).toBeFocused();
      expect(await listTop(page)).toBeCloseTo(at, 0);
      await inside(page, fresh);
      await fresh.fill('Typed new');
      await fresh.press('Enter');
      await expect(page.getByRole('button', { name: 'Edit Typed new', exact: true })).toBeVisible();
      await expect(add).toBeFocused();
      await inside(page, add);
      expect(await listTop(page), 'not thrown back to the top').toBeGreaterThan(at - 2);
      expect(await kinds(page)).toEqual(stack(4, 1, 20));
      await expect(lines.nth(3)).toContainText('Typed new');
      await expect(lines.nth(4)).toHaveClass(/day-free-add/);
      // And once more, from the line that is the add field now.
      await add.click();
      await expect(fresh).toBeFocused();
      await fresh.fill('Typed again');
      await fresh.press('Enter');
      await expect(page.getByRole('button', { name: 'Edit Typed again', exact: true })).toBeVisible();
      await expect(add).toBeFocused();
      await inside(page, add);
      expect(await listTop(page)).toBeGreaterThan(at - 2);
      expect(await kinds(page)).toEqual(stack(5, 1, 20));
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a to-do typed in the add field and sent after the list was scrolled away to the pile: the add field comes back focused and in view', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(923);
    for (let n = 1; n <= 3; n++) { await make(owner, { date, title: `Open ${n}` }); }
    for (let n = 1; n <= 20; n++) { await make(owner, { date, title: `Done ${n}` }, true); }
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      const add = page.getByLabel('New task', { exact: true });
      await add.fill('Sent from afar');
      // The keyboard stays in the add field while the list is scrolled to the end of the pile with the wheel.
      const end = await scrollList(page, 'end');
      expect(end).toBeGreaterThan(100);
      await expect(add).not.toBeInViewport();
      await add.press('Enter');
      await expect(page.getByRole('button', { name: 'Edit Sent from afar', exact: true })).toBeVisible();
      await expect(add).toBeFocused();
      await inside(page, add);
      await expect(add).toBeInViewport();
      expect(await kinds(page)).toEqual(stack(4, 1, 20));
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});

// ---- Week and Month: one list, the open rows, the blank lines, then the done ones crossed out at the bottom ----------------------------------

const week = (n: number) => periodStart(farDate(n), 'week');
const month = (n: number) => periodStart(farDate(n), 'month');
async function openPeriod(page: Page, view: 'Week' | 'Month', date: string, phone = false) {
  if (phone) {
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await page.getByRole('button', { name: view, exact: true }).click();
    await page.keyboard.press('Escape');
    await page.locator('#pill-date').fill(date);
  } else {
    await page.getByRole('button', { name: view, exact: true }).click();
    await page.locator('#jump-date').fill(date);
  }
  await expect(page.locator(`.wm-panel[data-panel="${view.toLowerCase()}"]`)).toBeVisible();
}

for (const [view, scope, min, pick] of [['Week', 'week', 13, week], ['Month', 'month', 8, month]] as const) {
  test.describe(`${view} to-do, desktop: done rows stack at the bottom of the list`, () => {
    test(`one list: the open rows, the blank lines (the add line first), then the done ones crossed out as the last of the ${min} lines; checking moves a row to the bottom, unchecking brings it back up; no Done heading or block`, async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = pick(770 + (scope === 'week' ? 0 : 20));
      const [a, b] = [await make(owner, { scope, date, title: unique('Alpha') }), await make(owner, { scope, date, title: unique('Bravo') })];
      const c = await make(owner, { scope, date, owners: [PARTNER], title: unique('Charlie') });
      const d = await make(owner, { scope, date, owners: [OWNER], title: unique('Delta') }, true);
      const e = await make(owner, { scope, date, owners: [OWNER, PARTNER], title: unique('Echo') }, true);
      try {
        await login(page, OWNER); await openPeriod(page, view, date);
        const lines = page.locator('ul.wm-todos > li');
        await expect(page.locator('ul.wm-todos')).toHaveCount(1);
        await expect(page.getByRole('list', { name: 'To-do', exact: true })).toHaveCount(1);
        // Three open rows, the blank lines (the add line the first of them), and the two done ones as the last lines of the page.
        expect(await wmKinds(page)).toEqual(stack(3, min - 5, 2));
        await expect(lines).toHaveCount(min);
        await expect(lines.nth(3)).toHaveClass(/\bwm-free-add\b/);
        await expect(lines.nth(min - 2)).toContainText(d.title);
        await expect(lines.nth(min - 1)).toContainText(e.title);
        await noDoneUi(page);
        // The owner colors: the owner's done row green, the linked one purple; the linked one is one row.
        await expect(page.locator('li.wm-todo.done').first()).toHaveAttribute('data-c', 'green');
        await expect(page.locator('li.wm-todo.done').last()).toHaveAttribute('data-c', 'purple');
        await expect(page.locator('li.wm-todo', { hasText: e.title })).toHaveCount(1);
        await expect(page.locator('li.wm-todo.done .wm-todo-title').first()).toHaveCSS('text-decoration-line', 'line-through');
        await expect(page.locator('li.wm-todo:not(.done) .wm-todo-title').first()).toHaveCSS('text-decoration-line', 'none');
        // The blank lines are above the pile, which ends the list.
        const [blank, pile, end] = [(await lines.nth(min - 3).boundingBox())!, (await lines.nth(min - 2).boundingBox())!, (await lines.nth(min - 1).boundingBox())!];
        expect(pile.y).toBeGreaterThanOrEqual(blank.y + blank.height - 1);
        const frame = (await page.locator('ul.wm-todos').boundingBox())!;
        expect(frame.y + frame.height - (end.y + end.height), 'nothing under the pile').toBeLessThanOrEqual(1);
        // Checking the first row moves it to the bottom pile, in front of nothing; the lines are the same.
        await page.getByRole('checkbox', { name: `Complete ${a.title}`, exact: true }).click();
        await expect(page.getByRole('checkbox', { name: `Reopen ${a.title}`, exact: true })).toBeChecked();
        expect(await wmKinds(page)).toEqual(stack(2, min - 5, 3));
        await expect(lines.nth(0)).toContainText(b.title);
        await expect(lines.nth(min - 3)).toContainText(a.title);
        await expect(lines.nth(2)).toHaveClass(/\bwm-free-add\b/);
        await noDoneUi(page);
        // Unchecking it puts it back among the open ones, at its own place, above the blank lines.
        await page.getByRole('checkbox', { name: `Reopen ${a.title}`, exact: true }).click();
        await expect(page.getByRole('checkbox', { name: `Complete ${a.title}`, exact: true })).not.toBeChecked();
        expect(await wmKinds(page)).toEqual(stack(3, min - 5, 2));
        await expect(lines.nth(0)).toContainText(a.title);
        await expect(lines.nth(3)).toHaveClass(/\bwm-free-add\b/);
        // The last open row, finished and reopened, comes back just under the open rows: the add line is right under it again.
        await page.getByRole('checkbox', { name: `Complete ${c.title}`, exact: true }).click();
        await expect(page.getByRole('checkbox', { name: `Reopen ${c.title}`, exact: true })).toBeChecked();
        expect(await wmKinds(page)).toEqual(stack(2, min - 5, 3));
        await page.getByRole('checkbox', { name: `Reopen ${c.title}`, exact: true }).click();
        await expect(page.getByRole('checkbox', { name: `Complete ${c.title}`, exact: true })).not.toBeChecked();
        expect(await wmKinds(page)).toEqual(stack(3, min - 5, 2));
        await expect(lines.nth(2)).toContainText(c.title);
        await expect(lines.nth(3)).toHaveClass(/\bwm-free-add\b/);
        // A done row is edited where it stands and stays crossed out; the blank lines still start a to-do.
        await page.getByRole('button', { name: `Edit ${d.title}`, exact: true }).click();
        const edit = field(page, `Edit to-do: ${d.title}`);
        await expect(edit).toBeFocused();
        await noWindow(page);
        const renamed = unique('Renamed');
        await edit.fill(renamed);
        await edit.press('Enter');
        await expect(page.getByRole('button', { name: `Edit ${renamed}`, exact: true })).toBeFocused();
        await expect(lines.nth(min - 2)).toHaveClass(/\bdone\b/);
        await expect(lines.nth(min - 2)).toContainText(renamed);
        // The add line and the other blank lines are where they were, above the done rows.
        await expect(lines.nth(3)).toHaveClass(/\bwm-free-add\b/);
        await expect(lines.nth(4)).toHaveClass(/\bwm-free\b/);
      } finally { await clearPeriod(owner, scope, date); await owner.dispose(); }
    });

    test(`the page keeps its ${min} lines: each row added takes a blank line from between the open rows and the pile, and the done rows stay the last lines`, async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = pick(780 + (scope === 'week' ? 0 : 20));
      await make(owner, { scope, date, title: 'First open' });
      await make(owner, { scope, date, title: 'Finished one' }, true);
      await make(owner, { scope, date, title: 'Finished two' }, true);
      try {
        await login(page, OWNER); await openPeriod(page, view, date);
        await pickList(page, OWNER_NAME);
        const lines = page.locator('ul.wm-todos > li'), add = page.getByLabel('New to-do', { exact: true });
        expect(await wmKinds(page)).toEqual(stack(1, min - 3, 2));
        for (const [n, title] of [[2, 'Second open'], [3, 'Third open'], [4, 'Fourth open']] as const) {
          await add.fill(title);
          await add.press('Enter');
          await expect(page.getByRole('button', { name: `Edit ${title}`, exact: true })).toBeVisible();
          await expect(lines, 'always the same lines').toHaveCount(min);
          expect(await wmKinds(page)).toEqual(stack(n, min - n - 2, 2));
          await expect(lines.nth(n - 1)).toContainText(title);
          await expect(lines.nth(n)).toHaveClass(/\bwm-free-add\b/);
          await expect(lines.nth(min - 2)).toContainText('Finished one');
          await expect(lines.nth(min - 1)).toContainText('Finished two');
        }
        // One row finished takes the bottom of the pile and frees no line.
        await page.getByRole('checkbox', { name: 'Complete Third open', exact: true }).click();
        await expect(page.getByRole('checkbox', { name: 'Reopen Third open', exact: true })).toBeChecked();
        expect(await wmKinds(page)).toEqual(stack(3, min - 6, 3));
        await expect(lines.nth(min - 1)).toContainText('Third open');
        await noDoneUi(page);
      } finally { await clearPeriod(owner, scope, date); await owner.dispose(); }
    });

    test(`a to-do written on a blank line and left for the ${view}'s text block (where the list cannot be drawn again) is put under the last open row at once, ahead of the blank lines and the done ones`, async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = pick(850 + (scope === 'week' ? 0 : 20));
      await make(owner, { scope, date, title: unique('Still open') });
      await make(owner, { scope, date, title: unique('Finished') }, true);
      await make(owner, { scope, date, title: unique('Finished too') }, true);
      try {
        await login(page, OWNER); await openPeriod(page, view, date);
        await pickList(page, OWNER_NAME);
        const lines = page.locator('ul.wm-todos > li');
        expect(await wmKinds(page)).toEqual(stack(1, min - 3, 2));
        await page.locator('ul.wm-todos > li.wm-free:not(.wm-free-add)').nth(1).click();
        const fresh = field(page, `New to-do for ${OWNER_NAME}`);
        await expect(fresh).toBeFocused();
        await fresh.fill('Swapped in');
        const text = page.getByLabel(`${OWNER_NAME} priorities`, { exact: true });
        await text.click();
        await expect(text).toBeFocused();
        await expect(page.getByRole('button', { name: 'Edit Swapped in', exact: true })).toBeVisible();
        expect(await wmKinds(page)).toEqual(stack(2, min - 4, 2));
        await expect(lines.nth(1)).toContainText('Swapped in');
        await expect(lines.nth(2)).toHaveClass(/\bwm-free-add\b/);
        await expect(page.locator('.wm-new')).toHaveCount(0);
        // The drawing that follows agrees.
        await leaveField(page);
        await expect(page.getByRole('button', { name: 'Edit Swapped in', exact: true })).toBeVisible();
        expect(await wmKinds(page)).toEqual(stack(2, min - 4, 2));
        await expect(lines.nth(1)).toContainText('Swapped in');
      } finally { await clearPeriod(owner, scope, date); await owner.dispose(); }
    });

    test(`more rows than the ${min} lines: the list simply grows (open rows, the add line, then the done ones), nothing inside it scrolls, and the add line stays between the two`, async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = pick(800 + (scope === 'week' ? 0 : 20));
      const open = min - 3, closed = 6;
      for (let n = 1; n <= open; n++) { await make(owner, { scope, date, title: `Open ${String(n).padStart(2, '0')}` }); }
      for (let n = 1; n <= closed; n++) { await make(owner, { scope, date, title: `Finished ${n}` }, true); }
      try {
        await login(page, OWNER); await openPeriod(page, view, date);
        // The rows alone are beyond the lines: one blank line, the add line, between the open rows and the done ones.
        expect(await wmKinds(page)).toEqual(stack(open, 1, closed));
        await expect(page.locator('ul.wm-todos > li.wm-free:not(.wm-free-add)')).toHaveCount(0);
        await expect(page.locator('ul.wm-todos > li').nth(open)).toHaveClass(/\bwm-free-add\b/);
        await noDoneUi(page);
        const list = await page.locator('ul.wm-todos').evaluate(el => ({ overflow: getComputedStyle(el).overflowY, scroll: el.scrollHeight, client: el.clientHeight }));
        // The Week's list grows; the Month's, in the side column, scrolls inside itself only when the room under the Priorities is shorter than it (empty Priorities leave room for these twelve lines).
        expect(list.overflow).toBe(scope === 'week' ? 'visible' : 'auto');
        expect(list.scroll).toBeLessThanOrEqual(list.client + 1);
        // Checking a row moves it down; the list does not get any longer or shorter.
        const before = (await page.locator('ul.wm-todos').boundingBox())!;
        await page.getByRole('checkbox', { name: 'Complete Open 01', exact: true }).click();
        await expect(page.getByRole('checkbox', { name: 'Reopen Open 01', exact: true })).toBeChecked();
        expect(await wmKinds(page)).toEqual(stack(open - 1, 1, closed + 1));
        expect((await page.locator('ul.wm-todos').boundingBox())!.height).toBeCloseTo(before.height, 0);
        // A row added on the add line goes after the open rows, above the add line.
        const add = page.getByLabel('New to-do', { exact: true });
        await add.fill('Brand new');
        await add.press('Enter');
        await expect(page.getByRole('button', { name: 'Edit Brand new', exact: true })).toBeVisible();
        expect(await wmKinds(page)).toEqual(stack(open, 1, closed + 1));
        await expect(page.locator('ul.wm-todos > li').nth(open - 1)).toContainText('Brand new');
        await expect(add).toBeFocused();
      } finally { await clearPeriod(owner, scope, date); await owner.dispose(); }
    });

    test(`Both view: the blank lines between the open rows and the pile are cut in thirds, and a to-do made there lands under the open rows`, async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = pick(870 + (scope === 'week' ? 0 : 20));
      await make(owner, { scope, date, owners: [OWNER], title: 'Open mine' });
      await make(owner, { scope, date, owners: [PARTNER], title: 'Open hers' });
      await make(owner, { scope, date, owners: [OWNER], title: 'Done mine' }, true);
      await make(owner, { scope, date, owners: [OWNER, PARTNER], title: 'Done ours' }, true);
      try {
        await login(page, OWNER); await openPeriod(page, view, date);
        const lines = page.locator('ul.wm-todos > li');
        expect(await wmKinds(page)).toEqual(stack(2, min - 4, 2));
        // A blank line well under the add line: a hover on its right third is the partner's, and a click on its middle makes one to-do for both, written on that line.
        const blank = lines.nth(min - 4), box = (await blank.boundingBox())!;
        await expect(blank).toHaveClass(/\bwm-free\b/);
        await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2);
        await expect(ghost(page)).toHaveAttribute('data-c', 'yellow');
        await expect(ghost(page)).toHaveAttribute('data-side', 'right');
        await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
        const fresh = field(page, `New to-do for ${OWNER_NAME} and ${PARTNER_NAME}`);
        await expect(fresh).toBeFocused();
        const editing = (await page.locator('.wm-new').boundingBox())!;
        expect(Math.abs(editing.y - box.y), 'it opens on the line that was clicked').toBeLessThanOrEqual(2);
        await fresh.fill('Linked new');
        await fresh.press('Enter');
        await expect(page.getByRole('checkbox', { name: 'Complete Linked new', exact: true })).toBeVisible();
        expect(await wmKinds(page)).toEqual(stack(3, min - 5, 2));
        await expect(lines.nth(2)).toContainText('Linked new');
        await expect(lines.nth(2)).toHaveAttribute('data-c', 'purple');
        await expect(lines.nth(3)).toHaveClass(/\bwm-free-add\b/);
        await expect(page.locator('.wm-new')).toHaveCount(0);
      } finally { await clearPeriod(owner, scope, date); await owner.dispose(); }
    });
  });
}

test.describe('Month to-do, desktop: the list that scrolls inside the side column keeps its keyboard rings', () => {
  test('the ring of every control lies whole inside the list: the first row, the last, and the add field', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = month(940);
    for (let n = 1; n <= 20; n++) { await make(owner, { scope: 'month', date, title: `Ring ${String(n).padStart(2, '0')}` }); }
    try {
      await login(page, OWNER); await openPeriod(page, 'Month', date);
      await pickList(page, OWNER_NAME);
      const list = page.locator('ul.wm-todos');
      expect(await list.evaluate(el => el.scrollHeight > el.clientHeight), 'twenty rows are more than the list shows').toBe(true);
      // From the first circle by the keyboard to the add field: every circle (at the list's left edge) and title (at its right), the first row's at the very top.
      await page.getByRole('checkbox', { name: 'Complete Ring 01', exact: true }).focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      const stops = await walkRings(page, 'ul.wm-todos', 60);
      expect(stops.length, '20 circles, 20 titles and the add field').toBe(41);
      expect(stops[0]).toContain('Complete Ring 01');
      expect(stops.at(-1)).toContain('New to-do');
      expect(await listTop(page, 'ul.wm-todos'), 'the walk scrolled the list to its last row').toBeGreaterThan(20);
    } finally { await clearPeriod(owner, 'month', date); await owner.dispose(); }
  });
});

test.describe('Week and Month to-do on a phone-sized page: done rows stack at the bottom of the list', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  for (const [view, scope, , pick] of [['Week', 'week', 13, week], ['Month', 'month', 8, month]] as const) {
    test(`${view}: the To-do tab is one list, the add line under the open rows and the crossed-out rows as the last lines, a finger-sized line each, scrolling in the panel above the bar`, async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = pick(830 + (scope === 'week' ? 0 : 20));
      for (let n = 1; n <= 3; n++) { await make(owner, { scope, date, title: `Open ${n}` }); }
      for (let n = 1; n <= 12; n++) { await make(owner, { scope, date, title: `Finished ${String(n).padStart(2, '0')}` }, true); }
      try {
        await login(page, OWNER); await openPeriod(page, view, date, true);
        await page.getByRole('tab', { name: 'To-do', exact: true }).tap();
        expect(await wmKinds(page)).toEqual(stack(3, 1, 12));
        await expect(page.locator('ul.wm-todos > li').nth(3)).toHaveClass(/\bwm-free-add\b/);
        await noDoneUi(page);
        const heights = await page.locator('ul.wm-todos > li').evaluateAll(els => els.map(el => el.getBoundingClientRect().height));
        expect(Math.min(...heights), 'a finger-sized line each').toBeGreaterThanOrEqual(39.5);
        // The panel scrolls (as a long list always did); the page and the bar do not move.
        const body = page.locator('.wm-body');
        expect(await body.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
        expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
        // A tap on a circle sends the row down to the pile and back up under the open rows.
        await page.getByRole('checkbox', { name: 'Complete Open 1', exact: true }).tap();
        await expect(page.getByRole('checkbox', { name: 'Reopen Open 1', exact: true })).toBeChecked();
        expect(await wmKinds(page)).toEqual(stack(2, 1, 13));
        await expect(page.locator('ul.wm-todos > li').nth(2)).toHaveClass(/\bwm-free-add\b/);
        await page.getByRole('checkbox', { name: 'Reopen Open 1', exact: true }).tap();
        await expect(page.getByRole('checkbox', { name: 'Complete Open 1', exact: true })).not.toBeChecked();
        expect(await wmKinds(page)).toEqual(stack(3, 1, 12));
        await expect(page.locator('ul.wm-todos > li').nth(0)).toContainText('Open 1');
      } finally { await clearPeriod(owner, scope, date); await owner.dispose(); }
    });

    test(`${view}: a redraw keeps the body where it was scrolled (an edit opened, cancelled and saved, a row reopened, a to-do added on the add line), and the keyboard stays in view`, async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = pick(1000 + (scope === 'week' ? 0 : 40));
      for (let n = 1; n <= 3; n++) { await make(owner, { scope, date, title: `Open ${n}` }); }
      for (let n = 1; n <= 20; n++) { await make(owner, { scope, date, title: `Done ${String(n).padStart(2, '0')}` }, true); }
      try {
        await login(page, OWNER); await openPeriod(page, view, date, true);
        await page.getByRole('tab', { name: 'To-do', exact: true }).tap();
        const body = '.wm-body', top = await scrollList(page, 300, body);
        expect(top, 'the body is scrolled').toBeGreaterThan(100);
        const [title, next] = [await middleRow(page, body, 'li.wm-todo.done', '.wm-todo-title'), await middleRow(page, body, 'li.wm-todo.done', '.wm-todo-title', 1)];
        const id = (await owner.snapshot()).tasks.find((t: { title: string }) => t.title === title).id, row = page.locator(`li.wm-todo[data-id="${id}"]`), was = (await row.boundingBox())!;
        const kept = async (what: string) => { expect(Math.abs((await listTop(page, body)) - top), `${what}: the body keeps its place`).toBeLessThanOrEqual(1); };
        await page.getByRole('button', { name: `Edit ${title}`, exact: true }).tap();
        await expect(field(page, `Edit to-do: ${title}`)).toBeFocused();
        await kept('edit opened');
        expect(Math.abs((await row.boundingBox())!.y - was.y), 'the row did not jump').toBeLessThanOrEqual(1);
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-editing]')).toHaveCount(0);
        await kept('edit cancelled');
        await expect(page.getByRole('button', { name: `Edit ${title}`, exact: true })).toBeFocused();
        await inside(page, page.getByRole('button', { name: `Edit ${title}`, exact: true }), body);
        await page.getByRole('button', { name: `Edit ${title}`, exact: true }).tap();
        await field(page, `Edit to-do: ${title}`).fill(`${title} renamed`);
        await field(page, `Edit to-do: ${title}`).press('Enter');
        await expect(page.getByRole('button', { name: `Edit ${title} renamed`, exact: true })).toBeFocused();
        await kept('edit saved');
        await inside(page, page.getByRole('button', { name: `Edit ${title} renamed`, exact: true }), body);
        await page.getByRole('checkbox', { name: `Reopen ${next}`, exact: true }).tap();
        await expect(page.getByRole('checkbox', { name: `Complete ${next}`, exact: true })).not.toBeChecked();
        await kept('row reopened');
        // The add line, under the open rows: the body is scrolled a little so it is near the top; a tap on it, a title, Enter; the add field is focused again, one line lower, and on screen.
        const add = page.locator('[data-key="wm:add"]'), near = await scrollList(page, 60, body);
        expect(near, 'the body is scrolled a little').toBeGreaterThan(20);
        await inside(page, add, body);
        await add.tap();
        const fresh = field(page, /^New to-do for /);
        await expect(fresh).toBeFocused();
        await fresh.fill('Typed new');
        await fresh.press('Enter');
        await expect(page.getByRole('button', { name: 'Edit Typed new', exact: true })).toBeVisible();
        await expect(add).toBeFocused();
        await inside(page, add, body);
        expect(await listTop(page, body), 'not thrown back to the top').toBeGreaterThan(near - 2);
      } finally { await clearPeriod(owner, scope, date); await owner.dispose(); }
    });
  }
});
