import { describe, it, expect } from 'vitest';
import { ALLDAY_ROWS, alldayCells, alldayStrip, calmindCells, type CalmindAllDay, type CalmindEvent } from '../src/calmind';
import type { Lane } from '../src/model';

const DAY = '2026-11-10';
const lanes: Lane[] = [
  { listId: 'alex', name: 'Alex', color: 'green', you: true },
  { listId: 'sam', name: 'Sam', color: 'yellow', you: false },
];
let n = 0;
const ev = (owner: 'alex' | 'sam', start: number, length: number, text = `x${++n}`, date = DAY): CalmindEvent => ({ id: `c${++n}`, owner, date, start, length, text, color: '' });
/** [start, lane, span, x, w] with x and w in quarters of the lane area (two lanes: a lane is 2). */
const shape = (cells: ReturnType<typeof calmindCells>) => cells.map(c => [c.event.start, c.lane, c.span, +(c.x * 4).toFixed(3), +(c.w * 4).toFixed(3)]);

describe('calmindCells', () => {
  it('puts each person in their own lane, and leaves out other days and lanes not shown', () => {
    const events = [ev('alex', 540, 60), ev('sam', 600, 60), ev('alex', 540, 60, 'y', '2026-11-11')];
    expect(shape(calmindCells(events, DAY, lanes))).toEqual([[540, 0, 1, 0, 2], [600, 1, 1, 2, 2]]);
    expect(shape(calmindCells(events, DAY, [lanes[1]!]))).toEqual([[600, 0, 1, 0, 4]]);
    expect(calmindCells(events, DAY, [{ listId: 'camp', name: 'Camp', color: 'blue', you: false }])).toEqual([]);
  });
  it('stands overlapping pieces side by side, and a piece after the run starts a new one', () => {
    const events = [ev('alex', 540, 120), ev('alex', 570, 30), ev('alex', 600, 60), ev('alex', 720, 30)];
    expect(shape(calmindCells(events, DAY, lanes))).toEqual([[540, 0, 1, 0, 1], [570, 0, 1, 1, 1], [600, 0, 1, 1, 1], [720, 0, 1, 0, 2]]);
  });
  it('touching pieces do not overlap; the longer goes first on the same start', () => {
    const a = ev('alex', 540, 30), b = ev('alex', 570, 30), c = ev('alex', 540, 90);
    expect(calmindCells([a, b, c], DAY, lanes).map(x => [x.event.id, x.x * 4, x.w * 4])).toEqual([[c.id, 0, 1], [a.id, 1, 1], [b.id, 1, 1]]);
  });
  it('an event on both calendars is one piece across both lanes, owned by both', () => {
    const cells = calmindCells([ev('alex', 540, 60, 'Dinner  with Mom'), ev('sam', 540, 60, 'dinner with mom'), ev('sam', 600, 30, 'Dinner with Mom')], DAY, lanes);
    expect(shape(cells)).toEqual([[540, 0, 2, 0, 4], [600, 1, 1, 2, 2]]);
    expect(cells[0]!.owners).toEqual(['alex', 'sam']);
    // Not the same when the time, the length or the words differ; and not across lanes that are not side by side.
    expect(calmindCells([ev('alex', 540, 60, 'A'), ev('sam', 555, 60, 'A')], DAY, lanes).every(c => c.span === 1)).toBe(true);
    expect(calmindCells([ev('alex', 540, 60, 'A'), ev('sam', 540, 60, 'B')], DAY, lanes).every(c => c.span === 1)).toBe(true);
    const apart: Lane[] = [lanes[0]!, { listId: 'camp', name: 'Camp', color: 'blue', you: false }, lanes[1]!];
    expect(calmindCells([ev('alex', 540, 60, 'A'), ev('sam', 540, 60, 'A')], DAY, apart).every(c => c.span === 1)).toBe(true);
  });
  it('a piece across both lanes keeps to their inner sides, beside each lane\'s own pieces', () => {
    // Shared 9a-10a; Alex has his own 9:30a; Sam has nothing else. Alex's lane: own on the left half, the shared one on the right
    // half; Sam's lane: the shared one alone, whole. So the shared piece runs from the middle of Alex's lane to Sam's right edge.
    const cells = calmindCells([ev('alex', 540, 60, 'S'), ev('sam', 540, 60, 'S'), ev('alex', 570, 30, 'own')], DAY, lanes);
    expect(shape(cells)).toEqual([[540, 0, 2, 1, 3], [570, 0, 1, 0, 1]]);
    // With Sam's own overlapping too, the shared piece is the middle band: Alex's right half to Sam's left half.
    const both = calmindCells([ev('alex', 540, 60, 'S'), ev('sam', 540, 60, 'S'), ev('alex', 570, 30, 'own'), ev('sam', 560, 30, 'hers')], DAY, lanes);
    expect(shape(both)).toEqual([[540, 0, 2, 1, 2], [560, 1, 1, 3, 1], [570, 0, 1, 0, 1]]);
  });
  it('shows the designated calendar in Both and either personal view without changing the owner', () => {
    const both = { ...ev('alex', 1140, 60, 'Shared calendar'), both: true } as const;
    const ordinary = ev('alex', 1200, 60, 'Personal calendar');
    expect(shape(calmindCells([both, ordinary], DAY, lanes))).toEqual([[1140, 0, 2, 0, 4], [1200, 0, 1, 0, 2]]);
    for (const lane of lanes) {
      const cells = calmindCells([both], DAY, [lane]);
      expect(shape(cells)).toEqual([[1140, 0, 1, 0, 4]]);
      expect(cells[0]).toMatchObject({ owners: ['alex', 'sam'], event: { owner: 'alex' } });
    }
    expect(calmindCells([both], DAY, [{ listId: 'camp', name: 'Camp', color: 'blue', you: false }])).toEqual([]);
  });
  it('uses one Both cell when a designated event also appears on the other calendar', () => {
    const both = { ...ev('sam', 1140, 60, 'Shared calendar'), both: true } as const;
    const matching = ev('alex', 1140, 60, 'shared calendar');
    const cells = calmindCells([both, matching], DAY, lanes);
    expect(shape(cells)).toEqual([[1140, 0, 2, 0, 4]]);
    expect(cells[0]!.event.id).toBe(both.id);
  });
});

// ---- All-day strip (#171) ----
let m = 0;
const ad = (owner: 'alex' | 'sam', text: string, over: Partial<CalmindAllDay> = {}): CalmindAllDay => ({ id: `a${++m}`, owner, date: DAY, text, color: '', ...over });
const both = [lanes[0]!, lanes[1]!];
/** [row, lane, span, text or "+N"] */
const rows = (chips: ReturnType<typeof alldayStrip>) => chips.map(c => [c.row, c.lane, c.span, c.cell ? c.cell.item.text : `+${c.more}`]);
const strip = (items: CalmindAllDay[], ls: Lane[] = both) => rows(alldayStrip(alldayCells(items, DAY, ls), ls.length));

describe('alldayCells', () => {
  it('puts each person in their own lane, alphabetically, and leaves out other days and lanes not shown', () => {
    const items = [ad('alex', 'Zoo trip'), ad('alex', 'Anniversary'), ad('sam', 'Book club'), ad('alex', 'Not today', { date: '2026-11-11' })];
    expect(alldayCells(items, DAY, both).map(c => [c.lane, c.span, c.item.text])).toEqual([[0, 1, 'Anniversary'], [0, 1, 'Zoo trip'], [1, 1, 'Book club']]);
    expect(alldayCells(items, DAY, [lanes[1]!]).map(c => c.item.text)).toEqual(['Book club']);
    expect(alldayCells(items, DAY, [{ listId: 'camp', name: 'Camp', color: 'blue', you: false }])).toEqual([]);
  });
  it('an event on both calendars (same words, case and spacing aside) is one chip across both lanes, owned by both', () => {
    const cells = alldayCells([ad('alex', 'Family  Day'), ad('sam', 'family day'), ad('sam', 'Hers')], DAY, both);
    expect(cells.map(c => [c.lane, c.span, c.item.text, c.owners])).toEqual([[1, 1, 'Hers', ['sam']], [0, 2, 'Family  Day', ['alex', 'sam']]]);
  });
  it('the designated Both calendar is one chip across both lanes, or sits in either lane when they are not side by side', () => {
    const b = ad('alex', 'Shared calendar', { both: true });
    expect(alldayCells([b], DAY, both).map(c => [c.lane, c.span])).toEqual([[0, 2]]);
    const apart = [lanes[0]!, { listId: 'camp', name: 'Camp', color: 'blue' as const, you: false }, lanes[1]!];
    expect(alldayCells([b], DAY, apart).map(c => [c.lane, c.span, c.owners])).toEqual([[0, 1, ['alex', 'sam']], [2, 1, ['alex', 'sam']]]);
    expect(alldayCells([b], DAY, [lanes[0]!]).map(c => [c.lane, c.span])).toEqual([[0, 1]]);
  });
  it('different words on the two calendars stay in their own lanes', () => {
    expect(alldayCells([ad('alex', 'A'), ad('sam', 'B')], DAY, both).map(c => c.span)).toEqual([1, 1]);
  });
});

describe('alldayStrip', () => {
  it('is empty with nothing, so the strip takes no height', () => {
    expect(strip([])).toEqual([]);
    expect(ALLDAY_ROWS).toBe(2);
  });
  it('stacks a lane\'s chips in its rows, each lane on its own', () => {
    expect(strip([ad('alex', 'A'), ad('alex', 'B'), ad('sam', 'C')])).toEqual([[0, 0, 1, 'A'], [0, 1, 1, 'C'], [1, 0, 1, 'B']]);
  });
  it('a lane with more than fits shows one fewer chip and +N counting what it hides', () => {
    expect(strip([ad('alex', 'A'), ad('alex', 'B'), ad('alex', 'C'), ad('alex', 'D'), ad('sam', 'E')])).toEqual([[0, 0, 1, 'A'], [0, 1, 1, 'E'], [1, 0, 1, '+3']]);
    const chips = alldayStrip(alldayCells([ad('alex', 'A'), ad('alex', 'B'), ad('alex', 'C')], DAY, both), 2);
    expect(chips.find(c => c.cell === null)!.hidden.map(h => h.text)).toEqual(['B', 'C']);
  });
  it('exactly as many as the rows is not an overflow', () => {
    expect(strip([ad('alex', 'A'), ad('alex', 'B')])).toEqual([[0, 0, 1, 'A'], [1, 0, 1, 'B']]);
  });
  it('a chip across both lanes takes the first row and the lanes\' own chips go under it', () => {
    expect(strip([ad('alex', 'Both'), ad('sam', 'both'), ad('alex', 'Mine')])).toEqual([[0, 0, 2, 'Both'], [1, 0, 1, 'Mine']]);
  });
  it('chips across both lanes never take the last row while a lane has chips of its own', () => {
    const twoSpans = [ad('alex', 'S1'), ad('sam', 'S1'), ad('alex', 'S2'), ad('sam', 'S2'), ad('alex', 'Mine')];
    expect(strip(twoSpans)).toEqual([[0, 0, 2, 'S1'], [1, 0, 1, '+2']]);
  });
  it('only chips across both lanes: two fit, a third is +N in the left lane', () => {
    const spans = (t: string) => [ad('alex', t), ad('sam', t)];
    expect(strip([...spans('A'), ...spans('B')])).toEqual([[0, 0, 2, 'A'], [1, 0, 2, 'B']]);
    expect(strip([...spans('A'), ...spans('B'), ...spans('C')])).toEqual([[0, 0, 2, 'A'], [1, 0, 1, '+2']]);
  });
  it('one lane: the same rule with no chip across', () => {
    expect(strip([ad('alex', 'A'), ad('alex', 'B'), ad('alex', 'C')], [lanes[0]!])).toEqual([[0, 0, 1, 'A'], [1, 0, 1, '+2']]);
  });
  it('never draws two things in one place', () => {
    const items = [ad('alex', 'S1'), ad('sam', 'S1'), ...'ABCDE'.split('').map(t => ad('alex', t)), ...'FGH'.split('').map(t => ad('sam', t))];
    const seen = new Set<string>();
    for (const c of alldayStrip(alldayCells(items, DAY, both), 2)) {
      for (let l = c.lane; l < c.lane + c.span; l++) { const key = `${c.row}:${l}`; expect(seen.has(key), key).toBe(false); seen.add(key); }
      expect(c.row).toBeLessThan(ALLDAY_ROWS);
    }
  });
});
