/** Making, checking and ordering transactions. The product's actual rules. */

import type { Draft, DraftErrors, DraftPart, Record_, SplitPart, Txn } from './types';
import { isDay } from './day';
import { amountInput, formatAmount, parseAmount } from './money';
import { touch } from './merge';

export const NAME_MAX = 120;
export const DESC_MAX = 2000;

/**
 * Check a draft. Returns one message per bad field, and `{}` when it is fine.
 *
 * Returning the errors rather than throwing is what lets the add form show
 * all of them at once. A validator that throws on the first problem makes a
 * person fix their input one round trip at a time.
 */
export function validateDraft(draft: Draft): DraftErrors {
  const errors: DraftErrors = {};

  const name = draft.name.trim();
  if (name === '') errors.name = 'Name is required';
  else if (name.length > NAME_MAX) errors.name = `Name is longer than ${NAME_MAX} characters`;

  if (draft.description.length > DESC_MAX) {
    errors.description = `Description is longer than ${DESC_MAX} characters`;
  }

  if (draft.amount.trim() === '') errors.amount = 'Amount is required';
  else if (parseAmount(draft.amount) === null) errors.amount = 'That is not an amount';

  if (!isDay(draft.date)) errors.date = 'Pick a date';

  if (draft.account.trim() === '') errors.account = 'Pick an account';

  // A split is judged only once there is an amount to split: "That is not an
  // amount" on the total already says what is wrong, and a second sentence
  // about the parts of a number that does not exist would be noise.
  if (draft.splits !== undefined && errors.amount === undefined) {
    const parts = draftParts(draft);
    const problem = parts === null ? 'That is not an amount' : splitProblem(parseAmount(draft.amount) ?? 0, parts);
    if (problem !== null) errors.splits = problem;
  }

  return errors;
}

/** True when `validateDraft` found nothing. */
export function isValid(errors: DraftErrors): boolean {
  return Object.keys(errors).length === 0;
}

/**
 * Build a transaction from a draft that has already passed validation.
 *
 * `id` and `created` are arguments rather than generated in here so that a
 * test can pin them and get the same object twice. The screens call
 * `newId()` and `Date.now()` themselves — the impurity lives at the edge.
 */
export function makeTxn(draft: Draft, id: string, created: number): Txn {
  const amount = parseAmount(draft.amount);
  if (amount === null) throw new Error('makeTxn: the draft has not been validated');
  return {
    id,
    name: draft.name.trim(),
    description: draft.description.trim(),
    amount,
    date: draft.date,
    account: draft.account,
    ...filing(draft, amount, 'makeTxn'),
    // A new row has never been dragged. Zero means "use the date order",
    // which is what makes an untouched list identical in every sort mode.
    order: 0,
    created,
    // A new record has never been edited, so its merge clock starts where it
    // was born. Every later change goes through `touch`.
    updated: created,
  };
}

/**
 * Where a validated draft files its money: one category, or a split with a
 * null category beside it (see `Txn.splits` for why null). No `splits` key at
 * all when it is not split, so an unsplit row is the row it always was.
 */
function filing(draft: Draft, amount: number, who: string): Pick<Txn, 'category' | 'splits'> {
  if (draft.splits === undefined) return { category: draft.category };
  const parts = draftParts(draft);
  if (parts === null || splitProblem(amount, parts) !== null) {
    throw new Error(`${who}: the draft has not been validated`);
  }
  return { category: null, splits: parts };
}

/** A blank draft, dated today. What the + button opens. */
export function emptyDraft(day: string, account: string, category: string | null = null): Draft {
  // The account is required rather than defaulted. A form that invented one
  // would put transactions somewhere nobody chose, and the screen always
  // knows which section the + was pressed in.
  //
  // The category is OPTIONAL and defaults to none, because most + presses
  // happen on an account and say nothing about a category. Budget's own + is
  // the case that does know one: pressing + beside Groceries means this is a
  // Groceries transaction, and making someone pick it again from a dropdown
  // is asking a question they have already answered.
  return { name: '', description: '', amount: '', date: day, account, category };
}

/* ------------------------------------------------------------------ *
 * Choosing several rows at once.
 *
 * The owner, 2026-08-21: "in edit mode allow for selecting multiple
 * transactions.. when multiple transactions are selected, show the sum of
 * their amounts." Which is the whole point of it — "what did this weekend
 * cost" is a question a ledger should answer by tapping four rows, not by
 * adding them up by hand.
 * ------------------------------------------------------------------ */

/** Add an id to the selection, or take it out. */
export function toggleSelected(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/**
 * The sum of the selected rows, in cents.
 *
 * Ids that no longer name a transaction are SKIPPED rather than counted as
 * zero or thrown over — a row can be deleted on another device while it sits
 * selected here, and a selection that outlives its row must not make the
 * total wrong or the screen crash. It just stops contributing.
 */
export function selectedTotal(txns: readonly Txn[], ids: readonly string[]): number {
  const want = new Set(ids);
  return txns.reduce((sum, t) => (want.has(t.id) ? sum + t.amount : sum), 0);
}

/* ------------------------------------------------------------------ *
 * SPLITS — one transaction filed under several lines.
 *
 * The owner, 2026-11-21: "add splitting a transaction between multiple
 * categories in a very trivial interface to use". The record is `Txn.splits`
 * (types.ts says what it holds, and why `category` is null beside it); the
 * rules are here, and there are three of them:
 *
 *   1. EVERY per-category sum reads a transaction through `txnParts` — budget
 *      spent and carry, the unfiled rows, the category filter, the ranking of
 *      category choices, reports. Never through `t.category`.
 *   2. A split is two or more non-zero parts with the transaction's sign that
 *      add up to its amount exactly (`splitProblem`). The store drops a split
 *      that breaks this; the form refuses to save one.
 *   3. The parts are KEPT AS SIZES and the amount gives them their sign; the
 *      LAST part is whatever is left (`resplit`). That one sentence is what the
 *      form draws (the last row is a remainder nobody types), what an amount
 *      edited in place does, and what an import that changes a row's amount
 *      does — so the three cannot disagree about where a difference goes.
 * ------------------------------------------------------------------ */

/**
 * What a transaction puts into each category: one part per category it is
 * filed under, amounts in cents summing to `t.amount`. Every per-category sum
 * (budget spent, reports, exports) reads a transaction through this, never
 * through `t.category` directly, so a transaction split across categories is
 * counted the same way everywhere.
 *
 * Copies, so a caller that sorts or edits what it was handed cannot reach
 * into the record. Two parts can name the same category (nothing stops a
 * person picking Groceries twice); a sum over parts is right either way, and
 * `txnShares` adds them together where one row per category is wanted.
 */
export function txnParts(t: Txn): SplitPart[] {
  return t.splits === undefined
    ? [{ category: t.category, amount: t.amount }]
    : t.splits.map((p) => ({ category: p.category, amount: p.amount }));
}

/** Is this row split? `Txn.splits` is absent or real, never `[]`. */
export function isSplit(t: Pick<Txn, 'splits'>): boolean {
  return t.splits !== undefined;
}

/**
 * A transaction as each of its categories sees it: one entry per category,
 * with a Txn standing for that category's SHARE — the row itself when the
 * whole amount is there, a copy carrying only that category's amount when it
 * is split.
 *
 * What a budget line lists as "its" transactions and sums as Spent, and what
 * the No category row lists and sums: a $100 shop split 60/40 shows −$60.00
 * under Groceries and −$40.00 under Household, and each list still adds up to
 * the figure beside it. The copy keeps the row's id, so a tap on it opens the
 * real transaction. Nothing may WRITE a share back to the store.
 */
export function txnShares(t: Txn): { category: string | null; txn: Txn }[] {
  if (t.splits === undefined) return [{ category: t.category, txn: t }];
  const by = new Map<string | null, number>();
  for (const p of t.splits) by.set(p.category, (by.get(p.category) ?? 0) + p.amount);
  return [...by].map(([category, amount]) => ({ category, txn: { ...t, amount } }));
}

/**
 * What is wrong with these parts as a split of `amount`, or null when nothing.
 *
 * The one statement of what a split IS, read by the store (which drops a
 * split that fails it, `normalizeTxn`) and by the form (which says it).
 *
 * The SAME SIGN as the amount, every part, non-zero. Mixed signs would be a
 * real thing to want one day (cash back inside a purchase), but the form
 * types sizes and lets the − button sign them, so the only way a part ends up
 * the other side of zero is the parts above it adding up to more than the
 * whole — which is a mistake to point at, not a split to store.
 */
export function splitProblem(amount: number, parts: readonly SplitPart[]): string | null {
  if (parts.length < 2) return 'A split needs two categories';
  if (amount === 0) return 'There is nothing to split';
  const sign = Math.sign(amount);
  let sum = 0;
  for (const p of parts) {
    if (!Number.isSafeInteger(p.amount)) return 'That is not an amount';
    if (p.amount === 0) return 'Every category needs an amount';
    if (Math.sign(p.amount) !== sign) return 'The other categories come to more than the amount';
    sum += p.amount;
  }
  return sum === amount ? null : 'The categories do not add up to the amount';
}

/**
 * The parts after the amount changes — rule 3: every part but the last keeps
 * its SIZE and takes the amount's sign, and the last is what is left.
 *
 * Null when that leaves the last part at zero or past it, i.e. the other parts
 * already come to the new amount or more. Which of them to cut is a question
 * for a person; `withAmount` says what an edit with nobody to ask does.
 */
export function resplit(parts: readonly SplitPart[], amount: number): SplitPart[] | null {
  const sign = Math.sign(amount);
  const head = parts.slice(0, -1).map((p) => ({ category: p.category, amount: sign * Math.abs(p.amount) }));
  const last = parts[parts.length - 1];
  if (last === undefined) return null;
  const rest = head.reduce((n, p) => n - p.amount, amount);
  const out = [...head, { category: last.category, amount: rest === 0 ? 0 : rest }];
  return splitProblem(amount, out) === null ? out : null;
}

/**
 * A transaction with a new AMOUNT, wherever that comes from without a form —
 * the amount edited in place in a list, or an import that finds the bank has
 * settled a pending row for a different figure.
 *
 * Unsplit, it is just the amount. Split, `resplit`: the last part absorbs the
 * difference. When it cannot (the other parts already come to the new amount
 * or more) the split comes off and the row is left UNFILED — a state every
 * surface already shows as waiting for a category, with the money exactly
 * right — rather than refusing the edit, because the list has no room to say
 * why and an import has nobody to ask. Not touched: the caller stamps it.
 */
export function withAmount(txn: Txn, amount: number): Txn {
  const { splits, ...rest } = txn;
  if (splits === undefined) return { ...txn, amount };
  const parts = resplit(splits, amount);
  return parts === null ? { ...rest, amount, category: null } : { ...rest, amount, category: null, splits: parts };
}

/** One field changed in place on a row — the list's name, amount or category cell. */
export type TxnPatch = { name?: string; amount?: number; category?: string | null };

/**
 * Apply an in-place edit, merge clock and all.
 *
 * The amount goes through `withAmount`, so a split row keeps its parts in
 * step. A CATEGORY picked for a split row files the whole row there and the
 * split comes off — one category is what that cell means — and a row never
 * carries a category and parts at once.
 */
export function patchTxn(txn: Txn, patch: TxnPatch, now: number): Txn {
  let next: Txn = patch.amount === undefined ? txn : withAmount(txn, patch.amount);
  if (patch.name !== undefined) next = { ...next, name: patch.name };
  if (patch.category !== undefined) {
    const { splits: _was, ...rest } = next;
    next = { ...rest, category: patch.category };
  }
  return touch(next, now);
}

/**
 * What a split row's category cell reads: `Split · Groceries, Household`.
 *
 * The names rather than a count, because on a read-only screen the cell is
 * the only place the split is written down at all; a narrow column truncates
 * the tail and still says it is a split. Each category once, in part order.
 */
export function splitLabel(t: Pick<Txn, 'splits'>, nameOf: (category: string | null) => string): string | null {
  if (t.splits === undefined) return null;
  const names = [...new Set(t.splits.map((p) => p.category))].map(nameOf);
  return `Split · ${names.join(', ')}`;
}

/* ---- the form's half: parts as typed ---- */

/** A typed amount with its sign taken off — parts are typed as sizes. */
const unsigned = (text: string): string => text.trim().replace(/^[-\u2212]\s*/, '');

/**
 * The draft's parts in cents, signed by the draft's amount, the last one the
 * remainder; null while the amount or any typed part is not an amount yet.
 *
 * The remainder is computed, never read, so the parts ALWAYS add up: the one
 * mistake left is the typed parts coming to more than the whole, which
 * `splitProblem` names.
 */
export function draftParts(draft: Draft): SplitPart[] | null {
  const parts = draft.splits;
  const amount = parseAmount(draft.amount);
  if (parts === undefined || amount === null) return null;
  const sign = amount < 0 ? -1 : 1;
  const head: SplitPart[] = [];
  for (const p of parts.slice(0, -1)) {
    const typed = unsigned(p.amount);
    const cents = typed === '' ? 0 : parseAmount(typed);
    if (cents === null || cents < 0) return null;
    head.push({ category: p.category, amount: cents === 0 ? 0 : sign * cents });
  }
  const last = parts[parts.length - 1];
  if (last === undefined) return null;
  const rest = head.reduce((n, p) => n - p.amount, amount);
  return [...head, { category: last.category, amount: rest === 0 ? 0 : rest }];
}

/** What the last row shows: the amount less every other part, or null while that is not known. */
export function draftRemainder(draft: Draft): number | null {
  const parts = draftParts(draft);
  return parts === null ? null : parts[parts.length - 1]?.amount ?? null;
}

/**
 * Start splitting: the category it had and the WHOLE amount, then a second
 * category for the rest — which is nothing yet, so the next thing typed into
 * the first row is the thing that moves money into the second.
 */
export function splitDraft(draft: Draft): Draft {
  return {
    ...draft,
    category: null,
    splits: [{ category: draft.category, amount: unsigned(draft.amount) }, { category: null, amount: '' }],
  };
}

/**
 * One more category at the bottom. The row that WAS last stops being the
 * remainder, so what it showed is written down as typed, and the new last row
 * takes over the remainder (nothing, until a row above it is made smaller).
 */
export function addDraftPart(draft: Draft): Draft {
  const parts = draft.splits;
  if (parts === undefined) return draft;
  const rest = draftRemainder(draft);
  const frozen: DraftPart[] = parts.map((p, i) => (
    i === parts.length - 1 ? { category: p.category, amount: rest === null ? '' : amountInput(Math.abs(rest)) } : p));
  return { ...draft, splits: [...frozen, { category: null, amount: '' }] };
}

/**
 * Take a row out; the remainder absorbs what it held. Down to ONE row is no
 * split at all: that row's category becomes the transaction's, and the
 * `splits` key goes, so an un-split draft is the draft it was before.
 */
export function removeDraftPart(draft: Draft, index: number): Draft {
  const parts = draft.splits;
  if (parts === undefined) return draft;
  const left = parts.filter((_, i) => i !== index);
  const { splits: _was, ...rest } = draft;
  if (left.length <= 1) return { ...rest, category: left[0]?.category ?? null };
  return { ...rest, splits: left };
}

/** Change one row's category or typed amount. */
export function setDraftPart(draft: Draft, index: number, patch: Partial<DraftPart>): Draft {
  const parts = draft.splits;
  if (parts === undefined) return draft;
  return { ...draft, splits: parts.map((p, i) => (i === index ? { ...p, ...patch } : p)) };
}

/** The sum, in cents. Integers throughout — see money.ts. */
export function total(txns: readonly Txn[]): number {
  return txns.reduce((sum, t) => sum + t.amount, 0);
}

/**
 * The part of a total the BANK has confirmed — the owner, 2026-09-18.
 *
 * Only rows carrying `cleared`, which is the flag an import sets for
 * everything a statement lists and leaves off everything still pending. Shown
 * beside the account's own total, the gap between the two is what is still in
 * the air: authorizations, a cheque nobody has presented, the row somebody
 * typed in this morning.
 *
 * `t.cleared === true` rather than a truthiness test, deliberately: the field
 * is `true` or ABSENT and never `false`, and a loose test would quietly start
 * counting a row the day something wrote a 0 or an empty string into it.
 */
export function clearedTotal(txns: readonly Txn[]): number {
  return total(txns.filter((t) => t.cleared === true));
}

/** Base-36 milliseconds, zero-padded — see `newId`. */
const TIME_WIDTH = 9;

/**
 * A fresh id: milliseconds in base 36, then randomness.
 *
 * Not `crypto.randomUUID()` — it is absent on some Hermes builds, and an id
 * generator that throws on one of six surfaces is found by a person, not a
 * test.
 *
 * The time prefix is PADDED to a fixed width, and that padding is the whole
 * point: base 36 only sorts lexicographically when every string is the same
 * length. Unpadded, `newId(1000)` is 'rs' and `newId(2000)` is '1jk', so the
 * later id sorts first. Today's timestamps are all 8 characters so it would
 * have looked correct for another thirty years and then quietly stopped — the
 * kind of bug that ships. Nine characters covers every millisecond up to the
 * year 5188, and ids are compared as strings everywhere they are compared.
 */
export function newId(now: number = Date.now(), rand: () => number = Math.random): string {
  let tail = '';
  for (let i = 0; i < 8; i++) tail += Math.floor(rand() * 36).toString(36);
  return now.toString(36).padStart(TIME_WIDTH, '0') + '-' + tail;
}

/* ------------------------------------------------------------------ *
 * The four things you can do to a transaction that already exists.
 *
 * A row is held down and offers, right to left: delete, copy, duplicate,
 * edit. Delete is the destructive one and sits furthest from the thumb's
 * resting place on the left, which is where `edit` — the one people reach
 * for most — goes instead.
 *
 * Everything here is pure and takes its clock and its ids as arguments, for
 * the same reason `makeTxn` does: a test can pin both and get the same object
 * twice.
 * ------------------------------------------------------------------ */

/**
 * A transaction as an editable draft — the inverse of `makeTxn`.
 *
 * The amount goes back through `amountInput`, so what lands in the field is
 * the canonical `-4.50` rather than the raw digits somebody once typed. A
 * form seeded with `1234` would read as $12.34 under the entry rules and
 * silently divide the amount by a hundred on the way in.
 */
export function draftOf(txn: Txn): Draft {
  return {
    name: txn.name,
    description: txn.description,
    amount: amountInput(txn.amount),
    date: txn.date,
    account: txn.account,
    category: txn.category,
    // Unsigned, like every typed part: the amount above holds the sign.
    ...(txn.splits === undefined ? {} : {
      splits: txn.splits.map((p) => ({ category: p.category, amount: amountInput(Math.abs(p.amount)) })),
    }),
  };
}

/**
 * Apply an edited draft to an existing transaction.
 *
 * Keeps `id` and `created` — it is the same transaction, edited, not a new
 * one — and moves the merge clock through `touch` so the edit outranks the
 * copy on every other device. `created` staying put is what keeps the list
 * order stable under an edit that does not change the date.
 */
export function applyDraft(txn: Txn, draft: Draft, now: number): Txn {
  const amount = parseAmount(draft.amount);
  if (amount === null) throw new Error('applyDraft: the draft has not been validated');
  // The old parts come off first, so an edit that un-splits a row leaves NO
  // key behind rather than one holding nothing — see Txn.splits.
  const { splits: _was, ...rest } = txn;
  return touch({
    ...rest,
    name: draft.name.trim(),
    description: draft.description.trim(),
    amount,
    date: draft.date,
    account: draft.account,
    ...filing(draft, amount, 'applyDraft'),
  }, now);
}

/**
 * A second transaction with the same details.
 *
 * A NEW id and a new `created`, because it is a new transaction — the point
 * of duplicating is a second coffee, not a second copy of the first one.
 * Anything else would make the two indistinguishable to the merge, and a
 * duplicate that shared an id would be silently swallowed by it.
 *
 * The DATE is carried over rather than reset to today. Someone duplicating a
 * row is usually entering something that already happened alongside it; a
 * date that quietly jumped would be a wrong number in the ledger, and it is
 * one tap to change.
 */
export function duplicateTxn(txn: Txn, id: string, now: number): Txn {
  return {
    id,
    name: txn.name,
    description: txn.description,
    amount: txn.amount,
    date: txn.date,
    account: txn.account,
    category: txn.category,
    // Split the same way: the second coffee went where the first one did.
    ...(txn.splits === undefined ? {} : { splits: txn.splits.map((p) => ({ ...p })) }),
    // Not the original's place in a hand-made order: it is a new row, and
    // inheriting the position would put two rows in one slot.
    order: 0,
    created: now,
    updated: now,
  };
}

/**
 * A transaction as text, for the clipboard.
 *
 * Tab-separated so it lands in a spreadsheet as four cells, and readable as
 * a line if it does not. The amount is `formatAmount`, the same string the
 * row shows — what is copied is what was on screen.
 */
export function txnText(txn: Txn): string {
  return [txn.date, txn.name, txn.description, formatAmount(txn.amount)].join('\t');
}

/* ------------------------------------------------------------------ *
 * Ordering
 * ------------------------------------------------------------------ */

/** How the list is ordered. A view choice, so it lives in device prefs. */
export type SortMode = 'custom' | 'date' | 'amount';

/**
 * The gap left between neighbours when order is assigned.
 *
 * Sparse on purpose. Dropping a row between two others takes the midpoint of
 * their orders, so one row is rewritten rather than every row after it — and
 * every rewrite is a merge-clock bump that has to cross a network. With a
 * gap of 1024 a list can be rearranged dozens of times in the same spot
 * before the midpoints collide.
 */
export const REORDER_GAP = 1024;

/**
 * Order by date, newest first — the default, and the tiebreak for the others.
 *
 * The id key exists so the order is TOTAL: without it two rows entered in the
 * same millisecond order themselves by input order, which reshuffles between
 * renders and lets two devices disagree about a list they both hold.
 */
function byDate(a: Txn, b: Txn): number {
  return b.date.localeCompare(a.date) || b.created - a.created || a.id.localeCompare(b.id);
}

/**
 * The list, in the order asked for.
 *
 * `amount` compares ABSOLUTE values: a ledger's biggest lines are the ones
 * worth seeing first whichever direction the money went, and sorting signed
 * would bury the largest expense at the bottom under every small credit.
 *
 * `custom` falls back to the date order for any row that has never been
 * dragged, which is what makes "custom remembers" true from the first launch:
 * an untouched list in custom mode looks exactly like the date one.
 */
export function sortTxns(txns: readonly Txn[], mode: SortMode = 'date'): Txn[] {
  const rows = [...txns];
  if (mode === 'amount') {
    return rows.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || byDate(a, b));
  }
  if (mode === 'custom') {
    // Rows never dragged carry order 0 and are separated by the date rule, so
    // a fresh ledger in custom mode is the date ledger until something moves.
    return rows.sort((a, b) => b.order - a.order || byDate(a, b));
  }
  return rows.sort(byDate);
}

/**
 * WHICH WAY a list's `order` runs, because the two lists here disagree.
 *
 * Transactions sort DESCENDING — a bigger `order` draws higher (see
 * `sortTxns`). Budget lines sort ASCENDING — a smaller one draws higher (see
 * core's `linesIn`). That is not a tidy-up waiting to happen: flipping either
 * one would reshuffle every ledger already on a device.
 *
 * It has to be SAID rather than inferred, and saying it is what this type is
 * for. `orderBetween` took no direction until 2026-09-21 and was written for
 * transactions, so every budget-line drag that landed at an END of a list
 * went to the opposite end: dropping a line at the top gave it
 * `below.order + GAP`, which in an ascending list is the BOTTOM. The middle
 * of a list is a midpoint either way, which is why it looked like it worked.
 */
export type OrderDir = 'asc' | 'desc';

/**
 * The order value that puts a row between two neighbours, as DRAWN.
 *
 * `above` and `below` are the rows the dragged one lands between on screen,
 * not in the array — `null` for an end of the list. Returns the midpoint, or
 * a clear step beyond the edge — never an average with a missing side, which
 * is how a dragged row ends up at zero and jumps somewhere nobody asked for.
 *
 * Takes anything that HAS an order, not a Txn: budget lines are dragged by
 * the same gesture and were the second caller. Typed to Txn it would have
 * meant a second copy of the arithmetic, which is exactly the duplication the
 * standing rule is about — and the direction argument is what makes the one
 * copy correct for both.
 */
export function orderBetween(
  above: { order: number } | null,
  below: { order: number } | null,
  dir: OrderDir = 'desc',
): number {
  if (above === null && below === null) return 0;
  // A step BEYOND the edge, in whichever direction puts it there: past the
  // top means a bigger number descending and a smaller one ascending.
  const step = dir === 'desc' ? REORDER_GAP : -REORDER_GAP;
  if (above === null) return (below?.order ?? 0) + step;
  if (below === null) return above.order - step;
  return (above.order + below.order) / 2;
}

/**
 * Move `id` to sit at `index` in the list as currently shown.
 *
 * Takes the VISIBLE list, because a drag is a statement about what is on
 * screen: the person moved a row below the one they can see, not below
 * whatever the raw array happens to hold next.
 *
 * Returns only the row that changed, or null when nothing needs to move —
 * so a drag that ends where it started costs no merge clock and no sync.
 *
 * Generic over the record, for the same reason `orderBetween` is: the Budget
 * tab drags lines with this exact function.
 */
export function reorder<R extends Record_ & { order: number }>(
  shown: readonly R[],
  id: string,
  index: number,
  now: number,
  dir: OrderDir = 'desc',
): R | null {
  const from = shown.findIndex((t) => t.id === id);
  if (from < 0) return null;
  const to = Math.max(0, Math.min(shown.length - 1, index));
  if (from === to) return null;
  const without = shown.filter((t) => t.id !== id);
  const above = without[to - 1] ?? null;
  const below = without[to] ?? null;
  const moved: R | undefined = shown[from];
  if (moved === undefined) return null;
  const order = orderBetween(above, below, dir);
  if (order === moved.order) return null;
  return touch({ ...moved, order }, now);
}

/**
 * The order a row takes when it is dropped ABOVE `beforeId` in `into`.
 *
 * `into` is the destination as DRAWN, in its own order, and the mover is
 * filtered out of it here rather than by every caller — a row dragged within
 * its own section would otherwise be measured against itself and land next
 * to where it already was.
 *
 * `beforeId` of `null` means the END of that list, which is what a drop below
 * the last row and a drop onto an empty section both mean. An id that names
 * nothing left in `into` means the same thing: the row it was aimed at went
 * away mid-drag, and the end is the only honest answer left.
 *
 * This is the other half of `rowslots.ts` — that file turns a boundary into
 * "this section, above that row", and this one turns that into a number.
 */
export function orderAbove<R extends { id: string; order: number }>(
  into: readonly R[],
  moverId: string,
  beforeId: string | null,
  dir: OrderDir = 'desc',
): number {
  /*
   * ALREADY THERE gives back the order it already has, and that one line is
   * what makes "a drag that ends where it started costs nothing" true for
   * the END of a list as well as the middle.
   *
   * Comparing the answer with the current order cannot do it. A drop at the
   * end is `last.order - GAP` — a fresh step beyond the edge, never the
   * number the last row is already carrying — so the row that was ALREADY
   * last came back rewritten, with a merge clock to travel and a sync to
   * pay for, every time a finger wobbled over it. `reorder` never had this
   * because it compares INDEXES before it computes anything; this is the
   * same idea said in terms of the row a drop names.
   */
  const at = into.findIndex((r) => r.id === moverId);
  if (at >= 0 && (beforeId === moverId || (into[at + 1]?.id ?? null) === beforeId)) {
    return into[at]!.order;
  }
  const rest = into.filter((r) => r.id !== moverId);
  const i = beforeId === null ? -1 : rest.findIndex((r) => r.id === beforeId);
  const slot = i < 0 ? rest.length : i;
  return orderBetween(rest[slot - 1] ?? null, rest[slot] ?? null, dir);
}

/**
 * Move a transaction into ANOTHER ACCOUNT, at the slot it was dropped on.
 *
 * The owner, 2026-09-21: "make it possible to drag items between sections and
 * folders". An account is this app's section, so a drag that ends over a
 * different one has to re-file the row as well as re-order it — before
 * today the drag was per-account and the question could not be asked.
 *
 * ONE record comes back, or null when nothing would change: the account is
 * on the transaction itself, so no other row has to move out of the way.
 * Null rather than an unchanged copy, for the reason `reorder` gives — a
 * drag that ends where it started must cost no merge clock and no sync.
 *
 * `txns` is EVERY live transaction, not the destination's: the destination
 * as DRAWN is what decides the order, and only this function knows that a
 * dragged ledger is drawn in custom order (dragging is offered nowhere
 * else — see `sortTxns`).
 */
export function moveTxnTo(
  txns: readonly Txn[], txn: Txn, account: string, beforeId: string | null, now: number,
): Txn | null {
  const into = sortTxns(txns.filter((t) => t.account === account), 'custom');
  const order = orderAbove(into, txn.id, beforeId, 'desc');
  if (txn.account === account && txn.order === order) return null;
  return touch({ ...txn, account, order }, now);
}

/**
 * The categories matching what someone has typed into the picker.
 *
 * A SUBSTRING match, case-insensitive, because people remember "groceries"
 * out of "Food & groceries" — a prefix match would hide the thing they are
 * looking for and look broken. An empty query is everything, not nothing.
 *
 * In core rather than in the picker because it is a rule stated in a
 * sentence, and it was in the component first: the screen was the only place
 * that knew it, so the only way to test it was to drive a dropdown, and the
 * only place it could be wrong was somewhere no unit test could see.
 */
export function filterByName<R extends { name: string }>(rows: readonly R[], query: string): R[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...rows];
  return rows.filter((r) => r.name.toLowerCase().includes(q));
}

export type TxnFilter = {
  query: string;
  /** undefined includes every category, null selects unfiled transactions. */
  category: string | null | undefined;
  status: 'any' | 'cleared' | 'uncleared';
  from: string | null;
  through: string | null;
};

export const EMPTY_TXN_FILTER: TxnFilter = {
  query: '', category: undefined, status: 'any', from: null, through: null,
};

export function hasTxnFilter({ query, category, status, from, through }: TxnFilter): boolean {
  return query.trim() !== '' || category !== undefined || status !== 'any' || from !== null || through !== null;
}

export function validTxnDateRange({ from, through }: Pick<TxnFilter, 'from' | 'through'>): boolean {
  return (from === null || isDay(from)) && (through === null || isDay(through))
    && (from === null || through === null || from <= through);
}

/** All selected criteria apply together. The date endpoints are inclusive. */
export function filterTransactions(txns: readonly Txn[], filter: TxnFilter): Txn[] {
  const { category, status, from, through } = filter;
  const query = filter.query.trim().toLowerCase();
  const wantCleared = status === 'cleared';
  return txns.filter((txn) => !txn.deleted
    && (category === undefined || txnParts(txn).some((p) => p.category === category))
    && (status === 'any' || (txn.cleared === true) === wantCleared)
    && (from === null || txn.date >= from)
    && (through === null || txn.date <= through)
    && (query === '' || txn.name.toLowerCase().includes(query) || txn.description.toLowerCase().includes(query)));
}

/* ------------------------------------------------------------------ *
 * The swipe
 *
 * Thresholds and the two decisions made from them, in core rather than in a
 * gesture handler — they are rules stated in a sentence, and leaving them in
 * the component meant the only way to test them was to drive a finger, which
 * the browser harness cannot do. Three attempts at that produced tests that
 * passed because NOTHING happened, which is the worst kind.
 * ------------------------------------------------------------------ */

/**
 * How far a horizontal drag must go before the row is claimed as a swipe.
 *
 * Fourteen, not six. At six this stole the LONG PRESS on real hardware: a
 * finger held still for 700ms drifts further than that, so the responder took
 * the gesture and the press was cancelled — holding a row did nothing on a
 * phone while every browser test passed, because a mouse does not drift.
 */
export const SWIPE_CLAIM_PX = 14;

/** How far it must travel before letting go arms the delete. */
export const SWIPE_ARM_PX = 96;

/**
 * Should this movement be taken as a swipe rather than left alone?
 *
 * Left only, past the claim distance, and decisively more horizontal than
 * vertical — a list that claims every touch cannot be scrolled, and one that
 * claims a wobble cannot be held.
 */
export function claimsSwipe(dx: number, dy: number): boolean {
  return dx < -SWIPE_CLAIM_PX && Math.abs(dx) > Math.abs(dy) * 2.5;
}

/**
 * Does letting go here ARM the delete, or come to nothing?
 *
 * It was `swipeDeletes`, and the swipe deleted the row outright. The owner,
 * 2026-08-21: a swipe should bring up a delete BUTTON. So the gesture no
 * longer destroys anything — it parks a control that does, and one more tap
 * is what actually deletes.
 *
 * Renamed rather than left alone, because a function still called
 * `swipeDeletes` that no longer deletes is the exact drift between a name and
 * its behaviour that this repo has been bitten by before.
 */
export function swipeArms(dx: number): boolean {
  return dx < -SWIPE_ARM_PX;
}

/** What a tap on a row — or on anything inside one — is asking for. */
export type RowTap = 'dismiss' | 'pick' | 'inline';

/**
 * What does a tap MEAN right now?
 *
 * One rule, consulted by every tappable part of a row, because the bug it
 * fixes was each part answering separately. A parked delete could only be
 * dismissed by tapping the row's own background — and the name, the amount
 * and the date cover nearly all of that background, each with a Pressable of
 * its own that swallowed the tap and opened an editor instead. So the only
 * ways out of an armed delete were to use it or to find the few pixels
 * between two fields. The owner, 2026-08-21: tap to exit the swipe delete.
 *
 * `parked` is whether ANY row has a delete showing, not this one. A tap on a
 * different row has to put it away too: an armed delete is modal in effect,
 * and a tap that lands somewhere else is a decision not to use it.
 *
 * Precedence is the whole content of the rule. Dismissing outranks editing,
 * which is why this cannot live in each caller's `onPress` — three callers
 * meant three chances to get the order wrong, and two of them did.
 */
export function rowTap(parked: boolean, edit: boolean): RowTap {
  if (parked) return 'dismiss';
  return edit ? 'pick' : 'inline';
}

/**
 * What a tap on the SELECTOR DOT does — the same precedence, one case short.
 *
 * The dot is MealMind's, brought over 2026-09-21, and it is drawn on every
 * row at all times rather than only in edit mode. So it has no `edit` case:
 * picking is what it is FOR, and a mode it ignored would be a mode it lied
 * about.
 *
 * `parked` still wins, and that is the whole reason this is here rather than
 * inline in the row. A delete parked by a swipe is the state this app least
 * wants left lying around, so EVERY tap anywhere on the row puts it away
 * first — see `rowTap` and the trap in AGENTS.md about four handlers each
 * answering for themselves. Two targets, two functions, ONE rule written
 * down twice in the same file where the difference is visible.
 */
export function pickTap(parked: boolean): 'dismiss' | 'pick' {
  return parked ? 'dismiss' : 'pick';
}

/**
 * Mark a transaction cleared — on the statement — or not.
 *
 * The owner, 2026-09-15: "add a cleared check box as the far right column in
 * transactions." The flag is stored only as the literal `true` (see
 * Txn.cleared), so clearing it REMOVES the key rather than writing `false`:
 * an uncleared row is byte-identical to one written before the field
 * existed. `touch` moves the merge clock, so the tick travels to the other
 * devices like any edit; a duplicate never inherits it (duplicateTxn builds
 * its row field by field, and a second coffee has not been on any statement).
 */
export function setCleared(txn: Txn, cleared: boolean, now: number): Txn {
  const { cleared: _was, ...rest } = txn;
  return touch(cleared ? { ...rest, cleared: true } : rest, now);
}
