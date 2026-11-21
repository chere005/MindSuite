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
import { amountInput, parseAmount } from './money';
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
 *   local — a plain browser with no CloudKit at all (a development host, or
 *           CloudKit blocked or unconfigured): the browser's own storage is
 *           the ledger and the only copy. Editable.
 */
export type LedgerSource = 'file' | 'copy' | 'local';

export type AccessInput = {
  /** The Expo native module is present (iOS, Android). */
  native: boolean;
  /** `window.__TAURI__` is present (the Mac and Windows shells). */
  tauri: boolean;
  /** What CloudKit JS is doing in this page: not answered yet, running, or unavailable. */
  cloudKit: 'pending' | 'ready' | 'off';
  signedIn: boolean;
  /** localhost, 127.0.0.1, [::1], *.localhost, *.test: where the API token is not valid. */
  localHost: boolean;
};

export type LedgerAccess = { source: LedgerSource; readOnly: boolean };

/**
 * The ONE answer the UI reads for "may this ledger be edited here".
 *
 * A signed-in browser is always reading the copy. A signed-out browser on a
 * real host is read-only too (it shows the sign-in) until CloudKit turns out
 * to be unavailable; on a development host a signed-out browser has only its
 * own local ledger, which is the case the e2e harness drives.
 */
export function ledgerAccess(i: AccessInput): LedgerAccess {
  if (i.native || i.tauri) return { source: 'file', readOnly: false };
  if (i.signedIn) return { source: 'copy', readOnly: true };
  if (i.cloudKit !== 'off' && !i.localHost) return { source: 'copy', readOnly: true };
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
  /** When the shared file / CloudKit copy was last read by this page, ms. */
  readAt: number | null;
  /** When this page last wrote the shared file, ms. */
  savedAt: number | null;
  /** When the iPhone wrote the CloudKit copy, ms. */
  writtenAt: number | null;
  signedIn: boolean;
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
    if (!info.signedIn) return 'iCloud copy · signed out';
    if (info.writtenAt !== null) return `iPhone copy · written ${formatWritten(info.writtenAt, now)}`;
    return info.readAt !== null ? 'iPhone copy · none written yet' : 'iPhone copy · reading…';
  }
  if (info.source === 'local') return 'This browser only · not synced';
  const parts = ['iCloud Drive'];
  if (info.readAt !== null) parts.push(`read ${clock(info.readAt)}`);
  if (info.savedAt !== null) parts.push(`saved ${clock(info.savedAt)}`);
  return parts.length === 1 ? 'iCloud Drive · not read yet' : parts.join(' · ');
}

/** The sentence the read-only banner says (without the "Read-only" lead). */
export function readOnlyMessage(info: SyncInfo, now: number): string {
  const tail = 'Add and edit on your iPhone or in the AcctMind Mac app.';
  if (!info.signedIn) return "Sign in with your Apple ID to read your iPhone's copy from iCloud.";
  if (info.writtenAt !== null) {
    return `Reading your iPhone's copy from iCloud, written ${formatWritten(info.writtenAt, now)}. ${tail}`;
  }
  return info.readAt === null
    ? `Reading your iPhone's copy from iCloud. ${tail}`
    : `Signed in, but your iPhone has not written a copy yet. ${tail}`;
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
  txns: readonly Txn[], account: string | null, filter: TxnFilter = EMPTY_TXN_FILTER,
): { rows: LedgerRow[]; foot: LedgerFoot } {
  const live = txns.filter((t) => t.deleted !== true);
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

/**
 * A typed date: empty is today; `2026-11-21`, `11/21`, `11/21/26`, `11/21/2026`,
 * `Nov 21` and `Nov 21 2026` are days; anything else is null. A bare month and
 * day take the current year.
 */
export function parseDayInput(text: string, now: string = todayDay()): string | null {
  const s = text.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (s === '') return now;
  if (isDay(s)) return s;
  const year = (y: string | undefined): string | null => {
    if (y === undefined) return now.slice(0, 4);
    if (y.length === 2) return `20${y}`;
    return y.length === 4 ? y : null;
  };
  let m: number; let d: number; let y: string | null;
  let hit = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(s);
  if (hit) {
    m = Number(hit[1]); d = Number(hit[2]); y = year(hit[3]);
  } else {
    hit = /^([a-z]{3})[a-z]* (\d{1,2})(?: (\d{2}|\d{4}))?$/.exec(s);
    if (!hit) return null;
    m = MONTH_INDEX[hit[1]!] ?? 0; d = Number(hit[2]); y = year(hit[3]);
  }
  if (y === null) return null;
  const out = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isDay(out) ? out : null;
}

/**
 * A typed amount as the draft's canonical string. Unsigned money is an
 * EXPENSE (the add form starts negative for the same reason: nearly
 * everything in a ledger goes out); `+` marks income, `-` or `−` an expense.
 * Null when it is not an amount.
 */
export function quickAmount(text: string): string | null {
  let s = text.trim().replace(/^−/, '-');
  if (s === '') return null;
  let negative = true;
  if (s.startsWith('+')) { negative = false; s = s.slice(1); }
  else if (s.startsWith('-')) s = s.slice(1);
  if (/^\s*[+-]/.test(s)) return null;
  const cents = parseAmount(s);
  if (cents === null) return null;
  return amountInput(negative ? -cents : cents);
}

/**
 * The category a typed word means: an exact name, else a single substring
 * match, else nothing. Empty means "decide from the name" (the rules).
 */
export function quickCategory(text: string, choices: readonly CategoryChoice[]): string | null | undefined {
  const q = text.trim();
  if (q === '') return undefined;
  const exact = choices.find((c) => c.name.toLowerCase() === q.toLowerCase());
  if (exact) return exact.id;
  const some = filterByName(choices, q);
  return some.length === 1 ? some[0]!.id : null;
}

export type QuickFields = { date: string; name: string; category: string; amount: string };

/** A quick-entry row read into core's Draft, with core's own validation. */
export function quickDraft(
  f: QuickFields,
  ctx: { account: string; choices: readonly CategoryChoice[]; rules: readonly CategoryRule[]; today?: string },
): { draft: Draft; errors: DraftErrors } {
  const day = parseDayInput(f.date, ctx.today);
  const amount = quickAmount(f.amount);
  const draft: Draft = {
    name: f.name, description: '', amount: amount ?? f.amount.trim(),
    date: day ?? f.date.trim(), account: ctx.account, category: null,
  };
  const typed = quickCategory(f.category, ctx.choices);
  draft.category = typed === undefined ? autoCategory(draft, ctx.rules) : typed;
  const errors = validateDraft(draft);
  if (amount === null && draft.amount !== '' && errors.amount === undefined) errors.amount = 'That is not an amount';
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
