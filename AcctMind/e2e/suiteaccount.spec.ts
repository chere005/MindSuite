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
  await page.getByTestId('menu-settings').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('menu-import')).toBeVisible();
  await expect(page.getByTestId('menu-import')).toBeFocused();
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


test('the suite bar and menu keep common dimensions on both tabs, including narrow phones', async ({ page }, info) => {
  await sharedShell(page, { ...account, username: 'long_account_name_12' });
  for (const width of [320, 375, 760, 1200]) {
    await page.setViewportSize({ width, height: 812 });
    for (const tab of ['budget', 'transactions']) {
      await page.getByTestId(`tab-${tab}`).click();
      const bar = page.getByTestId('suite-topbar');
      const target = page.getByTestId('app-menu-button');
      const [barBox, targetBox, faceBox] = await Promise.all([bar.boundingBox(), target.boundingBox(), target.locator(':scope > div').first().boundingBox()]);
      expect(barBox!.height, `${width}px ${tab} bar`).toBe(64);
      expect(targetBox!.height, `${width}px account target`).toBe(44);
      expect(faceBox!.height, `${width}px account face`).toBe(32);
      expect(targetBox!.x + targetBox!.width, `${width}px account right edge`).toBeLessThanOrEqual(width - 16);
      expect(await bar.evaluate(el => el.scrollWidth <= el.clientWidth), `${width}px ${tab} bar overflow`).toBe(true);
    }
  }
  await page.getByTestId('app-menu-button').click();
  const menu = page.getByTestId('suite-account-menu');
  const buttonBox = (await page.getByTestId('app-menu-button').boundingBox())!;
  const menuBox = (await menu.boundingBox())!;
  expect(menuBox.width).toBe(216);
  expect(menuBox.y).toBe(buttonBox.y + buttonBox.height + 6);
  for (const row of ['menu-account', 'menu-settings', 'menu-signout']) {
    expect((await page.getByTestId(row).boundingBox())!.height).toBe(44);
  }
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.getByTestId('app-menu-button')).toBeFocused();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(300); // The closing modal must not dim the captured bar.
  await page.screenshot({ path: info.outputPath('acctmind-common-topbar-phone.png') });
});
