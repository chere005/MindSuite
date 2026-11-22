/**
 * Refresh — the harder combine the shopping and pantry lists run over the rows
 * they already hold (the owner, 2026-08-22). The strict pass has its own suite in
 * shopping.test.ts; what is tested here is only what the loose one adds, and
 * the two lines it must still refuse to add together.
 */
import { describe, it, expect } from 'vitest';
import { recombineLines } from '../src/index';

describe('recombineLines — plurals, prep words and asides', () => {
  it('folds a plural into its singular', () => {
    expect(recombineLines(['2 onions', '1 onion'])).toEqual(['3 onions']);
  });

  it('ignores what was done to the thing', () => {
    expect(recombineLines(['1 onion', '2 chopped onions'])).toEqual(['3 onions']);
  });

  it('keeps the shortest of the names it merged', () => {
    expect(recombineLines(['2 finely chopped onions', '1 onion'])).toEqual(['3 onions']);
  });

  it('cuts a comma tail and a bracketed aside', () => {
    expect(recombineLines(['3 eggs, beaten', '2 eggs (free range)'])).toEqual(['5 eggs']);
  });

  it('sums cups and tablespoons of one thing in millilitres', () => {
    expect(recombineLines(['1 cup milk', '2 tbsp milk'])).toEqual(['266 ml milk']);
  });

  it('prefers the bracketed metric measure to the cook’s own', () => {
    expect(recombineLines(['2 cups (250 g) flour', '50 g flour'])).toEqual(['300 g flour']);
  });

  it('leaves a bracketed aside that is not metric alone', () => {
    expect(recombineLines(['1 cup (2 sticks) butter'])).toEqual(['237 ml butter']);
  });
});

describe('recombineLines — what it still refuses', () => {
  it('will not cross mass and volume, however alike the names', () => {
    expect(recombineLines(['200 g butter', '1 cup butter'])).toEqual(['200 g butter', '237 ml butter']);
  });

  it('never lets one ingredient claim another that contains its name', () => {
    expect(recombineLines(['200 g flour', '100 g almond flour'])).toEqual(['200 g flour', '100 g almond flour']);
  });

  it('keeps dried and fresh apart', () => {
    expect(recombineLines(['1 tbsp dried basil', '1 tbsp fresh basil'])).toEqual(['15 ml dried basil', '15 ml fresh basil']);
  });

  it('keeps a range as written rather than inventing a total', () => {
    expect(recombineLines(['2-3 cloves garlic', '1 clove garlic'])).toEqual(['2-3 cloves garlic']);
  });

  it('does not reduce a name to nothing', () => {
    expect(recombineLines(['2 chopped', '1 chopped'])).toEqual(['3 chopped']);
  });

  it('leaves a list that has nothing to combine exactly as it was', () => {
    const rows = ['500 g flour', '2 lemons', 'salt'];
    expect(recombineLines(rows)).toEqual(rows);
  });
});
