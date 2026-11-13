import { expect, test, type Page } from '@playwright/test';
import { periodStart } from '../packages/core/src/planner';
import { apiLogin, farDate, leaveField, login, resetPrefs, todo, removeTodos, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// The Month's side column holds scrollers side by side: the to-do list and the two priorities boxes. A list that scrolls stays where it is while someone types
// in a neighbouring box and when a poll redraws the panel (the rule of the Day's list too). A box that measures itself by releasing its own height makes the others
// roomier for a moment, and WebKit (the engine of the Mac and phone apps) clamps their scroll positions for good when that happens; Chromium does not, so this runs
// in WebKit too: PLANMIND_E2E_WEBKIT=1 npx playwright test e2e/month-scroll.spec.ts --project=webkit
const POLL = 13000;
const month = (n: number) => periodStart(farDate(n), 'month');
const lines = (n: number, what: string) => Array.from({ length: n }, (_, i) => `${what} ${i + 1}`).join('\n');
const cleanup: Array<() => Promise<unknown>> = [];
test.afterEach(async ({ baseURL }) => { for (const fn of cleanup.splice(0).reverse()) { await fn().catch(() => {}); } await resetPrefs(baseURL!); });

/** A priorities note written through the API, emptied again when the test ends (the store is shared by the run). */
async function note(api: Api, period: string, listId: string, text: string) {
  const key = `month:${period}:${listId}:priorities`;
  const stored = (await api.snapshot()).notes.find((n: { key: string }) => n.key === key);
  expect((await api.post({ action: 'saveNote', scope: 'month', period, listId, field: 'priorities', text, revision: stored?.revision ?? 0 })).status()).toBe(200);
  cleanup.push(async () => {
    const kept = (await api.snapshot()).notes.find((n: { key: string }) => n.key === key);
    if (kept) { await api.post({ action: 'saveNote', scope: 'month', period, listId, field: 'priorities', text: '', revision: kept.revision }); }
  });
}
const places = (page: Page) => page.evaluate(([ownerName, partnerName]) => {
  const top = (selector: string) => { const el = document.querySelector<HTMLElement>(selector)!; return { at: Math.round(el.scrollTop), end: el.scrollHeight - el.clientHeight }; };
  return { list: top('ul.wm-todos'), owner: top(`textarea[aria-label="${ownerName} priorities"]`), partner: top(`textarea[aria-label="${partnerName} priorities"]`) };
}, [OWNER_NAME, PARTNER_NAME]);
const toEnd = (page: Page) => page.evaluate(ownerName => {
  for (const selector of ['ul.wm-todos', `textarea[aria-label="${ownerName} priorities"]`]) { const el = document.querySelector<HTMLElement>(selector)!; el.scrollTop = el.scrollHeight; }
}, OWNER_NAME);

test('typing in one priorities box, and a redraw from a poll, leave the to-do list and the other box where they were scrolled', async ({ page, baseURL }) => {
  await page.clock.install();
  const when = month(500), owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER);
  cleanup.push(() => owner.dispose(), () => partner.dispose());
  // The owner's box is past its share, the partner's holds five lines, and the sixteen to-dos are more than the list shows.
  await note(owner, when, OWNER, lines(20, `${OWNER_NAME} priority`));
  await note(owner, when, PARTNER, lines(5, `${PARTNER_NAME} priority`));
  const ids: string[] = [];
  for (let n = 1; n <= 16; n++) { const body = todo({ scope: 'month', date: when, owners: [OWNER], title: `Month scroll ${n}` }); ids.push(body.id as string); await owner.post(body); }
  cleanup.push(() => removeTodos(owner, ids));
  await login(page, OWNER);
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await page.locator('#jump-date').fill(when);
  await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', when);
  await expect(page.locator('ul.wm-todos')).toBeVisible();
  await page.clock.runFor(100);
  await toEnd(page);
  const start = await places(page);
  expect(start.list.end, 'the list has something to scroll').toBeGreaterThan(50);
  expect(start.owner.end, `${OWNER_NAME}'s box has something to scroll`).toBeGreaterThan(50);
  expect([start.list.at, start.owner.at], 'both are at their end').toEqual([start.list.end, start.owner.end]);
  const still = async (what: string) => {
    const now = await places(page);
    expect(now.list.at, `${what}: the to-do list stays where it was`).toBeGreaterThanOrEqual(start.list.at - 1);
    expect(now.owner.at, `${what}: ${OWNER_NAME}'s box stays where it was`).toBeGreaterThanOrEqual(start.owner.at - 1);
  };

  // A character, then a new line, typed in the partner's box.
  const box = page.getByLabel(`${PARTNER_NAME} priorities`, { exact: true });
  await box.evaluate(el => { const text = el as HTMLTextAreaElement; text.focus(); text.setSelectionRange(text.value.length, text.value.length); });
  await page.keyboard.type('x');
  await still('a character typed');
  await page.keyboard.press('Enter');
  await page.keyboard.type('y');
  await page.clock.runFor(100);
  await still('a new line typed');

  // The other person adds a to-do to an unrelated month: the poll redraws the panel (a new list element) once no field has the focus.
  await leaveField(page);
  await page.locator('ul.wm-todos').evaluate(el => { el.dataset.mark = 'old'; });
  const other = periodStart(farDate(520), 'month');
  const body = todo({ scope: 'month', date: other, owners: [PARTNER], title: 'Month scroll elsewhere' });
  await partner.post(body);
  cleanup.push(() => removeTodos(partner, [body.id as string]));
  await page.clock.runFor(POLL);
  await expect.poll(() => page.locator('ul.wm-todos').evaluate(el => el.dataset.mark ?? 'redrawn')).toBe('redrawn');
  await page.clock.runFor(100);
  const after = await places(page);
  expect(after.list.at, 'the redraw leaves the to-do list where it was').toBeGreaterThanOrEqual(start.list.at - 1);
});
