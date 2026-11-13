import { describe, it, expect } from 'vitest';
import { CAPS, type ListRecord, type Note, type Priority, type ScheduleEvent, type Selection, type Settings, type Task, type ViewData, type ViewInput } from '../src/model';
import { resolveLanes } from '../src/selection';
import { visibleTodos, priorityCells, eventCells, noteLanes, noteKey, ownerLanes, inLanes } from '../src/placement';
import { dayView, weekView, monthView, monthGrid } from '../src/views';

const CAMP = '11111111-1111-4111-8111-111111111111';
const HOME = '22222222-2222-4222-8222-222222222222';
const DAY = '2026-10-30';
const stampList = { revision: 1, updatedAt: '2026-10-30T00:00:00Z' };
const lists: ListRecord[] = [
  { id: 'sam', kind: 'person', name: 'Sam', color: 'yellow', order: 0, ...stampList },
  { id: 'alex', kind: 'person', name: 'Alex', color: 'green', order: 1, ...stampList },
  { id: CAMP, kind: 'custom', name: 'Camping', color: 'blue', order: 2, ...stampList },
  { id: HOME, kind: 'custom', name: 'Home', color: 'orange', order: 3, ...stampList },
];
const settings: Settings = { bothColor: 'purple', revision: 1, updatedAt: '2026-10-30T00:00:00Z' };
const stamp = { revision: 1, ak: 'a', createdBy: 'alex', updatedBy: 'alex', createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z' } as const;
let n = 0;
const todo = (owners: string[], over: Partial<Task> = {}): Task => ({ id: `t${++n}`, scope: 'day', date: DAY, owners, title: 'x', done: false, pos: n * 1024, ...stamp, ...over });
const prio = (slots: Record<string, number>, over: Partial<Priority> = {}): Priority => ({ id: `p${++n}`, date: DAY, owners: Object.keys(slots).sort(), slots, text: 'x', ...stamp, ...over });
const event = (owners: string[], start: number, length = 30, over: Partial<ScheduleEvent> = {}): ScheduleEvent => ({ id: `e${++n}`, date: DAY, owners, text: 'x', start, length, ...stamp, ...over });
const note = (key: string, text = 'hello', revision = 3): Note => {
  const [scope, period, listId, field] = key.split(':');
  return { key, scope, period, listId, field, text, revision, updatedBy: 'alex', updatedAt: '2026-10-30T00:00:00Z' } as Note;
};
const sel = (base: string, ...overlays: string[]): Selection => ({ base, overlays });
const empty: ViewData = { lists, settings, tasks: [], priorities: [], events: [], notes: [] };
const input = (data: Partial<ViewData>, selection: Selection = sel('both'), me: 'sam' | 'alex' = 'alex'): ViewInput => ({ data: { ...empty, ...data }, selection, me });
const lanesFor = (selection: Selection, me: 'sam' | 'alex' = 'alex') => resolveLanes(selection, lists, me);
const h = (hour: number, minute = 0) => hour * 60 + minute;

describe('lane helpers', () => {
  const lanes = lanesFor(sel('both', CAMP));
  it('ownerLanes gives the visible lane indexes in order, inLanes says whether any is visible', () => {
    expect(ownerLanes(['sam', 'alex'], lanes)).toEqual([0, 1]);
    expect(ownerLanes([CAMP], lanes)).toEqual([2]);
    expect(ownerLanes([HOME], lanes)).toEqual([]);
    expect(inLanes(['sam', 'alex'], lanesFor(sel('sam')))).toBe(true);
    expect(inLanes(['alex'], lanesFor(sel('sam')))).toBe(false);
  });
  it('noteKey is the server key', () => {
    expect(noteKey('week', '2026-10-26', 'sam', 'priorities')).toBe('week:2026-10-26:sam:priorities');
  });
});

describe('visibleTodos', () => {
  const alex = todo(['alex']), sam = todo(['sam']), both = todo(['sam', 'alex']), camp = todo([CAMP]);
  const tasks = [alex, sam, both, camp];
  const ids = (selection: Selection, me: 'sam' | 'alex' = 'alex') =>
    visibleTodos(tasks, 'day', DAY, lanesFor(selection, me), lists, settings).map(r => r.item.id);

  it('under Both shows Sam, Alex and linked, and no custom list', () => {
    expect(ids(sel('both'))).toEqual([alex.id, sam.id, both.id]);
  });
  it('a single list shows its own items and the linked ones, nobody else', () => {
    expect(ids(sel('alex'))).toEqual([alex.id, both.id]);
    expect(ids(sel('sam'))).toEqual([sam.id, both.id]);
    expect(ids(sel(CAMP))).toEqual([camp.id]);
  });
  it('overlays add their list, and Both never includes a custom list on its own', () => {
    expect(ids(sel('both', CAMP))).toEqual([alex.id, sam.id, both.id, camp.id]);
    expect(ids(sel('alex', CAMP))).toEqual([alex.id, both.id, camp.id]);
  });
  it('is one list in pos order, open rows before done rows', () => {
    const first = todo(['alex'], { pos: 3000 }), second = todo(['sam'], { pos: 1000 }), finished = todo(['alex'], { pos: 500, done: true });
    const third = todo(['sam', 'alex'], { pos: 2000 });
    const rows = visibleTodos([first, finished, second, third], 'day', DAY, lanesFor(sel('both')), lists, settings);
    expect(rows.map(r => r.item.id)).toEqual([second.id, third.id, first.id, finished.id]);
  });
  it('breaks a pos tie by id so the order is stable', () => {
    const b = todo(['alex'], { id: 'b', pos: 10 }), a = todo(['alex'], { id: 'a', pos: 10 });
    expect(visibleTodos([b, a], 'day', DAY, lanesFor(sel('alex')), lists, settings).map(r => r.item.id)).toEqual(['a', 'b']);
  });
  it('keeps one scope and period apart from the others', () => {
    const week = todo(['alex'], { scope: 'week', date: '2026-10-26' });
    const month = todo(['alex'], { scope: 'month', date: '2026-10-01' });
    const otherDay = todo(['alex'], { date: '2026-10-31' });
    const all = [alex, week, month, otherDay];
    const lanes = lanesFor(sel('alex'));
    expect(visibleTodos(all, 'day', DAY, lanes, lists, settings).map(r => r.item.id)).toEqual([alex.id]);
    expect(visibleTodos(all, 'week', '2026-10-26', lanes, lists, settings).map(r => r.item.id)).toEqual([week.id]);
    expect(visibleTodos(all, 'month', '2026-10-01', lanes, lists, settings).map(r => r.item.id)).toEqual([month.id]);
    expect(visibleTodos(all, 'week', DAY, lanes, lists, settings)).toEqual([]);
  });
  it('colors the circle per owner: list color, Both color for a linked to-do', () => {
    const rows = visibleTodos(tasks, 'day', DAY, lanesFor(sel('both', CAMP)), lists, settings);
    const byId = Object.fromEntries(rows.map(r => [r.item.id, r]));
    expect(byId[alex.id]).toMatchObject({ color: 'green', linked: false });
    expect(byId[sam.id]).toMatchObject({ color: 'yellow', linked: false });
    expect(byId[both.id]).toMatchObject({ color: 'purple', linked: true });
    expect(byId[camp.id]).toMatchObject({ color: 'blue', linked: false });
  });
  it('follows a changed Both color and does not change its input', () => {
    const copy = JSON.stringify(tasks);
    const rows = visibleTodos(tasks, 'day', DAY, lanesFor(sel('both')), lists, { ...settings, bothColor: 'teal' });
    expect(rows.find(r => r.item.id === both.id)?.color).toBe('teal');
    expect(JSON.stringify(tasks)).toBe(copy);
  });
});

describe('priorityCells', () => {
  const run = (items: Priority[], selection: Selection, me: 'sam' | 'alex' = 'alex') => priorityCells(items, DAY, lanesFor(selection, me), lists, settings);

  it('puts a sole-owner line in its lane on its own line', () => {
    const cells = run([prio({ alex: 2 }), prio({ sam: 4 })], sel('both'));
    expect(cells).toMatchObject([
      { lane: 0, line: 2, span: 1, color: 'green', linked: false },
      { lane: 1, line: 4, span: 1, color: 'yellow', linked: false },
    ]);
  });
  it('a linked item on the same line in both lists is one purple cell spanning both lanes', () => {
    const linked = prio({ sam: 3, alex: 3 });
    const cells = run([linked], sel('both'));
    expect(cells).toEqual([{ item: linked, lane: 0, span: 2, line: 3, color: 'purple', linked: true }]);
  });
  it('a linked item on different lines is two purple half-lane cells, one in each list', () => {
    const linked = prio({ sam: 2, alex: 4 });
    const cells = run([linked], sel('both'));
    expect(cells).toEqual([
      { item: linked, lane: 1, span: 1, line: 2, color: 'purple', linked: true },
      { item: linked, lane: 0, span: 1, line: 4, color: 'purple', linked: true },
    ]);
  });
  it('the signed-in person is the left lane', () => {
    const linked = prio({ sam: 2, alex: 4 });
    const cells = priorityCells([linked, prio({ sam: 1 })], DAY, lanesFor(sel('both'), 'sam'), lists, settings);
    expect(cells.map(c => [c.line, c.lane])).toEqual([[1, 0], [2, 0], [4, 1]]);
  });
  it('a linked item in a single-list view stays Both-colored, on that list\'s own line', () => {
    const linked = prio({ sam: 2, alex: 4 });
    expect(run([linked], sel('alex'))).toEqual([{ item: linked, lane: 0, span: 1, line: 4, color: 'purple', linked: true }]);
    expect(run([linked], sel('sam'))).toEqual([{ item: linked, lane: 0, span: 1, line: 2, color: 'purple', linked: true }]);
    const same = prio({ sam: 3, alex: 3 });
    expect(run([same], sel('alex'))).toEqual([{ item: same, lane: 0, span: 1, line: 3, color: 'purple', linked: true }]);
  });
  it('an overlay is its own lane after Sam and Alex, and a linked item there stays in the first two', () => {
    const camp = prio({ [CAMP]: 1 }), same = prio({ sam: 1, alex: 1 });
    const cells = run([camp, same], sel('both', CAMP));
    expect(cells.map(c => [c.item.id, c.lane, c.span])).toEqual([[same.id, 0, 2], [camp.id, 2, 1]]);
    expect(cells[1].color).toBe('blue');
  });
  it('leaves out other days and lists that are not lanes', () => {
    const elsewhere = prio({ alex: 1 }, { date: '2026-10-31' });
    const hidden = prio({ sam: 1 }), custom = prio({ [HOME]: 2 });
    expect(run([elsewhere, hidden, custom], sel('alex'))).toEqual([]);
    expect(run([custom], sel('both'))).toEqual([]);
  });
  it('uses the current Both and list colors', () => {
    const cells = priorityCells([prio({ sam: 1, alex: 1 }), prio({ alex: 2 })], DAY, lanesFor(sel('both')), lists.map(l => (l.id === 'alex' ? { ...l, color: 'red' as const } : l)), { ...settings, bothColor: 'pink' });
    expect(cells.map(c => c.color)).toEqual(['pink', 'red']);
  });
  it('draws nothing for an owner that has no line rather than inventing one', () => {
    const broken = prio({ sam: 2, alex: 2 });
    delete (broken.slots as Record<string, number>).sam;
    delete (broken.slots as Record<string, number>).alex;
    expect(run([broken], sel('both'))).toEqual([]);
    expect(run([broken], sel('alex'))).toEqual([]);
    expect(dayView(input({ priorities: [broken] }), DAY).priorities.every(r => r.cells.length === 0)).toBe(true);
  });
  it('orders cells by line, then lane', () => {
    const cells = run([prio({ alex: 3 }), prio({ sam: 3 }), prio({ alex: 1 })], sel('both'));
    expect(cells.map(c => [c.line, c.lane])).toEqual([[1, 0], [3, 0], [3, 1]]);
  });
});

describe('eventCells', () => {
  const run = (items: ScheduleEvent[], selection: Selection, me: 'sam' | 'alex' = 'alex') => eventCells(items, DAY, lanesFor(selection, me), lists, settings);

  it('a linked event under Both is one cell spanning both lanes, with its start and end', () => {
    const lunch = event(['sam', 'alex'], h(12), 60);
    expect(run([lunch], sel('both'))).toEqual([{ item: lunch, lane: 0, span: 2, start: h(12), end: h(13), color: 'purple', linked: true }]);
  });
  it('a sole-owner event is one cell in its lane', () => {
    const mine = event(['alex'], h(9), 45), hers = event(['sam'], h(9, 15), 30);
    expect(run([mine, hers], sel('both'))).toMatchObject([
      { item: mine, lane: 0, span: 1, start: h(9), end: h(9, 45), color: 'green', linked: false },
      { item: hers, lane: 1, span: 1, start: h(9, 15), end: h(9, 45), color: 'yellow', linked: false },
    ]);
    expect(run([mine, hers], sel('both'), 'sam').map(c => c.lane)).toEqual([1, 0]);
  });
  it('a linked event in a single-list view is one Both-colored cell in that lane', () => {
    const lunch = event(['sam', 'alex'], h(12), 60);
    expect(run([lunch], sel('alex'))).toEqual([{ item: lunch, lane: 0, span: 1, start: h(12), end: h(13), color: 'purple', linked: true }]);
    expect(run([lunch], sel(CAMP))).toEqual([]);
  });
  it('an overlay list is the next lane', () => {
    const camp = event([CAMP], h(8));
    expect(run([camp], sel('alex', CAMP))).toMatchObject([{ lane: 1, span: 1, color: 'blue' }]);
    expect(run([camp], sel('both', CAMP))).toMatchObject([{ lane: 2 }]);
    expect(run([camp], sel('both'))).toEqual([]);
  });
  it('does not span lanes that are not side by side', () => {
    const lunch = event(['sam', 'alex'], h(12), 60);
    const lanes = [lanesFor(sel('alex'))[0], lanesFor(sel(CAMP))[0], lanesFor(sel('sam'))[0]];
    expect(eventCells([lunch], DAY, lanes, lists, settings).map(c => [c.lane, c.span])).toEqual([[0, 1], [2, 1]]);
  });
  it('keeps one day and sorts by start, then lane', () => {
    const late = event(['alex'], h(15)), early = event(['sam'], h(8)), same = event(['alex'], h(8)), other = event(['alex'], h(8), 30, { date: '2026-10-31' });
    expect(run([late, early, same, other], sel('both')).map(c => c.item.id)).toEqual([same.id, early.id, late.id]);
  });
});

describe('noteLanes', () => {
  const lanes = lanesFor(sel('both', CAMP));
  it('has one entry per lane with the server key', () => {
    const rows = noteLanes([], 'week', '2026-10-26', 'priorities', lanes);
    expect(rows.map(r => r.key)).toEqual([
      'week:2026-10-26:alex:priorities', 'week:2026-10-26:sam:priorities', `week:2026-10-26:${CAMP}:priorities`,
    ]);
    expect(rows.map(r => r.lane.listId)).toEqual(['alex', 'sam', CAMP]);
    expect(rows.every(r => r.note === null && r.revision === 0)).toBe(true);
  });
  it('finds each lane\'s own saved text and revision', () => {
    const mine = note('week:2026-10-26:alex:priorities', 'plan', 4);
    const hers = note('week:2026-10-26:sam:priorities', 'dinner', 1);
    const rows = noteLanes([hers, mine], 'week', '2026-10-26', 'priorities', lanes);
    expect(rows[0]).toMatchObject({ note: mine, revision: 4 });
    expect(rows[1]).toMatchObject({ note: hers, revision: 1 });
    expect(rows[2]).toMatchObject({ note: null, revision: 0 });
  });
  it('does not mix scope, period or field', () => {
    const others = [
      note('week:2026-10-19:alex:priorities'), note('month:2026-10-01:alex:priorities'), note('month:2026-10-01:alex:notes'),
      note('day:2026-10-26:alex:notes'),
    ];
    expect(noteLanes(others, 'week', '2026-10-26', 'priorities', lanes)[0].note).toBeNull();
    expect(noteLanes(others, 'month', '2026-10-01', 'notes', lanes)[0].note).toBe(others[2]);
    expect(noteLanes(others, 'month', '2026-10-01', 'priorities', lanes)[0].note).toBe(others[1]);
  });
});

describe('dayView', () => {
  it('has exactly five priority rows, with or without data', () => {
    for (const data of [{}, { priorities: [prio({ alex: 1 }), prio({ alex: 5 })] }]) {
      const rows = dayView(input(data), DAY).priorities;
      expect(rows).toHaveLength(5);
      expect(rows.map(r => r.line)).toEqual([1, 2, 3, 4, 5]);
    }
    expect(dayView(input({}, sel(CAMP)), DAY).priorities).toHaveLength(CAPS.prioritySlots);
  });
  it('places each priority cell on its row', () => {
    const linked = prio({ sam: 3, alex: 3 }), split = prio({ sam: 1, alex: 5 }), mine = prio({ alex: 1 });
    const view = dayView(input({ priorities: [linked, split, mine] }), DAY);
    expect(view.priorities[0].cells.map(c => [c.item.id, c.lane, c.span])).toEqual([[mine.id, 0, 1], [split.id, 1, 1]]);
    expect(view.priorities[1].cells).toEqual([]);
    expect(view.priorities[2].cells.map(c => [c.item.id, c.lane, c.span])).toEqual([[linked.id, 0, 2]]);
    expect(view.priorities[4].cells.map(c => [c.item.id, c.lane, c.span])).toEqual([[split.id, 0, 1]]);
  });
  it('ignores a priority line outside 1 to 5 instead of throwing', () => {
    const view = dayView(input({ priorities: [prio({ alex: 9 })] }), DAY);
    expect(view.priorities).toHaveLength(5);
    expect(view.priorities.every(r => r.cells.length === 0)).toBe(true);
  });
  it('takes lanes from the selection and the signed-in person', () => {
    expect(dayView(input({}, sel('both'), 'alex'), DAY).lanes.map(l => [l.listId, l.you])).toEqual([['alex', true], ['sam', false]]);
    expect(dayView(input({}, sel('both'), 'sam'), DAY).lanes.map(l => [l.listId, l.you])).toEqual([['sam', true], ['alex', false]]);
    expect(dayView(input({}, sel(CAMP, HOME)), DAY).lanes.map(l => l.listId)).toEqual([CAMP, HOME]);
  });
  it('splits to-dos into open and done, each in pos order', () => {
    const a = todo(['alex'], { pos: 2000 }), b = todo(['sam'], { pos: 1000 }), c = todo(['alex'], { done: true, pos: 100 }), d = todo(['alex'], { date: '2026-10-31' });
    const view = dayView(input({ tasks: [a, b, c, d] }), DAY);
    expect(view.todosOpen.map(r => r.item.id)).toEqual([b.id, a.id]);
    expect(view.todosDone.map(r => r.item.id)).toEqual([c.id]);
  });
  it('lists the schedule cells, one note lane per lane and a to-do counter per lane list', () => {
    const lunch = event(['sam', 'alex'], h(12), 60);
    const mine = note(`day:${DAY}:alex:notes`, 'remember', 2);
    const tasks = [todo(['alex']), todo(['alex']), todo(['sam', 'alex']), todo([CAMP]), todo(['alex'], { done: true })];
    const view = dayView(input({ events: [lunch], notes: [mine], tasks }, sel('both', CAMP)), DAY);
    expect(view.schedule).toHaveLength(1);
    expect(view.schedule[0].span).toBe(2);
    expect(view.notes.map(r => [r.lane.listId, r.revision])).toEqual([['alex', 2], ['sam', 0], [CAMP, 0]]);
    expect(Object.keys(view.caps).sort()).toEqual(['sam', 'alex', CAMP].sort());
    expect(view.caps.alex.todosOpen).toEqual({ used: 3, max: CAPS.dayTodosPerList, over: false });
    expect(view.caps.sam.todosOpen.used).toBe(1);
    expect(view.caps[CAMP].todosOpen.used).toBe(1);
  });
  it('limits what it shows to the selection', () => {
    const data = { tasks: [todo(['sam']), todo(['alex'])], events: [event(['sam'], h(9))], priorities: [prio({ sam: 1 })] };
    const view = dayView(input(data, sel('alex')), DAY);
    expect(view.todosOpen).toHaveLength(1);
    expect(view.schedule).toEqual([]);
    expect(view.priorities.every(r => r.cells.length === 0)).toBe(true);
    expect(Object.keys(view.caps)).toEqual(['alex']);
  });
  it('heals a selection that points at a deleted list', () => {
    const gone = '99999999-9999-4999-8999-999999999999';
    expect(dayView(input({}, sel(gone)), DAY).lanes.map(l => l.listId)).toEqual(['alex', 'sam']);
  });
});

describe('weekView', () => {
  const MONDAY = '2026-10-26';
  it('has a priorities text lane and the week\'s to-dos per selection', () => {
    const mine = note(`week:${MONDAY}:alex:priorities`, 'plan', 2);
    const a = todo(['alex'], { scope: 'week', date: MONDAY, pos: 2 }), b = todo(['sam', 'alex'], { scope: 'week', date: MONDAY, pos: 1 });
    const done = todo(['sam'], { scope: 'week', date: MONDAY, done: true });
    const dayTodo = todo(['alex']);
    const view = weekView(input({ notes: [mine], tasks: [a, b, done, dayTodo] }), MONDAY);
    expect(view.monday).toBe(MONDAY);
    expect(view.lanes.map(l => l.listId)).toEqual(['alex', 'sam']);
    expect(view.priorities.map(r => [r.key, r.revision])).toEqual([[`week:${MONDAY}:alex:priorities`, 2], [`week:${MONDAY}:sam:priorities`, 0]]);
    expect(view.todosOpen.map(r => r.item.id)).toEqual([b.id, a.id]);
    expect(view.todosDone.map(r => r.item.id)).toEqual([done.id]);
    const sam = weekView(input({ tasks: [a, b, done] }, sel('sam'), 'sam'), MONDAY);
    expect(sam.todosOpen.map(r => r.item.id)).toEqual([b.id]);
    expect(sam.priorities).toHaveLength(1);
  });
});

describe('monthView', () => {
  const FIRST = '2026-10-01';
  const grid = (first: string) => monthView(input({}), first).grid;

  it('is 42 cells, Monday first, from the Monday on or before the 1st', () => {
    const cells = grid(FIRST);
    expect(cells).toHaveLength(42);
    expect(cells[0].date).toBe('2026-09-28');
    expect(cells[41].date).toBe('2026-11-08');
    expect(cells.filter(c => c.inMonth)).toHaveLength(31);
    expect(cells.map(c => c.inMonth).join()).toBe([false, false, false, ...Array(31).fill(true), ...Array(8).fill(false)].join());
    expect(new Set(cells.map(c => c.date)).size).toBe(42);
    expect(cells.every(c => new Date(`${c.date}T12:00:00Z`).getUTCDay() === ((cells.indexOf(c) + 1) % 7))).toBe(true);
  });
  it('handles months that start on a Monday, a Sunday and a Saturday', () => {
    expect(grid('2027-02-01')[0]).toMatchObject({ date: '2027-02-01', inMonth: true });
    expect(grid('2027-02-01')[41].date).toBe('2027-03-14');
    expect(grid('2027-02-01').filter(c => c.inMonth)).toHaveLength(28);
    expect(grid('2026-11-01')[0]).toMatchObject({ date: '2026-10-26', inMonth: false });
    expect(grid('2026-11-01')[6]).toMatchObject({ date: '2026-11-01', inMonth: true });
    expect(grid('2026-11-01')[41].date).toBe('2026-12-06');
    expect(grid('2026-08-01')[0].date).toBe('2026-07-27');
    expect(grid('2026-08-01')[41].date).toBe('2026-09-06');
  });
  it('handles a leap February and a December that runs into the next year', () => {
    const leap = grid('2028-02-01');
    expect(leap[0].date).toBe('2028-01-31');
    expect(leap.filter(c => c.inMonth)).toHaveLength(29);
    expect(leap.some(c => c.date === '2028-02-29' && c.inMonth)).toBe(true);
    expect(leap[41].date).toBe('2028-03-12');
    const dec = grid('2026-12-01');
    expect(dec[0].date).toBe('2026-11-30');
    expect(dec[41].date).toBe('2027-01-10');
    expect(dec.filter(c => c.inMonth)).toHaveLength(31);
    expect(grid('2027-02-01').filter(c => c.inMonth)).toHaveLength(28);
  });
  it('draws no marks on its days (the chores are what the calendar shows): a cell is its date and whether it is in the month, however much is planned', () => {
    const data = {
      events: [event(['alex'], h(9), 30, { date: '2026-10-05' })],
      priorities: [prio({ alex: 1 }, { date: '2026-10-05' })],
      tasks: [todo(['alex'], { date: '2026-10-05' }), todo(['sam', 'alex'], { date: '2026-10-06' }), todo(['alex'], { scope: 'month', date: FIRST })],
    };
    const cells = monthView(input(data, sel('both', CAMP)), FIRST).grid;
    expect(cells).toEqual(grid(FIRST));
    expect(cells.every(c => Object.keys(c).sort().join() === 'date,inMonth')).toBe(true);
  });
  it('has priorities and notes lanes keyed by the first, and the month to-dos', () => {
    const text = note(`month:${FIRST}:alex:notes`, 'memo', 5);
    const a = todo(['alex'], { scope: 'month', date: FIRST }), done = todo(['sam'], { scope: 'month', date: FIRST, done: true });
    const view = monthView(input({ notes: [text], tasks: [a, done, todo(['alex'], { scope: 'week', date: '2026-10-26' })] }), FIRST);
    expect(view.first).toBe(FIRST);
    expect(view.lanes.map(l => l.listId)).toEqual(['alex', 'sam']);
    expect(view.priorities.map(r => r.key)).toEqual([`month:${FIRST}:alex:priorities`, `month:${FIRST}:sam:priorities`]);
    expect(view.notes.map(r => [r.key, r.revision])).toEqual([[`month:${FIRST}:alex:notes`, 5], [`month:${FIRST}:sam:notes`, 0]]);
    expect(view.todosOpen.map(r => r.item.id)).toEqual([a.id]);
    expect(view.todosDone.map(r => r.item.id)).toEqual([done.id]);
  });
});

describe('open to-do rows of a period', () => {
  const MONDAY = '2026-10-26', FIRST = '2026-10-01';
  const data = {
    tasks: [
      todo(['alex']), todo(['sam']), todo(['sam', 'alex']), todo(['alex'], { done: true }), todo([CAMP]), todo(['alex'], { date: '2026-10-31' }),
      todo(['alex'], { scope: 'week', date: MONDAY }), todo(['sam', 'alex'], { scope: 'week', date: MONDAY }), todo(['sam'], { scope: 'month', date: FIRST }),
    ],
  };
  // The views' own rule: open to-dos in the visible lanes, a linked one once.
  const open = (view: { todosOpen: unknown[] }) => view.todosOpen.length;
  it('counts open to-dos in the visible lanes, a linked one once', () => {
    expect(open(dayView(input(data, sel('both')), DAY))).toBe(3);
    expect(open(dayView(input(data, sel('alex')), DAY))).toBe(2);
    expect(open(dayView(input(data, sel('sam'), 'sam'), DAY))).toBe(2);
    expect(open(dayView(input(data, sel('both', CAMP)), DAY))).toBe(4);
    expect(open(dayView(input(data, sel(CAMP)), DAY))).toBe(1);
  });
  it('ignores done to-dos and other days', () => {
    expect(open(dayView(input(data, sel('both')), '2026-10-31'))).toBe(1);
    expect(open(dayView(input(data, sel('both')), '2026-11-30'))).toBe(0);
  });
  it('counts week and month to-dos under their own period key', () => {
    expect(open(weekView(input(data, sel('both')), MONDAY))).toBe(2);
    expect(open(weekView(input(data, sel('alex')), MONDAY))).toBe(2);
    expect(open(monthView(input(data, sel('alex')), FIRST))).toBe(0);
    expect(open(monthView(input(data, sel('both')), FIRST))).toBe(1);
    expect(open(weekView(input(data, sel('both')), DAY))).toBe(0);
  });
});

describe('monthGrid', () => {
  it('shows as many Monday-first weeks as the month needs: 5, or 6 when the 1st falls late in the week', () => {
    expect(monthGrid('2026-10-01')).toHaveLength(35);
    expect(monthGrid('2026-11-01')).toHaveLength(42);
    expect(monthGrid('2027-02-01')).toHaveLength(35);
    expect(monthGrid('2026-08-01')).toHaveLength(42);
    expect(monthGrid('2027-05-01')).toHaveLength(42);
  });
  it('begins on the Monday on or before the 1st and marks the days of the month', () => {
    const cells = monthGrid('2026-10-01');
    expect(cells[0]).toEqual({ date: '2026-09-28', inMonth: false });
    expect(cells[3]).toEqual({ date: '2026-10-01', inMonth: true });
    expect(cells.at(-1)).toEqual({ date: '2026-11-01', inMonth: false });
    expect(cells.filter(c => c.inMonth)).toHaveLength(31);
    expect(monthGrid('2027-02-01')[0]).toEqual({ date: '2027-02-01', inMonth: true });
  });
  it('takes the number of rows when it is told, and is what monthView draws with six', () => {
    expect(monthGrid('2026-10-01', 5)).toHaveLength(35);
    expect(monthGrid('2026-10-01', 6)).toHaveLength(42);
    expect(monthGrid('2027-02-01', 6).at(-1)!.date).toBe('2027-03-14');
    for (const first of ['2026-10-01', '2026-11-01', '2027-02-01', '2028-02-01']) {
      expect(monthView(input({}), first).grid.map(({ date, inMonth }) => ({ date, inMonth }))).toEqual(monthGrid(first, 6));
    }
  });
  it('shows at least five weeks, so a February that starts on a Monday ends on a week of March, and never a sixth without a day of the month', () => {
    expect(monthGrid('2027-02-01').slice(28).every(c => !c.inMonth)).toBe(true);
    for (const month of ['2026-01', '2026-03', '2026-05', '2026-08', '2026-10', '2026-11', '2026-12']) {
      const cells = monthGrid(`${month}-01`);
      if (cells.length === 42) expect(cells.slice(35).some(c => c.inMonth)).toBe(true);
    }
  });
});
