import { describe, expect, it } from 'vitest';
import { findVariant, liveSections, recipeSections, variantBody } from '../src/variant';

/**
 * Shaped like the owner's Cheese card, and deliberately VALID for splitRecipeBody:
 * an ingredients row is a '- ' bullet and a directions row is numbered. A
 * first draft of this fixture put '- salt' under **Directions**, which ends
 * the recipe block there — so half the card arrived as `after`, untouched,
 * and the variant filter appeared to leak. The parser was right and the
 * fixture was wrong, which is exactly the way round that is easy to miss.
 */
const CHEESE = [
  '**Ingredients**',
  '- 1 tsp salt',
  '**Ricotta:**',
  '- ½ gal whole milk',
  '- 5 Tbsp lemon juice',
  '**Mascarpone:**',
  '- 1 qt heavy cream',
  '',
  '**Directions**',
  '1. Warm the pan.',
  '**Ricotta:**',
  '2. Heat to 190°F.',
  '3. Strain.',
  '**Mascarpone:**',
  '4. Hold 5 min.',
].join('\n');

describe('a recipe’s own sections', () => {
  it('lists every subheader once, in the order written', () => {
    expect(recipeSections(CHEESE)).toEqual(['Ricotta:', 'Mascarpone:']);
  });

  it('is empty for a card with no subheaders', () => {
    expect(recipeSections('**Ingredients**\n- 2 eggs\n\n**Directions**\n1. Beat')).toEqual([]);
  });

  it('reads the recipe BLOCK, not the prose around it', () => {
    const body = 'A note about cheese.\n\n' + CHEESE + '\n\nSomething afterwards.';
    expect(recipeSections(body)).toEqual(['Ricotta:', 'Mascarpone:']);
  });
});

describe('the body a variant shows', () => {
  it('keeps its own sections and drops the others', () => {
    const out = variantBody(CHEESE, ['Ricotta:']);
    expect(out).toContain('**Ricotta:**');
    expect(out).toContain('½ gal whole milk');
    expect(out).toContain('2. Heat to 190°F.');
    expect(out).not.toContain('**Mascarpone:**');
    expect(out).not.toContain('1 qt heavy cream');
    expect(out).not.toContain('4. Hold 5 min.');
  });

  it('keeps a section that appears in BOTH blocks — the text is the key', () => {
    // Cheese repeats '**Ricotta:**' under Ingredients and again under
    // Directions, deliberately. Ticking it once must mean both.
    const out = variantBody(CHEESE, ['Ricotta:']);
    expect(out.match(/\*\*Ricotta:\*\*/g)?.length).toBe(2);
  });

  it('always keeps what is shared — the rows before any subheader', () => {
    // '- 1 tsp salt' and '1. Warm the pan.' each sit directly under their
    // block heading, before any subheader, so they belong to every variant.
    // The second is the case that made the block headings reset the run:
    // without it, 'Warm the pan' inherited the last INGREDIENT subheader and
    // vanished from every variant that did not also name Mascarpone.
    for (const v of [['Ricotta:'], ['Mascarpone:']]) {
      expect(variantBody(CHEESE, v)).toContain('- 1 tsp salt');
      expect(variantBody(CHEESE, v)).toContain('1. Warm the pan.');
    }
  });

  it('keeps both block headings whatever is chosen', () => {
    const out = variantBody(CHEESE, ['Mascarpone:']);
    expect(out).toContain('**Ingredients**');
    expect(out).toContain('**Directions**');
  });

  it('shows the WHOLE card when a variant names nothing', () => {
    // What a just-created variant does. A variant that hid everything would
    // look like a broken recipe rather than an unfinished setting.
    expect(variantBody(CHEESE, [])).toBe(CHEESE);
  });

  it('does not renumber the steps', () => {
    // They are the author's numbers, and the card and the variant must not
    // disagree about which one is step 3.
    expect(variantBody(CHEESE, ['Mascarpone:'])).toContain('4. Hold 5 min.');
  });

  it('keeps the prose around the recipe block', () => {
    const body = 'Before.\n\n' + CHEESE + '\n\nAfter.';
    const out = variantBody(body, ['Ricotta:']);
    expect(out.startsWith('Before.')).toBe(true);
    expect(out.trimEnd().endsWith('After.')).toBe(true);
  });

  it('leaves no run of blank lines where a section was cut out', () => {
    expect(variantBody(CHEESE, ['Ricotta:'])).not.toMatch(/\n{3,}/);
  });
});

describe('variants against a card that has since been edited', () => {
  it('drops a section that no longer exists rather than keeping a rule about it', () => {
    const v = { id: 'v1', name: 'Ricotta', sections: ['Ricotta:', 'Gone:'] };
    expect(liveSections(CHEESE, v)).toEqual(['Ricotta:']);
  });

  it('findVariant answers null for no selection and for a stale id', () => {
    const vs = [{ id: 'v1', name: 'Ricotta', sections: [] }];
    expect(findVariant(vs, null)).toBeNull();
    expect(findVariant(vs, 'nope')).toBeNull();
    expect(findVariant(undefined, 'v1')).toBeNull();
    expect(findVariant(vs, 'v1')?.name).toBe('Ricotta');
  });
});
