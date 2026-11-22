/**
 * Measures, converted — so a shopping list can say how much to buy in ONE
 * unit per thing instead of repeating itself.
 *
 * The owner, 2026-08-22: "sum the total amount needed to purchase in a consistent
 * unit by type... grams/ml if possible, even if converted properly... or
 * cups/oz if necessary.. tsp/tbsp are all fine".
 *
 * WHAT CHANGED, AND WHAT DID NOT. shopping.ts used to refuse all conversion,
 * on the grounds that turning '1 cup butter' into grams means choosing a
 * density and a list that invents numbers is worse than one that repeats
 * itself. That reasoning is still exactly right — and it only ever applied
 * ACROSS dimensions. A cup is 236.588 ml by definition, on any planet, for any
 * substance: converting volume to volume invents nothing. So:
 *
 *   - within MASS      → grams, exactly
 *   - within VOLUME    → millilitres, exactly
 *   - across the two   → REFUSED, still, and for the original reason
 *
 * A unit this file does not recognise (clove, can, stick, pinch, 'large') is
 * its own bucket and combines only with itself. That is not a gap: 3 cloves
 * and 2 cans have no common measure, and a shopping list is happier saying
 * both than guessing at either.
 */

export type Dimension = 'mass' | 'volume';

/** Grams per unit. Exact by definition — these are the international pound
 *  and ounce, not a kitchen approximation. */
const MASS: Record<string, number> = {
  g: 1,
  kg: 1000,
  oz: 28.349523125,
  lb: 453.59237,
};

/**
 * Millilitres per unit, US customary — which is what a recipe written in cups
 * means, and the only reading under which 16 tbsp is a cup.
 *
 * 'fl oz' is here and plain 'oz' is NOT, deliberately: an unqualified 'oz' in
 * a recipe is a weight far more often than not, and a wrong guess here is a
 * silent factor-of-ten error on a shopping list. UNIT_MAP does not produce
 * 'fl oz' today; this entry is what a parser change would land on.
 */
const VOLUME: Record<string, number> = {
  ml: 1,
  l: 1000,
  tsp: 4.92892159375,
  tbsp: 14.78676478125,
  cup: 236.5882365,
  pt: 473.176473,
  qt: 946.352946,
  gal: 3785.411784,
  'fl oz': 29.5735295625,
};

/** The plural forms UNIT_MAP hands back as their own keys — it canonicalises
 *  'cups' to 'cups', not to 'cup', so a lookup by the singular alone misses
 *  every ingredient anybody wrote naturally. */
const PLURAL: Record<string, string> = {
  cups: 'cup', grams: 'g', ounces: 'oz', pounds: 'lb', liters: 'l', milliliters: 'ml',
  teaspoons: 'tsp', tablespoons: 'tbsp', gallons: 'gal', quarts: 'qt', pints: 'pt',
};

/** The canonical key for a unit word, or null if this file does not measure it. */
function keyOf(unit: string): string | null {
  const u = unit.trim().toLowerCase();
  const k = PLURAL[u] ?? u;
  return MASS[k] !== undefined || VOLUME[k] !== undefined ? k : null;
}

/** Which dimension a unit belongs to, or null for one that is its own bucket. */
export function unitDimension(unit: string | null | undefined): Dimension | null {
  if (!unit) return null;
  const k = keyOf(unit);
  if (k === null) return null;
  return MASS[k] !== undefined ? 'mass' : 'volume';
}

/**
 * A quantity in its dimension's base unit (grams, or millilitres), or null
 * when the unit is not one this file measures.
 */
export function toBase(qty: number, unit: string | null | undefined): number | null {
  if (!unit) return null;
  const k = keyOf(unit);
  if (k === null) return null;
  const f = MASS[k] ?? VOLUME[k];
  return f === undefined ? null : qty * f;
}

/**
 * A base-unit amount, written the way it should appear on a list.
 *
 * Grams and millilitres up to 1000, then kilograms and litres — the point of
 * a shopping list is to be read in a shop, and "1500 g flour" is a worse
 * answer than "1.5 kg flour" for the same reason "0.0015 kg" would be.
 *
 * Rounding is deliberately coarse at the top and fine at the bottom: nobody
 * buys 1232.4 ml of milk, and nobody can measure 1.25 ml as "1 ml".
 */
export function formatBase(base: number, dim: Dimension): { qty: number; unit: string } {
  const big = dim === 'mass' ? 'kg' : 'l';
  const small = dim === 'mass' ? 'g' : 'ml';
  if (base >= 1000) return { qty: round(base / 1000, 2), unit: big };
  return { qty: round(base, base < 10 ? 2 : 0), unit: small };
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  // +Number.EPSILON so 1.005 rounds up rather than down off its float
  // representation — the classic one, and it shows on ¼ tsp amounts.
  return Math.round((n + Number.EPSILON) * f) / f;
}

/**
 * How a number prints on a list: no trailing zeros, no exponent.
 * `qtyText` in recipe.ts turns thirds and halves into ½ and ⅓, which is right
 * for a recipe card and wrong here — 236.59 ml has no vulgar fraction, and a
 * shopping list wants the decimal it computed.
 */
export function amountText(n: number): string {
  if (!Number.isFinite(n)) return '';
  return String(round(n, 2));
}
