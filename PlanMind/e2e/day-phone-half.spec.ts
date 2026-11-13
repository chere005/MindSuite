import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';
import { apiLogin, draftSpan, farDate, field, login, noWindow, pickList, resetPrefs, showHalf, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// The Day schedule has two pages behind an AM and PM switch. AM is the day as it always was, 7a to 9p (14 hour rows); PM is the night, 9p to 7a the
// next morning (ten rows, 9p, 10p, 11p, 12a ... 6a, at the same row height: the grid box keeps AM's size and PM leaves the last four rows of it
// empty). A planner day runs 7:00 to 7:00 the next morning, so an entry at 2a is stored on the date of the evening before and is on that date's PM
// page. On a phone the switch is a row of its own above the lane names. The slots, the drags, the handles and the pointer-to-minute mapping all use
// the page on the screen, an entry across 9p is cut flat at the edge of the page it is drawn in, and the page always opens on AM. The project's own
// viewport (375x812) is used; the days are in February and March 2044 (US Central standard time, UTC-6, until the clock change on 13 March), and the
// ones a clock is pinned on are early in February, so a pinned clock has one offset.
const add = async (api: Api, body: Record<string, unknown>) => {
  const data = { id: crypto.randomUUID(), ...body };
  const response = await api.post(data);
  expect(response.status(), JSON.stringify(await response.json())).toBe(200);
  return data.id as string;
};
const event = (date: string, over: Record<string, unknown> = {}) => ({ action: 'add', kind: 'event', date, owners: [OWNER], text: 'Dentist', start: 540, length: 60, ...over });
const day = (n: number) => farDate(1500 + n);
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
const stored = async (api: Api, date: string) => (await api.snapshot()).events.filter((e: { date: string }) => e.date === date).sort((a: { start: number }, b: { start: number }) => a.start - b.start);
/** Today is `date` at `time` in Chicago (the account's timezone), for a page that has not opened yet. The clock goes on running from there. */
const pin = (page: Page, date: string, time: string) => page.clock.install({ time: new Date(`${date}T${time}:00-06:00`) });
const AM_HOURS = ['7a', '8a', '9a', '10a', '11a', '12p', '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p'], PM_HOURS = ['9p', '10p', '11p', '12a', '1a', '2a', '3a', '4a', '5a', '6a'];
/** The schedule section says which half it draws (data-half); the AM/PM switch is in the menu behind the hamburger on a phone, so it is not on the page to read. */
const pressed = (page: Page) => page.locator('.day-sched');
/** The phone's way to the other half: the hamburger, then the AM or PM item (choosing closes the menu). */
const tapHalf = async (page: Page, half: 'am' | 'pm') => { await page.locator('#menu').tap(); await page.locator(`#sidebar [data-half=${half}]`).tap(); };
const lanes = async (page: Page) => (await page.locator('.day-lanes').boundingBox())!;
const rowHeights = (page: Page) => page.locator('.day-hours span').evaluateAll(spans => spans.map(s => s.getBoundingClientRect().height));
const centre = async (locator: ReturnType<Page['locator']>) => { const box = (await locator.boundingBox())!; return { x: box.x + box.width / 2, y: box.y + box.height / 2, box }; };
const block = (page: Page, label: string) => page.getByRole('button', { name: label, exact: true });
const bubble = (page: Page) => page.locator('.day-bubble');
/** The start the entry being edited has now: its block holds only this time label (start only), the title field and the two handles, no strip. */
const draftTime = (page: Page) => page.locator('.day-ev.day-editing .day-ev-time');
/** Puts a draft past the field's maxlength (typing and fill() stop at it, in Chromium too): sets the value and tells the page, as a script would. */
const overLimit = (input: Locator, text: string) => input.evaluate((el, value) => { (el as HTMLInputElement).value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, text);
/** The entry being edited has nothing hung over the schedule: no strip, no span, counter, hint, error or Delete in it (a message goes to the shell's banner). */
const expectNoStrip = async (page: Page) => {
  await expect(page.locator('.day-ev-strip')).toHaveCount(0);
  await expect(page.locator('.day-ev.day-editing').locator('.ip-span, .ip-count, .ip-hint, .ip-error, .ip-del')).toHaveCount(0);
};
const handle = (page: Page, edge: 'start' | 'end') => page.locator(`.day-handle[data-edge=${edge}]`);
/** The drop's write has been answered and the page has drawn the answer. */
const settled = async (page: Page) => {
  await expect(page.locator('#sync-status')).not.toHaveText('Saving…');
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
};
/**
 * The box of what `locator` names once it is on the page: right after an Escape the panel can be drawing again, and a
 * boundingBox() that lands between the old node and the new one reads null (seen 1 run in 6 in a full run, 2026-11-02).
 */
async function boxOf(locator: Locator) {
  let box = await locator.boundingBox();
  for (let tries = 0; !box && tries < 40; tries++) { await locator.page().waitForTimeout(25); box = await locator.boundingBox(); }
  return box!;
}
/** A tap on a slot of the grid, `fraction` of the way down its hour row. */
async function tapSlot(page: Page, name: string, fraction: number) {
  const slot = page.getByRole('button', { name, exact: true });
  const box = await boxOf(slot);
  await slot.tap({ position: { x: 10, y: Math.round(box.height * fraction) } });
}
/** A tap on a slot, `fraction` of the way down its hour row and `across` of the way across the whole grid (the Both view cuts the grid in thirds). */
async function tapSlotAcross(page: Page, name: string, fraction: number, across: number) {
  const slot = page.getByRole('button', { name, exact: true });
  const box = await boxOf(slot), grid = await boxOf(page.locator('.day-lanes'));
  await slot.tap({ position: { x: Math.round(grid.x + grid.width * across - box.x), y: Math.round(box.height * fraction) } });
}
function recordPosts(page: Page) {
  const posts: Array<Record<string, unknown>> = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('api.php')) { const body = request.postDataJSON(); if (body.action !== 'savePrefs') { posts.push(body); } } });
  return posts;
}
/** A finger: touch start, hold, then move in small steps. */
function finger(cdp: CDPSession) {
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  return {
    down: (x: number, y: number) => send('touchStart', x, y),
    up: () => send('touchEnd'),
    async to(from: { x: number; y: number }, y: number, steps = 24) { for (let i = 1; i <= steps; i++) { await send('touchMove', from.x, from.y + ((y - from.y) * i) / steps); } },
  };
}
/** Nothing scrolls, nothing sticks out sideways, and the tab bar is on screen. */
async function expectFits(page: Page, label: string) {
  const fit = await page.evaluate(() => {
    const host = document.querySelector('#period-panel')!, body = document.querySelector('.day-body')!, bar = document.querySelector('.day-tabs')!.getBoundingClientRect();
    return { host: host.scrollHeight - host.clientHeight, body: body.scrollHeight - body.clientHeight, page: document.documentElement.scrollHeight - innerHeight, sideways: document.documentElement.scrollWidth - innerWidth, bar: bar.bottom - innerHeight };
  });
  expect(fit, label).toEqual({ host: 0, body: 0, page: 0, sideways: 0, bar: expect.any(Number) });
  expect(fit.bar, label).toBeLessThanOrEqual(0);
}

/**
 * What a block's words show, read from the layout of the page and not from the page's own --lines. `room` is the block's clientHeight less its
 * vertical padding (the room ScheduleSection.fitLines gives the words), `line` the words' line-height, and `natural` how tall the same words
 * are with no clamp (a hidden copy laid out at the width they have), so whether they are cut is judged on the words themselves.
 */
const measure = (block: Locator) => block.evaluate(el => {
  const words = el.querySelector('.day-ev-text') as HTMLElement, box = getComputedStyle(el), style = getComputedStyle(words);
  const copy = words.cloneNode(true) as HTMLElement;
  copy.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;display:block;overflow:visible;height:auto;-webkit-line-clamp:none;line-clamp:none;width:${words.getBoundingClientRect().width}px`;
  el.appendChild(copy);
  const natural = copy.getBoundingClientRect().height;
  copy.remove();
  return {
    room: el.clientHeight - parseFloat(box.paddingTop) - parseFloat(box.paddingBottom), padding: parseFloat(box.paddingTop) + parseFloat(box.paddingBottom), line: parseFloat(style.lineHeight), natural,
    height: el.getBoundingClientRect().height, lines: el.style.getPropertyValue('--lines'), clamp: style.getPropertyValue('-webkit-line-clamp'),
    orient: style.getPropertyValue('-webkit-box-orient'), overflow: style.overflow, whiteSpace: style.whiteSpace,
    shown: words.clientHeight, scroll: words.scrollHeight, content: words.textContent, title: el.getAttribute('title'),
  };
});
type Measured = Awaited<ReturnType<typeof measure>>;
/** The lines the room holds (the product's rule, applied to what the layout measures: half a pixel of slack, at least one), and the lines the words need. */
const holds = (m: Measured) => Math.max(1, Math.floor((m.room + 0.5) / m.line));
const needs = (m: Measured) => Math.max(1, Math.ceil(m.natural / m.line - 0.01));
/**
 * What is wrong with a block's words ('' when nothing is): the variable, the computed clamp and the height the words really take must all be the
 * lines the room holds (or fewer when the words are shorter), the box must be vertical with its overflow hidden (what draws the ellipsis),
 * and the words are clipped (their scrollHeight is more than their height) exactly when they need more lines than the room holds.
 * `cut` says whether the test knows the words do not fit (true) or fit (false); null leaves it to the layout.
 */
function misfit(m: Measured, cut: boolean | null): string {
  const bad: string[] = [];
  if (!(m.line > 0)) { return `the words have no line-height in pixels (${m.line})`; }
  const room = holds(m), need = needs(m), showing = Math.min(room, need), over = need > room, clipped = m.scroll > m.shown + 0.5;
  if (Number(m.lines) !== room) { bad.push(`--lines is "${m.lines}" but a room of ${m.room}px holds ${room} lines of ${m.line}px`); }
  if (Number(m.clamp) !== room) { bad.push(`the computed -webkit-line-clamp is "${m.clamp}", not ${room}`); }
  if (Math.abs(m.shown - showing * m.line) > 1) { bad.push(`the words are ${m.shown}px tall, but ${showing} lines are ${showing * m.line}px`); }
  // The clamp is drawn by a vertical box with hidden overflow (Chromium reports its display as flow-root once it is a flex item, so only the effect, the height above, is checked of that).
  if (m.orient !== 'vertical' || m.overflow !== 'hidden') { bad.push(`the words are box-orient ${m.orient}, overflow ${m.overflow}, not vertical with hidden overflow`); }
  if (m.whiteSpace === 'nowrap') { bad.push('the words do not wrap'); }
  if (clipped !== over) { bad.push(`the words are ${clipped ? '' : 'not '}clipped (${m.scroll}px of ${m.shown}px) but need ${need} lines of the ${room} held`); }
  if (cut !== null && over !== cut) { bad.push(`the test expects the words ${cut ? 'not to fit' : 'to fit'}, but they need ${need} lines of the ${room} held`); }
  return bad.join('; ');
}
/** Waits (the page settles --lines on a ResizeObserver, after layout) until a block's words show exactly what its room holds. */
const expectFit = (block: Locator, cut: boolean | null, label: string) => expect.poll(async () => misfit(await measure(block), cut), { message: label }).toBe('');
/** Marks the element so a later `kept` shows it is the same one (no redraw made a new block, whose first fit would hide a missing re-fit). */
const mark = (locator: Locator) => locator.evaluate(el => { (el as unknown as { kept: boolean }).kept = true; });
const kept = (locator: Locator) => locator.evaluate(el => (el as unknown as { kept?: boolean }).kept === true);

test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });

test.describe('Day schedule, phone: the AM and PM switch', () => {
  test('AM and PM use the same readable hour height and the timeline scrolls independently', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(0);
    await add(owner, event(date, { text: 'Gym', start: 420 }));
    await add(owner, event(date, { text: 'Supper', start: 1110 }));
    await add(owner, event(date, { text: 'Night cap', start: 1320 }));
    await add(owner, event(date, { text: 'Owl', start: 1500 }));
    try {
      await login(page); await openDay(page, date);
      // The page opens on AM. The switch is a two-option item in the menu behind the hamburger (day-menu-phone.spec.ts), finger-sized; the Day has no row for it.
      await expect(pressed(page)).toHaveCount(1);
      await expect(pressed(page)).toHaveAttribute('data-half', 'am');
      await expect(page.locator('.day-half')).toHaveCount(0);
      await page.locator('#menu').tap();
      const group = page.locator('#day-tools').getByRole('group', { name: 'Part of the day', exact: true });
      await expect(group.getByRole('button')).toHaveText(['AM', 'PM']);
      for (const button of await group.getByRole('button').all()) { expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44); }
      await page.keyboard.press('Escape');
      await expect(page.locator('#sidebar')).toBeHidden();

      const seen: Record<string, { heights: number[]; grid: { x: number; y: number; width: number; height: number } }> = {};
      for (const [half, hours, other, from, to] of [['am', AM_HOURS, '9p', 420, 1260], ['pm', PM_HOURS, '8p', 1260, 1860]] as const) {
        await showHalf(page, half);
        await expect(pressed(page)).toHaveAttribute('data-half', half);
        await expect(page.locator('.day-hours span')).toHaveText(hours);
        await expect(page.locator('.day-hours span', { hasText: new RegExp(`^${other}$`) })).toHaveCount(0);
        await expect(page.locator('.day-sched')).toHaveAttribute('data-half', half);
        // The grid says which minutes its page is: both pages stand for 14 hours of box (PM's ten hours of night use its top ten rows).
        await expect(page.locator('.day-lanes')).toHaveAttribute('data-from', String(from));
        await expect(page.locator('.day-lanes')).toHaveAttribute('data-to', String(to));
        await expect(page.locator('.day-lanes')).toHaveAttribute('data-span', '840');
        // The slots keep their names, one row of them for each hour of the page and none for the other page.
        await expect(page.locator('.day-slot[data-lane="0"]')).toHaveCount(hours.length);
        await expect(page.getByRole('button', { name: `Add to ${OWNER_NAME} at ${hours[1]}`, exact: true })).toHaveCount(1);
        await expect(page.getByRole('button', { name: `Add to ${OWNER_NAME} at ${other}`, exact: true })).toHaveCount(0);
        seen[half] = { heights: await rowHeights(page), grid: await lanes(page) };
        const { heights, grid } = seen[half];
        expect(Math.max(...heights) - Math.min(...heights), `${half}: one height for every row`).toBeLessThanOrEqual(1);
        expect(Math.min(...heights), `${half}: compact hour floor`).toBeGreaterThanOrEqual(32);
        await expectFits(page, half);
      }
      const { am, pm } = seen;
      // AM fills the grid box, inside a scroll area that reaches down to the tab bar.
      const tabs = (await page.locator('.day-tabs').boundingBox())!;
      const timeline = page.locator('.day-timeline');
      const frame = (await timeline.boundingBox())!;
      expect(Math.abs(am.heights.reduce((a, b) => a + b, 0) - am.grid.height), 'AM: the rows are the grid').toBeLessThanOrEqual(2);
      expect(tabs.y - (frame.y + frame.height), 'AM: the timeline reaches down to the tab bar').toBeLessThanOrEqual(24);
      // PM has the same box and the same row height; it draws its ten rows at the top and the last four rows of the box are empty.
      for (const key of ['x', 'y', 'width', 'height'] as const) { expect(Math.abs(pm.grid[key] - am.grid[key]), `PM: the grid box keeps AM's ${key}`).toBeLessThanOrEqual(0.5); }
      pm.heights.forEach((height, i) => expect(Math.abs(height - am.heights[i]), `PM row ${i} is as tall as the AM row`).toBeLessThanOrEqual(0.5));
      const row = am.grid.height / 14;
      await expect(page.locator('.day-slot')).toHaveCount(10 * 2);
      await timeline.evaluate(el => { el.scrollTop = el.scrollHeight; });
      const night = await lanes(page);
      const below = await page.evaluate(({ top, x, y }) => ({
        lowest: Math.max(...[...document.querySelectorAll('.day-slot')].map(s => s.getBoundingClientRect().bottom)) - top,
        slotThere: !!document.elementFromPoint(x, y)?.closest('.day-slot'),
      }), { top: night.y, x: night.x + night.width / 2, y: night.y + row * 12.5 });
      expect(Math.abs(below.lowest - 10 * row), 'PM: the last slot ends with the tenth row').toBeLessThanOrEqual(1);
      expect(below.slotThere, 'PM: no slot below the tenth row').toBe(false);
      // A tap there starts nothing.
      await page.touchscreen.tap(night.x + night.width / 2, night.y + row * 12.5);
      await expect(page.locator('.day-ev.day-editing')).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(0);
      // The controls and lane names remain above the timeline when it scrolls.
      const above = await page.evaluate(() => {
        const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        const margins = (selector: string) => { const style = getComputedStyle(document.querySelector(selector)!); return parseFloat(style.marginTop) + parseFloat(style.marginBottom); };
        const section = box('.day-sched');
        return { gridTop: box('.day-timeline').top - section.top, rows: box('.day-lanehead').height + margins('.day-lanehead') };
      });
      expect(Math.abs(above.gridTop - above.rows), 'nothing but the lane names is above the grid').toBeLessThanOrEqual(1);
      // The day entries are in AM only, the night ones (the one at 1a is on this date's PM page) in PM only.
      await showHalf(page, 'am');
      await expect(block(page, `Gym, 7a to 8a, ${OWNER_NAME}`)).toBeVisible();
      await expect(block(page, `Supper, 6:30p to 7:30p, ${OWNER_NAME}`)).toBeVisible();
      await expect(page.locator('.day-ev')).toHaveCount(2);
      await showHalf(page, 'pm');
      await expect(block(page, `Night cap, 10p to 11p, ${OWNER_NAME}`)).toBeVisible();
      await expect(block(page, `Owl, 1a to 2a, ${OWNER_NAME}`)).toBeVisible();
      await expect(page.locator('.day-ev')).toHaveCount(2);
      await noWindow(page);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  // The page always opens on AM, whatever hour the clock is at, in the account's timezone: 9:00 in Chicago is 15:00 UTC and 22:00 is 04:00 UTC the next day.
  for (const [time, n] of [['09:00', 1], ['22:00', 2]] as const) {
    test(`on today at ${time} Chicago time the page opens on AM`, async ({ page }) => {
      const date = day(n);
      await pin(page, date, time);
      await login(page);
      // The clock is the pinned one: today is the day pinned, and it is the day on the screen.
      await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', date);
      await expect(pressed(page)).toHaveAttribute('data-half', 'am');
      await expect(page.locator('.day-hours span')).toHaveText(AM_HOURS);
      await expect(page.locator('.day-lanes')).toHaveAttribute('data-from', '420');
      await expect(page.locator('.day-lanes')).toHaveAttribute('data-to', '1260');
    });
  }

  test('a page opened wide late in the evening and made a phone later is on AM', async ({ page }) => {
    const date = day(3);
    await page.setViewportSize({ width: 1000, height: 800 });
    await pin(page, date, '22:00');
    await login(page);
    await expect(pressed(page)).toHaveAttribute('data-half', 'am');
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(pressed(page)).toHaveAttribute('data-half', 'am');
    await expect(page.locator('.day-hours span')).toHaveText(AM_HOURS);
  });

  test('the choice is kept from day to day, by the arrows and by a date, across tabs and redraws, in both directions; a reload opens on AM again', async ({ page }) => {
    await login(page);
    await showHalf(page, 'pm');
    await page.locator('#pill-next').tap();
    await expect(pressed(page)).toHaveAttribute('data-half', 'pm');
    await expect(page.locator('.day-hours span')).toHaveText(PM_HOURS);
    await openDay(page, day(6));
    await expect(pressed(page)).toHaveAttribute('data-half', 'pm');
    // Another list picked redraws the page: nothing asks again.
    await pickList(page, OWNER_NAME);
    await expect(pressed(page)).toHaveAttribute('data-half', 'pm');
    await expect(page.locator('.day-hours span')).toHaveText(PM_HOURS);
    await showHalf(page, 'am');
    await page.locator('#pill-prev').tap();
    await page.locator('#pill-prev').tap();
    await expect(pressed(page)).toHaveAttribute('data-half', 'am');
    await expect(page.locator('.day-hours span')).toHaveText(AM_HOURS);
    await openDay(page, day(7));
    await expect(pressed(page)).toHaveAttribute('data-half', 'am');
    // Another tab and back is the same page.
    await showHalf(page, 'pm');
    await page.getByRole('tab', { name: 'To-do', exact: true }).tap();
    await page.getByRole('tab', { name: 'Schedule', exact: true }).tap();
    await expect(pressed(page)).toHaveAttribute('data-half', 'pm');
    await expect(page.locator('.day-hours span')).toHaveText(PM_HOURS);
    // Only the open page keeps it: a new load is AM.
    await page.reload();
    await expect(page.locator('#sidebar .date-row.selected')).toBeAttached();
    await expect(pressed(page)).toHaveAttribute('data-half', 'am');
    await expect(page.locator('.day-hours span')).toHaveText(AM_HOURS);
  });

  test('crossing the phone breakpoint: the switch is on the Schedule heading\'s line on a desktop and in the menu behind the hamburger on a phone, and the page chosen is kept both ways', async ({ page }) => {
    await login(page);
    await showHalf(page, 'pm');
    await expect(page.locator('.day-half')).toHaveCount(0);
    await page.setViewportSize({ width: 1360, height: 900 });
    const wide = page.locator('.day-sechead .day-half');
    await expect(wide).toHaveCount(1);
    await expect(page.locator('.day-half')).toHaveCount(1);
    await expect(pressed(page)).toHaveAttribute('data-half', 'pm');
    await expect(page.locator('.day-hours span')).toHaveText(PM_HOURS);
    await expect(page.locator('.day-lanes')).toHaveAttribute('data-from', '1260');
    // At the right end of the heading's line, compact.
    const [head, sw] = [(await page.locator('.day-sechead').boundingBox())!, (await wide.boundingBox())!];
    expect(sw.x + sw.width, 'at the right end of the heading').toBeGreaterThan(head.x + head.width - 4);
    expect(sw.y, 'on the heading\'s line').toBeGreaterThanOrEqual(head.y - 1);
    expect(sw.y + sw.height, 'on the heading\'s line').toBeLessThanOrEqual(head.y + head.height + 1);
    // Compact with a mouse; the phone project has a touch screen (pointer: coarse), which gives every switch button its finger-sized 44px.
    for (const button of await wide.getByRole('button').all()) { expect((await button.boundingBox())!.height).toBeLessThanOrEqual(44); }
    await showHalf(page, 'am');
    await expect(page.locator('.day-hours span')).toHaveText(AM_HOURS);
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.locator('.day-half')).toHaveCount(0);
    await expect(pressed(page)).toHaveAttribute('data-half', 'am');
    await expect(page.locator('.day-corner')).toHaveText('AM');
    await expect(page.locator('.day-hours span')).toHaveText(AM_HOURS);
    await showHalf(page, 'pm');
    await page.setViewportSize({ width: 1360, height: 900 });
    await expect(pressed(page)).toHaveAttribute('data-half', 'pm');
    await expect(page.locator('.day-hours span')).toHaveText(PM_HOURS);
  });
});

test.describe('Day schedule, phone: what each page shows', () => {
  test('an entry from 8:30p to 9:30p is flat at the bottom in AM and flat at the top in PM, with no handle on the cut edge, and says its real times', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(8);
    await add(owner, event(date, { text: 'Late show', start: 1230, length: 60 }));
    try {
      await login(page); await openDay(page, date);
      const label = `Late show, 8:30p to 9:30p, ${OWNER_NAME}`;
      // AM: the first half hour of it, at the bottom of the grid.
      await showHalf(page, 'am');
      let grid = await lanes(page), show = block(page, label);
      const row = grid.height / 14;
      await expect(show).toBeVisible();
      await expect(show).toHaveAttribute('data-clip', 'bottom');
      await expect(show).toHaveAttribute('data-q', '55');
      await expect(show).toHaveAttribute('data-n', '2');
      let box = (await show.boundingBox())!;
      expect(Math.abs(box.y + box.height - (grid.y + grid.height)), 'AM: it ends flush with the bottom of the grid').toBeLessThanOrEqual(1.5);
      expect(Math.abs(box.y - (grid.y + grid.height - row / 2)), 'AM: it starts at 8:30, half a row from the bottom plus its inset').toBeLessThanOrEqual(2.5);
      expect(await show.evaluate(el => getComputedStyle(el).borderTopLeftRadius), 'AM: round at the top').not.toBe('0px');
      await show.tap();
      await expect(field(page, 'Edit entry: Late show')).toBeFocused();
      await expect(page.locator('.day-ev.day-editing')).toHaveAttribute('data-clip', 'bottom');
      await expect(handle(page, 'start')).toBeVisible();
      await expect(handle(page, 'end')).toBeHidden();
      await page.keyboard.press('Escape');
      await expect(page.locator('.day-ev.day-editing')).toHaveCount(0);

      // PM: the second half hour of it, at the top of the grid; the real times are the same words.
      await showHalf(page, 'pm');
      grid = await lanes(page); show = block(page, label);
      await expect(show).toBeVisible();
      await expect(show).toHaveAttribute('data-clip', 'top');
      await expect(show).toHaveAttribute('data-q', '1');
      await expect(show).toHaveAttribute('data-n', '2');
      box = (await show.boundingBox())!;
      expect(Math.abs(box.y - grid.y), 'PM: it starts flush with the top of the grid').toBeLessThanOrEqual(1.5);
      expect(Math.abs(box.y + box.height - (grid.y + row / 2)), 'PM: it ends at 9:30, half a row down').toBeLessThanOrEqual(2);
      expect(await show.evaluate(el => getComputedStyle(el).borderBottomLeftRadius), 'PM: round at the bottom').not.toBe('0px');
      await show.tap();
      await expect(field(page, 'Edit entry: Late show')).toBeFocused();
      await expect(page.locator('.day-ev.day-editing')).toHaveAttribute('data-clip', 'top');
      await expect(handle(page, 'start')).toBeHidden();
      await expect(handle(page, 'end')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.day-ev.day-editing')).toHaveCount(0);
      // Nothing was written by looking at it.
      expect(await stored(owner, date)).toMatchObject([{ text: 'Late show', start: 1230, length: 60, revision: 1 }]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the cut edge of an entry is square, not rounded, with and without the entry being edited: the bottom in AM and the top in PM', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(22);
    await add(owner, event(date, { text: 'Late show', start: 1230, length: 60 }));
    try {
      await login(page); await openDay(page, date);
      const corners = (locator: ReturnType<typeof block>) => locator.evaluate(el => { const s = getComputedStyle(el); return { topLeft: s.borderTopLeftRadius, topRight: s.borderTopRightRadius, bottomLeft: s.borderBottomLeftRadius, bottomRight: s.borderBottomRightRadius }; });
      const round = expect.not.stringMatching(/^0px$/);
      await showHalf(page, 'am');
      expect(await corners(block(page, `Late show, 8:30p to 9:30p, ${OWNER_NAME}`))).toEqual({ topLeft: round, topRight: round, bottomLeft: '0px', bottomRight: '0px' });
      await showHalf(page, 'pm');
      expect(await corners(block(page, `Late show, 8:30p to 9:30p, ${OWNER_NAME}`))).toEqual({ topLeft: '0px', topRight: '0px', bottomLeft: round, bottomRight: round });
      await block(page, `Late show, 8:30p to 9:30p, ${OWNER_NAME}`).tap();
      await expect(page.locator('.day-ev.day-editing')).toHaveCount(1);
      expect(await corners(page.locator('.day-ev.day-editing'))).toEqual({ topLeft: '0px', topRight: '0px', bottomLeft: round, bottomRight: round });
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('an entry wholly on the other page is not on the page: one that ends at 9p is only in AM, one that starts at 9p, in the small hours or ends at 7a only in PM', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(9);
    const ids: Record<string, string> = {};
    for (const [text, start] of [['Early', 480], ['Ends at 9p', 1200], ['Starts at 9p', 1260], ['Late', 1320], ['Small hours', 1500], ['Ends at 7a', 1800]] as const) { ids[text] = await add(owner, event(date, { text, start, length: 60 })); }
    try {
      await login(page); await openDay(page, date);
      const present = (names: string[]) => Promise.all(names.map(name => expect(page.locator(`.day-ev[data-id="${ids[name]}"]`), `${name} is drawn`).toHaveCount(1)));
      const absent = (names: string[]) => Promise.all(names.map(name => expect(page.locator(`.day-ev[data-id="${ids[name]}"]`), `${name} is not in the page`).toHaveCount(0)));
      await showHalf(page, 'am');
      await present(['Early', 'Ends at 9p']); await absent(['Starts at 9p', 'Late', 'Small hours', 'Ends at 7a']);
      await expect(page.locator('.day-ev')).toHaveCount(2);
      await expect(page.locator('.day-ev[data-clip]:not([data-clip=""])')).toHaveCount(0);
      await showHalf(page, 'pm');
      await present(['Starts at 9p', 'Late', 'Small hours', 'Ends at 7a']); await absent(['Early', 'Ends at 9p']);
      await expect(page.locator('.day-ev')).toHaveCount(4);
      await expect(page.getByText('Early', { exact: true })).toHaveCount(0);
      await expect(page.locator('.day-ev[data-clip]:not([data-clip=""])')).toHaveCount(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('both lanes: the cut is by page in each lane, and a Both entry across 9p is clipped in both lanes\' columns', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(10);
    await add(owner, event(date, { text: 'Show together', owners: [OWNER, PARTNER], start: 1200, length: 120 }));
    await add(owner, event(date, { text: 'Gym', start: 450, length: 60 }));
    await add(owner, event(date, { text: 'Yoga', owners: [PARTNER], start: 1320, length: 60 }));
    try {
      await login(page); await openDay(page, date);
      // The linked entry is cut on each page and still spans both lanes' columns.
      const spansBoth = async (label: string) => {
        const [grid, linked, lane] = [await lanes(page), (await page.locator('.day-ev', { hasText: 'Show together' }).boundingBox())!, (await page.locator('.day-ev', { hasText: label }).boundingBox())!];
        expect(linked.width, `${label}: the Both entry spans more than 90% of the grid`).toBeGreaterThan(grid.width * 0.9);
        expect(lane.width, `${label}: a lane's entry is narrower`).toBeLessThan(grid.width * 0.6);
      };
      await showHalf(page, 'am');
      await expect(page.locator('.day-ev', { hasText: 'Show together' })).toHaveAttribute('data-clip', 'bottom');
      await expect(page.locator('.day-ev', { hasText: 'Show together' })).toHaveAttribute('aria-label', 'Show together, 8p to 10p, Both');
      await expect(page.locator('.day-ev', { hasText: 'Gym' })).toHaveCount(1);
      await expect(page.locator('.day-ev', { hasText: 'Yoga' })).toHaveCount(0);
      await spansBoth('Gym');
      await showHalf(page, 'pm');
      await expect(page.locator('.day-ev', { hasText: 'Show together' })).toHaveAttribute('data-clip', 'top');
      await expect(page.locator('.day-ev', { hasText: 'Show together' })).toHaveAttribute('aria-label', 'Show together, 8p to 10p, Both');
      await expect(page.locator('.day-ev', { hasText: 'Yoga' })).toHaveCount(1);
      await spansBoth('Yoga');
      await expect(page.locator('.day-ev', { hasText: 'Gym' })).toHaveCount(0);
      await expect(page.locator('.day-lanehead')).toBeVisible();
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the night belongs to its date: an entry at 1a is stored on the evening before, drawn at 1a on that date\'s PM page and on no page of the next date', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(33), after = day(34);
    const id = await add(owner, event(date, { text: 'Night owl', start: 1500, length: 60 }));
    // The partner's lane across midnight: 11p to 1a is one entry on the PM page, not two.
    await add(owner, event(date, { text: 'Late show', start: 1380, length: 120, owners: [PARTNER] }));
    try {
      expect(await stored(owner, date)).toMatchObject([{ text: 'Late show', start: 1380, length: 120 }, { id, text: 'Night owl', start: 1500, length: 60 }]);
      await login(page); await openDay(page, date);
      await showHalf(page, 'am');
      await expect(page.locator('.day-ev')).toHaveCount(0);
      await showHalf(page, 'pm');
      const grid = await lanes(page), owl = block(page, `Night owl, 1a to 2a, ${OWNER_NAME}`), show = block(page, `Late show, 11p to 1a, ${PARTNER_NAME}`), row = grid.height / 14;
      await expect(owl).toBeVisible();
      await expect(owl).toHaveAttribute('data-clip', '');
      // 1a is the fifth row of the night (9p, 10p, 11p, 12a, 1a): the 17th quarter hour, an hour tall.
      await expect(owl).toHaveAttribute('data-q', '17');
      await expect(owl).toHaveAttribute('data-n', '4');
      const box = (await owl.boundingBox())!;
      expect(Math.abs(box.y - (grid.y + 4 * row)), 'it starts with the fifth row').toBeLessThanOrEqual(2);
      expect(Math.abs(box.y + box.height - (grid.y + 5 * row)), 'it ends with the fifth row').toBeLessThanOrEqual(2);
      await expect(show).toHaveAttribute('data-clip', '');
      await expect(show).toHaveAttribute('data-q', '9');
      await expect(show).toHaveAttribute('data-n', '8');
      await expect(page.locator('.day-ev')).toHaveCount(2);
      // The next date has nothing on either page: the night of an entry is not its next day's.
      await page.locator('#pill-next').tap();
      await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', after);
      await expect(pressed(page)).toHaveAttribute('data-half', 'pm');
      await expect(page.locator('.day-ev')).toHaveCount(0);
      await showHalf(page, 'am');
      await expect(page.locator('.day-ev')).toHaveCount(0);
      expect(await stored(owner, after)).toHaveLength(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the day runs to 7a: an entry from 6:30a to 7a is stored, drawn at the end of PM only, and cannot be moved or stretched later; one that would end after 7a is refused', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(4);
    const id = await add(owner, event(date, { text: 'Dawn', start: 1830, length: 30 }));
    try {
      // The server has it, and refuses an entry that would run past 7a.
      expect(await stored(owner, date)).toMatchObject([{ id, text: 'Dawn', start: 1830, length: 30 }]);
      expect((await owner.post({ id: crypto.randomUUID(), ...event(date, { text: 'Too late', start: 1845, length: 30 }) })).status()).toBe(400);
      expect((await owner.post({ id: crypto.randomUUID(), ...event(date, { text: 'Too late', start: 1860, length: 30 }) })).status()).toBe(400);
      expect(await stored(owner, date)).toHaveLength(1);
      await login(page); await openDay(page, date);
      await showHalf(page, 'am');
      await expect(page.locator('.day-ev')).toHaveCount(0);
      await showHalf(page, 'pm');
      const grid = await lanes(page), last = block(page, `Dawn, 6:30a to 7a, ${OWNER_NAME}`);
      await expect(last).toBeVisible();
      await expect(last).toHaveAttribute('data-clip', '');
      // 6:30a is the 39th quarter hour from 9p; the entry ends with the tenth row, at 7a.
      await expect(last).toHaveAttribute('data-q', '39');
      await expect(last).toHaveAttribute('data-n', '2');
      const box = (await last.boundingBox())!;
      expect(Math.abs(box.y + box.height - (grid.y + 10 * (grid.height / 14))), 'it ends with the tenth row, at 7a').toBeLessThanOrEqual(2.5);
      await last.tap();
      const edit = field(page, 'Edit entry: Dawn');
      await expect(edit).toBeFocused();
      await edit.press('Alt+ArrowDown');
      await expect(page.locator('#live')).toHaveText('Cannot move later: it is at the end of the schedule.');
      // Still 6:30a to 7a (the block holds the start; its rows are the last two of the night).
      await expect(draftTime(page)).toHaveText('6:30a');
      expect(await draftSpan(page)).toEqual({ start: 1830, length: 30 });
      await edit.press('Alt+Shift+ArrowDown');
      await expect(page.locator('#live')).toHaveText('Cannot make it longer.');
      await expect(draftTime(page)).toHaveText('6:30a');
      expect(await draftSpan(page)).toEqual({ start: 1830, length: 30 });
      await expectNoStrip(page);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});

test.describe('Day schedule, phone: new entries start inside the page shown', () => {
  test('a tap on each page starts a half-hour entry on that page at the half hour tapped, and Enter saves it there', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(11);
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      const time = draftTime(page);
      // AM: 60% of the way down the 10a row is the third quarter, 10:30.
      await showHalf(page, 'am');
      await tapSlot(page, `Add to ${OWNER_NAME} at 10a`, 0.6);
      await expect(field(page, 'New entry')).toBeFocused();
      await noWindow(page);
      await expect(time).toHaveText('10:30a');
      expect(await draftSpan(page), '10:30a to 11a').toEqual({ start: 630, length: 30 });
      await field(page, 'New entry').fill('Coffee');
      await field(page, 'New entry').press('Enter');
      await expect(block(page, `Coffee, 10:30a to 11a, ${OWNER_NAME}`)).toBeVisible();
      // PM: 30% of the way down the 10p row is the first half hour, 10:00.
      await showHalf(page, 'pm');
      await tapSlot(page, `Add to ${OWNER_NAME} at 10p`, 0.3);
      await expect(field(page, 'New entry')).toBeFocused();
      await expect(time).toHaveText('10p');
      expect(await draftSpan(page), '10p to 10:30p').toEqual({ start: 1320, length: 30 });
      await field(page, 'New entry').fill('Tea');
      await field(page, 'New entry').press('Enter');
      await expect(block(page, `Tea, 10p to 10:30p, ${OWNER_NAME}`)).toBeVisible();
      await expect(pressed(page)).toHaveAttribute('data-half', 'pm');
      // The night goes on past midnight: 60% of the way down the 12a row is the third quarter, 12:30a, stored as 1470 minutes of this date.
      await tapSlot(page, `Add to ${OWNER_NAME} at 12a`, 0.6);
      await expect(field(page, 'New entry')).toBeFocused();
      await expect(time).toHaveText('12:30a');
      expect(await draftSpan(page), '12:30a to 1a').toEqual({ start: 1470, length: 30 });
      await field(page, 'New entry').fill('Owl');
      await field(page, 'New entry').press('Enter');
      await expect(block(page, `Owl, 12:30a to 1a, ${OWNER_NAME}`)).toBeVisible();
      // The first half hour of each page, at its very top: 9:00p in PM and 7:00a in AM.
      await tapSlot(page, `Add to ${OWNER_NAME} at 9p`, 0.05);
      await expect(time).toHaveText('9p');
      await page.keyboard.press('Escape');
      await showHalf(page, 'am');
      await tapSlot(page, `Add to ${OWNER_NAME} at 7a`, 0.05);
      await expect(time).toHaveText('7a');
      await page.keyboard.press('Escape');
      await expect.poll(async () => (await stored(owner, date)).map((e: { text: string; start: number; length: number }) => [e.text, e.start, e.length])).toEqual([['Coffee', 630, 30], ['Tea', 1320, 30], ['Owl', 1470, 30]]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a tap at the end of AM starts the half hour that ends at 9p: it stays in AM, not cut there', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(12);
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      await showHalf(page, 'am');
      await tapSlot(page, `Add to ${OWNER_NAME} at 8p`, 0.9);
      // 8:45 would run half an hour past 9p, onto the page that is not on the screen: the entry is the half hour that fits, 8:30p to 9p.
      await expect(draftTime(page)).toHaveText('8:30p');
      await expect(page.locator('.day-ev.day-editing')).toHaveAttribute('data-clip', '');
      expect(await draftSpan(page)).toEqual({ start: 1230, length: 30 });
      await field(page, 'New entry').fill('Late dinner');
      await field(page, 'New entry').press('Enter');
      await expect(block(page, `Late dinner, 8:30p to 9p, ${OWNER_NAME}`)).toHaveAttribute('data-clip', '');
      await expect.poll(async () => (await stored(owner, date)).map((e: { start: number; length: number }) => [e.start, e.length])).toEqual([[1230, 30]]);
      // Nothing of it is on the other page.
      await showHalf(page, 'pm');
      await expect(page.locator('.day-ev')).toHaveCount(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a tap on PM at 9p starts 9p to 9:30p, one at 12a starts 12a to 12:30a, and one in the last row, 6a, starts 6:30a to 7a: the last half hour that fits', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(28);
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      await showHalf(page, 'pm');
      const editing = page.locator('.day-ev.day-editing');
      await tapSlot(page, `Add to ${OWNER_NAME} at 9p`, 0.1);
      await expect(draftTime(page)).toHaveText('9p');
      await expect(editing).toHaveAttribute('data-clip', '');
      await expect(editing).toHaveAttribute('data-q', '1');
      expect(await draftSpan(page)).toEqual({ start: 1260, length: 30 });
      await page.keyboard.press('Escape');
      await expect(editing).toHaveCount(0);
      // Midnight is the fourth row of the night: the 13th quarter hour, 1440 minutes of this date.
      await tapSlot(page, `Add to ${OWNER_NAME} at 12a`, 0.1);
      await expect(draftTime(page)).toHaveText('12a');
      await expect(editing).toHaveAttribute('data-clip', '');
      await expect(editing).toHaveAttribute('data-q', '13');
      expect(await draftSpan(page)).toEqual({ start: 1440, length: 30 });
      await page.keyboard.press('Escape');
      await expect(editing).toHaveCount(0);
      // 6:45a would run half an hour past 7a: the half hour that fits is 6:30a to 7a, at the bottom of the ten rows.
      await tapSlot(page, `Add to ${OWNER_NAME} at 6a`, 0.9);
      await expect(draftTime(page)).toHaveText('6:30a');
      await expect(editing).toHaveAttribute('data-clip', '');
      await expect(editing).toHaveAttribute('data-q', '39');
      await expect(editing).toHaveAttribute('data-n', '2');
      expect(await draftSpan(page)).toEqual({ start: 1830, length: 30 });
      await field(page, 'New entry').fill('Dawn run');
      await field(page, 'New entry').press('Enter');
      await expect(block(page, `Dawn run, 6:30a to 7a, ${OWNER_NAME}`)).toBeVisible();
      await expect.poll(async () => (await stored(owner, date)).map((e: { start: number; length: number }) => [e.start, e.length])).toEqual([[1830, 30]]);
      await showHalf(page, 'am');
      await expect(page.locator('.day-ev')).toHaveCount(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test(`in the Both view the page is cut in thirds on AM and on PM: the left third is ${OWNER_NAME}'s, the middle one entry for both, the right third ${PARTNER_NAME}'s`, async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(29);
    try {
      await login(page); await openDay(page, date);
      const editing = page.locator('.day-ev.day-editing[data-primary]');
      for (const [half, hour, start] of [['am', '10a', 600], ['pm', '10p', 1320]] as const) {
        await showHalf(page, half);
        const grid = await lanes(page);
        for (const [lane, across, who] of [[OWNER_NAME, 0.15, OWNER_NAME], [OWNER_NAME, 0.42, 'Both'], [PARTNER_NAME, 0.58, 'Both'], [PARTNER_NAME, 0.85, PARTNER_NAME]] as const) {
          await tapSlotAcross(page, `Add to ${lane} at ${hour}`, 0.1, across);
          await expect(field(page, 'New entry'), `${half} ${across}`).toBeFocused();
          await expect(editing, `${half} ${across}`).toHaveAttribute('data-who', who);
          expect(await draftSpan(page)).toEqual({ start, length: 30 });
          const box = (await editing.boundingBox())!;
          if (who === 'Both') { expect(box.width, `${half} ${across}: the middle is one entry across both lanes`).toBeGreaterThan(grid.width * 0.9); }
          else { expect(box.width, `${half} ${across}: a lane's third`).toBeLessThan(grid.width * 0.6); expect(who === OWNER_NAME ? box.x + box.width / 2 < grid.x + grid.width / 2 : box.x + box.width / 2 > grid.x + grid.width / 2, `${half} ${across}: the lane's side`).toBe(true); }
          await page.keyboard.press('Escape');
          await expect(editing).toHaveCount(0);
        }
      }
      expect(await stored(owner, date)).toHaveLength(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the last free half hour of a page is a 30-minute entry that ends at the edge of the page: at 9p on AM, at 7a on PM, in a lane and across both', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(13);
    // The owner's AM is taken from 7a to 8:30p and his PM from 9p to 6:30a: a half hour is free at the end of each page, and the edge of the page holds a new entry there to it.
    await add(owner, event(date, { text: 'Day', start: 420, length: 810 }));
    await add(owner, event(date, { text: 'Night', start: 1260, length: 570 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      await showHalf(page, 'am');
      await tapSlot(page, `Add to ${OWNER_NAME} at 8p`, 0.9);
      await expect.poll(() => draftSpan(page)).toEqual({ start: 1230, length: 30 });
      await page.keyboard.press('Escape');
      await expect(page.locator('.day-ev.day-editing')).toHaveCount(0);
      await showHalf(page, 'pm');
      await tapSlot(page, `Add to ${OWNER_NAME} at 6a`, 0.9);
      await expect.poll(() => draftSpan(page)).toEqual({ start: 1830, length: 30 });
      await page.keyboard.press('Escape');
      await expect(page.locator('.day-ev.day-editing')).toHaveCount(0);
      // Both of us: the middle third is an entry for both, and the half hour is free in both lanes.
      await pickList(page, 'Both');
      await tapSlotAcross(page, `Add to ${OWNER_NAME} at 6a`, 0.9, 0.42);
      await expect(page.locator('.day-ev.day-editing[data-primary]')).toHaveAttribute('data-who', 'Both');
      await expect.poll(() => draftSpan(page)).toEqual({ start: 1830, length: 30 });
      await page.keyboard.press('Escape');
      await showHalf(page, 'am');
      await tapSlotAcross(page, `Add to ${OWNER_NAME} at 8p`, 0.9, 0.42);
      await expect.poll(() => draftSpan(page)).toEqual({ start: 1230, length: 30 });
      await page.keyboard.press('Escape');
      // The partner's lane is free on both pages: the right third starts her an entry, the half hour the tap is in.
      await tapSlotAcross(page, `Add to ${PARTNER_NAME} at 10a`, 0.1, 0.85);
      await expect(page.locator('.day-ev.day-editing[data-primary]')).toHaveAttribute('data-who', PARTNER_NAME);
      await expect.poll(() => draftSpan(page)).toEqual({ start: 600, length: 30 });
      await page.keyboard.press('Escape');
      expect(posts).toEqual([]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test(`with no room left in ${OWNER_NAME}'s lane on the page, a tap in the middle third says there is no room left before 9p, or after 9p, for both of us, and starts nothing`, async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(44);
    // The owner's lane is booked from 7a to 7a the next morning, end to end. The tap is over the partner's free side of the middle third: her slot is there, but
    // The owner's quarter under it is taken and no start is free for both of us anywhere on the page.
    await add(owner, event(date, { text: 'Day', start: 420, length: 840 }));
    await add(owner, event(date, { text: 'Night', start: 1260, length: 600 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      const refresh = async () => { await page.getByRole('alert').getByRole('button', { name: 'Refresh', exact: true }).tap(); await expect(page.getByRole('alert')).toBeHidden(); };
      await showHalf(page, 'am');
      await tapSlotAcross(page, `Add to ${PARTNER_NAME} at 10a`, 0.1, 0.58);
      await expect(page.getByRole('alert')).toContainText('There is no room left before 9p.');
      await expect(page.locator('.day-ev.day-editing')).toHaveCount(0);
      await refresh();
      await showHalf(page, 'pm');
      await tapSlotAcross(page, `Add to ${PARTNER_NAME} at 10p`, 0.1, 0.58);
      await expect(page.getByRole('alert')).toContainText('There is no room left after 9p.');
      await expect(page.locator('.day-ev.day-editing')).toHaveCount(0);
      await refresh();
      // The partner's lane is free on both pages: the right third starts her an entry.
      await tapSlotAcross(page, `Add to ${PARTNER_NAME} at 10p`, 0.1, 0.85);
      await expect(page.locator('.day-ev.day-editing[data-primary]')).toHaveAttribute('data-who', PARTNER_NAME);
      await page.keyboard.press('Escape');
      expect(posts).toEqual([]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the hidden Add schedule entry button starts at 9a in AM and at 9p in PM', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(14);
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      const addEntry = page.getByRole('button', { name: 'Add schedule entry', exact: true });
      await showHalf(page, 'am');
      await addEntry.focus();
      await page.keyboard.press('Enter');
      await expect(field(page, 'New entry')).toBeFocused();
      await expect(page.locator('.day-ev.day-editing .day-ev-time')).toHaveText('9a');
      expect(await draftSpan(page), '9a to 9:30a').toEqual({ start: 540, length: 30 });
      await page.keyboard.press('Escape');
      await expect(page.locator('.day-ev.day-editing')).toHaveCount(0);
      await showHalf(page, 'pm');
      await addEntry.focus();
      await page.keyboard.press('Enter');
      await expect(field(page, 'New entry')).toBeFocused();
      await expect(page.locator('.day-ev.day-editing .day-ev-time')).toHaveText('9p');
      expect(await draftSpan(page), '9p to 9:30p').toEqual({ start: 1260, length: 30 });
      await field(page, 'New entry').fill('Snack');
      await field(page, 'New entry').press('Enter');
      await expect(block(page, `Snack, 9p to 9:30p, ${OWNER_NAME}`)).toBeVisible();
      expect((await stored(owner, date)).map((e: { start: number }) => e.start)).toEqual([1260]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});

test.describe('Day schedule, phone: dragging stays on the page shown', () => {
  test('a long press and drag of an entry grabbed by its start, to the bottom of AM, stops with a quarter hour of it still in AM: it does not jump onto PM', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(15);
    const id = await add(owner, event(date));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await showHalf(page, 'am');
      const f = finger(await page.context().newCDPSession(page));
      const grid = await lanes(page), dentist = (await block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`).boundingBox())!;
      const from = { x: dentist.x + dentist.width / 2, y: dentist.y + 5 };
      await f.down(from.x, from.y);
      await expect(page.locator('.day-ev[data-moving]')).toHaveCount(1, { timeout: 2000 });
      // Down past the bottom of the grid (the finger is in the tab bar's strip by then): the entry cannot start later than 8:45p.
      await f.to(from, grid.y + grid.height + 40);
      await expect(bubble(page)).toHaveText('8:45p – 9:45p');
      expect(posts).toHaveLength(0);
      await f.up();
      await expect.poll(async () => (await stored(owner, date))[0].start).toBe(1245);
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: [OWNER], text: 'Dentist', start: 1245, length: 60 }]);
      await settled(page);
      await expect(block(page, `Dentist, 8:45p to 9:45p, ${OWNER_NAME}`)).toHaveAttribute('data-clip', 'bottom');
      await expect(block(page, `Dentist, 8:45p to 9:45p, ${OWNER_NAME}`)).toHaveAttribute('data-n', '1');
      // The rest of it is on PM, from its top.
      await showHalf(page, 'pm');
      await expect(block(page, `Dentist, 8:45p to 9:45p, ${OWNER_NAME}`)).toHaveAttribute('data-clip', 'top');
      await expect(block(page, `Dentist, 8:45p to 9:45p, ${OWNER_NAME}`)).toHaveAttribute('data-n', '3');
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a long press and drag up past the top of PM keeps a quarter hour of the entry in PM: it starts no earlier than 8:15p', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(16);
    const id = await add(owner, event(date, { text: 'Visit', start: 1320, length: 60 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await showHalf(page, 'pm');
      const f = finger(await page.context().newCDPSession(page));
      const grid = await lanes(page), visit = (await block(page, `Visit, 10p to 11p, ${OWNER_NAME}`).boundingBox())!;
      const from = { x: visit.x + visit.width / 2, y: visit.y + 5 };
      await f.down(from.x, from.y);
      await expect(page.locator('.day-ev[data-moving]')).toHaveCount(1, { timeout: 2000 });
      await f.to(from, Math.max(8, grid.y - 100));
      await expect(bubble(page)).toHaveText('8:15p – 9:15p');
      await f.up();
      await expect.poll(async () => (await stored(owner, date))[0].start).toBe(1215);
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: [OWNER], text: 'Visit', start: 1215, length: 60 }]);
      await settled(page);
      await expect(block(page, `Visit, 8:15p to 9:15p, ${OWNER_NAME}`)).toHaveAttribute('data-clip', 'top');
      await expect(block(page, `Visit, 8:15p to 9:15p, ${OWNER_NAME}`)).toHaveAttribute('data-n', '1');
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  // The entry being edited is a draft: the same drag moves the draft, under the same rule, and nothing is written until Enter.
  // `begins` is the start the block's time label says once the finger is up; `shown` is the quarter hour of the draft that is on this page.
  for (const [half, n, start, label, text, toBottom, bubbled, kept, clip, begins, shown] of [
    ['AM', 31, 540, `Dentist, 9a to 10a, ${OWNER_NAME}`, 'Dentist', true, '8:45p – 9:45p', 1245, 'bottom', '8:45p', { start: 1245, length: 15 }],
    ['PM', 32, 1320, `Visit, 10p to 11p, ${OWNER_NAME}`, 'Visit', false, '8:15p – 9:15p', 1215, 'top', '8:15p', { start: 1260, length: 15 }],
  ] as const) {
    test(`a long press and drag of the entry being edited past the edge of ${half} keeps a quarter hour of the draft on ${half}, and writes nothing until Enter`, async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = day(n);
      const id = await add(owner, event(date, { text, start }));
      const posts = recordPosts(page);
      try {
        await login(page); await openDay(page, date);
        await showHalf(page, half === 'AM' ? 'am' : 'pm');
        await block(page, label).tap();
        await expect(field(page, `Edit entry: ${text}`)).toBeFocused();
        const f = finger(await page.context().newCDPSession(page));
        const grid = await lanes(page), editing = (await page.locator('.day-ev.day-editing').boundingBox())!;
        const from = { x: editing.x + editing.width / 2, y: editing.y + 5 };
        await f.down(from.x, from.y);
        await expect(page.locator('.day-ev[data-moving]')).toHaveCount(1, { timeout: 2000 });
        await f.to(from, toBottom ? grid.y + grid.height + 40 : Math.max(8, grid.y - 100));
        await expect(bubble(page)).toHaveText(bubbled);
        await f.up();
        // The draft keeps what the bubble read (the strip's span label is gone: the block says the start, the bubble said the whole span).
        await expect(draftTime(page)).toHaveText(begins);
        await expect(page.locator('.day-ev.day-editing')).toHaveAttribute('data-clip', clip);
        expect(await draftSpan(page)).toEqual(shown);
        await expectNoStrip(page);
        expect(posts).toEqual([]);
        expect((await stored(owner, date))[0].start, 'the stored entry has not moved').toBe(start);
        await field(page, `Edit entry: ${text}`).press('Enter');
        await expect.poll(async () => (await stored(owner, date))[0].start).toBe(kept);
        expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: [OWNER], text, start: kept, length: 60 }]);
      } finally { await clearDay(owner, date); await owner.dispose(); }
    });
  }

  test('a drag is measured on the whole 14-hour box on both pages: a fourteenth of the grid is an hour, on PM too', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(17);
    await add(owner, event(date, { text: 'Visit', start: 600, length: 60 }));
    await add(owner, event(date, { text: 'Show', start: 1260, length: 60 }));
    try {
      await login(page); await openDay(page, date);
      const f = finger(await page.context().newCDPSession(page));
      const hour = (await lanes(page)).height / 14;
      // AM: the entry moves an hour later for a fourteenth of the grid.
      await showHalf(page, 'am');
      let visit = (await block(page, `Visit, 10a to 11a, ${OWNER_NAME}`).boundingBox())!;
      let from = { x: visit.x + visit.width / 2, y: visit.y + visit.height / 2 };
      await f.down(from.x, from.y);
      await expect(page.locator('.day-ev[data-moving]')).toHaveCount(1, { timeout: 2000 });
      await f.to(from, from.y + hour);
      await expect(bubble(page)).toHaveText('11a – 12p');
      await f.up();
      await expect.poll(async () => (await stored(owner, date)).find((e: { text: string }) => e.text === 'Visit').start).toBe(660);
      await settled(page);
      await expect(block(page, `Visit, 11a to 12p, ${OWNER_NAME}`)).toBeVisible();
      // PM: its ten rows are the same size, so the same distance is the same hour.
      await showHalf(page, 'pm');
      visit = (await block(page, `Show, 9p to 10p, ${OWNER_NAME}`).boundingBox())!;
      from = { x: visit.x + visit.width / 2, y: visit.y + visit.height / 2 };
      await f.down(from.x, from.y);
      await expect(page.locator('.day-ev[data-moving]')).toHaveCount(1, { timeout: 2000 });
      await f.to(from, from.y + hour);
      await expect(bubble(page)).toHaveText('10p – 11p');
      await f.up();
      await expect.poll(async () => (await stored(owner, date)).find((e: { text: string }) => e.text === 'Show').start).toBe(1320);
      await settled(page);
      await expect(block(page, `Show, 10p to 11p, ${OWNER_NAME}`)).toBeVisible();
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a long press and drag down on PM, into the empty part of the box and past it, ends at 6a to 7a: the last hour of the night', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(30);
    const id = await add(owner, event(date, { text: 'Show', start: 1260, length: 60 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await showHalf(page, 'pm');
      const f = finger(await page.context().newCDPSession(page));
      const grid = await lanes(page), show = (await block(page, `Show, 9p to 10p, ${OWNER_NAME}`).boundingBox())!;
      const from = { x: show.x + show.width / 2, y: show.y + 5 };
      await f.down(from.x, from.y);
      await expect(page.locator('.day-ev[data-moving]')).toHaveCount(1, { timeout: 2000 });
      // Down into the four empty rows at the bottom of the box, the minutes after 7a that the night does not have, and on past the box.
      await f.to(from, grid.y + grid.height * 12 / 14);
      await expect(bubble(page)).toHaveText('6a – 7a');
      await f.to({ x: from.x, y: grid.y + grid.height * 12 / 14 }, grid.y + grid.height + 40);
      await expect(bubble(page)).toHaveText('6a – 7a');
      await f.up();
      await expect.poll(async () => (await stored(owner, date))[0].start).toBe(1800);
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: [OWNER], text: 'Show', start: 1800, length: 60 }]);
      await settled(page);
      await expect(block(page, `Show, 6a to 7a, ${OWNER_NAME}`)).toHaveAttribute('data-clip', '');
      await expect(block(page, `Show, 6a to 7a, ${OWNER_NAME}`)).toHaveAttribute('data-q', '37');
      // None of it is on AM.
      await showHalf(page, 'am');
      await expect(page.locator('.day-ev')).toHaveCount(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a long press and drag on PM across midnight: an entry 11p to 12a dragged an hour and three quarters later is 12:45a to 1:45a', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(35);
    const id = await add(owner, event(date, { text: 'Show', start: 1380, length: 60 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await showHalf(page, 'pm');
      const f = finger(await page.context().newCDPSession(page));
      const hour = (await lanes(page)).height / 14, show = (await block(page, `Show, 11p to 12a, ${OWNER_NAME}`).boundingBox())!;
      const from = { x: show.x + show.width / 2, y: show.y + show.height / 2 };
      await f.down(from.x, from.y);
      await expect(page.locator('.day-ev[data-moving]')).toHaveCount(1, { timeout: 2000 });
      // An hour and three quarters of grid down: 11p + 1:45 is 12:45a.
      await f.to(from, from.y + hour * 1.75);
      await expect(bubble(page)).toHaveText('12:45a – 1:45a');
      await f.up();
      await expect.poll(async () => (await stored(owner, date))[0].start).toBe(1485);
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: [OWNER], text: 'Show', start: 1485, length: 60 }]);
      await settled(page);
      await expect(block(page, `Show, 12:45a to 1:45a, ${OWNER_NAME}`)).toHaveAttribute('data-clip', '');
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  // The handles use the same pointer-to-minute mapping as the drag of an entry: the pointer counts as being inside the page it is shown in, so a
  // finger that runs on past the grid (into the tab bar's strip, where there is still screen) does not take an edge onto the other page.
  test('dragging the end handle of an entry past the bottom of the AM grid stops the end at 9p', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(18);
    await add(owner, event(date, { text: 'Morning', start: 540, length: 60 }));
    try {
      await login(page); await openDay(page, date);
      await showHalf(page, 'am');
      await block(page, `Morning, 9a to 10a, ${OWNER_NAME}`).tap();
      await expect(field(page, 'Edit entry: Morning')).toBeFocused();
      const grid = await lanes(page), grab = await centre(handle(page, 'end'));
      await page.mouse.move(grab.x, grab.y); await page.mouse.down();
      // Down to the bottom of the grid, then on past it for as long as the screen goes.
      const below = Math.min(grid.y + grid.height + 40, 805);
      for (let i = 1; i <= 24; i++) { await page.mouse.move(grab.x, grab.y + ((below - grab.y) * i) / 24); }
      await page.locator('.day-timeline').evaluate(el => { el.scrollTop = el.scrollHeight; });
      await expect(bubble(page)).toHaveText('9a – 9p');
      await page.mouse.up();
      await field(page, 'Edit entry: Morning').press('Enter');
      await expect.poll(async () => { const e = (await stored(owner, date))[0]; return e.start + e.length; }).toBe(1260);
      expect((await stored(owner, date))[0].start, 'the start did not move').toBe(540);
      await settled(page);
      await expect(block(page, `Morning, 9a to 9p, ${OWNER_NAME}`)).toHaveAttribute('data-clip', '');
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('dragging the start handle of an entry past the top of the PM grid stops the start at 9p', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(23);
    await add(owner, event(date, { text: 'Evening', start: 1320, length: 60 }));
    try {
      await login(page); await openDay(page, date);
      await showHalf(page, 'pm');
      await block(page, `Evening, 10p to 11p, ${OWNER_NAME}`).tap();
      await expect(field(page, 'Edit entry: Evening')).toBeFocused();
      const grid = await lanes(page), grab = await centre(handle(page, 'start'));
      await page.mouse.move(grab.x, grab.y); await page.mouse.down();
      const above = Math.max(grid.y - 40, 60);
      for (let i = 1; i <= 24; i++) { await page.mouse.move(grab.x, grab.y + ((above - grab.y) * i) / 24); }
      await page.mouse.up();
      await field(page, 'Edit entry: Evening').press('Enter');
      await expect.poll(async () => (await stored(owner, date))[0].start).toBe(1260);
      expect((await stored(owner, date))[0].start + (await stored(owner, date))[0].length, 'the end did not move').toBe(1380);
      await settled(page);
      await expect(block(page, `Evening, 9p to 11p, ${OWNER_NAME}`)).toHaveAttribute('data-clip', '');
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('dragging the end handle of an entry past the bottom of the night, into the empty rows of the box and beyond, stops the end at 7a', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(36);
    await add(owner, event(date, { text: 'Dawn', start: 1740, length: 60 }));
    try {
      await login(page); await openDay(page, date);
      await showHalf(page, 'pm');
      await block(page, `Dawn, 5a to 6a, ${OWNER_NAME}`).tap();
      await expect(field(page, 'Edit entry: Dawn')).toBeFocused();
      const grid = await lanes(page), grab = await centre(handle(page, 'end'));
      await page.mouse.move(grab.x, grab.y); await page.mouse.down();
      // Down through the last row of the night (the bubble reads its end at 7a), then on through the empty rows and past the box.
      const empty = grid.y + grid.height * 12 / 14, below = Math.min(grid.y + grid.height + 40, 805);
      for (let i = 1; i <= 12; i++) { await page.mouse.move(grab.x, grab.y + ((empty - grab.y) * i) / 12); }
      await expect(bubble(page)).toHaveText('5a – 7a');
      for (let i = 1; i <= 12; i++) { await page.mouse.move(grab.x, empty + ((below - empty) * i) / 12); }
      await expect(bubble(page)).toHaveText('5a – 7a');
      await page.mouse.up();
      await field(page, 'Edit entry: Dawn').press('Enter');
      await expect.poll(async () => { const e = (await stored(owner, date))[0]; return e.start + e.length; }).toBe(1860);
      expect((await stored(owner, date))[0].start, 'the start did not move').toBe(1740);
      await settled(page);
      await expect(block(page, `Dawn, 5a to 7a, ${OWNER_NAME}`)).toHaveAttribute('data-clip', '');
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('Alt+Arrow moves an entry being edited a quarter hour at a time, and says so when the next step would leave AM', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(19);
    await add(owner, event(date, { text: 'Visit', start: 1230, length: 30 }));
    try {
      await login(page); await openDay(page, date);
      await showHalf(page, 'am');
      await block(page, `Visit, 8:30p to 9p, ${OWNER_NAME}`).tap();
      const edit = field(page, 'Edit entry: Visit');
      await expect(edit).toBeFocused();
      // Each step moves the draft and the live region reads out where it is now (the strip's span label is gone); the block shows the start.
      await edit.press('Alt+ArrowDown');
      await expect(page.locator('#live')).toHaveText('8:45p – 9:15p');
      await expect(draftTime(page)).toHaveText('8:45p');
      // The next quarter hour would put all of it on PM.
      await edit.press('Alt+ArrowDown');
      await expect(page.locator('#live')).toHaveText('Cannot move later on this half of the day: switch to PM.');
      await expect(draftTime(page)).toHaveText('8:45p');
      await edit.press('Alt+ArrowUp');
      await expect(page.locator('#live')).toHaveText('8:30p – 9p');
      await expect(draftTime(page)).toHaveText('8:30p');
      expect(await draftSpan(page)).toEqual({ start: 1230, length: 30 });
      await expectNoStrip(page);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('Alt+Arrow on an entry being edited on PM stops where all of it would be on AM, and says so', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(5);
    await add(owner, event(date, { text: 'Visit', start: 1275, length: 30 }));
    try {
      await login(page); await openDay(page, date);
      await showHalf(page, 'pm');
      await block(page, `Visit, 9:15p to 9:45p, ${OWNER_NAME}`).tap();
      const edit = field(page, 'Edit entry: Visit');
      await expect(edit).toBeFocused();
      await edit.press('Alt+ArrowUp');
      await expect(page.locator('#live')).toHaveText('9p – 9:30p');
      await expect(draftTime(page)).toHaveText('9p');
      // Still a quarter hour of it on PM, drawn flat at the top.
      await edit.press('Alt+ArrowUp');
      await expect(page.locator('#live')).toHaveText('8:45p – 9:15p');
      await expect(draftTime(page)).toHaveText('8:45p');
      await expect(page.locator('.day-ev.day-editing')).toHaveAttribute('data-clip', 'top');
      expect(await draftSpan(page), 'the quarter hour of it that is on PM').toEqual({ start: 1260, length: 15 });
      // The next quarter hour would put all of it on AM.
      await edit.press('Alt+ArrowUp');
      await expect(page.locator('#live')).toHaveText('Cannot move earlier on this half of the day: switch to AM.');
      await expect(draftTime(page)).toHaveText('8:45p');
      expect(await draftSpan(page)).toEqual({ start: 1260, length: 15 });
      await edit.press('Alt+ArrowDown');
      await expect(page.locator('#live')).toHaveText('9p – 9:30p');
      await expect(draftTime(page)).toHaveText('9p');
      expect(await draftSpan(page)).toEqual({ start: 1260, length: 30 });
      await expectNoStrip(page);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('Alt+Shift+Arrow shortens an entry cut flat at the top of PM only while some of it stays on PM: the second press is refused and its block stays under its editor', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(24);
    await add(owner, event(date, { text: 'Late show', start: 1230, length: 60 }));
    try {
      await login(page); await openDay(page, date);
      await showHalf(page, 'pm');
      await block(page, `Late show, 8:30p to 9:30p, ${OWNER_NAME}`).tap();
      const edit = field(page, 'Edit entry: Late show'), editing = page.locator('.day-ev.day-editing');
      await expect(edit).toBeFocused();
      await expect(editing).toHaveAttribute('data-clip', 'top');
      // The end goes to 9:15p: a quarter hour of the entry is still on PM (the live region reads out the span; the block keeps the start).
      await edit.press('Alt+Shift+ArrowUp');
      await expect(page.locator('#live')).toHaveText('8:30p – 9:15p');
      await expect(draftTime(page)).toHaveText('8:30p');
      await expect(editing).toHaveAttribute('data-n', '1');
      // The next quarter hour would end it at 9p, with none of it on PM: it is not made, and the block does not vanish from under the field.
      await edit.press('Alt+Shift+ArrowUp');
      await expect(page.locator('#live')).toHaveText('Cannot make it shorter on this half of the day: switch to AM.');
      await expect(draftTime(page)).toHaveText('8:30p');
      await expect(editing).toBeVisible();
      await expect(editing).toHaveAttribute('data-n', '1');
      await expect(edit).toBeFocused();
      // Enter stores what is on the screen: a span with part of it on PM.
      await edit.press('Enter');
      await expect.poll(async () => (await stored(owner, date)).map((e: { start: number; length: number }) => [e.start, e.length])).toEqual([[1230, 45]]);
      await settled(page);
      await expect(block(page, `Late show, 8:30p to 9:15p, ${OWNER_NAME}`)).toHaveAttribute('data-clip', 'top');
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('Alt+Arrow on a stored entry at the end of AM moves it once; the step that would take all of it onto PM is refused with a word, and it stays in the AM grid; on PM the step back is refused the same way', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(25);
    const id = await add(owner, event(date, { text: 'Visit', start: 1230, length: 30 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await showHalf(page, 'am');
      await block(page, `Visit, 8:30p to 9p, ${OWNER_NAME}`).focus();
      await page.keyboard.press('Alt+ArrowDown');
      await expect(block(page, `Visit, 8:45p to 9:15p, ${OWNER_NAME}`)).toBeFocused();
      await expect(page.locator('#live')).toHaveText('Visit moved to 8:45p – 9:15p.');
      await page.keyboard.press('Alt+ArrowDown');
      await expect(page.locator('#live')).toHaveText('Visit cannot move later on this half of the day: switch to PM.');
      // Still where the first step left it, in the AM grid with its cut edge at the bottom, and only the first step was written.
      await expect(block(page, `Visit, 8:45p to 9:15p, ${OWNER_NAME}`)).toHaveAttribute('data-clip', 'bottom');
      await expect(page.locator('.day-ev')).toHaveCount(1);
      await settled(page);
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: [OWNER], text: 'Visit', start: 1245, length: 30 }]);
      expect(await stored(owner, date)).toMatchObject([{ start: 1245, length: 30 }]);
      // On PM the same entry is cut at the top: the step that would put all of it back on AM is refused, the one that keeps it on PM is made.
      await showHalf(page, 'pm');
      await block(page, `Visit, 8:45p to 9:15p, ${OWNER_NAME}`).focus();
      await page.keyboard.press('Alt+ArrowUp');
      await expect(page.locator('#live')).toHaveText('Visit cannot move earlier on this half of the day: switch to AM.');
      await expect(block(page, `Visit, 8:45p to 9:15p, ${OWNER_NAME}`)).toHaveAttribute('data-clip', 'top');
      await page.keyboard.press('Alt+ArrowDown');
      await expect(block(page, `Visit, 9p to 9:30p, ${OWNER_NAME}`)).toBeFocused();
      await expect(page.locator('#live')).toHaveText('Visit moved to 9p – 9:30p.');
      await settled(page);
      expect(await stored(owner, date)).toMatchObject([{ start: 1260, length: 30 }]);
      expect(posts).toHaveLength(2);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a long press and drag of a stored hour down past Show (8:30p to 9:30p) at the bottom of AM does not follow the nearest free start onto PM: it ends at the last place with all of it in AM', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(27);
    const id = await add(owner, event(date, { text: 'Visit', start: 540, length: 60 }));
    await add(owner, event(date, { text: 'Show', start: 1230, length: 60 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await showHalf(page, 'am');
      const f = finger(await page.context().newCDPSession(page));
      const grid = await lanes(page), visit = (await block(page, `Visit, 9a to 10a, ${OWNER_NAME}`).boundingBox())!;
      const from = { x: visit.x + visit.width / 2, y: visit.y + 5 };
      await f.down(from.x, from.y);
      await expect(page.locator('.day-ev[data-moving]')).toHaveCount(1, { timeout: 2000 });
      // Past the bottom of the grid the nearest free start for an hour is 9:30p, after Show and wholly on PM; a place with none of it on the screen is not followed.
      await f.to(from, grid.y + grid.height + 40);
      await expect(bubble(page)).toHaveText('7:30p – 8:30p');
      expect(posts).toHaveLength(0);
      await f.up();
      await expect.poll(async () => (await stored(owner, date)).find((e: { text: string }) => e.text === 'Visit').start).toBe(1170);
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: [OWNER], text: 'Visit', start: 1170, length: 60 }]);
      await settled(page);
      await expect(block(page, `Visit, 7:30p to 8:30p, ${OWNER_NAME}`)).toBeVisible();
      await expect(page.locator('.day-ev')).toHaveCount(2);
      // Nothing of it is on PM: only Show's second half hour.
      await showHalf(page, 'pm');
      await expect(page.locator('.day-ev')).toHaveCount(1);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});

test.describe('Day schedule, phone: switching page while an entry is being edited', () => {
  test('a stored entry being edited is saved first: the words typed are written, and the other page is shown', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(20);
    const id = await add(owner, event(date));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await showHalf(page, 'am');
      await block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`).tap();
      await field(page, 'Edit entry: Dentist').fill('Dentist two');
      expect(posts).toHaveLength(0);
      await tapHalf(page, 'pm');
      await expect(pressed(page)).toHaveAttribute('data-half', 'pm');
      await expect(page.locator('.day-hours span')).toHaveText(PM_HOURS);
      await expect.poll(async () => (await stored(owner, date))[0].text).toBe('Dentist two');
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: [OWNER], text: 'Dentist two', start: 540, length: 60 }]);
      await expect(page.locator('.day-ev.day-editing')).toHaveCount(0);
      await showHalf(page, 'am');
      await expect(block(page, `Dentist two, 9a to 10a, ${OWNER_NAME}`)).toBeVisible();
      await expect(page.locator('.day-ev.day-editing')).toHaveCount(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a stored entry of the night being edited is saved first on the way to AM: the words typed are written and AM is shown', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(37);
    const id = await add(owner, event(date, { text: 'Night owl', start: 1500 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await showHalf(page, 'pm');
      await block(page, `Night owl, 1a to 2a, ${OWNER_NAME}`).tap();
      await field(page, 'Edit entry: Night owl').fill('Owl two');
      expect(posts).toHaveLength(0);
      await tapHalf(page, 'am');
      await expect(pressed(page)).toHaveAttribute('data-half', 'am');
      await expect(page.locator('.day-hours span')).toHaveText(AM_HOURS);
      await expect.poll(async () => (await stored(owner, date))[0].text).toBe('Owl two');
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: [OWNER], text: 'Owl two', start: 1500, length: 60 }]);
      await expect(page.locator('.day-ev.day-editing')).toHaveCount(0);
      await expect(page.locator('.day-ev')).toHaveCount(0);
      await showHalf(page, 'pm');
      await expect(block(page, `Owl two, 1a to 2a, ${OWNER_NAME}`)).toBeVisible();
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('an entry whose words fill all 500 characters is saved on the way to the other page with no refusal; back on AM its block is still its one hour, its text is all 500 characters, and it shows exactly the lines its room holds, the clipped rest ending in an ellipsis', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(39);
    const id = await add(owner, event(date));
    const words = `${'word '.repeat(99)}word!`;
    expect(words).toHaveLength(500);
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await showHalf(page, 'am');
      await block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`).tap();
      const edit = field(page, 'Edit entry: Dentist');
      await expect(edit).toHaveAttribute('maxlength', '500');
      await edit.fill(words);
      await expect(edit).toHaveValue(words);
      // Typing 500 characters is no refusal. No save has been tried yet, so this alone cannot show that 500 is accepted: the checks after the switch do.
      await expect(page.locator('#error-message')).toHaveText('');
      await tapHalf(page, 'pm');
      await expect(pressed(page)).toHaveAttribute('data-half', 'pm');
      await expect.poll(async () => (await stored(owner, date))[0].text).toBe(words);
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: [OWNER], text: words, start: 540, length: 60 }]);
      // The save is answered and the page has drawn the answer: a refused or reported save of exactly 500 characters would be in the banner by now.
      await settled(page);
      await expect(page.locator('#error-message')).toHaveText('');
      await expect(page.getByRole('alert')).toBeHidden();
      expect(posts).toHaveLength(1);
      await showHalf(page, 'am');
      const long = block(page, `${words}, 9a to 10a, ${OWNER_NAME}`);
      await expect(long).toBeVisible();
      // The block is still the hour it was (one hour row of the grid, however long the words), and its words show the lines its room holds.
      const [row] = await rowHeights(page);
      await expectFit(long, true, 'the 500 characters show the lines the block\'s room holds, clipped after the last');
      const m = await measure(long);
      expect(Math.round(m.height)).toBeLessThanOrEqual(Math.round(row));
      expect(m.height).toBeGreaterThan(row * 0.8);
      // An hour of a phone holds more than the one line of the old display, and the words need more than it holds: this is what the ellipsis is for.
      expect(holds(m), 'the room of an hour, in lines').toBeGreaterThanOrEqual(2);
      expect(needs(m), 'the lines the 500 characters need').toBeGreaterThan(holds(m));
      // The page holds all 500 characters (the display cuts them, the markup does not), in the text and in the tooltip.
      expect(m.content).toBe(words);
      expect(m.title).toBe(words);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a block shows its words over the lines its room holds: 500 characters are clipped after the last line (a clamping box with hidden overflow), words that fit are not clipped at all', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(40);
    const words = `${'word '.repeat(99)}word!`, medium = 'a longer entry that wants a second line and then some more to say about it';
    expect(words).toHaveLength(500);
    await add(owner, event(date, { text: words, start: 540 }));
    await add(owner, event(date, { text: medium, start: 660 }));
    await add(owner, event(date, { text: 'Dentist', start: 780 }));
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      await showHalf(page, 'am');
      const long = block(page, `${words}, 9a to 10a, ${OWNER_NAME}`), mid = block(page, `${medium}, 11a to 12p, ${OWNER_NAME}`), short = block(page, `Dentist, 1p to 2p, ${OWNER_NAME}`);
      for (const b of [long, mid, short]) { await expect(b).toBeVisible(); }
      await expectFit(long, true, '500 characters are clipped');
      await expectFit(mid, false, 'words of a couple of lines are whole');
      await expectFit(short, false, 'one word is whole');
      const [l, m, s] = [await measure(long), await measure(mid), await measure(short)];
      // The three kinds of words are really three kinds: more lines than the room holds, several lines that fit, a single line.
      expect(holds(l), 'room of an hour').toBeGreaterThanOrEqual(2);
      expect(needs(l)).toBeGreaterThan(holds(l));
      expect(needs(m), 'the middle words wrap').toBeGreaterThanOrEqual(2);
      expect(needs(m)).toBeLessThanOrEqual(holds(m));
      expect(needs(s)).toBe(1);
      // The clipped words fill the block: the lines shown are the lines the room holds, and one more would not fit in it.
      expect(l.shown).toBeLessThanOrEqual(l.room + 0.5);
      expect(l.room + 0.5 - l.shown).toBeLessThan(l.line);
      // Whole words are not clipped (all of their height shows), and every kind keeps all of its characters in the page.
      expect(m.scroll).toBeLessThanOrEqual(m.shown);
      expect(s.scroll).toBeLessThanOrEqual(s.shown);
      expect([l.content, m.content, s.content]).toEqual([words, medium, 'Dentist']);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('blocks follow their room when the screen changes height, with no redraw: the lines shown track the block\'s room (padding left out) at every height of a sweep that crosses every step of the rule, on a phone and a wide page, for clipped, just-fitting and one-line words', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(41);
      const words = `${'word '.repeat(99)}word!`, fitting = 'three lines of words, '.repeat(13).trim();
    await add(owner, event(date, { text: words, start: 540 }));
    await add(owner, event(date, { text: fitting, start: 660 }));
    await add(owner, event(date, { text: 'Dentist', start: 780 }));
    try {
      await page.setViewportSize({ width: 375, height: 600 });
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      await showHalf(page, 'am');
      const blocks = { long: block(page, `${words}, 9a to 10a, ${OWNER_NAME}`), mid: block(page, `${fitting}, 11a to 12p, ${OWNER_NAME}`), short: block(page, `Dentist, 1p to 2p, ${OWNER_NAME}`) };
      for (const b of Object.values(blocks)) { await expect(b).toBeVisible(); await mark(b); }
      await expectFit(blocks.long, true, 'at 600px high before the sweep');
      const initialRoom = holds(await measure(blocks.long));
      // Sweep beyond the timeline's minimum height to cross several line-fit thresholds without redrawing.
      const rooms: number[] = [], clipped: number[] = [], whole: number[] = [];
      let needed = 0;
      for (let height = 1400; height <= 2300; height += 24) {
        await page.setViewportSize({ width: 375, height });
        await expectFit(blocks.long, true, `${height}px high: 500 characters over the lines the room holds`);
        await expectFit(blocks.mid, null, `${height}px high: the words that need a few lines, over the lines the room holds`);
        await expectFit(blocks.short, false, `${height}px high: one word is one line`);
        const [l, m] = [await measure(blocks.long), await measure(blocks.mid)];
        rooms.push(holds(l)); needed = needs(m);
        (needs(m) > holds(m) ? clipped : whole).push(holds(m));
      }
      // The room really changed (a sweep that left it alone would pass whatever the page did), by several lines, and it only grew with the height.
      expect(new Set(rooms).size, `lines held across the sweep: ${rooms}`).toBeGreaterThanOrEqual(4);
      expect(rooms, 'a taller screen holds as many lines or more').toEqual([...rooms].sort((a, b) => a - b));
      // The words that need a few lines were clipped (an ellipsis) while the room held fewer lines than they need, and whole from the height that holds them.
      expect(needed, 'the lines the words need').toBeGreaterThanOrEqual(2);
      expect(Math.max(...clipped), 'the most lines held while they were clipped').toBe(needed - 1);
      expect(Math.min(...whole), 'the fewest lines held while they were whole').toBe(needed);
      // No redraw made a new block on the way (its first fit would hide a missing re-fit).
      for (const b of Object.values(blocks)) { expect(await kept(b), 'the same block, not a redrawn one').toBe(true); }
      // And back down: the lines fall with the room.
      await page.setViewportSize({ width: 375, height: 600 });
      await expectFit(blocks.long, true, 'back at 600px high');
      expect(holds(await measure(blocks.long))).toBe(initialRoom);
      expect(await kept(blocks.long)).toBe(true);
      // The same sweep on a wide page.
      await page.setViewportSize({ width: 1360, height: 900 });
      await expect(page.locator('.day-panel[data-layout=wide]')).toBeVisible();
      for (const b of Object.values(blocks)) { await expect(b).toBeVisible(); await mark(b); }
      expect((await measure(blocks.long)).padding, 'a wide hour block has padding that the room must leave out').toBeGreaterThan(0);
      const wide: number[] = [];
      for (let height = 1550; height <= 2300; height += 24) {
        await page.setViewportSize({ width: 1360, height });
        await expectFit(blocks.long, null, `wide, ${height}px high: 500 characters over the lines the room holds`);
        await expectFit(blocks.mid, null, `wide, ${height}px high: the words that need a few lines, over the lines the room holds`);
        await expectFit(blocks.short, false, `wide, ${height}px high: one word is one line`);
        wide.push(holds(await measure(blocks.long)));
      }
      expect(new Set(wide).size, `lines held across the wide sweep: ${wide}`).toBeGreaterThanOrEqual(3);
      expect(wide, 'a taller window holds as many lines or more').toEqual([...wide].sort((a, b) => a - b));
      for (const b of Object.values(blocks)) { expect(await kept(b), 'the same block, not a redrawn one').toBe(true); }
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  /**
   * Edits a stored three-hour entry on a wide page (a phone shows one tab at a time, so only a wide page has a text field beside the schedule)
   * and moves the focus to the add box: the entry is saved, and the shell does not draw the panel again under a focused field, so the row is swapped
   * by hand. Returns the block that stands where the editor was, after proving it is the swapped one (the panel is the one that was there, the add box has the focus).
   */
  async function swapOut(page: Page, owner: Api, date: string, words: string) {
    await login(page); await openDay(page, date);
    await pickList(page, OWNER_NAME);
    await page.setViewportSize({ width: 1360, height: 900 });
    await expect(page.locator('.day-panel[data-layout=wide]')).toBeVisible();
    await expect(pressed(page)).toHaveAttribute('data-half', 'am');
    await block(page, `Dentist, 9a to 12p, ${OWNER_NAME}`).tap();
    await field(page, 'Edit entry: Dentist').fill(words);
    const addBox = page.getByLabel('New task', { exact: true }), panel = page.locator('.day-panel');
    await mark(panel);
    // focus(), not a tap: a press on the empty add field opens a new to-do in its place (to-dos in thirds); the keyboard is what moves the focus to it.
    await addBox.focus();
    await expect.poll(async () => (await stored(owner, date))[0].text).toBe(words);
    const swapped = block(page, `${words}, 9a to 12p, ${OWNER_NAME}`);
    await expect(swapped).toBeVisible();
    await expect(page.locator('.day-ev.day-editing')).toHaveCount(0);
    await expect(addBox).toBeFocused();
    expect(await kept(panel), 'the panel was not drawn again: the block is the swapped one').toBe(true);
    await mark(swapped);
    return { swapped, addBox };
  }

  test('an entry saved as its editor closes while the focus has gone to another field (the add box of a wide page, where its row is swapped by hand) is put back as a block that shows the lines its room holds', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(42);
    await add(owner, event(date, { text: 'Dentist', start: 540, length: 180 }));
    const words = 'W'.repeat(500);
    try {
      const { swapped } = await swapOut(page, owner, date, words);
      // As a block the page drew itself: the lines its room holds, clipped after the last (not the one line a block has until it is fitted).
      await expectFit(swapped, true, 'the swapped block shows the lines its room holds');
      expect(holds(await measure(swapped)), 'a three-hour block holds several lines').toBeGreaterThanOrEqual(3);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the block put back by hand as an editor closes (focus gone to the add box) keeps following its room: a shorter window gives it fewer lines, a taller one more, with no redraw', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(43);
    await add(owner, event(date, { text: 'Dentist', start: 540, length: 180 }));
    const words = `${'word '.repeat(99)}word!`;
    try {
      const { swapped, addBox } = await swapOut(page, owner, date, words);
      // Nothing is asserted of the first fit here (the test above does that): the window's height changes the block's, and its lines must follow.
      await page.setViewportSize({ width: 1360, height: 700 });
      await expectFit(swapped, null, 'the swapped block, in a window 200px shorter');
      const small = holds(await measure(swapped));
      await page.setViewportSize({ width: 1360, height: 1850 });
      await expectFit(swapped, null, 'the swapped block, in a window 400px taller than it started');
      expect(small, 'fewer lines in the shorter window than in the taller one').toBeLessThan(holds(await measure(swapped)));
      await expect(addBox).toBeFocused();
      expect(await kept(swapped), 'the same block all along').toBe(true);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a new entry with words is added in the page it was started in; one without words is dropped and nothing is written', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(21);
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      await showHalf(page, 'am');
      await tapSlot(page, `Add to ${OWNER_NAME} at 8a`, 0.1);
      await field(page, 'New entry').fill('Gym');
      await tapHalf(page, 'pm');
      await expect(pressed(page)).toHaveAttribute('data-half', 'pm');
      await expect.poll(async () => (await stored(owner, date)).map((e: { text: string; start: number; length: number }) => [e.text, e.start, e.length])).toEqual([['Gym', 480, 30]]);
      expect(posts).toHaveLength(1);
      await expect(page.locator('.day-ev')).toHaveCount(0);
      // Started on PM with nothing typed: leaving for AM drops it.
      await tapSlot(page, `Add to ${OWNER_NAME} at 10p`, 0.1);
      await expect(field(page, 'New entry')).toBeFocused();
      await tapHalf(page, 'am');
      await expect(pressed(page)).toHaveAttribute('data-half', 'am');
      await expect(page.locator('.day-ev.day-editing')).toHaveCount(0);
      await expect(block(page, `Gym, 8a to 8:30a, ${OWNER_NAME}`)).toBeVisible();
      await settled(page);
      expect(posts).toHaveLength(1);
      expect(await stored(owner, date)).toHaveLength(1);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('an entry that cannot be saved yet (its words are over the limit) keeps the page it is on: the other page is asked for, the switch stays and the editor stays', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(26);
    await add(owner, event(date));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await showHalf(page, 'am');
      await block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`).tap();
      const edit = field(page, 'Edit entry: Dentist'), editing = page.locator('.day-ev.day-editing');
      // The field stops typing at the limit (fill() stops there too, at 500); a script can still put a longer draft in it (501 characters), and its save is refused.
      await expect(edit).toHaveAttribute('maxlength', '500');
      await edit.fill('D'.repeat(501));
      await expect(edit).toHaveValue('D'.repeat(500));
      await overLimit(edit, 'D'.repeat(501));
      await tapHalf(page, 'pm');
      // The refusal is said once in the shell's banner, not in the block.
      await expect(page.locator('#error-message')).toHaveText('Keep it to 500 characters.');
      await expect(page.getByRole('alert')).toContainText('Keep it to 500 characters.');
      await expect(editing.locator('.ip-error')).toHaveCount(0);
      // #146: the banner lies over the top bar's date and arrows, between the menu and the picker; the switch row, the lane names and the
      // panel are not covered, and nothing moved.
      await settled(page);
      const [alert, nav, menu, picker, tools, names] = await page.evaluate(() =>
        ['#error', '.phone-nav', '#menu', '#picker-slot', '.day-lanehead', '.day-lanehead'].map(selector => document.querySelector(selector)!.getBoundingClientRect().toJSON() as DOMRect));
      expect(alert.top).toBeGreaterThanOrEqual(nav.top - 1);
      expect(alert.bottom).toBeLessThanOrEqual(tools.top + 0.5);
      expect(alert.left).toBeGreaterThanOrEqual(menu.right - 0.5);
      expect(alert.right).toBeLessThanOrEqual(picker.left + 0.5);
      expect(names.top).toBeGreaterThan(alert.bottom);
      // The menu button is not covered: it is what a press there reaches (the drawer that held the choice is still sliding away for a moment, so poll).
      await expect.poll(() => page.evaluate(() => { const b = document.querySelector('#menu')!.getBoundingClientRect(); return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('#menu') !== null; })).toBe(true);
      await expect(pressed(page)).toHaveAttribute('data-half', 'am');
      await expect(page.locator('.day-corner')).toHaveText('AM');
      await expect(page.locator('.day-hours span')).toHaveText(AM_HOURS);
      await expect(editing).toHaveCount(1);
      await expect(edit).toHaveValue('D'.repeat(501));
      await settled(page);
      expect(posts).toEqual([]);
      // Once the words fit, the same switch saves the entry first (here there is nothing new to write) and shows the other page.
      await edit.fill('Dentist');
      // Fixing the words takes the refusal back out of the banner.
      await expect(page.getByRole('alert')).toBeHidden();
      await expect(editing).toHaveCount(1);
      await tapHalf(page, 'pm');
      await expect(pressed(page)).toHaveAttribute('data-half', 'pm');
      await expect(editing).toHaveCount(0);
      expect(posts).toEqual([]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('an entry of the night that cannot be saved yet keeps PM: AM is asked for, the switch stays on PM and the editor stays', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = day(38);
    await add(owner, event(date, { text: 'Night owl', start: 1500 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await showHalf(page, 'pm');
      await block(page, `Night owl, 1a to 2a, ${OWNER_NAME}`).tap();
      const edit = field(page, 'Edit entry: Night owl'), editing = page.locator('.day-ev.day-editing');
      await expect(edit).toHaveAttribute('maxlength', '500');
      await overLimit(edit, 'N'.repeat(501));
      await tapHalf(page, 'am');
      await expect(page.locator('#error-message')).toHaveText('Keep it to 500 characters.');
      await expect(page.getByRole('alert')).toContainText('Keep it to 500 characters.');
      await expect(editing.locator('.ip-error')).toHaveCount(0);
      await expect(pressed(page)).toHaveAttribute('data-half', 'pm');
      await expect(page.locator('.day-hours span')).toHaveText(PM_HOURS);
      await expect(editing).toHaveCount(1);
      await expect(editing).toHaveAttribute('data-q', '17');
      await expect(edit).toHaveValue('N'.repeat(501));
      await settled(page);
      expect(posts).toEqual([]);
      // Once the words fit, the same switch saves the entry first (here there is nothing new to write) and shows AM.
      await edit.fill('Night owl');
      await expect(page.getByRole('alert')).toBeHidden();
      await expect(editing).toHaveCount(1);
      await tapHalf(page, 'am');
      await expect(pressed(page)).toHaveAttribute('data-half', 'am');
      await expect(editing).toHaveCount(0);
      expect(posts).toEqual([]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});
