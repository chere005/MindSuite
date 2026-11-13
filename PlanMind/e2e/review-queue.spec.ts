import { test, expect, type Page } from '@playwright/test';
import { apiLogin, farDate, login, type Api } from './helpers';
import { OWNER, PARTNER } from './people';

// Reviewer's checks of the write line under a 300 ms delay on every write (desktop only).
const DELAY = 300;
test.beforeEach(({}, info) => { test.skip(info.project.name !== 'desktop', 'desktop only'); });

async function slow(page: Page) {
  await page.route('**/api.php', async route => { if (route.request().method() === 'POST') { await new Promise(r => setTimeout(r, DELAY)); } await route.continue(); });
}
const openDay = async (page: Page, date: string) => { await page.locator('#jump-date').fill(date); await page.waitForTimeout(400); };
const circle = (page: Page, title: string) => page.locator(`input.day-circle[aria-label$=" ${title}"]`);
async function make(api: Api, date: string, titles: string[], owners: string[] = [OWNER]) {
  for (const title of titles) {
    const r = await api.post({ action: 'add', kind: 'todo', id: crypto.randomUUID(), scope: 'day', date, owners, title });
    expect(r.status()).toBe(200);
  }
}
const byTitle = async (api: Api, title: string) => (await api.snapshot()).tasks.find((t: any) => t.title === title);
let day = 900;

test('a refused write in the middle of the line reverts only its own change', async ({ page, baseURL }) => {
  const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER);
  const date = farDate(day++), tag = crypto.randomUUID().slice(0, 5);
  const [a, b, c] = ['A', 'B', 'C'].map(x => `Rq ${tag} ${x}`) as [string, string, string];
  await make(owner, date, [a, b, c]);
  await login(page); await slow(page); await openDay(page, date);
  await expect(circle(page, b)).toBeVisible();
  // The partner changes B under us (its revision moves on); the page has not polled yet.
  const tb = await byTitle(partner, b);
  expect((await partner.post({ action: 'edit', kind: 'todo', id: tb.id, revision: tb.revision, title: `${b} theirs`, owners: tb.owners, date: tb.date })).status()).toBe(200);
  await page.evaluate(async titles => {
    for (const t of titles) { document.querySelector<HTMLInputElement>(`input.day-circle[aria-label$=" ${t}"]`)?.click(); await new Promise(r => setTimeout(r, 80)); }
  }, [a, b, c]);
  // All three answered at once.
  await expect(page.locator('#error')).toBeVisible({ timeout: 5000 });
  await expect.poll(async () => [(await byTitle(owner, a))?.done, (await byTitle(owner, `${b} theirs`))?.done, (await byTitle(owner, c))?.done], { timeout: 8000 }).toEqual([true, false, true]);
  await expect(circle(page, a)).toBeChecked();
  await expect(circle(page, c)).toBeChecked();
  await expect(circle(page, `${b} theirs`)).not.toBeChecked({ timeout: 8000 });
  await owner.dispose(); await partner.dispose();
});

test('two sessions ticking the same and different items converge', async ({ browser, baseURL }) => {
  const owner = await apiLogin(baseURL!, OWNER);
  const date = farDate(day++), tag = crypto.randomUUID().slice(0, 5);
  const [x, y, z] = ['X', 'Y', 'Z'].map(s => `Two ${tag} ${s}`) as [string, string, string];
  await make(owner, date, [x, y, z], [OWNER, PARTNER].sort());
  const ctxA = await browser.newContext({ viewport: { width: 1360, height: 900 } }), ctxB = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const pa = await ctxA.newPage(), pb = await ctxB.newPage();
  await login(pa, OWNER); await login(pb, PARTNER);
  await slow(pa); await slow(pb);
  await openDay(pa, date); await openDay(pb, date);
  await expect(circle(pa, x)).toBeVisible(); await expect(circle(pb, x)).toBeVisible();
  const clicks = (p: Page, titles: string[]) => p.evaluate(async titles => {
    for (const t of titles) { document.querySelector<HTMLInputElement>(`input.day-circle[aria-label$=" ${t}"]`)?.click(); await new Promise(r => setTimeout(r, 80)); }
  }, titles);
  await Promise.all([clicks(pa, [x, y]), clicks(pb, [x, z])]);
  await expect.poll(async () => Promise.all([x, y, z].map(async t => (await byTitle(owner, t))?.done)), { timeout: 8000 }).toEqual([true, true, true]);
  // Each page shows all three once it has heard (a reload stands in for the next poll).
  for (const p of [pa, pb]) { await p.reload(); await openDay(p, date); for (const t of [x, y, z]) { await expect(circle(p, t)).toBeChecked(); } }
  await ctxA.close(); await ctxB.close(); await owner.dispose();
});

test('a rename committed by pressing the same row\'s circle', async ({ page, baseURL }) => {
  const owner = await apiLogin(baseURL!, OWNER);
  const date = farDate(day++), title = `Ren ${crypto.randomUUID().slice(0, 5)}`;
  await make(owner, date, [title]);
  await login(page); await slow(page); await openDay(page, date);
  await page.getByRole('button', { name: `Edit ${title}`, exact: true }).click();
  const input = page.getByRole('textbox', { name: `Edit task: ${title}`, exact: true });
  await input.fill(`${title} new`);
  await page.locator('.day-task.day-editing input.day-circle').click();
  await page.waitForTimeout(DELAY * 4 + 500);
  const stored = (await byTitle(owner, `${title} new`)) ?? (await byTitle(owner, title));
  const banner = await page.locator('#error').isVisible() ? await page.locator('#error-message').textContent() : null;
  const shownTitles = await page.locator('.day-task').allTextContents();
  console.log(`REVIEW rename+tick: screen=${JSON.stringify(shownTitles.map(t => t.trim().slice(0, 40)))} circle=${await circle(page, title).isChecked().catch(() => 'n/a')} stored=${JSON.stringify({ title: stored?.title, done: stored?.done })} banner=${JSON.stringify(banner)}`);
  await owner.dispose();
});
