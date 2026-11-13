import { describe, it, expect } from 'vitest';
import { monthView, type ListRecord, type ViewInput } from '../../../packages/core/src/planner';
import { notesFrom } from './MonthGrid';

const stamp = { revision: 1, updatedAt: '2026-10-30T00:00:00Z' };
const lists: ListRecord[] = [{ id: 'sam', kind: 'person', name: 'Sam', color: 'yellow', order: 0, ...stamp }, { id: 'alex', kind: 'person', name: 'Alex', color: 'green', order: 1, ...stamp }];
const input: ViewInput = { data: { lists, settings: { bothColor: 'purple', revision: 1, updatedAt: stamp.updatedAt }, tasks: [], priorities: [], events: [], notes: [] }, selection: { base: 'both', overlays: [] }, me: 'alex' };
const from = (first: string) => notesFrom(monthView(input, first).grid);

describe('notesFrom', () => {
  it('is Thursday in every month, as the wireframe draws October 2026 (Monday to Wednesday of the sixth row stay muted days)', () => {
    expect(from('2026-10-01')).toBe(4); // the month ends on a Saturday of row 5: the whole sixth row is next month's
    expect(from('2027-02-01')).toBe(4); // February from a Monday: rows 5 and 6 are March's
    expect(from('2027-05-01')).toBe(4); // 31 days from a Saturday: the 31st is Monday of row 6
    expect(from('2027-08-01')).toBe(4); // 31 days from a Sunday: the 31st is Tuesday of row 6, the longest case
  });
  it('covers the last four cells of the sixth row, none of them a day of the month', () => {
    for (let month = 1; month <= 12; month++) {
      for (const year of [2026, 2027, 2028]) {
        const first = `${year}-${String(month).padStart(2, '0')}-01`, grid = monthView(input, first).grid, start = notesFrom(grid);
        const taken = grid.slice(35 + start - 1);
        expect(taken.length, first).toBe(4);
        expect(taken.every(cell => !cell.inMonth), first).toBe(true);
      }
    }
  });
  it('begins after the last day when a month reached past Wednesday of the sixth row (not possible today; the rule is still honest)', () => {
    const grid = monthView(input, '2027-08-01').grid.map((cell, i) => ({ ...cell, inMonth: i < 35 + 5 }));
    expect(notesFrom(grid)).toBe(6);
  });
});
