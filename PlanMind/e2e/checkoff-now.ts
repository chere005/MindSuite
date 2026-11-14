import { expect, test, type Locator, type Page } from '@playwright/test';
import { periodStart } from '../packages/core/src/planner';
import { apiLogin, farDate, login, resetChores, resetPrefs, showTodos, todo, unique, type Api } from './helpers';
import { OWNER } from './people';

// #230: a check-off crosses the row out and moves it where done rows go in the frame of the tap, not when the last save returns. Every write is held at the
// network until the test lets it go (an endless reply latency), so what shows before the first reply is what the person sees on a slow connection.
// Shared by checkoff-now.spec.ts (desktop project) and checkoff-now-phone.spec.ts (phone project).
let day = 3300 + Math.floor(Math.random() * 18000);

type Held = { release(): void; releaseNext(): void; replies(): number; posts(): string[]; refuse(code: number, body: object, upTo?: number): void };
/** Holds every POST to the API until `release()` (all, now and later) or `releaseNext()` (the oldest still held); `refuse` answers the held ones with that status and body instead of sending them (only the first `upTo` posts when given). */
async function hold(page: Page): Promise<Held> {
  let refusal: { code: number; body: object; upTo?: number } | null = null, replies = 0, all = false;
  const gates: Array<() => void> = [];
  const posts: string[] = [];
  await page.route('**/api.php', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const nth = posts.push(JSON.parse(route.request().postData() ?? '{}').action);
    if (!all) { await new Promise<void>(resolve => { gates.push(resolve); }); }
    if (refusal && (refusal.upTo === undefined || nth <= refusal.upTo)) { await route.fulfill({ status: refusal.code, contentType: 'application/json', body: JSON.stringify(refusal.body) }); } else { await route.continue(); }
    replies++;
  });
  return {
    release: () => { all = true; gates.splice(0).forEach(open => open()); },
    releaseNext: () => { gates.shift()?.(); },
    replies: () => replies, posts: () => posts, refuse: (code, body, upTo) => { refusal = { code, body, upTo }; },
  };
}

const THU = '2027-03-11';   // the 2nd Thursday of a Week A: Dishes is the first of the day's own chores (chores.spec.ts)

export function defineCheckoffNow(phone: boolean) {
  const press = (target: Locator) => (phone ? target.tap() : target.click());
  const sized = phone ? 'phone' : 'desktop';
  test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });

  async function seed(baseURL: string, scope: 'day' | 'week', n: number, doneRows = 0) {
    const api = await apiLogin(baseURL, OWNER);
    const date = scope === 'day' ? farDate(day++) : periodStart(farDate(day += 7), 'week');
    const tag = unique('Co').replace(/ /g, '-');
    const titles = Array.from({ length: n }, (_, i) => `${tag}-${'ABCDEFGHIJKLMNOPQRST'[i]}`);
    // Rows already done (made first: the day holds 13 open ones), not among the titles: they make a long list that scrolls inside itself.
    for (let i = 0; i < doneRows; i++) {
      const body = todo({ scope, date, title: `${tag}-done${i}` });
      expect((await api.post(body)).status()).toBe(200);
      expect((await api.post({ action: 'complete', id: body.id, revision: 1, done: true })).status()).toBe(200);
    }
    for (const title of titles) { expect((await api.post(todo({ scope, date, title }))).status()).toBe(200); }
    return { api, date, titles };
  }
  async function openDay(page: Page, date: string) {
    await page.locator(phone ? '#pill-date' : '#jump-date').fill(date);
    await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', date);
    await showTodos(page);
  }
  async function openWeek(page: Page, date: string) {
    if (phone) {
      await page.getByRole('button', { name: 'Open menu', exact: true }).click();
      await page.getByRole('button', { name: 'Week', exact: true }).click();
      await page.keyboard.press('Escape');
      await page.locator('#pill-date').fill(date);
      await page.getByRole('tab', { name: 'To-do', exact: true }).tap();
    } else {
      await page.getByRole('button', { name: 'Week', exact: true }).click();
      await page.locator('#jump-date').fill(date);
    }
    await expect(page.locator('.wm-panel[data-panel="week"]')).toBeVisible();
  }
  /** The to-do rows of the list as drawn, top to bottom: [title, whether it is drawn crossed out]. */
  const rows = (page: Page, scope: 'day' | 'week', titles: string[]) => page.locator(scope === 'day' ? '.day-tasks > li[data-row=todo]' : 'ul.wm-todos > li.wm-todo[data-id]').evaluateAll((lis, titles) => lis.map(li => {
    const title = titles.find(t => li.textContent?.includes(t)) ?? '?';
    return [title, li.classList.contains('day-done') || li.classList.contains('done')] as [string, boolean];
  }).filter(([t]) => titles.includes(t)), titles);
  const circle = (page: Page, scope: 'day' | 'week', title: string) => page.locator(scope === 'day' ? `input.day-circle[aria-label$=" ${title}"]` : `input.wm-check[aria-label$=" ${title}"]`);
  const state = async (api: Api, titles: string[]) => (await api.snapshot()).tasks.filter((t: { title: string }) => titles.includes(t.title)).sort((a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title)).map((t: { title: string; done: boolean }) => [t.title, t.done]);

  for (const scope of ['day', 'week'] as const) {
    test(`${sized} ${scope}: a check-off is crossed out and sent to the done rows before any reply, an untick comes back, taps land on the row tapped`, async ({ page, baseURL }) => {
      const { api, date, titles } = await seed(baseURL!, scope, 5);
      const [a, b, c, d, e] = titles as [string, string, string, string, string];
      await login(page); const held = await hold(page);
      await (scope === 'day' ? openDay(page, date) : openWeek(page, date));
      await expect(circle(page, scope, a)).toBeVisible();
      expect(await rows(page, scope, titles)).toEqual([[a, false], [b, false], [c, false], [d, false], [e, false]]);
      // The first tap: A is crossed out in the done rows, below every open row, while the write is still on its way.
      await press(circle(page, scope, a));
      await expect.poll(() => rows(page, scope, titles), { timeout: 1500 }).toEqual([[b, false], [c, false], [d, false], [e, false], [a, true]]);
      expect(held.replies(), 'no reply has come').toBe(0);
      // The rows moved up: the next tap is on what is drawn at that place now, which is B (by its id, not by where A was).
      await press(circle(page, scope, b));
      await expect.poll(() => rows(page, scope, titles), { timeout: 1500 }).toEqual([[c, false], [d, false], [e, false], [a, true], [b, true]]);
      // A tap on the crossed-out A reopens it: back among the open rows, above the done ones.
      await press(circle(page, scope, a));
      await expect.poll(() => rows(page, scope, titles), { timeout: 1500 }).toEqual([[a, false], [c, false], [d, false], [e, false], [b, true]]);
      expect(held.replies(), 'still no reply').toBe(0);
      held.release();
      await expect.poll(async () => state(api, titles), { timeout: 8000 }).toEqual([[a, false], [b, true], [c, false], [d, false], [e, false]]);
      await expect.poll(() => rows(page, scope, titles)).toEqual([[a, false], [c, false], [d, false], [e, false], [b, true]]);
      await expect(page.locator('#error')).toBeHidden();
      await api.dispose();
    });
  }

  test(`${sized} day: a refused check-off is taken back alone, with its reason on the banner`, async ({ page, baseURL }) => {
    const { api, date, titles } = await seed(baseURL!, 'day', 3);
    const [a, b, c] = titles as [string, string, string];
    await login(page); const held = await hold(page);
    await openDay(page, date);
    await press(circle(page, 'day', a));
    await press(circle(page, 'day', b));
    await expect.poll(() => rows(page, 'day', titles), { timeout: 1500 }).toEqual([[c, false], [a, true], [b, true]]);
    // The server refuses the first write only: it is taken off again, alone (the second stays), and the reason is on the banner.
    held.refuse(400, { error: 'Refused for the test.', code: 'invalid' }, 1);
    held.release();
    await expect(page.locator('#error-message')).toHaveText('Refused for the test.');
    await expect.poll(() => rows(page, 'day', titles)).toEqual([[a, false], [c, false], [b, true]]);
    await expect.poll(async () => state(api, titles), { timeout: 8000 }).toEqual([[a, false], [b, true], [c, false]]);
    await api.dispose();
  });

  test(`${sized} day: nothing is redrawn under a pressed pointer or a focused text field`, async ({ page, baseURL }) => {
    const { api, date, titles } = await seed(baseURL!, 'day', 4);
    const [a, b, c, d] = titles as [string, string, string, string];
    await login(page); const held = await hold(page);
    await openDay(page, date);
    await expect(circle(page, 'day', a)).toBeVisible();
    // A text field with words in it keeps the focus and the same element while a check-off happens on the page.
    const add = page.getByLabel('New task', { exact: true });
    await add.fill('half typed');
    await add.evaluate(el => { (el as HTMLElement & { mark?: number }).mark = 1; });
    await circle(page, 'day', a).evaluate(el => (el as HTMLInputElement).click());
    await page.waitForTimeout(150);
    await expect(add).toBeFocused();
    expect(await add.evaluate(el => (el as HTMLElement & { mark?: number }).mark)).toBe(1);
    expect(await rows(page, 'day', titles)).toEqual([[a, false], [b, false], [c, false], [d, false]]);
    await add.evaluate(el => (el as HTMLElement).blur());
    // Blurring is a quiet moment: A is crossed out now.
    await expect.poll(() => rows(page, 'day', titles), { timeout: 1500 }).toEqual([[b, false], [c, false], [d, false], [a, true]]);
    // A pressed pointer: the row under it is the same element until it is let go (the reply comes while it is down).
    const target = circle(page, 'day', c);
    const at = (await target.boundingBox())!;
    await page.evaluate(() => { document.querySelectorAll('.day-tasks > li').forEach((li, i) => { (li as HTMLElement & { mark?: number }).mark = i + 1; }); });
    const cdp = await page.context().newCDPSession(page), [x, y] = [at.x + at.width / 2, at.y + at.height / 2];
    if (phone) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    } else { await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2); await page.mouse.down(); }
    held.release();
    await expect.poll(() => held.replies()).toBe(1);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => [...document.querySelectorAll('.day-tasks > li')].every((li, i) => (li as HTMLElement & { mark?: number }).mark === i + 1)), 'the list was not drawn again under the pointer').toBe(true);
    // Let go away from the circle (a scroll, a mouse released elsewhere), so the press is not a tap on C.
    if (phone) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 70, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else { await page.mouse.move(x + 300, y); await page.mouse.up(); }
    // Let go, the list is drawn again: the first check-off is crossed out among the done rows.
    await expect.poll(() => rows(page, 'day', titles)).toEqual([[b, false], [c, false], [d, false], [a, true]]);
    await expect.poll(async () => state(api, titles), { timeout: 8000 }).toEqual([[a, true], [b, false], [c, false], [d, false]]);
    await api.dispose();
  });

  test(`${sized} day: a key held on a circle while a reply lands still acts on that circle`, async ({ page, baseURL }) => {
    const { api, date, titles } = await seed(baseURL!, 'day', 4);
    const [a, b, c, d] = titles as [string, string, string, string];
    await login(page); const held = await hold(page);
    await openDay(page, date);
    await press(circle(page, 'day', a));
    await press(circle(page, 'day', c));
    await expect.poll(() => rows(page, 'day', titles), { timeout: 1500 }).toEqual([[b, false], [d, false], [a, true], [c, true]]);
    // Space goes down on B; the first reply comes while it is down (the second write is still on its way): the circle is not replaced, so the release ticks B.
    await circle(page, 'day', b).focus();
    await circle(page, 'day', b).evaluate(el => { (el as HTMLElement & { heldKey?: boolean }).heldKey = true; });
    await page.keyboard.down('Space');
    await page.keyboard.down('Shift');
    held.releaseNext();
    await expect.poll(() => held.replies()).toBe(1);
    await page.waitForTimeout(200);
    await page.keyboard.up('Shift');
    await page.waitForTimeout(100);
    expect(await circle(page, 'day', b).evaluate(el => (el as HTMLElement & { heldKey?: boolean }).heldKey), 'releasing another key does not release Space').toBe(true);
    await page.keyboard.up('Space');
    await expect.poll(() => rows(page, 'day', titles), { timeout: 1500 }).toEqual([[d, false], [a, true], [b, true], [c, true]]);
    held.release();
    await expect.poll(async () => state(api, titles), { timeout: 8000 }).toEqual([[a, true], [b, true], [c, true], [d, false]]);
    await api.dispose();
  });

  if (!phone) {
    test('desktop day: a pen release keeps the pressed row until its delayed click', async ({ page, baseURL }) => {
      const { api, date, titles } = await seed(baseURL!, 'day', 5);
      const [a, b, c, d, e] = titles as [string, string, string, string, string];
      await login(page); const held = await hold(page);
      try {
        await openDay(page, date);
        await press(circle(page, 'day', a));
        await press(circle(page, 'day', b));
        await expect.poll(() => rows(page, 'day', titles)).toEqual([[c, false], [d, false], [e, false], [a, true], [b, true]]);
        const target = circle(page, 'day', d);
        const at = (await target.boundingBox())!;
        const point = { x: at.x + at.width / 2, y: at.y + at.height / 2 };
        await target.evaluate((el, p) => {
          (el as HTMLElement & { penHeld?: boolean }).penHeld = true;
          el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'pen', clientX: p.x, clientY: p.y }));
        }, point);
        held.refuse(400, { error: 'Refused for the test.', code: 'invalid' }, 2);
        held.release();
        await expect.poll(() => held.replies()).toBe(2);
        await target.evaluate((el, p) => el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'pen', clientX: p.x, clientY: p.y })), point);
        // A browser may dispatch the pen's compatibility click in a later task, as it does for touch.
        await page.waitForTimeout(100);
        expect(await target.evaluate(el => (el as HTMLElement & { penHeld?: boolean }).penHeld), 'the row stays under the pen until the click').toBe(true);
        await page.evaluate(p => (document.elementFromPoint(p.x, p.y) as HTMLInputElement).click(), point);
        await expect.poll(() => rows(page, 'day', titles)).toEqual([[a, false], [b, false], [c, false], [e, false], [d, true]]);
        await expect.poll(async () => state(api, titles)).toEqual([[a, false], [b, false], [c, false], [d, true], [e, false]]);
      } finally { held.release(); await api.dispose(); }
    });
  }

  if (phone) {
    test(`${sized} day: a finger scrolling the list is not drawn under`, async ({ page, baseURL }) => {
      const { api, date, titles } = await seed(baseURL!, 'day', 13, 7);
      const [a, b] = titles as [string, string];
      await login(page); const held = await hold(page);
      await openDay(page, date);
      await expect(circle(page, 'day', a)).toBeVisible();
      await press(circle(page, 'day', a));
      await press(circle(page, 'day', b));
      await expect.poll(() => rows(page, 'day', titles).then(r => r.slice(-2)), { timeout: 1500 }).toEqual([[a, true], [b, true]]);
      const cdp = await page.context().newCDPSession(page);
      const list = page.locator('.day-tasks');
      const box = (await list.boundingBox())!, [x, y] = [box.x + box.width / 2, box.y + box.height - 30];
      // A finger drags the list: the browser takes it for a scroll and cancels the pointer; a reply comes meanwhile and the list is the same elements.
      await page.evaluate(() => { document.querySelectorAll('.day-tasks > li').forEach((li, i) => { (li as HTMLElement & { mark?: number }).mark = i + 1; }); });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - i * 12, id: 1 }] }); }
      held.releaseNext();
      await expect.poll(() => held.replies()).toBe(1);
      for (let i = 9; i <= 14; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - i * 12, id: 1 }] }); }
      await page.waitForTimeout(150);
      expect(await page.evaluate(() => [...document.querySelectorAll('.day-tasks > li')].every((li, i) => (li as HTMLElement & { mark?: number }).mark === i + 1)), 'the list was drawn again under the scrolling finger').toBe(true);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      held.release();
      await expect.poll(async () => state(api, titles).then((r: Array<[string, boolean]>) => r.filter(([, done]) => done).map(([t]) => t)), { timeout: 8000 }).toEqual([a, b]);
      await api.dispose();
    });

    test(`${sized} day: a tap whose press began before a refusal acts on the row pressed`, async ({ page, baseURL }) => {
      const { api, date, titles } = await seed(baseURL!, 'day', 5);
      const [a, b, c, d, e] = titles as [string, string, string, string, string];
      await login(page); const held = await hold(page);
      await openDay(page, date);
      await press(circle(page, 'day', a));
      await press(circle(page, 'day', b));
      await expect.poll(() => rows(page, 'day', titles), { timeout: 1500 }).toEqual([[c, false], [d, false], [e, false], [a, true], [b, true]]);
      const at = (await circle(page, 'day', d).boundingBox())!, [x, y] = [at.x + at.width / 2, at.y + at.height / 2];
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      // Both ticks are refused while the finger is down: A and B are taken off, which moves every row, but not under the finger.
      held.refuse(400, { error: 'Refused for the test.', code: 'invalid' }, 2);
      held.release();
      await expect.poll(() => held.replies()).toBe(2);
      await page.waitForTimeout(150);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      // The click belongs to D, the row pressed (by id), then the list is drawn again.
      await expect.poll(() => rows(page, 'day', titles), { timeout: 3000 }).toEqual([[a, false], [b, false], [c, false], [e, false], [d, true]]);
      await expect.poll(async () => state(api, titles), { timeout: 8000 }).toEqual([[a, false], [b, false], [c, false], [d, true], [e, false]]);
      await api.dispose();
    });
  }

  test(`${sized} chores: a ticked chore is crossed out among the done rows before any reply, an untick comes back`, async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    await resetChores(owner, '2027-03');
    try {
      await page.clock.install({ time: new Date(`${THU}T12:00:00-06:00`) });
      await login(page); const held = await hold(page);
      await page.locator(phone ? '#pill-date' : '#jump-date').fill(THU);
      await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', THU);
      if (phone) { await page.getByRole('tab', { name: 'Chores', exact: true }).tap(); }
      else { await page.getByRole('button', { name: /^Lists: / }).click(); await page.getByRole('group', { name: 'Lists', exact: true }).getByRole('switch', { name: 'Chores', exact: true }).click(); }
      const list = (what: 'kind' | 'state') => page.locator('.ch-row').evaluateAll((lis, what) => lis.map(li => [li.querySelector('.ch-title')?.textContent ?? '', (li as HTMLElement).dataset[what]]), what);
      const dishes = page.locator('input.ch-circle[aria-label$=" Dishes"]');
      await expect(dishes).toBeVisible();
      const first = (await list('kind'))[0]!;
      expect(first).toEqual(['Dishes', 'open']);
      await press(dishes);
      await expect.poll(async () => { const rows = await list('kind'); return rows[rows.length - 1]; }, { timeout: 1500 }).toEqual(['Dishes', 'done']);
      expect(held.replies(), 'no reply has come').toBe(0);
      await press(page.locator('input.ch-circle[aria-label$=" Dishes"]'));
      await expect.poll(async () => (await list('kind'))[0], { timeout: 1500 }).toEqual(['Dishes', 'open']);
      held.release();
      await expect.poll(() => held.posts().length > 0 && held.replies() === held.posts().length, { timeout: 8000 }).toBe(true);
      await expect.poll(async () => (await owner.snapshot()).choreMarks.filter((m: { date: string; state: string }) => m.date === THU && m.state === 'done').length, { timeout: 8000 }).toBe(0);
      await expect(page.locator('#error')).toBeHidden();
    } finally { await resetChores(owner, '2027-03'); await owner.dispose(); }
  });
}
