import { expect, test, type Page } from '@playwright/test';
import { apiLogin, farDate, field, isPhone, login, noWindow, resetPrefs, showHalf, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME } from './people';

// Deleting a schedule entry: swipe it to the left, then tap Delete (no strip of controls hangs over the schedule while an entry is
// edited, so there is no Delete in the editor). A swipe is a sideways press of 28px or more on an entry that is not being edited, with a
// mouse, a pen or a finger; the keyboard's way is Delete or Backspace on the focused entry. The mouse tests run on the desktop project, the
// finger's on the phone project.
const add = async (api: Api, body: Record<string, unknown>) => {
  const data = { id: crypto.randomUUID(), ...body };
  const response = await api.post(data);
  expect(response.status(), JSON.stringify(await response.json())).toBe(200);
  return data.id as string;
};
const event = (date: string, over: Record<string, unknown> = {}) => ({ action: 'add', kind: 'event', date, owners: [OWNER], text: 'Dentist', start: 540, length: 60, ...over });
const openDay = async (page: Page, date: string) => {
  await page.locator(isPhoneView(page) ? '#pill-date' : '#jump-date').fill(date);
  await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', date);
};
const isPhoneView = (page: Page) => (page.viewportSize()?.width ?? 1000) <= 760;
async function clearDay(api: Api, date: string) {
  const snapshot = await api.snapshot();
  for (const item of [...snapshot.tasks, ...snapshot.priorities, ...snapshot.events].filter((i: { date: string }) => i.date === date)) {
    await api.post({ action: 'delete', id: item.id, revision: item.revision, confirm: true });
  }
}
const stored = async (api: Api, date: string) => (await api.snapshot()).events.filter((e: { date: string }) => e.date === date);
const block = (page: Page, label: string) => page.getByRole('button', { name: label, exact: true });
const del = (page: Page) => page.locator('.day-ev-del');
const centre = async (locator: ReturnType<Page['locator']>) => { const box = (await locator.boundingBox())!; return { x: box.x + box.width / 2, y: box.y + box.height / 2, box }; };
function recordPosts(page: Page) {
  const posts: Array<Record<string, unknown>> = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('api.php')) { const body = request.postDataJSON(); if (body.action !== 'savePrefs') { posts.push(body); } } });
  return posts;
}
/** A mouse press on the entry's right part, moved sideways `dx` in small steps, and released. */
async function swipe(page: Page, label: string, dx: number, dy = 0) {
  const at = await centre(block(page, label));
  const x = at.box.x + at.box.width - 14;
  await page.mouse.move(x, at.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) { await page.mouse.move(x + (dx * i) / 12, at.y + (dy * i) / 12); }
  await page.mouse.up();
}
test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });
const DENTIST = `Dentist, 9a to 10a, ${OWNER_NAME}`;

test.describe('deleting an entry with a mouse or the keyboard', () => {
  test.beforeEach(async ({}, info) => { test.skip(isPhone(info.project.name), 'a mouse and the keyboard: the desktop project'); });

  test('Delete survives the panel being drawn again (another entry was being edited when the swipe began), is not lost by a second swipe on it, and goes when the entry is lifted to move', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(646);
    await add(owner, event(date));
    await add(owner, event(date, { text: 'Lunch', start: 720 }));
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      // Lunch is being edited; the press that swipes Dentist takes the focus out of it, which saves it and draws the panel again at the release.
      await block(page, `Lunch, 12p to 1p, ${OWNER_NAME}`).click();
      await expect(page.locator('.day-ev.day-editing')).toHaveCount(1);
      await swipe(page, DENTIST, -80);
      await expect(page.locator('.day-ev.day-editing')).toHaveCount(0);
      await expect(del(page)).toHaveCount(1);
      await expect(block(page, DENTIST)).toHaveAttribute('data-swiped', '');
      // The same swipe again on the entry that shows Delete keeps it (its release click is not a tap on the entry).
      await swipe(page, DENTIST, -80);
      await expect(del(page)).toHaveCount(1);
      // Pressing it and moving it up or down puts Delete away: the entry moves, Delete does not stay behind.
      const at = await centre(block(page, DENTIST));
      await page.mouse.move(at.x - 20, at.y); await page.mouse.down();
      for (let i = 1; i <= 8; i++) { await page.mouse.move(at.x - 20, at.y - i * 3); }
      await expect(del(page)).toHaveCount(0);
      await page.mouse.up();
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('Escape puts Delete away when nothing in the schedule has the focus (a swipe does not focus a button in Safari); after a keyboard delete the keyboard is on Add schedule entry; the hidden button is the screen reader\'s way to Delete', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(647);
    await add(owner, event(date));
    await add(owner, event(date, { text: 'Lunch', start: 720 }));
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      await swipe(page, DENTIST, -80);
      await expect(del(page)).toHaveCount(1);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press('Escape');
      await expect(del(page)).toHaveCount(0);
      // The hidden button after each entry: named with the time, out of the tab order, and it shows Delete with the focus on it.
      const hidden = page.getByRole('button', { name: 'Delete Dentist, 9a to 10a', exact: true });
      await expect(hidden).toHaveAttribute('tabindex', '-1');
      await hidden.dispatchEvent('click');
      await expect(del(page)).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(block(page, DENTIST)).toHaveCount(0);
      await expect(page.locator('.day-addentry')).toBeFocused();
      // A write in flight: Delete stays for another tap instead of vanishing.
      expect((await stored(owner, date)).map((e: { text: string }) => e.text)).toEqual(['Lunch']);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a refused save of an entry is said in the banner and taken back when the draft is fixed or the edit is left; a stored entry emptied says what to do without a Delete', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(648);
    await add(owner, event(date));
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      await block(page, DENTIST).click();
      const title = field(page, 'Edit entry: Dentist');
      // The field's maxlength (500) stops typing, pasting and fill(); a text set from code does not: 501 characters is the one over the limit.
      const tooLong = 'a'.repeat(501);
      const overfill = (text: string) => title.evaluate((el: HTMLInputElement, value: string) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, text);
      await expect(title).toHaveAttribute('maxlength', '500');
      await overfill(tooLong);
      await title.press('Enter');
      await expect(page.locator('#error')).toBeVisible();
      await expect(page.locator('#error-message')).toHaveText('Keep it to 500 characters.');
      expect(await stored(owner, date)).toMatchObject([{ text: 'Dentist' }]);
      await overfill('Dentist');
      await expect(page.locator('#error')).toBeHidden();
      // Refused again, then left with Escape: the banner goes with the edit.
      await overfill(tooLong);
      await title.press('Enter');
      await expect(page.locator('#error')).toBeVisible();
      await expect(page.locator('#error-message')).toHaveText('Keep it to 500 characters.');
      await title.press('Escape');
      await expect(page.locator('.day-ev.day-editing')).toHaveCount(0);
      await expect(page.locator('#error')).toBeHidden();
      expect(await stored(owner, date)).toMatchObject([{ text: 'Dentist' }]);
      // Emptied and entered: it asks for text (it has no Delete in its editor to point at).
      await block(page, DENTIST).click();
      await title.fill('');
      await title.press('Enter');
      await expect(page.locator('#error-message')).toHaveText('Type something, or press Escape to leave it as it was.');
      await title.press('Escape');
      expect(await stored(owner, date)).toMatchObject([{ text: 'Dentist' }]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a swipe to the left shows Delete over the right end of the entry, writes nothing and opens no editor; a tap on Delete deletes it with its revision, at once', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(640);
    const id = await add(owner, event(date));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      await swipe(page, DENTIST, -80);
      await expect(del(page)).toHaveCount(1);
      await expect(block(page, DENTIST)).toHaveAttribute('data-swiped', '');
      await expect(page.locator('.day-ev.day-editing')).toHaveCount(0);
      const b = (await block(page, DENTIST).boundingBox())!, d = (await del(page).boundingBox())!;
      expect(Math.abs(d.x + d.width - (b.x + b.width)), 'Delete is at the right end of the entry').toBeLessThanOrEqual(3);
      expect(d.x).toBeGreaterThan(b.x + b.width / 2);
      await expect(del(page)).toHaveAccessibleName('Delete Dentist');
      expect(posts).toHaveLength(0);
      await noWindow(page);
      await del(page).click();
      await expect(page.locator('.day-ev')).toHaveCount(0);
      await expect(del(page)).toHaveCount(0);
      expect(posts).toEqual([{ action: 'delete', id, revision: 1, confirm: true }]);
      expect(await stored(owner, date)).toHaveLength(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a short sideways press is a click that opens the editor and a swipe to the right is no swipe', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(641);
    await add(owner, event(date));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      // A press that moves less than a swipe and is let go on the entry is a click: it opens the editor, with no Delete.
      await swipe(page, DENTIST, -18);
      await expect(page.locator('.day-ev.day-editing')).toHaveCount(1);
      await expect(del(page)).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.locator('.day-ev.day-editing')).toHaveCount(0);
      // Sideways to the right is a move that goes nowhere: no Delete, no editor, nothing written.
      await swipe(page, DENTIST, 80);
      await expect(del(page)).toHaveCount(0);
      await expect(page.locator('.day-ev.day-editing')).toHaveCount(0);
      expect(posts.filter(p => p.action === 'delete')).toHaveLength(0);
      expect(await stored(owner, date)).toHaveLength(1);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('Delete is put away by a click elsewhere, Escape or a click on the entry (which opens nothing); an entry being edited has no swipe, no Delete and no strip over the schedule', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(642);
    await add(owner, event(date));
    await add(owner, event(date, { text: 'Lunch', start: 720 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      await swipe(page, DENTIST, -80);
      await expect(del(page)).toHaveCount(1);
      await page.locator('.day-label', { hasText: 'Notes' }).click();
      await expect(del(page)).toHaveCount(0);
      await expect(block(page, DENTIST)).not.toHaveAttribute('data-swiped', '');
      await swipe(page, DENTIST, -80);
      await block(page, DENTIST).focus();
      await page.keyboard.press('Escape');
      await expect(del(page)).toHaveCount(0);
      await expect(block(page, DENTIST)).toBeFocused();
      // A click on the entry that shows Delete only puts Delete away.
      await swipe(page, DENTIST, -80);
      await block(page, DENTIST).click({ position: { x: 8, y: 8 } });
      await expect(del(page)).toHaveCount(0);
      await expect(page.locator('.day-ev.day-editing')).toHaveCount(0);
      // Showing Delete on another entry puts the first one's away: there is one at a time.
      await swipe(page, DENTIST, -80);
      await swipe(page, `Lunch, 12p to 1p, ${OWNER_NAME}`, -80);
      await expect(del(page)).toHaveCount(1);
      await expect(block(page, `Lunch, 12p to 1p, ${OWNER_NAME}`)).toHaveAttribute('data-swiped', '');
      await page.keyboard.press('Escape');
      // An entry being edited: no Delete, no swipe, and nothing hangs over the schedule (no counter, no strip, no hint).
      await block(page, DENTIST).click();
      await expect(page.locator('.day-ev.day-editing')).toHaveCount(1);
      await expect(page.locator('.day-ev-strip, .day-ev .ip-count, .day-ev .ip-del, .day-ev .ip-hint')).toHaveCount(0);
      const open = (await page.locator('.day-ev.day-editing').boundingBox())!, x = open.x + open.width - 14, y = open.y + open.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      for (let i = 1; i <= 12; i++) { await page.mouse.move(x - (80 * i) / 12, y); }
      await page.mouse.up();
      await expect(del(page)).toHaveCount(0);
      await page.keyboard.press('Escape');
      expect(posts.filter(p => p.action === 'delete')).toHaveLength(0);
      expect(await stored(owner, date)).toHaveLength(2);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the keyboard: Delete or Backspace on the focused entry shows Delete and moves the focus to it; Enter deletes; Escape gives the entry the focus back', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(643);
    const id = await add(owner, event(date));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      await block(page, DENTIST).focus();
      await page.keyboard.press('Delete');
      await expect(del(page)).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(del(page)).toHaveCount(0);
      await expect(block(page, DENTIST)).toBeFocused();
      await page.keyboard.press('Backspace');
      await expect(del(page)).toBeFocused();
      expect(posts).toHaveLength(0);
      await page.keyboard.press('Enter');
      await expect(page.locator('.day-ev')).toHaveCount(0);
      expect(posts).toEqual([{ action: 'delete', id, revision: 1, confirm: true }]);
      // Backspace in the title of an entry being edited is the text's.
      await add(owner, event(date, { text: 'Gym', start: 420 }));
      await page.reload(); await openDay(page, date);
      await block(page, `Gym, 7a to 8a, ${OWNER_NAME}`).click();
      await field(page, 'Edit entry: Gym').press('Backspace');
      await expect(del(page)).toHaveCount(0);
      await expect(field(page, 'Edit entry: Gym')).toHaveValue('Gy');
      await page.keyboard.press('Escape');
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('an entry for both of us says so on its Delete and is deleted from both lists as one record; a stale delete leaves it and the shell says why', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(644);
    const both = await add(owner, event(date, { text: 'Lunch', owners: [OWNER, PARTNER], start: 720 }));
    const mine = await add(owner, event(date, { text: 'Gym', start: 420 }));
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      await swipe(page, 'Lunch, 12p to 1p, Both', -80);
      await expect(del(page)).toHaveAccessibleName('Delete Lunch, for both of us');
      await del(page).click();
      await expect(page.locator('.day-ev', { hasText: 'Lunch' })).toHaveCount(0);
      expect((await stored(owner, date)).map((e: { id: string }) => e.id)).toEqual([mine]);
      expect((await stored(owner, date)).some((e: { id: string }) => e.id === both)).toBe(false);
      // Someone else changed Gym since this page read it: the delete is refused as stale, the entry stays, and the shell says so.
      const current = (await stored(owner, date))[0];
      expect((await owner.post({ action: 'edit', kind: 'event', id: mine, revision: current.revision, date, owners: [OWNER], text: 'Gym class', start: 420, length: 60 })).status()).toBe(200);
      await swipe(page, `Gym, 7a to 8a, ${OWNER_NAME}`, -80);
      await del(page).click();
      await expect(page.locator('#error')).toBeVisible();
      expect(await stored(owner, date)).toMatchObject([{ id: mine, text: 'Gym class' }]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});
