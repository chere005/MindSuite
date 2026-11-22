/**
 * The cooking SESSION: what a person has built up but not yet written — the
 * recipes picked, the Review they opened (its frozen plan and their choices),
 * and the Cook in progress (tab, step, gather ticks, Finish ticks).
 *
 * It lives in one provider ABOVE both layouts (App mounts it over the phone
 * column and the wide frame), so crossing 900 px — an iPad rotation does — swaps
 * the layout and reopens the same screen with the same state, instead of
 * rebuilding the tree and losing it. The pure functions are here too so a test
 * can read them without a screen.
 */
import { createContext, useContext, useMemo, useRef, useSyncExternalStore, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import type { AnyRec, Rec } from '@calmind/core';
import { ingredientsOf, pantryTexts } from './addToShopping';
import { planFor, reviewLines, type Plan } from './chefflows';

/* ── Review ── */

export type ReviewSource = { title: string | null; ingredients: string[] };

/**
 * An open Review. `plan` is computed ONCE, when the Review opens, and the
 * choices are indices into THAT plan: the store changes under an open Review
 * (a sync, an edit on another device), and a plan rebuilt on every change would
 * apply "untick row 2" to whatever row 2 had become. What is written is what
 * the person saw and chose; only the merge targets are read again at write time.
 */
export type ReviewSession = { ids: string[]; sources: ReviewSource[]; plan: Plan; off: number[]; anyway: number[] };

export function newReviewFrom(recs: readonly AnyRec[], ids: string[], sources: ReviewSource[]): ReviewSession {
  return { ids, sources, plan: planFor(recs, sources, pantryTexts(recs)), off: [], anyway: [] };
}

export function newReview(recs: readonly AnyRec[], notes: readonly Rec<'note'>[]): ReviewSession {
  return newReviewFrom(recs, notes.map((n) => n.id), notes.map((n) => ({ title: n.payload.title as string | null, ingredients: ingredientsOf(n) })));
}

/** The lines Add writes: exactly the frozen plan's ticked rows and Buy-anyway rows. */
export function reviewWriteLines(r: ReviewSession): string[] {
  return reviewLines(r.plan, { off: new Set(r.off), anyway: new Set(r.anyway) });
}

export function flipIn(list: readonly number[], i: number): number[] {
  return list.includes(i) ? list.filter((x) => x !== i) : [...list, i];
}

/* ── Cook ── */

export type CookTabState = { step: number; gathered: number[]; variantId: string | null };
export type CookState = { active: number; tabs: Record<string, CookTabState>; finishOpen: boolean; ticked: string[]; shop: boolean };
export type CookSession = { ids: string[]; first?: string; variantId: string | null; state: CookState };

export function newCookState(active = 0): CookState {
  return { active, tabs: {}, finishOpen: false, ticked: [], shop: true };
}

export function newCook(ids: string[], first?: string, variantId: string | null = null): CookSession {
  const at = first === undefined ? 0 : Math.max(0, ids.indexOf(first));
  return { ids, ...(first !== undefined ? { first } : {}), variantId, state: newCookState(at) };
}

/**
 * Cooking is one recipe by default; another is added from inside Cook (the
 * owner, 2026-11-21: "usually it would just be one recipe, then some other ux
 * to add another one for simultaneous cooking"). The added recipe gets its own
 * tab and becomes the one on screen; one already on the stove is just shown.
 */
export function addToCook(c: CookSession, id: string): CookSession {
  const at = c.ids.indexOf(id);
  if (at >= 0) return at === c.state.active ? c : { ...c, state: { ...c.state, active: at } };
  return { ...c, ids: [...c.ids, id], state: { ...c.state, active: c.ids.length } };
}

/**
 * Take one recipe off the stove: its tab and its progress go, the tab on
 * screen stays on screen (or its neighbour takes over), and dropping the last
 * one ends the Cook (null). The variant the session opened with belonged to
 * the first recipe, so it goes with it rather than passing to whichever tab
 * is first now.
 */
export function dropFromCook(c: CookSession, id: string): CookSession | null {
  const at = c.ids.indexOf(id);
  if (at < 0) return c;
  const ids = c.ids.filter((x) => x !== id);
  if (ids.length === 0) return null;
  const tabs = Object.fromEntries(Object.entries(c.state.tabs).filter(([k]) => k !== id));
  const a = c.state.active;
  const active = at < a ? a - 1 : Math.min(a, ids.length - 1);
  const head = c.first === id ? { variantId: null } : { ...(c.first !== undefined ? { first: c.first } : {}), variantId: c.variantId };
  return { ids, ...head, state: { ...c.state, active, tabs } };
}

/** Ids that still name a live record, in order. Returns the same array when nothing left. */
export function pruneIds(ids: readonly string[], live: ReadonlySet<string>): string[] {
  const next = ids.filter((id) => live.has(id));
  return next.length === ids.length ? (ids as string[]) : next;
}

/* ── The store ── */

export type SessionData = { picked: string[]; review: ReviewSession | null; cook: CookSession | null };

/**
 * One plain external store, created once above both layouts. The phone tree and
 * the wide tree each READ it; neither owns it, so unmounting one and mounting
 * the other (crossing 900 px) shows the same session. Being plain (no React) is
 * what lets a test cross the line: write through one "layout", read through the
 * other.
 */
export type SessionStore = {
  get: () => SessionData;
  set: (fn: (d: SessionData) => SessionData) => void;
  subscribe: (fn: () => void) => () => void;
};

export function createSessionStore(): SessionStore {
  let data: SessionData = { picked: [], review: null, cook: null };
  const subs = new Set<() => void>();
  return {
    get: () => data,
    set: (fn) => { const next = fn(data); if (next !== data) { data = next; subs.forEach((f) => f()); } },
    subscribe: (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}

const resolve = <T,>(a: SetStateAction<T>, cur: T): T => (typeof a === 'function' ? (a as (c: T) => T)(cur) : a);

/** The setters over a store; the hook and the tests share them. */
export function sessionActions(store: SessionStore) {
  return {
    setPicked: ((a) => store.set((d) => { const picked = resolve(a, d.picked); return picked === d.picked ? d : { ...d, picked }; })) as Dispatch<SetStateAction<string[]>>,
    setReview: ((a) => store.set((d) => { const review = resolve(a, d.review); return review === d.review ? d : { ...d, review }; })) as Dispatch<SetStateAction<ReviewSession | null>>,
    setCook: ((a) => store.set((d) => { const cook = resolve(a, d.cook); return cook === d.cook ? d : { ...d, cook }; })) as Dispatch<SetStateAction<CookSession | null>>,
    setCookState: (fn: (s: CookState) => CookState) => store.set((d) => (d.cook ? { ...d, cook: { ...d.cook, state: fn(d.cook.state) } } : d)),
  };
}

type Value = SessionData & ReturnType<typeof sessionActions>;

const Ctx = createContext<SessionStore | null>(null);

export function ChefSessionProvider({ children }: { children: ReactNode }) {
  const store = useRef<SessionStore>(null as unknown as SessionStore);
  if (!store.current) store.current = createSessionStore();
  return <Ctx.Provider value={store.current}>{children}</Ctx.Provider>;
}

export function useChefSession(): Value {
  const store = useContext(Ctx);
  if (!store) throw new Error('useChefSession needs a ChefSessionProvider');
  const data = useSyncExternalStore(store.subscribe, store.get, store.get);
  const actions = useMemo(() => sessionActions(store), [store]);
  return useMemo(() => ({ ...data, ...actions }), [data, actions]);
}
