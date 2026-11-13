import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { ChoreMark, ChoreRule, ListRecord, Session } from '../../../packages/core/src/planner';
import { makeContext } from '../../panelContext';
import { createState } from '../../state';
import * as day from '../DayPanel';

// The desktop Day with the picker's Chores switch on, drawn from a real state in Node (no DOM): the To-do section becomes the day's chores, and nothing else of the page moves.
const stamp = { revision: 1, updatedAt: '2026-11-01T00:00:00Z' };
const base = { createdBy: 'alex', updatedBy: 'alex', createdAt: stamp.updatedAt, updatedAt: stamp.updatedAt, ak: 'a', revision: 1 } as const;
const lists: ListRecord[] = [{ id: 'sam', kind: 'person', name: 'Sam', color: 'yellow', order: 0, ...stamp }, { id: 'alex', kind: 'person', name: 'Alex', color: 'green', order: 1, ...stamp }];
const rule = (title: string, owners: ChoreRule['owners'], cadence: ChoreRule['cadence'], order: number): ChoreRule => ({ id: `c0de0000-0000-4000-8000-00000000000${order}`, title, owners, cadence, order, ...base });
const chores = [rule('Dishes', ['alex'], { kind: 'daily' }, 1), rule('Cat bowls', ['sam'], { kind: 'weekly', day: 3, weeks: 'every' }, 2), rule('Kitchen wipe-down', ['alex'], { kind: 'weekly', day: 3, weeks: 'A' }, 3)];
const session = (over: Partial<Session> = {}): Session => ({
  v: 5, revision: 5, lists, settings: { bothColor: 'purple', revision: 1, updatedAt: stamp.updatedAt },
  tasks: [{ id: 't1', scope: 'day', date: '2026-11-04', owners: ['alex'], title: 'Buy stamps', done: false, pos: 1000, ...base } as Session['tasks'][number]], priorities: [], events: [], notes: [],
  chores, choreMarks: [] as ChoreMark[], rhythm: { anchor: '2026-11-02', start: '2026-11-02', revision: 1, updatedBy: 'alex', updatedAt: stamp.updatedAt },
  prefs: { selection: { base: 'both', overlays: [] }, sidebar: 'shown' }, user: 'alex', csrf: 't', timezone: 'America/Chicago', theme: 'midnight', ...over,
});
const io = { load: async () => ({ unchanged: true as const, revision: 5 }), send: async () => session(), setTheme: async (theme: string) => ({ theme }), hidden: () => false };
const width = (phone: boolean) => vi.stubGlobal('window', { matchMedia: () => ({ matches: phone, addEventListener: () => {} }) });
// The Day lists chores from today on: the clock is on the day drawn (2026-11-04), not the real date.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-04T18:00:00Z')); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function draw(on: boolean, phone = false) {
  width(phone);
  const state = createState(session(), io);
  state.go('2026-11-04', true);
  state.setChores(on);
  return day.html(makeContext(state, () => {}));
}

describe('the desktop Day with Chores on', () => {
  it('swaps the To-do section for a Chores section in the same place (the right column, under Priorities), titled Chores', () => {
    const off = draw(false), on = draw(true);
    expect(off).toContain('class="day-sec day-todo"');
    expect(off).toContain('Buy stamps');
    expect(on).not.toContain('day-sec day-todo');
    expect(on).not.toContain('Buy stamps');
    expect(on).toMatch(/<h2 class="day-label">Chores<\/h2>/);
    expect(on.indexOf('day-prio')).toBeLessThan(on.indexOf('day-chores'));
    // Both sections close the right column, after the Priorities.
    expect(on.slice(on.indexOf('day-chores'))).not.toContain('day-prio');
  });

  it('lists the day\'s chores as the Chores page does: rows with a circle, an owner title and a cadence badge, whoever the picker shows', () => {
    const on = draw(true);
    expect([...on.matchAll(/class="ch-title"[^>]*>([^<]+)</g)].map(m => m[1])).toEqual(['Dishes', 'Cat bowls', 'Kitchen wipe-down']);
    expect(on).toContain('class="ch-chip ch-badge" data-cadence="weekly">Weekly');
    expect(on).toContain('Week A');
    expect(on.match(/class="ch-circle"/g)).toHaveLength(3);
  });

  it('leaves the Schedule, Priorities and Notes as they are', () => {
    const [off, on] = [draw(false), draw(true)];
    const without = (markup: string, from: string) => markup.slice(0, markup.indexOf(from));
    expect(without(on, '<section class="day-sec day-chores"')).toBe(without(off, '<section class="day-sec day-todo"'));
  });

  it('is not drawn on a phone: its Chores is the Chores view the shell draws, and the Day keeps its To-do tab', () => {
    const phone = draw(true, true);
    expect(phone).not.toContain('day-chores');
    expect(phone).toContain('data-layout="phone"');
  });
});
