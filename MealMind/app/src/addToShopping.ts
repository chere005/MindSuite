/**
 * Putting a recipe's ingredients on the shopping list.
 *
 * Two screens do this now — the Recipes tab's edit mode, over several recipes
 * at once, and the Shop button on the Recipe page, over the one in front of
 * you (the owner, 2026-09-18). It lives here rather than in either of them because
 * the SECOND one is where a rule quietly grows a second version of itself:
 * the pantry filter, where the rows land, and what to say when nothing is
 * added are one behaviour, and a copy of it on the Recipe page would drift
 * the first time one of the three changed.
 *
 * What is NOT here is the combining — same thing, same unit, added together,
 * and the pantry match — which is core's `shoppingLines` and tested there.
 * This owns the store: what the pantry holds, where the rows go, and in what
 * order.
 */
import {
  mergeIntoList, recipeFromPages, shoppingLines, splitRecipeBody,
  type AnyRec, type Rec, type SyncEngine,
} from '@calmind/core';
import { applyOps, shoppingWriteOps } from './chefflows';

/** What happened, for a caller to say in its own words. */
export type ShopResult =
  /** Rows were written: `added` new ones, `merged` folded into rows already
   *  on the list. Either may be zero, but never both. */
  | { ok: true; added: number; merged: number }
  /**
   * Nothing was written, and WHY — three different nothings. A cook who has
   * everything already must not be left wondering whether the button worked,
   * which is a different sentence from a recipe that lists no ingredients.
   */
  | { ok: false; why: 'pantry' | 'empty' | 'notready' };

/**
 * Everything the pantry claims is on hand, as the text of its rows.
 *
 * Read and handed to core rather than filtered afterwards, because core owns
 * the matching — 'flour' must not claim 'almond flour', and 'a pinch of salt'
 * must match plain salt — and that rule belongs in one place with the tests
 * for it.
 */
export function pantryTexts(recs: readonly AnyRec[]): string[] {
  const folder = recs.find((r): r is Rec<'folder'> =>
    r.type === 'folder' && !r.deleted && r.payload.pantry === true);
  if (!folder) return [];
  const secs = new Set(
    recs.filter((r): r is Rec<'section'> =>
      r.type === 'section' && !r.deleted && r.payload.folderId === folder.id).map((s) => s.id),
  );
  return recs
    .filter((r): r is Rec<'reminder'> =>
      r.type === 'reminder' && !r.deleted && secs.has(r.payload.sectionId))
    .map((r) => r.payload.text);
}

/** The recipe block of a note's body — never the whole body, which may carry
 *  ordinary text before and after it, and none of that is shopping. */
export function ingredientsOf(note: Rec<'note'>): string[] {
  return recipeFromPages([splitRecipeBody(note.payload.body)?.recipe ?? note.payload.body]).ingredients;
}

/**
 * Add these ingredient lines to the shopping list.
 *
 * A shopping row IS a reminder — text, an order key, a swipe to delete — so
 * this writes reminders into the shopping folder and everything that already
 * handles reminders handles them.
 *
 * WHAT IS ALREADY ON THE LIST IS COMBINED WITH, not appended beside. The owner,
 * 2026-09-18: "duplicate ingredients i don't have in my pantry should always
 * be combined automatically", of a list carrying two lines of all purpose
 * flour from two different recipes. A single add has always combined within
 * itself; what it could not do was see the list it was landing on, so every
 * add after the first grew a second row for the same thing. There WAS a
 * Refresh button for this and it left the bar on 2026-09-16 — a button for
 * "tidy what you already did" is a worse answer than doing it, and this file
 * is now `recombineLines`'s only caller.
 *
 * A row is rewritten ONLY when something actually folded into it, and it
 * keeps its id and its place. That matters: the alternative — rebuilding the
 * whole list — throws away the order somebody dragged it into and the wording
 * they edited on rows nothing was even added to.
 *
 * What is genuinely new lands at the END, after whatever is already there. A
 * prepend would push a half-shopped list down the screen every time.
 */
export function addToShopping(
  recs: readonly AnyRec[],
  mutate: (fn: (engine: SyncEngine) => void) => void,
  sources: { title: string | null; ingredients: string[] }[],
): ShopResult {
  const lines = shoppingLines(sources, pantryTexts(recs));
  if (lines.length === 0) {
    return { ok: false, why: sources.some((s) => s.ingredients.length > 0) ? 'pantry' : 'empty' };
  }
  return addLinesToShopping(recs, mutate, lines);
}

/**
 * Add these EXACT lines to the shopping list — the Review's write, and the
 * tail of `addToShopping`. Nothing is filtered here (the pantry subtraction
 * already happened, or the cook chose "buy anyway"); lines still COMBINE with
 * rows already on the list (core's `mergeIntoList`), and what is new lands at
 * the end. One `mutate`, built by `shoppingWriteOps` so it can be tested.
 */
export function addLinesToShopping(
  recs: readonly AnyRec[],
  mutate: (fn: (engine: SyncEngine) => void) => void,
  lines: readonly string[],
): ShopResult {
  const w = shoppingWriteOps(recs, lines, mergeIntoList);
  if (!w.ok) return { ok: false, why: w.why };
  mutate((e) => applyOps(e, w.ops));
  return { ok: true, added: w.added, merged: w.merged };
}

/** What to say about a result, in one sentence. `one` is whether a single
 *  recipe was asked about — the empty case reads differently for several. */
export function shopMessage(result: ShopResult, one: boolean): string {
  if (result.ok) {
    const { added, merged } = result;
    if (added === 0) return merged === 1 ? '1 combined with a row already there.' : `${merged} combined with rows already there.`;
    if (merged === 0) return `${added} added to the shopping list.`;
    return `${added} added, ${merged} combined with rows already there.`;
  }
  return result.why === 'pantry' ? 'Everything for that is already in the pantry.'
    : result.why === 'empty' ? (one ? 'That recipe lists no ingredients.' : 'Those recipes list no ingredients.')
      : 'The shopping list is not ready yet — try again in a moment.';
}
