import { describe, it, expect } from 'vitest';
import {
  CAPS, canonicalOwners, resolveSelection, selectOnly, toggleOverlay, pickerRows, pickerColors, resolveLanes, newOwners, blankAim, blankThirds, listDeleteImpact,
  type ListRecord, type Selection, type Settings,
} from '../src/planner';

const CAMP = '11111111-1111-4111-8111-111111111111';
const HOME = '22222222-2222-4222-8222-222222222222';
const GIFT = '33333333-3333-4333-8333-333333333333';
const stamp = { revision: 1, updatedAt: '2026-10-30T00:00:00Z' };
const lists: ListRecord[] = [
  { id: 'sam', kind: 'person', name: 'Sam', color: 'yellow', order: 0, ...stamp },
  { id: 'alex', kind: 'person', name: 'Alex', color: 'green', order: 1, ...stamp },
  { id: CAMP, kind: 'custom', name: 'Camping', color: 'blue', order: 2, ...stamp },
  { id: HOME, kind: 'custom', name: 'Home', color: 'orange', order: 3, ...stamp },
  { id: GIFT, kind: 'custom', name: 'Gifts', color: 'teal', order: 4, ...stamp },
];
const settings: Settings = { bothColor: 'purple', revision: 1, updatedAt: '2026-10-30T00:00:00Z' };
const sel = (base: string, ...overlays: string[]): Selection => ({ base, overlays });

describe('canonicalOwners (vectors shared with the PHP suite)', () => {
  it('accepts one list or exactly alex+sam, sorted', () => {
    expect(canonicalOwners(['alex'])).toEqual(['alex']);
    expect(canonicalOwners([CAMP])).toEqual([CAMP]);
    expect(canonicalOwners(['sam', 'alex'])).toEqual(['alex', 'sam']);
    expect(canonicalOwners(['alex', 'sam'])).toEqual(['alex', 'sam']);
  });
  it('rejects empty, duplicate, three, mixed custom and malformed owners', () => {
    expect(canonicalOwners([])).toBeNull();
    expect(canonicalOwners(['sam', 'sam'])).toBeNull();
    expect(canonicalOwners(['sam', 'alex', CAMP])).toBeNull();
    expect(canonicalOwners(['sam', CAMP])).toBeNull();
    expect(canonicalOwners([CAMP, HOME])).toBeNull();
    expect(canonicalOwners(['alex', CAMP])).toBeNull();
    expect(canonicalOwners([''])).toBeNull();
    expect(canonicalOwners('sam' as never)).toBeNull();
    expect(canonicalOwners(null as never)).toBeNull();
    expect(canonicalOwners([1 as never])).toBeNull();
  });
  it('rejects any third owner, whatever it sorts like (a list id can sort before alex, between, or after sam)', () => {
    expect(canonicalOwners(['sam', 'alex', 'alex'])).toBeNull();
    expect(canonicalOwners(['alex', 'sam', 'alex'])).toBeNull();
    expect(canonicalOwners(['sam', 'alex', 'zzz'])).toBeNull();
    expect(canonicalOwners(['alex', 'sam', '00000000-0000-4000-8000-000000000000'])).toBeNull();
    expect(canonicalOwners(['sam', 'alex', 'sam', 'alex'])).toBeNull();
  });
  it('does not reorder or mutate its input', () => {
    const input = ['sam', 'alex'];
    canonicalOwners(input);
    expect(input).toEqual(['sam', 'alex']);
  });
});

describe('resolveSelection', () => {
  it('defaults to Both with no overlays, as a fresh object each time', () => {
    expect(resolveSelection(null, lists)).toEqual(sel('both'));
    expect(resolveSelection(undefined, lists)).toEqual(sel('both'));
    expect(resolveSelection(null, lists)).not.toBe(resolveSelection(null, lists));
  });
  it('keeps a valid selection as it is', () => {
    expect(resolveSelection(sel('alex', CAMP, HOME), lists)).toEqual(sel('alex', CAMP, HOME));
    expect(resolveSelection(sel(CAMP, HOME), lists)).toEqual(sel(CAMP, HOME));
  });
  it('falls back to Both for an unknown base and keeps the overlays that are still valid', () => {
    expect(resolveSelection(sel('44444444-4444-4444-8444-444444444444', CAMP), lists)).toEqual(sel('both', CAMP));
    expect(resolveSelection({ base: 7 as never, overlays: [] }, lists)).toEqual(sel('both'));
  });
  it('drops dangling, duplicate, person, base and surplus overlays', () => {
    expect(resolveSelection(sel('both', '44444444-4444-4444-8444-444444444444', CAMP), lists)).toEqual(sel('both', CAMP));
    expect(resolveSelection(sel('both', CAMP, CAMP), lists)).toEqual(sel('both', CAMP));
    expect(resolveSelection(sel('both', 'sam', 'both', CAMP), lists)).toEqual(sel('both', CAMP));
    expect(resolveSelection(sel(CAMP, CAMP, HOME), lists)).toEqual(sel(CAMP, HOME));
    expect(resolveSelection(sel('both', CAMP, HOME, GIFT), lists)).toEqual(sel('both', CAMP, HOME));
    expect(CAPS.maxOverlays).toBe(2);
  });
  it('treats a non-array overlays value as empty', () => {
    expect(resolveSelection({ base: 'sam', overlays: 'x' as never }, lists)).toEqual(sel('sam'));
  });
  it('a list deleted elsewhere heals the view', () => {
    const without = lists.filter(l => l.id !== CAMP);
    expect(resolveSelection(sel(CAMP, HOME), without)).toEqual(sel('both', HOME));
  });
});

describe('selectOnly', () => {
  it('selects that row alone and clears every overlay', () => {
    expect(selectOnly('sam')).toEqual(sel('sam'));
    expect(selectOnly(CAMP)).toEqual(sel(CAMP));
    expect(selectOnly('both')).toEqual(sel('both'));
  });
});

describe('toggleOverlay', () => {
  it('adds a custom list over Both, a person or another custom base', () => {
    expect(toggleOverlay(sel('both'), CAMP, lists).selection).toEqual(sel('both', CAMP));
    expect(toggleOverlay(sel('sam'), CAMP, lists).selection).toEqual(sel('sam', CAMP));
    expect(toggleOverlay(sel('alex'), CAMP, lists).selection).toEqual(sel('alex', CAMP));
    expect(toggleOverlay(sel(HOME), CAMP, lists).selection).toEqual(sel(HOME, CAMP));
  });
  it('removes a ticked overlay and keeps the rest', () => {
    expect(toggleOverlay(sel('both', CAMP, HOME), CAMP, lists).selection).toEqual(sel('both', HOME));
    expect(toggleOverlay(sel('sam', CAMP), CAMP, lists)).toEqual({ selection: sel('sam') });
  });
  it('refuses a third overlay and says why, leaving the selection unchanged', () => {
    const r = toggleOverlay(sel('both', CAMP, HOME), GIFT, lists);
    expect(r).toEqual({ selection: sel('both', CAMP, HOME), rejected: 'overlay_limit' });
  });
  it('unticking the sole custom base lands on Both and keeps the overlays', () => {
    expect(toggleOverlay(sel(CAMP), CAMP, lists)).toEqual({ selection: sel('both') });
    expect(toggleOverlay(sel(CAMP, HOME), CAMP, lists).selection).toEqual(sel('both', HOME));
  });
  it('removing an overlay at the limit frees a slot for another', () => {
    const full = toggleOverlay(sel('both', CAMP, HOME), HOME, lists).selection;
    expect(toggleOverlay(full, GIFT, lists).selection).toEqual(sel('both', CAMP, GIFT));
  });
  it('never toggles Sam, Alex, Both or an unknown id', () => {
    for (const id of ['sam', 'alex', 'both', '44444444-4444-4444-8444-444444444444']) {
      expect(toggleOverlay(sel('both', CAMP), id, lists)).toEqual({ selection: sel('both', CAMP) });
      expect(toggleOverlay(sel('sam'), id, lists)).toEqual({ selection: sel('sam') });
    }
  });
  it('Both never gains a custom list unless it is ticked', () => {
    expect(resolveLanes(selectOnly('both'), lists, 'alex').map(l => l.listId)).toEqual(['alex', 'sam']);
    expect(toggleOverlay(selectOnly('both'), 'sam', lists).selection.overlays).toEqual([]);
  });
  it('does not mutate its input', () => {
    const input = sel('both', CAMP);
    toggleOverlay(input, HOME, lists);
    expect(input).toEqual(sel('both', CAMP));
  });
});

describe('resolveLanes', () => {
  it('Both puts the signed-in person on the left, for Alex and for Sam', () => {
    const alex = resolveLanes(sel('both'), lists, 'alex');
    expect(alex.map(l => [l.listId, l.name, l.color, l.you])).toEqual([['alex', 'Alex', 'green', true], ['sam', 'Sam', 'yellow', false]]);
    const sam = resolveLanes(sel('both'), lists, 'sam');
    expect(sam.map(l => [l.listId, l.you])).toEqual([['sam', true], ['alex', false]]);
  });
  it('a single list is one lane, and you marks it only when it is the signed-in person', () => {
    expect(resolveLanes(sel('sam'), lists, 'alex').map(l => [l.listId, l.you])).toEqual([['sam', false]]);
    expect(resolveLanes(sel('alex'), lists, 'alex').map(l => [l.listId, l.you])).toEqual([['alex', true]]);
    expect(resolveLanes(sel(CAMP), lists, 'sam').map(l => [l.listId, l.name, l.color, l.you])).toEqual([[CAMP, 'Camping', 'blue', false]]);
  });
  it('overlays follow the base in list order, not tick order', () => {
    expect(resolveLanes(sel('both', GIFT, CAMP), lists, 'alex').map(l => l.listId)).toEqual(['alex', 'sam', CAMP, GIFT]);
    expect(resolveLanes(sel('sam', HOME), lists, 'alex').map(l => l.listId)).toEqual(['sam', HOME]);
    expect(resolveLanes(sel(CAMP, GIFT), lists, 'alex').map(l => l.listId)).toEqual([CAMP, GIFT]);
  });
  it('heals a dangling selection instead of throwing', () => {
    expect(resolveLanes(sel('55555555-5555-4555-8555-555555555555', CAMP), lists, 'sam').map(l => l.listId)).toEqual(['sam', 'alex', CAMP]);
  });
  it('uses the current name and color of each list', () => {
    const renamed = lists.map(l => (l.id === CAMP ? { ...l, name: 'Trips', color: 'pink' as const } : l));
    expect(resolveLanes(sel(CAMP), renamed, 'alex')[0]).toMatchObject({ name: 'Trips', color: 'pink' });
  });
});

describe('pickerRows', () => {
  it('lists Both, Sam, Alex, then custom lists by order', () => {
    const shuffled = [lists[3], lists[1], lists[4], lists[0], lists[2]];
    expect(pickerRows(shuffled, sel('both')).map(r => r.id)).toEqual(['both', 'sam', 'alex', CAMP, HOME, GIFT]);
  });
  it('labels, colors and kinds: Both has no color of its own here', () => {
    const rows = pickerRows(lists, sel('both'));
    expect(rows.map(r => [r.label, r.color, r.kind])).toEqual([
      ['Both', null, 'both'], ['Sam', 'yellow', 'person'], ['Alex', 'green', 'person'],
      ['Camping', 'blue', 'custom'], ['Home', 'orange', 'custom'], ['Gifts', 'teal', 'custom'],
    ]);
  });
  it('only custom rows can be checked', () => {
    expect(pickerRows(lists, sel('both')).map(r => r.canCheck)).toEqual([false, false, false, true, true, true]);
  });
  it('Both selected: only the Both row is the base; nothing custom is on screen', () => {
    const rows = pickerRows(lists, sel('both'));
    expect(rows.map(r => r.selected)).toEqual([true, false, false, false, false, false]);
    expect(rows.filter(r => r.kind === 'custom').some(r => r.checked || r.checkDisabled)).toBe(false);
  });
  it('Both selected: Both, Sam and Alex are all on screen, so all three rows read as checked', () => {
    expect(pickerRows(lists, sel('both')).map(r => [r.id, r.checked])).toEqual([
      ['both', true], ['sam', true], ['alex', true], [CAMP, false], [HOME, false], [GIFT, false],
    ]);
    expect(pickerRows(lists, sel('both', CAMP)).filter(r => r.checked).map(r => r.id)).toEqual(['both', 'sam', 'alex', CAMP]);
  });
  it('a custom base or overlays show neither person as on screen', () => {
    expect(pickerRows(lists, sel(CAMP)).filter(r => r.kind === 'person').map(r => r.checked)).toEqual([false, false]);
  });
  it('a person alone selects that row only', () => {
    const rows = pickerRows(lists, sel('sam'));
    expect(rows.map(r => [r.id, r.selected, r.checked])).toEqual([
      ['both', false, false], ['sam', true, true], ['alex', false, false], [CAMP, false, false], [HOME, false, false], [GIFT, false, false],
    ]);
  });
  it('a custom base is selected and ticked; overlays are ticked but not selected', () => {
    const rows = pickerRows(lists, sel(CAMP, HOME));
    const by = Object.fromEntries(rows.map(r => [r.id, r]));
    expect(by[CAMP]).toMatchObject({ selected: true, checked: true, canCheck: true, checkDisabled: false });
    expect(by[HOME]).toMatchObject({ selected: false, checked: true, canCheck: true });
    expect(by[GIFT]).toMatchObject({ selected: false, checked: false, checkDisabled: false });
    expect(by.both).toMatchObject({ selected: false, checked: false });
  });
  it('at the overlay limit the unticked boxes are disabled and the ticked ones stay live', () => {
    const by = Object.fromEntries(pickerRows(lists, sel('both', CAMP, HOME)).map(r => [r.id, r]));
    expect(by[GIFT]).toMatchObject({ checked: false, checkDisabled: true });
    expect(by[CAMP]).toMatchObject({ checked: true, checkDisabled: false });
    expect(by[HOME]).toMatchObject({ checked: true, checkDisabled: false });
    expect(by.sam.checkDisabled).toBe(false);
  });
  it('one overlay is under the limit', () => {
    expect(pickerRows(lists, sel('sam', CAMP)).find(r => r.id === HOME)!.checkDisabled).toBe(false);
  });
  it('a stale selection is resolved first', () => {
    const rows = pickerRows(lists, sel('55555555-5555-4555-8555-555555555555', CAMP));
    expect(rows[0].selected).toBe(true);
    expect(rows.find(r => r.id === CAMP)!.checked).toBe(true);
  });
});

describe('pickerColors', () => {
  it('Both is its own color, from settings', () => {
    expect(pickerColors(sel('both'), lists, settings)).toEqual(['purple']);
    expect(pickerColors(sel('both'), lists, { ...settings, bothColor: 'red' })).toEqual(['red']);
  });
  it('one list shows its color; overlays add slices in list order', () => {
    expect(pickerColors(sel('sam'), lists, settings)).toEqual(['yellow']);
    expect(pickerColors(sel(CAMP), lists, settings)).toEqual(['blue']);
    expect(pickerColors(sel('alex', GIFT, CAMP), lists, settings)).toEqual(['green', 'blue', 'teal']);
    expect(pickerColors(sel('both', HOME), lists, settings)).toEqual(['purple', 'orange']);
  });
});

describe('blankAim: the thirds of a blank to-do line (the click and the hover ghost both ask)', () => {
  const lanesOf = (s: Selection, me: 'alex' | 'sam' = 'alex') => resolveLanes(s, lists, me);
  const aim = (s: Selection, across: number, both = false, me: 'alex' | 'sam' = 'alex') => blankAim(s, lists, settings, lanesOf(s, me), across, both);
  it('the Both view is cut in thirds: the signed-in person on the left, one linked item in the middle, the other person on the right', () => {
    expect(aim(sel('both'), 0.1)).toEqual({ side: 'left', owners: ['alex'], color: 'green' });
    expect(aim(sel('both'), 0.5)).toEqual({ side: 'both', owners: ['alex', 'sam'], color: 'purple' });
    expect(aim(sel('both'), 0.9)).toEqual({ side: 'right', owners: ['sam'], color: 'yellow' });
    // Sam signed in: the lanes swap, so the left third is hers.
    expect(aim(sel('both'), 0.1, false, 'sam')).toEqual({ side: 'left', owners: ['sam'], color: 'yellow' });
    expect(aim(sel('both'), 0.9, false, 'sam')).toEqual({ side: 'right', owners: ['alex'], color: 'green' });
  });
  it('the edges belong to the side they are on: a third starts at 1/3 and the right one at 2/3; the ends are the lanes', () => {
    expect(aim(sel('both'), 0).side).toBe('left');
    expect(aim(sel('both'), 1 / 3 - 0.001).side).toBe('left');
    expect(aim(sel('both'), 1 / 3).side).toBe('both');
    expect(aim(sel('both'), 2 / 3 - 0.001).side).toBe('both');
    expect(aim(sel('both'), 2 / 3).side).toBe('right');
    expect(aim(sel('both'), 1).side).toBe('right');
    expect(aim(sel('both'), -5).side).toBe('left');
    expect(aim(sel('both'), 9).side).toBe('right');
  });
  it('both forces the middle, and a position that is not a number is the middle too', () => {
    expect(aim(sel('both'), 0.05, true)).toEqual({ side: 'both', owners: ['alex', 'sam'], color: 'purple' });
    expect(aim(sel('both'), 0.95, true).side).toBe('both');
    expect(aim(sel('both'), Number.NaN).side).toBe('both');
  });
  it('the middle wears the Both color from settings', () => {
    expect(blankAim(sel('both'), lists, { ...settings, bothColor: 'red' }, lanesOf(sel('both')), 0.5).color).toBe('red');
  });
  it('one list alone has no thirds, wherever the pointer is', () => {
    for (const across of [0, 0.2, 0.5, 0.8, 1]) {
      expect(aim(sel('alex'), across)).toEqual({ side: 'only', owners: ['alex'], color: 'green' });
      expect(aim(sel('sam'), across, true)).toEqual({ side: 'only', owners: ['sam'], color: 'yellow' });
      expect(aim(sel(CAMP), across)).toEqual({ side: 'only', owners: [CAMP], color: 'blue' });
    }
  });
  it('a custom list with an overlay, and Both with an overlay (three lanes), have no thirds: the line is for the top picker\'s base', () => {
    expect(blankThirds(sel(CAMP, HOME), lists, settings, lanesOf(sel(CAMP, HOME)))).toBe(false);
    expect(aim(sel(CAMP, HOME), 0.9)).toEqual({ side: 'only', owners: [CAMP], color: 'blue' });
    expect(blankThirds(sel('both', HOME), lists, settings, lanesOf(sel('both', HOME)))).toBe(false);
    expect(aim(sel('both', HOME), 0.1)).toEqual({ side: 'only', owners: ['alex', 'sam'], color: 'purple' });
    expect(blankThirds(sel('both'), lists, settings, lanesOf(sel('both')))).toBe(true);
  });
});

describe('newOwners', () => {
  it('Both is the one linked record, in the Both color from settings', () => {
    expect(newOwners(sel('both'), lists, settings)).toEqual({ owners: ['alex', 'sam'], color: 'purple' });
    expect(newOwners(sel('both'), lists, { ...settings, bothColor: 'red' })).toEqual({ owners: ['alex', 'sam'], color: 'red' });
  });
  it('a single list is that list alone, in its own color', () => {
    expect(newOwners(sel('alex'), lists, settings)).toEqual({ owners: ['alex'], color: 'green' });
    expect(newOwners(sel('sam'), lists, settings)).toEqual({ owners: ['sam'], color: 'yellow' });
    expect(newOwners(sel(CAMP), lists, settings)).toEqual({ owners: [CAMP], color: 'blue' });
  });
  it('the color follows the list, so a recolored list changes it', () => {
    const recolored = lists.map(l => (l.id === 'sam' ? { ...l, color: 'pink' as const } : l));
    expect(newOwners(sel('sam'), recolored, settings).color).toBe('pink');
  });
  it('overlays never decide the owner', () => {
    expect(newOwners(sel('both', CAMP), lists, settings).owners).toEqual(['alex', 'sam']);
    expect(newOwners(sel('sam', CAMP, HOME), lists, settings).owners).toEqual(['sam']);
    expect(newOwners(sel(CAMP, GIFT), lists, settings).owners).toEqual([CAMP]);
  });
  it('a tapped lane decides, whatever the base and the overlays', () => {
    expect(newOwners(sel('both'), lists, settings, 'alex')).toEqual({ owners: ['alex'], color: 'green' });
    expect(newOwners(sel('both', CAMP), lists, settings, CAMP)).toEqual({ owners: [CAMP], color: 'blue' });
    expect(newOwners(sel('sam'), lists, settings, 'sam').owners).toEqual(['sam']);
  });
  it('a lane that is not a list is ignored, and a base that is not a list reads as Both', () => {
    expect(newOwners(sel('alex'), lists, settings, 'both').owners).toEqual(['alex']);
    expect(newOwners(sel('alex'), lists, settings, '99999999-9999-4999-8999-999999999999').owners).toEqual(['alex']);
    expect(newOwners(sel('99999999-9999-4999-8999-999999999999'), lists, settings)).toEqual({ owners: ['alex', 'sam'], color: 'purple' });
  });
  it('always names a canonical owner set, and never the word both as a list', () => {
    for (const base of ['both', 'sam', 'alex', CAMP, HOME, GIFT]) {
      for (const lane of [undefined, 'sam', 'alex', CAMP]) {
        const { owners } = newOwners(sel(base, GIFT), lists, settings, lane);
        expect(canonicalOwners(owners)).toEqual(owners);
        expect(owners).not.toContain('both');
      }
    }
  });
});

describe('listDeleteImpact', () => {
  const at = { revision: 1, createdBy: 'alex', updatedBy: 'alex', createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z', ak: 'a' } as const;
  const todo = (id: string, owners: string[]) => ({ id, scope: 'day' as const, date: '2026-10-30', owners, title: id, done: false, pos: 1024, ...at });
  const priority = (id: string, owners: string[]) => ({ id, date: '2026-10-30', owners, slots: Object.fromEntries(owners.map(o => [o, 1])), text: id, ...at });
  const event = (id: string, owners: string[]) => ({ id, date: '2026-10-30', owners, text: id, start: 540, length: 30, ...at });
  const note = (listId: string, text: string, period = '2026-10-30') => ({ key: `day:${period}:${listId}:notes`, scope: 'day' as const, period, listId, field: 'notes' as const, text, revision: 1, updatedAt: stamp.updatedAt });
  const none = { tasks: [], priorities: [], events: [], notes: [] };

  it('counts the to-dos, priorities and events the list owns alone, and not linked ones', () => {
    const data = {
      tasks: [todo('a', [CAMP]), todo('b', [CAMP]), todo('c', ['sam', 'alex']), todo('d', [HOME])],
      priorities: [priority('p', [CAMP]), priority('q', ['sam', 'alex'])],
      events: [event('e', [CAMP]), event('f', [GIFT])],
      notes: [],
    };
    expect(listDeleteImpact(data as never, CAMP)).toEqual({ items: 4, notes: 0 });
    expect(listDeleteImpact(data as never, HOME)).toEqual({ items: 1, notes: 0 });
    expect(listDeleteImpact(data as never, 'sam')).toEqual({ items: 0, notes: 0 });
  });
  it('counts only the notes of that list that hold text', () => {
    const data = { ...none, notes: [note(CAMP, 'tent'), note(CAMP, '  \n '), note(CAMP, 'stove', '2026-10-31'), note(HOME, 'paint')] };
    expect(listDeleteImpact(data as never, CAMP)).toEqual({ items: 0, notes: 2 });
    expect(listDeleteImpact(data as never, GIFT)).toEqual({ items: 0, notes: 0 });
  });
  it('is zero for a list with nothing in it', () => {
    expect(listDeleteImpact(none, CAMP)).toEqual({ items: 0, notes: 0 });
  });
});
