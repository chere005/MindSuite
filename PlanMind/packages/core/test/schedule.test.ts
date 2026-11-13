import { describe, it, expect } from 'vitest';
import { CAPS, SCHEDULE_ROWS, type ListRecord, type ScheduleEvent, type Selection, type Settings } from '../src/model';
import { snapQuarter, clampEvent, findEventOverlap, freeStartNear, freeSpanNear, fitNewEntry, resizeEvent, resizeBoundary, slotStart, moveEvent, moveAim, stepAim, stepEvent, spanBox, timeLabel } from '../src/schedule';
import { resolveLanes } from '../src/selection';

const CAMP = '11111111-1111-4111-8111-111111111111';
const DAY = '2026-10-30';
let n = 0;
const ev = (owners: string[], start: number, length = 30, over: Partial<ScheduleEvent> = {}): ScheduleEvent => ({
  id: `e${++n}`, date: DAY, owners, text: 'x', start, length, ak: 'a', revision: 1,
  createdBy: 'alex', updatedBy: 'alex', createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z', ...over,
});
const h = (hour: number, minute = 0) => hour * 60 + minute;

describe('snapQuarter', () => {
  it('snaps to the nearest quarter-hour, halves up', () => {
    expect(snapQuarter(h(9))).toBe(h(9));
    expect(snapQuarter(h(9, 7))).toBe(h(9));
    expect(snapQuarter(h(9, 8))).toBe(h(9, 15));
    expect(snapQuarter(h(9, 22))).toBe(h(9, 15));
    expect(snapQuarter(h(9, 23))).toBe(h(9, 30));
    expect(snapQuarter(h(9, 52))).toBe(h(9, 45));
    expect(snapQuarter(h(9, 53))).toBe(h(10));
  });
  it('never returns negative zero', () => {
    expect(snapQuarter(-5)).toBe(0);
    expect(Object.is(snapQuarter(-5), 0)).toBe(true);
  });
});

describe('clampEvent', () => {
  it('defaults to half an hour when no length is given and keeps a valid span as it is', () => {
    expect(clampEvent(h(9))).toEqual({ start: h(9), length: 30 });
    expect(CAPS.eventDefaultLength).toBe(30);
    expect(clampEvent(h(9), 90)).toEqual({ start: h(9), length: 90 });
  });
  it('raises a short length to the minimum and snaps both to the grid', () => {
    expect(clampEvent(h(9), 0)).toEqual({ start: h(9), length: 30 });
    expect(clampEvent(h(9), 10)).toEqual({ start: h(9), length: 30 });
    expect(clampEvent(h(9), 15)).toEqual({ start: h(9), length: 30 });
    expect(clampEvent(h(9, 7), 40)).toEqual({ start: h(9), length: 45 });
  });
  it('keeps the whole span inside 7:00 to 7:00 the next morning', () => {
    expect(clampEvent(h(6), 60)).toEqual({ start: h(7), length: 60 });
    expect(clampEvent(0, 30)).toEqual({ start: h(7), length: 30 });
    expect(clampEvent(h(20, 45), 60)).toEqual({ start: h(20, 45), length: 60 });
    expect(clampEvent(h(30, 30), 60)).toEqual({ start: h(30), length: 60 });
    expect(clampEvent(h(31), 30)).toEqual({ start: h(30, 30), length: 30 });
    expect(clampEvent(h(31), 15)).toEqual({ start: h(30, 30), length: 30 });
    expect(clampEvent(h(30, 30), 30)).toEqual({ start: h(30, 30), length: 30 });
    expect(clampEvent(h(7), 30)).toEqual({ start: h(7), length: 30 });
    expect(clampEvent(h(12), 5000)).toEqual({ start: h(7), length: CAPS.eventEndMin - CAPS.eventStartMin });
  });
});

describe('findEventOverlap', () => {
  const nine = ev(['alex'], h(9), 60);
  it('treats spans as half-open: touching is fine, a shared minute is not', () => {
    const events = [nine];
    expect(findEventOverlap(events, DAY, ['alex'], h(8), 60)).toBeNull();
    expect(findEventOverlap(events, DAY, ['alex'], h(10), 30)).toBeNull();
    expect(findEventOverlap(events, DAY, ['alex'], h(8, 45), 30)).toBe(nine);
    expect(findEventOverlap(events, DAY, ['alex'], h(9, 45), 30)).toBe(nine);
    expect(findEventOverlap(events, DAY, ['alex'], h(9, 15), 30)).toBe(nine);
    expect(findEventOverlap(events, DAY, ['alex'], h(8), 180)).toBe(nine);
  });
  it('only collides inside a shared owner lane', () => {
    const events = [nine];
    expect(findEventOverlap(events, DAY, ['sam'], h(9), 60)).toBeNull();
    expect(findEventOverlap(events, DAY, [CAMP], h(9), 60)).toBeNull();
    expect(findEventOverlap(events, DAY, ['sam', 'alex'], h(9), 60)).toBe(nine);
    const linked = ev(['sam', 'alex'], h(14), 60);
    expect(findEventOverlap([linked], DAY, ['sam'], h(14), 30)).toBe(linked);
    expect(findEventOverlap([linked], DAY, ['alex'], h(14, 30), 30)).toBe(linked);
    expect(findEventOverlap([linked], DAY, [CAMP], h(14), 30)).toBeNull();
  });
  it('ignores other days and the ignored id', () => {
    expect(findEventOverlap([ev(['alex'], h(9), 60, { date: '2026-10-31' })], DAY, ['alex'], h(9), 60)).toBeNull();
    expect(findEventOverlap([nine], DAY, ['alex'], h(9), 60, nine.id)).toBeNull();
  });
  it('answers with the earliest of several overlaps, as the PHP rule does', () => {
    const late = ev(['alex'], h(11), 60), early = ev(['alex'], h(10), 30);
    expect(findEventOverlap([late, early], DAY, ['alex'], h(10), 120)).toBe(early);
  });
});

describe('freeStartNear', () => {
  it('returns the snapped start when that spot is free', () => {
    expect(freeStartNear([], DAY, ['alex'], h(9, 7), 60)).toBe(h(9));
    expect(freeStartNear([], DAY, ['alex'], h(9, 8), 60)).toBe(h(9, 15));
  });
  it('moves to the nearest free quarter-hour on either side', () => {
    const events = [ev(['alex'], h(9), 60)];
    expect(freeStartNear(events, DAY, ['alex'], h(9, 15), 30)).toBe(h(8, 30));
    expect(freeStartNear(events, DAY, ['alex'], h(9, 45), 30)).toBe(h(10));
    expect(freeStartNear(events, DAY, ['alex'], h(9, 30), 30)).toBe(h(10));
  });
  it('lets the moving event overlap its own old place and skips other lanes', () => {
    const mine = ev(['alex'], h(9), 60);
    expect(freeStartNear([mine], DAY, ['alex'], h(9, 15), 60, mine.id)).toBe(h(9, 15));
    expect(freeStartNear([ev(['sam'], h(9), 60)], DAY, ['alex'], h(9), 60)).toBe(h(9));
    expect(freeStartNear([ev(['sam'], h(9), 60)], DAY, ['sam', 'alex'], h(9), 60)).toBe(h(8));
  });
  it('stays inside the window and fits the whole length', () => {
    expect(freeStartNear([], DAY, ['alex'], h(5), 60)).toBe(h(7));
    expect(freeStartNear([], DAY, ['alex'], h(33), 60)).toBe(h(30));
    const blocked = [ev(['alex'], h(7), 120), ev(['alex'], h(10, 15), 60)];
    expect(freeStartNear(blocked, DAY, ['alex'], h(7), 60)).toBe(h(9));
  });
  it('fits the length it would really be given: a short or odd length is clamped before looking for room', () => {
    // The 30-minute minimum makes 7:30 the nearest start before the occupied 8:00 slot.
    expect(freeStartNear([ev(['alex'], h(8), 30)], DAY, ['alex'], h(7, 45), 10)).toBe(h(7, 30));
    expect(freeStartNear([ev(['alex'], h(8), 30)], DAY, ['alex'], h(8), 10)).toBe(h(7, 30));
    // Half an hour does not fit there: the nearest free start is 7:30.
    expect(freeStartNear([ev(['alex'], h(8), 30)], DAY, ['alex'], h(7, 45), 30)).toBe(h(7, 30));
    // A length longer than the whole window is the whole window, which an empty day has room for at the very start.
    expect(freeStartNear([], DAY, ['alex'], h(12), 2000)).toBe(h(7));
  });
  it('is null when no gap is long enough', () => {
    const fullDay = [ev(['alex'], h(7), 24 * 60)];
    expect(freeStartNear(fullDay, DAY, ['alex'], h(12), 30)).toBeNull();
    const gaps = [ev(['alex'], h(7), 120), ev(['alex'], h(9, 30), 21 * 60 + 30)];
    expect(freeStartNear(gaps, DAY, ['alex'], h(9), 60)).toBeNull();
    expect(freeStartNear(gaps, DAY, ['alex'], h(9), 30)).toBe(h(9));
  });
});

/** One lane's entry from `from` to `to` (minutes from midnight; the window is 7:00 to 31:00, 7:00 the next morning). */
const busy = (owners: string[], from: number, to: number) => ev(owners, from, to - from);
const END = h(31);

describe('freeSpanNear', () => {
  it('is half an hour at the nearest free start', () => {
    expect(freeSpanNear([], DAY, ['alex'], h(9, 15))).toEqual({ start: h(9, 15), length: 30 });
    // 9:00 to 9:30 is taken: the half hours that fit start at 8:30 or 9:30, and 9:30 is nearer to 9:15.
    expect(freeSpanNear([busy(['alex'], h(9), h(9, 30))], DAY, ['alex'], h(9, 15))).toEqual({ start: h(9, 30), length: 30 });
  });
  it('is the nearest half hour that is free in the lanes, never a shorter gap', () => {
    // Free: 7:00 to 7:30 and 12:00 to 12:30; the nearest half hour to 11:00 starts at 12:00.
    const halves = [busy(['alex'], h(7, 30), h(12)), busy(['alex'], h(12, 30), END)];
    expect(freeSpanNear(halves, DAY, ['alex'], h(11))).toEqual({ start: h(12), length: 30 });
    const quarters = [busy(['alex'], h(7), h(12)), busy(['alex'], h(12, 15), END)];
    expect(freeSpanNear(quarters, DAY, ['alex'], h(9))).toBeNull();
  });
  it('is null when the lanes have no room at all', () => {
    expect(freeSpanNear([busy(['alex'], h(7), END)], DAY, ['alex'], h(12))).toBeNull();
  });
});

describe('fitNewEntry', () => {
  it('is half an hour from the pointer\'s half hour when the free stretch around it holds one', () => {
    expect(fitNewEntry([], DAY, ['alex'], h(9))).toEqual({ start: h(9), length: 30 });
    expect(fitNewEntry([], DAY, ['alex'], h(9, 45))).toEqual({ start: h(9, 30), length: 30 });
    // A half hour from 9:30 ends where the next entry starts: it fits exactly.
    expect(fitNewEntry([busy(['alex'], h(10), h(11))], DAY, ['alex'], h(9, 30))).toEqual({ start: h(9, 30), length: 30 });
  });
  it('starts earlier, only as far as it takes, when the pointer is too near the end of the stretch', () => {
    // A stretch of 45 minutes: from the pointer, or earlier when the pointer is too near the end.
    const threeQuarters = [busy(['alex'], h(7), h(19, 15)), busy(['alex'], h(20), END)];
    expect(fitNewEntry(threeQuarters, DAY, ['alex'], h(19, 15))).toEqual({ start: h(19, 15), length: 30 });
    expect(fitNewEntry(threeQuarters, DAY, ['alex'], h(19, 30))).toEqual({ start: h(19, 30), length: 30 });
    expect(fitNewEntry(threeQuarters, DAY, ['alex'], h(19, 45))).toEqual({ start: h(19, 30), length: 30 });
    // Never before the stretch begins: here the stretch is exactly the half hour from 9:00.
    const exact = [busy(['alex'], h(7), h(9)), busy(['alex'], h(9, 30), END)];
    expect(fitNewEntry(exact, DAY, ['alex'], h(9, 15))).toEqual({ start: h(9), length: 30 });
  });
  it('has no landing in a gap shorter than a half hour', () => {
    expect(fitNewEntry([busy(['alex'], h(7), h(19)), busy(['alex'], h(19, 30), h(20, 30))], DAY, ['alex'], h(19))).toEqual({ start: h(19), length: 30 });
    expect(fitNewEntry([busy(['alex'], h(7), h(19)), busy(['alex'], h(19, 15), h(20, 15))], DAY, ['alex'], h(19))).toBeNull();
  });
  it('starts 15 minutes earlier when the pointer is in the last quarter of a 30-minute gap', () => {
    const gap = [busy(['alex'], h(7), h(19)), busy(['alex'], h(19, 30), h(20, 30))];
    expect(fitNewEntry(gap, DAY, ['alex'], h(19, 15))).toEqual({ start: h(19), length: 30 });
    expect(fitNewEntry(gap, DAY, ['alex'], h(19))).toEqual({ start: h(19), length: 30 });
  });
  it('is Alex\'s screenshot: both lanes are free from 7:30p to 8p, so a pointer at 7:35p gets that half hour for both', () => {
    const day = [
      busy(['sam'], h(8, 30), h(16, 30)), busy(['alex'], h(13, 30), h(18, 45)), busy(['sam', 'alex'], h(18, 45), h(19, 30)), busy(['alex'], h(20), h(21)),
    ];
    expect(fitNewEntry(day, DAY, ['sam', 'alex'], slotStart(12, 35 / 60))).toEqual({ start: h(19, 30), length: 30 });
    // Alex is busy from 7:45p instead: the quarter hour that is left.
    const later = [...day.slice(0, 3), busy(['alex'], h(19, 45), h(21))];
    expect(fitNewEntry(later, DAY, ['sam', 'alex'], h(19, 30))).toBeNull();
  });
  it('looks at every lane the entry is for, and only those', () => {
    const samLater = busy(['sam'], h(10), h(11));
    expect(fitNewEntry([samLater], DAY, ['alex'], h(9, 45))).toEqual({ start: h(9, 30), length: 30 });
    expect(fitNewEntry([samLater], DAY, ['sam', 'alex'], h(9, 45))).toEqual({ start: h(9, 30), length: 30 });
    // Alex is in 8:00 to 8:15 and Sam from 8:30: the stretch for both is the quarter hour between, for Alex alone it is the rest of the day.
    const apart = [busy(['alex'], h(8), h(8, 15)), busy(['sam'], h(8, 30), h(9, 30))];
    expect(fitNewEntry(apart, DAY, ['sam', 'alex'], h(8, 15))).toBeNull();
    expect(fitNewEntry(apart, DAY, ['alex'], h(8, 15))).toEqual({ start: h(8, 15), length: 30 });
    expect(fitNewEntry(apart, DAY, ['sam'], h(8, 15))).toEqual({ start: h(8), length: 30 });
  });
  it('is the nearest free start when the pointer\'s quarter is taken in one of the lanes', () => {
    // Sam is in 9:00 to 10:00, Alex is not. The half hours that fit start at 8:30 or 10:00.
    const sam = busy(['sam'], h(9), h(10));
    expect(fitNewEntry([sam], DAY, ['sam', 'alex'], h(9, 15))).toEqual({ start: h(8, 30), length: 30 });
    expect(fitNewEntry([sam], DAY, ['sam', 'alex'], h(9, 45))).toEqual({ start: h(10), length: 30 });
    expect(fitNewEntry([sam], DAY, ['sam', 'alex'], h(9, 0))).toEqual({ start: h(8, 30), length: 30 });
    expect(fitNewEntry([sam], DAY, ['alex'], h(9, 15))).toEqual({ start: h(9), length: 30 });
    // A quarter-hour gap cannot fit a new appointment.
    const halves = [busy(['alex'], h(7), h(12)), busy(['alex'], h(12, 30), END)];
    expect(fitNewEntry(halves, DAY, ['alex'], h(9))).toEqual({ start: h(12), length: 30 });
    const quarters = [busy(['alex'], h(7), h(12)), busy(['alex'], h(12, 15), END)];
    expect(fitNewEntry(quarters, DAY, ['alex'], h(9))).toBeNull();
    expect(fitNewEntry([busy(['alex'], h(7), END)], DAY, ['alex'], h(9))).toBeNull();
  });
  it('is walled by events a caller adds: the shown half of the day gives neither a start nor an end outside it', () => {
    // AM page: 9p to 7a is a wall. Alex is booked until 8:45p, so no appointment fits at the end of AM.
    const night = busy(['alex'], h(21), END);
    expect(fitNewEntry([busy(['alex'], h(7), h(20, 45)), night], DAY, ['alex'], h(20, 45))).toBeNull();
    expect(fitNewEntry([night], DAY, ['alex'], h(20, 45))).toEqual({ start: h(20, 30), length: 30 });
    // PM page: 7a to 9p is a wall; a pointer in the last row gives the half hour that ends at 7a.
    const day = busy(['alex'], h(7), h(21));
    expect(fitNewEntry([day], DAY, ['alex'], h(30, 45))).toEqual({ start: h(30, 30), length: 30 });
    expect(fitNewEntry([day], DAY, ['alex'], h(21))).toEqual({ start: h(21), length: 30 });
    expect(fitNewEntry([day, busy(['alex'], h(22), END)], DAY, ['alex'], h(21, 45))).toEqual({ start: h(21, 30), length: 30 });
    expect(fitNewEntry([day, busy(['alex'], h(21, 30), END)], DAY, ['alex'], h(21, 15))).toEqual({ start: h(21), length: 30 });
  });
  it('keeps a pointer outside the window inside it, and ignores other days', () => {
    expect(fitNewEntry([], DAY, ['alex'], h(5))).toEqual({ start: h(7), length: 30 });
    expect(fitNewEntry([], DAY, ['alex'], h(40))).toEqual({ start: h(30, 30), length: 30 });
    expect(fitNewEntry([ev(['alex'], h(9), 60, { date: '2026-10-31' })], DAY, ['alex'], h(9))).toEqual({ start: h(9), length: 30 });
  });
});

describe('resizeEvent', () => {
  const mid = ev(['alex'], h(10), 60);
  it('moves the start edge and keeps the end', () => {
    expect(resizeEvent([mid], mid, 'start', h(9))).toEqual({ start: h(9), length: 120 });
    expect(resizeEvent([mid], mid, 'start', h(10, 15))).toEqual({ start: h(10, 15), length: 45 });
  });
  it('moves the end edge and keeps the start', () => {
    expect(resizeEvent([mid], mid, 'end', h(12))).toEqual({ start: h(10), length: 120 });
    expect(resizeEvent([mid], mid, 'end', h(10, 45))).toEqual({ start: h(10), length: 45 });
  });
  it('snaps a free-form target to the grid', () => {
    expect(resizeEvent([mid], mid, 'end', h(11, 52))).toEqual({ start: h(10), length: 105 });
    expect(resizeEvent([mid], mid, 'end', h(11, 53))).toEqual({ start: h(10), length: 120 });
    expect(resizeEvent([mid], mid, 'start', h(9, 21))).toEqual({ start: h(9, 15), length: 105 });
    expect(resizeEvent([mid], mid, 'start', h(9, 23))).toEqual({ start: h(9, 30), length: 90 });
  });
  it('keeps the 30-minute minimum from either edge', () => {
    expect(resizeEvent([mid], mid, 'end', h(10))).toEqual({ start: h(10), length: 30 });
    expect(resizeEvent([mid], mid, 'end', h(3))).toEqual({ start: h(10), length: 30 });
    expect(resizeEvent([mid], mid, 'end', h(10, 20))).toEqual({ start: h(10), length: 30 });
    expect(resizeEvent([mid], mid, 'end', h(10, 30))).toEqual({ start: h(10), length: 30 });
    expect(resizeEvent([mid], mid, 'start', h(11))).toEqual({ start: h(10, 30), length: 30 });
    expect(resizeEvent([mid], mid, 'start', h(15))).toEqual({ start: h(10, 30), length: 30 });
    expect(resizeEvent([mid], mid, 'start', h(10, 30))).toEqual({ start: h(10, 30), length: 30 });
  });
  it('stops at the window edges', () => {
    expect(resizeEvent([mid], mid, 'start', h(2))).toEqual({ start: h(7), length: 240 });
    expect(resizeEvent([mid], mid, 'end', h(40))).toEqual({ start: h(10), length: 21 * 60 });
  });
  it('stops at a neighbour in its own lane and may touch it', () => {
    const before = ev(['alex'], h(8), 60), after = ev(['alex'], h(12), 60);
    const events = [before, mid, after];
    expect(resizeEvent(events, mid, 'start', h(7))).toEqual({ start: h(9), length: 120 });
    expect(resizeEvent(events, mid, 'end', h(15))).toEqual({ start: h(10), length: 120 });
    expect(resizeEvent(events, mid, 'end', h(11, 45))).toEqual({ start: h(10), length: 105 });
  });
  it('a neighbour that ends where the event starts, or starts where it ends, holds the handle in place', () => {
    const before = ev(['alex'], h(9), 60), after = ev(['alex'], h(11), 60);
    expect(resizeEvent([before, mid, after], mid, 'start', h(8))).toEqual({ start: h(10), length: 60 });
    expect(resizeEvent([before, mid, after], mid, 'end', h(13))).toEqual({ start: h(10), length: 60 });
    expect(resizeEvent([before, mid], mid, 'start', h(9, 30))).toEqual({ start: h(10), length: 60 });
    expect(resizeEvent([mid, after], mid, 'end', h(11, 30))).toEqual({ start: h(10), length: 60 });
    // and a handle may still shrink away from the neighbour it touches
    expect(resizeEvent([before, mid, after], mid, 'start', h(10, 15))).toEqual({ start: h(10, 15), length: 45 });
    expect(resizeEvent([before, mid, after], mid, 'end', h(10, 45))).toEqual({ start: h(10), length: 45 });
  });
  it('a linked event stops at a neighbour in either of its lanes', () => {
    const linked = ev(['sam', 'alex'], h(10), 60);
    const samBefore = ev(['sam'], h(8), 90), alexAfter = ev(['alex'], h(11, 30), 30);
    const events = [samBefore, linked, alexAfter];
    expect(resizeEvent(events, linked, 'start', h(7))).toEqual({ start: h(9, 30), length: 90 });
    expect(resizeEvent(events, linked, 'end', h(14))).toEqual({ start: h(10), length: 90 });
  });
  it('ignores other lanes, other days and itself', () => {
    const events = [ev(['sam'], h(8), 120), ev(['alex'], h(12), 60, { date: '2026-10-31' }), ev([CAMP], h(11), 60), mid];
    expect(resizeEvent(events, mid, 'start', h(7))).toEqual({ start: h(7), length: 240 });
    expect(resizeEvent(events, mid, 'end', h(14))).toEqual({ start: h(10), length: 240 });
  });
});

describe('resizeBoundary', () => {
  it('moves a shared boundary later and earlier: the first entry ends where the second now starts', () => {
    const a = ev(['alex'], h(9), 60), b = ev(['alex'], h(10), 60);
    expect(resizeBoundary([a, b], a, 'end', h(10, 30))).toEqual({ start: h(9), length: 90, linked: [{ id: b.id, start: h(10, 30), length: 30 }] });
    expect(resizeBoundary([a, b], a, 'end', h(9, 30))).toEqual({ start: h(9), length: 30, linked: [{ id: b.id, start: h(9, 30), length: 90 }] });
    // The same boundary held from the second entry's start handle.
    expect(resizeBoundary([a, b], b, 'start', h(9, 45))).toEqual({ start: h(9, 45), length: 75, linked: [{ id: a.id, start: h(9), length: 45 }] });
  });
  it('keeps the minimum length on both sides of the boundary', () => {
    const a = ev(['alex'], h(9), 60), b = ev(['alex'], h(10), 60);
    expect(resizeBoundary([a, b], a, 'end', h(13))).toEqual({ start: h(9), length: 90, linked: [{ id: b.id, start: h(10, 30), length: 30 }] });
    expect(resizeBoundary([a, b], a, 'end', h(7))).toEqual({ start: h(9), length: 30, linked: [{ id: b.id, start: h(9, 30), length: 90 }] });
    expect(resizeBoundary([a, b], b, 'start', h(7))).toEqual({ start: h(9, 30), length: 90, linked: [{ id: a.id, start: h(9), length: 30 }] });
  });
  it('snaps to the quarter hour', () => {
    const a = ev(['alex'], h(9), 60), b = ev(['alex'], h(10), 60);
    expect(resizeBoundary([a, b], a, 'end', h(10, 8))).toMatchObject({ length: 75, linked: [{ start: h(10, 15), length: 45 }] });
  });
  it('is a plain resize when the edge borders nothing, or borders an entry in another lane only', () => {
    const a = ev(['alex'], h(9), 60), gap = ev(['alex'], h(10, 15), 60), other = ev(['sam'], h(10), 60);
    expect(resizeBoundary([a, gap, other], a, 'end', h(11))).toEqual({ start: h(9), length: 75, linked: [] });
    expect(resizeBoundary([a, other], a, 'end', h(9, 30))).toEqual({ start: h(9), length: 30, linked: [] });
  });
  it('a growing entry stops at its own other neighbours, in lanes the dragged entry is not in', () => {
    // Alex's 9-10 borders Both's 10-11; Sam has 9:30-10, so Both cannot grow back past 10 at all.
    const a = ev(['alex'], h(9), 60), both = ev(['sam', 'alex'], h(10), 60), sam = ev(['sam'], h(9, 30), 30);
    expect(resizeBoundary([a, both, sam], a, 'end', h(9, 15))).toEqual({ start: h(9), length: 60, linked: [{ id: both.id, start: h(10), length: 60 }] });
    expect(resizeBoundary([a, both, sam], a, 'end', h(10, 30))).toEqual({ start: h(9), length: 90, linked: [{ id: both.id, start: h(10, 30), length: 30 }] });
    // And the dragged entry stops at an entry beyond a neighbour in another of its lanes.
    const tall = ev(['sam', 'alex'], h(8), 60), s2 = ev(['alex'], h(9), 120), a2 = ev(['sam'], h(9, 30), 60);
    expect(resizeBoundary([tall, s2, a2], tall, 'end', h(10, 30))).toEqual({ start: h(8), length: 90, linked: [{ id: s2.id, start: h(9, 30), length: 90 }] });
  });
  it('moves every entry that borders the edge in the dragged entry\'s lanes', () => {
    const both = ev(['sam', 'alex'], h(9), 60), s = ev(['alex'], h(10), 45), a = ev(['sam'], h(10), 60);
    expect(resizeBoundary([both, s, a], both, 'end', h(11))).toEqual({
      start: h(9), length: 75, linked: [{ id: s.id, start: h(10, 15), length: 30 }, { id: a.id, start: h(10, 15), length: 45 }],
    });
  });
  it('stops at the window', () => {
    const a = ev(['alex'], CAPS.eventEndMin - 60, 30), b = ev(['alex'], CAPS.eventEndMin - 30, 30);
    expect(resizeBoundary([a, b], b, 'end', CAPS.eventEndMin + 60)).toEqual({ start: CAPS.eventEndMin - 30, length: 30, linked: [] });
    expect(resizeBoundary([a, b], a, 'start', h(1))).toEqual({ start: h(7), length: CAPS.eventEndMin - 30 - h(7), linked: [] });
  });
});

describe('slotStart', () => {
  it('retains the pointed quarter for overlap and short-gap detection', () => {
    expect([0, 0.2, 0.249].map(f => slotStart(2, f))).toEqual([h(9), h(9), h(9)]);
    expect([0.25, 0.3, 0.499].map(f => slotStart(2, f))).toEqual([h(9, 15), h(9, 15), h(9, 15)]);
    expect([0.5, 0.6, 0.749].map(f => slotStart(2, f))).toEqual([h(9, 30), h(9, 30), h(9, 30)]);
    expect([0.75, 0.9, 0.999].map(f => slotStart(2, f))).toEqual([h(9, 45), h(9, 45), h(9, 45)]);
  });
  it('the row index counts from the 7a row, the first and the last row included', () => {
    expect(slotStart(0, 0)).toBe(CAPS.eventStartMin);
    expect(slotStart(0, 0.8)).toBe(h(7, 45));
    expect(slotStart(13, 0.8)).toBe(h(20, 45));
  });
  it('a fraction outside 0..1 (a tap on the border) stays inside the row', () => {
    expect(slotStart(3, -0.2)).toBe(h(10));
    expect(slotStart(3, 1)).toBe(h(10, 45));
    expect(slotStart(3, 7)).toBe(h(10, 45));
  });
  it('resolves to a quarter-hour position', () => {
    for (let hour = 0; hour < 14; hour++) for (let step = 0; step <= 100; step++) expect(slotStart(hour, step / 100) % CAPS.eventStep).toBe(0);
  });
});

describe('moveEvent', () => {
  const mine = ev(['alex'], h(10), 60);
  it('lands on the target snapped to the grid', () => {
    expect(moveEvent([mine], mine, h(12))).toBe(h(12));
    expect(moveEvent([mine], mine, h(12, 7))).toBe(h(12));
    expect(moveEvent([mine], mine, h(12, 8))).toBe(h(12, 15));
  });
  it('may overlap its own old place', () => {
    expect(moveEvent([mine], mine, h(10, 15))).toBe(h(10, 15));
    expect(moveEvent([mine], mine, h(9, 30))).toBe(h(9, 30));
  });
  it('keeps the whole event inside 7:00 to 7:00 the next morning', () => {
    expect(moveEvent([mine], mine, h(3))).toBe(h(7));
    expect(moveEvent([mine], mine, h(40))).toBe(h(30));
  });
  it('lands on the nearest free quarter-hour when the target is taken', () => {
    const other = ev(['alex'], h(12), 60);
    // A 60-minute event needs 11:00 or earlier, or 13:00 or later; half way between, the earlier one wins.
    expect(moveEvent([mine, other], mine, h(12, 15))).toBe(h(13));
    expect(moveEvent([mine, other], mine, h(12, 45))).toBe(h(13));
    expect(moveEvent([mine, other], mine, h(12))).toBe(h(11));
    expect(moveEvent([mine, other], mine, h(11, 30))).toBe(h(11));
  });
  it('only a neighbour in one of its own lanes blocks it', () => {
    const sams = ev(['sam'], h(12), 60);
    expect(moveEvent([mine, sams], mine, h(12))).toBe(h(12));
    const linked = ev(['sam', 'alex'], h(10), 60);
    expect(moveEvent([linked, sams], linked, h(12, 30))).toBe(h(13));
    // A linked event is blocked from either of its lanes, the second owner's as much as the first's.
    const alexs = ev(['alex'], h(12), 60);
    expect(moveEvent([linked, alexs], linked, h(12, 30))).toBe(h(13));
    expect(moveEvent([linked, alexs], linked, h(12))).toBe(h(11));
  });
  it('never changes the length and stays where it is when the day has no other room', () => {
    const long = ev(['alex'], h(8), 120);
    expect(moveEvent([long, ev(['alex'], h(12), 30)], long, h(12))).toBe(h(12, 30));
    const wall = ev(['alex'], h(7), 7 * 60), small = ev(['alex'], h(14), 7 * 60);
    expect(moveEvent([wall, small], small, h(9))).toBe(h(14));
  });
});

describe('moveEvent with owners (a drag across Alex / Both / Sam)', () => {
  it('the start is free in the lanes it will have, not in the ones it leaves', () => {
    const mine = ev(['alex'], h(10), 60), sams = ev(['sam'], h(12), 60), alexs = ev(['alex'], h(14), 60);
    // Still Alex's, 12:00 is free; as Sam's it is taken, so the nearest free start for her is 13:00 (or 11:00, which is as near: the earlier wins).
    expect(moveEvent([mine, sams], mine, h(12))).toBe(h(12));
    expect(moveEvent([mine, sams], mine, h(12), ['sam'])).toBe(h(11));
    expect(moveEvent([mine, sams], mine, h(12, 15), ['sam'])).toBe(h(13));
    // Alex's own later entry does not matter once it is Sam's.
    expect(moveEvent([mine, alexs], mine, h(14), ['sam'])).toBe(h(14));
  });
  it('a linked entry needs both lanes free', () => {
    // Sam is busy 12-1 and Alex 1-2: neither lane alone blocks 1p for the other, but together they block 12 to 2.
    const mine = ev(['alex'], h(10), 60), sams = ev(['sam'], h(12), 60), alexs = ev(['alex'], h(13), 60);
    expect(moveEvent([mine, sams, alexs], mine, h(12), ['sam', 'alex'])).toBe(h(11));
    expect(moveEvent([mine, sams, alexs], mine, h(13), ['sam', 'alex'])).toBe(h(14));
    expect(moveEvent([mine, sams, alexs], mine, h(12, 30), ['sam', 'alex'])).toBe(h(11));
    // One lane at a time each finds the room the other lacks.
    expect(moveEvent([mine, sams, alexs], mine, h(13), ['sam'])).toBe(h(13));
    expect(moveEvent([mine, sams, alexs], mine, h(12), ['alex'])).toBe(h(12));
  });
  it('a linked entry that becomes one person\'s needs only that lane', () => {
    const linked = ev(['sam', 'alex'], h(10), 60), sams = ev(['sam'], h(12), 60);
    expect(moveEvent([linked, sams], linked, h(12), ['alex'])).toBe(h(12));
    expect(moveEvent([linked, sams], linked, h(12), ['sam'])).toBe(h(11));
  });
  it('its own old place counts as free in every lane it keeps, and the length never changes', () => {
    const linked = ev(['sam', 'alex'], h(10), 60);
    expect(moveEvent([linked], linked, h(10, 15), ['alex'])).toBe(h(10, 15));
    expect(moveEvent([linked], linked, h(10), ['sam', 'alex'])).toBe(h(10));
  });
  it('null when no start is free in those lanes', () => {
    const mine = ev(['alex'], h(8), 120);
    const walls = [ev(['sam'], h(7), 7 * 60), ev(['sam'], h(14), 7 * 60), ev(['sam'], h(21), 10 * 60)];
    // Sam's day has no two free hours anywhere; Alex's own is free.
    expect(moveEvent([mine, ...walls], mine, h(9), ['sam'])).toBeNull();
    expect(moveEvent([mine, ...walls], mine, h(9), ['sam', 'alex'])).toBeNull();
    expect(moveEvent([mine, ...walls], mine, h(9))).toBe(h(9));
  });
});

describe('moveAim and stepAim', () => {
  const CAMP = '11111111-1111-4111-8111-111111111111';
  const stamp = { revision: 1, updatedAt: '2026-10-30T00:00:00Z' };
  const lists: ListRecord[] = [
    { id: 'sam', kind: 'person', name: 'Sam', color: 'yellow', order: 0, ...stamp },
    { id: 'alex', kind: 'person', name: 'Alex', color: 'green', order: 1, ...stamp },
    { id: CAMP, kind: 'custom', name: 'Camping', color: 'blue', order: 2, ...stamp },
  ];
  const settings: Settings = { bothColor: 'purple', revision: 1, updatedAt: '2026-10-30T00:00:00Z' };
  const sel = (base: string, ...overlays: string[]): Selection => ({ base, overlays });
  const aim = (s: Selection, owners: string[], across: number, me: 'alex' | 'sam' = 'alex') => moveAim(s, lists, settings, resolveLanes(s, lists, me), owners, across);
  const step = (s: Selection, owners: string[], direction: -1 | 1, me: 'alex' | 'sam' = 'alex') => stepAim(s, lists, settings, resolveLanes(s, lists, me), owners, direction);

  it('in the Both view with the two lanes, the thirds decide: the left lane (the signed-in person), both, the right lane', () => {
    expect(aim(sel('both'), ['sam'], 0.1)).toEqual({ side: 'left', owners: ['alex'], color: 'green' });
    expect(aim(sel('both'), ['alex'], 0.5)).toEqual({ side: 'both', owners: ['alex', 'sam'], color: 'purple' });
    expect(aim(sel('both'), ['alex'], 0.9)).toEqual({ side: 'right', owners: ['sam'], color: 'yellow' });
    // The edges of the middle third: one third in, two thirds out.
    expect(aim(sel('both'), ['alex'], 1 / 3).side).toBe('both');
    expect(aim(sel('both'), ['alex'], 2 / 3).side).toBe('right');
    expect(aim(sel('both'), ['alex'], 0.3333).side).toBe('left');
    // A pointer past the grid is still the nearest third.
    expect(aim(sel('both'), ['alex'], -0.4).side).toBe('left');
    expect(aim(sel('both'), ['alex'], 1.6).side).toBe('right');
  });
  it('the left lane is the signed-in person, so for Sam the thirds read Sam, both, Alex', () => {
    expect(aim(sel('both'), ['alex'], 0.1, 'sam').owners).toEqual(['sam']);
    expect(aim(sel('both'), ['alex'], 0.9, 'sam').owners).toEqual(['alex']);
  });
  it('anywhere else a drag never changes who an entry is for, whatever the pointer does', () => {
    for (const across of [0, 0.2, 0.5, 0.8, 1, 3]) {
      expect(aim(sel('alex'), ['alex'], across)).toEqual({ side: 'only', owners: ['alex'], color: 'green' });
      expect(aim(sel('sam'), ['sam'], across)).toEqual({ side: 'only', owners: ['sam'], color: 'yellow' });
      expect(aim(sel(CAMP), [CAMP], across)).toEqual({ side: 'only', owners: [CAMP], color: 'blue' });
      // A custom list on top of Both makes three lanes: no thirds, and a linked entry stays linked.
      expect(aim(sel('both', CAMP), ['alex', 'sam'], across)).toEqual({ side: 'only', owners: ['alex', 'sam'], color: 'purple' });
      expect(aim(sel('both', CAMP), ['sam'], across)).toEqual({ side: 'only', owners: ['sam'], color: 'yellow' });
      // One list with a custom list on top: still the entry's own owners (the overlay's entries are not Alex's to give away).
      expect(aim(sel('alex', CAMP), [CAMP], across).owners).toEqual([CAMP]);
    }
  });
  it('the keyboard goes one third at a time and stops at the ends', () => {
    expect(step(sel('both'), ['alex'], 1)).toEqual({ side: 'both', owners: ['alex', 'sam'], color: 'purple' });
    expect(step(sel('both'), ['sam', 'alex'], 1)).toEqual({ side: 'right', owners: ['sam'], color: 'yellow' });
    expect(step(sel('both'), ['sam'], 1)).toBeNull();
    expect(step(sel('both'), ['sam'], -1)).toEqual({ side: 'both', owners: ['alex', 'sam'], color: 'purple' });
    expect(step(sel('both'), ['sam', 'alex'], -1)).toEqual({ side: 'left', owners: ['alex'], color: 'green' });
    expect(step(sel('both'), ['alex'], -1)).toBeNull();
    // For Sam the left lane is hers.
    expect(step(sel('both'), ['sam'], -1, 'sam')).toBeNull();
    expect(step(sel('both'), ['sam'], 1, 'sam')).toEqual({ side: 'both', owners: ['alex', 'sam'], color: 'purple' });
  });
  it('the keyboard has no thirds outside the Both view, and none for an entry that is not one of the three', () => {
    expect(step(sel('alex'), ['alex'], 1)).toBeNull();
    expect(step(sel('both', CAMP), ['alex'], 1)).toBeNull();
    expect(step(sel('both'), [CAMP], 1)).toBeNull();
  });
});

describe('stepEvent', () => {
  const mid = ev(['alex'], h(10), 60);
  it('moves one quarter hour either way', () => {
    expect(stepEvent([mid], mid, 1)).toEqual({ ok: true, start: h(10, 15) });
    expect(stepEvent([mid], mid, -1)).toEqual({ ok: true, start: h(9, 45) });
  });
  it('stops at the edges of the window', () => {
    const first = ev(['alex'], h(7), 30), last = ev(['alex'], h(30, 30), 30);
    expect(stepEvent([first], first, -1)).toEqual({ ok: false, reason: 'window' });
    expect(stepEvent([first], first, 1)).toEqual({ ok: true, start: h(7, 15) });
    expect(stepEvent([last], last, 1)).toEqual({ ok: false, reason: 'window' });
    expect(stepEvent([last], last, -1)).toEqual({ ok: true, start: h(30, 15) });
  });
  it('may land exactly on 7:00 and end exactly at 9:00p', () => {
    const early = ev(['alex'], h(7, 15), 30), late = ev(['alex'], h(20, 15), 30);
    expect(stepEvent([early], early, -1)).toEqual({ ok: true, start: h(7) });
    expect(stepEvent([late], late, 1)).toEqual({ ok: true, start: h(20, 30) });
  });
  it('names the neighbour that blocks it, in any lane it occupies, and never jumps over it', () => {
    const after = ev(['alex'], h(11), 30), before = ev(['alex'], h(9), 60);
    expect(stepEvent([mid, after], mid, 1)).toEqual({ ok: false, reason: 'overlap', with: after });
    expect(stepEvent([mid, before], mid, -1)).toEqual({ ok: false, reason: 'overlap', with: before });
    expect(stepEvent([mid, after], mid, -1)).toEqual({ ok: true, start: h(9, 45) });
    const linked = ev(['sam', 'alex'], h(10), 60), sams = ev(['sam'], h(11), 30);
    expect(stepEvent([linked, sams], linked, 1)).toEqual({ ok: false, reason: 'overlap', with: sams });
    expect(stepEvent([mid, ev(['sam'], h(11), 30)], mid, 1)).toEqual({ ok: true, start: h(10, 15) });
    // Either lane of a linked event blocks it: Alex's is the second owner here.
    const alexs = ev(['alex'], h(11), 30), touching = ev(['alex'], h(9), 45), over = ev(['alex'], h(9), 60);
    expect(stepEvent([linked, alexs], linked, 1)).toEqual({ ok: false, reason: 'overlap', with: alexs });
    expect(stepEvent([linked, touching], linked, -1)).toEqual({ ok: true, start: h(9, 45) });
    expect(stepEvent([linked, over], linked, -1)).toEqual({ ok: false, reason: 'overlap', with: over });
  });
});

describe('timeLabel', () => {
  it('matches the schedule row labels on the hour', () => {
    SCHEDULE_ROWS.forEach((label, i) => expect(timeLabel(CAPS.eventStartMin + i * 60)).toBe(label));
  });
  it('shows minutes only when there are some', () => {
    expect(timeLabel(h(9, 15))).toBe('9:15a');
    expect(timeLabel(h(9, 5))).toBe('9:05a');
    expect(timeLabel(h(12, 15))).toBe('12:15p');
    expect(timeLabel(h(13, 45))).toBe('1:45p');
    expect(timeLabel(h(11, 45))).toBe('11:45a');
  });
  it('handles noon, midnight and the end of the window', () => {
    expect(timeLabel(h(12))).toBe('12p');
    expect(timeLabel(0)).toBe('12a');
    expect(timeLabel(CAPS.eventEndMin)).toBe('7a');
    expect(timeLabel(h(21))).toBe('9p');
    expect(timeLabel(h(26))).toBe('2a');
    expect(timeLabel(h(24))).toBe('12a');
    expect(timeLabel(-60)).toBe('11p');
  });
});

describe('spanBox: one place on the grid for the planner\'s entries and CalMind\'s events', () => {
  const AM = { from: 420, to: 1260, span: 840 }, PM = { from: 1260, to: 1860, span: 840 };
  it('puts a span on the quarter-hour rows and as fractions of the window', () => {
    expect(spanBox(600, 60, AM)).toEqual({ y: 180 / 840, h: 60 / 840, q: 13, n: 4, clip: '' });
    expect(spanBox(420, 15, AM)).toEqual({ y: 0, h: 15 / 840, q: 1, n: 1, clip: '' });
  });
  it('keeps the rows and fractions in step: y * span / step + 1 is the row, even off the quarter hour (CalMind\'s times)', () => {
    for (const start of [420, 435, 470, 555, 1000]) {
      const b = spanBox(start, 50, AM)!;
      expect(b.q).toBeCloseTo((b.y * AM.span) / 15 + 1, 9);
      expect(b.n).toBeCloseTo((b.h * AM.span) / 15, 9);
    }
  });
  it('cuts a span at the window edges and names the cut ends', () => {
    expect(spanBox(360, 90, AM)).toEqual({ y: 0, h: 30 / 840, q: 1, n: 2, clip: 'top' });
    expect(spanBox(1230, 60, AM)).toEqual({ y: 810 / 840, h: 30 / 840, q: 55, n: 2, clip: 'bottom' });
    expect(spanBox(1230, 60, PM)).toEqual({ y: 0, h: 30 / 840, q: 1, n: 2, clip: 'top' });
    expect(spanBox(400, 900, AM)).toMatchObject({ clip: 'top bottom', y: 0, h: 1 });
  });
  it('is null when none of the span is in the window, and treats the 7a boundary as the planner day\'s end', () => {
    expect(spanBox(1260, 30, AM)).toBeNull();
    expect(spanBox(1230, 30, AM)!.clip).toBe('');
    expect(spanBox(360, 60, AM)).toBeNull();
    expect(spanBox(1830, 30, PM)).toMatchObject({ clip: '', q: 39, n: 2 });
    expect(spanBox(1860, 30, PM)).toBeNull();
    expect(spanBox(600, 0, AM)).toBeNull();
  });
});
