import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { apiLogin, login, resetPrefs, showHalf } from './helpers';
import { DAYS, chip, removeStores, strip, writeStores } from './calmind-allday';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// The all-day strip on a phone (#171): above the timeline in both the AM and the PM page, inside the screen with nothing scrolling sideways, compact (one
// or two 22px rows), absent with no all-day events, and the timed grid below it still gets a usable height on the smallest screens. Phone project.
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
const openDay = async (page: Page, date: string) => {
  await page.locator('#pill-date').fill(date);
  await expect(page.locator('.day-sched')).toBeVisible();
  await expect(page.locator('#jump-date')).toHaveValue(date);
};
const box = async (locator: ReturnType<typeof strip>) => (await locator.boundingBox())!;
const sizes: Array<[number, number]> = [[375, 812], [375, 667], [320, 568]];

for (const [width, height] of sizes) {
  test(`${width}x${height}: the strip is above the timeline on both pages, inside the screen, and the grid keeps its height`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await login(page, OWNER);
    await openDay(page, DAYS.both);
    const open = async (half: 'am' | 'pm') => {
      await showHalf(page, half);
      await expect(page.locator('.day-sched')).toHaveAttribute('data-half', half);
      await expect(strip(page)).toHaveCount(1);
      await expect(chip(page, 'Anniversary')).toBeVisible();
      await expect(chip(page, `${PARTNER_NAME} birthday`)).toBeVisible();
      const band = await box(strip(page)), names = await box(page.locator('.day-sched .day-lanehead')), timeline = await box(page.locator('.day-timeline'));
      // Lane names, then the strip, then the timeline: nothing overlaps (the schedule choices are in the menu on a phone).
      expect(band.y).toBeGreaterThanOrEqual(names.y + names.height - 1);
      expect(band.y + band.height).toBeLessThanOrEqual(timeline.y + 1);
      expect(band.height).toBeLessThan(30);
      // Inside the screen, each chip in its own half of the lane area.
      const lanes = (await page.locator('.day-lanes').boundingBox())!, mine = await box(chip(page, 'Anniversary')), hers = await box(chip(page, `${PARTNER_NAME} birthday`));
      expect(mine.x).toBeGreaterThanOrEqual(lanes.x - 0.5);
      expect(mine.x + mine.width).toBeLessThanOrEqual(lanes.x + lanes.width / 2 + 1);
      expect(hers.x).toBeGreaterThanOrEqual(lanes.x + lanes.width / 2 - 1);
      expect(hers.x + hers.width).toBeLessThanOrEqual(lanes.x + lanes.width + 1);
      expect(hers.x + hers.width).toBeLessThanOrEqual(width);
      const fit = await page.evaluate(() => ({ sideways: document.documentElement.scrollWidth - innerWidth, strip: (() => { const s = document.querySelector('.day-allday')!; return s.scrollWidth - s.clientWidth; })() }));
      expect(fit).toEqual({ sideways: 0, strip: 0 });
      // The timeline still shows a usable stretch of the day (the strip is at most two chip rows).
      expect(timeline.height, `${half}: timeline height`).toBeGreaterThan(height <= 568 ? 150 : 200);
      if (process.env.PLANMIND_SHOTS) { await page.screenshot({ path: path.join(process.env.PLANMIND_SHOTS, `allday-phone-${width}x${height}-${half}.png`) }); }
    };
    await open('am');
    await open('pm');
    void info;
  });
}

test('no all-day events: no strip, and the phone Day is as before', async ({ page }) => {
  await login(page, OWNER);
  await openDay(page, DAYS.timedOnly);
  await expect(page.locator('.day-cal', { hasText: 'Dentist' })).toBeVisible();
  await expect(strip(page)).toHaveCount(0);
  await openDay(page, DAYS.empty);
  await expect(strip(page)).toHaveCount(0);
});

test(`overflow on a phone: one chip and +3 in ${OWNER_NAME}'s lane, ${PARTNER_NAME}'s chip beside it, two rows at most`, async ({ page }, info) => {
  await login(page, OWNER);
  await openDay(page, DAYS.many);
  await expect(page.locator('.day-ad-more')).toHaveText('+3');
  await expect(page.locator('.day-ad-more')).toHaveAttribute('title', 'Workshop, Yoga retreat, Zoo');
  await expect(chip(page, 'Book club')).toBeVisible();
  const band = await box(strip(page));
  expect(band.height).toBeLessThan(2 * 22 + 8);
  const more = await box(page.locator('.day-ad-more')), lanes = (await page.locator('.day-lanes').boundingBox())!;
  expect(more.x + more.width).toBeLessThanOrEqual(lanes.x + lanes.width / 2 + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  if (process.env.PLANMIND_SHOTS) { await page.screenshot({ path: path.join(process.env.PLANMIND_SHOTS, `allday-phone-overflow-${info.project.name}.png`) }); }
});

test('a chip across both lanes spans the lane area on a phone, and the timed cards do not move', async ({ page }) => {
  await login(page, OWNER);
  await openDay(page, DAYS.pair);
  const lanes = (await page.locator('.day-lanes').boundingBox())!, across = await box(chip(page, 'Family day'));
  await expect(page.locator('.day-ad')).toHaveCount(1);
  expect(across.x).toBeLessThan(lanes.x + 3);
  expect(across.x + across.width).toBeGreaterThan(lanes.x + lanes.width - 3);
  const place = () => page.locator('.day-cal', { hasText: 'Dentist' }).evaluate(el => { const h = el as HTMLElement; return [h.dataset.y, h.dataset.h, h.dataset.x, h.dataset.w]; });
  await openDay(page, DAYS.both);
  const withStrip = await place();
  await openDay(page, DAYS.timedOnly);
  expect(await place()).toEqual(withStrip);
});
