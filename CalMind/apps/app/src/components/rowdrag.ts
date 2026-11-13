/**
 * A portable row drag — PanResponder, so it works on web and native alike.
 * The suite's feedback rule carries over: nothing moves while you drag; a
 * single drop line is the only hint, and the list reorders on release. The
 * dragged row just dims and rides the finger.
 *
 * MEASURED, like the section drag: every flat entry (row or empty-section
 * placeholder) registers a ref, the grant measures them all in window space,
 * and the pointer's absolute Y picks the nearest boundary — so wrapped rows,
 * section headers and folder heads between rows never bend the math the way
 * the old uniform-height model did.
 *
 * The responders are created ONCE per row index and read live values through
 * a ref — a responder rebuilt mid-gesture drops the gesture on the floor,
 * which showed up as text selection instead of a drag.
 */
import { createElement, useRef, useState, useSyncExternalStore } from 'react';
import { PanResponder, View as RNView, type PanResponderInstance, type View } from 'react-native';
import { ordBetween, ordGap } from '@calmind/core';

export type RowDrag = {
  /** Attach to flat entry `i`'s View so the grant can measure it. */
  registerRow: (i: number) => (ref: View | null) => void;
  /** Pan handlers for the ≡ handle of row `i`. */
  handleFor: (i: number) => PanResponderInstance['panHandlers'];
  dragIdx: number | null;
  dragDy: number;
  /** The boundary the drop line sits on (0..count), or null. */
  slot: number | null;
  /** The live slot, for <DropLine>. Only `live` drags keep `slot` out of state. */
  liveSlot: { subscribe: (fn: () => void) => () => void; get: () => number | null };
};

/**
 * A `live` drag keeps the per-move values (the drop slot, the dragged row's
 * travel) OUT of React state: a pointermove used to setState on the screen
 * that owns the list, which re-rendered every row of it on every move (240
 * rows: ~350 ms a move at 4x CPU). With `live`, the row rides the finger by a
 * transform written straight to its node, and the drop line is a <DropLine>
 * that subscribes to the slot and re-renders alone, only when the slot
 * changes. `slot` and `dragDy` then stay null / 0 — a live caller reads the
 * slot through <DropLine at={n}/> and passes no translateY. `dragIdx` is
 * still state: it flips twice a gesture, and the screen needs it to dim the
 * row and to freeze its scroll. Callers that do not pass `live` keep the old
 * behaviour exactly.
 */
export type RowDragOptions = { live?: boolean };

/** Move a registered row by `dy` without a render: DOM node on web, native props elsewhere. */
function shiftNode(node: View | undefined, dy: number) {
  if (!node) return;
  const n = node as unknown as { setNativeProps?: (p: object) => void; style?: CSSStyleDeclaration };
  if (typeof n.setNativeProps === 'function') n.setNativeProps({ style: { transform: [{ translateY: dy }] } });
  else if (n.style) n.style.transform = dy === 0 ? '' : `translateY(${dy}px)`;
}

export function useRowDrag(count: number, onDrop: (from: number, to: number) => void, options?: RowDragOptions): RowDrag {
  const live = options?.live === true;
  const [ui, setUi] = useState<{ dragIdx: number | null; dragDy: number; slot: number | null }>({
    dragIdx: null,
    dragDy: 0,
    slot: null,
  });
  // The live slot: a value and its listeners, read by <DropLine>.
  const slotStore = useRef<{ api: RowDrag['liveSlot']; set: (v: number | null) => void } | null>(null);
  if (!slotStore.current) {
    let value: number | null = null;
    const listeners = new Set<() => void>();
    slotStore.current = {
      api: {
        subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
        get: () => value,
      },
      set: (v) => { if (v !== value) { value = v; listeners.forEach((l) => l()); } },
    };
  }
  const setLiveSlot = (v: number | null) => slotStore.current!.set(v);
  const cfg = useRef({ count, onDrop });
  cfg.current = { count, onDrop };
  const rows = useRef(new Map<number, View>());
  // Each registered entry's midpoint in window space, filled at grant.
  const mids = useRef(new Map<number, number>());
  const responders = useRef(new Map<number, PanResponderInstance>());

  const registerRow = (i: number) => (ref: View | null) => {
    if (ref) rows.current.set(i, ref);
    else rows.current.delete(i);
  };

  const measure = async () => {
    const entries = [...rows.current.entries()];
    const measured = await Promise.all(
      entries.map(
        ([i, ref]) =>
          new Promise<{ i: number; mid: number }>((res) =>
            ref.measureInWindow((_x, y, _w, h) => res({ i, mid: y + h / 2 })),
          ),
      ),
    );
    mids.current = new Map(measured.map((m) => [m.i, m.mid]));
  };

  /** The classic sortable rule, on measured geometry: the dragged row's
   *  DISPLACED midpoint (its own mid + total travel — so where you grabbed it
   *  cancels out) is compared against every other row's midpoint, and the
   *  count it has passed is its destination index. Crossing a row's centre is
   *  what swaps with it, whatever anyone's height is. */
  const destFor = (i: number, dy: number): number | null => {
    const own = mids.current.get(i);
    if (own === undefined) return null;
    // A hair of direction-aware bias so an exact tie of centres resolves the
    // way the drag is heading instead of falling dead on the knife edge.
    const c = own + dy + (dy > 0 ? 0.5 : -0.5);
    let k = 0;
    for (const [j, mid] of mids.current) {
      if (j !== i && mid < c) k++;
    }
    return k === i ? null : k;
  };

  const reset = (i: number) => {
    if (live) { shiftNode(rows.current.get(i), 0); setLiveSlot(null); }
    setUi({ dragIdx: null, dragDy: 0, slot: null });
  };

  const handleFor = (i: number) => {
    if (!responders.current.has(i)) {
      responders.current.set(
        i,
        PanResponder.create({
          onStartShouldSetPanResponder: () => true,
          onMoveShouldSetPanResponder: () => true,
          // A grip's drag is never up for negotiation. The enclosing
          // ScrollView asks for the responder the moment the pointer travels
          // vertically, and the default answer is yes — so on any list long
          // enough to scroll, the drag was granted, measured, and then
          // silently TERMINATED before it could drop. Refusing the request is
          // what makes a drag survive on a real-length list.
          onPanResponderTerminationRequest: () => false,
          onPanResponderGrant: () => {
            setUi({ dragIdx: i, dragDy: 0, slot: null });
            setLiveSlot(null);
            void measure();
          },
          onPanResponderMove: (_e, g) => {
            const to = destFor(i, g.dy);
            const slot = to === null ? null : to > i ? to + 1 : to;
            if (live) {
              shiftNode(rows.current.get(i), g.dy);
              setLiveSlot(slot);
            } else {
              setUi({ dragIdx: i, dragDy: g.dy, slot });
            }
          },
          onPanResponderRelease: (_e, g) => {
            // Compute from the RELEASE's own travel, not the last move — a
            // fast flick can land with barely any move events processed.
            const drop = () => {
              const to = destFor(i, g.dy);
              if (to === null) return;
              const bounded = Math.max(0, Math.min(cfg.current.count - 1, to));
              if (i !== bounded) cfg.current.onDrop(i, bounded);
            };
            reset(i);
            // measureInWindow is async, and a drag quick enough can be over
            // before it answers — which silently dropped the whole gesture.
            // Nothing but the dragged row MOVES during a drag, so measuring
            // now is just as true as measuring at the grant: take the late
            // answer rather than throwing the drag away.
            if (mids.current.size === 0) void measure().then(drop);
            else drop();
          },
          onPanResponderTerminate: () => reset(i),
        }),
      );
    }
    return responders.current.get(i)!.panHandlers;
  };

  return { ...ui, registerRow, handleFor, liveSlot: slotStore.current.api };
}

function SlotLine({ slot, at, style }: { slot: RowDrag['liveSlot']; at: number; style: object }) {
  const on = useSyncExternalStore(slot.subscribe, () => slot.get() === at);
  return on ? createElement(RNView, { style }) : null;
}

/**
 * The drop line of a `live` drag: drawn at boundary `at` while the live slot
 * is there, and it alone re-renders as the slot moves. Pass `drag.liveSlot` (stable, so a memoised row can take it) and the
 * screen's own dropLine style. For callers that did not ask for `live` it never draws —
 * they keep reading `drag.slot`.
 */
export function DropLine({ slot, at, style }: { slot: RowDrag['liveSlot']; at: number; style: object }) {
  return createElement(SlotLine, { slot, at, style });
}

/**
 * The ord key a row takes when it moves from index `from` to `to` in a list
 * already sorted by ord.
 *
 * ordGap rather than the raw neighbours, for the reason set out in order.ts:
 * two rows can carry the SAME key — ordBetween(null, null) is deterministic,
 * so two devices adding the first row to a list while offline both write 'V' —
 * and asking for a key between two equal ones threw, mid-drag, with nothing
 * catching it. manage.ts's movers were fixed first; this one backs the folder,
 * habit-section and calendar drags and had exactly the same exposure.
 */
export function ordForMove<T extends { payload: { ord: string } }>(arr: T[], from: number, to: number): string {
  const rest = arr.filter((_x, i) => i !== from);
  return ordBetween(...ordGap(rest.map((x) => x.payload.ord), to));
}
