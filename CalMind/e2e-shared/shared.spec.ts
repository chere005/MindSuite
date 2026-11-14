/**
 * The web build on the suite's shared sign-in, in a real browser, against the REAL CalMind API and the REAL /account/ page
 * (e2e-shared/router.php). The gesture suite runs against a server with no site lib, so it is the legacy sign-in's proof;
 * this file is the shared one's: the redirect out, the cookie session back, the CSRF header on writes, a Log out that
 * sticks, and a cookie that changes under the page.
 *
 * Accounts are placeholders planted in the shared store (e2e-shared/seed.php); nothing here touches a real site.
 */
import { test, expect, type Page, type Request } from '@playwright/test';
import { ACCOUNT, ACCOUNTS, API, BASE, SESSION_KEY, snapshotKey } from './port';
import { writeSite } from './site';

test.describe.configure({ mode: 'serial' });
test.beforeEach(() => writeSite('on'));

type Seen = { action: string; authorization: string | undefined; csrf: string | undefined; status?: number };

/** Every call the page makes to the API, with the two headers that matter and the status it got. */
function watch(page: Page): Seen[] {
  const seen: Seen[] = [];
  const byRequest = new Map<Request, Seen>();
  page.on('request', (r) => {
    if (r.url() !== API || r.method() !== 'POST') return;
    const h = r.headers();
    const entry: Seen = { action: (r.postDataJSON() as { action: string }).action, authorization: h['authorization'], csrf: h['x-csrf-token'] };
    seen.push(entry);
    byRequest.set(r, entry);
  });
  page.on('response', (res) => {
    const entry = byRequest.get(res.request());
    if (entry) entry.status = res.status();
  });
  return seen;
}

/** The real account page's sign-in form. */
async function signInAtAccount(page: Page, user: keyof typeof ACCOUNTS) {
  const form = page.locator('form', { has: page.getByRole('button', { name: 'Sign in', exact: true }) });
  await form.getByLabel('Username').fill(user);
  await form.getByLabel('Password').fill(ACCOUNTS[user]);
  await form.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** App -> /account/ -> app: a browser with no session opens the app and ends up in it. */
async function enter(page: Page, user: keyof typeof ACCOUNTS) {
  await page.goto(BASE);
  await page.waitForURL(/\/account\/\?next=/);
  await signInAtAccount(page, user);
  await page.waitForURL(BASE);
  await expect(page.getByTestId('tab-reminders')).toBeVisible({ timeout: 15_000 });
}

async function addReminder(page: Page, text: string) {
  await page.getByTestId('tab-reminders').click();
  await page.getByTestId('secadd-General').first().click();
  await page.getByTestId('rem-add-field').fill(text);
  await page.getByTestId('rem-add-field').press('Enter');
  await expect(page.getByTestId('rem-row').filter({ hasText: text })).toBeVisible();
}

const sessionOf = (page: Page) => page.evaluate((k) => localStorage.getItem(k), SESSION_KEY);
const everyStoredValue = (page: Page) =>
  page.evaluate(() => Object.keys(localStorage).map((k) => `${k}=${localStorage.getItem(k)}`).join('\n'));

async function logOut(page: Page) {
  await page.getByTestId('topbar-sync').click();
  await page.getByText('Log out', { exact: true }).click();
}

test('a fresh browser at /calmind/ goes to /account/ and comes back signed in, holding no token', async ({ page }) => {
  const seen = watch(page);
  await page.goto(BASE);
  await page.waitForURL(/\/account\/\?next=/);
  // Path only, and the app's own.
  expect(new URL(page.url()).searchParams.get('next')).toBe('/calmind/');
  expect(page.url().startsWith(ACCOUNT)).toBe(true);
  await expect(page.getByPlaceholder('Username'), 'the app drew no form of its own').toHaveCount(0);

  await signInAtAccount(page, 'alex');
  await page.waitForURL(BASE);
  await expect(page.getByTestId('tab-reminders')).toBeVisible({ timeout: 15_000 });

  // The session is a stand-in naming the person; no credential is stored anywhere.
  const session = JSON.parse((await sessionOf(page))!) as { token: string; username: string };
  expect(session.username).toBe('alex');
  expect(session.token).toBe('cookie:alex');
  expect(await everyStoredValue(page), 'no 64-hex bearer token in storage').not.toMatch(/[a-f0-9]{64}/);

  // Real writes reach the server with the CSRF secret and without a bearer.
  await addReminder(page, 'shared milk');
  await expect.poll(() => seen.filter((s) => s.action === 'sync' && s.status === 200).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const writes = seen.filter((s) => s.action !== 'whoami');
  expect(writes.length).toBeGreaterThan(0);
  for (const w of writes) expect(w.csrf, `${w.action} carries X-CSRF-Token`).toMatch(/^[a-f0-9]{16,}$/);
  for (const s of seen) expect(s.authorization, `${s.action} sends no Authorization`).toBeUndefined();
});

test('what one browser wrote is there for the next that signs in (the cookie session really syncs)', async ({ browser }) => {
  const a = await browser.newContext();
  const pa = await a.newPage();
  await enter(pa, 'alex');
  await addReminder(pa, 'carried over');
  await expect.poll(() => pa.evaluate((k) => localStorage.getItem(k), snapshotKey('alex'))).toContain('carried over');
  // Let the debounced push land before the second browser reads.
  await pa.waitForTimeout(2500);
  await a.close();

  const b = await browser.newContext();
  const pb = await b.newPage();
  await enter(pb, 'alex');
  await pb.getByTestId('tab-reminders').click();
  await expect(pb.getByTestId('rem-row').filter({ hasText: 'carried over' })).toBeVisible({ timeout: 15_000 });
  await b.close();
});

test('Log out ends the browser\'s session: back at /account/, and the old cookie does not sign them straight back in', async ({ page, context }) => {
  await enter(page, 'alex');
  await logOut(page);
  await page.waitForURL(/\/account\/\?next=/);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  // The cookie is gone from the browser, and the app does not take the person back without the account page.
  expect((await context.cookies()).filter((c) => c.name.startsWith('MSSESS'))).toEqual([]);
  expect(await sessionOf(page)).toBeNull();
  const again = await context.newPage();
  await again.goto(BASE);
  await again.waitForURL(/\/account\/\?next=/);
});

test('a session whose cookie is gone is sent to /account/ and the stale session is dropped', async ({ page, context }) => {
  await enter(page, 'alex');
  await context.clearCookies();
  await page.reload();
  await page.waitForURL(/\/account\/\?next=/);
  expect(await sessionOf(page)).toBeNull();
});

test('a legacy bearer token left in the browser from before the switch is dropped and the person is sent to /account/', async ({ page }) => {
  await page.addInitScript(([k, api]) => {
    // Only the app's own page, and only once per load: the account page shares this origin and must not get it back.
    if (location.pathname.startsWith('/calmind/') && !localStorage.getItem(k)) {
      localStorage.setItem(k, JSON.stringify({ token: 'a'.repeat(64), username: 'alex', serverUrl: api }));
    }
  }, [SESSION_KEY, API]);
  await page.goto(BASE);
  await page.waitForURL(/\/account\/\?next=/);
  expect(await page.evaluate((k) => localStorage.getItem(k), SESSION_KEY)).toBeNull();
});

test('the account page sends them back and the API still refuses: the card, never a loop', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForURL(/\/account\/\?next=/);
  // Out of the five-second window on purpose: it is the REFERRER (the sign-in page sent them here) that must stop it.
  await page.waitForTimeout(5_500);
  await page.route(API, (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'auth required', shared: true }) }));
  await signInAtAccount(page, 'alex');
  await expect(page.getByTestId('shared-signin')).toBeVisible({ timeout: 15_000 });
  expect(page.url()).toBe(BASE);
  await expect(page.getByPlaceholder('Username')).toHaveCount(0);
  await page.waitForTimeout(1_500);
  expect(page.url(), 'it stayed put: no second redirect').toBe(BASE);
  await page.getByTestId('shared-signin').click();       // the person may still choose to go
  await page.waitForURL(/\/account\/\?next=/);
});

test('a browser that strips the referrer is held by the five-second mark: a second redirect is refused', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForURL(/\/account\/\?next=/);          // the one redirect; this tab now holds the mark
  await page.route(API, (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'auth required', shared: true }) }));
  await page.goto(BASE);
  await expect(page.getByTestId('shared-signin')).toBeVisible({ timeout: 15_000 });
  expect(page.url()).toBe(BASE);
});

test('a shared sign-in that cannot answer says so; there is no form to fall back to', async ({ page }) => {
  await page.route(API, (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'sign-in unavailable', shared: true }) }));
  await page.goto(BASE);
  await expect(page.getByText('sign-in unavailable')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByPlaceholder('Username')).toHaveCount(0);
  await expect(page.getByTestId('shared-retry')).toBeVisible();
  await page.unroute(API);
  await page.getByTestId('shared-retry').click();
  await page.waitForURL(/\/account\/\?next=/);
});

test('another tab signs in as somebody else: this page never writes into their account', async ({ context }) => {
  const a = await context.newPage();
  await enter(a, 'alex');

  // The same browser, another tab: sign out and sign in as sam. The cookie is sam's now.
  const b = await context.newPage();
  await b.goto(ACCOUNT);
  await b.getByRole('button', { name: 'Sign out', exact: true }).click();
  await b.goto(`${ACCOUNT}?next=${encodeURIComponent('/calmind/')}`);
  await signInAtAccount(b, 'sam');
  await b.waitForURL(BASE);
  await expect(b.getByTestId('tab-reminders')).toBeVisible({ timeout: 15_000 });
  await b.close();

  // alex's tab still believes it is alex. Its next write must not be sam's.
  await addReminder(a, 'for alex only');
  await expect.poll(async () => JSON.parse((await sessionOf(a)) ?? '{}').username, { timeout: 20_000 }).toBe('sam');
  await a.getByTestId('tab-reminders').click();
  await expect(a.getByTestId('rem-row').filter({ hasText: 'for alex only' }), 'not shown in sam\'s account').toHaveCount(0);

  // Not sent to sam's records either: a fresh load of sam's account does not have it...
  await a.reload();
  await a.getByTestId('tab-reminders').click();
  await expect(a.getByTestId('rem-row').filter({ hasText: 'for alex only' })).toHaveCount(0);
  // ...and not thrown away: it is still in alex's own snapshot on this device.
  expect(await a.evaluate((k) => localStorage.getItem(k), snapshotKey('alex'))).toContain('for alex only');
});

test('held: CalMind keeps its own sign-in form and a bearer token, with no redirect', async ({ page }) => {
  writeSite('held');
  const seen = watch(page);
  await page.goto(BASE);
  await expect(page.getByPlaceholder('Username')).toBeVisible({ timeout: 15_000 });
  expect(page.url()).toBe(BASE);
  const user = `held${String(Date.now()).slice(-9)}`;
  await page.getByText('Sign up', { exact: true }).click();
  await page.getByPlaceholder('Username').fill(user);
  await page.getByPlaceholder('Email').fill(`${user}@example.com`);
  await page.getByPlaceholder('Password', { exact: true }).fill('e2epassword');
  await page.getByPlaceholder('Confirm password').fill('e2epassword');
  await page.getByText('Sign up', { exact: true }).click();
  await expect(page.getByTestId('tab-reminders')).toBeVisible({ timeout: 15_000 });
  const session = JSON.parse((await sessionOf(page))!) as { token: string };
  expect(session.token).toMatch(/^[a-f0-9]{64}$/);
  await expect.poll(() => seen.some((s) => s.action === 'sync' && s.authorization === `Bearer ${session.token}`)).toBe(true);
  expect(seen.some((s) => s.csrf !== undefined), 'no CSRF header on the bearer path').toBe(false);
  await expect(page.getByTestId('tab-reminders')).toBeVisible();
});

test('the harness is not vacuous: held really is legacy and on really is shared (same server, one config line apart)', async ({ page }) => {
  const asked = async () => page.evaluate(async (api) => {
    const r = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'whoami' }) });
    return { status: r.status, body: await r.json() };
  }, API);
  // An origin to ask from. The site is 'on' (beforeEach), so the app sends this tab on to /account/: wait for THAT
  // navigation, or the first evaluate() races it and dies with "Execution context was destroyed".
  await page.goto(BASE);
  await page.waitForURL(/\/account\/\?next=/);
  writeSite('on');
  expect(await asked()).toEqual({ status: 401, body: { ok: false, error: 'auth required', shared: true } });
  writeSite('held');
  expect(await asked()).toEqual({ status: 401, body: { ok: false, error: 'auth required' } });
});
