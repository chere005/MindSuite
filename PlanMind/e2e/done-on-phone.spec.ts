import { expect, test, type Page } from '@playwright/test';
import { dayLabel } from '../packages/core/src/planner';
import { shiftDate } from '../packages/core/src/parse';
import { apiLogin, login, pickList, removeTodos, resetPrefs, showTodos, today, todo, unique, type Api } from './helpers';
import { OWNER, OWNER_NAME } from './people';

// Where a to-do was done, on the Day's To-do tab of a phone (the rule and the desktop half: done-on.spec.ts). A far-past to-do carried onto
// today and ticked there is checked on today, unchecked with a "→" chip on its own day, and a reload keeps it. 375x812. Far dates, cleaned up.
test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });

const PAST = (n: number) => shiftDate('2021-04-01', n, 'day');
const openDay = async (page: Page, date: string) => {
  await page.locator('#pill-date').fill(date);
  await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', date);
  await showTodos(page);
};
const chip = (date: string) => `→ ${dayLabel(date, { weekday: 'short' })} ${dayLabel(date, { day: 'numeric' })}`;
const from = (date: string) => `from ${dayLabel(date, { weekday: 'short' })} ${dayLabel(date, { month: 'short', day: 'numeric' })}`;
const stored = async (api: Api, id: string) => (await api.snapshot()).tasks.find((t: { id: string }) => t.id === id);
const rowOf = (page: Page, title: string) => page.locator('.day-task', { hasText: title });

test('a far-past to-do carried onto today and ticked there is checked on today and unchecked, with the chip, on its own day; a reload keeps it', async ({ page, baseURL }) => {
  const owner = await apiLogin(baseURL!, OWNER), then = PAST(0), now = today();
  const body = todo({ date: then, owners: [OWNER], title: unique('Far past') });
  expect((await owner.post(body)).status()).toBe(200);
  const title = body.title as string;
  try {
    await login(page);
    await pickList(page, OWNER_NAME);
    await showTodos(page);
    await expect(rowOf(page, title).locator('.day-from')).toHaveText(from(then));
    await page.getByRole('checkbox', { name: `Complete ${title}`, exact: true }).tap();
    await expect(rowOf(page, title)).toHaveClass(/day-done/);
    await expect(page.getByRole('checkbox', { name: `Reopen ${title}`, exact: true })).toBeChecked();
    await expect(rowOf(page, title).locator('.day-from')).toHaveText(from(then));
    expect(await stored(owner, body.id as string)).toMatchObject({ date: then, done: true, doneOn: now });
    // The tab still fits: nothing scrolls but the list.
    expect(await page.evaluate(() => ({ page: document.documentElement.scrollHeight - innerHeight, sideways: document.documentElement.scrollWidth - innerWidth }))).toEqual({ page: 0, sideways: 0 });
    // Reload: it is still checked on today.
    await page.reload();
    await expect(page.locator('#sidebar .date-row.selected')).toBeAttached();
    await showTodos(page);
    await expect(page.getByRole('checkbox', { name: `Reopen ${title}`, exact: true })).toBeChecked();
    await expect(rowOf(page, title)).toHaveClass(/day-done/);
    // Its own day: unchecked, not crossed out, the chip says where it went, and its circle does nothing.
    await openDay(page, then);
    const row = rowOf(page, title);
    await expect(row).toHaveCount(1);
    await expect(row).not.toHaveClass(/day-done/);
    await expect(row.locator('.day-from')).toHaveText(chip(now));
    const circle = row.locator('.day-circle');
    await expect(circle).not.toBeChecked();
    await expect(circle).toHaveAttribute('aria-disabled', 'true');
    await expect(circle).toHaveAccessibleName(`Done on ${dayLabel(now, { weekday: 'short', month: 'short', day: 'numeric' })}: ${title}`);
    const revision = (await stored(owner, body.id as string)).revision;
    await circle.tap({ force: true });
    await expect(circle).not.toBeChecked();
    await page.waitForTimeout(300);
    expect(await stored(owner, body.id as string)).toMatchObject({ revision, done: true, doneOn: now });
    // The chip fits inside its row on a phone, next to a title that keeps room.
    const [rowBox, chipBox] = [(await row.boundingBox())!, (await row.locator('.day-from').boundingBox())!];
    expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
    // Back on today, unchecking removes the day: carried and open again.
    await openDay(page, now);
    await page.getByRole('checkbox', { name: `Reopen ${title}`, exact: true }).tap();
    await expect(page.getByRole('checkbox', { name: `Complete ${title}`, exact: true })).not.toBeChecked();
    await expect(rowOf(page, title).locator('.day-from')).toHaveText(from(then));
    expect(await stored(owner, body.id as string)).not.toHaveProperty('doneOn');
  } finally { await removeTodos(owner, [body.id as string]); await owner.dispose(); }
});
