import { expect, test, type Page, type Route } from '@playwright/test';
import { THEMES, type ThemeName } from '../app/theme';
import { MIN_CONTRAST } from '../packages/core/src/planner';
import { API, accountMenu, apiLogin, browserStorage, isPhone, login, showTheme, textContrast } from './helpers';
import { OWNER, PARTNER, PARTNER_NAME } from './people';

// The account: one button (dot, name, chevron) that opens a menu of Settings and Sign out; Settings is a window with the
// suite's four themes, applied at once and saved as the account's theme (the same prefs file CalMind and the suite read). The
// desktop top bar holds the button; on a phone the drawer's account row does. Both projects run this file.
const THEME_NAMES = Object.keys(THEMES) as ThemeName[];
const label = (name: ThemeName) => THEMES[name].label;
const swatch = (page: Page, name: ThemeName) => page.getByRole('button', { name: label(name), exact: true });
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });
/** The page palette as the browser holds it: the variables setTheme writes. */
const palette = (page: Page) => page.evaluate(() => {
  const style = document.documentElement.style;
  return { bg: style.getPropertyValue('--bg').trim(), surface: style.getPropertyValue('--surface').trim(), accent: style.getPropertyValue('--accent').trim(), scheme: style.colorScheme, meta: document.querySelector<HTMLMetaElement>('meta[name=theme-color]')?.content };
});
const expectTheme = async (page: Page, name: ThemeName) => {
  const cols = THEMES[name], light = name === 'sage';
  expect(await palette(page), name).toEqual({ bg: cols.bg, surface: cols.surface, accent: cols.accent, scheme: light ? 'light' : 'dark', meta: cols.bg });
};
const storedTheme = async (user: typeof OWNER | typeof PARTNER, baseURL: string) => { const api = await apiLogin(baseURL, user); const theme = (await api.snapshot()).theme; await api.dispose(); return theme; };
/** Both accounts back on Midnight, the theme every other test expects. */
async function resetThemes(baseURL: string) {
  for (const user of [OWNER, PARTNER] as const) {
    const api = await apiLogin(baseURL, user);
    await api.post({ action: 'setTheme', theme: 'midnight' });
    await api.dispose();
  }
}
test.afterEach(async ({ baseURL }) => { await resetThemes(baseURL!); });

test.describe('the account menu', () => {
  test('one button with the dot, the name and a chevron opens a menu of Settings and Sign out; there is no separate Sign out button', async ({ page }, info) => {
    await login(page, PARTNER);
    const phone = isPhone(info.project.name);
    if (phone) { await page.getByRole('button', { name: 'Open menu', exact: true }).click(); }
    const button = page.getByRole('button', { name: PARTNER_NAME, exact: true });
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-haspopup', 'menu');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(button.locator('.account-who')).toHaveAttribute('data-c', 'yellow');
    await expect(button.locator('.owner-dot')).toBeVisible();
    await expect(button.locator('.account-chevron svg')).toBeVisible();
    await expect(page.getByRole('menu')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText(['Settings', 'Sign out']);
    // The first item has the focus, so the menu is usable by keyboard at once.
    await expect(menu.getByRole('menuitem', { name: 'Settings', exact: true })).toBeFocused();
  });

  test('the menu opens fully on screen: at the right of the top bar on a desktop, above the account row in the phone drawer', async ({ page }, info) => {
    await login(page);
    await accountMenu(page);
    const box = (await page.getByRole('menu').boundingBox())!, view = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(view.width);
    expect(box.y + box.height).toBeLessThanOrEqual(view.height);
    if (isPhone(info.project.name)) {
      const row = (await page.locator('#account-button-drawer').boundingBox())!, drawer = (await page.locator('#sidebar').boundingBox())!;
      expect(box.y + box.height, 'above the account row').toBeLessThanOrEqual(row.y);
      expect(box.x + box.width, 'inside the drawer').toBeLessThanOrEqual(drawer.x + drawer.width);
    } else {
      const button = (await page.locator('#account-button-bar').boundingBox())!;
      expect(box.y, 'below the button').toBeGreaterThanOrEqual(button.y + button.height);
      expect(Math.abs(box.x + box.width - (button.x + button.width)), 'right edges line up').toBeLessThanOrEqual(2);
    }
  });

  test('keyboard: Down and Up open it, the arrows, Home and End move, Escape closes and gives the focus back, Tab closes', async ({ page }, info) => {
    test.skip(isPhone(info.project.name), 'a keyboard: the desktop project');
    await login(page);
    const button = page.locator('#account-button-bar'), menu = page.getByRole('menu'), items = menu.getByRole('menuitem');
    await button.focus();
    await page.keyboard.press('ArrowDown');
    await expect(menu).toBeVisible();
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press('End');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    // ArrowUp on the closed button opens it on the last item; Enter and Space open it too.
    await page.keyboard.press('ArrowUp');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Space');
    await expect(menu).toBeVisible();
    // Tab leaves the menu and closes it, the focus on the next control after the account.
    await page.keyboard.press('Tab');
    await expect(menu).toBeHidden();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(await page.evaluate(() => document.activeElement?.closest('.account-menu') !== null && document.activeElement?.classList.contains('account-button') !== true)).toBe(false);
  });

  test('a press outside closes it, and the account button toggles it', async ({ page }, info) => {
    await login(page);
    const button = await accountMenu(page), menu = page.getByRole('menu');
    await button.click();
    await expect(menu).toBeHidden();
    await button.click();
    await expect(menu).toBeVisible();
    // Outside: the page itself, by mouse on a desktop and by a finger on a phone.
    if (isPhone(info.project.name)) { await page.locator('.date-row').first().tap(); } else { await page.locator('.page-header h1').click(); }
    await expect(menu).toBeHidden();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  test('Sign out is a real form that posts the CSRF token; choosing it ends the session', async ({ page }) => {
    await login(page);
    await accountMenu(page);
    const form = page.locator('.account-pop form.logout:visible');
    await expect(form).toHaveAttribute('method', 'post');
    expect(await form.locator('input[name=csrf]').inputValue()).toMatch(/^[a-f0-9]{64}$/);
    expect(await form.locator('input[name=action]').inputValue()).toBe('logout');
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
    // The session is gone: the planner's API refuses.
    expect((await page.request.get(API)).status()).toBe(401);
  });
});

test.describe('Settings', () => {
  test('a window with who is signed in, the four themes (the current one marked) and Done; Done, Escape and a press on the backdrop close it and the focus goes back to the account', async ({ page }, info) => {
    await login(page, PARTNER);
    const button = await accountMenu(page, 'Settings');
    const dialog = settings(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(dialog.getByText(`Signed in as ${PARTNER_NAME}`)).toBeVisible();
    await expect(dialog.getByText('Theme', { exact: true })).toBeVisible();
    // No password change here: that stays with the site.
    await expect(dialog.getByText(/password/i)).toHaveCount(0);
    for (const name of THEME_NAMES) {
      await expect(swatch(page, name)).toHaveAttribute('title', label(name));
      await expect(swatch(page, name)).toHaveAttribute('aria-pressed', String(name === 'midnight'));
    }
    await expect(dialog.getByRole('button')).toHaveCount(THEME_NAMES.length + 1);
    // Each swatch is the theme in miniature: its page color with its accent as the dot.
    for (const name of THEME_NAMES) {
      const painted = await swatch(page, name).evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, dot: getComputedStyle(el.querySelector('.themedot')!).backgroundColor }));
      const rgb = (hex: string) => `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
      expect(painted, name).toEqual({ bg: rgb(THEMES[name].bg), dot: rgb(THEMES[name].accent) });
    }
    const target = isPhone(info.project.name) ? 44 : 28;
    for (const name of THEME_NAMES) { const box = (await swatch(page, name).boundingBox())!; expect(Math.min(box.width, box.height), name).toBeGreaterThanOrEqual(target); }
    // Done closes it.
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(button).toBeFocused();
    // Escape too.
    await accountMenu(page, 'Settings');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(button).toBeFocused();
    // And a press on the backdrop, outside the window.
    await accountMenu(page, 'Settings');
    await page.mouse.click(2, 2);
    await expect(dialog).toHaveCount(0);
    await expect(button).toBeFocused();
    // The focus is on the first thing in the window when it opens: the current theme.
    await accountMenu(page, 'Settings');
    await expect(swatch(page, 'midnight')).toBeFocused();
    await page.keyboard.press('Escape');
  });

  test('each theme applies at once, is saved for the account, and is still there after a reload; the other account keeps its own', async ({ page, baseURL }) => {
    await login(page, OWNER);
    await expectTheme(page, 'midnight');
    await accountMenu(page, 'Settings');
    for (const name of THEME_NAMES.filter(n => n !== 'midnight')) {
      const saved = page.waitForResponse(response => response.request().method() === 'POST' && (response.request().postData() ?? '').includes('"setTheme"'));
      await swatch(page, name).click();
      // At once: the variables are the theme's before the server has answered.
      await expectTheme(page, name);
      await expect(swatch(page, name)).toHaveAttribute('aria-pressed', 'true');
      const response = await saved;
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ theme: name });
      expect(response.headers()['cache-control']).toContain('no-store');
      for (const other of THEME_NAMES.filter(n => n !== name)) { await expect(swatch(page, other)).toHaveAttribute('aria-pressed', 'false'); }
      expect(await storedTheme(OWNER, baseURL!)).toBe(name);
      expect(await storedTheme(PARTNER, baseURL!)).toBe('midnight');
      // A reload keeps it: the server reads it back with the session.
      await page.reload();
      await expect(page.locator('#sidebar .date-row.selected')).toBeAttached();
      await expectTheme(page, name);
      await accountMenu(page, 'Settings');
      await expect(swatch(page, name)).toHaveAttribute('aria-pressed', 'true');
    }
    // Midnight again, through the same window.
    await swatch(page, 'midnight').click();
    await expectTheme(page, 'midnight');
    await expect.poll(() => storedTheme(OWNER, baseURL!)).toBe('midnight');
    expect(await browserStorage(page)).toEqual({ local: 0, session: 0, indexedDB: 0, caches: 0 });
  });

  test('a save the server refuses puts the swatch and the theme back and says so; a lost answer is not taken for a save either', async ({ page, baseURL }) => {
    await login(page, OWNER);
    await accountMenu(page, 'Settings');
    await expect(swatch(page, 'midnight')).toHaveAttribute('aria-pressed', 'true');
    // The server cannot write it (503): nothing was saved and nothing is claimed.
    const isApi = (url: URL) => url.pathname.endsWith('/api.php');
    const isTheme = (request: { method(): string; postData(): string | null }) => request.method() === 'POST' && (request.postData() ?? '').includes('"setTheme"');
    const refuse = (route: Route) => (isTheme(route.request()) ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Your theme could not be saved.', code: 'unavailable' }) }) : route.continue());
    const lose = (route: Route) => (isTheme(route.request()) ? route.abort('failed') : route.continue());
    await page.route(isApi, refuse);
    await swatch(page, 'sage').click();
    await expect(settings(page).getByRole('status')).toHaveText('Your theme could not be saved.');
    await expect(swatch(page, 'midnight')).toHaveAttribute('aria-pressed', 'true');
    await expect(swatch(page, 'sage')).toHaveAttribute('aria-pressed', 'false');
    await expectTheme(page, 'midnight');
    expect(await storedTheme(OWNER, baseURL!)).toBe('midnight');
    // The answer never arrives: the page cannot know it saved, so it goes back too.
    await page.unroute(isApi, refuse);
    await page.route(isApi, lose);
    await swatch(page, 'forest').click();
    await expect(settings(page).getByRole('status')).toContainText('stays as it was');
    await expect(swatch(page, 'midnight')).toHaveAttribute('aria-pressed', 'true');
    await expectTheme(page, 'midnight');
    // A message goes with the next pick, which works once the server does.
    await page.unroute(isApi, lose);
    await swatch(page, 'olive').click();
    await expectTheme(page, 'olive');
    await expect(settings(page).getByRole('status')).toHaveText('');
    await expect.poll(() => storedTheme(OWNER, baseURL!)).toBe('olive');
  });

  test('a save that fails after Settings was closed still says so, in the banner', async ({ page, baseURL }) => {
    await login(page, OWNER);
    await accountMenu(page, 'Settings');
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route(url => url.pathname.endsWith('/api.php'), async route => {
      if (route.request().method() === 'POST' && (route.request().postData() ?? '').includes('"setTheme"')) {
        await held;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Your theme could not be saved.', code: 'unavailable' }) });
      } else { await route.continue(); }
    });
    await swatch(page, 'sage').click();
    await expectTheme(page, 'sage');
    await page.keyboard.press('Escape');
    await expect(settings(page)).toHaveCount(0);
    await expect(page.locator('#error')).toBeHidden();
    release();
    await expect.poll(async () => (await palette(page)).bg).toBe(THEMES.midnight.bg);
    await expectTheme(page, 'midnight');
    await expect(page.locator('#error')).toBeVisible();
    await expect(page.locator('#error-message')).toHaveText('Your theme could not be saved.');
    expect(await storedTheme(OWNER, baseURL!)).toBe('midnight');
  });
});

test('the text of the account menu and of Settings clears AA in all four themes', async ({ page }) => {
  await login(page);
  await accountMenu(page);
  const menuText = '.account-button, .account-pop button';
  for (const name of THEME_NAMES) {
    await showTheme(page, name);
    for (const { text, ratio } of await textContrast(page, menuText)) { expect(ratio, `${name} menu "${text}"`).toBeGreaterThanOrEqual(MIN_CONTRAST); }
  }
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('status').evaluate(el => { el.textContent = 'Your theme could not be saved.'; });
  for (const name of THEME_NAMES) {
    await showTheme(page, name);
    for (const { text, ratio } of await textContrast(page, '.settings-title, .settings-who, .settings-label, .settings-msg')) { expect(ratio, `${name} settings "${text}"`).toBeGreaterThanOrEqual(MIN_CONTRAST); }
  }
});

test.describe('the setTheme action of the API', () => {
  const post = (api: Awaited<ReturnType<typeof apiLogin>>, data: unknown) => api.post(data);

  test('needs a session and the CSRF token, takes only the suite\'s theme names, answers no-store, and keeps each account\'s own', async ({ baseURL, playwright }) => {
    const anonymous = await playwright.request.newContext({ baseURL });
    expect((await anonymous.post(API, { data: { action: 'setTheme', theme: 'sage' }, headers: { 'X-CSRF-Token': 'x' } })).status()).toBe(401);
    await anonymous.dispose();
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER);
    try {
      // No token, a wrong token and a cross-site one are all refused with the csrf code, and nothing changes.
      for (const headers of [{}, { 'X-CSRF-Token': 'nope' }, { 'X-CSRF-Token': owner.csrf, 'Sec-Fetch-Site': 'cross-site' }] as Array<Record<string, string>>) {
        const refused = await owner.request.post(API, { data: { action: 'setTheme', theme: 'sage' }, headers });
        expect([refused.status(), (await refused.json()).code]).toEqual([403, 'csrf']);
      }
      expect(await storedTheme(OWNER, baseURL!)).toBe('midnight');
      // Names that are not one of the four: 400 invalid, whatever they look like.
      for (const theme of ['', 'Sage', 'SAGE', 'sage ', 'dark', 'light', '../sage', 'sage/../midnight', 'both', 'olive\u0000', null, 5, true, ['sage'], { name: 'sage' }]) {
        const response = await post(owner, { action: 'setTheme', theme });
        expect([response.status(), (await response.json()).code], JSON.stringify(theme)).toEqual([400, 'invalid']);
      }
      expect((await post(owner, { action: 'setTheme' })).status()).toBe(400);
      expect(await storedTheme(OWNER, baseURL!)).toBe('midnight');
      // A JSON body only.
      const wrongType = await owner.request.post(API, { headers: { 'X-CSRF-Token': owner.csrf, 'Content-Type': 'text/plain' }, data: '{"action":"setTheme","theme":"sage"}' });
      expect(wrongType.status()).toBe(415);
      // A good name is saved for the caller alone and answered with the theme and no-store.
      for (const theme of THEME_NAMES) {
        const response = await post(owner, { action: 'setTheme', theme });
        expect(response.status()).toBe(200);
        expect(await response.json()).toEqual({ theme });
        expect(response.headers()['cache-control']).toContain('no-store');
        expect(await storedTheme(OWNER, baseURL!)).toBe(theme);
        expect(await storedTheme(PARTNER, baseURL!)).toBe('midnight');
      }
      // The planner's own data is not touched by it: no write, no revision.
      const before = (await owner.snapshot()).revision;
      await post(partner, { action: 'setTheme', theme: 'forest' });
      expect((await owner.snapshot()).revision).toBe(before);
      expect(await storedTheme(PARTNER, baseURL!)).toBe('forest');
    } finally { await owner.dispose(); await partner.dispose(); }
  });

  test('an account that is not one of the two cannot set a theme', async ({ baseURL, playwright }) => {
    // The fixture's configured third account signs in at the site but is refused by the planner on every request.
    const client = await playwright.request.newContext({ baseURL });
    const form = await (await client.get('/PlanMind/')).text();
    await client.post('/PlanMind/', { form: { username: 'outsider', password: 'planmind-test-only', csrf: form.match(/name="csrf" value="([^"]+)"/)![1] } });
    const session = await client.get(API);
    expect([401, 403]).toContain(session.status());
    const write = await client.post(API, { data: { action: 'setTheme', theme: 'sage' }, headers: { 'X-CSRF-Token': 'x' } });
    expect([401, 403]).toContain(write.status());
    await client.dispose();
  });
});
