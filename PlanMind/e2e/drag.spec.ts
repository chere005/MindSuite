import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { apiLogin, draftSpan, farDate, field, isPhone, login, noWindow, resetPrefs, showHalf, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// Dragging in the schedule, with real pointer input: a mouse (many small moves, a held button, a release anywhere), a pen,
// and a finger (CDP touch events: press and hold about 0.4 s, then drag). Moving an entry by dragging it, the edit-mode
// handles that resize it, Escape and a cancelled pointer, a stale or refused drop, Alt+Arrow, and the geometry the drags rely
// on. The mouse tests run on the desktop project (and in WebKit with PLANMIND_E2E_WEBKIT=1); the touch tests on the phone project.
const add = async (api: Api, body: Record<string, unknown>) => {
  const data = { id: crypto.randomUUID(), ...body };
  const response = await api.post(data);
  expect(response.status(), JSON.stringify(await response.json())).toBe(200);
  return data.id as string;
};
const event = (date: string, over: Record<string, unknown> = {}) => ({ action: 'add', kind: 'event', date, owners: [OWNER], text: 'Dentist', start: 540, length: 60, ...over });
const openDay = async (page: Page, date: string) => {
  await page.locator(isPhoneView(page) ? '#pill-date' : '#jump-date').fill(date);
  await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', date);
};
const isPhoneView = (page: Page) => (page.viewportSize()?.width ?? 1000) <= 760;
async function clearDay(api: Api, date: string) {
  const snapshot = await api.snapshot();
  for (const item of [...snapshot.tasks, ...snapshot.priorities, ...snapshot.events].filter((i: { date: string }) => i.date === date)) {
    await api.post({ action: 'delete', id: item.id, revision: item.revision, confirm: true });
  }
}
const stored = async (api: Api, date: string) => (await api.snapshot()).events.filter((e: { date: string }) => e.date === date).sort((a: { start: number }, b: { start: number }) => a.start - b.start);
const gridBox = async (page: Page) => (await page.locator('.day-lanes').boundingBox())!;
/** Pixels of the grid for one minute, read live (the hour rows flex with the window). The grid stands for data-span minutes (840, the 14 hours of 7a to 9p) on AM and on PM alike; data-from says where the shown page starts. */
const perMinute = async (page: Page) => {
  const minutes = await page.locator('.day-lanes').evaluate(el => Number((el as HTMLElement).dataset.span));
  return (await gridBox(page)).height / minutes;
};
/** Each grab area's rows of the entry being edited, and what is the topmost thing at its middle, at its first and at its last row: the start's own, every one. */
const handleAreas = (page: Page) => page.evaluate(() => {
  const rect = (edge: string) => document.querySelector<HTMLElement>(`.day-ev.day-editing .day-handle[data-edge=${edge}]`)!.getBoundingClientRect();
  const hit = (x: number, y: number) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('.day-handle')?.dataset.edge ?? null;
  const [start, end] = [rect('start'), rect('end')], x = start.left + start.width / 2;
  return { start: [start.top, start.bottom], end: [end.top, end.bottom],
    hits: { start: [start.top + 1, (start.top + start.bottom) / 2, start.bottom - 1].map(y => hit(x, y)), end: [end.top + 1, (end.top + end.bottom) / 2, end.bottom - 1].map(y => hit(x, y)) } };
});
/** How far EventHandles.fit moved a handle's grab area from its place just outside the edge (positive pulls it in over the entry). */
const shiftOf = (page: Page, edge: 'start' | 'end') => page.locator(`.day-ev.day-editing .day-handle[data-edge=${edge}]`).evaluate(el => parseFloat((el as HTMLElement).style.getPropertyValue('--shift')) || 0);
const block = (page: Page, label: string) => page.getByRole('button', { name: label, exact: true });
/** The entry being edited in its block (no window) and its title field (the time is set only by dragging, or by the keyboard). Nothing else hangs over the schedule: `strip` is the old strip of counter / Delete, which is gone (no test may find it). */
const editing = (page: Page) => page.locator('.day-ev.day-editing');
const strip = (page: Page) => page.locator('.day-ev-strip');
const title = (page: Page, text: string) => field(page, `Edit entry: ${text}`);
const bubble = (page: Page) => page.locator('.day-bubble');
/** The drop's write has been answered and the page has drawn the answer (the redraw is a macrotask after it). A label that changes while
 *  the block moves is no sign of that, so a test that goes on to another gesture waits for this. */
const settled = async (page: Page) => {
  await expect(page.locator('#sync-status')).not.toHaveText('Saving…');
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
};
const centre = async (locator: ReturnType<Page['locator']>) => {
  await locator.scrollIntoViewIfNeeded();
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
};
function recordPosts(page: Page) {
  const posts: Array<Record<string, unknown>> = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('api.php')) { const body = request.postDataJSON(); if (body.action !== 'savePrefs') { posts.push(body); } } });
  return posts;
}

/** A mouse drag in small steps, the button left down. */
async function pressAndMove(page: Page, from: { x: number; y: number }, dy: number, dx = 0, steps = 24) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(from.x + (dx * i) / steps, from.y + (dy * i) / steps); }
}
/** A finger: touch start, hold, then move in small steps. `hold` is how long it rests before moving. */
function finger(cdp: CDPSession) {
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', x = 0, y = 0) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y, id: 1 }] });
  return {
    down: (x: number, y: number) => send('touchStart', x, y),
    move: (x: number, y: number) => send('touchMove', x, y),
    up: () => send('touchEnd'),
    cancel: () => send('touchCancel'),
    async drag(from: { x: number; y: number }, dy: number, steps = 20) { for (let i = 1; i <= steps; i++) { await send('touchMove', from.x, from.y + (dy * i) / steps); } },
  };
}

test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });

test.describe('dragging an entry with a mouse or a pen', () => {
  test.beforeEach(async ({}, info) => { test.skip(isPhone(info.project.name), 'mouse and pen: the desktop projects'); });

  test('press and move: the block follows the pointer in 15-minute steps, shows the span, and the drop is one write with the revision', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(600);
    const id = await add(owner, event(date));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      const from = await centre(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`)), minute = await perMinute(page);
      const lane = from.box.x;
      await pressAndMove(page, from, 80 * minute);
      // 80 minutes down is 10:20, which is between steps: the label says the quarter hour it snaps to, 10:15.
      await expect(bubble(page)).toHaveText('10:15a – 11:15a');
      await expect(page.locator('.day-ev[data-moving]')).toHaveCount(1);
      // While it moves, its time and its spoken label say where it is now, not where it was.
      const moving = page.locator('.day-ev[data-moving]');
      await expect(moving).toHaveAttribute('aria-label', `Dentist, 10:15a to 11:15a, ${OWNER_NAME}`);
      await expect(moving.locator('.day-ev-time')).toHaveText('10:15a');
      expect(Math.abs((await moving.boundingBox())!.y - (from.box.y + 75 * minute)), 'the block sits at the snapped step').toBeLessThanOrEqual(2);
      expect((await moving.boundingBox())!.x, 'it never leaves its lane').toBe(lane);
      expect(posts, 'nothing is written while it moves').toHaveLength(0);
      await page.mouse.up();
      await settled(page);
      await expect(block(page, `Dentist, 10:15a to 11:15a, ${OWNER_NAME}`)).toBeVisible();
      await expect(bubble(page)).toHaveCount(0);
      await expect(editing(page)).toHaveCount(0);
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: [OWNER], text: 'Dentist', start: 615, length: 60 }]);
      expect((await stored(owner, date))[0]).toMatchObject({ start: 615, length: 60, owners: [OWNER], revision: 2 });
      // Dragged back up past the first row it stops at 7:00, whatever the pointer does.
      const again = await centre(block(page, `Dentist, 10:15a to 11:15a, ${OWNER_NAME}`));
      await pressAndMove(page, again, -600 * minute);
      await expect(bubble(page)).toHaveText('7a – 8a');
      await page.mouse.up();
      await settled(page);
      expect((await stored(owner, date))[0]).toMatchObject({ start: 420, revision: 3 });
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a click edits the entry in its block, and so does a press that moves less than 4px', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(601);
    await add(owner, event(date));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`).click();
      await expect(editing(page)).toHaveCount(1);
      await expect(title(page, 'Dentist')).toBeFocused();
      await noWindow(page);
      await page.keyboard.press('Escape');
      await expect(editing(page)).toHaveCount(0);
      const from = await centre(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`));
      await page.mouse.move(from.x, from.y); await page.mouse.down();
      await page.mouse.move(from.x + 2, from.y + 3, { steps: 3 });
      await page.mouse.up();
      await expect(editing(page)).toHaveCount(1);
      await expect(bubble(page)).toHaveCount(0);
      expect(posts).toHaveLength(0);
      // After a real drag, no click follows to open the entry for editing.
      await page.keyboard.press('Escape');
      await expect(editing(page)).toHaveCount(0);
      await pressAndMove(page, from, 60 * (await perMinute(page)));
      await page.mouse.up();
      await expect(editing(page)).toHaveCount(0);
      expect(posts).toHaveLength(1);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('it lands on the nearest free quarter hour inside its own lanes: a neighbour in the lane is jumped, another lane does not matter, a Both entry is held by both', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(602);
    await add(owner, event(date));
    await add(owner, event(date, { text: 'Gym', start: 660 }));
    await add(owner, event(date, { text: 'Yoga', owners: [PARTNER], start: 540 }));
    await add(owner, event(date, { text: 'Lunch', owners: [OWNER, PARTNER], start: 780 }));
    await add(owner, event(date, { text: 'Call', owners: [PARTNER], start: 840 }));
    try {
      await login(page); await openDay(page, date);
      const minute = await perMinute(page);
      // Dentist (9a, the owner's lane) dragged onto Gym's hour: the 11:30 it aims at is taken, so it lands at noon, the nearest free start.
      const dentist = await centre(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`));
      await pressAndMove(page, dentist, 150 * minute);
      await expect(bubble(page)).toHaveText('12p – 1p');
      await page.mouse.up();
      await settled(page);
      await expect(block(page, `Dentist, 12p to 1p, ${OWNER_NAME}`)).toBeVisible();
      // The partner's Yoga at 9a was never in its way, and the Both entry Lunch (1p to 2p) now touches it: touching is fine.
      // Lunch is in the partner's lane too, so dragging it onto the partner's Call (2p) lands on the far side of Call, 3p.
      const lunch = await centre(block(page, 'Lunch, 1p to 2p, Both'));
      await pressAndMove(page, lunch, 75 * minute);
      await expect(bubble(page)).toHaveText('3p – 4p');
      await page.mouse.up();
      await settled(page);
      await expect(block(page, 'Lunch, 3p to 4p, Both')).toBeVisible();
      expect((await stored(owner, date)).map((e: { text: string; start: number; owners: string[] }) => [e.text, e.start, e.owners.join('+')])).toEqual([
        ['Yoga', 540, PARTNER], ['Gym', 660, OWNER], ['Dentist', 720, OWNER], ['Call', 840, PARTNER], ['Lunch', 900, `${OWNER}+${PARTNER}`],
      ]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('Escape puts the entry back and writes nothing; the entry being edited stays open with its text', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(603);
    await add(owner, event(date));
    await add(owner, event(date, { text: 'Gym', start: 720, length: 30 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      // A block that is not being edited: Escape in the middle of its drag puts it back.
      const from = await centre(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`)), minute = await perMinute(page), before = from.box.y;
      await pressAndMove(page, from, 90 * minute);
      await expect(bubble(page)).toHaveText('10:30a – 11:30a');
      await page.keyboard.press('Escape');
      await expect(bubble(page)).toHaveCount(0);
      await expect(page.locator('.day-ev[data-moving]')).toHaveCount(0);
      expect(Math.abs((await block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`).boundingBox())!.y - before)).toBeLessThanOrEqual(1);
      // The button is still down; letting go now does nothing more.
      await page.mouse.up();
      expect(posts).toHaveLength(0);
      expect((await stored(owner, date))[0]).toMatchObject({ start: 540, revision: 1 });
      // The entry being edited: Escape in the middle of moving its block puts the draft back, and the entry stays open with what was typed.
      await block(page, `Gym, 12p to 12:30p, ${OWNER_NAME}`).click();
      const input = title(page, 'Gym');
      await input.fill('Gym and sauna');
      const gym = await centre(editing(page));
      await pressAndMove(page, gym, 60 * minute);
      await expect(bubble(page)).toHaveText('1p – 1:30p');
      await page.keyboard.press('Escape');
      await expect(bubble(page)).toHaveCount(0);
      await expect.poll(() => draftSpan(page)).toEqual({ start: 720, length: 30 });
      await page.mouse.up();
      await expect(editing(page)).toHaveCount(1);
      await expect(input).toHaveValue('Gym and sauna');
      await expect(input).toBeFocused();
      expect(posts).toHaveLength(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a stale drop snaps back and says so; a drop the server refuses snaps back with its words', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER), date = farDate(604);
    const id = await add(owner, event(date));
    try {
      await login(page); await openDay(page, date);
      const minute = await perMinute(page);
      // The partner renames it while the pointer is down.
      let from = await centre(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`));
      await pressAndMove(page, from, 60 * minute);
      expect((await partner.post({ action: 'edit', kind: 'event', id, revision: 1, date, owners: [OWNER], text: 'Orthodontist', start: 540, length: 60 })).status()).toBe(200);
      await page.mouse.up();
      await expect(page.getByRole('alert')).toContainText('changed on another device');
      await expect(block(page, `Orthodontist, 9a to 10a, ${OWNER_NAME}`)).toBeVisible();
      expect((await stored(owner, date))[0]).toMatchObject({ text: 'Orthodontist', start: 540, revision: 2 });
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      // Another device takes the landing time before the drop: the server says so, and the block is back.
      from = await centre(block(page, `Orthodontist, 9a to 10a, ${OWNER_NAME}`));
      await pressAndMove(page, from, 120 * minute);
      await expect(bubble(page)).toHaveText('11a – 12p');
      await add(partner, event(date, { text: 'Taken', owners: [OWNER], start: 660, length: 60 }));
      await page.mouse.up();
      await expect(page.getByRole('alert')).toContainText('already taken');
      await expect(block(page, `Orthodontist, 9a to 10a, ${OWNER_NAME}`)).toBeVisible();
      expect((await stored(owner, date)).map((e: { text: string; start: number }) => [e.text, e.start])).toEqual([['Orthodontist', 540], ['Taken', 660]]);
    } finally { await clearDay(owner, date); await owner.dispose(); await partner.dispose(); }
  });

  test('while an entry is edited, dragging its block changes the draft and keeps the typed text; Enter is one write; the handles still work', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(605);
    const id = await add(owner, event(date));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`).click();
      const input = title(page, 'Dentist');
      await expect(strip(page)).toHaveCount(0);
      await input.fill('Dentist, cleaning');
      const minute = await perMinute(page);
      // A press on the field itself that goes up or down is the block moving (sideways it would select text).
      await pressAndMove(page, await centre(editing(page)), 30 * minute);
      await expect(bubble(page)).toHaveText('9:30a – 10:30a');
      await page.mouse.up();
      // The block's own time label (the start) follows the draft; there is no span label any more.
      await expect(editing(page).locator('.day-ev-time')).toHaveText('9:30a');
      await expect.poll(() => draftSpan(page)).toMatchObject({ start: 570 });
      await expect(input).toHaveValue('Dentist, cleaning');
      await expect(input).toBeFocused();
      expect(posts, 'a move of the draft is not a write').toHaveLength(0);
      // The end handle still resizes it, after the move.
      const handle = await centre(page.locator('.day-handle[data-edge=end]'));
      await pressAndMove(page, handle, 15 * minute, 0, 6);
      await expect(bubble(page)).toHaveText('9:30a – 10:45a');
      await page.mouse.up();
      await expect.poll(() => draftSpan(page)).toEqual({ start: 570, length: 75 });
      await input.press('Enter');
      await expect(editing(page)).toHaveCount(0);
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: [OWNER], text: 'Dentist, cleaning', start: 570, length: 75 }]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('pressing another entry to move it is the focus leaving the one being edited: its text is saved first, and the move is its own write', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(606);
    await add(owner, event(date));
    await add(owner, event(date, { text: 'Gym', start: 720, length: 30 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await block(page, `Gym, 12p to 12:30p, ${OWNER_NAME}`).click();
      const input = title(page, 'Gym');
      await input.fill('Gym, then the pool');
      const minute = await perMinute(page);
      await pressAndMove(page, await centre(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`)), 30 * minute);
      await page.mouse.up();
      await settled(page);
      await expect(editing(page)).toHaveCount(0);
      expect(posts.map(p => [p.text, p.start])).toEqual([['Gym, then the pool', 720], ['Dentist', 570]]);
      expect((await stored(owner, date)).map((e: { text: string; start: number }) => [e.text, e.start])).toEqual([['Dentist', 570], ['Gym, then the pool', 720]]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a pen moves an entry like a mouse, and a release outside the window still drops it', async ({ page, baseURL, browserName }) => {
    test.skip(browserName !== 'chromium', 'pen input is dispatched through the Chromium protocol');
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(607);
    await add(owner, event(date));
    try {
      await login(page); await openDay(page, date);
      const cdp = await page.context().newCDPSession(page);
      const pen = (type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', x: number, y: number, buttons = 1) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, pointerType: 'pen' });
      const from = await centre(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`)), minute = await perMinute(page);
      await pen('mousePressed', from.x, from.y);
      for (let i = 1; i <= 20; i++) { await pen('mouseMoved', from.x, from.y + (45 * minute * i) / 20); }
      await expect(bubble(page)).toHaveText('9:45a – 10:45a');
      // Released far below the window: the entry goes to the last start the shown page still has some of it in (AM ends at 9p, so 8:45p: a
      // quarter hour of it shows and it runs on past the edge to 9:45p), and the pen is not left holding it.
      await pen('mouseMoved', from.x + 40, 5000);
      await pen('mouseReleased', from.x + 40, 5000, 0);
      await expect(page.locator('.day-ev[data-moving]')).toHaveCount(0);
      await expect.poll(async () => (await stored(owner, date))[0]).toMatchObject({ start: 1245, length: 60 });
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('nothing is selected while dragging, nothing hangs over the schedule, and the cursor says what is happening', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(608);
    await add(owner, event(date));
    await add(owner, event(date, { text: 'Gym', start: 720, length: 30 }));
    try {
      await login(page); await openDay(page, date);
      await block(page, `Gym, 12p to 12:30p, ${OWNER_NAME}`).click();
      await expect(editing(page)).toHaveCount(1);
      await expect(strip(page)).toHaveCount(0);
      await expect(page.locator('html')).not.toHaveClass(/dragging/);
      const minute = await perMinute(page);
      const handle = await centre(page.locator('.day-handle[data-edge=end]'));
      // Sweep over the text of other rows and the page: no text gets selected, the cursor is the grab cursor.
      await pressAndMove(page, handle, 200 * minute, -300, 30);
      expect(await page.evaluate(() => String(getSelection()))).toBe('');
      await expect(page.locator('html')).toHaveClass(/dragging/);
      expect(await page.locator('body').evaluate(el => getComputedStyle(el).cursor)).toBe('grabbing');
      await page.mouse.up();
      await expect(page.locator('html')).not.toHaveClass(/dragging/);
      expect(await page.evaluate(() => String(getSelection()))).toBe('');
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the drag reads the grid live: a window that changes size or scrolls while the button is down moves the mapping with it', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(609);
    await add(owner, event(date));
    try {
      await page.setViewportSize({ width: 1360, height: 1850 });
      await login(page); await openDay(page, date);
      const originalHeight = (await gridBox(page)).height;
      // The pointer takes the block half an hour in from its top (it is centred on a 60-minute entry).
      const from = await centre(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`));
      await page.mouse.move(from.x, from.y); await page.mouse.down();
      await page.mouse.move(from.x, from.y + 40, { steps: 6 });
      // A shorter window makes the timeline shorter. The pointer goes to 2:30p on the NEW grid: the entry is half an
      // hour above it. A mapping that kept the grid's old box would put it somewhere else.
      await page.setViewportSize({ width: 1360, height: 1350 });
      await expect.poll(async () => (await gridBox(page)).height).toBeLessThan(originalHeight);
      const grid = await gridBox(page);
      await page.mouse.move(from.x, grid.y + (grid.height * (14 * 60 + 30 - 420)) / 840, { steps: 4 });
      await expect(bubble(page)).toHaveText('2p – 3p');
      await page.mouse.up();
      expect((await stored(owner, date))[0].start).toBe(840);
      await expect(block(page, `Dentist, 2p to 3p, ${OWNER_NAME}`)).toBeVisible();
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a wheel scroll of the timeline while dragging moves the entry under the pointer', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(614);
    await add(owner, event(date));
    try {
      await page.setViewportSize({ width: 1000, height: 520 });
      await login(page); await openDay(page, date);
      const host = page.locator('.day-timeline');
      expect(await host.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
      const from = await centre(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`));
      await page.mouse.move(from.x, from.y); await page.mouse.down();
      await page.mouse.move(from.x, from.y + 30, { steps: 6 });
      await page.mouse.wheel(0, 120);
      await expect.poll(() => host.evaluate(el => el.scrollTop)).toBeGreaterThan(50);
      await page.mouse.move(from.x, from.y + 31);
      // The pointer is at y = from.y + 31, over whatever the scrolled grid has there now.
      const grid = await gridBox(page);
      const minuteUnder = 420 + ((from.y + 31 - grid.y) / grid.height) * 840;
      const expected = Math.min(1200, Math.max(420, Math.round((minuteUnder - 30) / 15) * 15));
      const hh = (m: number) => `${Math.floor(m / 60) % 12 || 12}${m % 60 ? `:${String(m % 60).padStart(2, '0')}` : ''}${m < 720 ? 'a' : 'p'}`;
      await expect(bubble(page)).toHaveText(`${hh(expected)} – ${hh(expected + 60)}`);
      await page.mouse.up();
      expect((await stored(owner, date))[0].start).toBe(expected);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('after switching straight from one entry being edited to another, the second one\'s block is draggable, and the focus stays in its field so Escape still closes it', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(630);
    await add(owner, event(date, { text: 'Alpha', start: 540 }));
    await add(owner, event(date, { text: 'Bravo', start: 780 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await block(page, `Alpha, 9a to 10a, ${OWNER_NAME}`).click();
      await expect(editing(page)).toHaveCount(1);
      // Bravo takes Alpha's place as the entry being edited: Alpha is a plain block again.
      await block(page, `Bravo, 1p to 2p, ${OWNER_NAME}`).click();
      await expect(editing(page)).toHaveCount(1);
      await expect(title(page, 'Bravo')).toBeFocused();
      const minute = await perMinute(page);
      await pressAndMove(page, await centre(editing(page)), 30 * minute);
      await expect(bubble(page)).toHaveText('1:30p – 2:30p');
      await page.mouse.up();
      await expect.poll(() => draftSpan(page)).toMatchObject({ start: 810 });
      await expect(editing(page).locator('.day-ev-time')).toHaveText('1:30p');
      // The press on the block did not take the keyboard away from the field: it still has it, and Escape puts everything back.
      await expect(title(page, 'Bravo')).toBeFocused();
      expect(posts, 'a move of the draft is not a write').toHaveLength(0);
      await page.keyboard.press('Escape');
      await expect(editing(page)).toHaveCount(0);
      expect((await stored(owner, date)).map((e: { text: string; start: number }) => [e.text, e.start])).toEqual([['Alpha', 540], ['Bravo', 780]]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a scroll while the button is down, with the pointer still, moves the label and the drop to what is under the pointer now', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(631);
    await add(owner, event(date));
    try {
      await page.setViewportSize({ width: 1000, height: 520 });
      await login(page); await openDay(page, date);
      const host = page.locator('.day-timeline');
      expect(await host.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
      const from = await centre(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`));
      await page.mouse.move(from.x, from.y); await page.mouse.down();
      await page.mouse.move(from.x, from.y + 30, { steps: 6 });
      const before = (await bubble(page).textContent())!;
      await page.mouse.wheel(0, 120);
      await expect.poll(() => host.evaluate(el => el.scrollTop)).toBeGreaterThan(50);
      // No pointer move since: the label has followed the scroll by itself.
      const grid = await gridBox(page);
      const minuteUnder = 420 + ((from.y + 30 - grid.y) / grid.height) * 840;
      const expected = Math.min(1200, Math.max(420, Math.round((minuteUnder - 30) / 15) * 15));
      const hh = (m: number) => `${Math.floor(m / 60) % 12 || 12}${m % 60 ? `:${String(m % 60).padStart(2, '0')}` : ''}${m < 720 ? 'a' : 'p'}`;
      await expect(bubble(page)).toHaveText(`${hh(expected)} – ${hh(expected + 60)}`);
      expect(await bubble(page).textContent(), 'the scroll moved it').not.toBe(before);
      await page.mouse.up();
      await settled(page);
      expect((await stored(owner, date))[0].start, 'the drop is what the label showed').toBe(expected);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a moved entry shows its new time and label at once, also while another entry is being edited', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(632);
    await add(owner, event(date, { text: 'Alpha', start: 540 }));
    await add(owner, event(date, { text: 'Bravo', start: 720 }));
    try {
      await login(page); await openDay(page, date);
      await block(page, `Alpha, 9a to 10a, ${OWNER_NAME}`).click();
      await expect(editing(page)).toHaveCount(1);
      const minute = await perMinute(page);
      await pressAndMove(page, await centre(block(page, `Bravo, 12p to 1p, ${OWNER_NAME}`)), 90 * minute);
      await page.mouse.up();
      await settled(page);
      // The page is not redrawn while a field has the focus, so the block itself must say it.
      const moved = block(page, `Bravo, 1:30p to 2:30p, ${OWNER_NAME}`);
      await expect(moved).toBeVisible();
      await expect(moved.locator('.day-ev-time')).toHaveText('1:30p');
      expect((await stored(owner, date))[1]).toMatchObject({ text: 'Bravo', start: 810 });
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('Alt+Arrow presses that come while a write is in flight wait in line instead of being dropped; a press on a block while saving says so', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(633);
    await add(owner, event(date, { text: 'Alpha', start: 540 }));
    await add(owner, event(date, { text: 'Bravo', start: 720 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await page.route(url => url.pathname.endsWith('/api.php'), async route => {
        if (route.request().method() === 'POST' && (route.request().postData() ?? '').includes('"edit"')) { await new Promise(resolve => setTimeout(resolve, 400)); }
        await route.continue();
      });
      await block(page, `Alpha, 9a to 10a, ${OWNER_NAME}`).focus();
      for (let i = 0; i < 3; i++) { await page.keyboard.press('Alt+ArrowDown'); }
      // While the first write is out, a press on another block is refused out loud.
      await block(page, `Bravo, 12p to 1p, ${OWNER_NAME}`).dispatchEvent('pointerdown', { isPrimary: true, button: 0, pointerType: 'mouse' });
      await expect(page.locator('#live')).toHaveText('Still saving. Try again in a moment.');
      await expect.poll(async () => (await stored(owner, date))[0].start, { timeout: 10000 }).toBe(585);
      expect(posts.map(p => [p.start, p.revision])).toEqual([[555, 1], [570, 2], [585, 3]]);
      await expect(page.locator('#live')).toHaveText('Alpha moved to 9:45a – 10:45a.');
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});

test.describe('the edit-mode handles', () => {
  test.beforeEach(async ({}, info) => { test.skip(isPhone(info.project.name), 'the desktop projects; the phone has its own in the touch tests'); });

  test('the grab areas are at least 20px tall, sit outside the entry, and leave an entry just above or below clickable beside them', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(610);
    await add(owner, event(date, { text: 'Above', start: 690, length: 30 }));
    await add(owner, event(date, { text: 'Mid', start: 720, length: 30 }));
    await add(owner, event(date, { text: 'Below', start: 750, length: 30 }));
    try {
      await login(page); await openDay(page, date);
      await block(page, `Mid, 12p to 12:30p, ${OWNER_NAME}`).click();
      for (const edge of ['start', 'end']) {
        const handle = page.locator(`.day-handle[data-edge=${edge}]`), mid = (await page.locator('.day-ev.day-editing').boundingBox())!, box = (await handle.boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(20);
        expect(box.width, 'a pointer-wide target').toBeGreaterThanOrEqual(44);
        // Outside the entry, above its start and below its end, so it never covers the entry's own text.
        if (edge === 'start') { expect(box.y + box.height).toBeLessThanOrEqual(mid.y + 3); } else { expect(box.y).toBeGreaterThanOrEqual(mid.y + mid.height - 3); }
        // The element at its centre is the handle: nothing covers it.
        expect(await page.evaluate(([x, y]) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('.day-handle')?.getAttribute('data-edge') ?? null, [box.x + box.width / 2, box.y + box.height / 2])).toBe(edge);
      }
      // The entry above and the entry below are each still reachable on the side of the handle's 56px.
      const above = (await block(page, `Above, 11:30a to 12p, ${OWNER_NAME}`).boundingBox())!, below = (await block(page, `Below, 12:30p to 1p, ${OWNER_NAME}`).boundingBox())!;
      for (const target of [above, below]) {
        const x = target.x + 16, y = target.y + target.height / 2;
        expect(await page.evaluate(([px, py]) => (document.elementFromPoint(px, py) as HTMLElement | null)?.closest('.day-ev')?.classList.contains('day-editing') === false, [x, y])).toBe(true);
      }
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a handle drag that is cancelled puts the edge back; the label is above the pointer, inside the window', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(611);
    await add(owner, event(date));
    try {
      await login(page); await openDay(page, date);
      await block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`).click();
      await expect(title(page, 'Dentist')).toBeFocused();
      const minute = await perMinute(page), handle = await centre(page.locator('.day-handle[data-edge=end]'));
      await pressAndMove(page, handle, 45 * minute, 0, 10);
      await expect(bubble(page)).toHaveText('9a – 10:45a');
      const label = (await bubble(page).boundingBox())!;
      expect(label.y + label.height, 'above the pointer').toBeLessThanOrEqual(handle.y + 45 * minute - 20);
      expect(label.x).toBeGreaterThanOrEqual(0);
      expect(label.x + label.width).toBeLessThanOrEqual(1360);
      await page.keyboard.press('Escape');
      await expect.poll(() => draftSpan(page)).toEqual({ start: 540, length: 60 });
      await expect(editing(page)).toHaveCount(1);
      await page.mouse.up();
      await expect(editing(page).locator('.day-ev-time')).toHaveText('9a');
      // The press on the handle never took the keyboard from the title.
      await expect(title(page, 'Dentist')).toBeFocused();
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});

test.describe('nothing hangs over the schedule while an entry is edited, so its handles are reachable', () => {
  test.beforeEach(async ({}, info) => { test.skip(isPhone(info.project.name), 'the desktop layout at narrow widths; the phone project has its own'); });

  // An entry being edited is its time label, its title field and its two handles: no strip of counter / Delete hangs beside it any more.
  // At every width the wide layout has (a narrow window, an iPad held upright, a phone held sideways with a finger), with the sidebar shown or hidden,
  // there is no strip, nothing but those parts in the block, and every handle is the topmost thing at its middle.
  const sizes = [
    [761, 800, false, false], [800, 800, false, false], [900, 800, false, false], [1000, 800, false, false], [1001, 800, false, false], [1100, 800, false, false],
    [820, 1180, true, false], [844, 390, true, false], [800, 800, false, true], [1001, 800, false, true],
  ] as const;
  sizes.forEach(([width, height, touch, hidden], n) => {
    test(`${width}x${height}${touch ? ' with a finger' : ''}${hidden ? ', sidebar hidden' : ''}: every handle of an entry in either lane, or in both, is the topmost thing at its middle while it is edited and nothing hangs over the schedule`, async ({ browser, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = farDate(640 + n);
      if (hidden) { expect((await owner.post({ action: 'savePrefs', selection: { base: 'both', overlays: [] }, sidebar: 'hidden' })).status()).toBe(200); }
      const entries = [['Dawn', OWNER, 420], ['Early', PARTNER, 480], ['Mid', OWNER, 660], ['Lunch', 'both', 780], ['Late', PARTNER, 1110], ['Dusk', OWNER, 1230]] as const;
      for (const [text, who, start] of entries) { await add(owner, event(date, { text, start, length: 30, owners: who === 'both' ? [OWNER, PARTNER] : [who] })); }
      const context = await browser.newContext({ baseURL, viewport: { width, height }, hasTouch: touch });
      const page = await context.newPage();
      try {
        await login(page); await openDay(page, date);
        for (const [text, who, start] of entries) {
          const hh = (m: number) => `${Math.floor(m / 60) % 12 || 12}${m % 60 ? `:${String(m % 60).padStart(2, '0')}` : ''}${m < 720 ? 'a' : 'p'}`;
          await block(page, `${text}, ${hh(start)} to ${hh(start + 30)}, ${who === 'both' ? 'Both' : who === PARTNER ? PARTNER_NAME : OWNER_NAME}`).click();
          await expect(editing(page)).toHaveCount(1);
          await expect(strip(page)).toHaveCount(0);
          for (const edge of ['start', 'end']) {
            await expect.poll(() => page.evaluate(selector => {
              const handle = document.querySelector<HTMLElement>(selector)!, r = handle.getBoundingClientRect();
              const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
              return { inside: r.top >= 0 && r.bottom <= innerHeight, hit: top?.closest('.day-handle') === handle, height: r.height };
            }, `.day-ev.day-editing .day-handle[data-edge=${edge}]`), { message: `${text} ${edge} handle after the scroll settles` }).toMatchObject({ inside: true, hit: true });
          }
          // The block holds only the time label (the start), the title field and the two handles; the counter, the span, the hint, the message and Delete are gone from it.
          const parts = await page.evaluate(() => {
            const b = document.querySelector('.day-ev.day-editing')!, r = b.getBoundingClientRect();
            return {
              children: [...b.children].map(c => c.className.split(' ').filter(n => /^(day-ev-time|ip-input|day-ev-input|day-handle)$/.test(n)).join(' ') + (c.getAttribute('data-edge') ? `:${c.getAttribute('data-edge')}` : '')),
              extras: b.querySelectorAll('.day-ev-strip, .ip-span, .ip-count, .ip-hint, .ip-error, .ip-del').length,
              inside: r.left >= 0 && r.right <= innerWidth,
            };
          });
          expect(parts, `${text}: nothing but the time, the title and the handles, inside the window's width`).toEqual({ children: ['day-ev-time', 'ip-input day-ev-input', 'day-handle:start', 'day-handle:end'], extras: 0, inside: true });
          await page.keyboard.press('Escape');
          await expect(editing(page)).toHaveCount(0);
        }
      } finally { await context.close(); await clearDay(owner, date); await owner.dispose(); }
    });
  });
});

test.describe('a drag that loses its pointer', () => {
  test.beforeEach(async ({}, info) => { test.skip(isPhone(info.project.name), 'a mouse: the desktop projects'); });

  test('when the system takes the pointer away (capture lost) a moved entry and a moved edge both go back, and nothing stays held', async ({ page, baseURL, browserName }) => {
    test.skip(browserName !== 'chromium', 'the capture is taken away through the Chromium protocol');
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(615);
    await add(owner, event(date));
    await add(owner, event(date, { text: 'Gym', start: 720, length: 30 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      const minute = await perMinute(page);
      // An entry being moved: the element that holds the pointer lets go of it.
      await pressAndMove(page, await centre(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`)), 60 * minute);
      await expect(bubble(page)).toHaveText('10a – 11a');
      // (The event is delivered with the next pointer event, as the specification has it: the mouse moves a pixel.)
      await page.evaluate(() => { const el = document.querySelector<HTMLElement>('.day-ev[data-moving]')!; el.releasePointerCapture(1); });
      await page.mouse.move(await page.evaluate(() => innerWidth / 2), 400);
      await expect(page.locator('.day-ev[data-moving]')).toHaveCount(0);
      await expect(bubble(page)).toHaveCount(0);
      await expect(page.locator('html')).not.toHaveClass(/dragging/);
      await page.mouse.up();
      await expect(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`)).toBeVisible();
      expect(posts).toHaveLength(0);
      // An edge being moved in the editor: the same.
      await block(page, `Gym, 12p to 12:30p, ${OWNER_NAME}`).click();
      await expect(title(page, 'Gym')).toBeFocused();
      await pressAndMove(page, await centre(page.locator('.day-handle[data-edge=end]')), 60 * minute, 0, 10);
      await expect(bubble(page)).toHaveText('12p – 1:30p');
      await page.evaluate(() => { document.querySelector<HTMLElement>('.day-handle[data-edge=end]')!.releasePointerCapture(1); });
      await page.mouse.move(await page.evaluate(() => innerWidth / 2), 420);
      await expect(bubble(page)).toHaveCount(0);
      await expect.poll(() => draftSpan(page)).toEqual({ start: 720, length: 30 });
      await page.mouse.up();
      expect(posts).toHaveLength(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});

test.describe('Alt+Up and Alt+Down', () => {
  test.beforeEach(async ({}, info) => { test.skip(isPhone(info.project.name), 'a keyboard: the desktop projects'); });

  test('move the focused entry 15 minutes through the same write, say what happened, and keep the focus on the entry', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(612);
    const id = await add(owner, event(date));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`).focus();
      await page.keyboard.press('Alt+ArrowDown');
      await expect(block(page, `Dentist, 9:15a to 10:15a, ${OWNER_NAME}`)).toBeFocused();
      await expect(page.locator('#live')).toHaveText('Dentist moved to 9:15a – 10:15a.');
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: [OWNER], text: 'Dentist', start: 555, length: 60 }]);
      await page.keyboard.press('Alt+ArrowUp');
      await expect(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`)).toBeFocused();
      await page.keyboard.press('Alt+ArrowUp');
      await expect(block(page, `Dentist, 8:45a to 9:45a, ${OWNER_NAME}`)).toBeFocused();
      await expect(page.locator('#live')).toHaveText('Dentist moved to 8:45a – 9:45a.');
      expect((await stored(owner, date))[0]).toMatchObject({ start: 525, revision: 4 });
      // Without Alt the arrows do nothing to it, and nothing opens for editing.
      await page.keyboard.press('ArrowDown');
      await expect(editing(page)).toHaveCount(0);
      expect(posts).toHaveLength(3);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('it stops at the edge of the day and at a neighbour, says so, and writes nothing', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(613);
    await add(owner, event(date, { text: 'First', start: 420, length: 30 }));
    await add(owner, event(date, { text: 'Next', start: 450, length: 30 }));
    await add(owner, event(date, { text: 'Her call', owners: [PARTNER], start: 480, length: 30 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await block(page, `First, 7a to 7:30a, ${OWNER_NAME}`).focus();
      await page.keyboard.press('Alt+ArrowUp');
      await expect(page.locator('#live')).toHaveText('First cannot move earlier: it is at the start of the schedule.');
      await page.keyboard.press('Alt+ArrowDown');
      await expect(page.locator('#live')).toHaveText('First cannot move later: it would overlap Next.');
      // Another lane is no obstacle: Next may move down past the partner's entry.
      await block(page, `Next, 7:30a to 8a, ${OWNER_NAME}`).focus();
      await page.keyboard.press('Alt+ArrowDown');
      await expect(page.locator('#live')).toHaveText('Next moved to 7:45a – 8:15a.');
      expect(posts).toHaveLength(1);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});

test.describe('touch: press and hold, then drag', () => {
  test.beforeEach(async ({}, info) => { test.skip(!isPhone(info.project.name), 'a finger: the phone project'); });

  test('the timeline pans under a held entry or resize handle at its edge', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(642);
    await add(owner, event(date, { start: 600 }));
    await add(owner, event(date, { text: 'Hers', start: 600, owners: [PARTNER] }));
    try {
      await page.setViewportSize({ width: 375, height: 450 });
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      const timeline = page.locator('.day-timeline');
      const edge = async () => {
        const { y, height } = (await timeline.boundingBox())!;
        return y + height - 8;
      };
      const scrollTop = () => timeline.evaluate(el => el.scrollTop);
      const f = finger(await page.context().newCDPSession(page));
      const from = await centre(block(page, `Dentist, 10a to 11a, ${OWNER_NAME}`));
      await f.down(from.x, from.y);
      await expect(page.locator('.day-ev[data-moving]')).toHaveCount(1);
      await f.drag(from, await edge() - from.y);
      await expect.poll(scrollTop).toBeGreaterThanOrEqual(48);
      await f.up();
      await expect.poll(async () => (await stored(owner, date)).find((e: { text: string }) => e.text === 'Dentist').start).toBeGreaterThan(780);

      await timeline.evaluate(el => { el.scrollTop = 0; });
      await block(page, `Hers, 10a to 11a, ${PARTNER_NAME}`).tap();
      await expect(title(page, 'Hers')).toBeFocused();
      const end = await centre(page.locator('.day-handle[data-edge=end]')), before = await scrollTop();
      await f.down(end.x, end.y);
      await f.drag(end, await edge() - end.y);
      await expect.poll(scrollTop).toBeGreaterThan(before + 24);
      await f.up();
      await expect.poll(async () => (await draftSpan(page)).length).toBeGreaterThan(60);
      await title(page, 'Hers').press('Enter');
      await expect.poll(async () => (await stored(owner, date)).find((e: { text: string }) => e.text === 'Hers').length).toBeGreaterThan(60);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('holding an entry about 0.4s lifts it, then it follows the finger in 15-minute steps, with the span above the finger; the drop is one write', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(620);
    const id = await add(owner, event(date));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      const f = finger(await page.context().newCDPSession(page));
      const from = await centre(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`)), minute = await perMinute(page);
      await f.down(from.x, from.y);
      await page.waitForTimeout(150);
      await expect(page.locator('.day-ev[data-moving]'), 'not lifted after 150ms').toHaveCount(0);
      await expect(page.locator('.day-ev[data-moving]')).toHaveCount(1, { timeout: 2000 });
      await f.drag(from, -100 * minute);
      await expect(bubble(page)).toHaveText('7:15a – 8:15a');
      const label = (await bubble(page).boundingBox())!;
      expect(label.y + label.height, 'above the finger').toBeLessThanOrEqual(from.y - 100 * minute - 20);
      expect(posts).toHaveLength(0);
      await f.up();
      await expect(editing(page)).toHaveCount(0);
      await expect.poll(async () => (await stored(owner, date))[0].start).toBe(435);
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: [OWNER], text: 'Dentist', start: 435, length: 60 }]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a swipe that starts before the hold is over is a scroll, not a move; a tap edits the entry in its block; a cancelled touch puts a lifted entry back', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(621);
    await add(owner, event(date));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      const cdp = await page.context().newCDPSession(page), f = finger(cdp);
      const from = await centre(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`)), minute = await perMinute(page);
      // A quick swipe, 40px in 100ms, then the finger rests: the 0.4s timer was cancelled by the first move.
      await f.down(from.x, from.y);
      await f.drag(from, 40, 4);
      await page.waitForTimeout(700);
      await expect(page.locator('.day-ev[data-moving]')).toHaveCount(0);
      await f.up();
      expect(posts).toHaveLength(0);
      expect((await stored(owner, date))[0]).toMatchObject({ start: 540, revision: 1 });
      // A tap still opens it for editing, in its block.
      await block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`).tap();
      await expect(editing(page)).toHaveCount(1);
      await expect(title(page, 'Dentist')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(editing(page)).toHaveCount(0);
      // Lifted and then cancelled by the system (a call, a gesture): back where it was, nothing written.
      const again = await centre(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`));
      await f.down(again.x, again.y);
      await expect(page.locator('.day-ev[data-moving]')).toHaveCount(1, { timeout: 2000 });
      await f.drag(again, 120 * minute);
      await expect(bubble(page)).toBeVisible();
      await f.cancel();
      await expect(page.locator('.day-ev[data-moving]')).toHaveCount(0);
      await expect(bubble(page)).toHaveCount(0);
      expect(Math.abs((await block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`).boundingBox())!.y - again.box.y)).toBeLessThanOrEqual(1);
      expect(posts).toHaveLength(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the handles of an entry at 7a and at 8:30p can be grabbed: nothing clips them or the tab bar covers them; they are 44px tall; a drag resizes', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(622);
    const first = await add(owner, event(date, { text: 'Early', start: 420, length: 30 }));
    const last = await add(owner, event(date, { text: 'Late', start: 1230, length: 30 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      const f = finger(await page.context().newCDPSession(page));
      // How many pixel rows of a handle's grab area are really its own: nothing clips it (the top bar over a 7a entry) or covers it (the tab bar).
      const reach = (edge: string) => page.evaluate(selector => {
        const h = document.querySelector<HTMLElement>(selector)!, r = h.getBoundingClientRect(), x = r.left + r.width / 2;
        let rows = 0;
        for (let y = Math.ceil(r.top); y < r.bottom; y++) { if (y >= 0 && y < innerHeight && (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('.day-handle') === h) { rows++; } }
        return { height: r.height, rows, tabs: [...document.querySelectorAll<HTMLElement>('.day-tab')].map(tab => { const t = tab.getBoundingClientRect(); return (document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2) as HTMLElement | null)?.closest('.day-tab') === tab; }) };
      }, `.day-handle[data-edge=${edge}]`);
      await block(page, `Early, 7a to 7:30a, ${OWNER_NAME}`).tap();
      await expect(title(page, 'Early')).toBeFocused();
      const start = await reach('start');
      expect(start.height).toBeGreaterThanOrEqual(44);
      expect(start.rows, 'the 7a entry\'s start handle keeps its whole 44px, under the top bar or not').toBeGreaterThanOrEqual(44);
      // Drag its end handle 30 minutes down with a finger (no hold needed: a handle starts at once).
      const minute = await perMinute(page);
      const handle = await centre(page.locator('.day-handle[data-edge=end]'));
      await f.down(handle.x, handle.y);
      await f.drag(handle, 30 * minute, 10);
      await expect(bubble(page)).toHaveText('7a – 8a');
      await f.up();
      await title(page, 'Early').press('Enter');
      await expect.poll(async () => (await stored(owner, date))[0].length).toBe(60);
      // The last entry (it ends at 9p, the bottom of AM): its end handle hangs below the grid, over the tab bar, and is on top of it.
      await block(page, `Late, 8:30p to 9p, ${OWNER_NAME}`).tap();
      await expect(title(page, 'Late')).toBeFocused();
      const end = await reach('end');
      expect(end.height).toBeGreaterThanOrEqual(44);
      expect(end.rows, 'the 8:30p entry\'s end handle keeps its whole 44px above the tab bar').toBeGreaterThanOrEqual(44);
      expect(end.tabs, 'and takes no tap from a tab').toEqual([true, true, true, true]);
      const grab = await centre(page.locator('.day-handle[data-edge=start]'));
      await f.down(grab.x, grab.y);
      await f.drag(grab, -30 * (await perMinute(page)), 10);
      await expect(bubble(page)).toHaveText('8p – 9p');
      await f.up();
      await title(page, 'Late').press('Enter');
      await expect.poll(async () => (await stored(owner, date))[1].start).toBe(1200);
      expect(posts.map(p => [p.id, p.start, p.length])).toEqual([[first, 420, 60], [last, 1200, 60]]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the two 44px grab areas of a half-hour entry never overlap: each grip moves only its own edge', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(624);
    await add(owner, event(date, { text: 'Early', start: 420, length: 30 }));
    await add(owner, event(date, { text: 'Noon', start: 720, length: 30 }));
    await add(owner, event(date, { text: 'Late', start: 1215, length: 30 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      const f = finger(await page.context().newCDPSession(page)), minute = await perMinute(page);
      const areas = () => handleAreas(page);
      /** A finger on the middle of an area, pulled `minutes` down (up when negative), then lifted. */
      const pull = async (edge: 'start' | 'end', minutes: number) => {
        const grab = await centre(page.locator(`.day-handle[data-edge=${edge}]`));
        await f.down(grab.x, grab.y);
        await f.drag(grab, minutes * minute, 8);
        await f.up();
      };
      // Check both window edges and a middle entry with room around it.
      for (const [name, label, start, moves] of [
        ['Early', `Early, 7a to 7:30a, ${OWNER_NAME}`, 420, [['end', 30, { start: 420, length: 60 }], ['start', 15, { start: 435, length: 45 }]]],
        ['Noon', `Noon, 12p to 12:30p, ${OWNER_NAME}`, 720, [['end', 15, { start: 720, length: 45 }], ['start', -15, { start: 705, length: 60 }]]],
        ['Late', `Late, 8:15p to 8:45p, ${OWNER_NAME}`, 1215, [['end', 15, { start: 1215, length: 45 }], ['start', -30, { start: 1185, length: 75 }]]],
      ] as const) {
        await block(page, label).tap();
        await expect(title(page, name)).toBeFocused();
        const { start: top, end: bottom, hits } = await areas();
        expect(top[1] - top[0], `${name}: the start's area`).toBeGreaterThanOrEqual(44);
        expect(bottom[1] - bottom[0], `${name}: the end's area`).toBeGreaterThanOrEqual(44);
        expect(top[1], `${name}: the start's area is above the end's`).toBeLessThanOrEqual(bottom[0] + 0.5);
        expect(hits, `${name}: every row of an area is its own handle's`).toEqual({ start: ['start', 'start', 'start'], end: ['end', 'end', 'end'] });
        expect(await draftSpan(page)).toEqual({ start, length: 30 });
        // The top one pulls only the start and the bottom one only the end: the other edge stays where it was.
        for (const [edge, by, span] of moves) {
          await pull(edge, by);
          await expect.poll(() => draftSpan(page), { message: `${name}: ${edge} ${by} minutes` }).toEqual(span);
        }
        await title(page, name).press('Escape');
        await expect(editing(page)).toHaveCount(0);
      }
      expect(posts, 'nothing was saved: every edit was cancelled').toHaveLength(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a handle dragged far down with a finger takes the entry two hours longer, with nothing hanging over the schedule', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(623);
    await add(owner, event(date, { text: 'Morning', start: 540, length: 60 }));
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      const f = finger(await page.context().newCDPSession(page));
      await block(page, `Morning, 9a to 10a, ${OWNER_NAME}`).tap();
      await expect(title(page, 'Morning')).toBeFocused();
      await expect(strip(page)).toHaveCount(0);
      const minute = await perMinute(page), handle = await centre(page.locator('.day-handle[data-edge=end]'));
      await f.down(handle.x, handle.y);
      // Far down, two hours: the entry follows the finger, and nothing is drawn over the rest of the day it passes.
      await f.drag(handle, 120 * minute, 20);
      await expect(strip(page)).toHaveCount(0);
      await expect(bubble(page)).toHaveText('9a – 12p');
      await f.up();
      await expect.poll(() => draftSpan(page)).toEqual({ start: 540, length: 180 });
      await expect(strip(page)).toHaveCount(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});

test.describe('a short entry scrolled to the top of the timeline, under a finger', () => {
  test.beforeEach(async ({}, info) => { test.skip(isPhone(info.project.name), 'the wide layout with a touch screen'); });

  test('a half-hour entry at the top of the timeline has both handles within reach', async ({ browser, baseURL, browserName }) => {
    test.skip(browserName !== 'chromium', 'a finger is dispatched through the Chromium protocol');
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(626);
    await add(owner, event(date, { text: 'Early', start: 540, length: 30 }));
    const context = await browser.newContext({ baseURL, viewport: { width: 820, height: 700 }, hasTouch: true });
    const page = await context.newPage();
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await block(page, `Early, 9a to 9:30a, ${OWNER_NAME}`).click();
      await expect(title(page, 'Early')).toBeFocused();
      // Two hours at 32px/hour leave room for the 44px start handle and title field before scrolling.
      expect([await shiftOf(page, 'start'), await shiftOf(page, 'end')]).toEqual([0, 0]);
      const scrolls = await page.locator('.day-timeline').evaluate(panel => {
        const entry = document.querySelector<HTMLElement>('.day-ev.day-editing[data-primary]')!;
        panel.scrollTop += entry.getBoundingClientRect().top - panel.getBoundingClientRect().top;
        return panel.scrollHeight > panel.clientHeight;
      });
      expect(scrolls, 'the page scrolls in a window this short').toBe(true);
      await expect.poll(() => shiftOf(page, 'start'), { message: 'the start area is pulled in over the entry' }).toBeGreaterThan(0);
      expect(await shiftOf(page, 'end'), 'the end area steps back below it').toBeLessThan(0);
      const { start: top, end: bottom, hits } = await handleAreas(page);
      expect(top[1] - top[0]).toBeGreaterThanOrEqual(44);
      expect(bottom[1] - bottom[0]).toBeGreaterThanOrEqual(44);
      expect(top[1], 'the start area is above the end area').toBeLessThanOrEqual(bottom[0] + 0.5);
      expect(hits, 'every row of an area is its own handle\'s').toEqual({ start: ['start', 'start', 'start'], end: ['end', 'end', 'end'] });
      // A finger on the top area pulls only the start, on the bottom area only the end.
      const f = finger(await context.newCDPSession(page)), minute = await perMinute(page);
      const pull = async (edge: 'start' | 'end', minutes: number) => {
        // Both handles are already in reach. Auto-scrolling the focused edit before pressing would undo this setup.
        expect((await handleAreas(page)).hits[edge][1]).toBe(edge);
        const box = (await page.locator(`.day-handle[data-edge=${edge}]`).boundingBox())!;
        // Press below the top edge-pan zone so this checks resizing with a fixed grid.
        const grab = { x: box.x + box.width / 2, y: box.y + box.height * 0.75 };
        await f.down(grab.x, grab.y);
        await f.drag(grab, minutes * minute, 8);
        await f.up();
      };
      await pull('end', 60);
      await expect.poll(() => draftSpan(page), { message: 'the end moved 60 minutes' }).toEqual({ start: 540, length: 90 });
      await pull('start', 15);
      await expect.poll(() => draftSpan(page), { message: 'the start moved 15 minutes' }).toEqual({ start: 555, length: 75 });
      await title(page, 'Early').press('Escape');
      await expect(editing(page)).toHaveCount(0);
      expect(posts, 'nothing was saved: the edit was cancelled').toHaveLength(0);
    } finally { await context.close(); await clearDay(owner, date); await owner.dispose(); }
  });
});
