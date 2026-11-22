/**
 * REPORTS — where the money went, read off the ledger and never written back.
 *
 * The owner, 2026-11-21: "add a visualization tab that's similar to some basic
 * features from ynab so i can see spending/income by month, year, category".
 * Three reports, YNAB's basic three: Spending breakdown (by group and line),
 * Spending trends (per month) and Income vs expense (per month and per year).
 * The screens draw; every number, every bucket and every label rule is here.
 *
 * WHAT A ROW IS TO A REPORT. Nothing new is decided in this file; each rule is
 * one the ledger already keeps somewhere else, read the same way:
 *
 *   · Tombstones and rows in a deleted account are not there — `live`, and
 *     `ledgerTable`/`accountBalances` (wide.ts), which only count live accounts.
 *   · Every per-category amount comes through `txnParts` (txn.ts), so a
 *     transaction split across lines lands in each of them.
 *   · Filed under INCOME (types.ts) is income. A negative income part is
 *     income given back, and reduces it.
 *   · Filed under a live line in a live group (`selectableLines`'s rule,
 *     categorization.ts) is spending on that line, NET: money out is negative
 *     in this ledger, so a refund filed on the line takes its spending down —
 *     budget.ts's `availableOf`, "a refund does the right thing for free".
 *   · Anything else — unfiled, or filed on a line or group that has since been
 *     deleted (the Transactions tab shows those with no category, and
 *     `parseStore` files a row whose line is gone as `null`) — is spending
 *     under NO CATEGORY, the name the Budget tab gives the same rows.
 *   · An UNFILED Reconcile row is neither: it is "an adjustment, not a
 *     purchase, and there is nothing to file it under" (`unfiledSince`,
 *     budget.ts). One that someone filed counts where it was filed, as the
 *     Budget tab counts it.
 *
 * TRANSFERS. The ledger has no transfer record: moving money between two of
 * the owner's accounts is two rows, out of one and into the other, which the
 * budget's arithmetic leaves unfiled (filing either half would move a line).
 * So a transfer here is exactly that shape — an unfiled row out and an
 * unfiled row in, in two different live accounts, for the same cents, at most
 * `SETTLE_DRIFT` days apart (csv.ts: how far a row may drift as it settles) —
 * and both halves are left out of every report, whichever accounts are
 * picked. With every account picked the two would cancel anyway; pairing
 * them is what keeps a one-account report, or a transfer that crosses a month
 * end, from calling half of one spending. Rows the owner FILED are never
 * paired: filing is his statement of what the money was.
 *
 * MONTHS, NOT DAYS. Every period is whole calendar months, `YYYY-MM`, the
 * key the budget already uses (`monthOf`, views.ts); a row's day only decides
 * which month it is in. "Today" is an argument, and callers pass core's
 * `today()` — the LOCAL calendar day (day.ts), never UTC.
 *
 * Signs: `ReportRow.amount` is the ledger's (out negative). Every figure a
 * report returns is the way a person reads it — spending and income both
 * positive, net = income − spending.
 */
import { RECONCILE_NAME } from './budget';
import { SETTLE_DRIFT } from './csv';
import { addMonths, monthLabel } from './day';
import { PALETTE } from './palette';
import { txnParts } from './txn';
import { INCOME, type Account, type Category, type Line, type Txn } from './types';
import { monthOf } from './views';

/** The bucket key for spending filed under no live line. Cannot collide with an id. */
export const NO_CATEGORY = '\u001fnone';
/** What the Budget tab calls the same rows (BudgetScreen's "No Category" line). */
export const NO_CATEGORY_NAME = 'No Category';
/** The palette's grey, for the one bucket that has no record to carry a colour. */
export const NO_CATEGORY_COLOR: string = PALETTE[5];

export type ReportLedger = {
  txns: readonly Txn[];
  accounts: readonly Account[];
  categories: readonly Category[];
  lines: readonly Line[];
};

export type ReportKind = 'income' | 'spending';

/** One counted part of one transaction. */
export type ReportRow = {
  txn: string;
  date: string;
  /** `YYYY-MM`. */
  month: string;
  account: string;
  /** Signed cents as stored: money out is negative. */
  amount: number;
  kind: ReportKind;
  /** The line id, `NO_CATEGORY`, or `INCOME`. */
  line: string;
  /** The line's group (a `Category` id), `NO_CATEGORY`, or `INCOME`. */
  group: string;
};

/* ------------------------------------------------------------------ *
 * Rows.
 * ------------------------------------------------------------------ */

/** A day as a whole-day count — arithmetic on the calendar, no timezone in it. */
const dayNumber = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

const unfiled = (t: Txn): boolean => txnParts(t).every((p) => p.category === null);

/**
 * The ids of every row that is half of a transfer — see the head comment.
 *
 * Greedy and deterministic: outflows in date order, each taking the nearest
 * unclaimed inflow (fewest days apart, then earliest, then lowest id). A row
 * is half of at most one transfer.
 */
export function transferIds(txns: readonly Txn[], accounts: readonly Account[]): Set<string> {
  const open = new Set(accounts.filter((a) => a.deleted !== true).map((a) => a.id));
  const byCents = new Map<number, { outs: Txn[]; ins: Txn[] }>();
  for (const t of txns) {
    if (t.deleted === true || !open.has(t.account) || t.amount === 0) continue;
    if (t.name === RECONCILE_NAME || !unfiled(t)) continue;
    const key = Math.abs(t.amount);
    const bucket = byCents.get(key) ?? { outs: [], ins: [] };
    (t.amount < 0 ? bucket.outs : bucket.ins).push(t);
    byCents.set(key, bucket);
  }
  const order = (a: Txn, b: Txn) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const paired = new Set<string>();
  for (const { outs, ins } of byCents.values()) {
    if (ins.length === 0) continue;
    outs.sort(order);
    ins.sort(order);
    for (const out of outs) {
      const at = dayNumber(out.date);
      let best: Txn | null = null;
      let bestDrift = SETTLE_DRIFT + 1;
      for (const inn of ins) {
        if (paired.has(inn.id) || inn.account === out.account) continue;
        const drift = Math.abs(dayNumber(inn.date) - at);
        // `ins` is in order, so the first at a given drift is the earliest.
        if (drift < bestDrift) { best = inn; bestDrift = drift; }
      }
      if (best !== null) { paired.add(out.id); paired.add(best.id); }
    }
  }
  return paired;
}

/**
 * Every counted part of the ledger, classified once. The reports below are
 * sums over this list, so they cannot disagree about what a row is.
 */
export function reportRows(ledger: ReportLedger): ReportRow[] {
  const groups = new Set(ledger.categories.filter((c) => c.deleted !== true).map((c) => c.id));
  const groupOf = new Map(ledger.lines
    .filter((l) => l.deleted !== true && groups.has(l.category))
    .map((l) => [l.id, l.category] as const));
  const open = new Set(ledger.accounts.filter((a) => a.deleted !== true).map((a) => a.id));
  const transfers = transferIds(ledger.txns, ledger.accounts);
  const rows: ReportRow[] = [];
  for (const t of ledger.txns) {
    if (t.deleted === true || !open.has(t.account) || transfers.has(t.id)) continue;
    const base = { txn: t.id, date: t.date, month: monthOf(t.date), account: t.account };
    for (const part of txnParts(t)) {
      if (part.amount === 0) continue;
      if (part.category === INCOME) {
        rows.push({ ...base, amount: part.amount, kind: 'income', line: INCOME, group: INCOME });
        continue;
      }
      const group = part.category === null ? undefined : groupOf.get(part.category);
      if (group === undefined) {
        // An unfiled Reconcile is an adjustment; one filed on a line that has
        // gone is still money that went somewhere, so only `null` is skipped.
        if (part.category === null && t.name === RECONCILE_NAME) continue;
        rows.push({ ...base, amount: part.amount, kind: 'spending', line: NO_CATEGORY, group: NO_CATEGORY });
        continue;
      }
      rows.push({ ...base, amount: part.amount, kind: 'spending', line: part.category as string, group });
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * Periods.
 * ------------------------------------------------------------------ */

export type ReportPeriod = 'this-month' | 'last-month' | 'ytd' | 'last-12' | 'all' | `year:${number}`;

/** The fixed choices, in the order they are offered. Specific years follow them. */
export const REPORT_PERIODS: readonly { period: ReportPeriod; label: string }[] = [
  { period: 'this-month', label: 'This month' },
  { period: 'last-month', label: 'Last month' },
  { period: 'ytd', label: 'Year to date' },
  { period: 'last-12', label: 'Last 12 months' },
  { period: 'all', label: 'All time' },
];

/** What Reports opens on — YNAB's default, and the owner's ask. */
export const DEFAULT_REPORT_PERIOD: ReportPeriod = 'last-12';

export const yearPeriod = (year: number): ReportPeriod => `year:${year}`;

/** The year a `year:` period names, or null. */
export function periodYear(period: ReportPeriod): number | null {
  return period.startsWith('year:') ? Number(period.slice(5)) : null;
}

/** First and last month, `YYYY-MM`, both included. */
export type MonthRange = { from: string; to: string };

/** A `YYYY-MM` moved by whole months. */
export function shiftMonth(month: string, n: number): string {
  return addMonths(`${month}-01`, n).slice(0, 7);
}

/**
 * The months a period covers, on the calendar of `todayDay` (`today()`, local).
 *
 * Last 12 months is the twelve ending with this one, this one included. All
 * time runs from the first counted month to this month, or to the last
 * counted month when something is dated later.
 */
export function periodRange(period: ReportPeriod, todayDay: string, rows: readonly ReportRow[] = []): MonthRange {
  const now = monthOf(todayDay);
  const year = periodYear(period);
  if (year !== null) {
    const y = String(year).padStart(4, '0');
    return { from: `${y}-01`, to: `${y}-12` };
  }
  switch (period) {
    case 'this-month': return { from: now, to: now };
    case 'last-month': { const m = shiftMonth(now, -1); return { from: m, to: m }; }
    case 'ytd': return { from: `${now.slice(0, 4)}-01`, to: now };
    case 'last-12': return { from: shiftMonth(now, -11), to: now };
    default: {
      let from = now;
      let to = now;
      for (const r of rows) {
        if (r.month < from) from = r.month;
        if (r.month > to) to = r.month;
      }
      return { from, to };
    }
  }
}

/** Every month in a range, oldest first. Empty when `from` is after `to`. */
export function monthsIn(range: MonthRange): string[] {
  const out: string[] = [];
  for (let m = range.from; m <= range.to; m = shiftMonth(m, 1)) out.push(m);
  return out;
}

/** The years worth offering as their own period: any with a counted row, and this one. Newest first. */
export function reportYears(rows: readonly ReportRow[], todayDay: string): number[] {
  const years = new Set<number>([Number(todayDay.slice(0, 4))]);
  for (const r of rows) years.add(Number(r.month.slice(0, 4)));
  return [...years].sort((a, b) => b - a);
}

/** `Jan` for `2026-01`. */
export function monthShort(month: string): string {
  return monthLabel(`${month}-01`).slice(0, 3);
}

/** `November 2026`, `Jan – Nov 2026`, `Dec 2025 – Nov 2026`. */
export function rangeLabel(range: MonthRange): string {
  if (range.from === range.to) return monthLabel(`${range.from}-01`);
  const fy = range.from.slice(0, 4);
  const ty = range.to.slice(0, 4);
  return fy === ty
    ? `${monthShort(range.from)} – ${monthShort(range.to)} ${ty}`
    : `${monthShort(range.from)} ${fy} – ${monthShort(range.to)} ${ty}`;
}

/** What the period reads as over a report: a year is just the year. */
export function periodLabel(period: ReportPeriod, range: MonthRange): string {
  const year = periodYear(period);
  return year !== null ? String(year) : rangeLabel(range);
}

/* ------------------------------------------------------------------ *
 * Filters.
 * ------------------------------------------------------------------ */

/** Null is every category; otherwise one group (all its lines), one line, or No Category. */
export type CategoryFilter = null | { group: string } | { line: string };

export type ReportScope = {
  range: MonthRange;
  /** Account ids; null is every live account (they are all budget accounts here). */
  accounts: readonly string[] | null;
  /** Narrows SPENDING only. Income vs expense ignores it — see `incomeExpense`. */
  category: CategoryFilter;
};

const inRange = (r: ReportRow, range: MonthRange): boolean => r.month >= range.from && r.month <= range.to;
const accountIn = (r: ReportRow, accounts: readonly string[] | null): boolean =>
  accounts === null || accounts.includes(r.account);
const categoryIn = (r: ReportRow, f: CategoryFilter): boolean =>
  f === null || ('group' in f ? r.group === f.group : r.line === f.line);

/** The spending parts a scope counts. */
function spendingIn(rows: readonly ReportRow[], scope: ReportScope): ReportRow[] {
  return rows.filter((r) => r.kind === 'spending' && inRange(r, scope.range)
    && accountIn(r, scope.accounts) && categoryIn(r, scope.category));
}

/**
 * The account chips: picking one from "all" narrows to it; picking more adds;
 * un-picking the last one, or picking every one, is "all" again.
 */
export function toggleReportAccount(
  current: readonly string[] | null, id: string, all: readonly string[],
): string[] | null {
  if (current === null) return all.length <= 1 ? null : [id];
  const next = current.includes(id) ? current.filter((a) => a !== id) : [...current, id];
  if (next.length === 0 || all.every((a) => next.includes(a))) return null;
  return all.filter((a) => next.includes(a));
}

/** The picked accounts that are still live; none left, or every one, is "all". */
export function liveAccountFilter(current: readonly string[] | null, all: readonly string[]): string[] | null {
  if (current === null) return null;
  const kept = all.filter((a) => current.includes(a));
  return kept.length === 0 || kept.length === all.length ? null : kept;
}

export type CategoryOption = { filter: CategoryFilter; label: string; depth: 0 | 1; color: string };

/** The category picker's list: All, then each live group followed by its lines, then No Category. */
export function categoryOptions(ledger: Pick<ReportLedger, 'categories' | 'lines'>): CategoryOption[] {
  const groups = ledger.categories.filter((c) => c.deleted !== true).slice().sort((a, b) => a.order - b.order);
  const out: CategoryOption[] = [{ filter: null, label: 'All categories', depth: 0, color: '' }];
  for (const g of groups) {
    out.push({ filter: { group: g.id }, label: g.name || 'Untitled', depth: 0, color: g.color });
    const lines = ledger.lines.filter((l) => l.deleted !== true && l.category === g.id)
      .sort((a, b) => a.order - b.order);
    for (const l of lines) out.push({ filter: { line: l.id }, label: l.name || 'Untitled', depth: 1, color: g.color });
  }
  out.push({ filter: { line: NO_CATEGORY }, label: NO_CATEGORY_NAME, depth: 0, color: NO_CATEGORY_COLOR });
  return out;
}

export const sameCategoryFilter = (a: CategoryFilter, b: CategoryFilter): boolean =>
  a === null || b === null ? a === b
    : 'group' in a ? 'group' in b && a.group === b.group
    : 'line' in b && a.line === b.line;

/** The filter itself while it names something live; All once its group or line is gone. */
export function liveCategoryFilter(f: CategoryFilter, ledger: Pick<ReportLedger, 'categories' | 'lines'>): CategoryFilter {
  return categoryOptions(ledger).some((o) => sameCategoryFilter(o.filter, f)) ? f : null;
}

/** The picker's label for a filter; a filter naming something deleted reads as All. */
export function categoryFilterLabel(f: CategoryFilter, ledger: Pick<ReportLedger, 'categories' | 'lines'>): string {
  return categoryOptions(ledger).find((o) => sameCategoryFilter(o.filter, f))?.label ?? 'All categories';
}

/* ------------------------------------------------------------------ *
 * Spending breakdown.
 * ------------------------------------------------------------------ */

export type BreakdownRow = {
  id: string; name: string; color: string;
  /** Spending, positive; negative when refunds outran it. */
  amount: number;
  /**
   * Whole percent of the spending the positive groups add up to, or null
   * for a net refund, which is not a share of anything.
   */
  share: number | null;
};
export type BreakdownGroup = BreakdownRow & { lines: BreakdownRow[] };
/** `total` is net spending — refunds and all — and what the report heads with. */
export type Breakdown = { total: number; groups: BreakdownGroup[] };

/** A whole percent of `whole`, or null when either side is not positive. */
export function percentOf(part: number, whole: number): number | null {
  return part > 0 && whole > 0 ? Math.round((part * 100) / whole) : null;
}

/** `23%`, `<1%` for a real share that rounds to nothing, `` when there is none. */
export function shareLabel(share: number | null): string {
  return share === null ? '' : share === 0 ? '<1%' : `${share}%`;
}

/**
 * Spending by group, and by line within each group, largest first. Groups
 * and lines with nothing net in the scope are left out.
 */
export function spendingBreakdown(
  rows: readonly ReportRow[], scope: ReportScope, ledger: Pick<ReportLedger, 'categories' | 'lines'>,
): Breakdown {
  const byLine = new Map<string, number>();
  const byGroup = new Map<string, number>();
  let total = 0;
  for (const r of spendingIn(rows, scope)) {
    byLine.set(r.line, (byLine.get(r.line) ?? 0) - r.amount);
    byGroup.set(r.group, (byGroup.get(r.group) ?? 0) - r.amount);
    total -= r.amount;
  }
  // Shares are of the GROSS: what the positive groups add up to. A group
  // that refunds outran has no share, and must not push the others past 100%.
  let base = 0;
  for (const amount of byGroup.values()) if (amount > 0) base += amount;
  const cats = new Map(ledger.categories.map((c) => [c.id, c]));
  const lines = new Map(ledger.lines.map((l) => [l.id, l]));
  const bigger = (a: { amount: number; order: number; name: string }, b: { amount: number; order: number; name: string }) =>
    b.amount - a.amount || a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  const groups = [...byGroup].filter(([, amount]) => amount !== 0).map(([id, amount]) => {
    const cat = cats.get(id);
    const name = id === NO_CATEGORY ? NO_CATEGORY_NAME : cat?.name || 'Untitled';
    const color = id === NO_CATEGORY ? NO_CATEGORY_COLOR : cat?.color ?? NO_CATEGORY_COLOR;
    const groupLines = id === NO_CATEGORY ? [] : [...byLine]
      .filter(([lid, a]) => a !== 0 && lines.get(lid)?.category === id)
      .map(([lid, a]) => {
        const l = lines.get(lid);
        return { id: lid, name: l?.name || 'Untitled', color, amount: a, share: percentOf(a, base), order: l?.order ?? 0 };
      })
      .sort(bigger)
      .map(({ order: _order, ...row }) => row);
    return { id, name, color, amount, share: percentOf(amount, base), lines: groupLines, order: id === NO_CATEGORY ? Infinity : cat?.order ?? 0 };
  }).sort(bigger).map(({ order: _order, ...g }) => g);
  return { total, groups };
}

/* ------------------------------------------------------------------ *
 * Spending trends.
 * ------------------------------------------------------------------ */

export type TrendMonth = {
  month: string;
  /** Net spending in the month. */
  total: number;
  /** Each group's net spending, in the ledger's group order (No Category last); nonzero only. */
  groups: { id: string; amount: number }[];
};
export type Trend = { months: TrendMonth[]; total: number; average: number };

/** Spending per month across the scope's range, every month present — an empty one is zero. */
export function spendingTrend(
  rows: readonly ReportRow[], scope: ReportScope, ledger: Pick<ReportLedger, 'categories'>,
): Trend {
  const order = new Map(ledger.categories.map((c) => [c.id, c.order]));
  const rank = (id: string) => (id === NO_CATEGORY ? Infinity : order.get(id) ?? 0);
  const by = new Map<string, Map<string, number>>();
  for (const r of spendingIn(rows, scope)) {
    const m = by.get(r.month) ?? new Map<string, number>();
    m.set(r.group, (m.get(r.group) ?? 0) - r.amount);
    by.set(r.month, m);
  }
  const months = monthsIn(scope.range).map((month) => {
    const m = by.get(month) ?? new Map<string, number>();
    const groups = [...m].filter(([, a]) => a !== 0).map(([id, amount]) => ({ id, amount }))
      .sort((a, b) => rank(a.id) - rank(b.id) || (a.id < b.id ? -1 : 1));
    return { month, total: groups.reduce((n, g) => n + g.amount, 0), groups };
  });
  const total = months.reduce((n, m) => n + m.total, 0);
  return { months, total, average: months.length === 0 ? 0 : Math.round(total / months.length) };
}

/* ------------------------------------------------------------------ *
 * Income vs expense.
 * ------------------------------------------------------------------ */

export type FlowBucket = {
  /** `YYYY-MM`, `YYYY`, or `total`. */
  key: string;
  income: number;
  spending: number;
  /** income − spending. */
  net: number;
};
export type Flow = { months: FlowBucket[]; years: FlowBucket[]; total: FlowBucket };

const bucket = (key: string): FlowBucket => ({ key, income: 0, spending: 0, net: 0 });

/**
 * Income and spending per month and per year, with net, across the scope's
 * range and accounts. The CATEGORY filter is not applied: net is income less
 * ALL spending, and income less one category's spending is a different
 * question with a misleading answer.
 */
export function incomeExpense(rows: readonly ReportRow[], scope: Pick<ReportScope, 'range' | 'accounts'>): Flow {
  const months = new Map(monthsIn(scope.range).map((m) => [m, bucket(m)]));
  for (const r of rows) {
    const b = months.get(r.month);
    if (b === undefined || !accountIn(r, scope.accounts)) continue;
    if (r.kind === 'income') b.income += r.amount;
    else b.spending -= r.amount;
  }
  const years = new Map<string, FlowBucket>();
  const total = bucket('total');
  for (const b of months.values()) {
    b.net = b.income - b.spending;
    const y = b.key.slice(0, 4);
    const yb = years.get(y) ?? bucket(y);
    yb.income += b.income; yb.spending += b.spending; yb.net += b.net;
    years.set(y, yb);
    total.income += b.income; total.spending += b.spending; total.net += b.net;
  }
  return { months: [...months.values()], years: [...years.values()], total };
}

/* ------------------------------------------------------------------ *
 * Chart arithmetic.
 * ------------------------------------------------------------------ */

const STEPS = [1, 2, 2.5, 5, 10] as const;

/**
 * A value axis for bars up to `max` cents: a round step (1, 2, 2.5 or 5 times
 * a power of ten, whole dollars at least) and a top that is a whole number of
 * steps at or above `max`, with about `ticks` steps. Zero and below have no
 * axis to draw: `{ top: 0, step: 0 }`.
 */
export function niceScale(max: number, ticks = 4): { top: number; step: number } {
  if (!(max > 0)) return { top: 0, step: 0 };
  const raw = Math.max(100, max / Math.max(1, ticks));
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = Math.round((STEPS.find((s) => s * pow >= raw) ?? 10) * pow);
  return { top: Math.ceil(max / step) * step, step };
}

/**
 * A value axis that holds `min` and `max` and always zero: one round step
 * (`niceScale` of the whole span), a top at or above `max` and a bottom at or
 * below `min`, both whole steps. A month refunds outran draws below the line.
 */
export function niceAxis(min: number, max: number, ticks = 4): { top: number; bottom: number; step: number } {
  const hi = Math.max(0, max);
  const lo = Math.min(0, min);
  const { step } = niceScale(hi - lo, ticks);
  if (step === 0) return { top: 0, bottom: 0, step: 0 };
  // `+ 0` turns the -0 that `Math.floor(-0 / step) * step` can give into 0.
  return { top: Math.ceil(hi / step) * step, bottom: Math.floor(lo / step) * step + 0, step };
}

/** An axis label: `$950`, `$1.2k`, `$12k`, `$1.5M`. Whole dollars, rounded. */
export function shortAmount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const dollars = Math.round(Math.abs(cents) / 100);
  const one = (n: number) => (Math.round(n * 10) / 10).toString();
  if (dollars < 1000) return `${sign}$${dollars}`;
  if (dollars < 10_000) return `${sign}$${one(dollars / 1000)}k`;
  if (dollars < 999_500) return `${sign}$${Math.round(dollars / 1000)}k`;
  return `${sign}$${one(dollars / 1_000_000)}M`;
}
