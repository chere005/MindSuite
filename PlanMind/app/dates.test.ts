import { describe, it, expect } from 'vitest';
import { monthShort, weekRange } from './dates';

describe('weekRange', () => {
  it('writes a week inside one month as "Oct 12–18" (the wireframe)', () => {
    expect(weekRange('2026-10-12')).toBe('Oct 12–18');
    expect(weekRange('2026-09-07')).toBe('Sep 7–13');
  });
  it('writes a week across two months or two years with both names', () => {
    expect(weekRange('2026-10-26')).toBe('Oct 26–Nov 1');
    expect(weekRange('2026-09-28')).toBe('Sep 28–Oct 4');
    expect(weekRange('2026-12-28')).toBe('Dec 28–Jan 3');
  });
  it('takes the dash the page header wants', () => {
    expect(weekRange('2026-10-26', ' – ')).toBe('Oct 26 – Nov 1');
    expect(weekRange('2026-10-12', ' – ')).toBe('Oct 12 – 18');
  });
});

describe('monthShort', () => {
  it('is the short month and the year', () => {
    expect(monthShort('2026-06-01')).toBe('Jun 2026');
    expect(monthShort('2027-03-01')).toBe('Mar 2027');
  });
});
