import { expect, test, type Page } from '@playwright/test';
import { apiLogin, farDate, login, resetPrefs, showTodos, todo, unique } from './helpers';
import { OWNER, PARTNER } from './people';

// Performance: the shell does not draw the panel again for a reply that tells it what it already shows (the answer of a check-off the screen had laid over the
// snapshot, a poll that brought another day's change), because that redraw cost layouts and a repaint for nothing. It still draws when anything on the page
// differs from the markup it drew (a box ticked by hand that the data does not agree with), and never skips a redraw a panel asked for. Desktop project only.
let day = 5100 + Math.floor(Math.random() * 9000);
test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });

/** Counts how many times the panel's markup is set, from the page's first script on. */
async function countDraws(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __draws: number };
    w.__draws = 0;
    const set = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!;
    Object.defineProperty(Element.prototype, 'innerHTML', { ...set, set(this: Element, value: string) { if (this.id === 'period-panel') { w.__draws++; } set.set!.call(this, value); } });
  });
}
const draws = (page: Page) => page.evaluate(() => (window as unknown as { __draws: number }).__draws);
const settled = (page: Page) => expect(page.locator('#sync-status')).toHaveText('Saved');

async function openDay(page: Page, date: string) {
  await page.locator('#jump-date').fill(date);
  await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', date);
  await showTodos(page);
}

test('the answer to a check-off draws nothing again, and the page stays alive after it', async ({ page, baseURL }) => {
  const api = await apiLogin(baseURL!, OWNER);
  const date = farDate(day++), title = unique('Skip');
  expect((await api.post(todo({ date, title }))).status()).toBe(200);
  await countDraws(page);
  await login(page);
  await openDay(page, date);
  const circle = page.locator(`input.day-circle[aria-label$=" ${title}"]`);
  await expect(circle).toBeVisible();
  const before = await draws(page);
  await circle.click();
  await settled(page);
  await expect(page.locator(`li.day-done:has-text("${title}")`)).toHaveCount(1);
  // One draw for the tick as the screen laid it over the snapshot; the reply that only confirmed it drew nothing (it used to draw a second time).
  expect(await draws(page) - before).toBe(1);
  // The panel was never taken down, so what it wired is still wired: the tick comes back with a second press.
  await page.locator(`li.day-done input.day-circle[aria-label$=" ${title}"]`).click();
  await settled(page);
  await expect(page.locator(`li.day-done:has-text("${title}")`)).toHaveCount(0);
  expect((await api.snapshot()).tasks.find((t: { title: string }) => t.title === title).done).toBe(false);
  expect(await draws(page) - before).toBe(2);
  await api.dispose();
});

test('an answer that confirms a check-off still redraws a page that differs from its markup, and a poll with changes always draws', async ({ page, baseURL }) => {
  const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER);
  const date = farDate(day++), first = unique('First'), second = unique('Second');
  expect((await owner.post(todo({ date, title: first }))).status()).toBe(200);
  expect((await owner.post(todo({ date, title: second }))).status()).toBe(200);
  // The write waits at the network until the test lets it go, so the box ticked by hand below is there when the answer arrives.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api.php', async route => { if (route.request().method() === 'POST') { await gate; } await route.continue(); });
  await countDraws(page);
  await login(page);
  await openDay(page, date);
  const one = page.locator(`input.day-circle[aria-label$=" ${first}"]`), two = page.locator(`input.day-circle[aria-label$=" ${second}"]`);
  await expect(two).toBeVisible();
  const before = await draws(page);
  await one.click();
  await expect(page.locator(`li.day-done:has-text("${first}")`)).toHaveCount(1);
  expect(await draws(page) - before).toBe(1);
  await two.evaluate((box: HTMLInputElement) => { box.checked = true; });
  release();
  await settled(page);
  // The answer only confirmed the first tick, but the second box was ticked by hand and the data does not agree: the page is drawn again and the box is put back.
  await expect(page.locator(`input.day-circle[aria-label$=" ${second}"]`)).not.toBeChecked();
  expect(await draws(page) - before).toBe(2);

  // Another person's change that the page has not drawn: the poll that brings it draws, even when this day looks the same (a panel paints more than its markup from the data).
  expect((await partner.post(todo({ date: farDate(day++), owners: [PARTNER] }))).status()).toBe(200);
  const polled = await draws(page);
  await Promise.all([page.waitForResponse(r => r.url().includes('api.php?since=') && r.request().method() === 'GET'), page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))]);
  await expect.poll(() => draws(page)).toBe(polled + 1);
  await owner.dispose(); await partner.dispose();
});
