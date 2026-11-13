import { describe, it, expect } from 'vitest';
import { CAPS, type ListRecord, type Selection, type Settings, type Task, type ViewData, type ViewInput } from '../src/model';
import { fullOwnerOnEdit, todoCounter, todoSlots } from '../src/limits';
import { accomplishedTodos, carriedTodos, isCarried, rowDone, visibleTodos } from '../src/placement';
import { resolveLanes } from '../src/selection';
import { dayView, monthView, weekView } from '../src/views';

// Alex, 2026-11-02: a carried-over to-do "only shows checked for the day it was accomplished; previous days show it unchanged/unchecked".
// A done day to-do may hold `doneOn`, the date of the page it was ticked on (its own date, or today for a carried row). The day it was
// accomplished lists it checked, in that day's done pile (with the "from" chip when that is not its own day); its own day lists it unchecked
// with `wentTo`; it is no longer carried once done. A done to-do without doneOn is done on its own date, as before.
const CAMP = '11111111-1111-4111-8111-111111111111';
const TODAY = '2026-11-02', OLD = '2026-10-26', TUE = '2026-11-03';
const stampList = { revision: 1, updatedAt: '2026-10-30T00:00:00Z' };
const lists: ListRecord[] = [
  { id: 'sam', kind: 'person', name: 'Sam', color: 'yellow', order: 0, ...stampList },
  { id: 'alex', kind: 'person', name: 'Alex', color: 'green', order: 1, ...stampList },
  { id: CAMP, kind: 'custom', name: 'Camping', color: 'blue', order: 2, ...stampList },
];
const settings: Settings = { bothColor: 'purple', revision: 1, updatedAt: '2026-10-30T00:00:00Z' };
const stamp = { revision: 1, ak: 'a', createdBy: 'alex', updatedBy: 'alex', createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z' } as const;
let n = 0;
const todo = (owners: string[], over: Partial<Task> = {}): Task => ({ id: `t${++n}`, scope: 'day', date: TODAY, owners, title: 'x', done: false, pos: n * 1024, ...stamp, ...over });
/** A to-do of `date` ticked on `on`. */
const ticked = (owners: string[], date: string, on?: string, over: Partial<Task> = {}): Task => todo(owners, { date, done: true, ...(on ? { doneOn: on } : {}), ...over });
const sel = (base: string, ...overlays: string[]): Selection => ({ base, overlays });
const empty: ViewData = { lists, settings, tasks: [], priorities: [], events: [], notes: [] };
const input = (tasks: Task[], selection: Selection = sel('both'), today: string | null = TODAY): ViewInput => ({ data: { ...empty, tasks }, selection, me: 'alex', today: today ?? undefined });
const ids = (rows: { item: Task }[]) => rows.map(r => r.item.id);

describe('a carried to-do ticked on today', () => {
  it('is a done row of today, with the carried chip, in the done pile; it leaves the open rows', () => {
    const open = todo(['alex'], { date: '2026-10-28' }), carried = ticked(['alex'], OLD, TODAY), own = todo(['alex']);
    const view = dayView(input([open, carried, own]), TODAY);
    expect(ids(view.todosOpen)).toEqual([open.id, own.id]);
    expect(ids(view.todosDone)).toEqual([carried.id]);
    expect(view.todosDone[0]).toMatchObject({ carried: true, color: 'green', linked: false });
    expect(view.todosDone[0].wentTo).toBeUndefined();
    expect(view.todosDone[0].item).toBe(carried);
  });
  it('comes before today\'s own done to-dos, oldest day first, each day in its own order', () => {
    const ownDone = ticked(['alex'], TODAY, TODAY, { pos: 1 });
    const lateMon = ticked(['alex'], OLD, TODAY, { pos: 2000 }), earlyMon = ticked(['sam'], OLD, TODAY, { pos: 1000 }), older = ticked(['alex'], '2026-10-20', TODAY, { pos: 9000 });
    const view = dayView(input([ownDone, lateMon, older, earlyMon]), TODAY);
    expect(ids(view.todosDone)).toEqual([older.id, earlyMon.id, lateMon.id, ownDone.id]);
    expect(view.todosDone.map(r => r.carried)).toEqual([true, true, true, undefined]);
  });
  it('counts as a done row, not an open one: the counters and the open rows ignore it, and it takes one of the last lines', () => {
    const carried = ticked(['alex'], OLD, TODAY), open = todo(['alex'], { date: '2026-10-28' });
    const tasks = [carried, open];
    const view = dayView(input(tasks), TODAY);
    expect(view.caps.alex.todosOpen).toEqual({ used: 1, max: CAPS.dayTodosPerList, over: false });
    expect(todoCounter(tasks, TODAY, 'alex', undefined, TODAY).used).toBe(1);
    // Not an open row of today: the one open row is the carried open to-do, and today has none of its own.
    expect(ids(view.todosOpen)).toEqual([open.id]);
    expect(view.todosOpen.filter(r => !r.carried)).toEqual([]);
    const slots = todoSlots(view.todosOpen, view.todosDone);
    expect(slots.filled).toHaveLength(1);
    expect(ids(slots.done)).toEqual([carried.id]);
    expect(slots.empty).toBe(CAPS.dayTodosPerList - 2);
  });
  it('is one row for a linked to-do, in both lists\' views, and follows the selection', () => {
    const both = ticked(['sam', 'alex'], OLD, TODAY), mine = ticked(['alex'], OLD, TODAY), hers = ticked(['sam'], OLD, TODAY), camp = ticked([CAMP], OLD, TODAY);
    const tasks = [both, mine, hers, camp];
    expect(ids(dayView(input(tasks, sel('both')), TODAY).todosDone)).toEqual([both.id, mine.id, hers.id]);
    expect(ids(dayView(input(tasks, sel('alex')), TODAY).todosDone)).toEqual([both.id, mine.id]);
    expect(ids(dayView(input(tasks, sel('sam')), TODAY).todosDone)).toEqual([both.id, hers.id]);
    expect(ids(dayView(input(tasks, sel('alex', CAMP)), TODAY).todosDone)).toEqual([both.id, mine.id, camp.id]);
  });
});

describe('the same to-do on its own earlier day', () => {
  it('shows unchecked, in the open rows, pointing at the day it was done on', () => {
    const open = todo(['alex'], { date: OLD, pos: 1 }), went = ticked(['alex'], OLD, TODAY, { pos: 2 });
    const view = dayView(input([went, open]), OLD);
    expect(ids(view.todosOpen)).toEqual([open.id, went.id]);
    expect(view.todosDone).toEqual([]);
    expect(view.todosOpen[1]).toMatchObject({ wentTo: TODAY, color: 'green' });
    expect(view.todosOpen[1].carried).toBeUndefined();
    expect(view.todosOpen[1].item).toBe(went);
    expect(view.todosOpen[0].wentTo).toBeUndefined();
  });
  it('comes after the real open rows, whatever its own order, and before the done ones', () => {
    const a = todo(['alex'], { date: OLD, pos: 10 }), went = ticked(['alex'], OLD, TODAY, { pos: 20 }), c = todo(['alex'], { date: OLD, pos: 30 }), done = ticked(['alex'], OLD, undefined, { pos: 5 });
    const view = dayView(input([c, done, went, a]), OLD);
    expect(ids(view.todosOpen)).toEqual([a.id, c.id, went.id]);
    expect(ids(view.todosDone)).toEqual([done.id]);
  });
  it('never takes a line from a real open to-do: 13 open and one pointer all show, "+N more" is only open to-dos', () => {
    const opens = Array.from({ length: CAPS.dayTodosPerList }, (_, i) => todo(['alex'], { date: OLD, pos: 100 + i })), went = ticked(['alex'], OLD, TODAY, { pos: 1 });
    const view = dayView(input([went, ...opens]), OLD);
    expect(view.caps.alex.todosOpen).toMatchObject({ used: CAPS.dayTodosPerList, over: true });
    const slots = todoSlots(view.todosOpen, view.todosDone);
    expect(ids(slots.filled)).toEqual([...opens.map(t => t.id), went.id]);
    expect(slots.more).toEqual([]);
    expect(slots.empty).toBe(0);
    // One open to-do too many: only it waits behind "+1 more", the pointer keeps its line.
    const extra = todo(['alex'], { date: OLD, pos: 500 });
    const over = todoSlots(dayView(input([went, extra, ...opens]), OLD).todosOpen);
    expect(ids(over.more)).toEqual([extra.id]);
    expect(ids(over.filled)).toEqual([...opens.map(t => t.id), went.id]);
  });
  it('takes a line like a done row: the blank lines left shrink by one', () => {
    const open = todo(['alex'], { date: OLD }), went = ticked(['alex'], OLD, TODAY), done = ticked(['alex'], OLD);
    const view = dayView(input([open, went, done]), OLD);
    expect(todoSlots(view.todosOpen, view.todosDone).empty).toBe(CAPS.dayTodosPerList - 3);
  });
  it('is not counted as an open to-do, so the cap and the counter stay as the server has them', () => {
    const went = ticked(['alex'], OLD, TODAY), open = todo(['alex'], { date: OLD });
    const view = dayView(input([went, open]), OLD);
    expect(view.caps.alex.todosOpen.used).toBe(1);
    expect(todoCounter([went, open], OLD, 'alex').used).toBe(1);
    // Its own day still draws it, unchecked with its "→" chip, but the record is done: the one open record there is the other.
    expect(ids(view.todosOpen.filter(r => !r.item.done))).toEqual([open.id]);
    expect(fullOwnerOnEdit([went], went, OLD, went.owners)).toBeUndefined();
  });
  it('is not carried onto today any more once done, and the days between show nothing', () => {
    const went = ticked(['alex'], OLD, TODAY);
    expect(isCarried(went, TODAY, TODAY)).toBe(false);
    expect(ids(carriedTodos([went], TODAY, TODAY, resolveLanes(sel('both'), lists, 'alex'), lists, settings))).toEqual([]);
    for (const day of ['2026-10-27', '2026-10-31', '2026-11-01']) {
      const view = dayView(input([went]), day);
      expect(view.todosOpen).toEqual([]);
      expect(view.todosDone).toEqual([]);
    }
  });
  it('shows a linked one once, and follows the selection', () => {
    const both = ticked(['sam', 'alex'], OLD, TODAY);
    expect(ids(dayView(input([both], sel('both')), OLD).todosOpen)).toEqual([both.id]);
    expect(ids(dayView(input([both], sel('alex', CAMP)), OLD).todosOpen)).toEqual([both.id]);
    expect(dayView(input([ticked(['sam'], OLD, TODAY)], sel('alex')), OLD).todosOpen).toEqual([]);
  });
});

describe('page dates', () => {
  it('lists a to-do ticked on a past day other than today as done on that day, and unchecked on its own', () => {
    const t = ticked(['alex'], OLD, '2026-10-29');
    expect(ids(dayView(input([t]), '2026-10-29').todosDone)).toEqual([t.id]);
    expect(dayView(input([t]), '2026-10-29').todosDone[0].carried).toBe(true);
    expect(dayView(input([t]), OLD).todosOpen[0].wentTo).toBe('2026-10-29');
    expect(dayView(input([t]), TODAY).todosDone).toEqual([]);
    expect(dayView(input([t]), '2026-10-30').todosOpen).toEqual([]);
  });
  it('shows the same without a today (core has no clock): doneOn decides, not the clock', () => {
    const t = ticked(['alex'], OLD, '2026-10-29');
    expect(ids(dayView(input([t], sel('both'), null), '2026-10-29').todosDone)).toEqual([t.id]);
    expect(dayView(input([t], sel('both'), null), OLD).todosOpen[0].wentTo).toBe('2026-10-29');
  });
  it('week and month to-dos have no day they were done on', () => {
    const week = todo(['alex'], { scope: 'week', date: '2026-10-26', done: true }), month = todo(['alex'], { scope: 'month', date: '2026-11-01', done: true });
    expect(weekView(input([week]), '2026-10-26').todosDone[0].wentTo).toBeUndefined();
    expect(ids(weekView(input([week]), '2026-10-26').todosDone)).toEqual([week.id]);
    expect(ids(monthView(input([month]), '2026-11-01').todosDone)).toEqual([month.id]);
    expect(visibleTodos([week], 'week', '2026-10-26', resolveLanes(sel('both'), lists, 'alex'), lists, settings)[0]).not.toHaveProperty('wentTo');
  });
});

describe('a to-do checked on its own day, and the legacy ones without doneOn', () => {
  it('checked on its own day with doneOn equal to its date is an ordinary done row there', () => {
    const own = ticked(['alex'], TODAY, TODAY);
    const view = dayView(input([own]), TODAY);
    expect(ids(view.todosDone)).toEqual([own.id]);
    expect(view.todosDone[0].carried).toBeUndefined();
    expect(view.todosDone[0].wentTo).toBeUndefined();
    expect(view.todosOpen).toEqual([]);
  });
  it('without doneOn (all of the data before 0.14.0) it is done on its own date and nowhere else', () => {
    const old = ticked(['alex'], OLD);
    expect(ids(dayView(input([old]), OLD).todosDone)).toEqual([old.id]);
    expect(dayView(input([old]), OLD).todosOpen).toEqual([]);
    expect(dayView(input([old]), TODAY).todosDone).toEqual([]);
    expect(dayView(input([old]), TODAY).todosOpen).toEqual([]);
    expect(rowDone(dayView(input([old]), OLD).todosDone[0])).toBe(true);
  });
  it('a to-do of a later day ticked on its own page is an ordinary done row there', () => {
    const later = ticked(['alex'], TUE, TUE);
    expect(ids(dayView(input([later]), TUE).todosDone)).toEqual([later.id]);
    expect(dayView(input([later]), TODAY).todosDone).toEqual([]);
  });
});

describe('unchecking', () => {
  it('a to-do with its doneOn removed is open on its own day again and carried onto today again', () => {
    const { doneOn: _gone, ...rest } = ticked(['alex'], OLD, TODAY);
    const open: Task = { ...rest, done: false };
    expect(ids(dayView(input([open]), OLD).todosOpen)).toEqual([open.id]);
    expect(dayView(input([open]), OLD).todosOpen[0].wentTo).toBeUndefined();
    expect(dayView(input([open]), TODAY).todosOpen[0].carried).toBe(true);
    expect(dayView(input([open]), TODAY).todosDone).toEqual([]);
  });
});

describe('accomplishedTodos and rowDone', () => {
  const lanes = resolveLanes(sel('both'), lists, 'alex');
  it('lists only day to-dos ticked on that date from an earlier day', () => {
    const carried = ticked(['alex'], OLD, TODAY), own = ticked(['alex'], TODAY, TODAY), other = ticked(['alex'], OLD, '2026-10-29'), open = todo(['alex'], { date: OLD });
    const week = todo(['alex'], { scope: 'week', date: '2026-10-26', done: true, doneOn: TODAY });
    expect(ids(accomplishedTodos([carried, own, other, open, week], TODAY, lanes, lists, settings))).toEqual([carried.id]);
  });
  it('breaks a tie of day and pos by id', () => {
    const b = { ...ticked(['alex'], OLD, TODAY, { pos: 5 }), id: 'b' }, a = { ...ticked(['alex'], OLD, TODAY, { pos: 5 }), id: 'a' };
    expect(ids(accomplishedTodos([b, a], TODAY, lanes, lists, settings))).toEqual(['a', 'b']);
  });
  it('rowDone is done and not pointing elsewhere', () => {
    const t = ticked(['alex'], OLD, TODAY), color = 'green' as const;
    expect(rowDone({ item: t, color, linked: false })).toBe(true);
    expect(rowDone({ item: t, color, linked: false, wentTo: TODAY })).toBe(false);
    expect(rowDone({ item: todo(['alex']), color, linked: false })).toBe(false);
  });
});
