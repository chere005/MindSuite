import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { apiLogin, farDate, field, login, pickList, resetPrefs, showHalf, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// Dragging an entry across the owner / Both / the partner with a finger (press and hold about 0.4 s, then move): in the Both view with the two lanes the
// block's centre, carried by the finger's sideways travel, says whom it is for. Real CDP touch events at 375x812. The mouse's are drag-owners.
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
const stored = async (api: Api, date: string) => (await api.snapshot()).events.filter((e: { date: string }) => e.date === date).sort((a: { start: number }, b: { start: number }) => a.start - b.start);
const block = (page: Page, label: string) => page.getByRole('button', { name: label, exact: true });
const editing = (page: Page) => page.locator('.day-ev.day-editing');
const bubble = (page: Page) => page.locator('.day-bubble');
const moving = (page: Page) => page.locator('.day-ev[data-moving]');
const gridBox = async (page: Page) => (await page.locator('.day-lanes').boundingBox())!;
const perMinute = async (page: Page) => {
  const minutes = await page.locator('.day-lanes').evaluate(el => Number((el as HTMLElement).dataset.span));
  return (await gridBox(page)).height / minutes;
};
const centre = async (locator: ReturnType<Page['locator']>) => { const box = (await locator.boundingBox())!; return { x: box.x + box.width / 2, y: box.y + box.height / 2, box }; };
const across = async (page: Page, fraction: number) => { const grid = await gridBox(page); return grid.x + grid.width * fraction; };
const settled = async (page: Page) => {
  await expect(page.locator('#sync-status')).not.toHaveText('Saving…');
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
};
function recordPosts(page: Page) {
  const posts: Array<Record<string, unknown>> = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('api.php')) { const body = request.postDataJSON(); if (body.action !== 'savePrefs') { posts.push(body); } } });
  return posts;
}
const BOTH = [OWNER, PARTNER];
/** A finger: down, hold until the block lifts, move in small steps, up. */
function finger(page: Page, cdp: CDPSession) {
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  let at = { x: 0, y: 0 };
  return {
    /** Presses and waits for the lift (the hold is about 0.4 s). */
    async hold(x: number, y: number) { at = { x, y }; await send('touchStart', x, y); await expect(moving(page)).toHaveCount(1, { timeout: 2000 }); },
    async to(x: number, y: number, steps = 16) {
      const from = at;
      for (let i = 1; i <= steps; i++) { await send('touchMove', from.x + ((x - from.x) * i) / steps, from.y + ((y - from.y) * i) / steps); await page.waitForTimeout(8); }
      at = { x, y };
    },
    down: (x: number, y: number) => { at = { x, y }; return send('touchStart', x, y); },
    up: () => send('touchEnd'),
  };
}

test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });

test.describe(`dragging an entry across ${OWNER_NAME}, Both and ${PARTNER_NAME} with a finger`, () => {
  test(`hold and move: ${OWNER_NAME} to Both to ${PARTNER_NAME} and back, the block in its new lanes and color, the bubble above the finger naming them; each lift is one write with the stored owners changed`, async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1840);
    const snapshot = await owner.snapshot();
    const tone = { partner: snapshot.lists.find((l: { id: string }) => l.id === PARTNER).color, both: snapshot.settings.bothColor, owner: snapshot.lists.find((l: { id: string }) => l.id === OWNER).color };
    const id = await add(owner, event(date));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      const f = finger(page, await page.context().newCDPSession(page));
      const grid = await gridBox(page), minute = await perMinute(page);
      let at = await centre(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`));
      expect(at.x, `${OWNER_NAME} is the left lane`).toBeLessThan(grid.x + grid.width / 3);
      await f.hold(at.x, at.y);
      await expect(bubble(page)).toHaveText('9a – 10a');
      await f.to(await across(page, 0.5), at.y);
      await expect(bubble(page)).toHaveText('9a – 10a · Both');
      await expect(moving(page)).toHaveAttribute('data-c', tone.both);
      expect((await moving(page).boundingBox())!.width, 'across both lanes').toBeGreaterThan(grid.width * 0.9);
      const label = (await bubble(page).boundingBox())!;
      expect(label.y + label.height, 'above the finger').toBeLessThanOrEqual(at.y - 20);
      expect(posts).toHaveLength(0);
      await f.up();
      await settled(page);
      await expect(block(page, 'Dentist, 9a to 10a, Both')).toBeVisible();
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: BOTH, text: 'Dentist', start: 540, length: 60 }]);
      expect((await stored(owner, date))[0]).toMatchObject({ owners: BOTH, revision: 2 });
      // Both to the partner, and an hour later in the same move.
      at = await centre(block(page, 'Dentist, 9a to 10a, Both'));
      await f.hold(at.x, at.y);
      await f.to(await across(page, 0.85), at.y + 60 * minute);
      await expect(bubble(page)).toHaveText(`10a – 11a · ${PARTNER_NAME}`);
      await expect(moving(page)).toHaveAttribute('data-c', tone.partner);
      await f.up();
      await settled(page);
      await expect(block(page, `Dentist, 10a to 11a, ${PARTNER_NAME}`)).toBeVisible();
      expect(posts).toHaveLength(2);
      expect(posts[1]).toEqual({ action: 'edit', kind: 'event', id, revision: 2, date, owners: [PARTNER], text: 'Dentist', start: 600, length: 60 });
      expect((await stored(owner, date))[0]).toMatchObject({ owners: [PARTNER], start: 600, revision: 3 });
      // The partner to the owner in one stroke, over the middle third.
      at = await centre(block(page, `Dentist, 10a to 11a, ${PARTNER_NAME}`));
      await f.hold(at.x, at.y);
      await f.to(await across(page, 0.5), at.y, 8);
      await expect(bubble(page)).toHaveText('10a – 11a · Both');
      await f.to(await across(page, 0.12), at.y, 8);
      await expect(bubble(page)).toHaveText(`10a – 11a · ${OWNER_NAME}`);
      await f.up();
      await settled(page);
      await expect(block(page, `Dentist, 10a to 11a, ${OWNER_NAME}`)).toBeVisible();
      expect(posts).toHaveLength(3);
      expect((await stored(owner, date))[0]).toMatchObject({ owners: [OWNER], start: 600, revision: 4 });
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test(`it lands on the nearest free quarter hour for whoever it becomes: the finger at 12:15p is free for ${OWNER_NAME}, but ${PARTNER_NAME}'s lane is taken at noon, so Both lands at 1p`, async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1841);
    const id = await add(owner, event(date));
    await add(owner, event(date, { text: 'Her call', owners: [PARTNER], start: 720, length: 60 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      const f = finger(page, await page.context().newCDPSession(page)), minute = await perMinute(page);
      const at = await centre(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`));
      const y = at.y + (12 * 60 + 15 - 9 * 60) * minute;
      await f.hold(at.x, at.y);
      await f.to(at.x, y);
      await expect(bubble(page)).toHaveText('12:15p – 1:15p');
      await f.to(await across(page, 0.5), y);
      await expect(bubble(page)).toHaveText('1p – 2p · Both');
      await f.to(await across(page, 0.85), y);
      await expect(bubble(page)).toHaveText(`1p – 2p · ${PARTNER_NAME}`);
      await f.to(await across(page, 0.5), y);
      await f.up();
      await settled(page);
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: BOTH, text: 'Dentist', start: 780, length: 60 }]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a swipe to the left before the hold is over still shows Delete (nothing moves); a held entry may then go left into Both', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1842);
    const id = await add(owner, event(date, { text: 'Her call', owners: [PARTNER], start: 720 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      const f = finger(page, await page.context().newCDPSession(page));
      let at = await centre(block(page, `Her call, 12p to 1p, ${PARTNER_NAME}`));
      const right = at.x + at.box.width / 2 - 14;
      await f.down(right, at.y);
      await f.to(right - 80, at.y, 8);
      await f.up();
      await expect(page.locator('.day-ev-del')).toHaveCount(1);
      await expect(moving(page)).toHaveCount(0);
      expect(posts).toHaveLength(0);
      // Put Delete away with a tap on the entry, then hold it and go left over the middle third.
      await block(page, `Her call, 12p to 1p, ${PARTNER_NAME}`).tap();
      await expect(page.locator('.day-ev-del')).toHaveCount(0);
      at = await centre(block(page, `Her call, 12p to 1p, ${PARTNER_NAME}`));
      await f.hold(at.x, at.y);
      await f.to(await across(page, 0.5), at.y);
      await expect(bubble(page)).toHaveText('12p – 1p · Both');
      await f.up();
      await settled(page);
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: BOTH, text: 'Her call', start: 720, length: 60 }]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('an entry being edited can be held and dragged left into Both: the draft takes the owners, the typed words stay, and Enter is one write', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1843);
    const id = await add(owner, event(date, { text: 'Her call', owners: [PARTNER], start: 720 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      const f = finger(page, await page.context().newCDPSession(page)), minute = await perMinute(page);
      await block(page, `Her call, 12p to 1p, ${PARTNER_NAME}`).tap();
      await expect(field(page, 'Edit entry: Her call')).toBeFocused();
      await page.keyboard.type(' now');
      const at = await centre(editing(page));
      await f.hold(at.x, at.y);
      await f.to(await across(page, 0.5), at.y + 15 * minute);
      await expect(bubble(page)).toHaveText('12:15p – 1:15p · Both');
      await expect(editing(page)).toHaveAttribute('data-who', 'Both');
      expect(posts, 'a draft: nothing is written').toHaveLength(0);
      await f.up();
      await expect(editing(page)).toHaveCount(1);
      await expect(field(page, 'Edit entry: Her call')).toHaveValue('Her call now');
      await field(page, 'Edit entry: Her call').press('Enter');
      await expect(editing(page)).toHaveCount(0);
      await settled(page);
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: BOTH, text: 'Her call now', start: 735, length: 60 }]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('with one list shown a held entry follows the finger in time only: its owners and the bubble stay as they were', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1844);
    const id = await add(owner, event(date));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      await pickList(page, OWNER_NAME);
      const f = finger(page, await page.context().newCDPSession(page)), minute = await perMinute(page);
      const at = await centre(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`));
      await f.hold(at.x, at.y);
      await f.to(at.x + 100, at.y + 60 * minute);
      await expect(bubble(page)).toHaveText('10a – 11a');
      await f.up();
      await settled(page);
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: [OWNER], text: 'Dentist', start: 600, length: 60 }]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});
