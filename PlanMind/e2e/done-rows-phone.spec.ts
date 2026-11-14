import { expect, test, type Page } from '@playwright/test';
import { CAPS } from '../packages/core/src/planner';
import { addTodo, apiLogin, farDate, field, inside, listTop, login, middleRow, noWindow, pickList, resetPrefs, scrollList, todo, unique, walkRings, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// Done to-dos on the Day's To-do tab of a phone: never hidden, never behind a button. They stay in the one list, crossed out, and stack at the
// bottom of it: the open rows from the top, the blank ruled lines under them (the add field the first), the done rows as the last lines of the
// 13. The tab itself never scrolls and the rows never shrink below 30px: when the 13 lines or the open and done rows together are more than the
// tab shows, the list scrolls inside the tab (a phone under about 700px high has to scroll to the pile). (The same on a desktop and in the Week and Month: done-rows.spec.ts.)
test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });
const MAX = CAPS.dayTodosPerList;

const openDay = async (page: Page, date: string) => {
  await page.locator('#pill-date').fill(date);
  await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', date);
};
async function clearDay(api: Api, date: string) {
  const snapshot = await api.snapshot();
  for (const item of [...snapshot.tasks, ...snapshot.priorities, ...snapshot.events].filter((i: { date: string }) => i.date === date)) {
    await api.post({ action: 'delete', id: item.id, revision: item.revision, confirm: true });
  }
}
async function make(api: Api, over: Record<string, unknown>, done = false) {
  const body = todo(over);
  const response = await api.post(body);
  expect(response.status(), JSON.stringify(await response.json())).toBe(200);
  if (done) { expect((await api.post({ action: 'complete', id: body.id, revision: 1, done: true })).status()).toBe(200); }
  return { id: body.id as string, title: body.title as string };
}
const goToTodo = async (page: Page) => {
  const tab = page.getByRole('tab', { name: 'To-do', exact: true });
  await tab.tap();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
};
const kinds = (page: Page) => page.locator('.day-tasks > li').evaluateAll(lis => lis.map(li => (li.classList.contains('day-done') ? 'done' : li.classList.contains('day-task') ? 'open' : 'free')));
const same = (kind: string, n: number) => Array<string>(n).fill(kind);
/** The page top to bottom: `open` open rows, `free` blank lines (the first is the add field), `done` crossed-out rows as the last lines. */
const stack = (open: number, free: number, done: number) => [...same('open', open), ...same('free', free), ...same('done', done)];
/** Nothing scrolls but the list: not the page, not the tab's body, not the panel's host, and the tab bar is on screen. */
async function expectFits(page: Page, label: string) {
  const fit = await page.evaluate(() => {
    const host = document.querySelector('#period-panel')!, body = document.querySelector('.day-body')!, bar = document.querySelector('.day-tabs')!.getBoundingClientRect();
    return { host: host.scrollHeight - host.clientHeight, body: body.scrollHeight - body.clientHeight, page: document.documentElement.scrollHeight - innerHeight, sideways: document.documentElement.scrollWidth - innerWidth, bar: bar.bottom - innerHeight };
  });
  expect(fit, label).toEqual({ host: 0, body: 0, page: 0, sideways: 0, bar: expect.any(Number) });
  expect(fit.bar, label).toBeLessThanOrEqual(0);
}
async function noDoneUi(page: Page) {
  await expect(page.getByRole('button', { name: /^Done \(/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /^Done/ })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Done' })).toHaveCount(0);
  await expect(page.getByText(/^Done \(\d+\)$/)).toHaveCount(0);
  await expect(page.locator('.day-donelist, [data-list=done]')).toHaveCount(0);
}

for (const [width, height] of [[375, 812], [375, 667], [320, 568]] as const) {
  test.describe(`Day To-do tab, phone ${width}x${height}: done rows stay in the list`, () => {
    test.use({ viewport: { width, height } });
    const n = (width === 375 ? (height === 812 ? 0 : 1) : 2);

    test('crossed out as the last lines of the page, under the blank lines, no Done button; a tap on the circle moves a row to the bottom and back up; a done row is edited where it stands; the tab fits', async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = farDate(840 + n);
      const [a, b] = [await make(owner, { date, title: unique('Alpha') }), await make(owner, { date, title: unique('Bravo') })];
      await make(owner, { date, title: unique('Charlie') });
      const d = await make(owner, { date, title: unique('Delta') }, true);
      await make(owner, { date, title: unique('Echo') }, true);
      try {
        await login(page); await openDay(page, date);
        await pickList(page, OWNER_NAME);
        await goToTodo(page);
        const lines = page.locator('.day-tasks > li');
        // Three open rows, the rest of the 13 lines blank (the add field the first of them, right under the open rows), then the two done ones as the last two lines.
        expect(await kinds(page)).toEqual(stack(3, MAX - 5, 2));
        await expect(lines.nth(3).getByLabel('New task', { exact: true })).toBeVisible();
        await expect(lines.nth(MAX - 2)).toContainText(d.title);
        await expect(page.locator('.day-todo [data-kind=todos]')).toHaveText(`3 of ${MAX}`);
        await noDoneUi(page);
        await expectFits(page, 'to-do with done rows');
        const closed = page.locator('.day-tasks .day-task.day-done .day-task-title').first();
        await expect(closed).toHaveCSS('text-decoration-line', 'line-through');
        await expect(page.locator('.day-tasks .day-task:not(.day-done) .day-task-title').first()).toHaveCSS('text-decoration-line', 'none');
        await expect(page.getByRole('checkbox', { name: `Reopen ${d.title}`, exact: true })).toBeChecked();
        const heights = await lines.evaluateAll(els => els.map(el => el.getBoundingClientRect().height));
        expect(Math.min(...heights), 'no line under 30px').toBeGreaterThanOrEqual(29.9);
        // A tap on the circle sends the row to the bottom of the pile; a tap on its circle again brings it back up among the open rows.
        await page.getByRole('checkbox', { name: `Complete ${a.title}`, exact: true }).tap();
        await expect(page.getByRole('checkbox', { name: `Reopen ${a.title}`, exact: true })).toBeChecked();
        expect(await kinds(page)).toEqual(stack(2, MAX - 5, 3));
        await expect(lines.nth(0)).toContainText(b.title);
        await expect(lines.nth(MAX - 3)).toContainText(a.title);
        await expect(lines.nth(2)).toHaveClass(/day-free-add/);
        await expectFits(page, 'to-do after a row was finished');
        await page.getByRole('checkbox', { name: `Reopen ${a.title}`, exact: true }).tap();
        await expect(page.getByRole('checkbox', { name: `Complete ${a.title}`, exact: true })).not.toBeChecked();
        expect(await kinds(page)).toEqual(stack(3, MAX - 5, 2));
        await expect(lines.nth(0)).toContainText(a.title);
        await expect(lines.nth(3)).toHaveClass(/day-free-add/);
        // A done row is edited where it stands: no window, same place and size, still crossed out afterwards (a short phone scrolls its list to the pile first).
        const row = lines.nth(MAX - 2);
        await row.scrollIntoViewIfNeeded();
        const before = (await row.boundingBox())!;
        await page.getByRole('button', { name: `Edit ${d.title}`, exact: true }).tap();
        const edit = field(page, `Edit task: ${d.title}`);
        await expect(edit).toBeFocused();
        await noWindow(page);
        const after = (await row.boundingBox())!;
        expect(Math.abs(after.y - before.y) + Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
        await expectFits(page, 'to-do while a done row is edited');
        const renamed = unique('Renamed');
        await edit.fill(renamed);
        await edit.press('Enter');
        await expect(page.getByRole('button', { name: `Edit ${renamed}`, exact: true })).toBeFocused();
        await expect(lines.nth(MAX - 2)).toHaveClass(/day-done/);
        await expect(lines.nth(MAX - 2)).toContainText(renamed);
        await expectFits(page, 'to-do after the done row was saved');
      } finally { await clearDay(owner, date); await owner.dispose(); }
    });

    test('more rows than lines: the tab still fits, only the list scrolls, every row keeps 30px, and the add field and a new row are reachable', async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = farDate(850 + n);
      for (let k = 1; k <= 3; k++) { await make(owner, { date, title: `Open ${k}` }); }
      for (let k = 1; k <= 16; k++) { await make(owner, { date, title: `Finished ${String(k).padStart(2, '0')}` }, true); }
      try {
        await login(page); await openDay(page, date);
        await pickList(page, OWNER_NAME);
        await goToTodo(page);
        const lines = page.locator('.day-tasks > li'), add = page.getByLabel('New task', { exact: true });
        // 19 rows and the add line: the one blank line is between the 3 open rows and the 16 done ones.
        expect(await kinds(page)).toEqual(stack(3, 1, 16));
        await expect(lines.nth(3)).toHaveClass(/day-free-add/);
        await noDoneUi(page);
        await expectFits(page, 'to-do, more rows than lines');
        const list = await page.locator('.day-tasks').evaluate(el => ({ overflow: getComputedStyle(el).overflowY, client: el.clientHeight, scroll: el.scrollHeight, rows: [...el.children].map(li => li.getBoundingClientRect().height) }));
        expect(list.overflow).toBe('auto');
        expect(list.scroll, 'the list has more than it shows').toBeGreaterThan(list.client + 20);
        expect(Math.min(...list.rows), 'no row below 30px').toBeGreaterThanOrEqual(29.9);
        // The add field is under the open rows, above the pile: reached by the list's own place (no scrolling needed from the top), it takes a to-do, which goes
        // after the open rows, above the add line and the done ones.
        await add.scrollIntoViewIfNeeded();
        await expect(add).toBeInViewport();
        await add.fill('Added late');
        await page.getByRole('button', { name: 'Add', exact: true }).tap();
        await expect(page.getByRole('button', { name: 'Edit Added late', exact: true })).toBeVisible();
        expect(await kinds(page)).toEqual(stack(4, 1, 16));
        await expect(lines.nth(3)).toContainText('Added late');
        await expect(lines.nth(4)).toHaveClass(/day-free-add/);
        await expect(lines.nth(5)).toContainText('Finished 01');
        await expectFits(page, 'to-do after a to-do was added above the pile');
        // The last done row can be reached too (the list scrolls to the end of the pile), and tapped; it goes up among the open rows.
        await page.getByRole('checkbox', { name: 'Reopen Finished 16', exact: true }).tap();
        await expect(page.getByRole('checkbox', { name: 'Complete Finished 16', exact: true })).not.toBeChecked();
        expect(await kinds(page)).toEqual(stack(5, 1, 15));
        await expectFits(page, 'to-do after the last done row was reopened');
      } finally { await clearDay(owner, date); await owner.dispose(); }
    });

    test('the keyboard ring of every control in the list lies whole inside the list, the circles at its left edge and the last row at its bottom', async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = farDate(940 + n);
      for (let k = 1; k <= 3; k++) { await make(owner, { date, title: `Open ${k}` }); }
      for (let k = 1; k <= 16; k++) { await make(owner, { date, title: `Finished ${String(k).padStart(2, '0')}` }, true); }
      try {
        await login(page); await openDay(page, date);
        await pickList(page, OWNER_NAME);
        await goToTodo(page);
        await page.getByRole('checkbox', { name: 'Complete Open 1', exact: true }).focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        const stops = await walkRings(page, '.day-tasks', 60);
        expect(stops.length, '19 circles, 19 titles and the add field').toBe(39);
        expect(stops[6], 'the add field comes after the three open rows').toContain('New task');
        expect(stops.at(-1)).toContain('Edit Finished 16');
        await expectFits(page, 'to-do after the keyboard walked the list');
      } finally { await clearDay(owner, date); await owner.dispose(); }
    });

    test('a redraw keeps the list where it was scrolled: an edit opened, cancelled and saved, a row reopened; the touched row stays put and the keyboard stays in view', async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = farDate(945 + n);
      for (let k = 1; k <= 3; k++) { await make(owner, { date, title: `Open ${k}` }); }
      for (let k = 1; k <= 20; k++) { await make(owner, { date, title: `Done ${String(k).padStart(2, '0')}` }, true); }
      try {
        await login(page); await openDay(page, date);
        await pickList(page, OWNER_NAME);
        await goToTodo(page);
        const top = await scrollList(page, 150);
        expect(top, 'the list is scrolled').toBeGreaterThan(60);
        const [title, next] = [await middleRow(page, '.day-tasks', '.day-task', '.day-task-title'), await middleRow(page, '.day-tasks', '.day-task', '.day-task-title', 1)];
        const id = (await owner.snapshot()).tasks.find((t: { title: string }) => t.title === title).id, row = page.locator(`.day-task[data-id="${id}"]`);
        const was = (await row.boundingBox())!;
        const kept = async (what: string) => { expect(Math.abs((await listTop(page)) - top), `${what}: the list keeps its place`).toBeLessThanOrEqual(1); };
        // An edit opened on a row in the middle of the view: the row stays where it is.
        await page.getByRole('button', { name: `Edit ${title}`, exact: true }).tap();
        await expect(field(page, `Edit task: ${title}`)).toBeFocused();
        await kept('edit opened');
        expect(Math.abs((await row.boundingBox())!.y - was.y), 'the row did not jump').toBeLessThanOrEqual(1);
        await expectFits(page, 'to-do while a row in the middle is edited');
        // Escape: the same place, the button of the row has the keyboard and is on screen.
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-editing]')).toHaveCount(0);
        await kept('edit cancelled');
        expect(Math.abs((await row.boundingBox())!.y - was.y)).toBeLessThanOrEqual(1);
        await expect(page.getByRole('button', { name: `Edit ${title}`, exact: true })).toBeFocused();
        await inside(page, page.getByRole('button', { name: `Edit ${title}`, exact: true }));
        // Enter saves it, the same.
        await page.getByRole('button', { name: `Edit ${title}`, exact: true }).tap();
        const renamed = `${title} renamed`;
        await field(page, `Edit task: ${title}`).fill(renamed);
        await field(page, `Edit task: ${title}`).press('Enter');
        await expect(page.getByRole('button', { name: `Edit ${renamed}`, exact: true })).toBeFocused();
        await kept('edit saved');
        expect(Math.abs((await row.boundingBox())!.y - was.y)).toBeLessThanOrEqual(1);
        await inside(page, page.getByRole('button', { name: `Edit ${renamed}`, exact: true }));
        // A tap on the circle of another row in view reopens it: the list does not go back to the top.
        await page.getByRole('checkbox', { name: `Reopen ${next}`, exact: true }).tap();
        await expect(page.getByRole('checkbox', { name: `Complete ${next}`, exact: true })).not.toBeChecked();
        await kept('row reopened');
        await expectFits(page, 'to-do after the redraws');
      } finally { await clearDay(owner, date); await owner.dispose(); }
    });

    test('a to-do written from the add line of a list longer than its box: the add field comes back focused and on screen, one line lower, and the list does not go back to its top', async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = farDate(955 + n);
      for (let k = 1; k <= 3; k++) { await make(owner, { date, title: `Open ${k}` }); }
      for (let k = 1; k <= 20; k++) { await make(owner, { date, title: `Done ${k}` }, true); }
      try {
        await login(page); await openDay(page, date);
        await pickList(page, OWNER_NAME);
        await goToTodo(page);
        const add = page.locator('[data-key="todo:add"]'), lines = page.locator('.day-tasks > li');
        // The add line is under the three open rows with the pile under it; the list is scrolled a little, so the add line is still on screen.
        const at = await scrollList(page, 40);
        expect(at, 'the list is scrolled').toBeGreaterThan(20);
        await inside(page, add);
        await add.tap();
        const fresh = field(page, `New to-do for ${OWNER_NAME}`);
        await expect(fresh).toBeFocused();
        await inside(page, fresh);
        expect(Math.abs((await listTop(page)) - at)).toBeLessThanOrEqual(1);
        await fresh.fill('Typed new');
        await fresh.press('Enter');
        await expect(page.getByRole('button', { name: 'Edit Typed new', exact: true })).toBeVisible();
        await expect(add).toBeFocused();
        await inside(page, add);
        expect(await listTop(page), 'not thrown back to the top').toBeGreaterThan(at - 2);
        expect(await kinds(page)).toEqual(stack(4, 1, 20));
        await expect(lines.nth(3)).toContainText('Typed new');
        await expectFits(page, 'to-do after a to-do was written on the add line');
      } finally { await clearDay(owner, date); await owner.dispose(); }
    });

    test('the page keeps its 13 lines: each row added takes a blank line from between the open rows and the pile, and the done rows stay the last lines', async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = farDate(965 + n);
      await make(owner, { date, title: 'First open' });
      await make(owner, { date, title: 'Finished one' }, true);
      await make(owner, { date, title: 'Finished two' }, true);
      try {
        await login(page); await openDay(page, date);
        await pickList(page, OWNER_NAME);
        await goToTodo(page);
        const lines = page.locator('.day-tasks > li');
        expect(await kinds(page)).toEqual(stack(1, MAX - 3, 2));
        for (const [k, title] of [[2, 'Second open'], [3, 'Third open']] as const) {
          await addTodo(page, title);
          await expect(lines, 'always the same 13 lines').toHaveCount(MAX);
          expect(await kinds(page)).toEqual(stack(k, MAX - k - 2, 2));
          await expect(lines.nth(k - 1)).toContainText(title);
          await expect(lines.nth(k)).toHaveClass(/day-free-add/);
          await expect(lines.nth(MAX - 1)).toContainText('Finished two');
          await expectFits(page, 'to-do after a row was added');
        }
        await noDoneUi(page);
      } finally { await clearDay(owner, date); await owner.dispose(); }
    });

    test('Both view: done rows keep their owner color, a linked one is one row, and a tap on a blank line above them still starts a to-do that lands under the open rows', async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = farDate(860 + n);
      await make(owner, { date, owners: [OWNER], title: 'Open mine' });
      await make(owner, { date, owners: [PARTNER], title: 'Open hers' });
      await make(owner, { date, owners: [OWNER], title: 'Done mine' }, true);
      await make(owner, { date, owners: [PARTNER], title: 'Done hers' }, true);
      await make(owner, { date, owners: [OWNER, PARTNER], title: 'Done ours' }, true);
      try {
        await login(page); await openDay(page, date);
        await goToTodo(page);
        const done = page.locator('.day-tasks .day-task.day-done');
        expect(await kinds(page)).toEqual(stack(2, MAX - 5, 3));
        expect(await done.locator('.day-circle').evaluateAll(els => els.map(el => (el as HTMLElement).dataset.c))).toEqual(['green', 'yellow', 'purple']);
        await expect(done.locator('.day-who')).toHaveText([OWNER_NAME, PARTNER_NAME, 'Both']);
        await expect(page.locator('.day-task', { hasText: 'Done ours' })).toHaveCount(1);
        await noDoneUi(page);
        // A tap in the middle of a blank line (line 7: open rows above it, the pile below it) is one to-do for both of us, in place; saved, it is the third open row.
        const line = page.locator('.day-tasks > li[data-slot="7"]'), box = (await line.boundingBox())!;
        await page.touchscreen.tap(box.x + box.width * 0.5, box.y + box.height / 2);
        const fresh = field(page, `New to-do for ${OWNER_NAME} and ${PARTNER_NAME}`);
        await expect(fresh).toBeFocused();
        await expectFits(page, 'to-do while a new one is written');
        await fresh.fill('Family dinner');
        await fresh.press('Enter');
        await expect(page.getByRole('checkbox', { name: 'Complete Family dinner', exact: true })).toHaveAttribute('data-c', 'purple');
        expect(await kinds(page)).toEqual(stack(3, MAX - 6, 3));
        await expect(page.locator('.day-tasks > li').nth(2)).toContainText('Family dinner');
        await expect(page.locator('.day-tasks > li').nth(3)).toHaveClass(/day-free-add/);
        await expectFits(page, 'to-do after a new one was saved');
      } finally { await clearDay(owner, date); await owner.dispose(); }
    });
  });
}
