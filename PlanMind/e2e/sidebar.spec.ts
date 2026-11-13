import { expect, test, type Page } from '@playwright/test';
import { apiLogin, browserStorage, login, resetPrefs } from './helpers';
import { OWNER, PARTNER, OWNER_NAME } from './people';

// The sidebar button (desktop only): it hides and shows the left sidebar, the page takes the width it frees and stays
// centered, a hidden sidebar is out of the tab order and the accessibility tree, and the choice is a per-person preference
// kept on the server next to the picker selection (never in browser storage). Desktop project; the phone keeps its drawer.
const toggle = (page: Page) => page.locator('#sidebar-toggle');
const hidden = async (page: Page) => !(await page.locator('#sidebar').isVisible());
const prefsOf = async (baseURL: string, user: typeof OWNER | typeof PARTNER) => { const api = await apiLogin(baseURL, user); const prefs = (await api.snapshot()).prefs; await api.dispose(); return prefs; };
const saved = (page: Page) => page.waitForResponse(response => response.request().method() === 'POST' && (response.request().postData() ?? '').includes('"savePrefs"'));
test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });

test.describe('the sidebar button', () => {
  test('it is at the left end of the top bar, names what it will do, and hides and shows the sidebar by mouse, Enter and Space', async ({ page }) => {
    await login(page);
    const button = toggle(page), bar = (await page.locator('.topbar').boundingBox())!;
    await expect(button).toBeVisible();
    expect((await button.boundingBox())!.x - bar.x, 'at the left end').toBeLessThan(48);
    // Shown: the button offers to hide it.
    await expect(button).toHaveAttribute('aria-controls', 'sidebar');
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(button).toHaveAccessibleName('Hide sidebar');
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hide sidebar', exact: true })).toBeVisible();
    let write = saved(page);
    await button.click();
    await expect(page.locator('#sidebar')).toBeHidden();
    await expect(button).toHaveAccessibleName('Show sidebar');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await write;
    // Enter and Space work on the button, in both directions.
    write = saved(page);
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(button).toBeFocused();
    await write;
    write = saved(page);
    await page.keyboard.press('Space');
    await expect(page.locator('#sidebar')).toBeHidden();
    await write;
    write = saved(page);
    await page.keyboard.press('Space');
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(button).toHaveAccessibleName('Hide sidebar');
    await write;
    // Shown again, the selected day is in view in its list.
    await expect(page.locator('#sidebar .date-row.selected')).toBeInViewport();
  });

  test('hidden, the sidebar is out of the tab order and the accessibility tree, and nothing in it keeps the focus', async ({ page }) => {
    await login(page);
    // Focus inside the sidebar, then hide it (a click does not move the focus): the focus goes to the button.
    await page.locator('#today').focus();
    await toggle(page).evaluate(el => (el as HTMLButtonElement).click());
    await expect(page.locator('#sidebar')).toBeHidden();
    await expect(toggle(page)).toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.closest('#sidebar') === null)).toBe(true);
    // Not in the tree: the sidebar's navigation and its buttons cannot be found, and Tab never lands in it.
    await expect(page.getByRole('navigation', { name: 'Choose a day' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Today', exact: true })).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Planner view' })).toHaveCount(0);
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.closest('#sidebar') !== null), `Tab ${i + 1}`).toBe(false);
    }
    await expect(page.locator('#sidebar')).toHaveCSS('display', 'none');
    // The sidebar button stays: the way back.
    await toggle(page).click();
    await expect(page.getByRole('navigation', { name: 'Choose a day' })).toBeVisible();
  });

  test('the page takes the freed width and stays centered: no horizontal scrollbar, the button stays at the left end of the bar, in Day, Week and Month', async ({ page }) => {
    await login(page);
    const fromBarEdge = async () => (await toggle(page).boundingBox())!.x - (await page.locator('.topbar').boundingBox())!.x;
    for (const view of ['Day', 'Week', 'Month'] as const) {
      await page.locator(`.view-switch button[data-view=${view.toLowerCase()}]`).click();
      await expect(page.locator('#mode-heading')).toHaveText(`${view === 'Day' ? 'Daily' : view === 'Week' ? 'Weekly' : 'Monthly'} planner`);
      const x = await fromBarEdge();
      const shown = (await page.locator('.page').boundingBox())!;
      const write = saved(page);
      await toggle(page).click();
      await expect(page.locator('#sidebar')).toBeHidden();
      await write;
      const after = (await page.locator('.page').boundingBox())!, view1 = page.viewportSize()!;
      expect(after.width, `${view}: the page uses what the sidebar freed`).toBeGreaterThanOrEqual(shown.width);
      expect(Math.abs(after.x - (view1.width - after.x - after.width)), `${view}: centered`).toBeLessThanOrEqual(2);
      expect(after.x + after.width).toBeLessThanOrEqual(view1.width);
      expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth), `${view}: no horizontal scroll`).toBe(true);
      expect(await fromBarEdge(), `${view}: the button stays at the left end of the bar`).toBe(x);
      const back = saved(page);
      await toggle(page).click();
      await expect(page.locator('#sidebar')).toBeVisible();
      await back;
      const again = (await page.locator('.page').boundingBox())!;
      expect(Math.abs(again.x - shown.x) + Math.abs(again.width - shown.width), `${view}: back to where it was`).toBeLessThanOrEqual(2);
    }
  });

  test('the choice is a saved preference of the person: a reload keeps it, the other person has their own, and nothing is kept in the browser', async ({ page, browser, baseURL }) => {
    await login(page, OWNER);
    const write = saved(page);
    await toggle(page).click();
    await write;
    expect((await prefsOf(baseURL!, OWNER)).sidebar).toBe('hidden');
    // The picker's selection saved at the same time is still the default; the two share one write.
    expect((await prefsOf(baseURL!, OWNER)).selection).toEqual({ base: 'both', overlays: [] });
    expect((await prefsOf(baseURL!, PARTNER)).sidebar).toBe('shown');
    await page.reload();
    await expect(page.locator('#sidebar-toggle')).toBeVisible();
    await expect(page.locator('#sidebar')).toBeHidden();
    await expect(toggle(page)).toHaveAccessibleName('Show sidebar');
    expect(await browserStorage(page)).toEqual({ local: 0, session: 0, indexedDB: 0, caches: 0 });
    // The partner, in a browser of her own, still has it shown.
    const context = await browser.newContext({ baseURL, viewport: { width: 1360, height: 900 } });
    const other = await context.newPage();
    await login(other, PARTNER);
    await expect(other.locator('#sidebar')).toBeVisible();
    await expect(toggle(other)).toHaveAccessibleName('Hide sidebar');
    await context.close();
    // Changing the picker selection while the sidebar is hidden does not show it again (one save carries both).
    const pick = saved(page);
    await page.getByRole('button', { name: /^Lists: / }).click();
    await page.getByRole('group', { name: 'Lists', exact: true }).getByRole('button', { name: OWNER_NAME, exact: true }).click();
    await pick;
    expect(await prefsOf(baseURL!, OWNER)).toEqual({ selection: { base: OWNER, overlays: [] }, sidebar: 'hidden' });
    // Shown again: it is saved too.
    const back = saved(page);
    await toggle(page).click();
    await back;
    expect(await prefsOf(baseURL!, OWNER)).toEqual({ selection: { base: OWNER, overlays: [] }, sidebar: 'shown' });
  });

  test('a picker change on a device that has not touched the sidebar never undoes what another device chose', async ({ page, browser, baseURL }) => {
    // The owner's first device loads with the sidebar shown; his second hides it and then shows it again.
    await login(page, OWNER);
    const context = await browser.newContext({ baseURL, viewport: { width: 1360, height: 900 } });
    const other = await context.newPage();
    await login(other, OWNER);
    let write = saved(other);
    await toggle(other).click();
    await write;
    expect((await prefsOf(baseURL!, OWNER)).sidebar).toBe('hidden');
    // The first device still believes the sidebar is shown. Its picker change says nothing about the sidebar, so the server keeps 'hidden'.
    write = saved(page);
    await page.getByRole('button', { name: /^Lists: / }).click();
    await page.getByRole('group', { name: 'Lists', exact: true }).getByRole('button', { name: OWNER_NAME, exact: true }).click();
    await write;
    expect(await prefsOf(baseURL!, OWNER)).toEqual({ selection: { base: OWNER, overlays: [] }, sidebar: 'hidden' });
    await expect(page.locator('#sidebar')).toBeVisible();
    // The device that hid it shows it again, and a picker change on the first one leaves that alone too.
    write = saved(other);
    await toggle(other).click();
    await write;
    write = saved(page);
    await page.getByRole('button', { name: /^Lists: / }).click();
    await page.getByRole('group', { name: 'Lists', exact: true }).getByRole('button', { name: 'Both', exact: true }).click();
    await write;
    expect(await prefsOf(baseURL!, OWNER)).toEqual({ selection: { base: 'both', overlays: [] }, sidebar: 'shown' });
    await context.close();
  });

  test('a value the server does not know reads as shown, and the server will not store one', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    for (const odd of ['collapsed', 'Hidden', '', 'hidden ', 5, true, null, ['hidden']]) {
      expect((await owner.post({ action: 'savePrefs', selection: { base: 'both', overlays: [] }, sidebar: odd })).status()).toBe(200);
      expect((await owner.snapshot()).prefs.sidebar, JSON.stringify(odd)).toBe('shown');
    }
    expect((await owner.post({ action: 'savePrefs', selection: { base: 'both', overlays: [] }, sidebar: 'hidden' })).status()).toBe(200);
    expect((await owner.snapshot()).prefs.sidebar).toBe('hidden');
    // A save without the field keeps what is stored (an older page).
    expect((await owner.post({ action: 'savePrefs', selection: { base: 'both', overlays: [] } })).status()).toBe(200);
    expect((await owner.snapshot()).prefs.sidebar).toBe('hidden');
    await owner.dispose();
    await login(page, OWNER);
    await expect(page.locator('#sidebar')).toBeHidden();
  });

  test('the account menu still opens fully on screen with the sidebar hidden, and Escape from it leaves the sidebar alone', async ({ page }) => {
    await login(page);
    await toggle(page).click();
    await expect(page.locator('#sidebar')).toBeHidden();
    await page.locator('#account-button-bar').click();
    const menu = (await page.getByRole('menu').boundingBox())!, view = page.viewportSize()!;
    expect(menu.x).toBeGreaterThanOrEqual(0);
    expect(menu.x + menu.width).toBeLessThanOrEqual(view.width);
    expect(menu.y + menu.height).toBeLessThanOrEqual(view.height);
    await page.keyboard.press('Escape');
    await expect(page.locator('#sidebar')).toBeHidden();
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test('there is no sidebar button, and a hidden sidebar preference does not touch the drawer', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    expect((await owner.post({ action: 'savePrefs', selection: { base: 'both', overlays: [] }, sidebar: 'hidden' })).status()).toBe(200);
    await owner.dispose();
    await login(page);
    await expect(toggle(page)).toBeHidden();
    await expect(page.getByRole('button', { name: 'Open menu', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open menu', exact: true }).tap();
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Choose a day' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#sidebar')).toBeHidden();
  });
});
