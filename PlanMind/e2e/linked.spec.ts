import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { addTodo, apiLogin, browserStorage, draftSpan, farDate, field, leaveField, login, noWindow, todo, unique, type Api, type User } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// Linked ("Both") entries seen from two real browsers at once: the owner's and the partner's. A linked to-do, schedule entry or
// priority is ONE record with two owners, so what either person does to it is what the other person sees after the
// next poll. Each browser runs on a fake clock, so a poll is run on purpose (no real 12-second waits) and nothing
// races. Desktop project; the phone layouts of the same entries are in the phone specs.
const POLL = 13000;
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

/** Both people signed in, each in a browser of their own, on the same day. */
async function twoPeople(browser: Browser, baseURL: string, date: string) {
  const open = async (user: User) => {
    const context = await browser.newContext({ baseURL, viewport: { width: 1360, height: 900 } });
    const page = await context.newPage();
    await page.clock.install();
    await login(page, user);
    await openDay(page, date);
    return page;
  };
  const [owner, partner] = [await open(OWNER), await open(PARTNER)];
  return { owner, partner, close: () => Promise.all([owner.context().close(), partner.context().close()]) };
}
/** Runs one poll on this browser's clock and waits until the answer is in, without touching the focus. */
async function pollHere(page: Page) {
  const answered = page.waitForResponse(response => response.url().includes('api.php?since='));
  await page.clock.runFor(POLL);
  await answered;
}
/** A poll never redraws under a focused field (the add box keeps the focus after Add), so the focus is taken out of any
 *  field first, as a person's click away does. */
async function poll(page: Page) {
  await leaveField(page);
  await pollHere(page);
}
/** The picker selection is a saved preference; every test leaves both people on Both. */
async function backToBoth(baseURL: string) {
  for (const user of [OWNER, PARTNER] as const) {
    const api = await apiLogin(baseURL, user);
    await api.post({ action: 'savePrefs', selection: { base: 'both', overlays: [] } });
    await api.dispose();
  }
}

/** The shell's banner: a refused save of an entry being edited is said here (nothing hangs over the schedule beside the block). */
const banner = (page: Page) => page.locator('#error');
/** A mouse swipe to the left on an entry that is not being edited: its Delete shows at the right end of the block. */
async function swipeLeft(page: Page, entry: Locator) {
  const box = (await entry.boundingBox())!, x = box.x + box.width - 14, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) { await page.mouse.move(x - (80 * i) / 12, y); }
  await page.mouse.up();
}
const taskRow = (page: Page, title: string) => page.locator('.day-task', { has: page.getByRole('button', { name: `Edit ${title}`, exact: true }) });
const pickList = async (page: Page, name: string) => {
  await page.getByRole('button', { name: /^Lists: / }).click();
  await page.getByRole('group', { name: 'Lists', exact: true }).getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('button', { name: `Lists: ${name}`, exact: true })).toBeVisible();
};
const gridWidth = async (page: Page) => (await page.locator('.day-lanes').boundingBox())!.width;

test.describe('Linked entries across two browsers', () => {
  test(`a to-do for Both is one record: ${PARTNER_NAME} completes it, a stale save is refused, an edit keeps both owners, deleting removes it for both`, async ({ browser, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(500);
    const people = await twoPeople(browser, baseURL!, date);
    const title = unique('Linked'), renamed = unique('Renamed');
    const stored = async () => (await owner.snapshot()).tasks.filter((t: { date: string }) => t.date === date);
    const edit = (page: Page, name: string) => page.getByRole('button', { name: `Edit ${name}`, exact: true });
    try {
      // The owner adds it under the Both view of the top picker (there is no For control): one record owned by both lists.
      await addTodo(people.owner, title);
      await expect(taskRow(people.owner, title).locator('.day-circle')).toHaveAttribute('data-c', 'purple');
      expect(await stored()).toMatchObject([{ title, owners: [OWNER, PARTNER], done: false, revision: 1 }]);
      await poll(people.partner);
      await expect(taskRow(people.partner, title).locator('.day-circle')).toHaveAttribute('data-c', 'purple');
      await expect(taskRow(people.partner, title).locator('.day-who')).toHaveText('Both');

      // The partner completes it. There is still one record, and the owner sees it done after his next poll.
      await people.partner.getByRole('checkbox', { name: `Complete ${title}`, exact: true }).click();
      await expect(people.partner.getByRole('checkbox', { name: `Reopen ${title}`, exact: true })).toBeChecked();
      expect(await stored()).toMatchObject([{ title, owners: [OWNER, PARTNER], done: true, revision: 2 }]);
      await poll(people.owner);
      await expect(people.owner.getByRole('checkbox', { name: `Reopen ${title}`, exact: true })).toBeChecked();
      await people.owner.getByRole('checkbox', { name: `Reopen ${title}`, exact: true }).click();
      await expect(people.owner.getByRole('checkbox', { name: `Complete ${title}`, exact: true })).not.toBeChecked();
      await poll(people.partner);
      await expect(people.partner.getByRole('checkbox', { name: `Complete ${title}`, exact: true })).not.toBeChecked();
      expect(await stored()).toMatchObject([{ done: false, revision: 3 }]);

      // The partner edits it in its row; the owner renames the entry first. Her Enter is a stale write: refused, with her text kept in the row and the
      // message in the row and in the banner. Escape gives hers up, and the row shows what is true.
      await edit(people.partner, title).click();
      const neverSaved = unique('Never saved');
      await field(people.partner, `Edit task: ${title}`).fill(neverSaved);
      await edit(people.owner, title).click();
      await field(people.owner, `Edit task: ${title}`).fill(renamed);
      await field(people.owner, `Edit task: ${title}`).press('Enter');
      await expect(field(people.owner, `Edit task: ${title}`)).toHaveCount(0);
      await field(people.partner, `Edit task: ${title}`).press('Enter');
      await expect(people.partner.locator('.day-task.day-editing .ip-error')).toContainText('another device');
      await expect(people.partner.getByRole('alert')).toContainText('another device');
      await expect(field(people.partner, `Edit task: ${title}`)).toHaveValue(neverSaved);
      expect(await stored()).toMatchObject([{ title: renamed, owners: [OWNER, PARTNER], revision: 4 }]);
      await field(people.partner, `Edit task: ${title}`).press('Escape');
      await expect(edit(people.partner, renamed)).toBeVisible();
      expect(await stored()).toMatchObject([{ title: renamed, owners: [OWNER, PARTNER], revision: 4 }]);

      // The owner edits it again: an edit changes the words and never the owners, so it is still one record for both, and it shows
      // in each person's own list view as well as in Both.
      await edit(people.owner, renamed).click();
      await expect(people.owner.getByRole('radiogroup')).toHaveCount(0);
      await field(people.owner, `Edit task: ${renamed}`).fill(`${renamed} again`);
      await field(people.owner, `Edit task: ${renamed}`).press('Enter');
      await expect(field(people.owner, `Edit task: ${renamed}`)).toHaveCount(0);
      expect(await stored()).toMatchObject([{ title: `${renamed} again`, owners: [OWNER, PARTNER], revision: 5 }]);
      await poll(people.partner);
      await pickList(people.partner, PARTNER_NAME);
      await expect(edit(people.partner, `${renamed} again`)).toBeVisible();
      await expect(taskRow(people.partner, `${renamed} again`).locator('.day-circle')).toHaveAttribute('data-c', 'purple');
      await pickList(people.partner, 'Both');

      // The partner deletes it (two presses); the owner's row goes after his poll and the record is gone.
      await edit(people.partner, `${renamed} again`).click();
      await people.partner.getByRole('button', { name: `Delete task: ${renamed} again`, exact: true }).click();
      // The first press says who it is for, in the row; the same place now says Confirm delete.
      await expect(people.partner.locator('.day-task.day-editing .ip-error')).toHaveText('Deletes it for both of us.');
      await people.partner.getByRole('button', { name: 'Confirm delete', exact: true }).click();
      await expect(edit(people.partner, `${renamed} again`)).toHaveCount(0);
      expect(await stored()).toEqual([]);
      await poll(people.owner);
      await expect(edit(people.owner, `${renamed} again`)).toHaveCount(0);
      for (const page of [people.owner, people.partner]) { expect(await browserStorage(page)).toEqual({ local: 0, session: 0, indexedDB: 0, caches: 0 }); await noWindow(page); }
    } finally { await people.close(); await clearDay(owner, date); await backToBoth(baseURL!); await owner.dispose(); }
  });

  test(`a schedule entry for Both spans both lanes for each person; one edit moves it for both; it holds ${PARTNER_NAME}'s lane too, so her own entry cannot take its time`, async ({ browser, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(501);
    const people = await twoPeople(browser, baseURL!, date);
    const stored = async () => (await owner.snapshot()).events.filter((e: { date: string }) => e.date === date);
    const cell = (page: Page, label: string) => page.getByRole('button', { name: label, exact: true });
    try {
      // Under the Both view the Add button makes an entry for both of us (a tap on a lane would make one for that lane alone,
      // and there is no For control). 9:00 for half an hour is its default span; Alt+Shift+Down lengthens it to an hour, and Alt+Down moves it, a quarter hour a press, to 11a.
      await people.owner.getByRole('button', { name: 'Add schedule entry', exact: true }).focus();
      await people.owner.keyboard.press('Enter');
      await field(people.owner, 'New entry').fill('Lunch together');
      expect(await draftSpan(people.owner)).toEqual({ start: 540, length: 30 });
      for (let i = 0; i < 2; i++) { await field(people.owner, 'New entry').press('Alt+Shift+ArrowDown'); }
      expect(await draftSpan(people.owner)).toEqual({ start: 540, length: 60 });
      for (let i = 0; i < 8; i++) { await field(people.owner, 'New entry').press('Alt+ArrowDown'); }
      expect(await draftSpan(people.owner)).toEqual({ start: 660, length: 60 });
      // The field stops at the same 500 characters for an entry across both lanes as for one in a lane (the server's bound; no
      // shorter limit is shown for a linked entry), and no strip hangs over the schedule.
      await expect(field(people.owner, 'New entry')).toHaveAttribute('maxlength', '500');
      await expect(people.owner.locator('.day-ev-strip, .day-ev .ip-hint')).toHaveCount(0);
      // The new entry is one purple block over both lanes while it is a draft.
      expect((await people.owner.locator('.day-ev.day-editing').boundingBox())!.width).toBeGreaterThan((await gridWidth(people.owner)) * 0.9);
      await field(people.owner, 'New entry').press('Enter');
      await expect(people.owner.locator('.day-ev.day-editing')).toHaveCount(0);
      expect(await stored()).toMatchObject([{ text: 'Lunch together', owners: [OWNER, PARTNER], start: 660, length: 60, revision: 1 }]);
      await expect(cell(people.owner, 'Lunch together, 11a to 12p, Both')).toHaveAttribute('data-c', 'purple');
      expect((await cell(people.owner, 'Lunch together, 11a to 12p, Both').boundingBox())!.width).toBeGreaterThan((await gridWidth(people.owner)) * 0.9);

      // The partner sees it across her two lanes too, her own lane on the left.
      await poll(people.partner);
      await expect(people.partner.locator('.day-sched .day-lane')).toHaveText([`${PARTNER_NAME} · you`, OWNER_NAME]);
      await expect(cell(people.partner, 'Lunch together, 11a to 12p, Both')).toHaveAttribute('data-c', 'purple');
      expect((await cell(people.partner, 'Lunch together, 11a to 12p, Both').boundingBox())!.width).toBeGreaterThan((await gridWidth(people.partner)) * 0.9);

      // The partner makes it an hour and a half: one edit, one write, and the owner sees the new length after his poll.
      await cell(people.partner, 'Lunch together, 11a to 12p, Both').click();
      await field(people.partner, 'Edit entry: Lunch together').press('Alt+Shift+ArrowDown');
      await field(people.partner, 'Edit entry: Lunch together').press('Alt+Shift+ArrowDown');
      expect(await draftSpan(people.partner)).toEqual({ start: 660, length: 90 });
      await field(people.partner, 'Edit entry: Lunch together').press('Enter');
      await expect(people.partner.locator('.day-ev.day-editing')).toHaveCount(0);
      expect(await stored()).toMatchObject([{ owners: [OWNER, PARTNER], start: 660, length: 90, revision: 2 }]);
      await poll(people.owner);
      await expect(cell(people.owner, 'Lunch together, 11a to 12:30p, Both')).toBeVisible();

      // Editing has no For control: a linked entry stays linked, and it holds the partner's lane as well as the owner's.
      await cell(people.owner, 'Lunch together, 11a to 12:30p, Both').click();
      await expect(field(people.owner, 'Edit entry: Lunch together')).toBeFocused();
      await expect(people.owner.getByRole('radiogroup')).toHaveCount(0);
      await people.owner.keyboard.press('Escape');
      await expect(people.owner.locator('.day-ev.day-editing')).toHaveCount(0);
      await poll(people.partner);
      // The partner's own new entry cannot take its time: Enter does not write it, and the banner says why (nothing is said while she types).
      await people.partner.getByRole('button', { name: `Add to ${PARTNER_NAME} at 8a`, exact: true }).click({ position: { x: 20, y: 4 } });
      await field(people.partner, 'New entry').fill('Dent');
      expect(await draftSpan(people.partner)).toEqual({ start: 480, length: 30 });
      // An hour long, so that a linked entry moved to 8:30a lies under its second half.
      for (let i = 0; i < 2; i++) { await field(people.partner, 'New entry').press('Alt+Shift+ArrowDown'); }
      expect(await draftSpan(people.partner)).toEqual({ start: 480, length: 60 });
      await expect(field(people.partner, 'New entry')).toHaveAttribute('maxlength', '500');
      await expect(banner(people.partner)).toBeHidden();
      // A draft cannot be stepped or dragged into a neighbour, so the overlap comes the other way: the owner's device moves the linked
      // entry to 8:30a, under the draft. The partner's page polls (her field keeps the focus) and the next word she types makes the draft overlap.
      const lunch = (await stored())[0];
      expect((await owner.post({ action: 'edit', kind: 'event', id: lunch.id, revision: lunch.revision, date, owners: lunch.owners, text: lunch.text, start: 510, length: 90 })).status()).toBe(200);
      await pollHere(people.partner);
      await field(people.partner, 'New entry').pressSequentially('ist');
      // No live message while typing: the overlap is said when the save is attempted and refused, once, in the banner.
      await expect(banner(people.partner)).toBeHidden();
      await field(people.partner, 'New entry').press('Enter');
      await expect(people.partner.locator('#error-message')).toHaveText('Overlaps “Lunch together” (8:30a – 10a).');
      await expect(people.partner.getByRole('alert')).toContainText('Overlaps');
      await expect(people.partner.locator('.day-ev.day-editing')).toHaveCount(1);
      await expect(people.partner.locator('.day-ev .ip-error')).toHaveCount(0);
      await people.partner.keyboard.press('Escape');
      await expect(people.partner.locator('.day-ev.day-editing')).toHaveCount(0);
      expect(await stored()).toMatchObject([{ text: 'Lunch together', start: 510, length: 90 }]);

      // The owner deletes the linked entry with a swipe and a tap (the Delete says who it is for); it goes from both lanes and both people.
      await poll(people.owner);
      await swipeLeft(people.owner, cell(people.owner, 'Lunch together, 8:30a to 10a, Both'));
      const del = people.owner.getByRole('button', { name: 'Delete Lunch together, for both of us', exact: true });
      await expect(del).toHaveCount(1);
      await expect(people.owner.locator('.day-ev.day-editing')).toHaveCount(0);
      expect(await stored()).toHaveLength(1);
      await del.click();
      await expect(people.owner.locator('.day-ev')).toHaveCount(0);
      expect(await stored()).toEqual([]);
      await poll(people.partner);
      await expect(people.partner.locator('.day-sched .day-ev')).toHaveCount(0);
    } finally { await people.close(); await clearDay(owner, date); await backToBoth(baseURL!); await owner.dispose(); }
  });

  test('a Both priority: each person moves their own line and the other keeps theirs; the two halves are purple; a text edit and a delete reach both', async ({ browser, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(502);
    const people = await twoPeople(browser, baseURL!, date);
    const stored = async () => (await owner.snapshot()).priorities.filter((p: { date: string }) => p.date === date);
    const cell = (page: Page, label: string) => page.getByRole('button', { name: label, exact: true });
    try {
      // Line 2 for Both is free in both lists, so it is one entry across both lanes. (A lane tap makes a priority for that lane
      // alone and there is no For control, so this one comes from the API.)
      const id = crypto.randomUUID();
      expect((await owner.post({ action: 'add', kind: 'priority', id, date, owners: [OWNER, PARTNER], slots: { [PARTNER]: 2, [OWNER]: 2 }, text: 'Family dinner' })).status()).toBe(200);
      expect(await stored()).toMatchObject([{ text: 'Family dinner', owners: [OWNER, PARTNER], slots: { [PARTNER]: 2, [OWNER]: 2 }, revision: 1 }]);
      await poll(people.owner);
      await poll(people.partner);
      const whole = cell(people.partner, 'Priority 2: Family dinner, Both');
      await expect(whole).toHaveCount(1);
      await expect(whole).toHaveAttribute('data-c', 'purple');
      expect((await whole.boundingBox())!.width).toBeGreaterThan((await people.partner.locator('.day-prio .day-pcells').first().boundingBox())!.width - 6);

      // The partner moves it down in her list only. The owner keeps line 2, so the entry is now two purple half cells for him.
      await whole.click();
      await people.partner.getByRole('button', { name: 'Move down', exact: true }).click();
      await expect(field(people.partner, 'Edit priority 3: Family dinner')).toBeFocused();
      await people.partner.keyboard.press('Escape');
      await expect(people.partner.locator('.day-cell.day-editing')).toHaveCount(0);
      expect(await stored()).toMatchObject([{ owners: [OWNER, PARTNER], slots: { [PARTNER]: 3, [OWNER]: 2 }, revision: 2 }]);
      await poll(people.owner);
      await expect(people.owner.locator('.day-cell[data-c=purple]')).toHaveCount(2);
      const [mine, hers] = [cell(people.owner, 'Priority 2: Family dinner, Both'), cell(people.owner, 'Priority 3: Family dinner, Both')];
      await expect(mine).toHaveAttribute('data-lane', '0');
      await expect(hers).toHaveAttribute('data-lane', '1');
      expect((await mine.boundingBox())!.width).toBeLessThan((await gridWidth(people.owner)) * 0.55);

      // The owner rewrites the text: the lines stay where each person put them, and the partner reads the new text.
      await mine.click();
      await field(people.owner, 'Edit priority 2: Family dinner').fill('Dinner at six');
      await field(people.owner, 'Edit priority 2: Family dinner').press('Enter');
      await expect(people.owner.locator('.day-cell.day-editing')).toHaveCount(0);
      expect(await stored()).toMatchObject([{ text: 'Dinner at six', slots: { [PARTNER]: 3, [OWNER]: 2 }, revision: 3 }]);
      await poll(people.partner);
      await expect(cell(people.partner, 'Priority 3: Dinner at six, Both')).toHaveAttribute('data-c', 'purple');

      // Clearing it asks "for both of us" and removes the one record from both lists.
      await cell(people.owner, 'Priority 2: Dinner at six, Both').click();
      await people.owner.getByRole('button', { name: 'Delete priority: Dinner at six', exact: true }).click();
      await expect(people.owner.locator('.day-cell.day-editing .ip-error')).toHaveText('Deletes it for both of us.');
      await people.owner.getByRole('button', { name: 'Confirm delete', exact: true }).click();
      await expect(people.owner.locator('.day-cell.day-editing')).toHaveCount(0);
      expect(await stored()).toEqual([]);
      await poll(people.partner);
      await expect(people.partner.locator('.day-cell:not(.day-blank)')).toHaveCount(0);
    } finally { await people.close(); await clearDay(owner, date); await backToBoth(baseURL!); await owner.dispose(); }
  });

  test('a poll that brings the other person\'s change redraws the list but leaves the keyboard focus on the control it was on', async ({ browser, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER), date = farDate(520);
    const people = await twoPeople(browser, baseURL!, date);
    const mine = unique('Mine'), first = unique('Theirs'), second = unique('Later');
    const edit = people.owner.getByRole('button', { name: `Edit ${mine}`, exact: true });
    const complete = people.owner.getByRole('checkbox', { name: `Complete ${mine}`, exact: true });
    try {
      await addTodo(people.owner, mine);
      await leaveField(people.owner);
      // A button of a row has the focus; the partner adds a to-do; the poll redraws the list (her row is there) and the focus did not move.
      await edit.focus();
      expect((await partner.post(todo({ date, owners: [PARTNER], title: first }))).status()).toBe(200);
      await pollHere(people.owner);
      await expect(taskRow(people.owner, first)).toBeVisible();
      await expect(edit).toBeFocused();
      // The same for a checkbox, which is how a keyboard user completes a row.
      await complete.focus();
      expect((await partner.post(todo({ date, owners: [PARTNER], title: second }))).status()).toBe(200);
      await pollHere(people.owner);
      await expect(taskRow(people.owner, second)).toBeVisible();
      await expect(complete).toBeFocused();
      // A field is still never redrawn under the typist; Tab to the next control lets the waiting redraw run, and the Add
      // button, which has neither a row nor a label of its own, keeps the focus through it.
      const input = people.owner.getByLabel('New task', { exact: true });
      await input.fill('half typed');
      const third = unique('Third');
      expect((await partner.post(todo({ date, owners: [PARTNER], title: third }))).status()).toBe(200);
      await pollHere(people.owner);
      await expect(input).toBeFocused();
      await expect(taskRow(people.owner, third)).toHaveCount(0);
      await people.owner.keyboard.press('Tab');
      await expect(taskRow(people.owner, third)).toBeVisible();
      await expect(people.owner.getByRole('button', { name: 'Add', exact: true })).toBeFocused();
      await expect(input).toHaveValue('half typed');
    } finally { await people.close(); await clearDay(owner, date); await owner.dispose(); await partner.dispose(); }
  });
});
