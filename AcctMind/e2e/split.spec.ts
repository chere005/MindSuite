/**
 * Splitting a transaction between categories — the owner, 2026-11-21: "add
 * splitting a transaction between multiple categories in a very trivial
 * interface to use".
 *
 * Split beside the category turns it into rows of [category][amount][×], the
 * LAST row's amount is the remainder (drawn, never typed), "+ Add category"
 * adds a row and removing down to one un-splits. The rules are core's
 * (test/split.test.ts, spec/split.json); this drives the screens that call
 * them, on the phone layout (both projects) and the wide one (Chromium), and
 * asserts on the STORE, not only on what is drawn.
 */
import { deflateRawSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { CK_FIELD, CK_RECORD_NAME } from '@acctmind/core';
import { setSign, stored, withStore } from './helpers';

const stamp = { created: 1, updated: 1 };
const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const ledger = (txns: unknown[] = []): string => JSON.stringify({
  v: 4,
  txns,
  accounts: [{ id: 'a1', name: 'Checking', color: '#4c8bf0', order: 0, ...stamp }],
  categories: [
    { id: 'c-food', name: 'Food', color: '#66d695', order: 0, ...stamp },
    { id: 'c-home', name: 'Home', color: '#4c8bf0', order: 1, ...stamp },
  ],
  lines: [
    { id: 'l-groc', name: 'Groceries', category: 'c-food', budget: 0, needs: 0, snoozed: false, order: 0, ...stamp },
    { id: 'l-fun', name: 'Fun', category: 'c-food', budget: 0, needs: 0, snoozed: false, order: 1, ...stamp },
    { id: 'l-house', name: 'Household', category: 'c-home', budget: 0, needs: 0, snoozed: false, order: 0, ...stamp },
  ],
  budgets: [],
});
/** A $100 shop, already split $60 groceries / $40 household. */
const splitShop = () => ({
  id: 'shop', name: 'Market', description: '', amount: -10000, date: today(), account: 'a1', category: null, order: 0,
  created: 5, updated: 5, splits: [{ category: 'l-groc', amount: -6000 }, { category: 'l-house', amount: -4000 }],
});

type Row = { id: string; name: string; amount: number; category: string | null; splits?: { category: string | null; amount: number }[] };
const txnNamed = async (page: Page, name: string): Promise<Row> =>
  ((await stored(page)) as { txns: Row[] }).txns.find((t) => t.name === name)!;
const parts = (t: Row) => t.splits?.map((p) => [p.category, p.amount]);

/** Click first, then fill: `fill()` alone can do nothing on WebKit in a Modal (TESTING.md). */
async function type(page: Page, id: string, text: string): Promise<void> {
  await page.getByTestId(id).click();
  await page.getByTestId(id).fill(text);
}

async function pick(page: Page, button: string, line: string): Promise<void> {
  await page.getByTestId(button).click();
  await page.getByTestId(`category-opt-${line}`).click();
  await expect(page.getByTestId('category-filter')).toBeHidden();
}

test.describe('phone', () => {
  test('split a new transaction, edit the split, then un-split it', async ({ page }) => {
    await withStore(page, ledger());
    await page.getByTestId('add-button').click();
    await type(page, 'name-input', 'Market');
    await type(page, 'amount-input', '10000');
    await setSign(page, true);
    await pick(page, 'category-button', 'l-groc');

    // Split: the category it had and the whole amount, then a row for the rest.
    await page.getByTestId('split-button').click();
    await expect(page.getByTestId('split-category-0-value')).toHaveText('Groceries');
    await expect(page.getByTestId('split-amount-0')).toHaveValue('$100.00');
    await expect(page.getByTestId('split-rest')).toHaveText('$0.00');
    // Nothing in the second row yet: said, not saved.
    await page.getByTestId('save-button').click();
    await expect(page.getByTestId('error-category')).toHaveText('Every category needs an amount');

    await type(page, 'split-amount-0', '6000');
    await expect(page.getByTestId('split-rest')).toHaveText('$40.00');
    await pick(page, 'split-category-1', 'l-house');
    await page.getByTestId('save-button').click();
    await expect(page.getByTestId('save-button')).toBeHidden();

    let t = await txnNamed(page, 'Market');
    expect([t.amount, t.category, parts(t)]).toEqual([-10000, null, [['l-groc', -6000], ['l-house', -4000]]]);
    const row = page.getByTestId('txn-row').filter({ hasText: 'Market' });
    await expect(row.getByTestId('txn-category')).toHaveText('Split · Groceries, Household');

    // Each line's Spent is its part.
    await page.getByTestId('tab-budget').click();
    await expect(page.getByTestId('line-spent-l-groc')).toHaveText('-$60.00');
    await expect(page.getByTestId('line-spent-l-house')).toHaveText('-$40.00');
    await page.getByTestId('tab-transactions').click();

    // A tap on the split's category opens the editor, rows and all.
    await row.getByTestId(`txn-category-tap-${t.id}`).click();
    await expect(page.getByTestId('split-rows')).toBeVisible();
    await expect(page.getByTestId('split-rest')).toHaveText('$40.00');
    // + Add category: the old remainder is written down, the new row is the rest.
    await page.getByTestId('split-add').click();
    await expect(page.getByTestId('split-amount-1')).toHaveValue('$40.00');
    await expect(page.getByTestId('split-rest')).toHaveText('$0.00');
    await type(page, 'split-amount-1', '2500');
    await expect(page.getByTestId('split-rest')).toHaveText('$15.00');
    await pick(page, 'split-category-2', 'l-fun');
    await page.getByTestId('save-button').click();
    await expect(page.getByTestId('save-button')).toBeHidden();
    t = await txnNamed(page, 'Market');
    expect(parts(t)).toEqual([['l-groc', -6000], ['l-house', -2500], ['l-fun', -1500]]);

    // Removing down to one row is no split at all.
    await row.getByTestId(`txn-category-tap-${t.id}`).click();
    await page.getByTestId('split-remove-2').click();
    await expect(page.getByTestId('split-rest')).toHaveText('$40.00');
    await page.getByTestId('split-remove-0').click();
    await expect(page.getByTestId('split-rows')).toBeHidden();
    await expect(page.getByTestId('category-value')).toHaveText('Household');
    await page.getByTestId('save-button').click();
    await expect(page.getByTestId('save-button')).toBeHidden();
    t = await txnNamed(page, 'Market');
    expect(t.category).toBe('l-house');
    expect('splits' in t).toBe(false);
    await expect(row.getByTestId('txn-category')).toHaveText('Household');
  });
});

/** A stand-in CloudKit, signed in and holding `ledger` — wide.spec.ts's, cut to what read-only needs. */
async function asCopy(page: Page, raw: string): Promise<void> {
  const record = deflateRawSync(Buffer.from(raw, 'utf8')).toString('base64');
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
              return { hasErrors: false, errors: [], records: [{ fields: { [field]: { value: record } }, modified: { timestamp: Date.now() } }] };
            },
          },
        };
      },
    };
  }, { record, name: CK_RECORD_NAME, field: CK_FIELD });
}

test.describe('wide', () => {
  test.beforeEach(({ browserName }) => { test.skip(browserName !== 'chromium'); });
  test.use({ viewport: { width: 1200, height: 800 } });

  test('the table says Split; the detail pane edits the parts and the total moves only the last', async ({ page }) => {
    await withStore(page, ledger([splitShop()]));
    await page.getByTestId('wide-nav-transactions').click();
    const row = page.getByTestId('wide-row').filter({ hasText: 'Market' });
    await expect(row.getByTestId('wide-row-category')).toHaveText('Split · Groceries, Household');

    await row.click();
    await expect(page.getByTestId('txn-detail')).toBeVisible();
    await expect(page.getByTestId('split-amount-0')).toHaveValue('$60.00');
    await expect(page.getByTestId('split-rest')).toHaveText('$40.00');
    // A bigger total: the remainder takes it.
    await page.getByTestId('amount-input').fill('12000');
    await expect(page.getByTestId('split-rest')).toHaveText('$60.00');
    await page.getByTestId('save-button').click();
    await expect(page.getByTestId('txn-detail')).toBeHidden();
    expect(parts(await txnNamed(page, 'Market'))).toEqual([['l-groc', -6000], ['l-house', -6000]]);

    // Typing more than the whole turns the remainder red and is refused.
    await row.click();
    await page.getByTestId('split-amount-0').fill('13000');
    await expect(page.getByTestId('split-rest')).toHaveText('-$10.00');
    await page.getByTestId('save-button').click();
    await expect(page.getByTestId('error-category')).toHaveText('The other categories come to more than the amount');
    await page.getByTestId('cancel-button').click();

    // A new one, split in the pane.
    await page.getByTestId('wide-new').click();
    await page.getByTestId('name-input').fill('Pharmacy');
    await page.getByTestId('amount-input').fill('3000');
    await page.getByTestId('split-button').click();
    await page.getByTestId('split-amount-0').fill('1000');
    await pick(page, 'split-category-0', 'l-house');
    await pick(page, 'split-category-1', 'l-fun');
    await expect(page.getByTestId('split-rest')).toHaveText('$20.00');
    await page.getByTestId('save-button').click();
    await expect(page.getByTestId('txn-detail')).toBeHidden();
    const p = await txnNamed(page, 'Pharmacy');
    expect([p.category, parts(p)]).toEqual([null, [['l-house', -1000], ['l-fun', -2000]]]);
  });

  test('read-only shows the split and offers nothing to change it', async ({ page }) => {
    await asCopy(page, ledger([splitShop()]));
    await page.goto('./');
    await expect(page.getByTestId('readonly-banner')).toBeVisible();
    await page.getByTestId('wide-nav-transactions').click();
    const row = page.getByTestId('wide-row').filter({ hasText: 'Market' });
    await expect(row.getByTestId('wide-row-category')).toHaveText('Split · Groceries, Household');
    await row.click();
    const detail = page.getByTestId('txn-detail-readonly');
    await expect(detail).toContainText('Groceries  -$60.00');
    await expect(detail).toContainText('Household  -$40.00');
    const pane = page.getByTestId('wide-detail');
    await expect(pane.getByTestId('split-button')).toHaveCount(0);
    await expect(pane.getByTestId('split-rows')).toHaveCount(0);
    await expect(pane.getByTestId('save-button')).toHaveCount(0);
  });
});
