/**
 * Reports: spec/reports.json replayed, then the rules it rests on one at a
 * time — transfers, refunds, No Category, empty months, year ends, and the
 * local calendar the suite's TZ pin (America/Chicago) puts under `today()`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  categoryFilterLabel, categoryOptions, incomeExpense, liveAccountFilter, liveCategoryFilter, monthsIn, niceAxis, niceScale, NO_CATEGORY, NO_CATEGORY_NAME,
  periodLabel, periodRange, rangeLabel, reportRows, reportYears, shareLabel, shortAmount, spendingBreakdown,
  spendingTrend, today, toggleReportAccount, transferIds, INCOME,
  type Account, type Category, type CategoryFilter, type Line, type ReportPeriod, type ReportScope, type Txn,
} from '../src/index';

const rec = { created: 1, updated: 1 };

type SpecTxn = [string, string, number, string, string, string | null, boolean?];
type Case = {
  from: string; to: string; accounts: string[] | null;
  months: [string, number, number, number][];
  total: [number, number, number];
  breakdownTotal: number;
  groups: [string, number, number | null][];
};
type Spec = {
  periods: [ReportPeriod, string, string, string][];
  short: [number, string][];
  scale: [number, number, number, number][];
  ledger: {
    accounts: (Omit<Account, 'created' | 'updated'>)[];
    categories: (Omit<Category, 'created' | 'updated'>)[];
    lines: { id: string; name: string; category: string; order: number; deleted?: true }[];
    txns: SpecTxn[];
  };
  cases: Case[];
};
const spec = JSON.parse(readFileSync(new URL('../../../spec/reports.json', import.meta.url), 'utf8')) as Spec;

const specLedger = () => ({
  accounts: spec.ledger.accounts.map((a) => ({ ...a, ...rec })),
  categories: spec.ledger.categories.map((c) => ({ ...c, ...rec })),
  lines: spec.ledger.lines.map((l): Line => ({ budget: 0, needs: 0, snoozed: false, ...l, ...rec })),
  txns: spec.ledger.txns.map(([id, name, amount, date, account, category, deleted]): Txn => ({
    id, name, description: '', amount, date, account, category, order: 0, ...rec, ...(deleted ? { deleted: true as const } : {}),
  })),
});

describe('spec/reports.json', () => {
  it('periods are whole months on the calendar of the day given', () => {
    for (const [period, day, from, to] of spec.periods) {
      expect(periodRange(period, day), `${period} on ${day}`).toEqual({ from, to });
    }
  });
  it('axis labels', () => {
    for (const [cents, label] of spec.short) expect(shortAmount(cents), String(cents)).toBe(label);
  });
  it('an axis holds zero, the top and a month below the line', () => {
    expect(niceAxis(0, 0)).toEqual({ top: 0, bottom: 0, step: 0 });
    expect(niceAxis(0, 100000)).toEqual({ top: 100000, bottom: 0, step: 25000 });
    expect(niceAxis(-30000, 90000)).toEqual({ top: 100000, bottom: -50000, step: 50000 });
    expect(niceAxis(-4000, -1000)).toEqual({ top: 0, bottom: -4000, step: 1000 });
  });
  it('axis scales', () => {
    for (const [max, ticks, top, step] of spec.scale) expect(niceScale(max, ticks), String(max)).toEqual({ top, step });
  });
  for (const c of spec.cases) {
    it(`income vs expense and breakdown — accounts ${c.accounts?.join(',') ?? 'all'}`, () => {
      const ledger = specLedger();
      const rows = reportRows(ledger);
      const scope: ReportScope = { range: { from: c.from, to: c.to }, accounts: c.accounts, category: null };
      const flow = incomeExpense(rows, scope);
      expect(flow.months.map((m) => [m.key, m.income, m.spending, m.net])).toEqual(c.months);
      expect([flow.total.income, flow.total.spending, flow.total.net]).toEqual(c.total);
      const b = spendingBreakdown(rows, scope, ledger);
      expect(b.total).toBe(c.breakdownTotal);
      expect(b.groups.map((g) => [g.id, g.amount, g.share])).toEqual(c.groups);
    });
  }
});

/* ---------------- small builders ---------------- */

const acct = (id: string, order = 0, deleted = false): Account =>
  ({ id, name: id, color: '#4c8bf0', order, ...rec, ...(deleted ? { deleted: true as const } : {}) });
const cat = (id: string, order = 0): Category => ({ id, name: id.toUpperCase(), color: '#66d695', order, ...rec });
const line = (id: string, category: string, order = 0): Line =>
  ({ id, name: id, category, budget: 0, needs: 0, snoozed: false, order, ...rec });
let n = 0;
const t = (amount: number, date: string, account: string, category: string | null, name = `t${++n}`): Txn =>
  ({ id: `id-${++n}`, name, description: '', amount, date, account, category, order: 0, ...rec });

const base = () => ({
  accounts: [acct('chk'), acct('sav', 1), acct('card', 2)],
  categories: [cat('food'), cat('home', 1)],
  lines: [line('groc', 'food'), line('dine', 'food', 1), line('rent', 'home')],
});
const all = (from: string, to: string, category: CategoryFilter = null, accounts: string[] | null = null): ReportScope =>
  ({ range: { from, to }, accounts, category });

describe('transfers', () => {
  it('an unfiled out and in, in two accounts, within four days, are a pair', () => {
    const out = t(-50000, '2026-01-31', 'chk', null);
    const inn = t(50000, '2026-02-04', 'sav', null);
    expect(transferIds([out, inn], base().accounts)).toEqual(new Set([out.id, inn.id]));
  });

  it('five days apart, the same account, or a filed half is not a transfer', () => {
    const accounts = base().accounts;
    expect(transferIds([t(-100, '2026-01-01', 'chk', null), t(100, '2026-01-06', 'sav', null)], accounts).size).toBe(0);
    expect(transferIds([t(-100, '2026-01-01', 'chk', null), t(100, '2026-01-01', 'chk', null)], accounts).size).toBe(0);
    expect(transferIds([t(-100, '2026-01-01', 'chk', 'groc'), t(100, '2026-01-01', 'sav', null)], accounts).size).toBe(0);
    expect(transferIds([t(-100, '2026-01-01', 'chk', null), t(100, '2026-01-01', 'sav', INCOME)], accounts).size).toBe(0);
    // A Reconcile is an adjustment, never half of anything.
    expect(transferIds([t(-100, '2026-01-01', 'chk', null, 'Reconcile'), t(100, '2026-01-01', 'sav', null)], accounts).size).toBe(0);
  });

  it('an outflow takes the NEAREST inflow, and each row pairs once', () => {
    const out = t(-2000, '2026-03-10', 'chk', null);
    const far = t(2000, '2026-03-13', 'sav', null);
    const near = t(2000, '2026-03-11', 'card', null);
    const pairs = transferIds([out, far, near], base().accounts);
    expect(pairs).toEqual(new Set([out.id, near.id]));
  });

  it('a pair counts in no month and for no account, even across a month end', () => {
    const ledger = { ...base(), txns: [t(-50000, '2026-01-31', 'chk', null), t(50000, '2026-02-02', 'sav', null)] };
    const rows = reportRows(ledger);
    expect(rows).toEqual([]);
    const flow = incomeExpense(rows, all('2026-01', '2026-02', null, ['chk']));
    expect(flow.total).toEqual({ key: 'total', income: 0, spending: 0, net: 0 });
  });

  it('without a partner, an unfiled move is No Category — out is spending, in takes it back', () => {
    const ledger = { ...base(), txns: [t(-2222, '2025-12-28', 'chk', null), t(2222, '2026-01-09', 'sav', null)] };
    const trend = spendingTrend(reportRows(ledger), all('2025-12', '2026-01'), ledger);
    expect(trend.months.map((m) => m.total)).toEqual([2222, -2222]);
    expect(trend.total).toBe(0);
  });
});

describe('what a row counts as', () => {
  it('a refund on a line takes that line, and its group, down', () => {
    const ledger = { ...base(), txns: [t(-10000, '2026-05-02', 'card', 'groc'), t(2500, '2026-05-09', 'card', 'groc'), t(-4000, '2026-05-10', 'card', 'dine')] };
    const b = spendingBreakdown(reportRows(ledger), all('2026-05', '2026-05'), ledger);
    expect(b.total).toBe(11500);
    expect(b.groups[0]!.lines.map((l) => [l.id, l.amount, l.share])).toEqual([['groc', 7500, 65], ['dine', 4000, 35]]);
  });

  it('a group refunds outran sorts last with no share', () => {
    const ledger = { ...base(), txns: [t(-1000, '2026-05-02', 'chk', 'rent'), t(3000, '2026-05-03', 'card', 'groc')] };
    const b = spendingBreakdown(reportRows(ledger), all('2026-05', '2026-05'), ledger);
    expect(b.groups.map((g) => [g.id, g.amount, g.share])).toEqual([['home', 1000, 100], ['food', -3000, null]]);
    expect(b.total).toBe(-2000);
  });

  it('unfiled, on a deleted line, or in a deleted group is No Category; an unfiled Reconcile is nothing', () => {
    const ledger = base();
    ledger.lines.push({ ...line('gone', 'food'), deleted: true }, line('orphan', 'nogroup'));
    const txns = [
      t(-300, '2026-05-01', 'card', null), t(-200, '2026-05-02', 'card', 'gone'), t(-100, '2026-05-03', 'card', 'orphan'),
      t(-999, '2026-05-04', 'chk', null, 'Reconcile'), t(-50, '2026-05-05', 'chk', 'dine', 'Reconcile'),
    ];
    const rows = reportRows({ ...ledger, txns });
    const b = spendingBreakdown(rows, all('2026-05', '2026-05'), ledger);
    expect(b.groups.map((g) => [g.id, g.name, g.amount, g.lines.length])).toEqual([
      [NO_CATEGORY, NO_CATEGORY_NAME, 600, 0], ['food', 'FOOD', 50, 1],
    ]);
  });

  it('tombstones and closed accounts are not there', () => {
    const ledger = base();
    ledger.accounts.push(acct('closed', 9, true));
    const txns = [{ ...t(-500, '2026-05-01', 'card', 'groc'), deleted: true as const }, t(-700, '2026-05-01', 'closed', 'groc')];
    expect(reportRows({ ...ledger, txns })).toEqual([]);
  });

  it('income filed back out reduces income; income is never spending', () => {
    const ledger = { ...base(), txns: [t(300000, '2026-05-01', 'chk', INCOME), t(-500, '2026-05-20', 'chk', INCOME)] };
    const rows = reportRows(ledger);
    expect(incomeExpense(rows, all('2026-05', '2026-05')).total).toEqual({ key: 'total', income: 299500, spending: 0, net: 299500 });
    expect(spendingBreakdown(rows, all('2026-05', '2026-05'), ledger).groups).toEqual([]);
  });
});

describe('months and years', () => {
  it('every month in the range is there, an empty one as zero', () => {
    const ledger = { ...base(), txns: [t(-1000, '2026-03-15', 'card', 'groc'), t(5000, '2026-07-01', 'chk', INCOME)] };
    const rows = reportRows(ledger);
    const range = periodRange('last-12', '2026-11-21');
    expect(range).toEqual({ from: '2025-12', to: '2026-11' });
    const trend = spendingTrend(rows, { range, accounts: null, category: null }, ledger);
    expect(trend.months).toHaveLength(12);
    expect(trend.months.filter((m) => m.total !== 0).map((m) => m.month)).toEqual(['2026-03']);
    expect(trend.months[0]).toEqual({ month: '2025-12', total: 0, groups: [] });
    expect(trend.average).toBe(83);   // 1000 / 12, rounded to the cent
    const flow = incomeExpense(rows, { range, accounts: null });
    expect(flow.months).toHaveLength(12);
    expect(flow.months.find((m) => m.key === '2026-05')).toEqual({ key: '2026-05', income: 0, spending: 0, net: 0 });
  });

  it('Dec 31 and Jan 1 land in their own years, and the year view sums each', () => {
    const ledger = { ...base(), txns: [
      t(-1000, '2025-12-31', 'card', 'groc'), t(-2000, '2026-01-01', 'card', 'groc'),
      t(10000, '2025-12-31', 'chk', INCOME), t(20000, '2026-01-01', 'chk', INCOME),
    ] };
    const flow = incomeExpense(reportRows(ledger), all('2025-03', '2026-02'));
    expect(flow.years).toEqual([
      { key: '2025', income: 10000, spending: 1000, net: 9000 },
      { key: '2026', income: 20000, spending: 2000, net: 18000 },
    ]);
    expect(flow.months.find((m) => m.key === '2025-12')?.spending).toBe(1000);
    expect(flow.months.find((m) => m.key === '2026-01')?.spending).toBe(2000);
  });

  it('"today" is the LOCAL day: 03:00 UTC on Jan 1 is still Dec 31 in Chicago', () => {
    const day = today(new Date('2026-01-01T03:00:00Z'));
    expect(day).toBe('2025-12-31');
    expect(periodRange('this-month', day)).toEqual({ from: '2025-12', to: '2025-12' });
    expect(periodRange('ytd', day)).toEqual({ from: '2025-01', to: '2025-12' });
    expect(periodRange('last-month', day)).toEqual({ from: '2025-11', to: '2025-11' });
  });

  it('All time runs from the first counted month to now, or to a later-dated row', () => {
    const ledger = { ...base(), txns: [t(-100, '2024-02-10', 'card', 'groc'), t(-100, '2027-01-02', 'card', 'groc')] };
    const rows = reportRows(ledger);
    expect(periodRange('all', '2026-11-21', rows)).toEqual({ from: '2024-02', to: '2027-01' });
    expect(periodRange('all', '2026-11-21', [])).toEqual({ from: '2026-11', to: '2026-11' });
    expect(monthsIn({ from: '2025-11', to: '2026-02' })).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(reportYears(rows, '2026-11-21')).toEqual([2027, 2026, 2024]);
  });

  it('labels', () => {
    expect(rangeLabel({ from: '2026-11', to: '2026-11' })).toBe('November 2026');
    expect(rangeLabel({ from: '2026-01', to: '2026-11' })).toBe('Jan – Nov 2026');
    expect(rangeLabel({ from: '2025-12', to: '2026-11' })).toBe('Dec 2025 – Nov 2026');
    expect(periodLabel('year:2025', { from: '2025-01', to: '2025-12' })).toBe('2025');
    expect(shareLabel(null)).toBe('');
    expect(shareLabel(0)).toBe('<1%');
    expect(shareLabel(42)).toBe('42%');
  });
});

describe('filters', () => {
  const ledger = { ...base(), txns: [
    t(-1000, '2026-05-01', 'card', 'groc'), t(-2000, '2026-05-02', 'card', 'dine'),
    t(-30000, '2026-05-03', 'chk', 'rent'), t(-400, '2026-05-04', 'card', null), t(90000, '2026-05-05', 'chk', INCOME),
  ] };
  const rows = reportRows(ledger);
  const may = (category: CategoryFilter) => all('2026-05', '2026-05', category);

  it('a group, a line, or No Category narrows spending', () => {
    expect(spendingTrend(rows, may({ group: 'food' }), ledger).total).toBe(3000);
    expect(spendingTrend(rows, may({ line: 'dine' }), ledger).total).toBe(2000);
    expect(spendingTrend(rows, may({ line: NO_CATEGORY }), ledger).total).toBe(400);
    const b = spendingBreakdown(rows, may({ group: 'food' }), ledger);
    expect(b.groups.map((g) => g.id)).toEqual(['food']);
  });

  it('income vs expense ignores the category filter and keeps the account one', () => {
    expect(incomeExpense(rows, may({ group: 'food' })).total).toEqual({ key: 'total', income: 90000, spending: 33400, net: 56600 });
    expect(incomeExpense(rows, all('2026-05', '2026-05', null, ['card'])).total)
      .toEqual({ key: 'total', income: 0, spending: 3400, net: -3400 });
  });

  it('trend months carry each group in ledger order, No Category last', () => {
    const trend = spendingTrend(rows, may(null), ledger);
    expect(trend.months[0]!.groups).toEqual([
      { id: 'food', amount: 3000 }, { id: 'home', amount: 30000 }, { id: NO_CATEGORY, amount: 400 },
    ]);
  });

  it('the category picker lists groups with their lines, then No Category', () => {
    expect(categoryOptions(ledger).map((o) => [o.label, o.depth])).toEqual([
      ['All categories', 0], ['FOOD', 0], ['groc', 1], ['dine', 1], ['HOME', 0], ['rent', 1], [NO_CATEGORY_NAME, 0],
    ]);
    expect(categoryFilterLabel({ line: 'dine' }, ledger)).toBe('dine');
    expect(categoryFilterLabel({ group: 'deleted' }, ledger)).toBe('All categories');
  });

  it('a filter naming a deleted group or line falls back to All', () => {
    expect(liveCategoryFilter({ group: 'food' }, ledger)).toEqual({ group: 'food' });
    expect(liveCategoryFilter({ line: NO_CATEGORY }, ledger)).toEqual({ line: NO_CATEGORY });
    expect(liveCategoryFilter({ line: 'gone' }, ledger)).toBeNull();
  });

  it('account chips: one from all narrows, the last off or every one on is all again', () => {
    const ids = ['chk', 'sav', 'card'];
    expect(toggleReportAccount(null, 'sav', ids)).toEqual(['sav']);
    expect(toggleReportAccount(['sav'], 'chk', ids)).toEqual(['chk', 'sav']);
    expect(toggleReportAccount(['sav'], 'sav', ids)).toBeNull();
    expect(toggleReportAccount(['chk', 'sav'], 'card', ids)).toBeNull();
    expect(toggleReportAccount(null, 'chk', ['chk'])).toBeNull();
  });

  it('a picked account that has been deleted drops out of the pick', () => {
    expect(liveAccountFilter(['sav', 'closed'], ['chk', 'sav'])).toEqual(['sav']);
    expect(liveAccountFilter(['closed'], ['chk', 'sav'])).toBeNull();
    expect(liveAccountFilter(null, ['chk'])).toBeNull();
  });
});
