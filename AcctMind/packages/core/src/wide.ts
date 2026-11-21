/**
 * The wide (desktop-size) layout's rules.
 *
 * The screens draw; everything a sentence can say about what the wide table
 * shows, what the sidebar totals, whether the ledger may be edited at all,
 * and how a quick-entry row is read lives here, with a test (test/wide.test.ts).
 */
import { budgetOverspent, lineTone, linesIn, stillNeeded, unassigned, availableOf, type LineTone } from './budget';
import { autoCategory, type CategoryRule } from './categorization';
import { isDay, today as todayDay } from './day';
import { amountDigits, amountInput, signedCents, type AmountMode } from './money';
import { filterByName, filterTransactions, isValid, sortTxns, validateDraft, EMPTY_TXN_FILTER, type TxnFilter } from './txn';
import { monthlyBudgetAmounts, snoozedLines, monthSet } from './views';
import type { Account, Category, Draft, DraftErrors, Line, Setting, BudgetAmount, Txn } from './types';
import type { CategoryChoice } from './categorization';

/* ------------------------------------------------------------------ *
 * Who may edit.
 * ------------------------------------------------------------------ */

/**
 * Where the ledger on screen came from.
 *
 *   file  — the iCloud Drive document, read and written by this app (the Tauri
 *           Mac shell, and the native apps). Editable.
 *   copy  — a plain browser showing the CloudKit copy of the iPhone's ledger.
 *           NEVER written back (`cloudkitweb.push` is a no-op), so an edit made
 *           here would be silently lost. Read-only.
 *   local — a plain browser on a DEVELOPMENT host (where CloudKit's token
 *           cannot work) that is not signed in: the browser's own storage is
 *           the ledger and the only copy. Editable.
 *
 * On a real host a plain browser is ALWAYS `copy`: it shows the CloudKit copy
 * and nothing else, and stays read-only when CloudKit is unreachable or fails.
 */
export type LedgerSource = 'file' | 'copy' | 'local';

export type AccessInput = {
  /** The Expo native module is present (iOS, Android). */
  native: boolean;
  /** `window.__TAURI__` is present (the Mac and Windows shells). */
  tauri: boolean;
  signedIn: boolean;
  /** localhost, 127.0.0.1, [::1], *.localhost, *.test: where the API token is not valid. */
  localHost: boolean;
};

export type LedgerAccess = { source: LedgerSource; readOnly: boolean };

/**
 * The ONE answer the UI reads for "may this ledger be edited here".
 *
 * A plain browser on a real host is read-only whatever CloudKit does (loading,
 * signed out, failed): it never becomes editable there. A signed-in browser is
 * reading the copy on any host. Only an unsigned browser on a development host
 * (the e2e harness, `localhost`) keeps its own editable local ledger.
 */
export function ledgerAccess(i: AccessInput): LedgerAccess {
  if (i.native || i.tauri) return { source: 'file', readOnly: false };
  if (i.signedIn || !i.localHost) return { source: 'copy', readOnly: true };
  return { source: 'local', readOnly: false };
}

/** Is this a host where CloudKit's API token cannot work? */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'
    || h.endsWith('.localhost') || h.endsWith('.test');
}

export type SyncInfo = {
  source: LedgerSource;
  /** When this page last read the shared file / CloudKit copy successfully, ms. */
  readAt: number | null;
  /** When this page last wrote the shared file, ms. */
  savedAt: number | null;
  /** When the iPhone wrote the CloudKit copy, ms. */
  writtenAt: number | null;
  signedIn: boolean;
  /** CloudKit JS: not answered yet, running, or unavailable. */
  engine?: 'pending' | 'ready' | 'off';
  /** CloudKit could not be reached or the read failed. */
  unreachable?: boolean;
  /** When the cached copy on screen was written (or cached), ms, if one is shown. */
  cachedAt?: number | null;
  /** Why the copy could not be read as a ledger, when it could not. */
  unreadable?: string | null;
};

const clock = (ms: number): string => {
  const d = new Date(ms);
  const h = d.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `today at 9:14 AM`, `yesterday at 9:14 AM`, or `Nov 9 at 9:14 AM`. */
export function formatWritten(ms: number, now: number): string {
  const d = new Date(ms);
  const n = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(n) - startOf(d)) / 86_400_000);
  const when = days === 0 ? 'today' : days === 1 ? 'yesterday'
    : `${MONTH_ABBR[d.getMonth()]} ${d.getDate()}${d.getFullYear() === n.getFullYear() ? '' : `, ${d.getFullYear()}`}`;
  return `${when} at ${clock(ms)}`;
}

/** The small status line under the sidebar's title. */
export function syncLine(info: SyncInfo, now: number): string {
  if (info.source === 'copy') {
    if (info.unreadable) return 'iPhone copy · could not be read';
    if (info.unreachable) return 'iCloud · not reachable';
    if (!info.signedIn) return info.engine === 'pending' ? 'iCloud · connecting…' : 'iCloud copy · signed out';
    if (info.writtenAt !== null) return `iPhone copy · written ${formatWritten(info.writtenAt, now)}`;
    return info.readAt !== null ? 'iPhone copy · none written yet' : 'iPhone copy · reading…';
  }
  if (info.source === 'local') return 'This browser only · not synced';
  const parts = ['iCloud Drive'];
  if (info.readAt !== null) parts.push(`read ${clock(info.readAt)}`);
  if (info.savedAt !== null) parts.push(`saved ${clock(info.savedAt)}`);
  return parts.length === 1 ? 'iCloud Drive · not read yet' : parts.join(' · ');
}

export type ReadOnlyBanner = {
  tone: 'info' | 'warn' | 'error';
  text: string;
  /** What the button does: read again, or sign in. */
  action: 'reload' | 'signin';
};

/**
 * What the read-only banner says (after the bold "Read-only"), in priority
 * order: an unreadable copy, an unreachable iCloud (with the cached copy's time
 * when one is shown), still connecting, signed out, then the normal line.
 */
export function readOnlyBanner(info: SyncInfo, now: number): ReadOnlyBanner {
  const tail = 'Add and edit on your iPhone or in the AcctMind Mac app.';
  if (info.unreadable) {
    return { tone: 'error', action: 'reload', text: `Your iPhone's copy couldn't be read (${info.unreadable}).` };
  }
  if (info.unreachable) {
    const t = info.cachedAt ?? null;
    return {
      tone: 'warn', action: 'reload',
      text: t === null
        ? "Couldn't reach iCloud, and there is no saved copy to show."
        : `Couldn't reach iCloud; showing the copy from ${formatWritten(t, now)}.`,
    };
  }
  if (!info.signedIn) {
    return info.engine === 'pending'
      ? { tone: 'info', action: 'reload', text: 'Connecting to iCloud…' }
      : { tone: 'info', action: 'signin', text: "Sign in with your Apple ID to read your iPhone's copy from iCloud." };
  }
  if (info.writtenAt !== null) {
    return { tone: 'info', action: 'reload', text: `Reading your iPhone's copy from iCloud, written ${formatWritten(info.writtenAt, now)}. ${tail}` };
  }
  return {
    tone: 'info', action: 'reload',
    text: info.readAt === null
      ? `Reading your iPhone's copy from iCloud. ${tail}`
      : `Signed in, but your iPhone has not written a copy yet. ${tail}`,
  };
}

/* ------------------------------------------------------------------ *
 * Accounts and the transactions table.
 * ------------------------------------------------------------------ */

/** Each live account's balance, and the sum of all of them. */
export function accountBalances(accounts: readonly Account[], txns: readonly Txn[]) {
  const by = new Map<string, number>();
  for (const t of txns) if (t.deleted !== true) by.set(t.account, (by.get(t.account) ?? 0) + t.amount);
  const rows = accounts.filter((a) => a.deleted !== true)
    .map((a) => ({ account: a, balance: by.get(a.id) ?? 0 }));
  return { rows, all: rows.reduce((n, r) => n + r.balance, 0) };
}

export type LedgerRow = {
  txn: Txn;
  /** The account's balance AFTER this row; null unless exactly one account is shown. */
  balance: number | null;
};
export type LedgerFoot = { count: number; moneyIn: number; moneyOut: number; net: number };

/** Count, money in (positive rows), money out (negative rows, as a negative) and net. */
export function ledgerFoot(txns: readonly Txn[]): LedgerFoot {
  let moneyIn = 0;
  let moneyOut = 0;
  for (const t of txns) {
    if (t.amount >= 0) moneyIn += t.amount;
    else moneyOut += t.amount;
  }
  return { count: txns.length, moneyIn, moneyOut, net: moneyIn + moneyOut };
}

/**
 * The wide transactions table: newest first, a running Balance when ONE
 * account is selected, and the foot's totals over the rows actually shown.
 *
 * The balance is the account's whole history (never the filtered subset): a
 * search must not change what the account held on a given day. Rows that
 * share a date keep `sortTxns`'s order, so the running balance is stable.
 */
export function ledgerTable(
  txns: readonly Txn[], accounts: readonly Account[], account: string | null, filter: TxnFilter = EMPTY_TXN_FILTER,
): { rows: LedgerRow[]; foot: LedgerFoot } {
  // Only live accounts' rows, as the phone's sections and `accountBalances` do,
  // so the table's net agrees with the sidebar's total.
  const open = new Set(accounts.filter((a) => a.deleted !== true).map((a) => a.id));
  const live = txns.filter((t) => t.deleted !== true && open.has(t.account));
  const scope = account === null ? live : live.filter((t) => t.account === account);
  const sorted = sortTxns(scope, 'date');
  const balance = new Map<string, number>();
  if (account !== null) {
    // Newest first: the balance after a row is that row plus every older one.
    let older = 0;
    for (let i = sorted.length - 1; i >= 0; i--) {
      older += sorted[i]!.amount;
      balance.set(sorted[i]!.id, older);
    }
  }
  const shown = new Set(filterTransactions(sorted, filter).map((t) => t.id));
  const rows = sorted.filter((t) => shown.has(t.id))
    .map((txn) => ({ txn, balance: account === null ? null : balance.get(txn.id) ?? 0 }));
  return { rows, foot: ledgerFoot(rows.map((r) => r.txn)) };
}

/* ------------------------------------------------------------------ *
 * Quick entry: the Mac's row at the top of the table.
 * ------------------------------------------------------------------ */

const MONTH_INDEX: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const dayNumber = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d) / 86_400_000;

/**
 * A typed date: empty is today; `2026-11-21`, `11/21`, `11/21/26`, `11/21/2026`,
 * `Nov 21` and `Nov 21 2026` are days; anything else is null.
 *
 * A two-digit year takes the century that lands NEAREST today (`99` is 1999
 * and `26` is 2026 in 2026). A bare month and day take the nearest such date
 * to today, within six months either side (`12/30` typed on Jan 2 is the
 * previous Dec 30).
 */
export function parseDayInput(text: string, now: string = todayDay()): string | null {
  const s = text.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (s === '') return now;
  if (isDay(s)) return s;
  let m: number; let d: number; let y: string | undefined;
  let hit = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(s);
  if (hit) {
    m = Number(hit[1]); d = Number(hit[2]); y = hit[3];
  } else {
    hit = /^([a-z]{3})[a-z]* (\d{1,2})(?: (\d{2}|\d{4}))?$/.exec(s);
    if (!hit) return null;
    m = MONTH_INDEX[hit[1]!] ?? 0; d = Number(hit[2]); y = hit[3];
  }
  const [ny, nm, nd] = now.split('-').map(Number) as [number, number, number];
  const today = dayNumber(ny, nm, nd);
  const make = (year: number): string | null => {
    const out = `${String(year).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return isDay(out) ? out : null;
  };
  const nearest = (years: readonly number[]): string | null => {
    let best: string | null = null;
    let gap = Infinity;
    for (const year of years) {
      const day = make(year);
      if (day === null) continue;
      const g = Math.abs(dayNumber(year, m, d) - today);
      if (g < gap) { gap = g; best = day; }
    }
    return best;
  };
  if (y === undefined) return nearest([ny - 1, ny, ny + 1]);
  if (y.length === 4) return make(Number(y));
  const yy = Number(y);
  return nearest([1900 + yy, 2000 + yy, 2100 + yy]);
}

/**
 * A typed amount as the draft's canonical string, read the way the editor
 * reads it: the digits go through `amountDigits` and `signedCents` under the
 * same entry MODE, so with cents `350` is $3.50 and with whole dollars it is
 * $350.00, and a typed `.` makes it an ordinary amount in both.
 *
 * The sign is the one thing a quick row has no button for. Unsigned money is an
 * EXPENSE (the editor's minus starts on, for the same reason); `-`, `−` and
 * accounting brackets `(12.34)` are expenses too; a leading `+` makes it
 * income. A `+` with brackets, or two signs, is ambiguous and refused. Anything
 * but digits, one dot, commas and `$` is refused rather than dropped.
 */
export function quickAmount(text: string, mode: AmountMode): string | null {
  let s = text.trim().replace(/^\u2212/, '-');
  if (s === '') return null;
  let income = false;
  if (s.startsWith('+')) { income = true; s = s.slice(1).trim(); }
  else if (s.startsWith('-')) s = s.slice(1).trim();
  if (s.startsWith('(') && s.endsWith(')')) {
    if (income) return null;
    s = s.slice(1, -1).trim();
  }
  if (!/^[\d.,$\s]+$/.test(s)) return null;
  const cents = signedCents(amountDigits(s), !income, mode);
  return cents === null ? null : amountInput(cents);
}

export type QuickCategory =
  | { kind: 'auto' }
  | { kind: 'ok'; id: string }
  | { kind: 'none'; text: string }
  | { kind: 'many'; text: string; names: string[] };

/**
 * The category a typed word means: an exact name, else a single substring
 * match. Empty means "decide from the name" (the rules). A word that matches
 * nothing, or several, is NOT quietly dropped: the caller refuses and says so.
 */
export function quickCategory(text: string, choices: readonly CategoryChoice[]): QuickCategory {
  const q = text.trim();
  if (q === '') return { kind: 'auto' };
  const exact = choices.find((c) => c.name.toLowerCase() === q.toLowerCase());
  if (exact) return { kind: 'ok', id: exact.id };
  const some = filterByName(choices, q);
  if (some.length === 1) return { kind: 'ok', id: some[0]!.id };
  return some.length === 0 ? { kind: 'none', text: q } : { kind: 'many', text: q, names: some.map((c) => c.name) };
}

export type QuickFields = { date: string; name: string; category: string; amount: string };

/** A quick-entry row read into core's Draft, with core's own validation. */
export function quickDraft(
  f: QuickFields,
  ctx: {
    account: string; choices: readonly CategoryChoice[]; rules: readonly CategoryRule[];
    mode: AmountMode; today?: string;
  },
): { draft: Draft; errors: DraftErrors } {
  const day = parseDayInput(f.date, ctx.today);
  const amount = quickAmount(f.amount, ctx.mode);
  const draft: Draft = {
    name: f.name, description: '', amount: amount ?? f.amount.trim(),
    date: day ?? f.date.trim(), account: ctx.account, category: null,
  };
  const typed = quickCategory(f.category, ctx.choices);
  if (typed.kind === 'auto') draft.category = autoCategory(draft, ctx.rules);
  else if (typed.kind === 'ok') draft.category = typed.id;
  const errors = validateDraft(draft);
  if (amount === null && draft.amount !== '' && errors.amount === undefined) errors.amount = 'That is not an amount';
  if (typed.kind === 'none') errors.category = `No category matches "${typed.text}"`;
  else if (typed.kind === 'many') errors.category = `"${typed.text}" matches ${typed.names.join(', ')}: type more`;
  return { draft, errors };
}

export const quickIsValid = (e: DraftErrors): boolean => isValid(e);

/* ------------------------------------------------------------------ *
 * The wide budget sheet.
 * ------------------------------------------------------------------ */

export type SheetLine = {
  line: Line;
  /** Target each month (`line.needs`). */
  target: number;
  /** Assigned in this month. */
  allocated: number;
  spent: number;
  carry: number;
  /** What is left: carry + allocated + spent (spent is negative). */
  remaining: number;
  tone: LineTone;
  snoozed: boolean;
};
export type SheetGroup = { category: Category; lines: SheetLine[] };

/**
 * The budget as the wide screen reads it, for one month: the three totals
 * (Unassigned, Overspent, Short of target) and each category's lines with
 * Target, Allocated, Spent, Remaining and the tone core's `lineTone` gives.
 */
export function budgetSheet(
  store: {
    txns: readonly Txn[]; categories: readonly Category[]; lines: readonly Line[];
    budgets: readonly BudgetAmount[]; settings?: readonly Setting[] | undefined;
  },
  month: string, start: string | null,
) {
  const txns = store.txns.filter((t) => t.deleted !== true);
  const cats = store.categories.filter((c) => c.deleted !== true).sort((a, b) => a.order - b.order);
  const lines = store.lines.filter((l) => l.deleted !== true);
  const { held, amounts } = monthlyBudgetAmounts({ budgets: store.budgets }, month, lines, txns, start);
  const asleep = snoozedLines({ settings: store.settings }, monthSet(month));
  const groups: SheetGroup[] = cats.map((category) => ({
    category,
    lines: linesIn(lines, category.id).map((line) => {
      const a = amounts.get(line.id) ?? { budget: 0, spent: 0, carry: 0 };
      const snoozed = asleep.has(line.id);
      return {
        line, target: line.needs, allocated: a.budget, spent: a.spent, carry: a.carry,
        remaining: availableOf(a.budget, a.spent, a.carry),
        tone: lineTone({ needs: line.needs, snoozed, budget: a.budget }, a.spent, a.carry),
        snoozed,
      };
    }),
  }));
  const balances = groups.flatMap((g) => g.lines.map((l) => ({ budget: l.allocated, spent: l.spent, carry: l.carry })));
  const short = groups.reduce((n, g) => n + g.lines.reduce(
    (m, l) => m + stillNeeded({ needs: l.target, snoozed: l.snoozed, budget: l.allocated }, l.spent, l.carry), 0), 0);
  return {
    groups,
    unassigned: unassigned(held, balances),
    overspent: budgetOverspent(balances),
    short,
    /** This month's transactions per line id, newest first. */
    spending: (id: string): Txn[] => sortTxns(amounts.get(id)?.txns ?? [], 'date'),
  };
}
