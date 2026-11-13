import { expect, request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';

/** Every disposable account of tools/fixture.mjs shares this password. */
export const PASSWORD = 'taskmind-test-only';
export const API = '/TaskMind/api.php';
export const PAGE = '/TaskMind/';

/** Signs in through the page, as a person does. */
export async function login(page: Page, user: string, password = PASSWORD) {
  await page.goto(PAGE);
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** A request context that signed in as `user` through index.php (the same form post the page makes). */
export async function apiLogin(baseURL: string, user: string): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({ baseURL });
  const token = (await (await ctx.get(PAGE)).text()).match(/name="csrf" value="([^"]+)"/)![1];
  const response = await ctx.post(PAGE, { form: { username: user, password: PASSWORD, csrf: token }, maxRedirects: 0 });
  expect(response.status()).toBe(303);
  return ctx;
}

/** Everything the page could have left in the browser: all four storages and the Cache API. */
export async function browserStorage(page: Page) {
  return page.evaluate(async () => ({
    local: localStorage.length, session: sessionStorage.length,
    indexed: (await indexedDB.databases()).length, caches: (await caches.keys()).length,
  }));
}

/** Lets the real api.php answer, then changes what the page is told. */
export async function rewriteSession(page: Page, change: (body: Record<string, unknown>) => Record<string, unknown>) {
  await page.route(`**${API}`, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: change(await response.json()) });
  });
}
