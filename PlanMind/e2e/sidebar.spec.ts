import { expect, test, type Page } from '@playwright/test';
import { apiLogin, browserStorage, login, resetPrefs } from './helpers';
import { OWNER, PARTNER, OWNER_NAME } from './people';

// The sidebar button (desktop only): it hides and shows the left sidebar, the page takes the width it frees and stays
// centered, a hidden sidebar is out of the tab order and the accessibility tree, and the choice lasts for the page only
// (every load starts shown; nothing is saved, synced or kept in browser storage). Desktop project; the phone keeps its drawer.
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
    await button.click();
    await expect(page.locator('#sidebar')).toBeHidden();
    await expect(button).toHaveAccessibleName('Show sidebar');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    // Enter and Space work on the button, in both directions.
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(button).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.locator('#sidebar')).toBeHidden();
    await page.keyboard.press('Space');
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(button).toHaveAccessibleName('Hide sidebar');
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
      await toggle(page).click();
      await expect(page.locator('#sidebar')).toBeHidden();
      const after = (await page.locator('.page').boundingBox())!, view1 = page.viewportSize()!;
      expect(after.width, `${view}: the page uses what the sidebar freed`).toBeGreaterThanOrEqual(shown.width);
      expect(Math.abs(after.x - (view1.width - after.x - after.width)), `${view}: centered`).toBeLessThanOrEqual(2);
      expect(after.x + after.width).toBeLessThanOrEqual(view1.width);
      expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth), `${view}: no horizontal scroll`).toBe(true);
      expect(await fromBarEdge(), `${view}: the button stays at the left end of the bar`).toBe(x);
      await toggle(page).click();
      await expect(page.locator('#sidebar')).toBeVisible();
      const again = (await page.locator('.page').boundingBox())!;
      expect(Math.abs(again.x - shown.x) + Math.abs(again.width - shown.width), `${view}: back to where it was`).toBeLessThanOrEqual(2);
    }
  });

  test('the choice is for this page only: a reload shows the sidebar again, nothing is sent or kept, and another browser is not touched', async ({ page, browser, baseURL }) => {
    await login(page, OWNER);
    const writes: string[] = [];
    page.on('request', request => { if (request.method() === 'POST' && (request.postData() ?? '').includes('"savePrefs"')) { writes.push(request.postData()!); } });
    await toggle(page).click();
    await expect(page.locator('#sidebar')).toBeHidden();
    await expect(toggle(page)).toHaveAccessibleName('Show sidebar');
    await page.waitForTimeout(1000);
    expect(writes).toEqual([]);
    expect((await prefsOf(baseURL!, OWNER)).sidebar).toBe('shown');
    await page.reload();
    await expect(page.locator('#sidebar-toggle')).toBeVisible();
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(toggle(page)).toHaveAccessibleName('Hide sidebar');
    expect(await browserStorage(page)).toEqual({ local: 0, session: 0, indexedDB: 0, caches: 0 });
    // Another browser of the same person is not affected by a collapse here.
    await toggle(page).click();
    const context = await browser.newContext({ baseURL, viewport: { width: 1360, height: 900 } });
    const other = await context.newPage();
    await login(other, OWNER);
    await expect(other.locator('#sidebar')).toBeVisible();
    await context.close();
    // A picker change while it is collapsed neither shows it again nor carries a sidebar word.
    const pick = saved(page);
    await page.getByRole('button', { name: /^Lists: / }).click();
    await page.getByRole('group', { name: 'Lists', exact: true }).getByRole('button', { name: OWNER_NAME, exact: true }).click();
    await pick;
    expect(await prefsOf(baseURL!, OWNER)).toEqual({ selection: { base: OWNER, overlays: [] }, sidebar: 'shown' });
    await expect(page.locator('#sidebar')).toBeHidden();
  });

  test('an old stored or sent sidebar word is tolerated and ignored: every load starts shown', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    // An older page still sends it: the server accepts (and stores) it, and the page never applies it.
    expect((await owner.post({ action: 'savePrefs', selection: { base: 'both', overlays: [] }, sidebar: 'hidden' })).status()).toBe(200);
    expect((await owner.snapshot()).prefs.sidebar).toBe('hidden');
    await owner.dispose();
    await login(page, OWNER);
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(toggle(page)).toHaveAccessibleName('Hide sidebar');
    await page.reload();
    await expect(page.locator('#sidebar')).toBeVisible();
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
