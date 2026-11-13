import { expect, test, type Page } from '@playwright/test';
import { dayLabel } from '../packages/core/src/planner';
import { shiftDate } from '../packages/core/src/parse';
import { apiLogin, field, login, pickList, removeTodos, resetPrefs, today, todo, unique, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME } from './people';

// The owner, 2026-11-02: a carried-over to-do "only shows checked for the day it was accomplished; previous days show it unchanged/unchecked".
// Ticked on today's Day, a to-do of an earlier day is done on today: checked in today's pile (with its "from" chip) and, on its own day,
// unchecked with a "→ Tue 3" chip whose circle does nothing. It is no longer carried; unchecking it brings it back. A to-do ticked on its own
// day is done there, as before. Desktop project (1360x900); the phone half is done-on-phone.spec.ts. Far dates, and every test removes what it made:
// a leftover open to-do of the past would show on today's view of every later test.
test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });

/** A day long before any other spec's, so nothing else lists it. `n` keeps the desktop and the phone half apart. */
const PAST = (n: number) => shiftDate('2021-03-01', n, 'day');
const goTo = async (page: Page, date: string) => {
  await page.locator('#jump-date').fill(date);
  await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', date);
};
const chip = (date: string) => `→ ${dayLabel(date, { weekday: 'short' })} ${dayLabel(date, { day: 'numeric' })}`;
const from = (date: string) => `from ${dayLabel(date, { weekday: 'short' })} ${dayLabel(date, { month: 'short', day: 'numeric' })}`;
const stored = async (api: Api, id: string) => (await api.snapshot()).tasks.find((t: { id: string }) => t.id === id);
const rowOf = (page: Page, title: string) => page.locator('.day-task', { hasText: title });

test.describe('A to-do carried onto today and ticked there', () => {
  test('is checked on today, unchecked with a chip on its own day, and a reload keeps both; unchecking brings it back', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), then = PAST(0), now = today();
    const body = todo({ date: then, owners: [OWNER], title: unique('Far past') }), own = todo({ date: now, owners: [OWNER], title: unique('Own') });
    for (const b of [body, own]) { expect((await owner.post(b)).status()).toBe(200); }
    const title = body.title as string;
    try {
      await login(page);
      await pickList(page, OWNER_NAME);
      // Carried onto today: an open row with its chip, ahead of today's own.
      await expect(rowOf(page, title).locator('.day-from')).toHaveText(from(then));
      await page.getByRole('checkbox', { name: `Complete ${title}`, exact: true }).click();
      // Done on today: crossed out in today's pile, chip kept, below the blank lines; the open count falls.
      await expect(rowOf(page, title)).toHaveClass(/day-done/);
      await expect(page.getByRole('checkbox', { name: `Reopen ${title}`, exact: true })).toBeChecked();
      await expect(rowOf(page, title).locator('.day-from')).toHaveText(from(then));
      await expect(page.locator('.day-tasks > li').last()).toHaveClass(/day-done/);
      await expect(page.locator('.day-todo [data-kind=todos]')).toHaveText(/^1 of /);
      expect(await stored(owner, body.id as string)).toMatchObject({ date: then, done: true, doneOn: now });
      // Reload: still checked on today.
      await page.reload();
      await expect(page.locator('#sidebar .date-row.selected')).toBeAttached();
      await expect(page.getByRole('checkbox', { name: `Reopen ${title}`, exact: true })).toBeChecked();
      await expect(rowOf(page, title)).toHaveClass(/day-done/);
      // Its own day: unchecked, not crossed out, a chip saying where it went; the circle is inert and its name says it was done on today.
      await goTo(page, then);
      const row = rowOf(page, title);
      await expect(row).toHaveCount(1);
      await expect(row).not.toHaveClass(/day-done/);
      await expect(row.locator('.day-from')).toHaveText(chip(now));
      await expect(row.locator('.day-task-title')).not.toHaveCSS('text-decoration-line', 'line-through');
      const circle = row.locator('.day-circle');
      await expect(circle).not.toBeChecked();
      await expect(circle).toHaveAttribute('aria-disabled', 'true');
      await expect(circle).toHaveAccessibleName(`Done on ${dayLabel(now, { weekday: 'short', month: 'short', day: 'numeric' })}: ${title}`);
      const revision = (await stored(owner, body.id as string)).revision;
      await circle.click({ force: true });
      await expect(circle).not.toBeChecked();
      await page.waitForTimeout(300);
      expect(await stored(owner, body.id as string)).toMatchObject({ revision, done: true, doneOn: now });
      // The counter of that day counts open to-dos only: this one is done.
      await expect(page.locator('.day-todo [data-kind=todos]')).toHaveText(/^0 of /);
      // The chip opens the row's editor like the title does, and the day field still holds its own day.
      await row.locator('.day-from').click();
      await expect(field(page, `Edit task: ${title}`)).toBeFocused();
      await expect(page.locator('.day-task.day-editing input[type=date]')).toHaveValue(then);
      await field(page, `Edit task: ${title}`).press('Escape');
      // Back on today, unchecking removes the day: open on its own day again, and carried again.
      await goTo(page, now);
      await page.getByRole('checkbox', { name: `Reopen ${title}`, exact: true }).click();
      await expect(page.getByRole('checkbox', { name: `Complete ${title}`, exact: true })).not.toBeChecked();
      await expect(rowOf(page, title)).not.toHaveClass(/day-done/);
      await expect(rowOf(page, title).locator('.day-from')).toHaveText(from(then));
      const reopened = await stored(owner, body.id as string);
      expect(reopened.done).toBe(false);
      expect(reopened).not.toHaveProperty('doneOn');
      await goTo(page, then);
      await expect(page.getByRole('checkbox', { name: `Complete ${title}`, exact: true })).not.toBeChecked();
      await expect(rowOf(page, title).locator('.day-from')).toHaveCount(0);
    } finally { await removeTodos(owner, [body.id as string, own.id as string]); await owner.dispose(); }
  });

  test('a to-do ticked on its own day is done there and nowhere else; other days list neither row', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), then = PAST(2), between = PAST(5);
    const body = todo({ date: then, owners: [OWNER], title: unique('Own day') });
    expect((await owner.post(body)).status()).toBe(200);
    const title = body.title as string;
    try {
      await login(page);
      await pickList(page, OWNER_NAME);
      await goTo(page, then);
      await page.getByRole('checkbox', { name: `Complete ${title}`, exact: true }).click();
      await expect(rowOf(page, title)).toHaveClass(/day-done/);
      await expect(rowOf(page, title).locator('.day-from')).toHaveCount(0);
      expect(await stored(owner, body.id as string)).toMatchObject({ date: then, done: true, doneOn: then });
      // Today does not list a done to-do of the past; neither does a day in between.
      await goTo(page, today());
      await expect(rowOf(page, title)).toHaveCount(0);
      await goTo(page, between);
      await expect(rowOf(page, title)).toHaveCount(0);
      await goTo(page, then);
      await expect(page.getByRole('checkbox', { name: `Reopen ${title}`, exact: true })).toBeChecked();
    } finally { await removeTodos(owner, [body.id as string]); await owner.dispose(); }
  });

  test('the other person sees the same: checked on today, unchecked with the chip on its own day', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), then = PAST(7), now = today();
    const body = todo({ date: then, owners: [OWNER, PARTNER], title: unique('Both far past') });
    expect((await owner.post(body)).status()).toBe(200);
    const title = body.title as string;
    try {
      const done = await owner.post({ action: 'complete', id: body.id, revision: 1, done: true, doneOn: now });
      expect(done.status()).toBe(200);
      await login(page, PARTNER);
      await expect(page.getByRole('checkbox', { name: `Reopen ${title}`, exact: true })).toBeChecked();
      await goTo(page, then);
      await expect(rowOf(page, title).locator('.day-from')).toHaveText(chip(now));
      await expect(rowOf(page, title).locator('.day-circle')).toHaveAttribute('aria-disabled', 'true');
    } finally { await removeTodos(owner, [body.id as string]); await owner.dispose(); }
  });
});

test.describe('The server decides which day a tick may name', () => {
  test('its own day or the server\'s today, never another; only a done day to-do holds one', async ({ baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), then = PAST(9), now = today();
    const day = todo({ date: then, title: unique('Server rules') }), week = todo({ scope: 'week', date: '2021-03-15', title: unique('Week') });
    for (const b of [day, week]) { expect((await owner.post(b)).status()).toBe(200); }
    try {
      const tick = (id: unknown, doneOn: unknown, over: Record<string, unknown> = {}) => owner.post({ action: 'complete', id, revision: 1, done: true, doneOn, ...over });
      for (const doneOn of [shiftDate(now, -1, 'day'), shiftDate(now, 1, 'day'), shiftDate(then, -1, 'day'), 'today', 20260101, null]) {
        const refused = await tick(day.id, doneOn);
        expect(refused.status(), String(doneOn)).toBe(400);
        expect(await refused.json()).toMatchObject({ code: 'invalid' });
      }
      expect((await tick(week.id, '2021-03-15')).status()).toBe(400);
      expect((await owner.post({ action: 'complete', id: day.id, revision: 1, done: false, doneOn: now })).status()).toBe(400);
      expect(await stored(owner, day.id as string)).toMatchObject({ done: false });
      expect((await tick(day.id, now)).status()).toBe(200);
      expect(await stored(owner, day.id as string)).toMatchObject({ done: true, doneOn: now, revision: 2 });
      expect((await owner.post({ action: 'complete', id: day.id, revision: 2, done: false })).status()).toBe(200);
      expect(await stored(owner, day.id as string)).not.toHaveProperty('doneOn');
    } finally { await removeTodos(owner, [day.id as string, week.id as string]); await owner.dispose(); }
  });
});
