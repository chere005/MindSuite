/**
 * The shared file in iCloud Drive — the NATIVE half.
 *
 * On a phone this is the Expo module, which reaches the ubiquity container
 * through FileManager and NSFileCoordinator. The `.web.ts` beside this file
 * is the other half: the Tauri Mac shell, which reaches the SAME document by
 * path because it is the web bundle and has no native modules at all.
 *
 * One document, two readers, and neither of them decides anything — see
 * `planSync` in core, and core/src/ubiquity.ts for why a file rather than
 * the key-value store.
 */
import * as native from '../modules/icloud-file';

import type { LedgerAccess, SyncInfo } from '@acctmind/core';
import { fileTimes, markRead, markSaved, onSyncChange } from './syncinfo';

export const available = native.available;
export const pull: typeof native.pull = async () => {
  const text = await native.pull();
  markRead();
  return text;
};
export const push: typeof native.push = async (value) => {
  const ok = await native.push(value);
  if (ok) markSaved();
  return ok;
};
export const onRemoteChange = native.onRemoteChange;

/** CloudKit's Apple ID buttons are a browser's only (icloudfile.web.ts). */
export function signInSlots(): { signIn: string; signOut: string } | null {
  return null;
}

/**
 * The same one-line answer the desktop gives, for the Devices screen.
 *
 * On a phone there is no ambiguity to resolve — the app holds the
 * entitlement, so the container is either there or iCloud is off — but the
 * screen asks one question of whichever surface it is on.
 */
export async function status(): Promise<string> {
  if (!(await native.available())) {
    return 'no iCloud container — signed out, or iCloud Drive is off for AcctMind';
  }
  // The second half is the copy the web app reads (Swift module header).
  const mirror = await native.mirrorStatus();
  return mirror === null ? 'container available' : `container available · ${mirror}`;
}

/** The native apps hold the ledger file themselves: always editable. */
export async function settled(): Promise<void> {}

export function access(): LedgerAccess {
  return { source: 'file', readOnly: false };
}
export function onAccessChange(handler: () => void): () => void {
  return onSyncChange(handler);
}
export function syncInfo(): SyncInfo {
  const t = fileTimes();
  return { source: 'file', readAt: t.readAt, savedAt: t.savedAt, writtenAt: null, signedIn: false };
}
