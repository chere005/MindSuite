import { describe, expect, it } from 'vitest';
import {
  doneShoppingPlan, pantryHas, pantryRowKey, pantryUsedBy, pantryUsedIn, recipeStillToBuy, shoppingPlan,
} from '../src';

/**
 * `shelf` (one pantry array -> its identities) and `identify` (one text -> its
 * identity) are cached for speed: every recipe in the list asks "what is left
 * to buy" against the same pantry, and rebuilding the shelf per recipe and per
 * line is what made a 400-recipe cookbook take seconds to open. A cache must
 * never change an answer, so each test here compares against a computation the
 * cache cannot have touched: a COPY of the pantry (a different array, so a
 * different cache entry) or a changed pantry.
 */

const RECIPES = [
  ['2 cups flour', '1 tsp salt and pepper', '3 eggs', '1 can diced tomatoes', 'juice of a lemon', '500 g rice'],
  ['1 lb chicken thighs', '2 cloves garlic', 'fresh basil', '1 (14 oz) can chickpeas', 'olive oil', 'For the sauce:'],
  ['salt and pepper to taste', '2 tbsp butter', '1 red onion', '1/2 cup heavy cream', 'ground cumin'],
  ['3 tbsp soy sauce', '1 jar roasted peppers', 'lemon zest', '200 g pasta'],
];
const PANTRY = ['Flour', 'Salt', 'eggs', 'Garlic', 'Olive oil', 'Rice', 'butter', '2 cans tomatoes', 'Cumin', 'Pepper'];

const countsFor = (pantry: readonly string[]) => RECIPES.map((ing) => recipeStillToBuy(ing, pantry));

describe('the shelf is cached per pantry array, never across a change', () => {
  it('answers the same for the array and for a copy of it', () => {
    const first = countsFor(PANTRY);
    expect(countsFor(PANTRY)).toEqual(first); // served from the cache
    expect(countsFor([...PANTRY])).toEqual(first); // built fresh
  });

  it('sees a pantry that is a different array', () => {
    const before = countsFor(PANTRY);
    const more = [...PANTRY, 'chicken thighs', 'basil', 'lemons', 'soy sauce'];
    const after = countsFor(more);
    expect(after).not.toEqual(before);
    // The old array still answers as it did.
    expect(countsFor(PANTRY)).toEqual(before);
    expect(after[1]).toBeLessThan(before[1]!);
  });

  it('does not serve a stale shelf to an array that was grown in place', () => {
    const rows = ['Flour', 'Salt'];
    expect(recipeStillToBuy(['2 cups flour', '3 eggs'], rows)).toBe(1);
    rows.push('eggs'); // a caller that edits the array it already passed
    expect(recipeStillToBuy(['2 cups flour', '3 eggs'], rows)).toBe(0);
  });

  it('is the same for an empty pantry and a pantry with only blank rows', () => {
    expect(recipeStillToBuy(['2 cups flour'], [])).toBe(1);
    expect(recipeStillToBuy(['2 cups flour'], ['', '  '])).toBe(1);
  });

  it('leaves every other pantry reader unchanged', () => {
    const copy = [...PANTRY];
    expect(shoppingPlan([{ title: 'a', ingredients: RECIPES[0]! }], PANTRY, []))
      .toEqual(shoppingPlan([{ title: 'a', ingredients: RECIPES[0]! }], copy, []));
    const done = [{ id: '1', text: '1 lb chicken thighs', done: true }, { id: '2', text: '2 cups flour', done: true }];
    expect(doneShoppingPlan(done, PANTRY)).toEqual(doneShoppingPlan(done, copy));
    const recipes = RECIPES.map((ingredients, i) => ({ id: `r${i}`, title: `R${i}`, ingredients }));
    expect(pantryUsedBy('Garlic', recipes)).toEqual(pantryUsedBy('garlic', recipes));
    expect(pantryUsedIn(RECIPES[1]!, PANTRY)).toEqual(pantryUsedIn(RECIPES[1]!, copy));
    expect(pantryHas(PANTRY, '3 large eggs')).toBe(true);
    expect(pantryHas(PANTRY, 'saffron')).toBe(false);
  });
});

describe('the identity of a text is cached by text, and bounded', () => {
  it('is stable, and the same for text that differs only by outer space', () => {
    const k = pantryRowKey('2 cups all-purpose flour');
    expect(pantryRowKey('2 cups all-purpose flour')).toBe(k);
    expect(pantryRowKey('  2 cups all-purpose flour  ')).toBe(k);
    expect(k).not.toBe('');
  });

  it('keeps answering the same after the cache has been flushed by many other texts', () => {
    const keys = ['500 g rice', 'fresh basil', '1 can diced tomatoes', 'salt and pepper'].map(pantryRowKey);
    for (let i = 0; i < 51000; i++) pantryRowKey(`${i % 9 + 1} cups unique ingredient number ${i}`);
    expect(['500 g rice', 'fresh basil', '1 can diced tomatoes', 'salt and pepper'].map(pantryRowKey)).toEqual(keys);
  });
});
