import { describe, it, expect } from 'vitest';
import {
  CHORE_BARS, cadenceGroup, cadenceText, cadenceWith, catchUpFriday, choreAdd, choreBars, choreDayLabel, choreEdit, choreMark, choreStart, choreTurns, choreWeekStart, dayChores, mondayOf, monthChoreCells, monthChoreGrid, monthChores, monthGrid, newChoreDay,
  newChoreOwners, nextOwners, rhythmAnchor, rhythmGroups, ruleTurnsOn, turnsOn, weekChores, weekLetter,
  type ChoreCadence, type ChoreInput, type ChoreMark, type ChoreOwners, type ChoreRule, type ChoreSection, type ListRecord, type Rhythm,
} from '../src/planner';

// The 21 rules of the chart as the store seeds them (Alex's Gentle Chore Chart), with Week A starting Monday 2 November 2026.
const A: ChoreOwners = ['sam'], S: ChoreOwners = ['alex'], AS: ChoreOwners = ['sam', 'alex'];
const SUN = 0, MON = 1, TUE = 2, WED = 3, THU = 4, FRI = 5;
const daily: ChoreCadence = { kind: 'daily' };
const weekly = (day: 0 | 1 | 2 | 3 | 4 | 5, weeks: 'every' | 'A' | 'B' = 'every'): ChoreCadence => ({ kind: 'weekly', day, weeks });
const monthly = (nth: 1 | 2 | 3 | 4 | -1, day: 0 | 1 | 2 | 3 | 4 | 5, months: 'every' | 'odd' | 'even' = 'every'): ChoreCadence => ({ kind: 'monthly', nth, day, months });
const stamp = { revision: 1, updatedBy: 'alex', updatedAt: '2026-11-01T00:00:00Z' } as const;
const id = (n: number) => `c0de0000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SEED: [ChoreOwners, string, ChoreCadence][] = [
  [S, 'Dishes', daily], [A, 'Trash & recycling', daily], [S, 'Wipe the table', daily],
  [A, 'Cat bowls', weekly(MON)], [A, 'Clutter reset', weekly(MON)], [AS, 'Mail & papers', weekly(TUE)], [A, 'Fridge clean-out', weekly(WED)], [A, 'Bins to the curb', weekly(WED)],
  [A, 'Cat bowls', weekly(THU)], [A, 'Fresh litter + liner', weekly(THU)], [A, 'Laundry', weekly(SUN)], [S, 'Vacuum', weekly(SUN)],
  [S, 'Kitchen wipe-down', weekly(WED, 'A')], [A, 'Kitchen towels', weekly(SUN, 'A')], [A, 'Bedding', weekly(SUN, 'A')], [A, 'Couch blankets', weekly(SUN, 'A')], [S, 'Bathroom wipe-down', weekly(WED, 'B')],
  [A, 'Dust, then vacuum', monthly(1, SUN)], [A, 'Litter box deep clean', monthly(2, THU)], [A, 'Vacuum, then mop', monthly(3, SUN)], [S, 'Furnace filter', monthly(1, MON, 'odd')],
];
const chores: ChoreRule[] = SEED.map(([owners, title, cadence], i) => ({ id: id(i + 1), title, owners, cadence, order: i + 1, ...stamp }));
const rhythm: Rhythm = { anchor: '2026-11-02', start: '2026-11-02', ...stamp };
const lists: ListRecord[] = [
  { id: 'sam', kind: 'person', name: 'Sam', color: 'yellow', order: 0, revision: 1, updatedAt: stamp.updatedAt }, { id: 'alex', kind: 'person', name: 'Alex', color: 'green', order: 1, revision: 1, updatedAt: stamp.updatedAt },
];
const settings = { bothColor: 'purple', revision: 1, updatedAt: stamp.updatedAt } as const;
const rule = (title: string, from: ChoreRule[] = chores) => from.find(r => r.title === title)!;
const mark = (title: string, date: string, over: Partial<ChoreMark> = {}, from: ChoreRule[] = chores): ChoreMark =>
  ({ id: `${rule(title, from).id}:${date}`, ruleId: rule(title, from).id, date, state: 'open', moved: false, ...stamp, ...over });
const input = (today: string, over: { marks?: ChoreMark[]; rules?: ChoreRule[]; rhythm?: Rhythm } = {}): ChoreInput => ({
  data: { lists, settings, chores: over.rules ?? chores, choreMarks: over.marks ?? [], rhythm: over.rhythm ?? rhythm }, today,
});
const titles = (rules: ChoreRule[]) => rules.map(r => r.title);
const rowTitles = (sections: ChoreSection[], kind?: string) => sections.filter(s => !kind || s.kind === kind).flatMap(s => s.rows.map(r => r.title));
const DAILY = ['Dishes', 'Trash & recycling', 'Wipe the table'];

describe('week letters', () => {
  it('count Monday-to-Sunday weeks from the anchor: A when even, B when odd', () => {
    expect(weekLetter('2026-11-02', '2026-11-02')).toBe('A');
    expect(weekLetter('2026-11-08', '2026-11-02')).toBe('A'); // a Sunday ends its week
    expect(weekLetter('2026-11-09', '2026-11-02')).toBe('B');
    expect(weekLetter('2026-11-15', '2026-11-02')).toBe('B');
    expect(weekLetter('2026-11-16', '2026-11-02')).toBe('A');
    expect(weekLetter('2026-12-06', '2026-11-02')).toBe('A');
    expect(weekLetter('2027-01-04', '2026-11-02')).toBe('B'); // nine weeks on
    expect(weekLetter('2026-10-26', '2026-11-02')).toBe('B'); // the week before the anchor
    expect(weekLetter('2026-10-19', '2026-11-02')).toBe('A');
  });
  it('rhythmAnchor makes this week A (its Monday) or B (the Monday before), from any day of the week', () => {
    for (const today of ['2026-11-02', '2026-11-04', '2026-11-08']) {
      expect(rhythmAnchor('A', today)).toBe('2026-11-02');
      expect(rhythmAnchor('B', today)).toBe('2026-10-26');
      expect(weekLetter(today, rhythmAnchor('B', today))).toBe('B');
    }
  });
});

describe('weeks and catch-up', () => {
  it('a turn is made up by the first Friday on or after it, in a chore week that runs from the Sunday on or before', () => {
    expect(catchUpFriday('2026-11-02')).toBe('2026-11-06');
    expect(catchUpFriday('2026-11-06')).toBe('2026-11-06');
    expect(catchUpFriday('2026-11-08')).toBe('2026-11-13'); // a Sunday starts the next chore week
    expect(choreWeekStart('2026-11-04')).toBe('2026-11-01');
    expect(choreWeekStart('2026-11-08')).toBe('2026-11-08');
    expect(mondayOf('2026-11-08')).toBe('2026-11-02');
    expect(choreDayLabel('2026-11-12')).toBe('Thu 12');
  });
});

describe('turnsOn', () => {
  const on = (date: string) => titles(turnsOn(chores, rhythm, date));
  it('has no turn on Sunday 1 November (before the start) or on any Saturday', () => {
    expect(on('2026-11-01')).toEqual([]);
    expect(on('2026-11-07')).toEqual([]);
    expect(on('2026-11-14')).toEqual([]);
    expect(turnsOn(chores, { ...rhythm, start: '2026-11-04' }, '2026-11-03')).toEqual([]);
  });
  it('Monday 2 November: the daily three, Cat bowls, Clutter reset and the odd-month Furnace filter', () => {
    expect(on('2026-11-02')).toEqual([...DAILY, 'Cat bowls', 'Clutter reset', 'Furnace filter']);
  });
  it('Wednesday 4 November (Week A): daily, the weekly two and the Week A Kitchen wipe-down', () => {
    expect(on('2026-11-04')).toEqual([...DAILY, 'Fridge clean-out', 'Bins to the curb', 'Kitchen wipe-down']);
  });
  it('Sunday 8 November (Week A): Laundry, Vacuum and the three Week A extras; the 1st-Sunday chore is not this one', () => {
    expect(on('2026-11-08')).toEqual([...DAILY, 'Laundry', 'Vacuum', 'Kitchen towels', 'Bedding', 'Couch blankets']);
  });
  it('Wednesday 11 November (Week B): the Bathroom wipe-down instead', () => {
    expect(on('2026-11-11')).toEqual([...DAILY, 'Fridge clean-out', 'Bins to the curb', 'Bathroom wipe-down']);
  });
  it('Thursday 12 November: Cat bowls, litter, and the 2nd-Thursday deep clean', () => {
    expect(on('2026-11-12')).toEqual([...DAILY, 'Cat bowls', 'Fresh litter + liner', 'Litter box deep clean']);
    expect(on('2026-11-05')).toEqual([...DAILY, 'Cat bowls', 'Fresh litter + liner']);
  });
  it('Sunday 15 November (Week B): the 3rd Sunday is Vacuum, then mop', () => {
    expect(on('2026-11-15')).toEqual([...DAILY, 'Laundry', 'Vacuum', 'Vacuum, then mop']);
  });
  it('Sunday 6 December (Week A, the 1st Sunday): nine turns', () => {
    expect(on('2026-12-06')).toEqual([...DAILY, 'Laundry', 'Vacuum', 'Kitchen towels', 'Bedding', 'Couch blankets', 'Dust, then vacuum']);
    expect(on('2026-12-06')).toHaveLength(9);
  });
  it('the Furnace filter is for odd months only: not Monday 7 December, back on Monday 4 January 2027', () => {
    expect(on('2026-12-07')).toEqual([...DAILY, 'Cat bowls', 'Clutter reset']);
    expect(on('2027-01-04')).toEqual([...DAILY, 'Cat bowls', 'Clutter reset', 'Furnace filter']);
    expect(on('2026-11-09')).not.toContain('Furnace filter');
  });
  it('returns rules in their order whatever order they are given in', () => {
    expect(titles(turnsOn([...chores].reverse(), rhythm, '2026-11-02'))).toEqual([...DAILY, 'Cat bowls', 'Clutter reset', 'Furnace filter']);
  });
  it('the nth and the last weekday of a month, and even months', () => {
    const rules = [monthly(4, THU), monthly(-1, THU), monthly(-1, THU, 'even'), monthly(2, FRI, 'even')].map((cadence, i) => ({ ...chores[0], id: id(100 + i), title: `m${i}`, cadence, order: i }));
    const on = (date: string) => titles(turnsOn(rules, rhythm, date));
    expect(on('2026-11-19')).toEqual([]);
    expect(on('2026-11-26')).toEqual(['m0', 'm1']); // the fourth and the last Thursday
    expect(on('2026-12-31')).toEqual(['m1', 'm2']); // a fifth Thursday is the last, not the fourth; December is even
    expect(on('2026-12-11')).toEqual(['m3']);
    expect(ruleTurnsOn(rules[3], rhythm, '2026-11-13')).toBe(false); // the second Friday of an odd month
  });
});

describe('the state of a turn as of today', () => {
  const state = (title: string, date: string, today: string, marks: ChoreMark[] = [], rules = chores) =>
    choreTurns(input(today, { marks, rules }).data, today, date).find(t => t.rule.title === title)!.state;

  it('is today, upcoming, then missed, and a missed Tuesday Mail & papers is Missed on Wednesday, Catch-up on Friday and let go on Saturday', () => {
    expect(state('Mail & papers', '2026-11-03', '2026-11-02')).toBe('upcoming');
    expect(state('Mail & papers', '2026-11-03', '2026-11-03')).toBe('today');
    expect(state('Mail & papers', '2026-11-03', '2026-11-04')).toBe('missed');
    expect(rowTitles(dayChores(input('2026-11-04'), '2026-11-04').sections, 'missed')).toContain('Mail & papers');
    expect(state('Mail & papers', '2026-11-03', '2026-11-06')).toBe('missed');
    const friday = dayChores(input('2026-11-06'), '2026-11-06').sections;
    expect(friday.find(s => s.kind === 'catchup')?.rows.find(r => r.title === 'Mail & papers')).toMatchObject({ from: 'Tue', kind: 'catchup' });
    expect(rowTitles(friday, 'missed')).toEqual([]);
    expect(state('Mail & papers', '2026-11-03', '2026-11-07')).toBe('letgo');
    expect(dayChores(input('2026-11-07'), '2026-11-07')).toMatchObject({ dayOff: true, sections: [] });
    expect(dayChores(input('2026-11-09'), '2026-11-09').sections.flatMap(s => s.rows.map(r => r.title))).not.toContain('Mail & papers');
  });
  it('a missed Monday Cat bowls is let go once Thursday\'s Cat bowls arrives (another rule, same title)', () => {
    expect(state('Cat bowls', '2026-11-02', '2026-11-04')).toBe('missed');
    expect(state('Cat bowls', '2026-11-02', '2026-11-05')).toBe('letgo');
    const thursday = dayChores(input('2026-11-05'), '2026-11-05').sections;
    expect(rowTitles(thursday, 'missed')).not.toContain('Cat bowls');
    expect(rowTitles(thursday, 'open')).toContain('Cat bowls');
    expect(rowTitles(thursday, 'missed')).toContain('Clutter reset'); // no other Clutter reset: still missed
  });
  it('compares titles trimmed and ignoring case', () => {
    const rules = chores.map(r => (r.id === rule('Cat bowls').id && r.cadence.kind === 'weekly' && r.cadence.day === THU ? { ...r, title: '  CAT bowls ' } : r));
    expect(state('Cat bowls', '2026-11-02', '2026-11-05', [], rules)).toBe('letgo');
    expect(state('Clutter reset', '2026-11-02', '2026-11-05', [], rules)).toBe('missed');
  });
  it('a missed daily chore is let go the next day, and is open all day on its own', () => {
    expect(state('Dishes', '2026-11-02', '2026-11-02')).toBe('today');
    expect(state('Dishes', '2026-11-02', '2026-11-03')).toBe('letgo');
    expect(rowTitles(dayChores(input('2026-11-03'), '2026-11-03').sections, 'missed')).not.toContain('Dishes');
    // Sunday to Friday: Friday's Dishes are let go on Saturday, and Sunday starts fresh.
    expect(state('Dishes', '2026-11-06', '2026-11-07')).toBe('letgo');
    expect(state('Dishes', '2026-11-08', '2026-11-08')).toBe('today');
  });
  it('a done mark wins over time; a let go by hand shows as let go', () => {
    expect(state('Cat bowls', '2026-11-02', '2026-11-05', [mark('Cat bowls', '2026-11-02', { state: 'done' })])).toBe('done');
    expect(state('Dishes', '2026-11-02', '2026-11-20', [mark('Dishes', '2026-11-02', { state: 'done' })])).toBe('done');
    const hand = choreTurns(input('2026-11-04', { marks: [mark('Mail & papers', '2026-11-03', { state: 'letgo' })] }).data, '2026-11-04', '2026-11-03').find(t => t.rule.title === 'Mail & papers')!;
    expect(hand).toMatchObject({ state: 'letgo', byHand: true });
    const time = choreTurns(input('2026-11-05').data, '2026-11-05', '2026-11-02').find(t => t.rule.title === 'Cat bowls')!;
    expect(time).toMatchObject({ state: 'letgo', byHand: false, mark: null });
  });
  it('moved: the turn sits dimmed on its own day, out of Missed, and is in Catch-up on Friday', () => {
    const marks = [mark('Mail & papers', '2026-11-03', { moved: true })];
    expect(state('Mail & papers', '2026-11-03', '2026-11-04', marks)).toBe('moved');
    const wed = dayChores(input('2026-11-04', { marks }), '2026-11-04').sections;
    expect(rowTitles(wed, 'missed')).not.toContain('Mail & papers');
    const tue = dayChores(input('2026-11-04', { marks }), '2026-11-03').sections;
    expect(tue.find(s => s.kind === 'moved')?.rows.map(r => r.title)).toEqual(['Mail & papers']);
    const fri = dayChores(input('2026-11-06', { marks }), '2026-11-06').sections;
    expect(fri.find(s => s.kind === 'catchup')?.rows.find(r => r.title === 'Mail & papers')).toMatchObject({ from: 'Tue', state: 'moved' });
    // Browsing ahead to Friday shows it too.
    expect(rowTitles(dayChores(input('2026-11-04', { marks }), '2026-11-06').sections, 'catchup')).toContain('Mail & papers');
    expect(state('Mail & papers', '2026-11-03', '2026-11-07', marks)).toBe('letgo');
  });
  it('a let go by hand sits dimmed on its own day, after the moved rows and before the done pile', () => {
    const marks = [mark('Mail & papers', '2026-11-03', { state: 'letgo' }), mark('Clutter reset', '2026-11-02', { moved: true }), mark('Cat bowls', '2026-11-02', { state: 'done' })];
    const mon = dayChores(input('2026-11-04', { marks }), '2026-11-02').sections;
    expect(mon.map(s => s.kind)).toEqual(['open', 'moved', 'done']);
    const tue = dayChores(input('2026-11-04', { marks }), '2026-11-03').sections;
    expect(tue.map(s => s.kind)).toEqual(['letgo']); // the daily chores of Tuesday were let go by time
    expect(tue.find(s => s.kind === 'letgo')?.rows.map(r => r.title)).toEqual(['Mail & papers']);
    // Letting go by time lists nowhere on the Day.
    expect(rowTitles(dayChores(input('2026-11-05'), '2026-11-02').sections)).not.toContain('Dishes');
  });
});

describe('the Day tab', () => {
  it('lists today\'s open turns, then Missed, with rows that say what a tap does', () => {
    const day = dayChores(input('2026-11-04'), '2026-11-04');
    expect(day).toMatchObject({ date: '2026-11-04', today: true, dayOff: false });
    expect(day.sections.map(s => [s.kind, s.label])).toEqual([['open', null], ['missed', 'Missed']]);
    expect(rowTitles(day.sections, 'open')).toEqual([...DAILY, 'Fridge clean-out', 'Bins to the curb', 'Kitchen wipe-down']);
    expect(rowTitles(day.sections, 'missed')).toEqual(['Cat bowls', 'Clutter reset', 'Furnace filter', 'Mail & papers']);
    const [dishes, , , , , kitchen] = day.sections[0].rows;
    expect(dishes).toMatchObject({ title: 'Dishes', ownerName: 'Alex', nextOwnerName: 'Both', color: 'green', chip: null, done: false, dateLabel: 'Wed 4' });
    expect(kitchen).toMatchObject({ chip: 'A', ownerName: 'Alex' });
    expect(day.sections[0].rows.find(r => r.title === 'Bins to the curb')).toMatchObject({ ownerName: 'Sam', nextOwnerName: 'Alex', color: 'yellow' });
  });
  it('rows carry how often their rule comes: daily has no badge, weekly, Week A, Week B and monthly each have one (the Missed and Catch-up rows too)', () => {
    const badges = (today: string, date = today) => dayChores(input(today), date).sections.flatMap(s => s.rows.map(r => [r.title, r.cadence, r.badge]));
    // Wed 4 Nov, Week A: the daily three, two weekly and a Week A chore of its own; Missed brings weekly and monthly turns of Monday and Tuesday.
    expect(badges('2026-11-04')).toEqual([
      ['Dishes', 'daily', null], ['Trash & recycling', 'daily', null], ['Wipe the table', 'daily', null],
      ['Fridge clean-out', 'weekly', 'Weekly'], ['Bins to the curb', 'weekly', 'Weekly'], ['Kitchen wipe-down', 'weekA', 'Week A'],
      ['Cat bowls', 'weekly', 'Weekly'], ['Clutter reset', 'weekly', 'Weekly'], ['Furnace filter', 'monthly', 'Monthly'], ['Mail & papers', 'weekly', 'Weekly'],
    ]);
    expect(badges('2026-11-11').filter(([title]) => title === 'Bathroom wipe-down')).toEqual([['Bathroom wipe-down', 'weekB', 'Week B']]);
    // Sun 6 Dec 2026: Laundry and Vacuum weekly, the three Week A rules of a Sunday, and the 1st Sunday's monthly "Dust, then vacuum".
    expect(badges('2026-12-06').slice(3)).toEqual([
      ['Laundry', 'weekly', 'Weekly'], ['Vacuum', 'weekly', 'Weekly'], ['Kitchen towels', 'weekA', 'Week A'], ['Bedding', 'weekA', 'Week A'], ['Couch blankets', 'weekA', 'Week A'], ['Dust, then vacuum', 'monthly', 'Monthly'],
    ]);
    // A catch-up row keeps its badge next to its "from" chip.
    const catchup = dayChores(input('2026-11-06'), '2026-11-06').sections.find(s => s.kind === 'catchup')!.rows.find(r => r.title === 'Kitchen wipe-down')!;
    expect(catchup).toMatchObject({ from: 'Wed', cadence: 'weekA', badge: 'Week A', chip: 'A' });
  });
  it('is only today\'s own turns on another day; Missed belongs to today, and a done turn goes to the bottom', () => {
    const marks = [mark('Dishes', '2026-11-05', { state: 'done' })];
    const ahead = dayChores(input('2026-11-04', { marks }), '2026-11-05');
    expect(ahead.today).toBe(false);
    expect(ahead.sections.map(s => s.kind)).toEqual(['open', 'done']);
    expect(rowTitles(ahead.sections, 'done')).toEqual(['Dishes']);
    expect(ahead.sections[0].rows[0].state).toBe('upcoming');
    const back = dayChores(input('2026-11-04'), '2026-11-03');
    expect(back.sections.map(s => s.kind)).toEqual(['open']);
    expect(back.sections[0].rows.find(r => r.title === 'Mail & papers')?.state).toBe('missed');
  });
  it('Friday lists Catch-up (missed and moved, Sunday to Thursday) with "from" chips, and leaves the group out when empty', () => {
    const fri = dayChores(input('2026-11-06'), '2026-11-06');
    expect(fri.sections.map(s => [s.kind, s.label])).toEqual([['open', null], ['catchup', 'Catch-up']]);
    expect(fri.sections[1].rows.map(r => `${r.from}:${r.title}`)).toEqual([
      'Mon:Clutter reset', 'Mon:Furnace filter', 'Tue:Mail & papers', 'Wed:Fridge clean-out', 'Wed:Bins to the curb', 'Wed:Kitchen wipe-down', 'Thu:Cat bowls', 'Thu:Fresh litter + liner',
    ]);
    // Mon's Cat bowls were let go on Thursday, so they are not here; each of the rest let go by hand empties the group.
    const marks = fri.sections[1].rows.map(r => ({ ...mark(r.title, r.date, { state: 'letgo' }), id: r.id, ruleId: r.rule.id }));
    expect(dayChores(input('2026-11-06', { marks }), '2026-11-06').sections.map(s => s.kind)).toEqual(['open']);
  });
  it('a catch-up turn made up on Friday stays in the Friday pile with its "from" chip', () => {
    const catchup = dayChores(input('2026-11-06'), '2026-11-06').sections.find(s => s.kind === 'catchup')!.rows.find(r => r.title === 'Mail & papers')!;
    const write = choreMark(catchup, 'check');
    expect(write).toEqual({ action: 'markChore', ruleId: rule('Mail & papers').id, date: '2026-11-03', state: 'done', moved: true, revision: 0 });
    const made = mark('Mail & papers', '2026-11-03', { state: 'done', moved: true, revision: 1 });
    const fri = dayChores(input('2026-11-06', { marks: [made] }), '2026-11-06').sections;
    expect(fri.find(s => s.kind === 'done')?.rows.map(r => [r.title, r.from, r.done])).toEqual([['Mail & papers', 'Tue', true]]);
    expect(fri.find(s => s.kind === 'catchup')?.rows.map(r => r.title)).not.toContain('Mail & papers');
    // On its own day it is simply done, and taking the check back sends it to the catch-up list again.
    expect(dayChores(input('2026-11-06', { marks: [made] }), '2026-11-03').sections.find(s => s.kind === 'done')?.rows[0].from).toBeNull();
    expect(choreMark(fri.find(s => s.kind === 'done')!.rows[0], 'check')).toMatchObject({ state: 'open', moved: true, revision: 1 });
  });
  it('Saturday is a day off and nothing else', () => {
    expect(dayChores(input('2026-11-07'), '2026-11-07')).toEqual({ date: '2026-11-07', today: true, dayOff: true, sections: [] });
  });
  it('lists nothing before the start', () => {
    expect(dayChores(input('2026-11-01'), '2026-11-01').sections).toEqual([]);
  });
});

describe('writes', () => {
  const turn = (title: string, date: string, today: string, marks: ChoreMark[] = []) => choreTurns(input(today, { marks }).data, today, date).find(t => t.rule.title === title)!;
  const base = (title: string, date: string) => ({ action: 'markChore', ruleId: rule(title).id, date });

  it('check sets and clears done; move and unmove set and clear the catch-up Friday; letgo and unletgo', () => {
    const open = turn('Fridge clean-out', '2026-11-04', '2026-11-04');
    expect(choreMark(open, 'check')).toEqual({ ...base('Fridge clean-out', '2026-11-04'), state: 'done', moved: false, revision: 0 });
    const done = turn('Fridge clean-out', '2026-11-04', '2026-11-04', [mark('Fridge clean-out', '2026-11-04', { state: 'done', revision: 3 })]);
    expect(choreMark(done, 'check')).toEqual({ ...base('Fridge clean-out', '2026-11-04'), state: 'open', moved: false, revision: 3 });
    const missed = turn('Mail & papers', '2026-11-03', '2026-11-04');
    expect(choreMark(missed, 'move')).toEqual({ ...base('Mail & papers', '2026-11-03'), state: 'open', moved: true, revision: 0 });
    expect(choreMark(missed, 'letgo')).toEqual({ ...base('Mail & papers', '2026-11-03'), state: 'letgo', moved: false, revision: 0 });
    const moved = turn('Mail & papers', '2026-11-03', '2026-11-04', [mark('Mail & papers', '2026-11-03', { moved: true, revision: 2 })]);
    expect(choreMark(moved, 'unmove')).toEqual({ ...base('Mail & papers', '2026-11-03'), state: 'open', moved: false, revision: 2 });
    const hand = turn('Mail & papers', '2026-11-03', '2026-11-04', [mark('Mail & papers', '2026-11-03', { state: 'letgo', revision: 4 })]);
    expect(choreMark(hand, 'unletgo')).toEqual({ ...base('Mail & papers', '2026-11-03'), state: 'open', moved: false, revision: 4 });
  });
  it('the owner of a turn cycles Sam, Alex, Both, Sam; a tap that lands on the rule\'s own owners removes the override', () => {
    expect([nextOwners(['sam']), nextOwners(['alex']), nextOwners(['alex', 'sam'])]).toEqual([['alex'], ['alex', 'sam'], ['sam']]);
    let marks: ChoreMark[] = [];
    const seen: string[] = [];
    for (let tap = 0; tap < 4; tap++) {
      const t = turn('Fridge clean-out', '2026-11-04', '2026-11-04', marks); // Sam's by default
      seen.push(t.owners.join('+'));
      const write = choreMark(t, 'owner');
      marks = 'owners' in write ? [mark('Fridge clean-out', '2026-11-04', { owners: write.owners, revision: write.revision + 1 })] : [];
      if (tap === 2) expect(write).toEqual({ ...base('Fridge clean-out', '2026-11-04'), state: 'open', moved: false, revision: 2 }); // back to Sam: no owners sent
    }
    expect(seen).toEqual(['sam', 'alex', 'alex+sam', 'sam']);
    const override = turn('Fridge clean-out', '2026-11-04', '2026-11-04', [mark('Fridge clean-out', '2026-11-04', { owners: ['alex'] })]);
    expect(override).toMatchObject({ owners: ['alex'], color: 'green' });
    // The override rides along when something else about the turn changes.
    expect(choreMark(override, 'check')).toMatchObject({ owners: ['alex'], state: 'done' });
  });
  it('builds rule edits for The rhythm', () => {
    const cat = rule('Cat bowls');
    expect(choreEdit(cat, { owners: nextOwners(cat.owners) })).toEqual({ action: 'saveChore', id: cat.id, title: 'Cat bowls', owners: ['alex'], cadence: weekly(MON), revision: 1 });
    expect(choreEdit(cat, { title: 'Bowls', cadence: weekly(TUE, 'B') })).toMatchObject({ title: 'Bowls', owners: ['sam'], cadence: weekly(TUE, 'B') });
    expect(choreAdd(id(99), { title: 'Water plants', owners: AS, cadence: weekly(SUN) })).toEqual({ action: 'saveChore', id: id(99), title: 'Water plants', owners: AS, cadence: weekly(SUN), revision: 0 });
  });
  it('groups the rules for The rhythm and picks defaults for a new one', () => {
    const groups = rhythmGroups(chores);
    expect(groups.map(g => [g.key, g.label, g.rules.length])).toEqual([['daily', 'Daily', 3], ['weekly', 'Weekly', 9], ['weekA', 'Week A', 4], ['weekB', 'Week B', 1], ['monthly', 'Monthly', 4]]);
    expect(titles(groups[2].rules)).toEqual(['Kitchen wipe-down', 'Kitchen towels', 'Bedding', 'Couch blankets']);
    expect(rhythmGroups([]).every(g => g.rules.length === 0)).toBe(true);
    expect([daily, weekly(MON), weekly(MON, 'A'), weekly(MON, 'B'), monthly(2, THU, 'odd')].map(cadenceGroup)).toEqual(['daily', 'weekly', 'weekA', 'weekB', 'monthly']);
    expect(newChoreOwners()).toEqual(['alex', 'sam']);
    expect(['2026-11-02', '2026-11-06', '2026-11-07', '2026-11-08'].map(newChoreDay)).toEqual([1, 5, 0, 0]);
  });
  it('starts a new rule of each group on today\'s weekday, and changes one thing of a cadence at a time', () => {
    expect((['daily', 'weekly', 'weekA', 'weekB', 'monthly'] as const).map(group => choreStart(group, '2026-11-05'))).toEqual([daily, weekly(THU), weekly(THU, 'A'), weekly(THU, 'B'), monthly(1, THU)]);
    expect(choreStart('weekly', '2026-11-07')).toEqual(weekly(SUN)); // Saturday has no chores: Sunday
    expect(cadenceWith(weekly(MON), { day: FRI })).toEqual(weekly(FRI));
    expect(cadenceWith(weekly(MON), { weeks: 'B' })).toEqual(weekly(MON, 'B'));
    expect(cadenceWith(monthly(1, MON, 'odd'), { nth: -1 })).toEqual(monthly(-1, MON, 'odd'));
    expect(cadenceWith(monthly(1, MON, 'odd'), { months: 'even' })).toEqual(monthly(1, MON, 'even'));
    expect(cadenceWith(monthly(1, MON), { day: WED })).toEqual(monthly(1, WED));
    // A change that is not this kind's leaves it alone, and a daily rule has nothing to change.
    expect(cadenceWith(weekly(MON), { nth: 2 })).toEqual(weekly(MON));
    expect(cadenceWith(monthly(1, MON), { weeks: 'A' })).toEqual(monthly(1, MON));
    expect(cadenceWith(daily, { day: FRI })).toEqual(daily);
  });
  it('says when a rule happens in a few words', () => {
    expect([daily, weekly(MON), weekly(SUN, 'A'), monthly(1, SUN), monthly(2, THU), monthly(3, WED), monthly(4, FRI, 'even'), monthly(-1, MON, 'odd')].map(cadenceText))
      .toEqual(['', 'Mon', 'Sun', '1st Sun', '2nd Thu', '3rd Wed', '4th Fri · even', 'Last Mon · odd']);
  });
});

describe('chores are always shared', () => {
  // The builders take no selection at all: whoever the picker shows (Alex, Sam, a custom list), every chore is listed, whoever it is for.
  const day = (date: string, marks: ChoreMark[] = [], kind?: string) => rowTitles(dayChores(input(date, { marks }), date).sections, kind);
  it('lists every chore of the day, Alex\'s, Sam\'s and Both\'s alike', () => {
    expect(day('2026-11-02')).toEqual([...DAILY, 'Cat bowls', 'Clutter reset', 'Furnace filter']);
    expect(day('2026-11-03', [], 'open')).toEqual([...DAILY, 'Mail & papers']);
    expect(day('2026-11-04', [], 'open')).toEqual([...DAILY, 'Fridge clean-out', 'Bins to the curb', 'Kitchen wipe-down']);
  });
  it('colors a row by its owner: Alex green, Sam yellow, Both the Both color', () => {
    const rows = dayChores(input('2026-11-03'), '2026-11-03').sections.filter(s => s.kind === 'open').flatMap(s => s.rows);
    expect(rows.map(r => [r.title, r.color])).toEqual([['Dishes', 'green'], ['Trash & recycling', 'yellow'], ['Wipe the table', 'green'], ['Mail & papers', 'purple']]);
  });
  it('keeps a turn on the list when it is handed to the other person', () => {
    expect(day('2026-11-02', [mark('Dishes', '2026-11-02', { owners: ['sam'] })])).toContain('Dishes');
  });
  it('is the same for the Week and the Month: the grid holds every daily chore, the lists every monthly and A / B one', () => {
    expect(weekChores(input('2026-11-02'), '2026-11-02').grid.map(r => r.title)).toEqual(DAILY);
    expect(monthChores(input('2026-11-02'), '2026-11-01').monthly.map(r => r.title)).toEqual(['Furnace filter', 'Litter box deep clean', 'Vacuum, then mop']);
    expect(monthChores(input('2026-11-02'), '2026-11-01').weeks[0].rows.map(r => r.title)).toEqual(['Kitchen wipe-down', 'Kitchen towels', 'Bedding', 'Couch blankets']);
  });
});

describe('the Week tab', () => {
  it('has the week letter, the daily grid with a column per day, and a group for each day', () => {
    const week = weekChores(input('2026-11-02'), '2026-11-02');
    expect(week).toMatchObject({ monday: '2026-11-02', letter: 'A', label: 'Week A' });
    expect(week.columns.map(c => c.label).join('')).toBe('MTWTFSS');
    expect(week.columns.map(c => c.today)).toEqual([true, false, false, false, false, false, false]);
    expect(week.grid.map(r => r.title)).toEqual(DAILY);
    expect(week.days.map(d => [d.label, d.today, d.dayOff])).toEqual([
      ['Mon 2', true, false], ['Tue 3', false, false], ['Wed 4', false, false], ['Thu 5', false, false], ['Fri 6 · Catch-up', false, false], ['Sat 7', false, true], ['Sun 8', false, false],
    ]);
    expect(week.days.map(d => rowTitles(d.sections))).toEqual([
      ['Cat bowls', 'Clutter reset', 'Furnace filter'], ['Mail & papers'], ['Fridge clean-out', 'Bins to the curb', 'Kitchen wipe-down'], ['Cat bowls', 'Fresh litter + liner'], [], [],
      ['Laundry', 'Vacuum', 'Kitchen towels', 'Bedding', 'Couch blankets'],
    ]);
    expect(weekChores(input('2026-11-09'), '2026-11-09').label).toBe('Week B');
  });
  it('draws ✓ done, ○ today or missed, – let go or Saturday, · upcoming, and lets today and past days toggle', () => {
    const marks = [mark('Dishes', '2026-11-02', { state: 'done' }), mark('Dishes', '2026-11-04', { state: 'done' })];
    const dishes = weekChores(input('2026-11-04', { marks }), '2026-11-02').grid[0];
    expect(dishes.cells.map(c => c.symbol).join(' ')).toBe('✓ – ✓ · · – ·');
    expect(dishes.cells.map(c => c.state)).toEqual(['done', 'letgo', 'done', 'upcoming', 'upcoming', 'off', 'upcoming']);
    expect(dishes.cells.map(c => c.canToggle)).toEqual([true, true, true, false, false, false, false]);
    expect(dishes.cells.map(c => c.today)).toEqual([false, false, true, false, false, false, false]);
    const trash = weekChores(input('2026-11-04', { marks }), '2026-11-02').grid[1];
    expect(trash.cells[2]).toMatchObject({ symbol: '○', state: 'today' });
    expect(trash.cells[2].turn && choreMark(trash.cells[2].turn, 'check')).toMatchObject({ state: 'done', date: '2026-11-04' });
    expect(weekChores(input('2026-11-02'), '2026-10-26').grid[0].cells.map(c => c.symbol).join('')).toBe('–'.repeat(7)); // before the start
  });
  it('keeps a past miss on its own day and lists catch-up rows in Friday\'s group', () => {
    const week = weekChores(input('2026-11-06'), '2026-11-02');
    expect(rowTitles(week.days[1].sections)).toEqual(['Mail & papers']);
    expect(week.days[1].sections[0].rows[0].state).toBe('missed');
    const friday = week.days[4];
    expect(friday.label).toBe('Fri 6 · Catch-up');
    expect(friday.sections.map(s => s.kind)).toEqual(['catchup']);
    expect(rowTitles(friday.sections)).toContain('Mail & papers');
    expect(rowTitles(friday.sections)).not.toContain('Dishes');
    expect(weekChores(input('2026-11-04'), '2026-11-02').days.flatMap(d => d.sections).some(s => s.kind === 'missed')).toBe(false); // Missed is the Day's
  });
});

describe('the Month tab', () => {
  const month = monthChores(input('2026-11-02'), '2026-11-01');
  it('lists the monthly turns with date labels, then each week\'s Week A or B extras that fall in the month', () => {
    expect(month.monthly.map(r => `${r.title} ${r.dateLabel}`)).toEqual(['Furnace filter Mon 2', 'Litter box deep clean Thu 12', 'Vacuum, then mop Sun 15']);
    expect(month.weeks.map(w => [w.label, w.letter, w.rows.map(r => `${r.title} ${r.dateLabel}`)])).toEqual([
      ['Nov 2–8 · Week A', 'A', ['Kitchen wipe-down Wed 4', 'Kitchen towels Sun 8', 'Bedding Sun 8', 'Couch blankets Sun 8']],
      ['Nov 9–15 · Week B', 'B', ['Bathroom wipe-down Wed 11']],
      ['Nov 16–22 · Week A', 'A', ['Kitchen wipe-down Wed 18', 'Kitchen towels Sun 22', 'Bedding Sun 22', 'Couch blankets Sun 22']],
      ['Nov 23–29 · Week B', 'B', ['Bathroom wipe-down Wed 25']],
    ]);
    expect(month.weeks[0].rows[0]).toMatchObject({ chip: 'A', kind: 'open', ownerName: 'Alex' });
  });
  it('names a week that crosses into the next month by both', () => {
    const december = monthChores(input('2026-11-02'), '2026-12-01');
    expect(december.weeks[0].label).toBe('Nov 30–Dec 6 · Week A');
    expect(december.monthly.map(r => r.dateLabel)).toEqual(['Sun 6', 'Thu 10', 'Sun 20']);
    expect(monthChores(input('2026-11-02'), '2026-10-01')).toMatchObject({ monthly: [], weeks: [] }); // before the start
  });
  it('shows done rows crossed out, taken-back rows open again, and nothing for a let go by time', () => {
    const marks = [mark('Furnace filter', '2026-11-02', { state: 'done' })];
    expect(monthChores(input('2026-11-02', { marks }), '2026-11-01').monthly[0]).toMatchObject({ kind: 'done', done: true });
    const later = monthChores(input('2026-11-20'), '2026-11-01');
    expect(later.monthly.map(r => r.title)).toEqual(['Vacuum, then mop']); // Furnace filter and Litter box were let go by time
    expect(later.weeks.map(w => w.letter)).toEqual(['A', 'B']);
  });
  it('is a calendar: the Monday-first weeks of the month with a letter each (none before the rhythm starts), and in each day of the month that day\'s monthly and Week A or B turns', () => {
    const grid = monthChoreGrid(input('2026-11-04'), '2026-11-01');
    expect(grid.weeks).toHaveLength(6);
    // Oct 26 - Nov 1 ends the day before the rhythm starts: no letter.
    expect(grid.weeks.map(w => [w.monday, w.letter])).toEqual([['2026-10-26', null], ['2026-11-02', 'A'], ['2026-11-09', 'B'], ['2026-11-16', 'A'], ['2026-11-23', 'B'], ['2026-11-30', 'A']]);
    const days = grid.weeks.flatMap(w => w.days);
    expect(days).toHaveLength(42);
    const at = (date: string) => days.find(d => d.date === date)!;
    expect(at('2026-10-26')).toMatchObject({ inMonth: false, day: 26, rows: [], dayOff: false, beforeStart: false });
    expect(at('2026-11-01')).toMatchObject({ inMonth: true, beforeStart: true, rows: [] }); // a day of the month before the rhythm starts
    expect(at('2026-11-02')).toMatchObject({ beforeStart: false });
    expect(at('2026-11-30')).toMatchObject({ inMonth: true, rows: [] });
    expect(at('2026-12-06')).toMatchObject({ inMonth: false, rows: [] }); // outside the month, so empty even though Dec 6 has chores
    expect(at('2026-11-04')).toMatchObject({ today: true });
    expect(days.filter(d => d.today)).toHaveLength(1);
    expect(at('2026-11-02').rows.map(r => r.title)).toEqual(['Furnace filter']);
    expect(at('2026-11-04').rows.map(r => r.title)).toEqual(['Kitchen wipe-down']);
    expect(at('2026-11-08').rows.map(r => r.title)).toEqual(['Kitchen towels', 'Bedding', 'Couch blankets']);
    expect(at('2026-11-12').rows.map(r => r.title)).toEqual(['Litter box deep clean']);
    // Every-day and every-week chores are not on the Month; a Saturday of the month is a day off.
    expect(at('2026-11-03').rows).toEqual([]);
    expect(at('2026-11-07')).toMatchObject({ dayOff: true, rows: [] });
    expect(at('2026-10-31')).toMatchObject({ inMonth: false, dayOff: false });
    // The same rows as the list: a done turn is crossed out, one let go by time is not there.
    const done = monthChoreGrid(input('2026-11-04', { marks: [mark('Furnace filter', '2026-11-02', { state: 'done' })] }), '2026-11-01');
    expect(done.weeks[1].days[0].rows[0]).toMatchObject({ kind: 'done', done: true });
    expect(monthChoreGrid(input('2026-11-20'), '2026-11-01').weeks[1].days[0].rows).toEqual([]);
    // A week with no day of the month is not there: a February that starts on a Monday and ends on a Sunday has four, March 2027 five.
    expect(monthChoreGrid(input('2027-02-10'), '2027-02-01').weeks.map(w => w.monday)).toEqual(['2027-02-01', '2027-02-08', '2027-02-15', '2027-02-22']);
    expect(monthChoreGrid(input('2027-03-10'), '2027-03-01').weeks.map(w => [w.monday, w.letter])).toEqual([['2027-03-01', 'B'], ['2027-03-08', 'A'], ['2027-03-15', 'B'], ['2027-03-22', 'A'], ['2027-03-29', 'B']]);
    expect(monthChoreGrid(input('2026-11-04'), '2026-10-01').weeks.map(w => w.letter)).toEqual([null, null, null, null, null]); // October 2026: the rhythm starts on Nov 2
  });
  it('counts the month\'s done turns of all it shows (monthly and A / B only, a turn let go by hand still shown)', () => {
    expect(monthChoreGrid(input('2026-11-04'), '2026-11-01')).toMatchObject({ done: 0, total: 13 });
    // Nov 10: the first week is past its catch-up Friday (let go by time, so not shown); Kitchen towels is done, Bedding let go by hand (shown dim, so counted), Couch blankets sent to the catch-up Friday (still to do).
    const marks = [mark('Kitchen towels', '2026-11-08', { state: 'done' }), mark('Bedding', '2026-11-08', { state: 'letgo' }), mark('Couch blankets', '2026-11-08', { moved: true })];
    expect(monthChoreGrid(input('2026-11-10', { marks }), '2026-11-01')).toMatchObject({ done: 1, total: 11 });
    // Turns let go by time are not shown, so they are not counted: on Nov 20 the first two weeks are past their catch-up Friday.
    expect(monthChoreGrid(input('2026-11-20'), '2026-11-01')).toMatchObject({ done: 0, total: 6 });
    expect(monthChoreGrid(input('2026-11-04'), '2026-10-01')).toMatchObject({ done: 0, total: 0 });
  });
});

describe('the planner\'s Month calendar', () => {
  const cells = (today: string, first: string, over: Parameters<typeof input>[1] = {}) => monthChoreCells(input(today, over), first);
  const at = (list: ReturnType<typeof cells>, date: string) => list.find(c => c.date === date)!;
  it('is the 42 cells of monthView\'s grid, same dates and order, whatever month it is', () => {
    for (const first of ['2026-10-01', '2026-11-01', '2026-12-01', '2027-02-01', '2027-03-01', '2028-02-01']) {
      expect(cells('2026-11-04', first).map(c => [c.date, c.inMonth]), first).toEqual(monthGrid(first, 6).map(c => [c.date, c.inMonth]));
    }
  });
  it('gives each cell its week\'s letter (none before the rhythm starts), so the A rows can be told from the B rows', () => {
    const list = cells('2026-11-04', '2026-11-01');
    expect([0, 7, 14, 21, 28, 35].map(i => list[i].letter)).toEqual([null, 'A', 'B', 'A', 'B', 'A']);
    for (let week = 0; week < 6; week++) { expect(new Set(list.slice(week * 7, week * 7 + 7).map(c => c.letter)).size, `week ${week}`).toBe(1); }
    // The letter belongs to the cell even outside the month: the drawing decides that only days of the month are tinted.
    expect(at(list, '2026-12-01')).toMatchObject({ inMonth: false, letter: 'A' });
  });
  it('knows its Saturdays, in the month or not (the quiet hatch), and marks a Saturday of the month as the day off', () => {
    const list = cells('2026-11-04', '2026-11-01');
    expect(list.filter(c => c.saturday).map(c => c.date)).toEqual(['2026-10-31', '2026-11-07', '2026-11-14', '2026-11-21', '2026-11-28', '2026-12-05']);
    expect(at(list, '2026-11-07')).toMatchObject({ saturday: true, dayOff: true });
    expect(at(list, '2026-10-31')).toMatchObject({ saturday: true, dayOff: false, inMonth: false });
    expect(at(list, '2026-11-09')).toMatchObject({ saturday: false });
  });
  it('carries the same turns the Chores Month page shows (monthly and Week A / B only), chips for the day: owner colors, done, missed, let go', () => {
    const marks = [mark('Furnace filter', '2026-11-02', { state: 'done' }), mark('Kitchen wipe-down', '2026-11-04', { owners: A })];
    const list = cells('2026-11-10', '2026-11-01', { marks });
    const grid = monthChoreGrid(input('2026-11-10', { marks }), '2026-11-01').weeks.flatMap(w => w.days);
    for (const day of grid) { expect(at(list, day.date).rows.map(r => r.id), day.date).toEqual(day.rows.map(r => r.id)); }
    expect(at(list, '2026-11-02').rows[0]).toMatchObject({ title: 'Furnace filter', kind: 'done', done: true, color: 'green' });
    // Kitchen wipe-down of Nov 4 is Alex's rule; the mark hands that one turn to Sam (it is still shown on Nov 5, inside its chore week).
    expect(at(cells('2026-11-05', '2026-11-01', { marks }), '2026-11-04').rows[0]).toMatchObject({ title: 'Kitchen wipe-down', ownerName: 'Sam', color: 'yellow', state: 'missed' });
    expect(at(list, '2026-11-08').rows.map(r => r.title)).toEqual(['Kitchen towels', 'Bedding', 'Couch blankets']);
    // A turn past its day and still inside its chore week is missed, and says so for the warning edge.
    expect(at(list, '2026-11-08').rows[0]).toMatchObject({ state: 'missed' });
    // Days outside the month have none, even where the other month has chores.
    expect(at(list, '2026-12-06').rows).toEqual([]);
    expect(list.flatMap(c => c.rows)).toHaveLength(grid.reduce((n, d) => n + d.rows.length, 0));
  });
  it('ignores the picker: there is no selection in it, and the chores of every owner are there', () => {
    const owners = new Set(cells('2026-11-04', '2026-11-01').flatMap(c => c.rows.map(r => r.ownerName)));
    expect([...owners].sort()).toEqual(['Alex', 'Sam']);
  });
  it('has nothing before the rhythm starts, and a week crossing two months shows each month only its own days', () => {
    expect(cells('2026-11-04', '2026-10-01').flatMap(c => c.rows)).toEqual([]);
    const november = cells('2026-11-04', '2026-11-01'), december = cells('2026-11-04', '2026-12-01');
    expect(at(november, '2026-11-30').inMonth).toBe(true);
    expect(at(december, '2026-11-30')).toMatchObject({ inMonth: false, rows: [] });
    expect(at(december, '2026-12-06').rows.map(r => r.title)).toEqual(['Kitchen towels', 'Bedding', 'Couch blankets', 'Dust, then vacuum']);
  });
});

describe('the bars of a phone\'s Month cell', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `row${i}` })) as unknown as Parameters<typeof choreBars>[0];
  it('draws a bar for each of the first three turns and "+n" for the rest', () => {
    expect(CHORE_BARS).toBe(3);
    expect(choreBars(rows(0))).toEqual({ bars: [], more: 0 });
    expect(choreBars(rows(2))).toMatchObject({ more: 0 });
    expect(choreBars(rows(2)).bars).toHaveLength(2);
    expect(choreBars(rows(3))).toMatchObject({ more: 0 });
    expect(choreBars(rows(3)).bars).toHaveLength(3);
    const four = choreBars(rows(5));
    expect(four.bars.map(b => b.id)).toEqual(['row0', 'row1', 'row2']);
    expect(four.more).toBe(2);
  });
  it('is what the cells of a real day give: Nov 8 has three turns, Dec 6 has four', () => {
    expect(choreBars(monthChoreCells(input('2026-11-04'), '2026-11-01').find(c => c.date === '2026-11-08')!.rows)).toMatchObject({ more: 0 });
    expect(choreBars(monthChoreCells(input('2026-11-04'), '2026-12-01').find(c => c.date === '2026-12-06')!.rows).more).toBe(1);
  });
});
