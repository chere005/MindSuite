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
      fact = { ingredients: lines.filter((l) => l.trim() !== '' && !isSubheader(l.trim())).length, buy: buyCount(lines, pantry) };
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

/** One folder's block in the recipe table: its recipes in reading order. */
export type RecipeGroup = { folder: Rec<'folder'>; notes: Rec<'note'>[] };

/**
 * The table's folder blocks, in the phone's order (stored folder order; each
 * folder's notes section by section, in stored order). `folderId` narrows to
 * one folder. Empty folders keep their block, as on the phone; a note that is
 * in no recipe folder's section is not listed, as on the phone.
 */
export function recipeGroups(recs: readonly AnyRec[], opts: { folderId: string | null }): RecipeGroup[] {
  const folders = recipeFolders(recs).filter((f) => opts.folderId === null || f.id === opts.folderId);
  const sections = recs.filter((r): r is Rec<'section'> => r.type === 'section' && !r.deleted).sort(byRecOrd);
  const notes = recs.filter((r): r is Rec<'note'> => r.type === 'note' && !r.deleted).sort(byRecOrd);
  return folders.map((folder) => {
    const out: Rec<'note'>[] = [];
    for (const sec of sections) {
      if (sec.payload.folderId !== folder.id) continue;
      for (const n of notes) if (n.payload.sectionId === sec.id) out.push(n);
    }
    return { folder, notes: out };
  });
}

/** The notes the groups hold, flat, in table order. */
export function groupedNotes(groups: readonly RecipeGroup[]): Rec<'note'>[] {
  return groups.flatMap((g) => g.notes);
}

/** The recipes a table shows: every folder's, minus the folders that are shut. */
export function shownRecipes(groups: readonly RecipeGroup[], shut: ReadonlySet<string>): Rec<'note'>[] {
  return groups.filter((g) => !shut.has(g.folder.id)).flatMap((g) => g.notes);
}

/** "To buy" / "In pantry" for one ingredient line; a subheader is neither. */
export type IngredientState = { text: string; heading: boolean; have: boolean };

/**
 * Each ingredient line of a recipe, tagged by core's shopping rule: a line is
 * "In pantry" when buying just that line would add nothing. Tags are PER LINE,
 * so an ingredient repeated in a recipe is tagged on each line.
 */
export function ingredientStates(ingredients: readonly string[], pantry: readonly string[]): IngredientState[] {
  return ingredients
    .map((t) => t.trim())
    .filter((t) => t !== '')
    .map((t) => (isSubheader(t)
      ? { text: t.replace(/:$/, ''), heading: true, have: false }
      : { text: t, heading: false, have: recipeStillToBuy([t], pantry) === 0 }));
}

/**
 * The recipe's "N still to buy", for the table AND the pane: core's
 * `recipeStillToBuy`, which counts what shopping would write, with a repeated
 * ingredient combined into one row. The per-line tags can show more "To buy"
 * lines than this number (two lines of salt are two tags and one row); the
 * count is the same everywhere.
 */
export function buyCount(ingredients: readonly string[], pantry: readonly string[]): number {
  return recipeStillToBuy(ingredients, pantry);
}

/** "Ingredients · 2 still to buy" for the recipe pane's heading. */
export function stillToBuyHeading(buy: number, lines: number): string {
  return buy === 0 ? `Ingredients · ${lines}, all in your pantry` : `Ingredients · ${buy} still to buy`;
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

/** Which list a reminder record belongs to, by its folder's flag. */
export function hitSection(recs: readonly AnyRec[], id: string): 'shopping' | 'pantry' {
  const row = recs.find((r) => r.id === id && r.type === 'reminder') as Rec<'reminder'> | undefined;
  const folder = row ? recs.find((r) => r.id === row.payload.folderId && r.type === 'folder') as Rec<'folder'> | undefined : undefined;
  return folder?.payload.pantry === true ? 'pantry' : 'shopping';
}

/**
 * What saving the shopping row's pane does. `typed` is null until the person
 * changes the text, and then nothing is written: a stale field must never
 * overwrite a row another device just changed. An emptied field deletes the
 * row, as on the phone. The put is built on the LIVE record.
 */
export type RowSave = { kind: 'none' } | { kind: 'del' } | { kind: 'put'; rec: Rec<'reminder'> };
export function rowSave(live: Rec<'reminder'>, typed: string | null): RowSave {
  if (typed === null) return { kind: 'none' };
  const text = typed.trim();
  if (text === '') return { kind: 'del' };
  if (text === live.payload.text) return { kind: 'none' };
  return { kind: 'put', rec: { ...live, payload: { ...live.payload, text } } };
}

/** Is this event target somewhere text is typed? */
export function isTextTarget(t: unknown): boolean {
  const el = t as { tagName?: string; isContentEditable?: boolean } | null;
  const tag = el?.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable === true;
}
