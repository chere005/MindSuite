import { expect, test, type Locator, type Page } from '@playwright/test';
import { CAPS, PHONE_TABS, dayLabel } from '../packages/core/src/planner';
import { shiftDate } from '../packages/core/src/parse';
import { apiLogin, browserStorage, draftSpan, farDate, field, hitSizes, leaveField, login, noWindow, pickList, resetPrefs, showHalf, today, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// The Day panel on a phone: three tabs that each fit the screen, live counters, the done rows in the to-do list and the +N more list, the notes
// lane switch, and an entry edited in its block with its handles (nothing hangs over the schedule while it is edited, and no window opens
// for editing anything; Delete is a swipe, in swipe-delete-phone.spec.ts). The project's own viewport is 375x812; the smallest supported phones are run too. (The date sheets
// and the tab bars are in phone-sheets.spec.ts.) The schedule has two pages behind an AM and PM switch: AM is the day as it always was,
// 7a to 9p (840 minutes, 14 hour rows), and PM is the night after it, 9p to 7a (10 rows at the same row height). A page opens on AM,
// so a test that looks at or taps an entry after 9p first chooses PM with showHalf.
const add = async (api: Api, body: Record<string, unknown>) => {
  const data = { id: crypto.randomUUID(), ...body };
  const response = await api.post(data);
  expect(response.status(), JSON.stringify(await response.json())).toBe(200);
  return data.id as string;
};
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
const TAB_NAMES = { schedule: 'Schedule', todo: 'To-do', notes: 'Notes', chores: 'Chores' } as const;
const tab = (page: Page, name: keyof typeof TAB_NAMES) => page.getByRole('tab', { name: TAB_NAMES[name], exact: true });
const goTo = async (page: Page, name: keyof typeof TAB_NAMES) => { await tab(page, name).tap(); await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true'); };
const MAX = CAPS.dayTodosPerList;
/**
 * Nothing hangs over the schedule while an entry is edited: no strip, no span label, counter, hint, error or Delete in a block, and the middle of each of the
 * two handles is a handle (never a strip, a block or the tab bar). A handle pulled in to keep its grab area on the screen may sit over the other one, so it is
 * "a handle of this block", not "this very handle".
 */
async function bare(page: Page, label: string) {
  await expect(page.locator('.day-ev-strip, .day-ev .ip-span, .day-ev .ip-count, .day-ev .ip-hint, .day-ev .ip-error, .day-ev .ip-del, .day-ev-del'), `${label}: no strip, counter, hint or Delete`).toHaveCount(0);
  const hit = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.day-ev.day-editing .day-handle')].map(h => {
    const b = h.getBoundingClientRect(), on = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return { edge: h.dataset.edge, under: on?.closest('.day-handle') ? '' : `${on?.tagName}.${on?.className ?? 'nothing'}` };
  }));
  expect(hit.map(h => h.edge).sort(), `${label}: both handles`).toEqual(['end', 'start']);
  expect(hit.filter(h => h.under).map(h => `${h.edge} under ${h.under}`), `${label}: something covers a handle at its middle`).toEqual([]);
}
test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });

/** A busy day: both lanes full of everything the caps allow, so the tabs are at their worst. */
async function busyDay(api: Api, date: string) {
  const owners = (who: string) => (who === 'both' ? [OWNER, PARTNER] : [who]);
  await add(api, { action: 'add', kind: 'event', date, owners: owners(OWNER), text: 'Gym', start: 420, length: 60 });
  await add(api, { action: 'add', kind: 'event', date, owners: owners(OWNER), text: 'Dentist', start: 540, length: 60 });
  await add(api, { action: 'add', kind: 'event', date, owners: owners(PARTNER), text: 'Yoga', start: 540, length: 60 });
  await add(api, { action: 'add', kind: 'event', date, owners: owners('both'), text: 'Lunch together', start: 720, length: 60 });
  await add(api, { action: 'add', kind: 'event', date, owners: owners(PARTNER), text: 'Late call', start: 1200, length: 60 });
  await add(api, { action: 'add', kind: 'event', date, owners: owners(OWNER), text: 'Night owl', start: 1320, length: 60 });
  for (let line = 1; line <= 5; line++) {
    await add(api, { action: 'add', kind: 'priority', date, owners: [OWNER], slots: { [OWNER]: line }, text: `${OWNER_NAME} line ${line}` });
    await add(api, { action: 'add', kind: 'priority', date, owners: [PARTNER], slots: { [PARTNER]: line }, text: `${PARTNER_NAME} line ${line}` });
  }
  for (const title of ['Done one', 'Done two']) {
    const id = await add(api, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title });
    const stored = (await api.snapshot()).tasks.find((t: { id: string }) => t.id === id);
    expect((await api.post({ action: 'complete', id, revision: stored.revision, done: true })).status()).toBe(200);
  }
  for (const who of [OWNER, PARTNER]) {
    for (let n = 1; n <= MAX; n++) { await add(api, { action: 'add', kind: 'todo', scope: 'day', date, owners: [who], title: `${who === OWNER ? OWNER_NAME : PARTNER_NAME} thing ${n}` }); }
  }
  await add(api, { action: 'saveNote', scope: 'day', period: date, listId: OWNER, field: 'notes', text: 'n'.repeat(400), revision: 0 });
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
/** Every named element lies inside the tab's body, so nothing is clipped away by a fixed height. The rows of the to-do list are
 *  inside when the list itself is: it is the one thing that scrolls (and only when the 13 open rows, the done rows after them and the +N more row do
 *  not fit a short phone), so a row it holds is judged by the list's box, and has to be reachable by scrolling it. */
async function expectInside(page: Page, selector: string, label: string, minHeight = 0) {
  const outside = await page.evaluate(([sel, min]) => {
    const body = document.querySelector('.day-body')!.getBoundingClientRect();
    const inside = (r: DOMRect) => r.top >= body.top - 0.5 && r.bottom <= body.bottom + 0.5;
    return [...document.querySelectorAll<HTMLElement>(sel as string)].filter(el => !el.hidden).filter(el => {
      const r = el.getBoundingClientRect(), list = el.closest('.day-timeline, .day-todo > .day-tasks');
      return r.height < (min as number) || !inside(list && list !== el ? list.getBoundingClientRect() : r);
    }).length;
  }, [selector, minHeight]);
  expect(outside, label).toBe(0);
}

/**
 * What a schedule block shows of its words and what its height holds, read in the page (a plain function: it is sent to the page as it is). The room for
 * lines is worked out the way the product defines it (ScheduleSection.fitLines): the block's clientHeight less its vertical padding, and the lines it holds
 * are floor((room + 0.5) / lineHeight), at least one. `holds` is what the layout says; `lines` and `clamp` are what the product set (its --lines and the
 * computed -webkit-line-clamp), so a check of one against the other is never a variable read against itself. `words` is the height the words are drawn at,
 * `over` how much further the words go than the box that clips them (scrollHeight less clientHeight: above 0 is where the browser draws the ellipsis), and
 * `past` how far the last drawn line ends below the block's content box.
 */
const lineFacts = (el: HTMLElement) => {
  const text = el.querySelector<HTMLElement>('.day-ev-text')!, box = getComputedStyle(el), own = getComputedStyle(text);
  const rect = el.getBoundingClientRect(), words = text.getBoundingClientRect();
  const line = parseFloat(own.lineHeight), pad = parseFloat(box.paddingTop) + parseFloat(box.paddingBottom), room = el.clientHeight - pad;
  return {
    label: el.getAttribute('aria-label'), n: Number(el.getAttribute('data-n')), height: rect.height, row: document.querySelector('.day-hours span')!.getBoundingClientRect().height,
    line, pad, room, holds: Math.max(1, Math.floor((room + 0.5) / line)),
    lines: Number(el.style.getPropertyValue('--lines')), clamp: own.getPropertyValue('-webkit-line-clamp'), clipped: `${own.overflowX} ${own.overflowY}`,
    words: words.height, above: words.top - rect.top, below: rect.bottom - words.bottom, over: text.scrollHeight - text.clientHeight,
    past: words.bottom - (rect.bottom - parseFloat(box.borderBottomWidth) - parseFloat(box.paddingBottom)),
    text: text.textContent, title: el.getAttribute('title'),
  };
};
/**
 * A block's lines settle after layout (ScheduleSection watches the size of every block and sets --lines when it changes), so this waits until the product's
 * --lines and clamp are what the block's height holds, and then reads the block once more for the checks that follow.
 */
async function settledFacts(block: Locator, name: string) {
  await expect.poll(async () => {
    const f = await block.evaluate(lineFacts);
    return f.lines === f.holds && f.clamp === String(f.holds) ? 'follows its height' : `--lines ${f.lines} and clamp ${f.clamp}, but its height holds ${f.holds} (room ${f.room}, line ${f.line})`;
  }, { message: `${name}: --lines and the clamp follow the height`, timeout: 10_000 }).toBe('follows its height');
  return block.evaluate(lineFacts);
}

for (const [width, height] of [[375, 667], [320, 568]] as const) {
  test.describe(`Day panel, phone ${width}x${height}`, () => {
    test.use({ viewport: { width, height } });

    test('the four tabs of PHONE_TABS.day, Schedule first, each fitting one screen with no scrolling, on a full day', async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = farDate(width === 375 ? 200 : 201);
      await busyDay(owner, date);
      try {
        await login(page); await openDay(page, date);
        await expect(page.getByRole('tab')).toHaveText(PHONE_TABS.day.map(t => TAB_NAMES[t]));
        await expect(tab(page, 'schedule')).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('tabpanel')).toBeVisible();

        await expectFits(page, 'schedule');
        // AM has 14 hour rows (7a to 9p) share the height and PM draws its 10 (9p to 7a) at that same height: each row stays at the
        // grid's 32px floor or more, and the tab fits one screen with the switch above the timeline.
        let row = 0;
        for (const [half, rows, entries] of [['am', 14, 5], ['pm', 10, 1]] as const) {
          await showHalf(page, half);
          await expectFits(page, `schedule, ${half}`);
          const hours = await page.locator('.day-hours span').evaluateAll(spans => spans.map(s => s.getBoundingClientRect().height));
          expect(hours, half).toHaveLength(rows);
          expect(Math.min(...hours), half).toBeGreaterThanOrEqual(32);
          expect(Math.max(...hours) - Math.min(...hours), `${half}: one height for every row`).toBeLessThanOrEqual(1);
          row ||= hours[0];
          expect(Math.abs(hours[0] - row), `${half}: the same row height as AM`).toBeLessThanOrEqual(1);
          await expect(page.locator('.day-ev'), half).toHaveCount(entries);
          await expectInside(page, '.day-ev, .day-hours span, .day-lane', `schedule contents, ${half}`);
          // A block shows as many lines of its words as its height holds (the line clamp, its --lines) and never grows a row: it is as tall as the
          // quarter-hour rows it covers (less its 1px margins), and short words are one line that sits inside it. The lines it holds come from the
          // layout (its clientHeight less its padding, as the product works them out) and are what --lines and the computed clamp must be.
          const quarter = hours[0] / 4;
          for (const block of await page.locator('.day-ev').all()) {
            const name = `${half}: ${await block.getAttribute('aria-label')}`;
            const shown = await settledFacts(block, name);
            expect(Math.abs(shown.height - (shown.n * quarter - 2)), `${name}: as tall as its ${shown.n} quarter hours`).toBeLessThanOrEqual(1);
            expect(shown.room, `${name}: its height (less padding ${shown.pad}) has room for a line`).toBeGreaterThanOrEqual(shown.line - 0.5);
            expect(shown.lines, `${name}: --lines is the most lines its room of ${shown.room}px holds`).toBe(shown.holds);
            expect(shown.clamp, `${name}: the words are clamped to the lines it holds`).toBe(String(shown.holds));
            expect(shown.clipped, `${name}: the words are clipped at their box, which is what draws an ellipsis`).toBe('hidden hidden');
            expect(shown.holds * shown.line, `${name}: those lines fit its room`).toBeLessThanOrEqual(shown.room + 0.5);
            expect((shown.holds + 1) * shown.line, `${name}: and one more would not`).toBeGreaterThan(shown.room + 0.5);
            expect(shown.words, `${name}: short words are one line, not padded to the lines it holds`).toBe(shown.line);
            expect(shown.over, `${name}: nothing of short words is cut off (no ellipsis for words that fit)`).toBe(0);
            expect(Math.min(shown.above, shown.below), `${name}: the words are inside the block`).toBeGreaterThanOrEqual(0);
            expect(shown.past, `${name}: the last line ends inside the block's room`).toBeLessThanOrEqual(1);
          }
        }

        await goTo(page, 'todo');
        await expectFits(page, 'to-do');
        // Five lines, the 13 open rows a list may hold (CAPS.dayTodosPerList) with the 2 done rows crossed out after them in the same list, and a +N more row
        // for the other list's 13: all there, all on screen, none shorter than 30px (28px for a priority line), the list scrolling when they do not fit,
        // no Done button anywhere, and no For row (the picker at the top says who a new one is for).
        await expect(page.locator('.day-prow')).toHaveCount(5);
        await expect(page.locator('.day-tasks .day-task')).toHaveCount(CAPS.dayTodosPerList + 2);
        await expect(page.locator('.day-tasks .day-task:not(.day-done)')).toHaveCount(CAPS.dayTodosPerList);
        await expect(page.locator('.day-tasks .day-task.day-done')).toHaveCount(2);
        await expect(page.locator('.day-tasks > li').nth(CAPS.dayTodosPerList)).toHaveClass(/day-done/);
        await expect(page.getByRole('button', { name: /^Done \(/ })).toHaveCount(0);
        await expect(page.getByRole('button', { name: `+${2 * MAX - CAPS.dayTodosPerList} more`, exact: true })).toBeVisible();
        await expect(page.getByRole('radiogroup')).toHaveCount(0);
        await expectInside(page, '.day-prow, .day-task, .day-more, .day-add', 'to-do contents', 20);
        // The rows never squeeze past a readable size: 30px for a to-do, 28px for a priority line. Under that the list, and nothing
        // else on the tab, scrolls (the host and the tab's body are checked not to by expectFits).
        const rows = await page.evaluate(() => ({ todo: [...document.querySelectorAll('.day-tasks .day-task')].map(r => r.getBoundingClientRect().height), lines: [...document.querySelectorAll('.day-prow')].map(r => r.getBoundingClientRect().height) }));
        expect(Math.min(...rows.todo)).toBeGreaterThanOrEqual(29.9);
        expect(Math.min(...rows.lines)).toBeGreaterThanOrEqual(27.9);
        await expectInside(page, '.day-msg', 'to-do message');

        await goTo(page, 'notes');
        await expectFits(page, 'notes');
        await expectInside(page, '.day-seg, .day-note, .day-note-text, .day-note-save', 'notes contents', 20);
        await expect(page.locator('.day-note-text')).toHaveCount(1);
        expect(await browserStorage(page)).toEqual({ local: 0, session: 0, indexedDB: 0, caches: 0 });
      } finally { await clearDay(owner, date); await owner.dispose(); }
    });

    test('a long text is clamped to as many lines as its block holds and clipped after the last, where the ellipsis is drawn; a text that fits is not clamped; a taller block holds more, none grows, and all 500 characters stay in the block and its title', async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = farDate(width === 375 ? 218 : 219);
      // Exactly the most a stored text may hold (CAPS.dayEventText, 500): the server keeps all of it.
      const long = ('Review the plan with the accountant, then collect the papers and post them. '.repeat(7).slice(0, CAPS.dayEventText - 1) + '.');
      expect(long).toHaveLength(500);
      // Words that take two or three lines of a lane but come nowhere near filling a three-hour block.
      const fitting = 'Collect the papers and post them';
      const hour = await add(owner, { action: 'add', kind: 'event', date, owners: [OWNER], text: long, start: 540, length: 60 });
      const sibling = await add(owner, { action: 'add', kind: 'event', date, owners: [PARTNER], text: 'Short', start: 540, length: 60 });
      const three = await add(owner, { action: 'add', kind: 'event', date, owners: [OWNER], text: long, start: 660, length: 180 });
      const roomy = await add(owner, { action: 'add', kind: 'event', date, owners: [PARTNER], text: fitting, start: 660, length: 180 });
      try {
        await login(page); await openDay(page, date);
        await showHalf(page, 'am');
        const look = (id: string, name: string) => settledFacts(page.locator(`.day-ev[data-id="${id}"]`), name);
        const [one, short, tall, fits] = [await look(hour, 'one hour'), await look(sibling, 'a short text'), await look(three, 'three hours'), await look(roomy, 'a text that fits three hours')];
        for (const [name, block] of [['one hour', one], ['three hours', tall]] as const) {
          // As many lines as the height holds (worked out from the layout, as the product does: clientHeight less padding), every one of them filled by the 500
          // characters, and the rest of the words cut off: the words' box clips (overflow hidden) and its content is taller than the box, which is what the browser's
          // line clamp draws the ellipsis on, at the end of the last line.
          expect(block.room, `${name}: its height (less padding ${block.pad}) has room for a line`).toBeGreaterThanOrEqual(block.line - 0.5);
          expect(block.lines, `${name}: --lines is the most lines its room of ${block.room}px holds`).toBe(block.holds);
          expect(block.clamp, `${name}: clamped to the lines it holds`).toBe(String(block.holds));
          expect(block.holds * block.line, `${name}: those lines fit its room`).toBeLessThanOrEqual(block.room + 0.5);
          expect((block.holds + 1) * block.line, `${name}: one more would not`).toBeGreaterThan(block.room + 0.5);
          expect(block.words, `${name}: every line it holds is filled, and no more is drawn`).toBe(block.holds * block.line);
          expect(block.clipped, `${name}: the words are clipped at their box (that is what the ellipsis needs)`).toBe('hidden hidden');
          expect(block.over, `${name}: the words go on past the last line (that is where the ellipsis is)`).toBeGreaterThan(block.line);
          expect(Math.min(block.above, block.below), `${name}: the words are inside the block`).toBeGreaterThanOrEqual(0);
          expect(block.past, `${name}: the last line ends inside the block's room`).toBeLessThanOrEqual(1);
          // The words are never cut at a number of characters: all 500 are in the block, and in its title for a hover.
          expect(block.text, `${name}: all the words are there`).toBe(long);
          expect(block.title, `${name}: the title holds them all`).toBe(long);
          expect(Math.abs(block.height - (block.n * block.row / 4 - 2)), `${name}: as tall as its ${block.n} quarter hours, whatever the words`).toBeLessThanOrEqual(1);
        }
        // Words that fit are not clamped: they are drawn at their own height (two or more whole lines, fewer than the block holds), with nothing past the box (no ellipsis);
        // the clamp is the block's, not the words' (it is the same as for a long text of the same height).
        expect(fits.words % fits.line, 'fitting words are whole lines').toBe(0);
        expect(fits.words, 'fitting words wrap over more than one line').toBeGreaterThanOrEqual(2 * fits.line);
        expect(fits.words, 'fitting words leave room in the block').toBeLessThan(fits.holds * fits.line);
        expect(fits.over, 'nothing of fitting words is cut off').toBe(0);
        expect(fits.lines, 'fitting words are in a block that holds the same lines as the long text beside it').toBe(tall.lines);
        expect(fits.clipped).toBe('hidden hidden');
        expect(fits.text).toBe(fitting);
        // A short text in the same hour is one line with nothing cut, and the long one's block is the same height: the words never grow a block.
        expect(short.words).toBe(short.line);
        expect(short.over).toBe(0);
        expect(one.height).toBeCloseTo(short.height, 0);
        // Three times the height holds more lines than one hour does.
        expect(one.lines).toBeGreaterThanOrEqual(1);
        expect(tall.lines).toBeGreaterThan(one.lines);
        await expectFits(page, 'schedule, long texts');
        await expectInside(page, '.day-ev, .day-hours span, .day-lane', 'schedule contents, long texts');
        // Editing the long entry puts all of it in the field (the block shows the field, not the clamp), and the block keeps its height.
        await page.locator(`.day-ev[data-id="${hour}"]`).tap();
        await expect(field(page, `Edit entry: ${long}`)).toHaveValue(long);
        expect(Math.abs((await page.locator('.day-ev.day-editing').boundingBox())!.height - one.height)).toBeLessThanOrEqual(1);
        await expectFits(page, 'schedule, a long entry being edited');
        await page.keyboard.press('Escape');
      } finally { await clearDay(owner, date); await owner.dispose(); }
    });

    test('a block follows its height without being drawn again: a taller window gives it more lines, the window as it was gives back the old count, and the blocks are the very same elements', async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = farDate(width === 375 ? 222 : 223);
      const long = ('Review the plan with the accountant, then collect the papers and post them. '.repeat(7).slice(0, CAPS.dayEventText - 1) + '.');
      const fitting = 'Collect the papers and post them';
      const hour = await add(owner, { action: 'add', kind: 'event', date, owners: [OWNER], text: long, start: 540, length: 60 });
      const three = await add(owner, { action: 'add', kind: 'event', date, owners: [OWNER], text: long, start: 660, length: 180 });
      const roomy = await add(owner, { action: 'add', kind: 'event', date, owners: [PARTNER], text: fitting, start: 660, length: 180 });
      try {
        await login(page); await openDay(page, date);
        await showHalf(page, 'am');
        const ids = { hour, three, roomy };
        const names = { hour: 'one hour', three: 'three hours', roomy: 'a text that fits three hours' } as const;
        const locate = (key: keyof typeof ids) => page.locator(`.day-ev[data-id="${ids[key]}"]`);
        const keys = Object.keys(ids) as Array<keyof typeof ids>;
        const read = async () => Object.fromEntries(await Promise.all(keys.map(async key => [key, await settledFacts(locate(key), names[key])]))) as Record<keyof typeof ids, Awaited<ReturnType<typeof settledFacts>>>;
        // The elements as they are now: a panel drawn again would put new ones on the page and leave these detached.
        const elements = await Promise.all(keys.map(key => locate(key).elementHandle()));
        const was = await read();
        // A viewport tall enough for the minimum grid lets hour rows grow, without redrawing the panel.
        await page.setViewportSize({ width, height: 1820 });
        const taller = await read();
        for (const key of ['hour', 'three'] as const) {
          expect(taller[key].height, `${names[key]}: the block really grew with the window`).toBeGreaterThan(was[key].height + 10);
          expect(taller[key].holds, `${names[key]}: and its height now holds more lines`).toBeGreaterThan(was[key].holds);
          expect(taller[key].lines, `${names[key]}: --lines followed the height up`).toBe(taller[key].holds);
          expect(taller[key].clamp, `${names[key]}: so did the clamp`).toBe(String(taller[key].holds));
          expect(taller[key].words, `${names[key]}: the long text fills every line it now holds`).toBe(taller[key].holds * taller[key].line);
          expect(taller[key].over, `${names[key]}: and still goes on past the last (the ellipsis)`).toBeGreaterThan(taller[key].line);
          expect(taller[key].past, `${names[key]}: ending inside the block's room`).toBeLessThanOrEqual(1);
        }
        expect(taller.roomy.lines, 'fitting words: --lines followed the height up too').toBe(taller.roomy.holds);
        expect(taller.roomy.words, 'fitting words keep their own height in a taller block').toBe(was.roomy.words);
        expect(taller.roomy.over, 'and are still not cut').toBe(0);
        // The window as it was: the block is as tall as before and holds the old count again (down as well as up).
        await page.setViewportSize({ width, height });
        const back = await read();
        for (const key of keys) {
          expect(Math.abs(back[key].height - was[key].height), `${names[key]}: as tall as it was`).toBeLessThanOrEqual(1);
          expect(back[key].lines, `${names[key]}: --lines followed the height down again`).toBe(was[key].lines);
          expect(back[key].clamp).toBe(was[key].clamp);
        }
        expect(back.three.words, 'the long text fills the lines it holds again').toBe(was.three.words);
        for (const [i, element] of elements.entries()) { expect(await element!.evaluate(el => el.isConnected), `${names[keys[i]]}: still the very same block, not drawn again`).toBe(true); }
      } finally { await clearDay(owner, date); await owner.dispose(); }
    });

    test('a half-hour card holds its title, and resizing stops at 30 minutes', async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = farDate(width === 375 ? 220 : 221);
      const posts: Array<Record<string, unknown>> = [];
      page.on('request', request => { if (request.method() === 'POST' && request.url().includes('api.php')) { posts.push(request.postDataJSON()); } });
      // A one-hour entry can shrink to a half hour, and a half-hour entry is already at the minimum.
      const dentist = await add(owner, { action: 'add', kind: 'event', date, owners: [OWNER], text: 'Dentist', start: 540, length: 60 });
      const quick = await add(owner, { action: 'add', kind: 'event', date, owners: [PARTNER], text: 'Quick call', start: 840, length: 30 });
      try {
        await login(page); await openDay(page, date);
        await showHalf(page, 'am');
        const quarter = (await page.locator('.day-hours span').first().evaluate(el => el.getBoundingClientRect().height)) / 4;
        // A half hour has the same full-size type as longer entries.
        const bar = page.locator(`.day-ev[data-id="${quick}"]`);
        await expect(bar).toHaveAttribute('data-n', '2');
        await expect(bar).toHaveAttribute('aria-label', `Quick call, 2p to 2:30p, ${PARTNER_NAME}`);
        const look = await bar.evaluate(el => { const text = el.querySelector<HTMLElement>('.day-ev-text')!, own = getComputedStyle(text); return { font: own.fontSize, line: own.lineHeight, overflow: getComputedStyle(el).overflow, height: el.getBoundingClientRect().height, words: text.getBoundingClientRect().height }; });
        expect(look).toMatchObject({ font: '13px', line: '14px', overflow: 'visible', words: 14 });
        expect(Math.abs(look.height - (2 * quarter - 2)), 'two quarter-hour rows, less the inset').toBeLessThanOrEqual(1);
        expect(Math.abs((await page.locator(`.day-ev[data-id="${dentist}"]`).boundingBox())!.height - (4 * quarter - 2)), 'an hour is four quarter-hour rows').toBeLessThanOrEqual(1);
        await expectFits(page, 'schedule, a half-hour card');

        // The end handle pulled up past the start stops at 30 minutes (the least an entry can be), and Enter writes that.
        await page.getByRole('button', { name: `Dentist, 9a to 10a, ${OWNER_NAME}`, exact: true }).tap();
        await expect(field(page, 'Edit entry: Dentist')).toBeFocused();
        const grid = (await page.locator('.day-lanes').boundingBox())!, span = Number(await page.locator('.day-lanes').getAttribute('data-span'));
        const end = (await page.locator('.day-handle[data-edge=end]').boundingBox())!, x = end.x + end.width / 2, y = end.y + end.height / 2;
        await page.mouse.move(x, y); await page.mouse.down();
        await page.mouse.move(x, y - (120 * grid.height) / span, { steps: 8 });
        await expect(page.locator('.day-bubble')).toHaveText('9a – 9:30a');
        await page.mouse.up();
        await expect.poll(() => draftSpan(page)).toEqual({ start: 540, length: 30 });
        expect(posts).toHaveLength(0);
        await field(page, 'Edit entry: Dentist').press('Enter');
        await expect(page.getByRole('button', { name: `Dentist, 9a to 9:30a, ${OWNER_NAME}`, exact: true })).toBeVisible();
        expect(posts).toEqual([{ action: 'edit', kind: 'event', id: dentist, revision: 1, date, owners: [OWNER], text: 'Dentist', start: 540, length: 30 }]);
        expect((await owner.snapshot()).events.find((e: { id: string }) => e.id === dentist)).toMatchObject({ start: 540, length: 30 });

        // Alt+Shift+Up on a half hour keeps the minimum and says it cannot (the key is read and refused, not ignored); Alt+Shift+Down grows it back by a
        // step; and Escape on a draft that differs from the stored entry (45 minutes against the stored half hour) writes nothing and drops the draft.
        await bar.tap();
        const edit = field(page, 'Edit entry: Quick call'), told = page.locator('#live');
        await expect(edit).toBeFocused();
        await edit.press('Alt+Shift+ArrowUp');
        await expect(told, 'a half hour is refused a shorter length out loud').toHaveText('Cannot make it shorter.');
        await expect.poll(() => draftSpan(page)).toEqual({ start: 840, length: 30 });
        await edit.press('Alt+Shift+ArrowDown');
        await expect.poll(() => draftSpan(page)).toEqual({ start: 840, length: 45 });
        await expect(told).toHaveText('2p – 2:45p');
        await edit.press('Alt+Shift+ArrowUp');
        await expect.poll(() => draftSpan(page)).toEqual({ start: 840, length: 30 });
        await expect(told).toHaveText('2p – 2:30p');
        await edit.press('Alt+Shift+ArrowUp');
        await expect(told, 'and again, one step after it came back down to a half hour').toHaveText('Cannot make it shorter.');
        await expect.poll(() => draftSpan(page)).toEqual({ start: 840, length: 30 });
        await edit.press('Alt+Shift+ArrowDown');
        await expect.poll(() => draftSpan(page)).toEqual({ start: 840, length: 45 });
        await edit.press('Escape');
        await expect(page.locator('.day-ev.day-editing')).toHaveCount(0);
        // Escape drops the 45-minute draft and restores the saved half-hour card.
        expect(posts).toHaveLength(1);
        expect((await owner.snapshot()).events.find((e: { id: string }) => e.id === quick)).toMatchObject({ start: 840, length: 30 });
        await expect(bar).toHaveAttribute('data-n', '2');
        await expect(bar).toHaveAttribute('aria-label', `Quick call, 2p to 2:30p, ${PARTNER_NAME}`);
      } finally { await clearDay(owner, date); await owner.dispose(); }
    });

    test('live counters, a blocked Add over the cap, and with 13 open the add field gives way to the reason', async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = farDate(width === 375 ? 202 : 203);
      for (let n = 1; n < MAX; n++) { await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title: `Thing ${n}` }); }
      try {
        await login(page); await openDay(page, date);
        await pickList(page, OWNER_NAME);
        await goTo(page, 'todo');
        const counts = page.locator('.day-todo [data-kind=todos]'), chars = page.locator('.day-todo [data-kind=chars]');
        const box = page.getByLabel('New task', { exact: true }), go = page.getByRole('button', { name: 'Add', exact: true });
        await expect(counts).toHaveText(`${MAX - 1} of ${MAX}`);
        // The last free slot is the add field, and Add shows once there is something to add.
        await expect(page.locator('.day-free')).toHaveCount(1);
        await expect(go).toBeHidden();
        await box.fill('x'.repeat(37));
        await expect(chars).toHaveText('37 / 36');
        await expect(go).toBeDisabled();
        await box.fill('Last one');
        await expect(chars).toHaveText('8 / 36');
        await go.tap();
        await expect(page.getByRole('button', { name: 'Edit Last one', exact: true })).toBeVisible();
        await expect(counts).toHaveText(`${MAX} of ${MAX}`);
        await expect(counts).toHaveAttribute('data-over', 'true');
        // All 13 slots hold a to-do: no blank line and no field, only the reason.
        await expect(page.locator('.day-free')).toHaveCount(0);
        await expect(box).toHaveCount(0);
        await expect(page.locator('.day-msg')).toHaveText(`${OWNER_NAME} already has ${MAX} things to do that day.`);
        await expectFits(page, 'to-do, full');
        await expectInside(page, '.day-prow, .day-task, .day-more, .day-add', 'to-do contents, full', 20);
        await expectInside(page, '.day-msg', 'to-do message, full');
      } finally { await clearDay(owner, date); await owner.dispose(); }
    });

    test('an almost empty To-do tab is still 13 ruled slots: the tab fits, only the list may scroll, and the add field is on the first blank line, in reach', async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = farDate(width === 375 ? 208 : 209);
      for (let n = 1; n <= 3; n++) { await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title: `Thing ${n}` }); }
      try {
        await login(page); await openDay(page, date);
        await pickList(page, OWNER_NAME);
        await goTo(page, 'todo');
        await expectFits(page, 'to-do, three open');
        await expect(page.locator('.day-tasks .day-task')).toHaveCount(3);
        await expect(page.locator('.day-tasks .day-free')).toHaveCount(MAX - 3);
        const rows = await page.locator('.day-tasks > li').evaluateAll(items => items.map(item => item.getBoundingClientRect().height));
        expect(Math.min(...rows), 'no line under 30px').toBeGreaterThanOrEqual(29.9);
        expect(Math.max(...rows) - Math.min(...rows), 'every slot is a line of the same height').toBeLessThanOrEqual(1);
        await expectInside(page, '.day-add', 'the add field', 20);
        await expect(page.locator('.day-tasks > li').nth(3).getByLabel('New task', { exact: true })).toBeVisible();
      } finally { await clearDay(owner, date); await owner.dispose(); }
    });

    test('done rows are in the list after the open ones and +N more shows the open rows that did not fit, in the same place as the list; both stay in step with changes, and a row is edited where it is', async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = farDate(width === 375 ? 204 : 205);
      await busyDay(owner, date);
      try {
        await login(page); await openDay(page, date);
        await goTo(page, 'todo');
        // The first 13 open rows are on the tab, then the 2 done rows crossed out; the other list's 13 are behind "+13 more". No Done button.
        await expect(page.getByRole('checkbox', { name: `Complete ${OWNER_NAME} thing ${MAX}`, exact: true })).toBeVisible();
        await expect(page.getByRole('checkbox', { name: `Complete ${PARTNER_NAME} thing 1`, exact: true })).toHaveCount(0);
        const list = page.getByRole('list', { name: 'To do' });
        await expect(list.locator('.day-task')).toHaveCount(MAX + 2);
        await expect(list.locator('.day-task.day-done .day-task-title')).toHaveText(['Done one', 'Done two']);
        await expect(page.getByRole('button', { name: /^Done \(/ })).toHaveCount(0);
        await page.getByRole('button', { name: `+${MAX} more`, exact: true }).tap();
        const more = page.getByRole('list', { name: 'More to do' });
        await expect(more.locator('.day-task')).toHaveCount(MAX);
        await expect(more.getByRole('checkbox', { name: `Complete ${PARTNER_NAME} thing 1`, exact: true })).toBeVisible();
        await noWindow(page);
        await expectFits(page, 'to-do, more');
        // Completing one updates the list at once.
        await more.getByRole('checkbox', { name: `Complete ${PARTNER_NAME} thing 1`, exact: true }).tap();
        await expect(more.locator('.day-task')).toHaveCount(MAX - 1);
        await page.getByRole('button', { name: 'Back to to-do', exact: true }).tap();
        // The finished row joined the done rows after the 13 open ones, in the same list.
        await expect(list.locator('.day-task')).toHaveCount(MAX + 3);
        await expect(list.locator('.day-task:not(.day-done)')).toHaveCount(MAX);
        await expect(list.locator('.day-task.day-done .day-task-title')).toHaveText(['Done one', 'Done two', `${PARTNER_NAME} thing 1`]);
        await expect(page.getByRole('button', { name: `+${MAX - 1} more`, exact: true })).toBeVisible();
        // The owner has 13 open to-dos, so reopening a finished one is refused with the reason, and the list is unchanged.
        const done = list.locator('.day-task.day-done');
        await list.getByRole('checkbox', { name: 'Reopen Done one', exact: true }).tap();
        await expect(page.getByRole('alert')).toContainText(`${OWNER_NAME} already has ${MAX} things to do that day.`);
        await expect(done).toHaveCount(3);
        await expect(list.getByRole('checkbox', { name: 'Reopen Done one', exact: true })).toBeChecked();
        // Tapping a title edits that row where it is, among the done rows: no window, the row keeps its place and size, and the tab still fits.
        const row = done.nth(1);
        await row.scrollIntoViewIfNeeded();
        const before = (await row.boundingBox())!;
        await list.getByRole('button', { name: 'Edit Done two', exact: true }).tap();
        const edit = field(page, 'Edit task: Done two');
        await expect(edit).toBeFocused();
        await expect(edit).toHaveValue('Done two');
        await noWindow(page);
        const after = (await row.boundingBox())!;
        expect(Math.abs(after.y - before.y) + Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
        await expectFits(page, 'to-do while a done row is edited');
        await edit.press('Escape');
        await expect(edit).toHaveCount(0);
        await expect(list.getByRole('button', { name: 'Edit Done two', exact: true })).toBeFocused();
        await expectFits(page, 'to-do after the lists');
      } finally { await clearDay(owner, date); await owner.dispose(); }
    });

    test('a poll while the More list is shown updates its rows and leaves the focus on the row; Back returns to the list', async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER), date = farDate(width === 375 ? 206 : 207);
      await busyDay(owner, date);
      try {
        await page.clock.install();
        await login(page); await openDay(page, date);
        await goTo(page, 'todo');
        await page.getByRole('button', { name: `+${MAX} more`, exact: true }).tap();
        const more = page.getByRole('list', { name: 'More to do' });
        const row = more.getByRole('button', { name: `Edit ${PARTNER_NAME} thing 2`, exact: true });
        await row.focus();
        // The partner finishes one of her rows on another device, and this phone polls.
        const thing = (await partner.snapshot()).tasks.find((t: { title: string; date: string }) => t.title === `${PARTNER_NAME} thing 5` && t.date === date);
        expect((await partner.post({ action: 'complete', id: thing.id, revision: thing.revision, done: true })).status()).toBe(200);
        const answered = page.waitForResponse(response => response.url().includes('api.php?since='));
        await page.clock.runFor(13000);
        await answered;
        await expect(page.locator('#sync-status')).toHaveText('Up to date');
        // The list shows the change, is still the More list, and the focus is still on the row.
        await expect(more.locator('.day-task')).toHaveCount(MAX - 1);
        await expect(row).toBeFocused();
        await page.getByRole('button', { name: 'Back to to-do', exact: true }).tap();
        await expect(page.getByRole('button', { name: `+${MAX - 1} more`, exact: true })).toBeVisible();
        // The partner's finished row is one more done row of the list, after the open ones; there is still no Done button.
        await expect(page.getByRole('list', { name: 'To do' }).locator('.day-task.day-done')).toHaveCount(3);
        await expect(page.getByRole('button', { name: /^Done \(/ })).toHaveCount(0);
      } finally { await clearDay(owner, date); await owner.dispose(); await partner.dispose(); }
    });

    test('a to-do row being edited keeps the 13-row To-do tab on one screen, and the field, counter, day and Delete all fit inside the row', async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = farDate(width === 375 ? 212 : 213);
      for (let n = 1; n <= MAX; n++) { await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title: `Thing number ${n}` }); }
      try {
        await login(page); await openDay(page, date);
        await pickList(page, OWNER_NAME);
        await goTo(page, 'todo');
        const row = page.locator('.day-tasks .day-task').nth(6);
        const was = (await row.boundingBox())!;
        await page.getByRole('button', { name: 'Edit Thing number 7', exact: true }).tap();
        const edit = field(page, 'Edit task: Thing number 7');
        await expect(edit).toBeFocused();
        await expectFits(page, 'to-do, a row being edited');
        const box = (await row.boundingBox())!;
        expect(Math.abs(box.y - was.y) + Math.abs(box.height - was.height), 'the row does not move or change size').toBeLessThanOrEqual(1);
        // Everything of the row is inside it, side to side and top to bottom, and the field is wide enough to type in.
        const parts = await row.evaluate(el => { const r = el.getBoundingClientRect(); return [...el.querySelectorAll<HTMLElement>('.ip-input, .ip-count, .ip-date, .ip-del')].map(p => { const b = p.getBoundingClientRect(); return { name: p.className, left: b.left - r.left, right: r.right - b.right, top: b.top - r.top, bottom: r.bottom - b.bottom, width: b.width }; }); });
        expect(parts.map(p => p.name)).toEqual(expect.arrayContaining([expect.stringContaining('ip-input'), expect.stringContaining('ip-count'), expect.stringContaining('ip-date'), expect.stringContaining('ip-del')]));
        for (const part of parts) { expect(Math.min(part.left, part.right, part.top, part.bottom), `${part.name} is inside the row`).toBeGreaterThanOrEqual(-0.5); }
        expect(parts.find(p => p.name.includes('ip-input'))!.width, 'room to type').toBeGreaterThanOrEqual(width === 375 ? 90 : 60);
        await edit.fill('Thing seven, renamed');
        await edit.press('Enter');
        await expect(page.getByRole('button', { name: 'Edit Thing seven, renamed', exact: true })).toBeFocused();
        await expectFits(page, 'to-do, after the row was saved');
      } finally { await clearDay(owner, date); await owner.dispose(); }
    });

    test('an error message floats over the panel: the To-do tab keeps its height and still fits, with the bar on screen', async ({ page }) => {
      await login(page);
      await goTo(page, 'todo');
      const height = async () => (await page.locator('#period-panel').boundingBox())!.height;
      const before = await height();
      await expectFits(page, 'to-do before the message');
      const isApi = (url: URL) => url.pathname.endsWith('/api.php');
      await page.route(isApi, route => (route.request().method() === 'GET' ? route.continue() : route.abort('failed')));
      await page.getByLabel('New task', { exact: true }).fill('Cannot be saved');
      await page.getByRole('button', { name: 'Add', exact: true }).tap();
      const banner = page.getByRole('alert');
      await expect(banner).toContainText('may have saved');
      expect(await height()).toBe(before);
      await expectFits(page, 'to-do with the message');
      const [box, bar] = [(await banner.boundingBox())!, (await page.locator('.day-tabs').boundingBox())!];
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThan(bar.y);
      // It can be dismissed: Refresh reads again and takes it away.
      await page.unroute(isApi);
      await banner.getByRole('button', { name: 'Refresh', exact: true }).tap();
      await expect(banner).toBeHidden();
    });

    test('notes: one text area on screen, a lane switch, a counter, a draft kept across tabs, Save blocked over 400', async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = farDate(width === 375 ? 206 : 207);
      try {
        await login(page); await openDay(page, date);
        await goTo(page, 'notes');
        const switcher = page.getByRole('group', { name: 'Whose notes' });
        await expect(switcher.getByRole('button')).toHaveText([OWNER_NAME, PARTNER_NAME]);
        await expect(switcher.getByRole('button', { name: OWNER_NAME, exact: true })).toHaveAttribute('aria-pressed', 'true');
        await expect(page.getByRole('textbox')).toHaveCount(1);
        const mine = page.getByLabel(`Notes for ${OWNER_NAME}`, { exact: true });
        await mine.fill(`Pick up ${PARTNER_NAME} at 2p`);
        await expect(page.locator('.day-count')).toHaveText('17 / 400');
        await expect(page.locator('.day-note-status')).toHaveText('Unsaved');
        // Another lane, another tab, and back: the text is still a draft.
        await page.locator('.day-tab').first().tap();
        await goTo(page, 'notes');
        await switcher.getByRole('button', { name: PARTNER_NAME, exact: true }).tap();
        await expect(page.getByLabel(`Notes for ${PARTNER_NAME}`, { exact: true })).toHaveValue('');
        await switcher.getByRole('button', { name: OWNER_NAME, exact: true }).tap();
        await expect(mine).toHaveValue(`Pick up ${PARTNER_NAME} at 2p`);
        await expect(page.locator('.day-note-status')).toHaveText('Unsaved');
        await mine.fill('z'.repeat(401));
        await expect(page.locator('.day-count')).toHaveText('401 / 400');
        await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
        await mine.fill(`Pick up ${PARTNER_NAME} at 2p`);
        await page.getByRole('button', { name: 'Save', exact: true }).tap();
        await expect(page.locator('.day-note-status')).toHaveText('Saved');
        expect((await owner.snapshot()).notes.find((n: { key: string }) => n.key === `day:${date}:${OWNER}:notes`)).toMatchObject({ text: `Pick up ${PARTNER_NAME} at 2p` });
        await expectFits(page, 'notes');
      } finally { await clearDay(owner, date); await owner.dispose(); }
    });

    test('tapping an entry edits it in its block, with both handles and nothing hung over the schedule; dragging a handle and Enter are one write', async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = farDate(width === 375 ? 208 : 209);
      const morning = await add(owner, { action: 'add', kind: 'event', date, owners: [OWNER], text: 'Dentist', start: 540, length: 30 });
      await add(owner, { action: 'add', kind: 'event', date, owners: [PARTNER], text: 'Late call', start: 1080, length: 60 });
      const posts: Array<Record<string, unknown>> = [];
      page.on('request', request => { if (request.method() === 'POST' && request.url().includes('api.php')) { posts.push(request.postDataJSON()); } });
      try {
        await login(page); await openDay(page, date);
        const block = page.locator('.day-ev.day-editing');
        // A half-hour entry in the first part of the day is edited in its own block, with no strip beside it: the block holds only the time, the title and the handles.
        await showHalf(page, 'am');
        await page.getByRole('button', { name: `Dentist, 9a to 9:30a, ${OWNER_NAME}`, exact: true }).tap();
        await expect(field(page, 'Edit entry: Dentist')).toBeFocused();
        await noWindow(page);
        await bare(page, 'Dentist');
        await expect(block.locator('.day-ev-time')).toHaveText('9a');
        for (const edge of ['start', 'end']) {
          const handle = page.locator(`.day-handle[data-edge=${edge}]`);
          expect(await handle.evaluate(el => getComputedStyle(el).touchAction)).toBe('none');
          // A finger's grab area, taller than the pill drawn in it.
          expect((await handle.boundingBox())!.width).toBeGreaterThanOrEqual(44);
          expect((await handle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        }
        const grid = (await page.locator('.day-lanes').boundingBox())!, end = (await page.locator('.day-handle[data-edge=end]').boundingBox())!;
        const x = end.x + end.width / 2, y = end.y + end.height / 2;
        await page.mouse.move(x, y); await page.mouse.down();
        await page.mouse.move(x, y + (30 * grid.height) / Number(await page.locator('.day-lanes').getAttribute('data-span')), { steps: 6 }); // the grid is data-span minutes tall (840 on AM)
        await expect(page.locator('.day-bubble')).toHaveText('9a – 10a');
        await page.mouse.up();
        expect(posts).toHaveLength(0);
        await field(page, 'Edit entry: Dentist').press('Enter');
        await expect(block).toHaveCount(0);
        expect(posts).toEqual([{ action: 'edit', kind: 'event', id: morning, revision: 1, date, owners: [OWNER], text: 'Dentist', start: 540, length: 60 }]);
        // An evening entry is edited the same way: nothing hangs above it.
        await page.getByRole('button', { name: `Late call, 6p to 7p, ${PARTNER_NAME}`, exact: true }).tap();
        await expect(field(page, 'Edit entry: Late call')).toBeFocused();
        await bare(page, 'Late call');
        await page.keyboard.press('Escape');
        await expect(block).toHaveCount(0);
      } finally { await clearDay(owner, date); await owner.dispose(); }
    });

    test('whatever hour an entry is at, nothing hangs over the schedule when it is edited (only a handle is at the middle of a handle), and a new entry from a tap on an empty slot is edited the same way', async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = farDate(width === 375 ? 214 : 215);
      // AM holds the day from 7a to 9p and PM the night after it (9p to 7a, the last of it 6:30a), so each is looked at in turn: PM's entries first, AM's last (the new entry below is an AM one).
      const halves = [['pm', [1260, 1410, 1560, 1830]], ['am', [420, 540, 780, 810, 840, 870, 1080, 1230]]] as const;
      for (const start of halves.flatMap(([, list]) => list)) { await add(owner, { action: 'add', kind: 'event', date, owners: [OWNER], text: `At ${start}`, start, length: 30 }); }
      try {
        await login(page); await openDay(page, date);
        for (const [half, list] of halves) {
          await showHalf(page, half);
          for (const start of list) {
            await page.locator(`.day-ev[data-id]`, { has: page.locator('.day-ev-text', { hasText: `At ${start}` }) }).tap();
            await expect(field(page, `Edit entry: At ${start}`)).toBeFocused();
            await bare(page, `the entry at ${start}`);
            await page.keyboard.press('Escape');
            await expect(page.locator('.day-ev.day-editing')).toHaveCount(0);
          }
        }
        // An empty slot taps into a new entry in place: a field in a block, Enter with text saves, Escape or Enter with nothing drops it.
        await page.getByRole('button', { name: `Add to ${OWNER_NAME} at 10a`, exact: true }).tap({ position: { x: 10, y: 4 } });
        const fresh = field(page, 'New entry');
        await expect(fresh).toBeFocused();
        await noWindow(page);
        await bare(page, 'a new entry');
        await fresh.press('Enter');
        await expect(page.locator('.day-ev.day-editing')).toHaveCount(0);
        await page.getByRole('button', { name: `Add to ${OWNER_NAME} at 10a`, exact: true }).tap({ position: { x: 10, y: 4 } });
        await field(page, 'New entry').fill('Coffee');
        await field(page, 'New entry').press('Enter');
        await expect(page.getByRole('button', { name: new RegExp(String.raw`^Coffee, 10a to 10:30a, ${OWNER_NAME}$`) })).toBeVisible();
        expect((await owner.snapshot()).events.filter((e: { date: string; text: string }) => e.date === date && e.text === 'Coffee')).toHaveLength(1);
      } finally { await clearDay(owner, date); await owner.dispose(); }
    });
  });
}

test.describe(`Day panel, phone, ${PARTNER_NAME} signed in`, () => {
  test(`${PARTNER_NAME} is the left lane, her entries are yellow, and her notes switch comes first`, async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(210);
    await add(owner, { action: 'add', kind: 'event', date, owners: [PARTNER], text: 'Yoga', start: 540 });
    await add(owner, { action: 'add', kind: 'event', date, owners: [OWNER], text: 'Gym', start: 540 });
    await add(owner, { action: 'add', kind: 'priority', date, owners: [OWNER], slots: { [OWNER]: 1 }, text: `${OWNER_NAME} first` });
    await add(owner, { action: 'add', kind: 'priority', date, owners: [PARTNER], slots: { [PARTNER]: 1 }, text: `${PARTNER_NAME} first` });
    try {
      await login(page, PARTNER); await openDay(page, date);
      await showHalf(page, 'am');
      await expect(page.locator('.day-sched .day-lane')).toHaveText([`${PARTNER_NAME} · you`, OWNER_NAME]);
      const grid = (await page.locator('.day-lanes').boundingBox())!;
      expect((await page.getByRole('button', { name: /^Yoga, / }).boundingBox())!.x).toBeLessThan(grid.x + grid.width / 2);
      expect((await page.getByRole('button', { name: /^Gym, / }).boundingBox())!.x).toBeGreaterThan(grid.x + grid.width / 2 - 2);
      await expect(page.getByRole('button', { name: /^Yoga, / })).toHaveAttribute('data-c', 'yellow');
      await goTo(page, 'todo');
      await expect(page.locator('.day-prio .day-lane')).toHaveText([`${PARTNER_NAME} · you`, OWNER_NAME]);
      const [a, s] = [(await page.getByRole('button', { name: new RegExp(String.raw`^Priority 1: ${PARTNER_NAME} first`) }).boundingBox())!, (await page.getByRole('button', { name: new RegExp(String.raw`^Priority 1: ${OWNER_NAME} first`) }).boundingBox())!];
      expect(a.x).toBeLessThan(s.x);
      await goTo(page, 'notes');
      await expect(page.getByRole('group', { name: 'Whose notes' }).getByRole('button')).toHaveText([PARTNER_NAME, OWNER_NAME]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});

// The owner set 13 open to-dos per list on 2026-10-31. On the project's own phone (375x812) the whole To-do tab fits one screen:
// five priorities and 13 to-dos in the 13 slots, none of the rows under 30px, and nothing scrolls, the list included. On a
// smaller phone the rows shrink to that floor first, then the list (and nothing else on the tab) scrolls, which the sizes above pin.
test.describe('Day panel, phone 375x812: 13 to-dos', () => {
  test('five priorities and 13 open to-dos (every slot taken) are on one screen with nothing scrolling; the rows are at least 30px', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(211);
    for (let line = 1; line <= 5; line++) { await add(owner, { action: 'add', kind: 'priority', date, owners: [OWNER], slots: { [OWNER]: line }, text: `Priority ${line}` }); }
    for (let n = 1; n <= MAX; n++) { await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title: `Thing number ${n}` }); }
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      await goTo(page, 'todo');
      await expectFits(page, 'to-do, 13 rows');
      await expect(page.locator('.day-tasks .day-task')).toHaveCount(MAX);
      await expect(page.locator('.day-prow')).toHaveCount(5);
      const list = await page.locator('.day-todo > .day-tasks').evaluate(el => ({ over: el.scrollHeight - el.clientHeight, rows: [...el.querySelectorAll('.day-task')].map(row => row.getBoundingClientRect().height) }));
      expect(list.over, 'the list does not scroll').toBe(0);
      expect(Math.min(...list.rows)).toBeGreaterThanOrEqual(29.9);
      await expectInside(page, '.day-prow, .day-task, .day-add', 'to-do contents', 28);
      // The 13th is the last slot: no add field is left, and the list says why.
      await expect(page.getByLabel('New task', { exact: true })).toHaveCount(0);
      await expect(page.locator('.day-msg')).toHaveText(`${OWNER_NAME} already has ${MAX} things to do that day.`);
      await expectFits(page, 'to-do, 13 rows with the message');
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('13 ruled slots at any fill: a tap on a blank line starts a to-do there, and Enter in the add field of the first of them puts the to-do on that line', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(217);
    for (let n = 1; n <= 3; n++) { await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title: `Thing ${n}` }); }
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      await goTo(page, 'todo');
      await expectFits(page, 'to-do, three open');
      const list = await page.locator('.day-todo > .day-tasks').evaluate(el => ({ over: el.scrollHeight - el.clientHeight, rows: [...el.children].map(row => row.getBoundingClientRect().height) }));
      expect(list.rows).toHaveLength(MAX);
      expect(list.over, 'the list does not scroll').toBe(0);
      expect(Math.max(...list.rows) - Math.min(...list.rows), 'every slot is a line of the same height').toBeLessThanOrEqual(1);
      // The blank lines are decoration: hidden from a screen reader, each with a faint circle; the first holds the field.
      await expect(page.locator('.day-free[aria-hidden=true]')).toHaveCount(MAX - 4);
      await expect(page.locator('.day-free .day-ghost[aria-hidden=true]')).toHaveCount(MAX - 3);
      await expect(page.getByRole('checkbox')).toHaveCount(3);
      const field = page.getByLabel('New task', { exact: true });
      const [row, was] = [(await page.locator('.day-tasks > li').nth(3).boundingBox())!, (await field.boundingBox())!];
      expect(was.y).toBeGreaterThanOrEqual(row.y - 1);
      expect(was.y + was.height).toBeLessThanOrEqual(row.y + row.height + 1);
      // A tap on a lower blank line starts a to-do there, in place (todo-thirds-phone.spec.ts); the add field of the first blank line stays the way for Enter.
      await page.locator('.day-tasks > li').nth(9).tap();
      await expect(page.getByRole('textbox', { name: `New to-do for ${OWNER_NAME}`, exact: true })).toBeFocused();
      await leaveField(page);
      await expect(page.locator('.day-new')).toHaveCount(0);
      await field.fill('Fourth');
      await field.press('Enter');
      await expect(page.getByRole('button', { name: 'Edit Fourth', exact: true })).toBeVisible();
      // The to-do took the line the field was on, and the field moved one line down.
      const now = (await page.getByRole('button', { name: 'Edit Fourth', exact: true }).boundingBox())!;
      expect(Math.abs((now.y + now.height / 2) - (row.y + row.height / 2))).toBeLessThanOrEqual(3);
      await expect(page.locator('.day-tasks .day-task')).toHaveCount(4);
      await expect(page.locator('.day-tasks .day-free')).toHaveCount(MAX - 4);
      await expect(page.locator('.day-tasks > li').nth(4).getByLabel('New task', { exact: true })).toBeVisible();
      await expect(page.locator('.day-todo [data-kind=todos]')).toHaveText(`4 of ${MAX}`);
      await expectFits(page, 'to-do, four open');
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  const LONG = 'Call the dentist about the invoice 7'; // 36 characters, the most a day to-do may hold
  test('a carried to-do shows its "from" chip inside its row, next to a title that keeps room; the tab still fits and Done rows and the chip are tapped like any row', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), then = shiftDate(today(), -3, 'day'), ids: string[] = [];
    // Carried first (the long title is the worst case for the row), then today's own.
    ids.push(await add(owner, { action: 'add', kind: 'todo', scope: 'day', date: then, owners: [OWNER], title: LONG }));
    ids.push(await add(owner, { action: 'add', kind: 'todo', scope: 'day', date: today(), owners: [OWNER], title: 'Own thing' }));
    try {
      await login(page);
      await pickList(page, OWNER_NAME);
      await goTo(page, 'todo');
      const row = page.locator('.day-task', { has: page.locator('.day-from') }), chip = row.locator('.day-from');
      await expect(chip).toHaveText(`from ${dayLabel(then, { weekday: 'short' })} ${dayLabel(then, { month: 'short', day: 'numeric' })}`);
      const [r, c, t] = [(await row.boundingBox())!, (await chip.boundingBox())!, (await row.locator('.day-task-title').boundingBox())!];
      expect(c.x + c.width, 'the chip is inside the row').toBeLessThanOrEqual(r.x + r.width + 0.5);
      expect(c.x, 'the chip follows the title').toBeGreaterThanOrEqual(t.x + t.width - 0.5);
      expect(t.width, 'the title keeps room to read').toBeGreaterThanOrEqual(130);
      await expect(page.locator('.day-task .day-from')).toHaveCount(1);
      await expectFits(page, 'to-do, a carried row');
      // A tap on the chip edits the row where it is, like a tap on the title; the day field has the real day.
      await chip.tap();
      const edit = field(page, `Edit task: ${LONG}`);
      await expect(page.locator('.day-task.day-editing input[type=date]')).toHaveValue(then);
      await expect(edit).toBeFocused();
      await noWindow(page);
      await expectFits(page, 'to-do, a carried row being edited');
      await edit.press('Escape');
    } finally { for (const id of ids) { const task = (await owner.snapshot()).tasks.find((x: { id: string }) => x.id === id); if (task) { await owner.post({ action: 'delete', id, revision: task.revision, confirm: true }); } } await owner.dispose(); }
  });

  test('an empty priority cell and a stored one are edited in the cell: it takes the whole line of the two lanes, a tap elsewhere saves, Move down and Delete are in it, and the tab still fits', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(216);
    await add(owner, { action: 'add', kind: 'priority', date, owners: [OWNER], slots: { [OWNER]: 1 }, text: 'First thing' });
    try {
      await login(page); await openDay(page, date);
      await goTo(page, 'todo');
      const cell = page.locator('.day-cell.day-editing'), line = page.locator('.day-prow').nth(1);
      // The partner's blank cell on line 2: a field takes the line (both lanes wide), at the line's own height.
      await page.getByRole('button', { name: `Add priority 2 for ${PARTNER_NAME}`, exact: true }).tap();
      const fresh = field(page, `New priority 2 for ${PARTNER_NAME}`);
      await expect(fresh).toBeFocused();
      await noWindow(page);
      const [c, l] = [(await cell.boundingBox())!, (await line.boundingBox())!];
      expect(c.width, 'the cell takes the whole line of both lanes').toBeGreaterThan(l.width * 0.8);
      expect(Math.abs(c.y + c.height / 2 - (l.y + l.height / 2))).toBeLessThanOrEqual(2);
      await expectFits(page, 'to-do, a new priority being typed');
      await fresh.fill('Plan the trip');
      // A tap on the page behind it saves, as Enter does.
      await page.locator('.day-label', { hasText: 'To-do' }).tap();
      await expect(cell).toHaveCount(0);
      await expect(page.getByRole('button', { name: `Priority 2: Plan the trip, ${PARTNER_NAME}`, exact: true })).toBeVisible();
      expect((await owner.snapshot()).priorities.find((p: { text: string }) => p.text === 'Plan the trip')).toMatchObject({ owners: [PARTNER], slots: { [PARTNER]: 2 } });
      // A stored one: Move down and Delete are in the cell.
      await page.getByRole('button', { name: `Priority 1: First thing, ${OWNER_NAME}`, exact: true }).tap();
      await expect(field(page, 'Edit priority 1: First thing')).toBeFocused();
      for (const control of [cell.getByRole('button', { name: 'Move down', exact: true }), cell.getByRole('button', { name: 'Delete priority: First thing', exact: true })]) {
        const box = (await control.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(24);
      }
      await cell.getByRole('button', { name: 'Move down', exact: true }).tap();
      await expect(field(page, 'Edit priority 2: First thing')).toBeFocused();
      await expectFits(page, 'to-do, a priority being edited');
      await cell.getByRole('button', { name: 'Delete priority: First thing', exact: true }).tap();
      await cell.getByRole('button', { name: 'Confirm delete', exact: true }).tap();
      await expect(page.getByRole('button', { name: /First thing/ })).toHaveCount(0);
      expect((await owner.snapshot()).priorities.some((p: { text: string }) => p.text === 'First thing')).toBe(false);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});

// The To-do tab holds five priority lines and the 13 slots: on a short phone the list scrolls inside itself, but the lines keep their
// own height, so the heading and the counter of the list are never printed over the fifth line.
for (const [width, height] of [[375, 812], [375, 667], [360, 640], [320, 568]] as const) {
  test.describe(`Day panel, phone ${width}x${height}: the To-do tab`, () => {
    test.use({ viewport: { width, height } });

    test('the fifth priority line is clear of the To-do heading, with few to-dos and with a full list', async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = farDate(240 + width % 7 + height % 5), more = farDate(250 + width % 7 + height % 5);
      for (const day of [date, more]) { for (let line = 1; line <= 5; line++) { await add(owner, { action: 'add', kind: 'priority', date: day, owners: [OWNER], slots: { [OWNER]: line }, text: `Priority ${line}` }); } }
      for (let n = 1; n <= 4; n++) { await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title: `Thing ${n}` }); }
      for (let n = 1; n <= MAX; n++) { await add(owner, { action: 'add', kind: 'todo', scope: 'day', date: more, owners: [OWNER], title: `Full ${n}` }); }
      for (const title of ['Done one', 'Done two']) {
        const id = await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title });
        expect((await owner.post({ action: 'complete', id, revision: 1, done: true })).status()).toBe(200);
      }
      try {
        await login(page);
        await pickList(page, OWNER_NAME);
        for (const day of [date, more]) {
          await openDay(page, day);
          await goTo(page, 'todo');
          const gap = await page.evaluate(() => {
            const rows = [...document.querySelectorAll('.day-prow')], head = document.querySelector('.day-todohead')!;
            return Math.round(head.getBoundingClientRect().top - rows[rows.length - 1].getBoundingClientRect().bottom);
          });
          expect(gap, `${width}x${height} ${day === date ? 'four open' : 'a full list'}: the heading starts below the fifth line`).toBeGreaterThanOrEqual(0);
          await expectFits(page, `to-do tab, ${day === date ? 'four open' : 'full'}`);
        }
      } finally { await clearDay(owner, date); await clearDay(owner, more); await owner.dispose(); }
    });
  });
}

test.describe('Day panel, phone: an entry being edited, tall or short', () => {
  test('a block of two hours and one of half an hour hold only the time, the title and the handles, the title level with the time; the length is not typed', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(262);
    await add(owner, { action: 'add', kind: 'event', date, owners: [OWNER], text: 'Long one', start: 540, length: 120 });
    await add(owner, { action: 'add', kind: 'event', date, owners: [OWNER], text: 'Short one', start: 840, length: 30 });
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      await showHalf(page, 'am');
      await page.getByRole('button', { name: `Long one, 9a to 11a, ${OWNER_NAME}`, exact: true }).tap();
      await expect(field(page, 'Edit entry: Long one')).toBeFocused();
      await bare(page, 'Long one');
      // The block holds the time label, the title field and the two handles, and nothing else; the title is level with the time.
      const parts = () => page.evaluate(() => {
        const block = document.querySelector('.day-ev.day-editing')!, input = block.querySelector('.ip-input')!.getBoundingClientRect(), time = block.querySelector('.day-ev-time')!.getBoundingClientRect();
        return { kids: [...block.children].map(el => el.className.split(' ')[0]).sort(), sameLine: Math.abs((input.top + input.bottom) / 2 - (time.top + time.bottom) / 2) <= 3 };
      });
      expect(await parts()).toEqual({ kids: ['day-ev-time', 'day-handle', 'day-handle', 'ip-input'], sameLine: true });
      // The length is not typed: Alt+Shift+Up twice takes half an hour off the end, as dragging the bottom handle would.
      await field(page, 'Edit entry: Long one').press('Alt+Shift+ArrowUp'); await field(page, 'Edit entry: Long one').press('Alt+Shift+ArrowUp');
      await expect.poll(() => draftSpan(page)).toEqual({ start: 540, length: 90 });
      await field(page, 'Edit entry: Long one').press('Enter');
      await expect(page.getByRole('button', { name: `Long one, 9a to 10:30a, ${OWNER_NAME}`, exact: true })).toBeVisible();
      // A 30-minute block has no room for anything more, and gets nothing more: the same time, title and handles.
      await page.getByRole('button', { name: `Short one, 2p to 2:30p, ${OWNER_NAME}`, exact: true }).tap();
      await expect(field(page, 'Edit entry: Short one')).toBeFocused();
      await bare(page, 'Short one');
      expect((await parts()).kids).toEqual(['day-ev-time', 'day-handle', 'day-handle', 'ip-input']);
      await noWindow(page);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});

test.describe('Day panel, phone: the controls that join a row while it is edited', () => {
  test('Delete, Move up, Move down and the day field of a row being edited are wider than their icons for a finger, and as tall as the row allows', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(263);
    await add(owner, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title: 'Thing one' });
    await add(owner, { action: 'add', kind: 'priority', date, owners: [OWNER], slots: { [OWNER]: 2 }, text: 'Second line' });
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      await goTo(page, 'todo');
      await page.getByRole('button', { name: 'Edit Thing one', exact: true }).tap();
      await expect(field(page, 'Edit task: Thing one')).toBeFocused();
      for (const size of await hitSizes(page, '.day-task.day-editing .ip-del, .day-task.day-editing .ip-date')) {
        expect(size.width, `${size.name} is as wide as a finger needs`).toBeGreaterThanOrEqual(40);
        expect(size.height, `${size.name} is as tall as its row allows`).toBeGreaterThanOrEqual(30);
      }
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: `Priority 2: Second line, ${OWNER_NAME}`, exact: true }).tap();
      await expect(field(page, 'Edit priority 2: Second line')).toBeFocused();
      for (const size of await hitSizes(page, '.day-cell.day-editing .ip-del, .day-cell.day-editing .day-move')) {
        expect(size.width, `${size.name} is wider than its icon`).toBeGreaterThanOrEqual(26);
        expect(size.height, `${size.name} is as tall as its row allows`).toBeGreaterThanOrEqual(30);
      }
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});

