import { describe, expect, it } from 'vitest';
import {
  ADOPTED_PREF_STAMP,
  LOCAL_USER,
  USERNAME_PATTERN,
  adoptLocalStore,
  adoptionSnapshot,
  foldAdopted,
  mergeLocalInto,
  parseSnapshot,
  seedIdentity,
} from '../src/localmerge';
import { normalize, SUITE_SEEDS, type SeedProfile } from '../src/normalize';
import { SyncEngine, type Snapshot, type SyncRequest, type SyncResponse } from '../src/sync';
import { prefsId, type AnyRec, type Rec } from '../src/types';

/**
 * No-account local mode: the local store folded into an account at sign-in.
 * Both seed profiles are passed explicitly, so this file is canon in every app.
 */
const LISTS: SeedProfile = {
  reminders: { kind: 'lists', shopping: { name: 'Shopping list', color: '#f0b429' }, pantry: { name: 'Pantry', color: '#5fb6ac' } },
  calendar: false,
  habits: false,
};

/** A store as an app grows it on first load: normalize's starters, put through the engine. */
function seeded(profile: SeedProfile, t0 = 1_000): SyncEngine {
  const e = new SyncEngine();
  for (const r of normalize([], profile).added) e.put(r, t0);
  // normalize only seeds a section once its folder exists, so run it to a fixed point.
  for (let i = 0; i < 3; i++) {
    const { added, edited } = normalize(e.all(), profile);
    for (const r of [...added, ...edited]) e.put(r, t0 + 1 + i);
  }
  return e;
}

const live = (e: SyncEngine) => e.all();
const folders = (e: SyncEngine) => live(e).filter((r): r is Rec<'folder'> => r.type === 'folder');
const firstSection = (e: SyncEngine, folderId: string) =>
  live(e).find((r): r is Rec<'section'> => r.type === 'section' && r.payload.folderId === folderId)!;
const folderBy = (e: SyncEngine, pick: (f: Rec<'folder'>) => boolean) => folders(e).find(pick)!;

function reminder(id: string, f: Rec<'folder'>, sec: Rec<'section'>, text: string): AnyRec {
  return {
    id, type: 'reminder', updated: 0,
    payload: { text, due: null, time: null, done: false, repeat: null, folderId: f.id, sectionId: sec.id, indent: 0, ord: 'm' },
  };
}

/** A transport that plays the server: holds what it is sent, returns the tail. */
function fakeServer(initial: AnyRec[] = []) {
  let seq = 0;
  const recs = new Map<string, AnyRec & { seq: number }>();
  for (const r of initial) recs.set(r.id, { ...r, seq: ++seq });
  const sent: AnyRec[] = [];
  const transport = async (req: SyncRequest): Promise<SyncResponse> => {
    for (const c of req.changes) {
      sent.push(c);
      const cur = recs.get(c.id);
      if (!cur || c.updated > cur.updated) recs.set(c.id, { ...c, seq: ++seq });
    }
    const tail = [...recs.values()].filter((r) => r.seq > req.cursor).sort((a, b) => a.seq - b.seq);
    return { cursor: seq, changes: tail.map(({ seq: _s, ...r }) => r as AnyRec) };
  };
  return { transport, sent, recs };
}

describe('the local user', () => {
  it('can never be a username', () => {
    expect(USERNAME_PATTERN.test(LOCAL_USER)).toBe(false);
    expect(LOCAL_USER.startsWith('~')).toBe(true);
    expect(USERNAME_PATTERN.test('owner_1')).toBe(true);
  });
});

describe('parseSnapshot', () => {
  it('tells nothing stored from something unreadable', () => {
    expect(parseSnapshot(null)).toEqual({ kind: 'none' });
    expect(parseSnapshot('{not json')).toEqual({ kind: 'damaged' });
    expect(parseSnapshot('null')).toEqual({ kind: 'damaged' });
    expect(parseSnapshot('{"cursor":0,"recs":{},"dirty":[]}')).toEqual({ kind: 'damaged' });
    expect(parseSnapshot('{"cursor":0,"recs":[{"type":"note"}],"dirty":[]}')).toEqual({ kind: 'damaged' });
    expect(parseSnapshot('{"cursor":0,"recs":[],"dirty":[3]}')).toEqual({ kind: 'damaged' });
  });

  it('reads back what an engine wrote', () => {
    const e = seeded(SUITE_SEEDS);
    const p = parseSnapshot(JSON.stringify(e.toSnapshot()));
    expect(p.kind).toBe('ok');
    if (p.kind === 'ok') expect(p.snap).toEqual(e.toSnapshot());
  });
});

describe('adoptionSnapshot', () => {
  it('takes live records, every one dirty, cursor 0; drops tombstones and account-only types; demotes prefs', () => {
    const local: Snapshot = {
      cursor: 0,
      recs: [
        { id: 'n1', type: 'note', updated: 50, payload: { title: 'a', body: '', date: null, folderId: 'f', sectionId: 's', ord: 'm' } },
        { id: 'gone', type: 'note', updated: 60, deleted: true, payload: { title: 'b', body: '', date: null, folderId: 'f', sectionId: 's', ord: 'm' } },
        { id: 'share', type: 'share', updated: 70, payload: { partners: ['someone'], calendars: [], folders: [], notefolders: [] } },
        { id: prefsId('suite'), type: 'pref', updated: 80, payload: { theme: 'paper' } },
      ] as AnyRec[],
      dirty: ['n1'],
    };
    const a = adoptionSnapshot(local);
    expect(a.cursor).toBe(0);
    expect(a.recs.map((r) => r.id)).toEqual(['n1', prefsId('suite')]);
    expect(a.dirty).toEqual(['n1', prefsId('suite')]);
    expect(a.recs.find((r) => r.type === 'pref')!.updated).toBe(ADOPTED_PREF_STAMP);
    expect(local.recs[3]!.updated).toBe(80); // the input is untouched
  });
});

describe('seedIdentity', () => {
  it('names starters by flag or by starter name, and a renamed one not at all', () => {
    const e = seeded(SUITE_SEEDS);
    const ids = folders(e).map(seedIdentity).sort();
    expect(ids).toEqual(['folder:notes:General', 'folder:reminders:Reminders', 'folder:rideAlong']);
    const f = folderBy(e, (x) => x.payload.name === 'Reminders');
    expect(seedIdentity({ ...f, payload: { ...f.payload, name: 'Errands' } })).toBeNull();
    expect(seedIdentity({ ...f, deleted: true })).toBeNull();
  });
});

describe('mergeLocalInto', () => {
  it('into an empty account engine: every local record arrives, dirty, and the cursor stays', () => {
    const local = seeded(SUITE_SEEDS);
    const f = folderBy(local, (x) => x.payload.name === 'Reminders');
    local.put(reminder('r1', f, firstSection(local, f.id), 'buy milk'), 2_000);
    const account = new SyncEngine();
    const { adopted } = mergeLocalInto(account, local.toSnapshot());
    const ids = local.all().map((r) => r.id).sort();
    expect([...adopted].sort()).toEqual(ids);
    expect(account.all().map((r) => r.id).sort()).toEqual(ids);
    expect(account.toSnapshot().dirty.sort()).toEqual(ids);
    expect(account.toSnapshot().cursor).toBe(0);
  });

  it('the next sync pushes every adopted record', async () => {
    const local = seeded(LISTS);
    const shop = folderBy(local, (x) => !!x.payload.shopping);
    local.put(reminder('r1', shop, firstSection(local, shop.id), 'eggs'), 2_000);
    const account = new SyncEngine();
    mergeLocalInto(account, local.toSnapshot());
    const server = fakeServer();
    await account.sync(server.transport);
    expect(server.sent.map((r) => r.id).sort()).toEqual(local.all().map((r) => r.id).sort());
    expect(account.hasPending()).toBe(false);
  });

  it("a local pref loses to the account's, and is kept where the account has none", () => {
    const local = new SyncEngine();
    local.put({ id: prefsId('suite'), type: 'pref', updated: 0, payload: { theme: 'paper' } }, 9_000);
    local.put({ id: prefsId('notes'), type: 'pref', updated: 0, payload: { lastView: 'all' } }, 9_000);
    const account = new SyncEngine();
    account.put({ id: prefsId('suite'), type: 'pref', updated: 0, payload: { theme: 'forest', clock24: true } }, 5_000);
    const { adopted } = mergeLocalInto(account, local.toSnapshot());
    const suite = account.get(prefsId('suite')) as Rec<'pref'>;
    expect(suite.payload).toEqual({ theme: 'forest', clock24: true });
    expect(adopted.has(prefsId('suite'))).toBe(false);
    expect(adopted.has(prefsId('notes'))).toBe(true);
    expect(account.get(prefsId('notes'))!.updated).toBe(ADOPTED_PREF_STAMP);
  });

  it('a local pref pushed to an account the server already has prefs for comes back as the account\'s', async () => {
    const local = new SyncEngine();
    local.put({ id: prefsId('suite'), type: 'pref', updated: 0, payload: { theme: 'paper' } }, 9_000);
    const server = fakeServer([{ id: prefsId('suite'), type: 'pref', updated: 5_000, payload: { theme: 'forest' } } as AnyRec]);
    const account = new SyncEngine(); // a new device: nothing cached yet
    mergeLocalInto(account, local.toSnapshot());
    await account.sync(server.transport);
    expect((account.get(prefsId('suite')) as Rec<'pref'>).payload.theme).toBe('forest');
    expect(account.hasPending()).toBe(false);
  });

  it('folds CalMind starters into the account\'s own, moving what they hold', () => {
    const local = seeded(SUITE_SEEDS, 1_000);
    const lRem = folderBy(local, (x) => x.payload.name === 'Reminders');
    const lRide = folderBy(local, (x) => !!x.payload.rideAlong);
    const lNotes = folderBy(local, (x) => x.payload.name === 'General');
    const lCal = local.all().find((r): r is Rec<'calendar'> => r.type === 'calendar')!;
    const lHab = local.all().find((r): r is Rec<'habitsection'> => r.type === 'habitsection')!;
    local.put(reminder('r1', lRem, firstSection(local, lRem.id), 'call the bank'), 2_000);
    local.put(reminder('r2', lRide, firstSection(local, lRide.id), 'water plants'), 2_000);
    local.put({ id: 'n1', type: 'note', updated: 0, payload: { title: 'ideas', body: '', date: null, folderId: lNotes.id, sectionId: firstSection(local, lNotes.id).id, ord: 'm' } }, 2_000);
    local.put({ id: 'e1', type: 'event', updated: 0, payload: { text: 'dentist', date: '2026-12-01', time: null, repeat: null, calendarId: lCal.id, ord: 'm' } }, 2_000);
    local.put({ id: 'h1', type: 'habit', updated: 0, payload: { name: 'walk', sectionId: lHab.id, ord: 'm' } }, 2_000);
    // A folder the person made: it is theirs and comes across as it is.
    local.put({ id: 'own', type: 'folder', updated: 0, payload: { name: 'Errands', color: '#123456', ord: 'z', app: 'reminders' } }, 2_000);
    local.put({ id: 'ownsec', type: 'section', updated: 0, payload: { name: 'General', folderId: 'own', ord: 'm' } }, 2_000);

    const account = seeded(SUITE_SEEDS, 500);
    const aRem = folderBy(account, (x) => x.payload.name === 'Reminders');
    const aRide = folderBy(account, (x) => !!x.payload.rideAlong);
    const aNotes = folderBy(account, (x) => x.payload.name === 'General');
    const aCal = account.all().find((r) => r.type === 'calendar')!;
    const aHab = account.all().find((r) => r.type === 'habitsection')!;

    mergeLocalInto(account, local.toSnapshot());

    // One of each starter, and they are the account's.
    expect(folders(account).filter((f) => f.payload.name === 'Reminders').map((f) => f.id)).toEqual([aRem.id]);
    expect(folders(account).filter((f) => f.payload.rideAlong).map((f) => f.id)).toEqual([aRide.id]);
    expect(folders(account).filter((f) => f.payload.name === 'General').map((f) => f.id)).toEqual([aNotes.id]);
    expect(account.all().filter((r) => r.type === 'calendar').map((r) => r.id)).toEqual([aCal.id]);
    expect(account.all().filter((r) => r.type === 'habitsection').map((r) => r.id)).toEqual([aHab.id]);
    expect(account.get('own')).toBeDefined();

    // Everything they held is in the account's, in a live section of it.
    const r1 = account.get('r1') as Rec<'reminder'>;
    const r2 = account.get('r2') as Rec<'reminder'>;
    const n1 = account.get('n1') as Rec<'note'>;
    expect(r1.payload.folderId).toBe(aRem.id);
    expect(r2.payload.folderId).toBe(aRide.id);
    expect(n1.payload.folderId).toBe(aNotes.id);
    for (const it of [r1, r2, n1]) {
      const sec = account.get(it.payload.sectionId) as Rec<'section'> | undefined;
      expect(sec?.payload.folderId).toBe(it.payload.folderId);
    }
    expect((account.get('e1') as Rec<'event'>).payload.calendarId).toBe(aCal.id);
    expect((account.get('h1') as Rec<'habit'>).payload.sectionId).toBe(aHab.id);

    // Every record from the local store is still on its way to the server.
    const dirty = new Set(account.toSnapshot().dirty);
    for (const id of ['r1', 'r2', 'n1', 'e1', 'h1', 'own']) expect(dirty.has(id)).toBe(true);

    // And normalize finds nothing left to fix.
    const after = normalize(account.all(), SUITE_SEEDS);
    expect(after.added).toEqual([]);
    expect(after.edited).toEqual([]);
  });

  it('folds MealMind\'s shopping list and pantry, rows landing in the list the screen draws', () => {
    const local = seeded(LISTS, 1_000);
    const lShop = folderBy(local, (x) => !!x.payload.shopping);
    const lPan = folderBy(local, (x) => !!x.payload.pantry);
    local.put(reminder('s1', lShop, firstSection(local, lShop.id), 'eggs'), 2_000);
    local.put(reminder('p1', lPan, firstSection(local, lPan.id), 'flour'), 2_000);
    const account = seeded(LISTS, 500);
    const aShop = folderBy(account, (x) => !!x.payload.shopping);
    const aPan = folderBy(account, (x) => !!x.payload.pantry);
    account.put(reminder('a1', aShop, firstSection(account, aShop.id), 'milk'), 600);

    mergeLocalInto(account, local.toSnapshot());

    expect(folders(account).filter((f) => f.payload.shopping).map((f) => f.id)).toEqual([aShop.id]);
    expect(folders(account).filter((f) => f.payload.pantry).map((f) => f.id)).toEqual([aPan.id]);
    const s1 = account.get('s1') as Rec<'reminder'>;
    const p1 = account.get('p1') as Rec<'reminder'>;
    expect(s1.payload).toMatchObject({ folderId: aShop.id, sectionId: firstSection(account, aShop.id).id });
    expect(p1.payload).toMatchObject({ folderId: aPan.id, sectionId: firstSection(account, aPan.id).id });
    expect(account.get('a1')).toBeDefined();
    expect(account.get(lShop.id)).toBeUndefined();
    expect(account.get(firstSection(local, lShop.id).id)).toBeUndefined();
  });

  it('a new account (nothing to fold into) simply takes the local starters', () => {
    const local = seeded(LISTS);
    const account = new SyncEngine();
    const { folded } = mergeLocalInto(account, local.toSnapshot());
    expect(folded).toBe(0);
    expect(folders(account).map((f) => f.id).sort()).toEqual(folders(local).map((f) => f.id).sort());
  });

  it('a renamed starter is the person\'s own folder and is not folded', () => {
    const local = seeded(SUITE_SEEDS, 1_000);
    const lRem = folderBy(local, (x) => x.payload.name === 'Reminders');
    local.put({ ...lRem, payload: { ...lRem.payload, name: 'Work' } }, 2_000);
    const account = seeded(SUITE_SEEDS, 500);
    mergeLocalInto(account, local.toSnapshot());
    expect(account.get(lRem.id)).toBeDefined();
  });

  it('is a no-op the second time: re-running after a crash changes nothing', () => {
    const local = seeded(SUITE_SEEDS, 1_000);
    const lRem = folderBy(local, (x) => x.payload.name === 'Reminders');
    local.put(reminder('r1', lRem, firstSection(local, lRem.id), 'x'), 2_000);
    const account = seeded(SUITE_SEEDS, 500);
    mergeLocalInto(account, local.toSnapshot());
    const once = JSON.stringify(account.toSnapshot());
    const again = mergeLocalInto(account, local.toSnapshot());
    expect(again.folded).toBe(0);
    expect(JSON.stringify(account.toSnapshot())).toBe(once);
  });
});

describe('foldAdopted after the first sync', () => {
  it('folds the starters a stale (empty) account cache could not show at sign-in', async () => {
    const local = seeded(LISTS, 1_000);
    const lShop = folderBy(local, (x) => !!x.payload.shopping);
    local.put(reminder('s1', lShop, firstSection(local, lShop.id), 'eggs'), 2_000);
    // The server already holds this account's lists; this device has never synced it.
    const theirs = seeded(LISTS, 500);
    const server = fakeServer(theirs.toSnapshot().recs);
    const aShop = folderBy(theirs, (x) => !!x.payload.shopping);

    const account = new SyncEngine();
    const { adopted, folded } = mergeLocalInto(account, local.toSnapshot());
    expect(folded).toBe(0); // nothing to see yet
    await account.sync(server.transport);
    expect(folders(account).filter((f) => f.payload.shopping)).toHaveLength(2);

    const puts = foldAdopted(account.toSnapshot().recs, adopted);
    for (const r of puts) account.put(r, 3_000);
    expect(folders(account).filter((f) => f.payload.shopping).map((f) => f.id)).toEqual([aShop.id]);
    expect((account.get('s1') as Rec<'reminder'>).payload.folderId).toBe(aShop.id);
    await account.sync(server.transport);
    expect(account.hasPending()).toBe(false);
    expect(server.recs.get(lShop.id)?.deleted).toBe(true);
  });

  it('never folds two adopted containers into each other', () => {
    const local = seeded(SUITE_SEEDS);
    const recs = local.toSnapshot().recs;
    expect(foldAdopted(recs, new Set(recs.map((r) => r.id)))).toEqual([]);
  });
});

describe('adoptLocalStore: the order of the writes', () => {
  const localStore = () => {
    const local = seeded(SUITE_SEEDS, 1_000);
    const f = folderBy(local, (x) => x.payload.name === 'Reminders');
    local.put(reminder('r1', f, firstSection(local, f.id), 'only copy'), 2_000);
    return local.toSnapshot();
  };

  it('writes the merged account snapshot, then (and only then) removes the local one', async () => {
    const calls: string[] = [];
    let written = '';
    const out = await adoptLocalStore(new SyncEngine(), localStore(), {
      writeAccount: async (json) => { calls.push('write'); written = json; },
      removeLocal: async () => { calls.push('remove'); },
    });
    expect(calls).toEqual(['write', 'remove']);
    expect(out).toMatchObject({ persisted: true, localCleared: true });
    const saved = parseSnapshot(written);
    expect(saved.kind).toBe('ok');
    if (saved.kind === 'ok') {
      expect(saved.snap.recs.some((r) => r.id === 'r1')).toBe(true);
      expect(saved.snap.dirty).toContain('r1');
    }
  });

  it('a failed account write never removes the local snapshot', async () => {
    let removed = false;
    const engine = new SyncEngine();
    const out = await adoptLocalStore(engine, localStore(), {
      writeAccount: async () => { throw new Error('quota'); },
      removeLocal: async () => { removed = true; },
    });
    expect(removed).toBe(false);
    expect(out).toMatchObject({ persisted: false, localCleared: false });
    // The records are still in memory, dirty, so a sync can carry them anyway.
    expect(engine.toSnapshot().dirty).toContain('r1');
  });

  it('a failed removal is reported, not thrown', async () => {
    const out = await adoptLocalStore(new SyncEngine(), localStore(), {
      writeAccount: async () => {},
      removeLocal: async () => { throw new Error('refused'); },
    });
    expect(out).toMatchObject({ persisted: true, localCleared: false });
  });

  it('keepLocal merges but leaves the key alone', async () => {
    let removed = false;
    const out = await adoptLocalStore(new SyncEngine(), localStore(), {
      writeAccount: async () => {},
      removeLocal: async () => { removed = true; },
    }, { keepLocal: true });
    expect(removed).toBe(false);
    expect(out).toMatchObject({ persisted: true, localCleared: false });
  });
});
