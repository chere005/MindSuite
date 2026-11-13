import { describe, it, expect } from 'vitest';
import { grabShifts } from './EventHandles';

// Pure geometry, in client pixels: where the grab area of each handle of an entry being edited stands (no DOM).
const ROOM = { top: 60, bottom: 753 };
const FINGER = { start: 44, end: 44 };
/** The two areas as the CSS places them: the start's ends at the block's top, the end's begins at its bottom, each moved by its shift. */
const areas = (box: { top: number; bottom: number }, size = FINGER, room = ROOM) => {
  const shift = grabShifts(room, box, size);
  return { shift, start: [box.top - size.start + shift.start, box.top + shift.start], end: [box.bottom - shift.end, box.bottom + size.end - shift.end] };
};

describe('the grab areas of an entry being edited', () => {
  it('sit just outside their edges when that is within reach: no shift, whatever the entry\'s height', () => {
    for (const height of [9, 18, 40, 60, 200]) {
      const { shift, start, end } = areas({ top: 300, bottom: 300 + height });
      expect(shift).toEqual({ start: 0, end: 0 });
      expect(start[1]).toBeLessThanOrEqual(end[0]);
    }
  });
  it('are pulled in just far enough to be inside the part of the screen they can be reached in', () => {
    // A tall entry at the top of the room and one at the bottom: each pulled handle ends at the edge of the room, the other is where it was.
    const top = areas({ top: 70, bottom: 400 });
    expect(top.start[0]).toBeGreaterThanOrEqual(ROOM.top);
    expect(top.start[0]).toBeLessThanOrEqual(ROOM.top + 2);
    expect(top.shift.end).toBe(0);
    const bottom = areas({ top: 500, bottom: 745 });
    expect(bottom.end[1]).toBeLessThanOrEqual(ROOM.bottom);
    expect(bottom.end[1]).toBeGreaterThanOrEqual(ROOM.bottom - 2);
    expect(bottom.shift.start).toBe(0);
  });
  it('never overlap on a short entry at the bottom of the page: the end area keeps the screen\'s edge, the start area steps back above it', () => {
    // A 15-minute entry at 8:30p on a phone: 9px tall, 8px above the bottom of the grid, under the tab bar at 753.
    const { shift, start, end } = areas({ top: 729, bottom: 738 });
    expect(end[1]).toBeLessThanOrEqual(ROOM.bottom);
    expect(end[1] - end[0]).toBe(44);
    expect(start[1] - start[0]).toBe(44);
    expect(start[1]).toBeLessThanOrEqual(end[0]);
    expect(shift.start).toBeLessThan(0);
    expect(shift.end).toBeGreaterThan(0);
  });
  it('never overlap on a short entry at the top: the start area keeps the screen\'s edge, the end area steps back below it', () => {
    const { shift, start, end } = areas({ top: 62, bottom: 71 });
    expect(start[0]).toBeGreaterThanOrEqual(ROOM.top);
    expect(start[1]).toBeLessThanOrEqual(end[0]);
    expect(end[1] - end[0]).toBe(44);
    expect(shift.start).toBeGreaterThan(0);
    expect(shift.end).toBeLessThan(0);
  });
  it('keeps both grips reachable when the edited field extends across a clipped edge', () => {
    const top = areas({ top: ROOM.top - 5, bottom: ROOM.top + 7 });
    expect(top.start[0]).toBeGreaterThanOrEqual(ROOM.top);
    expect(top.start[1]).toBeLessThanOrEqual(top.end[0]);
    const bottom = areas({ top: ROOM.bottom - 7, bottom: ROOM.bottom + 5 });
    expect(bottom.end[1]).toBeLessThanOrEqual(ROOM.bottom);
    expect(bottom.start[1]).toBeLessThanOrEqual(bottom.end[0]);
  });
  it('never overlap, for any height and place of the entry, on a finger and on a pointer', () => {
    for (const size of [FINGER, { start: 20, end: 20 }]) {
      for (let top = 40; top <= 760; top += 7) {
        for (let height = 4; height <= 140; height += 9) {
          const { start, end } = areas({ top, bottom: top + height }, size);
          expect(start[1], `top ${top} height ${height} size ${size.start}`).toBeLessThanOrEqual(end[0]);
        }
      }
    }
  });
  it('keep their whole size wherever they are put', () => {
    for (const box of [{ top: 62, bottom: 100 }, { top: 700, bottom: 745 }, { top: 62, bottom: 745 }]) {
      const { start, end } = areas(box);
      expect(start[1] - start[0]).toBe(44);
      expect(end[1] - end[0]).toBe(44);
    }
  });
  it('a handle that is not there (cut by the page) takes no room and moves nothing', () => {
    expect(grabShifts(ROOM, { top: 729, bottom: 738 }, { start: 44, end: 0 })).toEqual({ start: 0, end: 0 });
    expect(grabShifts(ROOM, { top: 62, bottom: 71 }, { start: 0, end: 44 })).toEqual({ start: 0, end: 0 });
  });
  it('with both held by the edges of a room too small for two areas, they still do not overlap', () => {
    const { start, end } = areas({ top: 100, bottom: 110 }, FINGER, { top: 90, bottom: 130 });
    expect(start[1]).toBeLessThanOrEqual(end[0]);
  });
});
