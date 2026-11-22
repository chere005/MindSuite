import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, expect, test, vi } from 'vitest';

import { forgetMealStorage, readMealStorage } from '../src/storage';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));

const values = new Map<string, string>();
const current = 'mealmind.snapshot.alex@prod';
const previous = 'chef' + 'mind.snapshot.alex@prod';

beforeEach(() => {
  values.clear();
  vi.mocked(AsyncStorage.getItem).mockImplementation(async (key) => values.get(key) ?? null);
  vi.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => { values.set(key, value); });
  vi.mocked(AsyncStorage.removeItem).mockImplementation(async (key) => { values.delete(key); });
});

test('moves a saved snapshot only once and keeps a newer snapshot', async () => {
  values.set(previous, 'pending edits');
  expect(await readMealStorage(current)).toBe('pending edits');
  expect(values.get(current)).toBe('pending edits');
  expect(values.has(previous)).toBe(false);

  values.set(previous, 'earlier snapshot');
  expect(await readMealStorage(current)).toBe('pending edits');
});

test('leaves the old copy available if the migration write fails', async () => {
  values.set(previous, 'pending edits');
  vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('storage full'));
  expect(await readMealStorage(current)).toBe('pending edits');
  expect(values.get(previous)).toBe('pending edits');
});

test('clears both copies even when storage only permits overwriting', async () => {
  values.set(previous, 'old data');
  values.set(current, 'new data');
  vi.mocked(AsyncStorage.removeItem).mockRejectedValue(new Error('cannot delete'));
  await forgetMealStorage(current);
  expect(values.get(previous)).toBe('null');
  expect(values.get(current)).toBe('null');
});
