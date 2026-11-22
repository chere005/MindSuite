/**
 * Reports read every per-category amount through `txnParts`, so a split
 * transaction lands in each of its categories the day splits exist.
 *
 * `txnParts` returns one part today; this suite stands one in that splits a
 * marked row, which is the only way to prove the reports never read
 * `t.category` behind its back.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/txn', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/txn')>();
  return {
    ...real,
    txnParts: (t: import('../src/types').Txn) => t.description === 'split'
      // $100 out: $60 groceries, $40 dining.
      ? [{ category: 'groc', amount: -6000 }, { category: 'dine', amount: -4000 }]
      : t.description === 'split-unfiled'
        // Half filed, half not: never half of a transfer.
        ? [{ category: null, amount: -2500 }, { category: 'groc', amount: -2500 }]
        : t.description === 'split-income'
          // A paycheck with $50 kept back as a refund on groceries.
          ? [{ category: 'income', amount: 95000 }, { category: 'groc', amount: 5000 }]
          : real.txnParts(t),
  };
});

const { incomeExpense, reportRows, spendingBreakdown, transferIds, NO_CATEGORY } = await import('../src/index');
type Txn = import('../src/types').Txn;

const rec = { created: 1, updated: 1 };
const ledger = (txns: Txn[]) => ({
  accounts: [{ id: 'chk', name: 'chk', color: '#fff', order: 0, ...rec }, { id: 'sav', name: 'sav', color: '#fff', order: 1, ...rec }],
  categories: [{ id: 'food', name: 'Food', color: '#66d695', order: 0, ...rec }],
  lines: ['groc', 'dine'].map((id, i) => ({ id, name: id, category: 'food', budget: 0, needs: 0, snoozed: false, order: i, ...rec })),
  txns,
});
const t = (id: string, amount: number, account: string, category: string | null, description = ''): Txn =>
  ({ id, name: id, description, amount, date: '2026-06-10', account, category, order: 0, ...rec });
const june = { range: { from: '2026-06', to: '2026-06' }, accounts: null, category: null };

describe('split transactions', () => {
  it('each part lands on its own line', () => {
    const l = ledger([t('s', -10000, 'chk', null, 'split')]);
    const b = spendingBreakdown(reportRows(l), june, l);
    expect(b.total).toBe(10000);
    expect(b.groups[0]!.lines.map((x) => [x.id, x.amount])).toEqual([['groc', 6000], ['dine', 4000]]);
  });

  it('an income part is income and the rest is spending, in the same month', () => {
    const l = ledger([t('p', 100000, 'chk', null, 'split-income')]);
    expect(incomeExpense(reportRows(l), june).total).toEqual({ key: 'total', income: 95000, spending: -5000, net: 100000 });
  });

  it('a row with any filed part is never half of a transfer', () => {
    const l = ledger([t('a', -5000, 'chk', null, 'split-unfiled'), t('b', 5000, 'sav', null)]);
    expect(transferIds(l.txns, l.accounts).size).toBe(0);
    const b = spendingBreakdown(reportRows(l), june, l);
    expect(b.groups.map((g) => [g.id, g.amount])).toEqual([['food', 2500], [NO_CATEGORY, -2500]]);
  });
});
