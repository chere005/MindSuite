/**
 * The handful of choices a person makes about the app rather than about the
 * ledger — right now, exactly one.
 *
 * Kept in its OWN storage key, deliberately. Folding a preference into the
 * store would make it a thing that merges: two devices would argue about
 * which one has the `.00` button on, and a setting would travel between them
 * as though it were a transaction. It is not data, it is how this device's
 * keyboard behaves, and it stays here.
 *
 * Every read is defensive. A missing or damaged preferences file is not a
 * reason to stop — unlike the store, where a bad read means the only copy is
 * in doubt, a bad preference just means the default.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AmountMode, SortMode } from '@acctmind/core';

const KEY = 'acctmind.prefs.v1';

export type Prefs = {
  /** How bare digits are read when no `.` has been typed. */
  amountMode: AmountMode;
  /**
   * How the list is ordered. A VIEW choice, so it lives here — unlike the
   * custom order itself, which is a decision about the ledger and rides on
   * the records where both devices can see it.
   */
  sort: SortMode;
  /** Accounts folded shut, by id. Also a view choice. */
  collapsed: string[];
  /**
   * The selected Budget tab month and the local calendar month when it was picked.
   *
   * A view choice, so it lives here rather than on the records: which month
   * you were last looking at is about this device, while the amounts inside
   * it are the ledger's and sync.
   *
   * It had a `budgetView` beside it from 2026-09-16 — 'all', 'month', or a
   * named view's id — until the owner took the dropdown out on 2026-09-21
   * ("always have a month selected"). A device that saved one still has the
   * key in its file; nothing reads it, and the next save drops it.
   */
  budgetSelection: { month: string; selectedIn: string } | null;
};

/** What a device that has never chosen anything gets. */
export const DEFAULTS: Prefs = { amountMode: 'cents', sort: 'date', collapsed: [], budgetSelection: null };

export async function loadPrefs(): Promise<Prefs> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw === null) return DEFAULTS;
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) return DEFAULTS;
    const mode = (data as Record<string, unknown>)['amountMode'];
    // Only the two known values. Anything else — an older build, a hand-edited
    // file — falls back rather than putting the field into a state no code
    // here understands.
    const sort = (data as Record<string, unknown>)['sort'];
    const collapsed = (data as Record<string, unknown>)['collapsed'];
    const selection = (data as Record<string, unknown>)['budgetSelection'];
    const { month, selectedIn } = typeof selection === 'object' && selection !== null
      ? selection as Record<string, unknown> : {};
    return {
      amountMode: mode === 'whole' ? 'whole' : 'cents',
      sort: sort === 'custom' || sort === 'amount' ? sort : 'date',
      collapsed: Array.isArray(collapsed) ? collapsed.filter((c): c is string => typeof c === 'string') : [],
      // Old preferences recorded the viewed month without when it was picked.
      budgetSelection: typeof month === 'string' && typeof selectedIn === 'string'
        ? { month, selectedIn } : null,
    };
  } catch {
    return DEFAULTS;
  }
}

/** Never throws. A preference that would not save is not worth an error. */
export async function savePrefs(prefs: Prefs): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // The choice holds for this run and is forgotten. Nothing is lost that
    // one tap does not restore.
  }
}
