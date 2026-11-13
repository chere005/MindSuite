import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { apiLogin, farDate, login, resetPrefs, showHalf } from './helpers';
import { OWNER, PARTNER } from './people';

// CalMind's events and the planner's own entries stand on one grid (the owner, 2026-11-10: the CalMind items on the Day were "a bit off"): the same minutes
// give the same top, height and lane, on the grid's hour and half-hour lines, at a desktop, a short desktop and a phone, on both pages. Where a page
// cuts a span off, both are flush with the cut and have their inset elsewhere, and a half-hour event still shows its words. Desktop project.
const DIR = process.env.PLANMIND_E2E_CALMIND!;
const DAY = farDate(460);
const KEY = randomBytes(32).toString('hex');
const hm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const at = (h: number, m = 0) => h * 60 + m;
function store(user: string, recs: Record<string, unknown>) {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(KEY).digest(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ seq: 1, recs })), cipher.final()]);
  writeFileSync(path.join(DIR, `records-${user}.json`), 'ENC1:' + Buffer.concat([iv, body]).toString('base64'));
}
// [label, start, length]: the pairs are drawn twice, as a CalMind event (the owner's lane) and as an entry of the partner's, at the same minutes.
const PAIRS: [string, number, number][] = [
  ['Half past eight', at(8, 30), 30], ['Quarter past nine', at(9, 15), 45], ['Ten', at(10), 60], ['Half past eleven', at(11, 30), 90],
  ['Quarter to two', at(13, 45), 30], ['Past nine at night', at(20, 30), 60],
];
// Overlapping events (a column a third of the lane), a quarter hour, 20 and 25 minutes, and one off the quarter hours.
const CROWD: [string, number, number][] = [['Crowd A', at(15, 45), 60], ['Crowd B', at(16), 30], ['Crowd C', at(16, 15), 45]];
const TINY: [string, number, number][] = [['Tiny fifteen', at(18), 15], ['Tiny twenty', at(18, 30), 20], ['Tiny twenty five', at(19), 25], ['Odd start', at(19, 37), 38]];
const SPANS_7A = 'Across seven in the morning';

test.beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(path.join(DIR, '.datakey'), KEY + '\n');
  const recs: Record<string, unknown> = { c1: { id: 'c1', type: 'calendar', updated: 1, payload: { name: 'c1', color: '#3366cc', ord: 'a' } } };
  const add = (id: string, text: string, start: number, length: number) => { recs[id] = { id, type: 'event', updated: 1, payload: { text, date: DAY, time: hm(start), end: hm(start + length), repeat: null, calendarId: 'c1', ord: 'a' } }; };
  PAIRS.forEach(([label, start, length], i) => add(`e${i}`, `CalMind ${label}`, start, length));
  add('e7', SPANS_7A, at(6), 90);
  [...CROWD, ...TINY].forEach(([label, start, length], i) => add(`x${i}`, label, start, length));
  store(OWNER, recs);
  store(PARTNER, {});
});
test.afterAll(() => { rmSync(path.join(DIR, `records-${OWNER}.json`), { force: true }); rmSync(path.join(DIR, `records-${PARTNER}.json`), { force: true }); });
test.afterEach(async ({ baseURL }) => {
  await resetPrefs(baseURL!);
  const api = await apiLogin(baseURL!, PARTNER);
  for (const e of (await api.snapshot()).events.filter((x: { date: string }) => x.date === DAY)) { await api.post({ action: 'delete', id: e.id, revision: e.revision, confirm: true }); }
  await api.dispose();
});

type Box = { top: number; bottom: number; left: number; right: number };
/** The boxes of every CalMind event and entry on the page, by their words, with the lane area and the grid's hour lines. */
const measure = (page: Page) => page.evaluate(() => {
  const box = (e: Element): Box => { const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }; };
  const lanes = box(document.querySelector('.day-lanes')!);
  const lines = [...document.querySelectorAll<HTMLElement>('.day-slot[data-lane="0"]')].map(s => s.getBoundingClientRect().top);
  const items: Record<string, { box: Box; kind: string; clip: string; words: Box | null; shown: boolean }> = {};
  // The words' box is the text itself (its range), not the element, so a clamped or cut line shows.
  for (const e of document.querySelectorAll<HTMLElement>('.day-cal, .day-ev')) {
    const kind = e.classList.contains('day-cal') ? 'cal' : 'own';
    const words = e.querySelector(kind === 'cal' ? '.day-cal-text' : '.day-ev-text');
    const label = (words?.textContent ?? '').trim();
    items[`${kind}:${label.replace(/^CalMind /, '')}`] = { box: box(e), kind, clip: e.dataset.clip ?? '', words: words ? box(words) : null, shown: !!words && getComputedStyle(words).visibility !== 'hidden' };
  }
  return { lanes, lines, items };
});

for (const [width, height, name] of [[1360, 900, 'a desktop'], [1280, 620, 'a short desktop'], [1440, 1500, 'a tall desktop'], [390, 844, 'a phone']] as const) {
  test(`CalMind events sit on the grid exactly where the planner's entries of the same time do, on ${name}`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height });
    const partner = await apiLogin(baseURL!, PARTNER);
    for (const [label, start, length] of PAIRS) {
      expect((await partner.post({ action: 'add', kind: 'event', id: crypto.randomUUID(), date: DAY, owners: [PARTNER], text: label, start, length })).status()).toBe(200);
    }
    await partner.dispose();
    await login(page, OWNER);
    await page.locator(width < 500 ? '#pill-date' : '#jump-date').fill(DAY);
    await expect(page.locator('.day-cal').first()).toBeVisible();
    const near = (a: number, b: number, what: string) => expect(Math.abs(a - b), `${what}: ${a} against ${b}`).toBeLessThan(0.6);

    const am = await measure(page);
    const hour = (am.lanes.bottom - am.lanes.top) / 14;
    // Each pair: the same top and bottom, and the card's top is the line of its time plus the entry inset (1px) wherever the page does not cut it off.
    for (const [label, start, length] of PAIRS) {
      const cal = am.items[`cal:${label}`], own = am.items[`own:${label}`];
      expect(cal && own, label).toBeTruthy();
      near(cal.box.top, own.box.top, `${label} top`);
      near(cal.box.bottom, own.box.bottom, `${label} bottom`);
      // The owner's lane is the left half of the lanes and the partner's the right: each box is its lane less the 1px inset on both sides.
      const lane = (am.lanes.right - am.lanes.left) / 2;
      near(cal.box.left, am.lanes.left + 1, `${label} left`);
      near(cal.box.right, am.lanes.left + lane - 1, `${label} right`);
      near(own.box.left, am.lanes.left + lane + 1, `${label} own left`);
      near(own.box.right, am.lanes.right - 1, `${label} own right`);
      // The words sit where the entry's own do (not compared where a page cuts the span: the box is shorter than its minutes).
      if (!cal.clip) { near(cal.words!.top - cal.box.top, own.words!.top - own.box.top, `${label} words from the top`); }
      expect(cal.clip, label).toBe(own.clip);
      const line = am.lanes.top + ((start - 420) / 60) * hour;
      if (!cal.clip.includes('top')) { near(cal.box.top, line + 1, `${label} against its line`); }
      if (!cal.clip.includes('bottom')) { near(cal.box.bottom, line + (length / 60) * hour - 1, `${label} end against its line`); }
      else { near(cal.box.bottom, am.lanes.bottom, `${label} flush with the page's end`); }
      // A half hour still reads: its words are not hidden and sit inside the card.
      expect(cal.shown, `${label} words shown`).toBe(true);
      expect(cal.words!.right - cal.words!.left, `${label} words have width`).toBeGreaterThan(30);
      expect(cal.words!.top, label).toBeGreaterThanOrEqual(cal.box.top - 0.5);
      expect(cal.words!.bottom, label).toBeLessThanOrEqual(cal.box.bottom + 0.5);
    }
    // Overlapping events share the lane: the words of each have room (not a 2px sliver) and stay inside the card, at every size.
    for (const [label] of [...CROWD, ...TINY]) {
      const c = am.items[`cal:${label}`];
      expect(c, label).toBeTruthy();
      expect(c.box.right - c.box.left, `${label} card is inside its lane`).toBeLessThanOrEqual(am.lanes.right - am.lanes.left);
      expect(c.shown && c.words!.right - c.words!.left, `${label} words have width`).toBeGreaterThan(15);
      expect(c.words!.right, `${label} words stay inside the card`).toBeLessThanOrEqual(c.box.right + 0.5);
      // Whole lines only, or a chip across the middle of a short card (the planner's own quarter hours do the same): never a cut-off line.
      if (c.box.bottom - c.box.top >= 13) { expect(c.words!.bottom, `${label} words end inside the card`).toBeLessThanOrEqual(c.box.bottom + 0.5); expect(c.words!.top, `${label} words start inside the card`).toBeGreaterThanOrEqual(c.box.top - 0.5); }
    }
    // The grid's hour and half-hour lines do not run through a card: it is opaque.
    expect(await page.evaluate(() => { const e = document.querySelector('.day-cal-in')!; const c = getComputedStyle(e).backgroundColor; return /rgba\(.*,\s*0(\.\d+)?\)$/.test(c) || c === 'transparent' || getComputedStyle(e.parentElement!).opacity !== '1'; }), 'a card is opaque').toBe(false);
    // The event across 7a starts flush with the top of the grid (the night before cuts it), like an entry cut at a page's edge.
    const night = am.items[`cal:${SPANS_7A}`];
    expect(night.clip).toBe('');
    near(night.box.top, am.lanes.top + 1, 'the 7a span starts at the grid top');
    near(night.box.bottom, am.lanes.top + (30 / 60) * hour - 1, 'the 7a span ends at 7:30');
    // The grid's own lines: a quarter hour lies a quarter of a row below its line.
    near(am.lines[1] - am.lines[0], hour, 'a row is an hour');

    // PM: the 9p span continues flush with the top of the page.
    await showHalf(page, 'pm');
    await expect(page.locator('.day-cal[data-clip~=top]')).toBeVisible();
    const pm = await measure(page);
    const cal = pm.items['cal:Past nine at night'], own = pm.items['own:Past nine at night'];
    expect(cal.clip).toBe('top');
    near(cal.box.top, own.box.top, 'the 9p span on PM, top');
    near(cal.box.bottom, own.box.bottom, 'the 9p span on PM, bottom');
    near(cal.box.top, pm.lanes.top, 'flush with the top of PM');
  });
}
