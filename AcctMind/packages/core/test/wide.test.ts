import { describe, expect, it } from 'vitest';
import {
  accountBalances, budgetSheet, ledgerAccess, ledgerTable, isLocalHost, parseDayInput, quickAmount, quickCategory,
  quickDraft, syncLine, readOnlyBanner, formatWritten, EMPTY_TXN_FILTER, monthSet,
  type Account, type Category, type Line, type Txn,
} from '../src/index';

const t = (id: string, date: string, amount: number, account = 'a1', extra: Partial<Txn> = {}): Txn => ({
  id, name: id, description: '', amount, date, account, category: null, order: 0, created: 1, updated: 1, ...extra,
});
const acct = (id: string, order = 0): Account => ({ id, name: id, color: '#fff', order, created: 1, updated: 1 });

describe('ledgerAccess', () => {
  const base = { native: false, tauri: false, signedIn: false, localHost: false };
  it('native and Tauri are editable files', () => {
    expect(ledgerAccess({ ...base, tauri: true })).toEqual({ source: 'file', readOnly: false });
    expect(ledgerAccess({ ...base, native: true, signedIn: true })).toEqual({ source: 'file', readOnly: false });
  });
  it('a signed-in browser reads the copy, read-only, on any host', () => {
    expect(ledgerAccess({ ...base, signedIn: true, localHost: true })).toEqual({ source: 'copy', readOnly: true });
  });
  it('a browser on a real host is ALWAYS read-only, whatever CloudKit does', () => {
    expect(ledgerAccess(base)).toEqual({ source: 'copy', readOnly: true });
    expect(ledgerAccess({ ...base, signedIn: true }).readOnly).toBe(true);
  });
  it('an unsigned browser on a development host keeps its own local ledger', () => {
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
  const copy = { source: 'copy' as const, readAt: null, savedAt: null, writtenAt: null, signedIn: false };
  it('banner: sign in, connecting, normal', () => {
    expect(readOnlyBanner({ ...copy, engine: 'ready' }, now)).toMatchObject({ action: 'signin', tone: 'info' });
    expect(readOnlyBanner({ ...copy, engine: 'pending' }, now).text).toBe('Connecting to iCloud…');
    const ok = readOnlyBanner({ ...copy, signedIn: true, writtenAt: now - 3600_000, readAt: now }, now);
    expect(ok.text).toContain("Reading your iPhone's copy from iCloud, written today at 11:00 AM");
  });
  it('banner: unreachable names the cached copy, or says there is none', () => {
    const t = new Date(2026, 10, 20, 9, 14).getTime();
    expect(readOnlyBanner({ ...copy, engine: 'off', unreachable: true, cachedAt: t }, now))
      .toEqual({ tone: 'warn', action: 'reload', text: "Couldn't reach iCloud; showing the copy from yesterday at 9:14 AM." });
    expect(readOnlyBanner({ ...copy, unreachable: true, cachedAt: null }, now).text).toContain('no saved copy');
  });
  it('banner: an unreadable copy is an error, not "reading"', () => {
    const b = readOnlyBanner({ ...copy, signedIn: true, readAt: null, unreadable: 'not a ledger' }, now);
    expect(b).toEqual({ tone: 'error', action: 'reload', text: "Your iPhone's copy couldn't be read (not a ledger)." });
    expect(syncLine({ ...copy, signedIn: true, unreadable: 'x' }, now)).toBe('iPhone copy · could not be read');
  });
});

const ACCTS: Account[] = [{ id: 'a1', name: 'a1', color: '#fff', order: 0, created: 1, updated: 1 }, { id: 'a2', name: 'a2', color: '#fff', order: 1, created: 1, updated: 1 }];

describe('ledgerTable', () => {
  const rows = [t('rent', '2026-11-21', -185000), t('pay', '2026-11-17', 312500), t('open', '2026-11-01', 100000),
    t('other', '2026-11-20', -500, 'a2')];
  it('shows a running balance for one account only', () => {
    const one = ledgerTable(rows, ACCTS, 'a1');
    expect(one.rows.map((r) => [r.txn.id, r.balance])).toEqual([['rent', 227500], ['pay', 412500], ['open', 100000]]);
    expect(one.foot).toEqual({ count: 3, moneyIn: 412500, moneyOut: -185000, net: 227500 });
    expect(ledgerTable(rows, ACCTS, null).rows.every((r) => r.balance === null)).toBe(true);
    expect(ledgerTable(rows, ACCTS, null).foot.count).toBe(4);
  });
  it('a filter narrows rows and foot but not the balances', () => {
    const f = ledgerTable(rows, ACCTS, 'a1', { ...EMPTY_TXN_FILTER, query: 'pay' });
    expect(f.rows.map((r) => r.balance)).toEqual([412500]);
    expect(f.foot.net).toBe(312500);
  });
  it('skips deleted rows', () => {
    expect(ledgerTable([...rows, t('gone', '2026-11-22', 5, 'a1', { deleted: true })], ACCTS, 'a1').rows).toHaveLength(3);
  });
  it('leaves out the rows of a deleted account, so the net matches the sidebar', () => {
    const accts = [acct('a1'), { ...acct('a2', 1), deleted: true as const }];
    const all = ledgerTable(rows, accts, null);
    expect(all.rows.every((r) => r.txn.account === 'a1')).toBe(true);
    expect(all.foot.net).toBe(accountBalances(accts, rows).all);
    expect(all.foot.count).toBe(3);
  });
  it('totals accounts', () => {
    const b = accountBalances([acct('a1'), acct('a2')], rows);
    expect(b.rows.map((r) => r.balance)).toEqual([227500, -500]);
    expect(b.all).toBe(227000);
  });
});

describe('quick entry', () => {
  it('parses days, nearest-century years, and bare dates nearest today', () => {
    expect(parseDayInput('', '2026-11-21')).toBe('2026-11-21');
    expect(parseDayInput('Nov 5', '2026-11-21')).toBe('2026-11-05');
    expect(parseDayInput('11/5', '2026-11-21')).toBe('2026-11-05');
    expect(parseDayInput('11/5/25', '2026-11-21')).toBe('2025-11-05');
    expect(parseDayInput('11/5/99', '2026-11-21')).toBe('1999-11-05');
    expect(parseDayInput('11/5/26', '2026-11-21')).toBe('2026-11-05');
    expect(parseDayInput('11/5/2031', '2026-11-21')).toBe('2031-11-05');
    expect(parseDayInput('12/30', '2027-01-02')).toBe('2026-12-30');
    expect(parseDayInput('1/2', '2026-12-30')).toBe('2027-01-02');
    expect(parseDayInput('6/15', '2026-11-21')).toBe('2026-06-15');
    expect(parseDayInput('2/29', '2026-11-21')).toBeNull(); // no Feb 29 within six months
    expect(parseDayInput('2/29', '2028-01-10')).toBe('2028-02-29');
    expect(parseDayInput('2/30', '2026-11-21')).toBeNull();
    expect(parseDayInput('soon', '2026-11-21')).toBeNull();
  });
  it('reads amounts as the editor does, in both modes', () => {
    expect(quickAmount('350', 'cents')).toBe('-3.50');
    expect(quickAmount('350', 'whole')).toBe('-350.00');
    expect(quickAmount('3.5', 'cents')).toBe('-3.50');
    expect(quickAmount('4.50', 'whole')).toBe('-4.50');
    expect(quickAmount('+350', 'cents')).toBe('3.50');
    expect(quickAmount('+3125', 'whole')).toBe('3125.00');
    expect(quickAmount('-4.50', 'cents')).toBe('-4.50');
    expect(quickAmount('\u22124.50', 'cents')).toBe('-4.50');
    expect(quickAmount('$1,234.56', 'cents')).toBe('-1234.56');
  });
  it('treats brackets as an expense once, and refuses ambiguous signs', () => {
    expect(quickAmount('(12.34)', 'cents')).toBe('-12.34');
    expect(quickAmount('-(5)', 'whole')).toBe('-5.00');
    expect(quickAmount('(500)', 'cents')).toBe('-5.00');
    expect(quickAmount('+(5)', 'whole')).toBeNull();
    expect(quickAmount('--4', 'cents')).toBeNull();
    expect(quickAmount('abc', 'cents')).toBeNull();
    expect(quickAmount('4a5', 'cents')).toBeNull();
    expect(quickAmount('1.005', 'cents')).toBeNull();
  });
  const choices = [
    { id: 'l1', name: 'Groceries', category: 'c' }, { id: 'l2', name: 'Dining', category: 'c' },
    { id: 'l3', name: 'Grocery delivery', category: 'c' },
  ];
  it('matches categories by name and says when it cannot', () => {
    expect(quickCategory('', choices)).toEqual({ kind: 'auto' });
    expect(quickCategory('dining', choices)).toEqual({ kind: 'ok', id: 'l2' });
    expect(quickCategory('din', choices)).toEqual({ kind: 'ok', id: 'l2' });
    expect(quickCategory('groceries', choices)).toEqual({ kind: 'ok', id: 'l1' });
    expect(quickCategory('zzz', choices)).toEqual({ kind: 'none', text: 'zzz' });
    expect(quickCategory('groc', choices)).toEqual({ kind: 'many', text: 'groc', names: ['Groceries', 'Grocery delivery'] });
  });
  const ctx = { account: 'a1', choices, rules: [], mode: 'cents' as const, today: '2026-11-21' };
  it('builds a validated draft in the chosen mode', () => {
    const ok = quickDraft({ date: 'Nov 5', name: ' Coffee ', category: 'din', amount: '675' }, ctx);
    expect(ok.errors).toEqual({});
    expect(ok.draft).toMatchObject({ date: '2026-11-05', amount: '-6.75', category: 'l2', account: 'a1' });
    expect(quickDraft({ date: '', name: 'x', category: '', amount: '675' }, { ...ctx, mode: 'whole' }).draft.amount).toBe('-675.00');
    const bad = quickDraft({ date: 'x', name: '', category: '', amount: 'q' }, ctx);
    expect(Object.keys(bad.errors).sort()).toEqual(['amount', 'date', 'name']);
  });
  it('REFUSES an unknown or ambiguous category instead of dropping it', () => {
    const none = quickDraft({ date: '', name: 'Lunch', category: 'zzz', amount: '5' }, ctx);
    expect(none.errors.category).toContain('No category matches "zzz"');
    const many = quickDraft({ date: '', name: 'Lunch', category: 'groc', amount: '5' }, ctx);
    expect(many.errors.category).toContain('Groceries, Grocery delivery');
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
