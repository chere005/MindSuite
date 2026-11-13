import { expect, test, type Locator, type Page } from '@playwright/test';
import { SCHEDULE_ROWS } from '../packages/core/src/planner';
import { apiLogin, draftSpan, farDate, field, login, noWindow, resetPrefs, showHalf, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// The Day schedule has two pages behind the AM and PM switch on the Schedule heading's line. AM is the day as it always was, 7a to 9p (14 hour
// rows); PM is the night, 9p to 7a the next morning (ten rows, 9p, 10p, 11p, 12a ... 6a, at the same row height, drawn at the top of a grid box
// that keeps the AM's size). A planner day runs 7:00 to 7:00: an entry at 2a is stored on the date of the evening before and is on that date's PM
// page. The page opens on AM whatever the hour and the choice is kept while the page is open. The slots, the hover preview, the drags, the
// handles and the keyboard all work on the page that is shown, an entry across 9p is cut flat at the edge of each page, and a move that would
// take an entry wholly off the shown page is refused. Desktop project (1360x900); the phone's switch is in day-phone-half.spec.ts.
// Each test owns a block of far dates (1600 and up) and empties it again.
const add = async (api: Api, body: Record<string, unknown>) => {
  const data = { id: crypto.randomUUID(), ...body };
  const response = await api.post(data);
  expect(response.status(), JSON.stringify(await response.json())).toBe(200);
  return data.id as string;
};
const event = (date: string, over: Record<string, unknown> = {}) => ({ action: 'add', kind: 'event', date, owners: [OWNER], text: 'Dentist', start: 540, length: 60, ...over });
const day = (n: number) => farDate(1600 + n * 5);
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
const stored = async (api: Api, date: string) => (await api.snapshot()).events.filter((e: { date: string }) => e.date === date).sort((a: { start: number }, b: { start: number }) => a.start - b.start);
const gridBox = async (page: Page) => (await page.locator('.day-lanes').boundingBox())!;
/** Pixels of the grid for one minute: the box stands for data-span minutes (840) on both pages, so a PM row is as tall as an AM row. */
const perMinute = async (page: Page) => (await gridBox(page)).height / Number(await page.locator('.day-lanes').getAttribute('data-span'));
const rowHeights = (page: Page) => page.locator('.day-hours span').evaluateAll(spans => spans.map(s => s.getBoundingClientRect().height));
const AM_HOURS = SCHEDULE_ROWS.slice(0, 14), PM_HOURS = SCHEDULE_ROWS.slice(14);
const button = (page: Page, half: 'am' | 'pm') => page.locator(`.day-half button[data-half=${half}]`);
const editing = (page: Page) => page.locator('.day-ev.day-editing');
/** The start label of the entry being edited (the block holds only this, the title field and the two handles: no strip hangs over the schedule). */
const startLabel = (page: Page) => page.locator('.day-ev.day-editing[data-primary] .day-ev-time');
/** Nothing of the old strip is in the schedule: no span label, counter, hint, error or Delete in an event block. */
const noStrip = (page: Page) => expect(page.locator('.day-evs').locator('.day-ev-strip, .ip-span, .ip-count, .ip-hint, .ip-error, .ip-del')).toHaveCount(0);
/** What a failed or refused save of an entry says: once, in the shell's banner. */
const banner = (page: Page) => page.locator('#error');
const block = (page: Page, label: string) => page.getByRole('button', { name: label, exact: true });
const NEW = 'New entry';
const entry = (page: Page, stored?: string) => field(page, stored ? `Edit entry: ${stored}` : NEW);
const spanIs = (page: Page, start: number, length: number) => expect.poll(() => draftSpan(page)).toEqual({ start, length });
/** Puts a draft past the field's maxlength (typing and fill() stop at it): sets the value and tells the page, as a script would. */
const overLimit = (input: Locator, text: string) => input.evaluate((el, value) => { (el as HTMLInputElement).value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, text);
const nudge = async (input: Locator, key: string, times = 1) => { for (let i = 0; i < times; i++) { await input.press(key); } };
/** The Both view cuts a slot in thirds: the left lane's left edge and the right lane's far side are read as that lane, not as the middle third. */
const laneX = async (slot: Locator, width: number) => (await slot.getAttribute('data-lane')) === '1' ? width * 0.8 : 20;
/** Taps / hovers an hour row of a lane at `fraction` of its height (0 the top, 1 the bottom). */
async function tapSlot(page: Page, label: string, fraction: number) {
  const slot = page.getByRole('button', { name: label, exact: true });
  const box = (await slot.boundingBox())!;
  await slot.click({ position: { x: await laneX(slot, box.width), y: Math.min(box.height - 1, Math.max(1, box.height * fraction)) } });
}
async function hoverSlot(page: Page, label: string, fraction: number) {
  const slot = page.getByRole('button', { name: label, exact: true });
  const box = (await slot.boundingBox())!;
  await slot.hover({ position: { x: await laneX(slot, box.width), y: Math.min(box.height - 1, Math.max(1, box.height * fraction)) } });
}
/** Presses a handle (of the entry being edited), moves the pointer `minutes` along the grid, and leaves the button down. */
async function grab(page: Page, edge: 'start' | 'end', minutes: number) {
  const minute = await perMinute(page);
  const box = (await page.locator(`.day-ev.day-editing .day-handle[data-edge=${edge}]`).boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + minutes * minute, { steps: 8 });
}
/** A mouse drag of a block's middle in small steps, the button left down. */
async function pressAndMove(page: Page, from: { x: number; y: number }, dy: number, steps = 24) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(from.x, from.y + (dy * i) / steps); }
}
const centre = async (locator: Locator) => {
  await locator.scrollIntoViewIfNeeded();
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
/** The drop's write has been answered and the page has drawn the answer. */
const settled = async (page: Page) => {
  await expect(page.locator('#sync-status')).not.toHaveText('Saving…');
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
};
/** Nothing scrolls: not the page, not the panel's host. */
const fits = (page: Page) => page.evaluate(() => {
  const doc = document.scrollingElement!, host = document.querySelector('#period-panel')!;
  return { page: doc.scrollHeight - innerHeight, sideways: doc.scrollWidth - innerWidth, host: host.scrollHeight - host.clientHeight };
});

test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });

test.describe('Day schedule, desktop: the AM and PM switch', () => {
  test('the switch is a compact control at the right end of the Schedule heading\'s line, AM and PM, with AM pressed on first open', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(0);
    try {
      await login(page); await openDay(page, date);
      const group = page.getByRole('group', { name: 'Part of the day', exact: true });
      await expect(group).toHaveCount(1);
      await expect(group.getByRole('button')).toHaveText(['AM', 'PM']);
      await expect(button(page, 'am')).toHaveAttribute('aria-pressed', 'true');
      await expect(button(page, 'pm')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('.day-sched')).toHaveAttribute('data-half', 'am');
      // It is inside the heading's line (the Schedule label on the left, the switch on the right), and it is a small control, not a row of its own.
      const head = page.locator('.day-sched .day-sechead');
      await expect(head.getByRole('heading', { name: 'Schedule', exact: true })).toBeVisible();
      await expect(head.locator('.day-half')).toHaveCount(1);
      const [line, label, sw] = [(await head.boundingBox())!, (await head.getByRole('heading', { name: 'Schedule', exact: true }).boundingBox())!, (await group.boundingBox())!];
      expect(sw.x, 'on the right of the label').toBeGreaterThan(label.x + label.width);
      expect(Math.abs(sw.x + sw.width - (line.x + line.width)), 'at the right end of the line').toBeLessThanOrEqual(3);
      expect(Math.abs(sw.y + sw.height / 2 - (label.y + label.height / 2)), 'on the heading\'s own line').toBeLessThanOrEqual(4);
      expect(sw.height, 'compact').toBeLessThanOrEqual(34);
      for (const half of ['am', 'pm'] as const) {
        const box = (await button(page, half).boundingBox())!;
        expect(box.height, `${half} button`).toBeLessThanOrEqual(28);
        expect(box.height, `${half} button`).toBeGreaterThanOrEqual(18);
      }
      // Pressing PM presses only PM, and AM back presses only AM.
      await button(page, 'pm').click();
      await expect(button(page, 'pm')).toHaveAttribute('aria-pressed', 'true');
      await expect(button(page, 'am')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('.day-sched')).toHaveAttribute('data-half', 'pm');
      await button(page, 'am').click();
      await expect(button(page, 'am')).toHaveAttribute('aria-pressed', 'true');
      await noWindow(page);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the page always opens on AM, whatever the hour of the day, and again after a reload', async ({ page }) => {
    const date = day(1);
    // Today is `date`, late in the evening (11:30p in Chicago in daylight time, 10:30p otherwise): an hour that would once have chosen PM.
    await page.clock.install({ time: new Date(`${date}T23:30:00-05:00`) });
    await login(page);
    await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', date);
    await expect(button(page, 'am')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.day-hours span')).toHaveText(AM_HOURS);
    await showHalf(page, 'pm');
    await expect(page.locator('.day-hours span')).toHaveText(PM_HOURS);
    await page.reload();
    await expect(page.locator('#sidebar .date-row.selected')).toBeAttached();
    await expect(button(page, 'am')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.day-hours span')).toHaveText(AM_HOURS);
  });

  test('AM is the day as it was: 14 hour rows 7a to 8p, 420 / 1260 / 840, the same grid box, and blocks where they always sat', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(2);
    await add(owner, event(date, { text: 'Dentist', start: 540, length: 60 }));
    try {
      await login(page); await openDay(page, date);
      const first = await gridBox(page), firstFit = await fits(page);
      await expect(page.locator('.day-hours span')).toHaveText(AM_HOURS);
      const lanes = page.locator('.day-lanes');
      await expect(lanes).toHaveAttribute('data-from', '420');
      await expect(lanes).toHaveAttribute('data-to', '1260');
      await expect(lanes).toHaveAttribute('data-span', '840');
      // 14 rows of one height that add up to the grid; a slot for every one of them in each lane, named as always, and none for 9p.
      const heights = await rowHeights(page);
      expect(heights).toHaveLength(14);
      expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
      expect(Math.abs(heights.reduce((a, b) => a + b, 0) - first.height)).toBeLessThanOrEqual(2);
      await expect(page.locator('.day-slot[data-lane="0"]')).toHaveCount(14);
      await expect(page.locator('.day-slot[data-lane="1"]')).toHaveCount(14);
      await expect(page.getByRole('button', { name: `Add to ${OWNER_NAME} at 7a`, exact: true })).toHaveCount(1);
      await expect(page.getByRole('button', { name: `Add to ${PARTNER_NAME} at 8p`, exact: true })).toHaveCount(1);
      await expect(page.getByRole('button', { name: `Add to ${OWNER_NAME} at 9p`, exact: true })).toHaveCount(0);
      // 9:00 for an hour: two fourteenths down, one fourteenth tall.
      const dentist = (await block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`).boundingBox())!;
      expect(Math.abs(dentist.y - (first.y + (first.height * 2) / 14))).toBeLessThanOrEqual(4);
      expect(Math.abs(dentist.height - first.height / 14)).toBeLessThanOrEqual(4);
      // Choosing AM again, or going to PM and back, leaves the box exactly as big as it was.
      await showHalf(page, 'am');
      await showHalf(page, 'pm');
      await showHalf(page, 'am');
      const again = await gridBox(page);
      expect(Math.abs(again.height - first.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(again.width - first.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(again.y - first.y)).toBeLessThanOrEqual(1);
      expect(await fits(page)).toEqual(firstFit);
      expect(firstFit).toEqual({ page: 0, sideways: 0, host: 0 });
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('PM is the night: 9p to 6a, ten rows at the AM row height at the top of the same box, with no slots in the empty rest of it', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(3);
    try {
      await login(page); await openDay(page, date);
      const am = await gridBox(page), amRows = await rowHeights(page);
      await showHalf(page, 'pm');
      await expect(page.locator('.day-sched')).toHaveAttribute('data-half', 'pm');
      await expect(page.locator('.day-hours span')).toHaveText(['9p', '10p', '11p', '12a', '1a', '2a', '3a', '4a', '5a', '6a']);
      const lanes = page.locator('.day-lanes');
      await expect(lanes).toHaveAttribute('data-from', '1260');
      await expect(lanes).toHaveAttribute('data-to', '1860');
      await expect(lanes).toHaveAttribute('data-span', '840');
      // The box is the AM's; each of the ten rows is as tall as an AM row.
      const pm = await gridBox(page), rows = await rowHeights(page);
      expect(Math.abs(pm.height - am.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(pm.y - am.y)).toBeLessThanOrEqual(1);
      expect(rows).toHaveLength(10);
      for (const height of rows) { expect(Math.abs(height - amRows[0])).toBeLessThanOrEqual(1); }
      // The slots keep their names, ten in each lane, one row after the other from the top of the box; the hours of the other page do not exist.
      await expect(page.locator('.day-slot[data-lane="0"]')).toHaveCount(10);
      await expect(page.locator('.day-slot[data-lane="1"]')).toHaveCount(10);
      for (const hour of ['9p', '10p', '11p', '12a', '1a', '2a', '3a', '4a', '5a', '6a']) {
        await expect(page.getByRole('button', { name: `Add to ${OWNER_NAME} at ${hour}`, exact: true })).toHaveCount(1);
        await expect(page.getByRole('button', { name: `Add to ${PARTNER_NAME} at ${hour}`, exact: true })).toHaveCount(1);
      }
      for (const hour of ['8p', '7a', '12p', '8a']) { await expect(page.getByRole('button', { name: `Add to ${OWNER_NAME} at ${hour}`, exact: true })).toHaveCount(0); }
      const slots = [(await page.getByRole('button', { name: `Add to ${OWNER_NAME} at 9p`, exact: true }).boundingBox())!, (await page.getByRole('button', { name: `Add to ${OWNER_NAME} at 6a`, exact: true }).boundingBox())!];
      expect(Math.abs(slots[0].y - pm.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(slots[1].y + slots[1].height - (pm.y + 10 * amRows[0]))).toBeLessThanOrEqual(3);
      // Below the tenth row the box is empty (its last four rows): nothing there is a slot (or anything else the pointer could press).
      for (const row of [10.5, 12, 13.5]) {
        const below = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.day-slot, .day-ev, .day-hours span') ? 'something' : 'nothing', { x: pm.x + 40, y: pm.y + row * amRows[0] });
        expect(below, `row ${row}`).toBe('nothing');
      }
      expect(await fits(page)).toEqual({ page: 0, sideways: 0, host: 0 });
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the hover preview and a click start a half hour wholly on the page that is shown: 8:30p to 9p on AM, 9p to 9:30p on PM, 6:30a to 7a for the last half hour of the night', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(4);
    try {
      await login(page); await openDay(page, date);
      const preview = page.locator('.day-preview'), grid = await gridBox(page), hour = grid.height / 14;
      // AM: a tap at 8:45p starts the half hour it is in, 8:30p to 9p, which ends at the page's edge (the tap opens exactly the preview).
      await hoverSlot(page, `Add to ${OWNER_NAME} at 8p`, 0.9);
      await expect(preview).toHaveText('8:30p – 9p');
      await tapSlot(page, `Add to ${OWNER_NAME} at 8p`, 0.9);
      await expect(entry(page)).toBeFocused();
      await spanIs(page, 1230, 30);
      await expect(startLabel(page)).toHaveText('8:30p');
      await noStrip(page);
      await page.keyboard.press('Escape');
      await expect(editing(page)).toHaveCount(0);

      await showHalf(page, 'pm');
      // PM: the first half hour starts at 9p, drawn on the first row of the box.
      await hoverSlot(page, `Add to ${OWNER_NAME} at 9p`, 0.1);
      await expect(preview).toHaveText('9p – 9:30p');
      const box = (await preview.boundingBox())!;
      expect(Math.abs(box.height - hour / 2)).toBeLessThanOrEqual(4);
      expect(Math.abs(box.y - grid.y)).toBeLessThanOrEqual(4);
      expect(box.x + box.width).toBeLessThan(grid.x + grid.width / 2 + 2);
      await hoverSlot(page, `Add to ${OWNER_NAME} at 9p`, 0.6);
      await expect(preview).toHaveText('9:30p – 10p');
      // The latter half of the 10p row starts at 10:30p.
      await hoverSlot(page, `Add to ${PARTNER_NAME} at 10p`, 0.9);
      await expect(preview).toHaveText('10:30p – 11p');
      expect((await preview.boundingBox())!.x).toBeGreaterThan(grid.x + grid.width / 2 - 2);
      // Past midnight the hours are 12a, 1a ... in the same rows: 12a is the fourth row of the box.
      await hoverSlot(page, `Add to ${OWNER_NAME} at 12a`, 0.1);
      await expect(preview).toHaveText('12a – 12:30a');
      expect(Math.abs((await preview.boundingBox())!.y - ((await gridBox(page)).y + 3 * hour))).toBeLessThanOrEqual(4);
      await hoverSlot(page, `Add to ${OWNER_NAME} at 3a`, 0.6);
      await expect(preview).toHaveText('3:30a – 4a');
      expect(Math.abs((await preview.boundingBox())!.y - ((await gridBox(page)).y + 6.5 * hour))).toBeLessThanOrEqual(5);
      // The last half hour of the night: 6:30a to 7a. A pointer at 6:06a gets 6a to 6:30a, and one in the last quarter (6:45a) the half hour that ends at 7a.
      await hoverSlot(page, `Add to ${OWNER_NAME} at 6a`, 0.1);
      await expect(preview).toHaveText('6a – 6:30a');
      expect(Math.abs((await preview.boundingBox())!.y - ((await gridBox(page)).y + 9 * hour))).toBeLessThanOrEqual(4);
      await hoverSlot(page, `Add to ${OWNER_NAME} at 6a`, 0.9);
      await expect(preview).toHaveText('6:30a – 7a');
      expect(Math.abs((await preview.boundingBox())!.y - ((await gridBox(page)).y + 9.5 * hour))).toBeLessThanOrEqual(4);
      // A click makes exactly that entry, wholly on PM, and Enter writes it.
      await tapSlot(page, `Add to ${OWNER_NAME} at 6a`, 0.9);
      await expect(entry(page)).toBeFocused();
      await spanIs(page, 1830, 30);
      await expect(startLabel(page)).toHaveText('6:30a');
      await entry(page).fill('Early bird');
      await entry(page).press('Enter');
      await expect(editing(page)).toHaveCount(0);
      expect(await stored(owner, date)).toMatchObject([{ text: 'Early bird', owners: [OWNER], start: 1830, length: 30 }]);
      await expect(block(page, `Early bird, 6:30a to 7a, ${OWNER_NAME}`)).toBeVisible();
      // After midnight a tap in the 1a row of the partner's lane works the same way, and so does a click in the first row.
      await tapSlot(page, `Add to ${PARTNER_NAME} at 1a`, 0.1);
      await expect(entry(page)).toBeFocused();
      await spanIs(page, 1500, 30);
      await expect(startLabel(page)).toHaveText('1a');
      await page.keyboard.press('Escape');
      await expect(editing(page)).toHaveCount(0);
      await tapSlot(page, `Add to ${OWNER_NAME} at 9p`, 0.1);
      await spanIs(page, 1260, 30);
      await expect(entry(page)).toBeFocused();
      await noWindow(page);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the hidden Add schedule entry starts at 9a on AM and at 9p on PM', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(5);
    try {
      await login(page); await openDay(page, date);
      const addEntry = page.getByRole('button', { name: 'Add schedule entry', exact: true });
      await addEntry.focus();
      await page.keyboard.press('Enter');
      await expect(entry(page)).toBeFocused();
      await spanIs(page, 540, 30);
      await page.keyboard.press('Escape');
      await expect(editing(page)).toHaveCount(0);
      await showHalf(page, 'pm');
      await addEntry.focus();
      await page.keyboard.press('Enter');
      await expect(entry(page)).toBeFocused();
      await spanIs(page, 1260, 30);
      await expect(startLabel(page)).toHaveText('9p');
      await page.keyboard.press('Escape');
      await expect(editing(page)).toHaveCount(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the last free half hour of a page is a 30-minute entry that ends at the edge of the page: at 9p on AM, at 7a on PM', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(6);
    // The owner's lane is booked from 7a to 7a the next morning except a half hour at the end of each page (8:30p and 6:30a): a pointer there is on a free
    // slot, and the page's edge holds the entry to the half hour that is left, whatever is free on the other page.
    await add(owner, event(date, { text: 'Day', start: 420, length: 810 }));
    await add(owner, event(date, { text: 'Night', start: 1260, length: 570 }));
    try {
      await login(page); await openDay(page, date);
      const preview = page.locator('.day-preview');
      await hoverSlot(page, `Add to ${OWNER_NAME} at 8p`, 0.9);
      await expect(preview).toHaveText('8:30p – 9p');
      await tapSlot(page, `Add to ${OWNER_NAME} at 8p`, 0.9);
      await spanIs(page, 1230, 30);
      await page.keyboard.press('Escape');
      await expect(editing(page)).toHaveCount(0);
      await showHalf(page, 'pm');
      await hoverSlot(page, `Add to ${OWNER_NAME} at 6a`, 0.9);
      await expect(preview).toHaveText('6:30a – 7a');
      await tapSlot(page, `Add to ${OWNER_NAME} at 6a`, 0.9);
      await spanIs(page, 1830, 30);
      await page.keyboard.press('Escape');
      await expect(editing(page)).toHaveCount(0);
      // The partner's lane is free on both pages: the right third gives her the half hour the tap is in.
      await showHalf(page, 'am');
      await tapSlot(page, `Add to ${PARTNER_NAME} at 8p`, 0.9);
      await spanIs(page, 1230, 30);
      await page.keyboard.press('Escape');
      expect(await stored(owner, date)).toHaveLength(2);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('with no room left in a lane on the page, the middle third says so for both of us: before 9p on AM, after 9p on PM', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(44);
    // The owner's lane is booked from 7a to 7a the next morning, end to end. The middle third is one entry for both of us: a pointer over the partner's free side of it
    // is on a slot, but the owner's quarter there is taken and no start is free for both anywhere on the page.
    await add(owner, event(date, { text: 'Day', start: 420, length: 840 }));
    await add(owner, event(date, { text: 'Night', start: 1260, length: 600 }));
    try {
      await login(page); await openDay(page, date);
      const alert = page.getByRole('alert');
      const grid = await gridBox(page), slot = (await page.getByRole('button', { name: `Add to ${PARTNER_NAME} at 10a`, exact: true }).boundingBox())!;
      await page.mouse.move(grid.x + grid.width * 0.58, slot.y + slot.height * 0.1);
      await expect(page.locator('.day-preview')).toBeHidden();
      await page.mouse.click(grid.x + grid.width * 0.58, slot.y + slot.height * 0.1);
      await expect(alert).toContainText('There is no room left before 9p.');
      await expect(editing(page)).toHaveCount(0);
      await showHalf(page, 'pm');
      const slotPm = (await page.getByRole('button', { name: `Add to ${PARTNER_NAME} at 10p`, exact: true }).boundingBox())!;
      await page.mouse.click(grid.x + grid.width * 0.58, slotPm.y + slotPm.height * 0.1);
      await expect(alert).toContainText('There is no room left after 9p.');
      await expect(editing(page)).toHaveCount(0);
      // The partner's own lane is free: the right third starts her an entry, and the left third is the owner's full lane (it is his blocks there, not slots).
      await tapSlot(page, `Add to ${PARTNER_NAME} at 10p`, 0.1);
      await expect(editing(page)).toHaveAttribute('data-who', PARTNER_NAME);
      await spanIs(page, 1320, 30);
      expect(await stored(owner, date)).toHaveLength(2);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('an entry at 1a (start 1500, stored through the API) is on the PM page of its own date only, not on AM and not on the next date; one across midnight and one ending at 7a sit where their times say', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(14), next = farDate(1600 + 14 * 5 + 1);
    await add(owner, event(date, { text: 'Midnight', start: 1410, length: 60 }));
    await add(owner, event(date, { text: 'Owl', start: 1500, length: 60 }));
    await add(owner, event(date, { text: 'Dawn', start: 1830, length: 30 }));
    try {
      expect(await stored(owner, date)).toMatchObject([{ text: 'Midnight', start: 1410, length: 60 }, { text: 'Owl', start: 1500, length: 60 }, { text: 'Dawn', start: 1830, length: 30 }]);
      await login(page); await openDay(page, date);
      const grid = await gridBox(page), quarter = grid.height / 56;
      // AM has none of the night.
      await expect(page.locator('.day-ev')).toHaveCount(0);
      await showHalf(page, 'pm');
      await expect(page.locator('.day-ev')).toHaveCount(3);
      // Each is whole on the page (no cut edge), at the quarter-hour row its time says: 11:30p is the 11th quarter of the page, 1a the 17th, 6:30a the 39th.
      for (const [label, q, n] of [[`Midnight, 11:30p to 12:30a, ${OWNER_NAME}`, 11, 4], [`Owl, 1a to 2a, ${OWNER_NAME}`, 17, 4], [`Dawn, 6:30a to 7a, ${OWNER_NAME}`, 39, 2]] as const) {
        const one = block(page, label);
        await expect(one).toBeVisible();
        await expect(one).toHaveAttribute('data-clip', '');
        await expect(one).toHaveAttribute('data-q', String(q));
        await expect(one).toHaveAttribute('data-n', String(n));
        const box = (await one.boundingBox())!;
        expect(Math.abs(box.y - (grid.y + (q - 1) * quarter)), label).toBeLessThanOrEqual(4);
        expect(Math.abs(box.height - n * quarter), label).toBeLessThanOrEqual(4);
      }
      // The last entry of the night ends where the page does: 40 quarters down, ten hour rows, and the rest of the box is below it.
      const dawn = (await block(page, `Dawn, 6:30a to 7a, ${OWNER_NAME}`).boundingBox())!;
      expect(Math.abs(dawn.y + dawn.height - (grid.y + 40 * quarter))).toBeLessThanOrEqual(4);
      // The night after a date is that date's: the next date's PM page has nothing on it (and nor has its AM page).
      await openDay(page, next);
      await expect(button(page, 'pm')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.day-hours span')).toHaveText(PM_HOURS);
      await expect(page.locator('.day-ev')).toHaveCount(0);
      await showHalf(page, 'am');
      await expect(page.locator('.day-ev')).toHaveCount(0);
      await openDay(page, date);
      await expect(page.locator('.day-ev')).toHaveCount(0);
      await showHalf(page, 'pm');
      await expect(page.locator('.day-ev')).toHaveCount(3);
      // The entry that ends at 7a is a whole entry: both handles, and its real start in the block (nothing else hangs over the schedule).
      await block(page, `Dawn, 6:30a to 7a, ${OWNER_NAME}`).click();
      await expect(editing(page)).toHaveAttribute('data-clip', '');
      await expect(page.locator('.day-ev.day-editing .day-handle[data-edge=start]')).toBeVisible();
      await expect(page.locator('.day-ev.day-editing .day-handle[data-edge=end]')).toBeVisible();
      await spanIs(page, 1830, 30);
      await expect(startLabel(page)).toHaveText('6:30a');
      await noStrip(page);
      await entry(page, 'Dawn').press('Escape');
      await expect(editing(page)).toHaveCount(0);
      // Nothing was written by looking.
      expect(await stored(owner, date)).toMatchObject([{ text: 'Midnight', start: 1410, length: 60 }, { text: 'Owl', start: 1500, length: 60 }, { text: 'Dawn', start: 1830, length: 30 }]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('an entry at 8:30p to 9:30p is cut flat at 9p on each page, with no handle on the cut edge; one at 11:30p to 12a is on PM and not on AM', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(7);
    await add(owner, event(date, { text: 'Late', start: 1410, length: 30 }));
    await add(owner, event(date, { text: 'Cross', start: 1230, length: 60 }));
    try {
      expect(await stored(owner, date)).toMatchObject([{ text: 'Cross', start: 1230, length: 60 }, { text: 'Late', start: 1410, length: 30 }]);
      await login(page); await openDay(page, date);
      const grid = await gridBox(page), quarter = grid.height / 56;
      const cross = block(page, `Cross, 8:30p to 9:30p, ${OWNER_NAME}`), late = block(page, `Late, 11:30p to 12a, ${OWNER_NAME}`);
      // AM: Cross up to 9p (two quarters, the 55th and 56th, flat bottom), and Late is not drawn.
      await expect(cross).toBeVisible();
      await expect(late).toHaveCount(0);
      await expect(page.locator('.day-ev')).toHaveCount(1);
      await expect(cross).toHaveAttribute('data-clip', 'bottom');
      await expect(cross).toHaveAttribute('data-q', '55');
      await expect(cross).toHaveAttribute('data-n', '2');
      expect(await cross.evaluate(el => ({ bottom: getComputedStyle(el).borderBottomLeftRadius, top: getComputedStyle(el).borderTopLeftRadius }))).toMatchObject({ bottom: '0px', top: expect.not.stringMatching(/^0px$/) });
      let box = (await cross.boundingBox())!;
      expect(Math.abs(box.y + box.height - (grid.y + grid.height))).toBeLessThanOrEqual(3);
      expect(Math.abs(box.height - 2 * quarter)).toBeLessThanOrEqual(4);
      // Edited on AM it has its start handle and no end handle: its end is on the other page.
      await cross.click();
      await expect(editing(page)).toHaveCount(1);
      await expect(page.locator('.day-ev.day-editing .day-handle[data-edge=start]')).toBeVisible();
      await expect(page.locator('.day-ev.day-editing .day-handle[data-edge=end]')).toBeHidden();
      await expect(editing(page)).toHaveAttribute('data-clip', 'bottom');
      await spanIs(page, 1230, 30);
      await expect(startLabel(page)).toHaveText('8:30p');
      await entry(page, 'Cross').press('Escape');
      await expect(editing(page)).toHaveCount(0);

      // PM: Late whole (the 11th and 12th quarters of the page), Cross from 9p (flat top), both with their real times in the label.
      await showHalf(page, 'pm');
      await expect(late).toBeVisible();
      await expect(cross).toBeVisible();
      await expect(page.locator('.day-ev')).toHaveCount(2);
      await expect(late).toHaveAttribute('data-clip', '');
      await expect(late).toHaveAttribute('data-q', '11');
      await expect(late).toHaveAttribute('data-n', '2');
      await expect(cross).toHaveAttribute('data-clip', 'top');
      await expect(cross).toHaveAttribute('data-q', '1');
      await expect(cross).toHaveAttribute('data-n', '2');
      expect(await cross.evaluate(el => ({ bottom: getComputedStyle(el).borderBottomLeftRadius, top: getComputedStyle(el).borderTopLeftRadius }))).toMatchObject({ top: '0px', bottom: expect.not.stringMatching(/^0px$/) });
      box = (await cross.boundingBox())!;
      expect(Math.abs(box.y - grid.y)).toBeLessThanOrEqual(3);
      expect(Math.abs(box.height - 2 * quarter)).toBeLessThanOrEqual(4);
      box = (await late.boundingBox())!;
      expect(Math.abs(box.y - (grid.y + 10 * quarter))).toBeLessThanOrEqual(4);
      expect(Math.abs(box.height - 2 * quarter)).toBeLessThanOrEqual(4);
      await cross.click();
      await expect(editing(page)).toHaveCount(1);
      await expect(page.locator('.day-ev.day-editing .day-handle[data-edge=end]')).toBeVisible();
      await expect(page.locator('.day-ev.day-editing .day-handle[data-edge=start]')).toBeHidden();
      await expect(editing(page)).toHaveAttribute('data-clip', 'top');
      await entry(page, 'Cross').press('Escape');
      await expect(editing(page)).toHaveCount(0);
      // Late can be edited as a whole entry: both handles.
      await late.click();
      await expect(page.locator('.day-ev.day-editing .day-handle[data-edge=start]')).toBeVisible();
      await expect(page.locator('.day-ev.day-editing .day-handle[data-edge=end]')).toBeVisible();
      await entry(page, 'Late').press('Escape');
      await expect(editing(page)).toHaveCount(0);
      // Nothing was written by looking.
      expect(await stored(owner, date)).toMatchObject([{ text: 'Cross', start: 1230, length: 60 }, { text: 'Late', start: 1410, length: 30 }]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('Alt+Down on an AM entry at 8:30p to 9p stops once none of it is on the page, with the announcement; an edit and a stored block both; PM goes on to 7a', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(8);
    const id = await add(owner, event(date, { text: 'Late', start: 1230, length: 30 }));
    try {
      await login(page); await openDay(page, date);
      const live = page.locator('#live');
      // A stored block moved with the keyboard: a quarter hour later still has a quarter hour on AM (8:45p to 9:15p, cut at 9p), the next step would have none.
      await block(page, `Late, 8:30p to 9p, ${OWNER_NAME}`).focus();
      await page.keyboard.press('Alt+ArrowDown');
      await expect(block(page, `Late, 8:45p to 9:15p, ${OWNER_NAME}`)).toBeVisible();
      await expect.poll(async () => (await stored(owner, date))[0].start).toBe(1245);
      await expect(block(page, `Late, 8:45p to 9:15p, ${OWNER_NAME}`)).toHaveAttribute('data-clip', 'bottom');
      await block(page, `Late, 8:45p to 9:15p, ${OWNER_NAME}`).focus();
      await page.keyboard.press('Alt+ArrowDown');
      await expect(live).toContainText('Late cannot move later on this half of the day: switch to PM.');
      expect((await stored(owner, date))[0]).toMatchObject({ id, start: 1245, length: 30 });
      await expect(block(page, `Late, 8:45p to 9:15p, ${OWNER_NAME}`)).toBeVisible();

      // The same entry in an edit: the step is refused the same way and says what to do; the end of the entry can still be taken on past 9p.
      // The block has no span label any more: its start is in the block, and every step that is made is read out with the whole span.
      await block(page, `Late, 8:45p to 9:15p, ${OWNER_NAME}`).click();
      const input = entry(page, 'Late');
      await expect(input).toBeFocused();
      await expect(startLabel(page)).toHaveText('8:45p');
      await input.press('Alt+ArrowDown');
      await expect(live).toContainText('Cannot move later on this half of the day: switch to PM.');
      await expect(startLabel(page)).toHaveText('8:45p');
      await spanIs(page, 1245, 15);
      await input.press('Alt+ArrowUp');
      await expect(live).toHaveText('8:30p – 9p');
      await expect(startLabel(page)).toHaveText('8:30p');
      await spanIs(page, 1230, 30);
      await input.press('Alt+Shift+ArrowDown');
      await expect(live).toHaveText('8:30p – 9:15p');
      await nudge(input, 'Alt+Shift+ArrowDown', 3);
      await expect(live).toHaveText('8:30p – 10p');
      await expect(startLabel(page)).toHaveText('8:30p');
      await spanIs(page, 1230, 30);
      await input.press('Escape');
      await expect(editing(page)).toHaveCount(0);

      // PM: the stored block steps on to 9p; an edit goes on through the night to the end of the planner day, 7a, where it stops.
      await showHalf(page, 'pm');
      await block(page, `Late, 8:45p to 9:15p, ${OWNER_NAME}`).focus();
      await page.keyboard.press('Alt+ArrowDown');
      await expect(block(page, `Late, 9p to 9:30p, ${OWNER_NAME}`)).toBeVisible();
      await expect(block(page, `Late, 9p to 9:30p, ${OWNER_NAME}`)).toHaveAttribute('data-clip', '');
      await block(page, `Late, 9p to 9:30p, ${OWNER_NAME}`).click();
      await expect(input).toBeFocused();
      await nudge(input, 'Alt+ArrowDown', 10);
      await expect(live).toHaveText('11:30p – 12a');
      await expect(startLabel(page)).toHaveText('11:30p');
      // Past midnight it is the same entry of the same day: 12a, 1a ... up to 6:30a to 7a (38 steps from 9p).
      await nudge(input, 'Alt+ArrowDown', 28);
      await expect(live).toHaveText('6:30a – 7a');
      await expect(startLabel(page)).toHaveText('6:30a');
      await spanIs(page, 1830, 30);
      await input.press('Alt+ArrowDown');
      await expect(live).toContainText('at the end of the schedule');
      await input.press('Alt+Shift+ArrowDown');
      await expect(live).toContainText('Cannot make it longer.');
      await spanIs(page, 1830, 30);
      // The half-hour entry is already at the minimum.
      await input.press('Alt+Shift+ArrowUp');
      await expect(live).toContainText('Cannot make it shorter.');
      await spanIs(page, 1830, 30);
      await expect(startLabel(page)).toHaveText('6:30a');
      await input.press('Enter');
      await expect(editing(page)).toHaveCount(0);
      expect((await stored(owner, date))[0]).toMatchObject({ start: 1830, length: 30 });
      // On PM an entry that has gone back to 9p cannot step earlier once none of it would be on the page.
      await block(page, `Late, 6:30a to 7a, ${OWNER_NAME}`).click();
      await nudge(input, 'Alt+ArrowUp', 38);
      await expect(live).toHaveText('9p – 9:30p');
      await expect(startLabel(page)).toHaveText('9p');
      await input.press('Alt+ArrowUp');
      await expect(live).toHaveText('8:45p – 9:15p');
      await expect(startLabel(page)).toHaveText('8:45p');
      await input.press('Alt+ArrowUp');
      await expect(live).toContainText('Cannot move earlier on this half of the day: switch to AM.');
      await expect(startLabel(page)).toHaveText('8:45p');
      await spanIs(page, 1260, 15);
      await input.press('Escape');
      await expect(editing(page)).toHaveCount(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a resize that would leave none of the entry on the shown page is not made: an entry from 8:30p cannot be shortened to 9p on PM', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(9);
    await add(owner, event(date, { text: 'Cross', start: 1230, length: 60 }));
    try {
      await login(page); await openDay(page, date);
      await showHalf(page, 'pm');
      await block(page, `Cross, 8:30p to 9:30p, ${OWNER_NAME}`).click();
      const input = entry(page, 'Cross'), live = page.locator('#live');
      await expect(input).toBeFocused();
      await expect(startLabel(page)).toHaveText('8:30p');
      await input.press('Alt+Shift+ArrowUp');
      await expect(live).toHaveText('8:30p – 9:15p');
      await spanIs(page, 1260, 15);
      // 8:30p to 9p would be wholly on AM: the end stays where it is and the keyboard says it cannot.
      await input.press('Alt+Shift+ArrowUp');
      await expect(live).toContainText('Cannot make it shorter on this half of the day: switch to AM.');
      await expect(startLabel(page)).toHaveText('8:30p');
      await spanIs(page, 1260, 15);
      // Its end goes on through the night to 7a and no further.
      await nudge(input, 'Alt+Shift+ArrowDown', 39);
      await expect(live).toHaveText('8:30p – 7a');
      await spanIs(page, 1260, 600);
      await input.press('Alt+Shift+ArrowDown');
      await expect(live).toContainText('Cannot make it longer.');
      await expect(startLabel(page)).toHaveText('8:30p');
      await spanIs(page, 1260, 600);
      await input.press('Enter');
      await expect(editing(page)).toHaveCount(0);
      expect((await stored(owner, date))[0]).toMatchObject({ text: 'Cross', start: 1230, length: 630 });
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('in the Both view the schedule is cut in thirds on PM too, in the hours after midnight as well: the outer ones are the two lanes, the middle one is an entry for both', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(10);
    try {
      await login(page); await openDay(page, date);
      await showHalf(page, 'pm');
      const grid = await gridBox(page), preview = page.locator('.day-preview'), slot = page.getByRole('button', { name: `Add to ${OWNER_NAME} at 1a`, exact: true });
      const slotBox = (await slot.boundingBox())!;
      const at = async (third: number, hover = false) => {
        const x = grid.x + grid.width * third, y = slotBox.y + slotBox.height * 0.1;
        await page.mouse.move(x, y);
        if (!hover) { await page.mouse.click(x, y); }
      };
      await at(0.15, true);
      await expect(preview).toHaveText('1a – 1:30a');
      let box = (await preview.boundingBox())!;
      expect(box.x + box.width).toBeLessThan(grid.x + grid.width / 2 + 2);
      await at(0.85, true);
      box = (await preview.boundingBox())!;
      expect(box.x).toBeGreaterThan(grid.x + grid.width / 2 - 2);
      await at(0.4, true);
      expect((await preview.boundingBox())!.width).toBeGreaterThan(grid.width * 0.9);
      await at(0.6, true);
      expect((await preview.boundingBox())!.width).toBeGreaterThan(grid.width * 0.9);
      // The middle third makes one entry for both of us, wholly on PM; an outer third makes a lane entry.
      await at(0.5);
      await expect(entry(page)).toBeFocused();
      await expect(editing(page)).toHaveAttribute('data-who', 'Both');
      await noStrip(page);
      expect((await editing(page).boundingBox())!.width).toBeGreaterThan(grid.width * 0.9);
      await spanIs(page, 1500, 30);
      await entry(page).fill('Date night');
      await entry(page).press('Enter');
      await expect(editing(page)).toHaveCount(0);
      expect(await stored(owner, date)).toMatchObject([{ text: 'Date night', owners: [OWNER, PARTNER], start: 1500, length: 30 }]);
      await expect(block(page, 'Date night, 1a to 1:30a, Both')).toBeVisible();
      // It holds both lanes: a tap in the partner's lane at 12:45a (a half hour from there would run into it) goes to the half hour that is free and nearest, 12:30a to 1a.
      await tapSlot(page, `Add to ${PARTNER_NAME} at 12a`, 0.9);
      await expect(editing(page)).toHaveAttribute('data-who', PARTNER_NAME);
      await expect(entry(page)).toBeFocused();
      await spanIs(page, 1470, 30);
      await entry(page).fill('Yoga');
      await entry(page).press('Enter');
      await expect(editing(page)).toHaveCount(0);
      expect((await stored(owner, date)).find((e: { text: string }) => e.text === 'Yoga')).toMatchObject({ owners: [PARTNER], start: 1470, length: 30 });
      // None of it is on AM.
      await showHalf(page, 'am');
      await expect(page.locator('.day-ev')).toHaveCount(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a block dragged on PM follows the pointer in quarter hours and stays between 9p and 7a, never wholly off the page; the end handle stops at 7a and the start handle at 9p', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(11);
    await add(owner, event(date, { text: 'Drag', start: 1320, length: 60 }));
    try {
      await login(page); await openDay(page, date);
      await showHalf(page, 'pm');
      const bubble = page.locator('.day-bubble'), minute = await perMinute(page);
      // 45 minutes down: 10:45p to 11:45p.
      let from = await centre(block(page, `Drag, 10p to 11p, ${OWNER_NAME}`));
      await pressAndMove(page, from, 45 * minute);
      await expect(bubble).toHaveText('10:45p – 11:45p');
      await page.mouse.up();
      await settled(page);
      await expect(block(page, `Drag, 10:45p to 11:45p, ${OWNER_NAME}`)).toBeVisible();
      expect((await stored(owner, date))[0]).toMatchObject({ start: 1365, length: 60 });
      // Down through the empty rows of the box: the hour ends at 7a, not after it.
      from = await centre(block(page, `Drag, 10:45p to 11:45p, ${OWNER_NAME}`));
      await pressAndMove(page, from, 600 * minute);
      await expect(bubble).toHaveText('6a – 7a');
      await page.mouse.up();
      await settled(page);
      await expect(block(page, `Drag, 6a to 7a, ${OWNER_NAME}`)).toBeVisible();
      expect((await stored(owner, date))[0]).toMatchObject({ start: 1800, length: 60 });
      // Past midnight is the same page: a drag to the middle of the night lands on the quarter hour under the pointer.
      from = await centre(block(page, `Drag, 6a to 7a, ${OWNER_NAME}`));
      await pressAndMove(page, from, -300 * minute);
      await expect(bubble).toHaveText('1a – 2a');
      await page.mouse.up();
      await settled(page);
      await expect(block(page, `Drag, 1a to 2a, ${OWNER_NAME}`)).toBeVisible();
      expect((await stored(owner, date))[0]).toMatchObject({ start: 1500, length: 60 });
      // Up above the box: some of it is still on the page (the block is cut flat at 9p, 9:15p is where it ends) and the page is still PM.
      from = await centre(block(page, `Drag, 1a to 2a, ${OWNER_NAME}`));
      await pressAndMove(page, from, -(1530 - 1200) * minute);
      await expect(bubble).toHaveText('8:15p – 9:15p');
      await page.mouse.up();
      await settled(page);
      expect((await stored(owner, date))[0]).toMatchObject({ start: 1215, length: 60 });
      await expect(button(page, 'pm')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.day-ev')).toHaveCount(1);
      await expect(block(page, `Drag, 8:15p to 9:15p, ${OWNER_NAME}`)).toHaveAttribute('data-clip', 'top');

      // Handles, on an entry in an edit: the end handle pulled far below goes to 7a and stops, the start handle pulled far above stops at 9p.
      await clearDay(owner, date);
      await add(owner, event(date, { text: 'Handles', start: 1320, length: 60 }));
      await page.reload();
      await expect(page.locator('#sidebar .date-row.selected')).toBeAttached();
      await openDay(page, date);
      await showHalf(page, 'pm');
      await block(page, `Handles, 10p to 11p, ${OWNER_NAME}`).click();
      await expect(entry(page, 'Handles')).toBeFocused();
      await grab(page, 'end', 600);
      await expect(bubble).toHaveText('10p – 7a');
      await page.mouse.up();
      await spanIs(page, 1320, 540);
      await grab(page, 'start', -150);
      await expect(bubble).toHaveText('9p – 7a');
      await page.mouse.up();
      await spanIs(page, 1260, 600);
      await expect(startLabel(page)).toHaveText('9p');
      await entry(page, 'Handles').press('Enter');
      await expect(editing(page)).toHaveCount(0);
      expect((await stored(owner, date))[0]).toMatchObject({ text: 'Handles', start: 1260, length: 600 });
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('switching page with an entry being edited saves it first; one that cannot be saved yet keeps the page that has it', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(12);
    try {
      await login(page); await openDay(page, date);
      // A new entry with words on AM: PM saves it, and PM is drawn without it.
      await tapSlot(page, `Add to ${OWNER_NAME} at 10a`, 0.1);
      await expect(entry(page)).toBeFocused();
      await entry(page).fill('Meeting');
      await button(page, 'pm').click();
      await expect(button(page, 'pm')).toHaveAttribute('aria-pressed', 'true');
      await expect(editing(page)).toHaveCount(0);
      await expect(page.locator('.day-hours span')).toHaveText(PM_HOURS);
      await expect(page.locator('.day-ev')).toHaveCount(0);
      expect(await stored(owner, date)).toMatchObject([{ text: 'Meeting', start: 600, length: 30 }]);
      await showHalf(page, 'am');
      await expect(block(page, `Meeting, 10a to 10:30a, ${OWNER_NAME}`)).toBeVisible();

      // Changes to a stored entry go in the same save: its text and a quarter hour later.
      await block(page, `Meeting, 10a to 10:30a, ${OWNER_NAME}`).click();
      await entry(page, 'Meeting').fill('Meeting 2');
      await entry(page, 'Meeting').press('Alt+ArrowDown');
      await button(page, 'pm').click();
      await expect(editing(page)).toHaveCount(0);
      await expect(button(page, 'pm')).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(async () => (await stored(owner, date))[0]).toMatchObject({ text: 'Meeting 2', start: 615, length: 30 });

      // An entry that cannot be saved yet (more than 500 characters, the bound the server keeps) is not left: the page does not change away from it.
      await showHalf(page, 'am');
      await tapSlot(page, `Add to ${PARTNER_NAME} at 1p`, 0.1);
      await expect(entry(page)).toBeFocused();
      // The field stops typing at the limit (maxlength), so the draft is put past it by setting the value the way a paste of a script would.
      await expect(entry(page)).toHaveAttribute('maxlength', '500');
      await entry(page).fill('x'.repeat(501));
      await expect(entry(page)).toHaveValue('x'.repeat(500));
      await overLimit(entry(page), 'x'.repeat(501));
      await button(page, 'pm').click();
      await expect(editing(page)).toHaveCount(1);
      await expect(button(page, 'am')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.day-sched')).toHaveAttribute('data-half', 'am');
      await expect(page.locator('.day-hours span')).toHaveText(AM_HOURS);
      await expect(entry(page)).toHaveValue('x'.repeat(501));
      // The refusal is said once, in the shell's banner (not in the block, which has no room for it), and nothing hangs over the schedule.
      await expect(banner(page)).toBeVisible();
      await expect(banner(page)).toHaveAttribute('role', 'alert');
      await expect(page.locator('#error-message')).toHaveText('Keep it to 500 characters.');
      await noStrip(page);
      // Made valid, it can be left: the switch then goes through.
      await entry(page).fill('Lunch');
      // By the keyboard: the focus goes to the PM button and Enter presses it.
      await button(page, 'pm').focus();
      await page.keyboard.press('Enter');
      await expect(editing(page)).toHaveCount(0);
      await expect(button(page, 'pm')).toHaveAttribute('aria-pressed', 'true');
      expect((await stored(owner, date)).map((e: { text: string }) => e.text)).toEqual(['Meeting 2', 'Lunch']);
      // The same from PM: a new entry in the small hours is saved when AM is asked for, and AM is drawn without it.
      await tapSlot(page, `Add to ${OWNER_NAME} at 3a`, 0.1);
      await expect(entry(page)).toBeFocused();
      await spanIs(page, 1620, 30);
      await entry(page).fill('Nap');
      await button(page, 'am').click();
      await expect(button(page, 'am')).toHaveAttribute('aria-pressed', 'true');
      await expect(editing(page)).toHaveCount(0);
      await expect(page.locator('.day-hours span')).toHaveText(AM_HOURS);
      expect((await stored(owner, date)).map((e: { text: string }) => e.text)).toEqual(['Meeting 2', 'Lunch', 'Nap']);
      await expect(page.locator('.day-ev')).toHaveCount(2);
      await showHalf(page, 'pm');
      await expect(block(page, `Nap, 3a to 3:30a, ${OWNER_NAME}`)).toBeVisible();
      // An entry across 9p that is open on AM stays on the screen when PM is asked for: it is saved and PM draws its part from 9p.
      await add(owner, event(date, { text: 'Cross', owners: [PARTNER], start: 1230, length: 60 }));
      await page.reload();
      await expect(page.locator('#sidebar .date-row.selected')).toBeAttached();
      await openDay(page, date);
      await block(page, `Cross, 8:30p to 9:30p, ${PARTNER_NAME}`).click();
      await expect(editing(page)).toHaveCount(1);
      await button(page, 'pm').click();
      await expect(button(page, 'pm')).toHaveAttribute('aria-pressed', 'true');
      await expect(block(page, `Cross, 8:30p to 9:30p, ${PARTNER_NAME}`)).toHaveAttribute('data-clip', 'top');
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the choice is kept across day steps, views and redraws while the page is open', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(13), other = farDate(1600 + 13 * 5 + 1);
    await add(owner, event(date, { text: 'Owl', start: 1500, length: 60 }));
    try {
      await login(page); await openDay(page, date);
      await showHalf(page, 'pm');
      await expect(block(page, `Owl, 1a to 2a, ${OWNER_NAME}`)).toBeVisible();
      // Another day: still PM, and its schedule is the PM page.
      await openDay(page, other);
      await expect(button(page, 'pm')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.day-hours span')).toHaveText(PM_HOURS);
      await expect(page.locator('.day-lanes')).toHaveAttribute('data-from', '1260');
      await expect(page.locator('.day-lanes')).toHaveAttribute('data-to', '1860');
      // Back to the first day by the date list, and a redraw by a view round trip.
      await page.locator(`#sidebar .date-row[data-date="${date}"]`).click();
      await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', date);
      await expect(button(page, 'pm')).toHaveAttribute('aria-pressed', 'true');
      await expect(block(page, `Owl, 1a to 2a, ${OWNER_NAME}`)).toBeVisible();
      await page.locator('.view-switch button[data-view=week]').evaluate(el => (el as HTMLButtonElement).click());
      await expect(page.locator('.wm-panel')).toBeVisible();
      await page.locator('.view-switch button[data-view=day]').evaluate(el => (el as HTMLButtonElement).click());
      await expect(page.locator('.day-panel')).toBeVisible();
      await expect(button(page, 'pm')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.day-hours span')).toHaveText(PM_HOURS);
      // And AM is kept the same way.
      await showHalf(page, 'am');
      await openDay(page, other);
      await expect(button(page, 'am')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.day-hours span')).toHaveText(AM_HOURS);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});
