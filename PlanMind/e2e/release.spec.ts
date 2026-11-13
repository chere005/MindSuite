import { expect, test, type Page } from '@playwright/test';
import { periodStart } from '../packages/core/src/planner';
import { A, B, hold, host, mark, poll, reloaded, still } from './release-host';
import { accountMenu, apiLogin, farDate, field, leaveField, login, resetPrefs, todo, unique, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// An open page picks up a new release: api.php names the release that answered in X-PlanMind-Release; the app keeps the first stamp it
// sees and, when a later answer names another, reloads at the next quiet moment (no field focused, no unsent text anywhere, no pointer down, no write
// in flight), and puts the person back where they were. The preview has no releases, so each test stands in for the host (release-host.ts).
const openDay = async (page: Page, date: string) => {
  await page.locator('#jump-date').fill(date);
  await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', date);
};
async function clearDay(api: Api, date: string) {
  const snapshot = await api.snapshot();
  for (const item of [...snapshot.tasks, ...snapshot.priorities, ...snapshot.events].filter((i: { date: string }) => i.date === date)) {
    await api.post({ action: 'delete', id: item.id, revision: item.revision, confirm: true });
  }
}

test.describe('a new release reaches an open page', () => {
  test('a quiet page loads it at the next answer that names another stamp, once; the same stamp, no stamp and the old one again change nothing', async ({ page }) => {
    const served = await host(page);
    await login(page);
    await mark(page);
    // The same release again, and an answer that carries no stamp at all (a host error page): nothing to pick up.
    await poll(page);
    served.stamp = null;
    await poll(page);
    served.stamp = A;
    await poll(page);
    await still(page, 'the page started under A and A was served');
    // Another release is served: the next read names it and the page loads it.
    served.stamp = B;
    await poll(page);
    await reloaded(page);
    await expect(page.locator('#sidebar .date-row.selected')).toBeAttached();
    expect(await page.evaluate(() => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).type)).toBe('reload');
    // The new page's own release is B: it asks again and stays where it is.
    await mark(page);
    await poll(page);
    await still(page, 'B is the new page\'s own release');
  });

  test('a rollback to an older release is picked up too: any other stamp is another release', async ({ page }) => {
    const served = await host(page, B);
    await login(page);
    await mark(page);
    served.stamp = A;
    await poll(page);
    await reloaded(page);
    await expect(page.locator('#sidebar .date-row.selected')).toBeAttached();
  });

  test('it waits while a field has the focus and while unsent text is anywhere on the page, and loads the moment the page is quiet', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1700);
    const served = await host(page);
    try {
      await login(page);
      await openDay(page, date);
      await mark(page);
      served.stamp = B;
      // The add field holds the focus with words in it.
      const add = page.getByLabel('New task', { exact: true });
      await add.fill('Half a thought');
      await poll(page);
      await still(page, 'a field has the focus');
      // The focus leaves, the words stay unsent: still not the moment.
      await leaveField(page);
      await poll(page);
      await still(page, 'the add field holds unsent words');
      // A note typed and not saved is a draft too.
      const notes = page.getByRole('textbox', { name: `Notes for ${OWNER_NAME}`, exact: true });
      await add.fill('');
      await notes.fill('A note nobody saved');
      await leaveField(page);
      await poll(page);
      await still(page, 'a note holds unsaved words');
      // Words taken back out, nothing is unsent: the focus leaving is the quiet moment, with no further read needed.
      await notes.fill('');
      await leaveField(page);
      await reloaded(page);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('it waits while an item is open in its own place, and for a pointer that is down, and loads when each is over', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1701), title = unique('Plain');
    expect((await owner.post(todo({ date, owners: [OWNER], title }))).status()).toBe(200);
    const served = await host(page);
    try {
      await login(page);
      await openDay(page, date);
      await mark(page);
      served.stamp = B;
      // A to-do open for editing, its words untouched.
      await page.getByRole('button', { name: `Edit ${title}`, exact: true }).click();
      await expect(page.getByRole('textbox', { name: `Edit task: ${title}`, exact: true })).toBeFocused();
      await poll(page);
      await still(page, 'an item is open');
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-editing]')).toHaveCount(0);
      // The release was seen while the edit was open: Escape closes it and the page loads.
      await reloaded(page);
      await expect(page.locator('#sidebar .date-row.selected')).toBeAttached();
      await openDay(page, date);
      // A pointer held down (a drag or a press that has not finished) is not the moment either.
      await mark(page);
      served.stamp = A;
      const header = (await page.locator('.page-header').boundingBox())!;
      await page.mouse.move(header.x + header.width / 2, header.y + header.height / 2);
      await page.mouse.down();
      await poll(page);
      await still(page, 'the button is down');
      await page.mouse.up();
      await reloaded(page);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a write in flight finishes first: the page loads the new release after the answer, and the write is stored', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1702), title = unique('Plain');
    expect((await owner.post(todo({ date, owners: [OWNER], title }))).status()).toBe(200);
    const served = await host(page);
    try {
      await login(page);
      await openDay(page, date);
      await mark(page);
      // The host holds the answer of the write.
      const letGo = hold(served, '"complete"');
      await page.getByRole('checkbox', { name: `Complete ${title}`, exact: true }).click();
      await expect(page.locator('#sync-status')).toHaveText('Saving…');
      // Meanwhile another release answers (the silent save of the sidebar choice goes through) and the page is touched: a write is in flight, so it waits.
      served.stamp = B;
      const saved = page.waitForResponse(response => response.request().method() === 'POST' && (response.request().postData() ?? '').includes('"savePrefs"'));
      await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
      await saved;
      const header = (await page.locator('.page-header').boundingBox())!;
      await page.mouse.click(header.x + header.width / 2, header.y + header.height / 2);
      await still(page, 'the write is in flight');
      letGo();
      await reloaded(page);
      await expect(page.locator('#sidebar .date-row.selected')).toBeAttached();
      expect((await owner.snapshot()).tasks.find((t: { title: string }) => t.title === title)).toMatchObject({ done: true });
    } finally { await clearDay(owner, date); await owner.dispose(); await resetPrefs(baseURL!); }
  });

  test('it waits for a to-do put away with words that were never saved (its save was refused), and loads when they are given up', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), partner = await apiLogin(baseURL!, PARTNER), date = farDate(1703), title = unique('Plain');
    const item = todo({ date, owners: [OWNER], title });
    expect((await owner.post(item)).status()).toBe(200);
    const served = await host(page);
    try {
      await login(page);
      await openDay(page, date);
      await mark(page);
      // The partner changes the to-do after this page read it, so the owner's save is refused as stale and the words he typed are put away, off the page.
      expect((await partner.post({ action: 'edit', kind: 'todo', id: item.id, revision: 1, date, owners: [OWNER], title: `${PARTNER_NAME} changed ${title}` })).status()).toBe(200);
      await page.getByRole('button', { name: `Edit ${title}`, exact: true }).click();
      await field(page, `Edit task: ${title}`).fill('My changed title');
      await page.getByRole('button', { name: 'Next day', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('changed on another device');
      await leaveField(page);
      served.stamp = B;
      await poll(page);
      await still(page, 'a to-do that was put away holds words that were never saved');
      // Back on its day the words are in its row again; giving them up (Escape) is the quiet moment.
      await page.getByRole('button', { name: 'Previous day', exact: true }).click();
      await page.getByRole('button', { name: `Edit ${PARTNER_NAME} changed ${title}`, exact: true }).click();
      await expect(field(page, `Edit task: ${PARTNER_NAME} changed ${title}`)).toHaveValue('My changed title');
      await still(page, 'the row is open with its words');
      await page.keyboard.press('Escape');
      await reloaded(page);
    } finally { await clearDay(owner, date); await owner.dispose(); await partner.dispose(); }
  });

  test('it waits for words left in the add box of another week, and loads when they are taken out', async ({ page }) => {
    const served = await host(page), when = periodStart(farDate(1704), 'week');
    await login(page);
    await page.getByRole('button', { name: 'Week', exact: true }).click();
    await page.locator('#jump-date').fill(when);
    await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', when);
    await mark(page);
    served.stamp = B;
    const add = page.getByLabel('New to-do', { exact: true });
    await add.fill('Half a thought');
    await page.getByRole('button', { name: 'Next week', exact: true }).click();
    await expect(add).toHaveValue('');
    await poll(page);
    await still(page, 'the add box of another week holds unsent words');
    await page.getByRole('button', { name: 'Previous week', exact: true }).click();
    await expect(add).toHaveValue('Half a thought');
    await add.fill('');
    await leaveField(page);
    await reloaded(page);
  });

  test('it waits while the list manager is open, with a name typed in it and the focus elsewhere, and loads when it is closed', async ({ page }) => {
    const served = await host(page);
    await login(page);
    await mark(page);
    served.stamp = B;
    await page.locator('#picker-button').click();
    await page.getByRole('button', { name: 'Manage lists…', exact: true }).click();
    const dialog = page.getByRole('region', { name: 'Manage lists' });
    await dialog.getByLabel('New list name', { exact: true }).fill('Camping');
    await dialog.getByRole('button', { name: 'Add list', exact: true }).focus();
    await poll(page);
    await still(page, 'the list manager is open with a name typed in it');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await reloaded(page);
  });

  test('a picker or sidebar save still on its way finishes first: the page loads the new release after its answer, and the choice is stored', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), served = await host(page);
    try {
      await login(page);
      await mark(page);
      const letGo = hold(served, '"savePrefs"');
      const sent = page.waitForRequest(request => request.method() === 'POST' && (request.postData() ?? '').includes('"savePrefs"'));
      await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
      await sent;
      // The 400 ms pause is over and the request is out, with no write marked busy: the host has not answered, and a load now would cut it off.
      served.stamp = B;
      await poll(page);
      await still(page, 'the save of the sidebar is on its way');
      letGo();
      await reloaded(page);
      expect((await owner.snapshot()).prefs.sidebar).toBe('hidden');
    } finally { await owner.dispose(); await resetPrefs(baseURL!); }
  });

  test('a theme still being stored finishes first, then the page loads the new release', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), served = await host(page);
    try {
      await login(page);
      await mark(page);
      const letGo = hold(served, '"setTheme"');
      const sent = page.waitForRequest(request => request.method() === 'POST' && (request.postData() ?? '').includes('"setTheme"'));
      await accountMenu(page, 'Settings');
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Forest', exact: true }).click();
      await sent;
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      served.stamp = B;
      await poll(page);
      await still(page, 'the theme is still on its way to be stored');
      letGo();
      await reloaded(page);
      expect((await owner.snapshot()).theme).toBe('forest');
    } finally { await owner.post({ action: 'setTheme', theme: 'midnight' }); await owner.dispose(); }
  });

  test('the load puts the person back: the Day a Month opened (with its Back), and a far day with the Chores switch on; the URL is the plain one again', async ({ page }) => {
    const served = await host(page), selected = page.locator('#sidebar .date-row.selected'), plain = () => new URL(page.url()).hash;
    await login(page);
    await page.locator('#sidebar [data-view="month"]').click();
    await page.locator('#jump-date').fill('2041-03-17');
    await page.locator('.wm-day[data-date="2041-03-17"] .wm-day-num').click();
    await expect(page.locator('#back-view')).toBeVisible();
    await mark(page);
    served.stamp = B;
    await poll(page);
    await reloaded(page);
    // The same Day, still opened from the Month: its Back is there and goes to that Month.
    await expect(page.locator('.day-panel')).toBeVisible();
    await expect(selected).toHaveAttribute('data-date', '2041-03-17');
    await expect(page.locator('#jump-date')).toHaveValue('2041-03-17');
    await expect(page.locator('#back-view')).toBeVisible();
    expect(plain()).toBe('');
    await page.locator('#back-view').click();
    await expect(page.locator('.wm-panel[data-panel="month"]')).toBeVisible();
    await expect(selected).toHaveAttribute('data-date', '2041-03-01');
    // A load by hand is not a new release: it starts on today, as it always did.
    await page.reload();
    await expect(page.locator('#day-title')).toHaveText('Today');

    // A far day with the Day's Chores switch on (a desktop page: the to-do section lists the chores).
    const when = '2041-06-17';
    const chores = page.getByRole('group', { name: 'Lists', exact: true }).getByRole('switch', { name: 'Chores', exact: true });
    await page.locator('#sidebar [data-view="day"]').click();
    await page.locator('#jump-date').fill(when);
    await page.locator('#picker-button').click();
    await chores.click();
    await expect(page.locator('.day-chores')).toBeVisible();
    await mark(page);
    served.stamp = A;
    await poll(page);
    await reloaded(page);
    await expect(page.locator('.day-chores')).toBeVisible();
    await expect(page.locator('.day-todo')).toHaveCount(0);
    await expect(selected).toHaveAttribute('data-date', when);
    await expect(page.locator('#picker-button')).toHaveAttribute('aria-label', 'Lists: Both');
    await expect(page.locator('#sidebar [data-view="day"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#picker-button').click();
    await expect(chores).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    expect(plain()).toBe('');
  });
});
