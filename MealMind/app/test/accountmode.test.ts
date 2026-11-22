import { afterEach, describe, expect, test, vi } from 'vitest';
import { USERNAME_PATTERN } from '@calmind/core';
import {
  accountOptional,
  accountOptionalFrom,
  damagedKey,
  localSnapshotKey,
  modeWithoutSession,
  showsLogin,
  snapshotKey,
} from '../src/accountmode';

// The account-optional build flag and the decisions that hang off it. The
// record merge itself is core's (packages/mind-core/test/localmerge.test.ts).

describe('the flag', () => {
  afterEach(() => vi.unstubAllEnvs());

  test('only exactly "1" turns it on', () => {
    expect(accountOptionalFrom('1')).toBe(true);
    for (const v of [undefined, '', '0', 'true', 'yes', ' 1', '1 ']) expect(accountOptionalFrom(v)).toBe(false);
  });

  test('is read from EXPO_PUBLIC_ACCOUNT_OPTIONAL and is off when unset', () => {
    vi.stubEnv('EXPO_PUBLIC_ACCOUNT_OPTIONAL', '');
    expect(accountOptional()).toBe(false);
    vi.stubEnv('EXPO_PUBLIC_ACCOUNT_OPTIONAL', '1');
    expect(accountOptional()).toBe(true);
  });
});

describe('keys', () => {
  test('an account key is unchanged by local mode', () => {
    expect(snapshotKey('calmind', 'owner_1', 'host_calmind')).toBe('calmind.snapshot.owner_1@host_calmind');
    expect(snapshotKey('mealmind', 'owner_1', 'host_calmind')).toBe('mealmind.snapshot.owner_1@host_calmind');
  });

  test('the local key can never be an account key', () => {
    const local = localSnapshotKey('calmind', 'host_calmind');
    expect(local).toBe('calmind.snapshot.~local@host_calmind');
    const user = local.slice('calmind.snapshot.'.length, local.indexOf('@'));
    expect(USERNAME_PATTERN.test(user)).toBe(false);
    expect(localSnapshotKey('mealmind', 't')).toBe('mealmind.snapshot.~local@t');
  });

  test('damaged bytes go to a key of their own, never back over the store', () => {
    const k = localSnapshotKey('calmind', 't');
    expect(damagedKey(k, 5)).toBe(`${k}.damaged.5`);
    expect(damagedKey(k, 5)).not.toBe(damagedKey(k, 6));
  });
});

describe('what the app shows', () => {
  test('flag off: no session is the Login screen, exactly as before', () => {
    expect(modeWithoutSession(false)).toBe('login');
    expect(showsLogin({ session: false, localMode: false, signInOpen: false })).toBe(true);
    expect(showsLogin({ session: true, localMode: false, signInOpen: false })).toBe(false);
  });

  test('flag on: local mode, and Login only when asked for', () => {
    expect(modeWithoutSession(true)).toBe('local');
    expect(showsLogin({ session: false, localMode: true, signInOpen: false })).toBe(false);
    expect(showsLogin({ session: false, localMode: true, signInOpen: true })).toBe(true);
    expect(showsLogin({ session: true, localMode: false, signInOpen: true })).toBe(false);
  });
});
