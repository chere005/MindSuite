import { expect, test, type Browser, type Page } from '@playwright/test';
import { snapshotKey } from './port';

/**
 * The wide layout's review fixes: what saving the pane writes, what survives
 * a resize across 900 px, which sheet may reopen, ticking in the month grid,
 * the account menu's Search, and the sidebar's writes.
 */
const WIDE = { width: 1280, height: 820 };
const PHONE = { width: 420, height: 900 };

let seq = 0;
async function signup(page: Page): Promise<string> {
  const user = `df${Date.now() % 1e8}${seq++}`;
  await page.goto('.');
  await page.getByText('Sign up', { exact: true }).click();
  await page.getByPlaceholder('Username').fill(user);
  await page.getByPlaceholder('Email').fill(user + '@example.com');
  await page.getByPlaceholder('Password', { exact: true }).fill('e2epassword');
  await page.getByPlaceholder('Confirm password').fill('e2epassword');
  await page.getByText('Sign up', { exact: true }).click();
  await expect(page.getByTestId('tab-reminders')).toBeVisible({ timeout: 20_000 });
  return user;
}

type R = { id: string; type: string; deleted?: boolean; payload: Record<string, any> };
async function recs(page: Page, user: string): Promise<R[]> {
  return page.evaluate((key) => {
    const snap = JSON.parse(localStorage.getItem(key) ?? '{}');
    return (snap.recs ?? []).filter((r: { deleted?: boolean }) => !r.deleted);
  }, snapshotKey(user));
}
const byText = (rs: R[], text: string) => rs.find((r) => (r.payload.text ?? r.payload.title) === text);

async function quick(page: Page, kind: 'event' | 'reminder' | 'note', line: string) {
  await page.getByTestId('quick-kind').click();
  await page.getByTestId(`quick-kind-${kind}`).click();
  await page.getByTestId('quick-add').fill(line);
  await page.getByTestId('quick-add').press('Enter');
}

async function openReminderPane(page: Page, text: string) {
  await page.getByTestId('rem-body').filter({ hasText: text }).first().click();
  await expect(page.getByTestId('wide-detail')).toBeVisible();
  await expect(page.getByTestId('wide-detail').getByPlaceholder(/What\?/)).toHaveValue(text);
}

test('1a. a tick made in the list while the pane is open survives Save', async ({ page }) => {
  await page.setViewportSize(WIDE);
  const user = await signup(page);
  await page.getByTestId('tab-reminders').click();
  await quick(page, 'reminder', 'Buy milk');
  await expect(page.getByTestId('rem-body').filter({ hasText: 'Buy milk' })).toBeVisible();
  await openReminderPane(page, 'Buy milk');
  await page.getByTestId('tick').first().click();
  await expect.poll(async () => byText(await recs(page, user), 'Buy milk')?.payload.done).toBe(true);
  await page.getByTestId('wide-detail').getByText('Save', { exact: true }).click();
  await expect(page.getByTestId('wide-detail')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(byText(await recs(page, user), 'Buy milk')?.payload.done, 'Save did not un-tick it').toBe(true);
});

test('1b. a repeating reminder ticked beside the open pane keeps its new due date on Save', async ({ page }) => {
  await page.setViewportSize(WIDE);
  const user = await signup(page);
  await page.getByTestId('tab-reminders').click();
  await quick(page, 'reminder', 'Water plants');
  await expect(page.getByTestId('rem-body').filter({ hasText: 'Water plants' })).toBeVisible();
  await openReminderPane(page, 'Water plants');
  await page.getByTestId('wide-detail').getByText('+ Repeat', { exact: true }).click();
  await page.getByTestId('wide-detail').getByText('Save', { exact: true }).click();
  await expect(page.getByTestId('wide-detail')).toHaveCount(0);
  const before = byText(await recs(page, user), 'Water plants')!.payload.due as string;
  await openReminderPane(page, 'Water plants');
  await page.getByTestId('tick').first().click();
  await expect.poll(async () => byText(await recs(page, user), 'Water plants')?.payload.due as string).not.toBe(before);
  const rolled = byText(await recs(page, user), 'Water plants')!.payload.due as string;
  await page.getByTestId('wide-detail').getByText('Save', { exact: true }).click();
  await expect(page.getByTestId('wide-detail')).toHaveCount(0);
  await page.waitForTimeout(500);
  const after = byText(await recs(page, user), 'Water plants')!.payload;
  expect(after.due, 'Save kept the rolled due date').toBe(rolled);
  expect(after.done).toBe(false);
});

test('2a. an open edit form keeps its unsaved typing when the window crosses 900 px and back', async ({ page }) => {
  await page.setViewportSize(WIDE);
  await signup(page);
  await page.getByTestId('tab-reminders').click();
  await quick(page, 'reminder', 'Call bank');
  await expect(page.getByTestId('rem-body').filter({ hasText: 'Call bank' })).toBeVisible();
  await openReminderPane(page, 'Call bank');
  await page.getByTestId('wide-detail').getByPlaceholder(/What\?/).fill('Call bank about the card');
  await page.getByTestId('wide-detail').getByText('+ Repeat', { exact: true }).click();

  await page.setViewportSize(PHONE);
  await expect(page.getByTestId('wide-detail')).toHaveCount(0);
  await expect(page.getByPlaceholder(/What\?/), 'the phone modal carries the draft').toHaveValue('Call bank about the card');
  await expect(page.getByText('every', { exact: true }), 'and the revealed repeat row').toBeVisible();

  await page.setViewportSize(WIDE);
  await expect(page.getByTestId('wide-detail').getByPlaceholder(/What\?/)).toHaveValue('Call bank about the card');
  await page.getByTestId('wide-detail').getByText('Cancel', { exact: true }).click();
  await expect(page.getByTestId('wide-detail')).toHaveCount(0);
  await page.setViewportSize(PHONE);
  await expect(page.getByPlaceholder(/What\?/), 'a closed item stays closed').toHaveCount(0);
});

test('2b. an inline retype on the phone keeps its text when the window grows past 900 px', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await signup(page);
  await page.getByTestId('tab-reminders').click();
  await page.getByTestId('secadd-General').first().click();
  await page.getByTestId('rem-add-field').fill('Pack bags');
  await page.getByTestId('rem-add-field').press('Enter');
  await page.getByTestId('rem-body').filter({ hasText: 'Pack bags' }).click();
  await page.getByTestId('rem-edit').fill('Pack bags for Denver');
  await page.setViewportSize(WIDE);
  await expect(page.getByTestId('wide-sidebar')).toBeVisible();
  await expect(page.getByTestId('rem-edit')).toHaveValue('Pack bags for Denver');
});

const pad2 = (n: number) => String(n).padStart(2, '0');
const now = new Date();
const ymd = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:ts@feed', 'SUMMARY:Team sync', `DTSTART:${ymd}T140000`, `DTEND:${ymd}T150000`, 'LOCATION:Room 4', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

async function withImported(page: Page) {
  await page.route('**/api/index.php', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown> | null;
    if (body?.action === 'calsub_fetch') { await route.fulfill({ json: { ok: true, ics: ICS, cached: false } }); return; }
    if (body?.action === 'calsub_discover') { await route.fulfill({ json: { ok: true, calendars: [] } }); return; }
    await route.fallback();
  });
  const user = await signup(page);
  await page.getByTestId('tab-calendar').click();
  await page.getByTestId('pick-calendar').click();
  await page.getByTestId('manage-calendars-row').click();
  await page.getByTestId('calsub-url').fill('webcal://feeds.example.com/team.ics');
  await page.getByTestId('calsub-add').click();
  await expect(page.getByTestId('calsub-url')).toHaveValue('');
  await page.getByText('Done', { exact: true }).click();
  return user;
}

test('3. an imported event opens read-only with where to edit, and opens again after an editor was cancelled over it', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize(WIDE);
  await withImported(page);
  await quick(page, 'event', 'Lunch 1pm');
  await expect(page.getByTestId('dp-ev-body').filter({ hasText: 'Lunch' })).toBeVisible({ timeout: 10_000 });
  const sub = page.getByTestId('dp-sub-body').filter({ hasText: 'Team sync' });
  await expect(sub).toBeVisible({ timeout: 10_000 });
  const pane = page.getByTestId('wide-detail');

  await sub.click();
  await expect(page.getByTestId('detail-readonly')).toBeVisible();
  await expect(page.getByTestId('detail-banner')).toContainText('Read-only');
  await expect(page.getByTestId('detail-banner')).toContainText('edit it in');
  await expect(pane.getByPlaceholder(/What\?/), 'no edit controls').toHaveCount(0);
  await expect(pane.getByText('Save', { exact: true })).toHaveCount(0);

  // An editor opened over it by the row's pencil, then cancelled.
  await page.getByTestId('dp-ev-body').filter({ hasText: 'Lunch' }).click({ delay: 600 });
  await page.getByLabel('Edit', { exact: true }).first().click({ timeout: 3_000 });
  await expect(pane.getByPlaceholder(/What\?/)).toHaveValue('Lunch');
  await pane.getByText('Cancel', { exact: true }).click();
  await expect(pane).toHaveCount(0);

  await sub.click();
  await expect(page.getByTestId('detail-readonly'), 'the imported event opens again').toBeVisible();
});

test('6. a reminder ticked in the month grid stays for the grace and can be unticked, on a 24px target', async ({ page }) => {
  await page.setViewportSize(WIDE);
  const user = await signup(page);
  await quick(page, 'reminder', 'Pay rent');
  const line = page.getByTestId('cell-line').filter({ hasText: 'Pay rent' });
  await expect(line).toBeVisible({ timeout: 10_000 });
  const tick = line.locator('xpath=preceding-sibling::*[@data-testid="cell-tick"]');
  const box = (await tick.boundingBox())!;
  expect(box.width, 'a real tap target').toBeGreaterThanOrEqual(24);
  expect(box.height).toBeGreaterThanOrEqual(24);
  await tick.click();
  await expect.poll(async () => byText(await recs(page, user), 'Pay rent')?.payload.done).toBe(true);
  await page.waitForTimeout(500);
  await expect(line, 'held for the grace, not dropped at once').toBeVisible();
  await tick.click();
  await expect.poll(async () => byText(await recs(page, user), 'Pay rent')?.payload.done).toBe(false);
  await page.waitForTimeout(2600);
  await expect(line, 'unticked, so it stays').toBeVisible();
});

test('7. the account menu Search focuses the sidebar field on wide and never pops the phone Search later', async ({ page }) => {
  await page.setViewportSize(WIDE);
  await signup(page);
  await page.getByTestId('topbar-sync').click();
  await page.getByTestId('menu-search').click();
  await expect(page.getByTestId('wide-search')).toBeFocused();
  await page.setViewportSize(PHONE);
  await expect(page.getByTestId('tab-add')).toBeVisible();
  await expect(page.getByTestId('search-field'), 'no phone Search left pending').toHaveCount(0);
});

test('8a. the sidebar writes the same prefs as the pickers', async ({ page }) => {
  await page.setViewportSize(WIDE);
  const user = await signup(page);
  const cals = (await recs(page, user)).filter((r) => r.type === 'calendar');
  const personal = cals.find((c) => c.payload.name === 'Personal')!;
  await page.getByTestId('side-cal-Personal').click();
  await expect.poll(async () => (await recs(page, user)).find((r) => r.type === 'pref' && r.payload.hidden)?.payload.hidden).toEqual([personal.id]);
  // The calendar picker agrees: its box for Personal is unticked.
  await page.getByTestId('pick-calendar').click();
  await expect(page.getByTestId('calbox-Personal')).toHaveText('☐');
  await page.mouse.click(8, 800);
  await page.getByTestId('side-cal-Personal').click();
  await expect.poll(async () => (await recs(page, user)).find((r) => r.type === 'pref' && r.payload.hidden !== undefined && r.payload.lastView === 'all')?.payload.hidden).toEqual([]);

  const folder = (await recs(page, user)).find((r) => r.type === 'folder' && r.payload.name === 'Reminders')!;
  await page.getByTestId('side-list-Reminders').click();
  await expect(page.getByTestId('rem-row').first().or(page.getByTestId('secadd-General').first())).toBeVisible();
  await expect.poll(async () => (await recs(page, user)).find((r) => r.type === 'pref' && r.payload.lastView === folder.id)?.payload.hidden?.length).toBeGreaterThan(0);
  await page.getByTestId('side-list-all').click();
  await expect.poll(async () => (await recs(page, user)).filter((r) => r.type === 'pref' && r.payload.lastView === folder.id).length).toBe(0);
});

test('8b. quick-add files a reminder and a note through the Add tab parser', async ({ page }) => {
  await page.setViewportSize(WIDE);
  const user = await signup(page);
  await quick(page, 'reminder', 'Call dentist tomorrow 3pm');
  await expect.poll(async () => byText(await recs(page, user), 'Call dentist')?.payload.time).toBe('15:00');
  const rem = byText(await recs(page, user), 'Call dentist')!;
  expect(rem.type).toBe('reminder');
  expect(rem.payload.due > `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`, 'tomorrow, not today').toBe(true);
  await quick(page, 'note', 'Plan the Denver trip');
  await expect.poll(async () => byText(await recs(page, user), 'Plan the Denver trip')?.type).toBe('note');
});

async function sharePair(browser: Browser) {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await pageB.setViewportSize(WIDE);
  const userB = await signup(pageB);
  const userA = await signup(pageA);
  return { ctxA, ctxB, pageA, pageB, userA, userB };
}
async function acceptShare(pageA: Page, pageB: Page, userA: string, userB: string, bucket: string, name: string) {
  await pageA.getByTestId('topbar-sync').click();
  await pageA.getByText('Settings', { exact: true }).click();
  await pageA.getByTestId('open-share').click();
  await pageA.getByTestId('share-add-partner').fill(userB);
  await pageA.getByTestId('share-add-partner').press('Enter');
  await pageA.getByTestId(`share-${bucket}-${name}`).click();
  await pageA.getByText('Done', { exact: true }).click();
  await pageB.getByTestId('topbar-sync').click();
  await pageB.getByText('Settings', { exact: true }).click();
  await pageB.getByTestId('open-share').click();
  await pageB.getByTestId('share-add-partner').fill(userA);
  await pageB.getByTestId('share-add-partner').press('Enter');
  await expect(pageB.getByText('sharing', { exact: true })).toBeVisible({ timeout: 10_000 });
  await pageB.getByText('Done', { exact: true }).click();
}

test("4. the + on a partner's section still works after another editor was opened over its sheet and cancelled", async ({ browser }) => {
  test.setTimeout(150_000);
  const { ctxA, ctxB, pageA, pageB, userA, userB } = await sharePair(browser);
  await pageA.getByTestId('tab-reminders').click();
  await pageA.getByTestId('secadd-General').first().click();
  await pageA.getByTestId('rem-add-field').fill('collect the parcel');
  await pageA.getByTestId('rem-add-field').press('Enter');
  await acceptShare(pageA, pageB, userA, userB, 'folders', 'Reminders');

  await pageB.getByTestId('tab-reminders').click();
  await pageB.getByTestId('pick-reminders').click();
  await pageB.getByTestId('pick-all').click();
  await expect(pageB.getByTestId('all-shared-row').filter({ hasText: 'collect the parcel' })).toBeVisible({ timeout: 15_000 });
  await pageB.getByTestId('secadd-General').first().click();
  await pageB.getByTestId('rem-add-field').fill('mine');
  await pageB.getByTestId('rem-add-field').press('Enter');
  await expect(pageB.getByTestId('rem-body').filter({ hasText: 'mine' })).toBeVisible();

  const pane = pageB.getByTestId('wide-detail');
  await pageB.getByTestId('shared-secadd-General').click();
  await expect(pane.getByTestId('item-shared-note')).toBeVisible();
  // Another editor replaces it, and is cancelled.
  await pageB.getByTestId('rem-body').filter({ hasText: 'mine' }).click();
  await expect(pane.getByPlaceholder(/What\?/)).toHaveValue('mine');
  await pane.getByText('Cancel', { exact: true }).click();
  await expect(pane).toHaveCount(0);
  // The + opens its sheet again.
  await pageB.getByTestId('shared-secadd-General').click();
  await expect(pane.getByTestId('item-shared-note'), 'the + is not dead').toBeVisible();
  await ctxA.close();
  await ctxB.close();
});

test("5. a partner's note in the month grid opens in the edit sheet, not the Notes tab", async ({ browser }) => {
  test.setTimeout(150_000);
  const { ctxA, ctxB, pageA, pageB, userA, userB } = await sharePair(browser);
  await pageA.setViewportSize(WIDE);
  await quick(pageA, 'note', 'Shared plan today');
  await expect.poll(async () => byText(await recs(pageA, userA), 'Shared plan')?.type).toBe('note');
  // A new note carries no date; give it today's through its edit sheet.
  await pageA.getByTestId('tab-calendar').click();
  const noteFolder = (await recs(pageA, userA)).find((r) => r.type === 'folder' && r.payload.app === 'notes')!;
  await acceptShare(pageA, pageB, userA, userB, 'notefolders', noteFolder.payload.name);
  await pageB.getByTestId('tab-calendar').click();
  const line = pageB.getByTestId('cell-line').filter({ hasText: 'Shared plan' });
  await expect(line).toBeVisible({ timeout: 20_000 });
  await line.click();
  await expect(pageB.getByTestId('wide-detail').getByPlaceholder(/What\?/)).toHaveValue('Shared plan');
  await expect(pageB.getByTestId('item-shared-note')).toBeVisible();
  await ctxA.close();
  await ctxB.close();
});
