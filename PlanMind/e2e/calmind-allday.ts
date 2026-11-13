import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { farDate } from './helpers';
import { OWNER, PARTNER, PARTNER_NAME } from './people';

// Shared by calmind-allday.spec.ts and calmind-allday-phone.spec.ts: CalMind's store written as CalMind writes it (into the run's
// disposable CalMind directory), with all-day events on a handful of far-away days.
export const DIR = process.env.PLANMIND_E2E_CALMIND!;
export const DAYS = {
  /** The owner's and the partner's all-day events, and one timed event. */
  both: farDate(2000),
  /** The same timed event and nothing all-day. */
  timedOnly: farDate(2001),
  /** A day with nothing from CalMind at all. */
  empty: farDate(2002),
  /** The owner has four all-day events and the partner one: the overflow. */
  many: farDate(2003),
  /** The same words on both calendars: one chip across both lanes. */
  pair: farDate(2004),
  /** A three-day all-day event runs from here (2005) to 2007. */
  span: farDate(2005),
};
const KEY = randomBytes(32).toString('hex');
export const OWNER_BLUE = '#3366cc';
function store(user: string, recs: Record<string, unknown>) {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(KEY).digest(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ seq: 1, recs })), cipher.final()]);
  writeFileSync(path.join(DIR, `records-${user}.json`), 'ENC1:' + Buffer.concat([iv, body]).toString('base64'));
}
const cal = (id: string, color: string) => ({ [id]: { id, type: 'calendar', updated: 1, payload: { name: id, color, ord: 'a' } } });
const ev = (id: string, text: string, date: string, calendarId: string, more: Record<string, unknown> = {}) =>
  ({ [id]: { id, type: 'event', updated: 1, payload: { text, date, time: null, repeat: null, calendarId, ord: 'a', ...more } } });
const share = (partner: string, calendars: string[]) => ({ share: { id: 'share', type: 'share', updated: 1, payload: { partners: [partner], calendars, folders: [], notefolders: [] } } });

export function writeStores() {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(path.join(DIR, '.datakey'), KEY + '\n');
  store(OWNER, {
    ...cal('c1', OWNER_BLUE), ...share(PARTNER, ['c1']),
    ...ev('a1', 'Anniversary', DAYS.both, 'c1'),
    ...ev('t1', 'Dentist', DAYS.both, 'c1', { time: '10:00', end: '11:00' }),
    ...ev('t2', 'Dentist', DAYS.timedOnly, 'c1', { time: '10:00', end: '11:00' }),
    ...ev('m1', 'Zoo', DAYS.many, 'c1'), ...ev('m2', 'Yoga retreat', DAYS.many, 'c1'), ...ev('m3', 'Workshop', DAYS.many, 'c1'), ...ev('m4', 'Visit', DAYS.many, 'c1'),
    ...ev('p1', 'Family day', DAYS.pair, 'c1'),
    ...ev('s1', 'Conference', DAYS.span, 'c1', { endDate: farDate(2007) }),
  });
  store(PARTNER, {
    ...cal('k1', '#cc3366'), ...cal('k2', '#33cc66'), ...share(OWNER, ['k1']),
    ...ev('b1', `${PARTNER_NAME} birthday`, DAYS.both, 'k1'),
    ...ev('b2', `${PARTNER_NAME} private`, DAYS.both, 'k2'),
    ...ev('m5', 'Book club', DAYS.many, 'k1'),
    ...ev('p2', 'family  day', DAYS.pair, 'k1'),
  });
}
export function removeStores() {
  rmSync(path.join(DIR, `records-${OWNER}.json`), { force: true });
  rmSync(path.join(DIR, `records-${PARTNER}.json`), { force: true });
}
export const openDay = async (page: Page, date: string) => {
  await page.locator('#jump-date').fill(date);
  await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', date);
};
export const strip = (page: Page) => page.locator('.day-allday');
export const chip = (page: Page, text: string) => page.locator('.day-ad', { hasText: text });
