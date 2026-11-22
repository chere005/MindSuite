import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  acceptCategory, applyDraft, applyImport, autoCategoryAssignment, categoryChoices, categoryRules, draftOf, emptyStore,
  makeTxn, mergeStores, parseStore, patchTxn, planImport, quickDraft, removeCategoryRule, saveCategoryRule,
  serialize, INCOME, type Line, type Store, type Txn,
} from '../src/index';

const spec = JSON.parse(readFileSync(new URL('../../../spec/categorization.json', import.meta.url), 'utf8')) as {
  matches: [string, string, string | null, string | null, boolean][];
  frequency: { lines: string[]; filed: (string | null)[]; deleted: string[]; order: string[] };
  hiddenLines: { line: string; parent: 'missing' | 'deleted' }[];
};
const line = (id: string): Line => ({
  id, name: id, category: 'c1', budget: 0, needs: 0, snoozed: false, order: 0, created: 1, updated: 1,
});
const txn = (id: string, patch: Partial<Txn> = {}): Txn => ({
  id, name: id, description: '', amount: -50, date: '2026-11-21', account: 'a1',
  category: null, order: 0, created: 1, updated: 20, ...patch,
});
const store = (): Store => ({
  ...emptyStore(),
  accounts: [{ id: 'a1', name: 'Checking', color: '#4c8bf0', order: 0, created: 1, updated: 1 }],
  categories: [{ id: 'c1', name: 'Expenses', color: '#4c8bf0', order: 0, created: 1, updated: 1 }],
  lines: spec.frequency.lines.map(line),
});

it('matches literal names and descriptions, with longer rules taking precedence', () => {
  const broad = saveCategoryRule(store(), '  SHOP ', 'food', 10);
  const specific = saveCategoryRule(broad, 'Book Shop', 'books', 11);
  const rules = categoryRules(specific);
  for (const [name, description, category, want, review] of spec.matches) {
    expect(autoCategoryAssignment({ name, description, category }, rules), name)
      .toEqual({ category: want, ...(review ? { categoryNeedsReview: true } : {}) });
  }
});

it('uses live filing counts and keeps the existing order between ties', () => {
  const { filed, deleted, order } = spec.frequency;
  const txns = [
    ...filed.map((category, i) => txn(String(i), { category })),
    ...deleted.map((category, i) => txn(`d${i}`, { category, deleted: true })),
  ];
  expect(categoryChoices({ ...store(), txns }).map((choice) => choice.id))
    .toEqual(order.map((id) => id === 'income' ? INCOME : id));
});

it('excludes lines under deleted or missing categories from pickers and rules', () => {
  const initial = store();
  const parent = initial.categories[0]!;
  const base = {
    ...initial,
    categories: [...initial.categories, { ...parent, id: 'deleted', deleted: true as const }],
    lines: [...initial.lines, ...spec.hiddenLines.map(({ line: id, parent }) => ({ ...line(id), category: parent }))],
    settings: spec.hiddenLines.map(({ line: id }) => ({ id: `categoryMatch:${id}`, value: id, created: 1, updated: 1 })),
  };
  expect(categoryChoices(base).map(({ id }) => id)).toEqual([INCOME, ...spec.frequency.lines]);
  expect(categoryRules(base)).toEqual([]);
  expect(saveCategoryRule(base, 'Shop', spec.hiddenLines[0]!.line, 20)).toBe(base);
});

it('files existing unassigned transactions and persists rules for later imports', () => {
  const base = {
    ...store(), txns: [txn('before', { name: 'Shop' }), txn('manual', { name: 'Shop', category: 'books' }),
      txn('deleted', { name: 'Shop', deleted: true })],
  };
  const next = saveCategoryRule(base, 'shop', 'food', 10);
  expect(next.txns.map((entry) => entry.category)).toEqual(['food', 'books', null]);
  expect(next.txns.map((entry) => entry.categoryNeedsReview)).toEqual([true, undefined, undefined]);
  expect(next.txns[0]?.updated).toBe(21);
  const loaded = parseStore(serialize(next));
  if (!loaded.ok) throw new Error(loaded.error);
  expect(loaded.store.txns[0]?.categoryNeedsReview).toBe(true);
  const plan = planImport(loaded.store, 'a1', [
    { date: '2026-11-22', amount: -500, description: 'GROCERY SHOP', cleared: true },
  ], 'add');
  const imported = applyImport(loaded.store, 'a1', plan, 25, () => 'new');
  expect(imported.txns.find((entry) => entry.id === 'new')).toMatchObject({ category: 'food', categoryNeedsReview: true });
  const removed = removeCategoryRule(imported, 'shop', 9);
  expect(categoryRules(mergeStores(imported, removed))).toEqual([]);
  const deletedLine = { ...next, lines: next.lines.map((l) => l.id === 'food' ? { ...l, deleted: true as const } : l) };
  expect(categoryRules(deletedLine)).toEqual([]);
});

it('accepts a suggestion once, syncs the approval, and keeps the same rules', () => {
  const before = saveCategoryRule({ ...store(), txns: [txn('Shop')] }, 'shop', 'food', 10);
  const suggestion = before.txns[0]!;
  expect(acceptCategory(before, { ...suggestion, category: 'books' }, 11)).toBe(before);
  const accepted = acceptCategory(before, suggestion, 11);
  expect(accepted.txns[0]).toMatchObject({ category: 'food', updated: 22 });
  expect(accepted.txns[0]).not.toHaveProperty('categoryNeedsReview');
  expect(accepted.settings).toBe(before.settings);
  expect(acceptCategory(accepted, suggestion, 12)).toBe(accepted);
  expect(mergeStores(before, accepted).txns[0]).toEqual(accepted.txns[0]);
});

it('keeps a suggestion through other edits; changing or splitting the category resolves it', () => {
  const before = saveCategoryRule(store(), 'shop', 'food', 10);
  const fields = { date: '2026-11-22', name: 'Shop', category: '', amount: '100' };
  const ctx = { account: 'a1', choices: categoryChoices(before), rules: categoryRules(before), mode: 'cents' as const };
  const auto = makeTxn(quickDraft(fields, ctx).draft, 'auto', 11);
  const manual = makeTxn(quickDraft({ ...fields, category: 'books' }, ctx).draft, 'manual', 11);
  expect(auto).toMatchObject({ category: 'food', categoryNeedsReview: true });
  expect(manual).toMatchObject({ category: 'books' });
  expect(manual).not.toHaveProperty('categoryNeedsReview');
  const draft = draftOf(auto);
  expect(applyDraft(auto, { ...draft, name: 'Shop, renamed' }, 12).categoryNeedsReview).toBe(true);
  expect(applyDraft(auto, { ...draft, category: 'books' }, 13)).not.toHaveProperty('categoryNeedsReview');
  expect(applyDraft(auto, { ...draft, splits: [
    { category: 'food', amount: '0.60' }, { category: 'books', amount: '' },
  ] }, 13)).not.toHaveProperty('categoryNeedsReview');
  expect(patchTxn(auto, { category: null }, 12)).not.toHaveProperty('categoryNeedsReview');
});
