/**
 * The pure half of MealMind's cooking flows: Review, Done shopping, the
 * pantry's Ran out, and Finish cooking.
 *
 * Every flow here ends in WRITES, and a screen that builds its own writes
 * cannot be tested without a screen. So the decisions live in functions that
 * take the records and return OPS (a put or a delete), and the screens are
 * plumbing: read the records, ask, hand the ops to the store's ONE `mutate`.
 * One mutate per flow is also what makes a flow all-or-nothing — Done shopping
 * deletes the bought rows and creates the pantry rows in the same call, so a
 * failure cannot leave the items on neither list.
 *
 * What is NOT here is anything about matching, combining or aisles: that is
 * core's (`shoppingPlan`, `doneShoppingPlan`, `pantryUsedBy`, `pantryUsedIn`,
 * tested there).
 */
import {
  AISLES, byRecOrd, findVariant, isSubheader, liveSections, newId, ordBetween, pantryHas,
  recipeFromPages, shoppingPlan, splitRecipeBody, variantBody,
  type Aisle, type AnyRec, type Rec, type SyncEngine,
} from '@calmind/core';

/** One write. The store's `mutate` takes a function over the engine; this is
 *  the same thing as data, so a test can read it. */
export type Op = { kind: 'put'; rec: AnyRec } | { kind: 'del'; id: string };

export function applyOps(e: SyncEngine, ops: readonly Op[]): void {
  for (const op of ops) {
    if (op.kind === 'put') e.put(op.rec);
    else e.del(op.id);
  }
}

type Reminder = Rec<'reminder'>;
export type ListKind = 'shopping' | 'pantry';

/** A shopping or pantry list as the records hold it: its folder, its first
 *  section (where rows go) and its rows in stored order. `null` while the
 *  store has not hydrated — normalize guarantees all of it afterwards. */
export function listOf(recs: readonly AnyRec[], kind: ListKind):
  { folderId: string; sectionId: string; rows: Reminder[] } | null {
  const folder = recs.find((r): r is Rec<'folder'> => r.type === 'folder' && !r.deleted && r.payload[kind] === true);
  if (!folder) return null;
  const section = recs
    .filter((r): r is Rec<'section'> => r.type === 'section' && !r.deleted && r.payload.folderId === folder.id)
    .sort(byRecOrd)[0];
  if (!section) return null;
  const rows = recs
    .filter((r): r is Reminder => r.type === 'reminder' && !r.deleted && r.payload.sectionId === section.id)
    .sort(byRecOrd);
  return { folderId: folder.id, sectionId: section.id, rows };
}

/** A new row at the END of a list. `prev` is the order key of whatever is
 *  last; the caller threads the returned key into the next row, because
 *  `ordBetween(prev, null)` is deterministic and asking it the same question
 *  twice hands two rows one key. */
export function newRow(
  list: { folderId: string; sectionId: string },
  text: string,
  prev: string | null,
  id: string,
  done = false,
): { rec: Reminder; ord: string } {
  const ord = ordBetween(prev, null);
  return {
    ord,
    rec: {
      id, type: 'reminder', updated: 0,
      payload: { text, due: null, time: null, done, repeat: null, folderId: list.folderId, sectionId: list.sectionId, indent: 0, ord },
    },
  };
}

/* ── Reading a recipe the way the Recipe page does ─────────────────────── */

/** What the Cook and Review screens need out of one recipe note. The recipe
 *  BLOCK is parsed, never the whole body (prose around it is not a step), by
 *  the same two calls the Recipe page and `ingredientsOf` make. */
export function readRecipe(
  note: Rec<'note'>,
  variantId: string | null = null,
): { ingredients: string[]; steps: string[] } {
  const variant = findVariant(note.payload.variants, variantId);
  const body = variant
    ? variantBody(note.payload.body, liveSections(note.payload.body, variant))
    : note.payload.body;
  const parts = recipeFromPages([splitRecipeBody(body)?.recipe ?? body]);
  return { ingredients: parts.ingredients, steps: parts.steps };
}

/** The ingredient lines Cook's Gather list shows, with the subheaders marked
 *  so the screen can draw them as headings instead of as things to tick. */
export function gatherItems(ingredients: readonly string[]): { text: string; heading: boolean }[] {
  return ingredients
    .map((t) => t.trim())
    .filter((t) => t !== '')
    .map((t) => ({ text: isSubheader(t) ? t.replace(/:$/, '') : t, heading: isSubheader(t) }));
}

/** The steps Cook walks through. A subheader is not a step: it is carried as
 *  the `heading` of the step after it, so the cook sees "For the sauce" over
 *  the step it applies to and the count says "Step 3 of 6", not 8. */
export function cookSteps(steps: readonly string[]): { n: number; text: string; heading: string | null }[] {
  const out: { n: number; text: string; heading: string | null }[] = [];
  let heading: string | null = null;
  for (const raw of steps) {
    const t = raw.trim();
    if (t === '') continue;
    if (isSubheader(t)) { heading = t.replace(/:$/, ''); continue; }
    out.push({ n: out.length + 1, text: t, heading });
    heading = null;
  }
  return out;
}

/** Move the current step one way, never off either end. */
export function stepTo(current: number, dir: 1 | -1, total: number): number {
  if (total <= 0) return 0;
  return Math.min(total - 1, Math.max(0, current + dir));
}

/** Cook's keyboard: Space is next, Shift+Space is back, and nothing at all
 *  while a text field has the focus (Space must still type a space). */
export function cookKey(e: { key: string; shiftKey: boolean; target?: { tagName?: string; isContentEditable?: boolean } | null }): 'next' | 'back' | null {
  if (e.key !== ' ') return null;
  const tag = e.target?.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return null;
  return e.shiftKey ? 'back' : 'next';
}

/* ── Recipe list: how much is left to buy ──────────────────────────────── */

/**
 * "2 to buy" / "Have everything" — the number per recipe, cached by what it
 * depends on. The count reads every ingredient line against the whole pantry,
 * and the list screen re-renders on every edit of every record, so recomputing
 * for each recipe each time would put a parse of the whole cookbook under a
 * keystroke. A recipe is recomputed only when ITS body or the pantry changed.
 */
export function stillToBuyCounts(
  notes: readonly Rec<'note'>[],
  pantry: readonly string[],
  count: (ingredients: readonly string[], pantry: readonly string[]) => number,
  ingredientsOf: (n: Rec<'note'>) => string[],
  cache: Map<string, { body: string; key: string; n: number }>,
): Map<string, number> {
  const key = pantry.join('\u0001');
  const out = new Map<string, number>();
  const live = new Set<string>();
  for (const n of notes) {
    live.add(n.id);
    const hit = cache.get(n.id);
    if (hit && hit.body === n.payload.body && hit.key === key) { out.set(n.id, hit.n); continue; }
    const c = count(ingredientsOf(n), pantry);
    cache.set(n.id, { body: n.payload.body, key, n: c });
    out.set(n.id, c);
  }
  for (const id of [...cache.keys()]) if (!live.has(id)) cache.delete(id);
  return out;
}

/** The label on a recipe row. */
export function toBuyLabel(n: number): string {
  return n === 0 ? 'Have everything' : `${n} to buy`;
}

/* ── Review ─────────────────────────────────────────────────────────────── */

export type Plan = ReturnType<typeof shoppingPlan>;

/** What the Review's two kinds of box say. Indices are into `plan.toBuy` and
 *  `plan.inPantry` OF THE PLAN FROZEN WHEN THE REVIEW OPENED (`newReview` in
 *  session.tsx). They are meaningless against a plan rebuilt later: the store
 *  changes under an open Review, and a fresh plan reorders the rows. */
export type ReviewChoice = { off: ReadonlySet<number>; anyway: ReadonlySet<number> };

/** The lines the Review writes: every ticked "to buy" row, then every
 *  "buy anyway" pantry row — and nothing else. */
export function reviewLines(plan: Plan, choice: ReviewChoice): string[] {
  const out: string[] = [];
  plan.toBuy.forEach((r, i) => { if (!choice.off.has(i)) out.push(r.text); });
  plan.inPantry.forEach((r, i) => { if (choice.anyway.has(i)) out.push(r.text); });
  return out;
}

/** "To buy", by aisle in AISLES order, each row keeping its plan index. */
export function groupByAisle<T extends { aisle: Aisle }>(rows: readonly T[]): { aisle: Aisle; rows: { row: T; index: number }[] }[] {
  const by = new Map<Aisle, { row: T; index: number }[]>();
  rows.forEach((row, index) => {
    const a = by.get(row.aisle);
    if (a) a.push({ row, index }); else by.set(row.aisle, [{ row, index }]);
  });
  return AISLES.filter((a) => by.has(a)).map((aisle) => ({ aisle, rows: by.get(aisle)! }));
}

/** The row an incoming line would fold into, by line text. */
export function mergeNotes(plan: Plan): Map<string, string> {
  return new Map(plan.merges.map((m) => [m.text, m.into]));
}

/** The shopping rows still to buy (not ticked into the cart): the only rows a
 *  new line may merge into. */
export function openRows(recs: readonly AnyRec[]): Reminder[] {
  return (listOf(recs, 'shopping')?.rows ?? []).filter((r) => !r.payload.done);
}

/** The plan for these recipes against this pantry and this list. */
export function planFor(
  recs: readonly AnyRec[],
  sources: { title: string | null; ingredients: string[] }[],
  pantry: readonly string[],
): Plan {
  // A row already in the cart is bought: nothing folds into it.
  return shoppingPlan(sources, pantry, openRows(recs).map((r) => r.payload.text));
}

/** "22 ingredients from 3 recipes", counting what the cook wrote: real lines,
 *  not subheaders. */
export function reviewSummary(sources: readonly { ingredients: readonly string[] }[]): { ingredients: number; recipes: number } {
  let n = 0;
  for (const s of sources) for (const l of s.ingredients) { const t = l.trim(); if (t !== '' && !isSubheader(t)) n++; }
  return { ingredients: n, recipes: sources.length };
}

/* ── Writing lines to the shopping list ────────────────────────────────── */

export type ShoppingWrite =
  | { ok: true; ops: Op[]; added: number; merged: number }
  | { ok: false; why: 'empty' | 'notready' };

/**
 * The ops that put these lines on the shopping list, combining with what is
 * already there (core's `mergeIntoList`) rather than appending beside it.
 *
 * A row is rewritten ONLY when something folded into it, and keeps its id and
 * its place; what is new lands at the END, each key made from the one before.
 * `mergeInto` is core's `mergeIntoList`, passed in so this file stays free of
 * a second import of the same rule and a test can see what it was handed.
 */
export function shoppingWriteOps(
  recs: readonly AnyRec[],
  lines: readonly string[],
  mergeInto: (existing: readonly string[], incoming: readonly string[]) => { kept: string[]; added: string[] },
  idOf: () => string = newId,
): ShoppingWrite {
  const clean = lines.map((l) => l.trim()).filter((l) => l !== '');
  if (clean.length === 0) return { ok: false, why: 'empty' };
  const list = listOf(recs, 'shopping');
  if (!list) return { ok: false, why: 'notready' };
  // Only NOT-done rows are merge targets: folding "2 eggs" into a ticked
  // "6 eggs" would make "8 eggs", still ticked, and Done shopping would put
  // the 2 never bought in the pantry. If the only match is done, the line is
  // added as a new, unticked row.
  const targets = list.rows.filter((r) => !r.payload.done);
  const { kept, added } = mergeInto(targets.map((r) => r.payload.text), clean);
  const ops: Op[] = [];
  let merged = 0;
  targets.forEach((row, i) => {
    const text = kept[i] as string;
    if (text !== row.payload.text) { ops.push({ kind: 'put', rec: { ...row, payload: { ...row.payload, text } } }); merged++; }
  });
  let prev = list.rows.slice(-1)[0]?.payload.ord ?? null;
  for (const text of added) {
    const r = newRow(list, text, prev, idOf());
    prev = r.ord;
    ops.push({ kind: 'put', rec: r.rec });
  }
  return { ok: true, ops, added: added.length, merged };
}

/* ── Shopping: tick = in the cart ──────────────────────────────────────── */

export function toggleCartOp(row: Reminder): Op {
  return { kind: 'put', rec: { ...row, payload: { ...row.payload, done: !row.payload.done } } };
}

/* ── Done shopping ──────────────────────────────────────────────────────── */

export type DoneResult =
  | { ok: true; ops: Op[]; put: number; removed: number }
  | { ok: false; why: 'notready' };

/**
 * Done shopping: a pantry row for each ticked name, and EVERY done shopping
 * row deleted, ticked for the pantry or not — "in the cart" means bought,
 * whether or not it is the kind of thing a pantry keeps.
 *
 * New pantry rows go at the end of the pantry folder's first section, the way
 * a typed one does. The pantry holds each thing once, so a name the pantry
 * already has (or that an earlier name in this very batch already covers) is
 * not written twice — but its shopping row still goes.
 *
 * With no pantry to write to and names to write, NOTHING is returned: deleting
 * the bought rows without their pantry rows would lose the items.
 */
export function doneShoppingOps(
  recs: readonly AnyRec[],
  names: readonly string[],
  doneIds: readonly string[],
  idOf: () => string = newId,
): DoneResult {
  const clean = names.map((n) => n.trim()).filter((n) => n !== '');
  const pantry = listOf(recs, 'pantry');
  if (clean.length > 0 && !pantry) return { ok: false, why: 'notready' };
  const ops: Op[] = [];
  let put = 0;
  if (pantry) {
    const have = pantry.rows.map((r) => r.payload.text);
    let prev = pantry.rows.slice(-1)[0]?.payload.ord ?? null;
    for (const name of clean) {
      if (pantryHas(have, name)) continue;
      have.push(name);
      const r = newRow(pantry, name, prev, idOf());
      prev = r.ord;
      ops.push({ kind: 'put', rec: r.rec });
      put++;
    }
  }
  for (const id of doneIds) ops.push({ kind: 'del', id });
  return { ok: true, ops, put, removed: doneIds.length };
}

/** The done shopping rows, as `doneShoppingPlan` wants them. */
export function doneRows(recs: readonly AnyRec[]): { id: string; text: string; done: boolean }[] {
  return (listOf(recs, 'shopping')?.rows ?? []).filter((r) => r.payload.done).map((r) => ({ id: r.id, text: r.payload.text, done: true }));
}

/* ── Pantry: Ran out, Remove, Rename ───────────────────────────────────── */

/** "Ran out: add to shopping": the NAME goes onto the shopping list through
 *  the merge path, and the pantry row leaves — one write, so a refusal leaves
 *  the row on the pantry rather than on neither list. */
export function ranOutOps(
  recs: readonly AnyRec[],
  pantryRowId: string,
  mergeInto: Parameters<typeof shoppingWriteOps>[2],
  idOf: () => string = newId,
): ShoppingWrite {
  const row = listOf(recs, 'pantry')?.rows.find((r) => r.id === pantryRowId);
  if (!row) return { ok: false, why: 'empty' };
  const w = shoppingWriteOps(recs, [row.payload.text], mergeInto, idOf);
  if (!w.ok) return w;
  return { ...w, ops: [...w.ops, { kind: 'del', id: row.id }] };
}

/** Rename: a blank name is refused (that is Remove's job), and so is a name
 *  another pantry row already has. */
export function renameOp(recs: readonly AnyRec[], pantryRowId: string, name: string):
  { ok: true; op: Op } | { ok: false; why: 'blank' | 'duplicate' | 'missing' } {
  const t = name.trim();
  if (t === '') return { ok: false, why: 'blank' };
  const rows = listOf(recs, 'pantry')?.rows ?? [];
  const at = rows.findIndex((r) => r.id === pantryRowId);
  if (at < 0) return { ok: false, why: 'missing' };
  if (pantryHas(rows.map((r) => r.payload.text), t, at)) return { ok: false, why: 'duplicate' };
  const row = rows[at]!;
  return { ok: true, op: { kind: 'put', rec: { ...row, payload: { ...row.payload, text: t } } } };
}

/* ── Finish cooking ─────────────────────────────────────────────────────── */

export type FinishResult =
  | { ok: true; ops: Op[]; removed: number; added: number; merged: number }
  | { ok: false; why: 'notready' };

/**
 * Finish: the ticked pantry rows leave the pantry, and — when the box is
 * ticked — go on the shopping list as their names, in the SAME write.
 * `ranOut` holds the pantry rows' text, as `pantryUsedIn` returned it.
 */
export function finishCookingOps(
  recs: readonly AnyRec[],
  ranOut: readonly string[],
  alsoShop: boolean,
  mergeInto: Parameters<typeof shoppingWriteOps>[2],
  idOf: () => string = newId,
): FinishResult {
  const pantry = listOf(recs, 'pantry');
  if (!pantry) return { ok: false, why: 'notready' };
  const gone = pantry.rows.filter((r) => ranOut.includes(r.payload.text));
  const ops: Op[] = gone.map((r) => ({ kind: 'del', id: r.id }));
  let added = 0;
  let merged = 0;
  if (alsoShop && gone.length > 0) {
    const w = shoppingWriteOps(recs, gone.map((r) => r.payload.text), mergeInto, idOf);
    if (!w.ok) return { ok: false, why: 'notready' };
    ops.push(...w.ops);
    added = w.added;
    merged = w.merged;
  }
  return { ok: true, ops, removed: gone.length, added, merged };
}
