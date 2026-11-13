import { expect, test, type Page } from '@playwright/test';
import { apiLogin, farDate, field, login, overlayList, pickList, resetPrefs, unique, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// Dragging an entry across the owner / Both / the partner (the owner, 2026-11-02: "allow dragging from the owner to both to the partner"), with a real mouse. In the Both view
// with the two people's lanes, the schedule is cut in thirds: the block's centre, carried by the pointer's sideways travel, says whom the entry is
// for (left: the signed-in person, middle: both, right: the other). It lands on the nearest free quarter hour for them, in one write. Anywhere else a
// drag never changes owners. Alt+Left and Alt+Right do it from the keyboard. Desktop project; the finger's is drag-owners-phone.
const add = async (api: Api, body: Record<string, unknown>) => {
  const data = { id: crypto.randomUUID(), ...body };
  const response = await api.post(data);
  expect(response.status(), JSON.stringify(await response.json())).toBe(200);
  return data.id as string;
};
const event = (date: string, over: Record<string, unknown> = {}) => ({ action: 'add', kind: 'event', date, owners: [OWNER], text: 'Dentist', start: 540, length: 60, ...over });
const openDay = async (page: Page, date: string) => {
  await page.locator('#jump-date').fill(date);
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
const centre = async (locator: ReturnType<Page['locator']>) => {
  await locator.scrollIntoViewIfNeeded();
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
};
/** The drop's write has been answered and the page has drawn the answer. */
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
/** A press moves a little (5px, under half a quarter hour on this grid) to lift the block without changing its time. */
const NUDGE = 5;
/** Where a fraction of the schedule's width is on the screen. */
const across = async (page: Page, fraction: number) => { const grid = await gridBox(page); return grid.x + grid.width * fraction; };
/** The color key of a person's list and the Both color, as the page draws them. */
const colors = async (api: Api) => { const snapshot = await api.snapshot(); return { owner: snapshot.lists.find((l: { id: string }) => l.id === OWNER).color, partner: snapshot.lists.find((l: { id: string }) => l.id === PARTNER).color, both: snapshot.settings.bothColor }; };
/** A mouse press on `from`, then the pointer moved in small steps to a place, the button left down. */
async function pressAt(page: Page, from: { x: number; y: number }) { await page.mouse.move(from.x, from.y); await page.mouse.down(); }
const moveTo = (page: Page, x: number, y: number, steps = 16) => page.mouse.move(x, y, { steps });

test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });

test.describe(`dragging an entry across ${OWNER_NAME}, Both and ${PARTNER_NAME} with a mouse`, () => {
  test(`${OWNER_NAME} to Both to ${PARTNER_NAME} and back: the block shows its new lanes in the owner's color, the bubble names them, and each drop is one write with the stored owners changed`, async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1820), tone = await colors(owner);
    const id = await add(owner, event(date));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      const grid = await gridBox(page);
      let at = await centre(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`));
      expect(at.x, `${OWNER_NAME} is the left lane`).toBeLessThan(grid.x + grid.width / 3);
      // Along its own lane the bubble is what it always was.
      await pressAt(page, at);
      await moveTo(page, at.x, at.y + NUDGE, 4);
      await expect(bubble(page)).toHaveText('9a – 10a');
      // To the middle third: one block across both lanes, in the Both color; nothing is written while it moves.
      await moveTo(page, await across(page, 0.5), at.y);
      await expect(bubble(page)).toHaveText('9a – 10a · Both');
      await expect(moving(page)).toHaveAttribute('data-c', tone.both);
      await expect(moving(page)).toHaveAttribute('data-who', 'Both');
      await expect(moving(page)).toHaveAttribute('aria-label', 'Dentist, 9a to 10a, Both');
      expect((await moving(page).boundingBox())!.width, 'across both lanes').toBeGreaterThan(grid.width * 0.9);
      expect(posts).toHaveLength(0);
      await page.mouse.up();
      await settled(page);
      await expect(block(page, 'Dentist, 9a to 10a, Both')).toBeVisible();
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: BOTH, text: 'Dentist', start: 540, length: 60 }]);
      expect((await stored(owner, date))[0]).toMatchObject({ owners: BOTH, start: 540, revision: 2 });
      // To the right third: the partner's lane, in the partner's color.
      at = await centre(block(page, 'Dentist, 9a to 10a, Both'));
      await pressAt(page, at);
      await moveTo(page, await across(page, 0.85), at.y);
      await expect(bubble(page)).toHaveText(`9a – 10a · ${PARTNER_NAME}`);
      await expect(moving(page)).toHaveAttribute('data-c', tone.partner);
      expect((await moving(page).boundingBox())!.x, 'in the right lane').toBeGreaterThan(grid.x + grid.width / 2 - 2);
      await page.mouse.up();
      await settled(page);
      await expect(block(page, `Dentist, 9a to 10a, ${PARTNER_NAME}`)).toBeVisible();
      expect(posts).toHaveLength(2);
      expect(posts[1]).toEqual({ action: 'edit', kind: 'event', id, revision: 2, date, owners: [PARTNER], text: 'Dentist', start: 540, length: 60 });
      expect((await stored(owner, date))[0]).toMatchObject({ owners: [PARTNER], revision: 3 });
      // All the way back to the left third, with the time moved too: one write for both.
      at = await centre(block(page, `Dentist, 9a to 10a, ${PARTNER_NAME}`));
      const minute = await perMinute(page);
      await pressAt(page, at);
      await moveTo(page, at.x, at.y + NUDGE, 4);
      await moveTo(page, await across(page, 0.12), at.y + 60 * minute);
      await expect(bubble(page)).toHaveText(`10a – 11a · ${OWNER_NAME}`);
      await expect(moving(page)).toHaveAttribute('data-c', tone.owner);
      await page.mouse.up();
      await settled(page);
      await expect(block(page, `Dentist, 10a to 11a, ${OWNER_NAME}`)).toBeVisible();
      expect(posts).toHaveLength(3);
      expect(posts[2]).toEqual({ action: 'edit', kind: 'event', id, revision: 3, date, owners: [OWNER], text: 'Dentist', start: 600, length: 60 });
      expect((await stored(owner, date))[0]).toMatchObject({ owners: [OWNER], start: 600, revision: 4 });
      // Dragged out to a third and back to where it was, nothing is written.
      at = await centre(block(page, `Dentist, 10a to 11a, ${OWNER_NAME}`));
      await pressAt(page, at);
      await moveTo(page, await across(page, 0.5), at.y);
      await expect(bubble(page)).toHaveText('10a – 11a · Both');
      await moveTo(page, at.x, at.y);
      await expect(bubble(page)).toHaveText('10a – 11a');
      await page.mouse.up();
      await settled(page);
      expect(posts).toHaveLength(3);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a press anywhere on a block and a drag straight up or down never changes whom it is for; a linked block grabbed in its right part stays Both', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1821);
    const dinner = await add(owner, event(date, { text: 'Dinner', owners: BOTH, start: 1080 }));
    await add(owner, event(date, { text: 'Hers', owners: [PARTNER], start: 540 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      const minute = await perMinute(page);
      const grid = await gridBox(page);
      // The right end of the Both block is the right third of the schedule.
      const wide = await centre(block(page, 'Dinner, 6p to 7p, Both'));
      const grab = { x: grid.x + grid.width * 0.9, y: wide.y };
      await pressAt(page, grab);
      await moveTo(page, grab.x, grab.y - 60 * minute);
      await expect(bubble(page)).toHaveText('5p – 6p');
      await page.mouse.up();
      await settled(page);
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id: dinner, revision: 1, date, owners: BOTH, text: 'Dinner', start: 1020, length: 60 }]);
      // The same for the partner's block, grabbed at its left edge (the middle third of the schedule).
      const hers = await centre(block(page, `Hers, 9a to 10a, ${PARTNER_NAME}`));
      const edge = { x: grid.x + grid.width / 2 + 12, y: hers.y };
      await pressAt(page, edge);
      await moveTo(page, edge.x, edge.y + 60 * minute);
      await expect(bubble(page)).toHaveText('10a – 11a');
      await page.mouse.up();
      await settled(page);
      expect((await stored(owner, date)).find((e: { text: string }) => e.text === 'Hers')).toMatchObject({ owners: [PARTNER], start: 600 });
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test(`it lands on the nearest free quarter hour for whoever it becomes: free for ${OWNER_NAME}, taken in ${PARTNER_NAME}'s lane, so Both and ${PARTNER_NAME} land elsewhere`, async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1822);
    const id = await add(owner, event(date));
    await add(owner, event(date, { text: 'Her call', owners: [PARTNER], start: 720, length: 60 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      const minute = await perMinute(page);
      const at = await centre(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`));
      // The pointer goes to 12:15p (the block's start is 12:15p) and then across the thirds at that height.
      await pressAt(page, at);
      await moveTo(page, at.x, at.y + (12 * 60 + 15 - 9 * 60) * minute);
      await expect(bubble(page)).toHaveText('12:15p – 1:15p');
      // The owner's lane is free there; the middle third needs the partner's lane too: the nearest free hour is 1p (45 minutes on), not 11a; and so for the partner.
      await moveTo(page, await across(page, 0.5), at.y + (12 * 60 + 15 - 9 * 60) * minute);
      await expect(bubble(page)).toHaveText('1p – 2p · Both');
      await moveTo(page, await across(page, 0.85), at.y + (12 * 60 + 15 - 9 * 60) * minute);
      await expect(bubble(page)).toHaveText(`1p – 2p · ${PARTNER_NAME}`);
      await moveTo(page, await across(page, 0.12), at.y + (12 * 60 + 15 - 9 * 60) * minute);
      await expect(bubble(page)).toHaveText('12:15p – 1:15p');
      await moveTo(page, await across(page, 0.5), at.y + (12 * 60 + 15 - 9 * 60) * minute);
      await expect(bubble(page)).toHaveText('1p – 2p · Both');
      await page.mouse.up();
      await settled(page);
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: BOTH, text: 'Dentist', start: 780, length: 60 }]);
      expect((await stored(owner, date)).find((e: { text: string }) => e.text === 'Dentist')).toMatchObject({ owners: BOTH, start: 780 });
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('where no start is free for those owners the preview stays at the last good place, with the last good owners, and a drop there writes nothing', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1823);
    await add(owner, event(date));
    // The partner's whole day, 7a to 7a, in three entries: no hour is free in her lane, so nothing can be hers or both of ours.
    for (const [start, length] of [[420, 420], [840, 420], [1260, 600]]) { await add(owner, event(date, { text: `${PARTNER_NAME} ${start}`, owners: [PARTNER], start, length })); }
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      const at = await centre(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`));
      await pressAt(page, at);
      await moveTo(page, at.x, at.y + NUDGE, 4);
      await moveTo(page, await across(page, 0.5), at.y);
      await expect(bubble(page)).toHaveText('9a – 10a');
      await moveTo(page, await across(page, 0.85), at.y);
      await expect(bubble(page)).toHaveText('9a – 10a');
      await expect(moving(page)).toHaveAttribute('data-who', OWNER_NAME);
      expect((await moving(page).boundingBox())!.x, `still in ${OWNER_NAME}'s lane`).toBeLessThan((await gridBox(page)).x + (await gridBox(page)).width / 3);
      await page.mouse.up();
      await settled(page);
      expect(posts).toHaveLength(0);
      expect((await stored(owner, date)).find((e: { text: string }) => e.text === 'Dentist')).toMatchObject({ owners: [OWNER], revision: 1 });
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a left swipe on an entry that is not being edited still shows its Delete; a drag that has already lifted (it went down first) may then go left into Both', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1824);
    const id = await add(owner, event(date, { text: 'Her call', owners: [PARTNER], start: 720 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      const minute = await perMinute(page);
      let at = await centre(block(page, `Her call, 12p to 1p, ${PARTNER_NAME}`));
      // Sideways to the left before it lifts: the swipe, not a move across the thirds.
      await pressAt(page, { x: at.x + at.box.width / 2 - 14, y: at.y });
      await moveTo(page, at.x + at.box.width / 2 - 14 - 90, at.y, 12);
      await page.mouse.up();
      await expect(page.locator('.day-ev-del')).toHaveCount(1);
      await expect(bubble(page)).toHaveCount(0);
      expect(posts).toHaveLength(0);
      await page.keyboard.press('Escape');
      await expect(page.locator('.day-ev-del')).toHaveCount(0);
      // Down first, so it lifts; then left across the middle of the schedule: it is Both's.
      at = await centre(block(page, `Her call, 12p to 1p, ${PARTNER_NAME}`));
      await pressAt(page, at);
      await moveTo(page, at.x, at.y + 15 * minute, 6);
      await expect(moving(page)).toHaveCount(1);
      await moveTo(page, await across(page, 0.5), at.y + 15 * minute);
      await expect(bubble(page)).toHaveText('12:15p – 1:15p · Both');
      await page.mouse.up();
      await settled(page);
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: BOTH, text: 'Her call', start: 735, length: 60 }]);
      expect((await stored(owner, date))[0]).toMatchObject({ owners: BOTH, start: 735 });
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('an entry being edited can be dragged left into Both: the draft changes owners (the block, its color and its pill), the words typed are kept, and Enter is one write', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1825), tone = await colors(owner);
    const id = await add(owner, event(date, { text: 'Her call', owners: [PARTNER], start: 720 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      const minute = await perMinute(page);
      await block(page, `Her call, 12p to 1p, ${PARTNER_NAME}`).click();
      await expect(editing(page)).toHaveCount(1);
      await page.keyboard.type(' now');
      await expect(page.locator('.day-when')).toHaveAttribute('data-c', tone.partner);
      const at = await centre(editing(page));
      // On the field, a press is a move only when it goes up or down first; then it may go left.
      await pressAt(page, at);
      await moveTo(page, at.x, at.y + 15 * minute, 6);
      await moveTo(page, await across(page, 0.5), at.y + 15 * minute);
      await expect(bubble(page)).toHaveText('12:15p – 1:15p · Both');
      await expect(editing(page)).toHaveAttribute('data-who', 'Both');
      await expect(editing(page)).toHaveAttribute('data-c', tone.both);
      expect((await editing(page).boundingBox())!.width, 'across both lanes').toBeGreaterThan((await gridBox(page)).width * 0.9);
      expect(posts, 'nothing is written while it is a draft').toHaveLength(0);
      await page.mouse.up();
      await expect(editing(page)).toHaveCount(1);
      await expect(page.locator('.day-when')).toHaveAttribute('data-c', tone.both);
      await expect(page.locator('.day-when')).toHaveText('12:15p – 1:15p');
      await expect(field(page, 'Edit entry: Her call')).toHaveValue('Her call now');
      expect(posts).toHaveLength(0);
      await page.keyboard.press('Enter');
      await expect(editing(page)).toHaveCount(0);
      await settled(page);
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: BOTH, text: 'Her call now', start: 735, length: 60 }]);
      expect((await stored(owner, date))[0]).toMatchObject({ owners: BOTH, text: 'Her call now', start: 735, revision: 2 });
      // Escape in the middle of such a drag puts the draft back, owners included; leaving the edit then writes nothing.
      await block(page, 'Her call now, 12:15p to 1:15p, Both').click();
      const again = await centre(editing(page));
      await pressAt(page, again);
      await moveTo(page, again.x, again.y + 15 * minute, 6);
      await moveTo(page, await across(page, 0.9), again.y + 15 * minute);
      await expect(bubble(page)).toHaveText(`12:30p – 1:30p · ${PARTNER_NAME}`);
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await expect(editing(page)).toHaveAttribute('data-who', 'Both');
      await expect(page.locator('.day-when')).toHaveText('12:15p – 1:15p');
      await page.keyboard.press('Enter');
      await settled(page);
      expect(posts).toHaveLength(1);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test(`a new entry being typed can be dragged to ${PARTNER_NAME} too, and is added for her`, async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1826);
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      const minute = await perMinute(page);
      const grid = await gridBox(page);
      // A tap in the left third at 10a starts a new entry for the owner.
      await page.mouse.click(grid.x + grid.width * 0.15, grid.y + (10 * 60 - 420) * minute + 2);
      await expect(editing(page)).toHaveCount(1);
      await page.keyboard.type('Pickup');
      const at = await centre(editing(page));
      await pressAt(page, at);
      await moveTo(page, at.x, at.y + 6, 4);
      await moveTo(page, await across(page, 0.85), at.y + 6);
      await expect(editing(page)).toHaveAttribute('data-who', PARTNER_NAME);
      await page.mouse.up();
      await page.keyboard.press('Enter');
      await expect.poll(async () => (await stored(owner, date)).length).toBe(1);
      expect((await stored(owner, date))[0]).toMatchObject({ owners: [PARTNER], text: 'Pickup' });
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ action: 'add', kind: 'event', owners: [PARTNER], text: 'Pickup' });
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('Escape in the middle of a drag across the thirds puts the block back in its lane and writes nothing; a stale drop goes back to its lane and says so', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER), date = farDate(1827);
    const id = await add(owner, event(date));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      let at = await centre(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`));
      await pressAt(page, at);
      await moveTo(page, await across(page, 0.85), at.y);
      await expect(bubble(page)).toHaveText(`9a – 10a · ${PARTNER_NAME}`);
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await expect(bubble(page)).toHaveCount(0);
      await expect(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`)).toBeVisible();
      await expect(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`)).toHaveAttribute('data-c', (await colors(owner)).owner);
      expect(Math.abs((await block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`).boundingBox())!.x - at.box.x)).toBeLessThanOrEqual(1);
      expect(posts).toHaveLength(0);
      // The partner renames it while the pointer is down: the drop is stale, the shell says so, and the block is in the owner's lane again.
      at = await centre(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`));
      await pressAt(page, at);
      await moveTo(page, await across(page, 0.5), at.y);
      await expect(bubble(page)).toHaveText('9a – 10a · Both');
      expect((await partner.post({ action: 'edit', kind: 'event', id, revision: 1, date, owners: [OWNER], text: 'Orthodontist', start: 540, length: 60 })).status()).toBe(200);
      await page.mouse.up();
      await expect(page.getByRole('alert')).toContainText('changed on another device');
      await expect(block(page, `Orthodontist, 9a to 10a, ${OWNER_NAME}`)).toBeVisible();
      expect((await stored(owner, date))[0]).toMatchObject({ text: 'Orthodontist', owners: [OWNER], revision: 2 });
      expect((await block(page, `Orthodontist, 9a to 10a, ${OWNER_NAME}`).boundingBox())!.x).toBeLessThan((await gridBox(page)).x + (await gridBox(page)).width / 3);
    } finally { await clearDay(owner, date); await owner.dispose(); await partner.dispose(); }
  });

  test(`${PARTNER_NAME} signed in sees herself on the left: the thirds read ${PARTNER_NAME}, both, ${OWNER_NAME}`, async ({ browser, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1828);
    const id = await add(owner, event(date, { text: 'Hers', owners: [PARTNER] }));
    const context = await browser.newContext({ baseURL, viewport: { width: 1360, height: 900 } });
    const page = await context.newPage();
    const posts = recordPosts(page);
    try {
      await login(page, PARTNER); await openDay(page, date);
      const grid = await gridBox(page);
      const at = await centre(block(page, 'Hers, 9a to 10a, You'.replace('You', PARTNER_NAME)));
      expect(at.x, `${PARTNER_NAME} is the left lane for ${PARTNER_NAME}`).toBeLessThan(grid.x + grid.width / 3);
      await pressAt(page, at);
      await moveTo(page, await across(page, 0.85), at.y);
      await expect(bubble(page)).toHaveText(`9a – 10a · ${OWNER_NAME}`);
      await page.mouse.up();
      await settled(page);
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: [OWNER], text: 'Hers', start: 540, length: 60 }]);
    } finally { await context.close(); await clearDay(owner, date); await owner.dispose(); }
  });
});

test.describe('anywhere else a drag never changes owners', () => {
  test('one list on its own, and the Both view with a list on top (three lanes): the pointer may go anywhere sideways, the entry stays for the same people, the bubble has no owner', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1829);
    const camp = crypto.randomUUID(), name = unique('Camp').slice(0, 24);
    expect((await owner.post({ action: 'saveList', id: camp, name, color: 'blue', revision: 0 })).status()).toBe(200);
    const mine = await add(owner, event(date));
    const dinner = await add(owner, event(date, { text: 'Dinner', owners: BOTH, start: 1080 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      const minute = await perMinute(page);
      // The owner's list alone: one lane across the whole schedule.
      await pickList(page, OWNER_NAME);
      let at = await centre(block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`));
      await pressAt(page, at);
      await moveTo(page, at.x + 200, at.y + 60 * minute);
      await expect(bubble(page)).toHaveText('10a – 11a');
      await expect(moving(page)).toHaveAttribute('data-who', OWNER_NAME);
      await page.mouse.up();
      await settled(page);
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id: mine, revision: 1, date, owners: [OWNER], text: 'Dentist', start: 600, length: 60 }]);
      // Both with a list on top: three lanes, no thirds. The owner's entry and the linked one stay as they are.
      await pickList(page, 'Both');
      await overlayList(page, name);
      const grid = await gridBox(page);
      at = await centre(block(page, `Dentist, 10a to 11a, ${OWNER_NAME}`));
      await pressAt(page, at);
      await moveTo(page, grid.x + grid.width * 0.9, at.y + 30 * minute);
      await expect(bubble(page)).toHaveText('10:30a – 11:30a');
      await page.mouse.up();
      await settled(page);
      at = await centre(block(page, 'Dinner, 6p to 7p, Both'));
      await pressAt(page, at);
      await moveTo(page, grid.x + grid.width * 0.9, at.y - 30 * minute);
      await expect(bubble(page)).toHaveText('5:30p – 6:30p');
      await page.mouse.up();
      await settled(page);
      expect(posts).toHaveLength(3);
      expect(posts[1]).toMatchObject({ id: mine, owners: [OWNER], start: 630 });
      expect(posts[2]).toMatchObject({ id: dinner, owners: BOTH, start: 1050 });
      const all = await stored(owner, date);
      expect(all.map((e: { text: string; owners: string[] }) => [e.text, e.owners])).toEqual([['Dentist', [OWNER]], ['Dinner', BOTH]]);
    } finally {
      await clearDay(owner, date);
      const list = (await owner.snapshot()).lists.find((l: { id: string }) => l.id === camp);
      if (list) { await owner.post({ action: 'deleteList', id: camp, revision: list.revision, confirm: true }); }
      await owner.dispose();
    }
  });

  test('Alt+Left and Alt+Right do nothing outside the Both view\'s thirds (and leave the key to the browser)', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1830);
    await add(owner, event(date));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await pickList(page, OWNER_NAME);
      await block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`).focus();
      const prevented = await page.evaluate(() => new Promise<boolean[]>(resolve => {
        const seen: boolean[] = [];
        const el = document.activeElement!;
        window.addEventListener('keydown', e => { if (e.altKey) { seen.push(e.defaultPrevented); } }, { once: false });
        setTimeout(() => resolve(seen), 300);
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true }));
      }));
      expect(prevented).toEqual([false]);
      expect(posts).toHaveLength(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});

test.describe('Alt+Left and Alt+Right', () => {
  test(`one third at a time, ${OWNER_NAME} to Both to ${PARTNER_NAME} and back, each a write with the new owners, said out loud, and the focus stays on the entry; the ends say so`, async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1831);
    const id = await add(owner, event(date, { text: 'Dinner', start: 1125, length: 45 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await block(page, `Dinner, 6:45p to 7:30p, ${OWNER_NAME}`).focus();
      await page.keyboard.press('Alt+ArrowRight');
      await expect(block(page, 'Dinner, 6:45p to 7:30p, Both')).toBeFocused();
      await expect(page.locator('#live')).toHaveText('Dinner is for both of you, 6:45p – 7:30p.');
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: BOTH, text: 'Dinner', start: 1125, length: 45 }]);
      await page.keyboard.press('Alt+ArrowRight');
      await expect(block(page, `Dinner, 6:45p to 7:30p, ${PARTNER_NAME}`)).toBeFocused();
      await expect(page.locator('#live')).toHaveText(`Dinner is for ${PARTNER_NAME}, 6:45p – 7:30p.`);
      expect((await stored(owner, date))[0]).toMatchObject({ owners: [PARTNER], revision: 3 });
      // The right end: nothing is written.
      await page.keyboard.press('Alt+ArrowRight');
      await expect(page.locator('#live')).toHaveText(`Dinner is for ${PARTNER_NAME}: it cannot go further right.`);
      expect(posts).toHaveLength(2);
      await page.keyboard.press('Alt+ArrowLeft');
      await expect(block(page, 'Dinner, 6:45p to 7:30p, Both')).toBeFocused();
      await page.keyboard.press('Alt+ArrowLeft');
      await expect(block(page, `Dinner, 6:45p to 7:30p, ${OWNER_NAME}`)).toBeFocused();
      await expect(page.locator('#live')).toHaveText('Dinner is for you, 6:45p – 7:30p.');
      await page.keyboard.press('Alt+ArrowLeft');
      await expect(page.locator('#live')).toHaveText('Dinner is for you: it cannot go further left.');
      expect(posts).toHaveLength(4);
      expect((await stored(owner, date))[0]).toMatchObject({ owners: [OWNER], start: 1125, revision: 5 });
      // Without Alt the arrows do nothing to it.
      await page.keyboard.press('ArrowRight');
      expect(posts).toHaveLength(4);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the same placement as a drag: where the new lanes are busy at its start, it lands on the nearest free quarter hour, and says that time; with no room it says so and writes nothing', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1832);
    const id = await add(owner, event(date));
    await add(owner, event(date, { text: 'Her call', owners: [PARTNER], start: 540, length: 60 }));
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`).focus();
      // The partner is busy 9 to 10: for both of them it is 8a (as near as 10a, and earlier).
      await page.keyboard.press('Alt+ArrowRight');
      await expect(block(page, 'Dentist, 8a to 9a, Both')).toBeFocused();
      await expect(page.locator('#live')).toHaveText('Dentist is for both of you, 8a – 9a.');
      expect(posts).toEqual([{ action: 'edit', kind: 'event', id, revision: 1, date, owners: BOTH, text: 'Dentist', start: 480, length: 60 }]);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test(`with ${PARTNER_NAME}'s whole day taken it says there is no room and writes nothing`, async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1833);
    await add(owner, event(date));
    for (const [start, length] of [[420, 420], [840, 420], [1260, 600]]) { await add(owner, event(date, { text: `${PARTNER_NAME} ${start}`, owners: [PARTNER], start, length })); }
    const posts = recordPosts(page);
    try {
      await login(page); await openDay(page, date);
      await block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`).focus();
      await page.keyboard.press('Alt+ArrowRight');
      await expect(page.locator('#live')).toHaveText('Dentist cannot be for both of you: there is no room.');
      expect(posts).toHaveLength(0);
      expect((await stored(owner, date)).find((e: { text: string }) => e.text === 'Dentist')).toMatchObject({ owners: [OWNER], revision: 1 });
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});
