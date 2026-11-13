import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { apiLogin, farDate, field, login, resetPrefs } from './helpers';
import { OWNER, PARTNER, PARTNER_NAME } from './people';

// CalMind's events on the Day schedule (the owner, 2026-11-09): read from CalMind's own store (written here the way CalMind writes it, into
// the run's disposable CalMind directory), drawn faint under the planner's entries, never a control (a tap goes through one and starts
// an entry on top of it), and hidden or shown by the CalMind button, which is saved per account. Desktop project.
const DIR = process.env.PLANMIND_E2E_CALMIND!;
const DAY = farDate(400);
const KEY = randomBytes(32).toString('hex');
function store(user: string, recs: Record<string, unknown>) {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(KEY).digest(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ seq: 1, recs })), cipher.final()]);
  writeFileSync(path.join(DIR, `records-${user}.json`), 'ENC1:' + Buffer.concat([iv, body]).toString('base64'));
}
const cal = (id: string, color: string) => ({ [id]: { id, type: 'calendar', updated: 1, payload: { name: id, color, ord: 'a' } } });
const ev = (id: string, text: string, time: string, end: string, calendarId: string) =>
  ({ [id]: { id, type: 'event', updated: 1, payload: { text, date: DAY, time, end, repeat: null, calendarId, ord: 'a' } } });
const share = (partner: string, calendars: string[]) => ({ share: { id: 'share', type: 'share', updated: 1, payload: { partners: [partner], calendars, folders: [], notefolders: [] } } });

test.beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(path.join(DIR, '.datakey'), KEY + '\n');
  store(OWNER, { ...cal('c1', '#3366cc'), ...ev('e1', 'Dentist (CalMind)', '10:00', '11:30', 'c1'), ...ev('e2', 'Supper together', '18:00', '19:00', 'c1'), ...share(PARTNER, []) });
  store(PARTNER, { ...cal('k1', '#cc3366'), ...cal('k2', '#33cc66'), ...ev('a1', `${PARTNER_NAME} shared (CalMind)`, '13:00', '14:00', 'k1'), ...ev('a2', `${PARTNER_NAME} private (CalMind)`, '15:00', '16:00', 'k2'), ...ev('a3', 'supper  together', '18:00', '19:00', 'k1'), ...share(OWNER, ['k1']) });
});
test.afterAll(() => { rmSync(path.join(DIR, `records-${OWNER}.json`), { force: true }); rmSync(path.join(DIR, `records-${PARTNER}.json`), { force: true }); });
test.afterEach(async ({ baseURL }) => {
  await resetPrefs(baseURL!);
  for (const user of [OWNER, PARTNER] as const) {
    const api = await apiLogin(baseURL!, user);
    await api.post({ action: 'setCalmind', hidden: false });
    const snapshot = await api.snapshot();
    for (const e of snapshot.events.filter((x: { date: string }) => x.date === DAY)) { await api.post({ action: 'delete', id: e.id, revision: e.revision, confirm: true }); }
    await api.dispose();
  }
});
const openDay = async (page: Page) => {
  await page.locator('#jump-date').fill(DAY);
  await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', DAY);
};
const cal_ = (page: Page, text: string) => page.locator('.day-cal', { hasText: text });

test('CalMind events show faint in their owner\'s lane, the other person\'s only from shared calendars', async ({ page }) => {
  await login(page, OWNER);
  await openDay(page);
  await expect(cal_(page, 'Dentist (CalMind)')).toBeVisible();
  await expect(cal_(page, `${PARTNER_NAME} shared (CalMind)`)).toBeVisible();
  await expect(cal_(page, `${PARTNER_NAME} private (CalMind)`)).toHaveCount(0);
  // Faint is a muted color on an opaque card (the grid's lines do not run through its words), not a see-through one.
  const look = await cal_(page, 'Dentist (CalMind)').evaluate(el => { const s = getComputedStyle(el), i = getComputedStyle(el.firstElementChild!); return { opacity: Number(s.opacity) * Number(i.opacity), events: s.pointerEvents, left: i.borderLeftColor, fill: i.backgroundColor }; });
  expect(look.opacity).toBe(1);
  expect(look.fill).not.toMatch(/rgba|transparent/);
  expect(look.events).toBe('none');
  expect(look.left).toBe('rgb(51, 102, 204)');
  // In the Both view the owner (you) is the left lane and the partner the right one: each event sits in its owner's half.
  const lanes = (await page.locator('.day-lanes').boundingBox())!;
  const mine = (await cal_(page, 'Dentist (CalMind)').boundingBox())!, hers = (await cal_(page, `${PARTNER_NAME} shared (CalMind)`).boundingBox())!;
  expect(mine.x + mine.width).toBeLessThanOrEqual(lanes.x + lanes.width / 2 + 1);
  expect(hers.x).toBeGreaterThanOrEqual(lanes.x + lanes.width / 2 - 1);
  // An event on both calendars (the same time, length and words) is one piece across both lanes, in the Both color.
  const supper = page.locator('.day-cal', { hasText: /supper/i });
  await expect(supper).toHaveCount(1);
  await expect(supper).toHaveAttribute('data-span', '2');
  await expect(supper).toHaveAttribute('aria-label', /^CalMind, both of you: /);
  const across = (await supper.boundingBox())!;
  expect(across.x).toBeLessThan(lanes.x + 8);
  expect(across.x + across.width).toBeGreaterThan(lanes.x + lanes.width - 8);
  // 10:00 to 11:30 is an hour and a half of the 14-hour AM page.
  expect(Math.abs(mine.height + 2 - (lanes.height * 90) / 840)).toBeLessThan(1);
  // They are not entries: nothing of CalMind is in the planner's store.
  const api = await apiLogin(new URL(page.url()).origin, OWNER);
  expect((await api.snapshot()).events.filter((e: { date: string }) => e.date === DAY)).toEqual([]);
  await api.dispose();
});

test('a tap on a CalMind event starts a planner entry on top of it', async ({ page, baseURL }) => {
  await login(page, OWNER);
  await openDay(page);
  const box = (await cal_(page, 'Dentist (CalMind)').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + 8);
  const input = field(page, 'New entry');
  await expect(input).toBeFocused();
  await input.fill('Over the dentist');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: /^Over the dentist, 10a to 10:30a/ })).toBeVisible();
  await expect(cal_(page, 'Dentist (CalMind)')).toBeVisible();
  const api = await apiLogin(baseURL!, OWNER);
  expect((await api.snapshot()).events.filter((e: { date: string }) => e.date === DAY).map((e: { text: string; start: number }) => [e.text, e.start])).toEqual([['Over the dentist', 600]]);
  await api.dispose();
});

test('the CalMind button hides and shows them, and the choice is kept per account', async ({ page, baseURL }) => {
  await login(page, OWNER);
  await openDay(page);
  const button = page.locator('.day-calbtn');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.day-cal')).toHaveCount(3);
  await button.click();
  await expect(page.locator('.day-cal')).toHaveCount(0);
  await expect(page.locator('.day-calbtn')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => { const api = await apiLogin(baseURL!, OWNER); const v = (await api.snapshot()).calmind; await api.dispose(); return v; }).toBe('hidden');
  await page.reload();
  await expect(page.locator('#sidebar .date-row.selected')).toBeAttached();
  await openDay(page);
  await expect(page.locator('.day-calbtn')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.day-cal')).toHaveCount(0);
  // The partner's own choice is hers: she still sees hers (and the owner shares nothing with her).
  const partner = await apiLogin(baseURL!, PARTNER);
  expect((await partner.snapshot()).calmind).toBe('shown');
  expect((await (await partner.request.get('/PlanMind/api.php?calmind=1&from=' + DAY + '&to=' + DAY)).json()).events.map((e: { text: string }) => e.text)).toEqual([`${PARTNER_NAME} shared (CalMind)`, `${PARTNER_NAME} private (CalMind)`, 'supper  together']);
  await partner.dispose();
  await page.locator('.day-calbtn').click();
  await expect(page.locator('.day-cal')).toHaveCount(3);
});
