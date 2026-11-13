import { test, expect, type Route } from '@playwright/test';
import { CAPS, COLOR_HUES, COLOR_KEYS, periodStart, tint } from '../packages/core/src/planner';
import { monthShort, weekRange } from '../app/dates';
import { THEMES, type ThemeName } from '../app/theme';
import { API, addTodo, apiLogin, browserStorage, farDate, isPhone, leaveField, login, removeTodos, showTodos, todo, today, unique, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// API and shell. Both projects (desktop and phone) run this file against one disposable server, so every test
// makes its own to-dos under unique names or far-away dates and removes them again.
const POLL = 13000;
const edit = (title: string) => ({ name: `Edit ${title}`, exact: true });
const day = (iso: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
const shiftDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const isGet = (route: Route) => route.request().method() === 'GET';
const isApi = (url: URL) => url.pathname.endsWith('/api.php');
async function removeTitled(api: Api, ...titles: string[]) {
  const { tasks } = await api.snapshot();
  await removeTodos(api, tasks.filter((t: { title: string }) => titles.includes(t.title)).map((t: { id: string }) => t.id));
}

test.describe('the page cannot be zoomed', () => {
  test('the viewport forbids scaling, and no element opts back in to a pinch', async ({ page }) => {
    await login(page);
    expect(await page.locator('meta[name=viewport]').getAttribute('content')).toContain('user-scalable=no');
    expect(await page.locator('meta[name=viewport]').getAttribute('content')).toContain('maximum-scale=1');
    // Only pans are allowed from the root down: a pinch or a double tap has nothing to start from. Nothing in the app lists pinch-zoom again.
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).touchAction)).toBe('pan-x pan-y');
    const optsIn = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('body *')].filter(el => /pinch-zoom/.test(getComputedStyle(el).touchAction)).length);
    expect(optsIn).toBe(0);
  });
});

test.describe('private API', () => {
  test('the page may be framed by the site itself (the MindSuite tabs) and by no other origin', async ({ request }) => {
    const page = await request.get('/PlanMind/');
    expect(page.status()).toBe(200);
    expect(page.headers()['x-frame-options']).toBe('SAMEORIGIN');
    const csp = page.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("frame-ancestors 'none'");
  });

  test('without a session every read is 401 and nothing is cacheable', async ({ request }) => {
    const denied = await request.get(API);
    expect(denied.status()).toBe(401);
    expect(await denied.json()).toMatchObject({ code: 'unauthorized' });
    expect(denied.headers()['cache-control']).toContain('no-store');
  });

  test('a write needs the CSRF token, and says so with code csrf', async ({ baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    for (const headers of [{} as Record<string, string>, { 'X-CSRF-Token': 'not-the-token' }, { 'X-CSRF-Token': owner.csrf, 'Sec-Fetch-Site': 'cross-site' }]) {
      const refused = await owner.request.post(API, { headers, data: { action: 'add' } });
      expect(refused.status()).toBe(403);
      expect((await refused.json()).code).toBe('csrf');
    }
    await owner.dispose();
  });

  test('an account outside the two cannot sign in or read', async ({ request }) => {
    const token = (await (await request.get('/PlanMind/')).text()).match(/name="csrf" value="([^"]+)"/)![1];
    const denied = await request.post('/PlanMind/', { form: { username: 'outsider', password: 'planmind-test-only', csrf: token } });
    expect(await denied.text()).toContain('Unable to sign in');
    expect((await request.get(API)).status()).toBe(401);
  });

  test('v2 errors carry a code; the old person-shaped add is refused', async ({ baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    const refusal = async (data: object, status: number, code: string) => {
      const response = await owner.post(data);
      expect([response.status(), (await response.json()).code]).toEqual([status, code]);
    };
    const date = farDate(1), made: string[] = [];
    await refusal({ action: 'add', id: crypto.randomUUID(), title: 'old shape', date, person: PARTNER }, 400, 'invalid');
    await refusal({ action: 'nothing' }, 400, 'invalid');
    await refusal(todo({ date: '2026-02-30' }), 400, 'invalid');
    await refusal(todo({ date, title: 'x'.repeat(37) }), 400, 'text_too_long');
    const longest = todo({ date, title: 'é'.repeat(36) });
    expect((await owner.post(longest)).status()).toBe(200);
    made.push(longest.id);
    // CAPS.dayTodosPerList (13) open to-dos fill a list for the day; the next one names its cap.
    const full = farDate(2);
    for (let n = 0; n < CAPS.dayTodosPerList; n++) { const row = todo({ date: full }); expect((await owner.post(row)).status()).toBe(200); made.push(row.id); }
    const over = await owner.post(todo({ date: full }));
    expect(over.status()).toBe(409);
    expect(await over.json()).toMatchObject({ code: 'limit', cap: 'dayTodosPerList', error: `${OWNER_NAME} already has ${CAPS.dayTodosPerList} things to do that day.` });
    const put = await owner.request.put(API, { headers: { 'X-CSRF-Token': owner.csrf }, data: {} });
    expect([put.status(), (await put.json()).code]).toEqual([405, 'method_not_allowed']);
    const text = await owner.request.post(API, { headers: { 'X-CSRF-Token': owner.csrf, 'Content-Type': 'text/plain' }, data: 'x' });
    expect([text.status(), (await text.json()).code]).toEqual([415, 'unsupported_media']);
    await removeTodos(owner, made);
    await owner.dispose();
  });

  test('a poll with the current revision answers only unchanged; any other since gets the full snapshot; prefs are per person', async ({ baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER);
    const get = (api: Api, query: string) => api.request.get(`${API}${query}`);
    const { revision } = await owner.snapshot();
    const same = await get(owner, `?since=${revision}`);
    expect([same.status(), await same.json()]).toEqual([200, { unchanged: true, revision }]);
    // A different, larger or malformed since (including an array) can never hide data.
    for (const query of [`?since=${revision + 1}`, `?since=${revision}x`, '?since=', '?since=-1', `?since[]=${revision}`]) {
      const body = await (await get(owner, query)).json();
      expect([query, body.unchanged, body.revision, Array.isArray(body.tasks)]).toEqual([query, undefined, revision, true]);
    }
    // Only a full GET carries the session fields; a bare POST answer does not.
    const full = await owner.snapshot();
    expect(full).toMatchObject({ user: OWNER, csrf: owner.csrf });
    expect(full).toHaveProperty('theme'); expect(full).toHaveProperty('timezone');
    const put = await owner.request.put(API, { headers: { 'X-CSRF-Token': owner.csrf }, data: {} });
    expect(put.headers()['allow']).toBe('GET, POST');
    // Prefs: saved for the caller only, and a prefs write never moves the shared revision.
    const kept = (await owner.snapshot()).prefs;
    const saved = await owner.post({ action: 'savePrefs', selection: { base: OWNER, overlays: [] } });
    const after = await saved.json();
    expect([saved.status(), after.revision, after.user, after.csrf]).toEqual([200, revision, undefined, undefined]);
    expect((await get(owner, `?since=${revision}`)).status()).toBe(200);
    expect(await (await get(owner, `?since=${revision}`)).json()).toEqual({ unchanged: true, revision });
    expect((await owner.snapshot()).prefs.selection.base).toBe(OWNER);
    expect((await partner.snapshot()).prefs.selection.base).not.toBe(OWNER);
    await owner.post({ action: 'savePrefs', selection: kept.selection });
    await owner.dispose(); await partner.dispose();
  });

  test('both accounts share one store, and a stale or removed record is a 409', async ({ baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER);
    const input = todo({ owners: [PARTNER], title: '<img src=x onerror=alert(1)>' });
    const created = await (await owner.post(input)).json();
    expect(created.tasks.find((t: { id: string }) => t.id === input.id)).toMatchObject({ owners: [PARTNER], revision: 1, done: false });
    const seen = (await partner.snapshot()).tasks.find((t: { id: string }) => t.id === input.id);
    expect(seen.title).toBe(input.title);
    const complete = { action: 'complete', id: input.id, revision: 1, done: true };
    expect((await partner.post(complete)).status()).toBe(200);
    const stale = await owner.post(complete);
    expect([stale.status(), (await stale.json()).code]).toEqual([409, 'stale']);
    expect((await partner.post({ action: 'delete', id: input.id, revision: 2, confirm: true })).status()).toBe(200);
    const gone = await owner.post({ ...complete, revision: 2 });
    expect([gone.status(), (await gone.json()).code]).toEqual([409, 'gone']);
    await owner.dispose(); await partner.dispose();
  });

  test('an add retried with the same id writes once; another account cannot reuse the id', async ({ baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER);
    const input = todo({ date: farDate(3) });
    const first = await (await owner.post(input)).json(), again = await (await owner.post(input)).json();
    expect(again.revision).toBe(first.revision);
    expect(again.tasks.filter((t: { id: string }) => t.id === input.id)).toHaveLength(1);
    const taken = await partner.post(input);
    expect([taken.status(), (await taken.json()).code]).toEqual([409, 'id_in_use']);
    await removeTodos(owner, [input.id]);
    await owner.dispose(); await partner.dispose();
  });
});

test.describe('shell', () => {
  test(`no fluff text: neither footer line is on the page, and the sidebar footer keeps "${OWNER_NAME} & ${PARTNER_NAME}" with its dot`, async ({ page }, info) => {
    await login(page);
    await expect(page.getByText('A day at a time. Together.')).toHaveCount(0);
    await expect(page.getByText('Our shared planner')).toHaveCount(0);
    await expect(page.locator('.page-footer, .footer-note')).toHaveCount(0);
    if (isPhone(info.project.name)) { await page.getByRole('button', { name: 'Open menu', exact: true }).click(); }
    const footer = page.locator('.sidebar-footer');
    await expect(footer).toBeVisible();
    await expect(footer).toHaveText(`${OWNER_NAME} & ${PARTNER_NAME}`);
    const dot = (await footer.locator('.private-dot').boundingBox())!;
    expect(dot.width).toBeGreaterThan(0);
    expect(await footer.locator('.private-dot').evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('desktop: fifteen days around today, three views, stepping and the window arrows', async ({ page }, info) => {
    test.skip(isPhone(info.project.name), 'desktop layout');
    await login(page);
    await expect(page.locator('.date-row')).toHaveCount(15);
    await expect(page.locator('.date-row').nth(7)).toContainText('Today');
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Next day', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toHaveCount(0);
    await expect(page.locator('.date-row.selected')).toHaveAttribute('data-date', shiftDays(today(), 1));
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    const first = await page.locator('.date-row').first().getAttribute('data-date');
    await page.getByRole('button', { name: 'Earlier dates', exact: true }).click();
    await expect(page.locator('.date-row').first()).toHaveAttribute('data-date', shiftDays(first!, -7));
    await page.getByRole('button', { name: 'Week', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Week', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.date-row').nth(7)).toHaveAttribute('data-date', periodStart(today(), 'week'));
    await expect(page.locator('.date-row').nth(7)).toContainText(weekRange(periodStart(today(), 'week')));
    await expect(page.locator('.date-row').nth(7)).toHaveAttribute('aria-label', /, This week$/);
    await expect(page.getByRole('heading', { name: 'This week', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Month', exact: true }).click();
    await expect(page.locator('#dates-heading')).toHaveText('Your months');
    await page.getByRole('button', { name: 'Day', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('desktop: the date list is fifteen one-line rows of 30px that fit an 800px window, written as the wireframe writes them', async ({ page }, info) => {
    test.skip(isPhone(info.project.name), 'desktop layout');
    await page.setViewportSize({ width: 1280, height: 800 });
    await login(page);
    const rows = page.locator('.date-row'), now = today(), monday = periodStart(now, 'week'), first = periodStart(now, 'month');
    const label = (index: number) => rows.nth(index).locator('.date-label');
    const headings = { Day: ['Your days', 'Daily planner'], Week: ['Monday–Sunday', 'Weekly planner'], Month: ['Your months', 'Monthly planner'] } as const;
    for (const view of ['Day', 'Week', 'Month'] as const) {
      await page.getByRole('button', { name: view, exact: true }).click();
      await expect(rows).toHaveCount(15);
      // Today plus and minus seven, every row on screen at once: no scrolling in the list, no second line in a row.
      const fit = await page.locator('#dates').evaluate(el => ({ scroll: el.scrollHeight, client: el.clientHeight }));
      expect(fit.scroll, view).toBeLessThanOrEqual(fit.client);
      expect(await rows.evaluateAll(list => list.map(el => el.getBoundingClientRect().height)), view).toEqual(Array(15).fill(30));
      await expect(rows.locator('small')).toHaveCount(0);
      await expect(rows.nth(7)).toHaveClass(/\bselected\b/);
      // Sentence case, never forced to upper case.
      await expect(page.locator('#dates-heading')).toHaveText(headings[view][0]);
      await expect(page.locator('#mode-heading')).toHaveText(headings[view][1]);
      for (const selector of ['#dates-heading', '#mode-heading', '#full-date']) {
        expect(await page.locator(selector).evaluate(el => getComputedStyle(el).textTransform), `${view} ${selector}`).toBe('none');
      }
    }
    await page.getByRole('button', { name: 'Day', exact: true }).click();
    await expect(label(7)).toHaveText('Today');
    await expect(label(8)).toHaveText(day(shiftDays(now, 1), { weekday: 'long' }));
    await expect(rows.nth(8).locator('.date-number')).toHaveText(shiftDays(now, 1).slice(-2));
    await expect(page.locator('#full-date')).toHaveText(day(now, { month: 'long', day: 'numeric', year: 'numeric' }));
    await page.getByRole('button', { name: 'Week', exact: true }).click();
    await expect(label(7)).toHaveText(weekRange(monday));
    await expect(label(6)).toHaveText(weekRange(periodStart(shiftDays(monday, -7), 'week')));
    expect(await label(6).textContent()).toMatch(/^[A-Z][a-z]{2} \d{1,2}–([A-Z][a-z]{2} )?\d{1,2}$/);
    await expect(rows.nth(7).locator('.date-number')).toHaveText(monday.slice(-2));
    await expect(page.locator('#full-date')).toHaveText(`${weekRange(monday, ' – ')} · ${now.slice(0, 4)} · Mon to Sun`);
    await page.getByRole('button', { name: 'Month', exact: true }).click();
    await expect(label(7)).toHaveText(monthShort(first));
    expect(await label(8).textContent()).toMatch(/^[A-Z][a-z]{2} \d{4}$/);
    await expect(rows.nth(7).locator('.date-number')).toHaveText(first.slice(5, 7));
  });

  test('desktop: the account name has a dot in the signed-in list\'s color before it', async ({ page }, info) => {
    test.skip(isPhone(info.project.name), 'desktop layout');
    for (const [user, name, color] of [[OWNER, OWNER_NAME, 'green'], [PARTNER, PARTNER_NAME, 'yellow']] as const) {
      await login(page, user);
      const who = page.locator('#account-button-bar .account-who');
      await expect(who).toHaveAttribute('data-c', color);
      await expect(who.locator('.account-name')).toHaveText(name);
      const [dot, text] = [(await who.locator('.owner-dot').boundingBox())!, (await who.locator('.account-name').boundingBox())!];
      expect(dot.width).toBeGreaterThan(0);
      expect(dot.x + dot.width).toBeLessThanOrEqual(text.x);
      // It is the list's own color, not a fixed green.
      expect(await who.locator('.owner-dot').evaluate(el => getComputedStyle(el).backgroundColor)).toBe(await page.evaluate(key => getComputedStyle(document.documentElement).getPropertyValue(`--c-${key}-line`).trim(), color).then(hex => `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`));
      await page.context().clearCookies();
    }
  });

  test('desktop: the top bar keeps every label on one line from 761px up, and drops the planner name when it is short of room', async ({ page }, info) => {
    test.skip(isPhone(info.project.name), 'desktop layout');
    await login(page);
    for (const width of [761, 800, 900, 901, 1000, 1360]) {
      await page.setViewportSize({ width, height: 700 });
      const lines = await page.evaluate(() => ['#mode-heading', '#sync-status', '.account-name', '#account-button-bar', '#sidebar-toggle', '#picker-slot button'].map(selector => {
        const el = document.querySelector<HTMLElement>(selector);
        const shown = !!el && el.getClientRects().length > 0;
        return { selector, shown, rows: shown ? new Set([...el!.getClientRects()].map(rect => Math.round(rect.top))).size : 0, height: shown ? el!.getBoundingClientRect().height : 0 };
      }));
      for (const { selector, shown, rows, height } of lines) {
        if (selector === '#mode-heading') { expect(shown, `${width}px ${selector}`).toBe(width > 900); }
        if (shown) { expect(rows, `${width}px ${selector} lines`).toBe(1); expect(height, `${width}px ${selector} height`).toBeLessThanOrEqual(46); }
      }
      expect(await page.locator('.topbar').evaluate(el => el.scrollWidth <= el.clientWidth), `${width}px top bar overflow`).toBe(true);
      const [bar, brand, picker, account] = await Promise.all(['.topbar', '.sidebar-brand', '.picker-button', '#account-button-bar'].map(s => page.locator(s).boundingBox()));
      expect(bar!.height, `${width}px top bar`).toBe(46);
      expect(brand!.height, `${width}px brand row`).toBe(bar!.height);
      expect(picker!.height, `${width}px picker height`).toBe(account!.height);
      expect(picker!.y, `${width}px button alignment`).toBe(account!.y);
    }
  });

  test('phone: top bar with the date, the drawer, no overflow', async ({ page }, info) => {
    test.skip(!isPhone(info.project.name), 'phone layout');
    await login(page, PARTNER);
    await expect(page.getByRole('button', { name: 'Open menu', exact: true })).toBeVisible();
    await expect(page.locator('#date-pill')).toHaveText(day(today(), { weekday: 'short', month: 'short', day: 'numeric' }));
    // The button says what it opens as well as the date.
    await expect(page.locator('#date-pill')).toHaveAttribute('aria-label', `${day(today(), { weekday: 'short', month: 'short', day: 'numeric' })}. Choose a date`);
    await expect(page.locator('.account')).toBeHidden();
    // A closed drawer is out of reach: hidden, and Tab never lands in it.
    await expect(page.locator('#sidebar')).toBeHidden();
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.closest('#sidebar') !== null), `Tab ${i + 1} stays out of the closed drawer`).toBe(false);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Next day', exact: true }).click();
    await expect(page.locator('#date-pill')).toHaveText(day(shiftDays(today(), 1), { weekday: 'short', month: 'short', day: 'numeric' }));
    await page.getByRole('button', { name: 'Previous day', exact: true }).click();
    // The hidden date input behind the pill moves the page too (the phone specs use it to reach far-away days).
    await page.locator('#pill-date').fill(farDate(0));
    await expect(page.locator('#date-pill')).toHaveText(day(farDate(0), { weekday: 'short', month: 'short', day: 'numeric' }));
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await expect(page.locator('#sidebar')).toHaveAttribute('aria-modal', 'true');
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(page.locator('#drawer-close')).toBeFocused();
    // The account is one button in the drawer too: the signed-in list's dot before the name, and its menu holds Settings and Sign out.
    await expect(page.locator('.drawer-account .account-who')).toHaveAttribute('data-c', 'yellow');
    await expect(page.getByRole('button', { name: PARTNER_NAME, exact: true })).toHaveAttribute('aria-haspopup', 'menu');
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
    await page.locator('.date-row').nth(8).click();
    await expect(page.locator('body')).not.toHaveClass(/drawer-open/);
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Open menu', exact: true })).toBeFocused();
    // Closed again, it slides away and is hidden once it has.
    await expect(page.locator('#sidebar')).toBeHidden();
  });

  test('a failed write keeps the draft and says the change may have saved', async ({ page }) => {
    await login(page);
    await showTodos(page);
    await page.route(isApi, route => isGet(route) ? route.continue() : route.abort('failed'));
    await page.getByLabel('New task', { exact: true }).fill('Keep this draft');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('may have saved');
    await expect(page.getByLabel('New task', { exact: true })).toHaveValue('Keep this draft');
  });

  test('a poll brings in the other account\'s change but never overwrites what is being typed', async ({ page, baseURL }) => {
    await page.clock.install();
    await login(page);
    await showTodos(page);
    const partner = await apiLogin(baseURL!, PARTNER);
    const theirs = todo({ owners: [PARTNER], title: unique('Theirs') });
    const input = page.getByLabel('New task', { exact: true });
    await input.fill('half typed');
    expect((await partner.post(theirs)).status()).toBe(200);
    // The page's own poll brings the change in (its answer carries the new to-do), but the focused field and its text are untouched and the list waits.
    const polled = page.waitForResponse(async response => response.url().includes('api.php?since=') && response.ok() && (await response.text()).includes(theirs.id));
    await page.clock.runFor(POLL);
    await polled;
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('half typed');
    await expect(page.getByRole('button', edit(theirs.title))).toHaveCount(0);
    await leaveField(page);
    await expect(page.getByRole('button', edit(theirs.title))).toBeVisible();
    await expect(page.getByLabel('New task', { exact: true })).toHaveValue('half typed');
    await removeTodos(partner, [theirs.id]);
    await partner.dispose();
  });

  test('a failed poll never replaces what is on screen, and the next good one clears the warning', async ({ page, baseURL }) => {
    await page.clock.install();
    await login(page);
    const owner = await apiLogin(baseURL!, OWNER);
    const title = unique('Stays');
    await addTodo(page, title);
    await leaveField(page);
    await page.route(isApi, route => isGet(route)
      ? route.fulfill({ status: 503, json: { error: 'Your list could not be loaded or saved. Your last saved data is preserved.', code: 'unavailable' } })
      : route.continue());
    await page.clock.runFor(POLL);
    await expect(page.locator('#sync-status')).toHaveText('Connection interrupted');
    await expect(page.getByRole('alert')).toContainText('last saved data is preserved');
    await expect(page.getByRole('button', edit(title))).toBeVisible();
    await page.unroute(isApi);
    await page.clock.runFor(POLL);
    await expect(page.locator('#sync-status')).toHaveText('Up to date');
    await expect(page.locator('#error')).toBeHidden();
    await removeTitled(owner, title);
    await owner.dispose();
  });

  test('a reply older than the one held is ignored', async ({ page, baseURL }) => {
    await page.clock.install();
    await login(page);
    const owner = await apiLogin(baseURL!, OWNER);
    const title = unique('Newer');
    await addTodo(page, title);
    await leaveField(page);
    await page.route(url => isApi(url) && url.searchParams.has('since'), route => route.fulfill({ json: { v: 2, revision: 1, lists: [], tasks: [], priorities: [], events: [], notes: [] } }));
    await page.clock.runFor(POLL);
    await expect(page.locator('#sync-status')).toHaveText('Up to date');
    await expect(page.getByRole('button', edit(title))).toBeVisible();
    await removeTitled(owner, title);
    await owner.dispose();
  });

  test('a 401 on a poll closes the view and removes the rows', async ({ page, baseURL }) => {
    await page.clock.install();
    await login(page);
    const owner = await apiLogin(baseURL!, OWNER);
    const title = unique('Private');
    await addTodo(page, title);
    await page.route(isApi, route => isGet(route) ? route.fulfill({ status: 401, json: { error: 'Sign in to open PlanMind.', code: 'unauthorized' } }) : route.continue());
    await page.clock.runFor(POLL);
    await expect(page.getByRole('heading', { name: 'Sign in again', exact: true })).toBeVisible();
    await expect(page.locator('#app')).not.toContainText(title);
    await expect(page.locator('.day-task')).toHaveCount(0);
    await removeTitled(owner, title);
    await owner.dispose();
  });

  test('the picker selection is read at load, healed when its list is deleted, and never changed by a poll', async ({ page, baseURL }) => {
    await page.clock.install();
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER);
    const listId = crypto.randomUUID();
    expect((await owner.post({ action: 'saveList', id: listId, name: unique('Camp').slice(0, 24), color: 'blue', revision: 0 })).status()).toBe(200);
    const mine = todo({ owners: [OWNER], title: unique('Mine') }), listed = todo({ owners: [listId], title: unique('Listed') }), other = todo({ owners: [PARTNER], title: unique('Other') });
    expect((await owner.post(mine)).status()).toBe(200);
    expect((await owner.post(listed)).status()).toBe(200);
    await login(page);
    await showTodos(page);
    await expect(page.getByRole('button', edit(mine.title))).toBeVisible();
    await expect(page.getByRole('button', edit(listed.title))).toHaveCount(0);
    // The saved preference changes on the server, then a newer snapshot arrives by poll: the view keeps its selection.
    expect((await owner.post({ action: 'savePrefs', selection: { base: listId, overlays: [] } })).status()).toBe(200);
    expect((await partner.post(other)).status()).toBe(200);
    await page.clock.runFor(POLL);
    await expect(page.getByRole('button', edit(other.title))).toBeVisible();
    await expect(page.getByRole('button', edit(mine.title))).toBeVisible();
    await expect(page.getByRole('button', edit(listed.title))).toHaveCount(0);
    // A new load takes the saved selection: the custom list alone.
    await page.reload();
    await showTodos(page);
    await expect(page.getByRole('button', edit(listed.title))).toBeVisible();
    await expect(page.getByRole('button', edit(mine.title))).toHaveCount(0);
    // The other person deletes the list; the next poll heals the selection to Both.
    const list = (await partner.snapshot()).lists.find((l: { id: string }) => l.id === listId);
    expect((await partner.post({ action: 'deleteList', id: listId, revision: list.revision, confirm: true })).status()).toBe(200);
    await page.clock.runFor(POLL);
    await expect(page.getByRole('button', edit(mine.title))).toBeVisible();
    await expect(page.getByRole('button', edit(listed.title))).toHaveCount(0);
    await removeTodos(owner, [mine.id, other.id]);
    await owner.dispose(); await partner.dispose();
  });

  test('every color key is tinted for the theme the session names, in all four themes', async ({ page }) => {
    let theme: ThemeName = 'midnight';
    await page.route(isApi, async route => {
      if (!isGet(route)) { return route.continue(); }
      const response = await route.fetch();
      const body = await response.json();
      return route.fulfill({ response, json: 'theme' in body ? { ...body, theme } : body });
    });
    await login(page);
    for (const name of Object.keys(THEMES) as ThemeName[]) {
      theme = name;
      await page.reload();
      await expect(page.locator('#sidebar .date-row.selected')).toBeAttached();
      const seen = await page.evaluate(keys => {
        const probe = document.createElement('i');
        document.body.append(probe);
        const tones: Record<string, string[]> = {};
        for (const key of keys) {
          probe.dataset.c = key;
          const style = getComputedStyle(probe);
          tones[key] = ['--tone-bg', '--tone-fg', '--tone-line'].map(property => style.getPropertyValue(property).trim());
        }
        probe.remove();
        const root = document.documentElement;
        return { tones, surface2: getComputedStyle(root).getPropertyValue('--surface-2').trim(), scheme: root.style.colorScheme };
      }, [...COLOR_KEYS]);
      for (const key of COLOR_KEYS) {
        const { bg, fg, line } = tint(COLOR_HUES[key], THEMES[name].surface, THEMES[name].text);
        expect(seen.tones[key], `${name} ${key}`).toEqual([bg, fg, line]);
      }
      expect(seen.surface2, `${name} --surface-2`).toBe(THEMES[name].surface2);
      expect(seen.scheme).toBe(name === 'sage' ? 'light' : 'dark');
    }
  });

  test('no private data reaches localStorage, sessionStorage, IndexedDB or the cache', async ({ page }) => {
    await login(page);
    const title = unique('Private');
    await addTodo(page, title);
    await page.reload();
    await showTodos(page);
    await expect(page.getByRole('button', edit(title))).toBeVisible();
    expect(await browserStorage(page)).toEqual({ local: 0, session: 0, indexedDB: 0, caches: 0 });
    await page.getByRole('button', edit(title)).click();
    await page.getByRole('button', { name: `Delete task: ${title}`, exact: true }).click();
    await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
    await expect(page.getByRole('button', edit(title))).toHaveCount(0);
  });
});
