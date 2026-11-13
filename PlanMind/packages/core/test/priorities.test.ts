import { describe, it, expect } from 'vitest';
import type { Priority } from '../src/model';
import { suggestSlots, pickSlots, arrangePriorities } from '../src/priorities';

const CAMP = '11111111-1111-4111-8111-111111111111';
const DAY = '2026-10-30';
let n = 0;
const pr = (slots: Record<string, number>, over: Partial<Priority> = {}): Priority => ({
  id: `p${++n}`, date: DAY, owners: Object.keys(slots).sort(), slots, text: 'x', ak: 'a', revision: 1,
  createdBy: 'alex', updatedBy: 'alex', createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z', ...over,
});
/** A list's five lines as the line numbers in use. */
const apply = (items: Priority[], listId: string, moves: { id: string; slot: number }[]) =>
  items.map(p => ({ id: p.id, line: moves.find(m => m.id === p.id)?.slot ?? p.slots[listId] }));

describe('suggestSlots', () => {
  it('starts at line 1 on an empty day', () => {
    expect(suggestSlots([], DAY, ['alex'])).toEqual({ alex: 1 });
    expect(suggestSlots([], DAY, ['sam', 'alex'])).toEqual({ sam: 1, alex: 1 });
  });
  it('takes the lowest free line for one list, filling gaps', () => {
    const items = [pr({ alex: 1 }), pr({ alex: 3 })];
    expect(suggestSlots(items, DAY, ['alex'])).toEqual({ alex: 2 });
    expect(suggestSlots([pr({ alex: 2 })], DAY, ['alex'])).toEqual({ alex: 1 });
  });
  it('only looks at the day and the owner asked about', () => {
    const items = [pr({ alex: 1 }, { date: '2026-10-29' }), pr({ sam: 1 }), pr({ [CAMP]: 1 })];
    expect(suggestSlots(items, DAY, ['alex'])).toEqual({ alex: 1 });
    expect(suggestSlots(items, DAY, ['sam'])).toEqual({ sam: 2 });
  });
  it('for Both, takes the lowest line free for both lists', () => {
    const items = [pr({ sam: 1 }), pr({ alex: 2 }), pr({ sam: 3 })];
    expect(suggestSlots(items, DAY, ['sam', 'alex'])).toEqual({ sam: 4, alex: 4 });
    expect(suggestSlots([pr({ sam: 1 })], DAY, ['sam', 'alex'])).toEqual({ sam: 2, alex: 2 });
  });
  it('a linked priority holds a line in each of its lists', () => {
    const items = [pr({ sam: 1, alex: 2 })];
    expect(suggestSlots(items, DAY, ['sam'])).toEqual({ sam: 2 });
    expect(suggestSlots(items, DAY, ['alex'])).toEqual({ alex: 1 });
    expect(suggestSlots(items, DAY, ['sam', 'alex'])).toEqual({ sam: 3, alex: 3 });
  });
  it('with no common line, gives each list its own lowest free line', () => {
    const items = [pr({ sam: 1 }), pr({ sam: 2 }), pr({ sam: 3 }), pr({ sam: 4 }), pr({ alex: 5 })];
    expect(suggestSlots(items, DAY, ['sam', 'alex'])).toEqual({ sam: 5, alex: 1 });
  });
  it('is null when any owner has all five lines used', () => {
    const full = [1, 2, 3, 4, 5].map(line => pr({ alex: line }));
    expect(suggestSlots(full, DAY, ['alex'])).toBeNull();
    expect(suggestSlots(full, DAY, ['sam', 'alex'])).toBeNull();
    expect(suggestSlots(full, DAY, ['sam'])).toEqual({ sam: 1 });
  });
  it('is null for no owners', () => {
    expect(suggestSlots([], DAY, [])).toBeNull();
  });
});

describe('arrangePriorities', () => {
  const a = pr({ alex: 1 }), b = pr({ alex: 2 }), c = pr({ alex: 3 });
  const three = [a, b, c];

  it('moves a line up: the lines it passes shift down by one', () => {
    const moves = arrangePriorities(three, DAY, 'alex', c.id, 1);
    expect(moves).toEqual([
      { id: c.id, revision: 1, slot: 1 }, { id: a.id, revision: 1, slot: 2 }, { id: b.id, revision: 1, slot: 3 },
    ]);
  });
  it('moves a line down: the lines it passes shift up by one', () => {
    const moves = arrangePriorities(three, DAY, 'alex', a.id, 3);
    expect(moves).toEqual([
      { id: b.id, revision: 1, slot: 1 }, { id: c.id, revision: 1, slot: 2 }, { id: a.id, revision: 1, slot: 3 },
    ]);
    expect(apply(three, 'alex', moves).map(x => x.line).sort()).toEqual([1, 2, 3]);
  });
  it('moves one step with a swap of two records only', () => {
    expect(arrangePriorities(three, DAY, 'alex', b.id, 3)).toEqual([
      { id: c.id, revision: 1, slot: 2 }, { id: b.id, revision: 1, slot: 3 },
    ]);
    expect(arrangePriorities(three, DAY, 'alex', b.id, 1)).toEqual([
      { id: b.id, revision: 1, slot: 1 }, { id: a.id, revision: 1, slot: 2 },
    ]);
  });
  it('moves into an empty line: the line it leaves absorbs the shift, so neighbours move only when passed', () => {
    const x = pr({ alex: 1 }), y = pr({ alex: 3 });
    expect(arrangePriorities([x, y], DAY, 'alex', y.id, 2)).toEqual([{ id: y.id, revision: 1, slot: 2 }]);
    expect(arrangePriorities([x, y], DAY, 'alex', x.id, 2)).toEqual([{ id: x.id, revision: 1, slot: 2 }]);
    expect(arrangePriorities([x, y], DAY, 'alex', x.id, 5)).toEqual([
      { id: y.id, revision: 1, slot: 2 }, { id: x.id, revision: 1, slot: 5 },
    ]);
  });
  it('returns nothing for the line it is already on', () => {
    expect(arrangePriorities(three, DAY, 'alex', b.id, 2)).toEqual([]);
  });
  it('returns nothing for an unknown id, another list, another day or a target outside 1 to 5', () => {
    expect(arrangePriorities(three, DAY, 'alex', 'nope', 2)).toEqual([]);
    expect(arrangePriorities(three, DAY, 'sam', a.id, 2)).toEqual([]);
    expect(arrangePriorities(three, '2026-10-31', 'alex', a.id, 2)).toEqual([]);
    expect(arrangePriorities(three, DAY, 'alex', a.id, 0)).toEqual([]);
    expect(arrangePriorities(three, DAY, 'alex', a.id, 6)).toEqual([]);
    expect(arrangePriorities(three, DAY, 'alex', a.id, 2.5)).toEqual([]);
  });
  it('ignores a record whose line is outside 1 to 5 instead of treating it as a sixth line (invalid data)', () => {
    const a = pr({ alex: 1 }), off = pr({ alex: 6 }), zero = pr({ alex: 0 }), half = pr({ alex: 2.5 });
    const items = [a, off, zero, half];
    expect(arrangePriorities(items, DAY, 'alex', off.id, 1)).toEqual([]);
    expect(arrangePriorities(items, DAY, 'alex', zero.id, 1)).toEqual([]);
    expect(arrangePriorities(items, DAY, 'alex', half.id, 1)).toEqual([]);
    expect(arrangePriorities(items, DAY, 'alex', a.id, 3)).toEqual([{ id: a.id, revision: 1, slot: 3 }]);
    expect(suggestSlots([off, zero, half], DAY, ['alex'])).toEqual({ alex: 1 });
  });
  it('when two records claim one line (invalid data) the first keeps it and the second is not movable', () => {
    const first = pr({ alex: 2 }), second = pr({ alex: 2 });
    expect(arrangePriorities([first, second], DAY, 'alex', first.id, 1)).toEqual([{ id: first.id, revision: 1, slot: 1 }]);
    expect(arrangePriorities([first, second], DAY, 'alex', second.id, 1)).toEqual([]);
  });
  it('changes at most five records and carries each current revision', () => {
    const full = [1, 2, 3, 4, 5].map(line => pr({ alex: line }, { revision: line + 10 }));
    const moves = arrangePriorities(full, DAY, 'alex', full[4].id, 1);
    expect(moves).toHaveLength(5);
    expect(moves.map(m => m.slot)).toEqual([1, 2, 3, 4, 5]);
    expect(moves.map(m => m.revision)).toEqual([15, 11, 12, 13, 14]);
    const after = apply(full, 'alex', moves).map(x => x.line);
    expect([...after].sort()).toEqual([1, 2, 3, 4, 5]);
  });
  it('only changes the chosen list for a linked record and leaves the other list alone', () => {
    const samOnly = pr({ sam: 1 });
    const linked = pr({ sam: 2, alex: 1 });
    const alexOnly = pr({ alex: 2 });
    const items = [samOnly, linked, alexOnly];
    const alexMoves = arrangePriorities(items, DAY, 'alex', linked.id, 2);
    expect(alexMoves).toEqual([{ id: alexOnly.id, revision: 1, slot: 1 }, { id: linked.id, revision: 1, slot: 2 }]);
    const samMoves = arrangePriorities(items, DAY, 'sam', linked.id, 1);
    expect(samMoves).toEqual([{ id: linked.id, revision: 1, slot: 1 }, { id: samOnly.id, revision: 1, slot: 2 }]);
  });
  it('does not change its input', () => {
    const copy = JSON.stringify(three);
    arrangePriorities(three, DAY, 'alex', c.id, 1);
    expect(JSON.stringify(three)).toBe(copy);
  });
});

describe('pickSlots', () => {
  const lines = (owner: string, taken: number[]) => taken.map(line => pr({ [owner]: line }, { id: `${owner}${line}` }));

  it('gives every owner the line asked for when it is free for all of them', () => {
    expect(pickSlots([], DAY, ['alex'], null, 3)).toEqual({ alex: 3 });
    expect(pickSlots(lines('sam', [1, 2]), DAY, ['sam', 'alex'], null, 3)).toEqual({ sam: 3, alex: 3 });
  });
  it('falls back to the lowest line free for all when the one asked for is taken by one owner', () => {
    const items = [...lines('sam', [3]), ...lines('alex', [1])];
    expect(pickSlots(items, DAY, ['sam', 'alex'], null, 3)).toEqual({ sam: 2, alex: 2 });
  });
  it('gives each owner their own lowest line when no line is free for both', () => {
    const items = [...lines('sam', [1, 2, 3]), ...lines('alex', [3, 4, 5])];
    expect(pickSlots(items, DAY, ['sam', 'alex'], null, 1)).toEqual({ sam: 4, alex: 1 });
  });
  it('says no when an owner has all five lines', () => {
    expect(pickSlots(lines('sam', [1, 2, 3, 4, 5]), DAY, ['sam'], null, 2)).toBeNull();
    expect(pickSlots(lines('sam', [1, 2, 3, 4, 5]), DAY, ['sam', 'alex'], null, 2)).toBeNull();
    expect(pickSlots([], DAY, [], null, 2)).toEqual({});
  });
  it('does not count other days, or the record being edited', () => {
    const items = [...lines('sam', [1, 2, 3, 4]), pr({ sam: 5 }, { date: '2026-10-31' })];
    expect(pickSlots(items, DAY, ['sam'], null, 5)).toEqual({ sam: 5 });
    // the line asked for is used on another day only, so it is the one given, not the lowest free one
    expect(pickSlots([...lines('sam', [1]), pr({ sam: 3 }, { date: '2026-10-31' })], DAY, ['sam'], null, 3)).toEqual({ sam: 3 });
    const own = lines('sam', [1, 2, 3, 4, 5]);
    expect(pickSlots(own, DAY, ['sam'], 'sam3', 3)).toEqual({ sam: 3 });
    expect(pickSlots(own, DAY, ['sam'], 'sam3', 1)).toEqual({ sam: 3 });
  });
  it('hands a line over when the owner changes from Sam to Both: the line it has if Alex has it free, else a line free for both', () => {
    const mine = pr({ sam: 2 }, { id: 'mine' });
    expect(pickSlots([mine, ...lines('alex', [1])], DAY, ['sam', 'alex'], 'mine', 2)).toEqual({ sam: 2, alex: 2 });
    expect(pickSlots([mine, ...lines('alex', [2])], DAY, ['sam', 'alex'], 'mine', 2)).toEqual({ sam: 1, alex: 1 });
  });
  it('does not change the list it is given', () => {
    const items = lines('sam', [1, 2]);
    const copy = JSON.stringify(items);
    pickSlots(items, DAY, ['sam'], 'sam1', 1);
    expect(JSON.stringify(items)).toBe(copy);
  });
});
