/**
 * ACCOUNT-OPTIONAL builds: the app opens and works with no account, and
 * signing in is only for syncing and sharing (App Store review asks that an
 * app not demand an account it does not need). Off unless a build sets
 * EXPO_PUBLIC_ACCOUNT_OPTIONAL=1; unset, or any other value, is the app
 * exactly as before: no session, the Login screen.
 *
 * This is the ONE place the flag is read. Expo inlines EXPO_PUBLIC_* at build
 * time, and both apps' metro.config.js fold every EXPO_PUBLIC_* value into
 * Metro's cache key, so switching it can never be answered from a warm cache.
 * It is deliberately not in app.json: a build setting, not app metadata.
 *
 * With the flag on and no session the store runs LOCAL MODE (store.tsx): the
 * records live under their own snapshot key on this device, `session` stays
 * null so every screen's existing "no session, no server" guard holds, and no
 * sync, sharing or account request is ever made. Signing in folds the local
 * records into the account (@calmind/core's localmerge.ts) and signing out
 * comes back to an empty local store.
 *
 * Same bytes in CalMind and MealMind (tools/shared-files.json); the apps
 * differ only in the key prefix they pass in.
 */
import { LOCAL_USER } from '@calmind/core';

/** The flag's rule: exactly '1' turns it on. */
export function accountOptionalFrom(value: string | undefined): boolean {
  return value === '1';
}

/** Whether this build lets the app be used without an account. */
export function accountOptional(): boolean {
  // Read as a literal `process.env.EXPO_PUBLIC_…` member so Expo inlines it.
  return accountOptionalFrom(process.env.EXPO_PUBLIC_ACCOUNT_OPTIONAL);
}

/** A snapshot key: `<prefix>.snapshot.<user>@<instance>`. */
export function snapshotKey(prefix: string, user: string, tag: string): string {
  return `${prefix}.snapshot.${user}@${tag}`;
}

/** The local store's key. LOCAL_USER starts with '~', which no username can. */
export function localSnapshotKey(prefix: string, tag: string): string {
  return snapshotKey(prefix, LOCAL_USER, tag);
}

/** Where unreadable local bytes are moved, so starting afresh never writes over them. */
export function damagedKey(key: string, now: number): string {
  return `${key}.damaged.${now}`;
}

/** With no session: local mode when the build allows it, else the Login screen. */
export function modeWithoutSession(optional: boolean): 'local' | 'login' {
  return optional ? 'local' : 'login';
}

/**
 * Whether the app shows the Login screen. Without the flag localMode is never
 * true, so this is `!session`, as it always was; with it, Login is shown only
 * when the person asked to sign in from local mode.
 */
export function showsLogin(s: { session: boolean; localMode: boolean; signInOpen: boolean }): boolean {
  if (s.session) return false;
  return !s.localMode || s.signInOpen;
}
