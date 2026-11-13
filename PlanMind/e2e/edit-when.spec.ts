import { expect, test, type Page } from '@playwright/test';
import { THEMES, type ThemeName } from '../app/theme';
import { apiLogin, farDate, field, login, resetPrefs, showHalf, showTheme, textContrast, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// The span of an entry while it is edited ("7:30p – 8:30p"), a small pill above the block's top edge (below its bottom edge where the grid has
// no room above), in the owner's tone (the owner, 2026-11-02: "show start and end time as a small hover when editing a schedule item"). It takes no
// room, cannot be pressed, follows every change of the draft, and gives way to the drag's own bubble. Desktop project; the phone's is edit-when-phone.
const add = async (api: Api, body: Record<string, unknown>) => {
  const data = { id: crypto.randomUUID(), ...body };
  const response = await api.post(data);
  expect(response.status(), JSON.stringify(await response.json())).toBe(200);
  return data.id as string;
};
const event = (date: string, over: Record<string, unknown> = {}) => ({ action: 'add', kind: 'event', date, owners: [OWNER], text: 'Dentist', start: 540, length: 60, ...over });
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
const block = (page: Page, label: string) => page.getByRole('button', { name: label, exact: true });
const editing = (page: Page) => page.locator('.day-ev.day-editing');
const pill = (page: Page) => page.locator('.day-when');
const bubble = (page: Page) => page.locator('.day-bubble');
const gridBox = async (page: Page) => (await page.locator('.day-lanes').boundingBox())!;
const perMinute = async (page: Page) => {
  const minutes = await page.locator('.day-lanes').evaluate(el => Number((el as HTMLElement).dataset.span));
  return (await gridBox(page)).height / minutes;
};
const boxOf = async (locator: ReturnType<Page['locator']>) => (await locator.boundingBox())!;
/** The pill and the block being edited, as boxes: where the pill stands against the block and against the schedule. */
const where = async (page: Page) => {
  await expect(pill(page)).toBeVisible();
  const [p, b, g] = [await boxOf(pill(page)), await boxOf(editing(page)), await gridBox(page)];
  return { pill: p, block: b, grid: g, above: p.y + p.height <= b.y, below: p.y >= b.y + b.height, inside: p.x >= g.x && p.x + p.width <= g.x + g.width };
};

test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });

test.describe('the time pill of an entry being edited (desktop)', () => {
  test('it is above the block, clear of its words; below it where the grid has no room above; and it moves back above once there is room', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1800);
    await add(owner, event(date));
    await add(owner, event(date, { text: 'Early', start: 420, length: 60 }));
    await add(owner, event(date, { text: 'Late', start: 1230, length: 30, owners: [PARTNER] }));
    await add(owner, event(date, { text: 'Dinner', start: 1080, length: 60, owners: [OWNER, PARTNER] }));
    try {
      await login(page); await openDay(page, date);
      await expect(pill(page)).toHaveCount(0);
      // Nothing is edited: no pill. Dentist, in the owner's lane, mid-morning: above the block, over its middle, inside the schedule.
      await block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`).click();
      await expect(editing(page)).toHaveCount(1);
      await expect(pill(page)).toHaveText('9a – 10a');
      let at = await where(page);
      expect(at, 'above, inside the schedule').toMatchObject({ above: true, inside: true });
      expect(at.pill.y, 'inside the grid, not over the lane heads').toBeGreaterThanOrEqual(at.grid.y);
      expect(Math.abs(at.pill.x + at.pill.width / 2 - (at.block.x + at.block.width / 2)), 'over the middle of the block').toBeLessThanOrEqual(2);
      await page.keyboard.press('Escape');
      await expect(pill(page)).toHaveCount(0);
      // At 7a there is no room above the block inside the schedule: it goes below the bottom edge.
      await block(page, `Early, 7a to 8a, ${OWNER_NAME}`).click();
      at = await where(page);
      expect(at, 'below').toMatchObject({ below: true, inside: true });
      await expect(pill(page)).toHaveText('7a – 8a');
      // Moved down an hour with Alt+Arrow it has room above, and goes there; Alt+Up takes the entry back and the pill below again.
      for (let i = 0; i < 4; i++) { await page.keyboard.press('Alt+ArrowDown'); }
      await expect(pill(page)).toHaveText('8a – 9a');
      expect(await where(page), 'above once there is room').toMatchObject({ above: true, inside: true });
      for (let i = 0; i < 4; i++) { await page.keyboard.press('Alt+ArrowUp'); }
      await expect(pill(page)).toHaveText('7a – 8a');
      expect(await where(page)).toMatchObject({ below: true });
      await page.keyboard.press('Escape');
      // At the bottom of the page (8:30p to 9p, in the right lane) it is above, and in sight.
      await block(page, `Late, 8:30p to 9p, ${PARTNER_NAME}`).click();
      await expect(pill(page)).toHaveText('8:30p – 9p');
      expect(await where(page)).toMatchObject({ above: true, inside: true });
      await page.keyboard.press('Escape');
      // A Both entry is one block across both lanes: the pill stays over its middle, inside the schedule's width.
      await block(page, 'Dinner, 6p to 7p, Both').click();
      at = await where(page);
      expect(at).toMatchObject({ above: true, inside: true });
      expect(Math.abs(at.pill.x + at.pill.width / 2 - (at.block.x + at.block.width / 2))).toBeLessThanOrEqual(2);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the last rows of a page: an entry ending at 9p on AM and one ending at 7a on PM have their pill above them, in sight', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1801);
    await add(owner, event(date, { text: 'Close', start: 1230, length: 30 }));
    await add(owner, event(date, { text: 'Dawn', start: 1830, length: 30 }));
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      await block(page, `Close, 8:30p to 9p, ${OWNER_NAME}`).click();
      await expect(pill(page)).toHaveText('8:30p – 9p');
      let at = await where(page);
      expect(at).toMatchObject({ above: true, inside: true });
      expect(at.pill.y + at.pill.height, 'in sight').toBeLessThanOrEqual(page.viewportSize()!.height);
      await page.keyboard.press('Escape');
      await showHalf(page, 'pm');
      await block(page, `Dawn, 6:30a to 7a, ${OWNER_NAME}`).click();
      await expect(pill(page)).toHaveText('6:30a – 7a');
      at = await where(page);
      expect(at).toMatchObject({ above: true, inside: true });
      expect(at.pill.y + at.pill.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('it takes no room, cannot be pressed, is hidden from a screen reader, and is about 11px in the owner\'s tone', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1802);
    await add(owner, event(date));
    await add(owner, event(date, { text: 'Lunch', start: 720, owners: [PARTNER] }));
    try {
      await login(page); await openDay(page, date);
      const before = await page.evaluate(() => ({
        blocks: [...document.querySelectorAll('.day-ev')].map(el => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }),
        lanes: document.querySelector('.day-lanes')!.getBoundingClientRect().toJSON(), scroll: document.querySelector('#period-panel')!.scrollHeight,
      }));
      await block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`).click();
      await expect(pill(page)).toBeVisible();
      const after = await page.evaluate(() => ({
        blocks: [...document.querySelectorAll('.day-ev:not(.day-editing)')].map(el => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }),
        lanes: document.querySelector('.day-lanes')!.getBoundingClientRect().toJSON(), scroll: document.querySelector('#period-panel')!.scrollHeight,
      }));
      expect(after.lanes, 'the schedule did not move').toEqual(before.lanes);
      expect(after.scroll, 'the page did not grow').toBe(before.scroll);
      expect(after.blocks, 'no other entry moved').toEqual([before.blocks[1]]);
      const style = await pill(page).evaluate(el => { const c = getComputedStyle(el); return { position: c.position, events: c.pointerEvents, size: c.fontSize, hidden: el.getAttribute('aria-hidden'), tone: el.getAttribute('data-c') }; });
      expect(style).toMatchObject({ position: 'absolute', events: 'none', size: '11px', hidden: 'true' });
      expect(style.tone, `${OWNER_NAME}'s color`).toBe((await owner.snapshot()).lists.find((l: { id: string }) => l.id === OWNER).color);
      // A press at its middle goes through it: to what is under it.
      const p = await boxOf(pill(page));
      expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.day-when'), [p.x + p.width / 2, p.y + p.height / 2])).toBe(false);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('it follows the draft: the end grip, the start grip, Alt+Arrow and Alt+Shift+Arrow; a drag shows its own bubble and no pill, and the pill is back at the release', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1803);
    await add(owner, event(date));
    try {
      await login(page); await openDay(page, date);
      const minute = await perMinute(page);
      await block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`).click();
      await expect(pill(page)).toHaveText('9a – 10a');
      // Keys: Alt+Down moves it a quarter hour, Alt+Shift+Down makes it a quarter hour longer.
      await page.keyboard.press('Alt+ArrowDown');
      await expect(pill(page)).toHaveText('9:15a – 10:15a');
      await page.keyboard.press('Alt+Shift+ArrowDown');
      await expect(pill(page)).toHaveText('9:15a – 10:30a');
      await page.keyboard.press('Alt+Shift+ArrowUp');
      await page.keyboard.press('Alt+ArrowUp');
      await expect(pill(page)).toHaveText('9a – 10a');
      // The end grip: while it is dragged the bubble shows the span and the pill is not shown (no second label); at the release the pill says the new end.
      const end = await boxOf(page.locator('.day-handle[data-edge=end]'));
      await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2);
      await page.mouse.down();
      await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2 + 30 * minute, { steps: 12 });
      await expect(bubble(page)).toHaveText('9a – 10:30a');
      await expect(pill(page)).toBeHidden();
      await page.mouse.up();
      await expect(bubble(page)).toHaveCount(0);
      await expect(pill(page)).toBeVisible();
      await expect(pill(page)).toHaveText('9a – 10:30a');
      // The start grip.
      const start = await boxOf(page.locator('.day-handle[data-edge=start]'));
      await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
      await page.mouse.down();
      await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2 - 45 * minute, { steps: 12 });
      await expect(pill(page)).toBeHidden();
      await page.mouse.up();
      await expect(pill(page)).toHaveText('8:15a – 10:30a');
      // Dragging the block itself (its time label is the handle for the pointer): the bubble only, then the pill at the new place.
      const chip = await boxOf(page.locator('.day-ev.day-editing .day-ev-time'));
      await page.mouse.move(chip.x + chip.width / 2, chip.y + chip.height / 2);
      await page.mouse.down();
      await page.mouse.move(chip.x + chip.width / 2, chip.y + chip.height / 2 + 60 * minute, { steps: 12 });
      await expect(bubble(page)).toHaveText('9:15a – 11:30a');
      await expect(pill(page)).toBeHidden();
      // Escape puts the drag back and the pill with it.
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await expect(pill(page)).toHaveText('8:15a – 10:30a');
      expect(await where(page)).toMatchObject({ above: true });
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('another entry dragged while one is open for editing: the drag\'s bubble is the only time label, the pill is not shown until the release', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1804);
    await add(owner, event(date, { text: 'Walk', start: 600 }));
    await add(owner, event(date, { text: 'Lunch', start: 720, owners: [PARTNER] }));
    try {
      await login(page); await openDay(page, date);
      const minute = await perMinute(page);
      await block(page, `Lunch, 12p to 1p, ${PARTNER_NAME}`).click();
      await expect(editing(page)).toHaveCount(1);
      await expect(pill(page)).toHaveText('12p – 1p');
      const walk = await boxOf(block(page, `Walk, 10a to 11a, ${OWNER_NAME}`));
      const [x, y] = [walk.x + walk.width / 2, walk.y + walk.height / 2];
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + 30 * minute, { steps: 10 });
      await expect(bubble(page)).toHaveCount(1);
      await expect(page.locator('.day-when:not([hidden])'), 'no second time label').toHaveCount(0);
      await page.mouse.up();
      await expect(bubble(page)).toHaveCount(0);
      await expect(page.locator('.day-when:not([hidden])')).toHaveCount(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test(`its color is the owner's and reads AA in all four themes, for ${OWNER_NAME}, ${PARTNER_NAME} and Both`, async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1804);
    await add(owner, event(date, { text: 'Mine', start: 480 }));
    await add(owner, event(date, { text: 'Hers', start: 600, owners: [PARTNER] }));
    await add(owner, event(date, { text: 'Ours', start: 720, owners: [OWNER, PARTNER] }));
    try {
      await login(page); await openDay(page, date);
      for (const name of Object.keys(THEMES) as ThemeName[]) {
        await showTheme(page, name, { tints: true });
        for (const label of [`Mine, 8a to 9a, ${OWNER_NAME}`, `Hers, 10a to 11a, ${PARTNER_NAME}`, 'Ours, 12p to 1p, Both']) {
          await block(page, label).click();
          await expect(pill(page)).toBeVisible();
          const ratios = await textContrast(page, '.day-when');
          expect(ratios, name).toHaveLength(1);
          expect(ratios[0].ratio, `${name}: ${label}`).toBeGreaterThanOrEqual(4.5);
          await page.keyboard.press('Escape');
          await expect(pill(page)).toHaveCount(0);
        }
      }
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('it is gone with the edit: Escape, Enter and leaving the field; a saved move of the block shows the same span in the pill of the next edit', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1805);
    await add(owner, event(date));
    try {
      await login(page); await openDay(page, date);
      await block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`).click();
      await expect(pill(page)).toHaveCount(1);
      await page.keyboard.press('Alt+ArrowDown');
      await page.keyboard.press('Enter');
      await expect(editing(page)).toHaveCount(0);
      await expect(pill(page)).toHaveCount(0);
      await block(page, `Dentist, 9:15a to 10:15a, ${OWNER_NAME}`).click();
      await expect(pill(page)).toHaveText('9:15a – 10:15a');
      await field(page, 'Edit entry: Dentist').blur();
      await expect(editing(page)).toHaveCount(0);
      await expect(pill(page)).toHaveCount(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});
