import { expect, test, vi } from 'vitest';

// The component file imports react-native, the store and the theme; only the two pure functions are under test.
vi.mock('react-native', () => ({ StyleSheet: { create: (x: unknown) => x }, Text: 'Text', View: 'View' }));
vi.mock('../src/store', () => ({ useStore: () => ({}) }));
vi.mock('../src/theme', () => ({ themed: (f: () => unknown) => f(), T: { danger: 'danger', gold: 'gold', accent: 'accent', dim: 'dim' } }));
vi.mock('../src/ui', () => ({ SYNC_DOT: 8 }));
import { syncLook, syncWord } from '../src/components/SyncDot';

// What the one dot and the one word say, in every combination that matters for
// a refused write into a partner's list (sharedTrouble).

const L = (sync: Parameters<typeof syncLook>[0], persist: boolean, shared: boolean, refused: string[] = []) =>
  syncLook(sync, persist, refused, 'too_large', shared);

test('a take-back on the partner list says so, not "offline"', () => {
  expect(L('idle', false, true).text).toMatch(/partner.*not saved/i);
  expect(L('idle', false, true).text).not.toMatch(/offline/i);
  expect(syncWord('idle', false, true)).toBe('Not saved');
});

test('it is told even while the own sync is offline or syncing', () => {
  expect(L('offline', false, true).text).toMatch(/partner.*not saved/i);
  expect(L('syncing', false, true).text).toMatch(/partner.*not saved/i);
  expect(syncWord('offline', false, true)).toBe('Not saved');
});

test('it never hides a standing refusal or a device that cannot save', () => {
  expect(L('refused', false, true, ['Long note']).text).toMatch(/Long note.*too long/);
  expect(L('idle', true, true).text).toMatch(/cannot save its copy/);
  expect(L('idle', true, true).color).toBe(L('idle', true, false).color);
});

test('without it nothing changes', () => {
  expect(L('offline', false, false).text).toMatch(/^Offline/);
  expect(L('idle', false, false).text).toMatch(/^Online/);
  expect(syncWord('idle', false)).toBe('Saved');
  expect(syncWord('offline', false)).toBe('Offline');
});

test('a lost reply says unconfirmed until the partner list can be checked', () => {
  expect(syncLook('idle', false, [], 'too_large', 'unconfirmed')).toEqual({ color: 'gold', text: 'Could not confirm whether a change to your partner’s list was saved.' });
  expect(syncWord('idle', false, 'unconfirmed')).toBe('Unconfirmed');
  expect(syncWord('refused', false, 'unconfirmed')).toBe('Not saved');
});
