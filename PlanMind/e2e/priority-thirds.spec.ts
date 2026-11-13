import { expect, test, type Page } from '@playwright/test';
import { apiLogin, farDate, field, login, pickList, resetPrefs, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// Priorities in the Both view are cut in thirds across a blank line, as the schedule is: the outer thirds are the two lanes, the middle one
// is one priority for both of us (the linked one). The hover draws the cell a click would make, in the color of whoever it is for. A line
// where one lane already has a priority has no thirds (the blank half is that lane's alone). Desktop project; the phone is in
// priority-thirds-phone.spec.ts.
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
const storedPriorities = async (api: Api, date: string) => (await api.snapshot()).priorities.filter((p: { date: string }) => p.date === date);
const cells = (page: Page, line: number) => page.locator(`.day-prow[data-line="${line}"] .day-pcells`);

test.describe('Day priorities, desktop: thirds in the Both view', () => {
  test('the hover is the cell a click would make, in the color of who it is for: left lane, both, right lane', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(330);
    try {
      await login(page); await openDay(page, date);
      const row = cells(page, 2), ghost = page.locator('.day-newcell');
      const box = (await row.boundingBox())!;
      const at = async (across: number) => { await page.mouse.move(box.x + box.width * across, box.y + box.height / 2); };
      await expect(ghost).toHaveCount(0);
      // The owner is the left lane (you), the partner the right one; the middle third is Both's own color.
      await at(0.12);
      await expect(ghost).toHaveAttribute('data-c', 'green');
      let g = (await ghost.boundingBox())!;
      expect(g.x).toBeLessThan(box.x + 4);
      expect(g.width).toBeLessThan(box.width * 0.55);
      await at(0.5);
      await expect(ghost).toHaveAttribute('data-c', 'purple');
      g = (await ghost.boundingBox())!;
      expect(g.width).toBeGreaterThan(box.width * 0.95);
      await at(0.9);
      await expect(ghost).toHaveAttribute('data-c', 'yellow');
      g = (await ghost.boundingBox())!;
      expect(g.x).toBeGreaterThan(box.x + box.width * 0.45);
      // The blank cells keep their place (the ghost is not a grid item that pushes them to another row).
      await expect(page.getByRole('button', { name: `Add priority 2 for ${OWNER_NAME}`, exact: true })).toHaveCount(1);
      expect(Math.abs((await page.getByRole('button', { name: `Add priority 2 for ${PARTNER_NAME}`, exact: true }).boundingBox())!.y - box.y)).toBeLessThanOrEqual(4);
      // Leaving the row takes it away.
      await page.mouse.move(box.x - 20, box.y + box.height / 2);
      await expect(ghost).toHaveCount(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a click in the middle third makes one priority for both of us, saved on one line of both lists; an outer third is that lane alone', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(331);
    try {
      await login(page); await openDay(page, date);
      const row = cells(page, 2), box = (await row.boundingBox())!;
      // The exact middle is the gap between the two blank cells: it still counts.
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
      const fresh = field(page, `New priority 2 for ${OWNER_NAME} and ${PARTNER_NAME}`);
      await expect(fresh).toBeFocused();
      await expect(page.locator('.day-cell.day-editing')).toHaveAttribute('data-c', 'purple');
      expect((await page.locator('.day-cell.day-editing').boundingBox())!.width).toBeGreaterThan(box.width * 0.95);
      await fresh.fill('Family dinner');
      await fresh.press('Enter');
      await expect(page.locator('.day-cell.day-editing')).toHaveCount(0);
      expect(await storedPriorities(owner, date)).toMatchObject([{ text: 'Family dinner', owners: [OWNER, PARTNER], slots: { [PARTNER]: 2, [OWNER]: 2 } }]);
      const whole = page.getByRole('button', { name: 'Priority 2: Family dinner, Both', exact: true });
      await expect(whole).toHaveAttribute('data-c', 'purple');
      expect((await whole.boundingBox())!.width).toBeGreaterThan(box.width * 0.95);

      // An outer third is a priority for that lane alone: a click at 0.1 on line 3 is the owner's, one at 0.9 on line 4 is the partner's.
      const row3 = (await cells(page, 3).boundingBox())!, row4 = (await cells(page, 4).boundingBox())!;
      await page.mouse.click(row3.x + row3.width * 0.1, row3.y + row3.height / 2);
      await field(page, `New priority 3 for ${OWNER_NAME}`).fill('Run');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: `Priority 3: Run, ${OWNER_NAME}`, exact: true })).toBeVisible();
      await page.mouse.click(row4.x + row4.width * 0.9, row4.y + row4.height / 2);
      await field(page, `New priority 4 for ${PARTNER_NAME}`).fill('Yoga');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: `Priority 4: Yoga, ${PARTNER_NAME}`, exact: true })).toBeVisible();
      expect(await storedPriorities(owner, date)).toMatchObject([
        { text: 'Family dinner', owners: [OWNER, PARTNER] }, { text: 'Run', owners: [OWNER], slots: { [OWNER]: 3 } }, { text: 'Yoga', owners: [PARTNER], slots: { [PARTNER]: 4 } },
      ]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a line where one lane is taken has no thirds, Escape on a new priority for both gives both blank cells back, and the keyboard keeps its own lane', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(332);
    try {
      const response = await owner.post({ action: 'add', kind: 'priority', id: crypto.randomUUID(), date, owners: [OWNER], slots: { [OWNER]: 1 }, text: 'First thing' });
      expect(response.status()).toBe(200);
      await login(page); await openDay(page, date);
      // Line 1: the owner's lane is taken, so the partner's blank half is hers alone wherever the pointer is on it, and it is hovered as hers.
      const row1 = (await cells(page, 1).boundingBox())!;
      await page.mouse.move(row1.x + row1.width * 0.6, row1.y + row1.height / 2);
      await expect(page.locator('.day-newcell')).toHaveAttribute('data-c', 'yellow');
      expect((await page.locator('.day-newcell').boundingBox())!.width).toBeLessThan(row1.width * 0.55);
      await page.mouse.click(row1.x + row1.width * 0.6, row1.y + row1.height / 2);
      await expect(field(page, `New priority 1 for ${PARTNER_NAME}`)).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.locator('.day-cell.day-editing')).toHaveCount(0);
      await expect(page.getByRole('button', { name: `Add priority 1 for ${PARTNER_NAME}`, exact: true })).toBeVisible();
      // A new one for both, cancelled with Escape: both blank cells are back, and the keyboard is on the left one.
      const row2 = (await cells(page, 2).boundingBox())!;
      await page.mouse.click(row2.x + row2.width * 0.5, row2.y + row2.height / 2);
      await field(page, `New priority 2 for ${OWNER_NAME} and ${PARTNER_NAME}`).fill('Never saved');
      await page.keyboard.press('Escape');
      await expect(page.locator('.day-cell.day-editing')).toHaveCount(0);
      await expect(page.getByRole('button', { name: `Add priority 2 for ${OWNER_NAME}`, exact: true })).toBeFocused();
      await expect(page.getByRole('button', { name: `Add priority 2 for ${PARTNER_NAME}`, exact: true })).toBeVisible();
      expect(await storedPriorities(owner, date)).toHaveLength(1);
      // The keyboard has no pointer position: Enter on the right blank cell is the partner's, not the middle's.
      await page.getByRole('button', { name: `Add priority 3 for ${PARTNER_NAME}`, exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(field(page, `New priority 3 for ${PARTNER_NAME}`)).toBeFocused();
      await page.keyboard.press('Escape');
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a priority for both of us without a pointer in the middle third: Shift+Enter on a blank cell, and the hidden button a screen reader has; the ghost goes when the page scrolls under a resting pointer', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(335);
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', { name: `Add priority 2 for ${PARTNER_NAME}`, exact: true }).focus();
      await page.keyboard.press('Shift+Enter');
      await expect(field(page, `New priority 2 for ${OWNER_NAME} and ${PARTNER_NAME}`)).toBeFocused();
      await page.keyboard.type('Dinner');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Priority 2: Dinner, Both', exact: true })).toBeVisible();
      // The hidden button: out of the tab order, named for both of us, only on a line where both lanes are blank.
      const hidden = page.getByRole('button', { name: `Add priority 3 for ${OWNER_NAME} and ${PARTNER_NAME}`, exact: true });
      await expect(hidden).toHaveAttribute('tabindex', '-1');
      await expect(page.getByRole('button', { name: `Add priority 2 for ${OWNER_NAME} and ${PARTNER_NAME}`, exact: true })).toHaveCount(0);
      await hidden.dispatchEvent('click');
      await expect(field(page, `New priority 3 for ${OWNER_NAME} and ${PARTNER_NAME}`)).toBeFocused();
      await page.keyboard.press('Escape');
      expect(await storedPriorities(owner, date)).toMatchObject([{ text: 'Dinner', owners: [OWNER, PARTNER], slots: { [PARTNER]: 2, [OWNER]: 2 } }]);
      // A scroll of the panel under a resting pointer takes the ghost away.
      await expect(page.locator('.day-cell.day-editing')).toHaveCount(0);
      const row = (await cells(page, 4).boundingBox())!;
      await page.mouse.move(row.x + row.width * 0.4, row.y + row.height / 2);
      await page.mouse.move(row.x + row.width * 0.5, row.y + row.height / 2);
      await expect(page.locator('.day-newcell')).toHaveCount(1);
      await page.locator('#period-panel').evaluate(el => el.dispatchEvent(new Event('scroll')));
      await expect(page.locator('.day-newcell')).toHaveCount(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('one list alone has no thirds: the hover and the click are that list', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(333);
    try {
      await login(page); await openDay(page, date);
      await pickList(page, PARTNER_NAME);
      const row = (await cells(page, 2).boundingBox())!;
      await page.mouse.move(row.x + row.width * 0.5, row.y + row.height / 2);
      await expect(page.locator('.day-newcell')).toHaveAttribute('data-c', 'yellow');
      await page.mouse.click(row.x + row.width * 0.5, row.y + row.height / 2);
      await expect(field(page, `New priority 2 for ${PARTNER_NAME}`)).toBeFocused();
      await page.keyboard.press('Escape');
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});
