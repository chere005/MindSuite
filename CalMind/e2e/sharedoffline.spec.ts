/**
 * A lost reply is not a refusal. With both partner routes unreachable, the optimistic change stays unconfirmed;
 * own-list sync cannot prove whether the partner write landed and must not replace that message with Online.
 * No partner write is automatically retried.
 */
import { test, expect, type Page } from '@playwright/test';

let seq = 0;
async function signup(page: Page): Promise<string> {
  const user = `so${Date.now()}${seq++}`;
  await page.goto('.');
  await page.getByText('Sign up', { exact: true }).click();
  await page.getByPlaceholder('Username').fill(user);
  await page.getByPlaceholder('Email').fill(`${user}@example.com`);
  await page.getByPlaceholder('Password', { exact: true }).fill('e2epassword');
  await page.getByPlaceholder('Confirm password').fill('e2epassword');
  await page.getByText('Sign up', { exact: true }).click();
  await expect(page.getByTestId('tab-reminders')).toBeVisible({ timeout: 20_000 });
  return user;
}

test('a shared tick with no write or read reply remains unconfirmed, never falsely not saved', async ({ browser }) => {
  test.setTimeout(180_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const userB = await signup(pageB);
  const userA = await signup(pageA);

  // A shares a folder holding one row.
  await pageA.getByTestId('tab-reminders').click();
  await pageA.getByTestId('secadd-General').first().click();
  await pageA.getByTestId('rem-add-field').fill('peel garlic');
  await pageA.getByTestId('rem-add-field').press('Enter');
  await pageA.getByTestId('topbar-sync').click();
  await pageA.getByText('Settings', { exact: true }).click();
  await pageA.getByTestId('open-share').click();
  await pageA.getByTestId('share-add-partner').fill(userB);
  await pageA.getByTestId('share-add-partner').press('Enter');
  await pageA.getByTestId('share-folders-Reminders').click();
  await pageA.getByText('Done', { exact: true }).click();

  // B closes the handshake and opens A's list.
  await pageB.getByTestId('topbar-sync').click();
  await pageB.getByText('Settings', { exact: true }).click();
  await pageB.getByTestId('open-share').click();
  await pageB.getByTestId('share-add-partner').fill(userA);
  await pageB.getByTestId('share-add-partner').press('Enter');
  await expect(pageB.getByText('sharing', { exact: true })).toBeVisible({ timeout: 20_000 });
  await pageB.getByText('Done', { exact: true }).click();
  await pageB.getByTestId('tab-reminders').click();
  await pageB.getByTestId('pick-reminders').click();
  await pageB.getByTestId('pick-shared-Reminders').click();
  await expect(pageB.getByText('peel garlic')).toBeVisible({ timeout: 20_000 });

  // Break ONLY the sharing calls, and leave ordinary sync working.
  //
  // The first version of this test used setOffline, and it passed with the
  // guard deleted — a check that could not fail. Offline breaks the ordinary
  // sync too, and THAT sets 'offline' on its own, so the assertion never
  // touched the line it claimed to be about. What the guard is really for is
  // a failure specific to SHARING while the network is otherwise fine: a
  // revoked share, a partner's store refusing, a 500 on that path alone.
  await pageB.route('**/api/**', async (route) => {
    const body = route.request().postData() ?? '';
    if (body.includes('shared_put') || body.includes('shared_pull')) return route.abort();
    return route.fallback();
  });
  await pageB.getByTestId('shared-tick').first().click();

  // The dot is the app's one honest signal here, and it carries the sentence
  // as its accessibility label — a coloured circle tells a screen reader
  // nothing, so that is what this reads. The change to the PARTNER's list is
  // unconfirmed and is never retried, so the sentence must not promise a retry
  // ('Offline — changes sync when you are back' is true of my own lists only).
  const dot = async () => (await pageB.getByTestId('topbar-sync').getAttribute('aria-label')) ?? '';
  await expect
    .poll(dot, { message: 'the app admits that the partner write is unconfirmed', timeout: 20_000 })
    .toMatch(/confirm.*partner/i);
  expect(await dot()).not.toMatch(/sync when you are back/i);

  // It survives the next own sync (30 s at most): that sync is about MY lists
  // and proves nothing about the partner's.
  await pageB.waitForRequest((r) => (r.postData() ?? '').includes('"action":"sync"'), { timeout: 45_000 });
  await pageB.waitForTimeout(1_500);
  expect(await dot()).toMatch(/confirm.*partner/i);
  expect(await dot()).not.toMatch(/not saved/i);

  await ctxA.close();
  await ctxB.close();
});
