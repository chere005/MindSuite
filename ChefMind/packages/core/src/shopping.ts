/**
 * A shopping list out of chosen recipes.
 *
 * ChefMind only (the owner, 2026-08-21): pick several recipes in the Recipes tab's
 * edit mode and their ingredients become the list. CalMind's core has no twin
 * of this file — it has no shopping tab to feed.
 *
 * THE RULE, and the reason it is a rule rather than a concatenation: a cook
 * shopping for three dinners wants one line that says how much butter, not
 * three lines each saying some.
 *
 * CONVERSION, added 2026-08-22 (the owner: "consolidate identical items.. sum the
 * total amount needed to purchase in a consistent unit by type... grams/ml if
 * possible, even if converted properly"). This file used to refuse every
 * conversion, on the grounds that '1 cup butter' plus '2 tbsp butter' means
 * choosing a density. That was two rules wearing one coat:
 *
 *   - cup → tbsp is VOLUME to VOLUME, exact by definition, invents nothing;
 *   - cup → gram is volume to MASS, and still refused, for the original
 *     reason. Butter, flour and honey do not weigh the same per cup, and a
 *     list that quietly picks one is worse than a list that repeats itself.
 *
 * So lines that name the same thing in the same DIMENSION are added together
 * and rendered once in grams or millilitres; lines in different dimensions
 * stay as two lines, as they always did. A unit with no dimension (clove,
 * can, pinch, 'large') combines only with itself, exactly as before.
 *
 * THE PANTRY (the owner, same day: "if something is on the pantry already, skip
 * adding to shopping cart") is applied here rather than at the call site, so
 * every route into the list obeys it and there is one place to look.
 */
import { ingredientParts, isSubheader, countWord, precleanOcrLine, qtyText, qtyValue, scrubLine, singularOf } from './recipe';
import { amountText, formatBase, toBase, unitDimension, type Dimension } from './units';
import { ingredientAisle, type Aisle } from './grocery';

export type ShoppingSource = { title: string | null; ingredients: string[] };

/** One thing to buy, before it is written out. */
type Entry = {
  /** Summed in the dimension's base unit (g or ml) when `dim` is set, and in
   *  the line's own unit when it is not. Null once a range has poisoned it. */
  qty: number | null;
  dim: Dimension | null;
  /** The unit as written — kept for the dimensionless case, where it is the
   *  only unit this entry will ever have. */
  unit: string | null;
  name: string;
  /** The first line exactly as written, which is what an unsummable entry
   *  falls back to rather than a reconstruction. */
  raw: string;
};

/** Case-folded, punctuation-light, for deciding "the same thing". */
function nameKey(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, '').replace(/\s+/g, ' ').trim();
}

/**
 * What a cook did TO an ingredient, as opposed to which ingredient it is.
 *
 * This list is the whole of the loose match's extra reach, and every word on
 * it was chosen by one test: could dropping it ever send you home with the
 * wrong thing? 'chopped' cannot — chopped onions and onions are one purchase.
 * So the list is preparation and size, and nothing else.
 *
 * What is deliberately NOT here is longer than what is: ground, whole, dried,
 * smoked, salted, unsalted, heavy, double, plain, self-raising, dark, white,
 * brown, and every colour and nut in the shop. Those name a DIFFERENT THING
 * on the shelf — dried basil is not fresh basil, and the standing rule that
 * 'flour' must never claim 'almond flour' is the same rule seen from the
 * other side. A loose match that swallowed them would combine two lines into
 * one wrong one, which is worse than the two lines it started with.
 */
const PREP_WORDS = new Set([
  'chopped', 'diced', 'minced', 'sliced', 'shredded', 'grated', 'crushed', 'cubed',
  'halved', 'quartered', 'peeled', 'seeded', 'cored', 'stemmed', 'trimmed', 'rinsed',
  'drained', 'softened', 'melted', 'beaten', 'whisked', 'sifted', 'packed', 'divided',
  'optional', 'finely', 'roughly', 'coarsely', 'thinly', 'freshly', 'lightly', 'well',
  'large', 'small', 'medium', 'extra', 'approx', 'about', 'plus', 'more', 'needed',
]);

/**
 * The same name, reduced to the thing itself — the loose match Refresh uses.
 *
 * Three passes, in this order because each one makes the next simpler: drop a
 * bracketed aside ('flour (plain)'), cut a comma tail (', softened' — what a
 * cook writes after the ingredient is a note to themselves, never a second
 * ingredient, because a second one would be its own line), then drop the prep
 * words and singularise what is left. 'Chopped Onions, finely' and 'onion'
 * meet in the middle at 'onion'.
 */
function looseNameKey(name: string): string {
  const words = nameKey(bareName(name)).split(' ').filter(Boolean);
  const kept = words.filter((w) => !PREP_WORDS.has(w)).map((w) => singularOf(w));
  // Never reduce a name to nothing: a line that says only 'chopped' is a line
  // that says 'chopped', and it should combine with itself rather than with
  // every other emptied name on the list.
  return (kept.length > 0 ? kept : words).join(' ');
}

/**
 * THE QUANTITIES A COOK WRITES IN WORDS, and the articles around them.
 *
 * The owner, 2026-09-18: "if i have salt in the pantry, and it calls for a pinch
 * of salt or some amount of salt, it shouldn't go on the shopping list."
 *
 * A measure written as a number gets taken off the name by the parser — '1
 * tsp salt' has always been name 'salt', and has always been skipped. One
 * written in words does not: `ingredientParts('a pinch of salt')` answers a
 * name of 'a pinch of salt', which is the honest reading of a line with no
 * quantity in it, and which no pantry row will ever equal.
 *
 * So these come off the FRONT, and only off the front. A word that turns up
 * later in a name is part of the name — 'chocolate drops' is a thing to buy,
 * and eating the 'drops' off it would leave a pantry row for chocolate
 * claiming it.
 */
const VAGUE_WORDS = new Set([
  'a', 'an', 'some', 'few', 'little', 'couple', 'of',
  'pinch', 'pinches', 'dash', 'dashes', 'splash', 'splashes', 'drizzle', 'drizzles',
  'sprinkle', 'sprinkling', 'handful', 'handfuls', 'knob', 'knobs', 'glug', 'glugs',
  'squeeze', 'squeezes', 'drop', 'drops', 'sprig', 'sprigs', 'bunch', 'bunches',
  'scant', 'heaping', 'heaped', 'generous',
]);

/**
 * What a cook writes AFTER an ingredient about when to use it.
 *
 * 'Salt to taste' and 'oil for frying' are the same salt and the same oil.
 * The comma form ('sea salt, to taste') is already handled by `bareName` —
 * everything after a comma is a note to the cook — and this is the same note
 * written without one.
 */
const USE_TAIL = /\s*\b(?:to taste|as needed|if needed|as required|divided|optional|for (?:serving|garnish|garnishing|frying|greasing|dusting|drizzling|brushing|topping|the pan))\b\s*\.?\s*$/i;

/**
 * A MEASURE still sitting in the name, because the line said it twice.
 *
 * '1/3 cup (70 grams) + 1 tablespoon granulated sugar' is a real line from a
 * real recipe: the parser takes the FIRST measure off, the bracketed one is
 * an aside, and what is left over as the name begins '1 tablespoon'. Seen on
 * the owner's list, 2026-09-18, sitting under a pantry that had sugar in it.
 *
 * Singular forms only — the key is singularised before this is asked.
 */
const MEASURE_WORDS = new Set([
  'g', 'gram', 'kg', 'kilogram', 'ml', 'milliliter', 'millilitre', 'l', 'liter', 'litre',
  'tsp', 'teaspoon', 'tbsp', 'tablespoon', 'oz', 'ounce', 'lb', 'pound',
  'cup', 'clove', 'can', 'gal', 'gallon', 'qt', 'quart', 'pt', 'pint',
  'stick', 'slice', 'packet', 'package', 'pkg', 'jar', 'bottle', 'box', 'bag', 'tin',
]);

/** Is this word an amount rather than a thing? A number, a measure, or one of
 *  the measures a cook writes in words. */
const isAmountWord = (w: string): boolean =>
  /^\d/.test(w) || MEASURE_WORDS.has(w) || VAGUE_WORDS.has(w);

/**
 * WHICH KIND OF THE SAME THING — the owner, 2026-09-18: "i have sugar in my pantry
 * yet these both showed up", of a list carrying three lines of granulated
 * sugar and two of all purpose flour.
 *
 * A word on this list narrows a staple without changing what you come home
 * with: granulated sugar IS the sugar in the cupboard, and all purpose flour
 * IS the flour. So the pantry reads past them, on BOTH sides — a cupboard
 * holding granulated sugar holds sugar too.
 *
 * WHAT IS DELIBERATELY NOT HERE is the whole point, and it is the same rule
 * the loose match keeps from the other side: almond, coconut, oat, rice,
 * whole wheat, powdered, confectioners, brown, dark, white — every one of
 * those names a DIFFERENT BAG on the shelf, and a pantry row for flour that
 * claimed almond flour would send you home without the thing the recipe is
 * made of. Colour words especially: white sugar is granulated sugar, but
 * white wine is not red wine, and one list cannot tell those apart.
 */
const VARIETY_WORDS = new Set([
  'granulated', 'table', 'fine', 'superfine', 'coarse', 'flaky', 'plain',
  'regular', 'ordinary', 'standard', 'pure', 'unbleached',
  'all', 'purpose', 'allpurpose', 'kosher', 'sea', 'iodized', 'iodised',
]);

/**
 * A PART of a staple that having the staple covers — the owner, same day: "things
 * like egg yolk should realize i already have eggs".
 *
 * A table rather than a rule, and short on purpose. 'Yolk' and 'white' are
 * the two words a recipe uses for half an egg, and 'white' is exactly the
 * word a general rule must not be allowed to drop (see above). Naming the
 * two pairs outright is what buys the egg case without buying the wine one.
 */
const PART_OF: Record<string, string> = {
  'egg yolk': 'egg',
  'egg white': 'egg',
};

/**
 * The name as the PANTRY reads it: the thing itself, with the measure a cook
 * wrote in words and the note about when to use it taken off.
 *
 * Deliberately more forgiving than `nameKey` about AMOUNTS and MOMENTS, and
 * no more forgiving than `looseNameKey` about what a thing IS.
 */
export function pantryKey(name: string): string {
  const bare = bareName(name).replace(USE_TAIL, '').trim();
  const words = nameKey(bare).split(' ').filter(Boolean).map((w) => singularOf(w));
  // Only off the FRONT: a word that turns up later is part of the name —
  // 'chocolate drops' is a thing to buy, and eating the 'drops' off it would
  // let a pantry row for chocolate claim it.
  let i = 0;
  while (i < words.length && isAmountWord(words[i] as string)) i++;
  const kept = words.slice(i).filter((w) => !PREP_WORDS.has(w));
  // Never reduce a name to nothing — `looseNameKey`'s rule, for its reason: a
  // row that says only 'a pinch' says 'a pinch', and a pantry that matched
  // everything emptied to '' would empty the whole list.
  return (kept.length > 0 ? kept : words).join(' ');
}

/**
 * The STAPLE a key names: the same thing with the kind of it taken off.
 *
 * What the pantry actually compares, on both sides. `pantryKey` answers what
 * the line says; this answers what is in the cupboard when it is true.
 */
function staple(key: string): string {
  const words = key.split(' ').filter(Boolean);
  const kept = words.filter((w) => !VARIETY_WORDS.has(w));
  const bare = (kept.length > 0 ? kept : words).join(' ');
  return PART_OF[bare] ?? bare;
}

/**
 * What a pantry ROW is, for deciding two rows are the same ingredient: its
 * staple, with the quantity and unit a cook typed in front taken off ('500 g
 * rice' is 'rice'). A can or jar is where a thing is SOLD and keeps its own
 * identity ('2 cans tomatoes' is not the fresh tomatoes), the same exception
 * `ingredientAisle` makes. No mass/volume conversion happens: the unit only
 * decides the key's class, never a number.
 */
export function pantryRowKey(text: string): string {
  const p = ingredientParts(text.trim());
  const key = staple(pantryKey(p.name || text));
  if (key === '') return '';
  const u = p.unit ? p.unit.trim().toLowerCase() : '';
  return u === 'can' || u === 'cans' || u === 'jar' || u === 'jars' ? `${u.startsWith('can') ? 'can' : 'jar'}:${key}` : key;
}

/**
 * Does the pantry already hold `text`'s ingredient? `except` is an index into
 * `rows` to ignore (the row being renamed is not a duplicate of itself).
 */
export function pantryHas(rows: readonly string[], text: string, except = -1): boolean {
  const key = pantryRowKey(text);
  if (key === '') return false;
  return rows.some((r, i) => i !== except && pantryRowKey(r) === key);
}

/**
 * Is this line's ingredient already on hand?
 *
 * The 'and' case is here because a recipe writes 'salt and pepper to taste'
 * far more often than it writes either alone. It goes only when EVERY thing
 * it names is in the pantry — half a line cannot be crossed off, so a cook
 * with salt and no pepper still gets the line, whole, and still buys pepper.
 *
 * The split is deliberately one-way. A PANTRY row saying 'macaroni and
 * cheese' is one box and does not put cheese on hand; a recipe line saying
 * 'salt and pepper' is two things and needs both.
 */
function onHand(have: ReadonlySet<string>, name: string): boolean {
  const key = staple(pantryKey(name));
  if (key === '') return false;
  if (have.has(key)) return true;
  const parts = key.split(/\s+and\s+/).filter(Boolean).map(staple);
  return parts.length > 1 && parts.every((part) => have.has(part));
}

/** A name with its bracketed aside and its comma tail taken off — what the
 *  loose match compares, and what it puts on the list. */
function bareName(name: string): string {
  return name
    .replace(/\([^)]*\)/g, ' ')
    .replace(/,[\s\S]*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The metric measure a recipe writes in brackets beside its own — '2 cups
 * (250 g) flour', which is one ingredient stated twice.
 *
 * The owner, 2026-08-22: "if multiple units are provided, prefer g/ml to cups
 * etc." Preferring it is not a conversion and needs no density: the author
 * already did the weighing, and taking the number they wrote is the one way
 * to get a mass out of a cup of flour without inventing anything. Only g, kg,
 * ml and l count — a bracketed '(2 sticks)' is an aside about packaging, not
 * a better measure.
 */
const METRIC_ASIDE = /\((?:approx\.?\s*|about\s*|~)?(\d+(?:[.,]\d+)?)\s*(g|gram|grams|kg|kilogram|kilograms|ml|millilitre|millilitres|milliliter|milliliters|l|litre|litres|liter|liters)\b[^)]*\)/i;

function metricAside(text: string): { qty: string; unit: string } | null {
  const m = METRIC_ASIDE.exec(text);
  if (!m) return null;
  return { qty: m[1]!.replace(',', '.'), unit: m[2]!.toLowerCase() };
}

/**
 * One line per thing to buy, in the order first met.
 *
 * Order matters and is the ORDER THE RECIPES WERE PICKED IN, not alphabetical
 * and not regrouped: the list reads as "the first recipe, then what the second
 * one adds", which is how someone checks they chose the right recipes. The
 * shopping screen groups by aisle for the walk round the shop; that is a view
 * over this order, not a change to it.
 *
 * `pantry` is a list of names already on hand. Anything matching one of them
 * is left out entirely — not added and struck through, left out: a list you
 * have to read past is the thing it was meant to save you from.
 */
export function shoppingLines(sources: ShoppingSource[], pantry: string[] = []): string[] {
  return shoppingEntries(sources, pantry).map((e) => e.text);
}

/** The same list, with each line's aisle and name alongside — what the
 *  shopping screen needs to group without re-parsing every row. */
export function shoppingRows(
  sources: ShoppingSource[],
  pantry: string[] = [],
): { text: string; name: string; aisle: Aisle }[] {
  return shoppingEntries(sources, pantry);
}

/**
 * The same combining, tried HARDER — what the Refresh button on the shopping
 * and pantry lists runs (the owner, 2026-08-22: "a button that says refresh that
 * puts additional effort into combining things that are alike").
 *
 * It takes the rows a list already holds rather than recipes, because by the
 * time you press it the lines have come from several places: two recipes, a
 * thing typed in at the shop door, a row edited by hand. shoppingLines
 * combined each batch as it arrived and had no way to see across them.
 *
 * THREE things it does that the strict pass does not, and nothing else:
 *   - matches on the loose name — prep words dropped, plurals folded, a
 *     bracketed aside and a comma tail ignored (see looseNameKey);
 *   - prefers a bracketed metric measure to the cook's own (metricAside);
 *   - keeps the SHORTEST of the names it merged, so a list tidies towards
 *     'onions' rather than away from it.
 *
 * What it deliberately does NOT do is convert across dimensions. Grams and
 * cups of the same thing are still two lines here, for the reason at the top
 * of this file: that conversion needs a density, and a shopping list that
 * invents one is worse than a list that repeats itself. 'Additional effort'
 * was never a licence to guess.
 */
export function recombineLines(texts: string[]): string[] {
  return shoppingEntries([{ title: null, ingredients: texts }], [], true).map((e) => e.text);
}

/**
 * Fold new lines into a list that is already there.
 *
 * The owner, 2026-09-18: "duplicate ingredients i don't have in my pantry should
 * always be combined automatically" — of a list carrying two lines of all
 * purpose flour, one from each of two recipes added minutes apart. A single
 * add has always combined within itself; what it could not do was see the
 * list it was landing on.
 *
 * THE TEST FOR "the same thing" is the combine itself: hand `recombineLines`
 * the two and see whether it gives one back. A separate opinion about what a
 * name means, kept beside the arithmetic that acts on it, is two rules that
 * eventually disagree.
 *
 * `kept` comes back the SAME LENGTH and in the same order as `existing`, with
 * only the entries that absorbed something rewritten — the caller has rows
 * with ids, an order somebody dragged them into and wording they may have
 * edited, and none of that survives being rebuilt from a list of strings.
 */
export function mergeIntoList(existing: readonly string[], incoming: readonly string[]): {
  kept: string[];
  /** What nothing on the list could take, combined among themselves. */
  added: string[];
} {
  const kept = existing.slice();
  const fresh: string[] = [];
  for (const line of incoming) {
    // Against the CURRENT text, so a second line can fold into a row the
    // first one already changed — two recipes each wanting butter.
    const at = kept.findIndex((t) => recombineLines([t, line]).length === 1);
    if (at < 0) { fresh.push(line); continue; }
    const [combined] = recombineLines([kept[at] as string, line]);
    if (combined !== undefined) kept[at] = combined;
  }
  // The leftovers meet each other too: `shoppingLines` combined them on the
  // STRICT reading, and 'onion' beside 'chopped onions' only meets on the
  // loose one — which is the reading every line above just had.
  return { kept, added: recombineLines(fresh) };
}

function shoppingEntries(
  sources: ShoppingSource[],
  pantry: string[],
  loose = false,
): { text: string; name: string; aisle: Aisle }[] {
  const keyOfName = loose ? looseNameKey : nameKey;
  // The pantry reads names its OWN way, the same way in both passes: whether
  // two lines of a list combine and whether a cupboard already holds one of
  // them are different questions, and the second one has to survive '1 tsp',
  // 'a pinch of' and 'to taste' alike.
  const have = new Set(
    pantry.map((p) => staple(pantryKey(ingredientParts(p).name || p))).filter(Boolean),
  );
  // Insertion-ordered, which is what Map guarantees and a plain object does
  // not for numeric-looking keys.
  const seen = new Map<string, Entry>();
  for (const src of sources) {
    for (const line of src.ingredients) {
      const text = line.trim();
      // A subheader is a heading for the COOK ("For the béchamel:"), not a
      // thing to buy. It carries no quantity by definition — that is what
      // isSubheader tests — so it would otherwise arrive as a bare row
      // telling you to purchase a phase of the work.
      if (text === '' || isSubheader(text)) continue;
      const p = ingredientParts(text);
      // The bracketed metric measure wins over the cook's own, and only in
      // the loose pass: it is a second reading of the SAME line rather than a
      // conversion, so it can never be wrong in the way a density would be.
      const aside = loose ? metricAside(text) : null;
      const unit = (aside?.unit ?? p.unit)?.toLowerCase() ?? null;
      const name = loose ? bareName(p.name) : p.name.trim();
      const nk = keyOfName(name);
      if (have.size > 0 && onHand(have, name)) continue;   // already in the pantry
      const dim = unitDimension(unit);
      // The key is what "the same thing" means. Case-folded; the DIMENSION
      // counts rather than the unit, so cups and tablespoons of the same
      // thing are one line while grams and cups of it stay two.
      //
      // A dimensionless unit is SINGULARISED first. UNIT_MAP canonicalises
      // 'cloves' to 'cloves' and 'clove' to 'clove' — deliberately, so the
      // scaler can print back the spelling the author used — which meant
      // '1 clove garlic' and '3 cloves garlic' were two different things.
      const key = `${dim ?? (unit === null ? '' : singularOf(unit))}|${nk}`;
      // A RANGE ('2-3 cloves') has no single value, so qtyValue answers null
      // and the entry stops combining from then on. That is the honest
      // outcome: '2-3 cloves' plus '4 cloves' has no arithmetic, and inventing
      // one would put a number on the list nobody wrote.
      const rawQty = aside ? qtyValue(aside.qty) : p.qty === null ? null : qtyValue(p.qty);
      const qty = rawQty === null ? null : dim === null ? rawQty : toBase(rawQty, unit);
      const prev = seen.get(key);
      if (!prev) {
        seen.set(key, { qty, dim, unit, name, raw: text });
        continue;
      }
      // Two lines that both parse: add them. Anything else keeps the first
      // line exactly as written, which is also what makes a repeated
      // quantity-less ingredient ('salt') collapse to one row.
      if (prev.qty !== null && qty !== null) prev.qty += qty;
      else prev.qty = null;
      // The shortest name of the ones that met, in the loose pass only: three
      // lines that say 'onion', 'chopped onions' and 'yellow onions, diced'
      // should leave one that says 'onion'. First-met wins everywhere else,
      // and still does here whenever the lengths tie.
      if (loose && name !== '' && name.length < prev.name.length) prev.name = name;
    }
  }
  return [...seen.values()].map((e) => {
    const text = render(e, loose);
    return { text, name: e.name, aisle: ingredientAisle(e.name, e.unit) };
  });
}

/** The name made to agree with the number in front of it — the last word
 *  only, because that is the noun: 'baby potato' pluralises to 'baby
 *  potatoes', never 'babies potato'. */
function countName(name: string, qty: number): string {
  const words = name.split(' ');
  const last = words[words.length - 1];
  if (last === undefined || last === '') return name;
  // A prep word is not a noun and has no plural: a line whose whole name is
  // one ('2 chopped' — nonsense, but it reaches here) came out '2 choppeds'.
  if (PREP_WORDS.has(last.toLowerCase())) return name;
  words[words.length - 1] = countWord(last, qty);
  return words.join(' ');
}

function render(e: Entry, loose = false): string {
  if (e.qty === null) return e.raw;
  if (e.dim !== null) {
    // Grams and millilitres, which is what the owner asked for and what makes one
    // unit per thing possible at all. amountText, not qtyText: 236.59 ml has
    // no vulgar fraction, and ⅙ of a gram is not a shopping instruction.
    const { qty, unit } = formatBase(e.qty, e.dim);
    return `${amountText(qty)} ${unit} ${e.name}`.trim();
  }
  const amount = qtyText(e.qty);
  // countWord is what makes '1 clove' and '2 cloves' both right — and the same
  // call the scaler makes, so the two agree about English.
  if (e.unit) return `${amount} ${countWord(e.unit, e.qty)} ${e.name}`.trim();
  // With no unit the NAME is what the number counts, so it is the name that
  // has to agree — and only in the loose pass, which is the only one that can
  // hand you a name from a different line than the total. '2 onions' plus '1
  // onion' kept the shorter name and read '3 onion' the first time this ran.
  // The strict pass never rewrites a name and must not start here.
  return `${amount} ${loose ? countName(e.name, e.qty) : e.name}`.trim();
}

/**
 * WHAT A PHOTO SAYS IS ON HAND — the owner, 2026-10-01: "in chefmind pantry add a
 * button to do ocr to look at a receipt or list of ingredients to add them to
 * the pantry".
 *
 * Two kinds of page, read by one pass, because a line on either is the same
 * question — is this a thing on the shelf, and what is it called?
 *
 *   - A RECEIPT: 'ORG BANANAS 1.23 LB @ 0.59/LB 0.73 F'. Prices, weights,
 *     tax flags and SKUs come off; the till's own chatter (totals, tenders,
 *     the store's address, the date) is dropped whole.
 *   - A LIST: '2 cups flour', '- eggs', '[ ] butter, softened'. The bullet,
 *     the measure and the cook's note come off, so the pantry holds 'flour'
 *     — the name is what the pantry matches on, never the amount.
 *
 * The result is a PROPOSAL: the screen shows it and the cook unticks the
 * till's junk before anything is written. So this errs towards keeping a
 * line it is unsure of — an extra row costs a tap, a lost one costs a retype.
 *
 * `have` is the pantry as it stands. Anything already on it (by the pantry's
 * own reading, `staple(pantryKey(…))`) is left out, and so is a repeat within
 * the photo — a receipt that rang up milk twice still means one row.
 */
export function pantryItemsFromPages(pages: readonly string[], have: readonly string[] = []): string[] {
  const seen = new Set(have.map(pantryRowKey).filter(Boolean));
  const out: string[] = [];
  for (const page of pages) {
    for (const raw of page.split(/\r?\n/)) {
      for (const name of scannedNames(raw)) {
        const key = pantryRowKey(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(name);
      }
    }
  }
  return out;
}

/** The till's own words: a line carrying one of these is never a product. */
const RECEIPT_CHROME = /\b(?:sub\s*-?\s*total|tax(?:able)?|gst|incl(?:uded)?|balance|change|cash|tender(?:ed)?|visa|mastercard|amex|discover|debit|credit|card|paid|payment|approved|approval|auth(?:orization)?|acct|account|trans(?:action)?|terminal|cashier|register|receipt|thank(?:s| you)?|welcome|survey|savings|saved|coupon|discount|member(?:ship)?|rewards?|points|loyalty|items?\s+sold|item\s+count|tel|phone|manager|store\s*#?|st\s*#|op\s*#|tr\s*#|ref\s*#|invoice|order\s*#|signature|customer|copy|refund|return(?:s)?\s+policy|market|supermarket|cafe|branch|till|specimen|fictional)\b/i;
// Sample receipts and some real merchant slips carry print-shop/test notices
// in the footer. These phrases are not food names even when OCR loses the
// punctuation or mistakes a character.
const RECEIPT_NOTICE = /\b(?:made\s+by|free\s+to\s+use|for\s+testing|for\s+shopping\s+at)\b/i;
// `TOTAL` by itself is also a cereal brand. A total line has a number after
// its label; that is a stronger signal than matching the word anywhere in an
// item name (which used to drop Total cereal from a receipt).
const RECEIPT_TOTAL = /^\s*(?:sub\s*-?\s*total|total)\s*:?[ \t]*[$€£]?\s*\d/i;

/** A heading over the list rather than a thing on it. */
const LIST_HEADING = /^(?:ingredients?|shopping(?:\s+list)?|grocer(?:y|ies)(?:\s+list)?|pantry|list|to\s+buy|need|groceries|directions|method|instructions|notes?)\s*:?$/i;

/** Receipt shorthand that says nothing about which thing it is. */
const RECEIPT_PREFIX = /^(?:org|organic)\s+/i;

/**
 * One OCR line into the names it carries — none for chatter, usually one,
 * several for a comma list ('flour, sugar, eggs').
 */
function scannedNames(raw: string): string[] {
  let l = raw.replace(/\s+/g, ' ').trim();
  if (l === '') return [];
  if (/https?:\/\/|www\.|@\S+\.\w|\.(?:com|net|org)\b/i.test(l)) return [];
  if (RECEIPT_TOTAL.test(l) || RECEIPT_CHROME.test(l) || RECEIPT_NOTICE.test(l)) return [];
  // The store's address: a street number and a street word, or a state and
  // a ZIP. Asked before the SKU strip below, which would take the number.
  if (/^\d+\s.*\b(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|hwy|highway|pkwy|parkway|way|suite|ste)\b\.?/i.test(l)) return [];
  if (/\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/.test(l)) return [];
  // Dates, times and phone numbers: the receipt's header and footer.
  if (/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{1,2}:\d{2}\b|\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(l)) return [];
  l = l
    // A weighed or multi-bought line: everything from the '@' on is the sum,
    // and the number before it is how much — '1.23 LB @ 0.59/LB', '2 @ 3.00'.
    .replace(/\s*(?:\d+(?:[.,]\d+)?\s*(?:lbs?|kg|oz|ea)?\s*)?@.*$/i, '')
    // Trailing prices with their tax flags, as often as they stack:
    // '4.99 F', '$4.99', '1.00-', '4.99 TF', '2/5.00'.
    .replace(/(?:\s+(?:\d+\s*\/\s*)?-?\$?\s?\d+[.,]\d{2}-?(?:\s+[A-Z*]{1,2})?)+\s*$/, '')
    // An SKU or PLU at either end: four or more digits run together.
    .replace(/^\d{4,}\s+/, '')
    .replace(/\s+\d{4,}$/, '')
    // Receipt quantity markers are not ingredient names. OCR may repeat the
    // x in a blurry `2 x` as `2 Xx`.
    .replace(/^\d{1,3}\s*[x×]+\s*/i, '')
    // A list's own furniture: bullets, checkboxes, numbering.
    .replace(/^(?:[-*•·◦▪●]\s+|\[\s*[xX✓]?\s*\]\s*|[☐☑☒□■]\s*|\d{1,2}[.)]\s+)/, '');
  l = scrubLine(precleanOcrLine(l))
    .replace(/^(?:ingredients?|shopping list|grocery list|groceries)\s*:\s*/i, '');
  if (LIST_HEADING.test(l)) return [];
  // A comma LIST, not a comma NOTE: 'flour, sugar, eggs' names three things,
  // where '2 cups flour, sifted' names one with a note — and a note never
  // comes with two commas and no measure in front of it.
  const commas = (l.match(/,/g) ?? []).length;
  const parts = commas >= 2 && ingredientParts(l).qty === null ? l.split(',') : [l];
  const names: string[] = [];
  for (const part of parts) {
    const n = scannedName(part);
    if (n) names.push(n);
  }
  return names;
}

function scannedName(text: string): string | null {
  const p = ingredientParts(text.trim());
  let name = bareName(p.name || text).replace(USE_TAIL, '').trim();
  // A till prints in capitals; a pantry row reads better in a cook's case.
  if (/[A-Z]{2}/.test(name) && name === name.toUpperCase()) name = name.toLowerCase();
  name = name.replace(RECEIPT_PREFIX, '').replace(/^[^\p{L}]+|[^\p{L})]+$/gu, '').trim();
  const letters = (name.match(/\p{L}/gu) ?? []).length;
  // Too short to be a product, or mostly digits — OCR's speckle, a barcode.
  if (letters < 3 || letters < name.replace(/\s/g, '').length / 2) return null;
  if (name.length > 48) return null;
  return name;
}
