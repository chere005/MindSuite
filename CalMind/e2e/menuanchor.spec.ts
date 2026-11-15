import { expect, test, type Page } from '@playwright/test';

/**
 * The username menu hangs off the username, not off the window.
 *
 * The owner, 2026-08-11, with a screenshot: "settings menu is randomly off to the
 * side on web and macos". It was `right: 16` inside its Modal — sixteen pixels
 * from the edge of the WINDOW. The app is a 640px centred column, so on any
 * window wider than that the menu appeared far to the right of the pill that
 * opened it. It looked random because it depended on the window width.
 *
 * Checked at a WIDE size, because at phone width the two positions coincide
 * and the bug is invisible — which is exactly why nothing caught it.
 */
async function signedIn(page: Page, user = `mn${String(Date.now()).slice(-7)}`): Promise<string> {
  await page.goto('.');
  await page.getByText('Sign up', { exact: true }).click();
  await page.getByPlaceholder('Username').fill(user);
  await page.getByPlaceholder('Email').fill(user + '@example.com');
  await page.getByPlaceholder('Password', { exact: true }).fill('e2epassword');
  await page.getByPlaceholder('Confirm password').fill('e2epassword');
  await page.getByText('Sign up', { exact: true }).click();
  await expect(page.getByTestId('tab-reminders')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('tab-reminders').click();
  return user;
}

test('a long account name leaves navigation and the menu usable on a narrow screen', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const user = await signedIn(page, 'alex'.repeat(3) + String(Date.now()).slice(-8));
  const bar = page.getByTestId('suite-topbar');
  const account = page.getByTestId('topbar-sync');
  await expect(account).toHaveAttribute('aria-label', new RegExp(user));
  const title = (await bar.getByText('Reminders', { exact: true }).boundingBox())!;
  expect(title.width).toBeGreaterThan(0);
  const button = (await account.boundingBox())!;
  expect(button.x + button.width).toBeLessThanOrEqual(320);
  await account.click();
  await expect(page.getByRole('menuitem', { name: 'Settings', exact: true })).toBeVisible();
  await expect.poll(() => page.getByTestId('suite-account-menu').evaluate((el) => {
    let opacity = 1;
    for (let node: HTMLElement | null = el as HTMLElement; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
    return opacity;
  })).toBeGreaterThan(0.99);
  await page.screenshot({ path: info.outputPath('calmind-topbar-320-long-name.png') });
});

for (const width of [1440, 1160, 390, 320]) {
  test(`the menu sits under the username at ${width}px`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 800 });
    await signedIn(page);

    const bar = (await page.getByTestId('suite-topbar').boundingBox())!;
    const pill = (await page.getByTestId('topbar-sync').first().boundingBox())!;
    const back = (await page.getByTestId('nav-back').boundingBox())!;
    const picker = (await page.getByTestId('pick-reminders').boundingBox())!;
    expect(bar.height).toBe(64);
    expect(back.width).toBe(44);
    expect(back.height).toBe(44);
    expect(picker.width).toBe(44);
    expect(picker.height).toBe(44);
    expect(pill.height).toBe(44);
    expect(Math.round(pill.y + pill.height / 2)).toBe(Math.round(bar.y + 32));
    expect(pill.x + pill.width).toBeLessThanOrEqual(width);

    await page.getByTestId('topbar-sync').click();
    const menu = (await page.getByTestId('suite-account-menu').boundingBox())!;
    expect(menu.width).toBe(216);
    for (const row of await page.getByRole('menuitem').all()) expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    // Its right edge tracks the pill's, rather than the window's.
    expect(
      Math.abs((menu.x + menu.width) - (pill.x + pill.width)),
      'the menu is right-aligned with the username, not with the window',
    ).toBeLessThanOrEqual(1);

    // And it hangs BELOW the pill, not level with it or above.
    expect(menu.y, 'the menu opens six pixels under the target').toBe(pill.y + pill.height + 6);

    // On screen at all — a menu pushed past the edge is unusable.
    expect(menu.x, 'not off the left edge').toBeGreaterThanOrEqual(0);
    expect(menu.x + menu.width, 'not off the right edge').toBeLessThanOrEqual(width);
  });
}

test('the account menu opens and moves focus from the keyboard, then dismisses to its trigger', async ({ page }) => {
  await signedIn(page);
  const trigger = page.getByTestId('topbar-sync');
  await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  await trigger.focus();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('menuitem', { name: 'Sign out', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Settings', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: 'Sign out', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('suite-account-menu')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('an open menu stays inside a resized short viewport and can scroll to every action', async ({ page }) => {
  await signedIn(page);
  await page.getByTestId('topbar-sync').click();
  await page.setViewportSize({ width: 320, height: 260 });
  const menu = page.getByTestId('suite-account-menu');
  await expect.poll(async () => {
    const box = (await menu.boundingBox())!;
    return box.x >= 8 && box.x + box.width <= 312 && box.y >= 8 && box.y + box.height <= 252;
  }).toBe(true);
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: 'Sign out', exact: true })).toBeFocused();
  await expect(page.getByRole('menuitem', { name: 'Sign out', exact: true })).toBeInViewport();
});
