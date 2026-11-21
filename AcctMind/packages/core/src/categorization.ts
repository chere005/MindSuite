import { RECONCILE_NAME } from './budget';
import { touch } from './merge';
import { putSetting } from './store';
import { DESC_MAX } from './txn';
import { INCOME, INCOME_NAME, type Line, type Store, type Txn } from './types';

export type CategoryChoice = Pick<Line, 'id' | 'name' | 'category'>;

type HasCategoryLines = Pick<Store, 'categories' | 'lines'>;

function selectableLines(store: HasCategoryLines): Line[] {
  const groups = new Set(store.categories.filter((category) => !category.deleted).map((category) => category.id));
  return store.lines.filter((line) => !line.deleted && groups.has(line.category));
}

/** Rank choices by live transactions across the ledger, preserving the input order for ties. */
export function categoryChoices(store: HasCategoryLines & Pick<Store, 'txns'>): CategoryChoice[] {
  const counts = new Map<string, number>();
  for (const { category, deleted } of store.txns) {
    if (category !== null && !deleted) counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const count = (choice: CategoryChoice) => counts.get(choice.id) ?? 0;
  return [{ id: INCOME, name: INCOME_NAME, category: '' }, ...selectableLines(store)]
    .sort((a, b) => count(b) - count(a));
}

const RULE_PREFIX = 'categoryMatch:';
const matchText = (text: string): string => text.trim().toLowerCase();

export type CategoryRule = { match: string; category: string };

export function categoryRules(store: HasCategoryLines & Pick<Store, 'settings'>): CategoryRule[] {
  const targets = new Set([INCOME, ...selectableLines(store).map((line) => line.id)]);
  return (store.settings ?? [])
    .filter((row) => !row.deleted && row.id.startsWith(RULE_PREFIX) && targets.has(row.value))
    .map((row) => ({ match: row.id.slice(RULE_PREFIX.length), category: row.value }))
    .filter((rule) => rule.match !== '')
    .sort((a, b) => b.match.length - a.match.length || (a.match < b.match ? -1 : 1));
}

type Matchable = Pick<Txn, 'name' | 'description' | 'category' | 'deleted'>;

function matchingRule(txn: Matchable, rules: readonly CategoryRule[]): CategoryRule | undefined {
  if (txn.deleted || txn.category !== null || txn.name.trim() === RECONCILE_NAME) return undefined;
  const name = matchText(txn.name);
  const description = matchText(txn.description);
  return rules.find(({ match }) => name.includes(match) || description.includes(match));
}

export function autoCategory(txn: Matchable, rules: readonly CategoryRule[]): string | null {
  return matchingRule(txn, rules)?.category ?? txn.category;
}

export function canSaveCategoryRule(text: string, category: string | null): boolean {
  const match = matchText(text);
  return match !== '' && match.length <= DESC_MAX && category !== null;
}

/** Saving a rule also files existing unassigned rows that this rule wins. */
export function saveCategoryRule(store: Store, text: string, category: string, now: number): Store {
  if (!canSaveCategoryRule(text, category)) return store;
  if (category !== INCOME && !selectableLines(store).some((line) => line.id === category)) return store;
  const match = matchText(text);
  const next = { ...store, settings: putSetting(store, RULE_PREFIX + match, category, now) };
  const rules = categoryRules(next);
  return {
    ...next,
    txns: store.txns.map((txn) => matchingRule(txn, rules)?.match === match
      ? touch({ ...txn, category }, now)
      : txn),
  };
}

export function removeCategoryRule(store: Store, match: string, now: number): Store {
  return { ...store, settings: putSetting(store, RULE_PREFIX + match, '', now) };
}
