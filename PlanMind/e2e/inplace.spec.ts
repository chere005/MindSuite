import { expect, test, type Page } from '@playwright/test';
import { apiLogin, farDate, field, leaveField, login, noWindow, resetPrefs, unique, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// Editing where the item is (the owner, 2026-10-31: no window for editing content). The rules every kind of item shares, in the real
// app: Enter saves and Escape cancels, the focus leaving the row saves, Tab inside a row keeps it, one item is open at a time, the
// field has a name and the keyboard goes back to the item's button, a failed or stale save keeps what was typed. What each kind
// shows and does is in its own spec (day-desktop, schedule, week-month, picker, linked, day-phone); this file is the rules.
// Each test owns a far-away date and empties it again.
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
/** The writes the page makes (not the saved picker state). */
function recordPosts(page: Page) {
  const posts: Array<Record<string, unknown>> = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('api.php')) { const body = request.postDataJSON(); if (body.action !== 'savePrefs') { posts.push(body); } } });
  return posts;
}
const todoTitle = (api: Api, date: string, title: string) => api.snapshot().then(s => s.tasks.find((t: { date: string; title: string }) => t.date === date && t.title === title));
const editing = (page: Page) => page.locator('[data-editing]');
const edit = (title: string) => ({ name: `Edit ${title}`, exact: true });

test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });

test.describe('editing in place: the rules', () => {
  test('Enter saves in one write, Escape gives the changes up and writes nothing, an unchanged row writes nothing, and the keyboard goes back to the item\'s button', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(700), title = unique('Rule');
    const id = await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title });
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      // Escape: what was typed is given up, nothing is written, the button has the keyboard back.
      await page.getByRole('button', edit(title)).click();
      await field(page, `Edit task: ${title}`).fill('Typed and abandoned');
      await page.keyboard.press('Escape');
      await expect(editing(page)).toHaveCount(0);
      await expect(page.getByRole('button', edit(title))).toBeFocused();
      expect(posts).toHaveLength(0);
      // Nothing typed: Enter closes it and writes nothing.
      await page.getByRole('button', edit(title)).click();
      await field(page, `Edit task: ${title}`).press('Enter');
      await expect(editing(page)).toHaveCount(0);
      await expect(page.getByRole('button', edit(title))).toBeFocused();
      expect(posts).toHaveLength(0);
      // Enter with a change: one write carrying the revision the row opened on, the day and the owners, and what is announced.
      await page.getByRole('button', edit(title)).click();
      await field(page, `Edit task: ${title}`).fill(`${title} later`);
      await field(page, `Edit task: ${title}`).press('Enter');
      await expect(page.getByRole('button', edit(`${title} later`))).toBeFocused();
      expect(posts).toEqual([{ action: 'edit', kind: 'todo', id, revision: 1, date, owners: [OWNER], title: `${title} later` }]);
      await expect(page.locator('#live')).toHaveText('Saved.');
      await noWindow(page);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the focus leaving the row saves it (a click on the page, on another item), exactly as Enter does, and does not take the keyboard back', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(701), one = unique('One'), two = unique('Two');
    await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title: one });
    await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title: two });
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      // A click on nothing in particular.
      await page.getByRole('button', edit(one)).click();
      await field(page, `Edit task: ${one}`).fill(`${one} 2`);
      await page.locator('.page-header h1').click();
      await expect(editing(page)).toHaveCount(0);
      await expect(page.getByRole('button', edit(`${one} 2`))).toBeVisible();
      await expect(page.getByRole('button', edit(`${one} 2`))).not.toBeFocused();
      expect(posts.map(p => p.title)).toEqual([`${one} 2`]);
      // A click on another item: the first is saved, and the other one is the one being edited, with the keyboard in it.
      await page.getByRole('button', edit(`${one} 2`)).click();
      await field(page, `Edit task: ${one} 2`).fill(`${one} 3`);
      await page.getByRole('button', edit(two)).click();
      await expect(field(page, `Edit task: ${two}`)).toBeFocused();
      await expect(editing(page)).toHaveCount(1);
      await expect(page.getByRole('button', edit(`${one} 3`))).toBeVisible();
      expect(posts.map(p => p.title)).toEqual([`${one} 2`, `${one} 3`]);
      // An unchanged row leaves without a write.
      await page.locator('.page-header h1').click();
      await expect(editing(page)).toHaveCount(0);
      expect(posts).toHaveLength(2);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the focus going to a text field of the page (the add box, a note) saves the row and puts it back as plain text at once, though the panel is not drawn again under that field', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(712), title = unique('Plain');
    await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title });
    await add(owner, { action: 'add', kind: 'priority', date, owners: [OWNER], slots: { [OWNER]: 1 }, text: 'First thing' });
    await add(owner, { action: 'add', kind: 'event', date, owners: [OWNER], text: 'Dentist', start: 540, length: 60 });
    try {
      await login(page); await openDay(page, date);
      const box = page.getByLabel('New task', { exact: true }), notes = page.getByLabel(`Notes for ${OWNER_NAME}`, { exact: true });
      // The focus reaches the add box with focus(): a click on the empty box is a click on a blank line, which opens a new to-do in place (todo-thirds.spec.ts).
      await page.getByRole('button', edit(title)).click();
      await field(page, `Edit task: ${title}`).fill(`${title} 2`);
      await box.focus();
      await expect(box).toBeFocused();
      await expect(editing(page)).toHaveCount(0);
      await expect(page.getByRole('button', edit(`${title} 2`))).toBeVisible();
      await page.getByRole('button', { name: `Priority 1: First thing, ${OWNER_NAME}`, exact: true }).click();
      await field(page, 'Edit priority 1: First thing').fill('First thing, again');
      await notes.click();
      await expect(notes).toBeFocused();
      await expect(editing(page)).toHaveCount(0);
      await expect(page.getByRole('button', { name: `Priority 1: First thing, again, ${OWNER_NAME}`, exact: true })).toBeVisible();
      await page.getByRole('button', { name: `Dentist, 9a to 10a, ${OWNER_NAME}`, exact: true }).click();
      await field(page, 'Edit entry: Dentist').fill('Dentist at nine');
      await box.focus();
      await expect(box).toBeFocused();
      await expect(editing(page)).toHaveCount(0);
      await expect(page.getByRole('button', { name: `Dentist at nine, 9a to 10a, ${OWNER_NAME}`, exact: true })).toBeVisible();
      await expect(page.locator('.day-handle')).toHaveCount(0);
      // The typed text of the field the keyboard went to is untouched by all of it.
      await box.fill('half typed');
      await page.getByRole('button', edit(`${title} 2`)).click();
      await field(page, `Edit task: ${title} 2`).press('Escape');
      await expect(box).toHaveValue('half typed');
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('Tab: moving from the title to the day, Delete and back keeps the row and writes nothing; Tab out of the last control of the row saves it, once', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(702), title = unique('Tab');
    await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title });
    await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title: unique('After') });
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', edit(title)).click();
      const input = field(page, `Edit task: ${title}`), row = page.locator('.day-task.day-editing');
      await input.fill(`${title} typed`);
      const inside = () => page.evaluate(() => !!document.activeElement?.closest('.day-task.day-editing'));
      // Forward: the day (several stops inside it) and Delete are the row's; none of them is leaving it.
      const seen: string[] = [];
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('Tab');
        if (!(await inside())) { break; }
        seen.push(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.ip ?? document.activeElement!.tagName));
        expect(posts, `still in the row after ${i + 1} Tabs`).toHaveLength(0);
        await expect(row).toHaveCount(1);
      }
      expect(seen, 'the day and Delete are in the Tab order of the row').toEqual(expect.arrayContaining(['date', 'del']));
      // The press that left the row saved it, once.
      await expect(editing(page)).toHaveCount(0);
      expect(posts.map(p => p.title)).toEqual([`${title} typed`]);
      // And Shift+Tab out of the title does the same, backwards.
      await page.getByRole('button', edit(`${title} typed`)).click();
      await field(page, `Edit task: ${title} typed`).fill(`${title} back`);
      await page.keyboard.press('Shift+Tab');
      await expect(editing(page)).toHaveCount(1);
      await page.keyboard.press('Shift+Tab');
      await expect(editing(page)).toHaveCount(0);
      expect(posts.map(p => p.title)).toEqual([`${title} typed`, `${title} back`]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('one item is open at a time in the Day panel, whatever the kinds: opening a to-do, a priority and an entry in turn saves the one before (an empty new one is dropped)', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(703), title = unique('Todo');
    await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title });
    await add(owner, { action: 'add', kind: 'priority', date, owners: [OWNER], slots: { [OWNER]: 1 }, text: 'First thing' });
    await add(owner, { action: 'add', kind: 'event', date, owners: [OWNER], text: 'Dentist', start: 540, length: 60 });
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', edit(title)).click();
      await field(page, `Edit task: ${title}`).fill(`${title} 2`);
      await page.getByRole('button', { name: `Priority 1: First thing, ${OWNER_NAME}`, exact: true }).click();
      await expect(field(page, 'Edit priority 1: First thing')).toBeFocused();
      await expect(editing(page)).toHaveCount(1);
      await field(page, 'Edit priority 1: First thing').fill('First thing, again');
      await page.getByRole('button', { name: `Dentist, 9a to 10a, ${OWNER_NAME}`, exact: true }).click();
      await expect(field(page, 'Edit entry: Dentist')).toBeFocused();
      await expect(editing(page)).toHaveCount(1);
      // An empty new priority in another cell, then the to-do: the empty one is dropped without a write.
      await page.getByRole('button', { name: `Add priority 2 for ${OWNER_NAME}`, exact: true }).click();
      await expect(field(page, `New priority 2 for ${OWNER_NAME}`)).toBeFocused();
      await page.getByRole('button', edit(`${title} 2`)).click();
      await expect(field(page, `Edit task: ${title} 2`)).toBeFocused();
      await expect(editing(page)).toHaveCount(1);
      expect(posts.map(p => [p.kind, p.title ?? p.text])).toEqual([['todo', `${title} 2`], ['priority', 'First thing, again']]);
      await noWindow(page);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a priority and an entry have no day field (they belong to the day); a to-do has, and a new day moves it there', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(704), later = farDate(706), title = unique('Move');
    const id = await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title });
    await add(owner, { action: 'add', kind: 'priority', date, owners: [OWNER], slots: { [OWNER]: 1 }, text: 'First thing' });
    await add(owner, { action: 'add', kind: 'event', date, owners: [OWNER], text: 'Dentist', start: 540, length: 60 });
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', { name: `Priority 1: First thing, ${OWNER_NAME}`, exact: true }).click();
      await expect(field(page, 'Edit priority 1: First thing')).toBeFocused();
      await expect(page.locator('[data-editing] input[type=date]')).toHaveCount(0);
      await page.getByRole('button', { name: `Dentist, 9a to 10a, ${OWNER_NAME}`, exact: true }).click();
      await expect(field(page, 'Edit entry: Dentist')).toBeFocused();
      await expect(page.locator('[data-editing] input[type=date]')).toHaveCount(0);
      await page.getByRole('button', edit(title)).click();
      const day = page.locator('.day-task.day-editing input[type=date]');
      await expect(day).toHaveValue(date);
      await day.fill(later);
      await field(page, `Edit task: ${title}`).press('Enter');
      await expect(page.getByRole('button', edit(title))).toHaveCount(0);
      expect((await owner.snapshot()).tasks.find((t: { id: string }) => t.id === id)).toMatchObject({ date: later, title, owners: [OWNER], revision: 2 });
      await openDay(page, later);
      await expect(page.getByRole('button', edit(title))).toBeVisible();
    } finally { await clearDay(owner, date); await clearDay(owner, later); await owner.dispose(); }
  });

  test('the field has a name, the failure is spoken, and the keyboard returns to the right button: a stored priority and entry, and the blank cell after Escape on a new one', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(705);
    await add(owner, { action: 'add', kind: 'priority', date, owners: [OWNER], slots: { [OWNER]: 1 }, text: 'First thing' });
    await add(owner, { action: 'add', kind: 'event', date, owners: [OWNER], text: 'Dentist', start: 540, length: 60 });
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', { name: `Priority 1: First thing, ${OWNER_NAME}`, exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Edit priority 1: First thing', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: `Priority 1: First thing, ${OWNER_NAME}`, exact: true })).toBeFocused();
      await page.getByRole('button', { name: `Dentist, 9a to 10a, ${OWNER_NAME}`, exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Edit entry: Dentist', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: `Dentist, 9a to 10a, ${OWNER_NAME}`, exact: true })).toBeFocused();
      // A new priority: Escape puts the keyboard on the blank cell it was made in; text and Enter put it on the new cell.
      await page.getByRole('button', { name: `Add priority 2 for ${OWNER_NAME}`, exact: true }).click();
      await expect(page.getByRole('textbox', { name: `New priority 2 for ${OWNER_NAME}`, exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: `Add priority 2 for ${OWNER_NAME}`, exact: true })).toBeFocused();
      await page.getByRole('button', { name: `Add priority 2 for ${OWNER_NAME}`, exact: true }).click();
      await field(page, `New priority 2 for ${OWNER_NAME}`).fill('Second thing');
      await field(page, `New priority 2 for ${OWNER_NAME}`).press('Enter');
      await expect(page.getByRole('button', { name: `Priority 2: Second thing, ${OWNER_NAME}`, exact: true })).toBeFocused();
      // A refusal is announced (and shown in the banner), and the typed text is kept.
      await page.getByRole('button', { name: `Priority 2: Second thing, ${OWNER_NAME}`, exact: true }).click();
      await field(page, 'Edit priority 2: Second thing').fill('x'.repeat(19));
      await field(page, 'Edit priority 2: Second thing').press('Enter');
      await expect(page.locator('.day-cell.day-editing .ip-error')).toHaveText('Keep it to 18 characters.');
      await expect(field(page, 'Edit priority 2: Second thing')).toHaveValue('x'.repeat(19));
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a stale save of a to-do keeps what was typed and says so in the row and the banner; Escape shows what is true; Enter again saves over it', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER), date = farDate(707), title = unique('Stale');
    const id = await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title });
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', edit(title)).click();
      const input = field(page, `Edit task: ${title}`);
      await input.fill('Mine, first try');
      expect((await partner.post({ action: 'edit', kind: 'todo', id, revision: 1, date, owners: [OWNER], title: 'Hers' })).status()).toBe(200);
      await input.press('Enter');
      await expect(page.locator('.day-task.day-editing .ip-error')).toContainText('changed on another device');
      await expect(page.locator('.day-task.day-editing .ip-error')).toContainText('Escape keeps theirs');
      await expect(page.getByRole('alert')).toContainText('changed on another device');
      await expect(page.locator('#live')).toContainText('changed on another device');
      await expect(input).toHaveValue('Mine, first try');
      expect(await todoTitle(owner, date, 'Hers')).toMatchObject({ revision: 2 });
      // Theirs: Escape, and the row shows what is stored.
      await input.press('Escape');
      await expect(page.getByRole('button', edit('Hers'))).toBeVisible();
      // Mine over theirs: a second Enter after the message.
      await page.getByRole('button', edit('Hers')).click();
      await field(page, 'Edit task: Hers').fill('Mine, second try');
      expect((await partner.post({ action: 'edit', kind: 'todo', id, revision: 2, date, owners: [OWNER], title: 'Hers again' })).status()).toBe(200);
      await field(page, 'Edit task: Hers').press('Enter');
      await expect(page.locator('.day-task.day-editing .ip-error')).toContainText('changed on another device');
      await field(page, 'Edit task: Hers').press('Enter');
      await expect(editing(page)).toHaveCount(0);
      expect(await todoTitle(owner, date, 'Mine, second try')).toMatchObject({ revision: 4, owners: [OWNER] });
    } finally { await clearDay(owner, date); await owner.dispose(); await partner.dispose(); }
  });

  test('a record deleted by the other person while it is being edited: the row goes, with a message, and nothing is written', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER), date = farDate(708), title = unique('Gone');
    const id = await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title });
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', edit(title)).click();
      await field(page, `Edit task: ${title}`).fill('Typed for nothing');
      expect((await partner.post({ action: 'delete', id, revision: 1, confirm: true })).status()).toBe(200);
      await field(page, `Edit task: ${title}`).press('Enter');
      await expect(editing(page)).toHaveCount(0);
      await expect(page.getByRole('alert')).toBeVisible();
      await expect(page.locator('.day-task')).toHaveCount(0);
      expect(posts.map(p => p.action)).toEqual(['edit']);
    } finally { await clearDay(owner, date); await owner.dispose(); await partner.dispose(); }
  });

  test('a new priority and a new entry whose reply is lost keep their text, and the retry is the same add; after it succeeds the next one has a new id', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(709);
    const posts: Array<Record<string, unknown>> = [];
    let lose = true;
    try {
      await login(page); await openDay(page, date);
      await page.route(url => url.pathname.endsWith('/api.php'), route => {
        const request = route.request();
        if (request.method() !== 'POST') { return route.continue(); }
        const body = request.postDataJSON();
        if (body.action === 'add') { posts.push({ kind: body.kind, id: body.id }); }
        return lose && body.action === 'add' ? route.abort('failed') : route.continue();
      });
      await page.getByRole('button', { name: `Add priority 1 for ${OWNER_NAME}`, exact: true }).click();
      await field(page, `New priority 1 for ${OWNER_NAME}`).fill('Might have saved');
      await field(page, `New priority 1 for ${OWNER_NAME}`).press('Enter');
      await expect(page.getByRole('alert')).toContainText('may have saved');
      await expect(page.locator('.day-cell.day-editing .ip-error')).toContainText('may have saved');
      await expect(field(page, `New priority 1 for ${OWNER_NAME}`)).toHaveValue('Might have saved');
      await field(page, `New priority 1 for ${OWNER_NAME}`).press('Enter');
      await expect.poll(() => posts.length).toBe(2);
      expect(posts[1]).toEqual(posts[0]);
      // The retry has been answered (a field is read-only while its write is out) before the next try.
      await expect(page.locator('.day-cell.day-editing')).not.toHaveAttribute('data-saving', '');
      lose = false;
      await field(page, `New priority 1 for ${OWNER_NAME}`).press('Enter');
      await expect(page.getByRole('button', { name: `Priority 1: Might have saved, ${OWNER_NAME}`, exact: true })).toBeVisible();
      expect(posts).toHaveLength(3);
      expect(posts[2]).toEqual(posts[0]);
      // The same for an entry (and a different id after a success).
      await page.getByRole('button', { name: `Add to ${OWNER_NAME} at 9a`, exact: true }).click({ position: { x: 20, y: 5 } });
      await field(page, 'New entry').fill('Dentist');
      await field(page, 'New entry').press('Enter');
      await expect(page.getByRole('button', { name: new RegExp(String.raw`^Dentist, 9a to 9:30a, ${OWNER_NAME}$`) })).toBeVisible();
      expect(posts[3]).toMatchObject({ kind: 'event' });
      expect(posts[3].id).not.toBe(posts[0].id);
      expect((await owner.snapshot()).priorities.filter((p: { date: string }) => p.date === date)).toHaveLength(1);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a poll never redraws under a row being edited, and shows what changed once the row is left', async ({ page, baseURL }) => {
    await page.clock.install();
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER), date = farDate(710), title = unique('Held'), later = unique('Hers');
    await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title });
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', edit(title)).click();
      const input = field(page, `Edit task: ${title}`);
      await input.fill('Half typed');
      await add(partner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title: later });
      const polled = page.waitForResponse(response => response.url().includes('api.php?since='));
      await page.clock.runFor(13000);
      await polled;
      await expect(input).toBeFocused();
      await expect(input).toHaveValue('Half typed');
      await expect(page.getByRole('button', edit(later))).toHaveCount(0);
      await input.press('Escape');
      await expect(page.getByRole('button', edit(later))).toBeVisible();
      await expect(page.getByRole('button', edit(title))).toBeVisible();
    } finally { await clearDay(owner, date); await owner.dispose(); await partner.dispose(); }
  });

  test('a redraw of the page while the keyboard is on one of the row\'s buttons keeps the row open with its text and its focus, and writes nothing', async ({ page, baseURL }) => {
    await page.clock.install();
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER), date = farDate(713), title = unique('Kept'), later = unique('Theirs');
    await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title });
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', edit(title)).click();
      const input = field(page, `Edit task: ${title}`);
      await input.fill('Typed, not saved');
      // The trash button is not a text field, so the page may be drawn again under it.
      const trash = page.locator('.day-task.day-editing .ip-del');
      await trash.focus();
      await add(partner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title: later });
      const polled = page.waitForResponse(response => response.url().includes('api.php?since='));
      await page.clock.runFor(13000);
      await polled;
      await expect(page.getByRole('button', edit(later))).toBeVisible();
      await expect(editing(page)).toHaveCount(1);
      await expect(input).toHaveValue('Typed, not saved');
      await expect(trash).toBeFocused();
      expect(posts).toHaveLength(0);
    } finally { await clearDay(owner, date); await owner.dispose(); await partner.dispose(); }
  });

  test('a day change with an edit that cannot be saved yet puts it away; it is there again when the item is opened', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(711), title = unique('Away');
    await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title });
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', edit(title)).click();
      await field(page, `Edit task: ${title}`).fill('z'.repeat(40));
      await leaveField(page);
      await expect(page.locator('.day-task.day-editing .ip-error')).toHaveText('Keep it to 36 characters.');
      await page.getByRole('button', { name: 'Next day', exact: true }).click();
      await expect(editing(page)).toHaveCount(0);
      await page.getByRole('button', { name: 'Previous day', exact: true }).click();
      await expect(editing(page)).toHaveCount(0);
      await page.getByRole('button', edit(title)).click();
      await expect(field(page, `Edit task: ${title}`)).toHaveValue('z'.repeat(40));
      expect(posts).toHaveLength(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});

test.describe('editing in place: leaving for a text field, restored drafts, where a moved to-do leaves the keyboard', () => {
  test('a row left untouched, or an empty new one, for the add box or a note is plain text at once: no dead field stays on the page', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(716), title = unique('Untouched');
    await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title });
    await add(owner, { action: 'add', kind: 'priority', date, owners: [OWNER], slots: { [OWNER]: 1 }, text: 'First thing' });
    await add(owner, { action: 'add', kind: 'event', date, owners: [OWNER], text: 'Dentist', start: 540, length: 60 });
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      const box = page.getByLabel('New task', { exact: true }), notes = page.getByLabel(`Notes for ${OWNER_NAME}`, { exact: true });
      // The focus reaches the add box with focus(): a click on the empty box is a click on a blank line, which opens a new to-do in place (todo-thirds.spec.ts).
      // Nothing changed in the row: the focus going to the add box closes it as plain text, with no write and no field left to type into.
      await page.getByRole('button', edit(title)).click();
      await expect(field(page, `Edit task: ${title}`)).toBeFocused();
      await box.focus();
      await expect(editing(page)).toHaveCount(0);
      await expect(page.getByRole('button', edit(title))).toBeVisible();
      await page.getByRole('button', { name: `Priority 1: First thing, ${OWNER_NAME}`, exact: true }).click();
      await expect(field(page, 'Edit priority 1: First thing')).toBeFocused();
      await notes.click();
      await expect(editing(page)).toHaveCount(0);
      await expect(page.getByRole('button', { name: `Priority 1: First thing, ${OWNER_NAME}`, exact: true })).toBeVisible();
      await page.getByRole('button', { name: `Dentist, 9a to 10a, ${OWNER_NAME}`, exact: true }).click();
      await expect(field(page, 'Edit entry: Dentist')).toBeFocused();
      await box.focus();
      await expect(editing(page)).toHaveCount(0);
      await expect(page.locator('.day-handle')).toHaveCount(0);
      // An empty new item (a blank priority cell, a blank slot of the schedule) is dropped the same way, its handles with it.
      await page.getByRole('button', { name: `Add priority 2 for ${OWNER_NAME}`, exact: true }).click();
      await expect(field(page, `New priority 2 for ${OWNER_NAME}`)).toBeFocused();
      await box.focus();
      await expect(editing(page)).toHaveCount(0);
      await expect(page.getByRole('button', { name: `Add priority 2 for ${OWNER_NAME}`, exact: true })).toBeVisible();
      await page.getByRole('button', { name: `Add to ${OWNER_NAME} at 1p`, exact: true }).click({ position: { x: 10, y: 4 } });
      await expect(field(page, 'New entry')).toBeFocused();
      await expect(page.locator('.day-ev.day-editing .day-handle')).toHaveCount(2);
      await notes.click();
      await expect(editing(page)).toHaveCount(0);
      await expect(page.locator('.day-handle')).toHaveCount(0);
      expect(posts).toHaveLength(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a draft that comes back after a refused save says so in the row, for a to-do and a priority too, and typing takes the notice away', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER), date = farDate(717), title = unique('Back');
    const todoId = await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title });
    const priorityId = await add(owner, { action: 'add', kind: 'priority', date, owners: [OWNER], slots: { [OWNER]: 1 }, text: 'First thing' });
    try {
      await login(page); await openDay(page, date);
      // The other person changes both after this page read them, so each save from here is stale and is refused: the text typed is put away.
      expect((await partner.post({ action: 'edit', kind: 'todo', id: todoId, revision: 1, date, owners: [OWNER], title: `${PARTNER_NAME} changed the to-do` })).status()).toBe(200);
      expect((await partner.post({ action: 'edit', kind: 'priority', id: priorityId, revision: 1, date, owners: [OWNER], slots: { [OWNER]: 1 }, text: `${PARTNER_NAME} line` })).status()).toBe(200);
      await page.getByRole('button', edit(title)).click();
      await field(page, `Edit task: ${title}`).fill('My changed title');
      await page.getByRole('button', { name: 'Next day', exact: true }).click();
      await expect(page.getByRole('alert')).toBeVisible();
      await page.getByRole('button', { name: 'Previous day', exact: true }).click();
      await page.getByRole('button', edit(`${PARTNER_NAME} changed the to-do`)).click();
      await expect(field(page, `Edit task: ${PARTNER_NAME} changed the to-do`)).toHaveValue('My changed title');
      await expect(page.locator('.day-task.day-editing .ip-error')).toHaveText('Your unsaved changes are back.');
      await page.keyboard.type('!');
      await expect(page.locator('.day-task.day-editing .ip-error')).toHaveText('');
      await field(page, `Edit task: ${PARTNER_NAME} changed the to-do`).press('Escape');
      await page.getByRole('button', { name: `Priority 1: ${PARTNER_NAME} line, ${OWNER_NAME}`, exact: true }).click();
      await expect(field(page, `Edit priority 1: ${PARTNER_NAME} line`)).toBeFocused();
      await page.keyboard.type(' mine');
      expect((await partner.post({ action: 'edit', kind: 'priority', id: priorityId, revision: 2, date, owners: [OWNER], slots: { [OWNER]: 1 }, text: `${PARTNER_NAME} again` })).status()).toBe(200);
      await page.getByRole('button', { name: 'Next day', exact: true }).click();
      await expect(page.getByRole('alert')).toBeVisible();
      await page.getByRole('button', { name: 'Previous day', exact: true }).click();
      await page.getByRole('button', { name: `Priority 1: ${PARTNER_NAME} again, ${OWNER_NAME}`, exact: true }).click();
      await expect(field(page, `Edit priority 1: ${PARTNER_NAME} again`)).toHaveValue(`${PARTNER_NAME} line mine`);
      await expect(page.locator('.day-cell.day-editing .ip-error')).toHaveText('Your unsaved changes are back.');
    } finally { await clearDay(owner, date); await owner.dispose(); await partner.dispose(); }
  });

  test('a to-do given another day leaves the list: the keyboard goes to the add field and a screen reader is told where it went', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(718), other = farDate(719), title = unique('Moving');
    await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title });
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', edit(title)).click();
      await page.locator('.day-task.day-editing .ip-date').fill(other);
      await field(page, `Edit task: ${title}`).press('Enter');
      await expect(page.getByRole('button', edit(title))).toHaveCount(0);
      await expect(page.getByLabel('New task', { exact: true })).toBeFocused();
      await expect(page.locator('#live')).toContainText('Saved. Moved to ');
      expect((await todoTitle(owner, other, title)).date).toBe(other);
    } finally { await clearDay(owner, date); await clearDay(owner, other); await owner.dispose(); }
  });
});

