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

  /**
   * `sync` models a measure that answers AT ONCE from the last COMMITTED tree
   * (Fabric's measureInWindow reads the current shadow tree synchronously): a
   * dragDy screen's shift sits on the row at the committed `dragIdx` of the
   * committed list, and a setUi made in the same handler is not in it yet.
   * `tick` is the commit after a handler. Without `sync`, measures wait for
   * `answer` and read the rows as they are then.
   */
  function shiftHarness(first: string[], m: Mode, startSync = false) {
    let sync = startSync;
    let keys = first;
    let committed: { idx: number | null; dy: number; keys: string[] } = { idx: null, dy: 0, keys: first };
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
            if (sync) {
              const seen = m.live ? shift.get(k) ?? 0 : committed.idx !== null && committed.keys[committed.idx] === k ? committed.dy : 0;
              cb(0, committed.keys.indexOf(k) * 20 + (m.seesShift ? seen : 0), 10, 20);
            } else waiting.push(() => cb(0, keys.indexOf(k) * 20 + (m.seesShift ? drawn(k) : 0), 10, 20));
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
    const commit = () => { const d = render(); committed = { idx: d.dragIdx, dy: d.dragDy, keys: [...keys] }; };
    const g = (travel: number, dy = travel) => ({ dy, moveY: Y0 + travel });
    return {
      onDrop,
      drawn,
      /** The list changed (a reorder after a drop, or a second tab's write). */
      setKeys: (next: string[]) => { keys = next; render(); registerAll(); commit(); },
      /** From now on, measures answer at once (true) or wait for `answer` (false). */
      setSync: (on: boolean) => { sync = on; },
      /** The handler's promise callbacks run, then React commits what it drew. */
      tick: async () => {
        for (let n = 0; n < 5; n++) await Promise.resolve();
        commit();
      },
      grip: (k: string | number) => {
        // A key, or a bare responder index (a move delivered to a responder
        // whose row changed, before the screen re-rendered its grips).
        const h = drag.handleFor(typeof k === 'number' ? k : keys.indexOf(k)) as unknown as {
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

    test(`${name(m)}: while a newer measure is out, no line from an older one; then the line is the drop`, async () => {
      // The release waits for the newest measure, so a line drawn from an
      // older one could name another row than the drop.
      const h = shiftHarness(['a', 'b', 'c', 'd'], m);
      h.grip('b').grant();
      await h.answer();
      h.grip('b').move(25);
      expect(h.slot()).toBe(3); // b (30+25 = 55) past c (50)
      h.setKeys(['x', 'a', 'b', 'c', 'd']);
      h.grip('b').move(25);
      h.setKeys(['a', 'b', 'y', 'c', 'd']); // b is back at 1, y now sits where c was
      h.grip('b').move(25);
      expect(h.slot(), 'the first measure would put the line under c').toBe(null);
      await h.answer();
      expect(h.slot()).toBe(3); // 55 passes y (50), not c (70)
      h.grip('b').release(25);
      expect(h.onDrop).toHaveBeenCalledTimes(1);
      expect(h.onDrop).toHaveBeenCalledWith(1, 2);
    });

    test(`${name(m)}: a release clears the shift it drew, after the list changed under it`, async () => {
      const h = shiftHarness(['a', 'b', 'c', 'd'], m);
      h.grip('b').grant();
      await h.answer();
      h.grip('b').move(30);
      expect(h.drawn('b')).toBe(30);
      h.setKeys(['x', 'a', 'b', 'c', 'd']);
      h.grip('b').release(30);
      await h.answer();
      for (const k of ['x', 'a', 'b', 'c', 'd']) expect(h.drawn(k), k).toBe(0);
    });
  }

  for (const m of MODES) {
    const lag = `${name(m)}, answered at once from the last commit`;

    test(`${lag}: a row arrives above; the neighbour a dragDy screen still draws shifted is not the home`, async () => {
      const h = shiftHarness(['a', 'b', 'c', 'd'], m, true);
      h.grip('b').grant();
      await h.tick();
      h.grip('b').move(10);
      await h.tick(); // dragIdx 1 (b) drawn 10 down
      h.setKeys(['x', 'a', 'b', 'c', 'd']); // committed with dragIdx still 1: a is drawn 10 down
      const moved = h.grip('b');
      moved.move(40, 30); // the handoff's measure answers from that commit
      await h.tick();
      // b's home is 50; 50+40 = 90 passes x, a, c (70) and d (90).
      expect(h.drawn('b')).toBe(40);
      expect(h.slot()).toBe(5);
      moved.move(30, 20);
      await h.tick();
      expect(h.slot()).toBe(4); // 80: past c, not d
      moved.release(30, 20);
      await h.tick();
      expect(h.onDrop).toHaveBeenCalledTimes(1);
      expect(h.onDrop).toHaveBeenCalledWith(2, 3);
    });

    test(`${lag}: a row leaves above the top; the row below still drawn shifted is not the home`, async () => {
      const h = shiftHarness(['a', 'b', 'c', 'd', 'e'], m, true);
      h.grip('b').grant();
      await h.tick();
      h.grip('b').move(-10);
      await h.tick();
      h.setKeys(['b', 'c', 'd', 'e']); // b is first; dragIdx 1 is c now, drawn 10 up
      const moved = h.grip('b');
      moved.move(45, 55);
      await h.tick();
      // b's home is 10; 10+45 = 55 passes c (30) and d (50), not e (70).
      expect(h.drawn('b')).toBe(45);
      expect(h.slot()).toBe(3);
      moved.release(45, 55);
      await h.tick();
      expect(h.onDrop).toHaveBeenCalledTimes(1);
      expect(h.onDrop).toHaveBeenCalledWith(0, 2);
    });

    test(`${lag}: the grant's measure answers after a row arrived above; the row then drawn shifted is not the home`, async () => {
      const h = shiftHarness(['a', 'b', 'c', 'd'], m);
      h.grip('b').grant(); // its measure waits
      h.grip('b').move(10);
      h.setKeys(['x', 'a', 'b', 'c', 'd']);
      // It answers before the next move: that draw goes to index 1, the old
      // responder's, which is row a now.
      await h.answer();
      await h.tick();
      h.setSync(true);
      const moved = h.grip('b');
      moved.move(40, 30);
      await h.tick();
      expect(h.drawn('b')).toBe(40);
      expect(h.drawn('a')).toBe(0);
      expect(h.slot()).toBe(5); // 50+40 = 90 passes x, a, c and d
      moved.move(30, 20);
      await h.tick();
      expect(h.slot()).toBe(4);
      moved.release(30, 20);
      await h.tick();
      expect(h.onDrop).toHaveBeenCalledTimes(1);
      expect(h.onDrop).toHaveBeenCalledWith(2, 3);
    });

    test(`${lag}: two handoffs; a row an earlier measure saw shifted is not the home either`, async () => {
      const h = shiftHarness(['a', 'b', 'c', 'd', 'e', 'f'], m, true);
      h.grip('c').grant();
      await h.tick();
      h.grip('c').move(10);
      await h.tick();
      h.setKeys(['x', 'a', 'b', 'c', 'd', 'e', 'f']); // dragIdx 2 is b now
      h.grip('c').move(20);
      await h.tick(); // that measure may have seen b shifted
      h.setKeys(['a', 'b', 'c', 'd', 'e', 'f']); // x gone: c is back at 2, dragIdx 3 is d
      const back = h.grip('c');
      back.move(45);
      await h.tick();
      // c's home is 50; 50+45 = 95 passes d (70) and e (90), not f (110).
      expect(h.drawn('c')).toBe(45);
      expect(h.slot()).toBe(5);
      back.release(45);
      await h.tick();
      expect(h.onDrop).toHaveBeenCalledTimes(1);
      expect(h.onDrop).toHaveBeenCalledWith(2, 4);
    });

    test(`${lag}: one quick move and two quick drags in a row`, async () => {
      for (const [k, travel, want] of CASES) {
        rt.slots = []; rt.at = 0;
        const h = shiftHarness(['a', 'b', 'c', 'd', 'e'], m, true);
        const grip = h.grip(k);
        grip.grant();
        grip.move(travel);
        grip.release(travel);
        await h.tick();
        if (want) expect(h.onDrop, `${k} ${travel}`).toHaveBeenCalledWith(...want);
        else expect(h.onDrop, `${k} ${travel}`).not.toHaveBeenCalled();
        if (!want) continue;
        // The screen applies the drop, and the same row is dragged straight back.
        const next = ['a', 'b', 'c', 'd', 'e'].filter((x) => x !== k);
        next.splice(want[1], 0, k);
        h.setKeys(next);
        h.onDrop.mockClear();
        const again = h.grip(k);
        again.grant();
        again.move(-travel);
        again.release(-travel);
        await h.tick();
        expect(h.onDrop, `${k} ${travel}, second drag`).toHaveBeenCalledTimes(1);
        expect(h.onDrop, `${k} ${travel}, second drag`).toHaveBeenCalledWith(want[1], want[0]);
      }
    });

    test(`${lag}: a row arrives above and the drag goes up past the row still drawn shifted`, async () => {
      const h = shiftHarness(['a', 'b', 'c', 'd'], m, true);
      h.grip('d').grant();
      await h.tick();
      h.grip('d').move(-48);
      await h.tick(); // dragIdx 3 (d) drawn 48 up
      h.setKeys(['x', 'a', 'b', 'c', 'd']); // committed with dragIdx still 3: c is drawn 48 up
      const moved = h.grip('d');
      moved.move(-48); // the handoff's measure answers from that commit
      await h.tick();
      // d's home is 90; 90-48 = 42 passes x (10) and a (30), not b (50) or c (70).
      expect(h.drawn('d')).toBe(-48);
      expect(h.slot()).toBe(2);
      moved.release(-48);
      await h.tick();
      expect(h.onDrop).toHaveBeenCalledTimes(1);
      expect(h.onDrop).toHaveBeenCalledWith(4, 2);
    });

    test(`${lag}: a row leaves above and the drag goes down past the row still drawn shifted`, async () => {
      const h = shiftHarness(['x', 'a', 'b', 'c', 'd', 'e'], m, true);
      h.grip('a').grant();
      await h.tick();
      h.grip('a').move(48);
      await h.tick(); // dragIdx 1 (a) drawn 48 down
      h.setKeys(['a', 'b', 'c', 'd', 'e']); // committed with dragIdx still 1: b is drawn 48 down
      const moved = h.grip('a');
      moved.move(48);
      await h.tick();
      // a's home is 10; 10+48 = 58 passes b (30) and c (50), not d (70).
      expect(h.drawn('a')).toBe(48);
      expect(h.slot()).toBe(3);
      moved.release(48);
      await h.tick();
      expect(h.onDrop).toHaveBeenCalledTimes(1);
      expect(h.onDrop).toHaveBeenCalledWith(0, 2);
    });
  }

  for (const m of MODES) {
    test(`${name(m)}, answered at once from the last commit: a move reaches the old responder after a row arrived above`, async () => {
      const h = shiftHarness(['a', 'b', 'c', 'd'], m, true);
      h.grip('b').grant();
      await h.tick();
      h.setKeys(['x', 'a', 'b', 'c', 'd']);
      // Responder 1 is a's now: a live drag shifts the node there, a.
      h.grip(1).move(-30);
      await h.tick();
      const moved = h.grip('b');
      moved.move(-30); // the handoff's measure may see a drawn 30 up
      await h.tick();
      // b's home is 50; 50-30 = 20 passes x (10), not a (30).
      expect(h.drawn('b')).toBe(-30);
      expect(h.drawn('a')).toBe(0);
      expect(h.slot()).toBe(1);
      moved.release(-30);
      await h.tick();
      expect(h.onDrop).toHaveBeenCalledTimes(1);
      expect(h.onDrop).toHaveBeenCalledWith(2, 1);
    });

    test(`${name(m)}, answered at once from the last commit: a row it may have seen shifted that cannot be placed cancels the drop`, async () => {
      const h = shiftHarness(['a', 'b', 'c', 'd'], m, true);
      h.grip('b').grant();
      await h.tick();
      h.setKeys(['a', 'x', 'b', 'c', 'd']);
      // Responder 1 is the new row x's now: a live drag shifts x, which no
      // earlier measure has seen, so nothing places its midpoint.
      h.grip(1).move(-30);
      await h.tick();
      const moved = h.grip('b');
      moved.move(-30);
      await h.tick();
      expect(h.drawn('b')).toBe(-30);
      expect(h.drawn('x')).toBe(0);
      // dragDy rows never draw x shifted: b's home is 50, 50-30 = 20 passes a (10), not x (30).
      expect(h.slot()).toBe(m.live ? null : 1);
      moved.release(-30);
      await h.tick();
      if (m.live) expect(h.onDrop).not.toHaveBeenCalled();
      else expect(h.onDrop).toHaveBeenCalledWith(2, 1);
    });

    test(`${name(m)}: a row arrives above and the new responder moves before the grant's measure answers`, async () => {
      const h = shiftHarness(['a', 'b', 'c', 'd'], m);
      h.grip('b').grant(); // its measure waits
      h.setKeys(['x', 'a', 'b', 'c', 'd']);
      const moved = h.grip('b');
      moved.move(30);
      await h.answer();
      // b's home is 50 in the new list; 50+30 = 80 passes x, a and c (70), not d (90).
      expect(h.drawn('b')).toBe(30);
      expect(h.slot()).toBe(4);
      moved.release(30);
      await h.answer();
      expect(h.onDrop).toHaveBeenCalledTimes(1);
      expect(h.onDrop).toHaveBeenCalledWith(2, 3);
    });
  }
});
