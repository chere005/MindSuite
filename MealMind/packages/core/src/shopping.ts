/**
 * A shopping list out of chosen recipes.
 *
 * MealMind only (the owner, 2026-08-21): pick several recipes in the Recipes tab's
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
  /** A whole citrus fruit, counted: '1 lemon' and 'juice of 2 lemons' sum. */
  fruit?: boolean;
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
  'fl', 'dl', 'cl', 'mg', 'milligram', 'head', 'stalk', 'piece', 'dozen', 'wedge',
]);

/** Is this word an amount rather than a thing? A number, a measure, or one of
 *  the measures a cook writes in words. */
const isAmountWord = (w: string): boolean =>
  /^[\d\p{No}]/u.test(w) || MEASURE_WORDS.has(w) || VAGUE_WORDS.has(w);

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
 *
 * 'kosher' WAS HERE and is not (the owner, 2026-11-21: "salt on its own would
 * match salt, but if it specifies kosher salt, it only matches if the pantry
 * has kosher salt"). Kosher salt is its own box on the shelf, so it is a
 * KIND word that counts. The other words keep the reading they had.
 */
const VARIETY_WORDS = new Set([
  'granulated', 'table', 'fine', 'superfine', 'coarse', 'flaky', 'plain',
  'regular', 'ordinary', 'standard', 'pure', 'unbleached',
  'all', 'purpose', 'allpurpose', 'sea', 'iodized', 'iodised',
]);

/**
 * A PART of a staple that having the staple covers — the owner, 2026-09-18: "things
 * like egg yolk should realize i already have eggs".
 *
 * A table rather than a rule, and short on purpose. 'Yolk' and 'white' are
 * the two words a recipe uses for half an egg, and 'white' is exactly the
 * word a general rule must not be allowed to drop (see above). Naming the
 * pairs outright is what buys the egg case without buying the wine one.
 *
 * ONE DIRECTION ONLY (the owner, 2026-11-21): the key is what a RECIPE line
 * asks for, the value is the thing on the shelf that covers it. A pantry row
 * for lemon juice does not put a lemon on hand, so this is read on the recipe
 * side and never folds two pantry rows together. Keys are singular, as
 * `pantryKey` leaves them.
 */
const PART_OF: Record<string, string> = {
  'egg yolk': 'egg',
  'egg white': 'egg',
  'lemon juice': 'lemon',
  'lemon zest': 'lemon',
  'lime juice': 'lime',
  'lime zest': 'lime',
  'orange juice': 'orange',
  'orange zest': 'orange',
  'garlic clove': 'garlic',
};

/**
 * NAMED ALIASES — two spellings of ONE thing on the shelf, read both ways
 * (the owner, 2026-11-21). A short explicit table like PART_OF, not a rule:
 * every pair here was named, and what is not named stays itself ('buttermilk',
 * 'coconut milk' and 'almond milk' are not milk).
 *
 * Keys are what `pantryKey` leaves: singular, preparation words gone, so
 * 'extra virgin olive oil' arrives as 'virgin olive oil' ('extra' is a prep
 * word) and 'extra-virgin' as 'extravirgin' (the hyphen is dropped). The
 * value is the one spelling both sides are compared as.
 *
 * 'pepper' means black pepper: a spice-rack reading, because a cook lists
 * pepper in the pantry and does not list a bell pepper there. Every other
 * pepper is a kind word and never reaches this table.
 */
const ALIASES: Record<string, string> = {
  'black pepper': 'pepper',
  'peppercorn': 'pepper',
  'black peppercorn': 'pepper',
  'green onion': 'scallion',
  'chicken stock': 'chicken broth',
  'parmigiano reggiano': 'parmesan',
  'parmigianoreggiano': 'parmesan',
  'parmesan cheese': 'parmesan',
  // The spice, which 'red pepper' (the vegetable) is not (the owner, 2026-11-21).
  'crushed red pepper': 'red pepper flake',
  'crushed red pepper flake': 'red pepper flake',
  'virgin olive oil': 'olive oil',
  'extravirgin olive oil': 'olive oil',
  'unsalted butter': 'butter',
  'salted butter': 'butter',
  'whole milk': 'milk',
  'skim milk': 'milk',
  // '2% milk' reaches here as 'milk': the 2 is an amount word, read past.
};

/**
 * 'ground' is a preparation word ONLY on a spice ('ground black pepper' is
 * pepper), and these four are the spices where ground is a different thing
 * from the plain one: ground (dried) ginger is not the fresh root, ground
 * coriander is the seed and not cilantro, ground mustard is not the
 * condiment, ground turmeric is not the root. They keep 'ground'.
 */
const FORM_SENSITIVE = new Set(['ginger', 'coriander', 'mustard', 'turmeric']);

/** Does this name file as produce or a herb ('fresh basil' is basil), singular
 *  or plural? Only for these is 'fresh' what the bare name already means. */
function isProduceName(words: string[]): boolean {
  const j = words.join(' ');
  return ingredientAisle(j) === 'Produce' || ingredientAisle(`${j}s`) === 'Produce';
}

/** Preserved, said as an adjective: the same thing as a can or jar unit. */
const PRESERVED = new Set(['canned', 'tinned', 'jarred']);

/** Never put on a shopping list, as if always on hand (the owner, 2026-11-21). */
const ALWAYS_ON_HAND = new Set([
  'water', 'ice', 'boiling water', 'warm water', 'cold water', 'hot water', 'ice water',
  'lukewarm water', 'ice cube',
]);

/**
 * The name as the PANTRY reads it: the thing itself, with the measure a cook
 * wrote in words and the note about when to use it taken off.
 *
 * Deliberately more forgiving than `nameKey` about AMOUNTS and MOMENTS, and
 * no more forgiving than `looseNameKey` about what a thing IS.
 */
export function pantryKey(name: string): string {
  // 'extra-large' and 'medium-large' are size words joined by a hyphen and
  // drop like the words do; 'bone-in' and 'sun-dried' are not, and stay whole.
  const sizeish = (w: string) => PREP_WORDS.has(w.toLowerCase()) || w.toLowerCase() === 'jumbo';
  const bare = bareName(name).replace(USE_TAIL, '')
    .replace(/(\p{L}+)-(\p{L}+)/gu, (m, a: string, b: string) => (sizeish(a) && sizeish(b) ? ' ' : m)).trim();
  const words = nameKey(bare).split(' ').filter(Boolean).map((w) => singularOf(w));
  // Only off the FRONT: a word that turns up later is part of the name —
  // 'chocolate drops' is a thing to buy, and eating the 'drops' off it would
  // let a pantry row for chocolate claim it.
  let i = 0;
  while (i < words.length && isAmountWord(words[i] as string)) i++;
  // 'crushed' is preparation ('crushed garlic') except in 'crushed red pepper',
  // which is the spice and a different thing from a red pepper.
  const kept = words.slice(i).filter((w, at, rest) => !PREP_WORDS.has(w) || (w === 'crushed' && rest[at + 1] === 'red'));
  // Never reduce a name to nothing — `looseNameKey`'s rule, for its reason: a
  // row that says only 'a pinch' says 'a pinch', and a pantry that matched
  // everything emptied to '' would empty the whole list.
  return (kept.length > 0 ? kept : words).join(' ');
}

const CITRUS = new Set(['lemon', 'lime', 'orange']);
/** Words between 'juice of' and the fruit: '1', 'half', 'a', 'the'. */
const PART_FILLER = new Set(['a', 'an', 'the', 'one', 'two', 'three', 'half', 'whole', 'large', 'small', 'medium']);

/**
 * 'juice of 1 lemon', 'the juice of half a lemon', 'zest of 2 limes' read as
 * 'lemon juice' / 'lime zest' — the part PART_OF already knows. Anything that
 * does not fit the shape is returned as it came.
 */
function partPhrase(words: string[]): string[] {
  const at = words.findIndex((x, i) => (x === 'juice' || x === 'zest') && words[i + 1] === 'of');
  if (at < 0) return words;
  const rest = words.slice(at + 2).filter((x) => !PART_FILLER.has(x) && !NUMBER_WORD.test(x));
  const fruit = rest[0];
  return rest.length === 1 && fruit !== undefined && CITRUS.has(fruit) ? [fruit, words[at] as string] : words;
}

/**
 * A juice or zest line names the FRUIT to buy: 'juice of a lemon' is '1
 * lemon', 'zest of 2 limes' is '2 limes', 'the juice of half a lemon' is
 * '1 lemon' (whole fruits, rounded up), '1 lemon, juiced' is '1 lemon'. A line
 * that is literally 'lemon juice' is bottled and is not touched. Only the
 * three citrus fruits PART_OF knows; anything else of another shape is null.
 */
function fruitLine(text: string): { n: number; fruit: string } | null {
  const flat = text.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  let rest: string | null = null;
  const lead = /^(?:the\s+)?(?:(?:juice|zest)\s+(?:and|&)\s+)?(?:juice|zest)\s+of\s+([^,]+)/.exec(flat);
  if (lead) rest = lead[1] as string;
  else {
    const tail = /^([^,]+),\s*(?:finely\s+)?(?:juiced|zested)\b/.exec(flat);
    if (tail) rest = tail[1] as string;
  }
  if (rest === null) return null;
  let n: number | null = null;
  let afterNumber = false;
  const left: string[] = [];
  for (const tok of rest.replace(/(\d)(\p{No})/gu, '$1 $2').split(' ').filter(Boolean)) {
    if (tok === 'half') { n ??= 0.5; afterNumber = false; continue; }
    if (tok === 'a' || tok === 'an' || tok === 'one') { n ??= 1; afterNumber = false; continue; }
    if (PART_FILLER.has(tok) || tok === 'of') { afterNumber = false; continue; }
    const v = qtyValue(tok);
    // '1 1/2 lemons' is one quantity of two tokens, not two quantities.
    if (v !== null) { n = afterNumber && n !== null ? n + v : (n ?? v); afterNumber = true; continue; }
    afterNumber = false;
    left.push(tok);
  }
  const fruit = left.length === 1 ? singularOf(left[0] as string) : '';
  if (!CITRUS.has(fruit)) return null;
  return { n: Math.max(1, Math.ceil((n ?? 1) - 1e-9)), fruit };
}

/** Filter, but never to nothing. */
function keepSome(words: string[], keep: (w: string) => boolean): string[] {
  const out = words.filter(keep);
  return out.length > 0 ? out : words;
}

/** An amount that survived in the middle of a name: '2', '½', '250g'. */
const NUMBER_WORD = /^(?:[\d\p{No}]+(?:[./,]\d+)?|\d+(?:\.\d+)?[a-z]+)$/u;

/**
 * The STAPLE a run of `pantryKey` words names: what is in the cupboard when
 * the line is true. In this order, because each step makes the next simpler:
 *   1. canned/tinned/jarred come off (the caller turns them into can:/jar:);
 *   2. 'fresh coriander' is cilantro, before 'fresh' is read past;
 *   3. a number, and a measure right after one, is not part of a name,
 *      whether or not the parser caught it ('flour 2 cups');
 *   4. 'cracked' comes off, and 'fresh' where it is the default (produce and
 *      herbs); 'dried' never does;
 *   5. 'ground' comes off a SPICE only (the aisle classifier decides, so
 *      ground beef keeps it), except the FORM_SENSITIVE four;
 *   6. a kind that is the same box on the shelf ('granulated') comes off;
 *   7. a named alias is read as its one spelling.
 */
function stapleOf(base: string[]): string {
  let w = keepSome(partPhrase(base), (x) => !PRESERVED.has(x));
  const fc = w.findIndex((x, i) => x === 'fresh' && w[i + 1] === 'coriander');
  if (fc >= 0) w = [...w.slice(0, fc), 'cilantro', ...w.slice(fc + 2)];
  const noNumbers: string[] = [];
  for (let i = 0; i < w.length; i++) {
    const x = w[i] as string;
    if (NUMBER_WORD.test(x)) {
      if (MEASURE_WORDS.has(w[i + 1] ?? '')) i++;
      continue;
    }
    noNumbers.push(x);
  }
  w = noNumbers.length > 0 ? noNumbers : w;
  w = keepSome(w, (x) => x !== 'cracked');
  // 'fresh' is the default only for produce and herbs; on anything else it is
  // a kind ('fresh mozzarella', 'fresh pasta', 'fresh yeast'). 'fresh ground'
  // is how pepper is ground, not a kind of anything.
  const fresh = w.indexOf('fresh');
  if (fresh >= 0 && w.length > 1) {
    const rest = w.filter((_, at) => at !== fresh);
    if (w[fresh + 1] === 'ground' || isProduceName(rest)) w = rest;
  }
  if (w.includes('ground') && !w.some((x) => FORM_SENSITIVE.has(x))
    && ingredientAisle(w.join(' ')) === 'Spices & Seasoning') {
    w = keepSome(w, (x) => x !== 'ground');
  }
  w = keepSome(w, (x) => !VARIETY_WORDS.has(x));
  const joined = w.join(' ');
  return ALIASES[joined] ?? joined;
}

/**
 * A can or a jar is where a thing is SOLD, and by default it keeps its own
 * identity: '2 cans tomatoes' are not the fresh tomatoes, 'canned tomatoes'
 * is not '2 tomatoes', and 'a can of peaches' is not a peach. The exception is
 * a short NAMED list of things that are only ever sold preserved (coconut
 * milk, salsa, chickpeas, black beans, stock, olives…): for those the can is
 * a unit like any other and is read past (the coordinator, 2026-11-21). The
 * list is named rather than inferred from the aisle table, because that
 * guessed wrong both ways ('diced green chiles' and 'jalapeños' are not
 * produce to it, and a canned peach is not a peach). 'tin' is a can,
 * 'jarred' a jar.
 */
function containerOf(text: string, unit: string | null, name: string): '' | 'can' | 'jar' {
  const c = containerWord(text, unit, name);
  if (c === '') return '';
  const words = nameKey(bareName(name)).split(' ').filter(Boolean);
  let i = 0;
  while (i < words.length && isAmountWord(singularOf(words[i] as string))) i++;
  const bare = words.slice(i).map((w) => singularOf(w)).filter((w) => !PRESERVED.has(w)
    && !CONTAINER_WORDS.has(w) && !PREP_WORDS.has(w));
  return onlyPreserved(bare) ? '' : c;
}

/** Things only ever sold preserved, named in the plural a cook writes and read
 *  singular on both sides. Contiguous words, except chipotles in adobo. */
const PRESERVED_ONLY: string[][] = [
  'coconut milk', 'coconut cream', 'salsa', 'chickpeas', 'garbanzo beans', 'black beans',
  'kidney beans', 'pinto beans', 'cannellini beans', 'white beans', 'refried beans',
  'broth', 'stock', 'tomato paste', 'tomato sauce', 'passata', 'tomato puree',
  'evaporated milk', 'condensed milk', 'tuna', 'anchovies', 'olives', 'capers', 'pickles',
  'mustard', 'jam',
].map((ph) => ph.split(' ').map((w) => singularOf(w)));

function onlyPreserved(words: string[]): boolean {
  if (words.includes('chipotle') && words.includes('adobo')) return true;
  return PRESERVED_ONLY.some((ph) => {
    for (let at = 0; at + ph.length <= words.length; at++) {
      if (ph.every((w, k) => words[at + k] === w)) return true;
    }
    return false;
  });
}

/**
 * Canned tomato PRODUCTS, which are never the fresh tomato: crushed, whole
 * peeled, and diced or chopped when the line is can-sized — a can/tin/jar
 * word, 10 oz / 280 g or more (not pounds, which are bought fresh), or no
 * amount at all, which is how a pantry row says 'diced tomatoes'.
 * '2 tomatoes, diced' and '1 cup diced tomatoes' are fresh. Passata and
 * tomato puree are their own words and never equal 'tomato'.
 */
function cannedTomato(text: string, unit: string | null, qty: string | null, name: string): boolean {
  const words = nameKey(bareName(name)).split(' ').filter(Boolean);
  let i = 0;
  while (i < words.length && isAmountWord(singularOf(words[i] as string))) i++;
  const rest = words.slice(i);
  const core = rest.filter((w) => !PREP_WORDS.has(w) && !PRESERVED.has(w) && !CONTAINER_WORDS.has(w) && w !== 'whole')
    .map((w) => singularOf(w));
  if (core.length !== 1 || core[0] !== 'tomato') return false;
  if (rest.includes('crushed') || rest.includes('peeled')) return true;
  if (!rest.includes('diced') && !rest.includes('chopped')) return false;
  if (containerWord(text, unit, name) !== '') return true;
  const u = unit ? unit.toLowerCase() : null;
  const q = qty === null ? null : qtyValue(qty);
  if (u !== null && q !== null && unitDimension(u) === 'mass' && u !== 'lb' && u !== 'lbs') {
    return (toBase(q, u) ?? 0) >= 280;
  }
  const aside = /\(\s*(\d+(?:[.,]\d+)?)\s*-?\s*(oz|ounces?|g|grams?)\b/i.exec(text);
  if (aside) return (toBase(Number(aside[1]!.replace(',', '.')), aside[2]!.toLowerCase().startsWith('o') ? 'oz' : 'g') ?? 0) >= 280;
  return qty === null && unit === null;
}

const CONTAINER_WORDS = new Set(['can', 'cans', 'tin', 'tins', 'jar', 'jars']);

/** Which container the line names, whatever the thing in it is. */
function containerWord(text: string, unit: string | null, name: string): '' | 'can' | 'jar' {
  const u = unit ? singularOf(unit.trim().toLowerCase()) : '';
  if (u === 'can' || u === 'tin') return 'can';
  if (u === 'jar') return 'jar';
  if (/\b(?:canned|tinned)\b/i.test(text)) return 'can';
  if (/\bjarred\b/i.test(text)) return 'jar';
  // The unit the parser missed: '1 (14 oz) can diced tomatoes', '2 tins …'.
  for (const x of nameKey(bareName(name)).split(' ').filter(Boolean).map((w) => singularOf(w))) {
    if (!isAmountWord(x)) break;
    if (x === 'can' || x === 'tin') return 'can';
    if (x === 'jar') return 'jar';
  }
  return '';
}

/** What a line or pantry row IS, for deciding it is on the shelf: one key for
 *  the whole thing, and one per thing it names when it says 'X and Y'. */
type Ident = { key: string; parts: string[] };

function identify(text: string): Ident {
  const t = text.trim();
  const p = ingredientParts(t);
  const name = p.name || t;
  const canned = cannedTomato(t, p.unit, p.qty, name);
  const c = canned ? 'can' : containerOf(t, p.unit, name);
  const prefixed = (k: string) => (k !== '' && c !== '' ? `${c}:${k}` : k);
  let base = canned ? 'tomato' : pantryKey(name);
  // 'lemon, juiced' is the juice of a lemon, said the other way round.
  const tail = /,\s*(?:finely\s+)?(juiced|zested)\b/i.exec(name);
  if (tail && CITRUS.has(base)) base = `${base} ${tail[1]!.toLowerCase() === 'juiced' ? 'juice' : 'zest'}`;
  const key = prefixed(stapleOf(base.split(' ').filter(Boolean)));
  const parts = base.split(/\s+and\s+/).filter(Boolean)
    .map((part) => prefixed(stapleOf(part.split(' ').filter(Boolean)))).filter(Boolean);
  return { key, parts: parts.length > 1 ? parts : [key] };
}

/** The shelf things that would cover a key: itself, and the thing it is a
 *  part of (PART_OF, recipe side only). */
const coverers = (key: string): string[] => (PART_OF[key] ? [key, PART_OF[key] as string] : [key]);

/**
 * What a pantry ROW is, for deciding two rows are the same ingredient: its
 * staple, with the quantity and unit a cook typed in front taken off ('500 g
 * rice' is 'rice'). A can or jar is where a thing is SOLD and keeps its own
 * identity ('2 cans tomatoes' is not the fresh tomatoes), the same exception
 * `ingredientAisle` makes. No mass/volume conversion happens: the unit only
 * decides the key's class, never a number.
 */
export function pantryRowKey(text: string): string {
  return identify(text).key;
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

/** The pantry as shelf things: identity → the first ROW that holds it. */
function shelf(pantry: readonly string[]): Map<string, string> {
  const have = new Map<string, string>();
  for (const row of pantry) {
    const key = pantryRowKey(row);
    if (key !== '' && !have.has(key)) have.set(key, row);
  }
  return have;
}

/**
 * The pantry rows that cover this line, or null when it is not all on hand.
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
function coveredBy(have: ReadonlyMap<string, string>, id: Ident): string[] | null {
  if (id.key === '') return null;
  const find = (key: string): string | undefined => {
    for (const k of coverers(key)) { const row = have.get(k); if (row !== undefined) return row; }
    return undefined;
  };
  const whole = find(id.key);
  if (whole !== undefined) return [whole];
  if (id.parts.length < 2) return null;
  const rows = id.parts.map(find);
  return rows.every((r) => r !== undefined) ? (rows as string[]) : null;
}

/** Is a pantry row (by identity) one of the things this line names? Looser
 *  than `coveredBy`: a cook who had salt used salt even if pepper ran out. */
function lineUses(rowKey: string, id: Ident): boolean {
  if (rowKey === '' || id.key === '') return false;
  return coverers(id.key).includes(rowKey) || (id.parts.length > 1 && id.parts.some((k) => coverers(k).includes(rowKey)));
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
  const { kept, added } = foldIntoList(existing, incoming);
  return { kept, added };
}

/** `mergeIntoList`, with a record of which incoming line landed on which
 *  existing row (`at` indexes `existing`) and what that row became. */
function foldIntoList(existing: readonly string[], incoming: readonly string[]): {
  kept: string[];
  added: string[];
  folds: { line: string; at: number; result: string }[];
} {
  const kept = existing.slice();
  const fresh: string[] = [];
  const folds: { line: string; at: number; result: string }[] = [];
  for (const line of incoming) {
    // Against the CURRENT text, so a second line can fold into a row the
    // first one already changed — two recipes each wanting butter.
    const at = kept.findIndex((t) => recombineLines([t, line]).length === 1);
    if (at < 0) { fresh.push(line); continue; }
    const [combined] = recombineLines([kept[at] as string, line]);
    if (combined !== undefined) { kept[at] = combined; folds.push({ line, at, result: combined }); }
  }
  // The leftovers meet each other too: `shoppingLines` combined them on the
  // STRICT reading, and 'onion' beside 'chopped onions' only meets on the
  // loose one — which is the reading every line above just had.
  return { kept, added: recombineLines(fresh), folds };
}

function shoppingEntries(
  sources: readonly ShoppingSource[],
  pantry: readonly string[],
  loose = false,
): { text: string; name: string; aisle: Aisle }[] {
  return buildEntries(sources, pantry, loose).rows;
}

/** An entry plus who asked for it. */
type Tracked = Entry & { from: string[]; srcs: Set<number>; match: string };

/**
 * The one pass behind every list: what to buy, what the pantry covered, and
 * how many lines collapsed into another recipe's. `rows` is what
 * `shoppingLines` has always answered; the rest is what the plan view shows.
 */
function buildEntries(
  sources: readonly ShoppingSource[],
  pantry: readonly string[],
  loose: boolean,
): {
  rows: { text: string; name: string; aisle: Aisle; from: string[] }[];
  held: { text: string; from: string[]; match: string }[];
  combined: number;
} {
  const keyOfName = loose ? looseNameKey : nameKey;
  // The pantry reads names its OWN way, the same way in both passes: whether
  // two lines of a list combine and whether a cupboard already holds one of
  // them are different questions, and the second one has to survive '1 tsp',
  // 'a pinch of' and 'to taste' alike.
  const have = shelf(pantry);
  // Insertion-ordered, which is what Map guarantees and a plain object does
  // not for numeric-looking keys.
  const seen = new Map<string, Tracked>();
  const held = new Map<string, Tracked>();
  let combined = 0;
  sources.forEach((src, srcIx) => {
    for (const line of src.ingredients) {
      const text = line.trim();
      // A subheader is a heading for the COOK ("For the béchamel:"), not a
      // thing to buy. It carries no quantity by definition — that is what
      // isSubheader tests — so it would otherwise arrive as a bare row
      // telling you to purchase a phase of the work.
      if (text === '' || isSubheader(text)) continue;
      // 'juice of a lemon' is a lemon to buy (strict pass only: Refresh
      // combines rows somebody already put on the list).
      const conv = loose ? null : fruitLine(text);
      const p = conv ? { qty: String(conv.n), unit: null, name: conv.fruit } : ingredientParts(text);
      // The bracketed metric measure wins over the cook's own, and only in
      // the loose pass: it is a second reading of the SAME line rather than a
      // conversion, so it can never be wrong in the way a density would be.
      const aside = loose ? metricAside(text) : null;
      const unit = (aside?.unit ?? p.unit)?.toLowerCase() ?? null;
      let name = loose ? bareName(p.name) : p.name.trim();
      // A bare citrus fruit is counted in whole fruits, whichever way a line
      // spelled it, so '1 lemon' and 'juice of 2 lemons' are one line.
      const fruit = !loose && unit === null && /^\p{L}+$/u.test(name) && CITRUS.has(singularOf(name.toLowerCase()))
        ? singularOf(name.toLowerCase()) : null;
      if (fruit) name = fruit;
      const nk = keyOfName(name);
      const id = identify(text);
      // Water and ice are never bought. Strict pass only: Refresh combines
      // rows somebody put on the list, and must not make one vanish.
      if (!loose && ALWAYS_ON_HAND.has(id.key)) continue;
      const rows = have.size > 0 ? coveredBy(have, id) : null;
      const into = rows ? held : seen;
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
      const prev = into.get(key);
      if (!prev) {
        into.set(key, {
          qty, dim, unit, name, raw: conv ? `${conv.n} ${conv.fruit}` : text, fruit: fruit !== null,
          from: src.title ? [src.title] : [], srcs: new Set([srcIx]), match: rows ? rows.join(', ') : '',
        });
        continue;
      }
      // Two recipes asking for the same thing is one line, and worth saying.
      if (into === seen && !prev.srcs.has(srcIx)) combined++;
      prev.srcs.add(srcIx);
      if (src.title && !prev.from.includes(src.title)) prev.from.push(src.title);
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
  });
  return {
    rows: [...seen.values()].map((e) => ({
      text: render(e, loose), name: e.name, aisle: ingredientAisle(e.name, e.unit), from: e.from,
    })),
    held: [...held.values()].map((e) => ({ text: render(e, loose), from: e.from, match: e.match })),
    combined,
  };
}

/**
 * The shopping PLAN: what to buy, what the pantry already covers, what would
 * fold into rows the list already has, and how many lines two recipes shared.
 * The same combining as `shoppingLines`, in the same order, with the reasons
 * left in. `from` is the recipe titles that want a line; `match` is the
 * pantry ROW that covered it; `merges` are the lines `mergeIntoList` would add
 * to an existing list row (`into` is that row as it stands in `list`, `result`
 * what it becomes).
 */
export function shoppingPlan(
  sources: ShoppingSource[],
  pantry: readonly string[],
  list: readonly string[],
): {
  toBuy: { text: string; name: string; aisle: Aisle; from: string[] }[];
  inPantry: { text: string; from: string[]; match: string }[];
  merges: { text: string; into: string; result: string }[];
  combined: number;
} {
  const { rows, held, combined } = buildEntries(sources, pantry, false);
  const { folds } = foldIntoList(list, rows.map((r) => r.text));
  return {
    toBuy: rows,
    inPantry: held,
    merges: folds.map((f) => ({ text: f.line, into: list[f.at] as string, result: f.result })),
    combined,
  };
}

/** How many shopping lines this one recipe would add, given the pantry — the
 *  recipe list's "2 to buy" / "Have everything". */
export function recipeStillToBuy(ingredients: readonly string[], pantry: readonly string[]): number {
  return buildEntries([{ title: null, ingredients: [...ingredients] }], pantry, false).rows.length;
}

/** The recipes with an ingredient this pantry row covers, and the first line
 *  that does — the pantry row's "used in". */
export function pantryUsedBy(
  row: string,
  recipes: readonly { id: string; title: string; ingredients: readonly string[] }[],
): { id: string; title: string; line: string }[] {
  const rowKey = pantryRowKey(row);
  const out: { id: string; title: string; line: string }[] = [];
  for (const r of recipes) {
    const line = r.ingredients.find((l) => {
      const t = l.trim();
      return t !== '' && !isSubheader(t) && lineUses(rowKey, identify(t));
    });
    if (line !== undefined) out.push({ id: r.id, title: r.title, line });
  }
  return out;
}

/** The pantry rows this recipe uses, in pantry order — the "Ran out?" step
 *  after cooking. */
export function pantryUsedIn(ingredients: readonly string[], pantry: readonly string[]): string[] {
  const ids = ingredients.map((l) => l.trim()).filter((t) => t !== '' && !isSubheader(t)).map(identify);
  const out: string[] = [];
  for (const row of pantry) {
    const rowKey = pantryRowKey(row);
    if (rowKey !== '' && !out.includes(row) && ids.some((id) => lineUses(rowKey, id))) out.push(row);
  }
  return out;
}

/**
 * The name a pantry row would carry for a bought line: the ingredient alone,
 * in the words and case the cook wrote — no amount, unit, preparation word or
 * comma note ('30 ml chopped parsley' is 'parsley', '59 ml fresh basil, torn'
 * is 'basil'), a part named as the whole ('juice of a lemon' is 'lemon'), and
 * every KIND word kept ('red onion', 'dried basil'). A can or jar of a thing
 * with a fresh form stays one ('canned tomatoes'). Whatever it answers still
 * covers the line it came from: if the tidy name would not, the plainer one
 * is used.
 */
function pantryNameOf(text: string): string {
  const t = text.trim();
  const fruit = fruitLine(t);
  if (fruit) return fruit.fruit;
  const p = ingredientParts(t);
  const name = p.name || t;
  const tokens = bareName(name).replace(USE_TAIL, '').trim().split(' ').filter(Boolean);
  let i = 0;
  while (i < tokens.length && isAmountWord(singularOf(tokens[i]!.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')))) i++;
  const plain = (tokens.slice(i).length > 0 ? tokens.slice(i) : tokens);
  // A canned tomato product named by its form ('28 oz crushed tomatoes') keeps
  // that form as its name; one in an actual can is 'canned tomatoes'.
  const asProduct = cannedTomato(t, p.unit, p.qty, name) && containerWord(t, p.unit, name) === '';
  const c = asProduct ? '' : containerOf(t, p.unit, name);
  const withContainer = (words: string[]): string => {
    const out = words.join(' ');
    return c === '' || /\b(?:canned|tinned|jarred)\b/i.test(out) ? out : `${c === 'can' ? 'canned' : 'jarred'} ${out}`;
  };
  const covered = (n: string) => coveredBy(shelf([n]), identify(t)) !== null;
  const lower = (w: string) => w.toLowerCase();
  const KEEP_FORM = new Set(['crushed', 'diced', 'chopped', 'peeled']);
  // Preparation words go ('crushed red pepper' and a canned product's form stay).
  let tidy = plain.filter((w, at) => (!PREP_WORDS.has(lower(w)) || lower(w) === 'extra'
    || (asProduct && KEEP_FORM.has(lower(w))) || (lower(w) === 'crushed' && lower(plain[at + 1] ?? '') === 'red')));
  if (tidy.length === 0) tidy = plain;
  // 'fresh', 'cracked' and 'ground' go only where they change nothing.
  for (const drop of ['fresh', 'cracked', 'ground']) {
    const without = tidy.filter((w) => lower(w) !== drop);
    if (without.length > 0 && without.length < tidy.length
      && identify(withContainer(without)).key === identify(withContainer(tidy)).key) tidy = without;
  }
  // A part is named as the whole ('garlic cloves' is 'garlic', 'egg yolks' is
  // 'egg') — but never bottled juice or zest: 'lemon juice' is its own row,
  // and only 'juice of a lemon' (above) names the fruit.
  const k = stapleOf(pantryKey(tidy.join(' ')).split(' ').filter(Boolean));
  const whole = /\b(?:juice|zest)$/.test(k) ? undefined : PART_OF[k];
  let named = withContainer(tidy);
  if (whole !== undefined) {
    named = /^\p{Lu}/u.test(tidy[0] as string) ? whole.charAt(0).toUpperCase() + whole.slice(1) : whole;
  }
  if (covered(named)) return named;
  const fallback = withContainer(plain);
  return covered(fallback) ? fallback : plain.join(' ');
}

/**
 * What ticking off the shopping list offers to put in the pantry: one entry
 * per DONE row. `already` is the pantry holding it; `defaultOn` is whether the
 * box starts ticked — not when it is already there, and not for an `Other`
 * thing the aisles could not place (batteries, a card).
 */
export function doneShoppingPlan(
  rows: readonly { id: string; text: string; done: boolean }[],
  pantry: readonly string[],
): { id: string; text: string; name: string; aisle: Aisle; defaultOn: boolean; already: boolean }[] {
  const have = shelf(pantry);
  const out: { id: string; text: string; name: string; aisle: Aisle; defaultOn: boolean; already: boolean }[] = [];
  for (const r of rows) {
    if (!r.done) continue;
    const text = r.text.trim();
    if (text === '') continue;
    const id = identify(text);
    if (ALWAYS_ON_HAND.has(id.key)) continue;
    const p = ingredientParts(text);
    const aisle = ingredientAisle(p.name || text, p.unit);
    const already = coveredBy(have, id) !== null;
    out.push({ id: r.id, text: r.text, name: pantryNameOf(text), aisle, defaultOn: aisle !== 'Other' && !already, already });
  }
  return out;
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
  return `${amount} ${loose || e.fruit ? countName(e.name, e.qty) : e.name}`.trim();
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
 * own reading, `pantryRowKey`) is left out, and so is a repeat within
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
