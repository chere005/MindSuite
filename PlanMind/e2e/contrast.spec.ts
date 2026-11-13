import { expect, test } from '@playwright/test';
import { MIN_CONTRAST } from '../packages/core/src/planner';
import { THEMES, type ThemeName } from '../app/theme';
import { shiftDate } from '../packages/core/src/parse';
import { apiLogin, login, removeTodos, showTheme, textContrast, today, todo, unique } from './helpers';
import { OWNER } from './people';

// Small text must clear AA (MIN_CONTRAST, 4.5) in every theme, at rest and on a selected row. Small means under 14px bold or
// 18px: muted ink and accent ink on the soft accent fall short in some palettes, so the shell uses dim and the plain ink there.
const SHELL = [
  '#mode-heading', '#full-date', '#dates-heading', '#today', '#sync-status', '.account-name',
  '.view-switch button[aria-pressed=false]', '.view-switch button[aria-pressed=true]',
  '.date-row:not(.selected) .date-number', '.date-row:not(.selected) .date-label',
  '.date-row.selected .date-number', '.date-row.selected .date-label',
];
const VIEWS = {
  Day: [...SHELL, '.day-label', '.day-fl', '.day-count:not(:empty)', '.day-task-title', '.day-from'],
  Month: [...SHELL, '.wm-dow-full', '.wm-day.out .wm-day-num', '.wm-day:not(.out):not(.today) .wm-day-num', '.wm-day.today .wm-day-num', '.wm-day[data-sat]:not(.out) .wm-day-num', '.wm-day[data-letter=A]:not(.out):not(.today) .wm-day-num', '.wm-day .ch-title', '.wm-add-count:not([hidden])', '.wm-notes .panel-label', '.wm-notes .wm-lane-head h3', '.wm-notes .wm-count', '.wm-notes .wm-state:not(:empty)', '.wm-notes .wm-lane-head .wm-you'],
} as const;

const MUST_EXIST = { Day: ['.day-count:not(:empty)', '.day-from'], Month: ['.wm-day.out', '.wm-day.today', '.wm-day[data-sat]', '.wm-notes .wm-state:not(:empty)'] } as const;

test('desktop: small text clears AA in all four themes, resting and selected, in Day and Month', async ({ page, baseURL }) => {
  // One open to-do today, so the Day's to-do counter has a count to check, and one from yesterday for the "from" chip.
  const owner = await apiLogin(baseURL!, OWNER), item = todo({ owners: [OWNER], title: unique('Contrast') }), old = todo({ owners: [OWNER], title: unique('Carried'), date: shiftDate(today(), -1, 'day') });
  expect((await owner.post(item)).status()).toBe(200);
  expect((await owner.post(old)).status()).toBe(200);
  // A saved note this month, so the Notes card of the Month says "Saved" (small text in its own place) in every theme.
  const month = `${today().slice(0, 7)}-01`, noteKey = `month:${month}:${OWNER}:notes`;
  const noted = (await owner.snapshot()).notes.find((n: { key: string }) => n.key === noteKey);
  expect((await owner.post({ action: 'saveNote', scope: 'month', period: month, listId: OWNER, field: 'notes', text: 'Contrast note', revision: noted?.revision ?? 0 })).status()).toBe(200);
  try {
    await login(page);
    for (const view of ['Day', 'Month'] as const) {
      await page.getByRole('button', { name: view, exact: true }).click();
      await expect(page.locator('.date-row.selected')).toBeVisible();
      // What the check needs to have on the page: a selected row, the to-do counter and the "from" chip, and (in Month) muted days, today and a hatched Saturday.
      for (const selector of MUST_EXIST[view]) { await expect(page.locator(selector).first(), `${view} ${selector}`).toBeAttached(); }
      for (const theme of Object.keys(THEMES) as ThemeName[]) {
        await showTheme(page, theme);
        for (const selector of VIEWS[view]) {
          const seen = await textContrast(page, selector);
          // Some of them exist only with data or only in some states; the ones that matter are always on this page.
          for (const { text, ratio } of seen) { expect(ratio, `${theme} ${view} ${selector} "${text}"`).toBeGreaterThanOrEqual(MIN_CONTRAST); }
        }
      }
    }
  } finally {
    await removeTodos(owner, [item.id, old.id]);
    const kept = (await owner.snapshot()).notes.find((n: { key: string }) => n.key === noteKey);
    if (kept) { await owner.post({ action: 'saveNote', scope: 'month', period: month, listId: OWNER, field: 'notes', text: noted?.text ?? '', revision: kept.revision }); }
    await owner.dispose();
  }
});

test('desktop: the error banner\'s words clear AA in all four themes, the light one too', async ({ page }) => {
  await login(page);
  // A write that cannot be saved puts its message in the shell's banner (nothing is stored: the add is cut off).
  await page.route(url => url.pathname.endsWith('/api.php'), route => (route.request().method() === 'GET' ? route.continue() : route.abort('failed')));
  const add = page.getByLabel('New task', { exact: true });
  await add.fill('Contrast probe');
  await add.press('Enter');
  await expect(page.locator('#error')).toBeVisible();
  for (const theme of Object.keys(THEMES) as ThemeName[]) {
    await showTheme(page, theme);
    for (const selector of ['#error-message', '#error .text-button']) {
      const seen = await textContrast(page, selector);
      expect(seen.length, `${theme} ${selector}`).toBeGreaterThan(0);
      for (const { text, ratio } of seen) { expect(ratio, `${theme} ${selector} "${text}"`).toBeGreaterThanOrEqual(MIN_CONTRAST); }
    }
  }
});
