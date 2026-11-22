/**
 * Which aisle a thing is in.
 *
 * The owner, 2026-08-22: "shopping should separate ingredients by the categories
 * you might find them in the grocery store... produce, meat, dry goods, cans,
 * liquids, dairy, etc".
 *
 * A shopping list is walked, not read. Ordered by the route through a shop
 * rather than alphabetically, so the list is a path: produce at the door,
 * bakery and deli round the edge, dairy and meat along the back wall, dry
 * goods and tins through the middle, frozen last so it stays cold.
 *
 * KEYWORDS, NOT A DATABASE, and that is the whole design. There is no
 * ingredient ontology in here and there should not be: what this needs to do
 * is put most things in the right place and the rest somewhere honest.
 * `Other` is a real answer, printed last, and a row in it is still a row on
 * the list — nothing is ever dropped for failing to match.
 *
 * Matching is on WHOLE WORDS. Substring matching put 'butternut squash' in
 * Dairy (butter), 'grapeseed oil' in Produce (grape) and — the one that made
 * the rule — 'cream of tartar' in Dairy, which is a powder in the baking
 * aisle. A word boundary is cheap and settles all three.
 */

export type Aisle =
  | 'Produce'
  | 'Bakery'
  | 'Deli'
  | 'Meat & Seafood'
  | 'Dairy & Eggs'
  | 'Dry Goods'
  | 'Cans & Jars'
  | 'Liquids'
  | 'Spices & Seasoning'
  | 'Frozen'
  | 'Other';

/** Shop order. `Other` is last, where an unsorted pile belongs. */
export const AISLES: Aisle[] = [
  'Produce', 'Bakery', 'Deli', 'Meat & Seafood', 'Dairy & Eggs',
  'Dry Goods', 'Cans & Jars', 'Liquids', 'Spices & Seasoning', 'Frozen', 'Other',
];

/**
 * Checked IN ORDER, first match wins, so the specific beats the general:
 * 'coconut milk' has to reach Cans & Jars before 'milk' claims it for Dairy,
 * and 'ice cream' before 'cream' does. Multi-word phrases are matched as
 * phrases, which is what makes that ordering do any work at all.
 */
const RULES: [Aisle, string[]][] = [
  // Before Dairy, Produce and Dry Goods, which would otherwise take them.
  ['Frozen', ['frozen', 'ice cream', 'ice', 'puff pastry', 'phyllo', 'filo', 'peas frozen']],
  ['Cans & Jars', [
    'coconut milk', 'condensed milk', 'evaporated milk', 'tomato paste', 'tomato puree',
    'canned', 'can', 'cans', 'tinned', 'jar', 'olives', 'capers', 'anchovies', 'pickles',
    'salsa', 'jam', 'jelly', 'preserves', 'peanut butter', 'nutella', 'chickpeas',
    'garbanzo', 'black beans', 'kidney beans', 'refried beans', 'baked beans',
    'crushed tomatoes', 'diced tomatoes', 'tuna', 'sardines', 'broth', 'stock',
    'coconut cream', 'artichoke hearts', 'roasted peppers', 'sun-dried tomatoes',
  ]],
  ['Dairy & Eggs', [
    'milk', 'buttermilk', 'cream', 'heavy cream', 'half-and-half', 'sour cream',
    'creme fraiche', 'crème fraîche', 'yogurt', 'yoghurt', 'butter', 'ghee', 'egg', 'eggs',
    'cheese', 'cheddar', 'parmesan', 'parmigiano', 'mozzarella', 'burrata', 'ricotta',
    'mascarpone', 'feta', 'gruyere', 'gruyère', 'brie', 'goat cheese', 'cottage cheese',
    'cream cheese', 'rennet', 'kefir',
  ]],
  ['Meat & Seafood', [
    'beef', 'steak', 'ground beef', 'mince', 'lamb', 'pork', 'bacon', 'pancetta',
    'sausage', 'chorizo', 'ham', 'prosciutto', 'chicken', 'turkey', 'duck', 'veal',
    'brisket', 'ribs', 'shrimp', 'prawns', 'salmon', 'cod', 'halibut', 'tilapia',
    'scallops', 'mussels', 'clams', 'crab', 'lobster', 'squid', 'calamari', 'fish',
  ]],
  // Before Produce, whose bare 'pepper'/'chili' would otherwise claim the
  // ground spice. Fresh peppers ('bell pepper', 'jalapeno', plain 'pepper')
  // stay Produce.
  ['Spices & Seasoning', [
    'black pepper', 'white pepper', 'ground pepper', 'cracked pepper', 'peppercorns',
    'peppercorn', 'pepper flakes', 'red pepper flakes', 'cayenne pepper', 'chili powder',
    'chili flakes', 'salt and pepper', 'pepper and salt', 'lemon pepper', 'garlic powder',
    'onion powder',
  ]],
  ['Produce', [
    'onion', 'onions', 'shallot', 'shallots', 'garlic', 'ginger', 'scallion', 'scallions',
    'leek', 'leeks', 'celery', 'carrot', 'carrots', 'potato', 'potatoes', 'sweet potato',
    'tomato', 'tomatoes', 'cucumber', 'lettuce', 'romaine', 'spinach', 'kale', 'arugula',
    'cabbage', 'broccoli', 'cauliflower', 'zucchini', 'courgette', 'squash', 'eggplant',
    'aubergine', 'pepper', 'peppers', 'bell pepper', 'jalapeno', 'jalapeño', 'chili',
    'mushroom', 'mushrooms', 'corn', 'peas', 'green beans', 'asparagus', 'beet', 'beets',
    'radish', 'turnip', 'parsnip', 'fennel', 'avocado', 'lemon', 'lemons', 'lime', 'limes',
    'orange', 'oranges', 'apple', 'apples', 'banana', 'bananas', 'pear', 'pears', 'peach',
    'berries', 'strawberries', 'blueberries', 'raspberries', 'grapes', 'melon', 'mango',
    'pineapple', 'cilantro', 'coriander', 'parsley', 'basil', 'mint', 'dill', 'chives',
    'rosemary', 'thyme', 'sage', 'tarragon', 'herbs',
  ]],
  ['Bakery', [
    'bread', 'baguette', 'sourdough', 'ciabatta', 'roll', 'rolls', 'bun', 'buns',
    'tortilla', 'tortillas', 'pita', 'naan', 'croissant', 'brioche', 'bagel',
    'breadcrumbs', 'panko', 'cake', 'pie crust', 'tart shell',
  ]],
  ['Deli', ['deli', 'salami', 'pastrami', 'smoked salmon', 'lox', 'hummus']],
  ['Liquids', [
    'water', 'wine', 'red wine', 'white wine', 'beer', 'vodka', 'rum', 'whiskey', 'bourbon',
    'brandy', 'sherry', 'vermouth', 'juice', 'coffee', 'tea', 'soda', 'olive oil', 'oil',
    'vegetable oil', 'canola oil', 'sesame oil', 'vinegar', 'soy sauce', 'fish sauce',
    'worcestershire', 'hot sauce', 'sriracha', 'maple syrup', 'honey', 'molasses',
    'vanilla extract', 'extract',
  ]],
  ['Spices & Seasoning', [
    'salt', 'kosher salt', 'sea salt', 'black pepper', 'peppercorns', 'paprika', 'cumin',
    'cinnamon', 'nutmeg', 'clove', 'cloves', 'cardamom', 'turmeric', 'curry', 'oregano',
    'bay leaf', 'bay leaves', 'chili powder', 'cayenne', 'red pepper flakes', 'allspice',
    'saffron', 'spice', 'spices', 'seasoning', 'zest', 'msg', 'citric acid',
  ]],
  ['Dry Goods', [
    'flour', 'sugar', 'brown sugar', 'powdered sugar', 'confectioners', 'rice', 'pasta',
    'spaghetti', 'penne', 'macaroni', 'noodles', 'lasagna', 'couscous', 'quinoa', 'oats',
    'oatmeal', 'barley', 'lentils', 'beans', 'cornstarch', 'cornmeal', 'polenta',
    'baking powder', 'baking soda', 'yeast', 'cocoa', 'chocolate', 'chocolate chips',
    'nuts', 'almonds', 'walnuts', 'pecans', 'cashews', 'pistachios', 'peanuts',
    'sesame seeds', 'raisins', 'cranberries', 'dates', 'cereal', 'crackers', 'gelatin',
    'cream of tartar', 'semolina',
  ]],
];

/**
 * Pre-split into words once, at module load, rather than on every row: the
 * shopping list re-categorises its whole list on every render, and this is
 * about 400 phrases against every row.
 */
const COMPILED: [Aisle, string[][]][] = RULES.map(([aisle, phrases]) => [
  aisle,
  phrases.map((p) => p.toLowerCase().split(/\s+/)),
]);

/** An ingredient name, reduced to lowercase words with punctuation dropped. */
function words(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);
}

/** Does `hay` contain `needle` as a run of whole words? */
function hasPhrase(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * The aisle an ingredient name belongs to. Never throws, always answers:
 * `Other` is the honest result for a thing this file has never heard of.
 */
export function groceryAisle(name: string): Aisle {
  const w = words(name);
  if (w.length === 0) return 'Other';
  for (const [aisle, phrases] of COMPILED) {
    for (const p of phrases) {
      if (hasPhrase(w, p)) return aisle;
    }
  }
  return 'Other';
}

/**
 * The units that ARE an aisle. Filing by the ingredient rather than the
 * measure is the rule — it is what keeps '3 cloves garlic' out of the spice
 * rack — but a can is where a thing is sold, not how it is counted: '2 cans
 * tomatoes' belongs beside the other tins, however fresh the word tomato is.
 */
const UNIT_AISLE: Record<string, Aisle> = {
  can: 'Cans & Jars', cans: 'Cans & Jars', jar: 'Cans & Jars', jars: 'Cans & Jars',
};

/**
 * An ingredient's aisle, given its name and the unit it was counted in.
 * The name decides unless the unit names an aisle outright (see UNIT_AISLE).
 */
export function ingredientAisle(name: string, unit?: string | null): Aisle {
  const byUnit = unit ? UNIT_AISLE[unit.trim().toLowerCase()] : undefined;
  return byUnit ?? groceryAisle(name);
}
