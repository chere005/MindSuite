import { expect, test, type Locator, type Page } from '@playwright/test';
import { periodStart } from '../packages/core/src/planner';
import { apiLogin, farDate, login, resetPrefs, showTodos, todo, unique, type Api } from './helpers';
import { OWNER } from './people';

// #230: a check-off crosses the row out and moves it where done rows go in the frame of the tap, not when the last save returns. Every write is held at the
// network until the test lets it go (an endless reply latency), so what shows before the first reply is what the person sees on a slow connection.
// Shared by checkoff-now.spec.ts (desktop project) and checkoff-now-phone.spec.ts (phone project).
let day = 3300 + Math.floor(Math.random() * 20000);

type Held = { release(): void; replies(): number; posts(): string[]; refuse(code: number, body: object): void };
/** Holds every POST to the API until `release()`; `refuse` answers the held ones with that status and body instead of sending them. */
async function hold(page: Page): Promise<Held> {
  let open!: () => void, refusal: { code: number; body: object } | null = null, replies = 0;
  const gate = new Promise<void>(resolve => { open = resolve; });
  const posts: string[] = [];
  await page.route('**/api.php', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    posts.push(JSON.parse(route.request().postData() ?? '{}').action);
    await gate;
    if (refusal) { await route.fulfill({ status: refusal.code, contentType: 'application/json', body: JSON.stringify(refusal.body) }); } else { await route.continue(); }
    replies++;
  });
  return { release: () => open(), replies: () => replies, posts: () => posts, refuse: (code, body) => { refusal = { code, body }; } };
}

export function defineCheckoffNow(phone: boolean) {
  const press = (target: Locator) => (phone ? target.tap() : target.click());
  const sized = phone ? 'phone' : 'desktop';
  test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });

  async function seed(baseURL: string, scope: 'day' | 'week', n: number) {
    const api = await apiLogin(baseURL, OWNER);
    const date = scope === 'day' ? farDate(day++) : periodStart(farDate(day += 7), 'week');
    const tag = unique('Co').replace(/ /g, '-');
    const titles = Array.from({ length: n }, (_, i) => `${tag}-${'ABCDEFGH'[i]}`);
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
    // The server refuses the first write: it is taken off again, alone (the second was not built on it), and the reason is on the banner.
    held.refuse(400, { error: 'Refused for the test.', code: 'invalid' });
    held.release();
    await expect(page.locator('#error-message')).toHaveText('Refused for the test.');
    await expect.poll(() => rows(page, 'day', titles)).toEqual([[a, false], [b, false], [c, false]]);
    expect(await state(api, titles)).toEqual([[a, false], [b, false], [c, false]]);
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
    if (phone) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x + at.width / 2, y: at.y + at.height / 2, id: 1 }] });
    } else { await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2); await page.mouse.down(); }
    held.release();
    await expect.poll(() => held.replies()).toBe(1);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => [...document.querySelectorAll('.day-tasks > li')].every((li, i) => (li as HTMLElement & { mark?: number }).mark === i + 1)), 'the list was not drawn again under the pointer').toBe(true);
    if (phone) { await (await page.context().newCDPSession(page)).send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); } else { await page.mouse.up(); }
    await expect.poll(async () => state(api, titles), { timeout: 8000 }).toEqual([[a, true], [b, false], [c, false], [d, false]]);
    await api.dispose();
  });
}
