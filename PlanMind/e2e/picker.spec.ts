import { test, expect, type Locator, type Page } from '@playwright/test';
import { COLOR_KEYS, nextCustomColor, type ColorKey } from '../packages/core/src/planner';
import { API, apiLogin, browserStorage, field, login, todo, today, unique, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// The list picker and the manager. Desktop project only (the file name has no "phone"); the phone layout is
// checked at the end by giving this file a phone-sized viewport. Every list a test makes is named "Pk …", and
// afterEach removes them and puts both people's selection and the colors back, because the accounts are shared
// by every spec of the run.
const POLL = 13000;
const DEFAULTS = { [PARTNER]: 'yellow', [OWNER]: 'green', both: 'purple' } as const;
const cap = (key: string) => key[0].toUpperCase() + key.slice(1);

const button = (page: Page) => page.getByRole('button', { name: /^Lists: / });
const menu = (page: Page) => page.getByRole('group', { name: 'Lists', exact: true });
const row = (page: Page, name: string) => menu(page).locator('.picker-row').filter({ has: page.getByRole('button', { name, exact: true }) });
const select = (page: Page, name: string) => menu(page).getByRole('button', { name, exact: true });
const box = (page: Page, name: string) => menu(page).getByRole('checkbox', { name: `Show ${name}`, exact: true });
const slices = (page: Page) => page.locator('.picker-button .pie-slice');
const manager = (page: Page) => page.getByRole('region', { name: 'Manage lists' });
const tray = (page: Page, label: string) => manager(page).getByRole('radiogroup', { name: label, exact: true });
const isSavePrefs = (request: { method(): string; postData(): string | null }) => request.method() === 'POST' && (request.postData() ?? '').includes('"savePrefs"');

/** Resolves when the browser's savePrefs write has been answered. Start it before the click that causes the write. */
const prefsSaved = (page: Page) => page.waitForResponse(response => isSavePrefs(response.request()));
const selectionOf = async (api: Api) => (await api.snapshot()).prefs.selection;
const colorsOf = async (api: Api) => { const s = await api.snapshot(); return { partner: s.lists.find((l: { id: string }) => l.id === PARTNER).color, owner: s.lists.find((l: { id: string }) => l.id === OWNER).color, both: s.bothColor ?? s.settings.bothColor }; };

async function makeList(api: Api, color: ColorKey = 'blue') {
  const id = crypto.randomUUID(), name = unique('Pk');
  expect((await api.post({ action: 'saveList', id, name, color, revision: 0 })).status()).toBe(200);
  return { id, name };
}
async function openMenu(page: Page) {
  await button(page).click();
  await expect(menu(page)).toBeVisible();
}
async function openManager(page: Page) {
  await openMenu(page);
  await page.getByRole('button', { name: 'Manage lists…', exact: true }).click();
  await expect(manager(page)).toBeVisible();
}

test.afterEach(async ({ baseURL }) => {
  const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER);
  const snapshot = await owner.snapshot();
  for (const list of snapshot.lists.filter((l: { kind: string; name: string }) => l.kind === 'custom' && l.name.startsWith('Pk '))) {
    await owner.post({ action: 'deleteList', id: list.id, revision: list.revision, confirm: true });
  }
  for (const api of [owner, partner]) { await api.post({ action: 'savePrefs', selection: { base: 'both', overlays: [] } }); }
  const now = await owner.snapshot();
  for (const id of [OWNER, PARTNER] as const) {
    const list = now.lists.find((l: { id: string }) => l.id === id);
    if (list.color !== DEFAULTS[id]) { await owner.post({ action: 'saveList', id, color: DEFAULTS[id], revision: list.revision }); }
  }
  if (now.settings.bothColor !== DEFAULTS.both) { await owner.post({ action: 'saveSettings', bothColor: DEFAULTS.both, revision: now.settings.revision }); }
  // Both is a color of each person's own (#138): the picks are cleared, back to the household default.
  for (const api of [owner, partner]) { await api.post({ action: 'setBothColor', bothColor: null }); }
  await owner.dispose(); await partner.dispose();
});

test.describe('the list picker', () => {
  test(`the menu lists Both, ${PARTNER_NAME} and ${OWNER_NAME}, then custom lists in order; only custom rows have a box`, async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    const first = await makeList(owner, 'blue'), second = await makeList(owner, 'orange');
    await login(page);
    await expect(button(page)).toHaveAccessibleName('Lists: Both');
    await expect(menu(page)).toBeHidden();
    await openMenu(page);
    const labels = await menu(page).locator('.picker-label').allTextContents();
    expect(labels.slice(0, 3)).toEqual(['Both', PARTNER_NAME, OWNER_NAME]);
    expect(labels.filter(label => label.startsWith('Pk '))).toEqual([first.name, second.name]);
    // Boxes: the two custom rows only. Under Both, the partner and the owner show a plain mark and Both is the selected row.
    await expect(menu(page).getByRole('checkbox')).toHaveCount(2);
    await expect(box(page, first.name)).not.toBeChecked();
    await expect(select(page, 'Both')).toHaveAttribute('aria-current', 'true');
    for (const name of [PARTNER_NAME, OWNER_NAME]) { await expect(row(page, name).locator('.picker-mark')).toHaveCount(1); await expect(row(page, name).locator('input')).toHaveCount(0); }
    await expect(row(page, 'Both').locator('.swatch')).toHaveAttribute('data-c', 'purple');
    await expect(row(page, PARTNER_NAME).locator('.swatch')).toHaveAttribute('data-c', 'yellow');
    await expect(row(page, OWNER_NAME).locator('.swatch')).toHaveAttribute('data-c', 'green');
    await expect(row(page, first.name).locator('.swatch')).toHaveAttribute('data-c', 'blue');
    // Under Both the button is one disc in the Both color, not an the partner + the owner pie.
    await expect(slices(page)).toHaveCount(1);
    await expect(slices(page).first()).toHaveAttribute('data-c', 'purple');
    await owner.dispose();
  });

  test('tapping a row shows that list alone; ticking a box adds it on top; each change is saved for this person', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    const camp = await makeList(owner, 'blue');
    await login(page);
    await openMenu(page);
    let saved = prefsSaved(page);
    await select(page, OWNER_NAME).click();
    await saved;
    await expect(menu(page)).toBeHidden();
    await expect(button(page)).toHaveAccessibleName(`Lists: ${OWNER_NAME}`);
    expect(await selectionOf(owner)).toEqual({ base: OWNER, overlays: [] });

    await openMenu(page);
    await expect(select(page, OWNER_NAME)).toHaveAttribute('aria-current', 'true');
    await expect(row(page, PARTNER_NAME).locator('.picker-mark')).toHaveCount(0);
    saved = prefsSaved(page);
    await box(page, camp.name).click();
    await saved;
    await expect(menu(page)).toBeVisible();
    await expect(box(page, camp.name)).toBeChecked();
    await expect(select(page, OWNER_NAME)).toHaveAttribute('aria-current', 'true');
    await expect(button(page)).toHaveAccessibleName(`Lists: ${OWNER_NAME} + ${camp.name}`);
    await expect(slices(page)).toHaveCount(2);
    await expect(slices(page).nth(0)).toHaveAttribute('data-c', 'green');
    await expect(slices(page).nth(1)).toHaveAttribute('data-c', 'blue');
    expect(await selectionOf(owner)).toEqual({ base: OWNER, overlays: [camp.id] });

    // A tap on another row is that row alone: the overlay goes.
    saved = prefsSaved(page);
    await select(page, PARTNER_NAME).click();
    await saved;
    expect(await selectionOf(owner)).toEqual({ base: PARTNER, overlays: [] });
    await openMenu(page);
    await expect(box(page, camp.name)).not.toBeChecked();
    // A custom list tapped alone is the base, and its own box is live and ticked.
    saved = prefsSaved(page);
    await select(page, camp.name).click();
    await saved;
    await expect(button(page)).toHaveAccessibleName(`Lists: ${camp.name}`);
    await expect(slices(page)).toHaveCount(1);
    await expect(slices(page).first()).toHaveAttribute('data-c', 'blue');
    await owner.dispose();
  });

  test('Both never includes a custom list implicitly', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    const camp = await makeList(owner, 'blue');
    await login(page);
    await openMenu(page);
    await expect(box(page, camp.name)).not.toBeChecked();
    expect(await selectionOf(owner)).toEqual({ base: 'both', overlays: [] });
    // Ticked on top of Both, it is an overlay of this view only.
    let saved = prefsSaved(page);
    await box(page, camp.name).click();
    await saved;
    await expect(button(page)).toHaveAccessibleName(`Lists: Both + ${camp.name}`);
    expect(await selectionOf(owner)).toEqual({ base: 'both', overlays: [camp.id] });
    // Choosing Both again is Both alone, whatever was ticked, and so is coming back to it from another list.
    saved = prefsSaved(page);
    await select(page, 'Both').click();
    await saved;
    expect(await selectionOf(owner)).toEqual({ base: 'both', overlays: [] });
    await openMenu(page);
    await expect(box(page, camp.name)).not.toBeChecked();
    saved = prefsSaved(page);
    await select(page, OWNER_NAME).click();
    await saved;
    await openMenu(page);
    saved = prefsSaved(page);
    await select(page, 'Both').click();
    await saved;
    expect(await selectionOf(owner)).toEqual({ base: 'both', overlays: [] });
    await expect(slices(page)).toHaveCount(1);
    await owner.dispose();
  });

  test('unticking the custom list that is the base lands on Both and keeps the other overlay', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    const camp = await makeList(owner, 'blue'), home = await makeList(owner, 'orange');
    await login(page);
    await openMenu(page);
    let saved = prefsSaved(page);
    await select(page, camp.name).click();
    await saved;
    await openMenu(page);
    await expect(box(page, camp.name)).toBeChecked();
    await expect(box(page, camp.name)).not.toHaveAttribute('aria-disabled', 'true');
    saved = prefsSaved(page);
    await box(page, home.name).click();
    await saved;
    expect(await selectionOf(owner)).toEqual({ base: camp.id, overlays: [home.id] });
    saved = prefsSaved(page);
    await box(page, camp.name).click();
    await saved;
    await expect(select(page, 'Both')).toHaveAttribute('aria-current', 'true');
    await expect(box(page, camp.name)).not.toBeChecked();
    await expect(box(page, home.name)).toBeChecked();
    await expect(button(page)).toHaveAccessibleName(`Lists: Both + ${home.name}`);
    expect(await selectionOf(owner)).toEqual({ base: 'both', overlays: [home.id] });
    await owner.dispose();
  });

  test('a third overlay is refused, and the menu says why', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    const one = await makeList(owner, 'blue'), two = await makeList(owner, 'orange'), three = await makeList(owner, 'teal');
    await login(page);
    await openMenu(page);
    for (const list of [one, two]) {
      const saved = prefsSaved(page);
      await box(page, list.name).click();
      await saved;
    }
    const hint = menu(page).locator('.picker-hint');
    await expect(hint).toBeHidden();
    await expect(box(page, three.name)).toHaveAttribute('aria-disabled', 'true');
    // aria-disabled, not disabled: a press still lands, so the person is told why nothing happened (force skips the enabled check).
    await box(page, three.name).click({ force: true });
    await expect(hint).toHaveText('Up to 2 extra lists');
    await expect(box(page, three.name)).not.toBeChecked();
    await expect(button(page)).toHaveAccessibleName(`Lists: Both + ${one.name} + ${two.name}`);
    expect(await selectionOf(owner)).toEqual({ base: 'both', overlays: [one.id, two.id] });
    // Making room takes the hint and the lock away.
    const saved = prefsSaved(page);
    await box(page, one.name).click();
    await saved;
    await expect(hint).toBeHidden();
    await expect(box(page, three.name)).not.toHaveAttribute('aria-disabled', 'true');
    await owner.dispose();
  });

  test('changes are saved after a pause, as one write with the final selection', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    const camp = await makeList(owner, 'blue'), home = await makeList(owner, 'orange');
    await page.clock.install();
    await login(page);
    const writes: string[] = [];
    page.on('request', request => { if (isSavePrefs(request)) { writes.push(request.postData()!); } });
    await openMenu(page);
    await box(page, camp.name).click();
    await box(page, home.name).click();
    await box(page, camp.name).click();
    await page.clock.runFor(300);
    expect(writes).toHaveLength(0);
    await page.clock.runFor(200);
    await expect.poll(() => writes.length).toBe(1);
    expect(JSON.parse(writes[0]).selection).toEqual({ base: 'both', overlays: [home.id] });
    await owner.dispose();
  });

  test('a failed save of the selection is silent and the view keeps what was picked', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    const camp = await makeList(owner, 'blue');
    await page.clock.install();
    await login(page);
    await page.route(url => url.pathname === API, route => isSavePrefs(route.request()) ? route.abort('failed') : route.continue());
    await openMenu(page);
    await box(page, camp.name).click();
    await page.clock.runFor(500);
    await expect(button(page)).toHaveAccessibleName(`Lists: Both + ${camp.name}`);
    await expect(page.locator('#error')).toBeHidden();
    expect(await selectionOf(owner)).toEqual({ base: 'both', overlays: [] });
    await owner.dispose();
  });

  test('the selection survives a reload and a second browser of the same person, and differs for the other person', async ({ page, browser, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    const camp = await makeList(owner, 'blue');
    await login(page);
    await openMenu(page);
    let saved = prefsSaved(page);
    await select(page, OWNER_NAME).click();
    await saved;
    await openMenu(page);
    saved = prefsSaved(page);
    await box(page, camp.name).click();
    await saved;
    const name = `Lists: ${OWNER_NAME} + ${camp.name}`;
    await page.reload();
    await expect(button(page)).toHaveAccessibleName(name);

    const second = await browser.newContext({ baseURL });
    const again = await second.newPage();
    await login(again, OWNER);
    await expect(button(again)).toHaveAccessibleName(name);
    const other = await browser.newContext({ baseURL });
    const partner = await other.newPage();
    await login(partner, PARTNER);
    await expect(button(partner)).toHaveAccessibleName('Lists: Both');
    await openMenu(partner);
    await expect(box(partner, camp.name)).not.toBeChecked();
    await second.close(); await other.close();
    await owner.dispose();
  });

  test('the open menu follows the lists: a list deleted by the other person is gone and the selection heals', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER);
    const camp = await makeList(owner, 'blue'), home = await makeList(owner, 'orange');
    expect((await owner.post({ action: 'savePrefs', selection: { base: camp.id, overlays: [home.id] } })).status()).toBe(200);
    await page.clock.install();
    await login(page);
    await expect(button(page)).toHaveAccessibleName(`Lists: ${camp.name} + ${home.name}`);
    await openMenu(page);
    const list = (await partner.snapshot()).lists.find((l: { id: string }) => l.id === camp.id);
    expect((await partner.post({ action: 'deleteList', id: camp.id, revision: list.revision, confirm: true })).status()).toBe(200);
    await page.clock.runFor(POLL);
    await expect(menu(page).getByRole('button', { name: camp.name, exact: true })).toHaveCount(0);
    await expect(button(page)).toHaveAccessibleName(`Lists: Both + ${home.name}`);
    await expect(box(page, home.name)).toBeChecked();
    await owner.dispose(); await partner.dispose();
  });

  test('Escape and a click outside close the menu; Escape gives focus back to the button; arrow keys walk the rows', async ({ page }) => {
    await login(page);
    await openMenu(page);
    await expect(select(page, 'Both')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(select(page, PARTNER_NAME)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    // Up from the first row wraps to the last item of the menu, The rhythm…, and the item above it is Manage lists….
    await expect(page.getByRole('button', { name: 'The rhythm…', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('button', { name: 'Manage lists…', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(button(page)).toBeFocused();
    await openMenu(page);
    await page.locator('.page-header h1').click();
    await expect(menu(page)).toBeHidden();
    await expect(button(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('the picker keeps nothing in browser storage', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    const camp = await makeList(owner, 'blue');
    await login(page);
    await openMenu(page);
    const saved = prefsSaved(page);
    await box(page, camp.name).click();
    await saved;
    await page.getByRole('button', { name: 'Manage lists…', exact: true }).click();
    await manager(page).getByRole('button', { name: `Edit ${camp.name}`, exact: true }).click();
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(button(page)).toHaveAccessibleName(`Lists: Both + ${camp.name}`);
    expect(await browserStorage(page)).toEqual({ local: 0, session: 0, indexedDB: 0, caches: 0 });
    await owner.dispose();
  });

  const chores = (page: Page) => menu(page).getByRole('switch', { name: 'Chores', exact: true });

  test('a window crossing the phone breakpoint with the menu open redraws it: the desktop-only Chores switch is never in the phone menu, and the keyboard stays in the menu', async ({ page }) => {
    await login(page);
    await openMenu(page);
    await expect(chores(page)).toBeVisible();
    await chores(page).focus();
    const rows = await menu(page).locator('.picker-row').count();
    // Down to a phone's width (the window narrows, the menu stays open): the row is gone, and the keyboard is on the row that is chosen, not on the page.
    await page.setViewportSize({ width: 700, height: 900 });
    await expect(menu(page)).toBeVisible();
    await expect(chores(page)).toHaveCount(0);
    await expect(menu(page).locator('.picker-row')).toHaveCount(rows - 1);
    await expect(select(page, 'Both')).toBeFocused();
    // And back: the switch returns to the open menu.
    await page.setViewportSize({ width: 1360, height: 900 });
    await expect(menu(page)).toBeVisible();
    await expect(chores(page)).toBeVisible();
    await expect(menu(page).locator('.picker-row')).toHaveCount(rows);
  });

  test('with Chores on, the window crossing the breakpoint closes the open menu: the phone has no menu there, just the grey locked house', async ({ page }) => {
    await login(page);
    await openMenu(page);
    await chores(page).click();
    await expect(menu(page)).toBeHidden();
    await openMenu(page);
    await expect(chores(page)).toHaveAttribute('aria-checked', 'true');
    // The keyboard is on the switch of the menu that goes away: it goes to the (locked) button, never to the page.
    await chores(page).focus();
    await page.setViewportSize({ width: 700, height: 900 });
    await expect(menu(page)).toBeHidden();
    await expect(page.locator('#picker-button')).toBeFocused();
    await expect(page.locator('#picker-button')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#picker-button')).not.toHaveAttribute('aria-expanded', /.*/);
    // Back on a desktop it opens again, with the switch on and the lists as they were.
    await page.setViewportSize({ width: 1360, height: 900 });
    await expect(page.locator('#picker-button')).not.toHaveAttribute('aria-disabled', /.*/);
    await openMenu(page);
    await expect(chores(page)).toHaveAttribute('aria-checked', 'true');
    await expect(select(page, 'Both')).toHaveAttribute('aria-current', 'true');
  });
});

test.describe('the list manager', () => {
  test('Manage lists is a panel of the page, not a window: no dialog layer, over the page under the top bar, the focus on its heading, the page behind out of reach, Escape and Close give the page back', async ({ page }, info) => {
    await login(page);
    const phone = info.project.name === 'phone';
    const content = (await page.locator('#content').boundingBox())!, bar = (await page.locator('.topbar').boundingBox())!;
    await (phone ? button(page).tap() : button(page).click());
    await page.getByRole('button', { name: 'Manage lists…', exact: true }).click();
    await expect(manager(page)).toBeVisible();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(manager(page).getByRole('heading', { name: 'Manage lists', level: 2 })).toBeFocused();
    const box = (await manager(page).boundingBox())!;
    expect(box.y, 'the panel starts under the top bar').toBeGreaterThanOrEqual(bar.y + bar.height - 1);
    expect(box.x + box.width, 'inside the page column').toBeLessThanOrEqual(content.x + content.width + 1);
    // The top bar stays and works (the picker opens over the panel); the planner page behind is inert.
    await expect(button(page)).toBeVisible();
    await expect(page.locator('.page')).toHaveAttribute('inert', '');
    expect(await page.evaluate(() => { const r = document.querySelector('#content .page')!.getBoundingClientRect(); const el = document.elementFromPoint(r.x + r.width / 2, r.y + 120); return !!el?.closest('.manager-page'); }), 'the panel is what a click reaches').toBe(true);
    await page.keyboard.press('Escape');
    await expect(manager(page)).toHaveCount(0);
    await expect(page.locator('.page')).not.toHaveAttribute('inert', '');
    await expect(button(page)).toBeFocused();
    // Reopened, Close does the same, and the keyboard cannot reach the page behind it.
    await (phone ? button(page).tap() : button(page).click());
    await page.getByRole('button', { name: 'Manage lists…', exact: true }).click();
    for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); expect(await page.evaluate(() => !!document.activeElement?.closest('.page'))).toBe(false); }
    await manager(page).getByRole('button', { name: 'Close lists', exact: true }).click();
    await expect(manager(page)).toHaveCount(0);
    await expect(button(page)).toBeFocused();
  });

  test(`${PARTNER_NAME}, ${OWNER_NAME} and Both have a color and nothing else: no rename and no delete`, async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    for (const id of [PARTNER, OWNER, 'both']) {
      const refused = await owner.post({ action: 'deleteList', id, revision: 1, confirm: true });
      expect([id, refused.status()]).toEqual([id, 400]);
    }
    await owner.dispose();
    await login(page);
    await openManager(page);
    for (const name of [PARTNER_NAME, OWNER_NAME, 'Both']) { await expect(tray(page, `Color for ${name}`).getByRole('radio')).toHaveCount(COLOR_KEYS.length); }
    await expect(manager(page).getByRole('button', { name: /^Edit /})).toHaveCount(0);
    await expect(manager(page).getByRole('button', { name: /^Delete /})).toHaveCount(0);
    await expect(manager(page).getByText('No lists of your own yet.')).toBeVisible();
    await expect(manager(page).locator('h3', { hasText: 'Your lists' })).toContainText('0 of 12');
  });

  test('add a list: the color starts at the next one in the cycle, can be changed, and the list shows in the picker', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    await login(page);
    await openManager(page);
    const expected = nextCustomColor((await owner.snapshot()).lists);
    const newTray = tray(page, 'Color for the new list');
    await expect(newTray.getByRole('radio', { name: cap(expected), exact: true })).toBeChecked();
    const name = unique('Pk');
    const input = manager(page).getByLabel('New list name', { exact: true });
    const add = manager(page).getByRole('button', { name: 'Add list', exact: true });
    await expect(add).toBeDisabled();
    await input.fill(name);
    await expect(manager(page).locator('[data-count=add]')).toHaveText(`${[...name].length} / 24`);
    await newTray.getByRole('radio', { name: 'Pink', exact: true }).click();
    await add.click();
    await expect(manager(page).getByRole('button', { name: `Edit ${name}`, exact: true })).toBeVisible();
    await expect(input).toHaveValue('');
    const made = (await owner.snapshot()).lists.find((l: { name: string }) => l.name === name);
    expect(made).toMatchObject({ kind: 'custom', color: 'pink', name });
    await expect(manager(page).locator('h3', { hasText: 'Your lists' })).toContainText('1 of 12');
    await manager(page).getByRole('button', { name: 'Close lists', exact: true }).click();
    await expect(manager(page)).toBeHidden();
    await expect(button(page)).toBeFocused();
    // A new list is not shown anywhere until it is picked.
    await expect(button(page)).toHaveAccessibleName('Lists: Both');
    await openMenu(page);
    await expect(row(page, name).locator('.swatch')).toHaveAttribute('data-c', 'pink');
    await expect(box(page, name)).not.toBeChecked();
    await owner.dispose();
  });

  test('a reserved or taken name is refused in the panel and the draft stays; a name over 24 characters cannot be added', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    const camp = await makeList(owner, 'blue');
    await login(page);
    await openManager(page);
    const input = manager(page).getByLabel('New list name', { exact: true });
    const add = manager(page).getByRole('button', { name: 'Add list', exact: true });
    const alert = manager(page).getByRole('alert');
    await input.fill(PARTNER);
    await add.click();
    await expect(alert).toContainText('reserved');
    await expect(input).toHaveValue(PARTNER);
    await input.fill(camp.name.toUpperCase());
    await add.click();
    await expect(alert).toContainText('already exists');
    await expect(input).toHaveValue(camp.name.toUpperCase());
    const long = 'x'.repeat(24) + 'é';
    await input.fill(long);
    await expect(manager(page).locator('[data-count=add]')).toHaveText('25 / 24');
    await expect(add).toBeDisabled();
    await input.fill('😀'.repeat(24));
    await expect(manager(page).locator('[data-count=add]')).toHaveText('24 / 24');
    await expect(add).toBeEnabled();
    await owner.dispose();
  });

  test('rename and recolor a list in its own row, then delete it in two presses that name what goes with it', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    const camp = await makeList(owner, 'blue');
    const day = today();
    const owned = todo({ owners: [camp.id], title: unique('Tent') });
    expect((await owner.post(owned)).status()).toBe(200);
    expect((await owner.post({ action: 'saveNote', scope: 'day', period: day, listId: camp.id, field: 'notes', text: 'Gear list', revision: 0 })).status()).toBe(200);
    await login(page);
    await openManager(page);
    const open = manager(page).getByRole('button', { name: `Edit ${camp.name}`, exact: true });
    const was = (await open.boundingBox())!;
    await open.click();
    const renamed = unique('Pk ren').slice(0, 24);
    const name = field(page, `Edit list: ${camp.name}`);
    await expect(name).toBeFocused();
    await expect(name).toHaveValue(camp.name);
    // The name is a field in the list's own row, the same size as the name it replaces; the counter, Delete and the swatches join it. No second window.
    const row = manager(page).locator('li[data-editing]');
    const now = (await name.boundingBox())!;
    expect(Math.abs(now.y + now.height / 2 - (was.y + was.height / 2)), 'the name stays on its line').toBeLessThanOrEqual(12);
    await expect(row.locator('[data-count=edit]')).toHaveText(`${[...camp.name].length} / 24`);
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await name.fill(renamed);
    // The swatches are in the row: the focus moving to one of them is not leaving it.
    await tray(page, `Color for ${camp.name}`).getByRole('radio', { name: 'Teal', exact: true }).click();
    await expect(row).toHaveCount(1);
    expect((await owner.snapshot()).lists.find((l: { id: string }) => l.id === camp.id)).toMatchObject({ name: camp.name, color: 'blue' });
    await name.press('Enter');
    await expect(manager(page).getByRole('button', { name: `Edit ${renamed}`, exact: true })).toBeVisible();
    await expect(name).toHaveCount(0);
    expect((await owner.snapshot()).lists.find((l: { id: string }) => l.id === camp.id)).toMatchObject({ name: renamed, color: 'teal' });

    await manager(page).getByRole('button', { name: `Edit ${renamed}`, exact: true }).click();
    const deletes: string[] = [];
    page.on('request', request => { if (request.method() === 'POST' && request.url().includes('api.php') && request.postDataJSON().action === 'deleteList') { deletes.push('deleteList'); } });
    await manager(page).getByRole('button', { name: `Delete list: ${renamed}`, exact: true }).click();
    // The first press says what goes with the list, in the row, and turns the icon red: it is now Confirm delete.
    await expect(manager(page).locator('.manager-row-message')).toHaveText(`Delete ${renamed} with 1 item and 1 note?`);
    const second = manager(page).getByRole('button', { name: 'Confirm delete', exact: true });
    await expect(second).toBeVisible();
    // The first press changed nothing (no write was sent; a round trip here would race the icon forgetting the press after 2.5 s).
    expect(deletes).toEqual([]);
    await second.click();
    await expect(manager(page).getByRole('button', { name: `Edit ${renamed}`, exact: true })).toHaveCount(0);
    const after = await owner.snapshot();
    expect(after.lists.some((l: { id: string }) => l.id === camp.id)).toBe(false);
    expect(after.tasks.some((t: { id: string }) => t.id === owned.id)).toBe(false);
    expect(after.notes.some((n: { listId: string }) => n.listId === camp.id)).toBe(false);
    await owner.dispose();
  });

  test('Escape and the clock leave the list alone, and a second press never happens by itself', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    const camp = await makeList(owner, 'blue');
    await login(page);
    await openManager(page);
    await manager(page).getByRole('button', { name: `Edit ${camp.name}`, exact: true }).click();
    const name = field(page, `Edit list: ${camp.name}`);
    await name.fill('Changed my mind');
    await manager(page).getByRole('button', { name: `Delete list: ${camp.name}`, exact: true }).click();
    await expect(manager(page).getByRole('button', { name: 'Confirm delete', exact: true })).toBeVisible();
    // Left alone the press is forgotten after a few seconds, not the typing; Escape gives that up and closes the row, not the manager.
    await expect(manager(page).getByRole('button', { name: `Delete list: ${camp.name}`, exact: true })).toBeVisible({ timeout: 6000 });
    await expect(name).toHaveValue('Changed my mind');
    await name.press('Escape');
    await expect(manager(page)).toBeVisible();
    await expect(manager(page).getByRole('button', { name: `Edit ${camp.name}`, exact: true })).toBeFocused();
    await manager(page).getByRole('button', { name: `Edit ${camp.name}`, exact: true }).click();
    await expect(manager(page).getByRole('button', { name: `Delete list: ${camp.name}`, exact: true })).toBeVisible();
    await expect(field(page, `Edit list: ${camp.name}`)).toHaveValue(camp.name);
    // From the keyboard: moving on from Delete to the name forgets the first press.
    const trash = manager(page).locator('.manager-trash');
    await trash.focus();
    await page.keyboard.press('Enter');
    await expect(trash).toHaveAccessibleName('Confirm delete');
    await page.keyboard.press('Shift+Tab');
    await expect(trash).toHaveAccessibleName(`Delete list: ${camp.name}`);
    const list = (await owner.snapshot()).lists.find((l: { id: string }) => l.id === camp.id);
    expect(list).toMatchObject({ name: camp.name, color: 'blue', revision: 1 });
    await owner.dispose();
  });

  test('a row is saved when the focus leaves it and not before; an emptied name is put back, and Enter on one asks for text or Delete', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    const camp = await makeList(owner, 'blue'), other = await makeList(owner, 'red');
    await login(page);
    await openManager(page);
    const stored = async (id: string) => (await owner.snapshot()).lists.find((l: { id: string }) => l.id === id);
    await manager(page).getByRole('button', { name: `Edit ${camp.name}`, exact: true }).click();
    const name = field(page, `Edit list: ${camp.name}`);
    // Tab from the name goes to the row's own controls and the row stays open; the list is not written.
    await name.fill('Moved on');
    await page.keyboard.press('Tab');
    await expect(manager(page).locator('li[data-editing]')).toHaveCount(1);
    expect(await stored(camp.id)).toMatchObject({ name: camp.name, revision: 1 });
    // Another list's row takes the focus: that is leaving, so the first is saved (once), and the other one opens.
    await manager(page).getByRole('button', { name: `Edit ${other.name}`, exact: true }).click();
    await expect(field(page, `Edit list: ${other.name}`)).toBeFocused();
    expect(await stored(camp.id)).toMatchObject({ name: 'Moved on', revision: 2 });
    await expect(manager(page).locator('li[data-editing]')).toHaveCount(1);
    // An emptied name: Enter keeps the row and asks; leaving puts the old name back, with nothing written.
    const empty = field(page, `Edit list: ${other.name}`);
    await empty.fill('');
    await empty.press('Enter');
    await expect(manager(page).locator('.manager-row-message')).toHaveText('Type a name, or use Delete.');
    await manager(page).getByRole('heading', { name: 'Manage lists' }).click();
    await expect(manager(page).getByRole('button', { name: `Edit ${other.name}`, exact: true })).toBeVisible();
    expect(await stored(other.id)).toMatchObject({ name: other.name, revision: 1 });
    // A name over 24 characters is not written, the counter turns, the row says why.
    await manager(page).getByRole('button', { name: `Edit ${other.name}`, exact: true }).click();
    await field(page, `Edit list: ${other.name}`).fill('x'.repeat(25));
    await expect(manager(page).locator('[data-count=edit]')).toHaveText('25 / 24');
    await field(page, `Edit list: ${other.name}`).press('Enter');
    await expect(manager(page).locator('.manager-row-message')).toHaveText('Keep it to 24 characters.');
    expect(await stored(other.id)).toMatchObject({ name: other.name, revision: 1 });
    await owner.dispose();
  });

  test(`recolor ${PARTNER_NAME}, ${OWNER_NAME} and Both; the picker and its button follow`, async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    await login(page);
    await openManager(page);
    await tray(page, `Color for ${PARTNER_NAME}`).getByRole('radio', { name: 'Blue', exact: true }).click();
    await expect.poll(async () => (await colorsOf(owner)).partner).toBe('blue');
    await tray(page, `Color for ${OWNER_NAME}`).getByRole('radio', { name: 'Red', exact: true }).click();
    await expect.poll(async () => (await colorsOf(owner)).owner).toBe('red');
    await tray(page, 'Color for Both').getByRole('radio', { name: 'Orange', exact: true }).click();
    await expect.poll(async () => (await colorsOf(owner)).both).toBe('orange');
    await expect(tray(page, 'Color for Both').getByRole('radio', { name: 'Orange', exact: true })).toBeChecked();
    await manager(page).getByRole('button', { name: 'Close lists', exact: true }).click();
    await expect(slices(page).first()).toHaveAttribute('data-c', 'orange');
    await openMenu(page);
    await expect(row(page, 'Both').locator('.swatch')).toHaveAttribute('data-c', 'orange');
    await expect(row(page, PARTNER_NAME).locator('.swatch')).toHaveAttribute('data-c', 'blue');
    await expect(row(page, OWNER_NAME).locator('.swatch')).toHaveAttribute('data-c', 'red');
    // The list colors are the household's, so the other person sees them; Both is each person's own, so the partner still has the default (e2e/both-color.spec.ts).
    const partner = await apiLogin(baseURL!, PARTNER);
    const seen = await colorsOf(partner);
    expect([seen.partner, seen.owner, seen.both]).toEqual(['blue', 'red', 'purple']);
    await partner.dispose(); await owner.dispose();
  });

  test('a stale rename keeps the typed name and says what happened', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER);
    const camp = await makeList(owner, 'blue');
    await login(page);
    await openManager(page);
    await manager(page).getByRole('button', { name: `Edit ${camp.name}`, exact: true }).click();
    await field(page, `Edit list: ${camp.name}`).fill('Pk typed here');
    // The other person recolors it first, so the revision the page holds is old.
    const list = (await partner.snapshot()).lists.find((l: { id: string }) => l.id === camp.id);
    expect((await partner.post({ action: 'saveList', id: camp.id, name: camp.name, color: 'orange', revision: list.revision })).status()).toBe(200);
    await field(page, `Edit list: ${camp.name}`).press('Enter');
    await expect(manager(page).locator('.manager-row-message')).toContainText('Refresh to see the latest');
    await expect(field(page, `Edit list: ${camp.name}`)).toHaveValue('Pk typed here');
    // The refresh that follows a stale answer brings the new revision, so Enter again goes through.
    await expect.poll(async () => (await page.evaluate(() => document.querySelector('.manager-input') !== null))).toBe(true);
    await field(page, `Edit list: ${camp.name}`).press('Enter');
    await expect(manager(page).getByRole('button', { name: 'Edit Pk typed here', exact: true })).toBeVisible();
    await owner.dispose(); await partner.dispose();
  });

  test('a rename is judged on the version the row was opened on: a change that arrived while the name was typed is refused, not written over', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER);
    const camp = await makeList(owner, 'blue');
    await login(page);
    await openManager(page);
    await manager(page).getByRole('button', { name: `Edit ${camp.name}`, exact: true }).click();
    await field(page, `Edit list: ${camp.name}`).fill('Pk typed twice');
    // The other person recolors it, and the page learns of it (a poll) before Enter: the page's own copy of the list is the new one now.
    const list = (await partner.snapshot()).lists.find((l: { id: string }) => l.id === camp.id);
    expect((await partner.post({ action: 'saveList', id: camp.id, name: camp.name, color: 'orange', revision: list.revision })).status()).toBe(200);
    const polled = page.waitForResponse(response => response.request().method() === 'GET' && response.url().includes('api.php'));
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await polled;
    await page.waitForTimeout(150);
    await field(page, `Edit list: ${camp.name}`).press('Enter');
    await expect(manager(page).locator('.manager-row-message')).toContainText('Refresh to see the latest');
    await expect(manager(page).locator('.manager-row-message')).toContainText('Enter saves yours over it');
    await expect(field(page, `Edit list: ${camp.name}`)).toHaveValue('Pk typed twice');
    expect((await owner.snapshot()).lists.find((l: { id: string }) => l.id === camp.id)).toMatchObject({ name: camp.name, color: 'orange' });
    // Enter again says yes to theirs being replaced: the name is saved over their version.
    await field(page, `Edit list: ${camp.name}`).press('Enter');
    await expect(manager(page).getByRole('button', { name: 'Edit Pk typed twice', exact: true })).toBeVisible();
    expect((await owner.snapshot()).lists.find((l: { id: string }) => l.id === camp.id)).toMatchObject({ name: 'Pk typed twice' });
    await owner.dispose(); await partner.dispose();
  });

  test('twelve lists is the most; the form says so', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    const { lists } = await owner.snapshot();
    const room = 12 - lists.filter((l: { kind: string }) => l.kind === 'custom').length;
    for (let n = 0; n < room; n++) { await makeList(owner, 'gray'); }
    await login(page);
    await openManager(page);
    await expect(manager(page).getByText('the most there can be')).toBeVisible();
    await expect(manager(page).getByLabel('New list name', { exact: true })).toHaveCount(0);
    await owner.dispose();
  });
});

// The same file on a phone-sized screen: the project is the desktop one, so the viewport is set here.
test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test('the round button is in the top bar, the menu fits the screen and the manager scrolls inside itself', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER);
    const camp = await makeList(owner, 'blue');
    await login(page);
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    await expect(button(page)).toBeVisible();
    await expect(page.locator('.picker-name')).toBeHidden();
    const round = (await button(page).boundingBox())!;
    expect(round.width).toBeGreaterThanOrEqual(44);
    expect(round.height).toBeGreaterThanOrEqual(44);
    expect(round.x + round.width).toBeLessThanOrEqual(375);
    expect(round.y + round.height).toBeLessThanOrEqual(60);
    await button(page).tap();
    await expect(menu(page)).toBeVisible();
    const open = (await menu(page).boundingBox())!;
    expect(open.x).toBeGreaterThanOrEqual(0);
    expect(open.x + open.width).toBeLessThanOrEqual(375);
    for (const target of [select(page, OWNER_NAME), box(page, camp.name)]) {
      const size = (await target.boundingBox())!;
      expect(size.height).toBeGreaterThanOrEqual(20);
    }
    expect((await select(page, OWNER_NAME).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await fits()).toBe(true);
    const saved = prefsSaved(page);
    await box(page, camp.name).tap();
    await saved;
    await expect(button(page)).toHaveAccessibleName(`Lists: Both + ${camp.name}`);
    await expect(slices(page)).toHaveCount(2);
    await page.getByRole('button', { name: 'Manage lists…', exact: true }).tap();
    await expect(manager(page)).toBeVisible();
    const sheet = (await manager(page).boundingBox())!;
    expect(sheet.x).toBeGreaterThanOrEqual(0);
    expect(sheet.x + sheet.width).toBeLessThanOrEqual(375);
    expect(sheet.y + sheet.height).toBeLessThanOrEqual(812);
    expect(await fits()).toBe(true);
    // Every swatch of the tray is on screen and big enough to hit.
    const swatches = tray(page, `Color for ${PARTNER_NAME}`).locator('.tray-swatch');
    await expect(swatches).toHaveCount(COLOR_KEYS.length);
    for (const swatch of await swatches.all()) {
      const box = (await swatch.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width).toBeLessThanOrEqual(375);
    }
    await manager(page).getByRole('button', { name: 'Close lists', exact: true }).tap();
    await expect(button(page)).toBeFocused();
    await owner.dispose();
  });
});
