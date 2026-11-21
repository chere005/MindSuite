import { describe, expect, test } from 'vitest';
import { shoppingPlan, type AnyRec, type Rec } from '@calmind/core';
import { aisleRuns, filterRows, ingredientStates, pantrySummary, pickedNames, recipeFacts, recipeRows, shoppingSummary, stillToBuyHeading, whereWent } from '../src/wideflows';

const note = (id: string, title: string, sec: string, fol: string, ord: string, ing: string[], recipe = true): Rec<'note'> => ({
  id, type: 'note', updated: 1,
  payload: { title, body: recipe ? `**Ingredients**\n${ing.map((x) => `- ${x}`).join('\n')}\n\n**Directions**\n1. Cook.` : 'plain', date: null, folderId: fol, sectionId: sec, ord, ...(recipe ? { recipe: true } : {}) },
} as unknown as Rec<'note'>);
const folder = (id: string, ord: string): AnyRec => ({ id, type: 'folder', updated: 1, payload: { name: id, color: '#fff', ord, app: 'notes' } } as unknown as AnyRec);
const section = (id: string, fol: string): AnyRec => ({ id, type: 'section', updated: 1, payload: { name: id, folderId: fol, ord: 'a' } } as unknown as AnyRec);

describe('recipe table', () => {
  const a = note('a', 'Soup', 's1', 'f1', 'a', ['2 cans (14 oz) canned tomatoes', '1 tsp kosher salt']);
  const b = note('b', 'Toast', 's2', 'f2', 'a', ['2 eggs']);
  const c = note('c', 'Memo', 's2', 'f2', 'b', [], false);
  const recs = [folder('f1', 'a'), folder('f2', 'b'), section('s1', 'f1'), section('s2', 'f2'), c, b, a] as AnyRec[];

  test('facts count ingredients and what is still to buy; plain notes have none', () => {
    const facts = recipeFacts([a, b, c], ['kosher salt'], new Map());
    expect(facts.get('a')).toEqual({ ingredients: 2, buy: 1 });
    expect(facts.get('c')).toEqual({ ingredients: 0, buy: null });
  });
  test('rows run folder by folder, filter by folder and by can-make', () => {
    const facts = recipeFacts([a, b, c], ['kosher salt', 'canned tomatoes', 'eggs'], new Map());
    expect(recipeRows(recs, { folderId: null, canMake: false, facts }).map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(recipeRows(recs, { folderId: 'f2', canMake: false, facts }).map((n) => n.id)).toEqual(['b', 'c']);
    expect(recipeRows(recs, { folderId: null, canMake: true, facts }).map((n) => n.id)).toEqual(['a', 'b']);
  });
  test('ingredient tags agree with the still-to-buy count', () => {
    const lines = ['2 cans (14 oz) canned tomatoes', '1 tsp kosher salt', 'For the sauce:'];
    const st = ingredientStates(lines, ['kosher salt']);
    expect(st.map((x) => [x.heading, x.have])).toEqual([[false, false], [false, true], [true, false]]);
    expect(stillToBuyHeading(st)).toBe('Ingredients · 1 still to buy');
    expect(stillToBuyHeading(ingredientStates(['1 tsp kosher salt'], ['kosher salt']))).toContain('all in your pantry');
  });
});

describe('lists', () => {
  test('aisle runs keep stored order inside an aisle', () => {
    const runs = aisleRuns([{ text: 'milk' }, { text: 'apples' }, { text: 'butter' }]);
    const dairy = runs.find((r) => r.rows.some((x) => x.text === 'milk'));
    expect(dairy?.rows.map((x) => x.text)).toContain('butter');
    expect(runs.flatMap((r) => r.rows).length).toBe(3);
  });
  test('find, summaries and the picked tray', () => {
    expect(filterRows([{ text: 'Soy sauce' }, { text: 'rice' }], ' SOY ').map((r) => r.text)).toEqual(['Soy sauce']);
    expect(shoppingSummary(11, 4)).toBe('11 items · 4 in your cart · in aisle order');
    expect(shoppingSummary(1, 0)).toBe('1 item · in aisle order');
    expect(pantrySummary(20)).toBe('20 things you have · in aisle order');
    expect(pickedNames(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C and 2 more');
  });
  test('where it went', () => {
    const plan = shoppingPlan([{ title: 'A', ingredients: ['1 tsp kosher salt', '3 cloves garlic'] }, { title: 'B', ingredients: ['3 cloves garlic'] }], ['kosher salt'], []);
    const w = whereWent(plan, 3);
    expect(w).toMatchObject({ total: 3, toBuy: 1, covered: 1, combined: 1 });
  });
});
