import { expect, test, type Page } from '@playwright/test';
import { apiLogin, farDate, field, login, noWindow, resetPrefs, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// Priorities in the Both view on a phone: a tap on a blank line is cut in thirds as on a desktop (left lane, both of us, right lane); there is
// no hover. The priorities are on the To-do tab. The project's viewport is 375x812.
test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });
const openDay = async (page: Page, date: string) => {
  await page.locator('#pill-date').fill(date);
  await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', date);
};
async function clearDay(api: Api, date: string) {
  const snapshot = await api.snapshot();
  for (const item of [...snapshot.tasks, ...snapshot.priorities, ...snapshot.events].filter((i: { date: string }) => i.date === date)) {
    await api.post({ action: 'delete', id: item.id, revision: item.revision, confirm: true });
  }
}
const storedPriorities = async (api: Api, date: string) => (await api.snapshot()).priorities.filter((p: { date: string }) => p.date === date);

test.describe('Day priorities, phone: thirds in the Both view', () => {
  test('a tap in the middle third is one priority for both of us, an outer third is that lane, and no hover box is drawn', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(334);
    try {
      await login(page); await openDay(page, date);
      await page.getByRole('tab', { name: 'To-do', exact: true }).tap();
      const row = (n: number) => page.locator(`.day-prow[data-line="${n}"] .day-pcells`);
      const box2 = (await row(2).boundingBox())!;
      await page.touchscreen.tap(box2.x + box2.width * 0.5, box2.y + box2.height / 2);
      const fresh = field(page, `New priority 2 for ${OWNER_NAME} and ${PARTNER_NAME}`);
      await expect(fresh).toBeFocused();
      await noWindow(page);
      await fresh.fill('Family dinner');
      await fresh.press('Enter');
      await expect(page.getByRole('button', { name: 'Priority 2: Family dinner, Both', exact: true })).toHaveAttribute('data-c', 'purple');
      expect(await storedPriorities(owner, date)).toMatchObject([{ text: 'Family dinner', owners: [OWNER, PARTNER], slots: { [PARTNER]: 2, [OWNER]: 2 } }]);
      // A tap near either end is that lane alone.
      const box3 = (await row(3).boundingBox())!;
      await page.touchscreen.tap(box3.x + box3.width * 0.85, box3.y + box3.height / 2);
      await field(page, `New priority 3 for ${PARTNER_NAME}`).fill('Yoga');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: `Priority 3: Yoga, ${PARTNER_NAME}`, exact: true })).toBeVisible();
      await expect(page.locator('.day-newcell')).toHaveCount(0);
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});
