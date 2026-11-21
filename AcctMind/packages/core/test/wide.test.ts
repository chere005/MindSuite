import { describe, expect, it } from 'vitest';
import {
  accountBalances, budgetSheet, ledgerAccess, ledgerTable, isLocalHost, parseDayInput, quickAmount, quickCategory,
  quickDraft, syncLine, readOnlyMessage, formatWritten, EMPTY_TXN_FILTER, monthSet,
  type Account, type Category, type Line, type Txn,
} from '../src/index';

const t = (id: string, date: string, amount: number, account = 'a1', extra: Partial<Txn> = {}): Txn => ({
  id, name: id, description: '', amount, date, account, category: null, order: 0, created: 1, updated: 1, ...extra,
});
const acct = (id: string, order = 0): Account => ({ id, name: id, color: '#fff', order, created: 1, updated: 1 });

describe('ledgerAccess', () => {
  const base = { native: false, tauri: false, cloudKit: 'ready' as const, signedIn: false, localHost: false };
  it('native and Tauri are editable files', () => {
    expect(ledgerAccess({ ...base, tauri: true })).toEqual({ source: 'file', readOnly: false });
    expect(ledgerAccess({ ...base, native: true, signedIn: true })).toEqual({ source: 'file', readOnly: false });
  });
  it('a signed-in browser reads the copy, read-only, on any host', () => {
    expect(ledgerAccess({ ...base, signedIn: true, localHost: true }).readOnly).toBe(true);
  });
  it('a signed-out browser on a real host is read-only, pending included', () => {
    expect(ledgerAccess(base).readOnly).toBe(true);
    expect(ledgerAccess({ ...base, cloudKit: 'pending' }).readOnly).toBe(true);
  });
  it('a browser with no usable CloudKit keeps its own local ledger', () => {
    expect(ledgerAccess({ ...base, cloudKit: 'off' })).toEqual({ source: 'local', readOnly: false });
    expect(ledgerAccess({ ...base, localHost: true })).toEqual({ source: 'local', readOnly: false });
  });
  it('knows local hosts', () => {
    expect(isLocalHost('127.0.0.1')).toBe(true);
    expect(isLocalHost('seancheren.com')).toBe(false);
  });
});

describe('sync lines', () => {
  const now = new Date(2026, 10, 21, 12, 0).getTime();
  it('formats the file times and the copy', () => {
    const read = new Date(2026, 10, 21, 9, 40).getTime();
    expect(syncLine({ source: 'file', readAt: read, savedAt: read + 120000, writtenAt: null, signedIn: false }, now))
      .toBe('iCloud Drive · read 9:40 AM · saved 9:42 AM');
    expect(syncLine({ source: 'file', readAt: null, savedAt: null, writtenAt: null, signedIn: false }, now))
      .toBe('iCloud Drive · not read yet');
    expect(syncLine({ source: 'copy', readAt: read, savedAt: null, writtenAt: read, signedIn: true }, now))
      .toBe('iPhone copy · written today at 9:40 AM');
    expect(formatWritten(new Date(2026, 10, 9, 14, 5).getTime(), now)).toBe('Nov 9 at 2:05 PM');
  });
  it('banner says sign in when signed out', () => {
    expect(readOnlyMessage({ source: 'copy', readAt: null, savedAt: null, writtenAt: null, signedIn: false }, now))
      .toContain('Sign in with your Apple ID');
  });
});

describe('ledgerTable', () => {
  const rows = [t('rent', '2026-11-21', -185000), t('pay', '2026-11-17', 312500), t('open', '2026-11-01', 100000),
    t('other', '2026-11-20', -500, 'a2')];
  it('shows a running balance for one account only', () => {
    const one = ledgerTable(rows, 'a1');
    expect(one.rows.map((r) => [r.txn.id, r.balance])).toEqual([['rent', 227500], ['pay', 412500], ['open', 100000]]);
    expect(one.foot).toEqual({ count: 3, moneyIn: 412500, moneyOut: -185000, net: 227500 });
    expect(ledgerTable(rows, null).rows.every((r) => r.balance === null)).toBe(true);
    expect(ledgerTable(rows, null).foot.count).toBe(4);
  });
  it('a filter narrows rows and foot but not the balances', () => {
    const f = ledgerTable(rows, 'a1', { ...EMPTY_TXN_FILTER, query: 'pay' });
    expect(f.rows.map((r) => r.balance)).toEqual([412500]);
    expect(f.foot.net).toBe(312500);
  });
  it('skips deleted rows', () => {
    expect(ledgerTable([...rows, t('gone', '2026-11-22', 5, 'a1', { deleted: true })], 'a1').rows).toHaveLength(3);
  });
  it('totals accounts', () => {
    const b = accountBalances([acct('a1'), acct('a2')], rows);
    expect(b.rows.map((r) => r.balance)).toEqual([227500, -500]);
    expect(b.all).toBe(227000);
  });
});

describe('quick entry', () => {
  it('parses days', () => {
    expect(parseDayInput('', '2026-11-21')).toBe('2026-11-21');
    expect(parseDayInput('Nov 5', '2026-11-21')).toBe('2026-11-05');
    expect(parseDayInput('11/5', '2026-11-21')).toBe('2026-11-05');
    expect(parseDayInput('11/5/25', '2026-11-21')).toBe('2025-11-05');
    expect(parseDayInput('2/30', '2026-11-21')).toBeNull();
    expect(parseDayInput('soon', '2026-11-21')).toBeNull();
  });
  it('reads unsigned money as an expense and + as income', () => {
    expect(quickAmount('4.50')).toBe('-4.50');
    expect(quickAmount('-4.50')).toBe('-4.50');
    expect(quickAmount('+3125')).toBe('3125.00');
    expect(quickAmount('--4')).toBeNull();
    expect(quickAmount('abc')).toBeNull();
  });
  const choices = [{ id: 'l1', name: 'Groceries', category: 'c' }, { id: 'l2', name: 'Dining', category: 'c' }];
  it('matches categories by name', () => {
    expect(quickCategory('', choices)).toBeUndefined();
    expect(quickCategory('dining', choices)).toBe('l2');
    expect(quickCategory('groc', choices)).toBe('l1');
    expect(quickCategory('zzz', choices)).toBeNull();
  });
  it('builds a validated draft', () => {
    const ok = quickDraft({ date: 'Nov 5', name: ' Coffee ', category: 'din', amount: '6.75' },
      { account: 'a1', choices, rules: [], today: '2026-11-21' });
    expect(ok.errors).toEqual({});
    expect(ok.draft).toMatchObject({ date: '2026-11-05', amount: '-6.75', category: 'l2', account: 'a1' });
    const bad = quickDraft({ date: 'x', name: '', category: '', amount: 'q' },
      { account: 'a1', choices, rules: [], today: '2026-11-21' });
    expect(Object.keys(bad.errors).sort()).toEqual(['amount', 'date', 'name']);
  });
});

describe('budgetSheet', () => {
  const cat: Category = { id: 'c1', name: 'Food', color: '#fff', order: 0, created: 1, updated: 1 };
  const line = (id: string, needs: number): Line => ({
    id, name: id, category: 'c1', budget: 0, needs, snoozed: false, order: 1, created: 1, updated: 1,
  });
  const set = monthSet('2026-11');
  const store = {
    txns: [t('in', '2026-11-02', 100000, 'a1', { category: 'income' }), t('g', '2026-11-03', -4000, 'a1', { category: 'g' })],
    categories: [cat], lines: [line('g', 6000), line('d', 8000)],
    budgets: [{ id: `${set}|g`, set, line: 'g', amount: 5000, created: 1, updated: 1 }],
  };
  it('totals unassigned, overspent and short of target', () => {
    const s = budgetSheet(store, '2026-11', null);
    expect(s.unassigned).toBe(95000);
    const g = s.groups[0]!.lines.find((l) => l.line.id === 'g')!;
    expect(g).toMatchObject({ allocated: 5000, spent: -4000, remaining: 1000, tone: 'short' });
    expect(s.short).toBe(1000 + 8000);
    expect(s.overspent).toBe(0);
    expect(s.spending('g').map((x) => x.id)).toEqual(['g']);
  });
});
