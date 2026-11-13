import { expect, test, type Page } from '@playwright/test';
import { CAPS, SCHEDULE_ROWS } from '../packages/core/src/planner';
import { apiLogin, browserStorage, farDate, field, leaveField, login, noWindow, pickList, resetPrefs, unique, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// The Day panel on a desktop. Each test owns one far-away date, fills it through the API and empties it again, so
// nothing leaks into the shared disposable server.
const add = async (api: Api, body: Record<string, unknown>) => {
  const data = { id: crypto.randomUUID(), ...body };
  const response = await api.post(data);
  expect(response.status(), JSON.stringify(await response.json())).toBe(200);
  return data.id as string;
};
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
const MAX = CAPS.dayTodosPerList;
const chars = (page: Page) => page.locator('.day-todo [data-kind=chars]');
const todos = (page: Page) => page.locator('.day-todo [data-kind=todos]');

test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });

test.describe('Day panel, desktop', () => {
  test('two columns, the signed-in person first, and blocks sit on their start and length', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(100);
    await add(owner, { action: 'add', kind: 'event', date, owners: [OWNER], text: 'Dentist', start: 540, length: 60 });
    try {
      await login(page); await openDay(page, date);
      const box = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
      const [sched, notes, prio, todo] = [await box('.day-sched'), await box('.day-notes'), await box('.day-prio'), await box('.day-todo')];
      expect(sched.x).toBeLessThan(prio.x);
      expect(Math.abs(notes.x - sched.x)).toBeLessThan(2);
      expect(Math.abs(todo.x - prio.x)).toBeLessThan(2);
      expect(notes.y).toBeGreaterThan(sched.y + sched.height - 2);
      expect(todo.y).toBeGreaterThan(prio.y + prio.height - 2);
      await expect(page.locator('.day-sched .day-lane')).toHaveText([`${OWNER_NAME} · you`, PARTNER_NAME]);
      // The page opens on AM, the day as it always was: 14 hour rows, 7a to 8p (PM is the night, 9p to 6a; day-half.spec.ts).
      await expect(page.locator('.day-hours span')).toHaveText(SCHEDULE_ROWS.slice(0, 14));
      await expect(page.locator('.day-prow')).toHaveCount(5);
      // 9:00 for an hour on a 7:00 to 21:00 grid: two fourteenths down, one fourteenth tall.
      const grid = await box('.day-lanes'), block = (await page.getByRole('button', { name: new RegExp(String.raw`^Dentist, 9a to 10a, ${OWNER_NAME}$`) }).boundingBox())!;
      expect(Math.abs(block.y - (grid.y + (grid.height * 2) / 14))).toBeLessThanOrEqual(4);
      expect(Math.abs(block.height - grid.height / 14)).toBeLessThanOrEqual(4);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('to-do: add under Both and under one list, no For control, live counters, 36 characters of code points, complete, edit keeps the owners, delete', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(101);
    try {
      await login(page); await openDay(page, date);
      await expect(todos(page)).toHaveText(`0 of ${MAX}`);
      await expect(page.getByRole('radiogroup')).toHaveCount(0);
      await expect(page.getByText('For', { exact: true })).toHaveCount(0);
      const box = page.getByLabel('New task', { exact: true }), go = page.getByRole('button', { name: 'Add', exact: true });
      // Over the cap: the counter turns, Add is blocked and says why. Exactly 36 characters is fine.
      await box.fill('x'.repeat(37));
      await expect(chars(page)).toHaveText('37 / 36');
      await expect(chars(page)).toHaveAttribute('data-over', 'true');
      await expect(go).toBeDisabled();
      await expect(page.locator('.day-msg')).toHaveText('Keep it to 36 characters.');
      // Characters are code points, not UTF-16 units: 36 emoji are 72 units and still fit.
      const emoji = '😀'.repeat(36);
      await box.fill(emoji);
      await expect(chars(page)).toHaveText('36 / 36');
      await expect(go).toBeEnabled();
      await go.click();
      await expect(page.getByRole('button', { name: `Edit ${emoji}`, exact: true })).toBeVisible();
      await expect(todos(page)).toHaveText(`1 of ${MAX}`);
      // Under the Both view the top picker says Both: one linked row, in the Both color, counted for each list.
      const linked = page.locator('.day-task', { has: page.getByRole('button', { name: `Edit ${emoji}`, exact: true }) });
      await expect(linked.locator('.day-circle')).toHaveAttribute('data-c', 'purple');

      const title = unique('Mine');
      await box.fill(title);
      // The one selector is the picker at the top: under the owner the new to-do is the owner's alone.
      await pickList(page, OWNER_NAME);
      await expect(todos(page)).toHaveText(`1 of ${MAX}`);
      await go.click();
      const row = page.locator('.day-task', { has: page.getByRole('button', { name: `Edit ${title}`, exact: true }) });
      await expect(row.locator('.day-circle')).toHaveAttribute('data-c', 'green');
      await expect(todos(page)).toHaveText(`2 of ${MAX}`);
      expect((await owner.snapshot()).tasks.find((t: { title: string }) => t.title === title)).toMatchObject({ owners: [OWNER], date, scope: 'day', done: false });

      // Complete and reopen: the row stays in the list, crossed out after the open rows; reopening brings it back among them.
      await page.getByRole('checkbox', { name: `Complete ${title}`, exact: true }).click();
      await expect(page.getByRole('checkbox', { name: `Reopen ${title}`, exact: true })).toBeChecked();
      await expect(row).toHaveClass(/day-done/);
      await expect(page.locator('.day-task').last()).toContainText(title);
      await page.getByRole('checkbox', { name: `Reopen ${title}`, exact: true }).click();
      await expect(page.getByRole('checkbox', { name: `Complete ${title}`, exact: true })).not.toBeChecked();

      // Edit: rename, where the row is. There is no window and no For control, and the owner stays: it is the owner's, still green, still one owner.
      await page.getByRole('button', { name: `Edit ${title}`, exact: true }).click();
      const edit = field(page, `Edit task: ${title}`);
      await expect(edit).toBeFocused();
      await noWindow(page);
      await expect(page.getByRole('radiogroup')).toHaveCount(0);
      await expect(page.getByText('For', { exact: true })).toHaveCount(0);
      const renamed = unique('Renamed');
      await edit.fill(renamed);
      await edit.press('Enter');
      await expect(edit).toHaveCount(0);
      // The keyboard goes back to the row's own button.
      await expect(page.getByRole('button', { name: `Edit ${renamed}`, exact: true })).toBeFocused();
      const hers = page.locator('.day-task', { has: page.getByRole('button', { name: `Edit ${renamed}`, exact: true }) });
      await expect(hers.locator('.day-circle')).toHaveAttribute('data-c', 'green');
      await expect(hers.locator('.day-who')).toHaveText(OWNER_NAME);
      expect((await owner.snapshot()).tasks.find((t: { title: string }) => t.title === renamed)).toMatchObject({ owners: [OWNER], revision: 4 });

      // Delete is two presses in the row: the first turns the icon red (it is then Confirm delete).
      await page.getByRole('button', { name: `Edit ${renamed}`, exact: true }).click();
      await page.getByRole('button', { name: `Delete task: ${renamed}`, exact: true }).click();
      await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
      await expect(page.getByRole('button', { name: `Edit ${renamed}`, exact: true })).toHaveCount(0);
      expect((await owner.snapshot()).tasks.some((t: { title: string }) => t.title === renamed)).toBe(false);
      await noWindow(page);
      expect(await browserStorage(page)).toEqual({ local: 0, session: 0, indexedDB: 0, caches: 0 });
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('an add whose reply was lost keeps its text, and the retry sends the same id; a new add after a success has a new id', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(104);
    const posts: { id: string; title: string }[] = [];
    let lose = true;
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      await page.route(url => url.pathname.endsWith('/api.php'), route => {
        const request = route.request();
        if (request.method() !== 'POST') { return route.continue(); }
        const body = request.postDataJSON();
        if (body.action === 'add') { posts.push({ id: body.id, title: body.title }); }
        return lose ? route.abort('failed') : route.continue();
      });
      const box = page.getByLabel('New task', { exact: true }), go = page.getByRole('button', { name: 'Add', exact: true });
      await box.fill('Might have saved');
      await go.click();
      await expect(page.getByRole('alert')).toContainText('may have saved');
      await expect(box).toHaveValue('Might have saved');
      // The retry of the same to-do is the same add: if the first one did reach the server, it cannot be written twice.
      await go.click();
      await expect.poll(() => posts.length).toBe(2);
      expect(posts[1]).toEqual(posts[0]);
      lose = false;
      await go.click();
      await expect(page.getByRole('button', { name: 'Edit Might have saved', exact: true })).toBeVisible();
      expect(posts).toHaveLength(3);
      expect(posts[2].id).toBe(posts[0].id);
      await box.fill('Second one');
      await go.click();
      await expect(page.getByRole('button', { name: 'Edit Second one', exact: true })).toBeVisible();
      expect(posts[3].id).not.toBe(posts[0].id);
      expect((await owner.snapshot()).tasks.filter((t: { date: string }) => t.date === date).map((t: { title: string }) => t.title).sort()).toEqual(['Might have saved', 'Second one']);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('deleting a to-do asks twice in its row: the icon turns red, and the first press is forgotten after a few seconds and when the focus moves on to another part of the row', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(105), title = unique('Doomed');
    await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER, PARTNER], title });
    // What the page sends is recorded as it goes: a snapshot fetched between the two presses could take longer than the press is remembered.
    const posts: Array<Record<string, unknown>> = [];
    page.on('request', request => { if (request.method() === 'POST' && request.url().includes('api.php')) { posts.push(request.postDataJSON()); } });
    const deletes = () => posts.filter(p => p.action === 'delete').length;
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', { name: `Edit ${title}`, exact: true }).click();
      const row = page.locator('.day-task.day-editing'), remove = row.locator('.ip-del');
      const stored = async () => (await owner.snapshot()).tasks.some((t: { title: string }) => t.title === title);
      await expect(remove).toHaveAccessibleName(`Delete task: ${title}`);
      await expect(remove).not.toHaveCSS('background-color', 'rgb(214, 69, 61)');
      await remove.click();
      // The same icon turns red and is Confirm delete; nothing was written. Left alone, it forgets the press after a few seconds.
      await expect(remove).toHaveAccessibleName('Confirm delete');
      expect(deletes(), 'the first press only asks').toBe(0);
      await expect(remove).toHaveCSS('background-color', 'rgb(214, 69, 61)');
      await expect(remove.locator('svg')).toBeVisible();
      await expect(row.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
      await expect(remove).toHaveAccessibleName(`Delete task: ${title}`, { timeout: 6000 });
      await expect(remove).not.toHaveCSS('background-color', 'rgb(214, 69, 61)');
      // From the keyboard: moving on to another part of the row forgets the press, so it asks again instead of deleting on one stray Enter.
      await remove.focus();
      await page.keyboard.press('Enter');
      await expect(remove).toHaveAccessibleName('Confirm delete');
      await page.keyboard.press('Shift+Tab');
      await expect(row.locator('.ip-date')).toBeFocused();
      await expect(remove).toHaveAccessibleName(`Delete task: ${title}`);
      await remove.focus();
      await page.keyboard.press('Enter');
      await expect(remove).toHaveAccessibleName('Confirm delete');
      expect(deletes(), 'the first press only asks').toBe(0);
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: `Edit ${title}`, exact: true })).toHaveCount(0);
      expect(deletes()).toBe(1);
      expect(await stored()).toBe(false);
      await noWindow(page);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a priority cell that is drawn again by Move down while its Delete is armed still forgets the press after a few seconds, and the next press only asks', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(122), text = unique('Prio');
    await add(owner, { action: 'add', kind: 'priority', date, owners: [OWNER], slots: { [OWNER]: 1 }, text });
    const posts: Array<Record<string, unknown>> = [];
    page.on('request', request => { if (request.method() === 'POST' && request.url().includes('api.php')) { posts.push(request.postDataJSON()); } });
    const deletes = () => posts.filter(p => p.action === 'delete').length;
    const RED = 'rgb(214, 69, 61)';
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', { name: `Priority 1: ${text}, ${OWNER_NAME}`, exact: true }).click();
      const cell = page.locator('.day-cell.day-editing'), remove = cell.locator('.ip-del');
      await expect(field(page, `Edit priority 1: ${text}`)).toBeFocused();
      await remove.click();
      await expect(remove).toHaveAccessibleName('Confirm delete');
      await expect(remove).toHaveCSS('background-color', RED);
      // Move down draws the cell again, so the icon on the page is a new one. The press is still waiting, and is forgotten on the icon that is there then.
      await cell.getByRole('button', { name: 'Move down', exact: true }).click();
      await expect(field(page, `Edit priority 2: ${text}`)).toBeFocused();
      await expect(remove).toHaveAccessibleName(`Delete priority: ${text}`, { timeout: 4000 });
      await expect(remove).not.toHaveCSS('background-color', RED);
      // The next single press only asks again.
      await remove.click();
      await expect(remove).toHaveAccessibleName('Confirm delete');
      expect(deletes(), 'one press only asks').toBe(0);
      expect((await owner.snapshot()).priorities.some((p: { text: string }) => p.text === text)).toBe(true);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a delete that does not go through leaves the icon red, and it forgets the press after a few seconds all the same', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(123), title = unique('Stays');
    await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title });
    const attempts: unknown[] = [];
    const RED = 'rgb(214, 69, 61)';
    try {
      await login(page); await openDay(page, date);
      await page.route(url => url.pathname.endsWith('/api.php'), route => {
        const request = route.request();
        if (request.method() === 'POST' && request.postDataJSON().action === 'delete') { attempts.push(request.postDataJSON()); return route.abort('failed'); }
        return route.continue();
      });
      await page.getByRole('button', { name: `Edit ${title}`, exact: true }).click();
      const row = page.locator('.day-task.day-editing'), remove = row.locator('.ip-del');
      await remove.click();
      await expect(remove).toHaveAccessibleName('Confirm delete');
      await remove.click();
      await expect.poll(() => attempts.length).toBe(1);
      await expect(row.locator('.ip-error')).toContainText('may have saved');
      // The write failed, so the icon is still red; the press is forgotten like any other, and the to-do is still there.
      await expect(remove).toHaveAccessibleName('Confirm delete');
      await expect(remove).toHaveCSS('background-color', RED);
      await expect(remove).toHaveAccessibleName(`Delete task: ${title}`, { timeout: 4000 });
      await expect(remove).not.toHaveCSS('background-color', RED);
      expect((await owner.snapshot()).tasks.some((t: { title: string }) => t.title === title)).toBe(true);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the To-do list is 13 ruled slots: open to-dos fill them top-down, the empty ones are blank lines with a faint circle, the first is the add field, a click on any blank line starts a to-do there', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(104);
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      const lines = page.locator('.day-tasks > li'), field = page.getByLabel('New task', { exact: true });
      // An empty day: 13 blank lines of one height, none of them a to-do, each with a decorative circle, the first holding the field.
      await expect(lines).toHaveCount(MAX);
      await expect(page.locator('.day-task')).toHaveCount(0);
      await expect(page.locator('.day-free')).toHaveCount(MAX);
      await expect(page.locator('.day-free .day-ghost[aria-hidden=true]')).toHaveCount(MAX);
      await expect(page.locator('.day-free[aria-hidden=true]')).toHaveCount(MAX - 1);
      await expect(page.getByRole('checkbox')).toHaveCount(0);
      await expect(lines.first().getByLabel('New task', { exact: true })).toBeVisible();
      await expect(todos(page)).toHaveText(`0 of ${MAX}`);
      const heights = await lines.evaluateAll(items => items.map(item => item.getBoundingClientRect()));
      expect(Math.max(...heights.map(r => r.height)) - Math.min(...heights.map(r => r.height))).toBeLessThanOrEqual(1);
      for (let i = 1; i < heights.length; i++) { expect(Math.abs(heights[i].top - heights[i - 1].bottom), `line ${i} follows line ${i - 1}`).toBeLessThanOrEqual(1); }
      // A click on the ninth line starts a to-do there, in place (todo-thirds.spec.ts); the add field, on the first line, is the keyboard's way.
      await lines.nth(8).click();
      await expect(page.getByRole('textbox', { name: `New to-do for ${OWNER_NAME}`, exact: true })).toBeFocused();
      await expect(lines.nth(8).getByRole('textbox')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.locator('.day-new')).toHaveCount(0);
      await expect(field).toBeFocused();
      await field.fill('First thing');
      await field.press('Enter');
      // Enter puts the to-do on the line the field was on, shows it at once and moves the field down one line, focused.
      await expect(page.getByRole('button', { name: 'Edit First thing', exact: true })).toBeVisible();
      await expect(page.locator('.day-task')).toHaveCount(1);
      await expect(page.locator('.day-free')).toHaveCount(MAX - 1);
      await expect(lines).toHaveCount(MAX);
      await expect(lines.nth(1).getByLabel('New task', { exact: true })).toBeFocused();
      const first = (await lines.first().boundingBox())!, titleBox = (await page.getByRole('button', { name: 'Edit First thing', exact: true }).boundingBox())!;
      expect(Math.abs(first.y + first.height / 2 - (titleBox.y + titleBox.height / 2))).toBeLessThanOrEqual(2);
      await field.fill('Second thing');
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Edit Second thing', exact: true })).toBeVisible();
      await expect(todos(page)).toHaveText(`2 of ${MAX}`);
      await expect(lines.nth(2).getByLabel('New task', { exact: true })).toBeFocused();
      // A finished to-do stays in the same list, crossed out, at the bottom: the last of the 13 lines, under the blank lines (so it still uses its line).
      await page.getByRole('checkbox', { name: 'Complete First thing', exact: true }).click();
      await expect(page.locator('.day-task.day-done')).toHaveCount(1);
      await expect(page.locator('.day-free')).toHaveCount(MAX - 2);
      await expect(lines).toHaveCount(MAX);
      await expect(lines.nth(0)).toContainText('Second thing');
      await expect(lines.nth(MAX - 1)).toContainText('First thing');
      await expect(lines.nth(MAX - 1)).toHaveClass(/day-done/);
      await expect(lines.nth(1).getByLabel('New task', { exact: true })).toBeVisible();
      await expect(page.getByRole('list', { name: 'Done', exact: true })).toHaveCount(0);
      // Nothing about the blank lines is a control a keyboard or a screen reader meets besides the field.
      await expect(page.locator('.day-free[aria-hidden=true] :is(button,input,a)')).toHaveCount(0);
      await noWindow(page);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a list with 13 open to-dos has no empty slot left, so no add field, and says so; a server refusal reads the same and keeps the draft', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), full = farDate(102), race = farDate(103);
    for (let n = 1; n <= MAX; n++) { await add(owner, { action: 'add', kind: 'todo', scope: 'day', date: full, owners: [OWNER], title: `Full ${n}` }); }
    for (let n = 1; n < MAX; n++) { await add(owner, { action: 'add', kind: 'todo', scope: 'day', date: race, owners: [OWNER], title: `Race ${n}` }); }
    try {
      await login(page); await openDay(page, full);
      await pickList(page, OWNER_NAME);
      await expect(todos(page)).toHaveText(`${MAX} of ${MAX}`);
      await expect(todos(page)).toHaveAttribute('data-over', 'true');
      // All 13 slots are open to-dos: nothing to type into, and the list says why.
      await expect(page.locator('.day-task')).toHaveCount(MAX);
      await expect(page.locator('.day-free')).toHaveCount(0);
      await expect(page.getByLabel('New task', { exact: true })).toHaveCount(0);
      await expect(page.locator('.day-msg')).toHaveText(`${OWNER_NAME} already has ${MAX} things to do that day.`);
      // The partner's list is empty that day, so under the partner there are 13 free slots and the first is the add field.
      await pickList(page, PARTNER_NAME);
      await expect(page.locator('.day-free')).toHaveCount(MAX);
      await expect(page.getByLabel('New task', { exact: true })).toBeVisible();
      await expect(page.locator('.day-msg')).toBeHidden();
      await page.getByLabel('New task', { exact: true }).fill(`Typed for ${PARTNER_NAME}`);
      // A done row frees a place for an open one (the cap counts open to-dos); its own line stays used, so the add field is the line after the 13 rows. The typed text waits in the field that comes back.
      await pickList(page, OWNER_NAME);
      await page.getByRole('checkbox', { name: 'Complete Full 1', exact: true }).click();
      await expect(page.getByRole('checkbox', { name: 'Reopen Full 1', exact: true })).toBeChecked();
      await expect(todos(page)).toHaveText(`${MAX - 1} of ${MAX}`);
      await expect(page.locator('.day-msg')).toBeHidden();
      await expect(page.locator('.day-free')).toHaveCount(1);
      await expect(page.getByLabel('New task', { exact: true })).toHaveValue(`Typed for ${PARTNER_NAME}`);
      await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();

      // The page shows 12 of 13 while another device adds the last one: the server refuses with its own words.
      await page.getByLabel('New task', { exact: true }).fill('');
      await page.locator('#jump-date').fill(race);
      await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', race);
      await expect(todos(page)).toHaveText(`${MAX - 1} of ${MAX}`);
      await add(owner, { action: 'add', kind: 'todo', scope: 'day', date: race, owners: [OWNER], title: `Race ${MAX}` });
      await page.getByLabel('New task', { exact: true }).fill('One more');
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(page.locator('.day-msg')).toHaveText(`${OWNER_NAME} already has ${MAX} things to do that day.`);
      await expect(page.getByLabel('New task', { exact: true })).toHaveValue('One more');
    } finally { await clearDay(owner, full); await clearDay(owner, race); await owner.dispose(); }
  });

  test('priorities: add in a lane (no For control), a Both entry on one line, move up and down moves only that list\'s line, an edit keeps the owners', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(104);
    // A priority for both of us is one record on the same line in both lists; with no For control it is made by the API here.
    await add(owner, { action: 'add', kind: 'priority', date, owners: [OWNER, PARTNER], slots: { [PARTNER]: 2, [OWNER]: 2 }, text: 'Family dinner' });
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', { name: `Add priority 1 for ${PARTNER_NAME}`, exact: true }).click();
      // The empty cell itself takes the text: a field in the same cell, no window, nothing to choose.
      const fresh = field(page, `New priority 1 for ${PARTNER_NAME}`);
      await expect(fresh).toBeFocused();
      await noWindow(page);
      await expect(page.getByRole('radiogroup')).toHaveCount(0);
      await expect(page.getByText('For', { exact: true })).toHaveCount(0);
      await fresh.fill('Call school');
      await fresh.press('Enter');
      await expect(fresh).toHaveCount(0);
      const school = page.getByRole('button', { name: `Priority 1: Call school, ${PARTNER_NAME}`, exact: true });
      await expect(school).toBeFocused();
      await expect(school).toHaveAttribute('data-c', 'yellow');
      expect((await owner.snapshot()).priorities.find((p: { text: string }) => p.text === 'Call school')).toMatchObject({ owners: [PARTNER], slots: { [PARTNER]: 1 }, date });
      // The partner's cell is in the right-hand lane for the owner.
      const lanes = (await page.locator('.day-prio .day-pcells').first().boundingBox())!, cell = (await school.boundingBox())!;
      expect(cell.x).toBeGreaterThan(lanes.x + lanes.width / 2 - 2);

      // Both on line 2: the same line in both lists, so it is one entry across both lanes.
      const dinner = page.getByRole('button', { name: 'Priority 2: Family dinner, Both', exact: true });
      await expect(dinner).toHaveCount(1);
      expect((await dinner.boundingBox())!.width).toBeGreaterThan(lanes.width - 6);
      expect((await owner.snapshot()).priorities.find((p: { text: string }) => p.text === 'Family dinner')).toMatchObject({ owners: [OWNER, PARTNER], slots: { [PARTNER]: 2, [OWNER]: 2 } });
      // Editing it changes the words for both lists and keeps both owners; the field is as wide as the cell it replaces.
      await dinner.click();
      const dinnerField = field(page, 'Edit priority 2: Family dinner');
      const [was, now] = [(await dinner.boundingBox())!, (await page.locator('.day-cell.day-editing').boundingBox())!];
      expect(Math.abs(now.width - was.width)).toBeLessThanOrEqual(2);
      expect(Math.abs(now.y - was.y)).toBeLessThanOrEqual(2);
      await dinnerField.fill('Family dinner out');
      await dinnerField.press('Enter');
      await expect(dinnerField).toHaveCount(0);
      expect((await owner.snapshot()).priorities.find((p: { text: string }) => p.text === 'Family dinner out')).toMatchObject({ owners: [OWNER, PARTNER], slots: { [PARTNER]: 2, [OWNER]: 2 } });

      // Moving the partner's first line down swaps it with the Both entry in the partner's list only: the owner keeps line 2. The cell stays in edit mode where it lands.
      await school.click();
      await expect(page.getByRole('button', { name: 'Move up', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: 'Move down', exact: true }).click();
      await expect(field(page, 'Edit priority 2: Call school')).toBeFocused();
      await expect(page.getByRole('button', { name: 'Move up', exact: true })).toBeEnabled();
      await page.keyboard.press('Escape');
      await expect(page.locator('.day-cell.day-editing')).toHaveCount(0);
      const stored = (await owner.snapshot()).priorities;
      expect(stored.find((p: { text: string }) => p.text === 'Call school').slots).toEqual({ [PARTNER]: 2 });
      expect(stored.find((p: { text: string }) => p.text === 'Family dinner out').slots).toEqual({ [PARTNER]: 1, [OWNER]: 2 });
      // Lines differ now, so the Both entry is two half cells, both purple.
      await expect(page.locator('.day-cell[data-c=purple]')).toHaveCount(2);

      // Alt+Up in the field moves it back, and Clear is two presses in the cell.
      await page.getByRole('button', { name: `Priority 2: Call school, ${PARTNER_NAME}`, exact: true }).click();
      await expect(field(page, 'Edit priority 2: Call school')).toBeFocused();
      await page.keyboard.press('Alt+ArrowUp');
      await expect(field(page, 'Edit priority 1: Call school')).toBeFocused();
      await page.getByRole('button', { name: 'Delete priority: Call school', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
      await expect(page.getByRole('button', { name: /Call school/ })).toHaveCount(0);
      expect((await owner.snapshot()).priorities.some((p: { text: string }) => p.text === 'Call school')).toBe(false);
      await noWindow(page);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a priority over 18 characters is blocked with a live counter and a message in the cell; a full list has no blank line to add to', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(105);
    for (let line = 1; line <= 5; line++) { await add(owner, { action: 'add', kind: 'priority', date, owners: [OWNER], slots: { [OWNER]: line }, text: `Line ${line}` }); }
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', { name: `Add priority 1 for ${PARTNER_NAME}`, exact: true }).click();
      const input = field(page, `New priority 1 for ${PARTNER_NAME}`), cell = page.locator('.day-cell.day-editing');
      await input.fill('x'.repeat(19));
      await expect(cell.locator('.ip-count')).toHaveText('19 / 18');
      await expect(cell.locator('.ip-count')).toHaveAttribute('data-over', 'true');
      await expect(cell.locator('.ip-error')).toHaveText('Keep it to 18 characters.');
      // Enter does not write it, and the text stays.
      await input.press('Enter');
      await expect(input).toHaveValue('x'.repeat(19));
      expect((await owner.snapshot()).priorities.filter((p: { date: string }) => p.date === date)).toHaveLength(5);
      await input.fill('x'.repeat(18));
      await expect(cell.locator('.ip-error')).toHaveText('');
      await page.keyboard.press('Escape');
      await expect(cell).toHaveCount(0);
      // Nothing was written, and the owner has all five lines: no blank line is left to add to in his lane, and the partner's lane still has all five.
      expect((await owner.snapshot()).priorities.filter((p: { date: string }) => p.date === date)).toHaveLength(5);
      await expect(page.getByRole('button', { name: new RegExp(String.raw`^Add priority \d for ${OWNER_NAME}$`) })).toHaveCount(0);
      await expect(page.getByRole('button', { name: new RegExp(String.raw`^Add priority \d for ${PARTNER_NAME}$`) })).toHaveCount(5);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('notes: a text per list, a counter, Save, a draft that survives leaving the day, and a stale save that offers Keep mine or the saved text', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER), date = farDate(106);
    const key = `day:${date}:${OWNER}:notes`;
    const saved = async () => (await owner.snapshot()).notes.find((n: { key: string }) => n.key === key);
    try {
      await login(page); await openDay(page, date);
      const mine = page.getByLabel(`Notes for ${OWNER_NAME}`, { exact: true }), hers = page.getByLabel(`Notes for ${PARTNER_NAME}`, { exact: true });
      const block = page.locator('.day-note', { has: mine }), save = block.getByRole('button', { name: 'Save', exact: true });
      await expect(save).toBeDisabled();
      await mine.fill('Ask about the invoice');
      await expect(block.locator('.day-note-status')).toHaveText('Unsaved');
      await expect(block.locator('.day-count')).toHaveText('21 / 400');
      // The draft is in memory only: it is still there after the day changes and changes back.
      await leaveField(page);
      await page.getByRole('button', { name: 'Next day', exact: true }).click();
      await expect(page.locator('#sidebar .date-row.selected')).not.toHaveAttribute('data-date', date);
      await page.getByRole('button', { name: 'Previous day', exact: true }).click();
      await expect(mine).toHaveValue('Ask about the invoice');
      await expect(block.locator('.day-note-status')).toHaveText('Unsaved');
      await save.click();
      await expect(block.locator('.day-note-status')).toHaveText('Saved');
      expect(await saved()).toMatchObject({ text: 'Ask about the invoice', revision: 1, listId: OWNER });
      await expect(hers).toHaveValue('');
      // Over 400 code points blocks Save.
      await mine.fill('y'.repeat(401));
      await expect(block.locator('.day-count')).toHaveText('401 / 400');
      await expect(save).toBeDisabled();
      await mine.fill('Ask about the invoice, twice');
      await expect(save).toBeEnabled();
      // The partner changes the owner's note first: this save is stale, keeps the draft, and can reload the saved text.
      const current = await saved();
      expect((await partner.post({ action: 'saveNote', scope: 'day', period: date, listId: OWNER, field: 'notes', text: `${PARTNER_NAME} was here`, revision: current.revision })).status()).toBe(200);
      await save.click();
      await expect(block.locator('.day-note-status')).toHaveText('Changed elsewhere');
      await expect(mine).toHaveValue('Ask about the invoice, twice');
      // Keep mine takes the draft over her newer text: it is an ordinary unsaved draft again, and Save now writes it.
      await block.getByRole('button', { name: 'Keep mine', exact: true }).click();
      await expect(block.locator('.day-note-status')).toHaveText('Unsaved');
      await expect(block.getByRole('button', { name: 'Keep mine', exact: true })).toBeHidden();
      await save.click();
      await expect(block.locator('.day-note-status')).toHaveText('Saved');
      expect(await saved()).toMatchObject({ text: 'Ask about the invoice, twice', revision: current.revision + 2 });
      // Another change by the partner and another draft of mine: this time the saved text is taken.
      await mine.fill('Mine again');
      expect((await partner.post({ action: 'saveNote', scope: 'day', period: date, listId: OWNER, field: 'notes', text: `${PARTNER_NAME} was here`, revision: current.revision + 2 })).status()).toBe(200);
      await save.click();
      await expect(block.locator('.day-note-status')).toHaveText('Changed elsewhere');
      await expect(mine).toHaveValue('Mine again');
      await block.getByRole('button', { name: 'Reload saved', exact: true }).click();
      await expect(mine).toHaveValue(`${PARTNER_NAME} was here`);
      await expect(block.locator('.day-note-status')).toHaveText('Saved');
      expect(await browserStorage(page)).toEqual({ local: 0, session: 0, indexedDB: 0, caches: 0 });
    } finally { await clearDay(owner, date); await owner.dispose(); await partner.dispose(); }
  });

  test('leaving the page warns only while a note has unsaved text of a list that still exists', async ({ page, baseURL }) => {
    await page.clock.install();
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER), date = farDate(107);
    const listId = crypto.randomUUID(), name = unique('Camp').slice(0, 24);
    expect((await owner.post({ action: 'saveList', id: listId, name, color: 'blue', revision: 0 })).status()).toBe(200);
    // What the browser asks the page when it is about to leave: does it ask to stay?
    const warns = () => page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
    try {
      await login(page); await openDay(page, date);
      expect(await warns()).toBe(false);
      const mine = page.getByLabel(`Notes for ${OWNER_NAME}`, { exact: true }), block = page.locator('.day-note', { has: mine });
      await mine.fill('Not saved yet');
      expect(await warns()).toBe(true);
      await block.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(block.locator('.day-note-status')).toHaveText('Saved');
      expect(await warns()).toBe(false);
      // The other person saves the very words that are waiting here: the draft is still held, but nothing is left to lose.
      await mine.fill('Same words');
      expect(await warns()).toBe(true);
      await leaveField(page);
      const note = (await owner.snapshot()).notes.find((n: { key: string }) => n.key === `day:${date}:${OWNER}:notes`);
      expect((await partner.post({ action: 'saveNote', scope: 'day', period: date, listId: OWNER, field: 'notes', text: 'Same words', revision: note.revision })).status()).toBe(200);
      const same = page.waitForResponse(response => response.url().includes('api.php?since='));
      await page.clock.runFor(13000);
      await same;
      await expect(block.locator('.day-note-status')).toHaveText('Saved');
      expect(await warns()).toBe(false);
      // Text typed in a list's notes, and then the list is deleted by the other person: that text can no longer be saved or
      // seen, so it must not keep the warning on for good.
      await page.getByRole('button', { name: /^Lists: / }).click();
      await page.getByRole('group', { name: 'Lists', exact: true }).getByRole('button', { name, exact: true }).click();
      const camp = page.getByLabel(`Notes for ${name}`, { exact: true });
      await camp.fill('Lost with the list');
      expect(await warns()).toBe(true);
      await leaveField(page);
      const stored = (await partner.snapshot()).lists.find((l: { id: string }) => l.id === listId);
      expect((await partner.post({ action: 'deleteList', id: listId, revision: stored.revision, confirm: true })).status()).toBe(200);
      const answered = page.waitForResponse(response => response.url().includes('api.php?since='));
      await page.clock.runFor(13000);
      await answered;
      await expect(page.getByLabel(`Notes for ${name}`, { exact: true })).toHaveCount(0);
      expect(await warns()).toBe(false);
    } finally {
      await owner.post({ action: 'savePrefs', selection: { base: 'both', overlays: [] } });
      await clearDay(owner, date); await owner.dispose(); await partner.dispose();
    }
  });

  test('crossing the phone breakpoint rebuilds the panel as tabs, and back as two columns, without losing what was typed', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(109);
    await add(owner, { action: 'add', kind: 'event', date, owners: [OWNER], text: 'Dentist', start: 540, length: 60 });
    try {
      await login(page); await openDay(page, date);
      await page.getByLabel('New task', { exact: true }).fill('Typed on a desktop');
      await leaveField(page);
      await expect(page.locator('.day-panel')).toHaveAttribute('data-layout', 'wide');
      await page.setViewportSize({ width: 375, height: 700 });
      await expect(page.locator('.day-panel')).toHaveAttribute('data-layout', 'phone');
      await expect(page.getByRole('tab')).toHaveText(['Schedule', 'To-do', 'Notes', 'Chores']);
      await expect(page.getByRole('button', { name: `Dentist, 9a to 10a, ${OWNER_NAME}`, exact: true })).toBeVisible();
      await page.getByRole('tab', { name: 'To-do', exact: true }).click();
      await expect(page.getByLabel('New task', { exact: true })).toHaveValue('Typed on a desktop');
      await page.setViewportSize({ width: 1360, height: 900 });
      await expect(page.locator('.day-panel')).toHaveAttribute('data-layout', 'wide');
      await expect(page.getByRole('tab')).toHaveCount(0);
      await expect(page.getByLabel('New task', { exact: true })).toHaveValue('Typed on a desktop');
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('an unfinished to-do stays in the add box when the view or the day changes, and goes when it is added', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(109), other = farDate(110);
    try {
      await login(page); await openDay(page, date);
      const box = page.getByLabel('New task', { exact: true });
      await box.fill('Half typed');
      await leaveField(page);
      await page.locator('.view-switch button[data-view=week]').click();
      await expect(page.locator('#mode-heading')).toHaveText('Weekly planner');
      await page.locator('.view-switch button[data-view=day]').click();
      await expect(page.locator('#mode-heading')).toHaveText('Daily planner');
      await expect(box).toHaveValue('Half typed');
      await openDay(page, other);
      await expect(box).toHaveValue('Half typed');
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Edit Half typed', exact: true })).toBeVisible();
      await expect(box).toHaveValue('');
    } finally { await clearDay(owner, date); await clearDay(owner, other); await owner.dispose(); }
  });

  test('nothing from the day is written into the page as markup: titles, event and note text stay text', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(108);
    const hostile = '<b>x</b>';
    await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title: hostile });
    await add(owner, { action: 'add', kind: 'event', date, owners: [OWNER], text: hostile, start: 600 });
    await add(owner, { action: 'add', kind: 'priority', date, owners: [OWNER], slots: { [OWNER]: 1 }, text: hostile });
    try {
      await login(page); await openDay(page, date);
      await expect(page.locator('.day-panel b')).toHaveCount(0);
      await expect(page.getByRole('button', { name: `Edit ${hostile}`, exact: true })).toBeVisible();
      await expect(page.locator('.day-ev-text')).toHaveText(hostile);
      await expect(page.locator('.day-cell:not(.day-blank) span')).toHaveText(hostile);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('Both: a priority in half a lane is edited on the whole line, so its field is as long as the line and its controls stay inside the cell', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(120);
    await add(owner, { action: 'add', kind: 'priority', date, owners: [OWNER], slots: { [OWNER]: 1 }, text: 'Finish the budget' });
    await add(owner, { action: 'add', kind: 'priority', date, owners: [PARTNER], slots: { [PARTNER]: 1 }, text: `${PARTNER_NAME} 1` });
    try {
      await login(page);
      for (const [width, height] of [[1360, 900], [1000, 735]] as const) {
        await page.setViewportSize({ width, height });
        await openDay(page, date);
        await page.getByRole('button', { name: `Priority 1: Finish the budget, ${OWNER_NAME}`, exact: true }).click();
        const input = field(page, 'Edit priority 1: Finish the budget');
        await expect(input).toBeFocused();
        const sizes = await page.evaluate(() => {
          const cell = document.querySelector('.day-cell.day-editing')!, row = document.querySelector('.day-pcells')!.getBoundingClientRect(), box = cell.getBoundingClientRect();
          const inside = ['.ip-input', '.ip-count', '.ip-moves', '.ip-del-pair'].map(selector => { const r = cell.querySelector(selector)!.getBoundingClientRect(); return r.left >= box.left - 0.5 && r.right <= box.right + 0.5; });
          const field = cell.querySelector<HTMLInputElement>('.ip-input')!;
          return { wholeLine: Math.abs(box.width - row.width) <= 2, inputWidth: field.clientWidth, clipped: field.scrollWidth > field.clientWidth, inside };
        });
        expect(sizes, `${width}x${height}`).toMatchObject({ wholeLine: true, clipped: false, inside: [true, true, true, true] });
        expect(sizes.inputWidth).toBeGreaterThanOrEqual(100);
        await input.press('Escape');
        await expect(page.locator('.day-cell.day-editing')).toHaveCount(0);
      }
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('typing in the add field right after Enter keeps what is typed after the title that was sent, not the sent title with it', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(121);
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      // The write takes a moment: the next words are typed while it runs.
      await page.route('**/api.php', async route => {
        if (route.request().method() === 'POST' && (route.request().postData() ?? '').includes('"kind":"todo"')) { await new Promise(resolve => setTimeout(resolve, 500)); }
        await route.continue();
      });
      const box = page.getByLabel('New task', { exact: true });
      // The keyboard's way in: a click on the empty field is a click on a blank line (todo-thirds.spec.ts), which opens a new to-do in place.
      await box.focus();
      await box.fill('Buy milk');
      await box.press('Enter');
      await page.keyboard.type('Eggs');
      await expect(page.getByRole('button', { name: 'Edit Buy milk', exact: true })).toBeVisible();
      await expect(page.getByLabel('New task', { exact: true })).toHaveValue('Eggs');
      expect((await owner.snapshot()).tasks.filter((t: { date: string }) => t.date === date).map((t: { title: string }) => t.title)).toEqual(['Buy milk']);
    } finally { await page.unroute('**/api.php'); await clearDay(owner, date); await owner.dispose(); }
  });
});

