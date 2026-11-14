/**
 * App sign-in in a real browser, against the REAL CalMind API and the REAL /account/ and /account/app/ pages
 * (e2e-shared/router.php). Nothing here is a mock of the server side.
 *
 * The desktop shell cannot be launched, so its half is faked at exactly one seam: window.__TAURI__.core.invoke, which the
 * page calls for signin_listen, open_in_browser, signin_wait and signin_cancel (src/appsignin-browser.ts). The fake is
 * node: a real loopback http server answers the return, and "the system browser" is a SECOND browser context with its
 * own cookie jar. Everything between those two is the product's own code: the exported app, the API, the site pages.
 * The Rust listener itself is proven by desktop/test-signin.sh; a real Tauri IPC call and a real https-to-loopback hand
 * back inside a running shell are not provable here.
 *
 * Accounts are placeholders planted in the shared store (e2e-shared/seed.php).
 */
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test, expect, type Browser, type BrowserContext, type Page, type Request } from '@playwright/test';
import { ACCOUNTS, API, BASE, ORIGIN, SESSION_KEY, phpEnv } from './port';
import { writeSite } from './site';

test.describe.configure({ mode: 'serial' });
test.beforeEach(() => writeSite('on'));

const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const php = (script: string, ...args: string[]) => execFileSync('php', [join(__dirname, script), ...args], { env: { ...process.env, ...phpEnv() } }).toString();

/** The node half of the desktop shell: the loopback listener and "the system browser" (a second context). */
class FakeShell {
  port = 0;
  server: http.Server | null = null;
  queries: string[] = [];
  systemPage: Page | null = null;
  commands: string[] = [];
  private resolve: ((q: string | null) => void) | null = null;
  private result: Promise<string | null> | null = null;
  constructor(private readonly system: BrowserContext) {}

  async invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.commands.push(cmd);
    switch (cmd) {
      case 'signin_listen': {
        this.result = new Promise((r) => { this.resolve = r; });
        this.server = http.createServer((req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          if (url.pathname !== '/signin') { res.statusCode = 404; res.end('not found'); return; }
          this.queries.push(url.search.slice(1));
          res.setHeader('Content-Type', 'text/html');
          res.end('<p>CalMind has your sign-in.</p>');
          this.resolve?.(url.search.slice(1));
        });
        await new Promise<void>((ok) => this.server!.listen(0, '127.0.0.1', ok));
        this.port = (this.server.address() as { port: number }).port;
        expect(typeof args.state).toBe('string');
        return this.port;
      }
      case 'open_in_browser': {
        this.systemPage = await this.system.newPage();
        await this.systemPage.goto(String(args.url));
        return undefined;
      }
      case 'signin_wait': return this.result;
      case 'signin_cancel': this.resolve?.(null); return undefined;
      default: throw new Error(`unexpected command ${cmd}`);
    }
  }

  async close() {
    this.resolve?.(null);
    await new Promise<void>(ok => {
      if (!this.server) { ok(); return; }
      this.server.close(() => ok());
      this.server.closeAllConnections();
    });
  }
}

/** An app window whose page believes it is in the desktop shell. */
async function desktopApp(browser: Browser, viewport = { width: 420, height: 900 }) {
  const system = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  const appCtx = await browser.newContext({ viewport });
  const shell = new FakeShell(system);
  await appCtx.exposeBinding('__tauriInvoke', (_src, cmd: string, args: Record<string, unknown>) => shell.invoke(cmd, args));
  await appCtx.addInitScript(() => {
    (window as unknown as { __TAURI__: unknown }).__TAURI__ = {
      core: { invoke: (c: string, a: unknown) => (window as unknown as { __tauriInvoke: (c: string, a: unknown) => Promise<unknown> }).__tauriInvoke(c, a) },
    };
  });
  const app = await appCtx.newPage();
  return { app, appCtx, system, shell, close: async () => { await shell.close(); await appCtx.close(); await system.close(); } };
}

/** Every call the page makes to the API: the action, and whether it carried a bearer. */
function watch(page: Page): { action: string; bearer: boolean }[] {
  const seen: { action: string; bearer: boolean }[] = [];
  page.on('request', (r: Request) => {
    if (r.url() !== API || r.method() !== 'POST') return;
    seen.push({ action: (r.postDataJSON() as { action: string }).action, bearer: (r.headers()['authorization'] ?? '').startsWith('Bearer ') });
  });
  return seen;
}

async function signInAtAccount(page: Page, user: keyof typeof ACCOUNTS) {
  const form = page.locator('form', { has: page.getByRole('button', { name: 'Sign in', exact: true }) });
  await form.getByLabel('Username').fill(user);
  await form.getByLabel('Password').fill(ACCOUNTS[user]);
  await form.getByRole('button', { name: 'Sign in', exact: true }).click();
}

const RETURN = 'com.seancheren.calmind:/signin';
function pageUrl(over: Record<string, string> = {}) {
  const verifier = b64u(randomBytes(32));
  const q = new URLSearchParams({
    app: 'calmind', redirect_uri: RETURN, state: b64u(randomBytes(32)),
    code_challenge: b64u(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', ...over,
  });
  return { url: `${ORIGIN}/account/app/?${q.toString()}`, verifier, state: q.get('state')!, challenge: q.get('code_challenge')! };
}

test('desktop path, end to end: Sign in opens the account page in the system browser, the person signs in and confirms, and the app is signed in with a suite token and no password form', async ({ browser }) => {
  const d = await desktopApp(browser);
  try {
    const seen = watch(d.app);
    await d.app.goto(BASE);
    await expect(d.app.getByTestId('app-signin')).toBeVisible({ timeout: 15_000 });
    await expect(d.app.getByPlaceholder('Username'), 'no username field').toHaveCount(0);
    await expect(d.app.getByPlaceholder('Password'), 'no password field').toHaveCount(0);
    await expect(d.app.getByText('Use a passkey'), 'no passkey button in the shell').toHaveCount(0);
    await d.app.getByTestId('app-signin').click();
    await expect(d.app.getByText('Finish signing in in your browser, then come back here.')).toBeVisible();
    await expect.poll(() => d.shell.systemPage !== null).toBe(true);
    const sys = d.shell.systemPage!;
    await sys.waitForURL(/\/account\/\?next=/);
    await expect(sys.locator('#account-for-app')).toHaveText('Sign in to continue to CalMind.');
    await signInAtAccount(sys, 'alex');
    await expect(sys.getByRole('heading', { name: 'Continue to CalMind as alex?' })).toBeVisible();
    // The first load of the confirm page: what Sec-Fetch-Site did the browser send? (design assumption: none, then same-origin)
    const continued = sys.waitForResponse(r => r.url().startsWith(`${ORIGIN}/account/app/`) && r.request().method() === 'POST');
    await sys.getByRole('button', { name: 'Continue to CalMind', exact: true }).click();
    expect((await continued).status(), 'the confirmation POST hands back the code').toBe(303);
    await sys.waitForURL(new RegExp(`^http://127\\.0\\.0\\.1:${d.shell.port}/signin\\?`));
    await expect(d.app.getByTestId('tab-reminders')).toBeVisible({ timeout: 15_000 });
    expect(d.shell.queries).toHaveLength(1);
    expect(d.shell.queries[0]).toMatch(/^code=[a-f0-9]{64}&state=[A-Za-z0-9_-]{43}$/);

    expect(seen.map((s) => s.action)).toContain('signin_info');
    expect(seen.map((s) => s.action)).toContain('signin_redeem');
    expect(seen.map((s) => s.action), 'the form was never used').not.toContain('login');
    expect(seen.find((s) => s.action === 'signin_redeem')!.bearer).toBe(false);
    const stored = JSON.parse((await d.app.evaluate((k) => localStorage.getItem(k), SESSION_KEY)) as string) as { token: string; username: string; suite?: boolean };
    expect(stored.username).toBe('alex');
    expect(stored.suite).toBe(true);
    expect(stored.token).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(php('store-row.php', stored.token))).toEqual({ scope: 'calmind', user: 'alex' });
    // It is a calmind bearer: the API takes it, and as the suite cookie it is nothing.
    const bearer = await d.appCtx.request.post(API, { data: { action: 'whoami' }, headers: { Authorization: `Bearer ${stored.token}` } });
    expect(bearer.status()).toBe(200);
    const asCookie = await d.appCtx.request.post(API, { data: { action: 'whoami' }, headers: { Cookie: `MSSESS=${stored.token}` } });
    expect(asCookie.status()).toBe(401);
    // The system browser is signed in at the suite, the app is signed in with its own token: signing the app out leaves the browser alone.
    expect(d.shell.commands).toEqual(['signin_listen', 'open_in_browser', 'signin_wait']);
  } finally { await d.close(); }
});

test('scheme return: Continue answers a 303 to the app scheme with a 64-hex code, which redeems once for a scoped bearer and never twice', async ({ browser }) => {
  const ctx = await browser.newContext();
  try {
    const p = pageUrl();
    const page = await ctx.newPage();
    await page.goto(p.url);
    await page.waitForURL(/\/account\/\?next=/);
    await signInAtAccount(page, 'sam');
    await expect(page.getByRole('heading', { name: 'Continue to CalMind as sam?' })).toBeVisible();
    const resp = page.waitForResponse((r) => r.url().startsWith(`${ORIGIN}/account/app/`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Continue to CalMind', exact: true }).click();
    const r = await resp;
    expect(r.status()).toBe(303);
    const loc = r.headers()['location'] ?? '';
    const m = new RegExp(`^${RETURN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?code=([a-f0-9]{64})&state=${p.state}$`).exec(loc);
    expect(m, 'the Location is the scheme, a 64-hex code and our state').not.toBeNull();
    const code = m![1]!;
    const body = { action: 'signin_redeem', code, code_verifier: p.verifier, redirect_uri: RETURN };
    const first = await ctx.request.post(API, { data: body });
    expect(first.status()).toBe(200);
    const token = ((await first.json()) as { token: string }).token;
    expect((await ctx.request.post(API, { data: { action: 'whoami' }, headers: { Authorization: `Bearer ${token}` } })).status()).toBe(200);
    const second = await ctx.request.post(API, { data: body });
    expect(second.status()).toBe(400);
    expect((await ctx.request.post(API, { data: { action: 'whoami' }, headers: { Authorization: `Bearer ${token}` } })).status(), 'a replay ends the session it made').toBe(401);
  } finally { await ctx.close(); }
});

test('a verifier that is not the page\'s own never redeems', async ({ browser }) => {
  const ctx = await browser.newContext();
  try {
    const p = pageUrl();
    const page = await ctx.newPage();
    await page.goto(p.url);
    await signInAtAccount(page, 'sam');
    const resp = page.waitForResponse((r) => r.url().startsWith(`${ORIGIN}/account/app/`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Continue to CalMind', exact: true }).click();
    const code = /code=([a-f0-9]{64})/.exec((await resp).headers()['location'] ?? '')![1]!;
    const wrong = await ctx.request.post(API, { data: { action: 'signin_redeem', code, code_verifier: b64u(randomBytes(32)), redirect_uri: RETURN } });
    expect(wrong.status()).toBe(400);
  } finally { await ctx.close(); }
});

test('cancel on the confirm page returns access_denied to the listener and the app is back on Sign in with no error', async ({ browser }) => {
  const d = await desktopApp(browser);
  try {
    await d.app.goto(BASE);
    await d.app.getByTestId('app-signin').click();
    await expect.poll(() => d.shell.systemPage !== null).toBe(true);
    const sys = d.shell.systemPage!;
    await sys.waitForURL(/\/account\/\?next=/);
    await signInAtAccount(sys, 'alex');
    await sys.getByRole('link', { name: 'Cancel' }).click();
    await sys.waitForURL(new RegExp(`^http://127\\.0\\.0\\.1:${d.shell.port}/signin\\?`));
    expect(d.shell.queries[0]).toMatch(/^error=access_denied&state=[A-Za-z0-9_-]{43}$/);
    await expect(d.app.getByTestId('app-signin')).toBeVisible();
    await expect(d.app.getByText('did not finish')).toHaveCount(0);
    await expect(d.app.getByText('expired')).toHaveCount(0);
  } finally { await d.close(); }
});

test('the Cancel pill in the app stops the wait and brings the Sign in card back', async ({ browser }) => {
  const d = await desktopApp(browser);
  try {
    await d.app.goto(BASE);
    await d.app.getByTestId('app-signin').click();
    await expect(d.app.getByTestId('app-signin-cancel')).toBeVisible();
    await d.app.getByTestId('app-signin-cancel').click();
    await expect(d.app.getByTestId('app-signin')).toBeVisible();
    expect(d.shell.commands).toContain('signin_cancel');
  } finally { await d.close(); }
});

test('held: the API answers legacy, so the card shows the old form and nothing opens', async ({ browser }) => {
  writeSite('held');
  const d = await desktopApp(browser);
  try {
    await d.app.goto(BASE);
    await expect(d.app.getByPlaceholder('Username')).toBeVisible({ timeout: 15_000 });
    await expect(d.app.getByTestId('app-signin')).toHaveCount(0);
    expect(d.shell.commands).toEqual([]);
  } finally { await d.close(); writeSite('on'); }
});

for (const refusal of ['offline', 'unavailable'] as const) {
  test(`a legacy form does not submit a password when its fresh mode check is ${refusal}`, async ({ browser }) => {
    writeSite('held');
    const d = await desktopApp(browser);
    const calls = watch(d.app);
    try {
      await d.app.goto(BASE);
      await expect(d.app.getByPlaceholder('Username')).toBeVisible();
      await d.app.getByPlaceholder('Username').fill('alex');
      await d.app.getByPlaceholder('Password', { exact: true }).fill(ACCOUNTS.alex);
      await d.app.route(API, async route => {
        if (route.request().postDataJSON().action !== 'signin_info') return route.continue();
        if (refusal === 'offline') return route.abort();
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, shared: true, error: 'Sign-in is unavailable right now.' }) });
      });
      await d.app.getByText('Sign in', { exact: true }).click();
      await expect(d.app.getByText(refusal === 'offline'
        ? 'Could not reach the server. Check your connection and try again.'
        : 'Sign-in is unavailable right now.', { exact: true })).toBeVisible();
      expect(calls.filter(call => call.action === 'login')).toEqual([]);
    } finally { await d.close(); writeSite('on'); }
  });
}

test('screens: the confirm page and the account page it sends people to, midnight and sage, phone and desktop; the app\'s sign-in cards', async ({ browser }, testInfo) => {
  const shot = (page: Page, name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: false });
  // The signed-out account page with its banner (the theme is per person, so signed out it is always midnight).
  for (const [w, h, tag] of [[420, 900, 'phone'], [1280, 800, 'desktop']] as const) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await page.goto(pageUrl().url);
    await page.waitForURL(/\/account\/\?next=/);
    await expect(page.locator('#account-for-app')).toBeVisible();
    await shot(page, `account-banner-midnight-${tag}`);
    await ctx.close();
  }
  for (const theme of ['midnight', 'sage']) {
    php('theme.php', 'alex', theme);
    for (const [w, h, tag] of [[420, 900, 'phone'], [1280, 800, 'desktop']] as const) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      await page.goto(pageUrl().url);
      await page.waitForURL(/\/account\/\?next=/);
      await signInAtAccount(page, 'alex');
      await expect(page.getByRole('heading', { name: 'Continue to CalMind as alex?' })).toBeVisible();
      await shot(page, `confirm-${theme}-${tag}`);
      const bad = await ctx.newPage();
      await bad.goto(pageUrl({ redirect_uri: 'https://evil.example/cb' }).url);
      await shot(bad, `invalid-${theme}-${tag}`);
      await ctx.close();
    }
  }
  php('theme.php', 'alex', 'midnight');
  // The app's own cards, in the desktop window (480 wide) and at phone width: Sign in, waiting, offline.
  for (const [w, h, tag] of [[480, 800, 'window'], [420, 900, 'phone']] as const) {
    const d = await desktopApp(browser, { width: w, height: h });
    try {
      await d.app.goto(BASE);
      await expect(d.app.getByTestId('app-signin')).toBeVisible({ timeout: 15_000 });
      await shot(d.app, `app-signin-${tag}`);
      await d.app.getByTestId('app-signin').click();
      await expect(d.app.getByTestId('app-signin-cancel')).toBeVisible();
      await shot(d.app, `app-waiting-${tag}`);
    } finally { await d.close(); }
    const off = await desktopApp(browser, { width: w, height: h });
    try {
      await off.appCtx.route(API, (r) => r.abort());
      await off.app.goto(BASE);
      await expect(off.app.getByTestId('app-signin-retry')).toBeVisible({ timeout: 20_000 });
      await shot(off.app, `app-offline-${tag}`);
    } finally { await off.close(); }
  }
});
