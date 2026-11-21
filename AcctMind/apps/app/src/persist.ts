/**
 * Where the ledger actually lives: this device, and nowhere else.
 *
 * AsyncStorage is one API across all six surfaces — localStorage in the
 * browser and in both Tauri shells, a native store on iOS and Android — so
 * there is no per-platform branch here to get wrong.
 *
 * The rule this file exists to enforce: **a load that failed must never be
 * saved over.** Core distinguishes an empty store from a damaged one; that
 * distinction is worth nothing if the screen calls `save()` anyway. See
 * `useStore` in App.tsx, which holds the refusal.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { parseStore, serialize, type LoadResult, type Store } from '@acctmind/core';

/**
 * The key carries the store version. A future v2 writes a different key and
 * leaves v1 where it is, so a downgrade finds its own data instead of a file
 * it cannot read.
 */
export const KEY = 'acctmind.store.v1';

export async function load(): Promise<LoadResult> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(KEY);
  } catch (e) {
    // Storage itself being unavailable is not an empty ledger — it is a
    // device that cannot answer. Saying so stops the caller writing.
    return { ok: false, error: `this device could not read its saved data (${String(e)})` };
  }
  return parseStore(raw);
}

/**
 * Write, and let the caller hear about a failure.
 *
 * Deliberately NOT `.catch(() => {})`. A silent write failure is the exact
 * shape of the worst bugs CalMind found: the app says saved, the disk says
 * nothing, and the data is gone at the next launch.
 */
export async function save(store: Store): Promise<void> {
  await AsyncStorage.setItem(KEY, serialize(store));
}

/**
 * The last CloudKit copy a plain browser showed, kept ONLY so it can be shown
 * again when iCloud cannot be reached. A different key from the ledger's: it
 * is never the editable ledger and is never merged into it.
 */
export const COPY_KEY = 'acctmind.copycache.v1';
export type CopyCache = { text: string; writtenAt: number | null; cachedAt: number };

export async function loadCopyCache(): Promise<CopyCache | null> {
  try {
    const raw = await AsyncStorage.getItem(COPY_KEY);
    if (raw === null) return null;
    const v = JSON.parse(raw) as Partial<CopyCache>;
    return typeof v.text === 'string' && typeof v.cachedAt === 'number'
      ? { text: v.text, writtenAt: typeof v.writtenAt === 'number' ? v.writtenAt : null, cachedAt: v.cachedAt }
      : null;
  } catch {
    return null;
  }
}

export async function saveCopyCache(cache: CopyCache): Promise<void> {
  try { await AsyncStorage.setItem(COPY_KEY, JSON.stringify(cache)); } catch { /* a cache is allowed to fail */ }
}

export async function clearCopyCache(): Promise<void> {
  try { await AsyncStorage.removeItem(COPY_KEY); } catch { /* nothing to lose */ }
}
