import { describe, expect, it } from 'vitest';
import {
  doneShoppingPlan, mergeIntoList, pantryHas, pantryKey, pantryRowKey, pantryUsedBy, pantryUsedIn,
  recipeStillToBuy, shoppingLines, shoppingPlan, shoppingRows,
} from '../src';

const r = (title: string, ingredients: string[]) => ({ title, ingredients });

describe('a shopping list out of chosen recipes', () => {
  it('adds up the same thing in the same unit, in millilitres', () => {
    // 5 cups → 1182.94 ml → over a litre, so it reads as litres. The owner, 2026-08-22:
    // "sum the total amount needed to purchase in a consistent unit by type...
    // grams/ml if possible".
    //
    // Whole millilitres above 10, two decimals below: nobody buys 236.59 ml of
    // sugar, and nobody can measure 1.23 ml as "1 ml". The precision belongs
    // where the amount is small enough for it to mean something.
    expect(shoppingLines([
      r('Cake', ['2 cups flour', '1 cup sugar']),
      r('Bread', ['3 cups flour']),
    ])).toEqual(['1.18 l flour', '237 ml sugar']);
  });

  it('converts within a dimension rather than repeating itself', () => {
    // This is the case the old rule got wrong. A cup is 236.588 ml BY
    // DEFINITION — no density, no guess — so cups and tablespoons of the same
    // thing are one line.
    expect(shoppingLines([
      r('a', ['1 cup butter']),
      r('b', ['2 tbsp butter']),
    ])).toEqual(['266 ml butter']);
  });

  it('still refuses to convert ACROSS dimensions', () => {
    // Volume to mass needs a density, which differs per ingredient. Two lines
    // is a thing a person reconciles in a second; a wrong single line is not.
    expect(shoppingLines([
      r('a', ['1 cup flour']),
      r('b', ['200 g flour']),
    ])).toEqual(['237 ml flour', '200 g flour']);
  });

  it('adds mass in grams and steps up to kilograms', () => {
    expect(shoppingLines([r('a', ['1 lb beef']), r('b', ['8 oz beef'])])).toEqual(['680 g beef']);
    expect(shoppingLines([r('a', ['2 kg flour']), r('b', ['500 g flour'])])).toEqual(['2.5 kg flour']);
  });

  it('keeps a small amount readable rather than rounding it to nothing', () => {
    // ¼ tsp is 1.23 ml. Rounded to a whole millilitre it would read as 1, and
    // at the bottom of the scale that is a 20% error on a measurement.
    expect(shoppingLines([r('a', ['1/4 tsp salt'])])).toEqual(['1.23 ml salt']);
  });

  it('counts unitless things without pretending they have a measure', () => {
    expect(shoppingLines([r('a', ['2 large eggs']), r('b', ['3 large eggs'])])).toEqual(['5 large eggs']);
  });

  it('leaves a unit it does not measure alone, and says cloves at more than one', () => {
    expect(shoppingLines([r('a', ['1 clove garlic']), r('b', ['3 cloves garlic'])])).toEqual(['4 cloves garlic']);
    expect(shoppingLines([r('a', ['2 cans tomatoes'])])).toEqual(['2 cans tomatoes']);
  });

  it('collapses a repeated ingredient that carries no quantity', () => {
    expect(shoppingLines([
      r('a', ['salt to taste']),
      r('b', ['salt to taste']),
    ])).toEqual(['salt to taste']);
  });

  it('drops the cook’s subheaders — they are not things to buy', () => {
    expect(shoppingLines([r('a', ['For the béchamel:', '2 cups milk'])])).toEqual(['473 ml milk']);
  });

  it('leaves a RANGE alone rather than putting a number on it nobody wrote', () => {
    const out = shoppingLines([r('a', ['2-3 cloves garlic']), r('b', ['4 cloves garlic'])]);
    expect(out).toEqual(['2-3 cloves garlic']);
  });

  it('a range poisons the sum whichever side it arrives on', () => {
    // The first line parses and the second does not. Before, the second was
    // simply skipped and the list claimed 4 — a number smaller than the truth,
    // stated with confidence.
    expect(shoppingLines([r('a', ['4 cloves garlic']), r('b', ['2-3 cloves garlic'])]))
      .toEqual(['4 cloves garlic']);
  });

  it('keeps the order the recipes were picked in', () => {
    expect(shoppingLines([
      r('a', ['1 onion', '1 cup rice']),
      r('b', ['1 lemon']),
    ])).toEqual(['1 onion', '237 ml rice', '1 lemon']);
  });

  it('is empty for nothing, and for a recipe with no ingredients', () => {
    expect(shoppingLines([])).toEqual([]);
    expect(shoppingLines([r('a', [])])).toEqual([]);
    expect(shoppingLines([r('a', ['   '])])).toEqual([]);
  });
});

describe('the big US volumes', () => {
  it('adds gallons, quarts and pints like any other volume', () => {
    // Found the first time the owner's Cheese card reached the list: '½ gal whole
    // milk' and '1 gal whole milk' had no unit between them, so 'gal' stayed
    // part of the NAME and the row read '1 ½ gal whole milk'.
    expect(shoppingLines([r('a', ['1/2 gal whole milk']), r('b', ['1 gal whole milk'])]))
      .toEqual(['5.68 l whole milk']);
    expect(shoppingLines([r('a', ['1 qt heavy cream'])])).toEqual(['946 ml heavy cream']);
    expect(shoppingLines([r('a', ['1 pt cream']), r('b', ['1 cup cream'])])).toEqual(['710 ml cream']);
  });

  it('a quart and four cups are the same quart', () => {
    expect(shoppingLines([r('a', ['1 qt stock']), r('b', ['4 cups stock'])])).toEqual(['1.89 l stock']);
  });
});

describe('the pantry', () => {
  it('leaves out what is already on hand', () => {
    // The owner, 2026-08-22: "if something is on the pantry already, skip adding to
    // shopping cart". Left OUT, not struck through — a list you have to read
    // past is the thing it was meant to save you from.
    expect(shoppingLines([r('a', ['2 cups flour', '3 eggs', '1 tsp salt'])], ['flour', 'salt']))
      .toEqual(['3 eggs']);
  });

  it('matches on the ingredient NAME, however the pantry row was written', () => {
    expect(shoppingLines([r('a', ['2 cups flour'])], ['1 kg flour'])).toEqual([]);
    expect(shoppingLines([r('a', ['2 cups Flour'])], ['flour'])).toEqual([]);
  });

  it('does not match a different thing that merely contains the word', () => {
    expect(shoppingLines([r('a', ['2 cups almond flour'])], ['flour']))
      .toEqual(['473 ml almond flour']);
  });

  it('an empty pantry changes nothing', () => {
    expect(shoppingLines([r('a', ['3 eggs'])], [])).toEqual(['3 eggs']);
  });

  it('a measure written in WORDS is still a measure', () => {
    // The owner, 2026-09-18: "if i have salt in the pantry, and it calls for a
    // pinch of salt or some amount of salt, it shouldn't go on the shopping
    // list." '1 tsp salt' always worked, because the parser takes a numeric
    // measure off the name; 'a pinch of salt' is a line with no quantity at
    // all, so the whole phrase WAS the name and no pantry row could equal it.
    const pantry = ['salt', 'olive oil', 'thyme'];
    expect(shoppingLines([r('a', [
      'a pinch of salt',
      'pinch of salt',
      'a pinch salt',
      'salt to taste',
      'a splash of olive oil',
      'some olive oil',
      'olive oil, for frying',
      'a few sprigs of thyme',
    ])], pantry)).toEqual([]);
  });

  it('two things on one line go only when BOTH are on hand', () => {
    // The commonest line in any recipe. Half of it cannot be crossed off, so
    // a cook with salt and no pepper still gets the line, whole.
    const line = ['Salt and pepper to taste'];
    expect(shoppingLines([r('a', line)], ['salt', 'pepper'])).toEqual([]);
    expect(shoppingLines([r('a', line)], ['salt'])).toEqual(['Salt and pepper to taste']);
    expect(shoppingLines([r('a', line)], [])).toEqual(['Salt and pepper to taste']);
  });

  it('a KIND of a staple is the staple', () => {
    // The owner, 2026-09-18: "i have sugar in my pantry yet these both showed up",
    // of a list carrying three lines of granulated sugar and two of all
    // purpose flour. A word that narrows a staple without changing what you
    // come home with is read past, on both sides.
    expect(shoppingLines([r('a', [
      '1/4 cup granulated sugar',
      '2 cups (500 grams) all purpose flour',
      'sea salt, to taste',
    ])], ['sugar', 'flour', 'salt'])).toEqual([]);
    // …and the cupboard holding the KIND holds the staple too.
    expect(shoppingLines([r('a', ['2 cups flour'])], ['unbleached all purpose flour'])).toEqual([]);
  });

  it('a measure the line said TWICE is still a measure', () => {
    // A real line off the owner's list: the parser takes the first measure, the
    // bracketed one is an aside, and what is left as the NAME begins '1
    // tablespoon'. It sat on a list under a pantry that had sugar in it.
    expect(shoppingLines(
      [r('a', ['1/3 cup (70 grams) + 1 tablespoon granulated sugar'])], ['sugar'],
    )).toEqual([]);
  });

  it('half an egg is an egg', () => {
    // The owner, same day: "things like egg yolk should realize i already have
    // eggs". Named outright rather than by a rule, because 'white' is exactly
    // the word a general rule must not be allowed to drop.
    expect(shoppingLines([r('a', ['3 egg yolks', '1 egg white', '2 large eggs'])], ['eggs']))
      .toEqual([]);
  });

  it('still does not claim a DIFFERENT thing that reads similarly', () => {
    // The standing rule, and what every list above is bounded by: a variety
    // word narrows a staple, and these name another bag on the shelf.
    expect(shoppingLines([r('a', ['2 cups almond flour'])], ['flour']))
      .toEqual(['473 ml almond flour']);
    expect(shoppingLines([r('a', ['1 cup powdered sugar'])], ['sugar']))
      .toEqual(['237 ml powdered sugar']);
    expect(shoppingLines([r('a', ['1 cup brown sugar'])], ['sugar']))
      .toEqual(['237 ml brown sugar']);
    // Colour words especially: white sugar is granulated sugar, but white
    // wine is not red wine, and one list cannot tell those apart.
    expect(shoppingLines([r('a', ['1 cup white wine'])], ['wine']))
      .toEqual(['237 ml white wine']);
    // (2026-11-21: 'freshly ground black pepper' used to stay here; it is
    // preparation and a bare pepper row covers it. A KIND of pepper still
    // does not.)
    expect(shoppingLines([r('a', ['1 tsp red pepper flakes'])], ['pepper']))
      .toEqual(['4.93 ml red pepper flakes']);
  });

  it('takes a vague word off the FRONT only', () => {
    // 'chocolate drops' is a thing to buy; eating the 'drops' off it would
    // let a pantry row for chocolate claim it.
    expect(shoppingLines([r('a', ['chocolate drops'])], ['chocolate'])).toEqual(['chocolate drops']);
    expect(shoppingLines([r('a', ['a drop of vanilla'])], ['vanilla'])).toEqual([]);
  });

  it('reads a pantry row the same way it reads a recipe line', () => {
    expect(pantryKey('a pinch of salt')).toBe('salt');
    expect(pantryKey('salt to taste')).toBe('salt');
    expect(pantryKey('olive oil, for frying')).toBe('olive oil');
    // Never emptied: a row that says only 'a pinch' says 'a pinch'.
    expect(pantryKey('a pinch')).toBe('a pinch');
    expect(pantryKey('')).toBe('');
  });
});

describe('folding an add into the list already there', () => {
  // The owner, 2026-09-18: "duplicate ingredients i don't have in my pantry should
  // always be combined automatically." Two recipes added minutes apart were
  // leaving two lines of all purpose flour.
  it('adds the new amount to the row that is already there', () => {
    const { kept, added } = mergeIntoList(['500 g all purpose flour'], ['25 g all purpose flour']);
    expect(kept).toEqual(['525 g all purpose flour']);
    expect(added).toEqual([]);
  });

  it('keeps the list the same length and in the same order', () => {
    // The caller has ids, an order somebody dragged the rows into and wording
    // they may have edited; a rebuild from strings throws all three away.
    const { kept, added } = mergeIntoList(
      ['3 eggs', '500 g flour', '2 onions'],
      ['1 onion', '250 ml milk'],
    );
    expect(kept).toEqual(['3 eggs', '500 g flour', '3 onions']);
    expect(added).toEqual(['250 ml milk']);
  });

  it('a second line folds into a row the first one just changed', () => {
    const { kept } = mergeIntoList(['100 g butter'], ['50 g butter', '25 g butter']);
    expect(kept).toEqual(['175 g butter']);
  });

  it('leaves a different thing alone, however alike it reads', () => {
    const { kept, added } = mergeIntoList(['500 g flour'], ['200 g almond flour']);
    expect(kept).toEqual(['500 g flour']);
    expect(added).toEqual(['200 g almond flour']);
  });

  it('does not add across dimensions — it has no density to do it with', () => {
    // The rule this file has kept since the day conversion arrived: grams and
    // cups of the same thing are two lines, and a list that invents a density
    // is worse than one that repeats itself.
    const { kept, added } = mergeIntoList(['500 g flour'], ['2 cups flour']);
    expect(kept).toEqual(['500 g flour']);
    expect(added).toEqual(['473 ml flour']);
  });

  it('the leftovers meet each other on the loose reading too', () => {
    const { kept, added } = mergeIntoList([], ['1 onion', '2 chopped onions']);
    expect(kept).toEqual([]);
    expect(added).toEqual(['3 onions']);
  });

  it('an empty add changes nothing', () => {
    expect(mergeIntoList(['3 eggs'], [])).toEqual({ kept: ['3 eggs'], added: [] });
  });
});

describe('rows carry the aisle to shop them in', () => {
  it('files each line where it is found in the shop', () => {
    const rows = shoppingRows([r('a', ['3 eggs', '1 onion', '1 lb beef', '2 cups flour'])]);
    expect(rows.map((x) => x.aisle)).toEqual(['Dairy & Eggs', 'Produce', 'Meat & Seafood', 'Dry Goods']);
  });

  it('files by the ingredient, never by the measure it was counted in', () => {
    // '3 cloves garlic' is Produce. The clove that is a spice is a different
    // word wearing the same spelling, and filing by the unit put garlic in
    // the spice rack.
    const rows = shoppingRows([r('a', ['3 cloves garlic', '2 cans tomatoes'])]);
    expect(rows.map((x) => x.aisle)).toEqual(['Produce', 'Cans & Jars']);
  });
});

// ---------------------------------------------------------------------------
// The owner, 2026-11-21: pantry matching. Every rule has a positive case and a
// negative one beside it.
// ---------------------------------------------------------------------------

/** Lines of one recipe left to buy, as the text of each, given a pantry. */
const left = (lines: string[], pantry: string[]) => shoppingLines([r('t', lines)], pantry);
/** True when the pantry covers the line (nothing left to buy). */
const covers = (pantry: string[], line: string) => left([line], pantry).length === 0;

describe('pantry rule 1: units never count', () => {
  it('whether the parser caught them or not', () => {
    for (const line of ['2 cups flour', '1 tbsp flour', '200 g flour', '8 oz flour', '1 lb flour',
      'a pinch of flour', 'flour 2 cups', '2 dl flour', '1 (14 oz) flour']) {
      expect(covers(['flour'], line), line).toBe(true);
    }
    // …and in the pantry row too.
    expect(covers(['2 lb flour'], '1 cup flour')).toBe(true);
    expect(pantryRowKey('500 g flour')).toBe(pantryRowKey('flour'));
    // negative: a different thing with the same unit is still different.
    expect(covers(['flour'], '2 cups sugar')).toBe(false);
  });

  it('a can, tin or jar is the exception: it means preserved', () => {
    const canned = ['canned tomatoes', '1 can tomatoes', '2 tins tomatoes', '1 (14 oz) can diced tomatoes',
      '1 400g tin chopped tomatoes', 'tomatoes, canned'];
    const keys = new Set(canned.map(pantryRowKey));
    expect([...keys]).toEqual(['can:tomato']);
    expect(pantryRowKey('1 jar tomatoes')).toBe(pantryRowKey('jarred tomatoes'));
    expect(pantryRowKey('1 jar tomatoes')).toBe('jar:tomato');
    expect(pantryRowKey('1 jar tomatoes')).not.toBe(pantryRowKey('1 can tomatoes'));
    // negative: none of them is the fresh tomato.
    for (const c of canned) {
      expect(pantryRowKey(c), c).not.toBe(pantryRowKey('tomatoes'));
      expect(covers(['tomatoes'], c), c).toBe(false);
    }
    expect(covers(['tomatoes'], 'canned tomatoes')).toBe(false);
    expect(covers(['canned tomatoes'], '2 tins tomatoes')).toBe(true);
    expect(covers(['2 cans tomatoes'], '1 can (28 oz) crushed tomatoes')).toBe(true);
    expect(covers(['canned tomatoes'], 'tomatoes')).toBe(false);
    expect(pantryHas(['1 can tomatoes'], '3 cans tomatoes')).toBe(true);
  });
});

describe('pantry rule 2: fresh, canned and dried are different things', () => {
  it('fresh is what a bare name means; dried is a kind and never dropped', () => {
    expect(covers(['basil'], 'fresh basil')).toBe(true);
    expect(covers(['fresh basil'], '1 cup basil')).toBe(true);
    expect(covers(['basil'], '1 tsp dried basil')).toBe(false);
    expect(covers(['dried basil'], 'basil')).toBe(false);
    expect(covers(['dried basil'], '2 tsp dried basil')).toBe(true);
    expect(covers(['dried oregano'], 'fresh oregano')).toBe(false);
  });
});

describe('pantry rule 3: preparation words never count', () => {
  it('fresh ground pepper in any wording matches pepper and black pepper', () => {
    for (const line of ['fresh ground pepper', 'freshly ground black pepper', 'coarsely ground pepper',
      '1/2 tsp cracked black pepper', 'ground black pepper']) {
      expect(covers(['pepper'], line), line).toBe(true);
      expect(covers(['black pepper'], line), line).toBe(true);
    }
    // negative: no pepper in the pantry, no match.
    expect(covers(['salt'], 'freshly ground black pepper')).toBe(false);
  });

  it('ground comes off a spice only: ground beef keeps it', () => {
    expect(covers(['cumin'], '1 tsp ground cumin')).toBe(true);
    expect(covers(['ground cinnamon'], 'cinnamon')).toBe(true);
    expect(covers(['ground beef'], '1 lb beef')).toBe(false);
    expect(covers(['beef'], '1 lb ground beef')).toBe(false);
    expect(covers(['ground beef'], '1 lb ground beef')).toBe(true);
    expect(covers(['turkey'], '1 lb ground turkey')).toBe(false);
  });
});

describe('pantry rule 4: form-sensitive spices keep ground', () => {
  it('ground ginger, coriander, mustard and turmeric are not the bare names', () => {
    expect(covers(['ginger'], '1 tsp ground ginger')).toBe(false);
    expect(covers(['ground ginger'], '1 tsp ginger')).toBe(false);
    expect(covers(['ground ginger'], '1/2 tsp ground ginger')).toBe(true);
    expect(covers(['cilantro'], '1 tsp ground coriander')).toBe(false);
    expect(covers(['coriander'], '1 tsp ground coriander')).toBe(false);
    expect(covers(['mustard'], '1 tsp ground mustard')).toBe(false);
    expect(covers(['turmeric'], '1 tsp ground turmeric')).toBe(false);
    expect(covers(['ground turmeric'], '1 tsp ground turmeric')).toBe(true);
    // contrast: a spice that is not on the list drops it.
    expect(covers(['nutmeg'], '1/4 tsp ground nutmeg')).toBe(true);
  });
});

describe('pantry rule 5: kind words count', () => {
  it('a kind of pepper never matches pepper or black pepper', () => {
    for (const line of ['red pepper', '1 tsp red pepper flakes', '1 tsp crushed red pepper', 'cayenne pepper',
      'white pepper', '1 bell pepper', '2 jalapeño peppers']) {
      expect(covers(['pepper'], line), line).toBe(false);
      expect(covers(['black pepper'], line), line).toBe(false);
    }
    // …and each matches itself.
    expect(covers(['red pepper'], 'red pepper')).toBe(true);
    expect(covers(['red pepper flakes'], '1 tsp red pepper flakes')).toBe(true);
    expect(covers(['bell pepper'], '1 bell pepper')).toBe(true);
    expect(covers(['white pepper'], '1/2 tsp white pepper')).toBe(true);
  });

  it('kosher salt matches only kosher salt; bare salt matches salt', () => {
    expect(covers(['salt'], 'kosher salt')).toBe(false);
    expect(covers(['salt'], '1 tsp kosher salt')).toBe(false);
    expect(covers(['kosher salt'], 'salt')).toBe(false);
    expect(covers(['kosher salt'], '2 tsp kosher salt')).toBe(true);
    expect(covers(['salt'], '1 tsp salt')).toBe(true);
    // the other variety words keep their reading
    expect(covers(['salt'], 'sea salt, to taste')).toBe(true);
    expect(covers(['sugar'], '1/4 cup granulated sugar')).toBe(true);
  });
});

describe('pantry rule 6: named aliases, both ways', () => {
  const same = (a: string, b: string) => {
    expect(covers([a], `1 tsp ${b}`), `${a} covers ${b}`).toBe(true);
    expect(covers([b], `1 tsp ${a}`), `${b} covers ${a}`).toBe(true);
    expect(pantryRowKey(a)).toBe(pantryRowKey(b));
  };

  it('pepper, black pepper, peppercorns, black peppercorns', () => {
    same('pepper', 'black pepper');
    same('pepper', 'peppercorns');
    same('pepper', 'black peppercorns');
    same('black pepper', 'peppercorns');
    expect(covers(['pepper'], 'white peppercorns')).toBe(false);
  });

  it('the one-to-one pairs', () => {
    same('scallions', 'green onions');
    same('cilantro', 'fresh coriander');
    same('chicken stock', 'chicken broth');
    same('parmesan', 'parmigiano-reggiano');
    same('parmesan', 'parmigiano reggiano');
    same('olive oil', 'extra virgin olive oil');
    same('olive oil', 'extra-virgin olive oil');
    same('butter', 'unsalted butter');
    same('butter', 'salted butter');
    same('unsalted butter', 'salted butter');
    // negatives: near neighbours are not the pair
    expect(covers(['onions'], '2 green onions')).toBe(false);
    expect(covers(['cilantro'], 'coriander seeds')).toBe(false);
    expect(covers(['chicken broth'], 'beef stock')).toBe(false);
    expect(covers(['olive oil'], 'light olive oil')).toBe(false);
    expect(covers(['cheddar'], 'parmesan')).toBe(false);
    expect(covers(['peanut butter'], 'butter')).toBe(false);
  });

  it('milk grades are milk; buttermilk, coconut milk and almond milk are not', () => {
    same('milk', 'whole milk');
    same('milk', 'skim milk');
    same('milk', '2% milk');
    expect(covers(['milk'], '1 cup buttermilk')).toBe(false);
    expect(covers(['milk'], '1 can coconut milk')).toBe(false);
    expect(covers(['milk'], '1 cup almond milk')).toBe(false);
    expect(covers(['buttermilk'], 'milk')).toBe(false);
    expect(covers(['coconut milk'], '1 cup milk')).toBe(false);
  });

  it('salt and pepper to taste needs both, and pepper means black pepper', () => {
    expect(covers(['salt', 'black pepper'], 'Salt and freshly ground pepper to taste')).toBe(true);
    expect(covers(['salt', 'red pepper'], 'Salt and pepper to taste')).toBe(false);
  });
});

describe('pantry rule 7: part-of, one direction', () => {
  it('juice, zest and a garlic clove are covered by the whole', () => {
    expect(covers(['lemon'], '2 tbsp lemon juice')).toBe(true);
    expect(covers(['lemons'], '1 tsp lemon zest')).toBe(true);
    expect(covers(['lime'], '1 tbsp lime juice')).toBe(true);
    expect(covers(['lime'], 'lime zest')).toBe(true);
    expect(covers(['oranges'], '1/2 cup orange juice')).toBe(true);
    expect(covers(['orange'], '1 tsp orange zest')).toBe(true);
    expect(covers(['garlic'], '3 garlic cloves, minced')).toBe(true);
    expect(covers(['garlic'], '1 clove garlic')).toBe(true);
    expect(covers(['egg'], '2 egg yolks')).toBe(true);
  });

  it('never the other way', () => {
    expect(covers(['lemon juice'], '1 lemon')).toBe(false);
    expect(covers(['lemon juice'], '1 lemon, sliced')).toBe(false);
    expect(covers(['lime juice'], '2 limes')).toBe(false);
    expect(covers(['orange zest'], '1 orange')).toBe(false);
    expect(covers(['garlic clove'], 'garlic')).toBe(false);
    // …and a lime does not cover lemon juice
    expect(covers(['lime'], 'lemon juice')).toBe(false);
    // two pantry rows are not one ingredient just because one is part of the other
    expect(pantryHas(['lemon'], 'lemon juice')).toBe(false);
    expect(pantryHas(['lemon juice'], 'lemon')).toBe(false);
  });
});

describe('pantry rule 8: water and ice are never bought', () => {
  it('shoppingLines and shoppingRows leave them out', () => {
    const lines = ['2 cups water', '1 cup ice', '2 cups boiling water', '1/2 cup warm water',
      '1 cup cold water', 'ice', '1 cup flour'];
    expect(shoppingLines([r('a', lines)])).toEqual(['237 ml flour']);
    expect(shoppingRows([r('a', lines)]).map((x) => x.text)).toEqual(['237 ml flour']);
    // negatives: other things with water or ice in the name are bought
    expect(shoppingLines([r('a', ['1 cup coconut water', '1 pint ice cream', '1 tbsp rose water'])]))
      .toEqual(['237 ml coconut water', '473 ml ice cream', '15 ml rose water']);
  });
});

describe('shoppingPlan', () => {
  const sources = [
    r('Cake', ['2 cups flour', '1 cup sugar', '1 tsp salt', '3 eggs']),
    r('Bread', ['3 cups flour', '1 tsp salt', 'water']),
  ];

  it('says what to buy, from which recipes, and how many lines collapsed', () => {
    const plan = shoppingPlan(sources, ['salt'], []);
    expect(plan.toBuy).toEqual([
      { text: '1.18 l flour', name: 'flour', aisle: 'Dry Goods', from: ['Cake', 'Bread'] },
      { text: '237 ml sugar', name: 'sugar', aisle: 'Dry Goods', from: ['Cake'] },
      { text: '3 eggs', name: 'eggs', aisle: 'Dairy & Eggs', from: ['Cake'] },
    ]);
    expect(plan.combined).toBe(1);
    // the same order shoppingLines gives
    expect(plan.toBuy.map((x) => x.text)).toEqual(shoppingLines(sources, ['salt']));
  });

  it('says what the pantry covered, by which row', () => {
    const plan = shoppingPlan(sources, ['Kosher salt', '1 kg salt'], []);
    expect(plan.inPantry).toEqual([{ text: '9.86 ml salt', from: ['Cake', 'Bread'], match: '1 kg salt' }]);
    // negative: the water was never a candidate, in either list
    expect(plan.toBuy.some((x) => /water/.test(x.text))).toBe(false);
    expect(plan.inPantry.some((x) => /water/.test(x.text))).toBe(false);
  });

  it('lists the lines that would fold into a row already on the list', () => {
    const plan = shoppingPlan(sources, ['salt'], ['500 ml flour', '2 onions']);
    expect(plan.merges).toEqual([{ text: '1.18 l flour', into: '500 ml flour', result: '1.68 l flour' }]);
    // negative: nothing on the list, nothing to merge
    expect(shoppingPlan(sources, ['salt'], []).merges).toEqual([]);
    expect(shoppingPlan(sources, ['salt'], ['2 onions']).merges).toEqual([]);
  });

  it('counts a collapse only when TWO recipes asked', () => {
    expect(shoppingPlan([r('a', ['1 onion', '1 onion'])], [], []).combined).toBe(0);
    // the strict reading keeps 'onion' and 'onions' apart, as it always has
    expect(shoppingPlan([r('a', ['1 onion']), r('b', ['2 onions'])], [], []).combined).toBe(0);
    expect(shoppingPlan([r('a', ['1 onion']), r('b', ['1 onion'])], [], []).combined).toBe(1);
    expect(shoppingPlan([r('a', ['1 onion']), r('b', ['1 carrot'])], [], []).combined).toBe(0);
  });

  it('is empty for nothing', () => {
    expect(shoppingPlan([], [], [])).toEqual({ toBuy: [], inPantry: [], merges: [], combined: 0 });
  });
});

describe('recipeStillToBuy', () => {
  const dinner = ['2 tbsp extra-virgin olive oil', '1 lb ground beef', '1 can (14 oz) diced tomatoes',
    'Salt and freshly ground black pepper', '2 cups water'];
  it('counts the lines this recipe would add', () => {
    expect(recipeStillToBuy(dinner, [])).toBe(4);
    expect(recipeStillToBuy(dinner, ['olive oil', 'salt', 'pepper'])).toBe(2);
    expect(recipeStillToBuy(dinner, ['olive oil', 'salt', 'pepper', 'ground beef', 'canned tomatoes'])).toBe(0);
    // negatives: beef is not ground beef, tomatoes are not canned tomatoes
    expect(recipeStillToBuy(dinner, ['olive oil', 'salt', 'pepper', 'beef', 'tomatoes'])).toBe(2);
    expect(recipeStillToBuy([], [])).toBe(0);
  });
});

describe('pantryUsedBy', () => {
  const recipes = [
    { id: '1', title: 'Pasta', ingredients: ['1 lb spaghetti', 'For the sauce:', '2 cloves garlic, minced', '1 tsp freshly ground black pepper'] },
    { id: '2', title: 'Lemonade', ingredients: ['1/2 cup lemon juice', '1 cup sugar'] },
    { id: '3', title: 'Burgers', ingredients: ['1 lb ground beef'] },
  ];
  it('finds the recipes that use a pantry row, and the line', () => {
    expect(pantryUsedBy('Garlic', recipes)).toEqual([{ id: '1', title: 'Pasta', line: '2 cloves garlic, minced' }]);
    expect(pantryUsedBy('black pepper', recipes)).toEqual([{ id: '1', title: 'Pasta', line: '1 tsp freshly ground black pepper' }]);
    expect(pantryUsedBy('2 lemons', recipes)).toEqual([{ id: '2', title: 'Lemonade', line: '1/2 cup lemon juice' }]);
    expect(pantryUsedBy('sugar', recipes).map((x) => x.id)).toEqual(['2']);
  });
  it('and not the ones it does not cover', () => {
    expect(pantryUsedBy('beef', recipes)).toEqual([]);
    expect(pantryUsedBy('lemon juice', [{ id: '9', title: 'x', ingredients: ['1 lemon'] }])).toEqual([]);
    expect(pantryUsedBy('red pepper', recipes)).toEqual([]);
    expect(pantryUsedBy('flour', recipes)).toEqual([]);
  });
});

describe('pantryUsedIn', () => {
  it('returns the pantry rows a recipe uses, in pantry order', () => {
    const pantry = ['Butter', 'flour', '1 kg sugar', 'black pepper', 'cinnamon', 'lemons'];
    expect(pantryUsedIn(['2 tbsp unsalted butter', '1 tsp lemon zest', 'freshly ground pepper', '1 cup sugar'], pantry))
      .toEqual(['Butter', '1 kg sugar', 'black pepper', 'lemons']);
    // negatives
    expect(pantryUsedIn(['1 cup almond flour', '1 tsp red pepper flakes'], pantry)).toEqual([]);
    expect(pantryUsedIn([], pantry)).toEqual([]);
  });
  it('a salt-and-pepper line uses whichever of them is on the shelf', () => {
    expect(pantryUsedIn(['Salt and pepper to taste'], ['pepper'])).toEqual(['pepper']);
  });
});

describe('doneShoppingPlan', () => {
  const rows = [
    { id: 'a', text: '473 ml flour', done: true },
    { id: 'b', text: '2 cans tomatoes', done: true },
    { id: 'c', text: '3 Eggs', done: true },
    { id: 'd', text: 'paper towels', done: true },
    { id: 'e', text: '1 lb butter', done: false },
    { id: 'f', text: '1 tsp ground ginger', done: true },
  ];
  it('covers the done rows only, named as a pantry row', () => {
    const plan = doneShoppingPlan(rows, ['flour']);
    expect(plan.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd', 'f']);
    expect(plan.map((x) => x.name)).toEqual(['flour', 'canned tomatoes', 'Eggs', 'paper towels', 'ground ginger']);
    expect(plan.map((x) => x.aisle)).toEqual(['Dry Goods', 'Cans & Jars', 'Dairy & Eggs', 'Other', 'Produce']);
  });
  it('already means the pantry has it; defaultOn is off for that and for Other', () => {
    const plan = doneShoppingPlan(rows, ['flour', 'ginger']);
    expect(plan.map((x) => x.already)).toEqual([true, false, false, false, false]);
    expect(plan.map((x) => x.defaultOn)).toEqual([false, true, true, false, true]);
    // negative: a pantry that holds the fresh tomatoes does not hold the cans
    expect(doneShoppingPlan(rows, ['tomatoes']).find((x) => x.id === 'b')?.already).toBe(false);
    expect(doneShoppingPlan(rows, ['canned tomatoes']).find((x) => x.id === 'b')?.already).toBe(true);
    expect(doneShoppingPlan([], ['flour'])).toEqual([]);
  });
});

describe('a container is an identity only for a thing with a fresh form', () => {
  it('tomatoes: cans are not fresh, either way round', () => {
    expect(covers(['tomatoes'], '2 cans diced tomatoes')).toBe(false);
    expect(covers(['canned tomatoes'], '2 tomatoes')).toBe(false);
    expect(covers(['canned tomatoes'], '1 can diced tomatoes')).toBe(true);
    expect(covers(['tomatoes'], '2 tomatoes')).toBe(true);
  });

  it('only-ever-preserved things read the container as a unit', () => {
    expect(covers(['coconut milk'], '1 can coconut milk')).toBe(true);
    expect(covers(['1 can coconut milk'], 'coconut milk')).toBe(true);
    expect(covers(['salsa'], '1 jar salsa')).toBe(true);
    expect(covers(['chickpeas'], '1 can chickpeas')).toBe(true);
    expect(covers(['canned chickpeas'], '2 cups chickpeas')).toBe(true);
    expect(pantryRowKey('1 can coconut milk')).toBe(pantryRowKey('coconut milk'));
    // negatives: a different thing is still different
    expect(covers(['coconut milk'], '1 can chickpeas')).toBe(false);
    expect(covers(['milk'], '1 can coconut milk')).toBe(false);
    expect(covers(['salsa'], '1 jar tomatoes')).toBe(false);
  });

  it('black beans file as Cans & Jars, so the can is only a unit', () => {
    expect(shoppingRows([r('a', ['1 can black beans'])])[0]?.aisle).toBe('Cans & Jars');
    expect(covers(['black beans'], '1 can black beans')).toBe(true);
    expect(covers(['1 can black beans'], 'black beans')).toBe(true);
    // negative: other beans are other beans
    expect(covers(['black beans'], '1 can kidney beans')).toBe(false);
  });

  it('dried stays a kind, separate from the container rule', () => {
    expect(covers(['basil'], '1 tsp dried basil')).toBe(false);
    expect(covers(['dried basil'], 'basil')).toBe(false);
  });
});

describe('part-of reads "juice of 1 lemon" as lemon juice', () => {
  it('pantry lemon covers the juice or zest of one, in every wording', () => {
    for (const line of ['juice of 1 lemon', 'Juice of 1 lemon', 'the juice of half a lemon',
      '1 lemon, juiced', 'zest of 1 lemon', 'zest of a lemon']) {
      expect(covers(['lemon'], line), line).toBe(true);
      expect(covers(['lemons'], line), line).toBe(true);
    }
    expect(covers(['lime'], 'juice of 2 limes')).toBe(true);
    expect(covers(['limes'], 'zest of 1 lime')).toBe(true);
    expect(covers(['orange'], 'zest of 1 orange')).toBe(true);
    expect(covers(['oranges'], 'juice of 1 large orange')).toBe(true);
    expect(covers(['lemon juice'], 'juice of 1 lemon')).toBe(true);
  });

  it('one direction, and only the right fruit', () => {
    expect(covers(['lemon juice'], '1 lemon')).toBe(false);
    expect(covers(['lemon juice'], 'zest of 1 lemon')).toBe(false);
    expect(covers(['lime'], 'juice of 1 lemon')).toBe(false);
    expect(covers(['lemon'], 'juice of 2 limes')).toBe(false);
    expect(covers(['orange'], 'zest of 1 lemon')).toBe(false);
    expect(covers(['flour'], 'juice of 1 lemon')).toBe(false);
    expect(covers(['lemon'], 'juice of 1 lemon and 1 lime')).toBe(false);
  });
});
