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
import { AppState } from 'react-native';
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
/**
 * When the file changes, AND whenever the app comes back to the foreground.
 *
 * The metadata query only reports a change it sees while the app runs, and
 * the CloudKit copy the browser reads is mirrored only when this phone reads
 * or writes the file. So an edit made on the Mac, or merged in from a peer,
 * reached the browser only at the phone's next cold launch; reading again on
 * every return to the foreground puts it there the next time the phone is
 * opened (the owner, 2026-11-21: "acctmind readonly seems out of date").
 */
export function onRemoteChange(handler: () => void): () => void {
  const off = native.onRemoteChange(handler);
  const sub = AppState.addEventListener('change', (s) => { if (s === 'active') handler(); });
  return () => { off(); sub.remove(); };
}

/** Apple ID sign-in is a browser's only: no state, nothing to start. */
export function appleIdState(): 'signed-in' | 'signed-out' | null { return null; }
export function startSignIn(): boolean { return false; }
export function startSignOut(): boolean { return false; }

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

export function confirmRead(): void {}
