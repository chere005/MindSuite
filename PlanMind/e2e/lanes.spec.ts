import { expect, test, type Page, type Route } from '@playwright/test';
import { COLOR_HUES, tint, type ColorKey } from '../packages/core/src/planner';
import { THEMES, type ThemeName } from '../app/theme';
import { addTodo, apiLogin, farDate, login, resetPrefs, unique, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// Lanes and colors on the Day panel: who is on the left, what spans both lanes, what each list and Both look like in
// every theme, and how overlays and a single list change the lanes. Desktop project.
const add = async (api: Api, body: Record<string, unknown>) => {
  const data = { id: crypto.randomUUID(), ...body };
  const response = await api.post(data);
  expect(response.status(), JSON.stringify(await response.json())).toBe(200);
  return data.id as string;
};
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
const BOTH = { selection: { base: 'both', overlays: [] } };
const rgb = (hex: string) => `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
const isGet = (route: Route) => route.request().method() === 'GET';
const seed = async (api: Api, date: string) => {
  await add(api, { action: 'add', kind: 'event', date, owners: [OWNER], text: 'Gym', start: 480, length: 60 });
  await add(api, { action: 'add', kind: 'event', date, owners: [PARTNER], text: 'Yoga', start: 540, length: 60 });
  await add(api, { action: 'add', kind: 'event', date, owners: [OWNER, PARTNER], text: 'Lunch together', start: 720, length: 60 });
  await add(api, { action: 'add', kind: 'priority', date, owners: [OWNER], slots: { [OWNER]: 1 }, text: 'Ship it' });
  await add(api, { action: 'add', kind: 'priority', date, owners: [PARTNER], slots: { [PARTNER]: 1 }, text: 'Call school' });
  await add(api, { action: 'add', kind: 'priority', date, owners: [OWNER, PARTNER], slots: { [PARTNER]: 2, [OWNER]: 2 }, text: 'Family dinner' });
  await add(api, { action: 'add', kind: 'priority', date, owners: [OWNER, PARTNER], slots: { [PARTNER]: 3, [OWNER]: 4 }, text: 'Renew passport' });
  await add(api, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER], title: `${OWNER_NAME} thing` });
  await add(api, { action: 'add', kind: 'todo', scope: 'day', date, owners: [PARTNER], title: `${PARTNER_NAME} thing` });
  await add(api, { action: 'add', kind: 'todo', scope: 'day', date, owners: [OWNER, PARTNER], title: 'Both thing' });
};
const cell = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name}, `) });

test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });

test.describe('Lanes and colors', () => {
  test(`the signed-in person is the left lane, for ${OWNER_NAME} and for ${PARTNER_NAME}`, async ({ browser, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(400);
    await seed(owner, date);
    const contexts = [] as Awaited<ReturnType<typeof browser.newContext>>[];
    try {
      for (const [user, left, right] of [[OWNER, 'Ship it', 'Call school'], [PARTNER, 'Call school', 'Ship it']] as const) {
        const context = await browser.newContext({ baseURL: baseURL!, viewport: { width: 1360, height: 900 } });
        contexts.push(context);
        const page = await context.newPage();
        await login(page, user); await openDay(page, date);
        const mine = user === OWNER ? OWNER_NAME : PARTNER_NAME, other = user === OWNER ? PARTNER_NAME : OWNER_NAME;
        await expect(page.locator('.day-sched .day-lane')).toHaveText([`${mine} · you`, other]);
        await expect(page.locator('.day-prio .day-lane')).toHaveText([`${mine} · you`, other]);
        const [a, b] = [(await cell(page, `Priority 1: ${left}`).boundingBox())!, (await cell(page, `Priority 1: ${right}`).boundingBox())!];
        expect(a.x).toBeLessThan(b.x);
        // The same on the schedule: the signed-in person's 8a/9a entry is in the left column of the grid.
        const grid = (await page.locator('.day-lanes').boundingBox())!;
        const own = (await cell(page, user === OWNER ? 'Gym' : 'Yoga').boundingBox())!, theirs = (await cell(page, user === OWNER ? 'Yoga' : 'Gym').boundingBox())!;
        expect(own.x).toBeLessThan(grid.x + grid.width / 2);
        expect(theirs.x).toBeGreaterThan(grid.x + grid.width / 2 - 2);
      }
    } finally { await Promise.all(contexts.map(c => c.close())); await clearDay(owner, date); await owner.dispose(); }
  });

  test('a Both entry spans both lanes; the same line is one cell, different lines are two half cells, all in the Both color', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(401);
    await seed(owner, date);
    try {
      await login(page); await openDay(page, date);
      const grid = (await page.locator('.day-lanes').boundingBox())!;
      const [gym, lunch] = [(await cell(page, 'Gym').boundingBox())!, (await cell(page, 'Lunch together').boundingBox())!];
      expect(gym.width).toBeLessThan(grid.width * 0.55);
      expect(lunch.width).toBeGreaterThan(grid.width * 0.9);
      await expect(cell(page, 'Lunch together')).toHaveAttribute('data-c', 'purple');
      // Priorities: line 2 is one cell across both lanes.
      const row = (await page.locator('.day-prio .day-pcells').first().boundingBox())!;
      await expect(page.locator('.day-cell[aria-label^="Priority 2: Family dinner"]')).toHaveCount(1);
      expect((await cell(page, 'Priority 2: Family dinner').boundingBox())!.width).toBeGreaterThan(row.width - 6);
      await expect(cell(page, 'Priority 2: Family dinner')).toHaveAttribute('data-c', 'purple');
      // Lines 3 and 4 are the same entry on different lines: two cells, one per lane, each one lane wide, both purple.
      const passport = page.locator('.day-cell[aria-label*="Renew passport"]');
      await expect(passport).toHaveCount(2);
      for (const part of await passport.all()) {
        await expect(part).toHaveAttribute('data-c', 'purple');
        await expect(part).toHaveAttribute('data-line', /^[34]$/);
        expect((await part.boundingBox())!.width).toBeLessThan(row.width * 0.55);
      }
      const [partner, mine] = [(await cell(page, 'Priority 3: Renew passport').boundingBox())!, (await cell(page, 'Priority 4: Renew passport').boundingBox())!];
      expect(partner.x).toBeGreaterThan(mine.x + 20);
      expect(partner.y).toBeLessThan(mine.y);
      // To-do stays one list with a colored circle per owner.
      await expect(page.locator('.day-tasks .day-circle')).toHaveCount(3);
      await expect(page.locator('.day-task', { has: page.getByRole('button', { name: 'Edit Both thing' }) }).locator('.day-circle')).toHaveAttribute('data-c', 'purple');
      await expect(page.locator('.day-task', { has: page.getByRole('button', { name: `Edit ${OWNER_NAME} thing` }) }).locator('.day-circle')).toHaveAttribute('data-c', 'green');
      await expect(page.locator('.day-task', { has: page.getByRole('button', { name: `Edit ${PARTNER_NAME} thing` }) }).locator('.day-circle')).toHaveAttribute('data-c', 'yellow');
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test(`${OWNER_NAME} is green, ${PARTNER_NAME} yellow and Both purple in all four themes, read from the tinted variables`, async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(402);
    await seed(owner, date);
    let theme: ThemeName = 'midnight';
    await page.route(url => url.pathname.endsWith('/api.php'), async route => {
      if (!isGet(route)) { return route.continue(); }
      const response = await route.fetch();
      const body = await response.json();
      return route.fulfill({ response, json: 'theme' in body ? { ...body, theme } : body });
    });
    try {
      await login(page);
      for (const name of Object.keys(THEMES) as ThemeName[]) {
        theme = name;
        await page.reload();
        await openDay(page, date);
        const expected = (key: ColorKey) => tint(COLOR_HUES[key], THEMES[name].surface, THEMES[name].text);
        for (const [label, key] of [['Gym', 'green'], ['Yoga', 'yellow'], ['Lunch together', 'purple'], ['Priority 1: Ship it', 'green'], ['Priority 1: Call school', 'yellow'], ['Priority 2: Family dinner', 'purple']] as const) {
          const target = cell(page, label);
          await expect(target, `${name} ${label}`).toHaveAttribute('data-c', key);
          const painted = await target.evaluate(el => { const s = getComputedStyle(el); return { bg: s.backgroundColor, fg: s.color, line: s.borderTopColor }; });
          expect(painted, `${name} ${label}`).toEqual({ bg: rgb(expected(key).bg), fg: rgb(expected(key).fg), line: rgb(expected(key).line) });
        }
      }
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test(`list colors and the Both color come from the settings: recolor ${PARTNER_NAME} and Both, and every place follows`, async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(403);
    await seed(owner, date);
    const before = await owner.snapshot();
    const partnerList = before.lists.find((l: { id: string }) => l.id === PARTNER);
    try {
      expect((await owner.post({ action: 'saveSettings', bothColor: 'blue', revision: before.settings.revision })).status()).toBe(200);
      expect((await owner.post({ action: 'saveList', id: PARTNER, color: 'red', revision: partnerList.revision })).status()).toBe(200);
      await login(page); await openDay(page, date);
      await expect(cell(page, 'Lunch together')).toHaveAttribute('data-c', 'blue');
      await expect(cell(page, 'Priority 2: Family dinner')).toHaveAttribute('data-c', 'blue');
      await expect(cell(page, 'Yoga')).toHaveAttribute('data-c', 'red');
      await expect(page.locator('.day-task', { has: page.getByRole('button', { name: 'Edit Both thing' }) }).locator('.day-circle')).toHaveAttribute('data-c', 'blue');
      await expect(page.locator('.day-sched .day-lane').nth(1)).toHaveAttribute('data-c', 'red');
      // What a new to-do takes follows the settings too: under Both the Both color, under the partner the partner's.
      const mineBoth = unique('Under Both'), minePartner = unique(`Under ${PARTNER_NAME}`);
      await addTodo(page, mineBoth);
      await expect(page.locator('.day-task', { has: page.getByRole('button', { name: `Edit ${mineBoth}`, exact: true }) }).locator('.day-circle')).toHaveAttribute('data-c', 'blue');
      await addTodo(page, minePartner, PARTNER_NAME);
      await expect(page.locator('.day-task', { has: page.getByRole('button', { name: `Edit ${minePartner}`, exact: true }) }).locator('.day-circle')).toHaveAttribute('data-c', 'red');
    } finally {
      const now = await owner.snapshot();
      await owner.post({ action: 'saveSettings', bothColor: before.settings.bothColor, revision: now.settings.revision });
      await owner.post({ action: 'saveList', id: PARTNER, color: partnerList.color, revision: now.lists.find((l: { id: string }) => l.id === PARTNER).revision });
      await clearDay(owner, date); await owner.dispose();
    }
  });

  test('an overlay is a third lane, Both never includes a custom list on its own, and a custom list alone is one lane', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(404), listId = crypto.randomUUID();
    const name = unique('Camp').slice(0, 24);
    expect((await owner.post({ action: 'saveList', id: listId, name, color: 'blue', revision: 0 })).status()).toBe(200);
    await seed(owner, date);
    await add(owner, { action: 'add', kind: 'event', date, owners: [listId], text: 'Pack the car', start: 900 });
    await add(owner, { action: 'add', kind: 'priority', date, owners: [listId], slots: { [listId]: 1 }, text: 'Buy a tent' });
    try {
      // Base Both with no overlay: nothing of the custom list is on the page.
      await login(page); await openDay(page, date);
      await expect(page.locator('.day-sched .day-lane')).toHaveText([`${OWNER_NAME} · you`, PARTNER_NAME]);
      await expect(page.getByRole('button', { name: /^Pack the car/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Buy a tent/ })).toHaveCount(0);
      // As an overlay it is the third lane; its entries sit in the last column.
      expect((await owner.post({ action: 'savePrefs', selection: { base: 'both', overlays: [listId] } })).status()).toBe(200);
      await page.reload(); await openDay(page, date);
      await expect(page.locator('.day-sched .day-lane')).toHaveText([`${OWNER_NAME} · you`, PARTNER_NAME, name]);
      await expect(page.locator('.day-lanes')).toHaveClass(/\bn3\b/);
      const grid = (await page.locator('.day-lanes').boundingBox())!, car = (await page.getByRole('button', { name: /^Pack the car/ }).boundingBox())!;
      expect(car.x).toBeGreaterThan(grid.x + (grid.width * 2) / 3 - 2);
      await expect(page.getByRole('button', { name: /^Pack the car/ })).toHaveAttribute('data-c', 'blue');
      const tent = page.getByRole('button', { name: new RegExp(`Priority 1: Buy a tent, ${name}`) });
      expect((await tent.boundingBox())!.x).toBeGreaterThan(grid.x + (grid.width * 2) / 3 - 2);
      // Both entries still span exactly the first two lanes.
      const lunch = (await cell(page, 'Lunch together').boundingBox())!;
      expect(lunch.width).toBeGreaterThan(grid.width * 0.55);
      expect(lunch.width).toBeLessThan(grid.width * 0.7);
      // An overlay never decides who a new item is for: under Both with the overlay on, a new to-do is the one linked record.
      const linkedTitle = unique('Linked');
      await addTodo(page, linkedTitle);
      expect((await owner.snapshot()).tasks.find((t: { title: string }) => t.title === linkedTitle)).toMatchObject({ owners: [OWNER, PARTNER] });
      // The custom list alone: one lane, and an entry for Both is not in it.
      expect((await owner.post({ action: 'savePrefs', selection: { base: listId, overlays: [] } })).status()).toBe(200);
      await page.reload(); await openDay(page, date);
      await expect(page.locator('.day-sched .day-lane')).toHaveText([name]);
      await expect(page.getByRole('button', { name: /^Pack the car/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Lunch together/ })).toHaveCount(0);
      // A new to-do under it is that list's alone.
      const alone = unique('Alone');
      await addTodo(page, alone);
      expect((await owner.snapshot()).tasks.find((t: { title: string }) => t.title === alone)).toMatchObject({ owners: [listId] });
    } finally {
      await owner.post({ action: 'savePrefs', ...BOTH });
      const list = (await owner.snapshot()).lists.find((l: { id: string }) => l.id === listId);
      if (list) { await owner.post({ action: 'deleteList', id: listId, revision: list.revision, confirm: true }); }
      await clearDay(owner, date); await owner.dispose();
    }
  });

  test('one list alone: a linked entry stays in the Both color, in that list\'s lane', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(405);
    await seed(owner, date);
    try {
      expect((await owner.post({ action: 'savePrefs', selection: { base: PARTNER, overlays: [] } })).status()).toBe(200);
      await login(page); await openDay(page, date);
      await expect(page.locator('.day-sched .day-lane')).toHaveText([PARTNER_NAME]);
      const grid = (await page.locator('.day-lanes').boundingBox())!, lunch = (await cell(page, 'Lunch together').boundingBox())!;
      await expect(cell(page, 'Lunch together')).toHaveAttribute('data-c', 'purple');
      expect(lunch.width).toBeGreaterThan(grid.width * 0.9);
      await expect(cell(page, 'Yoga')).toHaveAttribute('data-c', 'yellow');
      await expect(page.getByRole('button', { name: /^Gym/ })).toHaveCount(0);
      // The linked priority is on the partner's own lines (3 here), in purple, and the owner's line 4 is not drawn.
      await expect(page.locator('.day-cell[aria-label*="Renew passport"]')).toHaveCount(1);
      await expect(cell(page, 'Priority 3: Renew passport')).toHaveAttribute('data-c', 'purple');
      // And a new to-do under the partner is the partner's alone, in her color.
      const hers = unique('Hers');
      await addTodo(page, hers);
      expect((await owner.snapshot()).tasks.find((t: { title: string }) => t.title === hers)).toMatchObject({ owners: [PARTNER] });
      await expect(page.locator('.day-task', { has: page.getByRole('button', { name: `Edit ${hers}`, exact: true }) }).locator('.day-circle')).toHaveAttribute('data-c', 'yellow');
    } finally {
      await owner.post({ action: 'savePrefs', ...BOTH });
      await clearDay(owner, date); await owner.dispose();
    }
  });
});

