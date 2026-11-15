import { expect, test } from '@playwright/test';
import { API, SESSION_KEY, snapshotKey } from './port';

// The API permits scoped bearer tokens for native clients. A saved web token must therefore be replaced with
// the browser's current shared identity before the store reads any cached records or sends a sync.
test('an old web token reopens only the current shared account and keeps the old account cache', async ({ page }, testInfo) => {
  const oldSnapshot = JSON.stringify({ cursor: 1, records: [], dirty: [] });
  await page.addInitScript(({ key, api, oldKey, snapshot }) => {
    localStorage.setItem(key, JSON.stringify({ token: 'old-bearer', username: 'alex', serverUrl: api }));
    localStorage.setItem(oldKey, snapshot);
  }, { key: SESSION_KEY, api: API, oldKey: snapshotKey('alex'), snapshot: oldSnapshot });
  const authorization: Array<string | undefined> = [];
  await page.route('**/api/index.php', async (route) => {
    authorization.push(route.request().headers().authorization);
    const action = route.request().postDataJSON().action;
    const body = action === 'whoami' ? { ok: true, username: 'sam', csrf: 'current-csrf' }
      : action === 'sync' ? { ok: true, cursor: 1, changes: [] }
      : { ok: true, partners: [], requests: [], shared: true, app_signin: true };
    await route.fulfill({ json: body });
  });
  await page.goto('.');
  await expect(page.getByTestId('topbar-sync').first()).toHaveAttribute('aria-label', /sam/);
  expect(authorization.length).toBeGreaterThan(0);
  expect(authorization.every((value) => value === undefined)).toBe(true);
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), SESSION_KEY))
    .toMatchObject({ token: 'cookie:sam', username: 'sam' });
  expect(await page.evaluate((key) => localStorage.getItem(key), snapshotKey('alex'))).toBe(oldSnapshot);
  await page.getByTestId('topbar-sync').first().click();
  await expect(page.getByTestId('menu-account')).toBeVisible();
  await expect(page.getByText('Settings', { exact: true })).toBeVisible();
  await expect(page.getByText('Sign out', { exact: true })).toBeVisible();
  await page.waitForTimeout(300); // Let the native-style modal's fade finish before visual inspection.
  await page.screenshot({ path: testInfo.outputPath('account-menu-420.png') });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    // Close the old anchor before measuring the newly laid-out account pill.
    await page.mouse.click(2, 500);
    await page.getByTestId('topbar-sync').first().click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: testInfo.outputPath(`account-menu-${width}.png`) });
  }
});

test('a shared logout cannot reopen a saved web bearer or its cache', async ({ page }) => {
  await page.addInitScript(({ key, api, snapshot }) => {
    localStorage.setItem(key, JSON.stringify({ token: 'old-bearer', username: 'alex', serverUrl: api }));
    localStorage.setItem(snapshot, 'cached-work-is-preserved');
  }, { key: SESSION_KEY, api: API, snapshot: snapshotKey('alex') });
  let syncs = 0;
  await page.route('**/api/index.php', async (route) => {
    if (route.request().postDataJSON().action === 'sync') syncs++;
    await route.fulfill({ status: 401, json: { ok: false, shared: true, error: 'auth required' } });
  });
  await page.route('**/account/**', (route) => route.fulfill({ contentType: 'text/html', body: '<main>Shared sign-in</main>' }));
  await page.goto('.');
  await expect(page).toHaveURL(/\/account\//);
  expect(syncs).toBe(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), snapshotKey('alex'))).toBe('cached-work-is-preserved');
});


test('an unknown web sign-in mode cannot use the password bearer door or trust it for offline restore', async ({ page }) => {
  const actions: string[] = [];
  await page.route('**/api/index.php', async (route) => {
    const action = route.request().postDataJSON().action;
    actions.push(action);
    if (action === 'whoami') { await route.abort(); return; }
    await route.fulfill({ json: { ok: true, token: 'shared-bearer', username: 'alex' } });
  });
  await page.goto('.');
  await page.getByPlaceholder('Username').fill('alex');
  await page.getByPlaceholder('Password', { exact: true }).fill('password');
  await page.getByText('Sign in', { exact: true }).click();
  await expect(page.getByText('Could not check your sign-in. Check your connection and try again.')).toBeVisible();
  expect(actions.filter((action) => action === 'whoami').length).toBeGreaterThan(1);
  expect(actions).not.toContain('login');
  expect(await page.evaluate((key) => localStorage.getItem(key), SESSION_KEY)).toBeNull();
});
