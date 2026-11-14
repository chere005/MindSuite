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
 * ONE RULE for the picture and the result (`place`): the row is drawn at its
 * home plus the pointer's whole travel since the grant, the line sits where
 * that centre would land, and the release drops exactly there. No midpoint
 * is read off a node once a shift of this drag may be on it — the grant's
 * measure is answered before any shift is drawn, a dragDy screen's `dragIdx`
 * names the dragged row by key in every render (so no neighbour is ever
 * drawn shifted), and a later measure carries the home, and the midpoint of
 * any row it may have seen shifted, from a neighbour no shift of this drag
 * has been drawn on — because measureInWindow answers late
 * (react-native-web from a setTimeout that a queued pointer move runs ahead
 * of; native over the bridge), and whether its answer includes a transform
 * already drawn differs by platform. A home that held the travel had it added
 * twice, and a quick drag overshot (e2e/dragquick.spec.ts).
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
export type RowDragOptions = {
  live?: boolean;
  /**
   * A stable identity for flat entry `i` (null when there is none), read live
   * at the grant and again at the drop. Indices are only true for the list as
   * it was when the drag began; a background pull, or a second tab, can insert,
   * remove or reorder rows mid-drag. With `keyOf`, the drop names the dragged
   * entry and the entry it lands on by key, re-finds both in the list as it
   * is NOW, and cancels (nothing moves) when either is gone or the two have
   * swapped sides. Without it the drop is by index, as before.
   */
  keyOf?: (i: number) => string | null;
};

/** The key of a flat screen entry: a row by its record's id, a head or an empty placeholder by its section. */
export function flatKey(e: { kind: 'row' | 'empty' | 'head'; sectionId: string; rec?: { id: string } } | undefined): string | null {
  if (!e) return null;
  return e.kind === 'row' ? (e.rec ? `row:${e.rec.id}` : null) : `${e.kind}:${e.sectionId}`;
}

/** A measured entry: its window-space top and bottom. */
type Edge = { top: number; bot: number };

/**
 * One measure of the list, and where the dragged row's HOME (its untouched
 * midpoint) sits in it. `home` is never read off the dragged row's own node
 * once the row may have been shifted: the grant's measure is taken before
 * any shift is drawn, and a later measure (after the row's index moved)
 * carries the home, and any midpoint it may have seen shifted, from rows
 * this drag has not drawn shifted (carryEpoch).
 * Null when no home could be placed, which shows no drop line and cancels
 * the drop.
 */
type Epoch = {
  mids: Map<number, number>;
  edges: Map<number, Edge>;
  /** The flat list's keys when this measure was asked for, or null when the caller gave no keyOf. */
  keys: (string | null)[] | null;
  count: number;
  /** The dragged entry's index in this measure's list. */
  idx: number;
  home: number | null;
  /** Entries this measure may have seen with a shift of this drag drawn on them: never carried from. */
  suspect: Set<number>;
};

/** One drag's own state: nothing here outlives the gesture, so nothing leaks into the next one. */
type Session = {
  /** The entry the gesture was granted on, and the dragged entry's key then (null without keyOf). */
  from: number;
  dragKey: string | null;
  keyed: boolean;
  /** The dragged entry's index now: the responder that last saw the gesture. */
  at: number;
  /** The latest measure that has answered; null until the grant's own measure answers. */
  epoch: Epoch | null;
  /** The latest measure asked for, and whether it has answered. */
  ready: Promise<void>;
  pending: boolean;
  /** The pointer's Y at the grant and at the latest move, whichever responder saw it (null when the platform gave none). */
  startY: number | null;
  lastY: number | null;
  /** The dragged row's travel since the grant, as last computed. */
  travel: number;
  /** The node a live drag last shifted, so a reset clears the right one. */
  node: View | undefined;
  /**
   * Every node a live drag has drawn shifted. A dragDy screen needs no such
   * record: with keys, the `dragIdx` it renders is the dragged row's index in
   * the list of that very render (see the hook's return), so no other row is
   * ever drawn shifted.
   */
  shiftedNodes: Set<View>;
  /** The current list's keys, cached per render of the hook (keyOf is read live). */
  curKeys: (string | null)[] | null;
  curVer: number;
  over: boolean;
};

/**
 * Re-find a drop made against a measured list in the list as it is now.
 * Null cancels the drop: the dragged entry or its landing entry is gone, or
 * the list changed so that the move no longer points the same way.
 */
function resolveDrop(
  was: (string | null)[],
  from: number,
  to: number,
  cur: (string | null)[],
): { from: number; to: number } | null {
  if (cur.length === was.length && cur.every((k, x) => k === was[x])) return { from, to };
  const dragKey = was[from];
  const anchorKey = was[to];
  if (dragKey == null || anchorKey == null) return null;
  const f = cur.indexOf(dragKey);
  const t = cur.indexOf(anchorKey);
  if (f < 0 || t < 0) return null;
  if (Math.sign(to - from) !== Math.sign(t - f)) return null;
  return { from: f, to: t };
}

/** Move a registered row by `dy` without a render: DOM node on web, native props elsewhere. */
function shiftNode(node: View | undefined, dy: number) {
  if (!node) return;
  const n = node as unknown as { setNativeProps?: (p: object) => void; style?: CSSStyleDeclaration };
  if (typeof n.setNativeProps === 'function') n.setNativeProps({ style: { transform: [{ translateY: dy }] } });
  else if (n.style) n.style.transform = dy === 0 ? '' : `translateY(${dy}px)`;
}

/** The classic sortable rule, on measured geometry: the dragged row's
 *  DISPLACED midpoint (its home + total travel — so where you grabbed it
 *  cancels out) is compared against every other row's midpoint, and the
 *  count it has passed is its destination index. Crossing a row's centre is
 *  what swaps with it, whatever anyone's height is. */
function destFor(mids: Map<number, number>, i: number, home: number, dy: number): number | null {
  // A hair of direction-aware bias so an exact tie of centres resolves the
  // way the drag is heading instead of falling dead on the knife edge.
  const c = home + dy + (dy > 0 ? 0.5 : -0.5);
  let k = 0;
  for (const [j, mid] of mids) {
    if (j !== i && mid < c) k++;
  }
  return k === i ? null : k;
}

/**
 * How far entry `t` of a new measure (entry `pt` of the last one) has moved
 * since the last measure, read off a row that kept its place relative to it
 * (the same keys between them, so the same heights): that row has moved
 * exactly as far. The nearest such row on either side is used, skipping the
 * dragged row (`f`, `prev.idx`) and any row that either measure may have seen
 * shifted by this drag: a live drag shifts the node at the responder's index,
 * and a move that reaches a responder before the screen re-rendered its
 * grips after a list change shifts a neighbour, which a synchronous native
 * measure (Fabric) or a late web one can read. Null when no such row exists.
 */
function carry(
  prev: Epoch, keys: (string | null)[], t: number, pt: number, f: number, edges: Map<number, Edge>, suspect: Set<number>,
): number | null {
  if (!prev.keys || t < 0 || pt < 0) return null;
  const pkeys = prev.keys;
  const from = (dir: -1 | 1): number | null => {
    for (let d = 1; ; d++) {
      const k = t + dir * d;
      const pk = pt + dir * d;
      const key = keys[k];
      if (k < 0 || pk < 0 || key == null || pkeys[pk] !== key) return null;
      if (k === f || pk === prev.idx || suspect.has(k) || prev.suspect.has(pk)) continue;
      const was = prev.edges.get(pk);
      const now = edges.get(k);
      if (!was || !now) return null;
      return dir < 0 ? now.bot - was.bot : now.top - was.top;
    }
  };
  return from(-1) ?? from(1);
}

/**
 * The dragged row's home in a new measure, and every OTHER row's midpoint
 * there, read so that no shift of this drag can be in them. The dragged row's
 * own node is never read: whether a measure includes the transform already
 * drawn on it differs by platform and by timing. Its home is carried from the
 * last measure (carry). A row this measure may have seen shifted has its
 * midpoint carried the same way from the last measure, whose midpoints are
 * clean by the same rule (the grant's measure is taken before any shift is
 * drawn) — counting a shifted neighbour's drawn midpoint put the drop one row
 * off once the drag passed it. When either cannot be carried, there is no
 * home: no line, and the drop is cancelled rather than placed wrong.
 */
function carryEpoch(
  prev: Epoch, keys: (string | null)[], f: number, edges: Map<number, Edge>, mids: Map<number, number>, suspect: Set<number>,
): number | null {
  if (prev.home === null || !prev.keys || f < 0) return null;
  const dh = carry(prev, keys, f, prev.idx, f, edges, suspect);
  if (dh === null) return null;
  for (const k of suspect) {
    if (k === f || !mids.has(k)) continue;
    const pk = keys[k] == null ? -1 : prev.keys.indexOf(keys[k]);
    const was = prev.mids.get(pk);
    const d = carry(prev, keys, k, pk, f, edges, suspect);
    if (was === undefined || d === null) return null;
    mids.set(k, was + d);
  }
  return prev.home + dh;
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
  const cfg = useRef({ count, onDrop, keyOf: options?.keyOf, ver: 0 });
  // Every render may carry a changed list; `ver` tells a drag to read the keys again.
  cfg.current = { count, onDrop, keyOf: options?.keyOf, ver: cfg.current.ver + 1 };
  const rows = useRef(new Map<number, View>());
  // The drag in progress: its own measures and its own keys.
  const sess = useRef<Session | null>(null);
  const responders = useRef(new Map<number, PanResponderInstance>());

  const registerRow = (i: number) => (ref: View | null) => {
    if (ref) rows.current.set(i, ref);
    else rows.current.delete(i);
  };

  const keysNow = (): (string | null)[] | null => {
    const { count: n, keyOf } = cfg.current;
    if (!keyOf) return null;
    const keys: (string | null)[] = [];
    for (let k = 0; k < n; k++) keys.push(keyOf(k));
    return keys;
  };

  const curKeys = (s: Session): (string | null)[] => {
    if (s.curVer !== cfg.current.ver || !s.curKeys) { s.curKeys = keysNow() ?? []; s.curVer = cfg.current.ver; }
    return s.curKeys;
  };

  const measure = async (): Promise<{ edges: Map<number, Edge>; refs: Map<number, View> }> => {
    const entries = [...rows.current.entries()];
    const measured = await Promise.all(
      entries.map(
        ([i, ref]) =>
          new Promise<{ i: number; e: Edge }>((res) =>
            ref.measureInWindow((_x, y, _w, h) => res({ i, e: { top: y, bot: y + h } })),
          ),
      ),
    );
    return { edges: new Map(measured.map((m) => [m.i, m.e])), refs: new Map(entries) };
  };

  /** Ask for a measure of the list as it is now; the newest one asked for is the one that counts. */
  const remeasure = (s: Session) => {
    const keys = keysNow();
    const n = cfg.current.count;
    s.pending = true;
    const p: Promise<void> = measure().then(({ edges, refs }) => {
      if (s.ready !== p) return;
      const mids = new Map<number, number>();
      for (const [i, e] of edges) mids.set(i, (e.top + e.bot) / 2);
      // Whatever this drag has shifted so far may be in this answer, committed or not.
      const suspect = new Set<number>();
      for (const [i, r] of refs) if (s.shiftedNodes.has(r)) suspect.add(i);
      const prev = s.epoch;
      let idx: number;
      let home: number | null;
      if (!prev) {
        // The first measure to answer (the grant's, or one asked for after
        // the list changed before it answered). No shift is drawn until it
        // answers (see place), so every node, the dragged row's own
        // included, is still at home. By key: the list may have changed
        // since the grant.
        idx = keys && s.dragKey !== null ? keys.indexOf(s.dragKey) : s.from;
        home = mids.get(idx) ?? null;
      } else {
        idx = keys && s.dragKey !== null ? keys.indexOf(s.dragKey) : s.at;
        home = keys ? carryEpoch(prev, keys, idx, edges, mids, suspect) : null;
      }
      s.epoch = { mids, edges, keys, count: n, idx, home, suspect };
      s.pending = false;
      if (sess.current === s) draw(s, s.at);
    });
    s.ready = p;
  };

  const begin = (from: number, y0?: number): Session => {
    const keys = keysNow();
    const s: Session = {
      from, dragKey: keys ? keys[from] ?? null : null, keyed: keys !== null, at: from,
      epoch: null, ready: Promise.resolve(), pending: false,
      startY: y0 && y0 > 0 ? y0 : null, lastY: null, travel: 0, node: undefined,
      shiftedNodes: new Set(),
      curKeys: keys, curVer: cfg.current.ver, over: false,
    };
    remeasure(s);
    return s;
  };

  /** The pointer's whole travel since the grant, whichever responder saw it; a responder's own dy when the platform gives no Y. */
  const travelOf = (s: Session, g: { dy?: number; moveY?: number } | undefined): number => {
    const y = g?.moveY !== undefined && g.moveY > 0 ? g.moveY : s.lastY;
    if (s.startY !== null && y !== null) return y - s.startY;
    return g?.dy ?? s.travel;
  };

  /** The dragged row's index now changed (a row arrived or left above it): its grip came to responder `i`. */
  const follow = (s: Session, i: number) => {
    if (i === s.at) return;
    s.at = i;
    // The measure names other rows now; place() shows no line until the new
    // one answers, and the draw that follows takes the old line down.
    if (s.keyed && !s.over) remeasure(s);
  };

  /**
   * THE rule, for the picture and the result alike: where the dragged row is
   * drawn (its home plus the travel), the drop line, and the drop the release
   * makes. Nothing is drawn shifted until the grant's own measure has
   * answered, so that measure can never include the shift.
   */
  const place = (s: Session): { shift: number; drop: { from: number; to: number } | null; slot: number | null } => {
    const e = s.epoch;
    if (!e) return { shift: 0, drop: null, slot: null };
    const shift = s.travel;
    // Without keys the responder follows its row by index: the grip is handed
    // to the responder of the NEW index, and `at` is the row's live one
    // (dragunder.spec), read against the grant's midpoints as before.
    const idx = s.keyed ? e.idx : s.at;
    if (s.keyed && (e.idx !== s.at || s.pending)) return { shift, drop: null, slot: null };
    const home = s.keyed ? e.home : e.mids.get(idx) ?? null;
    if (home === null || idx < 0) return { shift, drop: null, slot: null };
    const to = destFor(e.mids, idx, home, shift);
    if (to === null) return { shift, drop: null, slot: null };
    const bounded = Math.max(0, Math.min(e.count - 1, to));
    if (bounded === idx) return { shift, drop: null, slot: null };
    // By id when the caller gave keys: the list may have changed since the
    // measure, and an index would then name another row.
    const drop = e.keys ? resolveDrop(e.keys, idx, bounded, curKeys(s)) : { from: idx, to: bounded };
    if (!drop) return { shift, drop: null, slot: null };
    return { shift, drop, slot: drop.to > drop.from ? drop.to + 1 : drop.to };
  };

  const draw = (s: Session, i: number) => {
    const p = place(s);
    if (live) {
      const node = rows.current.get(i);
      if (s.node && s.node !== node) shiftNode(s.node, 0);
      s.node = node;
      shiftNode(node, p.shift);
      if (node && p.shift !== 0) s.shiftedNodes.add(node);
      setLiveSlot(p.slot);
    } else {
      setUi({ dragIdx: i, dragDy: p.shift, slot: p.slot });
    }
  };

  const reset = (s: Session | null) => {
    sess.current = null;
    if (live) {
      // Exactly the node this drag shifted: after a list change the row at
      // index `i` can be another one.
      if (s?.node) shiftNode(s.node, 0);
      setLiveSlot(null);
    }
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
          onPanResponderGrant: (_e, g) => {
            setUi({ dragIdx: i, dragDy: 0, slot: null });
            setLiveSlot(null);
            sess.current = begin(i, g?.y0);
          },
          onPanResponderMove: (_e, g) => {
            const s = sess.current;
            if (!s) return;
            if (g.moveY > 0) s.lastY = g.moveY;
            s.travel = travelOf(s, g);
            follow(s, i);
            draw(s, i);
          },
          onPanResponderRelease: (_e, g) => {
            // Compute from the RELEASE's own travel, not the last move — a
            // fast flick can land with barely any move events processed.
            const s = sess.current;
            reset(s);
            if (!s) return;
            if (g?.moveY !== undefined && g.moveY > 0) s.lastY = g.moveY;
            s.travel = travelOf(s, g);
            follow(s, i);
            s.over = true;
            const drop = () => {
              const p = place(s);
              if (p.drop) cfg.current.onDrop(p.drop.from, p.drop.to);
            };
            // measureInWindow is async, and a drag quick enough can be over
            // before it answers — which silently dropped the whole gesture.
            // Wait for THIS drag's own measure (never an earlier drag's
            // midpoints), the newest one it asked for (none can be asked for
            // after this: the drag is over), and drop on its answer.
            if (!s.pending) drop();
            else void s.ready.then(drop);
          },
          onPanResponderTerminate: () => reset(sess.current),
        }),
      );
    }
    return responders.current.get(i)!.panHandlers;
  };

  // A keyed drag names its row by key in every render: when the list changes
  // under it, `ui.dragIdx` (the responder's index, set by the last handler)
  // names another row until the next move, and a dragDy screen drew the
  // shift on that neighbour — where a measure (synchronous on native, late on
  // web) then read it, and the drop counted it. Read here, in the render that
  // draws it, the index is always the dragged row's own. When the row is gone
  // the old index stays (the drop is cancelled anyway; the screen keeps its
  // scroll frozen).
  let dragIdx = ui.dragIdx;
  const cur = sess.current;
  if (cur && cur.keyed && cur.dragKey !== null && dragIdx !== null && options?.keyOf?.(dragIdx) !== cur.dragKey) {
    for (let k = 0; k < count; k++) if (options?.keyOf?.(k) === cur.dragKey) { dragIdx = k; break; }
  }
  return { ...ui, dragIdx, registerRow, handleFor, liveSlot: slotStore.current.api };
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
