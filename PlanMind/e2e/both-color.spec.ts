import { expect, test, type Browser, type Page } from '@playwright/test';
import { addTodo, apiLogin, farDate, login, resetPrefs, type Api, type User } from './helpers';
import { OWNER, PARTNER } from './people';

// The Both color is each person's own (the owner, 2026-11-09, #138). It is an account preference beside the theme, not planner data: the
// household's settings.bothColor stays the default until someone picks, a pick shows everywhere Both is colored for that person only,
// and the other person's views do not move. Desktop project.
const DAY = farDate(1500);
const clearDay = async (api: Api, date: string) => {
  const snapshot = await api.snapshot();
  for (const item of [...snapshot.tasks, ...snapshot.events].filter((i: { date: string }) => i.date === date)) {
    await api.post({ action: 'delete', id: item.id, revision: item.revision, confirm: true });
  }
};
const openDay = async (page: Page, date: string) => {
  await page.locator('#jump-date').fill(date);
  await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', date);
};
const manager = (page: Page) => page.getByRole('region', { name: 'Manage lists' });
const tray = (page: Page, label: string) => manager(page).getByRole('radiogroup', { name: label, exact: true });
const pick = async (page: Page, color: string) => {
  await page.getByRole('button', { name: /^Lists: / }).click();
  await page.getByRole('button', { name: 'Manage lists…', exact: true }).click();
  await expect(manager(page)).toBeVisible();
  await tray(page, 'Color for Both').getByRole('radio', { name: color, exact: true }).click();
  await expect(tray(page, 'Color for Both').getByRole('radio', { name: color, exact: true })).toBeChecked();
  await manager(page).getByRole('button', { name: 'Close lists', exact: true }).click();
};
const both = (page: Page) => page.locator('.day-task', { has: page.getByRole('button', { name: 'Edit Both thing', exact: true }) }).locator('.day-circle');
const entry = (page: Page) => page.getByRole('button', { name: /^Lunch together, / });
const buttonSlice = (page: Page) => page.locator('.picker-button .pie-slice').first();
async function person(browser: Browser, baseURL: string, user: User) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  await login(page, user);
  await openDay(page, DAY);
  return page;
}

test.beforeEach(async ({ baseURL }) => {
  await resetPrefs(baseURL!);
  const owner = await apiLogin(baseURL!, OWNER);
  await owner.post({ action: 'add', kind: 'todo', id: crypto.randomUUID(), scope: 'day', date: DAY, owners: [OWNER, PARTNER], title: 'Both thing' });
  await owner.post({ action: 'add', kind: 'event', id: crypto.randomUUID(), date: DAY, owners: [OWNER, PARTNER], text: 'Lunch together', start: 720, length: 60 });
  await owner.dispose();
});
test.afterEach(async ({ baseURL }) => {
  const owner = await apiLogin(baseURL!, OWNER);
  await clearDay(owner, DAY);
  await owner.dispose();
  await resetPrefs(baseURL!);
});

test('with no pick nothing changes: both people see the household Both color', async ({ browser, baseURL }) => {
  for (const user of [OWNER, PARTNER] as const) {
    const api = await apiLogin(baseURL!, user);
    const snapshot = await api.snapshot();
    expect(snapshot.bothColor ?? null, `${user} has no pick`).toBeNull();
    expect(snapshot.settings.bothColor).toBe('purple');
    await api.dispose();
    const page = await person(browser, baseURL!, user);
    await expect(both(page)).toHaveAttribute('data-c', 'purple');
    await expect(entry(page)).toHaveAttribute('data-c', 'purple');
    await expect(buttonSlice(page)).toHaveAttribute('data-c', 'purple');
    await page.context().close();
  }
});

test('two people pick different Both colors and each sees their own everywhere, also after a reload', async ({ browser, baseURL }) => {
  const owner = await person(browser, baseURL!, OWNER), partner = await person(browser, baseURL!, PARTNER);
  await pick(owner, 'Orange');
  await expect(both(owner)).toHaveAttribute('data-c', 'orange');
  await expect(entry(owner)).toHaveAttribute('data-c', 'orange');
  await expect(buttonSlice(owner)).toHaveAttribute('data-c', 'orange');
  // The partner has not moved, and not after a poll's worth of her own reloads either.
  await partner.reload(); await openDay(partner, DAY);
  await expect(both(partner)).toHaveAttribute('data-c', 'purple');
  await pick(partner, 'Blue');
  await expect(both(partner)).toHaveAttribute('data-c', 'blue');
  await expect(entry(partner)).toHaveAttribute('data-c', 'blue');
  await expect(both(owner)).toHaveAttribute('data-c', 'orange');
  // What a new Both to-do takes follows the person's own color, and Manage lists shows it checked.
  await addTodo(owner, 'Both again');
  await expect(owner.locator('.day-task', { has: owner.getByRole('button', { name: 'Edit Both again', exact: true }) }).locator('.day-circle')).toHaveAttribute('data-c', 'orange');
  await owner.reload(); await openDay(owner, DAY);
  await partner.reload(); await openDay(partner, DAY);
  await expect(both(owner)).toHaveAttribute('data-c', 'orange');
  await expect(both(partner)).toHaveAttribute('data-c', 'blue');
  // On the server: two account preferences; the household setting and the store's revision rule are untouched.
  for (const [user, color] of [[OWNER, 'orange'], [PARTNER, 'blue']] as const) {
    const api = await apiLogin(baseURL!, user);
    const snapshot = await api.snapshot();
    expect(snapshot.bothColor).toBe(color);
    expect(snapshot.settings).toMatchObject({ bothColor: 'purple', revision: 1 });
    expect(snapshot.v).toBe(5);
    await api.dispose();
  }
  await owner.context().close(); await partner.context().close();
});

test('the pick is refused for a color outside the palette and cleared with null', async ({ baseURL }) => {
  const api = await apiLogin(baseURL!, OWNER);
  for (const bad of ['mauve', '', 'Purple', 5, ['red']]) {
    const response = await api.post({ action: 'setBothColor', bothColor: bad });
    expect(response.status(), JSON.stringify(bad)).toBe(400);
  }
  expect((await api.snapshot()).bothColor ?? null).toBeNull();
  expect(await (await api.post({ action: 'setBothColor', bothColor: 'teal' })).json()).toEqual({ bothColor: 'teal' });
  expect((await api.snapshot()).bothColor).toBe('teal');
  expect(await (await api.post({ action: 'setBothColor', bothColor: null })).json()).toEqual({ bothColor: null });
  expect((await api.snapshot()).bothColor ?? null).toBeNull();
  await api.dispose();
});
