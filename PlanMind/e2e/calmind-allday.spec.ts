import path from 'node:path';
import { expect, test } from '@playwright/test';
import { apiLogin, farDate, login, resetPrefs } from './helpers';
import { DAYS, OWNER_BLUE, chip, openDay, removeStores, strip, writeStores } from './calmind-allday';
import { OWNER, PARTNER, PARTNER_NAME } from './people';

// CalMind's ALL-DAY events on the Day (#171, the owner 2026-11-09): a compact read-only strip above the schedule, outside the timed grid so it never
// moves a timed card, absent when the day has none, capped at two rows with "+N", the same visibility as the timed cards. An all-day date D is on
// planner day D (D 7a to D+1 7a); a multi-day event is on each day it runs. Desktop project; the phone is in calmind-allday-phone.spec.ts.
test.beforeAll(writeStores);
test.afterAll(removeStores);
test.afterEach(async ({ baseURL }) => {
  await resetPrefs(baseURL!);
  for (const user of [OWNER, PARTNER] as const) {
    const api = await apiLogin(baseURL!, user);
    await api.post({ action: 'setCalmind', hidden: false });
    await api.dispose();
  }
});
const box = async (locator: ReturnType<typeof strip>) => (await locator.boundingBox())!;

test('the strip sits above the timeline with each person\'s chips in their own lane, and a private calendar stays out', async ({ page }, info) => {
  await login(page, OWNER);
  await openDay(page, DAYS.both);
  await expect(strip(page)).toHaveCount(1);
  await expect(chip(page, 'Anniversary')).toBeVisible();
  await expect(chip(page, `${PARTNER_NAME} birthday`)).toBeVisible();
  // The partner shares k1 with the owner, not k2.
  await expect(chip(page, `${PARTNER_NAME} private`)).toHaveCount(0);
  const lanes = (await page.locator('.day-lanes').boundingBox())!, head = await box(page.locator('.day-sched .day-lanehead')), band = await box(strip(page)), timeline = await box(page.locator('.day-timeline'));
  // Between the lane names and the timeline, and not overlapping either.
  expect(band.y).toBeGreaterThanOrEqual(head.y + head.height - 1);
  expect(band.y + band.height).toBeLessThanOrEqual(timeline.y + 1);
  // In the Both view the owner (you) is the left lane, the partner the right: each chip sits in its owner's half, with the grid's 1px inset.
  const mine = await box(chip(page, 'Anniversary')), hers = await box(chip(page, `${PARTNER_NAME} birthday`));
  expect(mine.x).toBeGreaterThanOrEqual(lanes.x);
  expect(mine.x + mine.width).toBeLessThanOrEqual(lanes.x + lanes.width / 2 + 1);
  expect(hers.x).toBeGreaterThanOrEqual(lanes.x + lanes.width / 2 - 1);
  expect(hers.x + hers.width).toBeLessThanOrEqual(lanes.x + lanes.width + 1);
  expect(Math.abs(mine.x - (lanes.x + 1))).toBeLessThan(1.5);
  // Compact: one row, a chip of 20px.
  expect(mine.height).toBeLessThanOrEqual(21);
  expect(band.height).toBeLessThan(30);
  await expect(page.locator('.day-allday-gut')).toHaveText('all day');
  if (process.env.PLANMIND_SHOTS) { await page.screenshot({ path: path.join(process.env.PLANMIND_SHOTS, `allday-desktop-${info.project.name}.png`) }); }
});

test('the same look as the timed CalMind cards: opaque, the calendar\'s stripe and tint', async ({ page }) => {
  await login(page, OWNER);
  await openDay(page, DAYS.both);
  const look = (selector: string) => page.locator(selector).first().evaluate(el => {
    const s = getComputedStyle(el), i = getComputedStyle(el.querySelector('[class$="-in"]')!);
    return { opacity: Number(s.opacity) * Number(i.opacity), fill: i.backgroundColor, stripe: i.borderLeftColor, edge: i.borderTopColor, style: i.borderTopStyle, words: i.color, radius: i.borderTopLeftRadius };
  });
  const timed = await look('.day-cal:has-text("Dentist")'), allDay = await look('.day-ad:has-text("Anniversary")');
  expect(allDay.opacity).toBe(1);
  expect(allDay.fill).not.toMatch(/rgba|transparent/);
  expect(allDay.stripe).toBe('rgb(51, 102, 204)');
  expect(OWNER_BLUE).toBe('#3366cc');
  expect(allDay).toEqual(timed);
});

test('it is read-only: a click on a chip starts and opens nothing', async ({ page, baseURL }) => {
  await login(page, OWNER);
  await openDay(page, DAYS.both);
  const b = await box(chip(page, 'Anniversary'));
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect(page.locator('[data-editing]')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const api = await apiLogin(baseURL!, OWNER);
  expect((await api.snapshot()).events.filter((e: { date: string }) => e.date === DAYS.both)).toEqual([]);
  await api.dispose();
  // Nothing in it is a control or in the tab order.
  expect(await strip(page).locator('button, a, input, [tabindex]').count()).toBe(0);
});

test('no all-day events: no strip at all, and the timed grid is where it was', async ({ page }) => {
  await login(page, OWNER);
  await openDay(page, DAYS.timedOnly);
  await expect(page.locator('.day-cal', { hasText: 'Dentist' })).toBeVisible();
  await expect(strip(page)).toHaveCount(0);
  await expect(page.locator('.day-ad')).toHaveCount(0);
  await openDay(page, DAYS.empty);
  await expect(strip(page)).toHaveCount(0);
  await expect(page.locator('.day-timeline')).toBeVisible();
});

test('the strip never moves a timed card: the same event has the same place on the grid with and without it', async ({ page }) => {
  await login(page, OWNER);
  const place = async () => page.locator('.day-cal', { hasText: 'Dentist' }).evaluate(el => {
    const lanes = document.querySelector('.day-lanes')!.getBoundingClientRect(), b = el.getBoundingClientRect();
    const h = el as HTMLElement;
    return { y: h.dataset.y, h: h.dataset.h, x: h.dataset.x, w: h.dataset.w, top: (b.top - lanes.top) / lanes.height, height: b.height / lanes.height, left: (b.left - lanes.left) / lanes.width, cy: h.style.getPropertyValue('--cy'), ch: h.style.getPropertyValue('--ch') };
  });
  await openDay(page, DAYS.timedOnly);
  const without = await place();
  await openDay(page, DAYS.both);
  await expect(strip(page)).toHaveCount(1);
  const withStrip = await place();
  // spanBox's own numbers are identical; the rendered fractions agree within a pixel's rounding of the shorter timeline.
  expect([withStrip.y, withStrip.h, withStrip.x, withStrip.w, withStrip.cy, withStrip.ch]).toEqual([without.y, without.h, without.x, without.w, without.cy, without.ch]);
  expect(Math.abs(withStrip.top - without.top)).toBeLessThan(0.004);
  expect(Math.abs(withStrip.height - without.height)).toBeLessThan(0.004);
  expect(withStrip.left).toBeCloseTo(without.left, 3);
  // 10:00 to 11:00 is an hour of the 14-hour AM page, whatever sits above the grid.
  expect(withStrip.top).toBeCloseTo((180 / 840), 2);
});

test('more than two rows end in +N that lists what it hides', async ({ page }) => {
  await login(page, OWNER);
  await openDay(page, DAYS.many);
  // The owner has four (Visit, Workshop, Yoga retreat, Zoo, alphabetically): one chip and +3; the partner has one.
  await expect(chip(page, 'Book club')).toBeVisible();
  const more = page.locator('.day-ad-more');
  await expect(more).toHaveCount(1);
  await expect(more).toHaveText('+3');
  await expect(more).toHaveAttribute('title', 'Workshop, Yoga retreat, Zoo');
  await expect(more).toHaveAttribute('aria-label', '3 more CalMind all-day events: Workshop, Yoga retreat, Zoo');
  await expect(chip(page, 'Visit')).toBeVisible();
  for (const hidden of ['Workshop', 'Yoga retreat', 'Zoo']) { await expect(page.locator('.day-ad:not(.day-ad-more)', { hasText: hidden })).toHaveCount(0); }
  // Two rows at most, however many there are.
  const band = await box(strip(page));
  expect(band.height).toBeLessThan(2 * 22 + 8);
  expect(await page.locator('.day-allday-chips').evaluate(el => new Set([...el.children].map(c => (c as HTMLElement).dataset.row)).size)).toBe(2);
  // And in the lane that fit two, nothing is hidden.
  await expect(page.locator('.day-ad-more')).toHaveCount(1);
});

test('the same words on both calendars are one chip across both lanes', async ({ page }) => {
  await login(page, OWNER);
  await openDay(page, DAYS.pair);
  await expect(page.locator('.day-ad')).toHaveCount(1);
  await expect(chip(page, 'Family day')).toHaveAttribute('data-span', '2');
  await expect(chip(page, 'Family day')).toHaveAttribute('aria-label', 'CalMind all day, both of you: Family day');
  const lanes = (await page.locator('.day-lanes').boundingBox())!, across = await box(chip(page, 'Family day'));
  expect(across.x).toBeLessThan(lanes.x + 3);
  expect(across.x + across.width).toBeGreaterThan(lanes.x + lanes.width - 3);
  await expect(chip(page, 'Family day')).toHaveAttribute('data-c', 'purple');
});

test('the Both chip takes this person\'s own Both color', async ({ page, baseURL }) => {
  const api = await apiLogin(baseURL!, OWNER);
  await api.post({ action: 'setBothColor', bothColor: 'orange' });
  await api.dispose();
  await login(page, OWNER);
  await openDay(page, DAYS.pair);
  await expect(chip(page, 'Family day')).toHaveAttribute('data-c', 'orange');
});

test('a multi-day event is on each day it runs and on no other; an all-day date belongs to its own planner day', async ({ page }) => {
  await login(page, OWNER);
  await openDay(page, farDate(2004));
  await expect(chip(page, 'Conference')).toHaveCount(0);
  for (const n of [2005, 2006, 2007]) { await openDay(page, farDate(n)); await expect(chip(page, 'Conference'), farDate(n)).toBeVisible(); }
  await openDay(page, farDate(2008));
  await expect(chip(page, 'Conference')).toHaveCount(0);
  await expect(strip(page)).toHaveCount(0);
});

test('both pages of the day show the strip, and the timeline keeps the room that is left', async ({ page }) => {
  await login(page, OWNER);
  await openDay(page, DAYS.both);
  await expect(chip(page, 'Anniversary')).toBeVisible();
  const pm = page.locator('.day-sched .day-half button[data-half=pm]');
  await pm.click();
  await expect(page.locator('.day-sched')).toHaveAttribute('data-half', 'pm');
  await expect(chip(page, 'Anniversary')).toBeVisible();
  await expect(chip(page, `${PARTNER_NAME} birthday`)).toBeVisible();
  const band = await box(strip(page)), timeline = await box(page.locator('.day-timeline'));
  expect(band.y + band.height).toBeLessThanOrEqual(timeline.y + 1);
  await page.locator('.day-sched .day-half button[data-half=am]').click();
  await expect(chip(page, 'Anniversary')).toBeVisible();
});

test(`the CalMind button hides the strip with the timed cards, and ${PARTNER_NAME} sees her own set`, async ({ page, browser, baseURL }) => {
  await login(page, OWNER);
  await openDay(page, DAYS.both);
  await expect(strip(page)).toHaveCount(1);
  await page.locator('.day-calbtn').click();
  await expect(strip(page)).toHaveCount(0);
  await expect(page.locator('.day-cal')).toHaveCount(0);
  await page.locator('.day-calbtn').click();
  await expect(strip(page)).toHaveCount(1);
  // The partner: her own calendars whole, and only the calendar the owner shares with her (c1, not anything private).
  const context = await browser.newContext({ baseURL, viewport: { width: 1360, height: 900 } });
  const partner = await context.newPage();
  await login(partner, PARTNER);
  await openDay(partner, DAYS.both);
  await expect(chip(partner, `${PARTNER_NAME} birthday`)).toBeVisible();
  await expect(chip(partner, `${PARTNER_NAME} private`)).toBeVisible();
  await expect(chip(partner, 'Anniversary')).toBeVisible();
  await context.close();
});
