import { expect, it } from 'vitest';
import { shiftDate } from '../src/parse';

it('uses the shared date parser through the app package', () => {
  expect(shiftDate('2024-01-31', 1, 'month')).toBe('2024-02-29');
  expect(shiftDate('2023-12-31', 1, 'day')).toBe('2024-01-01');
});
