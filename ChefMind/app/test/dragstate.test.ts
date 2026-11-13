/**
 * The row and section drags' per-drag state — the two faults a latency audit
 * found by reading (neither had a test, and the screens have no unit harness).
 *
 *  1. STALE MEASURE. The grant measures every row asynchronously. The midpoints
 *     were never cleared between drags, so a release that came before the NEXT
 *     drag's measure answered was placed on the PREVIOUS drag's geometry — a
 *     quick second drag dropped on the wrong row. The section drag had the
 *     same hole for its boundaries, and a section drag's callback was the one
 *     its first render closed over (stale records).
 *
 *  2. INDEXES ACROSS A CHANGE. Rows were addressed by index, measured once at
 *     the grant; a background pull that inserted, removed or reordered rows
 *     mid-drag made the drop move whichever row then sat at that index.
 *
 * react-native has no renderer here, so this drives the REAL hooks through a
 * tiny hook runtime (useRef/useState only) and a PanResponder that hands its
 * handlers back. Measurement is a queue the test answers by hand, which is how
 * "released before the measure answered" is made to happen on purpose.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

const rt = vi.hoisted(() => ({ slots: [] as unknown[], at: 0 }));

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const useRef = (init: unknown) => {
    const k = rt.at++;
    if (!(k in rt.slots)) rt.slots[k] = { current: init };
    return rt.slots[k];
  };
  const useState = (init: unknown) => {
    const k = rt.at++;
    if (!(k in rt.slots)) rt.slots[k] = { v: init };
    const cell = rt.slots[k] as { v: unknown };
    return [cell.v, (n: unknown) => { cell.v = typeof n === 'function' ? (n as (p: unknown) => unknown)(cell.v) : n; }];
  };
  return { ...real, default: real, useRef, useState };
});
vi.mock('react-native', () => ({ PanResponder: { create: (c: unknown) => ({ panHandlers: c }) }, View: 'View' }));
vi.mock('@calmind/core', () => ({ ordBetween: () => '', ordGap: () => [null, null] }));

import { useRowDrag, type RowDragOptions } from '../src/components/rowdrag';
import { useSectionDrag, type SectionSlot } from '../src/components/sectiondrag';

type Handlers = {
  onPanResponderGrant: () => void;
  onPanResponderMove: (e: unknown, g: { dy?: number; moveY?: number }) => void;
  onPanResponderRelease: (e: unknown, g: { dy?: number; moveY?: number }) => void;
};

/** A row whose measureInWindow waits until the test answers it. */
function fakeRows(layout: () => { y: number; h: number }[]) {
  const waiting: (() => void)[] = [];
  const ref = (i: number) => ({
    measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => {
      waiting.push(() => { const l = layout()[i]!; cb(0, l.y, 10, l.h); });
    },
  });
  return {
    ref,
    /** Answer every measure asked so far, from the layout AS IT IS NOW. */
    answer: async () => {
      waiting.splice(0).forEach((f) => f());
      for (let n = 0; n < 5; n++) await Promise.resolve();
    },
  };
}

const evenRows = (n: number) => () => Array.from({ length: n }, (_x, i) => ({ y: i * 20, h: 20 })); // mids 10, 30, 50, ...

beforeEach(() => { rt.slots = []; rt.at = 0; });

function rowHarness(n: number, layout: () => { y: number; h: number }[], opts?: RowDragOptions) {
  const rows = fakeRows(layout);
  const onDrop = vi.fn();
  const render = (count: number, o?: RowDragOptions, cb: (from: number, to: number) => void = onDrop) => {
    rt.at = 0;
    return useRowDrag(count, cb, o);
  };
  let drag = render(n, opts);
  for (let i = 0; i < n; i++) drag.registerRow(i)(rows.ref(i) as never);
  return {
    rows,
    onDrop,
    rerender: (count: number, o?: RowDragOptions) => { drag = render(count, o); },
    handlers: (i: number) => drag.handleFor(i) as unknown as Handlers,
  };
}

describe('row drag: the measure belongs to its own drag', () => {
  test('a release before the second drag\'s measure answers is placed on the SECOND drag\'s rows', async () => {
    // Drag one lays out 20px rows. By drag two, row 0 has grown to 60px
    // (mids 30, 70, 90, 110, 130), so a 45px pull down passes ONE row. The
    // old midpoints (10, 30, 50, 70, 90) say two.
    let layout = evenRows(5)();
    const h = rowHarness(5, () => layout);
    const grab = h.handlers(0);
    grab.onPanResponderGrant();
    await h.rows.answer();
    grab.onPanResponderRelease({}, { dy: 45 });
    expect(h.onDrop).toHaveBeenLastCalledWith(0, 2);
    h.onDrop.mockClear();

    layout = [{ y: 0, h: 60 }, { y: 60, h: 20 }, { y: 80, h: 20 }, { y: 100, h: 20 }, { y: 120, h: 20 }];
    grab.onPanResponderGrant();
    grab.onPanResponderRelease({}, { dy: 45 }); // over before the measure answers
    expect(h.onDrop).not.toHaveBeenCalled(); // not on the last drag's geometry
    await h.rows.answer();
    expect(h.onDrop).toHaveBeenCalledTimes(1);
    expect(h.onDrop).toHaveBeenCalledWith(0, 1);
  });
});

describe('row drag: a drop names rows by key when the list changed mid-drag', () => {
  const keysOf = (keys: string[]) => ({ keyOf: (i: number) => keys[i] ?? null });

  async function pickUp(keys: string[]) {
    const h = rowHarness(keys.length, evenRows(keys.length), keysOf(keys));
    const grab = h.handlers(1); // 'b'
    grab.onPanResponderGrant();
    await h.rows.answer();
    return { h, grab };
  }

  test('an unchanged list drops by the same indexes', async () => {
    const { h, grab } = await pickUp(['a', 'b', 'c', 'd']);
    grab.onPanResponderRelease({}, { dy: 25 }); // b past c
    expect(h.onDrop).toHaveBeenCalledWith(1, 2);
  });

  test('a row inserted between the dragged row and its landing row moves the dragged row to the landing row', async () => {
    const { h, grab } = await pickUp(['a', 'b', 'c', 'd']);
    const next = ['a', 'b', 'x', 'c', 'd'];
    h.rerender(next.length, keysOf(next));
    grab.onPanResponderRelease({}, { dy: 25 });
    expect(h.onDrop).toHaveBeenCalledTimes(1);
    expect(h.onDrop).toHaveBeenCalledWith(1, 3); // by index it would stop at x, one short of c
  });

  test('a row inserted above: the grip is handed to the dragged row\'s new index and the drop keeps the index rule', async () => {
    // The row's own index changed, so its grip now carries the responder of
    // index 2 (e2e/dragunder.spec.ts pins that this lands right in a browser):
    // the release arrives on THAT responder, whose index is already the row's.
    const { h } = await pickUp(['a', 'b', 'c', 'd']);
    const next = ['x', 'a', 'b', 'c', 'd'];
    h.rerender(next.length, keysOf(next));
    h.handlers(2).onPanResponderRelease({}, { dy: 25 });
    expect(h.onDrop).toHaveBeenCalledTimes(1);
    expect(h.onDrop.mock.calls[0]![0]).toBe(2);
  });

  test('the dragged row removed: nothing moves', async () => {
    const { h, grab } = await pickUp(['a', 'b', 'c', 'd']);
    const next = ['a', 'c', 'd'];
    h.rerender(next.length, keysOf(next));
    grab.onPanResponderRelease({}, { dy: 25 });
    expect(h.onDrop).not.toHaveBeenCalled();
  });

  test('the row it would land on removed: nothing moves', async () => {
    const { h, grab } = await pickUp(['a', 'b', 'c', 'd']);
    const next = ['a', 'b', 'd'];
    h.rerender(next.length, keysOf(next));
    grab.onPanResponderRelease({}, { dy: 25 });
    expect(h.onDrop).not.toHaveBeenCalled();
  });

  test('the landing row moved to the other side of the dragged row: nothing moves', async () => {
    const { h, grab } = await pickUp(['a', 'b', 'c', 'd']);
    const next = ['c', 'a', 'b', 'd'];
    h.rerender(next.length, keysOf(next));
    grab.onPanResponderRelease({}, { dy: 25 });
    expect(h.onDrop).not.toHaveBeenCalled();
  });

  test('a caller with no keys keeps the index drop', async () => {
    const h = rowHarness(4, evenRows(4));
    const grab = h.handlers(1);
    grab.onPanResponderGrant();
    await h.rows.answer();
    h.rerender(5);
    grab.onPanResponderRelease({}, { dy: 25 });
    expect(h.onDrop).toHaveBeenCalledWith(1, 2);
  });
});

describe('section drag', () => {
  /** Three section headers, 100px apart, in one folder. */
  function sectionHarness(layout: () => number[]) {
    const waiting: (() => void)[] = [];
    const ref = (i: number) => ({ measureInWindow: (cb: (x: number, y: number) => void) => { waiting.push(() => cb(0, layout()[i]!)); } });
    const first = vi.fn();
    const render = (cb: (id: string, slot: SectionSlot) => void) => { rt.at = 0; return useSectionDrag(cb); };
    let drag = render(first);
    ['s0', 's1', 's2'].forEach((id, i) => drag.registerHeader(id, 'f')(ref(i) as never));
    return {
      first,
      rerender: (cb: (id: string, slot: SectionSlot) => void) => { drag = render(cb); },
      grip: (id: string) => drag.gripFor(id) as unknown as Handlers,
      answer: async () => { waiting.splice(0).forEach((f) => f()); for (let n = 0; n < 5; n++) await Promise.resolve(); },
    };
  }

  test('a release before the second drag\'s measure answers uses the second drag\'s headers', async () => {
    let ys = [0, 100, 200];
    const h = sectionHarness(() => ys);
    const grip = h.grip('s0');
    grip.onPanResponderGrant();
    await h.answer();
    grip.onPanResponderMove({}, { moveY: 150 });
    grip.onPanResponderRelease({}, { moveY: 150 });
    expect(h.first).toHaveBeenLastCalledWith('s0', expect.objectContaining({ key: 'before:s1' }));
    h.first.mockClear();

    ys = [0, 300, 400]; // s1 is no longer anywhere near 150
    grip.onPanResponderGrant();
    grip.onPanResponderMove({}, { moveY: 150 }); // before the measure answers
    grip.onPanResponderRelease({}, { moveY: 150 });
    await h.answer();
    // On the new headers y=150 is still above s1 (300): the only boundary at
    // or above it is s0's own, which is a no-op.
    expect(h.first).not.toHaveBeenCalledWith('s0', expect.objectContaining({ key: 'before:s1' }));
  });

  test('the drop goes to the callback of the LATEST render, not the one the grip was made in', async () => {
    const h = sectionHarness(() => [0, 100, 200]);
    const grip = h.grip('s0'); // created while `first` was the callback
    const later = vi.fn();
    h.rerender(later);
    grip.onPanResponderGrant();
    await h.answer();
    grip.onPanResponderMove({}, { moveY: 150 });
    grip.onPanResponderRelease({}, { moveY: 150 });
    expect(later).toHaveBeenCalledTimes(1);
    expect(h.first).not.toHaveBeenCalled();
  });
});
