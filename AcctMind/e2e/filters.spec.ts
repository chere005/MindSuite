import { expect, test, type Page } from '@playwright/test';
import { storedTxns, thisMonthSet, withStore } from './helpers';

const month = thisMonthSet().slice(2);
const stamp = { order: 0, created: 1, updated: 1 };

async function openLedger(page: Page): Promise<void> {
  await withStore(page, JSON.stringify({
    v: 4,
    accounts: [
      { id: 'checking', name: 'Checking', color: '#4c8bf0', ...stamp },
      { id: 'savings', name: 'Savings', color: '#66d695', ...stamp },
    ],
    categories: [{ id: 'food', name: 'Food', color: '#66d695', ...stamp }],
    lines: [{ id: 'groceries', name: 'Groceries', category: 'food', ...stamp }],
    txns: [
      { id: 'a', name: 'Market', description: 'Co-op debit', date: `${month}-06`, amount: -5000,
        account: 'checking', category: 'groceries', cleared: true, ...stamp },
      { id: 'b', name: 'Co-op payment', date: `${month}-07`, amount: -2000,
        account: 'checking', category: null, ...stamp },
      { id: 'c', name: 'Market return', date: `${month}-08`, amount: 1000,
        account: 'checking', category: 'groceries', ...stamp },
      { id: 'd', name: 'Deposit', date: `${month}-09`, amount: 4000,
        account: 'savings', category: null, cleared: true, ...stamp },
    ],
    budgets: [],
  }));
}

test('search opens matching accounts and leaves their full balances and normal folds intact', async ({ page }) => {
  await openLedger(page);
  await page.getByTestId('account-head-checking').click();
  await expect(page.getByTestId('txn-name')).toHaveText(['Deposit']);

  await page.getByTestId('txn-search').fill('  CO-OP  ');
  await expect(page.getByTestId('txn-name')).toHaveText(['Co-op payment', 'Market']);
  await expect(page.getByTestId('account-total-checking')).toHaveText('-$60.00');
  await expect(page.getByTestId('account-cleared-checking')).toContainText('-$50.00');

  await page.getByTestId('txn-search-clear').click();
  await expect(page.getByTestId('txn-name')).toHaveText(['Deposit']);
});

test('category, dates, and cleared status combine with search', async ({ page }) => {
  await openLedger(page);
  await page.getByTestId('txn-search').fill('market');
  await page.getByTestId('txn-filters').click();
  await page.getByTestId('txn-filter-category').click();
  await page.getByTestId('category-opt-groceries').click();
  await page.getByTestId('txn-filter-status-cleared').click();
  await page.getByTestId('txn-filter-from').click();
  await page.getByTestId(`day-${month}-06`).click();
  await page.getByTestId('txn-filter-through').click();
  await page.getByTestId(`day-${month}-06`).click();
  await page.getByTestId('txn-filters-apply').click();
  await expect(page.getByTestId('txn-filters-title')).toBeHidden();
  await expect(page.getByTestId('txn-name')).toHaveText(['Market']);
  await expect(page.getByTestId('txn-filters')).toHaveText('Filters (3)');

  await page.getByTestId('txn-filters').click();
  await page.getByTestId('txn-filter-through').click();
  await page.getByTestId(`day-${month}-05`).click();
  await expect(page.getByTestId('txn-filters-apply')).toHaveAttribute('aria-disabled', 'true');
  await page.getByTestId('txn-filters-reset').click();
  await page.getByTestId('txn-filters-apply').click();
  await expect(page.getByTestId('txn-name')).toHaveText(['Market return', 'Market']);
});

test('deleting selected search results keeps the other transactions', async ({ page }) => {
  await openLedger(page);
  await page.getByTestId('picked-all').click();
  await expect(page.getByTestId('picked-count')).toContainText('4 selected');
  await page.getByTestId('txn-search').fill('Co-op debit');
  await expect(page.getByTestId('picked-count')).toHaveText('0 selected');
  await page.getByTestId('picked-all').click();
  await expect(page.getByTestId('picked-count')).toContainText('1 selected');
  await page.getByTestId('picked-delete').click();
  await page.getByTestId('picked-delete').click();
  await expect(page.getByTestId('empty-state')).toHaveText('No matching transactionsClear filters');
  const txns = await storedTxns(page) as { id: string; deleted?: true }[];
  expect(txns.filter((txn) => txn.deleted).map((txn) => txn.id)).toEqual(['a']);
  await page.getByTestId('txn-filters-clear').click();
  await expect(page.getByTestId('txn-name')).toHaveText(['Market return', 'Co-op payment', 'Deposit']);
});
