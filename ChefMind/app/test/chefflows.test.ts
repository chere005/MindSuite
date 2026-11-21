import { describe, expect, test } from 'vitest';
import { mergeIntoList, shoppingPlan, type AnyRec, type Rec } from '@calmind/core';
import {
  cookKey, cookSteps, doneShoppingOps, finishCookingOps, gatherItems, groupByAisle, listOf, ranOutOps,
  readRecipe, renameOp, planFor, reviewLines, reviewSummary, shoppingWriteOps, stepTo, stillToBuyCounts, toBuyLabel,
  toggleCartOp, applyOps, type Op,
} from '../src/chefflows';

let n = 0;
const ids = () => `id${++n}`;
const folder = (id: string, flag: 'shopping' | 'pantry'): AnyRec =>
  ({ id, type: 'folder', updated: 1, payload: { name: flag, color: '#fff', ord: 'a', app: 'reminders', [flag]: true } } as unknown as AnyRec);
const section = (id: string, folderId: string): AnyRec =>
  ({ id, type: 'section', updated: 1, payload: { name: 'S', folderId, ord: 'a' } } as unknown as AnyRec);
const row = (id: string, sectionId: string, folderId: string, text: string, ord: string, done = false): AnyRec =>
  ({ id, type: 'reminder', updated: 1, payload: { text, due: null, time: null, done, repeat: null, folderId, sectionId, indent: 0, ord } } as unknown as AnyRec);

function store(shop: [string, boolean?][], pantry: string[]): AnyRec[] {
  return [
    folder('fs', 'shopping'), section('ss', 'fs'), folder('fp', 'pantry'), section('sp', 'fp'),
    ...shop.map(([t, d], i) => row(`s${i}`, 'ss', 'fs', t, String.fromCharCode(97 + i), !!d)),
    ...pantry.map((t, i) => row(`p${i}`, 'sp', 'fp', t, String.fromCharCode(97 + i))),
  ];
}
const puts = (ops: Op[]) => ops.filter((o): o is Extract<Op, { kind: 'put' }> => o.kind === 'put').map((o) => (o.rec as Rec<'reminder'>).payload.text);
const dels = (ops: Op[]) => ops.filter((o) => o.kind === 'del').map((o) => (o as { id: string }).id);

describe('review selection', () => {
  const plan = shoppingPlan(
    [{ title: 'Soup', ingredients: ['2 cans (14 oz) canned tomatoes', '1 tsp kosher salt', '3 cloves garlic'] }],
    ['garlic'], [],
  );
  test('writes only ticked to-buy rows plus buy-anyway rows', () => {
    const all = reviewLines(plan, { off: new Set(), anyway: new Set() });
    expect(all.length).toBe(plan.toBuy.length);
    const off = reviewLines(plan, { off: new Set([0]), anyway: new Set() });
    expect(off.length).toBe(plan.toBuy.length - 1);
    expect(off).not.toContain(plan.toBuy[0]!.text);
    const anyway = reviewLines(plan, { off: new Set(), anyway: new Set([0]) });
    expect(anyway.at(-1)).toBe(plan.inPantry[0]!.text);
  });
  test('summary skips subheaders and blanks', () => {
    expect(reviewSummary([{ ingredients: ['For the sauce:', '1 onion', ''] }, { ingredients: ['2 eggs'] }])).toEqual({ ingredients: 2, recipes: 2 });
  });
  test('groups by aisle keeping plan indices', () => {
    const g = groupByAisle([{ aisle: 'Dairy & Eggs' as const }, { aisle: 'Produce' as const }, { aisle: 'Dairy & Eggs' as const }]);
    const flat = g.flatMap((x) => x.rows.map((r) => r.index)).sort();
    expect(flat).toEqual([0, 1, 2]);
    expect(g.find((x) => x.aisle === 'Dairy & Eggs')!.rows.map((r) => r.index)).toEqual([0, 2]);
  });
});

describe('shoppingWriteOps', () => {
  test('merges into an existing row, appends the rest at the end', () => {
    const recs = store([['1 onion']], []);
    const w = shoppingWriteOps(recs, ['2 onions', '1 lemon'], mergeIntoList, ids);
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.merged).toBe(1);
    expect(w.added).toBe(1);
    const lemon = w.ops.map((o) => (o as { rec: Rec<'reminder'> }).rec).find((r) => r.payload.text.includes('lemon'))!;
    expect(lemon.payload.ord > 'a').toBe(true);
  });
  test('empty and not-ready are refused, not written', () => {
    expect(shoppingWriteOps(store([], []), [' '], mergeIntoList)).toEqual({ ok: false, why: 'empty' });
    expect(shoppingWriteOps([], ['x'], mergeIntoList)).toEqual({ ok: false, why: 'notready' });
  });
  test('new rows get distinct increasing keys', () => {
    const w = shoppingWriteOps(store([], []), ['a1', 'b2', 'c3'].map((x) => `${x} thing`), (_e, inc) => ({ kept: [], added: [...inc] }), ids);
    if (!w.ok) throw new Error('x');
    const ords = w.ops.map((o) => (o as { rec: Rec<'reminder'> }).rec.payload.ord);
    expect(new Set(ords).size).toBe(3);
    expect([...ords].sort()).toEqual(ords);
  });
});

describe('done shopping', () => {
  test('creates ticked pantry rows at the end and deletes every done row in one op list', () => {
    const recs = store([['2 lb chicken', true], ['paper towels', true], ['1 lemon', false]], ['salt']);
    const r = doneShoppingOps(recs, ['chicken'], ['s0', 's1'], ids);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(puts(r.ops)).toEqual(['chicken']);
    expect(dels(r.ops)).toEqual(['s0', 's1']);
    expect(r.put).toBe(1);
    const created = (r.ops[0] as { rec: Rec<'reminder'> }).rec;
    expect(created.payload.sectionId).toBe('sp');
    expect(created.payload.ord > 'a').toBe(true);
  });
  test('a name the pantry already has is not written twice, its shopping row still goes', () => {
    const recs = store([['1 cup flour', true]], ['flour']);
    const r = doneShoppingOps(recs, ['flour', 'flour'], ['s0'], ids);
    if (!r.ok) throw new Error('x');
    expect(r.put).toBe(0);
    expect(dels(r.ops)).toEqual(['s0']);
  });
  test('no pantry + names to write deletes nothing', () => {
    expect(doneShoppingOps([], ['x'], ['s0'])).toEqual({ ok: false, why: 'notready' });
  });
  test('applies through the engine interface', () => {
    const seen: string[] = [];
    applyOps({ put: (r: AnyRec) => seen.push(`put ${r.id}`), del: (id: string) => seen.push(`del ${id}`) } as never,
      [{ kind: 'del', id: 'a' }, { kind: 'put', rec: { id: 'b' } as AnyRec }]);
    expect(seen).toEqual(['del a', 'put b']);
  });
});

describe('cart tick', () => {
  test('flips done and keeps the row', () => {
    const r = listOf(store([['milk']], []), 'shopping')!.rows[0]!;
    const op = toggleCartOp(r) as { rec: Rec<'reminder'> };
    expect(op.rec.payload.done).toBe(true);
    expect(op.rec.payload.text).toBe('milk');
  });
});

describe('pantry actions', () => {
  test('ran out puts the name on the list and removes the row, one op list', () => {
    const recs = store([['1 tbsp soy sauce']], ['soy sauce', 'rice']);
    const w = ranOutOps(recs, 'p0', mergeIntoList, ids);
    if (!w.ok) throw new Error('x');
    expect(dels(w.ops)).toEqual(['p0']);
    expect(w.merged + w.added).toBe(1);
  });
  test('ran out with no shopping list leaves the pantry row alone', () => {
    expect(ranOutOps([folder('fp', 'pantry'), section('sp', 'fp'), row('p0', 'sp', 'fp', 'x', 'a')], 'p0', mergeIntoList).ok).toBe(false);
  });
  test('rename refuses blank and duplicates', () => {
    const recs = store([], ['soy sauce', 'rice']);
    expect(renameOp(recs, 'p0', ' ')).toEqual({ ok: false, why: 'blank' });
    expect(renameOp(recs, 'p0', 'rice')).toEqual({ ok: false, why: 'duplicate' });
    const ok = renameOp(recs, 'p0', 'tamari');
    expect(ok.ok).toBe(true);
    expect(renameOp(recs, 'p0', 'soy sauce').ok).toBe(true);
  });
});

describe('finish cooking', () => {
  const recs = store([], ['soy sauce', 'rice', 'salt']);
  test('removes ticked rows and shops them in one op list', () => {
    const r = finishCookingOps(recs, ['soy sauce', 'rice'], true, mergeIntoList, ids);
    if (!r.ok) throw new Error('x');
    expect(dels(r.ops)).toEqual(['p0', 'p1']);
    expect(puts(r.ops)).toEqual(['soy sauce', 'rice']);
    expect(r.removed).toBe(2);
  });
  test('box off: only removes', () => {
    const r = finishCookingOps(recs, ['salt'], false, mergeIntoList, ids);
    if (!r.ok) throw new Error('x');
    expect(puts(r.ops)).toEqual([]);
    expect(dels(r.ops)).toEqual(['p2']);
  });
  test('nothing ticked is a no-op', () => {
    const r = finishCookingOps(recs, [], true, mergeIntoList, ids);
    if (!r.ok) throw new Error('x');
    expect(r.ops).toEqual([]);
  });
  test('shopping list missing: refuses without removing', () => {
    const r = finishCookingOps([folder('fp', 'pantry'), section('sp', 'fp'), row('p0', 'sp', 'fp', 'rice', 'a')], ['rice'], true, mergeIntoList);
    expect(r.ok).toBe(false);
  });
});

describe('cook helpers', () => {
  test('steps drop subheaders and carry them as headings', () => {
    expect(cookSteps(['For the sauce:', 'Simmer.', 'Serve.'])).toEqual([
      { n: 1, text: 'Simmer.', heading: 'For the sauce' }, { n: 2, text: 'Serve.', heading: null }]);
  });
  test('gather marks headings', () => {
    expect(gatherItems(['For the sauce:', '1 onion'])).toEqual([{ text: 'For the sauce', heading: true }, { text: '1 onion', heading: false }]);
  });
  test('stepTo clamps', () => {
    expect(stepTo(0, -1, 4)).toBe(0);
    expect(stepTo(3, 1, 4)).toBe(3);
    expect(stepTo(1, 1, 4)).toBe(2);
    expect(stepTo(0, 1, 0)).toBe(0);
  });
  test('keys: space next, shift+space back, never in a text field', () => {
    expect(cookKey({ key: ' ', shiftKey: false })).toBe('next');
    expect(cookKey({ key: ' ', shiftKey: true })).toBe('back');
    expect(cookKey({ key: ' ', shiftKey: false, target: { tagName: 'input' } })).toBeNull();
    expect(cookKey({ key: 'a', shiftKey: false })).toBeNull();
  });
  test('readRecipe reads the recipe block and honours a variant', () => {
    const body = 'Intro\n\n**Ingredients**\n- 1 egg\n**Sweet:**\n- 1 cup sugar\n\n**Directions**\n1. Crack.\n**Sweet:**\n2. Sweeten.';
    const note = { id: 'n', type: 'note', updated: 1, payload: { title: 'T', body, date: null, folderId: 'f', sectionId: 's', ord: 'a', recipe: true, variants: [{ id: 'v', name: 'Plain', sections: ['Sweet:'] }] } } as unknown as Rec<'note'>;
        expect(readRecipe(note, 'v')).toEqual({ ingredients: ['1 egg', 'Sweet:', '1 cup sugar'], steps: ['Crack.', 'Sweet:', 'Sweeten.'] });
    // The variant leaves the other section out of both lists.
    const two = { ...note, payload: { ...note.payload, body: 'Intro\n\n**Ingredients**\n- 1 egg\n**Sweet:**\n- 1 cup sugar\n**Savory:**\n- 1 tsp salt\n\n**Directions**\n1. Crack.\n**Sweet:**\n2. Sweeten.\n**Savory:**\n3. Season.' } } as Rec<'note'>;
    expect(readRecipe(two, 'v')).toEqual({ ingredients: ['1 egg', 'Sweet:', '1 cup sugar'], steps: ['Crack.', 'Sweet:', 'Sweeten.'] });
    expect(readRecipe(two).steps).toContain('Season.');
  });
});

describe('to-buy counts', () => {
  const note = (id: string, body: string) => ({ id, type: 'note', updated: 1, payload: { body } }) as unknown as Rec<'note'>;
  test('cached per body and pantry; evicts removed recipes', () => {
    let calls = 0;
    const cache = new Map();
    const count = () => { calls++; return 2; };
    const ing = (x: Rec<'note'>) => [x.payload.body];
    const a = note('a', 'x');
    stillToBuyCounts([a], ['salt'], count, ing, cache);
    stillToBuyCounts([a], ['salt'], count, ing, cache);
    expect(calls).toBe(1);
    stillToBuyCounts([a], ['salt', 'rice'], count, ing, cache);
    expect(calls).toBe(2);
    stillToBuyCounts([], [], count, ing, cache);
    expect(cache.size).toBe(0);
  });
  test('labels', () => { expect(toBuyLabel(0)).toBe('Have everything'); expect(toBuyLabel(2)).toBe('2 to buy'); });
});

describe('a row in the cart is never merged into', () => {
  const eggsDone = () => store([['6 eggs', true]], []);
  const eggsOpen = () => store([['6 eggs', false]], []);

  test('Review: a line matching only a done row is a NEW, unticked row', () => {
    const w = shoppingWriteOps(eggsDone(), ['2 eggs'], mergeIntoList, ids);
    expect(w.ok && w.merged).toBe(0);
    expect(w.ok && w.added).toBe(1);
    expect(w.ok && puts(w.ops)).toEqual(['2 eggs']);
    const rec = (w.ok ? w.ops : [])[0] as Extract<Op, { kind: 'put' }>;
    expect((rec.rec as Rec<'reminder'>).payload.done).toBe(false);
  });
  test('Review: the same line still merges into a row that is NOT in the cart', () => {
    const w = shoppingWriteOps(eggsOpen(), ['2 eggs'], mergeIntoList, ids);
    expect(w.ok && w.merged).toBe(1);
    expect(w.ok && w.added).toBe(0);
  });
  test('Review: with a done and an open match, only the open one takes it', () => {
    const recs = store([['6 eggs', true], ['4 eggs', false]], []);
    const w = shoppingWriteOps(recs, ['2 eggs'], mergeIntoList, ids);
    expect(w.ok && w.merged).toBe(1);
    const p = (w.ok ? w.ops : [])[0] as Extract<Op, { kind: 'put' }>;
    expect((p.rec as Rec<'reminder'>).id).toBe('s1');
  });
  test("the plan's merge notes name only rows still to buy", () => {
    expect(planFor(eggsDone(), [{ title: 'T', ingredients: ['2 eggs'] }], []).merges).toEqual([]);
    expect(planFor(eggsOpen(), [{ title: 'T', ingredients: ['2 eggs'] }], []).merges.map((m) => m.into)).toEqual(['6 eggs']);
  });
  test('Ran out: the name goes on as a new row, the done row is untouched', () => {
    const recs = [...store([['6 eggs', true]], ['eggs'])];
    const w = ranOutOps(recs, 'p0', mergeIntoList, ids);
    expect(w.ok && w.added).toBe(1);
    expect(w.ok && w.merged).toBe(0);
    expect(w.ok && puts(w.ops)).toEqual(['eggs']);
    expect(w.ok && dels(w.ops)).toEqual(['p0']);
  });
  test('Finish: a ran-out item does not fold into a done row', () => {
    const recs = store([['6 eggs', true]], ['eggs']);
    const w = finishCookingOps(recs, ['eggs'], true, mergeIntoList, ids);
    expect(w.ok && w.added).toBe(1);
    expect(w.ok && w.merged).toBe(0);
    expect(w.ok && puts(w.ops)).toEqual(['eggs']);
  });
});
