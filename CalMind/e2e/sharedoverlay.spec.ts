import { expect, test, type Page } from '@playwright/test';

/**
 * Writes into a PARTNER's list answer at once, over a slow network.
 *
 * Both sharing calls are held for a second and a half, which is what a phone
 * on a bad connection looks like and what a loopback server never shows. The
 * assertions are made on the screen of the account that WRITES, inside that
 * window, and the owner's page is the check that the write also ended right.
 * (sharedgrace.spec holds only the pull; this holds the write too, and lets
 * the pull land before the second tap.)
 */
let seq = 0;
async function signup(page: Page): Promise<string> {
  const user = `so${Date.now()}${seq++}`;
  await page.goto('.');
  await page.getByText('Sign up', { exact: true }).click();
  await page.getByPlaceholder('Username').fill(user);
  await page.getByPlaceholder('Email').fill(user + '@example.com');
  await page.getByPlaceholder('Password', { exact: true }).fill('e2epassword');
  await page.getByPlaceholder('Confirm password').fill('e2epassword');
  await page.getByText('Sign up', { exact: true }).click();
  await expect(page.getByTestId('tab-reminders')).toBeVisible({ timeout: 20_000 });
  return user;
}

/** A shares a Reminders folder holding `row` with B, and leaves B looking at it. */
async function share(pageA: Page, pageB: Page, row: string) {
  const userB = await signup(pageB);
  const userA = await signup(pageA);
  await pageA.getByTestId('tab-reminders').click();
  await pageA.getByTestId('secadd-General').first().click();
  await pageA.getByTestId('rem-add-field').fill(row);
  await pageA.getByTestId('rem-add-field').press('Enter');
  await pageA.getByTestId('topbar-sync').click();
  await pageA.getByText('Settings', { exact: true }).click();
  await pageA.getByTestId('open-share').click();
  await pageA.getByTestId('share-add-partner').fill(userB);
  await pageA.getByTestId('share-add-partner').press('Enter');
  await pageA.getByTestId('share-folders-Reminders').click();
  await pageA.getByText('Done', { exact: true }).click();

  await pageB.getByTestId('topbar-sync').click();
  await pageB.getByText('Settings', { exact: true }).click();
  await pageB.getByTestId('open-share').click();
  await pageB.getByTestId('share-add-partner').fill(userA);
  await pageB.getByTestId('share-add-partner').press('Enter');
  await expect(pageB.getByText('sharing', { exact: true })).toBeVisible({ timeout: 10_000 });
  await pageB.getByText('Done', { exact: true }).click();

  await pageB.getByTestId('tab-reminders').click();
  await pageB.getByTestId('pick-reminders').click();
  await pageB.getByTestId('pick-shared-Reminders').click();
  await expect(pageB.getByText(row)).toBeVisible({ timeout: 15_000 });
  return { userA, userB };
}

const DELAY = 1_500;

test('a partner write applied before its reply is lost is confirmed without a false refusal or retry', async ({ browser }) => {
  test.setTimeout(150_000);
  const a = await browser.newContext(), b = await browser.newContext();
  try {
    const owner = await a.newPage(), writer = await b.newPage();
    await share(owner, writer, 'applied before the reply was lost');
    await writer.evaluate(() => {
      (window as unknown as { falseRefusal: boolean }).falseRefusal = false;
      const dot = document.querySelector('[data-testid="topbar-sync"]')!;
      new MutationObserver(() => {
        if (/partner.*not saved/i.test(dot.getAttribute('aria-label') || '')) (window as unknown as { falseRefusal: boolean }).falseRefusal = true;
      }).observe(dot, { attributes: true, attributeFilter: ['aria-label'] });
    });
    let puts = 0, applied = false;
    await writer.route('**/api/index.php*', async route => {
      if (!(route.request().postData() || '').includes('"shared_put"')) return route.continue();
      puts++;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      applied = true;
      await route.abort('connectionreset');
    });
    const checked = writer.waitForResponse(response => applied && (response.request().postData() || '').includes('"shared_pull"'));
    await writer.getByTestId('shared-tick').first().click();
    await checked;
    await expect.poll(async () => (await writer.getByTestId('topbar-sync').getAttribute('aria-label')) || '').not.toMatch(/not saved|confirm whether/i);
    expect(await writer.evaluate(() => (window as unknown as { falseRefusal: boolean }).falseRefusal)).toBe(false);
    expect(puts).toBe(1);
  } finally { await a.close(); await b.close(); }
});

/** Hold every shared_put and shared_pull for DELAY ms before it goes out. */
async function slow(page: Page) {
  await page.route('**/api/index.php*', async (route) => {
    const body = route.request().postData() ?? '';
    if (body.includes('"shared_put"') || body.includes('"shared_pull"')) await new Promise((r) => setTimeout(r, DELAY));
    await route.continue();
  });
}

test("undo inside the grace, after the pull has landed, never makes the row vanish", async ({ browser }) => {
  test.setTimeout(150_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await share(pageA, pageB, 'book the ferry');

  // Put and pull are each 300 ms: both are back well inside the 2 s grace, so
  // the second tap lands AFTER the server copy says done, and its own put and
  // pull take 600 ms to come back.
  await pageB.route('**/api/index.php*', async (route) => {
    const body = route.request().postData() ?? '';
    if (body.includes('"shared_put"')) await new Promise((r) => setTimeout(r, 300));
    if (body.includes('"shared_pull"')) await new Promise((r) => setTimeout(r, 300));
    await route.continue();
  });
  await pageB.getByTestId('shared-tick').first().click();
  await expect(pageB.getByTestId('shared-tick').first().getByText('✓')).toBeVisible();
  await pageB.waitForTimeout(1_000); // put and re-pull are back; still inside the grace
  await pageB.getByTestId('shared-tick').first().click();
  // 150 ms on (a React render and a half), long before the 600 ms round trip:
  // still there, and unticked.
  await pageB.waitForTimeout(150);
  await expect(pageB.getByTestId('shared-row'), 'the row does not vanish while the undo travels').toHaveCount(1, { timeout: 100 });
  await expect(pageB.getByTestId('shared-tick').first().getByText('✓')).toHaveCount(0, { timeout: 100 });
  await pageB.waitForTimeout(3_000);
  await expect(pageB.getByText('book the ferry')).toBeVisible();

  await ctxA.close();
  await ctxB.close();
});

test("an edit of a partner's row is drawn before the network answers", async ({ browser }) => {
  test.setTimeout(150_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await share(pageA, pageB, 'collect the parcel');
  await slow(pageB);

  // Reword in the sheet: the new words are drawn well inside the first delay.
  await pageB.getByTestId('shared-row').first().click();
  await pageB.getByPlaceholder(/What\?/).fill('collect the BIG parcel');
  await pageB.getByText('Save', { exact: true }).click();
  await expect(pageB.getByText('collect the BIG parcel'), 'drawn before the put and pull return').toBeVisible({ timeout: 700 });
  // and it stays through the slow put and the stale pulls
  await pageB.waitForTimeout(DELAY * 2 + 500);
  await expect(pageB.getByText('collect the BIG parcel')).toBeVisible();

  await ctxA.close();
  await ctxB.close();
});

test("deleting a partner's row from the sheet removes it at once and for them", async ({ browser }) => {
  test.setTimeout(150_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await share(pageA, pageB, 'old errand');
  await slow(pageB);

  await pageB.getByTestId('shared-row').first().click();
  await pageB.getByText('Delete', { exact: true }).click(); // arms
  await pageB.getByText('Delete', { exact: true }).click(); // confirms
  await expect(pageB.getByText('old errand'), 'gone before the put and pull return').toHaveCount(0, { timeout: 700 });
  await pageB.waitForTimeout(DELAY * 2 + 500);
  await expect(pageB.getByText('old errand'), 'and it stays gone through the stale pulls').toHaveCount(0);

  await pageA.getByTestId('tab-reminders').click();
  await pageA.reload();
  await expect(pageA.getByTestId('tab-reminders')).toBeVisible({ timeout: 20_000 });
  await expect(pageA.getByText('old errand')).toHaveCount(0);
  await ctxA.close();
  await ctxB.close();
});

test("a quick add into a partner's section shows at once and reaches them", async ({ browser }) => {
  test.setTimeout(150_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await share(pageA, pageB, 'collect the parcel');
  await slow(pageB);

  await pageB.getByTestId('pick-reminders').click();
  await pageB.getByTestId('pick-all').click();
  await pageB.getByTestId('shared-secadd-General').click();
  await pageB.getByPlaceholder(/What\?/).fill('buy stamps');
  await pageB.getByText('Save', { exact: true }).click();
  await expect(pageB.getByTestId('all-shared-row').filter({ hasText: 'buy stamps' }), 'drawn before any reply').toBeVisible({ timeout: 700 });

  // The put itself was held 1.5 s; once it has had time to land, the owner's
  // fresh load has the row.
  await pageB.waitForTimeout(DELAY * 2 + 500);
  await pageA.reload();
  await pageA.getByTestId('tab-reminders').click();
  await expect(pageA.getByText('buy stamps')).toBeVisible({ timeout: 20_000 });
  await ctxA.close();
  await ctxB.close();
});

test('a refused write is taken back and the sync dot says it was not saved', async ({ browser }) => {
  test.setTimeout(150_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await share(pageA, pageB, 'peel garlic');
  await pageB.route('**/api/index.php*', async (route) => {
    const body = route.request().postData() ?? '';
    if (body.includes('"shared_put"')) {
      await route.fulfill({ status: 403, contentType: 'application/json', body: '{"ok":false,"error":"not sharing"}' });
      return;
    }
    await route.continue();
  });
  await pageB.getByTestId('shared-tick').first().click();
  await expect(pageB.getByTestId('shared-tick').first().getByText('✓'), 'drawn ticked at once').toBeVisible({ timeout: 200 });
  await expect
    .poll(async () => (await pageB.getByTestId('topbar-sync').getAttribute('aria-label')) ?? '', { timeout: 10_000 })
    .toMatch(/partner.*not saved/i);
  // The refused tick is not left behind: after the grace the row is still there, unticked.
  await pageB.waitForTimeout(3_000);
  await expect(pageB.getByText('peel garlic')).toBeVisible();
  await expect(pageB.getByTestId('shared-tick').first().getByText('✓')).toHaveCount(0);
  await ctxA.close();
  await ctxB.close();
});
