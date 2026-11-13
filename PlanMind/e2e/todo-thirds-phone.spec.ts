import { expect, test, type Locator, type Page } from '@playwright/test';
import { periodStart } from '../packages/core/src/planner';
import { apiLogin, farDate, field, login, noWindow, pickList, resetPrefs, todo, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// To-dos in the Both view on a phone: a tap on a blank ruled line is cut in thirds as on a desktop (left lane, both of us, right lane); there
// is no hover. The Day's To-do list is on the To-do tab (under the priorities), the Week's and the Month's behind their To-do tab. The
// project's viewport is 375x812.
test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });
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
async function clearPeriod(api: Api, scope: 'week' | 'month', date: string) {
  for (const task of (await api.snapshot()).tasks.filter((t: { scope: string; date: string }) => t.scope === scope && t.date === date)) {
    await api.post({ action: 'delete', id: task.id, revision: task.revision, confirm: true });
  }
}
const storedTasks = async (api: Api, scope: string, date: string) => (await api.snapshot()).tasks.filter((t: { scope: string; date: string }) => t.scope === scope && t.date === date);
const slot = (page: Page, n: number) => page.locator(`.day-tasks > li[data-slot="${n}"]`);
/** Taps `across` (0 to 1) of the way along a line, in the middle of its height. */
async function tapAt(page: Page, line: Locator, across: number) {
  const box = (await line.boundingBox())!;
  await page.touchscreen.tap(box.x + box.width * across, box.y + box.height / 2);
  return box;
}
/** The Day's To-do tab fits the screen: neither the page nor the tab's body scrolls, and the list is not clipped. */
const fits = (page: Page) => page.evaluate(() => {
  const body = document.querySelector<HTMLElement>('.day-body')!, list = document.querySelector<HTMLElement>('.day-tasks')!;
  return { page: document.documentElement.scrollHeight <= innerHeight, body: body.scrollHeight <= body.clientHeight + 1, list: list.scrollHeight <= list.clientHeight + 1 };
});

test.describe('Day to-do, phone: thirds in the Both view', () => {
  test('a tap in the middle third is one to-do for both of us, an outer third is that lane, no hover box is drawn, the tab does not scroll', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(350);
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('tab', { name: 'To-do', exact: true }).tap();
      await expect(page.getByRole('tab', { name: 'To-do', exact: true })).toHaveAttribute('aria-selected', 'true');
      expect(await fits(page)).toEqual({ page: true, body: true, list: true });
      // The targets are lines a finger can hit: tall enough, and each third is wide.
      const heights = await page.locator('.day-tasks > li').evaluateAll(els => els.map(el => el.getBoundingClientRect().height));
      expect(Math.min(...heights)).toBeGreaterThanOrEqual(29.5);
      expect((await slot(page, 5).boundingBox())!.width / 3).toBeGreaterThan(100);

      await tapAt(page, slot(page, 5), 0.5);
      const fresh = field(page, `New to-do for ${OWNER_NAME} and ${PARTNER_NAME}`);
      await expect(fresh).toBeFocused();
      await noWindow(page);
      await expect(page.locator('.day-task.day-new')).toHaveAttribute('data-c', 'purple');
      expect(await fits(page), 'nothing scrolls while it is written').toEqual({ page: true, body: true, list: true });
      await fresh.fill('Family dinner');
      await fresh.press('Enter');
      await expect(page.getByRole('checkbox', { name: 'Complete Family dinner', exact: true })).toHaveAttribute('data-c', 'purple');
      // A tap near either end is that lane alone.
      await tapAt(page, slot(page, 6), 0.85);
      await expect(page.locator('.day-task.day-new')).toHaveAttribute('data-c', 'yellow');
      await field(page, `New to-do for ${PARTNER_NAME}`).fill('Yoga');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('checkbox', { name: 'Complete Yoga', exact: true })).toHaveAttribute('data-c', 'yellow');
      await tapAt(page, slot(page, 7), 0.15);
      await expect(page.locator('.day-task.day-new')).toHaveAttribute('data-c', 'green');
      await field(page, `New to-do for ${OWNER_NAME}`).fill('Run');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('checkbox', { name: 'Complete Run', exact: true })).toHaveAttribute('data-c', 'green');
      const stored = await storedTasks(owner, 'day', date);
      expect(stored).toHaveLength(3);
      expect(stored).toMatchObject([{ title: 'Family dinner', owners: [OWNER, PARTNER] }, { title: 'Yoga', owners: [PARTNER] }, { title: 'Run', owners: [OWNER] }]);
      // No hover on a touch screen: a mouse move over a blank line draws nothing visible.
      const box = (await slot(page, 8).boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
      await expect(page.locator('.day-newcell')).toBeHidden();
      expect(await fits(page)).toEqual({ page: true, body: true, list: true });
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the add field\'s line is cut too, a tap while the field holds words goes on typing, one list alone has no thirds, a cancelled one gives the blank back', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(351);
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('tab', { name: 'To-do', exact: true }).tap();
      // The first line is the add field; a tap on its right third is the partner's, the field does not take the caret.
      await tapAt(page, slot(page, 1), 0.9);
      await expect(field(page, `New to-do for ${PARTNER_NAME}`)).toBeFocused();
      await expect(page.getByLabel('New task', { exact: true })).toHaveCount(0);
      await page.keyboard.type(`${PARTNER_NAME} first`);
      await page.keyboard.press('Enter');
      await expect(page.getByRole('checkbox', { name: `Complete ${PARTNER_NAME} first`, exact: true })).toHaveAttribute('data-c', 'yellow');
      // Words in the add field are the field's: a tap on its line goes on typing there.
      const input = page.getByLabel('New task', { exact: true });
      await input.fill('Half a thought');
      await tapAt(page, slot(page, 2), 0.15);
      await expect(input).toBeFocused();
      await expect(page.locator('.day-new')).toHaveCount(0);
      await input.fill('');
      // Escape has no key on a phone, but the focus leaving an empty one gives the blank back.
      await tapAt(page, slot(page, 6), 0.5);
      await expect(field(page, `New to-do for ${OWNER_NAME} and ${PARTNER_NAME}`)).toBeFocused();
      await tapAt(page, slot(page, 8), 0.5);
      await expect(field(page, `New to-do for ${OWNER_NAME} and ${PARTNER_NAME}`)).toHaveCount(1);
      await expect(slot(page, 6)).toHaveClass(/\bday-free\b/);
      await page.keyboard.press('Escape');
      await expect(page.locator('.day-new')).toHaveCount(0);
      // One list alone: every tap is that list.
      await pickList(page, OWNER_NAME);
      await tapAt(page, slot(page, 4), 0.9);
      await expect(page.locator('.day-task.day-new')).toHaveAttribute('data-c', 'green');
      await field(page, `New to-do for ${OWNER_NAME}`).fill(`${OWNER_NAME} alone`);
      await page.keyboard.press('Enter');
      await expect(page.getByRole('checkbox', { name: `Complete ${OWNER_NAME} alone`, exact: true })).toHaveAttribute('data-c', 'green');
      expect(await storedTasks(owner, 'day', date)).toMatchObject([{ title: `${PARTNER_NAME} first`, owners: [PARTNER] }, { title: `${OWNER_NAME} alone`, owners: [OWNER] }]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});

test.describe('Day to-do, phone: the empty add field', () => {
  test('a tap on the empty add field starts a to-do in its place and Enter hands the keyboard back to the field; it also saves a to-do being edited and opens the new one', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(352), title = `Plain ${crypto.randomUUID().slice(0, 8)}`;
    expect((await owner.post(todo({ date, owners: [OWNER], title }))).status()).toBe(200);
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('tab', { name: 'To-do', exact: true }).tap();
      await pickList(page, OWNER_NAME);
      const input = page.getByLabel('New task', { exact: true });
      // A to-do with changed words is open: the tap leaves it (saved) and the new editor opens, the row is not left as a dead field.
      await page.getByRole('button', { name: `Edit ${title}`, exact: true }).tap();
      await field(page, `Edit task: ${title}`).fill(`${title} 2`);
      await input.tap();
      await expect(field(page, `New to-do for ${OWNER_NAME}`)).toBeFocused();
      await expect(page.locator('[data-editing]')).toHaveCount(1);
      await expect(page.getByRole('button', { name: `Edit ${title} 2`, exact: true })).toBeVisible();
      expect(await storedTasks(owner, 'day', date)).toMatchObject([{ title: `${title} 2` }]);
      // Enter on it: the keyboard is on the add field again, ready for the next to-do.
      await page.keyboard.type('Buy milk');
      await page.keyboard.press('Enter');
      await expect(input).toBeFocused();
      await page.keyboard.type('Call dentist', { delay: 70 });
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Edit Call dentist', exact: true })).toBeVisible();
      expect((await storedTasks(owner, 'day', date)).map((t: { title: string }) => t.title)).toEqual([`${title} 2`, 'Buy milk', 'Call dentist']);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});

const PERIODS = [{ view: 'Week' as const, scope: 'week' as const, when: periodStart(farDate(362), 'week') }, { view: 'Month' as const, scope: 'month' as const, when: periodStart(farDate(363), 'month') }];
for (const { view, scope, when } of PERIODS) {
  test(`${view} to-do, phone: a tap in each third makes the to-do for that person, with no hover box`, async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    try {
      await login(page);
      await page.getByRole('button', { name: 'Open menu', exact: true }).click();
      await page.getByRole('button', { name: view, exact: true }).click();
      await page.keyboard.press('Escape');
      await page.locator('#pill-date').fill(when);
      await expect(page.locator(`.wm-panel[data-panel="${scope}"]`)).toBeVisible();
      await page.getByRole('tab', { name: 'To-do', exact: true }).tap();
      const line = (n: number) => page.locator(`ul.wm-todos[aria-label="To-do"] > li[data-slot="${n}"]`);
      const heights = await page.locator('ul.wm-todos[aria-label="To-do"] > li').evaluateAll(els => els.map(el => el.getBoundingClientRect().height));
      expect(Math.min(...heights)).toBeGreaterThanOrEqual(39.5);

      await tapAt(page, line(4), 0.5);
      const fresh = field(page, `New to-do for ${OWNER_NAME} and ${PARTNER_NAME}`);
      await expect(fresh).toBeFocused();
      await expect(page.locator('.wm-todo.wm-new')).toHaveAttribute('data-c', 'purple');
      await fresh.fill('Together');
      await fresh.press('Enter');
      await expect(page.getByRole('button', { name: 'Edit Together', exact: true })).toBeVisible();
      await tapAt(page, line(5), 0.1);
      await field(page, `New to-do for ${OWNER_NAME}`).fill('Mine');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Edit Mine', exact: true })).toBeVisible();
      await tapAt(page, line(6), 0.9);
      await field(page, `New to-do for ${PARTNER_NAME}`).fill('Hers');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Edit Hers', exact: true })).toBeVisible();
      expect(await storedTasks(owner, scope, when)).toMatchObject([{ title: 'Together', owners: [OWNER, PARTNER] }, { title: 'Mine', owners: [OWNER] }, { title: 'Hers', owners: [PARTNER] }]);
      await expect(page.locator('.wm-todo[data-c=purple] .wm-owner')).toHaveText('Both');
      await expect(page.locator('.day-newcell')).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await clearPeriod(owner, scope, when); await owner.dispose(); }
  });
}
