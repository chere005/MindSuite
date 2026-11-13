import { describe, expect, it } from 'vitest';
import { ingredientAisle, ingredientParts, pantryHas, pantryRowKey, shoppingLines } from '../src';

/** Aisle of a pantry row as the screen computes it (Shopping.tsx aisleOf). */
const aisleOfRow = (text: string) => {
  const p = ingredientParts(text);
  return ingredientAisle(p.name || text, p.unit);
};

describe('pantry ingredient identity (TODO #125)', () => {
  it('a quantity/unit prefix changes neither identity nor aisle of rice', () => {
    expect(pantryRowKey('500 g rice')).toBe(pantryRowKey('Rice'));
    expect(pantryRowKey('1 kg Rice')).toBe(pantryRowKey('rice'));
    expect(aisleOfRow('Rice')).toBe('Dry Goods');
    expect(aisleOfRow('500 g rice')).toBe('Dry Goods');
    expect(aisleOfRow('2 cups rice')).toBe('Dry Goods');
  });

  it('pantryHas finds the same ingredient in plain/prefixed forms (the add/rename duplicate check)', () => {
    expect(pantryHas(['Rice'], '500 g rice')).toBe(true);
    expect(pantryHas(['500 g rice'], 'Rice')).toBe(true);
    expect(pantryHas(['500 g rice'], '1 kg rice')).toBe(true);
    expect(pantryHas(['Rice'], 'almond flour')).toBe(false);
    expect(pantryHas(['flour'], 'almond flour')).toBe(false);
    expect(pantryHas([], 'rice')).toBe(false);
  });

  it('rename: a row is not a duplicate of itself', () => {
    expect(pantryHas(['Rice', 'Salt'], '500 g rice', 0)).toBe(false);
    expect(pantryHas(['Rice', '500 g rice'], '500 g rice', 0)).toBe(true);
  });

  it('cans and jars stay their own thing: canned tomatoes are not fresh tomatoes', () => {
    expect(aisleOfRow('2 cans tomatoes')).toBe('Cans & Jars');
    expect(aisleOfRow('1 jar salsa')).toBe('Cans & Jars');
    expect(aisleOfRow('tomatoes')).toBe('Produce');
    expect(pantryRowKey('2 cans tomatoes')).not.toBe(pantryRowKey('tomatoes'));
    expect(pantryHas(['2 cans tomatoes'], 'tomatoes')).toBe(false);
    expect(pantryHas(['tomatoes'], '1 can tomatoes')).toBe(false);
    expect(pantryHas(['1 can tomatoes'], '3 cans tomatoes')).toBe(true);
  });

  it('black pepper is Spices & Seasoning, fresh peppers stay Produce', () => {
    expect(aisleOfRow('Black pepper')).toBe('Spices & Seasoning');
    expect(aisleOfRow('1 tsp black pepper')).toBe('Spices & Seasoning');
    expect(aisleOfRow('freshly ground black pepper')).toBe('Spices & Seasoning');
    expect(aisleOfRow('white pepper')).toBe('Spices & Seasoning');
    expect(aisleOfRow('peppercorns')).toBe('Spices & Seasoning');
    expect(aisleOfRow('salt and pepper')).toBe('Spices & Seasoning');
    expect(aisleOfRow('red pepper flakes')).toBe('Spices & Seasoning');
    expect(aisleOfRow('2 bell peppers')).toBe('Produce');
    expect(aisleOfRow('red bell pepper')).toBe('Produce');
    expect(aisleOfRow('jalapeno peppers')).toBe('Produce');
    expect(aisleOfRow('pepper')).toBe('Produce');
    expect(aisleOfRow('roasted peppers')).toBe('Cans & Jars');
  });

  it('a pantry row with a quantity still covers the shopping line (no mass<->volume conversion needed)', () => {
    const left = shoppingLines([{ title: null, ingredients: ['2 cups rice', '1 tsp black pepper'] }], ['500 g rice']);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/black pepper/);
    expect(shoppingLines([{ title: null, ingredients: ['2 cups rice'] }], ['rice'])).toEqual([]);
  });
});
