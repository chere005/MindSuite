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
    register: (i: number) => drag.registerRow(i)(rows.ref(i) as never),
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

  test('a row inserted above: the drop lands where the pointer travel puts the row, by id, in the new list', async () => {
    // The row's own index changed, so its grip now carries the responder of
    // index 2 and the release arrives on THAT responder, whose own dy counts
    // only the movement since the handoff. The drop must use the whole travel
    // since the grant and the list as it is now (e2e/zzreviewprobe found it
    // landing one row short, or not at all).
    for (const [releaseY, to] of [[50, 3], [70, 4]] as const) {
      rt.slots = []; rt.at = 0;
      let layout = evenRows(4)();
      const h = rowHarness(4, () => layout, keysOf(['a', 'b', 'c', 'd']));
      const grab = h.handlers(1); // 'b'
      (grab.onPanResponderGrant as (e: unknown, g: unknown) => void)({}, { y0: 30 });
      await h.rows.answer();
      grab.onPanResponderMove({}, { dy: 10, moveY: 40 });
      layout = evenRows(5)();
      const next = ['x', 'a', 'b', 'c', 'd'];
      h.rerender(next.length, keysOf(next));
      for (let i = 0; i < 5; i++) h.register(i);
      h.handlers(2).onPanResponderMove({}, { dy: 5, moveY: releaseY });
      h.handlers(2).onPanResponderRelease({}, { dy: 5, moveY: releaseY });
      await h.rows.answer();
      expect(h.onDrop).toHaveBeenCalledTimes(1);
      expect(h.onDrop).toHaveBeenCalledWith(2, to);
    }
  });

  test('a row inserted above, released with no move after the handoff: the last pointer position is used', async () => {
    let layout = evenRows(4)();
    const h = rowHarness(4, () => layout, keysOf(['a', 'b', 'c', 'd']));
    const grab = h.handlers(1);
    (grab.onPanResponderGrant as (e: unknown, g: unknown) => void)({}, { y0: 30 });
    await h.rows.answer();
    grab.onPanResponderMove({}, { dy: 20, moveY: 50 });
    layout = evenRows(5)();
    const next = ['x', 'a', 'b', 'c', 'd'];
    h.rerender(next.length, keysOf(next));
    h.handlers(2).onPanResponderRelease({}, { dy: 0, moveY: 0 });
    await h.rows.answer();
    expect(h.onDrop).toHaveBeenCalledWith(2, 3);
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

  test('every move before the measure answered, the release after it: the release point is placed', async () => {
    const h = sectionHarness(() => [0, 100, 200]);
    const grip = h.grip('s0');
    grip.onPanResponderGrant();
    grip.onPanResponderMove({}, { moveY: 150 });
    await h.answer();
    grip.onPanResponderRelease({}, { moveY: 150 });
    expect(h.first).toHaveBeenCalledWith('s0', expect.objectContaining({ key: 'before:s1' }));
  });
});

/**
 * 3. A MEASURE THAT SEES THE SHIFT. The grant's measure answers later than the
 *    first move can arrive (react-native-web answers measureInWindow from a
 *    setTimeout, and a browser runs a queued pointer move before a timer; a
 *    native measure is asynchronous as well). By then the first move may have
 *    shifted the dragged row — a transform on its node in a live drag, a
 *    dragDy render otherwise — and whether a measure includes that transform
 *    differs by platform. A row whose measured midpoint included its own
 *    travel had that travel added a second time and overshot (found in the
 *    web build: one quick move of 2.4 rows landed 3 rows on).
 *
 * The rows here are 20 px high and touch (mids 10, 30, 50, ...), and each
 * measure reports the row where it is DRAWN when `seesShift` is on.
 */
describe('row drag: the drop is where the dragged row\'s centre was released, whenever the measure answers', () => {
  type Mode = { live: boolean; seesShift: boolean };
  const MODES: Mode[] = [
    { live: true, seesShift: true },
    { live: true, seesShift: false },
    { live: false, seesShift: true },
    { live: false, seesShift: false },
  ];
  const Y0 = 500; // the pointer's page Y at the grant; only differences count

  function shiftHarness(first: string[], m: Mode) {
    let keys = first;
    const shift = new Map<string, number>();
    const waiting: (() => void)[] = [];
    const onDrop = vi.fn();
    let drag = null as unknown as ReturnType<typeof useRowDrag>;
    const render = () => {
      rt.at = 0;
      drag = useRowDrag(keys.length, onDrop, { live: m.live, keyOf: (i) => keys[i] ?? null });
      return drag;
    };
    /** The shift drawn on row `k` now: its node's transform (live), or the dragDy the screen renders it with. */
    const drawn = (k: string): number => {
      if (m.live) return shift.get(k) ?? 0;
      const d = render();
      return d.dragIdx !== null && keys[d.dragIdx] === k ? d.dragDy : 0;
    };
    const nodes = new Map<string, object>();
    const node = (k: string) => {
      if (!nodes.has(k)) {
        nodes.set(k, {
          setNativeProps: (p: { style: { transform: { translateY: number }[] } }) => { shift.set(k, p.style.transform[0]!.translateY); },
          measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => {
            waiting.push(() => cb(0, keys.indexOf(k) * 20 + (m.seesShift ? drawn(k) : 0), 10, 20));
          },
        });
      }
      return nodes.get(k)!;
    };
    let registered = 0;
    const registerAll = () => {
      for (let i = keys.length; i < registered; i++) drag.registerRow(i)(null);
      keys.forEach((k, i) => drag.registerRow(i)(node(k) as never));
      registered = keys.length;
    };
    render();
    registerAll();
    const g = (travel: number, dy = travel) => ({ dy, moveY: Y0 + travel });
    return {
      onDrop,
      drawn,
      /** The list changed (a reorder after a drop, or a second tab's write). */
      setKeys: (next: string[]) => { keys = next; render(); registerAll(); },
      grip: (k: string) => {
        const h = drag.handleFor(keys.indexOf(k)) as unknown as {
          onPanResponderGrant: (e: unknown, g: unknown) => void;
          onPanResponderMove: (e: unknown, g: unknown) => void;
          onPanResponderRelease: (e: unknown, g: unknown) => void;
        };
        return {
          grant: () => h.onPanResponderGrant({}, { y0: Y0, dy: 0 }),
          move: (travel: number, dy?: number) => h.onPanResponderMove({}, g(travel, dy)),
          release: (travel: number, dy?: number) => h.onPanResponderRelease({}, g(travel, dy)),
        };
      },
      slot: (): number | null => (m.live ? drag.liveSlot.get() : render().slot),
      answer: async () => {
        waiting.splice(0).forEach((f) => f());
        for (let n = 0; n < 5; n++) await Promise.resolve();
      },
    };
  }

  const name = (m: Mode) => `${m.live ? 'live' : 'dragDy'} rows, measure ${m.seesShift ? 'includes' : 'ignores'} the shift`;

  // [grabbed, travel, expected drop]: 2.4 and 0.6 rows, down and up, from the
  // first, a middle and the last row of a b c d e.
  const CASES: [string, number, [number, number] | null][] = [
    ['b', 48, [1, 3]],   // centre 30+48 = 78 passes c (50) and d (70), not e (90)
    ['d', -48, [3, 1]],  // 70-48 = 22 passes c and b, not a (10)
    ['a', 48, [0, 2]],
    ['e', -48, [4, 2]],
    ['a', 12, null],     // 0.6 of a row passes no centre
    ['c', -12, null],
    ['e', -12, null],
  ];

  for (const m of MODES) {
    test(`${name(m)}: one quick move, the measure answering after it (before the release, or after)`, async () => {
      for (const late of [false, true]) {
        for (const [k, travel, want] of CASES) {
          rt.slots = []; rt.at = 0;
          const h = shiftHarness(['a', 'b', 'c', 'd', 'e'], m);
          const grip = h.grip(k);
          grip.grant();
          grip.move(travel);
          if (!late) await h.answer();
          grip.release(travel);
          if (late) {
            expect(h.onDrop, `${k} ${travel}: not before its measure`).not.toHaveBeenCalled();
            await h.answer();
          }
          if (want) expect(h.onDrop, `${k} ${travel} late=${late}`).toHaveBeenCalledWith(...want);
          else expect(h.onDrop, `${k} ${travel} late=${late}`).not.toHaveBeenCalled();
        }
      }
    });

    test(`${name(m)}: moves before the measure answers, the release after it; the picture is the drop`, async () => {
      for (const [k, travel, want] of CASES) {
        rt.slots = []; rt.at = 0;
        const h = shiftHarness(['a', 'b', 'c', 'd', 'e'], m);
        const grip = h.grip(k);
        grip.grant();
        grip.move(travel / 2);
        grip.move(travel);
        await h.answer();
        // Drawn by the same rule the release uses: the row rides its whole
        // travel, and the line sits where the drop will land.
        expect(h.drawn(k), `${k} ${travel}: drawn shift`).toBe(travel);
        expect(h.slot(), `${k} ${travel}: line`).toBe(want ? (want[1] > want[0] ? want[1] + 1 : want[1]) : null);
        grip.release(travel);
        if (want) expect(h.onDrop, `${k} ${travel}`).toHaveBeenCalledWith(...want);
        else expect(h.onDrop, `${k} ${travel}`).not.toHaveBeenCalled();
      }
    });

    test(`${name(m)}: a quick second drag right after a drop`, async () => {
      const h = shiftHarness(['a', 'b', 'c', 'd', 'e'], m);
      let grip = h.grip('b');
      grip.grant();
      grip.move(48);
      await h.answer();
      grip.release(48);
      expect(h.onDrop).toHaveBeenLastCalledWith(1, 3);
      h.setKeys(['a', 'c', 'd', 'b', 'e']); // the screen applies the drop
      h.onDrop.mockClear();
      grip = h.grip('d'); // index 2 now, mid 50
      grip.grant();
      grip.move(-48);
      await h.answer(); // after the move, before the release
      grip.release(-48);
      expect(h.onDrop).toHaveBeenCalledTimes(1);
      expect(h.onDrop).toHaveBeenCalledWith(2, 0); // 50-48 = 2 passes a (10)
    });

    test(`${name(m)}: after a row arrives above, the row rides the whole travel and the line is the drop`, async () => {
      const h = shiftHarness(['a', 'b', 'c', 'd'], m);
      const grip = h.grip('b');
      grip.grant();
      await h.answer();
      grip.move(10);
      h.setKeys(['x', 'a', 'b', 'c', 'd']); // b is index 2 now; its grip carries responder 2
      const moved = h.grip('b');
      // The new responder's own dy counts only what it saw (30 of the 40).
      moved.move(40, 30);
      expect(h.drawn('b'), 'drawn while the new measure is out').toBe(40);
      expect(h.slot(), 'no line on the old measure').toBe(null);
      await h.answer();
      // b's home is 50 now; 50+40 = 90 passes x (10), a (30), c (70) and d (90).
      expect(h.drawn('b')).toBe(40);
      expect(h.slot()).toBe(5);
      moved.move(30, 20); // 80: passes c (70), not d (90)
      expect(h.drawn('b')).toBe(30);
      expect(h.slot()).toBe(4);
      moved.release(30, 20);
      expect(h.onDrop).toHaveBeenCalledTimes(1);
      expect(h.onDrop).toHaveBeenCalledWith(2, 3);
    });

    test(`${name(m)}: the landing row deleted mid-drag takes the line down with the drop`, async () => {
      const h = shiftHarness(['a', 'b', 'c', 'd'], m);
      const grip = h.grip('b');
      grip.grant();
      grip.move(25);
      await h.answer();
      expect(h.slot()).toBe(3); // b past c
      h.setKeys(['a', 'b', 'd']);
      grip.move(26);
      expect(h.slot()).toBe(null);
      grip.release(26);
      expect(h.onDrop).not.toHaveBeenCalled();
    });
  }
});
