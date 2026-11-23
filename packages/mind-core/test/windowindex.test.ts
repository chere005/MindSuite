import { describe, expect, it } from 'vitest';
import { addDays, cellMarks, cellMarksRange, dayItems, dayItemsRange, monthGridFilled, monthLegend } from '../src/day';
import { REPEAT_MAX, repeatDates, repeatStep, repeatAdvances } from '../src/repeats';
import type { AnyRec, FolderMode, Rec, Repeat } from '../src/types';

/**
 * The window forms (repeatDates skipping to the window, dayItemsRange filing a
 * whole window in one pass) are speed-ups of rules that were already pinned
 * one day at a time. These tests hold them to the one-day answers: the
 * reference below is the old walk from the first step, and dayItems is the
 * per-day truth for the range.
 */

const naiveRepeatDates = (start: string, rep: Repeat | null, from: string, to: string): string[] => {
  if (start === '' || to < from) return [];
  if (!rep) return start >= from && start <= to ? [start] : [];
  if (!repeatAdvances(start, rep)) return start >= from && start <= to ? [start] : [];
  const out: string[] = [];
  for (let i = 0; i < REPEAT_MAX; i++) {
    const d = repeatStep(start, rep, i);
    if (d > to) break;
    if (d >= from) out.push(d);
  }
  return out;
};

// A small seeded generator: the suite must not flake, and a failure must replay.
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

const TODAY = '2026-08-07';

describe('repeatDates over a window equals the walk from the first step', () => {
  it('agrees on random rules, starts and windows, including the REPEAT_MAX cap', () => {
    const r = rng(7);
    const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
    const units: Repeat['unit'][] = ['day', 'week', 'month', 'year'];
    const starts = ['2020-01-31', '2024-02-29', '2025-12-31', '2026-03-30', '2026-08-07', '2027-01-01', '2019-06-15'];
    let checked = 0;
    for (let i = 0; i < 4000; i++) {
      const rep: Repeat = { n: pick([1, 1, 1, 2, 3, 7, 14, 30]), unit: pick(units) };
      const start = pick(starts);
      const from = addDays(pick(['2026-01-01', '2026-08-01', '2026-12-25', '2028-03-01', '2019-01-01', '2035-01-01']), Math.floor(r() * 60));
      const to = addDays(from, Math.floor(r() * 45));
      expect(repeatDates(start, rep, from, to), JSON.stringify({ start, rep, from, to })).toEqual(naiveRepeatDates(start, rep, from, to));
      checked++;
    }
    expect(checked).toBe(4000);
  });

  it('keeps the cap: a daily repeat older than REPEAT_MAX days has no occurrence past it', () => {
    const rep: Repeat = { n: 1, unit: 'day' };
    expect(repeatDates('2020-01-01', rep, '2026-08-01', '2026-08-31')).toEqual([]);
    expect(repeatDates('2025-08-01', rep, '2026-08-01', '2026-08-03')).toEqual(naiveRepeatDates('2025-08-01', rep, '2026-08-01', '2026-08-03'));
  });

  it('leaves a rule that does not advance, or a window before the start, alone', () => {
    expect(repeatDates('2026-08-07', { n: 0, unit: 'day' }, '2026-08-01', '2026-08-31')).toEqual(['2026-08-07']);
    expect(repeatDates('2026-08-07', { n: 1, unit: 'fortnight' as never }, '2026-08-01', '2026-08-31')).toEqual(['2026-08-07']);
    expect(repeatDates('2026-08-07', { n: 2, unit: 'week' }, '2026-01-01', '2026-08-31')).toEqual(naiveRepeatDates('2026-08-07', { n: 2, unit: 'week' }, '2026-01-01', '2026-08-31'));
  });
});

const folder = (id: string, opts: Partial<Rec<'folder'>['payload']> = {}): Rec<'folder'> => ({
  id, type: 'folder', updated: 0, payload: { name: id, color: `#${id.length}${id.length}${id.length}`, ord: id, app: 'reminders', ...opts },
});

function fuzzRecs(seed: number): { recs: AnyRec[]; modes: Record<string, FolderMode> } {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const day = () => addDays('2026-06-20', Math.floor(r() * 90) - (r() < 0.2 ? 400 : 0));
  const units: Repeat['unit'][] = ['day', 'week', 'month', 'year'];
  const rep = (): Repeat | null => (r() < 0.45 ? { n: pick([1, 1, 2, 3, 0]), unit: pick(units) } : null);
  const recs: AnyRec[] = [
    folder('fa'), folder('fb', { rideAlong: true }), folder('fc'), folder('fn', { app: 'notes' }),
    { id: 'c1', type: 'calendar', updated: 0, payload: { name: 'one', color: '#111111', ord: 'a' } } as AnyRec,
    { id: 'c2', type: 'calendar', updated: 0, payload: { name: 'two', color: '#222222', ord: 'b' } } as AnyRec,
  ];
  for (let i = 0; i < 160; i++) {
    const d = day();
    const span = r() < 0.2 ? addDays(d, 1 + Math.floor(r() * 5)) : r() < 0.05 ? d : null;
    recs.push({
      id: `e${i}`, type: 'event', updated: 0, deleted: r() < 0.05 || undefined,
      payload: { text: `e${i}`, date: d, endDate: span, time: r() < 0.6 ? pick(['07:00', '09:30', '09:30', '18:00']) : null, repeat: rep(), calendarId: pick(['c1', 'c2', 'gone']), ord: pick(['a', 'b', 'b', 'c']) },
    } as AnyRec);
  }
  for (let i = 0; i < 220; i++) {
    const due = r() < 0.25 ? null : day();
    recs.push({
      id: `r${i}`, type: 'reminder', updated: 0, deleted: r() < 0.05 || undefined,
      payload: { text: `r${i}`, due, time: r() < 0.4 ? pick(['08:00', '12:00']) : null, done: r() < 0.3, repeat: due ? rep() : null, folderId: pick(['fa', 'fb', 'fc', 'nope']), sectionId: 's', indent: 0, ord: pick(['a', 'b', 'c']) },
    } as AnyRec);
  }
  for (let i = 0; i < 80; i++) {
    recs.push({
      id: `n${i}`, type: 'note', updated: 0, deleted: r() < 0.05 || undefined,
      payload: { title: `n${i}`, body: '', date: r() < 0.5 ? day() : null, folderId: pick(['fn', 'fa']), ord: pick(['a', 'b']) },
    } as unknown as AnyRec);
  }
  return { recs, modes: { fa: pick<FolderMode>(['all', 'dated']), fc: pick<FolderMode>(['none', 'dated', 'all']) } };
}

describe('dayItemsRange equals dayItems for every date of the window', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`fuzzed records, seed ${seed}`, () => {
      const { recs, modes } = fuzzRecs(seed);
      const dates = [null, ...monthGridFilled(2026, 8), ...monthGridFilled(2026, 7).slice(0, 4), TODAY, null];
      for (const m of [undefined, modes]) {
        const win = dayItemsRange(recs, dates, TODAY, m);
        let busy = 0;
        for (const d of dates) {
          if (!d) continue;
          const want = dayItems(recs, d, TODAY, m);
          const got = win.get(d)!;
          expect(got.events.map((e) => e.id), `events ${d}`).toEqual(want.events.map((e) => e.id));
          expect(got.reminders.map((x) => [x.rec.id, x.overdue, x.rider, x.late]), `reminders ${d}`).toEqual(want.reminders.map((x) => [x.rec.id, x.overdue, x.rider, x.late]));
          expect(got.notes.map((n) => n.id), `notes ${d}`).toEqual(want.notes.map((n) => n.id));
          busy += want.events.length + want.reminders.length + want.notes.length;
        }
        expect(busy).toBeGreaterThan(50); // the fixture is not vacuous
      }
    });
  }

  it('a window that does not contain today still sees the dated rows and no riders', () => {
    const { recs, modes } = fuzzRecs(9);
    const dates = monthGridFilled(2027, 2);
    const win = dayItemsRange(recs, dates, TODAY, modes);
    for (const d of dates) {
      const want = dayItems(recs, d, TODAY, modes);
      expect(win.get(d)!.reminders.map((x) => x.rec.id)).toEqual(want.reminders.map((x) => x.rec.id));
      expect(win.get(d)!.events.map((x) => x.id)).toEqual(want.events.map((x) => x.id));
    }
  });

  it('lists a multi-day event once per day even where its repeats overlap', () => {
    const e = { id: 'x', type: 'event', updated: 0, payload: { text: 'x', date: '2026-08-01', endDate: '2026-08-05', time: null, repeat: { n: 2, unit: 'day' }, calendarId: 'c1', ord: 'a' } } as AnyRec;
    const win = dayItemsRange([e], ['2026-08-04', '2026-08-05', '2026-08-06'], TODAY);
    for (const d of ['2026-08-04', '2026-08-05', '2026-08-06']) expect(win.get(d)!.events.length).toBe(1);
    expect(win.get('2026-08-06')!.events.length).toBe(dayItems([e], '2026-08-06', TODAY).events.length);
  });

  it('answers an empty window and gives every real date an entry', () => {
    expect(dayItemsRange([], [], TODAY).size).toBe(0);
    expect(dayItemsRange([], [null, null], TODAY).size).toBe(0);
    expect([...dayItemsRange([], ['2026-08-01', null, '2026-08-01'], TODAY).keys()]).toEqual(['2026-08-01']);
  });
});

describe('the marks and the legend over a window equal their one-day forms', () => {
  it('cellMarksRange equals cellMarks for each date, with and without a shared window', () => {
    const { recs, modes } = fuzzRecs(11);
    const dates = monthGridFilled(2026, 8);
    const marks = cellMarksRange(recs, dates, TODAY, modes);
    const win = dayItemsRange(recs, dates, TODAY, modes);
    const marks2 = cellMarksRange(recs, dates, TODAY, modes, win);
    let nonEmpty = 0;
    for (const d of dates) {
      expect(marks.get(d), d).toEqual(cellMarks(recs, d, TODAY, modes));
      expect(marks2.get(d), d).toEqual(marks.get(d));
      if (cellMarks(recs, d, TODAY, modes).length) nonEmpty++;
    }
    expect(nonEmpty).toBeGreaterThan(10);
  });

  it('monthLegend equals the legend read off one dayItems call per date', () => {
    const { recs, modes } = fuzzRecs(12);
    const dates = [null, ...monthGridFilled(2026, 8)];
    for (const showDone of [false, true]) {
      const cals = new Set<string>(), rems = new Set<string>(), notes = new Set<string>();
      for (const d of dates) {
        if (!d) continue;
        const it = dayItems(recs, d, TODAY, modes);
        for (const e of it.events) cals.add(e.payload.calendarId);
        for (const x of it.reminders) if (showDone || !x.rec.payload.done) rems.add(x.rec.payload.folderId);
        for (const n of it.notes) notes.add(n.payload.folderId);
      }
      const got = monthLegend(recs, dates, TODAY, modes, showDone);
      expect(new Set(got.filter((x) => x.kind === 'event').map((x) => x.id))).toEqual(new Set([...cals].filter((id) => recs.some((r) => r.id === id && r.type === 'calendar'))));
      expect(new Set(got.filter((x) => x.kind === 'reminder').map((x) => x.id))).toEqual(new Set([...rems].filter((id) => recs.some((r) => r.id === id && r.type === 'folder'))));
      expect(new Set(got.filter((x) => x.kind === 'note').map((x) => x.id))).toEqual(new Set([...notes].filter((id) => recs.some((r) => r.id === id && r.type === 'folder'))));
      expect(got.length).toBeGreaterThan(0);
      const win = dayItemsRange(recs, dates, TODAY, modes);
      expect(monthLegend(recs, dates, TODAY, modes, showDone, win)).toEqual(got);
    }
  });
});
