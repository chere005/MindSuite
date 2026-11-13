/**
 * normalize() must SETTLE. Nothing was checking that it does.
 *
 * store.tsx calls it on every refresh and puts everything it hands back:
 *
 *     const { added, edited } = normalize(engine.all());
 *     for (const r of [...added, ...edited]) engine.put(r);
 *
 * `put` marks a record dirty, a dirty record is pushed on the next sync, and
 * a sync ends in another refresh. So a repair that does not settle is not a
 * cosmetic wobble — it is a write on every refresh, for ever, on every
 * device, and it looks like nothing at all from the outside except a store
 * that is never quite in sync and a battery that goes flat.
 *
 * This does not fix anything: normalize settles today, on all seven damage
 * cases below and on random stores. It is here because the property is the
 * kind that holds until someone adds one more repair, and because the failure
 * has no symptom anyone would report.
 *
 * The damage cases are the repairs normalize actually performs, taken from
 * its own source rather than imagined: a row pointing at a container that is
 * gone, a container pointing at a folder that is gone, an app with no folder,
 * a folder with no section, a live row inside a DELETED section, and two
 * containers sharing one ord key. The seeding path is included too — an empty
 * store is the case every new account starts from.
 *
 * Every case runs twice: with no profile (SUITE_SEEDS) and under a 'lists'
 * profile, which alone runs the one repair that removes a container (any
 * general reminders folder folded into the shopping list) and so the one most
 * able to chase its own tail. Its names and colours only label the seeds.
 */
import { describe, it, expect } from 'vitest';
import { normalize, type AnyRec, type SeedProfile } from '../src/index';

/** A 'lists' profile, ChefMind's shape: shopping list and pantry, no calendar or habit starters. */
const LISTS: SeedProfile = {
  reminders: { kind: 'lists', shopping: { name: 'Shopping list', color: '#f0b429' }, pantry: { name: 'Pantry', color: '#5fb6ac' } },
  calendar: false,
  habits: false,
};

/** One normalize pass, applied. Returns the new store and how much it wrote. */
function pass(recs: AnyRec[], profile?: SeedProfile): { next: AnyRec[]; wrote: number } {
  const { added, edited } = normalize(recs, profile);
  const byId = new Map(recs.map((r) => [r.id, r]));
  for (const r of [...added, ...edited]) byId.set(r.id, r);
  return { next: [...byId.values()], wrote: added.length + edited.length };
}

/** Normalise until it stops writing, or give up and say how far it got. */
function settle(recs: AnyRec[], profile?: SeedProfile, limit = 6): { passes: number; store: AnyRec[]; wrote: number[] } {
  const wrote: number[] = [];
  let store = recs;
  for (let i = 0; i < limit; i++) {
    const r = pass(store, profile);
    wrote.push(r.wrote);
    store = r.next;
    if (r.wrote === 0) return { passes: i, store, wrote };
  }
  return { passes: limit, store, wrote };
}

const folder = (id: string, app: 'reminders' | 'notes' = 'reminders', ord = id): AnyRec =>
  ({ id, type: 'folder', updated: 1, payload: { name: id, color: '#fff', ord, app } }) as AnyRec;
const section = (id: string, folderId: string): AnyRec =>
  ({ id, type: 'section', updated: 1, payload: { name: id, folderId, ord: id } }) as AnyRec;
const reminder = (id: string, folderId: string, sectionId: string): AnyRec =>
  ({
    id, type: 'reminder', updated: 1,
    payload: { text: id, due: null, time: null, done: false, repeat: null, folderId, sectionId, indent: 0, ord: id },
  }) as AnyRec;

const damaged: [string, AnyRec[]][] = [
  ['an empty store — what every new account starts from', []],
  ['a reminder in a section that is gone', [folder('f'), section('s', 'f'), reminder('r', 'f', 'GONE')]],
  ['a reminder in a folder that is gone', [folder('f'), section('s', 'f'), reminder('r', 'GONE', 's')]],
  ['a section in a folder that is gone', [folder('f'), section('s', 'f'), section('orphan', 'GONE')]],
  ['a folder with no section', [folder('f')]],
  ['a live reminder inside a DELETED section', [
    folder('f'), section('s', 'f'),
    { ...(section('dead', 'f') as { id: string }), deleted: true } as AnyRec,
    reminder('r', 'f', 'dead'),
  ]],
  ['two folders sharing one ord key', [folder('a'), section('sa', 'a'), folder('b', 'reminders', 'a'), section('sb', 'b')]],
  ['notes has a folder and reminders has none', [folder('nf', 'notes'), section('ns', 'nf')]],
];

/** A reminders folder carrying a list flag: under 'lists' it IS the list, never folded. */
const flagged = (id: string, flag: 'shopping' | 'pantry', ord = id): AnyRec =>
  ({ id, type: 'folder', updated: 1, payload: { name: id, color: '#fff', ord, app: 'reminders', [flag]: true } }) as AnyRec;

/** The damage only a 'lists' profile reacts to: the fold, and the flagged lists themselves. */
const listsDamaged: [string, AnyRec[]][] = [
  ['a general reminders folder beside the lists, with a row in it — folded away', [
    flagged('sh', 'shopping'), section('ssh', 'sh'), flagged('pa', 'pantry'), section('spa', 'pa'),
    folder('g'), section('sg', 'g'), reminder('r', 'g', 'sg'),
  ]],
  ['a pantry and no shopping list, a row stranded in a section that is gone', [
    flagged('pa', 'pantry'), section('spa', 'pa'), reminder('r', 'pa', 'GONE'),
  ]],
  ['two shopping lists, as two devices can make, and a stray', [
    flagged('a', 'shopping'), section('sa', 'a'), flagged('b', 'shopping', 'a'), section('sb', 'b'),
    flagged('pa', 'pantry'), section('spa', 'pa'), reminder('r', 'GONE', 'GONE'),
  ]],
  ['a shopping list with no section, beside a general folder with none either', [
    flagged('sh', 'shopping'), flagged('pa', 'pantry'), section('spa', 'pa'), folder('g'),
  ]],
];

const profiles: [string, SeedProfile | undefined, [string, AnyRec[]][]][] = [
  ['normalize settles', undefined, []],
  ['normalize settles under a lists profile', LISTS, listsDamaged],
];

for (const [title, profile, extra] of profiles) describe(title, () => {
  const lists = profile?.reminders.kind === 'lists';
  for (const [name, recs] of [...damaged, ...extra]) {
    it(name, () => {
      const { passes, wrote } = settle(recs, profile);
      // One pass to repair, and the next must write NOTHING. `passes` is the
      // index of the first silent pass, so 0 means it was already clean and 1
      // means it repaired once and then stopped — both fine. More than that
      // is a repair chasing its own tail.
      expect(passes, `still writing after ${wrote.length} passes: ${wrote.join(', ')}`).toBeLessThanOrEqual(1);
    });
  }

  it('settles on random damage, 400 stores', () => {
    // Deterministic, so a failure can be reproduced from the seed alone.
    let seed = 20260812;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;

    for (let n = 0; n < 400; n++) {
      const recs: AnyRec[] = [];
      const fids: string[] = [];
      const sids: string[] = [];
      for (let i = 0; i < Math.floor(rnd() * 4); i++) {
        const id = `f${i}`;
        fids.push(id);
        const app = rnd() < 0.3 ? 'notes' : 'reminders';
        const ord = rnd() < 0.25 ? 'DUP' : id;
        // Under 'lists' some reminders folders are the lists themselves. Only
        // then is rnd() drawn again, so the suite run draws the stores it always drew.
        const x = lists && app === 'reminders' ? rnd() : 1;
        recs.push(x < 0.3 ? flagged(id, 'shopping', ord) : x < 0.5 ? flagged(id, 'pantry', ord) : folder(id, app, ord));
      }
      for (let i = 0; i < Math.floor(rnd() * 5); i++) {
        const id = `s${i}`;
        sids.push(id);
        // Deliberately sometimes pointing at a folder that was never made.
        recs.push(section(id, rnd() < 0.3 ? 'GONE' : (fids.length ? pick(fids) : 'GONE')));
      }
      for (let i = 0; i < Math.floor(rnd() * 6); i++) {
        recs.push(reminder(
          `r${i}`,
          rnd() < 0.3 ? 'GONE' : (fids.length ? pick(fids) : 'GONE'),
          rnd() < 0.3 ? 'GONE' : (sids.length ? pick(sids) : 'GONE'),
        ));
      }
      // …and sometimes a tombstone over something still referenced.
      if (recs.length && rnd() < 0.3) {
        const at = Math.floor(rnd() * recs.length);
        recs[at] = { ...recs[at]!, deleted: true };
      }

      const { passes, wrote } = settle(recs, profile);
      expect(passes, `store ${n} kept writing: ${wrote.join(', ')}\n${JSON.stringify(recs)}`).toBeLessThanOrEqual(1);
    }
  });

  it('survives every container for an app being DELETED, rather than throwing', () => {
    // normalize claims `appFolders(app)[0]!.id` and `secsOf(folderId)[0]!.id`
    // when it re-homes a stranded row. Both are true only because seeding
    // runs FIRST — put the re-home ahead of it and these become a TypeError
    // inside refresh(), which escapes syncNow (its try/catch covers the
    // network, not this) and takes the render with it.
    //
    // Tombstones are the way to reach it: a folder can be deleted on the
    // phone while the web still holds rows inside it, which is an ordinary
    // Tuesday on three devices, not a corrupt store.
    const del = (r: AnyRec): AnyRec => ({ ...r, deleted: true });
    const note = (id: string, folderId: string, sectionId: string): AnyRec =>
      ({ id, type: 'note', updated: 1, payload: { title: id, body: '', date: null, folderId, sectionId, ord: id } }) as AnyRec;

    const cases: [string, AnyRec[]][] = [
      ['every reminders folder deleted', [del(folder('a')), section('sa', 'a'), reminder('r', 'a', 'sa')]],
      ['the folder lives, its every section deleted', [folder('a'), del(section('sa', 'a')), reminder('r', 'a', 'sa')]],
      ['both deleted', [del(folder('a')), del(section('sa', 'a')), reminder('r', 'a', 'sa')]],
      ['the notes side, same shape', [del(folder('n', 'notes')), del(section('sn', 'n')), note('nt', 'n', 'sn')]],
    ];
    if (lists) {
      cases.push(
        ['the shopping list deleted, a row still in it', [del(flagged('sh', 'shopping')), section('ssh', 'sh'), reminder('r', 'sh', 'ssh')]],
        ['both lists deleted, their sections too', [
          del(flagged('sh', 'shopping')), del(section('ssh', 'sh')), del(flagged('pa', 'pantry')), del(section('spa', 'pa')),
          reminder('r', 'pa', 'spa'),
        ]],
      );
    }
    for (const [name, recs] of cases) {
      expect(() => normalize(recs, profile), name).not.toThrow();
      // …and it still settles afterwards, which is the property above holding
      // on the paths that only a tombstone reaches.
      const { passes } = settle(recs, profile);
      expect(passes, `${name}: repaired but would not settle`).toBeLessThanOrEqual(1);
    }
  });

  it('and a settled store is left completely alone', () => {
    // The strong form: not "few writes" but none, and the same records out as
    // in. A normalize that rewrote one field harmlessly on every pass would
    // satisfy every test above via `edited` being cheap; it would still push
    // a record to the server on every refresh.
    const { store } = settle([], profile);
    const { added, edited } = normalize(store, profile);
    expect(added, 'a settled store adds nothing').toEqual([]);
    expect(edited, 'and edits nothing').toEqual([]);
  });
});
