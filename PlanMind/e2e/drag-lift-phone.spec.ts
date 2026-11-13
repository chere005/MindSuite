import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { apiLogin, draftSpan, farDate, login, resetPrefs, showHalf, type Api } from './helpers';
import { OWNER, OWNER_NAME } from './people';

// A finger rolls a few pixels in the last moments before it leaves the glass, and a quarter hour is only about 10px tall on a phone: the
// edge a drag leaves at is where the finger RESTED, not where it left (the owner, 2026-11-01: "can't drag up to 15 minutes, it goes back").
// Phone project, real touch events.
const add = async (api: Api, body: Record<string, unknown>) => {
  const data = { id: crypto.randomUUID(), ...body };
  const response = await api.post(data);
  expect(response.status(), JSON.stringify(await response.json())).toBe(200);
  return data.id as string;
};
const event = (date: string, over: Record<string, unknown> = {}) => ({ action: 'add', kind: 'event', date, owners: [OWNER], text: 'Roll', start: 540, length: 45, ...over });
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
const touch = (cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });

test.describe('a finger lifting off a handle', () => {
  test('the edge stays where the finger rested: a 15-minute drag is not undone by the finger rolling down as it lifts; a drag that really ends elsewhere still ends there', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(655);
    await add(owner, event(date));
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      const cdp = await page.context().newCDPSession(page);
      await page.getByRole('button', { name: `Roll, 9a to 9:45a, ${OWNER_NAME}`, exact: true }).tap();
      await expect(page.locator('.day-ev.day-editing input')).toBeFocused();
      const row = (await page.locator('.day-lanes').boundingBox())!.height / 56;   // a quarter hour, in px
      const grab = async () => { const b = (await page.locator('.day-handle[data-edge=end]').boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };

      // Up one quarter hour (45 → 30), rest there, then the finger rolls a little more than half a quarter back down as it lifts (0.6 of a quarter: the phone's quarter is 11.75px now that the schedule has the row's height, and the rest rule's 8px must still hold).
      let from = await grab();
      await touch(cdp, 'touchStart', from.x, from.y);
      for (let i = 1; i <= 8; i++) { await touch(cdp, 'touchMove', from.x, from.y - (row * i) / 8); await pause(page, 16); }
      await pause(page, 160);
      await touch(cdp, 'touchMove', from.x, from.y - row + row * 0.6);
      await pause(page, 20);
      await touch(cdp, 'touchEnd');
      await expect.poll(() => draftSpan(page), 'the finger rested at 30 minutes').toEqual({ start: 540, length: 30 });

      // Down two quarters (30 → 60), and a real movement in the last moments is not thrown away: it ends where the finger ended.
      from = await grab();
      await touch(cdp, 'touchStart', from.x, from.y);
      for (let i = 1; i <= 8; i++) { await touch(cdp, 'touchMove', from.x, from.y + row * i / 4); await pause(page, 16); }
      await touch(cdp, 'touchEnd');
      await expect.poll(() => draftSpan(page), 'a drag that ends moving keeps its end').toEqual({ start: 540, length: 60 });
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});
