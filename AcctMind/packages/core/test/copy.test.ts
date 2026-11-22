/**
 * The read-only web copy (src/copy.ts, and the banner in src/wide.ts).
 *
 * The owner, 2026-11-21: "acctmind readonly seems out of date or wrong in the
 * web". The last block is the guarantee the web leans on: ONE ledger, taken
 * through the phone's path (its own store, the iCloud file, `planSync`, the
 * Budget tab's arithmetic) and through the web's (the CloudKit record's packed
 * bytes, `parseStore`, the wide `budgetSheet`), gives the same figures.
 */
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  COPY_REFRESH_MS, STORE_VERSION, availableOf, budgetSheet, budgetStart, budgetOverspent, copyAge, copyIntact,
  copyProblem, copyVersion, copyWrittenAt, ensureAccount, ensureCategory, lineTone, linesIn, live,
  monthSet, monthlyBudgetAmounts, olderFormat, parseStore, phoneOlder, planSync, putBudgetStart, putSnooze,
  readOnlyBanner, serialize, snoozedLines, syncLine, unassigned,
  type BudgetAmount, type Store, type SyncInfo,
} from '../src/index';

const NOW = new Date(2026, 10, 21, 12, 0).getTime();
const H = 3600_000;

describe('the copy\'s time, length and format', () => {
  it('prefers the server\'s save time, then the phone\'s stamp, and never invents one', () => {
    expect(copyWrittenAt(1000, 2000)).toBe(1000);
    expect(copyWrittenAt(undefined, 2000)).toBe(2000);
    expect(copyWrittenAt(undefined, undefined)).toBeNull();
    expect(copyWrittenAt('x', 0)).toBeNull();
  });
  it('a declared length that disagrees means the copy arrived damaged', () => {
    expect(copyIntact(10, 10)).toBe(true);
    expect(copyIntact(10, 9)).toBe(false);
    expect(copyIntact(undefined, 9)).toBe(true);
  });
  it('reads the format from the first key, and names a newer one plainly', () => {
    expect(copyVersion(serialize({ v: STORE_VERSION, txns: [], accounts: [], categories: [], lines: [], budgets: [], settings: [] })))
      .toBe(STORE_VERSION);
    expect(copyVersion('{"txns":[],"v":4}')).toBeNull();
    const newer = `{"v":${STORE_VERSION + 1},"txns":[]}`;
    const parsed = parseStore(newer);
    expect(parsed.ok).toBe(false);
    expect(copyProblem(newer, parsed.ok ? '' : parsed.error)).toContain(`newer format (v${STORE_VERSION + 1})`);
    expect(copyProblem('nonsense', 'the saved data is not readable JSON')).toBe('the saved data is not readable JSON');
    expect(olderFormat('{"v":3,"txns":[]}')).toBe(3);
    expect(olderFormat(`{"v":${STORE_VERSION},"txns":[]}`)).toBeNull();
  });
  it('says the age in words', () => {
    expect(copyAge(NOW - 20_000, NOW)).toBe('just now');
    expect(copyAge(NOW + 60_000, NOW)).toBe('just now');
    expect(copyAge(NOW - 60_000, NOW)).toBe('1 minute ago');
    expect(copyAge(NOW - 5 * 60_000, NOW)).toBe('5 minutes ago');
    expect(copyAge(NOW - 3 * H, NOW)).toBe('3 hours ago');
    expect(copyAge(NOW - 50 * H, NOW)).toBe('2 days ago');
  });
  it('re-checks every minute', () => {
    expect(COPY_REFRESH_MS).toBe(60_000);
  });
  it('knows when the iPhone\'s app is older than the page', () => {
    expect(phoneOlder(undefined, '0.71.0')).toBe(false);
    // No `app` field: a record from before the field existed (0.63.0 on 2026-11-21).
    expect(phoneOlder(null, '0.71.0')).toBe(true);
    expect(phoneOlder('0.63.0', '0.71.0')).toBe(true);
    expect(phoneOlder('0.9.0', '0.10.0')).toBe(true);
    expect(phoneOlder('0.71.0', '0.71.0')).toBe(false);
    expect(phoneOlder('0.72.0', '0.71.0')).toBe(false);
    expect(phoneOlder('junk', '0.71.0')).toBe(false);
    expect(phoneOlder('0.63.0', undefined)).toBe(false);
  });
});

describe('the banner always says how old the copy on screen is', () => {
  const base: SyncInfo = { source: 'copy', readAt: null, savedAt: null, writtenAt: null, signedIn: false };
  const cached = NOW - 26 * H;
  it('a cached copy shown while iCloud connects', () => {
    expect(readOnlyBanner({ ...base, engine: 'pending', cachedAt: cached }, NOW).text)
      .toBe('Connecting to iCloud… showing the copy from 1 day ago (yesterday at 10:00 AM), saved in this browser.');
  });
  it('a cached copy shown while the first read is out', () => {
    expect(readOnlyBanner({ ...base, signedIn: true, engine: 'ready', cachedAt: cached }, NOW).text)
      .toBe('Checking iCloud… showing the copy from 1 day ago (yesterday at 10:00 AM), saved in this browser.');
  });
  it('the last good copy kept under an unreadable newer one', () => {
    const b = readOnlyBanner({ ...base, signedIn: true, unreadable: 'damaged', cachedAt: NOW - 2 * H }, NOW);
    expect(b.tone).toBe('error');
    expect(b.text).toBe("Your iPhone's newest copy couldn't be read (damaged); showing the copy from 2 hours ago (today at 10:00 AM).");
  });
  it('a read copy leads with its age', () => {
    const b = readOnlyBanner({ ...base, signedIn: true, readAt: NOW, writtenAt: NOW - 2 * H, phoneApp: '0.72.0', pageApp: '0.72.0' }, NOW);
    expect(b).toEqual({
      tone: 'info', action: 'reload',
      text: 'iPhone copy from 2 hours ago (today at 10:00 AM). Add and edit on your iPhone or in the AcctMind Mac app.',
    });
  });
  it('a copy with no recorded time is still a copy, never "none written"', () => {
    const info = { ...base, signedIn: true, readAt: NOW, writtenAt: null };
    expect(readOnlyBanner(info, NOW).text).toContain("iPhone copy (its time wasn't recorded).");
    expect(syncLine(info, NOW)).toBe('iPhone copy · time not recorded');
    expect(readOnlyBanner({ ...info, noCopy: true }, NOW).text).toContain('has not written a copy yet');
    expect(syncLine({ ...info, noCopy: true }, NOW)).toBe('iPhone copy · none written yet');
  });
  it('an older iPhone app is named, because its figures can differ from this page\'s', () => {
    const read = { ...base, signedIn: true, readAt: NOW, writtenAt: NOW - H, pageApp: '0.72.0' };
    const was = readOnlyBanner({ ...read, phoneApp: null }, NOW);
    expect(was.tone).toBe('warn');
    expect(was.text).toContain("Your iPhone's AcctMind is older than this page (0.72.0), so budget figures can differ");
    expect(readOnlyBanner({ ...read, phoneApp: '0.63.0' }, NOW).text)
      .toContain('Your iPhone has AcctMind 0.63.0 and this page is 0.72.0');
    expect(readOnlyBanner({ ...read, phoneApp: '0.72.0' }, NOW).text).not.toContain('differ');
    expect(readOnlyBanner({ ...read, phoneApp: '0.72.0', olderFormat: 3 }, NOW).text).toContain('older format (v3)');
  });
});

/* ------------------------------------------------------------------ *
 * One ledger, two paths, the same figures.
 * ------------------------------------------------------------------ */

const rec = { created: 1, updated: 1 };
const txn = (id: string, date: string, amount: number, category: string | null, extra: object = {}) => ({
  id, name: id, description: '', amount, date, account: 'chk', category, order: 0, ...rec, ...extra,
});
const amt = (month: string, line: string, amount: number): BudgetAmount => ({
  id: `${monthSet(month)}|${line}`, set: monthSet(month), line, amount, ...rec,
});

/** A ledger with the awkward parts: overspending, carry, tombstones, a start day, snoozes, unfiled money. */
function ledger(): Store {
  const base: Store = {
    v: STORE_VERSION,
    accounts: [{ id: 'chk', name: 'Checking', color: '#4c8bf0', order: 0, ...rec }],
    categories: [
      { id: 'home', name: 'Home', color: '#4c8bf0', order: 0, ...rec },
      { id: 'fun', name: 'Fun', color: '#4c8bf0', order: 1, ...rec },
      { id: 'gone', name: 'Gone', color: '#4c8bf0', order: 2, ...rec, deleted: true },
    ],
    lines: [
      { id: 'rent', name: 'Rent', category: 'home', budget: 0, needs: 185000, snoozed: false, order: 0, ...rec },
      { id: 'food', name: 'Food', category: 'home', budget: 0, needs: 60000, snoozed: false, order: 1, ...rec },
      { id: 'games', name: 'Games', category: 'fun', budget: 0, needs: 5000, snoozed: false, order: 0, ...rec },
      { id: 'old', name: 'Old', category: 'fun', budget: 0, needs: 0, snoozed: false, order: 1, ...rec, deleted: true },
      { id: 'orphan', name: 'Orphan', category: 'gone', budget: 0, needs: 0, snoozed: false, order: 0, ...rec },
    ],
    budgets: [
      amt('2026-09', 'rent', 185000), amt('2026-09', 'food', 50000),
      amt('2026-10', 'rent', 185000), amt('2026-10', 'food', 40000), amt('2026-10', 'games', 5000),
      amt('2026-11', 'rent', 185000), amt('2026-11', 'food', 30000),
    ],
    settings: [],
    txns: [
      txn('pay-sep', '2026-09-01', 450000, null),
      txn('before-start', '2026-09-02', -9900, 'food'),
      txn('rent-sep', '2026-09-03', -185000, 'rent'),
      txn('food-sep', '2026-09-15', -42000, 'food'),
      txn('pay-oct', '2026-10-01', 450000, null),
      txn('rent-oct', '2026-10-03', -185000, 'rent'),
      txn('food-oct', '2026-10-20', -61234, 'food'),        // overspent: covered later or not
      txn('games-oct', '2026-10-21', -7999, 'games'),
      txn('deleted', '2026-10-22', -100000, 'food', { deleted: true }),
      txn('on-old-line', '2026-10-23', -1500, 'old'),
      txn('unfiled', '2026-11-02', -2500, null),
      txn('rent-nov', '2026-11-03', -185000, 'rent'),
      txn('food-nov', '2026-11-04', -12345, 'food', { cleared: true }),
      txn('next-month', '2026-12-01', -5000, 'food'),
    ],
  };
  const settings = putSnooze(
    { settings: putBudgetStart(base, '2026-09-03', 1) }, monthSet('2026-11'), 'games', true, 2);
  return { ...base, settings };
}

type Figures = {
  available: number; overspent: number;
  lines: Record<string, { budget: number; spent: number; carry: number; remaining: number; tone: string }>;
};

/** THE PHONE: its own saved store, the iCloud file through planSync, then the Budget tab's arithmetic (BudgetScreen). */
function phoneFigures(localText: string, fileText: string, month: string): Figures {
  const loaded = parseStore(localText);
  if (!loaded.ok) throw new Error(loaded.error);
  // App.tsx seeds on load; a real ledger has both already, so this is a no-op.
  const local = ensureCategory(ensureAccount(loaded.store, 'acct-x', NOW), 'cat-x', NOW);
  const store = planSync(local, fileText, NOW).store;
  const txns = live(store.txns);
  const categories = live(store.categories);
  const lines = live(store.lines);
  const { held, amounts } = monthlyBudgetAmounts({ budgets: store.budgets }, month, lines, txns, budgetStart(store));
  const snoozed = snoozedLines({ settings: store.settings }, monthSet(month));
  const out: Figures['lines'] = {};
  const balances = categories.flatMap((c) => linesIn(lines, c.id).map((line) => {
    const a = amounts.get(line.id)!;
    out[line.id] = {
      budget: a.budget, spent: a.spent, carry: a.carry, remaining: availableOf(a.budget, a.spent, a.carry),
      tone: lineTone({ needs: line.needs, snoozed: snoozed.has(line.id), budget: a.budget }, a.spent, a.carry),
    };
    return { budget: a.budget, spent: a.spent, carry: a.carry };
  }));
  return { available: unassigned(held, balances), overspent: budgetOverspent(balances), lines: out };
}

/** What the phone puts in the CloudKit record: the file's bytes, raw DEFLATE, as CloudKit JS hands Bytes over. */
const record = (fileText: string) => ({
  ledger: deflateRawSync(Buffer.from(fileText, 'utf8')).toString('base64'),
  bytes: Buffer.byteLength(fileText, 'utf8'),
});

/** THE WEB: the same steps as cloudkitweb's `unpack`, then `parseStore`, then the wide `budgetSheet`. */
async function webFigures(rec: { ledger: string; bytes: number }, month: string): Promise<Figures> {
  const bin = atob(rec.ledger);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const raw = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
  expect(copyIntact(rec.bytes, raw.byteLength)).toBe(true);
  const text = new TextDecoder().decode(raw);
  const parsed = parseStore(text);
  if (!parsed.ok) throw new Error(parsed.error);
  expect(parsed.dropped).toBe(0);
  const sheet = budgetSheet(parsed.store, month, budgetStart(parsed.store));
  const out: Figures['lines'] = {};
  for (const g of sheet.groups) {
    for (const l of g.lines) {
      out[l.line.id] = { budget: l.allocated, spent: l.spent, carry: l.carry, remaining: l.remaining, tone: l.tone };
    }
  }
  return { available: sheet.unassigned, overspent: sheet.overspent, lines: out };
}

const MONTHS = ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12'];

describe('one ledger through the phone\'s path and the web\'s gives the same figures', () => {
  it('every month, every line, both totals', async () => {
    const file = serialize(ledger());
    for (const month of MONTHS) {
      const phone = phoneFigures(file, file, month);
      const web = await webFigures(record(file), month);
      expect(web, month).toEqual(phone);
    }
    // And the fixture is not trivially agreeing: it overspends, carries and snoozes.
    const oct = phoneFigures(file, file, '2026-10');
    expect(oct.overspent).toBeGreaterThan(0);
    expect(phoneFigures(file, file, '2026-11').lines['games']!.tone).toBe('snoozed');
    expect(Object.values(phoneFigures(file, file, '2026-11').lines).some((l) => l.carry !== 0)).toBe(true);
  });

  it('a phone whose saved store is behind the file shows the merge, and the file is what the copy holds', async () => {
    // The phone reads the file on launch, merges, and publishes the merge, which the
    // module mirrors again; the copy ends on what the phone shows.
    const full = ledger();
    const behind = { ...full, txns: full.txns.filter((t) => t.id !== 'food-nov') };
    const local = parseStore(serialize(behind));
    if (!local.ok) throw new Error(local.error);
    const plan = planSync(local.store, serialize(full), NOW);
    expect(plan.save).toBe(true);
    // The module mirrors on `get` (the file) and again on `set` (what planSync
    // publishes — here the file with its expired tombstones pruned); the last wins.
    const copy = plan.publish ?? serialize(full);
    for (const month of MONTHS) {
      expect(await webFigures(record(copy), month)).toEqual(phoneFigures(serialize(behind), serialize(full), month));
      expect(await webFigures(record(serialize(full)), month)).toEqual(phoneFigures(serialize(behind), serialize(full), month));
    }
  });

  it('a copy from an OLDER phone (fields it never wrote, an older format) reads with nothing dropped', async () => {
    // As a v3 phone wrote it: money on the categories, no lines, no settings,
    // no `cleared`, `needs`, `snoozed` or `order`.
    const v3 = JSON.stringify({
      v: 3,
      accounts: [{ id: 'chk', name: 'Checking', color: '#4c8bf0', created: 1, updated: 1 }],
      categories: [{ id: 'home', name: 'Home', color: '#4c8bf0', budget: 120000, created: 1, updated: 1 }],
      txns: [
        { id: 'a', name: 'Pay', amount: 300000, date: '2026-11-01', account: 'chk', created: 1, updated: 1 },
        { id: 'b', name: 'Rent', amount: -100000, date: '2026-11-02', account: 'chk', category: 'home', created: 1, updated: 1 },
      ],
    });
    expect(olderFormat(v3)).toBe(3);
    for (const month of ['2026-10', '2026-11']) {
      expect(await webFigures(record(v3), month)).toEqual(phoneFigures(v3, v3, month));
    }
    expect((await webFigures(record(v3), '2026-11')).lines['line-home']!.spent).toBe(-100000);
  });
});
