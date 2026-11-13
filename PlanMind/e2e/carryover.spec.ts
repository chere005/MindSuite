import { expect, test, type Page } from '@playwright/test';
import { CAPS, dayLabel } from '../packages/core/src/planner';
import { shiftDate } from '../packages/core/src/parse';
import { apiLogin, field, login, noWindow, pickList, resetPrefs, today, unique, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// R10 (the owner, 2026-10-31): the Day view of TODAY also lists the open day to-dos of earlier days, oldest first, each with a muted
// "from Mon Oct 26" chip. A view only: the records stay on their own day (the other days never show them), and completing, editing,
// moving by the day field and deleting act on the real record. On today the cap of 13 counts them, in the page and on the server.
// Every test removes what it made: a leftover open to-do of the past would show on today's view of every later test.
const MAX = CAPS.dayTodosPerList;
// The display tests set the browser's clock, so the days (and the chips) are fixed: a Saturday after Monday Oct 26.
const NOW = new Date('2026-10-31T17:00:00Z'), TODAY = '2026-10-31';
const created: string[] = [];
const add = async (api: Api, body: Record<string, unknown>) => {
  const data = { id: crypto.randomUUID(), ...body };
  const response = await api.post(data);
  expect(response.status(), JSON.stringify(await response.json())).toBe(200);
  created.push(data.id as string);
  return data.id as string;
};
const day = (api: Api, date: string, title: string, owners = [OWNER], more: Record<string, unknown> = {}) => add(api, { action: 'add', kind: 'todo', scope: 'day', date, owners, title, ...more });
async function finish(api: Api, id: string, done = true) {
  const task = (await api.snapshot()).tasks.find((t: { id: string }) => t.id === id);
  expect((await api.post({ action: 'complete', id, revision: task.revision, done })).status()).toBe(200);
}
async function wipe(api: Api) {
  const { tasks } = await api.snapshot();
  for (const task of tasks.filter((t: { id: string }) => created.includes(t.id))) { await api.post({ action: 'delete', id: task.id, revision: task.revision, confirm: true }); }
  created.length = 0;
}
const stored = async (api: Api, id: string) => (await api.snapshot()).tasks.find((t: { id: string }) => t.id === id);
const titles = (page: Page) => page.locator('.day-task .day-task-title').allTextContents();
const chips = (page: Page) => page.locator('.day-task .day-from').allTextContents();
const goTo = async (page: Page, date: string) => {
  await page.locator('#jump-date').fill(date);
  await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', date);
};
const edit = (title: string) => ({ name: `Edit ${title}`, exact: true }) as const;

test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });

test.describe('Day to-dos carried over to today', () => {
  test('today lists the open to-dos of earlier days first, oldest first, with a chip; no other day shows them; they stay on their own day', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    try {
      const mon = await day(owner, '2026-10-26', 'Wait for the plumber'), thu = await day(owner, '2026-10-29', 'Renew the passport', [PARTNER]);
      const fri = await day(owner, '2026-10-30', 'Pick up the parcel', [OWNER, PARTNER]), finished = await day(owner, '2026-10-30', 'Already finished');
      await finish(owner, finished);
      await day(owner, '2026-10-26', 'Weekly thing', [OWNER], { scope: 'week' });
      await day(owner, '2026-11-01', 'Tomorrow thing');
      await day(owner, TODAY, 'Own thing');
      await page.clock.install({ time: NOW });
      await login(page);
      await expect(page.locator('#day-title')).toHaveText('Today');
      // Earlier days' open to-dos first, oldest first, then today's own; a done one, a week one and a later day's stay out.
      await expect.poll(() => titles(page)).toEqual(['Wait for the plumber', 'Renew the passport', 'Pick up the parcel', 'Own thing']);
      expect(await chips(page)).toEqual(['from Mon Oct 26', 'from Thu Oct 29', 'from Fri Oct 30']);
      await expect(page.locator('.day-task').nth(3).locator('.day-from')).toHaveCount(0);
      // The ruled slots: four to-dos and nine blank lines, the first of them the add field. The circle takes the owner's color.
      await expect(page.locator('.day-free')).toHaveCount(MAX - 4);
      await expect(page.locator('.day-task').nth(2).locator('.day-circle')).toHaveAttribute('data-c', 'purple');
      await expect(page.locator('.day-todo [data-kind=todos]')).toHaveText(`3 of ${MAX}`);
      // Each day shows its own and nothing carried: the day it was made on keeps the record.
      await goTo(page, '2026-10-30');
      await expect.poll(() => titles(page)).toEqual(['Pick up the parcel', 'Already finished']);
      expect(await chips(page)).toEqual([]);
      await goTo(page, '2026-10-26');
      await expect.poll(() => titles(page)).toEqual(['Wait for the plumber']);
      await goTo(page, '2026-10-27');
      await expect.poll(() => titles(page)).toEqual([]);
      await goTo(page, '2026-11-01');
      await expect.poll(() => titles(page)).toEqual(['Tomorrow thing']);
      expect(await chips(page)).toEqual([]);
      await goTo(page, '2026-11-02');
      await expect.poll(() => titles(page)).toEqual([]);
      // Nothing was written by looking: the records have the days they were made with.
      expect((await stored(owner, mon)).date).toBe('2026-10-26');
      expect((await stored(owner, thu)).date).toBe('2026-10-29');
      expect((await stored(owner, fri)).date).toBe('2026-10-30');
    } finally { await wipe(owner); await owner.dispose(); }
  });

  test('a carried to-do shows when its list is shown, and a linked one only once', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    try {
      await day(owner, '2026-10-27', `${OWNER_NAME} carried`);
      await day(owner, '2026-10-28', `${PARTNER_NAME} carried`, [PARTNER]);
      await day(owner, '2026-10-29', 'Both carried', [OWNER, PARTNER]);
      await page.clock.install({ time: NOW });
      await login(page);
      await expect.poll(() => titles(page)).toEqual([`${OWNER_NAME} carried`, `${PARTNER_NAME} carried`, 'Both carried']);
      await pickList(page, OWNER_NAME);
      await expect.poll(() => titles(page)).toEqual([`${OWNER_NAME} carried`, 'Both carried']);
      await pickList(page, PARTNER_NAME);
      await expect.poll(() => titles(page)).toEqual([`${PARTNER_NAME} carried`, 'Both carried']);
      await expect(page.locator('.day-task').first().locator('.day-from')).toHaveText('from Wed Oct 28');
    } finally { await wipe(owner); await owner.dispose(); }
  });

  test('completing, renaming, dating in place and deleting a carried to-do act on the real record, its own day unchanged unless the day field changes', async ({ page, baseURL }) => {
    // The real clock: ticking a carried row writes the day it was ticked on, which the server only takes when it is the server's today.
    const owner = await apiLogin(baseURL!, OWNER), then = shiftDate(today(), -3, 'day');
    const chip = `from ${dayLabel(then, { weekday: 'short' })} ${dayLabel(then, { month: 'short', day: 'numeric' })}`;
    try {
      const one = await day(owner, then, 'Carried one'), two = await day(owner, then, 'Carried two');
      const three = await day(owner, then, 'Carried three'), four = await day(owner, then, 'Carried four');
      await login(page);
      await pickList(page, OWNER_NAME);
      await expect.poll(() => titles(page)).toEqual(['Carried one', 'Carried two', 'Carried three', 'Carried four']);
      // Complete: the real record is done, keeps its own day and says it was done on today; a done to-do is not carried, so the row leaves the open
      // rows and is a done row of today's list (done-on.spec.ts: the whole rule).
      await page.getByRole('checkbox', { name: 'Complete Carried one', exact: true }).click();
      await expect.poll(async () => (await stored(owner, one)).done).toBe(true);
      expect(await stored(owner, one)).toMatchObject({ date: then, doneOn: today() });
      await expect.poll(() => titles(page)).toEqual(['Carried two', 'Carried three', 'Carried four', 'Carried one']);
      await expect(page.locator('.day-task.day-done .day-from')).toHaveText(chip);
      // Rename where it stands: the day field shows the real day, the record keeps it, and the row is still carried.
      await page.getByRole('button', edit('Carried two')).click();
      const rename = field(page, 'Edit task: Carried two');
      await expect(rename).toBeFocused();
      await expect(page.locator('.day-task.day-editing input[type=date]')).toHaveValue(then);
      await expect(page.locator('.day-task.day-editing .day-from')).toHaveCount(0);
      await rename.fill('Carried two, renamed');
      await rename.press('Enter');
      await expect.poll(async () => (await stored(owner, two)).title).toBe('Carried two, renamed');
      expect((await stored(owner, two)).date).toBe(then);
      await expect(page.getByRole('button', edit('Carried two, renamed'))).toBeVisible();
      await expect(page.locator('.day-task', { has: page.getByRole('button', edit('Carried two, renamed')) }).locator('.day-from')).toHaveText(chip);
      // The day field is the one way to move it: dated to today it is today's own and the chip goes.
      await page.getByRole('button', edit('Carried three')).click();
      await page.locator('.day-task.day-editing input[type=date]').fill(today());
      await field(page, 'Edit task: Carried three').press('Enter');
      await expect.poll(async () => (await stored(owner, three)).date).toBe(today());
      await expect(page.locator('.day-task', { has: page.getByRole('button', edit('Carried three')) }).locator('.day-from')).toHaveCount(0);
      // Delete removes the record itself, for the day it was made on as well.
      await page.getByRole('button', edit('Carried four')).click();
      await page.getByRole('button', { name: 'Delete task: Carried four', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
      await expect.poll(async () => await stored(owner, four)).toBeUndefined();
      await expect.poll(() => titles(page)).toEqual(['Carried two, renamed', 'Carried three', 'Carried one']);
      await noWindow(page);
    } finally { await wipe(owner); await owner.dispose(); }
  });
});

test.describe('The open to-do cap on today counts the carried to-dos', () => {
  // The real clock: the server decides "today" in the site's timezone, as the page does.
  const spread = async (api: Api, count: number, owners = [OWNER]) => {
    for (let n = 0; n < count; n++) { await day(api, shiftDate(today(), -(1 + (n % 6)), 'day'), `Carried ${n + 1}`, owners); }
  };

  test('carried and own together fill the 13 slots: no add field, the reason; the server refuses an add on today by the same count, and a day after today has room', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    try {
      for (let n = 1; n <= 5; n++) { await day(owner, today(), `Own ${n}`); }
      await spread(owner, MAX - 5);
      await login(page);
      await pickList(page, OWNER_NAME);
      await expect(page.locator('.day-task')).toHaveCount(MAX);
      await expect(page.locator('.day-task .day-from')).toHaveCount(MAX - 5);
      await expect(page.locator('.day-free')).toHaveCount(0);
      await expect(page.getByLabel('New task', { exact: true })).toHaveCount(0);
      await expect(page.locator('.day-todo [data-kind=todos]')).toHaveText(`${MAX} of ${MAX}`);
      await expect(page.locator('.day-msg')).toHaveText(`${OWNER_NAME} already has ${MAX} things to do that day.`);
      // The server counts the same: an add for today is a limit, for a later day it is not.
      const refused = await owner.post({ action: 'add', kind: 'todo', id: crypto.randomUUID(), scope: 'day', date: today(), owners: [OWNER], title: 'One too many' });
      expect(refused.status()).toBe(409);
      expect(await refused.json()).toMatchObject({ code: 'limit', cap: 'dayTodosPerList' });
      await day(owner, shiftDate(today(), 1, 'day'), 'Tomorrow has room');
      // Finishing a carried one gives its slot back: a blank line and the field return, and it takes a new to-do.
      await page.getByRole('checkbox', { name: 'Complete Carried 1', exact: true }).click();
      await expect(page.locator('.day-free')).toHaveCount(1);
      await expect(page.locator('.day-msg')).toBeHidden();
      const box = page.getByLabel('New task', { exact: true }), title = unique('Fills the gap');
      await box.fill(title);
      await box.press('Enter');
      await expect(page.getByRole('button', edit(title))).toBeVisible();
      await expect(page.getByLabel('New task', { exact: true })).toHaveCount(0);
      created.push(...(await owner.snapshot()).tasks.filter((t: { title: string }) => t.title === title).map((t: { id: string }) => t.id));
      // The partner's list is a separate count: she has room.
      await pickList(page, PARTNER_NAME);
      await expect(page.getByLabel('New task', { exact: true })).toBeVisible();
    } finally { await wipe(owner); await owner.dispose(); }
  });

  test('more carried than the slots hold (time alone did it): 13 rows, "+N more" for the rest, no add field, and the rows behind it are edited where they are', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    try {
      // Today's own are written first (the server would count the carried ones against them afterwards).
      for (let n = 1; n <= 2; n++) { await day(owner, today(), `Own ${n}`); }
      await spread(owner, MAX);
      await login(page);
      await pickList(page, OWNER_NAME);
      await expect(page.locator('.day-task')).toHaveCount(MAX);
      await expect(page.getByRole('button', { name: '+2 more', exact: true })).toBeVisible();
      await expect(page.getByLabel('New task', { exact: true })).toHaveCount(0);
      await expect(page.locator('.day-msg')).toHaveText(`${OWNER_NAME} already has ${MAX} things to do that day.`);
      await page.getByRole('button', { name: '+2 more', exact: true }).click();
      const more = page.getByRole('list', { name: 'More to do' });
      await expect(more.locator('.day-task')).toHaveCount(2);
      await expect(more).toContainText('Own 1');
      await more.getByRole('button', edit('Own 2')).click();
      await expect(field(page, 'Edit task: Own 2')).toBeFocused();
      await noWindow(page);
      await field(page, 'Edit task: Own 2').press('Escape');
      await page.getByRole('button', { name: 'Back to to-do', exact: true }).click();
      await expect(page.locator('.day-task')).toHaveCount(MAX);
    } finally { await wipe(owner); await owner.dispose(); }
  });
});
