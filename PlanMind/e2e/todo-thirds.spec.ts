import { expect, test, type Locator, type Page } from '@playwright/test';
import { periodStart } from '../packages/core/src/planner';
import { apiLogin, farDate, field, leaveField, login, noWindow, overlayList, pickList, resetPrefs, todo, unique, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// To-dos have the same interface as the schedule and the priorities: in the Both view a blank ruled line is cut in thirds across its
// width. The left third makes a to-do for the left lane's person (the signed-in one), the middle third ONE linked to-do for both of us, the
// right third the right lane's person. The hover draws the cell a click will make, in the color of whoever it is for. One list shown has
// no thirds. The Day (13 slots), the Week (13 lines) and the Month (8 lines) share it. Desktop project; the phone is in todo-thirds-phone.spec.ts.
test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });
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
const storedTasks = async (api: Api, scope: string, date: string) => (await api.snapshot()).tasks.filter((t: { scope: string; date: string }) => t.scope === scope && t.date === date);
/** Blank line n (its ruled line number) of the Day's To-do list: the add field's line is the first of them. */
const slot = (page: Page, n: number) => page.locator(`.day-tasks > li[data-slot="${n}"]`);
const ghost = (page: Page) => page.locator('.day-newcell');
/** A point `across` (0 to 1) of the way along a line. */
/** The pointer well away from the lists (over the sidebar). */
const away = async (page: Page) => { const side = (await page.locator('#sidebar').boundingBox())!; await page.mouse.move(side.x + 20, side.y + 200); };
const along = async (line: Locator, across: number) => { const box = (await line.boundingBox())!; return { box, x: box.x + box.width * across, y: box.y + box.height / 2 }; };

test.describe('Day to-do, desktop: thirds in the Both view', () => {
  test('the hover is the cell a click would make, in the color of who it is for: left lane, both, right lane; also on the add field\'s line', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(340);
    try {
      await login(page); await openDay(page, date);
      await expect(ghost(page)).toHaveCount(0);
      // The owner is the left lane (you), the partner the right one; the middle third is Both's own color.
      for (const n of [4, 1]) {
        const line = slot(page, n), box = (await line.boundingBox())!;
        const at = async (across: number) => { await page.mouse.move(box.x + box.width * across, box.y + box.height / 2); };
        await at(0.12);
        await expect(ghost(page)).toHaveCount(1);
        await expect(ghost(page)).toHaveAttribute('data-c', 'green');
        await expect(ghost(page)).toHaveAttribute('data-side', 'left');
        let g = (await ghost(page).boundingBox())!;
        expect(g.x, `line ${n}: over the left half`).toBeLessThan(box.x + 4);
        expect(g.width).toBeLessThan(box.width * 0.55);
        expect(g.width).toBeGreaterThan(box.width * 0.4);
        expect(g.y).toBeGreaterThanOrEqual(box.y);
        expect(g.y + g.height).toBeLessThanOrEqual(box.y + box.height + 1);
        await at(0.5);
        await expect(ghost(page)).toHaveAttribute('data-c', 'purple');
        await expect(ghost(page)).toHaveAttribute('data-side', 'both');
        g = (await ghost(page).boundingBox())!;
        expect(g.width, `line ${n}: over the whole line`).toBeGreaterThan(box.width * 0.95);
        await at(0.9);
        await expect(ghost(page)).toHaveAttribute('data-c', 'yellow');
        await expect(ghost(page)).toHaveAttribute('data-side', 'right');
        g = (await ghost(page).boundingBox())!;
        expect(g.x, `line ${n}: over the right half`).toBeGreaterThan(box.x + box.width * 0.45);
        expect(g.x + g.width).toBeLessThanOrEqual(box.x + box.width + 1);
        // The edges: a third starts at a third of the line.
        await at(0.32);
        await expect(ghost(page)).toHaveAttribute('data-c', 'green');
        await at(0.35);
        await expect(ghost(page)).toHaveAttribute('data-c', 'purple');
        await at(0.65);
        await expect(ghost(page)).toHaveAttribute('data-c', 'purple');
        await at(0.68);
        await expect(ghost(page)).toHaveAttribute('data-c', 'yellow');
        // Shift held over the line is the middle: the click it previews makes one for both.
        await page.keyboard.down('Shift');
        await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2 + 1);
        await expect(ghost(page)).toHaveAttribute('data-side', 'both');
        await page.keyboard.up('Shift');
        await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2);
        await expect(ghost(page)).toHaveAttribute('data-side', 'left');
        // Leaving the list takes it away.
        await away(page);
        await expect(ghost(page)).toHaveCount(0);
      }
      // The lines keep their place: the ghost is not a row that pushes the next one down.
      const first = (await slot(page, 1).boundingBox())!, second = (await slot(page, 2).boundingBox())!;
      await page.mouse.move(first.x + 10, first.y + first.height / 2);
      await expect(ghost(page)).toHaveCount(1);
      const again = (await slot(page, 2).boundingBox())!;
      expect(again.y).toBeCloseTo(second.y, 0);
      expect(again.height).toBeCloseTo(second.height, 0);
      // A scroll of the panel under a resting pointer takes the ghost away.
      await page.locator('#period-panel').evaluate(el => el.dispatchEvent(new Event('scroll')));
      await expect(ghost(page)).toHaveCount(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a click in the middle third makes ONE to-do for both of us, seen in both lists; the outer thirds make a to-do for that lane alone, and each opens in place', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(341);
    try {
      await login(page); await openDay(page, date);
      const line = slot(page, 6), { box, x, y } = await along(line, 0.5);
      await page.mouse.click(x, y);
      const fresh = field(page, `New to-do for ${OWNER_NAME} and ${PARTNER_NAME}`);
      await expect(fresh).toBeFocused();
      await noWindow(page);
      const row = page.locator('.day-task.day-new');
      await expect(row).toHaveAttribute('data-c', 'purple');
      // In place: the field is on the line that was clicked, as wide as the line.
      const open = (await row.boundingBox())!;
      expect(Math.abs(open.y - box.y)).toBeLessThanOrEqual(2);
      expect(open.width).toBeGreaterThan(box.width * 0.95);
      await fresh.fill('Family dinner');
      await fresh.press('Enter');
      await expect(row).toHaveCount(0);
      const stored = await storedTasks(owner, 'day', date);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ title: 'Family dinner', owners: [OWNER, PARTNER] });
      await expect(page.getByRole('checkbox', { name: 'Complete Family dinner', exact: true })).toHaveAttribute('data-c', 'purple');
      // The keyboard goes to the new to-do, as it does for a priority.
      await expect(page.getByRole('button', { name: 'Edit Family dinner', exact: true })).toBeFocused();
      // One to-do, on one line of each list: it is there whichever list is shown.
      await pickList(page, OWNER_NAME);
      await expect(page.getByRole('button', { name: 'Edit Family dinner', exact: true })).toBeVisible();
      await pickList(page, PARTNER_NAME);
      await expect(page.getByRole('button', { name: 'Edit Family dinner', exact: true })).toBeVisible();
      await pickList(page, 'Both');
      await expect(page.getByRole('button', { name: 'Edit Family dinner', exact: true })).toHaveCount(1);

      // An outer third is a to-do for that lane alone: left is the owner's, right is the partner's. The saved to-do takes the next free line, top-down.
      const left = await along(slot(page, 7), 0.1);
      await page.mouse.click(left.x, left.y);
      await expect(page.locator('.day-task.day-new')).toHaveAttribute('data-c', 'green');
      await field(page, `New to-do for ${OWNER_NAME}`).fill('Run');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('checkbox', { name: 'Complete Run', exact: true })).toHaveAttribute('data-c', 'green');
      const rightOf = await along(slot(page, 8), 0.9);
      await page.mouse.click(rightOf.x, rightOf.y);
      await expect(page.locator('.day-task.day-new')).toHaveAttribute('data-c', 'yellow');
      await field(page, `New to-do for ${PARTNER_NAME}`).fill('Yoga');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('checkbox', { name: 'Complete Yoga', exact: true })).toHaveAttribute('data-c', 'yellow');
      expect(await storedTasks(owner, 'day', date)).toMatchObject([
        { title: 'Family dinner', owners: [OWNER, PARTNER] }, { title: 'Run', owners: [OWNER] }, { title: 'Yoga', owners: [PARTNER] },
      ]);
      // The new rows are the first three lines, the blank lines follow, and the add field is on the next one.
      await expect(page.locator('.day-tasks > li').nth(3).getByLabel('New task', { exact: true })).toBeVisible();
      await expect(page.locator('.day-tasks > li')).toHaveCount(13);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the add field\'s own line is cut too: a click on the empty field in the left, middle and right third makes the to-do for that person', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(342);
    try {
      await login(page); await openDay(page, date);
      const input = page.locator('[data-key="todo:add"]');
      const at = async (across: number) => { const box = (await input.boundingBox())!; const line = (await slot(page, 1).boundingBox())!; return { x: line.x + line.width * across, y: box.y + box.height / 2 }; };
      // The field is empty: pointing at it is pointing at a line. The field does not take the caret; the editor does.
      let p = await at(0.9);
      await page.mouse.click(p.x, p.y);
      await expect(field(page, `New to-do for ${PARTNER_NAME}`)).toBeFocused();
      await expect(input).toHaveCount(0);
      await page.keyboard.type('Right one');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('checkbox', { name: 'Complete Right one', exact: true })).toHaveAttribute('data-c', 'yellow');
      // The field moved down a line; the third of it is again each person's.
      const input2 = page.locator('[data-key="todo:add"]');
      const line2 = (await slot(page, 2).boundingBox())!;
      await page.mouse.click(line2.x + line2.width * 0.1, line2.y + line2.height / 2);
      await expect(field(page, `New to-do for ${OWNER_NAME}`)).toBeFocused();
      await page.keyboard.type('Left one');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('checkbox', { name: 'Complete Left one', exact: true })).toHaveAttribute('data-c', 'green');
      const line3 = (await slot(page, 3).boundingBox())!;
      await page.mouse.click(line3.x + line3.width * 0.5, line3.y + line3.height / 2);
      await expect(field(page, `New to-do for ${OWNER_NAME} and ${PARTNER_NAME}`)).toBeFocused();
      await page.keyboard.type('Middle one');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('checkbox', { name: 'Complete Middle one', exact: true })).toHaveAttribute('data-c', 'purple');
      expect(await storedTasks(owner, 'day', date)).toMatchObject([{ title: 'Right one', owners: [PARTNER] }, { title: 'Left one', owners: [OWNER] }, { title: 'Middle one', owners: [OWNER, PARTNER] }]);
      await expect(input2).toBeVisible();
      // Text typed in the field is the field's: a click on it goes on typing, it does not start a to-do.
      await input2.fill('Half a thought');
      const text = await along(slot(page, 4), 0.1);
      await page.mouse.click(text.x, text.y);
      await expect(input2).toBeFocused();
      await expect(page.locator('.day-new')).toHaveCount(0);
      await expect(input2).toHaveValue('Half a thought');
      await expect(ghost(page)).toHaveCount(0);
      await input2.fill('');
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('one list alone has no thirds: the hover and the click are that list, wherever the pointer is on the line, and there is no both button', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(343);
    try {
      await login(page); await openDay(page, date);
      await pickList(page, PARTNER_NAME);
      const line = slot(page, 3), box = (await line.boundingBox())!;
      for (const across of [0.1, 0.5, 0.9]) {
        await page.mouse.move(box.x + box.width * across, box.y + box.height / 2);
        await expect(ghost(page)).toHaveAttribute('data-c', 'yellow');
        await expect(ghost(page)).toHaveAttribute('data-side', 'only');
        const g = (await ghost(page).boundingBox())!;
        expect(g.width, `at ${across}: the whole line`).toBeGreaterThan(box.width * 0.95);
      }
      await expect(page.locator('button[data-both]')).toHaveCount(0);
      // Shift does not make it both.
      await line.click({ position: { x: box.width * 0.9, y: box.height / 2 }, modifiers: ['Shift'] });
      await expect(field(page, `New to-do for ${PARTNER_NAME}`)).toBeFocused();
      await expect(page.locator('.day-task.day-new')).toHaveAttribute('data-c', 'yellow');
      await page.keyboard.type(`${PARTNER_NAME} only`);
      await page.keyboard.press('Enter');
      await pickList(page, OWNER_NAME);
      await expect(page.getByRole('button', { name: `Edit ${PARTNER_NAME} only`, exact: true })).toHaveCount(0);
      const sline = (await slot(page, 2).boundingBox())!;
      await page.mouse.click(sline.x + sline.width * 0.1, sline.y + sline.height / 2);
      await expect(page.locator('.day-task.day-new')).toHaveAttribute('data-c', 'green');
      await field(page, `New to-do for ${OWNER_NAME}`).fill(`${OWNER_NAME} only`);
      await page.keyboard.press('Enter');
      expect(await storedTasks(owner, 'day', date)).toMatchObject([{ title: `${PARTNER_NAME} only`, owners: [PARTNER] }, { title: `${OWNER_NAME} only`, owners: [OWNER] }]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('Both with a custom list on top has three lanes and no thirds: the line is for the picker\'s Both', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(344), name = unique('Camp'), id = crypto.randomUUID();
    expect((await owner.post({ action: 'saveList', id, name, color: 'blue', revision: 0 })).status()).toBe(200);
    try {
      await login(page); await openDay(page, date);
      await overlayList(page, name);
      const line = slot(page, 3), box = (await line.boundingBox())!;
      for (const across of [0.1, 0.9]) {
        await page.mouse.move(box.x + box.width * across, box.y + box.height / 2);
        await expect(ghost(page)).toHaveAttribute('data-side', 'only');
        await expect(ghost(page)).toHaveAttribute('data-c', 'purple');
      }
      await expect(page.locator('button[data-both]')).toHaveCount(0);
      await page.mouse.click(box.x + box.width * 0.1, box.y + box.height / 2);
      await expect(field(page, `New to-do for ${OWNER_NAME} and ${PARTNER_NAME}`)).toBeFocused();
      await page.keyboard.press('Escape');
    } finally {
      await owner.post({ action: 'savePrefs', selection: { base: 'both', overlays: [] } });
      await clearDay(owner, date);
      const list = (await owner.snapshot()).lists.find((l: { id: string }) => l.id === id);
      if (list) { await owner.post({ action: 'deleteList', id, revision: list.revision, confirm: true }); }
      await owner.dispose();
    }
  });

  test('Escape gives the blank back and the keyboard returns to the add field; leaving it empty drops it; leaving it with words saves; Shift+click and the hidden button are for both', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(345);
    try {
      await login(page); await openDay(page, date);
      // Escape: nothing saved, the blank line is back as it was, and the keyboard is on the add field.
      let p = await along(slot(page, 5), 0.5);
      await page.mouse.click(p.x, p.y);
      await field(page, `New to-do for ${OWNER_NAME} and ${PARTNER_NAME}`).fill('Never saved');
      await page.keyboard.press('Escape');
      await expect(page.locator('.day-new')).toHaveCount(0);
      await expect(slot(page, 5)).toHaveClass(/\bday-free\b/);
      await expect(slot(page, 5)).toHaveAttribute('aria-hidden', 'true');
      await expect(page.locator('.day-free')).toHaveCount(13);
      await expect(page.getByLabel('New task', { exact: true })).toBeFocused();
      expect(await storedTasks(owner, 'day', date)).toHaveLength(0);
      // Leaving an empty one drops it without a word.
      p = await along(slot(page, 6), 0.1);
      await page.mouse.click(p.x, p.y);
      await expect(field(page, `New to-do for ${OWNER_NAME}`)).toBeFocused();
      await leaveField(page);
      await expect(page.locator('.day-new')).toHaveCount(0);
      await expect(page.locator('.day-free')).toHaveCount(13);
      expect(await storedTasks(owner, 'day', date)).toHaveLength(0);
      // Enter on an empty one closes it too.
      p = await along(slot(page, 6), 0.9);
      await page.mouse.click(p.x, p.y);
      await field(page, `New to-do for ${PARTNER_NAME}`).press('Enter');
      await expect(page.locator('.day-new')).toHaveCount(0);
      // Words typed and the focus leaving is Enter: it is saved, for the third it was started in.
      p = await along(slot(page, 7), 0.1);
      await page.mouse.click(p.x, p.y);
      await field(page, `New to-do for ${OWNER_NAME}`).fill('Saved by leaving');
      await leaveField(page);
      await expect(page.getByRole('button', { name: 'Edit Saved by leaving', exact: true })).toBeVisible();
      expect(await storedTasks(owner, 'day', date)).toMatchObject([{ title: 'Saved by leaving', owners: [OWNER] }]);

      // Shift+click on an outer third is both of us.
      const line = slot(page, 4), box = (await line.boundingBox())!;
      await line.click({ position: { x: box.width * 0.1, y: box.height / 2 }, modifiers: ['Shift'] });
      await expect(field(page, `New to-do for ${OWNER_NAME} and ${PARTNER_NAME}`)).toBeFocused();
      await expect(page.locator('.day-task.day-new')).toHaveAttribute('data-c', 'purple');
      await field(page, `New to-do for ${OWNER_NAME} and ${PARTNER_NAME}`).fill('Shifted');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('checkbox', { name: 'Complete Shifted', exact: true })).toHaveAttribute('data-c', 'purple');
      await line.click({ position: { x: box.width * 0.9, y: box.height / 2 }, modifiers: ['Shift'] });
      await expect(field(page, `New to-do for ${OWNER_NAME} and ${PARTNER_NAME}`)).toBeFocused();
      await page.keyboard.press('Escape');
      // Escape is the app's redraw (a macrotask later): the blank is back and the keyboard is in the add field before anything goes on.
      await expect(page.locator('.day-new')).toHaveCount(0);
      await expect(page.getByLabel('New task', { exact: true })).toBeFocused();

      // A screen reader's way to both of us: a hidden button on the add field's line, out of the tab order.
      const hidden = page.getByRole('button', { name: `Add to-do for ${OWNER_NAME} and ${PARTNER_NAME}`, exact: true });
      await expect(hidden).toHaveCount(1);
      await expect(hidden).toHaveAttribute('tabindex', '-1');
      await expect(page.locator('.day-free:not(.day-free-add) :is(button,input,a)')).toHaveCount(0);
      await hidden.dispatchEvent('click');
      // The app's own signal is where it put the keyboard (document.activeElement), not Playwright's toBeFocused(), which also needs the
      // browser to call the page focused: that is lost for good when a Tab leaves the page, and a Tab pressed before this click could do
      // that late (the browser takes the focus out after the key was dispatched, so after the app had focused the field).
      await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null)).toBe(`New to-do for ${OWNER_NAME} and ${PARTNER_NAME}`);
      await page.keyboard.press('Escape');
      await expect(page.locator('.day-new')).toHaveCount(0);
      await expect(page.getByLabel('New task', { exact: true })).toBeFocused();
      expect(await storedTasks(owner, 'day', date)).toHaveLength(2);
      // Out of the tab order: Tab from the add field, which has nothing after it, does not land on the hidden button (it leaves the page, so this is the last step).
      await page.keyboard.press('Tab');
      await expect(hidden).not.toBeFocused();
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a click on a blank line while another to-do is open saves that one first (a new one with words too), then opens the new one, one at a time', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(349), title = unique('Plain');
    expect((await owner.post(todo({ date, owners: [OWNER], title }))).status()).toBe(200);
    try {
      await login(page); await openDay(page, date);
      // A stored to-do being edited: the click elsewhere is the focus leaving, so it is saved, then the new editor opens.
      await page.getByRole('button', { name: `Edit ${title}`, exact: true }).click();
      await field(page, `Edit task: ${title}`).fill(`${title} 2`);
      const first = await along(slot(page, 6), 0.9);
      await page.mouse.click(first.x, first.y);
      await expect(field(page, `New to-do for ${PARTNER_NAME}`)).toBeFocused();
      await expect(page.locator('[data-editing]')).toHaveCount(1);
      await expect(page.getByRole('button', { name: `Edit ${title} 2`, exact: true })).toBeVisible();
      expect(await storedTasks(owner, 'day', date)).toMatchObject([{ title: `${title} 2` }]);
      // A new one with words: another blank line saves it, and opens its own editor.
      await field(page, `New to-do for ${PARTNER_NAME}`).fill('First new');
      const second = await along(slot(page, 8), 0.1);
      await page.mouse.click(second.x, second.y);
      await expect(field(page, `New to-do for ${OWNER_NAME}`)).toBeFocused();
      await expect(page.locator('[data-editing]')).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Edit First new', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      expect(await storedTasks(owner, 'day', date)).toMatchObject([{ title: `${title} 2`, owners: [OWNER] }, { title: 'First new', owners: [PARTNER] }]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a click on the empty add field starts a to-do in its place, and Enter hands the keyboard back to the add field so the next one can be typed straight away', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(342);
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      const input = page.locator('[data-key="todo:add"]');
      await input.click();
      await expect(field(page, `New to-do for ${OWNER_NAME}`)).toBeFocused();
      await expect(input).toHaveCount(0);
      await page.keyboard.type('Buy milk');
      await page.keyboard.press('Enter');
      // The keyboard is on the add field again (not on the button of the to-do just saved), so typing goes on at human speed.
      await expect(input).toBeFocused();
      await expect(page.getByRole('button', { name: 'Edit Buy milk', exact: true })).toBeVisible();
      await page.keyboard.type('Call dentist', { delay: 70 });
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Edit Call dentist', exact: true })).toBeVisible();
      await expect(input).toBeFocused();
      expect((await storedTasks(owner, 'day', date)).map((t: { title: string }) => t.title)).toEqual(['Buy milk', 'Call dentist']);
      // Written over another blank line the keyboard goes to the new to-do, as before.
      await slot(page, 6).click();
      await field(page, `New to-do for ${OWNER_NAME}`).fill('Lower line');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Edit Lower line', exact: true })).toBeFocused();
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a click on the empty add field while a to-do, a priority or the notes is open saves that one and opens the new to-do, as a click on a lower blank line does', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(343), title = unique('Plain');
    expect((await owner.post(todo({ date, owners: [OWNER], title }))).status()).toBe(200);
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      const input = page.getByLabel('New task', { exact: true });
      const opened = async () => {
        await expect(field(page, `New to-do for ${OWNER_NAME}`)).toBeFocused();
        await expect(page.locator('[data-editing]')).toHaveCount(1);
        await expect(page.locator('.day-task.day-new')).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect(page.locator('.day-new')).toHaveCount(0);
        await expect(input).toBeFocused();
        await leaveField(page);
      };
      // A to-do with changed words: saved, its row is plain text again, and the new editor is open.
      await page.getByRole('button', { name: `Edit ${title}`, exact: true }).click();
      await field(page, `Edit task: ${title}`).fill(`${title} 2`);
      await input.click();
      await expect(page.getByRole('button', { name: `Edit ${title} 2`, exact: true })).toBeVisible();
      expect(await storedTasks(owner, 'day', date)).toMatchObject([{ title: `${title} 2` }]);
      await opened();
      // The notes with words in them: the click leaves them (their save is the focus leaving), and the new editor is open.
      const notes = page.getByLabel(`Notes for ${OWNER_NAME}`, { exact: true });
      await notes.click();
      await page.keyboard.type('Remember the milk');
      await input.click();
      await expect(notes).not.toBeFocused();
      await expect(notes).toHaveValue('Remember the milk');
      await opened();
      // A priority being written: saved by the click, which opens the new to-do.
      await page.getByRole('button', { name: `Add priority 1 for ${OWNER_NAME}`, exact: true }).click();
      await field(page, `New priority 1 for ${OWNER_NAME}`).fill('Top thing');
      await input.click();
      await expect(page.getByRole('button', { name: `Priority 1: Top thing, ${OWNER_NAME}`, exact: true })).toBeVisible();
      await opened();
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the add field is still the keyboard\'s way: under Both it adds the linked to-do, as it always did', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(346);
    try {
      await login(page); await openDay(page, date);
      const input = page.getByLabel('New task', { exact: true });
      await input.focus();
      await page.keyboard.type('Keyboard one');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('checkbox', { name: 'Complete Keyboard one', exact: true })).toHaveAttribute('data-c', 'purple');
      expect(await storedTasks(owner, 'day', date)).toMatchObject([{ title: 'Keyboard one', owners: [OWNER, PARTNER] }]);
      await expect(page.getByLabel('New task', { exact: true })).toBeFocused();
      await pickList(page, PARTNER_NAME);
      await page.getByLabel('New task', { exact: true }).fill('Keyboard two');
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(page.getByRole('checkbox', { name: 'Complete Keyboard two', exact: true })).toHaveAttribute('data-c', 'yellow');
      await expect(page.locator('.day-new')).toHaveCount(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a list with 13 open to-dos has no blank line to point at and says so; a server refusal of a new to-do reads the same and keeps the words', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), full = farDate(347), race = farDate(348);
    for (let n = 1; n <= 13; n++) { expect((await owner.post(todo({ date: full, owners: [OWNER], title: `Full ${n}` }))).status()).toBe(200); }
    for (let n = 1; n <= 12; n++) { expect((await owner.post(todo({ date: race, owners: [OWNER], title: `Race ${n}` }))).status()).toBe(200); }
    try {
      await login(page); await openDay(page, full);
      // Under Both the owner's 13 fill the slots: nothing to point at, no ghost, the list says why.
      await expect(page.locator('.day-free')).toHaveCount(0);
      await expect(page.locator('.day-msg')).toHaveText(`${OWNER_NAME} already has 13 things to do that day.`);
      const last = (await page.locator('.day-task').last().boundingBox())!;
      await page.mouse.move(last.x + last.width * 0.9, last.y + last.height + 6);
      await expect(ghost(page)).toHaveCount(0);

      // 12 of 13 for the owner: one blank line, the add field's. Another device adds the 13th while the person is writing on it.
      await openDay(page, race);
      await expect(page.locator('.day-free')).toHaveCount(1);
      const p = await along(slot(page, 13), 0.1);
      await page.mouse.click(p.x, p.y);
      await expect(field(page, `New to-do for ${OWNER_NAME}`)).toBeFocused();
      expect((await owner.post(todo({ date: race, owners: [OWNER], title: 'Race 13' }))).status()).toBe(200);
      await field(page, `New to-do for ${OWNER_NAME}`).fill('One too many');
      await page.keyboard.press('Enter');
      const row = page.locator('.day-task.day-new');
      await expect(row.locator('.ip-error')).toHaveText(`${OWNER_NAME} already has 13 things to do that day.`);
      await expect(field(page, `New to-do for ${OWNER_NAME}`)).toHaveValue('One too many');
      expect((await storedTasks(owner, 'day', race)).filter((t: { title: string }) => t.title === 'One too many')).toHaveLength(0);
      await page.keyboard.press('Escape');
      await expect(page.locator('.day-new')).toHaveCount(0);
    } finally { await clearDay(owner, full); await clearDay(owner, race); await owner.dispose(); }
  });
});

// ---- the Week and the Month ----------------------------------------------------------------------------------------------

const PERIODS = [{ view: 'Week' as const, scope: 'week' as const, lines: 13, when: periodStart(farDate(360), 'week') }, { view: 'Month' as const, scope: 'month' as const, lines: 8, when: periodStart(farDate(361), 'month') }];
const wmLine = (page: Page, n: number) => page.locator(`ul.wm-todos[aria-label="To-do"] > li[data-slot="${n}"]`);

for (const { view, scope, lines, when } of PERIODS) {
  test.describe(`${view} to-do, desktop: the same thirds`, () => {
    test(`the hover per third and its color, a click makes the to-do for that person (one linked to-do for both), Escape gives the blank back`, async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER);
      try {
        await login(page);
        await page.getByRole('button', { name: view, exact: true }).click();
        await page.locator('#jump-date').fill(when);
        await expect(page.locator(`.wm-panel[data-panel="${scope}"]`)).toBeVisible();
        await expect(page.locator('ul.wm-todos[aria-label="To-do"] > li')).toHaveCount(lines);
        const line = wmLine(page, 4), box = (await line.boundingBox())!;
        const at = async (across: number) => { await page.mouse.move(box.x + box.width * across, box.y + box.height / 2); };
        await at(0.1);
        await expect(ghost(page)).toHaveAttribute('data-c', 'green');
        expect((await ghost(page).boundingBox())!.width).toBeLessThan(box.width * 0.55);
        await at(0.5);
        await expect(ghost(page)).toHaveAttribute('data-c', 'purple');
        expect((await ghost(page).boundingBox())!.width).toBeGreaterThan(box.width * 0.95);
        await at(0.9);
        await expect(ghost(page)).toHaveAttribute('data-c', 'yellow');
        expect((await ghost(page).boundingBox())!.x).toBeGreaterThan(box.x + box.width * 0.45);
        // The add line is cut too.
        const add = (await wmLine(page, 1).boundingBox())!;
        await page.mouse.move(add.x + add.width * 0.5, add.y + add.height / 2);
        await expect(ghost(page)).toHaveAttribute('data-c', 'purple');
        await away(page);
        await expect(ghost(page)).toHaveCount(0);

        // The middle: one to-do for both, in place on the line that was clicked.
        await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
        const fresh = field(page, `New to-do for ${OWNER_NAME} and ${PARTNER_NAME}`);
        await expect(fresh).toBeFocused();
        await noWindow(page);
        const row = page.locator('.wm-todo.wm-new');
        await expect(row).toHaveAttribute('data-c', 'purple');
        expect(Math.abs((await row.boundingBox())!.y - box.y)).toBeLessThanOrEqual(2);
        await fresh.fill('Together');
        await fresh.press('Enter');
        await expect(row).toHaveCount(0);
        const stored = await storedTasks(owner, scope, when);
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ title: 'Together', owners: [OWNER, PARTNER] });
        await expect(page.getByRole('button', { name: 'Edit Together', exact: true })).toBeFocused();
        for (const who of [OWNER_NAME, PARTNER_NAME]) {
          await pickList(page, who);
          await expect(page.getByRole('button', { name: 'Edit Together', exact: true })).toBeVisible();
        }
        await pickList(page, 'Both');

        // The outer thirds.
        const left = (await wmLine(page, 6).boundingBox())!;
        await page.mouse.click(left.x + left.width * 0.1, left.y + left.height / 2);
        await field(page, `New to-do for ${OWNER_NAME}`).fill('Mine');
        await page.keyboard.press('Enter');
        await expect(page.getByRole('button', { name: 'Edit Mine', exact: true })).toBeVisible();
        const right = (await wmLine(page, 7).boundingBox())!;
        await page.mouse.click(right.x + right.width * 0.9, right.y + right.height / 2);
        await field(page, `New to-do for ${PARTNER_NAME}`).fill('Hers');
        await page.keyboard.press('Enter');
        await expect(page.getByRole('button', { name: 'Edit Hers', exact: true })).toBeVisible();
        expect(await storedTasks(owner, scope, when)).toMatchObject([{ title: 'Together', owners: [OWNER, PARTNER] }, { title: 'Mine', owners: [OWNER] }, { title: 'Hers', owners: [PARTNER] }]);
        await expect(page.locator('.wm-todo[data-c=green] .wm-owner')).toHaveText(OWNER_NAME);
        await expect(page.locator('.wm-todo[data-c=yellow] .wm-owner')).toHaveText(PARTNER_NAME);
        await expect(page.locator('.wm-todo[data-c=purple] .wm-owner')).toHaveText('Both');

        // Escape: nothing saved, the blank is back and the keyboard is on the add field.
        const again = (await wmLine(page, 6).boundingBox())!;
        await page.mouse.click(again.x + again.width * 0.5, again.y + again.height / 2);
        await field(page, `New to-do for ${OWNER_NAME} and ${PARTNER_NAME}`).fill('Never saved');
        await page.keyboard.press('Escape');
        await expect(page.locator('.wm-new')).toHaveCount(0);
        await expect(wmLine(page, 6)).toHaveClass(/\bwm-free\b/);
        await expect(page.getByLabel('New to-do', { exact: true })).toBeFocused();
        expect(await storedTasks(owner, scope, when)).toHaveLength(3);
        // Shift+click on the add line's left third is both of us.
        const addLine = wmLine(page, 4);
        await expect(addLine).toHaveClass(/\bwm-free-add\b/);
        const abox = (await addLine.boundingBox())!;
        await addLine.click({ position: { x: abox.width * 0.1, y: abox.height / 2 }, modifiers: ['Shift'] });
        await expect(field(page, `New to-do for ${OWNER_NAME} and ${PARTNER_NAME}`)).toBeFocused();
        await page.keyboard.press('Escape');
        // The hidden button, and the add field as the keyboard's way (the linked to-do under Both).
        await expect(page.getByRole('button', { name: `Add to-do for ${OWNER_NAME} and ${PARTNER_NAME}`, exact: true })).toHaveAttribute('tabindex', '-1');
        await page.getByLabel('New to-do', { exact: true }).fill('From the keyboard');
        await page.getByLabel('New to-do', { exact: true }).press('Enter');
        await expect(page.getByRole('button', { name: 'Edit From the keyboard', exact: true })).toBeVisible();
        expect((await storedTasks(owner, scope, when)).find((t: { title: string }) => t.title === 'From the keyboard')).toMatchObject({ owners: [OWNER, PARTNER] });
      } finally { await clearPeriod(owner, scope, when); await owner.dispose(); }
    });

    test(`a click on the empty add field of the ${view} starts a to-do there and Enter hands the keyboard back to the field; it also leaves a to-do being edited, which is saved`, async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER);
      try {
        await login(page);
        await page.getByRole('button', { name: view, exact: true }).click();
        await page.locator('#jump-date').fill(when);
        await expect(page.locator(`.wm-panel[data-panel="${scope}"]`)).toBeVisible();
        await pickList(page, OWNER_NAME);
        const input = page.locator('[data-key="wm:add"]');
        await input.click();
        await expect(field(page, `New to-do for ${OWNER_NAME}`)).toBeFocused();
        await page.keyboard.type('Buy milk');
        await page.keyboard.press('Enter');
        await expect(input).toBeFocused();
        await expect(page.getByRole('button', { name: 'Edit Buy milk', exact: true })).toBeVisible();
        await page.keyboard.type('Call dentist', { delay: 70 });
        await page.keyboard.press('Enter');
        await expect(page.getByRole('button', { name: 'Edit Call dentist', exact: true })).toBeVisible();
        expect((await storedTasks(owner, scope, when)).map((t: { title: string }) => t.title)).toEqual(['Buy milk', 'Call dentist']);
        // A to-do with changed words is saved by the click, and the new editor opens (the row is not left as a dead field).
        await page.getByRole('button', { name: 'Edit Buy milk', exact: true }).click();
        await field(page, 'Edit to-do: Buy milk').fill('Buy oat milk');
        await input.click();
        await expect(field(page, `New to-do for ${OWNER_NAME}`)).toBeFocused();
        await expect(page.locator('[data-editing]')).toHaveCount(1);
        await expect(page.getByRole('button', { name: 'Edit Buy oat milk', exact: true })).toBeVisible();
        expect((await storedTasks(owner, scope, when)).map((t: { title: string }) => t.title)).toEqual(['Buy oat milk', 'Call dentist']);
        await page.keyboard.press('Escape');
        await expect(page.locator('.wm-new')).toHaveCount(0);
      } finally { await clearPeriod(owner, scope, when); await owner.dispose(); }
    });

    test(`one list alone has no thirds on the ${view}: the ghost and the click are that list`, async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER);
      try {
        await login(page);
        await page.getByRole('button', { name: view, exact: true }).click();
        await page.locator('#jump-date').fill(when);
        await expect(page.locator(`.wm-panel[data-panel="${scope}"]`)).toBeVisible();
        await pickList(page, PARTNER_NAME);
        const box = (await wmLine(page, 5).boundingBox())!;
        for (const across of [0.1, 0.5, 0.9]) {
          await page.mouse.move(box.x + box.width * across, box.y + box.height / 2);
          await expect(ghost(page)).toHaveAttribute('data-c', 'yellow');
          expect((await ghost(page).boundingBox())!.width).toBeGreaterThan(box.width * 0.95);
        }
        await expect(page.locator('button[data-both]')).toHaveCount(0);
        await page.mouse.click(box.x + box.width * 0.1, box.y + box.height / 2);
        await field(page, `New to-do for ${PARTNER_NAME}`).fill(`${PARTNER_NAME} alone`);
        await page.keyboard.press('Enter');
        await expect(page.getByRole('button', { name: `Edit ${PARTNER_NAME} alone`, exact: true })).toBeVisible();
        expect(await storedTasks(owner, scope, when)).toMatchObject([{ title: `${PARTNER_NAME} alone`, owners: [PARTNER] }]);
      } finally { await clearPeriod(owner, scope, when); await owner.dispose(); }
    });
  });
}
