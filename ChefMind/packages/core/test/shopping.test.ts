import { describe, expect, it } from 'vitest';
import { mergeIntoList, pantryKey, shoppingLines, shoppingRows } from '../src/shopping';

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
      'kosher salt',
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
    expect(shoppingLines([r('a', ['freshly ground black pepper'])], ['pepper']))
      .toEqual(['freshly ground black pepper']);
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
