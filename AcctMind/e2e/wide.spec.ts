/**
 * The wide (desktop-size) layout: sidebar left of the main pane, the table,
 * the detail pane, the Mac quick entry, and read-only mode.
 *
 * READ-ONLY IS FORCED by installing a stand-in CloudKit that is signed in and
 * holds the ledger: a signed-in plain browser is reading the phone's copy, which
 * is exactly the case core's `ledgerAccess` makes read-only. Without a
 * stand-in the harness is a plain browser on 127.0.0.1 with its own local
 * ledger, which stays editable (every older spec relies on that).
 */
import { deflateRawSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { CK_FIELD, CK_RECORD_NAME } from '@acctmind/core';
import { stored, storedTxns, withStore } from './helpers';
import { wideLedger } from './wide-data';

// Layout checks run once, at desktop size.
test.beforeEach(({ browserName }) => { test.skip(browserName !== 'chromium'); });

async function asCopy(page: Page, ledger: string): Promise<void> {
  const record = deflateRawSync(Buffer.from(ledger, 'utf8')).toString('base64');
  await page.route('**/cdn.apple-cloudkit.com/**', (r) => r.abort());
  await page.addInitScript(({ record, name, field }) => {
    (window as unknown as Record<string, unknown>).CloudKit = {
      configure() {},
      getDefaultContainer() {
        return {
          async setUpAuth() { return { userRecordName: '_me' }; },
          whenUserSignsIn() { return new Promise<void>(() => {}); },
          whenUserSignsOut() { return new Promise<void>(() => {}); },
          privateCloudDatabase: {
            async fetchRecords(names: string[]) {
              if (names[0] !== name) return { hasErrors: true, errors: [{ serverErrorCode: 'NOT_FOUND' }], records: [] };
              return { hasErrors: false, errors: [], records: [{ fields: { [field]: { value: record } }, modified: { timestamp: Date.now() - 3600_000 } }] };
            },
          },
        };
      },
    };
  }, { record, name: CK_RECORD_NAME, field: CK_FIELD });
}

const noOverflow = async (page: Page) => {
  const over = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - window.innerWidth,
    main: (() => { const m = document.querySelector('[data-testid="wide-main"]') as HTMLElement | null; return m ? m.scrollWidth - m.clientWidth : 0; })(),
  }));
  expect(over.doc).toBeLessThanOrEqual(0);
  expect(over.main).toBeLessThanOrEqual(0);
};

test.describe('1280x820, editable', () => {
  test.use({ viewport: { width: 1280, height: 820 } });

  test('sidebar left of the main pane, no overflow, balance only for one account', async ({ page }) => {
    await withStore(page, wideLedger());
    await expect(page.getByTestId('wide-frame')).toBeVisible();
    const side = (await page.getByTestId('wide-sidebar').boundingBox())!;
    const main = (await page.getByTestId('wide-main').boundingBox())!;
    expect(side.x + side.width).toBeLessThanOrEqual(main.x + 0.5);
    expect(side.y).toBeLessThanOrEqual(main.y + 0.5);
    await expect(page.getByTestId('wide-sync')).toContainText('This browser only');

    // Budget is first: one compact totals line and status pills.
    await expect(page.getByTestId('wide-totals')).toContainText('Unassigned');
    await expect(page.getByTestId('wide-totals')).toContainText('Short of target');
    await expect(page.getByTestId('wide-tone').first()).toBeVisible();
    await noOverflow(page);

    await page.getByTestId('wide-account-all').click();
    await expect(page.getByTestId('col-account')).toBeVisible();
    await expect(page.getByTestId('col-balance')).toHaveCount(0);
    await expect(page.getByTestId('wide-foot')).toContainText('transactions');
    await noOverflow(page);

    await page.getByTestId('wide-account-a-chk').click();
    await expect(page.getByTestId('col-balance')).toBeVisible();
    await expect(page.getByTestId('col-account')).toHaveCount(0);
    await expect(page.getByTestId('wide-row-balance').first()).toBeVisible();
    await noOverflow(page);
  });

  test('a row opens in the detail pane, which saves and deletes', async ({ page }) => {
    await withStore(page, wideLedger());
    await page.getByTestId('wide-account-a-chk').click();
    await page.getByTestId('wide-row').filter({ hasText: 'Paycheck' }).first().click();
    await expect(page.getByTestId('txn-detail')).toBeVisible();
    const detail = (await page.getByTestId('wide-detail').boundingBox())!;
    const main = (await page.getByTestId('wide-main').boundingBox())!;
    expect(detail.x).toBeGreaterThanOrEqual(main.x + main.width - 1);
    await expect(page.getByTestId('name-input')).toHaveValue('Paycheck');
    await page.getByTestId('name-input').fill('Salary');
    await page.getByTestId('save-button').click();
    await expect(page.getByTestId('txn-detail')).toBeHidden();
    await expect(page.getByTestId('wide-row-name').filter({ hasText: 'Salary' })).toHaveCount(1);
    const before = (await storedTxns(page)).length;

    await page.getByTestId('wide-row').filter({ hasText: 'Salary' }).click();
    await page.getByTestId('delete-button').click();
    await page.getByTestId('delete-button').click();
    await expect(page.getByTestId('wide-row-name').filter({ hasText: 'Salary' })).toHaveCount(0);
    expect((await storedTxns(page)).length).toBe(before);   // tombstoned, not removed
  });

  test('quick entry adds with Return and returns focus to the name', async ({ page }) => {
    await withStore(page, wideLedger());
    await page.getByTestId('wide-account-a-chk').click();
    await page.keyboard.press('Control+n');
    await expect(page.getByTestId('quick-name')).toBeFocused();
    await page.getByTestId('quick-name').fill('Bagel');
    await page.getByTestId('quick-category').fill('dining');
    await page.getByTestId('quick-amount').fill('3.50');
    await page.getByTestId('quick-amount').press('Enter');
    await expect(page.getByTestId('wide-row-name').filter({ hasText: 'Bagel' })).toHaveCount(1);
    await expect(page.getByTestId('quick-name')).toBeFocused();
    await expect(page.getByTestId('quick-name')).toHaveValue('');
    // An invalid row says why and adds nothing.
    await page.getByTestId('quick-amount').fill('x');
    await page.getByTestId('quick-amount').press('Enter');
    await expect(page.getByTestId('quick-error')).toBeVisible();
  });

  test('the Cleared checkbox in the table still flips and persists', async ({ page }) => {
    await withStore(page, wideLedger());
    await page.getByTestId('wide-account-a-chk').click();
    const first = page.getByTestId('wide-row-cleared').first();
    const cleared = async () => ((await storedTxns(page)) as { name: string; date: string; cleared?: true }[])
      .filter((t) => t.name === 'Paycheck').sort((a, b) => b.date.localeCompare(a.date))[0]!.cleared === true;
    expect(await cleared()).toBe(false);
    await first.click();
    await expect.poll(cleared).toBe(true);
    await first.click();
    await expect.poll(cleared).toBe(false);
  });

  test('a budget line opens its pane', async ({ page }) => {
    await withStore(page, wideLedger());
    await page.getByTestId('wide-line').filter({ hasText: 'Groceries' }).click();
    await expect(page.getByTestId('line-detail')).toBeVisible();
    await expect(page.getByTestId('line-name-input')).toHaveValue('Groceries');
    await expect(page.getByTestId('line-spending')).toContainText('Grocery');
    await page.getByTestId('line-cancel').click();
    await expect(page.getByTestId('line-detail')).toBeHidden();
  });
});

test.describe('1000x800: the pane opens over the main pane', () => {
  test.use({ viewport: { width: 1000, height: 800 } });
  test('backdrop and Esc close it', async ({ page }) => {
    await withStore(page, wideLedger());
    await page.getByTestId('wide-account-all').click();
    await page.getByTestId('wide-row').first().click();
    await expect(page.getByTestId('txn-detail')).toBeVisible();
    await page.getByTestId('wide-detail-backdrop').click({ position: { x: 20, y: 300 } });
    await expect(page.getByTestId('txn-detail')).toBeHidden();
    await page.getByTestId('wide-row').first().click();
    await expect(page.getByTestId('txn-detail')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('txn-detail')).toBeHidden();
    await noOverflow(page);
  });
});

test.describe('read-only (the phone\'s copy through CloudKit)', () => {
  test.describe('wide', () => {
    test.use({ viewport: { width: 1280, height: 820 } });
    test('no add or edit controls, a banner, and a text detail pane', async ({ page }) => {
      await asCopy(page, wideLedger());
      await page.goto('./');
      await expect(page.getByTestId('readonly-banner')).toBeVisible();
      await expect(page.getByTestId('readonly-banner')).toContainText('Read-only');
      await expect(page.getByTestId('readonly-banner')).toContainText('iPhone');
      await expect(page.getByTestId('readonly-reload')).toBeVisible();
      // Read-only never seeds: only the copy's three accounts, no default "Account".
      await page.getByTestId('wide-account-all').click();
      await expect(page.locator('[data-testid^="wide-account-"]')).toHaveCount(4);
      await expect(page.getByTestId('wide-sidebar')).not.toContainText(/^Account\b/m);
      const saved = await stored(page) as { accounts: { name: string }[]; categories: { name: string }[] };
      expect(saved.accounts.map((a) => a.name).sort()).toEqual(['Checking', 'Credit card', 'Savings']);
      expect(saved.categories.map((c) => c.name).sort()).toEqual(['Bills', 'Food', 'Housing', 'Savings']);
      await expect(page.getByTestId('wide-add-line')).toHaveCount(0);
      await page.getByTestId('wide-account-all').click();
      await expect(page.getByTestId('wide-row').first()).toBeVisible();
      await expect(page.getByTestId('quick-entry')).toHaveCount(0);
      await expect(page.getByTestId('wide-new')).toHaveCount(0);
      await expect(page.getByTestId('wide-row-cleared')).toHaveCount(0);
      await expect(page.getByTestId('wide-more-import')).toHaveCount(0);
      await page.getByTestId('wide-row').first().click();
      await expect(page.getByTestId('txn-detail-readonly')).toBeVisible();
      await expect(page.getByTestId('save-button')).toHaveCount(0);
      await expect(page.getByTestId('delete-button')).toHaveCount(0);
      await page.getByTestId('detail-close').click();
      await page.getByTestId('wide-nav-budget').click();
      await page.getByTestId('wide-line').first().click();
      await expect(page.getByTestId('line-detail-readonly')).toBeVisible();
      await expect(page.getByTestId('line-save')).toHaveCount(0);
    });
  });

  test.describe('phone width', () => {
    test.use({ viewport: { width: 420, height: 860 } });
    test('banner under the bar, no + and no pencil', async ({ page }) => {
      await asCopy(page, wideLedger());
      await page.goto('./');
      await expect(page.getByTestId('wide-frame')).toHaveCount(0);
      await expect(page.getByTestId('readonly-banner')).toBeVisible();
      await expect(page.getByTestId('add-button')).toHaveCount(0);
      await expect(page.getByTestId('budget-edit-toggle')).toHaveCount(0);
      await expect(page.getByTestId('undo-button')).toHaveCount(0);
      await page.getByTestId('tab-transactions').click();
      await expect(page.getByTestId('readonly-banner')).toBeVisible();
      await expect(page.getByTestId('edit-toggle')).toHaveCount(0);
      await expect(page.getByTestId('account-add-a-chk')).toHaveCount(0);
      // No selection circles, no pick bar, and Cleared is a plain tick, not a checkbox.
      await expect(page.getByTestId('txn-row').first()).toBeVisible();
      await expect(page.locator('[data-testid^="txn-pick-"]')).toHaveCount(0);
      await expect(page.getByTestId('picked-bar')).toHaveCount(0);
      await expect(page.getByText(/\d+ selected/)).toHaveCount(0);
      await expect(page.getByRole('checkbox')).toHaveCount(0);
      await expect(page.getByText('Account', { exact: true })).toHaveCount(0);
      await page.getByTestId('tab-budget').click();
      await expect(page.getByTestId('budget-title')).toBeVisible();
      await expect(page.locator('[data-testid^="line-pick-"]')).toHaveCount(0);
      await expect(page.getByText(/\d+ selected/)).toHaveCount(0);
      await expect(page.getByRole('checkbox')).toHaveCount(0);
    });
  });
});

test.describe('420 wide, editable: the phone layout is unchanged', () => {
  test.use({ viewport: { width: 420, height: 860 } });
  test('tab bar, + button and top bar, no wide frame', async ({ page }) => {
    await withStore(page, wideLedger());
    await expect(page.getByTestId('wide-frame')).toHaveCount(0);
    await expect(page.getByTestId('tab-budget')).toBeVisible();
    await expect(page.getByTestId('tab-transactions')).toBeVisible();
    await expect(page.getByTestId('add-button')).toBeVisible();
    await expect(page.getByTestId('readonly-banner')).toHaveCount(0);
    await expect(page.getByTestId('edit-toggle')).toBeVisible();
    await page.getByTestId('tab-budget').click();
    await expect(page.getByTestId('budget-edit-toggle')).toBeVisible();
    await page.getByTestId('add-button').click();
    await expect(page.getByTestId('save-button')).toBeVisible();
    await expect(page.getByTestId('name-input')).toBeVisible();
  });
});
