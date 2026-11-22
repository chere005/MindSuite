/**
 * Split transactions — the owner, 2026-11-21: "add splitting a transaction
 * between multiple categories in a very trivial interface to use".
 *
 * `spec/split.json` is replayed first (the contract a native port would
 * replay too); the rest is every place a per-category number is made, the
 * store and the merge, and the form's helpers.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  STORE_VERSION, addDraftPart, applyDraft, applyImport, autoCategory, budgetSheet, carriedInto, categoryChoices,
  categoryRules, draftOf, draftParts, draftRemainder, duplicateTxn, EMPTY_TXN_FILTER, emptyDraft, filterTransactions,
  makeTxn, mergeStores, monthlyBudgetAmounts, parseStore, patchTxn, planSync, putSetting, removeCategoryDeep,
  removeDraftPart, resplit, sameStore, saveCategoryRule, serialize, setDraftPart, splitDraft, splitLabel,
  splitProblem, txnParts, txnShares, undoTo, unfiledSince, updateTxn, validateDraft, withAmount,
} from '../src/index';
import type { Draft, Line, SplitPart, Store, Txn } from '../src/index';

type Part = [string | null, number];
const parts = (ps: readonly Part[]): SplitPart[] => ps.map(([category, amount]) => ({ category, amount }));
const pairs = (ps: readonly SplitPart[] | null): Part[] | null => ps === null ? null : ps.map((p) => [p.category, p.amount]);

const spec = JSON.parse(readFileSync(new URL('../../../spec/split.json', import.meta.url), 'utf8')) as {
  parts: { name: string; amount: number; category: string | null; splits: Part[] | null; want: Part[] }[];
  problems: [string, number, Part[], string | null][];
  resplit: [string, Part[], number, Part[] | null][];
  draft: [string, string, [string | null, string][], Part[] | null][];
  budget: {
    lines: string[];
    txns: { id: string; amount: number; category: string | null; splits: Part[] | null }[];
    spent: Record<string, number>;
    unfiled: Record<string, number>;
  };
};

const DAY = '2026-09-10';
const txn = (over: Partial<Txn> = {}): Txn => ({
  id: 't1', name: 'Shop', description: '', amount: -10000, date: DAY, account: 'a1',
  category: null, order: 0, created: 100, updated: 100, ...over,
});
const split = (over: Partial<Txn> = {}): Txn =>
  txn({ splits: parts([['groc', -6000], ['home', -4000]]), ...over });
const line = (id: string, category = 'food'): Line =>
  ({ id, name: id, category, budget: 0, needs: 0, snoozed: false, order: 0, created: 1, updated: 1 });
const ACCT = { id: 'a1', name: 'Account', color: '#4c8bf0', order: 0, created: 1, updated: 1 };
const FOOD = { id: 'food', name: 'Food', color: '#4c8bf0', order: 0, created: 1, updated: 1 };
const HOUSE = { id: 'house', name: 'House', color: '#4c8bf0', order: 1, created: 1, updated: 1 };
const store = (txns: Txn[]): Store => ({
  v: STORE_VERSION, txns, accounts: [ACCT], categories: [FOOD, HOUSE],
  lines: [line('groc'), line('home', 'house')], budgets: [], settings: [],
});
const draft = (amount: string, ps: [string | null, string][]): Draft =>
  ({ ...emptyDraft(DAY, 'a1'), name: 'Shop', amount, splits: ps.map(([category, a]) => ({ category, amount: a })) });

describe('spec/split.json', () => {
  for (const c of spec.parts) {
    it(`parts: ${c.name}`, () => {
      const t = txn({ amount: c.amount, category: c.category, ...(c.splits ? { splits: parts(c.splits) } : {}) });
      expect(pairs(txnParts(t))).toEqual(c.want);
    });
  }
  it('problems: what a split is', () => {
    for (const [name, amount, ps, want] of spec.problems) expect(splitProblem(amount, parts(ps)), name).toBe(want);
  });
  it('resplit: the last part takes the difference', () => {
    for (const [name, ps, amount, want] of spec.resplit) expect(pairs(resplit(parts(ps), amount)), name).toEqual(want);
  });
  it('draft: the last row is the remainder', () => {
    for (const [name, amount, ps, want] of spec.draft) expect(pairs(draftParts(draft(amount, ps))), name).toEqual(want);
  });
  it('budget: Spent and the No category row read parts', () => {
    const b = spec.budget;
    const txns = b.txns.map((r) => txn({
      id: r.id, amount: r.amount, category: r.category, ...(r.splits ? { splits: parts(r.splits) } : {}),
    }));
    const lines = b.lines.map((id) => line(id));
    const { amounts } = monthlyBudgetAmounts({ budgets: [] }, '2026-09', lines, txns, null);
    expect(Object.fromEntries(b.lines.map((id) => [id, amounts.get(id)!.spent]))).toEqual(b.spent);
    expect(Object.fromEntries(unfiledSince(txns).map((t) => [t.id, t.amount]))).toEqual(b.unfiled);
  });
});

describe('the store', () => {
  it('transactions written before splits read back byte for byte, with no splits key anywhere', () => {
    const rows = [txn({ category: 'groc' }), txn({ id: 't2', cleared: true }), txn({ id: 't3', deleted: true })];
    const r = parseStore(serialize(store(rows)));
    if (!r.ok) throw new Error(r.error);
    expect(JSON.stringify(r.store.txns)).toBe(JSON.stringify(rows));
    for (const t of r.store.txns) expect('splits' in t).toBe(false);
  });

  it('a split round-trips, and its category reads null whatever was stored beside it', () => {
    const raw = serialize(store([{ ...split(), category: 'groc' }]));
    const r = parseStore(raw);
    if (!r.ok) throw new Error(r.error);
    expect(r.store.txns[0]!.category).toBeNull();
    expect(pairs(r.store.txns[0]!.splits!)).toEqual([['groc', -6000], ['home', -4000]]);
  });

  it('a split that is not one is dropped, never the row: it reads unsplit and unfiled', () => {
    for (const bad of [
      [['groc', -6000], ['home', -3000]],     // does not add up
      [['groc', -10000]],                      // one part
      [['groc', -12000], ['home', 2000]],      // the wrong sign
      [['groc', -6000.5], ['home', -3999.5]],  // floats
      'groc',                                  // not a list
    ]) {
      const r = parseStore(JSON.stringify({ ...store([]), txns: [{ ...txn(), splits: Array.isArray(bad) ? parts(bad as Part[]) : bad }] }));
      if (!r.ok) throw new Error(r.error);
      expect(r.dropped, JSON.stringify(bad)).toBe(0);
      expect(r.store.txns[0]!.amount).toBe(-10000);
      expect('splits' in r.store.txns[0]!).toBe(false);
      expect(r.store.txns[0]!.category).toBeNull();
    }
  });

  it('a part filed under a line the store does not have goes unfiled; the others stay', () => {
    const r = parseStore(serialize(store([split({ splits: parts([['groc', -6000], ['gone', -4000]]) })])));
    if (!r.ok) throw new Error(r.error);
    expect(pairs(r.store.txns[0]!.splits!)).toEqual([['groc', -6000], [null, -4000]]);
  });

  it('deleting a category unfiles only the parts that were in it, and stamps the row', () => {
    const next = removeCategoryDeep(store([split(), txn({ id: 'plain', category: 'groc' })]), 'house', 500);
    const t = next.txns.find((x) => x.id === 't1')!;
    expect(pairs(t.splits!)).toEqual([['groc', -6000], [null, -4000]]);
    expect(t.updated).toBe(500);
    expect(next.txns.find((x) => x.id === 'plain')!.updated).toBe(100);   // not in the category: untouched
  });

  it('undo does not stamp a split row whose parts were merely rebuilt', () => {
    const before = store([split()]);
    const rebuilt = parseStore(serialize(before));
    if (!rebuilt.ok) throw new Error(rebuilt.error);
    const now = { ...rebuilt.store, txns: [...rebuilt.store.txns, txn({ id: 'new' })] };
    const undone = undoTo(now, rebuilt.store, 900);
    expect(undone.txns.find((t) => t.id === 't1')!.updated).toBe(100);
  });
});

describe('the merge', () => {
  // The same row on two devices: filed whole on one written before splits
  // existed (raw JSON, no key), split later on the other.
  const before = JSON.stringify({ ...store([txn({ category: 'groc' })]), settings: undefined });
  const after = store([split({ updated: 200 })]);

  it('a split made later wins over a copy written before the field existed, both ways round', () => {
    const r = parseStore(before);
    if (!r.ok) throw new Error(r.error);
    for (const merged of [mergeStores(r.store, after), mergeStores(after, r.store)]) {
      const t = merged.txns[0]!;
      expect(t.category).toBeNull();
      expect(pairs(t.splits!)).toEqual([['groc', -6000], ['home', -4000]]);
      const back = parseStore(serialize(merged));
      expect(back.ok && sameStore(back.store, merged)).toBe(true);
    }
  });

  it('an un-split made later wins too, and leaves no key behind', () => {
    const unsplit = applyDraft(after.txns[0]!, { ...draftOf(after.txns[0]!), splits: undefined, category: 'groc' }, 300);
    const merged = mergeStores(after, updateTxn(after, unsplit));
    expect('splits' in merged.txns[0]!).toBe(false);
    expect(merged.txns[0]!.category).toBe('groc');
  });

  it("an older build's copy, which dropped the key without editing, never takes the split away", () => {
    // What an old device holds after loading `after`: same clock, no parts.
    const { splits: _gone, ...stripped } = after.txns[0]!;
    const old = { ...after, txns: [stripped] };
    const plan = planSync(after, serialize(old), 1000);
    expect(pairs(plan.store.txns[0]!.splits!)).toEqual([['groc', -6000], ['home', -4000]]);
    expect(plan.save).toBe(false);
    expect(plan.publish).not.toBeNull();   // and the file gets the parts back
    // Hearing its own write back is not news.
    expect(planSync(after, serialize(after), 1000).reason).toBe('already-agreed');
  });
});

describe('every per-category number reads parts', () => {
  it('Spent, the per-line list (shares) and carry', () => {
    const txns = [split(), split({ id: 'old', date: '2026-08-05', splits: parts([['groc', -1000], ['home', -500]]), amount: -1500 })];
    const { amounts } = monthlyBudgetAmounts({ budgets: [] }, '2026-09', [line('groc'), line('home')], txns, null);
    expect(amounts.get('groc')!.spent).toBe(-6000);
    expect(amounts.get('home')!.txns.map((t) => [t.id, t.amount])).toEqual([['t1', -4000]]);
    const carry = carriedInto({ budgets: [] }, '2026-09', [line('groc'), line('home')], txns);
    expect([carry.get('groc'), carry.get('home')]).toEqual([-1000, -500]);
  });

  it('the wide sheet lists a line its share of a split, so the list adds up to Spent', () => {
    const sheet = budgetSheet(store([split()]), '2026-09', null);
    expect(sheet.spending('groc').map((t) => t.amount)).toEqual([-6000]);
    expect(sheet.groups.flatMap((g) => g.lines).find((l) => l.line.id === 'home')!.spent).toBe(-4000);
  });

  it('a share keeps the row itself when the whole amount is there', () => {
    const plain = txn({ category: 'groc' });
    expect(txnShares(plain)[0]!.txn).toBe(plain);
    // Two parts on one line are one share.
    expect(txnShares(split({ splits: parts([['groc', -6000], ['groc', -4000]]) })).map((s) => [s.category, s.txn.amount]))
      .toEqual([['groc', -10000]]);
  });

  it('a fully filed split is not waiting for a category; its unfiled part is', () => {
    expect(unfiledSince([split()])).toEqual([]);
    const half = split({ splits: parts([['groc', -6000], [null, -4000]]) });
    expect(unfiledSince([half]).map((t) => [t.id, t.amount])).toEqual([['t1', -4000]]);
  });

  it('the category filter finds a split under each of its categories', () => {
    const rows = [split(), txn({ id: 'plain', category: 'home' }), txn({ id: 'loose' })];
    const by = (category: string | null) => filterTransactions(rows, { ...EMPTY_TXN_FILTER, category }).map((t) => t.id);
    expect(by('groc')).toEqual(['t1']);
    expect(by('home')).toEqual(['t1', 'plain']);
    expect(by(null)).toEqual(['loose']);
  });

  it('category choices count a split once for each line it uses', () => {
    const s = store([split(), split({ id: 't2' }), txn({ id: 't3', category: 'groc' })]);
    expect(categoryChoices(s).slice(0, 2).map((c) => c.id)).toEqual(['groc', 'home']);
  });

  it('a category rule never files a split row, though its category is null', () => {
    const s0 = store([split({ name: 'Grocery store' }), txn({ id: 'loose', name: 'Grocery store' })]);
    const s1 = { ...s0, settings: putSetting(s0, 'categoryMatch:grocery', 'groc', 50) };
    expect(autoCategory(s1.txns[0]!, categoryRules(s1))).toBeNull();
    const filed = saveCategoryRule(s0, 'grocery', 'groc', 500);
    expect(filed.txns.find((t) => t.id === 't1')).toEqual(s0.txns[0]);
    expect(filed.txns.find((t) => t.id === 'loose')!.category).toBe('groc');
  });
});

describe('editing a split amount: the last part absorbs it', () => {
  it('in place, through patchTxn, with the clock moved', () => {
    const t = patchTxn(split(), { amount: -12000 }, 500);
    expect(pairs(t.splits!)).toEqual([['groc', -6000], ['home', -6000]]);
    expect([t.amount, t.category, t.updated]).toEqual([-12000, null, 500]);
  });

  it('when the others already come to more, the split comes off and the row is unfiled', () => {
    const t = withAmount(split(), -5000);
    expect('splits' in t).toBe(false);
    expect([t.amount, t.category]).toEqual([-5000, null]);
  });

  it('a category picked in place files the whole row and ends the split', () => {
    const t = patchTxn(split(), { category: 'groc' }, 500);
    expect('splits' in t).toBe(false);
    expect(t.category).toBe('groc');
  });

  it('an import settling a split pending row for a new figure keeps the split', () => {
    const s = store([split({ description: 'POS SHOP', date: '2026-09-10' })]);
    const row = { date: '2026-09-11', description: 'POS SHOP', amount: -11000, cleared: true };
    const next = applyImport(s, 'a1', { adding: [], updating: [{ txn: s.txns[0]!, row }], removing: [], missing: [] } as never, 600);
    expect(pairs(next.txns[0]!.splits!)).toEqual([['groc', -6000], ['home', -5000]]);
    expect(next.txns[0]!.cleared).toBe(true);
  });
});

describe('the form', () => {
  it('Split starts with the category it had and the whole amount, then an empty second row', () => {
    const d = splitDraft({ ...emptyDraft(DAY, 'a1', 'groc'), name: 'Shop', amount: '-100.00' });
    expect(d.category).toBeNull();
    expect(d.splits).toEqual([{ category: 'groc', amount: '100.00' }, { category: null, amount: '' }]);
    expect(draftRemainder(d)).toBe(0);
    // Not valid until money reaches the second row.
    expect(validateDraft(d).splits).toBe('Every category needs an amount');
    const typed = setDraftPart(d, 0, { amount: '60.00' });
    expect(draftRemainder(typed)).toBe(-4000);
    expect(validateDraft(typed)).toEqual({});
  });

  it('typed parts that come to more than the amount are said, not saved', () => {
    expect(validateDraft(draft('-100.00', [['groc', '120.00'], ['home', '']])).splits)
      .toBe('The other categories come to more than the amount');
    expect(validateDraft(draft('-100.00', [['groc', '1.005'], ['home', '']])).splits).toBe('That is not an amount');
    // A bad total is reported once, on the total.
    expect(validateDraft(draft('x', [['groc', '60'], ['home', '']]))).toEqual({ amount: 'That is not an amount' });
  });

  it('+ Add category writes the old remainder down and starts a new one', () => {
    const d = addDraftPart(draft('-100.00', [['groc', '60.00'], ['home', '']]));
    expect(d.splits).toEqual([
      { category: 'groc', amount: '60.00' }, { category: 'home', amount: '40.00' }, { category: null, amount: '' },
    ]);
    expect(draftRemainder(setDraftPart(d, 1, { amount: '25.00' }))).toBe(-1500);
  });

  it('removing a row gives its money to the remainder; down to one row is no split at all', () => {
    const three = draft('-100.00', [['groc', '60.00'], ['home', '25.00'], ['fun', '']]);
    expect(pairs(draftParts(removeDraftPart(three, 1)))).toEqual([['groc', -6000], ['fun', -4000]]);
    const one = removeDraftPart(removeDraftPart(three, 2), 0);
    expect('splits' in one).toBe(false);
    expect(one.category).toBe('home');
  });

  it('saves as a split with a null category, and opens again as the same parts', () => {
    const t = makeTxn(draft('-100.00', [['groc', '60.00'], ['home', '']]), 'n1', 5);
    expect([t.category, pairs(t.splits!)]).toEqual([null, [['groc', -6000], ['home', -4000]]]);
    expect(draftOf(t).splits).toEqual([{ category: 'groc', amount: '60.00' }, { category: 'home', amount: '40.00' }]);
    expect(applyDraft(t, draftOf(t), 6)).toEqual({ ...t, updated: 6 });
  });

  it('an unsplit row saves with NO splits key, and an edit that un-splits removes it', () => {
    expect('splits' in makeTxn({ ...emptyDraft(DAY, 'a1', 'groc'), name: 'x', amount: '-1.00' }, 'n', 1)).toBe(false);
    const un = applyDraft(split(), { ...draftOf(split()), splits: undefined, category: 'home' }, 300);
    expect('splits' in un).toBe(false);
    expect(un.category).toBe('home');
  });

  it('changing the amount in the form moves only the last row', () => {
    const t = applyDraft(split(), { ...draftOf(split()), amount: '-150.00' }, 300);
    expect(pairs(t.splits!)).toEqual([['groc', -6000], ['home', -9000]]);
  });

  it('refuses to build a row from a split it would have to invent', () => {
    expect(() => makeTxn(draft('-100.00', [['groc', '120.00'], ['home', '']]), 'n', 1)).toThrow(/validated/);
  });

  it('a duplicate is split the same way, in its own copy of the parts', () => {
    const d = duplicateTxn(split(), 'd1', 9);
    expect(d.splits).toEqual(split().splits);
    expect(d.splits).not.toBe(split().splits);
  });

  it('the list says Split and the categories, each once', () => {
    const name = (id: string | null) => (id === null ? 'No Category' : id === 'groc' ? 'Groceries' : 'Household');
    expect(splitLabel(split(), name)).toBe('Split · Groceries, Household');
    expect(splitLabel(split({ splits: parts([['groc', -1], ['groc', -2], [null, -3]]), amount: -6 }), name))
      .toBe('Split · Groceries, No Category');
    expect(splitLabel(txn({ category: 'groc' }), name)).toBeNull();
  });
});
