import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { apiLogin, farDate, login, resetPrefs, showHalf, type Api } from './helpers';
import { OWNER, OWNER_NAME } from './people';

// Deleting a schedule entry with a finger: swipe it to the left, then tap Delete (swipe-delete.spec.ts has the mouse and the keyboard).
// Phone project. A finger's swipe before the 0.4 s hold is over is not a scroll or a move when it goes sideways to the left.
const add = async (api: Api, body: Record<string, unknown>) => {
  const data = { id: crypto.randomUUID(), ...body };
  const response = await api.post(data);
  expect(response.status(), JSON.stringify(await response.json())).toBe(200);
  return data.id as string;
};
const event = (date: string, over: Record<string, unknown> = {}) => ({ action: 'add', kind: 'event', date, owners: [OWNER], text: 'Dentist', start: 540, length: 60, ...over });
const openDay = async (page: Page, date: string) => {
  await page.locator('#pill-date').fill(date);
  await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', date);
};
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
function finger(cdp: CDPSession) {
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  return {
    async swipe(from: { x: number; y: number }, dx: number, steps = 8) { await send('touchStart', from.x, from.y); for (let i = 1; i <= steps; i++) { await send('touchMove', from.x + (dx * i) / steps, from.y); } await send('touchEnd'); },
  };
}
test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });
const DENTIST = `Dentist, 9a to 10a, ${OWNER_NAME}`;

test.describe('deleting an entry with a finger', () => {
  test('a swipe to the left shows a finger-sized Delete, even on a half-hour entry; a tap on it deletes; a swipe the wrong way, or too short, does nothing but a tap still edits', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(645);
    const id = await add(owner, event(date));
    const short = await add(owner, event(date, { text: 'Call', start: 660, length: 30 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      const f = finger(await page.context().newCDPSession(page));
      const at = await centre(block(page, DENTIST));
      await f.swipe({ x: at.box.x + at.box.width - 14, y: at.y }, 70);
      await expect(del(page)).toHaveCount(0);
      await f.swipe({ x: at.box.x + at.box.width - 14, y: at.y }, -16);
      await expect(del(page)).toHaveCount(0);
      expect(posts).toHaveLength(0);
      await f.swipe({ x: at.box.x + at.box.width - 14, y: at.y }, -90);
      await expect(del(page)).toHaveCount(1);
      await expect(page.locator('.day-ev.day-editing')).toHaveCount(0);
      const d = (await del(page).boundingBox())!;
      // The entry's text makes room for Delete (the phone layout's own padding must not win), and the entry cannot be pinch-zoomed.
      expect(await block(page, DENTIST).evaluate(el => getComputedStyle(el).paddingRight)).toBe('58px');
      expect(await block(page, DENTIST).evaluate(el => getComputedStyle(el).touchAction)).toBe('pan-y');
      expect(d.width).toBeGreaterThanOrEqual(44);
      expect(d.height).toBeGreaterThanOrEqual(44);
      // A half-hour entry is about 25px tall: its Delete is still 44px tall.
      const call = await centre(block(page, `Call, 11a to 11:30a, ${OWNER_NAME}`));
      await f.swipe({ x: call.box.x + call.box.width - 10, y: call.y }, -90);
      await expect(del(page)).toHaveCount(1);
      await expect(block(page, `Call, 11a to 11:30a, ${OWNER_NAME}`)).toHaveAttribute('data-swiped', '');
      expect((await del(page).boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await del(page).tap();
      await expect(block(page, `Call, 11a to 11:30a, ${OWNER_NAME}`)).toHaveCount(0);
      expect(posts).toEqual([{ action: 'delete', id: short, revision: 1, confirm: true }]);
      // The other one is still there, and a tap on it edits it in its block.
      await block(page, DENTIST).tap();
      await expect(page.locator('.day-ev.day-editing')).toHaveCount(1);
      await expect(page.locator('.day-ev-strip')).toHaveCount(0);
      await page.keyboard.press('Escape');
      expect((await stored(owner, date)).map((e: { id: string }) => e.id)).toEqual([id]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});
