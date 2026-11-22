import { describe, expect, test } from 'vitest';
import { shoppingPlan, type AnyRec, type Rec } from '@calmind/core';
import { aisleRuns, buyCount, filterRows, hitSection, ingredientStates, isTextTarget, pantrySummary, pickedNames, recipeFacts, recipeGroups, groupedNotes, shownRecipes, rowSave, shoppingSummary, stillToBuyHeading, whereWent } from '../src/wideflows';

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
  test('groups run folder by folder, narrow to one folder, keep empty folders', () => {
    const g = recipeGroups([...recs, folder('f3', 'c')], { folderId: null });
    expect(g.map((x) => [x.folder.id, x.notes.map((n) => n.id)])).toEqual([['f1', ['a']], ['f2', ['b', 'c']], ['f3', []]]);
    expect(groupedNotes(g).map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(recipeGroups(recs, { folderId: 'f2' }).map((x) => x.folder.id)).toEqual(['f2']);
  });
  test('a note outside every recipe folder is not listed; shut folders hide their rows only', () => {
    const stray = note('z', 'Stray', 'sx', 'fx', 'a', ['1 egg']);
    const g = recipeGroups([...recs, stray], { folderId: null });
    expect(groupedNotes(g).map((n) => n.id)).not.toContain('z');
    expect(shownRecipes(g, new Set(['f1'])).map((n) => n.id)).toEqual(['b', 'c']);
    expect(shownRecipes(g, new Set()).map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });
  test('tags are per line; the pane count is the table count (one function)', () => {
    const lines = ['1 tsp kosher salt', '2 tsp kosher salt', '2 eggs', 'For the sauce:'];
    const st = ingredientStates(lines, ['eggs']);
    // Both salt lines are tagged To buy; eggs are In pantry; the subheader is neither.
    expect(st.map((x) => [x.heading, x.have])).toEqual([[false, false], [false, false], [false, true], [true, false]]);
    // The count combines the two salt lines into one row, and is what the table shows.
    const note1 = note('r', 'R', 's', 'f', 'a', ['1 tsp kosher salt', '2 tsp kosher salt', '2 eggs']);
    const table = recipeFacts([note1], ['eggs'], new Map()).get('r');
    expect(table).toEqual({ ingredients: 3, buy: 1 });
    expect(buyCount(lines, ['eggs'])).toBe(table!.buy);
    expect(stillToBuyHeading(table!.buy!, 3)).toBe('Ingredients · 1 still to buy');
    expect(stillToBuyHeading(0, 3)).toBe('Ingredients · 3, all in your pantry');
  });
});

describe('search, row saves and Esc', () => {
  const folder = (id: string, flag: 'shopping' | 'pantry'): AnyRec => ({ id, type: 'folder', updated: 1, payload: { name: flag, color: '#fff', ord: 'a', app: 'reminders', [flag]: true } } as unknown as AnyRec);
  const rem = (id: string, fol: string, text: string): Rec<'reminder'> => ({ id, type: 'reminder', updated: 1, payload: { text, due: null, time: null, done: false, repeat: null, folderId: fol, sectionId: 's', indent: 0, ord: 'a' } } as unknown as Rec<'reminder'>);
  test('a reminder is labelled by its folder flag', () => {
    const recs = [folder('fs', 'shopping'), folder('fp', 'pantry'), rem('a', 'fs', 'milk'), rem('b', 'fp', 'rice')];
    expect(hitSection(recs, 'a')).toBe('shopping');
    expect(hitSection(recs, 'b')).toBe('pantry');
  });
  test('an untouched field writes nothing; a change builds on the LIVE record', () => {
    const live = rem('a', 'fs', 'milk (changed elsewhere)');
    expect(rowSave(live, null)).toEqual({ kind: 'none' });
    expect(rowSave(live, '  ')).toEqual({ kind: 'del' });
    expect(rowSave(live, 'milk (changed elsewhere)')).toEqual({ kind: 'none' });
    const w = rowSave({ ...live, payload: { ...live.payload, done: true } }, '2 milk');
    expect(w.kind === 'put' && w.rec.payload).toMatchObject({ text: '2 milk', done: true });
  });
  test('text fields are recognised', () => {
    expect(isTextTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTextTarget({ tagName: 'textarea' })).toBe(true);
    expect(isTextTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTextTarget({ tagName: 'DIV' })).toBe(false);
    expect(isTextTarget(null)).toBe(false);
  });
});

describe('lists', () => {
  test('aisle runs keep stored order inside an aisle', () => {
    const runs = aisleRuns([{ text: 'milk' }, { text: 'apples' }, { text: 'butter' }, { text: 'cream' }]);
    expect(runs).toEqual([
      { aisle: 'Produce', rows: [{ text: 'apples' }] },
      { aisle: 'Dairy & Eggs', rows: [{ text: 'milk' }, { text: 'butter' }, { text: 'cream' }] },
    ]);
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
