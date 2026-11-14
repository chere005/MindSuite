import { expect, test, type Page } from '@playwright/test';

/** Stalled requests time out and may be retried, but syncs must never overlap. */
async function signup(page: Page): Promise<void> {
  const user = `sh${String(Date.now()).slice(-7)}`;
  await page.goto('.');
  await page.getByText('Sign up', { exact: true }).click();
  await page.getByPlaceholder('Username').fill(user);
  await page.getByPlaceholder('Email').fill(user + '@example.com');
  await page.getByPlaceholder('Password', { exact: true }).fill('e2epassword');
  await page.getByPlaceholder('Confirm password').fill('e2epassword');
  await page.getByText('Sign up', { exact: true }).click();
  await expect(page.getByTestId('tab-reminders')).toBeVisible({ timeout: 20_000 });
}

test('a sync that never answers does not leave the app looking synced', async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    const stats = { active: 0, max: 0 };
    (window as unknown as { syncProbe: typeof stats }).syncProbe = stats;
    window.fetch = (...args: Parameters<typeof fetch>) => {
      let sync = false;
      try { sync = JSON.parse(String(args[1]?.body ?? '{}')).action === 'sync'; } catch { }
      if (!sync) return original(...args);
      stats.active++;
      stats.max = Math.max(stats.max, stats.active);
      return original(...args).finally(() => { stats.active--; });
    };
  });
  await page.clock.install();
  await signup(page);
  await page.clock.pauseAt(new Date(Date.now() + 1_000));

  let hung = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/index.php*', async route => {
    if (JSON.parse(route.request().postData() ?? '{}').action === 'sync') {
      hung++;
      await held;
      await route.abort().catch(() => {});
      return;
    }
    await route.continue();
  });
  try {
    await page.getByTestId('tab-reminders').click();
    await page.getByTestId('secadd-General').first().click();
    await page.getByTestId('rem-add-field').fill('vanishing act');
    await page.getByTestId('rem-add-field').press('Enter');
    await page.clock.runFor(1_000);
    await expect.poll(() => hung).toBeGreaterThan(0);

    // Cross three poll intervals and the real request deadline without a 95-second wall-clock race.
    for (const elapsed of [30_000, 30_000, 30_000, 5_000]) await page.clock.runFor(elapsed);
    await expect.poll(() => hung, { message: 'a stalled request expires and another sync can be attempted' }).toBeGreaterThanOrEqual(2);
    const stats = await page.evaluate(() => (window as unknown as { syncProbe: { active: number; max: number } }).syncProbe);
    expect(stats.max, 'a retry starts only after the previous fetch has settled').toBe(1);
    await expect(page.getByTestId('topbar-sync')).not.toHaveAttribute('aria-label', /Online — synced/);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
