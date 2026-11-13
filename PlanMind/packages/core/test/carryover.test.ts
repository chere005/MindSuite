import { describe, it, expect } from 'vitest';
import { CAPS, type ListRecord, type Selection, type Settings, type Task, type ViewData, type ViewInput } from '../src/model';
import { todoCounter, fullOwnerOnEdit, todoSlots } from '../src/limits';
import { carriedTodos, isCarried } from '../src/placement';
import { resolveLanes } from '../src/selection';
import { dayView, monthView, weekView } from '../src/views';
import { todayIn } from '../src/planner';

// R10 (Alex, 2026-10-31): the Day view of TODAY also lists the open day to-dos of earlier days. A view only: nothing is written, the
// to-dos stay on their own day, and no other day shows them. R9's slots are filled by these first, then by today's own.
const CAMP = '11111111-1111-4111-8111-111111111111';
const TODAY = '2026-10-31';
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
const sel = (base: string, ...overlays: string[]): Selection => ({ base, overlays });
const empty: ViewData = { lists, settings, tasks: [], priorities: [], events: [], notes: [] };
/** `today` null is a view without a clock. */
const input = (tasks: Task[], selection: Selection = sel('both'), today: string | null = TODAY): ViewInput => ({ data: { ...empty, tasks }, selection, me: 'alex', today: today ?? undefined });
const ids = (rows: { item: Task }[]) => rows.map(r => r.item.id);

describe('dayView carries earlier days\' open to-dos onto today', () => {
  it('lists them before today\'s own, oldest day first, each day in its own order, and marks them', () => {
    const own1 = todo(['alex'], { pos: 100 }), own2 = todo(['sam'], { pos: 50 });
    const older = todo(['alex'], { date: '2026-10-20', pos: 9000 });
    const monLate = todo(['alex'], { date: '2026-10-27', pos: 2000 }), monEarly = todo(['sam'], { date: '2026-10-27', pos: 1000 });
    const yesterday = todo(['sam', 'alex'], { date: '2026-10-30' });
    const view = dayView(input([own1, yesterday, own2, monLate, older, monEarly]), TODAY);
    expect(ids(view.todosOpen)).toEqual([older.id, monEarly.id, monLate.id, yesterday.id, own2.id, own1.id]);
    expect(view.todosOpen.map(r => r.carried)).toEqual([true, true, true, true, undefined, undefined]);
    expect(view.todosOpen[0]).toMatchObject({ color: 'green', linked: false });
    expect(view.todosOpen[3]).toMatchObject({ color: 'purple', linked: true });
  });
  it('leaves the records alone: the same objects, dated where they were', () => {
    const old = todo(['alex'], { date: '2026-10-27' });
    const tasks = [old];
    const before = JSON.stringify(tasks);
    const view = dayView(input(tasks), TODAY);
    expect(view.todosOpen[0].item).toBe(old);
    expect(view.todosOpen[0].item.date).toBe('2026-10-27');
    expect(JSON.stringify(tasks)).toBe(before);
  });
  it('is the old day\'s own open list too: the item shows on its own day as before', () => {
    const old = todo(['alex'], { date: '2026-10-27' });
    const own = dayView(input([old]), '2026-10-27');
    expect(ids(own.todosOpen)).toEqual([old.id]);
    expect(own.todosOpen[0].carried).toBeUndefined();
  });
  it('never shows them on a day after today, or on a past day other than their own', () => {
    const mon = todo(['alex'], { date: '2026-10-27' }), tue = todo(['alex'], { date: '2026-10-28' });
    const tasks = [mon, tue];
    expect(ids(dayView(input(tasks), '2026-11-01').todosOpen)).toEqual([]);
    expect(ids(dayView(input(tasks), '2026-12-25').todosOpen)).toEqual([]);
    expect(ids(dayView(input(tasks), '2026-10-30').todosOpen)).toEqual([]);
    expect(ids(dayView(input(tasks), '2026-10-28').todosOpen)).toEqual([tue.id]);
    expect(ids(dayView(input(tasks), '2026-10-27').todosOpen)).toEqual([mon.id]);
  });
  it('does not carry anything for a later date than today\'s own to-dos (a future to-do stays on its day)', () => {
    const future = todo(['alex'], { date: '2026-11-03' });
    expect(ids(dayView(input([future]), TODAY).todosOpen)).toEqual([]);
    expect(ids(dayView(input([future]), '2026-11-03').todosOpen)).toEqual([future.id]);
  });
  it('carries nothing when the view has no today (core has no clock)', () => {
    const old = todo(['alex'], { date: '2026-10-27' });
    expect(dayView(input([old], sel('both'), null), TODAY).todosOpen).toEqual([]);
  });
  it('does not carry done to-dos, nor week or month to-dos, however old', () => {
    const done = todo(['alex'], { date: '2026-10-27', done: true });
    const week = todo(['alex'], { scope: 'week', date: '2026-10-26' }), month = todo(['alex'], { scope: 'month', date: '2026-10-01' });
    const view = dayView(input([done, week, month]), TODAY);
    expect(view.todosOpen).toEqual([]);
    expect(view.todosDone).toEqual([]);
  });
  it('keeps today\'s own done to-dos in Done, and an old done one only on its own day', () => {
    const doneToday = todo(['alex'], { done: true }), doneOld = todo(['alex'], { date: '2026-10-27', done: true });
    expect(ids(dayView(input([doneToday, doneOld]), TODAY).todosDone)).toEqual([doneToday.id]);
    expect(ids(dayView(input([doneToday, doneOld]), '2026-10-27').todosDone)).toEqual([doneOld.id]);
  });
  it('respects the selection: a carried to-do shows when its list is shown', () => {
    const mine = todo(['alex'], { date: '2026-10-27' }), hers = todo(['sam'], { date: '2026-10-27' }), both = todo(['sam', 'alex'], { date: '2026-10-28' }), camp = todo([CAMP], { date: '2026-10-29' });
    const tasks = [mine, hers, both, camp];
    expect(ids(dayView(input(tasks, sel('alex')), TODAY).todosOpen)).toEqual([mine.id, both.id]);
    expect(ids(dayView(input(tasks, sel('sam')), TODAY).todosOpen)).toEqual([hers.id, both.id]);
    expect(ids(dayView(input(tasks, sel('both')), TODAY).todosOpen)).toEqual([mine.id, hers.id, both.id]);
    expect(ids(dayView(input(tasks, sel(CAMP)), TODAY).todosOpen)).toEqual([camp.id]);
    expect(ids(dayView(input(tasks, sel('alex', CAMP)), TODAY).todosOpen)).toEqual([mine.id, both.id, camp.id]);
  });
  it('lists a linked to-do once, under Both and under an overlay', () => {
    const both = todo(['sam', 'alex'], { date: '2026-10-28' });
    expect(ids(dayView(input([both], sel('both')), TODAY).todosOpen)).toEqual([both.id]);
    expect(ids(dayView(input([both], sel('alex', CAMP)), TODAY).todosOpen)).toEqual([both.id]);
  });
  it('counts them in the lists\' open counters, once for each owner of a linked one', () => {
    const tasks = [todo(['alex'], { date: '2026-10-27' }), todo(['sam', 'alex'], { date: '2026-10-28' }), todo(['alex'])];
    const view = dayView(input(tasks), TODAY);
    expect(view.caps.alex.todosOpen).toEqual({ used: 3, max: CAPS.dayTodosPerList, over: false });
    expect(view.caps.sam.todosOpen.used).toBe(1);
    // Not on another day: the same tasks are only their own there.
    expect(dayView(input(tasks), '2026-10-28').caps.alex.todosOpen.used).toBe(1);
  });
  it('leaves Week, Month and the record\'s own day as they were', () => {
    const old = todo(['alex'], { date: '2026-10-27' });
    const withToday = input([old]), without = input([old], sel('both'), null);
    expect(weekView(withToday, '2026-10-26')).toEqual(weekView(without, '2026-10-26'));
    expect(monthView(withToday, '2026-10-01')).toEqual(monthView(without, '2026-10-01'));
    // Today holds none of its own: the one row there is the carried view of the 27th's record, which stays open on the 27th.
    expect(dayView(withToday, TODAY).todosOpen.filter(r => !r.carried)).toEqual([]);
    expect(dayView(without, TODAY).todosOpen).toEqual([]);
    expect(ids(dayView(withToday, '2026-10-27').todosOpen)).toEqual([old.id]);
  });
  it('can hold more than the slots: the whole carry-over is there, todoSlots puts the surplus behind more', () => {
    const many = Array.from({ length: CAPS.dayTodosPerList }, (_, i) => todo(['alex'], { date: `2026-10-${String(10 + i).padStart(2, '0')}` }));
    const own = todo(['alex']);
    const view = dayView(input([...many, own]), TODAY);
    expect(view.todosOpen).toHaveLength(CAPS.dayTodosPerList + 1);
    expect(view.todosOpen.at(-1)!.item.id).toBe(own.id);
    const slots = todoSlots(view.todosOpen);
    expect(slots.filled).toHaveLength(CAPS.dayTodosPerList);
    expect(ids(slots.more)).toEqual([own.id]);
    expect(slots.empty).toBe(0);
  });
  it('picks its day from the session timezone: the same instant is two different todays', () => {
    // 2026-11-01T03:30Z is still the evening of Oct 31 in Chicago and already the morning of Nov 1 in Auckland.
    const now = new Date('2026-11-01T03:30:00Z');
    const chicago = todayIn('America/Chicago', now), auckland = todayIn('Pacific/Auckland', now);
    expect([chicago, auckland]).toEqual(['2026-10-31', '2026-11-01']);
    const oct31 = todo(['alex'], { date: '2026-10-31' }), oct30 = todo(['alex'], { date: '2026-10-30' });
    const tasks = [oct31, oct30];
    // Chicago's today is Oct 31: Oct 30 carries, Oct 31 is its own, and Nov 1 (a day ahead there) shows nothing carried.
    expect(ids(dayView(input(tasks, sel('alex'), chicago), chicago).todosOpen)).toEqual([oct30.id, oct31.id]);
    expect(dayView(input(tasks, sel('alex'), chicago), chicago).todosOpen.map(r => r.carried)).toEqual([true, undefined]);
    expect(ids(dayView(input(tasks, sel('alex'), chicago), auckland).todosOpen)).toEqual([]);
    // Auckland's today is Nov 1: both carry.
    expect(ids(dayView(input(tasks, sel('alex'), auckland), auckland).todosOpen)).toEqual([oct30.id, oct31.id]);
    expect(dayView(input(tasks, sel('alex'), auckland), auckland).todosOpen.map(r => r.carried)).toEqual([true, true]);
  });
  it('rolls over at midnight: the same data carries one more day the day after', () => {
    const yesterday = todo(['alex'], { date: '2026-10-31' });
    expect(ids(dayView(input([yesterday], sel('alex'), '2026-10-31'), '2026-10-31').todosOpen)).toEqual([yesterday.id]);
    expect(dayView(input([yesterday], sel('alex'), '2026-10-31'), '2026-10-31').todosOpen[0].carried).toBeUndefined();
    expect(dayView(input([yesterday], sel('alex'), '2026-11-01'), '2026-11-01').todosOpen[0].carried).toBe(true);
    // Month and year edges compare as dates, not as numbers.
    const dec = todo(['alex'], { date: '2026-12-30' });
    expect(ids(dayView(input([dec], sel('alex'), '2027-01-02'), '2027-01-02').todosOpen)).toEqual([dec.id]);
  });
});

describe('isCarried and carriedTodos', () => {
  const lanes = resolveLanes(sel('both'), lists, 'alex');
  it('isCarried needs today to be the viewed date, an open day to-do and an earlier date', () => {
    const t = todo(['alex'], { date: '2026-10-27' });
    expect(isCarried(t, TODAY, TODAY)).toBe(true);
    expect(isCarried(t, TODAY, undefined)).toBe(false);
    expect(isCarried(t, '2026-10-30', TODAY)).toBe(false);
    expect(isCarried({ ...t, date: TODAY }, TODAY, TODAY)).toBe(false);
    expect(isCarried({ ...t, date: '2026-11-02' }, TODAY, TODAY)).toBe(false);
    expect(isCarried({ ...t, done: true }, TODAY, TODAY)).toBe(false);
    expect(isCarried({ ...t, scope: 'week' }, TODAY, TODAY)).toBe(false);
  });
  it('breaks a tie of day and pos by id, so the order is stable', () => {
    const b = { ...todo(['alex'], { date: '2026-10-27', pos: 5 }), id: 'b' }, a = { ...todo(['alex'], { date: '2026-10-27', pos: 5 }), id: 'a' };
    expect(ids(carriedTodos([b, a], TODAY, TODAY, lanes, lists, settings))).toEqual(['a', 'b']);
  });
});

describe('todoCounter on today counts the carried to-dos', () => {
  it('adds the earlier days\' open to-dos of the list to today\'s own, once for a linked one per owner', () => {
    const tasks = [todo(['alex']), todo(['alex'], { date: '2026-10-27' }), todo(['sam', 'alex'], { date: '2026-10-28' }), todo(['sam'], { date: '2026-10-28' })];
    expect(todoCounter(tasks, TODAY, 'alex', undefined, TODAY).used).toBe(3);
    expect(todoCounter(tasks, TODAY, 'sam', undefined, TODAY).used).toBe(2);
  });
  it('is unchanged without a today, and for any date that is not today', () => {
    const tasks = [todo(['alex']), todo(['alex'], { date: '2026-10-27' })];
    expect(todoCounter(tasks, TODAY, 'alex').used).toBe(1);
    expect(todoCounter(tasks, TODAY, 'alex', undefined, '2026-11-02').used).toBe(1);
    expect(todoCounter(tasks, '2026-11-02', 'alex', undefined, TODAY).used).toBe(0);
    expect(todoCounter(tasks, '2026-10-27', 'alex', undefined, TODAY).used).toBe(1);
  });
  it('ignores done and non-day to-dos, and the one being edited', () => {
    const open = todo(['alex'], { date: '2026-10-27' });
    const tasks = [open, todo(['alex'], { date: '2026-10-27', done: true }), todo(['alex'], { scope: 'week', date: '2026-10-26' })];
    expect(todoCounter(tasks, TODAY, 'alex', undefined, TODAY).used).toBe(1);
    expect(todoCounter(tasks, TODAY, 'alex', open.id, TODAY).used).toBe(0);
  });
  it('is full when carried and own together reach the cap', () => {
    const max = CAPS.dayTodosPerList;
    const carried = Array.from({ length: max - 2 }, () => todo(['alex'], { date: '2026-10-27' }));
    const tasks = [...carried, todo(['alex'])];
    expect(todoCounter(tasks, TODAY, 'alex', undefined, TODAY)).toEqual({ used: max - 1, max, over: false });
    expect(todoCounter([...tasks, todo(['alex'])], TODAY, 'alex', undefined, TODAY).over).toBe(true);
    expect(todoCounter([...tasks, todo(['alex'])], TODAY, 'alex').over).toBe(false);
  });
});

describe('fullOwnerOnEdit with a today', () => {
  const max = CAPS.dayTodosPerList;
  const fullOnToday = () => Array.from({ length: max }, (_, i) => todo(['alex'], i % 2 ? { date: '2026-10-27' } : {}));
  it('lets a carried to-do be edited, or moved to today, in a list that is full: it is already counted there', () => {
    const tasks = fullOnToday();
    const carried = tasks.find(t => t.date === '2026-10-27')!, own = tasks.find(t => t.date === TODAY)!;
    expect(fullOwnerOnEdit(tasks, carried, TODAY, carried.owners, TODAY)).toBeUndefined();
    expect(fullOwnerOnEdit(tasks, own, TODAY, own.owners, TODAY)).toBeUndefined();
  });
  it('lets a carried to-do be edited when today holds more than 13 (time passing did it): it is already counted there, as the server has it', () => {
    // 13 of today's own and two carried: 15 open on today, over the cap without any write having been refused.
    const tasks = [...Array.from({ length: max }, () => todo(['alex'])), todo(['alex'], { date: '2026-10-27' }), todo(['alex'], { date: '2026-10-28' })];
    const carried = tasks.find(t => t.date === '2026-10-27')!, own = tasks[0];
    expect(fullOwnerOnEdit(tasks, carried, TODAY, carried.owners, TODAY)).toBeUndefined();
    expect(fullOwnerOnEdit(tasks, own, TODAY, own.owners, TODAY)).toBeUndefined();
    // A to-do that is not on today yet still has no room.
    const later = todo(['alex'], { date: '2026-11-05' });
    expect(fullOwnerOnEdit([...tasks, later], later, TODAY, later.owners, TODAY)).toBe('alex');
  });
  it('refuses a to-do that is not counted on today yet, when today is full including the carried ones', () => {
    const tasks = fullOnToday();
    const future = todo(['alex'], { date: '2026-11-05' });
    expect(fullOwnerOnEdit([...tasks, future], future, TODAY, future.owners, TODAY)).toBe('alex');
    // Without the carried ones counted, the same list would have room (the server decides with them).
    expect(fullOwnerOnEdit([...tasks, future], future, TODAY, future.owners)).toBeUndefined();
  });
  it('a to-do of another list or day that lands on today needs room for each of its new owners', () => {
    const tasks = fullOnToday();
    const hers = todo(['sam'], { date: '2026-11-05' });
    expect(fullOwnerOnEdit([...tasks, hers], hers, TODAY, ['sam'], TODAY)).toBeUndefined();
    expect(fullOwnerOnEdit([...tasks, hers], hers, TODAY, ['sam', 'alex'], TODAY)).toBe('alex');
  });
  it('a done to-do is never refused', () => {
    const tasks = fullOnToday();
    const done = todo(['alex'], { date: '2026-10-27', done: true });
    expect(fullOwnerOnEdit([...tasks, done], done, TODAY, done.owners, TODAY)).toBeUndefined();
  });
  it('a carried to-do moved to another day than today is counted there by its new date alone', () => {
    const tasks = fullOnToday();
    const carried = tasks.find(t => t.date === '2026-10-27')!;
    expect(fullOwnerOnEdit(tasks, carried, '2026-11-05', carried.owners, TODAY)).toBeUndefined();
  });
});

describe('todoSlots: 13 ruled slots, filled top-down', () => {
  const rows = (count: number) => Array.from({ length: count }, () => ({ item: todo(['alex']), color: 'green' as const, linked: false }));
  it('has 13 slots in all: the open rows and the blank lines that remain', () => {
    expect(CAPS.dayTodosPerList).toBe(13);
    for (const count of [0, 1, 7, 12]) {
      const slots = todoSlots(rows(count));
      expect(slots.filled).toHaveLength(count);
      expect(slots.empty).toBe(13 - count);
      expect(slots.more).toEqual([]);
    }
  });
  it('has no blank line once the slots are full, and puts the rest behind more', () => {
    expect(todoSlots(rows(13))).toMatchObject({ empty: 0, more: [] });
    const twenty = rows(20), slots = todoSlots(twenty);
    expect(slots.filled).toEqual(twenty.slice(0, 13));
    expect(slots.more).toEqual(twenty.slice(13));
    expect(slots.empty).toBe(0);
  });
});
