import { expect, test, type Locator, type Page } from '@playwright/test';
import { apiLogin, draftSpan, farDate, field, login, noWindow, pickList, resetPrefs, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// The schedule: adding by tapping a lane (half-hour slots), the half-hour default and the hover preview of it, the edit-mode start and end
// handles, the keyboard's quarter-hour steps, overlaps and stale writes. An entry is edited in its own block (its title is the only field
// there; the time and the length are set by dragging, never by a control): there is no window and nothing hangs over the schedule (no strip
// of controls: the title field stops at the 500-character limit, a refused or stale save is said once in the shell's banner, and deleting is a swipe
// then a tap, which swipe-delete.spec.ts covers in full). The shortest entry is 30 minutes; a long text fills its block, line by line, and
// ends in an ellipsis. Desktop project; the phone is in day-phone.spec.ts and dragging an entry is in drag.spec.ts.
test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });
const POLL = 13000;
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
const storedEvents = async (api: Api, date: string) => (await api.snapshot()).events.filter((e: { date: string }) => e.date === date);
const gridBox = async (page: Page) => (await page.locator('.day-lanes').boundingBox())!;
/** Presses a handle, moves the pointer `minutes` along the grid, and leaves the button down for the caller to look. */
async function grab(page: Page, edge: 'start' | 'end', minutes: number) {
  const grid = await gridBox(page);
  const box = (await page.locator(`.day-ev.day-editing .day-handle[data-edge=${edge}]`).boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + (minutes * grid.height) / 840, { steps: 8 });
}
/** Waits until the entry being edited has this span (minutes from midnight), as its block shows it. */
const spanIs = (page: Page, start: number, length: number) => expect.poll(() => draftSpan(page)).toEqual({ start, length });
/** Presses `key` on the title `times` times: a quarter hour each for Alt+Arrow (moves the entry) and Alt+Shift+Arrow (moves its end). */
const nudge = async (input: Locator, key: string, times = 1) => { for (let i = 0; i < times; i++) { await input.press(key); } };
/** The shell's banner: where a refused or stale save of an entry is said (once), now that its block has no room for a message. */
const banner = (page: Page) => page.locator('#error-message');
/** What used to hang over the schedule while an entry was edited (the strip, the span label, the counter, the hint, the message, the red-icon Delete) and is gone. */
const NOT_DRAWN = '.day-ev-strip, .day-ev .ip-span, .day-ev .ip-count, .day-ev .ip-hint, .day-ev .ip-error, .day-ev .ip-del';
const nothingHangs = (page: Page) => expect(page.locator(NOT_DRAWN)).toHaveCount(0);
/** A mouse swipe to the left on an entry's right part (28px or more, mostly sideways): turns the end of the block into its Delete. */
async function swipeLeft(page: Page, label: string, dx = 80) {
  const entry = page.getByRole('button', { name: label, exact: true });
  await entry.scrollIntoViewIfNeeded();
  const box = (await entry.boundingBox())!;
  const x = box.x + box.width - 14, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) { await page.mouse.move(x - (dx * i) / 12, y); }
  await page.mouse.up();
}
/**
 * Puts `text` in a title field past its maxlength, the one way an over-limit draft can still exist: set from code. Typing, pasting and
 * Playwright's own fill() (Chromium's insertText) all stop at maxlength, so none of them can make the draft that save has to refuse.
 */
const overfill = (input: Locator, text: string) => input.evaluate((el, value) => {
  const field = el as HTMLInputElement;
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}, text);
const NEW = 'New entry';
/** The entry being edited, new or stored: its title field is in the block. */
const entry = (page: Page, stored?: string) => field(page, stored ? `Edit entry: ${stored}` : NEW);
/** Taps an hour row of a lane at `fraction` of its height (0 the top, 1 the bottom). */
async function tapSlot(page: Page, label: string, fraction: number) {
  const slot = page.getByRole('button', { name: label, exact: true });
  const box = (await slot.boundingBox())!;
  await slot.click({ position: { x: await laneX(slot, box.width), y: Math.min(box.height - 1, Math.max(1, box.height * fraction)) } });
}
/** Where across a slot to point so the Both view reads it as that lane and not as the middle third (the left lane's left edge; the right lane's far side). */
const laneX = async (slot: Locator, width: number) => (await slot.getAttribute('data-lane')) === '1' ? width * 0.8 : 20;
/** Moves the pointer over an hour row of a lane at `fraction` of its height, without pressing. */
async function hoverSlot(page: Page, label: string, fraction: number) {
  const slot = page.getByRole('button', { name: label, exact: true });
  const box = (await slot.boundingBox())!;
  await slot.hover({ position: { x: await laneX(slot, box.width), y: Math.min(box.height - 1, Math.max(1, box.height * fraction)) } });
}
const addEntryButton = (page: Page) => page.getByRole('button', { name: 'Add schedule entry', exact: true });
const editing = (page: Page) => page.locator('.day-ev.day-editing');
/** Escape on the entry being edited, and the redraw that puts its block back. */
const dismiss = async (page: Page) => { await page.keyboard.press('Escape'); await expect(editing(page)).toHaveCount(0); };

test.describe('Schedule', () => {
  test('a tap on an empty slot while an entry is being edited only puts the edit away (and the keyboard): it does not also start another entry; the next tap does', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(301);
    try {
      await login(page); await openDay(page, date);
      // A new entry with words: the tap away saves it (as leaving it any other way does) and starts nothing.
      await tapSlot(page, `Add to ${OWNER_NAME} at 9a`, 0.1);
      await entry(page).fill('Away tap');
      await tapSlot(page, `Add to ${OWNER_NAME} at 1p`, 0.1);
      await expect(editing(page)).toHaveCount(0);
      await expect(page.locator('input:focus, textarea:focus')).toHaveCount(0);
      expect((await storedEvents(owner, date)).map((e: { text: string; start: number }) => [e.text, e.start])).toEqual([['Away tap', 540]]);
      // Nothing waits behind it: the pointer is still over the same slot, and the page stays quiet.
      await page.waitForTimeout(400);
      await expect(editing(page)).toHaveCount(0);
      expect(await storedEvents(owner, date)).toHaveLength(1);
      // A stored entry opened for editing: the same.
      await page.getByRole('button', { name: `Away tap, 9a to 9:30a, ${OWNER_NAME}`, exact: true }).click();
      await expect(entry(page, 'Away tap')).toBeFocused();
      await tapSlot(page, `Add to ${PARTNER_NAME} at 3p`, 0.1);
      await expect(editing(page)).toHaveCount(0);
      await page.waitForTimeout(400);
      await expect(editing(page)).toHaveCount(0);
      expect(await storedEvents(owner, date)).toHaveLength(1);
      // With nothing open, the very next tap starts an entry as before.
      await tapSlot(page, `Add to ${PARTNER_NAME} at 3p`, 0.1);
      await expect(entry(page)).toBeFocused();
      await spanIs(page, 900, 30);
      await dismiss(page);
    } finally { await clearDay(owner, date); }
  });

  test('a tap on a lane starts a half-hour entry for that lane, at the half hour the tap is in', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(300);
    try {
      await login(page); await openDay(page, date);
      // Each half of the hour row is its own start: 9:00 or 9:30. The block says the start.
      for (const [fraction, start, label] of [[0.1, 540, '9a'], [0.35, 540, '9a'], [0.6, 570, '9:30a'], [0.9, 570, '9:30a']] as const) {
        await tapSlot(page, `Add to ${OWNER_NAME} at 9a`, fraction);
        // The new entry is a block on the grid with its title field focused: no window opens, and nothing hangs over the schedule.
        await expect(entry(page)).toBeFocused();
        await noWindow(page);
        await nothingHangs(page);
        await spanIs(page, start, 30);
        await expect(editing(page).locator('.day-ev-time')).toHaveText(label);
        await dismiss(page);
        await expect(editing(page)).toHaveCount(0);
      }
      // The same in the first and the last row of the day, and in the partner's lane.
      await tapSlot(page, `Add to ${OWNER_NAME} at 7a`, 0.4); await expect(entry(page)).toBeFocused(); await spanIs(page, 420, 30); await dismiss(page);
      // A half hour from 8:30p ends at 9p, the page's edge, so the last row's entry fits there.
      await tapSlot(page, `Add to ${OWNER_NAME} at 8p`, 0.9); await expect(entry(page)).toBeFocused(); await spanIs(page, 1230, 30); await dismiss(page);
      await tapSlot(page, `Add to ${PARTNER_NAME} at 9a`, 0.35);
      // Who it is for is the lane that was tapped: there is no For control.
      await expect(entry(page)).toBeFocused();
      await expect(page.getByRole('radiogroup')).toHaveCount(0);
      await spanIs(page, 540, 30);
      // Enter with nothing typed drops the draft: nothing is written.
      await entry(page).press('Enter');
      await expect(editing(page)).toHaveCount(0);
      expect(await storedEvents(owner, date)).toHaveLength(0);
      await tapSlot(page, `Add to ${PARTNER_NAME} at 9a`, 0.35);
      await entry(page).fill('Yoga');
      await entry(page).press('Enter');
      await expect(editing(page)).toHaveCount(0);
      const stored = (await storedEvents(owner, date))[0];
      expect(stored).toMatchObject({ text: 'Yoga', owners: [PARTNER], start: 540, length: 30 });
      // On the grid: the right-hand lane, half an hour tall, and the keyboard is back on the block.
      const grid = await gridBox(page), yoga = page.getByRole('button', { name: `Yoga, 9a to 9:30a, ${PARTNER_NAME}`, exact: true }), block = (await yoga.boundingBox())!;
      await expect(yoga).toBeFocused();
      expect(block.x).toBeGreaterThan(grid.x + grid.width / 2 - 2);
      expect(Math.abs(block.height - grid.height / 28)).toBeLessThanOrEqual(4);
      // Taps are for the owner in his lane: a tap in the bottom half of the 11a row starts at 11:30.
      await tapSlot(page, `Add to ${OWNER_NAME} at 11a`, 0.9);
      await expect(entry(page)).toBeFocused();
      await spanIs(page, 690, 30);
      // Escape closes without writing.
      await dismiss(page);
      await expect(editing(page)).toHaveCount(0);
      expect(await storedEvents(owner, date)).toHaveLength(1);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a tap lands on the nearest free quarter hour when the quarter it is in is taken', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(311);
    await add(owner, event(date, { start: 540, length: 30 }));
    try {
      await login(page); await openDay(page, date);
      // 9:00 to 9:30 is taken. A tap in the 8a row's last quarter wants 8:45, and a half hour from there would run into it. The nearest
      // free start is 8:30 (a half hour ending as it begins); one in the 9a row's third quarter wants 9:30, which is free.
      await tapSlot(page, `Add to ${OWNER_NAME} at 8a`, 0.9);
      await spanIs(page, 510, 30);
      await expect(entry(page)).toBeFocused();
      await dismiss(page);
      await tapSlot(page, `Add to ${OWNER_NAME} at 9a`, 0.6);
      await spanIs(page, 570, 30);
      await expect(entry(page)).toBeFocused();
      await dismiss(page);
      // The partner's lane is empty at that time and takes the tapped quarter as it is.
      await tapSlot(page, `Add to ${PARTNER_NAME} at 9a`, 0.1);
      await spanIs(page, 540, 30);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the pointer over a lane shows the half hour a tap would give the new entry, drawn where it will go', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(312);
    await add(owner, event(date, { start: 540, length: 30 }));
    try {
      await login(page); await openDay(page, date);
      const preview = page.locator('.day-preview'), grid = await gridBox(page), hour = grid.height / 14;
      await expect(preview).toBeHidden();
      // The quarter the pointer is in is the start, and the default is a half hour: 11:00 to 11:30, in the owner's (left) lane.
      await hoverSlot(page, `Add to ${OWNER_NAME} at 11a`, 0.1);
      await expect(preview).toHaveText('11a – 11:30a');
      let box = (await preview.boundingBox())!;
      expect(Math.abs(box.height - hour / 2)).toBeLessThanOrEqual(4);
      expect(Math.abs(box.y - (grid.y + 4 * hour))).toBeLessThanOrEqual(4);
      expect(box.x + box.width).toBeLessThan(grid.x + grid.width / 2 + 2);
      // It follows the quarter hour, and the other lane.
      await hoverSlot(page, `Add to ${OWNER_NAME} at 11a`, 0.6);
      await expect(preview).toHaveText('11:30a – 12p');
      await hoverSlot(page, `Add to ${PARTNER_NAME} at 11a`, 0.6);
      box = (await preview.boundingBox())!;
      expect(box.x).toBeGreaterThan(grid.x + grid.width / 2 - 2);
      // 9:00 to 9:30 is taken in the owner's lane, so a half hour from 8:45 would run into it: the preview sits where the tap will put
      // the entry (8:30 to 9:00), not where the pointer is, and the tap then opens exactly that.
      await hoverSlot(page, `Add to ${OWNER_NAME} at 8a`, 0.9);
      await expect(preview).toHaveText('8:30a – 9a');
      await tapSlot(page, `Add to ${OWNER_NAME} at 8a`, 0.9);
      await spanIs(page, 510, 30);
      await expect(editing(page).locator('.day-ev-time')).toHaveText('8:30a');
      await dismiss(page);
      // Over a stored entry, or away from the grid, there is nothing to show.
      await page.getByRole('button', { name: `Dentist, 9a to 9:30a, ${OWNER_NAME}`, exact: true }).hover();
      await expect(preview).toBeHidden();
      await hoverSlot(page, `Add to ${OWNER_NAME} at 11a`, 0.1);
      await expect(preview).toBeVisible();
      await page.locator('#sidebar').hover();
      await expect(preview).toBeHidden();
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('in the Both view the schedule is cut in thirds: the outer ones are the two lanes, the middle one is an entry for both', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(315);
    try {
      await login(page); await openDay(page, date);
      const grid = await gridBox(page), preview = page.locator('.day-preview'), slot = page.getByRole('button', { name: `Add to ${OWNER_NAME} at 11a`, exact: true });
      const slotBox = (await slot.boundingBox())!;
      const at = async (third: number, hover = false) => {
        const x = grid.x + grid.width * third, y = slotBox.y + slotBox.height * 0.1;
        await page.mouse.move(x, y);
        if (!hover) { await page.mouse.click(x, y); }
      };
      // The hover says what a tap will make: one lane in an outer third, both lanes in the middle one.
      await at(0.15, true);
      await expect(preview).toHaveText('11a – 11:30a');
      // It wears the color of whoever the entry will be for: the owner's, the partner's, or Both's.
      await expect(preview).toHaveAttribute('data-c', 'green');
      let box = (await preview.boundingBox())!;
      expect(box.x + box.width).toBeLessThan(grid.x + grid.width / 2 + 2);
      await at(0.85, true);
      await expect(preview).toHaveAttribute('data-c', 'yellow');
      box = (await preview.boundingBox())!;
      expect(box.x).toBeGreaterThan(grid.x + grid.width / 2 - 2);
      await at(0.4, true);
      await expect(preview).toHaveAttribute('data-c', 'purple');
      box = (await preview.boundingBox())!;
      expect(box.width).toBeGreaterThan(grid.width * 0.9);
      await at(0.6, true);
      expect((await preview.boundingBox())!.width).toBeGreaterThan(grid.width * 0.9);
      // The middle third makes one entry for both of us (it shows in both lists, over both lanes); an outer third makes a lane entry.
      await at(0.5);
      await expect(entry(page)).toBeFocused();
      // (The block no longer says "Shows on the owner's and the partner's lists."; it is the Both entry that spans both lanes.)
      await expect(editing(page)).toHaveAttribute('data-who', 'Both');
      expect((await editing(page).boundingBox())!.width).toBeGreaterThan(grid.width * 0.9);
      await entry(page).fill('Date night');
      await entry(page).press('Enter');
      await expect(editing(page)).toHaveCount(0);
      expect(await storedEvents(owner, date)).toMatchObject([{ text: 'Date night', owners: [OWNER, PARTNER], start: 660, length: 30 }]);
      // It holds both lanes, so a lane tap at 10:45 (a half hour from there would run into it) is moved clear of it, and each outer third is that lane alone.
      await page.getByRole('button', { name: 'Date night, 11a to 11:30a, Both', exact: true }).waitFor();
      await tapSlot(page, `Add to ${PARTNER_NAME} at 10a`, 0.9);
      await expect(editing(page)).toHaveAttribute('data-who', PARTNER_NAME);
      await expect(entry(page)).toBeFocused();
      await spanIs(page, 630, 30);
      await entry(page).fill('Yoga');
      await entry(page).press('Enter');
      await expect(editing(page)).toHaveCount(0);
      expect((await storedEvents(owner, date)).find((e: { text: string }) => e.text === 'Yoga')).toMatchObject({ owners: [PARTNER], start: 630, length: 30 });
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the preview keeps clear of the entry being edited, at the span its draft has now', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(313);
    try {
      await login(page); await openDay(page, date);
      const preview = page.locator('.day-preview');
      // The draft is moved to 10:15 to 10:45 (one quarter hour up from the tap's 10:30). With no words it is dropped when the focus leaves it,
      // so it does not count: the half hour at a pointer in the 10a row's first quarter is 10:00 to 10:30.
      await tapSlot(page, `Add to ${OWNER_NAME} at 10a`, 0.6);
      await expect(entry(page)).toBeFocused();
      await nudge(entry(page), 'Alt+ArrowUp');
      await spanIs(page, 615, 30);
      await hoverSlot(page, `Add to ${OWNER_NAME} at 10a`, 0.9);
      await hoverSlot(page, `Add to ${OWNER_NAME} at 10a`, 0.1);
      await expect(preview).toHaveText('10a – 10:30a');
      // With words it will be saved, so it holds 10:15 to 10:45 and the half hour that fits nearest the pointer ends where it begins.
      await entry(page).fill('Lunch');
      await hoverSlot(page, `Add to ${OWNER_NAME} at 10a`, 0.9);
      await hoverSlot(page, `Add to ${OWNER_NAME} at 10a`, 0.1);
      await expect(preview).toHaveText('9:45a – 10:15a');
      // Its draft span, not what is stored: moved to 12:15p with the keyboard (eight quarter hours), 10:00 is free again.
      await nudge(entry(page), 'Alt+ArrowDown', 8);
      await spanIs(page, 735, 30);
      await hoverSlot(page, `Add to ${OWNER_NAME} at 10a`, 0.9);
      await hoverSlot(page, `Add to ${OWNER_NAME} at 10a`, 0.1);
      await expect(preview).toHaveText('10a – 10:30a');
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('in a gap of exactly half an hour the entry is that half hour, and the preview says so', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(314);
    // An hour booked, then half an hour free, all day (the last two hours are booked end to end): every gap is 30 minutes.
    for (const start of [420, 510, 600, 690, 780, 870, 960, 1050, 1140, 1200]) { await add(owner, event(date, { start, length: 60 })); }
    try {
      await login(page); await openDay(page, date);
      const preview = page.locator('.day-preview');
      await hoverSlot(page, `Add to ${OWNER_NAME} at 8a`, 0.1);
      await expect(preview).toHaveText('8a – 8:30a');
      await tapSlot(page, `Add to ${OWNER_NAME} at 8a`, 0.1);
      await expect(entry(page)).toBeFocused();
      await spanIs(page, 480, 30);
      await dismiss(page);
      // The partner's lane is empty and gives the same half hour: the default is never longer.
      await hoverSlot(page, `Add to ${PARTNER_NAME} at 8a`, 0.1);
      await expect(preview).toHaveText('8a – 8:30a');
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a 15-minute gap cannot create a preview or a new appointment', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(316);
    // Leave a 15-minute gap at 8:45 and a longer one elsewhere. A pointer in the tiny gap must not jump to that longer gap.
    for (let start = 420; start < 1260; start += 60) {
      if (start !== 600) { await add(owner, event(date, { text: 'Booked', owners: [PARTNER], start, length: 45 })); }
    }
    try {
      await login(page); await openDay(page, date);
      // The pointer is in the 8:45–9:00 gap, and no 30-minute span fits in this lane.
      await hoverSlot(page, `Add to ${PARTNER_NAME} at 8a`, 0.9);
      await expect(page.locator('.day-preview')).toHaveCount(0);
      await tapSlot(page, `Add to ${PARTNER_NAME} at 8a`, 0.9);
      await expect(editing(page)).toHaveCount(0);
      await expect(banner(page)).toContainText('no room');
      // The owner's lane is empty and gives its half hour.
      await tapSlot(page, `Add to ${OWNER_NAME} at 8a`, 0.1);
      await spanIs(page, 480, 30);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  /** The owner's screenshot of 2026-11-02: his lane, the partner's work, and what the two of us share. The owner's last entry starts at `flash` and ends at 9p. */
  const screenshotDay = async (api: Api, date: string, flash: number) => {
    const both = [OWNER, PARTNER];
    for (const [text, start, length] of [['Tabular', 540, 60], ['Tech Check', 600, 30], ['Make profile', 630, 30], ['AI Products', 690, 60], ['Potential Lunch Break', 780, 30], ['League', 810, 315], ['Flash game fun', flash, 1260 - flash]] as const) {
      await add(api, event(date, { text, start, length }));
    }
    await add(api, event(date, { text: 'Work', owners: [PARTNER], start: 510, length: 480 }));
    await add(api, event(date, { text: 'Breakfast', owners: both, start: 450, length: 60 }));
    await add(api, event(date, { text: 'Dinner', owners: both, start: 1125, length: 45 }));
  };
  /** Where to point on an hour row of the schedule: `across` the grid's width (a third's worth is 1/3), `fraction` down the row. */
  const pointAt = async (page: Page, label: string, across: number, fraction: number) => {
    const slot = page.getByRole('button', { name: label, exact: true });
    await slot.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const box = (await slot.boundingBox())!, grid = await gridBox(page);
    return { x: grid.x + grid.width * across, y: box.y + box.height * fraction };
  };

  test(`a new entry fits where the pointer is: the middle third at 7:35p gets the half hour both of us have free, and a busy ${OWNER_NAME} from 7:45p leaves a quarter hour`, async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(317), later = farDate(318);
    await screenshotDay(owner, date, 1200);
    await screenshotDay(owner, later, 1185);
    try {
      await login(page); await openDay(page, date);
      const preview = page.locator('.day-preview'), grid = await gridBox(page);
      const hover = async (across: number, label = `Add to ${OWNER_NAME} at 7p`, fraction = 35 / 60) => {
        const { x, y } = await pointAt(page, label, across, fraction);
        await page.mouse.move(x, y);
        return { x, y };
      };
      // The red X: 7:35p in the middle third. Both lanes are free from 7:30p to 8p (Dinner ends at 7:30p, the owner's Flash game fun starts at 8p): the half hour, for both.
      await hover(0.5);
      await expect(preview).toHaveText('7:30p – 8p');
      await expect(preview).toHaveAttribute('data-c', 'purple');
      expect((await preview.boundingBox())!.width).toBeGreaterThan(grid.width * 0.9);
      // The same pointer in the owner's lane third: the same gap, and it is his alone. In the partner's, her lane is free to 9p, but the default is still the half hour from 7:30p.
      await hover(0.15);
      await expect(preview).toHaveText('7:30p – 8p');
      await expect(preview).toHaveAttribute('data-c', 'green');
      await hover(0.85);
      await expect(preview).toHaveText('7:30p – 8p');
      await expect(preview).toHaveAttribute('data-c', 'yellow');
      // The pointer's quarter taken in one lane (the owner is in League at 6p; the middle third's right half is over the partner's free lane): the nearest free start for both of us, the same half hour.
      await hover(0.55, `Add to ${PARTNER_NAME} at 6p`, 0.1);
      await expect(preview).toHaveText('7:30p – 8p');
      let at = await pointAt(page, `Add to ${PARTNER_NAME} at 6p`, 0.55, 0.1);
      await page.mouse.click(at.x, at.y);
      await expect(entry(page)).toBeFocused();
      await expect(editing(page)).toHaveAttribute('data-who', 'Both');
      await spanIs(page, 1170, 30);
      await dismiss(page);
      // The click makes what the hover showed, for both of us.
      at = await hover(0.5);
      await expect(preview).toHaveText('7:30p – 8p');
      await page.mouse.click(at.x, at.y);
      await expect(entry(page)).toBeFocused();
      await expect(editing(page)).toHaveAttribute('data-who', 'Both');
      await spanIs(page, 1170, 30);
      await entry(page).fill('Game night');
      await entry(page).press('Enter');
      await expect(editing(page)).toHaveCount(0);
      expect((await storedEvents(owner, date)).find((e: { text: string }) => e.text === 'Game night')).toMatchObject({ owners: [OWNER, PARTNER], start: 1170, length: 30 });
      // The remaining 15 minutes are too short for a new appointment for both.
      await openDay(page, later);
      const tooShort = await hover(0.5);
      await expect(preview).toHaveCount(0);
      await page.mouse.click(tooShort.x, tooShort.y);
      await expect(editing(page)).toHaveCount(0);
      await expect(banner(page)).toContainText('no room');
    } finally { await clearDay(owner, date); await clearDay(owner, later); await owner.dispose(); }
  });

  test('500 characters for an entry in a lane and for one across both: the field stops typing at the limit, 500 are saved whole, and a longer draft is refused in the banner', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(301);
    try {
      await login(page); await openDay(page, date);
      await tapSlot(page, `Add to ${OWNER_NAME} at 8a`, 0.1);
      const input = entry(page);
      // The field itself stops at the limit (there is no counter): with 499 characters in it, typing three more leaves 500.
      await expect(input).toHaveAttribute('maxlength', '500');
      await input.fill('a'.repeat(499));
      await input.pressSequentially('bcd');
      await expect(input).toHaveValue('a'.repeat(499) + 'b');
      await nothingHangs(page);
      // fill() stops at maxlength too, so a longer draft is set from code: Enter does not write it, the words go to the banner (and are read out), and the text stays.
      await input.fill('a'.repeat(501));
      await expect(input).toHaveValue('a'.repeat(500));
      await overfill(input, 'a'.repeat(501));
      await input.press('Enter');
      await expect(banner(page)).toHaveText('Keep it to 500 characters.');
      await expect(page.getByRole('alert')).toContainText('Keep it to 500 characters.');
      await expect(input).toHaveValue('a'.repeat(501));
      expect(await storedEvents(owner, date)).toHaveLength(0);
      await nothingHangs(page);
      // 500 is the limit, not 18: it is written whole, and its block is a half hour like any other (the words are cut to the lines the block holds, not the block grown).
      await input.fill('a'.repeat(500));
      await input.press('Enter');
      await expect(editing(page)).toHaveCount(0);
      await expect(page.locator('#error')).toBeHidden();
      expect(await storedEvents(owner, date)).toMatchObject([{ text: 'a'.repeat(500), owners: [OWNER], start: 480, length: 30 }]);
      const grid = await gridBox(page), block = (await page.locator('.day-ev:not(.day-editing)').boundingBox())!;
      expect(Math.abs(block.height - grid.height / 28)).toBeLessThanOrEqual(4);
      // The Add button under the Both view makes an entry for both of us, and its text may be 500 long too (it was twice a lane's before).
      await addEntryButton(page).focus();
      await page.keyboard.press('Enter');
      await expect(input).toBeFocused();
      await expect(editing(page)).toHaveAttribute('data-who', 'Both');
      await expect(input).toHaveAttribute('maxlength', '500');
      await input.fill('b'.repeat(499));
      await input.pressSequentially('cde');
      await expect(input).toHaveValue('b'.repeat(499) + 'c');
      await overfill(input, 'b'.repeat(501));
      await input.press('Enter');
      await expect(banner(page)).toHaveText('Keep it to 500 characters.');
      await expect(input).toHaveValue('b'.repeat(501));
      await input.fill('b'.repeat(500));
      await input.press('Enter');
      await expect(editing(page)).toHaveCount(0);
      // The write clears the banner.
      await expect(page.locator('#error')).toBeHidden();
      expect((await storedEvents(owner, date)).sort((x: { start: number }, y: { start: number }) => x.start - y.start)).toMatchObject([
        { text: 'a'.repeat(500), owners: [OWNER], start: 480, length: 30 },
        { text: 'b'.repeat(500), owners: [OWNER, PARTNER], start: 540, length: 30 },
      ]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('changes that cannot be saved yet come back when the same entry is opened again after a day change, and go on Escape', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(303);
    await add(owner, event(date));
    // One character past the limit: a longer sentence is no longer a draft that cannot be written (it is saved when the entry is left).
    const tooLong = 'Dentist and the hygienist ' + 'z'.repeat(475);
    expect(tooLong).toHaveLength(501);
    const posts: string[] = [];
    page.on('request', request => { if (request.method() === 'POST' && request.url().includes('api.php')) { posts.push(request.postDataJSON().action); } });
    try {
      await login(page); await openDay(page, date);
      const block = page.getByRole('button', { name: `Dentist, 9a to 10a, ${OWNER_NAME}`, exact: true });
      await block.click();
      const input = entry(page, 'Dentist');
      // Too long for an entry (501 characters, set past the field's maxlength, see overfill): it cannot be written, so leaving the entry (here by the day changing) keeps it for when the entry is opened again.
      await overfill(input, tooLong);
      await nudge(input, 'Alt+Shift+ArrowDown', 2);
      await page.getByRole('button', { name: 'Next day', exact: true }).click();
      await expect(editing(page)).toHaveCount(0);
      await page.getByRole('button', { name: 'Previous day', exact: true }).click();
      await block.click();
      await expect(input).toHaveValue(tooLong);
      await spanIs(page, 540, 90);
      // The notice is only read out now (the block has no room for it), not drawn.
      await expect(page.locator('#live')).toHaveText('Your unsaved changes are back.');
      await nothingHangs(page);
      // Nothing was written meanwhile.
      expect(posts.filter(action => action !== 'savePrefs')).toEqual([]);
      await input.fill('Dentist, hygienist');
      // Escape forgets the changes.
      await input.press('Escape');
      await expect(editing(page)).toHaveCount(0);
      await block.click();
      await expect(input).toHaveValue('Dentist');
      await spanIs(page, 540, 60);
      // Saved, it is stored once and the next opening starts from what was saved.
      await input.fill('Dentist saved');
      await input.press('Enter');
      await expect(editing(page)).toHaveCount(0);
      await page.getByRole('button', { name: `Dentist saved, 9a to 10a, ${OWNER_NAME}`, exact: true }).click();
      await expect(entry(page, 'Dentist saved')).toHaveValue('Dentist saved');
      await spanIs(page, 540, 60);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the handle pills sit outside a 30-minute entry, clear of its own text', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(301);
    await add(owner, event(date, { text: 'Quick call', start: 600, length: 30 }));
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', { name: `Quick call, 10a to 10:30a, ${OWNER_NAME}`, exact: true }).click();
      await expect(entry(page, 'Quick call')).toBeFocused();
      const text = (await entry(page, 'Quick call').boundingBox())!;
      const start = (await page.locator('.day-handle[data-edge=start] i').boundingBox())!, end = (await page.locator('.day-handle[data-edge=end] i').boundingBox())!;
      // A pixel of slack for rounding: before, the pills reached five pixels or more into the block.
      expect(start.y + start.height, 'the start pill ends above the text').toBeLessThanOrEqual(text.y + 1);
      expect(end.y, 'the end pill begins below the text').toBeGreaterThanOrEqual(text.y + text.height - 1);
      // The grab area is at least the pill's width and a pointer-sized height, and it reaches the pill.
      for (const edge of ['start', 'end']) {
        const handle = (await page.locator(`.day-handle[data-edge=${edge}]`).boundingBox())!, pill = (await page.locator(`.day-handle[data-edge=${edge}] i`).boundingBox())!;
        expect(handle.height).toBeGreaterThanOrEqual(20);
        expect(pill.y).toBeGreaterThanOrEqual(handle.y - 1);
        expect(pill.y + pill.height).toBeLessThanOrEqual(handle.y + handle.height + 1);
      }
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('edit-mode handles resize both edges on the 15-minute grid with a start–end label, and Enter is one write with the text', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(302);
    const id = await add(owner, event(date));
    const posts: Array<Record<string, unknown>> = [];
    page.on('request', request => { if (request.method() === 'POST' && request.url().includes('api.php')) { posts.push(request.postDataJSON()); } });
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', { name: `Dentist, 9a to 10a, ${OWNER_NAME}`, exact: true }).click();
      const input = entry(page, 'Dentist');
      // No handles until the entry is in edit mode; then one at each edge.
      await expect(page.locator('.day-ev.day-editing .day-handle')).toHaveCount(2);
      await input.fill('Dentist visit');
      // Bottom edge 30 minutes down: 10:30. The label follows the pointer.
      await grab(page, 'end', 30);
      await expect(page.locator('.day-bubble')).toHaveText('9a – 10:30a');
      await page.mouse.up();
      // Top edge 30 minutes up: 8:30. A pointer position between grid lines snaps to the nearest quarter hour.
      await grab(page, 'start', -29);
      await expect(page.locator('.day-bubble')).toHaveText('8:30a – 10:30a');
      await page.mouse.up();
      // The press on a handle did not take the keyboard out of the title: nothing was saved by it.
      await expect(input).toBeFocused();
      await spanIs(page, 510, 120);
      // The block itself moved with the handles, and its time label is the new start.
      await expect(editing(page).locator('.day-ev-time')).toHaveText('8:30a');
      const grid = await gridBox(page), block = (await editing(page).boundingBox())!;
      expect(Math.abs(block.y - (grid.y + (grid.height * 90) / 840))).toBeLessThanOrEqual(4);
      expect(Math.abs(block.height - (grid.height * 120) / 840)).toBeLessThanOrEqual(4);
      // Nothing was saved while dragging.
      expect(posts).toHaveLength(0);
      expect((await storedEvents(owner, date))[0]).toMatchObject({ start: 540, length: 60 });
      await input.press('Enter');
      await expect(editing(page)).toHaveCount(0);
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: [OWNER], text: 'Dentist visit', start: 510, length: 120 }]);
      expect((await storedEvents(owner, date))[0]).toMatchObject({ text: 'Dentist visit', start: 510, length: 120, revision: 2 });
      await expect(page.getByRole('button', { name: `Dentist visit, 8:30a to 10:30a, ${OWNER_NAME}`, exact: true })).toBeVisible();
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a handle stops at a neighbour in any lane, keeps the 30-minute minimum and stays inside 7:00 to 21:00', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(303);
    await add(owner, event(date));
    await add(owner, event(date, { text: 'Next', start: 630, length: 30 }));
    await add(owner, event(date, { text: 'Both', owners: [OWNER, PARTNER], start: 780, length: 30 }));
    await add(owner, event(date, { text: 'Hers', owners: [PARTNER], start: 900, length: 30 }));
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', { name: `Dentist, 9a to 10a, ${OWNER_NAME}`, exact: true }).click();
      const bubble = page.locator('.day-bubble');
      await expect(entry(page, 'Dentist')).toBeFocused();
      await grab(page, 'end', 120);
      await expect(bubble).toHaveText('9a – 10:30a');
      await page.mouse.up();
      // Half an hour is still a length the end handle can be left at...
      await grab(page, 'end', -60);
      await expect(bubble).toHaveText('9a – 9:30a');
      await page.mouse.up();
      await spanIs(page, 540, 30);
      // The handle stops there even when pulled farther.
      await grab(page, 'end', -200);
      await expect(bubble).toHaveText('9a – 9:30a');
      await page.mouse.up();
      await grab(page, 'start', -300);
      await expect(bubble).toHaveText('7a – 9:30a');
      await page.mouse.up();
      await spanIs(page, 420, 150);
      // The start handle stops half an hour before the end, too.
      await grab(page, 'start', 400);
      await expect(bubble).toHaveText('9a – 9:30a');
      await page.mouse.up();
      await spanIs(page, 540, 30);
      // The half-hour duration is saved.
      await entry(page, 'Dentist').press('Enter');
      await expect(editing(page)).toHaveCount(0);
      expect((await storedEvents(owner, date)).find((e: { text: string }) => e.text === 'Dentist')).toMatchObject({ start: 540, length: 30 });
      // A Both entry is held by the partner's lane too: it cannot grow into the partner's 3p entry.
      await page.getByRole('button', { name: 'Both, 1p to 1:30p, Both', exact: true }).click();
      await expect(entry(page, 'Both')).toBeFocused();
      await grab(page, 'end', 300);
      await expect(bubble).toHaveText('1p – 3p');
      await page.mouse.up();
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the keyboard sets the time and length without a pointer: Alt+Arrow moves, Alt+Shift+Arrow changes the end, never past 7 am, below 30 minutes or into a neighbour', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(304);
    await add(owner, event(date));
    await add(owner, event(date, { text: 'Wall', start: 780, length: 30 }));
    await add(owner, event(date, { text: 'Late', start: 1140, length: 60 }));
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', { name: `Dentist, 9a to 10a, ${OWNER_NAME}`, exact: true }).click();
      // The block shows the start and the rows it covers (and a half cuts it off), so the span is read from it (spanIs); where the end is cut
      // off by the half, the words said to a screen reader for each step ("7p – 9:15p") are what tells the end.
      const input = entry(page, 'Dentist'), live = page.locator('#live');
      await expect(input).toBeFocused();
      await nudge(input, 'Alt+ArrowDown', 8);
      await spanIs(page, 660, 60);
      await expect(editing(page).locator('.day-ev-time')).toHaveText('11a');
      await nudge(input, 'Alt+Shift+ArrowDown', 2);
      await spanIs(page, 660, 90);
      const grid = await gridBox(page), block = (await editing(page).boundingBox())!;
      expect(Math.abs(block.y - (grid.y + (grid.height * 240) / 840))).toBeLessThanOrEqual(4);
      // The end grows as far as the next entry's start, touching it, and no further; the entry cannot move into it either.
      await nudge(input, 'Alt+Shift+ArrowDown', 2);
      await spanIs(page, 660, 120);
      await input.press('Alt+Shift+ArrowDown');
      await expect(live).toContainText('Cannot make it longer.');
      await input.press('Alt+ArrowDown');
      await expect(live).toContainText('it would overlap Wall');
      await spanIs(page, 660, 120);
      // Enter, in the title, writes it.
      await input.press('Enter');
      await expect(editing(page)).toHaveCount(0);
      expect((await storedEvents(owner, date)).find((e: { text: string }) => e.text === 'Dentist')).toMatchObject({ start: 660, length: 120 });
      // Late in the day the end stops at 7 am, the end of the planner day, not at the 9 pm that ends the AM page (the entry is drawn cut off there), a
      // shorter entry stops at 30 minutes, and the entry stops moving once none of it would be on the AM page (the step is then
      // a switch to PM away).
      await page.getByRole('button', { name: `Late, 7p to 8p, ${OWNER_NAME}`, exact: true }).click();
      const late = entry(page, 'Late');
      await expect(late).toBeFocused();
      await nudge(late, 'Alt+Shift+ArrowDown', 4);
      await spanIs(page, 1140, 120);
      await late.press('Alt+Shift+ArrowDown');
      await expect(live).toHaveText('7p – 9:15p');
      await expect(editing(page)).toHaveAttribute('data-clip', 'bottom');
      await nudge(late, 'Alt+Shift+ArrowDown', 39);
      await expect(live).toHaveText('7p – 7a');
      await late.press('Alt+Shift+ArrowDown');
      await expect(live).toContainText('Cannot make it longer.');
      await late.press('Alt+ArrowDown');
      await expect(live).toContainText('at the end of the schedule');
      await spanIs(page, 1140, 120);
      await nudge(late, 'Alt+Shift+ArrowUp', 46);
      await spanIs(page, 1140, 30);
      await expect(live).toHaveText('7p – 7:30p');
      await late.press('Alt+Shift+ArrowUp');
      await expect(live).toContainText('Cannot make it shorter.');
      await spanIs(page, 1140, 30);
      await nudge(late, 'Alt+ArrowDown', 6);
      await spanIs(page, 1230, 30);
      await late.press('Alt+ArrowDown');
      await expect(live).toHaveText('8:45p – 9:15p');
      await late.press('Alt+ArrowDown');
      await expect(live).toContainText('Cannot move later on this half of the day: switch to PM.');
      await spanIs(page, 1245, 15);
      await late.press('Enter');
      await expect(editing(page)).toHaveCount(0);
      expect((await storedEvents(owner, date)).find((e: { text: string }) => e.text === 'Late')).toMatchObject({ start: 1245, length: 30 });
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('Alt+Up and Alt+Down in the title move the entry being edited 15 minutes, and stop at a neighbour, without writing', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(312);
    await add(owner, event(date, { start: 540, length: 30 }));
    await add(owner, event(date, { text: 'Above', start: 480, length: 30 }));
    const posts: string[] = [];
    page.on('request', request => { if (request.method() === 'POST' && request.url().includes('api.php')) { posts.push(request.postDataJSON().action); } });
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', { name: `Dentist, 9a to 9:30a, ${OWNER_NAME}`, exact: true }).click();
      const input = entry(page, 'Dentist');
      await expect(input).toBeFocused();
      await page.keyboard.press('Alt+ArrowDown');
      await spanIs(page, 555, 30);
      // Up three quarters: 8:30 to 9:00 touches Above's end, which is fine.
      for (const start of [540, 525, 510]) { await page.keyboard.press('Alt+ArrowUp'); await spanIs(page, start, 30); }
      // One more would overlap it: the draft stays where it is and says why.
      await page.keyboard.press('Alt+ArrowUp');
      await expect(page.locator('#live')).toContainText('it would overlap Above');
      await spanIs(page, 510, 30);
      await page.keyboard.press('Alt+ArrowDown');
      await page.keyboard.press('Alt+ArrowDown');
      await page.keyboard.press('Alt+ArrowDown');
      await page.keyboard.press('Alt+ArrowDown');
      await spanIs(page, 570, 30);
      await page.keyboard.press('Alt+ArrowUp');
      expect(posts.filter(action => action !== 'savePrefs')).toEqual([]);
      await input.press('Enter');
      await expect(editing(page)).toHaveCount(0);
      expect((await storedEvents(owner, date)).find((e: { text: string }) => e.text === 'Dentist')).toMatchObject({ start: 555 });
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('an overlap is refused when the entry is saved (Enter), in either lane of a Both entry, and touching is fine; the words go to the banner', async ({ page, baseURL }) => {
    await page.clock.install();
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER), date = farDate(305);
    await add(owner, event(date, { text: 'Gym', start: 540, length: 30 }));
    const texts = async () => (await storedEvents(owner, date)).map((e: { text: string }) => e.text).sort();
    try {
      await login(page); await openDay(page, date);
      // The entry cannot be moved or sized into a neighbour by hand (a tap, the keys and the handles all stop short of one), so an overlap
      // comes the way it can: another device writes into the entry's time while it is open, and the next poll brings it in. The block shows
      // nothing while the entry is typed (no live message): the overlap is said when a save is tried, and the entry stays as it is.
      const poll = async () => {
        const polled = page.waitForResponse(response => response.url().includes('api.php?since='));
        await page.clock.runFor(POLL);
        await polled;
      };
      // 9:30 to 10:30 starts where Gym ends: touching is fine. The partner's 9:30 entry is not in the owner's lane, so it is no clash: Enter writes it.
      await tapSlot(page, `Add to ${OWNER_NAME} at 9a`, 0.6);
      await spanIs(page, 570, 30);
      await entry(page).fill('Call');
      await add(partner, event(date, { text: 'Yoga', owners: [PARTNER], start: 570, length: 60 }));
      await poll();
      await entry(page).press('Enter');
      await expect(editing(page)).toHaveCount(0);
      expect((await storedEvents(owner, date)).find((e: { text: string }) => e.text === 'Call')).toMatchObject({ owners: [OWNER], start: 570, length: 30 });
      await expect(page.locator('#error')).toBeHidden();
      // ...but one of the owner's own that another device writes into a new entry's time is: Enter does not write it and the banner says why.
      await tapSlot(page, `Add to ${OWNER_NAME} at 1p`, 0.1);
      await spanIs(page, 780, 30);
      await entry(page).fill('Dinner');
      // A quarter hour longer (1:00p to 1:45p) runs into Late; it is still a draft until Enter.
      await nudge(entry(page), 'Alt+Shift+ArrowDown');
      await spanIs(page, 780, 45);
      await add(owner, event(date, { text: 'Late', start: 810, length: 30 }));
      await poll();
      await entry(page).press('Enter');
      await expect(banner(page)).toHaveText('Overlaps “Late” (1:30p – 2p).');
      await expect(page.getByRole('alert')).toContainText('Overlaps “Late”');
      await expect(editing(page)).toHaveCount(1);
      await expect(entry(page)).toHaveValue('Dinner');
      expect(await texts()).not.toContain('Dinner');
      // Shortened to end where Late begins, it only touches it: it is written, and the banner goes with the write.
      await nudge(entry(page), 'Alt+Shift+ArrowUp');
      await spanIs(page, 780, 30);
      await entry(page).press('Enter');
      await expect(editing(page)).toHaveCount(0);
      expect((await storedEvents(owner, date)).find((e: { text: string }) => e.text === 'Dinner')).toMatchObject({ start: 780, length: 30 });
      await expect(page.locator('#error')).toBeHidden();
      // A Both entry (the Add button under the Both view) is in the partner's lane too: 8:00 to 9:00 is the free half hour nearest 9:00 in both.
      await addEntryButton(page).focus();
      await page.keyboard.press('Enter');
      await spanIs(page, 510, 30);
      await entry(page).fill('Call both');
      await add(partner, event(date, { text: 'Stretch', owners: [PARTNER], start: 510, length: 30 }));
      await poll();
      await entry(page).press('Enter');
      await expect(banner(page)).toHaveText('Overlaps “Stretch” (8:30a – 9a).');
      // Enter does not write it, and the entry stays open with its words.
      await expect(editing(page)).toHaveCount(1);
      await expect(entry(page)).toHaveValue('Call both');
      await nothingHangs(page);
      expect(await texts()).toEqual(['Call', 'Dinner', 'Gym', 'Late', 'Stretch', 'Yoga']);
    } finally { await clearDay(owner, date); await owner.dispose(); await partner.dispose(); }
  });

  test('a write the server refuses for overlap keeps the entry and the draft with the server\'s words', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER), date = farDate(306);
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', { name: `Add to ${OWNER_NAME} at 2p`, exact: true }).click({ position: { x: 20, y: 6 } });
      await entry(page).fill('My call');
      // Another device takes that time before this one saves.
      await add(partner, event(date, { text: 'Taken', start: 840, length: 30 }));
      await entry(page).press('Enter');
      // The refusal is said once, in the shell's banner (the block has no room for it); the entry and its draft stay.
      await expect(banner(page)).toHaveText('That time is already taken in this list.');
      await expect(page.getByRole('alert')).toContainText('already taken');
      await expect(entry(page)).toHaveValue('My call');
      await spanIs(page, 840, 30);
      await nothingHangs(page);
      // Any change to the draft takes the refusal out of the banner, and the schedule grows into the room the banner held: a quarter hour longer
      // with the keyboard, then another, so that the handle below is measured on the schedule as it stays.
      await nudge(entry(page), 'Alt+Shift+ArrowDown');
      await spanIs(page, 840, 45);
      await expect(page.locator('#error')).toBeHidden();
      await nudge(entry(page), 'Alt+Shift+ArrowDown');
      await spanIs(page, 840, 60);
      // Moving it clear of the other entry and saving again works, with the same add: the keys stop at the other entry, so the start
      // handle is dragged down to 2:30, which leaves the draft half an hour (not the quarter hour that is the shortest it can be).
      await grab(page, 'start', 30);
      await expect(page.locator('.day-bubble')).toHaveText('2:30p – 3p');
      await page.mouse.up();
      await spanIs(page, 870, 30);
      await entry(page).press('Enter');
      await expect(editing(page)).toHaveCount(0);
      // The refusal left the banner with the first change to the draft (the keyboard nudge above), so it is empty before this write and stays empty after it:
      // that a write which goes through takes a refusal out is the next test's (the banner is still there when it is made).
      await expect(banner(page)).toHaveText('');
      await expect(page.locator('#error')).toBeHidden();
      expect((await storedEvents(owner, date)).map((e: { text: string; start: number }) => [e.text, e.start]).sort()).toEqual([['My call', 870], ['Taken', 840]]);
    } finally { await clearDay(owner, date); await owner.dispose(); await partner.dispose(); }
  });

  test('a refusal stays in the banner while the draft is unchanged, and the write that then goes through takes it out', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER), date = farDate(737);
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', { name: `Add to ${OWNER_NAME} at 2p`, exact: true }).click({ position: { x: 20, y: 6 } });
      await entry(page).fill('My call');
      // Another device takes that time before this one saves; the refusal is said in the banner, and the entry stays open with its draft.
      const taken = await add(partner, event(date, { text: 'Taken', owners: [OWNER], start: 840, length: 30 }));
      await entry(page).press('Enter');
      await expect(banner(page)).toHaveText('That time is already taken in this list.');
      await expect(page.getByRole('alert')).toContainText('already taken');
      await spanIs(page, 840, 30);
      // The time is free again on the server (the other entry is deleted there), and nothing here touches the draft: the refusal is still in the banner.
      const gone = (await partner.snapshot()).events.find((e: { id: string }) => e.id === taken);
      expect((await partner.post({ action: 'delete', id: taken, revision: gone.revision, confirm: true })).status()).toBe(200);
      await expect(banner(page)).toHaveText('That time is already taken in this list.');
      await expect(page.locator('#error')).toBeVisible();
      // The same draft saved again goes through, and the refusal that was in the banner goes with the write.
      await entry(page).press('Enter');
      await expect(editing(page)).toHaveCount(0);
      await expect(banner(page)).toHaveText('');
      await expect(page.locator('#error')).toBeHidden();
      expect((await storedEvents(owner, date)).map((e: { text: string; start: number; length: number }) => [e.text, e.start, e.length])).toEqual([['My call', 840, 30]]);
    } finally { await clearDay(owner, date); await owner.dispose(); await partner.dispose(); }
  });

  test('a stale save keeps what was typed and says so in the banner; Escape shows what is true, Enter again saves over it', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER), date = farDate(307);
    const id = await add(owner, event(date));
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', { name: `Dentist, 9a to 10a, ${OWNER_NAME}`, exact: true }).click();
      await nudge(entry(page, 'Dentist'), 'Alt+Shift+ArrowDown', 4);
      // The partner renames the entry while this one is being edited.
      expect((await partner.post({ action: 'edit', kind: 'event', id, revision: 1, date, owners: [OWNER], text: 'Orthodontist', start: 540, length: 60 })).status()).toBe(200);
      await entry(page, 'Dentist').press('Enter');
      // The words (with what Enter and Escape would do) are in the shell's banner, not in the block.
      await expect(banner(page)).toContainText('changed on another device');
      await expect(banner(page)).toContainText('Enter saves yours over it, Escape keeps theirs.');
      await expect(page.getByRole('alert')).toContainText('changed on another device');
      await nothingHangs(page);
      // What was typed is still there, and nothing of mine was written.
      await spanIs(page, 540, 120);
      expect((await storedEvents(owner, date))[0]).toMatchObject({ text: 'Orthodontist', length: 60 });
      // Escape gives up mine: the block shows what is true.
      await entry(page, 'Dentist').press('Escape');
      await expect(page.getByRole('button', { name: `Orthodontist, 9a to 10a, ${OWNER_NAME}`, exact: true })).toBeVisible();
      // Leaving the edit takes its message out of the banner (a message of the editor lasts as long as the edit and the draft it refused).
      await expect(page.locator('#error')).toBeHidden();
      // The same again, and this time Enter a second time saves mine over hers.
      await page.getByRole('button', { name: `Orthodontist, 9a to 10a, ${OWNER_NAME}`, exact: true }).click();
      await nudge(entry(page, 'Orthodontist'), 'Alt+Shift+ArrowDown', 2);
      expect((await partner.post({ action: 'edit', kind: 'event', id, revision: 2, date, owners: [OWNER], text: 'Orthodontist Z', start: 540, length: 60 })).status()).toBe(200);
      await entry(page, 'Orthodontist').press('Enter');
      await expect(banner(page)).toContainText('Enter saves yours over it, Escape keeps theirs.');
      await entry(page, 'Orthodontist').press('Enter');
      await expect(editing(page)).toHaveCount(0);
      expect((await storedEvents(owner, date))[0]).toMatchObject({ text: 'Orthodontist', length: 90, revision: 4 });
    } finally { await clearDay(owner, date); await owner.dispose(); await partner.dispose(); }
  });

  test('the other person\'s change arrives by poll but never under an entry being edited', async ({ page, baseURL }) => {
    await page.clock.install();
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER), date = farDate(308);
    await add(owner, event(date));
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', { name: `Dentist, 9a to 10a, ${OWNER_NAME}`, exact: true }).click();
      await entry(page, 'Dentist').fill('Half typed');
      await add(partner, event(date, { text: 'Surprise', owners: [PARTNER], start: 900, length: 30 }));
      const polled = page.waitForResponse(response => response.url().includes('api.php?since='));
      await page.clock.runFor(POLL);
      await polled;
      await expect(entry(page, 'Dentist')).toHaveValue('Half typed');
      await expect(page.getByRole('button', { name: /^Surprise/ })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(editing(page)).toHaveCount(0);
      await expect(page.getByRole('button', { name: `Surprise, 3p to 3:30p, ${PARTNER_NAME}`, exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: `Dentist, 9a to 10a, ${OWNER_NAME}`, exact: true })).toBeVisible();
    } finally { await clearDay(owner, date); await owner.dispose(); await partner.dispose(); }
  });

  test('opening another entry saves the first one\'s changes (an empty new one is dropped) and puts its block back', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(310);
    await add(owner, event(date));
    await add(owner, event(date, { text: 'Gym', start: 720, length: 30 }));
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('button', { name: `Dentist, 9a to 10a, ${OWNER_NAME}`, exact: true }).click();
      await entry(page, 'Dentist').fill('Dentist at nine');
      await page.getByRole('button', { name: `Gym, 12p to 12:30p, ${OWNER_NAME}`, exact: true }).click();
      await expect(entry(page, 'Gym')).toBeFocused();
      // The first entry is a normal block again with what was typed, saved: one of each, with no handles left on it.
      await expect(page.getByRole('button', { name: `Dentist at nine, 9a to 10a, ${OWNER_NAME}`, exact: true })).toBeVisible();
      expect((await storedEvents(owner, date)).find((e: { text: string }) => e.text === 'Dentist at nine')).toMatchObject({ revision: 2 });
      await expect(editing(page)).toHaveCount(1);
      await expect(page.locator('.day-handle')).toHaveCount(2);
      // An empty new entry is dropped, not written, when another one is opened. (A tap on an empty slot while Gym is still being edited would only
      // put that edit away, so it is put away first.)
      await dismiss(page);
      await tapSlot(page, `Add to ${OWNER_NAME} at 3p`, 0.2);
      await expect(entry(page)).toBeFocused();
      await page.getByRole('button', { name: `Gym, 12p to 12:30p, ${OWNER_NAME}`, exact: true }).click();
      await expect(entry(page, 'Gym')).toBeFocused();
      await expect(editing(page)).toHaveCount(1);
      expect(await storedEvents(owner, date)).toHaveLength(2);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('keyboard path: Add schedule entry opens a new entry; Delete on a focused entry shows its Delete and Enter deletes it, and a swipe then a tap does the same', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(309);
    await add(owner, event(date, { owners: [OWNER, PARTNER], text: 'Lunch', start: 720, length: 60 }));
    await add(owner, event(date, { text: 'Walk', start: 900, length: 30 }));
    const posts: Array<Record<string, unknown>> = [];
    page.on('request', request => { if (request.method() === 'POST' && request.url().includes('api.php')) { const body = request.postDataJSON(); if (body.action !== 'savePrefs') { posts.push(body); } } });
    try {
      await login(page); await openDay(page, date);
      const addEntry = page.getByRole('button', { name: 'Add schedule entry', exact: true });
      await addEntry.focus();
      await page.keyboard.press('Enter');
      // Who it is for is the top picker's base: Both under the Both view, so it is a shared entry (the block spans both lanes). 9:00 is free, so that is the start.
      await expect(entry(page)).toBeFocused();
      await expect(page.getByRole('radiogroup')).toHaveCount(0);
      await expect(editing(page)).toHaveAttribute('data-who', 'Both');
      await spanIs(page, 540, 30);
      // A new entry has nothing to delete yet, and an entry being edited has no Delete at all: nothing hangs over the schedule.
      await expect(page.locator('.day-ev-del')).toHaveCount(0);
      await nothingHangs(page);
      await page.keyboard.press('Escape');
      await expect(editing(page)).toHaveCount(0);
      // The keyboard: Delete on the focused entry (not in its title field) shows the Delete button and moves the focus to it; Enter deletes at once.
      const lunch = page.getByRole('button', { name: 'Lunch, 12p to 1p, Both', exact: true });
      await lunch.focus();
      await page.keyboard.press('Delete');
      const del = page.locator('.day-ev-del');
      await expect(del).toBeFocused();
      await expect(del).toHaveAccessibleName('Delete Lunch, for both of us');
      await expect(editing(page)).toHaveCount(0);
      expect(posts).toHaveLength(0);
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: /^Lunch/ })).toHaveCount(0);
      await expect(del).toHaveCount(0);
      expect(posts).toEqual([{ action: 'delete', id: expect.any(String), revision: 1, confirm: true }]);
      expect(await storedEvents(owner, date)).toHaveLength(1);
      // The pointer: a swipe to the left shows Delete over the end of the entry (no editor), one tap on it deletes.
      await swipeLeft(page, `Walk, 3p to 3:30p, ${OWNER_NAME}`);
      await expect(del).toHaveCount(1);
      await expect(del).toHaveAccessibleName('Delete Walk');
      await expect(editing(page)).toHaveCount(0);
      expect(posts).toHaveLength(1);
      await del.click();
      await expect(page.getByRole('button', { name: /^Walk/ })).toHaveCount(0);
      expect(posts).toHaveLength(2);
      expect(posts[1]).toMatchObject({ action: 'delete', revision: 1, confirm: true });
      expect(await storedEvents(owner, date)).toHaveLength(0);
      await noWindow(page);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});

test.describe('Schedule: what an entry being edited holds', () => {
  test('whatever its height, an entry being edited holds only its time, its title and its two handles: nothing hangs over the schedule, the handles are topmost at their middle, and the keyboard still works there', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(731);
    await add(owner, event(date, { text: 'Long one', start: 540, length: 120 }));
    await add(owner, event(date, { text: 'Hour', start: 780, length: 60 }));
    await add(owner, event(date, { text: 'Short one', start: 900, length: 30 }));
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      // The block's parts, in order, and what is on top of each handle's middle (the strip used to be the thing that could cover a handle).
      const parts = () => page.evaluate(() => {
        const block = document.querySelector('.day-ev.day-editing')!;
        const children = [...block.children].map(c => c.matches('.day-ev-time') ? 'time' : c.matches('input.day-ev-input[data-ip=text]') ? 'title' : c.matches('.day-handle') ? `handle-${(c as HTMLElement).dataset.edge}` : c.tagName.toLowerCase());
        const topmost = [...block.querySelectorAll<HTMLElement>('.day-handle')].map(h => {
          const box = h.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return `${h.dataset.edge}:${hit?.closest<HTMLElement>('.day-handle')?.dataset.edge ?? hit?.tagName}`;
        });
        const input = block.querySelector('.ip-input')!.getBoundingClientRect(), time = block.querySelector('.day-ev-time')!.getBoundingClientRect();
        return { children, topmost, sameLine: Math.abs((input.top + input.bottom) / 2 - (time.top + time.bottom) / 2) <= 3 };
      });
      const only = { children: ['time', 'title', 'handle-start', 'handle-end'], topmost: ['start:start', 'end:end'] };
      await page.getByRole('button', { name: `Long one, 9a to 11a, ${OWNER_NAME}`, exact: true }).click();
      await expect(entry(page, 'Long one')).toBeFocused();
      await nothingHangs(page);
      // A tall block puts the title on the line of the time, not centred in the block.
      expect(await parts()).toEqual({ ...only, sameLine: true });
      await spanIs(page, 540, 120);
      // The block works where it is: the keyboard shortens it, Enter is one write with the text.
      const posts: Array<Record<string, unknown>> = [];
      page.on('request', request => { if (request.method() === 'POST' && request.url().includes('api.php')) { posts.push(request.postDataJSON()); } });
      await nudge(entry(page, 'Long one'), 'Alt+Shift+ArrowUp', 2);
      await spanIs(page, 540, 90);
      await expect(page.locator('.day-bubble')).toHaveCount(0);
      expect(posts.filter(p => p.action !== 'savePrefs')).toHaveLength(0);
      await entry(page, 'Long one').press('Enter');
      await expect(page.getByRole('button', { name: `Long one, 9a to 10:30a, ${OWNER_NAME}`, exact: true })).toBeVisible();
      expect((await storedEvents(owner, date)).find((e: { text: string }) => e.text === 'Long one').length).toBe(90);
      // The hour and the half hour hold the same parts, and their handles are topmost too.
      for (const name of [`Hour, 1p to 2p, ${OWNER_NAME}`, `Short one, 3p to 3:30p, ${OWNER_NAME}`]) {
        await page.getByRole('button', { name, exact: true }).click();
        await expect(editing(page)).toHaveCount(1);
        await nothingHangs(page);
        expect(await parts()).toMatchObject(only);
        await dismiss(page);
      }
      await noWindow(page);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('while one entry is being edited another can be pressed, dragged and opened: nothing hangs over the schedule to get in the way', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(732);
    await add(owner, event(date, { text: 'First', start: 540, length: 60 }));
    await add(owner, event(date, { text: 'Second', start: 720, length: 60 }));
    await add(owner, event(date, { text: 'Third', start: 840, length: 60 }));
    const posts: Array<Record<string, unknown>> = [];
    page.on('request', request => { if (request.method() === 'POST' && request.url().includes('api.php')) { const body = request.postDataJSON(); if (body.action !== 'savePrefs') { posts.push(body); } } });
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      await page.getByRole('button', { name: `First, 9a to 10a, ${OWNER_NAME}`, exact: true }).click();
      await expect(entry(page, 'First')).toBeFocused();
      // Nothing hangs over the schedule, so the middle of "Second" (two hours on) is the entry's own.
      await nothingHangs(page);
      const second = (await page.getByRole('button', { name: `Second, 12p to 1p, ${OWNER_NAME}`, exact: true }).boundingBox())!;
      const at = { x: second.x + second.width / 2, y: second.y + second.height / 2 };
      expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.day-ev')?.getAttribute('data-key'), at)).toMatch(/^event:/);
      // A press and move on it moves it (drag-to-move keeps working beside an open edit); the open one is saved as unchanged.
      const grid = (await page.locator('.day-lanes').boundingBox())!;
      await page.mouse.move(at.x, at.y); await page.mouse.down();
      await page.mouse.move(at.x, at.y + (60 * grid.height) / 840, { steps: 8 });
      await page.mouse.up();
      await expect.poll(async () => (await storedEvents(owner, date)).find((e: { text: string }) => e.text === 'Second').start).toBe(780);
      expect(posts.map(p => [p.action, p.text])).toEqual([['edit', 'Second']]);
      // A click without movement on another entry opens it instead, saving the first one's edit (nothing to save here).
      await page.getByRole('button', { name: `Third, 2p to 3p, ${OWNER_NAME}`, exact: true }).click();
      await expect(entry(page, 'Third')).toBeFocused();
      await expect(editing(page)).toHaveCount(1);
      await nothingHangs(page);
      await noWindow(page);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});

test.describe('Schedule: what a block shows of its words', () => {
  /** 499 characters of short words, so that the lines break between words and every block holds fewer lines than the text takes. */
  const LONG = Array.from({ length: 100 }, (_, i) => `wd${String(i).padStart(2, '0')}`).join(' ').slice(0, 499);
  /** The blocks these tests seed, from 7a on and clear of one another (the hour at 7a can be lengthened to where `short` begins). */
  const BLOCKS = {
    hour: { text: LONG, start: 420, length: 60 },
    short: { text: 'Short', start: 540, length: 60 },
    two: { text: LONG, start: 600, length: 120 },
    half: { text: LONG, start: 780, length: 30 },
    quarter: { text: LONG, start: 840, length: 30 },
    tiny: { text: 'Tiny', start: 900, length: 30 },
    four: { text: LONG, start: 960, length: 240 },
  } as const;
  type Name = keyof typeof BLOCKS;
  const NAMES = Object.keys(BLOCKS) as Name[];
  const seed = async (api: Api, date: string) => {
    const ids = {} as Record<Name, string>;
    for (const name of NAMES) { ids[name] = await add(api, event(date, BLOCKS[name])); }
    return ids;
  };
  const block = (page: Page, id: string) => page.locator(`.day-ev[data-id="${id}"]`);

  /**
   * What one stored block shows of its text, all of it read from the layout. `room` and `wanted` are the product's rule (ScheduleSection.fitLines)
   * worked out here from the block's own height and padding: the room is the block's height inside its border less its vertical padding, it holds
   * floor((room + 0.5) / line) lines, and at least one. `lines` and `clamp` are what the block was given (read as they are, to be compared with `wanted`).
   */
  const measure = (page: Page, id: string) => block(page, id).evaluate(el => {
    const words = el.querySelector<HTMLElement>('.day-ev-text')!, time = el.querySelector<HTMLElement>('.day-ev-time')!;
    const own = getComputedStyle(el), text = getComputedStyle(words);
    const edge = el.getBoundingClientRect(), box = words.getBoundingClientRect();
    const line = parseFloat(text.lineHeight);
    const room = el.clientHeight - parseFloat(own.paddingTop) - parseFloat(own.paddingBottom);
    const holds = Math.floor((room + 0.5) / line);
    // What lies just under the last line shown, where the next line of the words would be if the box did not clip them: it must not be the words.
    const under = [2, 12].map(down => document.elementFromPoint(box.left + 8, box.bottom + down)?.closest('.day-ev-text') === words);
    // The height of the same words with the clamp taken off: taller than `shown` exactly when the block cuts them off (and draws the ellipsis after the last line).
    const kept = words.style.cssText;
    words.style.setProperty('-webkit-line-clamp', 'none'); words.style.setProperty('line-clamp', 'none');
    const whole = words.getBoundingClientRect().height;
    words.style.cssText = kept;
    return {
      height: edge.height, room, line, holds, wanted: Math.max(1, holds),
      lines: el.style.getPropertyValue('--lines'), clamp: text.getPropertyValue('-webkit-line-clamp'),
      shown: box.height, whole, scroll: words.scrollHeight, client: words.clientHeight, overflow: text.overflowY,
      bottom: box.bottom, inner: edge.bottom - parseFloat(own.borderBottomWidth), blockScroll: el.scrollHeight, blockClient: el.clientHeight,
      hitOutset: -parseFloat(getComputedStyle(el, '::before').bottom),
      leaks: under.some(Boolean),
      content: words.textContent, title: el.getAttribute('title'),
      blockSize: own.fontSize, wordsSize: text.fontSize, timeSize: getComputedStyle(time).fontSize,
    };
  });
  type Shown = Awaited<ReturnType<typeof measure>>;

  /** What a block must show, judged by the layout it has now and not by the --lines it was given. */
  function expectFilled(name: string, m: Shown) {
    expect(m.line, `${name} has a line height to count by`).toBeGreaterThan(0);
    // As many lines as the room holds: --lines and the clamp the browser computes say so.
    expect(m.lines, `${name}: --lines is what its ${m.room}px of room holds`).toBe(String(m.wanted));
    expect(m.clamp, `${name}: its words are clamped to those lines`).toBe(String(m.wanted));
    // They fit, and one more would not: both against the same padded room (and the same half pixel the product allows for).
    if (m.holds >= 1) {
      expect(m.wanted * m.line, `${name}: its lines fit in its room`).toBeLessThanOrEqual(m.room + 0.5);
      expect(m.bottom, `${name}: its words end inside the block`).toBeLessThanOrEqual(m.inner + 1);
      expect(m.blockScroll, `${name}: only the hit surface extends past the block`).toBeLessThanOrEqual(m.blockClient + m.hitOutset + 1);
    }
    expect((m.wanted + 1) * m.line, `${name}: one more line would not fit in the same room`).toBeGreaterThan(m.room + 0.5);
    // What is shown is exactly those lines, or the words' own height when they are shorter.
    expect(Math.abs(m.shown - Math.min(m.whole, m.wanted * m.line)), `${name} shows exactly its lines (or all of its words when they take fewer)`).toBeLessThan(0.5);
    // The cut: the words box clips (overflow hidden), the words run on past its end exactly when they take more lines than it shows, and the clipped lines are not painted outside it.
    const cut = m.whole > m.wanted * m.line + 0.5;
    expect(m.overflow, `${name}: the words box clips what does not fit`).toBe('hidden');
    expect(m.scroll - m.client > m.line / 2, `${name}: ${cut ? 'the words run on past the last line shown (the ellipsis is drawn there)' : 'the words are whole, nothing is cut off'}`).toBe(cut);
    if (cut) {
      expect(m.leaks, `${name}: no line of the words is outside the box that clips them`).toBe(false);
    }
  }

  /** The blocks whose --lines or clamp is not what their room holds now, said in words (none when every block is fitted): for expect.poll, as a fit settles after layout. */
  const unfitted = async (page: Page, ids: Record<string, string>) => {
    const out: string[] = [];
    for (const [name, id] of Object.entries(ids)) {
      const m = await measure(page, id);
      if (m.lines !== String(m.wanted) || m.clamp !== String(m.wanted)) { out.push(`${name}: --lines "${m.lines}" and clamp ${m.clamp}, but ${m.room}px of room holds ${m.wanted} line(s) of ${m.line}px`); }
    }
    return out;
  };
  /** The height of the schedule's grid, rounded (it is what the blocks' own heights follow). */
  const gridHeight = async (page: Page) => Math.round((await gridBox(page)).height);

  test('a long text fills its block without growing it, and a half-hour entry keeps the same font sizes', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(733);
    expect(LONG.length).toBeGreaterThan(498);
    const id = await seed(owner, date);
    try {
      await page.setViewportSize({ width: 1360, height: 1840 });
      await login(page); await openDay(page, date);
      await expect(page.locator('.day-ev')).toHaveCount(NAMES.length);
      // The lines are set after layout (and kept by the blocks' own observer): measure once every block holds what its room calls for.
      await expect.poll(() => unfitted(page, id), { message: 'every block holds as many lines as its room' }).toEqual([]);
      const grid = await gridBox(page), hour = grid.height / 14, quarterHour = hour / 4;
      const m = {} as Record<Name, Shown>;
      for (const name of NAMES) { m[name] = await measure(page, id[name]); }
      // A block's height follows its time span and the 1px inset on each side.
      expect(Math.abs(m.hour.height - m.short.height)).toBeLessThan(0.5);
      for (const [name, rows] of [['hour', 4], ['short', 4], ['two', 8], ['half', 2], ['quarter', 2], ['tiny', 2], ['four', 16]] as const) {
        expect(Math.abs(m[name].height - (rows * quarterHour - 2)), `the ${name} block is ${rows} quarter hours tall`).toBeLessThanOrEqual(1);
      }
      // The whole text is in the page and in the block's tooltip: nothing is cut at a number of characters, only drawn to the lines that fit.
      for (const name of ['hour', 'two', 'half', 'quarter', 'four'] as const) {
        expect(m[name].content, `${name} holds the whole text`).toBe(LONG);
        expect(m[name].title).toBe(LONG);
      }
      // As many lines as the block holds, judged by its layout: they fit, one more would not, the box clips the rest (an ellipsis after the last), and the words
      // take more lines than are shown. A short text, which takes fewer, is whole and clips nothing.
      for (const name of NAMES) { expectFilled(name, m[name]); }
      for (const name of ['hour', 'two', 'half', 'four'] as const) {
        const one = m[name];
        expect(Number(one.lines), `${name} sets its lines`).toBeGreaterThanOrEqual(1);
        expect(one.whole, `${name}: the words are cut off after the last line`).toBeGreaterThan(one.shown + one.line);
      }
      // A taller block shows more of the words.
      expect(Number(m.half.lines)).toBeGreaterThanOrEqual(2);
      expect(Number(m.hour.lines)).toBeGreaterThan(Number(m.half.lines));
      expect(Number(m.two.lines)).toBeGreaterThan(Number(m.hour.lines));
      expect(Number(m.four.lines)).toBeGreaterThan(Number(m.two.lines));
      // A short text is shown whole on one line, with no ellipsis to come.
      expect(m.short.whole).toBe(m.short.shown);
      expect(m.short.shown).toBe(m.short.line);
      // The shortest entries use the same 13px title and 11px time as every other card.
      for (const name of ['quarter', 'tiny'] as const) {
        expect(m[name].blockSize).toBe('13px');
        expect(m[name].wordsSize).toBe('13px');
        expect(m[name].timeSize).toBe('11px');
        expect(Number(m[name].lines)).toBeGreaterThanOrEqual(1);
      }
      expect(m.quarter.whole).toBeGreaterThan(m.quarter.shown + m.quarter.line);
      expect(m.tiny.whole).toBe(m.tiny.shown);
      for (const name of ['hour', 'half', 'short'] as const) {
        expect([m[name].blockSize, m[name].wordsSize, m[name].timeSize]).toEqual(['13px', '13px', '11px']);
      }
      // The half-hour entry keeps its full title and duration.
      await expect(page.getByRole('button', { name: `Tiny, 3p to 3:30p, ${OWNER_NAME}`, exact: true })).toBeVisible();
      expect((await storedEvents(owner, date)).find((e: { text: string }) => e.text === 'Tiny')).toMatchObject({ start: 900, length: 30 });
      // A block that is made taller shows more lines at once: the hour at 7a is lengthened to two hours (to where the next entry begins), and once the page is drawn again
      // it holds what the two-hour block holds (the block is a new one, drawn after the save; re-fitting one that stays is in the tests below).
      await block(page, id.hour).click();
      const title = page.locator('.day-ev.day-editing input.day-ev-input');
      await expect(title).toBeFocused();
      await nudge(title, 'Alt+Shift+ArrowDown', 4);
      await spanIs(page, 420, 120);
      await title.press('Enter');
      await expect(editing(page)).toHaveCount(0);
      await expect.poll(async () => Math.abs((await measure(page, id.hour)).height - m.two.height) < 0.5, { message: 'the lengthened block is as tall as the two-hour one' }).toBe(true);
      await expect.poll(() => unfitted(page, { hour: id.hour }), { message: 'the lengthened block holds as many lines as its new room' }).toEqual([]);
      const grown = await measure(page, id.hour);
      expectFilled('the lengthened hour', grown);
      expect(Math.abs(grown.height - m.two.height)).toBeLessThan(0.5);
      expect(grown.lines).toBe(m.two.lines);
      expect(Math.abs(grown.shown - m.two.shown)).toBeLessThan(0.5);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a block follows its height to a new number of lines when the window gets taller and shorter, with no redraw of the page (the same elements stay)', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(734);
    const id = await seed(owner, date);
    try {
      await page.setViewportSize({ width: 1360, height: 1600 });
      await login(page); await openDay(page, date);
      await expect(page.locator('.day-ev')).toHaveCount(NAMES.length);
      await expect.poll(() => unfitted(page, id), { message: 'every block holds as many lines as its room' }).toEqual([]);
      // Every block is marked: a redraw would put new elements on the page and the marks would be gone, and then the lines would no longer show the blocks following their own height.
      await page.evaluate(() => document.querySelectorAll('.day-ev').forEach(el => el.setAttribute('data-kept', '')));
      let height = await gridHeight(page), four = (await measure(page, id.four)).wanted;
      const visited = [four];
      for (const windowHeight of [1820, 2070, 2320, 1600]) {
        await page.setViewportSize({ width: 1360, height: windowHeight });
        // The schedule takes the room of the new window first; the blocks then follow it.
        await expect.poll(async () => Math.abs((await gridHeight(page)) - height) > 20, { message: `the schedule takes the room of a ${windowHeight}px window` }).toBe(true);
        height = await gridHeight(page);
        await expect.poll(() => unfitted(page, id), { message: `every block holds as many lines as its room in a ${windowHeight}px window` }).toEqual([]);
        const now = await measure(page, id.four);
        expect(now.wanted, `a ${windowHeight}px window gives the four-hour block another number of lines`).not.toBe(four);
        four = now.wanted; visited.push(four);
        for (const name of NAMES) { expectFilled(`${name} in a ${windowHeight}px window`, await measure(page, id[name])); }
      }
      expect(new Set(visited).size, 'the window really changed the room of the blocks').toBeGreaterThanOrEqual(4);
      // The lines followed the height with no redraw of the blocks.
      await expect(page.locator('.day-ev[data-kept]'), 'the blocks were not drawn again').toHaveCount(NAMES.length);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the banner lies over the schedule and takes no room from it: the grid and every block keep their size and lines while a refusal is shown and taken away with an entry open, with no redraw (the same elements stay)', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(735);
    const id = {
      tall: await add(owner, event(date, { text: LONG, start: 420, length: 240 })),
      hour: await add(owner, event(date, { text: LONG, start: 720, length: 60 })),
      quarter: await add(owner, event(date, { text: LONG, start: 780, length: 30 })),
      dentist: await add(owner, event(date, { text: 'Dentist', start: 840, length: 60 })),
    };
    const watched = { tall: id.tall, hour: id.hour, quarter: id.quarter };
    try {
      await login(page); await openDay(page, date);
      await expect.poll(() => unfitted(page, watched), { message: 'every block holds as many lines as its room' }).toEqual([]);
      const plain = await measure(page, id.tall), plainGrid = await gridHeight(page);
      await block(page, id.dentist).click();
      await expect(entry(page, 'Dentist')).toBeFocused();
      // The entry is open now, so the page is not drawn again for what follows: mark the blocks that are not being edited.
      await page.evaluate(() => document.querySelectorAll('.day-ev:not(.day-editing)').forEach(el => el.setAttribute('data-kept', '')));
      // A draft that cannot be saved: the message goes to the shell's banner, which lies over the top of the panel and takes no room from the schedule.
      await overfill(entry(page, 'Dentist'), 'x'.repeat(501));
      await entry(page, 'Dentist').press('Enter');
      await expect(banner(page)).toHaveText('Keep it to 500 characters.');
      await expect(banner(page)).toBeVisible();
      await expect.poll(async () => Math.abs((await gridHeight(page)) - plainGrid) <= 1, { message: 'the schedule keeps its room under the banner' }).toBe(true);
      await expect.poll(() => unfitted(page, watched), { message: 'every block holds as many lines as its room under the banner' }).toEqual([]);
      const covered = await measure(page, id.tall);
      expect(covered.wanted, 'the tall block keeps its lines under the banner').toBe(plain.wanted);
      for (const name of ['tall', 'hour', 'quarter'] as const) { expectFilled(`${name} under the banner`, await measure(page, id[name])); }
      // Changing the draft takes the message out of the banner, and nothing about the schedule changes.
      await entry(page, 'Dentist').fill('Dentist');
      await expect(banner(page)).toHaveText('');
      await expect.poll(async () => Math.abs((await gridHeight(page)) - plainGrid) <= 1, { message: 'the schedule has the room it always had' }).toBe(true);
      await expect.poll(() => unfitted(page, watched), { message: 'every block holds as many lines as the room it has back' }).toEqual([]);
      const back = await measure(page, id.tall);
      expect(back.wanted, 'the tall block has its line back').toBe(plain.wanted);
      for (const name of ['tall', 'hour', 'quarter'] as const) { expectFilled(`${name} with the room back`, await measure(page, id[name])); }
      await expect(page.locator('.day-ev[data-kept]'), 'the blocks were not drawn again').toHaveCount(3);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('an entry put back by hand when the focus moved to another text field (the page is not drawn again) holds as many lines as its room, as after a redraw', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(736);
    const id = { hour: await add(owner, event(date, { text: LONG, start: 420, length: 60 })), two: await add(owner, event(date, { text: LONG, start: 600, length: 120 })) };
    try {
      await login(page); await openDay(page, date);
      await expect.poll(() => unfitted(page, id), { message: 'every block holds as many lines as its room' }).toEqual([]);
      const drawn = await measure(page, id.hour);
      expect(drawn.wanted, 'the hour holds more than the one line a block gets by default').toBeGreaterThan(1);
      // Open the entry, then go to the to-do box: the entry is left with the focus in a text field, so the shell does not draw the panel again and the row puts its block back itself.
      await block(page, id.hour).click();
      await expect(editing(page)).toHaveCount(1);
      await expect(page.locator('.day-ev.day-editing input.day-ev-input')).toBeFocused();
      await page.evaluate(() => { (document.querySelector('.day-sched') as HTMLElement & { drawnOnce?: boolean }).drawnOnce = true; });
      // focus(), not a click: a press on the empty add field opens a new to-do in its place (to-dos in thirds), the keyboard is what takes the focus to it.
      await field(page, 'New task').focus();
      await expect(editing(page)).toHaveCount(0);
      await expect(field(page, 'New task')).toBeFocused();
      expect(await page.evaluate(() => (document.querySelector('.day-sched') as HTMLElement & { drawnOnce?: boolean }).drawnOnce), 'the panel was not drawn again, so the block was put back by hand').toBe(true);
      await expect(block(page, id.hour)).toBeVisible();
      await expect(block(page, id.hour).locator('.day-ev-text')).toHaveText(LONG);
      expect((await measure(page, id.hour)).height, 'the block put back is as tall as it was').toBeCloseTo(drawn.height, 0);
      // It shows as many lines as its room holds, like the block next to it that was never touched.
      await expect.poll(() => unfitted(page, id), { message: 'the block put back holds as many lines as its room, as the one beside it does' }).toEqual([]);
      expectFilled('the hour put back', await measure(page, id.hour));
      expect((await measure(page, id.hour)).lines).toBe(drawn.lines);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});
