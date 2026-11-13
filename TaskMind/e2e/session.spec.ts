import { test, expect } from '@playwright/test';
import { THEMES, type ThemeName } from '../app/theme';
import { API, PAGE, apiLogin, browserStorage, login, rewriteSession } from './helpers';

// The gate and the shell. Both projects (desktop and phone) run this file against one disposable server with three accounts:
// alex (owner) and sam (admin) are the seed team, outsider is a site account that is not on it.

test.describe('private API', () => {
  test('without a session every read is 401 and nothing is cacheable', async ({ request }) => {
    const denied = await request.get(API);
    expect(denied.status()).toBe(401);
    expect(await denied.json()).toMatchObject({ code: 'unauthorized' });
    expect(denied.headers()['cache-control']).toContain('no-store');
    expect(denied.headers()['x-content-type-options']).toBe('nosniff');
  });

  test('a member gets exactly who they are and what they may do', async ({ baseURL }) => {
    for (const [user, role] of [['alex', 'owner'], ['sam', 'admin']]) {
      const ctx = await apiLogin(baseURL!, user);
      const response = await ctx.get(API);
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ ok: true, me: user, role });
      expect(Object.keys(body).sort()).toEqual(['csrf', 'name', 'ok', 'me', 'role', 'theme'].sort());
      expect(response.headers()['cache-control']).toContain('no-store');
      await ctx.dispose();
    }
  });

  test('a site account that is not on the team is refused, and told nothing about the team', async ({ baseURL }) => {
    const ctx = await apiLogin(baseURL!, 'outsider');
    const refused = await ctx.get(API);
    expect(refused.status()).toBe(403);
    const body = await refused.json();
    expect(body).toMatchObject({ code: 'forbidden' });
    expect(Object.keys(body).sort()).toEqual(['code', 'error']);
    await ctx.dispose();
  });

  test('unsupported methods and mutations still pass through the gate', async ({ baseURL, request }) => {
    const alex = await apiLogin(baseURL!, 'alex');
    const refused = await alex.put(API, { data: { action: 'anything' } });
    expect(refused.status()).toBe(405);
    expect(refused.headers()['allow']).toBe('GET, POST');
    expect((await alex.post(API, { data: {} })).status()).toBe(403);
    await alex.dispose();
    expect((await request.post(API, { data: {} })).status()).toBe(401);
    const outsider = await apiLogin(baseURL!, 'outsider');
    expect((await outsider.post(API, { data: {} })).status()).toBe(403);
    await outsider.dispose();
  });

  test('a wrong password does not sign in, and the sign-in page says so without naming what was wrong', async ({ page }) => {
    await login(page, 'alex', 'not-the-password');
    await expect(page.getByRole('alert')).toHaveText('Unable to sign in with those details.');
    await login(page, 'nobody-here', 'not-the-password');
    await expect(page.getByRole('alert')).toHaveText('Unable to sign in with those details.');
  });
});

test.describe('the shell', () => {
  test('a member opens the app: who is signed in and their role, in the page, with nothing stored in the browser', async ({ page }) => {
    await login(page, 'sam');
    await expect(page.getByRole('heading', { name: 'TaskMind' })).toBeVisible();
    await expect(page.getByText('Signed in as')).toContainText('Sam');
    await expect(page.getByText('Admin', { exact: true })).toBeVisible();
    expect(await browserStorage(page)).toEqual({ local: 0, session: 0, indexed: 0, caches: 0 });
    // The whole page fits its width, on a desktop and on a phone.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.locator('meta[name=viewport]').getAttribute('content')).toContain('user-scalable=no');
  });

  test('a person who is not on the team gets the sign-in page with the reason, and no app', async ({ page }) => {
    await login(page, 'outsider');
    await expect(page.getByRole('alert')).toHaveText('TaskMind is for members of its team.');
    await expect(page.locator('#app')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('signing out ends the session', async ({ page, request }) => {
    await login(page, 'alex');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await page.goto(PAGE);
    await expect(page.getByLabel('Username')).toBeVisible();
    expect((await page.request.get(API)).status()).toBe(401);
    void request;
  });

  for (const name of Object.keys(THEMES) as ThemeName[]) {
    test(`takes the ${name} theme the account library says`, async ({ page }) => {
      await rewriteSession(page, body => ({ ...body, theme: name }));
      await login(page, 'alex');
      await expect(page.getByText('Signed in as')).toBeVisible();
      const colors = await page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, scheme: document.documentElement.style.colorScheme }));
      const hex = THEMES[name].bg;
      expect(colors.bg).toBe(`rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`);
      expect(colors.scheme).toBe(name === 'sage' ? 'light' : 'dark');
    });
  }

  test('an unknown theme falls back to Midnight', async ({ page }) => {
    await rewriteSession(page, body => ({ ...body, theme: 'neon' }));
    await login(page, 'alex');
    await expect(page.getByText('Signed in as')).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(17, 17, 17)');
  });

  test('a refused or failed first read shows its own screen, never an empty app', async ({ page }) => {
    await login(page, 'alex');
    await expect(page.getByText('Signed in as')).toBeVisible();
    for (const [status, title] of [[401, 'Sign in again'], [403, 'Members only'], [503, 'Unable to open TaskMind'], [200, 'Unable to open TaskMind']] as const) {
      await page.route(`**${API}`, route => route.fulfill({ status, json: status === 200 ? { ok: true } : { error: 'x', code: 'x' } }));
      await page.reload();
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
      await expect(page.getByText('Signed in as')).toHaveCount(0);
      await page.unroute(`**${API}`);
    }
  });

  test('the open page notices that its session ended', async ({ page }) => {
    await page.clock.install();
    await login(page, 'alex');
    await expect(page.getByText('Signed in as')).toBeVisible();
    await page.route(`**${API}`, route => route.fulfill({ status: 401, json: { error: 'Sign in to open TaskMind.', code: 'unauthorized' } }));
    await page.clock.runFor(61000);
    await expect(page.getByRole('heading', { name: 'Sign in again' })).toBeVisible();
    await expect(page.getByText('Signed in as')).toHaveCount(0);
  });

  test('the open page notices that the team no longer includes its member', async ({ page }) => {
    await page.clock.install();
    await login(page, 'alex');
    await expect(page.getByText('Signed in as')).toBeVisible();
    await page.route(`**${API}`, route => route.fulfill({ status: 403, json: { error: 'TaskMind is for members of its team.', code: 'forbidden' } }));
    await page.clock.runFor(61000);
    await expect(page.getByRole('heading', { name: 'Members only' })).toBeVisible();
  });
});
