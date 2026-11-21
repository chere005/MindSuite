/**
 * The pure half of ChefMind's desktop-size layout: what the recipe table, the
 * recipe pane, the review pane and the aisle columns SAY, worked out from the
 * records so the screens in `src/wide/` stay plumbing and a test can read it.
 *
 * Nothing here matches, combines or files an ingredient: that is core's
 * (`recipeStillToBuy`, `shoppingPlan`, `ingredientAisle`).
 */
import {
  AISLES, byRecOrd, ingredientAisle, ingredientParts, isRecipeNote, isSubheader, recipeStillToBuy,
  type Aisle, type AnyRec, type Rec,
} from '@calmind/core';
import { ingredientsOf } from './addToShopping';
import type { Plan } from './chefflows';

/** What the recipe table shows per recipe. `buy` is null for a note that is
 *  not a recipe (it has no ingredients to count). */
export type RecipeFact = { ingredients: number; buy: number | null };
type FactCache = Map<string, { body: string; key: string; fact: RecipeFact }>;

/**
 * The ingredient count and the still-to-buy count for every recipe, cached by
 * (body, pantry) exactly as `stillToBuyCounts` does for the phone list: the
 * table re-renders on every edit of every record and must not re-parse the
 * cookbook for it.
 */
export function recipeFacts(notes: readonly Rec<'note'>[], pantry: readonly string[], cache: FactCache): Map<string, RecipeFact> {
  const key = pantry.join('\u0001');
  const out = new Map<string, RecipeFact>();
  const live = new Set<string>();
  for (const n of notes) {
    live.add(n.id);
    const hit = cache.get(n.id);
    if (hit && hit.body === n.payload.body && hit.key === key) { out.set(n.id, hit.fact); continue; }
    let fact: RecipeFact;
    if (isRecipeNote(n.payload)) {
      const lines = ingredientsOf(n);
      fact = { ingredients: lines.filter((l) => l.trim() !== '' && !isSubheader(l.trim())).length, buy: recipeStillToBuy(lines, pantry) };
    } else {
      fact = { ingredients: 0, buy: null };
    }
    cache.set(n.id, { body: n.payload.body, key, fact });
    out.set(n.id, fact);
  }
  for (const id of [...cache.keys()]) if (!live.has(id)) cache.delete(id);
  return out;
}

/** The recipe folders (notes app, not the shopping list's), in stored order. */
export function recipeFolders(recs: readonly AnyRec[]): Rec<'folder'>[] {
  return recs
    .filter((r): r is Rec<'folder'> => r.type === 'folder' && !r.deleted && (r.payload.app ?? 'reminders') === 'notes' && !r.payload.shopping && !r.payload.pantry)
    .sort(byRecOrd);
}

/**
 * The notes the table lists, in reading order: folder by folder, section by
 * section, each in its stored order. `folderId` narrows to one folder;
 * `canMake` keeps only recipes with nothing left to buy.
 */
export function recipeRows(
  recs: readonly AnyRec[],
  opts: { folderId: string | null; canMake: boolean; facts: ReadonlyMap<string, RecipeFact> },
): Rec<'note'>[] {
  const folders = recipeFolders(recs).filter((f) => opts.folderId === null || f.id === opts.folderId);
  const sections = recs.filter((r): r is Rec<'section'> => r.type === 'section' && !r.deleted).sort(byRecOrd);
  const notes = recs.filter((r): r is Rec<'note'> => r.type === 'note' && !r.deleted).sort(byRecOrd);
  const out: Rec<'note'>[] = [];
  for (const f of folders) {
    for (const sec of sections) {
      if (sec.payload.folderId !== f.id) continue;
      for (const n of notes) {
        if (n.payload.sectionId !== sec.id) continue;
        if (opts.canMake && opts.facts.get(n.id)?.buy !== 0) continue;
        out.push(n);
      }
    }
  }
  return out;
}

/** "To buy" / "In pantry" for one ingredient line; a subheader is neither. */
export type IngredientState = { text: string; heading: boolean; have: boolean };

/**
 * Each ingredient line of a recipe, tagged by core's own shopping rule: a line
 * is "In pantry" when buying just that line would add nothing. The same rule
 * makes the recipe's "N to buy", so the tags and the count cannot disagree.
 */
export function ingredientStates(ingredients: readonly string[], pantry: readonly string[]): IngredientState[] {
  return ingredients
    .map((t) => t.trim())
    .filter((t) => t !== '')
    .map((t) => (isSubheader(t)
      ? { text: t.replace(/:$/, ''), heading: true, have: false }
      : { text: t, heading: false, have: recipeStillToBuy([t], pantry) === 0 }));
}

/** "2 ingredients still to buy" for the recipe pane's heading. */
export function stillToBuyHeading(states: readonly IngredientState[]): string {
  const real = states.filter((x) => !x.heading);
  const buy = real.filter((x) => !x.have).length;
  return buy === 0 ? `Ingredients · ${real.length}, all in your pantry` : `Ingredients · ${buy} still to buy`;
}

/** "Where the 22 went": to buy, covered by the pantry, and combined. */
export function whereWent(plan: Plan, ingredients: number): { total: number; toBuy: number; covered: number; combined: number } {
  return { total: ingredients, toBuy: plan.toBuy.length, covered: plan.inPantry.length, combined: plan.combined };
}

/** The aisle a list row belongs to, from the same two things core files by. */
export function aisleOfRow(text: string): Aisle {
  const p = ingredientParts(text);
  return ingredientAisle(p.name || text, p.unit);
}

/** Rows grouped under their aisle, aisles in walking order, rows keeping their
 *  stored order inside one. */
export function aisleRuns<T extends { text: string }>(rows: readonly T[]): { aisle: Aisle; rows: T[] }[] {
  const by = new Map<Aisle, T[]>();
  for (const r of rows) {
    const a = aisleOfRow(r.text);
    const list = by.get(a);
    if (list) list.push(r); else by.set(a, [r]);
  }
  return AISLES.filter((a) => by.has(a)).map((aisle) => ({ aisle, rows: by.get(aisle)! }));
}

/** The pantry's "Find in pantry" filter: a case-insensitive substring of the row. */
export function filterRows<T extends { text: string }>(rows: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  return q === '' ? [...rows] : rows.filter((r) => r.text.toLowerCase().includes(q));
}

/** The shopping header's second line: "11 items · 4 in your cart · in aisle order". */
export function shoppingSummary(total: number, inCart: number): string {
  const items = `${total} ${total === 1 ? 'item' : 'items'}`;
  return inCart > 0 ? `${items} · ${inCart} in your cart · in aisle order` : `${items} · in aisle order`;
}

/** The pantry header's second line: "20 things you have · in aisle order". */
export function pantrySummary(total: number): string {
  return `${total} ${total === 1 ? 'thing' : 'things'} you have · in aisle order`;
}

/** The tray's list of picked names, cut at `max` with "and N more". */
export function pickedNames(titles: readonly string[], max = 3): string {
  if (titles.length <= max) return titles.join(', ');
  return `${titles.slice(0, max).join(', ')} and ${titles.length - max} more`;
}
