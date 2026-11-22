import { describe, expect, test } from 'vitest';
import { mergeIntoList, type AnyRec, type Rec } from '@calmind/core';
import { planFor, reviewLines, shoppingWriteOps } from '../src/chefflows';
import { addLinesToShopping } from '../src/addToShopping';
import { addToCook, createSessionStore, dropFromCook, flipIn, newCook, newReview, pruneIds, reviewWriteLines, sessionActions } from '../src/session';

const folder = (id: string, flag: 'shopping' | 'pantry'): AnyRec =>
  ({ id, type: 'folder', updated: 1, payload: { name: flag, color: '#fff', ord: 'a', app: 'reminders', [flag]: true } } as unknown as AnyRec);
const section = (id: string, folderId: string): AnyRec => ({ id, type: 'section', updated: 1, payload: { name: 'S', folderId, ord: 'a' } } as unknown as AnyRec);
const row = (id: string, sec: string, fol: string, text: string, ord: string): AnyRec =>
  ({ id, type: 'reminder', updated: 1, payload: { text, due: null, time: null, done: false, repeat: null, folderId: fol, sectionId: sec, indent: 0, ord } } as unknown as AnyRec);
const note = (id: string, ing: string[]): Rec<'note'> => ({
  id, type: 'note', updated: 1,
  payload: { title: id, body: `**Ingredients**\n${ing.map((x) => `- ${x}`).join('\n')}\n\n**Directions**\n1. Cook.`, date: null, folderId: 'f', sectionId: 's', ord: 'a', recipe: true },
} as unknown as Rec<'note'>);
const base = (pantry: string[]): AnyRec[] => [
  folder('fs', 'shopping'), section('ss', 'fs'), folder('fp', 'pantry'), section('sp', 'fp'),
  ...pantry.map((t, i) => row(`p${i}`, 'sp', 'fp', t, String.fromCharCode(97 + i))),
];

describe('the Review is frozen when it opens', () => {
  const n = note('Soup', ['2 tbsp olive oil', '1 yellow onion', '3 cloves garlic']);
  test('a pantry change between open and Add does not move the choices', () => {
    const before = base([]);
    let rv = newReview(before, [n]);
    expect(rv.plan.toBuy.map((r) => r.name).length).toBe(3);
    const oil = rv.plan.toBuy.findIndex((r) => /oil/.test(r.text));
    rv = { ...rv, off: flipIn(rv.off, oil) }; // the person unticks the oil
    const expected = rv.plan.toBuy.filter((_, i) => i !== oil).map((r) => r.text);
    expect(reviewWriteLines(rv)).toEqual(expected);

    // A sync lands: the pantry now covers the oil. A plan REBUILT now has the
    // rows in different places, so the same choice would hit another row.
    const after = [...before, row('p9', 'sp', 'fp', 'olive oil', 'z')];
    const rebuilt = planFor(after, rv.sources, ['olive oil']);
    expect(reviewLines(rebuilt, { off: new Set(rv.off), anyway: new Set(rv.anyway) })).not.toEqual(expected);
    // The frozen review still writes exactly what was on screen.
    expect(reviewWriteLines(rv)).toEqual(expected);
  });
  test('Add writes the frozen lines and re-reads merge targets at write time', () => {
    const rv = newReview(base([]), [note('E', ['2 eggs'])]);
    // Between open and Add somebody puts 6 eggs on the list.
    const now = [...base([]), row('s9', 'ss', 'fs', '6 eggs', 'a')];
    const writes: AnyRec[] = [];
    const res = addLinesToShopping(now, (fn) => fn({ put: (r: AnyRec) => writes.push(r), del: () => {} } as never), reviewWriteLines(rv));
    expect(res).toEqual({ ok: true, added: 0, merged: 1 });
    expect((writes[0] as Rec<'reminder'>).payload.text).toBe('8 eggs');
    void shoppingWriteOps; void mergeIntoList;
  });
});

describe('the session survives a layout change', () => {
  test('picked, Review and Cook written in one layout read back in the other', () => {
    const store = createSessionStore();
    const phone = sessionActions(store);
    phone.setPicked(['a', 'b']);
    phone.setReview(newReview(base(['garlic']), [note('a', ['2 eggs'])]));
    phone.setReview((r) => (r ? { ...r, off: flipIn(r.off, 0) } : r));
    phone.setCook(newCook(['a', 'b'], 'b', 'v1'));
    phone.setCookState((s) => ({ ...s, tabs: { b: { step: 2, gathered: [0, 3], variantId: 'v1' } }, finishOpen: true, ticked: ['olive oil'], shop: false }));

    // Crossing 900 px unmounts the phone tree and mounts the wide one, which
    // reads the SAME store (a new reader, no copy).
    const wide = store.get();
    expect(wide.picked).toEqual(['a', 'b']);
    expect(wide.review?.off).toEqual([0]);
    expect(wide.cook?.state.active).toBe(1);
    expect(wide.cook?.state.tabs.b).toEqual({ step: 2, gathered: [0, 3], variantId: 'v1' });
    expect(wide.cook?.state.finishOpen).toBe(true);
    expect(wide.cook?.state.ticked).toEqual(['olive oil']);
    expect(wide.cook?.state.shop).toBe(false);

    // …and a change made there is seen back on the phone.
    sessionActions(store).setPicked((p) => p.filter((x) => x !== 'a'));
    expect(store.get().picked).toEqual(['b']);
  });
  test('subscribers are told once per real change, and not for a no-op', () => {
    const store = createSessionStore();
    let n = 0;
    store.subscribe(() => { n++; });
    const a = sessionActions(store);
    a.setPicked((p) => p);
    expect(n).toBe(0);
    a.setPicked(['x']);
    expect(n).toBe(1);
  });
});

describe('picked recipes are pruned against live ones', () => {
  test('deleted ids leave, order is kept, an untouched list is the same array', () => {
    const ids = ['a', 'b', 'c'];
    expect(pruneIds(ids, new Set(['a', 'c']))).toEqual(['a', 'c']);
    expect(pruneIds(ids, new Set(['a', 'b', 'c']))).toBe(ids);
    expect(pruneIds(ids, new Set())).toEqual([]);
  });
});

describe('one recipe on the stove, and another added from inside Cook', () => {
  test('adding opens a tab for it and shows it; one already cooking is just shown', () => {
    const one = newCook(['a'], 'a', 'v1');
    const two = addToCook(one, 'b');
    expect(two.ids).toEqual(['a', 'b']);
    expect(two.state.active).toBe(1);
    expect(two.first).toBe('a');
    expect(two.variantId).toBe('v1');
    const back = addToCook(two, 'a');
    expect(back.ids).toEqual(['a', 'b']);
    expect(back.state.active).toBe(0);
    expect(addToCook(back, 'a')).toBe(back);
  });
  test('dropping one keeps the tab on screen and the others\' progress', () => {
    let c = addToCook(addToCook(newCook(['a'], 'a', null), 'b'), 'c'); // active = c (2)
    c = { ...c, state: { ...c.state, tabs: { a: { step: 1, gathered: [], variantId: null }, c: { step: 4, gathered: [0], variantId: null } } } };
    const noA = dropFromCook(c, 'a')!;
    expect(noA.ids).toEqual(['b', 'c']);
    expect(noA.state.active).toBe(1); // still on c
    expect(noA.state.tabs).toEqual({ c: { step: 4, gathered: [0], variantId: null } });
    // Dropping the tab on screen hands it to its neighbour.
    const noC = dropFromCook(noA, 'c')!;
    expect(noC.ids).toEqual(['b']);
    expect(noC.state.active).toBe(0);
    // A tab after the one on screen leaves the active index alone.
    const mid = { ...c, state: { ...c.state, active: 0 } };
    expect(dropFromCook(mid, 'b')!.state.active).toBe(0);
  });
  test('the opening variant goes with the first recipe; the last one out ends Cook', () => {
    const c = addToCook(newCook(['a'], 'a', 'v1'), 'b');
    const noFirst = dropFromCook(c, 'a')!;
    expect(noFirst.first).toBeUndefined();
    expect(noFirst.variantId).toBeNull();
    expect(dropFromCook(c, 'b')!.variantId).toBe('v1');
    expect(dropFromCook(newCook(['a'], 'a'), 'a')).toBeNull();
    expect(dropFromCook(c, 'zz')).toBe(c);
  });
});
