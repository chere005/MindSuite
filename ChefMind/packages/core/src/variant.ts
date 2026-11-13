/**
 * Variants of one recipe card.
 *
 * The owner, 2026-08-22, looking at the Cheese card: "there should be a dropdown
 * next to the 1/2x 1x and 2x buttons that lets you choose a varient, Ricotta,
 * Marscapone, Mozzarella/Burrata... you select which ones are shown for each
 * varient".
 *
 * One card can hold several things you might actually make. Cheese is four:
 * two acid-set, two rennet-set, sharing a shopping list and a page. Splitting
 * it into four notes would mean four places to fix a typo; showing all of it
 * at once means reading past three recipes to cook one.
 *
 * A variant is a NAME plus a set of the card's own subheaders — "For the
 * béchamel:" and its kind, the sections a recipe body is already divided into.
 * Choosing a variant hides the subheaders it does not name, and the rows under
 * them; everything before the first subheader is SHARED and always shown,
 * because that is where a card puts the things every version needs.
 *
 * Sections are named by their TEXT, not by an index. A variant pointing at
 * "the third subheader" would silently mean something else the moment one was
 * added above it, and a recipe is edited far more often than its variants are.
 * The cost is that renaming a subheader detaches it from every variant naming
 * it — which is visible (it stops being ticked) rather than silent (it starts
 * showing the wrong steps).
 */
import { splitRecipeBody } from './recipe';
import type { RecipeVariant } from './types';

const SUBHEAD = /^\*\*(.+:)\*\*$/;

/**
 * Every subheader in a recipe body, in the order written, deduplicated.
 *
 * Deduplicated because a card may repeat one across the Ingredients and the
 * Directions blocks — Cheese does, deliberately: "**Ricotta:**" appears in
 * both — and a variant ticking it means both. That is the behaviour you want
 * and the reason the key is the text.
 */
export function recipeSections(body: string): string[] {
  const split = splitRecipeBody(body);
  const src = split ? split.recipe : body;
  const out: string[] = [];
  for (const raw of src.split('\n')) {
    const m = raw.trim().match(SUBHEAD);
    if (!m) continue;
    const name = m[1]!.trim();
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * The body as one variant shows it.
 *
 * Everything up to the first subheader inside a block is shared and kept —
 * the **Ingredients** and **Directions** headings themselves, and any rows
 * that sit under them before a subheader claims the rest. After that, a run
 * belongs to the subheader above it and is kept only if the variant names it.
 *
 * A variant naming NOTHING shows the whole card. That is what a just-created
 * variant does before anything is ticked, and it is the right default: a
 * variant that hid everything would look like a broken recipe rather than an
 * unfinished setting.
 *
 * Steps are NOT renumbered. They are the author's numbers, and a variant is a
 * view — rewriting them here would mean the card and the variant disagree
 * about which step is step 4, in a recipe someone is following with wet hands.
 */
export function variantBody(body: string, sections: string[]): string {
  if (sections.length === 0) return body;
  const keep = new Set(sections);
  const split = splitRecipeBody(body);
  const recipe = split ? split.recipe : body;
  const out: string[] = [];
  // null = before any subheader in this block, i.e. shared.
  let current: string | null = null;
  for (const raw of recipe.split('\n')) {
    const t = raw.trim();
    const m = t.match(SUBHEAD);
    if (m) {
      current = m[1]!.trim();
      if (keep.has(current)) out.push(raw);
      continue;
    }
    // A block heading resets the run: **Directions** ends whatever subheader
    // the ingredients ended on, so the first steps are shared again rather
    // than inheriting the last ingredient subheader's fate.
    if (/^\*\*(ingredients|directions)\*\*$/i.test(t)) {
      current = null;
      out.push(raw);
      continue;
    }
    if (current === null || keep.has(current)) out.push(raw);
  }
  // Blank lines at the seams where a run was removed: two in a row is the
  // only artefact this can leave, and it reads as a gap in the card.
  const body2 = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!split) return body2;
  return [split.before, body2, split.after].filter(Boolean).join('\n\n');
}

/** A variant by id, or null — the "show the whole card" case. */
export function findVariant(variants: RecipeVariant[] | undefined, id: string | null): RecipeVariant | null {
  if (!id || !variants) return null;
  return variants.find((v) => v.id === id) ?? null;
}

/**
 * A variant's sections, with any that no longer exist dropped.
 *
 * Read-side repair, not a migration: a subheader can be renamed or deleted
 * from the card at any time, and a variant still naming it would otherwise
 * quietly keep a rule about a section nobody can see. Dropping it on read
 * means the checkbox list and the rendered card always agree.
 */
export function liveSections(body: string, variant: RecipeVariant): string[] {
  const have = new Set(recipeSections(body));
  return variant.sections.filter((s) => have.has(s));
}
