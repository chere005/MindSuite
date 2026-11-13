import { expect, test, type Page } from '@playwright/test';
import { apiLogin, draftSpan, farDate, field, isPhone, login, resetPrefs, showHalf, type Api } from './helpers';
import { OWNER, OWNER_NAME } from './people';

// A shared boundary (the owner, 2026-11-09): when one entry ends where the next starts, dragging that edge moves both, the first one's end and the
// second one's start together, neither shorter than 30 minutes; Enter saves both in one write, Escape puts both back. Desktop and phone.
test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });
const add = async (api: Api, body: Record<string, unknown>) => {
  const data = { id: crypto.randomUUID(), ...body };
  const response = await api.post(data);
  expect(response.status(), JSON.stringify(await response.json())).toBe(200);
  return data.id as string;
};
async function clearDay(api: Api, date: string) {
  for (const item of (await api.snapshot()).events.filter((i: { date: string }) => i.date === date)) {
    await api.post({ action: 'delete', id: item.id, revision: item.revision, confirm: true });
  }
}
/** Presses a handle of the entry being edited and moves the pointer `minutes` along the grid, leaving the button down. */
async function grab(page: Page, edge: 'start' | 'end', minutes: number) {
  const grid = (await page.locator('.day-lanes').boundingBox())!, span = Number(await page.locator('.day-lanes').getAttribute('data-span'));
  const box = (await page.locator(`.day-ev.day-editing .day-handle[data-edge=${edge}]`).boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + (minutes * grid.height) / span, { steps: 8 });
}
const block = (page: Page, label: string) => page.getByRole('button', { name: label, exact: true });

test('dragging the edge two bordering entries share moves both, keeps each at 30 minutes or more, and saves both in one write', async ({ page, baseURL }, info) => {
  const phone = isPhone(info.project.name);
  const owner = await apiLogin(baseURL!, OWNER), date = farDate(phone ? 411 : 410);
  const gym = await add(owner, { action: 'add', kind: 'event', date, owners: [OWNER], text: 'Gym', start: 540, length: 60 });
  const dentist = await add(owner, { action: 'add', kind: 'event', date, owners: [OWNER], text: 'Dentist', start: 600, length: 60 });
  const posts: Array<Record<string, unknown>> = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('api.php')) { posts.push(request.postDataJSON()); } });
  try {
    await login(page);
    await page.locator(phone ? '#pill-date' : '#jump-date').fill(date);
    await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', date);
    await showHalf(page, 'am');
    await block(page, `Gym, 9a to 10a, ${OWNER_NAME}`).click();
    await expect(field(page, 'Edit entry: Gym')).toBeFocused();

    // Gym's end 30 minutes later: Dentist now starts at 10:30, while the drag is still going.
    await grab(page, 'end', 30);
    await expect(page.locator('.day-bubble')).toHaveText('9a – 10:30a');
    await expect(block(page, `Dentist, 10:30a to 11a, ${OWNER_NAME}`)).toBeVisible();
    await page.mouse.up();
    // Back an hour: Gym 9 to 9:30, Dentist grows to 9:30.
    await grab(page, 'end', -60);
    await expect(page.locator('.day-bubble')).toHaveText('9a – 9:30a');
    await expect(block(page, `Dentist, 9:30a to 11a, ${OWNER_NAME}`)).toBeVisible();
    await page.mouse.up();
    // Far past Dentist's end: it keeps its last 30 minutes; Gym stops there.
    await grab(page, 'end', 200);
    await expect(page.locator('.day-bubble')).toHaveText('9a – 10:30a');
    await expect(block(page, `Dentist, 10:30a to 11a, ${OWNER_NAME}`)).toBeVisible();
    await page.mouse.up();
    // And far before Gym's start: Gym keeps 30 minutes.
    await grab(page, 'end', -300);
    await expect(page.locator('.day-bubble')).toHaveText('9a – 9:30a');
    await expect(block(page, `Dentist, 9:30a to 11a, ${OWNER_NAME}`)).toBeVisible();
    await page.mouse.up();
    await grab(page, 'end', 75);
    await page.mouse.up();
    await expect.poll(() => draftSpan(page)).toEqual({ start: 540, length: 90 });
    await expect(block(page, `Dentist, 10:30a to 11a, ${OWNER_NAME}`)).toBeVisible();
    expect(posts, 'nothing is saved while dragging').toHaveLength(0);

    // Enter: both in one write, all or nothing.
    await field(page, 'Edit entry: Gym').press('Enter');
    await expect(block(page, `Gym, 9a to 10:30a, ${OWNER_NAME}`)).toBeVisible();
    await expect(block(page, `Dentist, 10:30a to 11a, ${OWNER_NAME}`)).toBeVisible();
    expect(posts).toEqual([{ action: 'editEvents', edits: [
      { id: gym, revision: 1, date, owners: [OWNER], text: 'Gym', start: 540, length: 90 },
      { id: dentist, revision: 1, date, owners: [OWNER], text: 'Dentist', start: 630, length: 30 },
    ] }]);
    const stored = (await owner.snapshot()).events.filter((e: { date: string }) => e.date === date);
    expect(stored.find((e: { id: string }) => e.id === gym)).toMatchObject({ start: 540, length: 90, revision: 2 });
    expect(stored.find((e: { id: string }) => e.id === dentist)).toMatchObject({ start: 630, length: 30, revision: 2 });

    // From the other side: Dentist's start handle is the same boundary. Escape puts both back and writes nothing.
    posts.length = 0;
    await block(page, `Dentist, 10:30a to 11a, ${OWNER_NAME}`).click();
    await expect(field(page, 'Edit entry: Dentist')).toBeFocused();
    await grab(page, 'start', -45);
    await expect(page.locator('.day-bubble')).toHaveText('9:45a – 11a');
    await expect(block(page, `Gym, 9a to 9:45a, ${OWNER_NAME}`)).toBeVisible();
    await page.mouse.up();
    await field(page, 'Edit entry: Dentist').press('Escape');
    await expect(block(page, `Gym, 9a to 10:30a, ${OWNER_NAME}`)).toBeVisible();
    await expect(block(page, `Dentist, 10:30a to 11a, ${OWNER_NAME}`)).toBeVisible();
    expect(posts).toHaveLength(0);
  } finally { await clearDay(owner, date); await owner.dispose(); }
});
