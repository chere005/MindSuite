import { afterEach, describe, it, expect, vi } from 'vitest';
import type { ChoreMark, ChoreRule, ListRecord, Note, ScheduleEvent, Session, Task } from '../../../packages/core/src/planner';
import { makeContext } from '../../panelContext';
import { createState, type AppState } from '../../state';
import * as week from '../WeekPanel';
import * as month from '../MonthPanel';

// Draws the real panels from a real state in Node (no DOM): what the markup says about lanes, drafts and the grid.
const stamp = { revision: 1, updatedAt: '2026-10-30T00:00:00Z' };
const CAMP = 'cccccccc-0000-4000-8000-000000000000';
const MONDAY = '2026-10-26', FIRST = '2026-10-01';
const lists: ListRecord[] = [
  { id: 'sam', kind: 'person', name: 'Sam', color: 'yellow', order: 0, ...stamp }, { id: 'alex', kind: 'person', name: 'Alex', color: 'green', order: 1, ...stamp },
  { id: CAMP, kind: 'custom', name: 'Camp <b>', color: 'blue', order: 2, ...stamp },
];
const base = { createdBy: 'alex', updatedBy: 'alex', createdAt: stamp.updatedAt, updatedAt: stamp.updatedAt, ak: 'a', revision: 1 } as const;
const note = (key: string, text: string, revision = 2): Note => {
  const [scope, period, listId, field] = key.split(':');
  return { key, scope, period, listId, field, text, revision, updatedBy: 'sam', updatedAt: stamp.updatedAt } as Note;
};
const session = (over: Partial<Session> = {}): Session => ({
  v: 5, revision: 5, lists, settings: { bothColor: 'purple', revision: 1, updatedAt: stamp.updatedAt }, tasks: [], priorities: [], events: [], notes: [],
  chores: [], choreMarks: [], rhythm: { anchor: '2026-11-02', start: '2026-11-02', revision: 1, updatedBy: 'alex', updatedAt: stamp.updatedAt },
  prefs: { selection: { base: 'both', overlays: [] }, sidebar: 'shown' }, user: 'alex', csrf: 't', timezone: 'America/Chicago', theme: 'midnight', ...over,
});
const io = { load: async () => ({ unchanged: true as const, revision: 5 }), send: async () => session(), setTheme: async (theme: string) => ({ theme }), hidden: () => false };
function open(view: 'week' | 'month', over: Partial<Session> = {}, at?: string): { state: AppState; ctx: ReturnType<typeof makeContext> } {
  const state = createState(session(over), io);
  state.setView(view);
  state.go(at ?? (view === 'week' ? MONDAY : FIRST), true);
  return { state, ctx: makeContext(state, () => {}) };
}
/** The panels choose their markup by the window's width (isPhone), and there is no window here: a stub that says which. */
const width = (phone: boolean) => vi.stubGlobal('window', { matchMedia: () => ({ matches: phone, addEventListener: () => {} }) });
width(false);
afterEach(() => width(false));
const lanesOf = (markup: string) => [...markup.matchAll(/<section class="wm-lane" data-c="(\w+)" data-key="([^"]+)"/g)].map(m => ({ color: m[1], key: m[2] }));
const textareas = (markup: string) => [...markup.matchAll(/<textarea[^>]*aria-label="([^"]+)"[^>]*>\n([^<]*)<\/textarea>/g)].map(m => ({ label: m[1], text: m[2] }));

describe('Week', () => {
  it('draws one text block for each lane, the signed-in person first, and keeps to-dos out of the blocks', () => {
    const { ctx } = open('week');
    const markup = week.html(ctx);
    expect(lanesOf(markup)).toEqual([
      { color: 'green', key: `week:${MONDAY}:alex:priorities` }, { color: 'yellow', key: `week:${MONDAY}:sam:priorities` },
    ]);
    expect(textareas(markup).map(t => t.label)).toEqual(['Alex priorities', 'Sam priorities']);
    expect(markup).toContain('data-tab="priorities"');
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('data-n="3"');
  });

  it('follows the selection: a single list is one block, an overlay adds one, the other person signed in swaps the order', () => {
    const only = open('week').ctx;
    only.setSelection({ base: CAMP, overlays: [] });
    expect(lanesOf(week.html(only)).map(l => l.key)).toEqual([`week:${MONDAY}:${CAMP}:priorities`]);
    only.setSelection({ base: 'both', overlays: [CAMP] });
    expect(lanesOf(week.html(only)).map(l => l.key)).toEqual([`week:${MONDAY}:alex:priorities`, `week:${MONDAY}:sam:priorities`, `week:${MONDAY}:${CAMP}:priorities`]);
    expect(lanesOf(week.html(open('week', { user: 'sam' }).ctx)).map(l => l.key)).toEqual([`week:${MONDAY}:sam:priorities`, `week:${MONDAY}:alex:priorities`]);
  });

  it('shows saved text, escaped, and a list name is text, not markup', () => {
    const { ctx } = open('week', { notes: [note(`week:${MONDAY}:alex:priorities`, '<img src=x onerror=1> & more')], prefs: { selection: { base: 'both', overlays: [CAMP] }, sidebar: 'shown' } });
    const markup = week.html(ctx);
    expect(textareas(markup)[0]).toEqual({ label: 'Alex priorities', text: '&lt;img src=x onerror=1&gt; &amp; more' });
    expect(markup).toContain('Camp &lt;b&gt;');
    expect(markup).not.toContain('Camp <b>');
  });

  it('keeps a draft across a selection change: hidden while its list is not a lane, back with its text when it is', () => {
    const { ctx, state } = open('week', { notes: [note(`week:${MONDAY}:sam:priorities`, 'saved by sam', 3)] });
    state.drafts.set(`week:${MONDAY}:sam:priorities`, { text: 'my edit of sam', revision: 3 });
    state.drafts.set(`week:${MONDAY}:alex:priorities`, { text: 'my own text', revision: 0 });
    expect(textareas(week.html(ctx)).map(t => t.text)).toEqual(['my own text', 'my edit of sam']);
    ctx.setSelection({ base: 'alex', overlays: [] });
    expect(textareas(week.html(ctx))).toEqual([{ label: 'Alex priorities', text: 'my own text' }]);
    ctx.setSelection({ base: CAMP, overlays: [] });
    expect(textareas(week.html(ctx)).map(t => t.text)).toEqual(['']);
    expect(state.drafts.size).toBe(2);
    ctx.setSelection({ base: 'both', overlays: [] });
    expect(textareas(week.html(ctx)).map(t => t.text)).toEqual(['my own text', 'my edit of sam']);
  });

  it('drops the drafts of a list that was deleted, whichever scope they belong to', () => {
    const { ctx, state } = open('week');
    const gone = 'dddddddd-0000-4000-8000-000000000000';
    state.drafts.set(`week:${MONDAY}:${gone}:priorities`, { text: 'x', revision: 0 });
    state.drafts.set(`day:2026-10-30:${gone}:notes`, { text: 'y', revision: 0 });
    state.drafts.set(`week:${MONDAY}:alex:priorities`, { text: 'z', revision: 0 });
    week.html(ctx);
    expect([...state.drafts.keys()]).toEqual([`week:${MONDAY}:alex:priorities`]);
  });

  it('lists the open to-dos, then the blank lines, then the done ones crossed out at the bottom of the same list; no Done heading or block; each row has its owner name and the add form has no For control', () => {
    const task = (id: string, title: string, owners: string[], done = false, pos = 1024): Task => ({ id, scope: 'week', date: MONDAY, owners, title, done, pos, ...base });
    const { ctx } = open('week', { tasks: [task('a', 'Plan trip', ['sam', 'alex'], false, 2048), task('b', 'Pay rent', ['alex'], false, 1024), task('c', 'Old one', ['sam'], true)] });
    const markup = week.html(ctx);
    expect([...markup.matchAll(/aria-label="Edit ([^"]+)"/g)].map(m => m[1])).toEqual(['Pay rent', 'Plan trip', 'Old one']);
    // One list: the done row is in it (crossed out by its class), after the blank lines (the very last line), and nothing says Done.
    expect(markup.match(/<ul class="wm-todos"/g)).toHaveLength(1);
    expect(markup).not.toMatch(/wm-done|Done \(|aria-label="Done"/);
    expect(markup).toMatch(/<li class="wm-todo done" data-id="c"/);
    expect(markup.indexOf('data-id="c"')).toBeGreaterThan(markup.lastIndexOf('wm-free'));
    expect(markup.indexOf('data-id="a"')).toBeLessThan(markup.indexOf('wm-free'));
    // The lines top to bottom: the two open rows, the add line and nine blank ones, then the done row, which is the last of the 13.
    const lines = [...markup.matchAll(/<li class="(wm-todo done|wm-todo|wm-free wm-free-add|wm-free)[ "]/g)].map(m => m[1]);
    expect(lines).toEqual(['wm-todo', 'wm-todo', 'wm-free wm-free-add', ...Array(9).fill('wm-free'), 'wm-todo done']);
    // 3 rows on a Week's 13 lines leave 10 blank ones, the first of them the add line.
    expect(markup.match(/class="wm-free/g)).toHaveLength(10);
    expect(markup).not.toMatch(/wm-for|wm-pill|radiogroup|>For</);
    expect(markup).toMatch(/data-id="a" data-c="purple"/);
  });

  it('keeps the done rows the last lines as rows are added: the blank lines shrink, down to the one add line, and then the list grows', () => {
    const task = (id: string, owners: string[], done: boolean, pos: number): Task => ({ id, scope: 'week', date: MONDAY, owners, title: id, done, pos, ...base });
    const kinds = (tasks: Task[]) => [...week.html(open('week', { tasks }).ctx).matchAll(/<li class="(wm-todo done|wm-todo|wm-free wm-free-add|wm-free)[ "]/g)].map(m => m[1]);
    const rows = (openCount: number, doneCount: number) => [
      ...Array.from({ length: openCount }, (_, i) => task(`o${i}`, ['alex'], false, 1024 * (i + 1))),
      ...Array.from({ length: doneCount }, (_, i) => task(`d${i}`, ['alex'], true, 1024 * (i + 100))),
    ];
    const expected = (openCount: number, blank: number, doneCount: number) => [...Array(openCount).fill('wm-todo'), 'wm-free wm-free-add', ...Array(blank - 1).fill('wm-free'), ...Array(doneCount).fill('wm-todo done')];
    expect(kinds(rows(0, 3))).toEqual(expected(0, 10, 3));
    expect(kinds(rows(4, 3))).toEqual(expected(4, 6, 3));
    expect(kinds(rows(10, 3))).toEqual(expected(10, 1, 3));
    // Beyond the 13 lines nothing is hidden: the one add line stays between the open rows and the done ones.
    expect(kinds(rows(12, 5))).toEqual(expected(12, 1, 5));
    expect(kinds(rows(2, 30))).toEqual(expected(2, 1, 30));
  });
});

describe('Month', () => {
  it('draws 42 day boxes with a date button each, one wm-days section, and a Notes block in the last four cells of the sixth row (Thursday on)', () => {
    const { ctx } = open('month');
    const markup = month.html(ctx);
    expect(markup.match(/class="wm-day[ "]/g)).toHaveLength(42);
    expect(markup).toContain('data-from="4"');
    expect(markup.match(/data-covered/g)).toHaveLength(4);
    // The cells it covers are the 5th to 8th of November; the 2nd to 4th stay, muted, in front of it.
    for (const date of ['2026-11-05', '2026-11-08']) { expect(markup).toMatch(new RegExp(`class="wm-day out"[^>]*data-date="${date}"[^>]*data-covered`)); }
    expect(markup).toMatch(/class="wm-day out" data-date="2026-11-04"(?![^>]*data-covered)/);
    expect(markup.match(/<button type="button" class="wm-day-num"/g)).toHaveLength(42);
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('data-n="5"');
  });

  it('heads the calendar Monday to Sunday, with a full name for a screen reader behind each one-letter head', () => {
    const markup = month.html(open('month').ctx);
    const heads = [...markup.matchAll(/<span class="wm-dow"><span class="wm-dow-full">(\w+)<\/span><span class="wm-dow-letter" aria-hidden="true">(\w)<\/span><\/span>/g)];
    expect(heads.map(m => m[1])).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(heads.map(m => m[2]).join('')).toBe('MTWTFSS');
  });

  it('marks today, and only today, as the current date', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-30T18:00:00Z'));
      const markup = month.html(open('month').ctx);
      expect(markup.match(/aria-current="date"/g)).toHaveLength(1);
      expect(markup).toMatch(/class="wm-day today" data-date="2026-10-30"[^>]*>\s*<button type="button" class="wm-day-num" data-date="2026-10-30" aria-current="date"/);
    } finally { vi.useRealTimers(); }
  });

  it('has Priorities and Notes blocks for each lane, in separate note keys', () => {
    const { ctx } = open('month', { prefs: { selection: { base: 'both', overlays: [CAMP] }, sidebar: 'shown' } });
    expect(lanesOf(month.html(ctx)).map(l => l.key)).toEqual([
      ...['alex', 'sam', CAMP].map(id => `month:${FIRST}:${id}:priorities`), ...['alex', 'sam', CAMP].map(id => `month:${FIRST}:${id}:notes`),
    ]);
  });

  const rule = (title: string, owners: ChoreRule['owners'], cadence: ChoreRule['cadence'], order: number): ChoreRule => ({ id: `c0de0000-0000-4000-8000-00000000000${order}`, title, owners, cadence, order, ...base });
  const furnace = rule('Furnace filter', ['alex'], { kind: 'monthly', nth: 1, day: 1, months: 'every' }, 1);
  const towels = rule('Kitchen towels', ['sam'], { kind: 'weekly', day: 0, weeks: 'A' }, 2), bedding = rule('Bedding', ['sam'], { kind: 'weekly', day: 0, weeks: 'A' }, 3);
  const couch = rule('Couch blankets', ['sam'], { kind: 'weekly', day: 0, weeks: 'A' }, 4), extra = rule('Bins', ['sam', 'alex'], { kind: 'weekly', day: 0, weeks: 'A' }, 5);
  const NOV = '2026-11-01';
  const cell = (markup: string, date: string) => markup.match(new RegExp(`<div class="wm-day[^"]*" data-date="${date}"[\\s\\S]*?(?=<div class="wm-day|<section class="wm-sec wm-notes)`))![0];

  it('draws no dots and no counts, whatever is planned: what is on the calendar is the chores', () => {
    const event = (id: string, owners: string[]): ScheduleEvent => ({ id, date: '2026-10-14', owners, text: 'x', start: 540, length: 30, ...base });
    const { ctx } = open('month', { events: [event('1', ['alex']), event('2', ['sam']), event('3', ['sam', 'alex'])], tasks: [{ id: 't', scope: 'day', date: '2026-10-14', owners: ['alex'], title: 'x', done: false, pos: 1000, ...base } as Task] });
    const markup = month.html(ctx);
    expect(markup).not.toMatch(/wm-dot|wm-dots|wm-day-count|planned/);
    expect(cell(markup, '2026-10-14')).not.toContain('<ul');
  });

  it('draws the month\'s chores in the cells of a desktop as the Chores page\'s chips: the circle, the owner title, tinted by the owner, and no button inside another', () => {
    const marks: ChoreMark[] = [{ id: `${furnace.id}:2026-11-02`, ruleId: furnace.id, date: '2026-11-02', state: 'done', moved: false, ...base }];
    const { ctx } = open('month', { chores: [furnace, towels, bedding], choreMarks: marks }, NOV);
    const markup = month.html(ctx);
    const mon = cell(markup, '2026-11-02');
    expect(mon).toMatch(/<li class="ch-row ch-done"[^>]*data-state="done" data-c="green"/);
    expect(mon).toContain('class="ch-circle" data-writes checked');
    expect(mon).toContain('aria-label="Furnace filter, for Alex. Tap to make it for Both"');
    expect(cell(markup, '2026-11-08').match(/<li class="ch-row/g)).toHaveLength(2);
    expect(cell(markup, '2026-11-08')).toMatch(/data-c="yellow"/);
    // The Month has no A / B column and no letter chips: the rows are not told apart in words.
    expect(markup).not.toMatch(/class="ch-chip"[^>]*aria-label="Week/);
    expect(markup).not.toContain('wm-bars');
    expect(markup).not.toContain('wm-chorelist');
    // A calendar cell is never one big button: the date number is the only button of an empty one, and nothing is nested.
    expect(cell(markup, '2026-11-03').match(/<button/g)).toHaveLength(1);
    let depth = 0;
    for (const tag of markup.match(/<button\b|<\/button>/g) ?? []) { depth += tag === '</button>' ? -1 : 1; expect(depth).toBeLessThanOrEqual(1); }
  });

  it('says which days are in an A week (the tinted rows) and which are Saturdays (the hatch), in the month or not, and writes no letters', () => {
    const markup = month.html(open('month', { chores: [furnace] }, NOV).ctx);
    expect(cell(markup, '2026-11-02')).toContain('data-letter="A"');
    expect(cell(markup, '2026-11-09')).toContain('data-letter="B"');
    expect(cell(markup, '2026-10-30')).not.toContain('data-letter');
    expect(cell(markup, '2026-11-07')).toContain('data-sat');
    expect(cell(markup, '2026-10-31')).toContain('data-sat');
    expect(cell(markup, '2026-11-06')).not.toContain('data-sat');
    expect(markup).not.toContain('Day off');
    expect(markup).not.toContain('ch-cal-pill');
  });

  it('shows the chores whoever the picker shows: a single list and an overlay change nothing in the cells', () => {
    const over = { chores: [furnace, towels] };
    const all = month.html(open('month', over, NOV).ctx);
    const sam = open('month', { ...over, prefs: { selection: { base: 'sam', overlays: [] }, sidebar: 'shown' } }, NOV).ctx;
    const camp = open('month', { ...over, prefs: { selection: { base: 'both', overlays: [CAMP] }, sidebar: 'shown' } }, NOV).ctx;
    for (const ctx of [sam, camp]) { expect(cell(month.html(ctx), '2026-11-02')).toBe(cell(all, '2026-11-02')); expect(cell(month.html(ctx), '2026-11-08')).toBe(cell(all, '2026-11-08')); }
  });

  it('on a phone each chore is a thin bar in its owner\'s color, three at most and "+n" for the rest, with the month\'s list under the grid and the day\'s chore count in its name', () => {
    width(true);
    const markup = month.html(open('month', { chores: [furnace, towels, bedding, couch, extra], choreMarks: [{ id: `${furnace.id}:2026-11-02`, ruleId: furnace.id, date: '2026-11-02', state: 'done', moved: false, ...base }] }, NOV).ctx);
    const sunday = cell(markup, '2026-11-08');
    expect([...sunday.matchAll(/<i class="wm-bar" data-c="(\w+)"/g)].map(m => m[1])).toEqual(['yellow', 'yellow', 'yellow']);
    expect(sunday).toContain('<span class="wm-more">+1</span>');
    expect(sunday).toContain('aria-label="Sunday, November 8, 2026, 4 chores"');
    expect(sunday).not.toContain('ch-row');
    expect(cell(markup, '2026-11-02')).toMatch(/<i class="wm-bar" data-c="green" data-state="done">/);
    expect(cell(markup, '2026-11-02')).toContain('aria-label="Monday, November 2, 2026, 1 chore"');
    expect(cell(markup, '2026-11-03')).not.toContain('wm-bars');
    // The list under the grid: Monthly, then each week, as the Chores page draws it, with a date button on every chip.
    expect(markup).toMatch(/<div class="wm-chorelist"[^>]*><div class="ch-month"><h3 class="ch-label">Monthly<\/h3>/);
    expect(markup).toContain('Nov 2–8 · Week A');
    expect(markup.match(/class="ch-chip ch-date"/g)).toHaveLength(9);
    expect(markup.indexOf('wm-chorelist')).toBeGreaterThan(markup.indexOf('id="wm-sec-calendar"'));
    expect(markup.indexOf('wm-chorelist')).toBeLessThan(markup.indexOf('wm-sec wm-notes'));
  });

  it('gives every cell a date a screen reader can read', () => {
    expect(month.html(open('month').ctx)).toMatch(/aria-label="Thursday, October 1, 2026"/);
  });
});
