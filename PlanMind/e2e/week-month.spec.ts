import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { periodStart } from '../packages/core/src/planner';
import { apiLogin, browserStorage, farDate, field, leaveField, login, noWindow, pickList, removeTodos, resetPrefs, todo, unique, type Api, type User } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// Week and Month panels. The disposable server and its data are shared by every spec of a run, so each test works in
// far-away periods of its own, makes its own lists, and takes them (and the picker selection it set) away again.
const POLL = 13000;
const edit = (title: string) => ({ name: `Edit ${title}`, exact: true });
const week = (n: number) => periodStart(farDate(n), 'week');
const month = (n: number) => periodStart(farDate(n), 'month');
const BOTH = { base: 'both', overlays: [] };

const cleanup: Array<() => Promise<unknown>> = [];
test.afterEach(async ({ baseURL }) => { for (const fn of cleanup.splice(0).reverse()) { await fn().catch(() => {}); } await resetPrefs(baseURL!); });

async function ok(response: { status(): number; text(): Promise<string> }) {
  const status = response.status();
  expect([status, status === 200 ? '' : await response.text()]).toEqual([200, '']);
}
/** A custom list, removed (with what is in it) when the test ends. */
async function makeList(api: Api, name = unique('Camp'), color = 'blue') {
  const id = crypto.randomUUID();
  await ok(await api.post({ action: 'saveList', id, name, color, revision: 0 }));
  cleanup.push(async () => {
    const list = (await api.snapshot()).lists.find((l: { id: string }) => l.id === id);
    if (list) { await api.post({ action: 'deleteList', id, revision: list.revision, confirm: true }); }
  });
  return { id, name };
}
/** Saves a person's picker selection (read at load), and puts the default back when the test ends. */
async function select(api: Api, selection: { base: string; overlays: string[] }) {
  await ok(await api.post({ action: 'savePrefs', selection }));
  cleanup.push(() => api.post({ action: 'savePrefs', selection: BOTH }));
}
async function makeApi(baseURL: string, user: User) {
  const api = await apiLogin(baseURL, user);
  cleanup.push(() => api.dispose());
  return api;
}
/** A second browser window signed in as `user`. */
async function windowFor(browser: Browser, baseURL: string, user: User, viewport?: { width: number; height: number }) {
  const context = await browser.newContext({ baseURL, ...(viewport ? { viewport } : {}) });
  cleanup.push(() => context.close());
  const page = await context.newPage();
  await login(page, user);
  return page;
}
/** Opens the Week or Month view on the period holding `date`. */
async function open(page: Page, view: 'Week' | 'Month', date: string, phone = false) {
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
  await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', periodStart(date, view === 'Week' ? 'week' : 'month'));
}
const lane = (page: Page, label: string) => page.locator('.wm-lane', { has: page.getByLabel(label, { exact: true }) });
const saveOf = (block: Locator) => block.getByRole('button', { name: 'Save', exact: true });
const names = (page: Page) => page.locator('.wm-lane h3');
const right = async (el: Locator) => (await el.boundingBox())!;
/** Whether the Notes card of a lane lies whole inside the strip of cards (one the keyboard reached is scrolled into view). */
const wholeInStrip = (page: Page, name: string) => page.evaluate(label => {
  const around = document.querySelector('.wm-notes .wm-lanes')!.getBoundingClientRect(), card = document.querySelector(`.wm-notes textarea[aria-label="${label} notes"]`)!.closest('.wm-lane')!.getBoundingClientRect();
  return card.left >= around.left - 0.5 && card.right <= around.right + 0.5;
}, name);
/** What is wrong inside a compact Notes card: a part (the name, the "you" tag, the count, the cue, a visible button) out of the card on any side, on another part or on the words, or with its own text cut off. */
const cardProblems = (card: Locator, nameWhole = true) => card.evaluate((el, whole) => {
  const rect = (node: Element) => node.getBoundingClientRect();
  const parts = [...el.querySelectorAll<HTMLElement>('.wm-lane-head h3, .wm-you, .wm-count, .wm-cue, button:not([hidden])')].filter(part => part.getClientRects().length && rect(part).width > 2);
  const around = rect(el), words = rect(el.querySelector('textarea')!), found: string[] = [];
  const meets = (a: DOMRect, b: DOMRect) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  parts.forEach((part, i) => {
    const r = rect(part), name = part.textContent!.trim();
    if (r.left < around.left - 0.5 || r.right > around.right + 0.5 || r.top < around.top - 0.5 || r.bottom > around.bottom + 0.5) { found.push(`"${name}" leaves the card`); }
    if (meets(r, words)) { found.push(`"${name}" is on the words`); }
    if ((part.tagName !== 'H3' || whole) && part.scrollWidth > part.clientWidth + 1) { found.push(`"${name}" is cut off`); }
    for (const other of parts.slice(i + 1)) { if (meets(r, rect(other))) { found.push(`"${name}" meets "${other.textContent!.trim()}"`); } }
  });
  return found;
}, nameWhole);
/** The lines of words a Notes box shows (its 4px of padding left out). */
const linesOf = (box: Locator) => box.evaluate(el => (el.clientHeight - 4) / 19.5);
/** The ruled lines of the open to-do list (the rows, then the add line, then the blank lines) and the blank ones alone. */
const todoLines = (page: Page) => page.locator('ul.wm-todos[aria-label="To-do"] > li');
const blankLines = (page: Page) => page.locator('ul.wm-todos[aria-label="To-do"] > li.wm-free:not(.wm-free-add)');
/** The lines are one ruled page: all the same height, each right under the one before with nothing between. */
async function expectRuled(lines: Locator) {
  const boxes = await lines.evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { y: r.y, height: r.height }; }));
  const heights = boxes.map(b => b.height), gaps = boxes.slice(1).map((b, i) => b.y - (boxes[i].y + boxes[i].height));
  expect(Math.max(...heights) - Math.min(...heights), 'every line is as tall as the next').toBeLessThanOrEqual(1);
  expect(Math.max(...gaps.map(Math.abs)), 'no gap between lines').toBeLessThanOrEqual(1);
}
/** Takes away the to-dos a test added to a week or a month through the page (it holds no ids for them). */
function forgetTodos(api: Api, scope: 'week' | 'month', date: string) {
  cleanup.push(async () => removeTodos(api, (await api.snapshot()).tasks.filter((t: { scope: string; date: string }) => t.scope === scope && t.date === date).map((t: { id: string }) => t.id)));
}

test.describe('Week', () => {
  test('a text block for each lane, the signed-in person first, saved into its own list and read by the other person', async ({ page, browser, baseURL }) => {
    const when = week(40);
    await login(page, OWNER);
    await open(page, 'Week', when);
    await expect(names(page)).toHaveText([OWNER_NAME, PARTNER_NAME]);
    await expect(lane(page, `${OWNER_NAME} priorities`).locator('.wm-you')).toBeVisible();
    await expect(lane(page, `${PARTNER_NAME} priorities`).locator('.wm-you')).toHaveCount(0);

    const mine = page.getByLabel(`${OWNER_NAME} priorities`, { exact: true }), save = saveOf(lane(page, `${OWNER_NAME} priorities`));
    await expect(save).toBeDisabled();
    // A note that starts with a line break and holds markup characters comes back exactly as typed.
    const text = `\n<b>Close out</b> Q4 & plan\n\nDinner with ${PARTNER_NAME}`;
    await mine.fill(text);
    await expect(lane(page, `${OWNER_NAME} priorities`)).toContainText('Unsaved');
    await expect(save).toBeEnabled();
    await expect(saveOf(lane(page, `${PARTNER_NAME} priorities`))).toBeDisabled();
    await save.click();
    await expect(lane(page, `${OWNER_NAME} priorities`)).toContainText('Saved');
    await expect(save).toBeDisabled();
    expect(await browserStorage(page)).toEqual({ local: 0, session: 0, indexedDB: 0, caches: 0 });

    const partner = await makeApi(baseURL!, PARTNER);
    const stored = (await partner.snapshot()).notes.filter((n: { period: string }) => n.period === when);
    expect(stored).toMatchObject([{ key: `week:${when}:${OWNER}:priorities`, listId: OWNER, field: 'priorities', text, updatedBy: OWNER }]);

    // The partner sees her own block first and the owner's text in the second.
    const partnerPage = await windowFor(browser, baseURL!, PARTNER);
    await open(partnerPage, 'Week', when);
    await expect(names(partnerPage)).toHaveText([PARTNER_NAME, OWNER_NAME]);
    await expect(partnerPage.getByLabel(`${OWNER_NAME} priorities`, { exact: true })).toHaveValue(text);
    await expect(partnerPage.getByLabel(`${PARTNER_NAME} priorities`, { exact: true })).toHaveValue('');
  });

  test('the blocks follow the picker selection: one list alone, an extra list added, Both with an extra list', async ({ page, baseURL }) => {
    const when = week(50);
    const owner = await makeApi(baseURL!, OWNER);
    const camp = await makeList(owner);
    await login(page, OWNER);
    for (const [selection, expected] of [
      [{ base: camp.id, overlays: [] }, [camp.name]],
      [{ base: OWNER, overlays: [camp.id] }, [OWNER_NAME, camp.name]],
      [{ base: 'both', overlays: [camp.id] }, [OWNER_NAME, PARTNER_NAME, camp.name]],
      [{ base: PARTNER, overlays: [] }, [PARTNER_NAME]],
    ] as const) {
      await select(owner, { base: selection.base, overlays: [...selection.overlays] });
      await page.reload();
      await open(page, 'Week', when);
      await expect(names(page)).toHaveText([...expected]);
    }
    await expect(page.getByLabel(`${PARTNER_NAME} priorities`, { exact: true })).toBeVisible();
  });

  test('a draft stays with its list when the lanes change around it (the base list is deleted by the other person)', async ({ page, baseURL }) => {
    await page.clock.install();
    const when = week(60);
    const owner = await makeApi(baseURL!, OWNER), partner = await makeApi(baseURL!, PARTNER);
    const first = await makeList(owner), second = await makeList(owner, unique('Home'), 'orange');
    await select(owner, { base: first.id, overlays: [second.id] });
    await login(page, OWNER);
    await open(page, 'Week', when);
    await expect(names(page)).toHaveText([first.name, second.name]);
    await page.getByLabel(`${first.name} priorities`, { exact: true }).fill('first draft');
    await page.getByLabel(`${second.name} priorities`, { exact: true }).fill('second draft');
    await leaveField(page);
    await expect(lane(page, `${second.name} priorities`)).toContainText('Unsaved');

    // The base list goes away: the view heals to Both with the other extra list still on, so that list's lane moves
    // from the second place to the third and its draft goes with it.
    const gone = (await partner.snapshot()).lists.find((l: { id: string }) => l.id === first.id);
    await ok(await partner.post({ action: 'deleteList', id: first.id, revision: gone.revision, confirm: true }));
    await page.clock.runFor(POLL);
    await expect(names(page)).toHaveText([OWNER_NAME, PARTNER_NAME, second.name]);
    await expect(page.getByLabel(`${second.name} priorities`, { exact: true })).toHaveValue('second draft');
    await expect(lane(page, `${second.name} priorities`)).toContainText('Unsaved');
    await expect(saveOf(lane(page, `${second.name} priorities`))).toBeEnabled();
    await expect(page.getByLabel(`${OWNER_NAME} priorities`, { exact: true })).toHaveValue('');
    await expect(page.getByLabel(`${PARTNER_NAME} priorities`, { exact: true })).toHaveValue('');
  });

  test('a save made elsewhere meanwhile is refused, the draft stays, and the person chooses: keep mine or reload saved', async ({ page, baseURL }) => {
    const when = week(70);
    const partner = await makeApi(baseURL!, PARTNER);
    await login(page, OWNER);
    await open(page, 'Week', when);
    const block = lane(page, `${OWNER_NAME} priorities`), box = page.getByLabel(`${OWNER_NAME} priorities`, { exact: true });
    await box.fill('mine');
    await leaveField(page);
    await ok(await partner.post({ action: 'saveNote', scope: 'week', period: when, listId: OWNER, field: 'priorities', text: 'theirs', revision: 0 }));

    await saveOf(block).click();
    await expect(page.getByRole('alert')).toContainText('changed on another device');
    await expect(block).toContainText(`${PARTNER_NAME} saved a newer version since you began.`);
    await expect(box).toHaveValue('mine');
    await expect(block.getByRole('button', { name: 'Keep mine', exact: true })).toBeVisible();

    // Keep mine: the draft now builds on what the partner saved, so Save goes through.
    await block.getByRole('button', { name: 'Keep mine', exact: true }).click();
    await expect(block).not.toContainText('saved a newer version');
    await saveOf(block).click();
    await expect(block).toContainText('Saved');
    expect((await partner.snapshot()).notes.find((n: { key: string }) => n.key === `week:${when}:${OWNER}:priorities`)).toMatchObject({ text: 'mine', revision: 2 });

    // Reload saved asks twice before it throws a draft away.
    await box.fill('something else');
    await leaveField(page);
    await block.getByRole('button', { name: 'Reload saved', exact: true }).click();
    await expect(box).toHaveValue('something else');
    await block.getByRole('button', { name: 'Discard draft?', exact: true }).click();
    await expect(box).toHaveValue('mine');
    await expect(block).not.toContainText('Unsaved');
  });

  test('to-dos: add under Both and under one list (no For control), complete, edit keeps the owners, delete; titles stay text; they belong to the week alone', async ({ page, baseURL }) => {
    const when = week(80);
    const owner = await makeApi(baseURL!, OWNER);
    await login(page, OWNER);
    await open(page, 'Week', when);
    // An empty week has no row, only the add line on blank ruled lines.
    await expect(page.locator('.wm-todo')).toHaveCount(0);
    // There is no For control: who a new to-do is for comes from the top picker, and under Both it is both of us.
    await expect(page.getByRole('radiogroup')).toHaveCount(0);
    await expect(page.locator('.wm-add').getByText('For', { exact: true })).toHaveCount(0);
    const title = `<i>${unique('Both')}</i>`;
    await page.getByLabel('New to-do', { exact: true }).fill(title);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    const row = page.locator('.wm-todo', { has: page.getByRole('button', edit(title)) });
    await expect(row).toHaveAttribute('data-c', 'purple');
    await expect(row.locator('.wm-owner')).toHaveText('Both');
    await expect(row.locator('i')).toHaveCount(0);

    // Enter adds too, then the field is empty and ready for the next one.
    const hers = unique('Hers');
    await pickList(page, PARTNER_NAME);
    await page.getByLabel('New to-do', { exact: true }).fill(hers);
    await page.getByLabel('New to-do', { exact: true }).press('Enter');
    const herRow = page.locator('.wm-todo', { has: page.getByRole('button', edit(hers)) });
    await expect(herRow).toHaveAttribute('data-c', 'yellow');
    await expect(page.getByLabel('New to-do', { exact: true })).toBeFocused();
    await expect(page.getByLabel('New to-do', { exact: true })).toHaveValue('');
    const made = (await owner.snapshot()).tasks.filter((t: { date: string }) => t.date === when);
    expect(made).toMatchObject([{ scope: 'week', owners: [OWNER, PARTNER], title }, { scope: 'week', owners: [PARTNER], title: hers }]);

    // Complete: the row stays in the same list, crossed out, after the open one; there is no Done heading or block. Reopen brings it back among the open rows.
    await page.getByRole('checkbox', { name: `Complete ${hers}`, exact: true }).click();
    await expect(page.getByRole('checkbox', { name: `Reopen ${hers}`, exact: true })).toBeChecked();
    await expect(page.locator('ul.wm-todos[aria-label="To-do"] > li.wm-todo')).toHaveText([/Both/, /Hers/]);
    await expect(page.locator('ul.wm-todos[aria-label="To-do"] > li.wm-todo.done')).toHaveCount(1);
    await expect(page.locator('.wm-done')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /^Done/ })).toHaveCount(0);
    await page.getByRole('checkbox', { name: `Reopen ${hers}`, exact: true }).click();
    await expect(page.locator('ul.wm-todos[aria-label="To-do"] > li.wm-todo.done')).toHaveCount(0);

    // Edit: the title becomes a field in its row (no window), on the saved title with no For control; the new title is saved on Enter and the owner stays the partner's.
    const rowOf = page.locator('.wm-todo', { has: page.getByRole('button', edit(hers)) });
    // Where the row is on the screen, once the page has stopped moving (a field taking the focus may scroll the page, which is not the row moving).
    const inList = async (row: Locator) => { await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))); const r = (await row.boundingBox())!; return { y: r.y, height: r.height }; };
    const was = await inList(rowOf);
    await page.getByRole('button', edit(hers)).click();
    const input = field(page, `Edit to-do: ${hers}`);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(hers);
    await noWindow(page);
    await expect(page.getByRole('radiogroup')).toHaveCount(0);
    const now = await inList(page.locator('.wm-todo.wm-editing'));
    expect(Math.abs(now.y - was.y) + Math.abs(now.height - was.height), 'the row does not move or change size').toBeLessThanOrEqual(1);
    await expect(page.locator('.wm-todo.wm-editing .ip-count')).toHaveText(`${hers.length} / 500`);
    const renamed = unique('Renamed');
    await input.fill(renamed);
    await input.press('Enter');
    await expect(page.getByRole('button', edit(renamed))).toBeFocused();
    await expect(page.locator('.wm-todo', { has: page.getByRole('button', edit(renamed)) })).toHaveAttribute('data-c', 'yellow');
    expect((await owner.snapshot()).tasks.find((t: { title: string }) => t.title === renamed)).toMatchObject({ owners: [PARTNER] });
    await pickList(page, 'Both');
    expect(await browserStorage(page)).toEqual({ local: 0, session: 0, indexedDB: 0, caches: 0 });

    // Another period and the Day view do not show it.
    await page.getByRole('button', { name: 'Next week', exact: true }).click();
    await expect(page.getByRole('button', edit(renamed))).toHaveCount(0);
    await page.getByRole('button', { name: 'Previous week', exact: true }).click();
    await page.getByRole('button', { name: 'Day', exact: true }).click();
    await expect(page.getByText(renamed)).toHaveCount(0);
    await page.getByRole('button', { name: 'Week', exact: true }).click();

    // Delete asks twice, in the row, and the first press says who it is for.
    await page.getByRole('button', edit(title)).click();
    await page.locator('.wm-todo.wm-editing .ip-del').click();
    await expect(page.locator('.wm-todo.wm-editing .ip-error')).toHaveText('Deletes it for both of us.');
    await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
    await expect(page.getByRole('button', edit(title))).toHaveCount(0);
    await noWindow(page);
    await removeTodos(owner, made.map((t: { id: string }) => t.id));
  });

  test('a to-do is edited in its row: a day moves it to that week, a title over 500 is refused in the row, Escape gives the changes up, and an empty title asks for text or Delete', async ({ page, baseURL }) => {
    const when = week(95), later = week(103), anyDay = farDate(103);
    const owner = await makeApi(baseURL!, OWNER);
    const id = crypto.randomUUID(), title = unique('Plan');
    await ok(await owner.post(todo({ id, scope: 'week', date: when, owners: [OWNER, PARTNER], title })));
    await login(page, OWNER);
    await open(page, 'Week', when);
    const input = field(page, `Edit to-do: ${title}`), row = page.locator('.wm-todo.wm-editing');
    await page.getByRole('button', edit(title)).click();
    await expect(input).toBeFocused();
    // Over 500: the counter turns, the row says why, and Enter writes nothing.
    await input.fill('é'.repeat(501));
    await expect(row.locator('.ip-count')).toHaveText('501 / 500');
    await expect(row.locator('.ip-count')).toHaveAttribute('data-over', 'true');
    await expect(row.locator('.ip-error')).toHaveText('Keep it to 500 characters.');
    await input.press('Enter');
    await expect(input).toHaveValue('é'.repeat(501));
    expect((await owner.snapshot()).tasks.find((t: { id: string }) => t.id === id)).toMatchObject({ title, revision: 1 });
    // Escape gives it up.
    await input.press('Escape');
    await expect(row).toHaveCount(0);
    await expect(page.getByRole('button', edit(title))).toBeFocused();
    expect((await owner.snapshot()).tasks.find((t: { id: string }) => t.id === id)).toMatchObject({ title, revision: 1 });
    // Emptied: Enter asks for text or Delete and keeps the row open; leaving it puts the old title back.
    await page.getByRole('button', edit(title)).click();
    await input.fill('');
    await input.press('Enter');
    await expect(row.locator('.ip-error')).toHaveText('Type something, or use Delete.');
    await leaveField(page);
    await expect(row).toHaveCount(0);
    await expect(page.getByRole('button', edit(title))).toBeVisible();
    // A day of another week moves it there: the to-do belongs to the Monday of that week, and this week no longer has it.
    await page.getByRole('button', edit(title)).click();
    await page.locator('.wm-todo.wm-editing .ip-date').fill(anyDay);
    await input.press('Enter');
    await expect(page.getByRole('button', edit(title))).toHaveCount(0);
    expect((await owner.snapshot()).tasks.find((t: { id: string }) => t.id === id)).toMatchObject({ title, date: later, scope: 'week', owners: [OWNER, PARTNER], revision: 2 });
    await removeTodos(owner, [id]);
  });

  test('an empty week is 13 ruled lines: the add field on the first, a ghost circle on each of 12 blank ones, no "Nothing here yet", and Add shows only with text (Enter adds too)', async ({ page, baseURL }) => {
    const when = week(150);
    const owner = await makeApi(baseURL!, OWNER);
    forgetTodos(owner, 'week', when);
    await login(page, OWNER);
    await open(page, 'Week', when);
    const lines = todoLines(page), blank = blankLines(page), input = page.getByLabel('New to-do', { exact: true }), add = page.locator('button.wm-add-go');
    const rowOf = (title: string) => page.locator('.wm-todo', { has: page.getByRole('button', edit(title)) });
    await expect(lines).toHaveCount(13);
    await expect(page.locator('.wm-todo')).toHaveCount(0);
    // The add field is the first line, with a faint circle like the others; the 12 blank lines follow it.
    await expect(lines.first()).toHaveClass(/\bwm-free-add\b/);
    await expect(lines.first().locator('.wm-ghost')).toBeVisible();
    await expect(input).toHaveAttribute('placeholder', /^Add something for this week/);
    await expect(blank).toHaveCount(12);
    await expect(blank.locator('.wm-ghost')).toHaveCount(12);
    // The blank lines are paper only: nothing on them to focus, and nothing for a screen reader.
    expect(await blank.evaluateAll(els => els.every(el => el.getAttribute('aria-hidden') === 'true' && !el.querySelector('input,button,a,textarea')))).toBe(true);
    await expect(page.getByText('Nothing here yet')).toHaveCount(0);
    await expect(page.locator('.wm-empty')).toHaveCount(0);
    await expectRuled(lines);

    // No Add button until there is something to add (spaces alone are nothing); with text it shows.
    await expect(add).toBeHidden();
    await input.fill('   ');
    await expect(add).toBeHidden();
    const first = unique('Paper'), second = unique('Enter');
    await input.fill(first);
    await expect(add).toBeVisible();
    await expect(add).toHaveText('Add');
    await expect(add).toHaveAttribute('type', 'submit');
    await add.click();
    await expect(rowOf(first)).toBeVisible();
    // The row took the first line, the add line moved down one, and a blank line gave way: still 13 lines.
    await expect(lines).toHaveCount(13);
    await expect(lines.nth(0)).toHaveClass(/\bwm-todo\b/);
    await expect(lines.nth(1)).toHaveClass(/\bwm-free-add\b/);
    await expect(blank).toHaveCount(11);
    await expect(add).toBeHidden();
    // Enter adds too, with no Add button pressed.
    await expect(input).toBeFocused();
    await input.fill(second);
    await input.press('Enter');
    await expect(rowOf(second)).toBeVisible();
    await expect(lines).toHaveCount(13);
    await expect(lines.nth(2)).toHaveClass(/\bwm-free-add\b/);
    await expect(blank).toHaveCount(10);
    await expect(blank.locator('.wm-ghost')).toHaveCount(10);
    await expectRuled(lines);
    expect((await owner.snapshot()).tasks.filter((t: { date: string; scope: string }) => t.date === when && t.scope === 'week')).toMatchObject([{ title: first }, { title: second }]);

    // A row keeps its owner in the circle (Both is purple); the name is there for a screen reader alone.
    const ownerMark = rowOf(first).locator('.wm-owner'), circle = rowOf(first).locator('input.wm-check');
    await expect(ownerMark).toHaveText('Both');
    await expect(ownerMark).toHaveClass(/\bsr-only\b/);
    expect((await right(ownerMark)).width).toBeLessThanOrEqual(1);
    await expect(circle).toBeVisible();
    await expect(circle).toHaveCSS('width', '18px');
    await expect(circle).toHaveCSS('height', '18px');
    expect(await page.evaluate(([row, ghost]) => getComputedStyle(document.querySelector(row)!).borderTopColor !== getComputedStyle(document.querySelector(ghost)!).borderTopColor, ['.wm-todo input.wm-check', '.wm-free .wm-ghost'])).toBe(true);
    expect(await browserStorage(page)).toEqual({ local: 0, session: 0, indexedDB: 0, caches: 0 });
  });

  test('a click on the faint circle of the add line, and on a blank ruled line (or its circle), starts a to-do on that line; with words in the add field a click on its line goes on typing there', async ({ page, baseURL }) => {
    const when = week(180);
    const owner = await makeApi(baseURL!, OWNER);
    forgetTodos(owner, 'week', when);
    await login(page, OWNER);
    await open(page, 'Week', when);
    const lines = todoLines(page), blank = blankLines(page), input = page.getByLabel('New to-do', { exact: true });
    await expect(page.locator('.wm-todo')).toHaveCount(0);
    await expect(blank).toHaveCount(12);
    await expect(input).not.toBeFocused();
    // A blank line is a place to write (the thirds of the Both view are in todo-thirds.spec.ts): the circle of the add line is paper like the
    // others, at the left end of the line, so a click on it is the left third, the owner's, who is signed in. The new to-do takes the add field's place.
    await lines.first().locator('.wm-ghost').click();
    await expect(field(page, `New to-do for ${OWNER_NAME}`)).toBeFocused();
    await expect(input).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(input).toBeFocused();
    await leaveField(page);
    await expect(input).not.toBeFocused();
    // So does a click on a blank ruled line further down (the middle of it is both of us), and on the circle of the last one.
    await blank.nth(7).click();
    await expect(field(page, `New to-do for ${OWNER_NAME} and ${PARTNER_NAME}`)).toBeFocused();
    await expect(input).toBeVisible();
    await page.keyboard.press('Escape');
    await leaveField(page);
    await blank.last().locator('.wm-ghost').click();
    await expect(field(page, `New to-do for ${OWNER_NAME}`)).toBeFocused();
    await page.keyboard.press('Escape');
    await leaveField(page);
    await expect(page.locator('.wm-todo')).toHaveCount(0);
    // With words in the add field its line is the field's: a click on the line goes on typing there.
    await input.fill('Half a thought');
    await leaveField(page);
    await lines.first().locator('.wm-ghost').click();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Half a thought');
    await expect(page.locator('.wm-new')).toHaveCount(0);
  });

  test('a week with 13 or more rows: the list simply grows (the open rows, the add line, then the done ones crossed out at the bottom, no other blank lines); done rows use up the blank lines', async ({ page, baseURL }) => {
    const when = week(165);
    const owner = await makeApi(baseURL!, OWNER);
    forgetTodos(owner, 'week', when);
    const rows = Array.from({ length: 11 }, (_, i) => todo({ scope: 'week', date: when, title: unique(`Row ${String(i).padStart(2, '0')}`) }));
    for (const row of rows) { await ok(await owner.post(row)); }
    await login(page, OWNER);
    await open(page, 'Week', when);
    const lines = todoLines(page), blank = blankLines(page), input = page.getByLabel('New to-do', { exact: true });
    // 11 rows, the add line and one blank line make the 13 lines.
    await expect(lines).toHaveCount(13);
    await expect(page.locator('ul.wm-todos[aria-label="To-do"] > li.wm-todo')).toHaveCount(11);
    await expect(blank).toHaveCount(1);
    await expectRuled(lines);

    // A row finished stays in the list, crossed out, at the bottom under the blank lines: the rows are the same 11, so the lines stay 13.
    for (const finished of [1, 2, 3]) {
      await page.getByRole('checkbox', { name: `Complete ${rows[finished - 1].title}`, exact: true }).click();
      await expect(page.getByRole('checkbox', { name: `Reopen ${rows[finished - 1].title}`, exact: true })).toBeChecked();
      await expect(lines).toHaveCount(13);
      await expect(blank).toHaveCount(1);
      await expect(page.locator('ul.wm-todos > li.wm-todo.done')).toHaveCount(finished);
      await expect(page.getByRole('heading', { name: /^Done/ })).toHaveCount(0);
    }
    await expect(page.locator('ul.wm-todos[aria-label="Done"], .wm-done')).toHaveCount(0);
    // The open rows are the first eight, then the add line and the one blank line, and the done ones are the last three lines, in the order the rows were made.
    for (let i = 0; i < 13; i++) { await expect(lines.nth(i), `line ${i + 1}`).toHaveClass(i < 8 ? /^(?!.*\b(done|wm-free)\b).*$/ : i < 10 ? /\bwm-free\b/ : /\bdone\b/); }
    await expect(lines.nth(8)).toHaveClass(/\bwm-free-add\b/);
    await expect(lines.nth(10)).toContainText(rows[0].title);
    await expect(lines.nth(12)).toContainText(rows[2].title);
    const [blankLine, firstDone, lastDone] = [await right(lines.nth(9)), await right(lines.nth(10)), await right(lines.nth(12))];
    expect(firstDone.y, 'the done rows are under the blank lines').toBeGreaterThanOrEqual(blankLine.y + blankLine.height - 1);
    expect(lastDone.y, 'and the last done row is the last line').toBeGreaterThan(firstDone.y);

    // Adding fills the blank line first (13 lines), then the list grows by one line for each new row, the add line staying between the open rows and
    // the done ones. A new row goes after the open ones, above the add line.
    for (const [title, count, at] of [[unique('Fills'), 13, 8], [unique('Grows'), 14, 9]] as const) {
      // The keyboard's way (a click on the empty field is a click on a blank line: todo-thirds.spec.ts).
      await input.focus();
      await input.fill(title);
      await input.press('Enter');
      await expect(page.getByRole('button', edit(title))).toBeVisible();
      await expect(lines).toHaveCount(count);
      await expect(blank).toHaveCount(0);
      await expect(lines.last()).toHaveClass(/\bdone\b/);
      await expect(lines.nth(at)).toContainText(title);
      await expect(lines.nth(at)).not.toHaveClass(/\bdone\b/);
      await expect(lines.nth(at + 1)).toHaveClass(/\bwm-free-add\b/);
      await expect(lines.nth(at + 2)).toHaveClass(/\bdone\b/);
    }
    await expectRuled(lines);
    // Reopening a done row puts it back among the open ones; the lines stay as they were.
    await page.getByRole('checkbox', { name: `Reopen ${rows[0].title}`, exact: true }).click();
    await expect(page.locator('ul.wm-todos > li.wm-todo.done')).toHaveCount(2);
    await expect(lines).toHaveCount(14);
  });

  test('a title over 500 characters is refused with the count, and 500 is accepted', async ({ page, baseURL }) => {
    const when = week(90);
    const owner = await makeApi(baseURL!, OWNER);
    await login(page, OWNER);
    await open(page, 'Week', when);
    const input = page.getByLabel('New to-do', { exact: true });
    await expect(page.locator('.wm-add-count')).toBeHidden();
    await input.fill('é'.repeat(501));
    await expect(page.locator('.wm-add-count')).toHaveText('501 / 500');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Use at most 500 characters.');
    expect((await owner.snapshot()).tasks.filter((t: { date: string }) => t.date === when)).toHaveLength(0);
    // The banner lies over the page header, not over the add box: the box is used again with the refusal still showing.
    await input.fill('é'.repeat(500));
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.locator('.wm-todo')).toHaveCount(1);
    await removeTodos(owner, (await owner.snapshot()).tasks.filter((t: { date: string }) => t.date === when).map((t: { id: string }) => t.id));
  });
});

test.describe('Month', () => {
  const day = (first: string, d: number) => `${first.slice(0, 8)}${String(d).padStart(2, '0')}`;
  const event = (date: string, owners: string[], start: number) => ({ action: 'add', kind: 'event', id: crypto.randomUUID(), date, owners, text: unique('Ev').slice(0, 18), start });

  test('the grid has 42 days and no dots or counts, whatever is planned on them: the days carry the chores, and the number of a day opens it', async ({ page, baseURL }) => {
    const first = month(120);
    const owner = await makeApi(baseURL!, OWNER);
    const camp = await makeList(owner);
    await select(owner, { base: 'both', overlays: [camp.id] });
    const busy = day(first, 14), quiet = day(first, 20);
    const made = [event(busy, [OWNER], 540), event(busy, [PARTNER], 600), event(busy, [OWNER, PARTNER], 660), event(busy, [camp.id], 720)];
    for (const e of made) { await ok(await owner.post(e)); }
    cleanup.push(async () => {
      for (const e of (await owner.snapshot()).events.filter((x: { id: string }) => made.some(m => m.id === x.id))) { await owner.post({ action: 'delete', id: e.id, revision: e.revision, confirm: true }); }
    });
    await login(page, OWNER);
    await open(page, 'Month', first);
    await expect(page.locator('.wm-day')).toHaveCount(42);
    const cell = (date: string) => page.locator(`.wm-day[data-date="${date}"]`);
    // What is planned is not drawn on the calendar: no dots, no count, nothing in the day's name about it.
    await expect(page.locator('.wm-dot, .wm-dots, .wm-day-count')).toHaveCount(0);
    await expect(cell(busy).locator('.wm-day-num')).toHaveAttribute('aria-label', /^\w+, \w+ 14, \d{4}$/);
    await expect(cell(quiet).locator('.wm-day-num')).toHaveAttribute('aria-label', /^\w+, \w+ 20, \d{4}$/);
    expect(await cell(busy).innerHTML()).not.toContain('planned');

    await cell(busy).locator('.wm-day-num').click();
    await expect(page.getByRole('button', { name: 'Day', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', busy);
    await expect(page.locator('.wm-panel')).toHaveCount(0);
  });

  test('desktop: the words of the priorities and notes boxes are the Day\'s size (13px over 1.5, labels 12px, the name 11px); a Month priorities box is as tall as its words, two lines when empty, with no resize grip', async ({ page }) => {
    await login(page, OWNER);
    // The Day's own notes box is the measure.
    await page.getByRole('button', { name: 'Day', exact: true }).click();
    await page.locator('#jump-date').fill('2040-02-01');
    const day = await page.locator('.day-note-text').first().evaluate(el => { const c = getComputedStyle(el); return { size: c.fontSize, line: c.lineHeight }; });
    expect(day).toEqual({ size: '13px', line: '19.5px' });
    for (const view of ['Week', 'Month'] as const) {
      await open(page, view, '2040-02-01');
      const looks = await page.locator('.wm-text').evaluateAll(els => els.map(el => { const c = getComputedStyle(el); return `${c.fontSize}/${c.lineHeight}`; }));
      expect(looks.length, `${view} has its boxes`).toBeGreaterThan(1);
      expect(new Set(looks), `${view}: every box is the Day's 13px over 19.5px`).toEqual(new Set(['13px/19.5px']));
      const label = await page.locator('.panel-label').first().evaluate(el => getComputedStyle(el).fontSize);
      const name = await page.locator('.wm-lane-head h3').first().evaluate(el => getComputedStyle(el).fontSize);
      expect([label, name], `${view}: section label 12px (the Day's .day-label), name 11px (its .day-note-name)`).toEqual(['12px', '11px']);
    }
    // The Month's priorities boxes have no fixed size: an empty one is two lines (and its 4px of padding), and every line typed adds one, with nothing to scroll to.
    for (const person of [OWNER_NAME, PARTNER_NAME]) {
      const box = page.getByLabel(`${person} priorities`, { exact: true });
      const size = () => box.evaluate(el => ({ client: el.clientHeight, scrolls: el.scrollHeight > el.clientHeight + 1, resize: getComputedStyle(el).resize }));
      expect(await size(), `${person}: empty is two lines`).toEqual({ client: 43, scrolls: false, resize: 'none' });
      await box.fill('one\ntwo\nthree\nfour\nfive');
      const five = await size();
      expect(Math.abs(five.client - (5 * 19.5 + 4)), `${person}: five lines are five lines tall`).toBeLessThanOrEqual(1);
      expect(five.scrolls, `${person}: five lines show whole`).toBe(false);
      await box.fill('');
      expect((await size()).client, `${person}: emptied again, two lines`).toBe(43);
    }
    // The Month's Notes are a compact box in the sixth calendar row (no grip: the row sets its height); the Week's boxes keep their size and their grip.
    await open(page, 'Month', '2040-02-01');
    expect(await page.getByLabel(`${OWNER_NAME} notes`, { exact: true }).evaluate(el => getComputedStyle(el).resize)).toBe('none');
    await open(page, 'Week', '2040-02-01');
    const week = await page.getByLabel(`${OWNER_NAME} priorities`, { exact: true }).evaluate(el => ({ resize: getComputedStyle(el).resize, client: el.clientHeight }));
    expect(week.resize).toBe('vertical');
    expect(week.client, 'the Week keeps its tall box').toBeGreaterThanOrEqual(280);
  });

  test('desktop: Priorities take at most two thirds of the side column, each card as tall as its words and showing at least eight lines; the calendar never scrolls for the column', async ({ page, baseURL }) => {
    const owner = await makeApi(baseURL!, OWNER);
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `Priority ${i + 1}`).join('\n');
    // Notes written through the API, emptied again when the test ends (the store is shared by the run).
    async function note(period: string, listId: string, text: string) {
      const key = `month:${period}:${listId}:priorities`;
      const stored = (await owner.snapshot()).notes.find((n: { key: string }) => n.key === key);
      await ok(await owner.post({ action: 'saveNote', scope: 'month', period, listId, field: 'priorities', text, revision: stored?.revision ?? 0 }));
      cleanup.push(async () => {
        const kept = (await owner.snapshot()).notes.find((n: { key: string }) => n.key === key);
        if (kept) { await owner.post({ action: 'saveNote', scope: 'month', period, listId, field: 'priorities', text: '', revision: kept.revision }); }
      });
    }
    /** The two priorities cards, the Priorities section against the column, and what scrolls. */
    const look = (page: Page) => page.evaluate(([ownerName, partnerName]) => {
      const box = (label: string) => { const el = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!; return { card: el.closest('.wm-lane')!.getBoundingClientRect().height, lines: Math.floor((el.clientHeight - 4) / 19.5), scrolls: el.scrollHeight > el.clientHeight + 1 }; };
      const high = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().height;
      const over = (selector: string) => { const el = document.querySelector(selector)!; return el.scrollHeight - el.clientHeight; };
      return {
        owner: box(`${ownerName} priorities`), partner: box(`${partnerName} priorities`), priorities: high('[data-sec=priorities]'), side: high('.wm-side'), todo: high('[data-sec=todo]'),
        scroll: { grid: over('.wm-grid'), body: over('.wm-body'), panel: over('.wm-panel'), side: over('.wm-side'), page: document.scrollingElement!.scrollHeight - innerHeight },
      };
    }, [OWNER_NAME, PARTNER_NAME]);
    /** Whether a box carries the shadow along its bottom edge that says there are more words below (mountNotes sets it). */
    const more = (label: string) => page.getByLabel(label, { exact: true }).evaluate(el => el.hasAttribute('data-more'));
    const expectCalm = (seen: Awaited<ReturnType<typeof look>>) => {
      expect(seen.priorities, 'Priorities are at most two thirds of the column').toBeLessThanOrEqual(seen.side * 2 / 3 + 2);
      expect(seen.priorities + seen.todo, 'the two sections fit the column').toBeLessThanOrEqual(seen.side);
      expect(seen.scroll, 'the calendar, the panel, the page and the column itself stay put').toEqual({ grid: 0, body: 0, panel: 0, side: 0, page: 0 });
    };

    // The owner has nothing written and the partner twelve lines (in two months, for the two window sizes), and in a third month both of them thirty.
    const [at1360, at1280, both] = [month(330), month(370), month(410)];
    await note(at1360, PARTNER, lines(12));
    await note(at1280, PARTNER, lines(12));
    await note(both, PARTNER, lines(30));
    await note(both, OWNER, lines(30));
    await login(page, OWNER);

    // The owner's card is small and the partner's has all the room that is left.
    for (const [width, height, when] of [[1360, 900, at1360], [1280, 800, at1280]] as const) {
      await page.setViewportSize({ width, height });
      await open(page, 'Month', when);
      const seen = await look(page);
      expect(seen.owner.lines, `${width}x${height}: ${OWNER_NAME}'s empty box is two lines`).toBe(2);
      expect(seen.owner.card, `${width}x${height}: ${OWNER_NAME}'s card is small`).toBeLessThanOrEqual(110);
      expect(seen.partner.lines, `${width}x${height}: ${PARTNER_NAME}'s box shows at least eight lines`).toBeGreaterThanOrEqual(8);
      expect(seen.partner.card).toBeGreaterThan(seen.owner.card * 2);
      if (width === 1360) { expect(seen.partner.scrolls, 'all twelve lines show at 1360x900').toBe(false); }
      expect(await more(`${OWNER_NAME} priorities`), `${width}x${height}: an empty box has nothing below its edge`).toBe(false);
      expect(await more(`${PARTNER_NAME} priorities`), `${width}x${height}: ${PARTNER_NAME}'s box has the shadow exactly when it cuts words off`).toBe(seen.partner.scrolls);
      expectCalm(seen);
    }

    // Both write a lot: each card shows at least eight lines (they share the two thirds evenly), the box past its share scrolls inside itself, and the to-do list, short of room, scrolls too.
    await page.setViewportSize({ width: 1360, height: 900 });
    await open(page, 'Month', both);
    const full = await look(page);
    expect(full.owner.lines).toBeGreaterThanOrEqual(8);
    expect(full.partner.lines).toBeGreaterThanOrEqual(8);
    expect(Math.abs(full.owner.card - full.partner.card), 'the two long cards share evenly').toBeLessThanOrEqual(2);
    expect([full.owner.scrolls, full.partner.scrolls]).toEqual([true, true]);
    expectCalm(full);
    // Past its share a box shows it has more words below its last line (a cut on a line boundary looks like the end), until it is scrolled there.
    expect([await more(`${OWNER_NAME} priorities`), await more(`${PARTNER_NAME} priorities`)]).toEqual([true, true]);
    await page.getByLabel(`${OWNER_NAME} priorities`, { exact: true }).evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect.poll(() => more(`${OWNER_NAME} priorities`)).toBe(false);
    expect(await more(`${PARTNER_NAME} priorities`)).toBe(true);
    expect(await page.locator('ul.wm-todos').evaluate(el => ({ scrolls: el.scrollHeight > el.clientHeight, overflow: getComputedStyle(el).overflowY }))).toEqual({ scrolls: true, overflow: 'auto' });
    // A card being edited keeps its footer to one row (Reload saved sits beside the name), so it still shows eight lines.
    await page.getByLabel(`${OWNER_NAME} priorities`, { exact: true }).pressSequentially('x');
    await expect(lane(page, `${OWNER_NAME} priorities`).getByRole('button', { name: 'Reload saved', exact: true })).toBeVisible();
    const typing = await look(page);
    expect([typing.owner.lines >= 8, typing.partner.lines >= 8]).toEqual([true, true]);
    expectCalm(typing);

    // Typing a new line grows a box that has room: the owner's own words, as a draft.
    const quiet = month(450);
    await open(page, 'Month', quiet);
    const mine = page.getByLabel(`${OWNER_NAME} priorities`, { exact: true });
    const high = () => mine.evaluate(el => el.clientHeight);
    const empty = await high();
    await mine.fill('first');
    const one = await high();
    expect(one, 'a line of words is no taller than the two lines an empty box has').toBe(empty);
    await mine.fill('first\nsecond\nthird');
    const three = await high();
    expect(Math.abs(three - empty - 19.5), 'three lines are one more than the two an empty box has').toBeLessThanOrEqual(1);
    await mine.press('Enter');
    await mine.pressSequentially('fourth');
    expect(Math.abs((await high()) - three - 19.5), 'a fourth line adds one line').toBeLessThanOrEqual(1);
    expect(await mine.evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  });

  test('desktop: a card whose note was saved elsewhere keeps its name and the recovery buttons apart, with a short name and the longest one, after the first press of Reload saved too', async ({ page, baseURL }) => {
    const when = month(1200);
    const owner = await makeApi(baseURL!, OWNER), partner = await makeApi(baseURL!, PARTNER);
    const camp = await makeList(owner, unique('Far lake trip'));
    await select(owner, { base: 'both', overlays: [camp.id] });
    const cards = [{ label: `${OWNER_NAME} priorities`, id: OWNER }, { label: `${camp.name} priorities`, id: camp.id }];
    await login(page, OWNER);
    await open(page, 'Month', when);
    for (const { label } of cards) { await page.getByLabel(label, { exact: true }).fill('mine'); }
    await leaveField(page);
    // Someone saves each of them from another device, then Save finds the newer versions.
    for (const { id } of cards) {
      await ok(await partner.post({ action: 'saveNote', scope: 'month', period: when, listId: id, field: 'priorities', text: 'theirs', revision: 0 }));
      cleanup.push(async () => {
        const kept = (await owner.snapshot()).notes.find((n: { key: string }) => n.key === `month:${when}:${id}:priorities`);
        if (kept) { await owner.post({ action: 'saveNote', scope: 'month', period: when, listId: id, field: 'priorities', text: '', revision: kept.revision }); }
      });
    }
    for (const { label } of cards) {
      await saveOf(lane(page, label)).click();
      await expect(lane(page, label).getByRole('button', { name: 'Keep mine', exact: true })).toBeVisible();
    }
    /** What in a card runs into what else, or out of the card (across or down): its name, the "you" tag and every visible button. */
    const clashes = (card: Locator) => card.evaluate(el => {
      const parts = [...el.querySelectorAll<HTMLElement>('.wm-lane-head h3, .wm-lane-head .wm-you, button:not([hidden])')].filter(part => part.getClientRects().length);
      const box = el.getBoundingClientRect(), found: string[] = [];
      parts.forEach((a, i) => {
        const r = a.getBoundingClientRect();
        if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5) { found.push(`"${a.textContent}" leaves the card`); }
        for (const b of parts.slice(i + 1)) {
          const s = b.getBoundingClientRect();
          if (r.left < s.right - 0.5 && s.left < r.right - 0.5 && r.top < s.bottom - 0.5 && s.top < r.bottom - 0.5) { found.push(`"${a.textContent}" meets "${b.textContent}"`); }
        }
      });
      return found;
    });
    for (const { label } of cards) { expect(await clashes(lane(page, label)), `${label}: newer version saved`).toEqual([]); }
    // The first press of Reload saved asks "Discard draft?", a longer word.
    for (const { label } of cards) {
      await lane(page, label).getByRole('button', { name: 'Reload saved', exact: true }).click();
      await expect(lane(page, label).getByRole('button', { name: 'Discard draft?', exact: true })).toBeVisible();
      expect(await clashes(lane(page, label)), `${label}: Discard draft?`).toEqual([]);
    }
  });

  test('desktop: Priorities and To-do in the column beside the grid, one block above the next, and Notes in the leftover cells of the sixth row', async ({ page, baseURL }) => {
    const first = '2040-02-01';
    const owner = await makeApi(baseURL!, OWNER);
    const camp = await makeList(owner);
    await select(owner, { base: 'both', overlays: [camp.id] });
    await login(page, OWNER);
    await open(page, 'Month', first);
    // Priorities blocks stack in the narrow column.
    const [one, two, three] = [await right(lane(page, `${OWNER_NAME} priorities`)), await right(lane(page, `${PARTNER_NAME} priorities`)), await right(lane(page, `${camp.name} priorities`))];
    expect(Math.abs(one.x - two.x) + Math.abs(two.x - three.x)).toBeLessThan(2);
    expect(one.y + one.height).toBeLessThanOrEqual(two.y);
    expect(two.y + two.height).toBeLessThanOrEqual(three.y);
    const side = await right(page.locator('.wm-side')), todoBox = await right(page.getByLabel('New to-do', { exact: true }));
    expect(todoBox.y).toBeGreaterThan(three.y + three.height);
    expect(todoBox.x + todoBox.width).toBeLessThanOrEqual(side.x + side.width);
    // The grid starts to the right of the column. As the wireframe draws it, the sixth row keeps three muted days of the next
    // month (Monday to Wednesday) and the Notes take Thursday to Sunday of that row, under the weekday heads of those columns.
    const monday = await right(page.locator('.wm-day').first());
    expect(monday.x).toBeGreaterThanOrEqual(side.x + side.width - 1);
    const notes = await right(page.locator('.wm-notes'));
    expect(notes.x).toBeGreaterThanOrEqual(side.x + side.width - 1);
    const shown = page.locator('.wm-day:visible');
    await expect(shown).toHaveCount(38);
    for (const index of [35, 36, 37]) { await expect(shown.nth(index)).toHaveClass(/\bout\b/); }
    const lastShown = await right(shown.last());
    expect(Math.abs(notes.y - lastShown.y)).toBeLessThan(2);
    expect(notes.x).toBeGreaterThanOrEqual(lastShown.x + lastShown.width - 1);
    const [thursday, sunday] = [await right(page.locator('.wm-dow').nth(3)), await right(page.locator('.wm-dow').nth(6))];
    expect(Math.abs(notes.x - thursday.x)).toBeLessThan(2);
    expect(Math.abs(notes.x + notes.width - (sunday.x + sunday.width))).toBeLessThan(2);
    // Cells the Notes block takes are not drawn, and nothing planned can be under them.
    await expect(page.locator('.wm-day[data-covered]')).toHaveCount(4);
    await expect(page.locator('.wm-day[data-covered]').first()).toBeHidden();
    expect(await page.locator('.wm-day[data-covered]').evaluateAll(cells => cells.every(cell => cell.classList.contains('out')))).toBe(true);
    // One compact card for each lane in the one row of the four cells, none taller than the row. A card keeps 156px (what its three rows hold needs it), so two lanes sit side by side and a third does not fit:
    // it begins inside the block, cut off by its edge (which says there is more), and the strip of cards scrolls sideways to it. Nothing wraps below, and the page and the rows do not move.
    const blocks = [await right(lane(page, `${OWNER_NAME} notes`)), await right(lane(page, `${PARTNER_NAME} notes`)), await right(lane(page, `${camp.name} notes`))];
    expect(new Set(blocks.map(block => Math.round(block.y))).size, 'one row of cards').toBe(1);
    expect(blocks[1].x).toBeGreaterThan(blocks[0].x + blocks[0].width - 1);
    expect(blocks[2].x).toBeGreaterThan(blocks[1].x + blocks[1].width - 1);
    for (const block of blocks) {
      expect(block.width, 'a card keeps its width').toBeGreaterThanOrEqual(155);
      expect(block.y).toBeGreaterThanOrEqual(notes.y - 1);
      expect(block.y + block.height).toBeLessThanOrEqual(notes.y + notes.height + 1);
    }
    for (const block of blocks.slice(0, 2)) { expect(block.x + block.width).toBeLessThanOrEqual(notes.x + notes.width + 1); }
    expect(blocks[2].x, 'the third card begins inside the block').toBeLessThan(notes.x + notes.width - 20);
    expect(await page.locator('.wm-notes .wm-lanes').evaluate(el => el.scrollWidth > el.clientWidth), 'the strip scrolls sideways to the third card').toBe(true);
    await lane(page, `${camp.name} notes`).getByLabel(`${camp.name} notes`, { exact: true }).focus();
    expect(await wholeInStrip(page, camp.name), 'a key press that reaches the third card shows it whole').toBe(true);
    // "Notes" and the first card's name are on one line, in the sixth row, and a card's box shows about two lines (room for more when the row has it).
    const [label, name] = [await right(page.locator('.wm-notes .panel-label')), await right(lane(page, `${OWNER_NAME} notes`).locator('h3'))];
    expect(Math.abs(label.y + label.height / 2 - (name.y + name.height / 2)), 'the label and the first name on one line').toBeLessThanOrEqual(4);
    expect(label.x + label.width, 'the label is before the cards').toBeLessThanOrEqual(blocks[0].x + 1);
    const lines = await lane(page, `${OWNER_NAME} notes`).getByLabel(`${OWNER_NAME} notes`, { exact: true }).evaluate(el => (el.clientHeight - 4) / 19.5);
    expect(lines, 'about two lines of words').toBeGreaterThanOrEqual(1.9);
    expect(lines).toBeLessThanOrEqual(3.5);
    // The count and Save are whole inside the card, under the box and not on its words.
    for (const label of [`${OWNER_NAME} notes`, `${PARTNER_NAME} notes`]) {
      const card = lane(page, label), [box, save, count, around] = [await right(card.getByLabel(label, { exact: true })), await right(saveOf(card)), await right(card.locator('.wm-count')), await right(card)];
      for (const part of [save, count]) {
        expect(part.y, `${label}: under the words`).toBeGreaterThanOrEqual(box.y + box.height - 1);
        expect(part.y + part.height, `${label}: inside the card`).toBeLessThanOrEqual(around.y + around.height + 1);
        expect(part.x + part.width).toBeLessThanOrEqual(around.x + around.width + 1);
      }
      expect(count.x + count.width, `${label}: the count and Save side by side`).toBeLessThanOrEqual(save.x + 1);
    }
    await lane(page, `${PARTNER_NAME} notes`).getByLabel(`${PARTNER_NAME} notes`, { exact: true }).fill('Passport photos');
    await saveOf(lane(page, `${PARTNER_NAME} notes`)).click();
    await expect(lane(page, `${PARTNER_NAME} notes`)).toContainText('Saved');
    expect((await owner.snapshot()).notes.find((n: { key: string }) => n.key === `month:${first}:${PARTNER}:notes`)).toMatchObject({ text: 'Passport photos', field: 'notes' });
  });

  test('desktop: a note typed and saved with the keyboard in the compact Notes box persists; a long one scrolls inside its box while the rows, the card and the page stay put; Reload saved and Save sit on the card without covering the words', async ({ page, baseURL }) => {
    const first = month(500);
    const owner = await makeApi(baseURL!, OWNER);
    cleanup.push(async () => {
      const kept = (await owner.snapshot()).notes.find((n: { key: string }) => n.key === `month:${first}:${OWNER}:notes`);
      if (kept) { await owner.post({ action: 'saveNote', scope: 'month', period: first, listId: OWNER, field: 'notes', text: '', revision: kept.revision }); }
    });
    for (const [width, height] of [[1360, 900], [1280, 800]] as const) {
      await page.setViewportSize({ width, height });
      if (width === 1360) { await login(page, OWNER); }
      await open(page, 'Month', first);
      const card = lane(page, `${OWNER_NAME} notes`), box = card.getByLabel(`${OWNER_NAME} notes`, { exact: true });
      const seen = () => page.evaluate(ownerName => {
        const rows = getComputedStyle(document.querySelector('.wm-grid')!).gridTemplateRows.split(' ').map(Number.parseFloat).slice(1);
        const text = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${ownerName} notes"]`)!, lane = text.closest('.wm-lane')!.getBoundingClientRect(), cell = document.querySelector('.wm-notes')!.getBoundingClientRect();
        return { spread: Math.max(...rows) - Math.min(...rows), card: [lane.top - cell.top, cell.bottom - lane.bottom], scrolls: text.scrollHeight > text.clientHeight + 1, box: text.clientHeight, page: document.scrollingElement!.scrollHeight - innerHeight };
      }, OWNER_NAME);
      const before = await seen();
      expect(before.spread, `${width}x${height}: six equal rows`).toBeLessThanOrEqual(1);
      // Click in the box and type with the keyboard (Enter makes a new line, as in any text box); the words are saved with Tab, Tab and Enter.
      await box.click();
      await expect(box).toBeFocused();
      const long = Array.from({ length: 12 }, (_, i) => `Note line ${i + 1}`).join('\n');
      await page.keyboard.insertText(long);
      await expect(card).toContainText('Unsaved');
      const typing = await seen();
      expect(typing.scrolls, 'twelve lines scroll inside the box').toBe(true);
      expect(Math.abs(typing.box - before.box), 'the box keeps its size while it fills').toBeLessThanOrEqual(1);
      expect(typing.card.every(gap => gap >= -1), 'the card stays inside its cell').toBe(true);
      expect(typing.spread, 'six equal rows while typing').toBeLessThanOrEqual(1);
      expect(typing.page, 'the page does not scroll').toBe(0);
      expect(await box.evaluate(el => el.hasAttribute('data-more') || el.scrollTop + el.clientHeight >= el.scrollHeight - 1), 'the caret is at the end of the words: the box scrolled to it or says there is more').toBe(true);
      // Every part of the card is whole and none lies on the words or on another part.
      const parts = await card.evaluate(el => {
        const rect = (node: Element) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
        const around = rect(el), text = rect(el.querySelector('textarea')!);
        const named = [...el.querySelectorAll<HTMLElement>('.wm-lane-head h3, button:not([hidden]), .wm-count')].filter(node => node.getClientRects().length);
        return { around, text, parts: named.map(node => ({ name: node.textContent!.trim(), ...rect(node) })) };
      });
      const apart = (a: { left: number; right: number; top: number; bottom: number }, b: typeof a) => a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
      for (const part of parts.parts) {
        expect(part.left >= parts.around.left - 0.5 && part.right <= parts.around.right + 0.5 && part.top >= parts.around.top - 0.5 && part.bottom <= parts.around.bottom + 0.5, `"${part.name}" is inside the card`).toBe(true);
        expect(apart(part, parts.text), `"${part.name}" is not on the words`).toBe(true);
      }
      parts.parts.forEach((a, i) => { for (const b of parts.parts.slice(i + 1)) { expect(apart(a, b), `"${a.name}" and "${b.name}" do not meet`).toBe(true); } });
      // Tab leaves the box for Reload saved, then Save; Enter presses it. Saved, and the same text is there after a reload of the page.
      await page.keyboard.press('Tab');
      await expect(card.getByRole('button', { name: 'Reload saved', exact: true })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(saveOf(card)).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(card).toContainText('Saved');
      await expect(card).not.toContainText('Unsaved');
      expect((await owner.snapshot()).notes.find((n: { key: string }) => n.key === `month:${first}:${OWNER}:notes`)).toMatchObject({ text: long });
      await page.reload();
      await expect(page.locator('#sidebar .date-row.selected')).toBeAttached();
      await open(page, 'Month', first);
      await expect(box).toHaveValue(long);
      expect((await seen()).spread, 'six equal rows after the reload').toBeLessThanOrEqual(1);
      // Edited again with the keyboard: the caret at the end of the words (the keys for it differ by platform), a new line, Save by the same Tabs.
      await box.focus();
      await box.evaluate(el => { const text = el as HTMLTextAreaElement; text.setSelectionRange(text.value.length, text.value.length); });
      await page.keyboard.press('Enter');
      await page.keyboard.insertText('And one more');
      await expect(card).toContainText('Unsaved');
      await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
      await expect(card).toContainText('Saved');
      expect((await owner.snapshot()).notes.find((n: { key: string }) => n.key === `month:${first}:${OWNER}:notes`)).toMatchObject({ text: `${long}\nAnd one more` });
      await box.fill('');
      await saveOf(card).click();
      await expect(card).toContainText('Saved');
    }
  });

  test('desktop: a compact Notes card keeps its three rows in every state (a draft, Discard draft?, saved elsewhere, over the limit): the cue stands in for the count or Save, the buttons stay whole on the card, the box keeps its two lines', async ({ page, baseURL }) => {
    const first = month(520);
    const [owner, partner] = [await makeApi(baseURL!, OWNER), await makeApi(baseURL!, PARTNER)];
    cleanup.push(async () => {
      const kept = (await owner.snapshot()).notes.find((n: { key: string }) => n.key === `month:${first}:${OWNER}:notes`);
      if (kept) { await owner.post({ action: 'saveNote', scope: 'month', period: first, listId: OWNER, field: 'notes', text: '', revision: kept.revision }); }
    });
    for (const [width, height] of [[1360, 900], [1280, 800]] as const) {
      await page.setViewportSize({ width, height });
      if (width === 1360) { await login(page, OWNER); }
      await open(page, 'Month', first);
      const where = `${width}x${height}`, card = lane(page, `${OWNER_NAME} notes`), box = card.getByLabel(`${OWNER_NAME} notes`, { exact: true }), status = card.getByRole('status');
      const reload = card.getByRole('button', { name: 'Reload saved', exact: true }), keep = card.getByRole('button', { name: 'Keep mine', exact: true }), discard = card.getByRole('button', { name: 'Discard draft?', exact: true });
      const calm = async (state: string) => {
        expect(await cardProblems(card), `${where}: ${state}`).toEqual([]);
        expect(await linesOf(box), `${where}: ${state}: the box keeps its lines`).toBeGreaterThanOrEqual(1.9);
        expect(await card.locator('.wm-count').evaluate(el => el.getBoundingClientRect().height), `${where}: ${state}: the count is one line`).toBeLessThanOrEqual(16.5);
      };
      const lines = await linesOf(box);
      await calm('empty');
      // A draft: Reload saved takes the place of the word Unsaved (which stays for a screen reader), and the count keeps one line with three digits.
      await box.fill('mine, '.repeat(20));
      await expect(reload).toBeVisible();
      await expect(status).toHaveText('Unsaved');
      await calm('a draft');
      // The first press of Reload saved asks "Discard draft?", a longer word; the second throws the draft away.
      await reload.click();
      await expect(discard).toBeVisible();
      await calm('Discard draft?');
      await discard.click();
      await expect(box).toHaveValue(/^$/);
      await box.fill('mine, '.repeat(20));
      await expect(reload).toBeVisible();
      // Another device saves the note, and Save finds the newer version: a cue where the count was, Keep mine where Save was, Reload saved beside the name; the sentence is the status.
      await ok(await partner.post({ action: 'saveNote', scope: 'month', period: first, listId: OWNER, field: 'notes', text: 'theirs', revision: (await owner.snapshot()).notes.find((n: { key: string }) => n.key === `month:${first}:${OWNER}:notes`)?.revision ?? 0 }));
      await saveOf(card).click();
      await expect(keep).toBeVisible();
      await expect(reload).toBeVisible();
      await expect(card.locator('.wm-cue')).toHaveText('Newer version');
      await expect(status).toHaveText(`${PARTNER_NAME} saved a newer version since you began.`);
      await expect(saveOf(card)).toBeHidden();
      await calm('saved elsewhere');
      expect(Math.abs(await linesOf(box) - lines), `${where}: the box is as tall as before`).toBeLessThanOrEqual(0.1);
      // Both buttons work from where they sit: Keep mine makes the draft the newer version's, and Save is back.
      await keep.click();
      await expect(card.locator('.wm-cue')).toHaveText('');
      await expect(saveOf(card)).toBeVisible();
      await calm('kept mine');
      // Over the limit: the count, a cue beside it and no Save (it is disabled): the sentence is the status.
      await box.fill('x'.repeat(12001));
      await expect(card.locator('.wm-cue')).toHaveText('Too long');
      await expect(status).toHaveText('Use at most 12000 characters.');
      await expect(card.locator('.wm-count')).toHaveText('12001 / 12000');
      await expect(saveOf(card)).toBeHidden();
      await expect(reload).toBeVisible();
      await calm('over the limit');
      // Back under it, the card is as it was; Reload saved (twice) leaves nothing of the draft.
      await box.fill('mine again');
      await expect(saveOf(card)).toBeEnabled();
      await calm('back under the limit');
      await reload.click();
      await discard.click();
      await expect(box).toHaveValue('theirs');
      await expect(card.locator('.wm-count')).toHaveText('6 / 12000');
      await calm('reloaded');
      await box.fill('');
      await saveOf(card).click();
      await expect(card).toContainText('Saved');
    }
  });

  test('desktop: with three lanes at 1360x900 and four at 1280x800 each Notes card keeps its width and what is on its rows (the name, the count in one line, Save); the strip scrolls sideways, a key press shows the card whole, and a note typed in the last card is saved', async ({ page, baseURL }) => {
    const first = month(540);
    const owner = await makeApi(baseURL!, OWNER);
    const [camp, garden] = [await makeList(owner, unique('Far lake trip'), 'blue'), await makeList(owner, unique('Garden'), 'purple')];
    cleanup.push(async () => {
      const kept = (await owner.snapshot()).notes.find((n: { key: string }) => n.key === `month:${first}:${garden.id}:notes`);
      if (kept) { await owner.post({ action: 'saveNote', scope: 'month', period: first, listId: garden.id, field: 'notes', text: '', revision: kept.revision }); }
    });
    for (const [width, height, lists] of [[1360, 900, [camp]], [1280, 800, [camp, garden]]] as const) {
      await select(owner, { base: 'both', overlays: lists.map(list => list.id) });
      await page.setViewportSize({ width, height });
      if (width === 1360) { await login(page, OWNER); } else { await page.reload(); await expect(page.locator('#sidebar .date-row.selected')).toBeAttached(); }
      await open(page, 'Month', first);
      const where = `${width}x${height}`, cards = [OWNER_NAME, PARTNER_NAME, ...lists.map(list => list.name)];
      await expect(page.locator('.wm-notes .wm-lane')).toHaveCount(cards.length);
      for (const name of cards) {
        const card = lane(page, `${name} notes`);
        // A name too long for the card ends in an ellipsis, but never goes (three characters at least), and the people's own are whole.
        expect(await cardProblems(card, name === OWNER_NAME || name === PARTNER_NAME), `${where}: ${name}`).toEqual([]);
        expect(await card.locator('h3').evaluate(el => el.clientWidth), `${where}: ${name}: the name is there`).toBeGreaterThanOrEqual(18);
        expect((await right(card)).width, `${where}: ${name}: the card keeps its width`).toBeGreaterThanOrEqual(155);
      }
      expect(await page.locator('.wm-notes .wm-lanes').evaluate(el => el.scrollWidth > el.clientWidth), `${where}: the strip scrolls sideways`).toBe(true);
      const rows = await page.locator('.wm-grid').evaluate(grid => getComputedStyle(grid).gridTemplateRows.split(' ').map(Number.parseFloat).slice(1));
      expect(Math.max(...rows) - Math.min(...rows), `${where}: six equal rows`).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.scrollingElement!.scrollHeight - innerHeight), `${where}: the page does not scroll`).toBe(0);
      // The keyboard (or a click) on the last card shows it whole, and the first again after it.
      const last = cards.at(-1)!;
      await lane(page, `${last} notes`).getByLabel(`${last} notes`, { exact: true }).focus();
      expect(await wholeInStrip(page, last), `${where}: the last card whole`).toBe(true);
      await lane(page, `${OWNER_NAME} notes`).getByLabel(`${OWNER_NAME} notes`, { exact: true }).focus();
      expect(await wholeInStrip(page, OWNER_NAME), `${where}: the first card whole`).toBe(true);
    }
    // A note typed in the last card with the keyboard, saved with Tab, Tab and Enter, is stored.
    const card = lane(page, `${garden.name} notes`), box = card.getByLabel(`${garden.name} notes`, { exact: true });
    await box.focus();
    await page.keyboard.insertText('Seeds to buy');
    await expect(card).toContainText('Unsaved');
    expect(await cardProblems(card, false)).toEqual([]);
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
    await expect(card).toContainText('Saved');
    expect((await owner.snapshot()).notes.find((n: { key: string }) => n.key === `month:${first}:${garden.id}:notes`)).toMatchObject({ text: 'Seeds to buy' });
    expect(await wholeInStrip(page, garden.name)).toBe(true);
  });

  test('desktop: a month that reaches into the sixth row keeps the same four Notes cells (Thursday to Sunday)', async ({ page }) => {
    await login(page, OWNER);
    await open(page, 'Month', '2027-08-01');
    // August 2027 ends on Tuesday of the sixth row: the 1st of September is the one muted day before the Notes.
    const shown = page.locator('.wm-day:visible');
    await expect(shown).toHaveCount(38);
    await expect(shown.nth(36)).toHaveAttribute('data-date', '2027-08-31');
    await expect(shown.nth(37)).toHaveAttribute('data-date', '2027-09-01');
    await expect(shown.nth(37)).toHaveClass(/\bout\b/);
    const [notes, thursday] = [await right(page.locator('.wm-notes')), await right(page.locator('.wm-dow').nth(3))];
    expect(Math.abs(notes.x - thursday.x)).toBeLessThan(2);
    await expect(page.locator('.wm-day[data-covered]')).toHaveCount(4);
  });

  test('month to-dos are the month\'s own, and priorities and notes keep separate texts for one list', async ({ page, baseURL }) => {
    const first = month(150);
    const owner = await makeApi(baseURL!, OWNER);
    await login(page, OWNER);
    await open(page, 'Month', first);
    await page.getByLabel(`${OWNER_NAME} priorities`, { exact: true }).fill('priority text');
    await saveOf(lane(page, `${OWNER_NAME} priorities`)).click();
    await expect(lane(page, `${OWNER_NAME} priorities`)).toContainText('Saved');
    await expect(page.getByLabel(`${OWNER_NAME} notes`, { exact: true })).toHaveValue('');
    const title = unique('Month');
    await page.getByLabel('New to-do', { exact: true }).fill(title);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('button', edit(title))).toBeVisible();
    const snapshot = await owner.snapshot();
    expect(snapshot.tasks.find((t: { title: string }) => t.title === title)).toMatchObject({ scope: 'month', date: first });
    expect(snapshot.notes.find((n: { key: string }) => n.key === `month:${first}:${OWNER}:priorities`)).toMatchObject({ text: 'priority text' });
    await removeTodos(owner, snapshot.tasks.filter((t: { title: string }) => t.title === title).map((t: { id: string }) => t.id));
  });

  test('desktop: an empty month is 8 ruled lines in the side column: the add field on the first, a ghost circle on each of 7 blank ones, no "Nothing here yet", and Add shows only with text (Enter adds too)', async ({ page, baseURL }) => {
    const first = month(240);
    const owner = await makeApi(baseURL!, OWNER);
    forgetTodos(owner, 'month', first);
    await login(page, OWNER);
    await open(page, 'Month', first);
    const lines = todoLines(page), blank = blankLines(page), input = page.getByLabel('New to-do', { exact: true }), add = page.locator('button.wm-add-go');
    const rowOf = (title: string) => page.locator('.wm-todo', { has: page.getByRole('button', edit(title)) });
    await expect(lines).toHaveCount(8);
    await expect(page.locator('.wm-todo')).toHaveCount(0);
    await expect(lines.first()).toHaveClass(/\bwm-free-add\b/);
    await expect(lines.first().locator('.wm-ghost')).toBeVisible();
    await expect(input).toHaveAttribute('placeholder', /^Add something for this month/);
    await expect(blank).toHaveCount(7);
    await expect(blank.locator('.wm-ghost')).toHaveCount(7);
    expect(await blank.evaluateAll(els => els.every(el => el.getAttribute('aria-hidden') === 'true' && !el.querySelector('input,button,a,textarea')))).toBe(true);
    await expect(page.getByText('Nothing here yet')).toHaveCount(0);
    await expect(page.locator('.wm-empty')).toHaveCount(0);
    await expectRuled(lines);
    // The lines are in the narrow column beside the grid, none wider than it.
    const side = await right(page.locator('.wm-side'));
    for (const box of await lines.evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, width: r.width }; }))) {
      expect(box.x).toBeGreaterThanOrEqual(side.x - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(side.x + side.width + 1);
    }

    await expect(add).toBeHidden();
    await input.fill('   ');
    await expect(add).toBeHidden();
    const one = unique('Paper'), two = unique('Enter');
    await input.fill(one);
    await expect(add).toBeVisible();
    await expect(add).toHaveText('Add');
    await add.click();
    await expect(rowOf(one)).toBeVisible();
    // A blank line gave way to the row: still 8 lines, with the add line second.
    await expect(lines).toHaveCount(8);
    await expect(lines.nth(1)).toHaveClass(/\bwm-free-add\b/);
    await expect(blank).toHaveCount(6);
    await expect(add).toBeHidden();
    await expect(input).toBeFocused();
    await input.fill(two);
    await input.press('Enter');
    await expect(rowOf(two)).toBeVisible();
    await expect(lines).toHaveCount(8);
    await expect(lines.nth(2)).toHaveClass(/\bwm-free-add\b/);
    await expect(blank).toHaveCount(5);
    await expectRuled(lines);
    expect((await owner.snapshot()).tasks.filter((t: { date: string; scope: string }) => t.date === first && t.scope === 'month')).toMatchObject([{ title: one }, { title: two }]);
    await expect(rowOf(one).locator('.wm-owner')).toHaveClass(/\bsr-only\b/);
  });
});

test.describe('Month to-dos, edited in place', () => {
  test('a month to-do is edited in its row in the side column: Enter saves, Escape gives up, its day moves it to that month\'s 1st, Delete is two presses', async ({ page, baseURL }) => {
    const here = month(170), there = month(210);
    const owner = await makeApi(baseURL!, OWNER);
    const id = crypto.randomUUID(), title = unique('Month plan');
    await ok(await owner.post(todo({ id, scope: 'month', date: here, owners: [OWNER], title })));
    await login(page, OWNER);
    await open(page, 'Month', here);
    const row = page.locator('.wm-todo.wm-editing'), input = field(page, `Edit to-do: ${title}`);
    await page.getByRole('button', edit(title)).click();
    await expect(input).toBeFocused();
    await noWindow(page);
    await input.fill(`${title} renamed`);
    await input.press('Escape');
    await expect(row).toHaveCount(0);
    await expect(page.getByRole('button', edit(title))).toBeFocused();
    expect((await owner.snapshot()).tasks.find((t: { id: string }) => t.id === id)).toMatchObject({ title, revision: 1 });
    await page.getByRole('button', edit(title)).click();
    await input.fill(`${title} renamed`);
    await input.press('Enter');
    await expect(page.getByRole('button', edit(`${title} renamed`))).toBeFocused();
    expect((await owner.snapshot()).tasks.find((t: { id: string }) => t.id === id)).toMatchObject({ title: `${title} renamed`, scope: 'month', date: here, revision: 2 });
    // Any day of another month puts the to-do on that month's 1st; this month no longer has it.
    await page.getByRole('button', edit(`${title} renamed`)).click();
    await row.locator('.ip-date').fill(periodStart(there, 'month').slice(0, 8) + '17');
    await field(page, `Edit to-do: ${title} renamed`).press('Enter');
    await expect(page.getByRole('button', edit(`${title} renamed`))).toHaveCount(0);
    expect((await owner.snapshot()).tasks.find((t: { id: string }) => t.id === id)).toMatchObject({ scope: 'month', date: periodStart(there, 'month'), revision: 3 });
    await open(page, 'Month', there);
    await page.getByRole('button', edit(`${title} renamed`)).click();
    await row.locator('.ip-del').click();
    await row.getByRole('button', { name: 'Confirm delete', exact: true }).click();
    await expect(page.getByRole('button', edit(`${title} renamed`))).toHaveCount(0);
    expect((await owner.snapshot()).tasks.some((t: { id: string }) => t.id === id)).toBe(false);
  });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && (document.querySelector('.wm-body') as HTMLElement).scrollWidth <= (document.querySelector('.wm-body') as HTMLElement).clientWidth);

  test('Week: Priorities, To-do and Chores tabs, the To-do tab scrolls inside the panel above the bar', async ({ page, baseURL }) => {
    const when = week(100);
    const owner = await makeApi(baseURL!, OWNER);
    const rows = Array.from({ length: 20 }, (_, i) => todo({ scope: 'week', date: when, title: unique(`Row ${i}`) }));
    for (const row of rows) { await ok(await owner.post(row)); }
    cleanup.push(() => removeTodos(owner, rows.map(r => r.id)));
    await login(page, OWNER);
    await open(page, 'Week', when, true);
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveText(['Priorities', 'To-do', 'Chores']);
    await expect(page.getByRole('tab', { name: 'Priorities', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel(`${OWNER_NAME} priorities`, { exact: true })).toBeVisible();
    await expect(page.getByLabel('New to-do', { exact: true })).toBeHidden();

    await page.getByRole('tab', { name: 'To-do', exact: true }).click();
    await expect(page.getByLabel(`${OWNER_NAME} priorities`, { exact: true })).toBeHidden();
    await expect(page.getByLabel('New to-do', { exact: true })).toBeVisible();
    // The tab is kept across a new week.
    await page.getByRole('button', { name: 'Next week', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'To-do', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: 'Previous week', exact: true }).click();

    const body = page.locator('.wm-body');
    const metrics = await body.evaluate(el => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    expect(metrics.scroll).toBeGreaterThan(metrics.client);
    await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
    expect(await body.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: `Edit ${rows[19].title}`, exact: true })).toBeInViewport();
    // The bar stays at the bottom of the screen, and the page itself neither scrolls nor widens.
    const bar = await right(page.locator('.wm-tabs'));
    expect(bar.y + bar.height).toBeGreaterThan(660);
    expect(bar.y + bar.height).toBeLessThanOrEqual(667);
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
    expect(await noSideScroll(page)).toBe(true);
  });

  test('Month: Calendar, Priorities, To-do, Notes and Chores tabs; the active tab alone names itself; a tap on a day opens it', async ({ page, baseURL }) => {
    const first = month(130);
    const owner = await makeApi(baseURL!, OWNER);
    const camp = await makeList(owner);
    await select(owner, { base: 'both', overlays: [camp.id] });
    const rows = Array.from({ length: 20 }, (_, i) => todo({ scope: 'month', date: first, title: unique(`Row ${i}`) }));
    for (const row of rows) { await ok(await owner.post(row)); }
    cleanup.push(() => removeTodos(owner, rows.map(r => r.id)));
    await login(page, OWNER);
    await open(page, 'Month', first, true);
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveCount(5);
    await expect(tabs.nth(0)).toHaveAttribute('aria-label', 'Calendar');
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.locator('span:visible')).toHaveText(['Calendar']);
    await expect(page.locator('.wm-day')).toHaveCount(42);
    for (const cell of await page.locator('.wm-day').all()) { await expect(cell).toBeInViewport(); }
    expect(await noSideScroll(page)).toBe(true);

    await page.getByRole('tab', { name: 'Priorities', exact: true }).click();
    await expect(page.locator('.wm-day').first()).toBeHidden();
    await expect(tabs.locator('span:visible')).toHaveText(['Priorities']);
    // Colored blocks stack, one for each lane.
    const [a, b, c] = [await right(lane(page, `${OWNER_NAME} priorities`)), await right(lane(page, `${PARTNER_NAME} priorities`)), await right(lane(page, `${camp.name} priorities`))];
    expect(Math.abs(a.x - b.x) + Math.abs(b.x - c.x)).toBeLessThan(2);
    expect(a.y + a.height).toBeLessThanOrEqual(b.y);
    expect(b.y + b.height).toBeLessThanOrEqual(c.y);
    await expect(page.getByLabel(`${OWNER_NAME} notes`, { exact: true })).toBeHidden();
    await page.getByRole('tab', { name: 'Notes', exact: true }).click();
    await expect(page.getByLabel(`${OWNER_NAME} notes`, { exact: true })).toBeVisible();
    await expect(page.getByLabel(`${OWNER_NAME} priorities`, { exact: true })).toBeHidden();
    await page.getByRole('tab', { name: 'To-do', exact: true }).click();
    await expect(page.getByLabel('New to-do', { exact: true })).toBeVisible();
    expect(await noSideScroll(page)).toBe(true);
    // A long list scrolls inside the panel and leaves the bar where it is.
    const body = page.locator('.wm-body');
    expect(await body.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(page.getByRole('button', { name: `Edit ${rows[19].title}`, exact: true })).toBeInViewport();
    expect((await right(page.locator('.wm-tabs'))).y).toBeGreaterThan(600);

    await page.getByRole('tab', { name: 'Calendar', exact: true }).click();
    await page.locator(`.wm-day[data-date="${first.slice(0, 8)}17"]`).tap();
    await expect(page.locator('#date-pill')).toContainText('17');
    await expect(page.locator('.wm-panel')).toHaveCount(0);
  });

  test(`Month: the Priorities and Notes boxes are as tall as a Week's, not a strip (${OWNER_NAME}: take the whole screen like on weeks)`, async ({ page }) => {
    await login(page, OWNER);
    await open(page, 'Week', week(131), true);
    const weekBox = (await right(page.getByLabel(`${OWNER_NAME} priorities`, { exact: true }))).height;
    expect(weekBox).toBeGreaterThanOrEqual(199);
    await open(page, 'Month', month(131), true);
    await page.getByRole('tab', { name: 'Priorities', exact: true }).click();
    const prio = (await right(page.getByLabel(`${OWNER_NAME} priorities`, { exact: true }))).height;
    expect(Math.abs(prio - weekBox), 'a Month priorities box is as tall as a Week one').toBeLessThanOrEqual(1);
    await page.getByRole('tab', { name: 'Notes', exact: true }).click();
    const notes = (await right(page.getByLabel(`${OWNER_NAME} notes`, { exact: true }))).height;
    expect(await page.getByLabel(`${OWNER_NAME} notes`, { exact: true }).evaluate(el => getComputedStyle(el).fontSize), 'a phone keeps 16px so the keyboard does not zoom the page').toBe('16px');
    expect(Math.abs(notes - weekBox), 'a Month notes box is as tall as a Week priorities box').toBeLessThanOrEqual(1);
    expect(await noSideScroll(page)).toBe(true);
  });

  test('the To-do tab of a Week and of a Month is ruled lines too (13 and 8), tall enough for a finger, with a 16px add field and an Add button that appears with text', async ({ page, baseURL }) => {
    const owner = await makeApi(baseURL!, OWNER);
    await login(page, OWNER);
    for (const [view, when, count] of [['Week', week(210), 13], ['Month', month(300), 8]] as const) {
      forgetTodos(owner, view === 'Week' ? 'week' : 'month', when);
      await open(page, view, when, true);
      await page.getByRole('tab', { name: 'To-do', exact: true }).click();
      const lines = todoLines(page), input = page.getByLabel('New to-do', { exact: true }), add = page.locator('button.wm-add-go'), title = unique(view);
      await expect(lines).toHaveCount(count);
      await expect(lines.first()).toHaveClass(/\bwm-free-add\b/);
      await expect(blankLines(page)).toHaveCount(count - 1);
      await expect(page.getByText('Nothing here yet')).toHaveCount(0);
      // A finger needs 40px a line, and a field under 16px makes the phone zoom in when it is tapped.
      await expect(input).toBeVisible();
      await expect(input).toHaveCSS('font-size', '16px');
      await expectRuled(lines);
      expect(Math.min(...(await lines.evaluateAll(els => els.map(el => el.getBoundingClientRect().height))))).toBeGreaterThanOrEqual(39.5);
      await expect(add).toBeHidden();
      await input.fill(title);
      await expect(add).toBeVisible();
      const button = await right(add);
      expect(button.x + button.width, 'the button stays on the screen').toBeLessThanOrEqual(375);
      expect(await noSideScroll(page)).toBe(true);
      await add.tap();
      await expect(page.getByRole('button', edit(title))).toBeVisible();
      await expect(lines).toHaveCount(count);
      await expect(lines.nth(1)).toHaveClass(/\bwm-free-add\b/);
      await expect(add).toBeHidden();
      await expectRuled(lines);
      expect(await noSideScroll(page)).toBe(true);
    }
  });

  test('Week text typed on the phone is a draft until saved, and survives a tab change', async ({ page }) => {
    const when = week(110);
    await login(page, PARTNER);
    await open(page, 'Week', when, true);
    await page.getByLabel(`${PARTNER_NAME} priorities`, { exact: true }).fill('Call school Monday');
    await page.getByRole('tab', { name: 'To-do', exact: true }).click();
    await page.getByRole('tab', { name: 'Priorities', exact: true }).click();
    await expect(page.getByLabel(`${PARTNER_NAME} priorities`, { exact: true })).toHaveValue('Call school Monday');
    await expect(lane(page, `${PARTNER_NAME} priorities`)).toContainText('Unsaved');
    await saveOf(lane(page, `${PARTNER_NAME} priorities`)).click();
    await expect(lane(page, `${PARTNER_NAME} priorities`)).toContainText('Saved');
    expect(await noSideScroll(page)).toBe(true);
  });
});

test.describe('Week and Month: a to-do edited in its row', () => {
  test('left untouched for the add box it is plain text at once; a draft that comes back says so; a to-do given another week leaves the keyboard on the add field', async ({ page, baseURL }) => {
    const when = week(120), later = week(134);
    const owner = await makeApi(baseURL!, OWNER);
    const title = unique('Week item');
    const id = crypto.randomUUID();
    await ok(await owner.post(todo({ id, scope: 'week', date: when, title, owners: [OWNER] })));
    cleanup.push(() => removeTodos(owner, [id]));
    await login(page, OWNER);
    await pickList(page, OWNER_NAME);
    await open(page, 'Week', when);
    // Nothing changed: the focus going to the add box closes the row as plain text, there is no dead field left behind.
    await page.getByRole('button', edit(title)).click();
    await expect(field(page, `Edit to-do: ${title}`)).toBeFocused();
    // The focus reaches the add box with focus(): a click on the empty box is a click on a blank line, which opens a new to-do in place (todo-thirds.spec.ts).
    await page.getByLabel('New to-do', { exact: true }).focus();
    await expect(page.locator('[data-editing]')).toHaveCount(0);
    await expect(page.getByRole('button', edit(title))).toBeVisible();
    // A save the server refused puts the text away; it comes back when the to-do is opened again, and says so until the text changes.
    const partner = await makeApi(baseURL!, PARTNER);
    await ok(await partner.post({ action: 'edit', kind: 'todo', id, revision: 1, date: when, owners: [OWNER], title: `${title} by ${PARTNER_NAME}` }));
    await page.getByRole('button', edit(title)).click();
    await field(page, `Edit to-do: ${title}`).fill(`${title} again`);
    await page.getByRole('button', { name: 'Next week', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await page.getByRole('button', { name: 'Previous week', exact: true }).click();
    await page.getByRole('button', edit(`${title} by ${PARTNER_NAME}`)).click();
    await expect(field(page, `Edit to-do: ${title} by ${PARTNER_NAME}`)).toHaveValue(`${title} again`);
    await expect(page.locator('.wm-todo.wm-editing .ip-error')).toHaveText('Your unsaved changes are back.');
    // Another week for it: the row leaves this list, the screen reader hears where it went, the keyboard is on the add field.
    await page.locator('.wm-todo.wm-editing .ip-date').fill(later);
    await expect(page.locator('.wm-todo.wm-editing .ip-error')).toHaveText('');
    await field(page, `Edit to-do: ${title} by ${PARTNER_NAME}`).press('Enter');
    await expect(page.getByRole('button', edit(`${title} again`))).toHaveCount(0);
    await expect(page.getByLabel('New to-do', { exact: true })).toBeFocused();
    await expect(page.locator('#live')).toContainText('Saved. Moved to the week of ');
    await noWindow(page);
  });
});

