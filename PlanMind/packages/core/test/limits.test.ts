import { describe, it, expect } from 'vitest';
import { CAPS, type Task, type TodoRow } from '../src/model';
import { textLimit, counter, todoCounter, todoSlots, periodBlankLines, fullOwnerOnEdit, laneChars } from '../src/limits';

const DAY = '2026-10-30';
const CAMP = '11111111-1111-4111-8111-111111111111';
let n = 0;
const todo = (owners: string[], over: Partial<Task> = {}): Task => ({
  id: `t${++n}`, scope: 'day', date: DAY, owners, title: 'x', done: false, pos: n * 1024, ak: 'a', revision: 1,
  createdBy: 'alex', updatedBy: 'alex', createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z', ...over,
});

describe('CAPS', () => {
  it('pins the tuning constants (the PHP limits.php is generated from these)', () => {
    expect(CAPS).toEqual({
      dayEventText: 500, dayEventTextLinked: 500, dayPriorityText: 18, dayPriorityTextLinked: 18, dayTodoText: 36, dayTodosPerList: 13,
      dayNotesChars: 400, periodTodoText: 500, periodTodosPerList: 200, docChars: 12000, prioritySlots: 5,
      eventStartMin: 420, eventEndMin: 1860, eventStep: 15, eventDefaultLength: 30, eventMinLength: 30,
      maxOverlays: 2, customListsMax: 12, listNameChars: 24, posGap: 1024,
      itemsMax: 20000, notesMax: 20000, choreTitleChars: 36, choresMax: 60, choreMarksMax: 20000, storeBytesMax: 8000000, requestBytesMax: 65536,
    });
  });
});

describe('textLimit', () => {
  it('events: 500 linked or not (a block shows what fits and an ellipsis; the cap is only the server\'s bound)', () => {
    expect(textLimit('event', 'day', false)).toBe(500);
    expect(textLimit('event', 'day', true)).toBe(500);
  });
  it('priorities: 18 either way, since a linked line can split into two half cells', () => {
    expect(textLimit('priority', 'day', false)).toBe(18);
    expect(textLimit('priority', 'day', true)).toBe(18);
  });
  it('to-dos: 36 on a day, 500 on a week or month, linked or not', () => {
    expect(textLimit('todo', 'day', false)).toBe(36);
    expect(textLimit('todo', 'day', true)).toBe(36);
    expect(textLimit('todo', 'week', false)).toBe(500);
    expect(textLimit('todo', 'month', true)).toBe(500);
  });
  it('notes: 400 on a day, 12000 on a week or month', () => {
    expect(textLimit('note', 'day', false)).toBe(400);
    expect(textLimit('note', 'week', false)).toBe(12000);
    expect(textLimit('note', 'month', false)).toBe(12000);
  });
  it('reads every value from CAPS', () => {
    expect(textLimit('event', 'day', false)).toBe(CAPS.dayEventText);
    expect(textLimit('event', 'day', true)).toBe(CAPS.dayEventTextLinked);
    expect(textLimit('priority', 'day', true)).toBe(CAPS.dayPriorityTextLinked);
    expect(textLimit('todo', 'day', false)).toBe(CAPS.dayTodoText);
    expect(textLimit('todo', 'week', false)).toBe(CAPS.periodTodoText);
    expect(textLimit('note', 'day', false)).toBe(CAPS.dayNotesChars);
    expect(textLimit('note', 'month', false)).toBe(CAPS.docChars);
  });
});

describe('counter', () => {
  it('counts plain text and reports the limit', () => {
    expect(counter('', 18)).toEqual({ used: 0, max: 18, over: false });
    expect(counter('Team call', 18)).toEqual({ used: 9, max: 18, over: false });
  });
  it('is over only past the limit: exactly at it still saves', () => {
    expect(counter('a'.repeat(18), 18).over).toBe(false);
    expect(counter('a'.repeat(19), 18)).toEqual({ used: 19, max: 18, over: true });
  });
  it('counts code points, not UTF-16 units: an emoji is one', () => {
    expect('😀'.length).toBe(2);
    expect(counter('😀', 18).used).toBe(1);
    expect(counter('😀'.repeat(18), 18)).toEqual({ used: 18, max: 18, over: false });
    expect(counter('😀'.repeat(19), 18).over).toBe(true);
    expect(counter('a😀b', 18).used).toBe(3);
  });
  it('counts a combining mark as its own code point, as the server does', () => {
    expect(counter('é', 18).used).toBe(2);
    expect(counter('é', 18).used).toBe(1);
    expect(counter('café', 4)).toEqual({ used: 5, max: 4, over: true });
  });
  it('counts a joined emoji sequence by its parts', () => {
    expect(counter('👨‍👩‍👧', 18).used).toBe(5);
  });
  it('counts a line break once, however it was typed', () => {
    expect(counter('a\r\nb', 18).used).toBe(3);
    expect(counter('a\rb', 18).used).toBe(3);
    expect(counter('a\nb', 18).used).toBe(3);
  });
  it('fits a long note against its own limit', () => {
    expect(counter('x'.repeat(400), textLimit('note', 'day', false)).over).toBe(false);
    expect(counter('x'.repeat(401), textLimit('note', 'day', false)).over).toBe(true);
  });
});

describe('todoCounter', () => {
  it('counts the open day to-dos of one list against the cap (13, set by Alex on 2026-10-31)', () => {
    expect(CAPS.dayTodosPerList).toBe(13);
    const tasks = [todo(['alex']), todo(['alex']), todo(['sam'])];
    expect(todoCounter(tasks, DAY, 'alex')).toEqual({ used: 2, max: CAPS.dayTodosPerList, over: false });
    expect(todoCounter(tasks, DAY, 'sam')).toEqual({ used: 1, max: CAPS.dayTodosPerList, over: false });
    expect(todoCounter(tasks, DAY, 'nobody')).toEqual({ used: 0, max: CAPS.dayTodosPerList, over: false });
  });
  it('ignores done to-dos, so finishing one frees a place', () => {
    const tasks = [todo(['alex']), todo(['alex'], { done: true }), todo(['alex'], { done: true })];
    expect(todoCounter(tasks, DAY, 'alex').used).toBe(1);
  });
  it('a linked to-do counts for both of its lists', () => {
    const tasks = [todo(['sam', 'alex']), todo(['alex'])];
    expect(todoCounter(tasks, DAY, 'sam').used).toBe(1);
    expect(todoCounter(tasks, DAY, 'alex').used).toBe(2);
  });
  it('looks at one day and day scope only', () => {
    const tasks = [todo(['alex'], { date: '2026-10-31' }), todo(['alex'], { scope: 'week', date: '2026-10-26' }), todo(['alex'], { scope: 'month', date: '2026-10-01' })];
    expect(todoCounter(tasks, DAY, 'alex').used).toBe(0);
  });
  it('does not mistake a week or month to-do for a day to-do on its period date', () => {
    const tasks = [todo(['alex'], { scope: 'week', date: '2026-10-26' }), todo(['alex'], { scope: 'month', date: '2026-10-01' })];
    expect(todoCounter(tasks, '2026-10-26', 'alex').used).toBe(0);
    expect(todoCounter(tasks, '2026-10-01', 'alex').used).toBe(0);
    expect(todoCounter([...tasks, todo(['alex'], { date: '2026-10-26' })], '2026-10-26', 'alex').used).toBe(1);
  });
  it('is over once the list is full: no room for another', () => {
    const max = CAPS.dayTodosPerList;
    const room = Array.from({ length: max - 1 }, () => todo(['alex']));
    expect(todoCounter(room, DAY, 'alex')).toEqual({ used: max - 1, max, over: false });
    const full = [...room, todo(['alex'])];
    expect(todoCounter(full, DAY, 'alex')).toEqual({ used: max, max, over: true });
    expect(todoCounter([...full.slice(0, max - 1), todo(['alex'], { done: true })], DAY, 'alex').over).toBe(false);
  });
  it('leaves out the to-do being edited so it does not count against itself', () => {
    const max = CAPS.dayTodosPerList;
    const full = Array.from({ length: max }, () => todo(['alex']));
    expect(todoCounter(full, DAY, 'alex', full[0].id)).toEqual({ used: max - 1, max, over: false });
    expect(todoCounter(full, DAY, 'alex', 'someone-else')).toEqual({ used: max, max, over: true });
  });
});

const row = (done = false): TodoRow => ({ item: todo(['alex'], { done }), color: 'green', linked: false });

describe('todoSlots', () => {
  it('stacks the done rows at the bottom of the same lines, taking their blank lines, in the order given', () => {
    const open = [row(), row()], done = [row(true), row(true), row(true)];
    const slots = todoSlots(open, done);
    expect(slots.filled).toEqual(open);
    expect(slots.done).toEqual(done);
    expect(slots.more).toEqual([]);
    expect(slots.empty).toBe(CAPS.dayTodosPerList - 5);
  });
  it('never counts the done rows against the cap of open ones: the 13 slots still show 13 open rows, the done ones follow, nothing is left blank', () => {
    const open = Array.from({ length: CAPS.dayTodosPerList + 2 }, () => row()), done = [row(true)];
    const slots = todoSlots(open, done);
    expect(slots.filled).toEqual(open.slice(0, CAPS.dayTodosPerList));
    expect(slots.more).toEqual(open.slice(CAPS.dayTodosPerList));
    expect(slots.done).toEqual(done);
    expect(slots.empty).toBe(0);
  });
  it('leaves no blank line once open and done rows fill the slots, however many done ones there are', () => {
    expect(todoSlots([row()], Array.from({ length: CAPS.dayTodosPerList - 1 }, () => row(true))).empty).toBe(0);
    expect(todoSlots([row()], Array.from({ length: 30 }, () => row(true))).empty).toBe(0);
    expect(todoSlots([], []).empty).toBe(CAPS.dayTodosPerList);
    expect(todoSlots([row()]).done).toEqual([]);
  });
});

describe('periodBlankLines', () => {
  it('is the page minimum less the open and the done rows, and never fewer than the one add line', () => {
    expect(periodBlankLines(13, 0, 0)).toBe(13);
    expect(periodBlankLines(13, 3, 4)).toBe(6);
    expect(periodBlankLines(8, 2, 3)).toBe(3);
    expect(periodBlankLines(13, 10, 3)).toBe(1);
    expect(periodBlankLines(13, 14, 0)).toBe(1);
    expect(periodBlankLines(8, 1, 40)).toBe(1);
  });
});

describe('laneChars', () => {
  it('splits the 36-character phone row across the lanes', () => {
    expect([1, 2, 3, 4].map(lanes => laneChars(lanes, 1))).toEqual([36, 18, 12, 9]);
  });
  it('gives a cell spanning two lanes twice a lane', () => {
    expect([2, 3, 4].map(lanes => laneChars(lanes, 2))).toEqual([36, 24, 18]);
  });
  it('matches the priority cap: a lane in Both view is 18 characters, as a priority line is', () => {
    expect(laneChars(2, 1)).toBe(CAPS.dayPriorityText);
    expect(laneChars(2, 2)).toBe(2 * CAPS.dayPriorityText);
  });
  it('rounds down, never up, when the lanes do not divide the row', () => {
    expect([5, 7, 8, 10, 11].map(lanes => laneChars(lanes, 1))).toEqual([7, 5, 4, 3, 3]);
    expect([8, 10].map(lanes => laneChars(lanes, 2))).toEqual([8, 6]);
  });
  it('treats fewer than one lane as one', () => {
    expect(laneChars(0, 1)).toBe(36);
    expect(laneChars(-3, 1)).toBe(36);
  });
});

describe('fullOwnerOnEdit', () => {
  const OTHER = '2026-10-31';
  const fill = (owner: string, date = DAY) => Array.from({ length: CAPS.dayTodosPerList }, () => todo([owner], { date }));

  it('lets an edit that leaves the to-do in the same list on the same day pass, even when that list is full', () => {
    const tasks = fill('alex');
    expect(fullOwnerOnEdit(tasks, tasks[0], DAY, ['alex'])).toBeUndefined();
  });
  it('lets an unchanged to-do pass in a list that is already over the cap (older data), because it was counted before the edit', () => {
    const tasks = [...fill('alex'), todo(['alex'])];
    expect(fullOwnerOnEdit(tasks, tasks[0], DAY, ['alex'])).toBeUndefined();
    const elsewhere = todo(['alex'], { date: OTHER });
    expect(fullOwnerOnEdit([...tasks, elsewhere], elsewhere, DAY, ['alex'])).toBe('alex');
  });
  it('blocks moving it to a day on which the list is full, and names the list', () => {
    const mine = todo(['alex']);
    const tasks = [...fill('alex', OTHER), mine];
    expect(fullOwnerOnEdit(tasks, mine, OTHER, ['alex'])).toBe('alex');
    expect(fullOwnerOnEdit(tasks, mine, '2026-11-02', ['alex'])).toBeUndefined();
  });
  it('blocks adding an owner whose list is full, and lets an owner be taken away', () => {
    const mine = todo(['alex']);
    expect(fullOwnerOnEdit([...fill('sam'), mine], mine, DAY, ['sam', 'alex'])).toBe('sam');
    const ours = todo(['sam', 'alex']);
    const both = [...fill('sam').slice(1), ours];
    expect(fullOwnerOnEdit(both, ours, DAY, ['alex'])).toBeUndefined();
    expect(fullOwnerOnEdit(both, ours, DAY, ['sam', 'alex'])).toBeUndefined();
  });
  it('names the first full owner in the order given', () => {
    const mine = todo(['alex']);
    const tasks = [...fill('sam'), ...fill(CAMP), mine];
    expect(fullOwnerOnEdit(tasks, mine, DAY, [CAMP, 'sam'])).toBe(CAMP);
    expect(fullOwnerOnEdit(tasks, mine, DAY, ['sam', CAMP])).toBe('sam');
  });
  it('does not count the to-do against itself, and never blocks a finished one', () => {
    const mine = todo(['alex'], { date: OTHER });
    expect(fullOwnerOnEdit([...fill('alex').slice(1), mine], mine, DAY, ['alex'])).toBeUndefined();
    expect(fullOwnerOnEdit([...fill('alex'), mine], mine, DAY, ['alex'])).toBe('alex');
    const finished = todo(['alex'], { done: true });
    expect(fullOwnerOnEdit([...fill('alex', OTHER), finished], finished, OTHER, ['alex'])).toBeUndefined();
  });
});
