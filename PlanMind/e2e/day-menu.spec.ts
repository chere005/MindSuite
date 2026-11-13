import { expect, test } from '@playwright/test';
import { apiLogin, farDate, login, resetPrefs } from './helpers';
import { DAYS, removeStores, writeStores } from './calmind-allday';
import { OWNER } from './people';

// On a desktop the AM/PM switch and the CalMind button stay on the Schedule heading's line: that costs the schedule no height, and the sidebar can
// be hidden there, which would take the choices with it. The phone's menu items (day-menu-phone.spec.ts) are not drawn on a desktop. Desktop project.
const DAY = farDate(491);
test.afterEach(async ({ baseURL }) => {
  await resetPrefs(baseURL!);
  const api = await apiLogin(baseURL!, OWNER);
  await api.post({ action: 'setCalmind', hidden: false });
  await api.dispose();
});

test('a desktop keeps both controls on the Schedule heading, shows no corner word, and its sidebar has no phone choices', async ({ page }) => {
  await login(page, OWNER);
  await page.locator('#jump-date').fill(DAY);
  await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', DAY);
  const head = page.locator('.day-sechead');
  await expect(head.locator('.day-calbtn')).toBeVisible();
  await expect(head.locator('.day-half')).toBeVisible();
  await expect(page.locator('.day-corner')).toHaveCount(0);
  await expect(page.locator('#day-tools')).toBeHidden();
  await expect(page.locator('#menu')).toBeHidden();
  // Hiding the sidebar leaves the choices where they are.
  await page.locator('#sidebar-toggle').click();
  await expect(page.locator('#sidebar')).toBeHidden();
  await expect(head.locator('.day-half')).toBeVisible();
  await head.locator('.day-half button[data-half=pm]').click();
  await expect(page.locator('.day-sched')).toHaveAttribute('data-half', 'pm');
  await page.locator('#sidebar-toggle').click();
});

// The timed grid on a desktop is exactly where origin/main (c342c818) drew it, on a day with no all-day events: measured there at 1280x800
// (timeline x, y, width, height; lanes x, y, width, height), AM and PM, CalMind shown and hidden. The all-day strip and the menu change moved nothing.
test.describe('the timed grid against origin/main', () => {
  test.beforeAll(writeStores);
  test.afterAll(removeStores);
  for (const day of ['timedOnly', 'empty'] as const) {
    test(`1280x800, ${day}: timeline and lanes keep main's boxes in both halves with CalMind shown and hidden`, async ({ page, baseURL }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await login(page, OWNER);
      await page.locator('#jump-date').fill(DAYS[day]);
      await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', DAYS[day]);
      const boxes = () => page.evaluate(() => {
        const r = (e: Element) => { const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map(n => Math.round(n)); };
        return { timeline: r(document.querySelector('.day-timeline')!), lanes: r(document.querySelector('.day-lanes')!) };
      });
      for (const hidden of [false, true]) {
        const api = await apiLogin(baseURL!, OWNER); await api.post({ action: 'setCalmind', hidden }); await api.dispose();
        await page.reload();
        await page.locator('#jump-date').fill(DAYS[day]);
        await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', DAYS[day]);
        for (const half of ['am', 'pm']) {
          await page.locator(`.day-half button[data-half=${half}]`).click();
          await expect(page.locator('.day-sched')).toHaveAttribute('data-half', half);
          expect(await boxes(), `${day} ${half} hidden=${hidden}`).toEqual({ timeline: [363, 141, 395, 509], lanes: [397, 146, 361, 498] });
        }
      }
    });
  }
});
