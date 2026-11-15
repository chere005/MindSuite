import { expect, test, type Page } from '@playwright/test';

const account = { username: 'alex', csrf: 'fixture-csrf', accountUrl: '/account/?next=%2FAcctMind%2F', logoutAction: '/account/', logoutNext: '/account/?next=%2FAcctMind%2F' };

/** Model only the protected doorway's metadata; drive the real exported app and browser form submission. */
async function sharedShell(page: Page, metadata: unknown = account) {
  await page.unroute('**/AcctMind/');
  await page.route('**/AcctMind/', async (route) => {
    const response = await route.fetch();
    const html = await response.text();
    const encoded = JSON.stringify(metadata).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    await route.fulfill({ response, body: html.replace('</head>', `<meta name="mindsuite-account" content="${encoded}"></head>`) });
  });
  await page.goto('./');
}


test('the shared web account replaces the cog on both tabs and Settings retains ledger options', async ({ page }, info) => {
  await sharedShell(page);
  await page.getByTestId('app-menu-button').click();
  await expect(page.getByTestId('menu-account')).toHaveText('Account');
  await expect(page.getByTestId('menu-settings')).toHaveText('Settings');
  await expect(page.getByTestId('menu-signout')).toHaveText('Sign out');
  await expect(page.getByTestId('menu-import')).toHaveCount(0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: info.outputPath('acctmind-account-menu.png') });
  await page.getByTestId('menu-settings').click();
  await expect(page.getByTestId('menu-import')).toBeVisible();
  await expect(page.getByTestId('menu-export')).toBeVisible();
  await expect(page.getByTestId('menu-whole')).toBeVisible();
  await page.getByTestId('app-menu-backdrop').click({ position: { x: 2, y: 500 } });
  await page.getByTestId('tab-transactions').click();
  await expect(page.getByTestId('app-menu-button')).toHaveAttribute('aria-label', 'alex — account menu');
});

test('Account opens the shared page and Sign out is a CSRF-protected browser POST', async ({ page }) => {
  await page.route('**/account/**', (route) => route.fulfill({ contentType: 'text/html', body: '<main>Account page</main>' }));
  await sharedShell(page);
  await page.getByTestId('app-menu-button').click();
  await page.getByTestId('menu-account').click();
  await expect(page).toHaveURL(/\/account\/\?next=%2FAcctMind%2F/);
  await page.goBack();
  await page.getByTestId('app-menu-button').click();
  const posted = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/account/');
  await page.getByTestId('menu-signout').click();
  const request = await posted;
  expect(Object.fromEntries(new URLSearchParams(request.postData() ?? ''))).toEqual({ action: 'logout', csrf: account.csrf, next: account.logoutNext });
  await expect(page.getByText('Account page')).toBeVisible();
});


test('valid shared names work and malformed or cross-origin metadata cannot create account actions', async ({ page }) => {
  for (const username of ['9member', '_member']) {
    await sharedShell(page, { ...account, username });
    await expect(page.getByTestId('app-menu-button')).toHaveAttribute('aria-label', `${username} — account menu`);
  }
  for (const metadata of [
    { ...account, username: '<invalid>' },
    { ...account, csrf: '' },
    { ...account, logoutAction: 'https://external.invalid/account/' },
    { ...account, accountUrl: '/other/' },
  ]) {
    await sharedShell(page, metadata);
    await expect(page.getByTestId('app-menu-button')).toHaveAttribute('aria-label', 'Settings');
    await page.getByTestId('app-menu-button').click();
    await expect(page.getByTestId('menu-signout')).toHaveCount(0);
    await expect(page.getByTestId('menu-import')).toBeVisible();
  }
});
