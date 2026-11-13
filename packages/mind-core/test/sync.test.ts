import { describe, it, expect } from 'vitest';
import { SyncEngine } from '../src/sync';
import type { AnyRec, Rec, SyncRequest, SyncResponse } from '../src/index';

const reminder = (id: string, text: string, updated = 0): Rec<'reminder'> => ({
  id,
  type: 'reminder',
  updated,
  payload: { text, due: null, time: null, done: false, repeat: null, folderId: 'f', sectionId: 's', indent: 0, ord: 'V' },
});

/** A tiny in-memory server speaking the real protocol — LWW + per-user seq. */
function fakeServer() {
  const recs = new Map<string, AnyRec & { seq: number }>();
  let seq = 0;
  return async (req: SyncRequest): Promise<SyncResponse> => {
    for (const c of req.changes) {
      const cur = recs.get(c.id);
      if (!cur || c.updated > cur.updated) recs.set(c.id, { ...c, seq: ++seq });
    }
    const changes = [...recs.values()].filter((r) => r.seq > req.cursor).map(({ seq: _s, ...r }) => r as AnyRec);
    return { cursor: seq, changes };
  };
}

describe('the sync engine', () => {
  it('pushes local edits and clears them once acked', async () => {
    const server = fakeServer();
    const a = new SyncEngine();
    a.put(reminder('r1', 'buy milk'), 1000);
    expect(a.hasPending()).toBe(true);
    await a.sync(server);
    expect(a.hasPending()).toBe(false);
    expect(a.all().length).toBe(1);
  });

  it('two devices converge, later write winning', async () => {
    const server = fakeServer();
    const a = new SyncEngine();
    const b = new SyncEngine();
    a.put(reminder('r1', 'from a'), 1000);
    await a.sync(server);
    await b.sync(server); // b learns of r1
    const r1 = b.get('r1') as Rec<'reminder'>;
    b.put({ ...r1, payload: { ...r1.payload, text: 'from b, later' } }, 2000);
    await b.sync(server);
    await a.sync(server);
    expect((a.get('r1') as Rec<'reminder'>).payload.text).toBe('from b, later');
  });

  it('a tombstone deletes everywhere', async () => {
    const server = fakeServer();
    const a = new SyncEngine();
    const b = new SyncEngine();
    a.put(reminder('r1', 'doomed'), 1000);
    await a.sync(server);
    await b.sync(server);
    a.del('r1', 2000);
    await a.sync(server);
    await b.sync(server);
    expect(b.get('r1')).toBeUndefined();
    expect(b.all().length).toBe(0);
  });

  it('an echo of my own push is a no-op, not a flicker', async () => {
    const server = fakeServer();
    const a = new SyncEngine();
    const mine = a.put(reminder('r1', 'mine'), 1000);
    await a.sync(server);
    expect(a.get('r1')!.updated).toBe(mine.updated);
  });

  it('an edit made mid-flight stays dirty for the next round', async () => {
    const server = fakeServer();
    const a = new SyncEngine();
    a.put(reminder('r1', 'v1'), 1000);
    // Race: the transport is in flight while the user keeps typing.
    const slow = async (req: SyncRequest) => {
      const res = await server(req);
      const cur = a.get('r1') as Rec<'reminder'>;
      a.put({ ...cur, payload: { ...cur.payload, text: 'v2' } }, 2000);
      return res;
    };
    await a.sync(slow);
    expect(a.hasPending()).toBe(true); // v2 still owed to the server
  });

  it('a transport that fails keeps the work owed', async () => {
    // The commonest event in the life of a sync engine, and nothing was
    // watching it: a phone in a tunnel. The error must reach the caller so
    // the UI can say so, and the record must stay dirty — swallowing either
    // one turns a lost connection into a lost note.
    const a = new SyncEngine();
    a.put(reminder('r1', 'written underground'), 1000);
    await expect(a.sync(async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(a.hasPending(), 'still owed to the server').toBe(true);
    expect(a.toSnapshot().dirty).toEqual(['r1']);
    expect((a.get('r1') as Rec<'reminder'>).payload.text).toBe('written underground');
  });

  it('an equal stamp with DIFFERENT content takes the server\'s copy, so two devices converge', async () => {
    // The fix for "two devices can disagree forever" (the owner's call,
    // 2026-08-11: the server arbitrates). Strictly-newer on both sides left
    // every party holding its own incumbent on a tie, and neither would ever
    // push again because neither was dirty.
    //
    // The server now accepts an equal-stamped write whose content differs, so
    // its copy means "whichever edit reached it last". Taking that here is
    // what makes the two agree.
    const a = new SyncEngine();
    const mine = a.put(reminder('r1', 'mine'), 500);
    // Sent and accepted, so nothing is owed — this is the settled case.
    await a.sync(async () => ({ cursor: 1, changes: [] }));
    expect(a.hasPending()).toBe(false);
    await a.sync(async () => ({
      cursor: 2,
      changes: [{ ...mine, payload: { text: 'theirs' } } as Rec<'reminder'>],
    }));
    expect(
      (a.get('r1') as Rec<'reminder'>).payload.text,
      'the tie resolves to what the server holds, rather than the two staying different forever',
    ).toBe('theirs');
  });

  it('an equal stamp does NOT clobber an edit we have not pushed yet', async () => {
    // The one case where the incumbent must win. A dirty record has never
    // been offered to anyone, so it is not a stale loser — and overwriting it
    // would be silent AND pointless: the id stays dirty, so the next push
    // would send back the copy we just adopted, which the server recognises
    // as identical and ignores. The local writing would be gone for nothing.
    const a = new SyncEngine();
    const mine = a.put(reminder('r1', 'unsent'), 500);
    expect(a.hasPending()).toBe(true);
    await a.sync(async () => ({
      cursor: 1,
      // The server's tail carries a different record at the same stamp, and
      // reports nothing rejected — but our own push is in the same round
      // trip, so this arrives while we are still dirty.
      changes: [{ ...mine, payload: { text: 'theirs' } } as Rec<'reminder'>],
    }));
    expect(
      (a.get('r1') as Rec<'reminder'>).payload.text,
      'an unsent edit survives the tie; it gets pushed, and the OTHER device converges on it',
    ).toBe('unsent');
  });

  it('an equal stamp with the SAME content changes nothing', async () => {
    // The echo. Without this the two devices would hand the record back and
    // forth for ever, each "resolving" a tie that is not one.
    const a = new SyncEngine();
    const mine = a.put(reminder('r1', 'same'), 500);
    await a.sync(async () => ({ cursor: 1, changes: [] }));
    const before = a.get('r1');
    // The SAME payload, rebuilt with its keys in the opposite order — which
    // is the case the canonicalisation exists for. Without sorting, a client
    // that happens to serialise its object differently would read as a
    // conflict on every single sync.
    const reordered = Object.fromEntries(Object.entries(mine.payload).reverse());
    await a.sync(async () => ({
      cursor: 2,
      changes: [{ updated: mine.updated, id: 'r1', type: 'reminder', payload: reordered } as Rec<'reminder'>],
    }));
    expect(a.get('r1'), 'an echo is not a conflict').toBe(before); // identity: toEqual ignores key order and so cannot see a needless replacement
  });

  it('snapshots round-trip, dirt included', async () => {
    const a = new SyncEngine();
    a.put(reminder('r1', 'unsent'), 1000);
    const b = SyncEngine.fromSnapshot(JSON.parse(JSON.stringify(a.toSnapshot())));
    expect(b.hasPending()).toBe(true);
    expect(b.all().length).toBe(1);
  });
});

describe('a record the server refuses', () => {
  it('stays dirty and is named, instead of quietly becoming local-only', () => {
    // The old behaviour: the server dropped an oversized record, answered ok,
    // and the engine cleared it from dirty because it had been "sent". The
    // note then existed on exactly one device while the app reported
    // everything saved — the worst shape a sync bug can take.
    const e = new SyncEngine();
    e.put({ id: 'big', type: 'note', updated: 1, deleted: false, payload: { title: 'x', body: 'y' } } as never, 1);
    e.put({ id: 'ok', type: 'note', updated: 1, deleted: false, payload: { title: 'a', body: 'b' } } as never, 1);
    expect(e.hasPending()).toBe(true);

    const transport = async () => ({ cursor: 5, changes: [], rejected: ['big'] });
    return e.sync(transport).then(() => {
      expect(e.rejected(), 'the refusal is reported by id').toEqual(['big']);
      expect(e.hasPending(), 'and the record is still waiting to be saved').toBe(true);
      // The rest of the batch landed and is forgotten, as it should be.
      const snap = e.toSnapshot();
      expect(snap.dirty).toEqual(['big']);
    });
  });

  it('clears the refusal once the record is accepted', () => {
    const e = new SyncEngine();
    e.put({ id: 'big', type: 'note', updated: 1, deleted: false, payload: { title: 'x', body: 'y' } } as never, 1);
    return e
      .sync(async () => ({ cursor: 1, changes: [], rejected: ['big'] }))
      .then(() => e.sync(async () => ({ cursor: 2, changes: [], rejected: [] })))
      .then(() => {
        expect(e.rejected()).toEqual([]);
        expect(e.hasPending()).toBe(false);
      });
  });
});

describe('a refusal says WHY (TODO §2: a bad id was reported as "too long")', () => {
  const note = (id: string, updated = 1) =>
    ({ id, type: 'note', updated, deleted: false, payload: { title: id, body: 'b' } }) as never;

  it('carries the server reason for each refused id', async () => {
    const e = new SyncEngine();
    e.put(note('big'), 1);
    e.put(note('odd'), 1);
    await e.sync(async () => ({
      cursor: 1, changes: [], rejected: ['big', 'odd'],
      rejectedWhy: { big: 'too_large', odd: 'bad_type' },
    }));
    expect(e.refusals()).toEqual([{ id: 'big', why: 'too_large' }, { id: 'odd', why: 'bad_type' }]);
    expect(e.hasPending(), 'both are still owed').toBe(true);
  });

  it('a server too old to give reasons means size, the only refusal it knew', async () => {
    const e = new SyncEngine();
    e.put(note('big'), 1);
    await e.sync(async () => ({ cursor: 1, changes: [], rejected: ['big'] }));
    expect(e.refusals()).toEqual([{ id: 'big', why: 'too_large' }]);
  });

  it('an unknown reason word is not trusted as a reason', async () => {
    const e = new SyncEngine();
    e.put(note('big'), 1);
    await e.sync(async () => ({ cursor: 1, changes: [], rejected: ['big'], rejectedWhy: { big: 'cosmic_rays' } }));
    expect(e.refusals()).toEqual([{ id: 'big', why: 'too_large' }]);
  });

  it('a record that breaks the protocol is never SENT — it is refused here, named, and kept', async () => {
    const e = new SyncEngine();
    e.put(note('fine'), 1);
    e.put(note('has:colon'), 1); // the 2026-08-21 availability-id bug, in miniature
    e.put({ ...(note('BadType') as object), type: 'Note' } as never, 1);
    const seen: string[] = [];
    await e.sync(async (req) => {
      seen.push(...req.changes.map((c) => c.id));
      return { cursor: 1, changes: [], rejected: [] };
    });
    expect(seen, 'only the valid record left the device').toEqual(['fine']);
    expect(e.refusals()).toEqual([
      { id: 'has:colon', why: 'bad_id' },
      { id: 'BadType', why: 'bad_type' },
    ]);
    expect(e.toSnapshot().dirty.sort(), 'both stay owed; the good one is done').toEqual(['BadType', 'has:colon']);
  });

  it('a row whose id is not a string is refused before it can become an uncounted loss', async () => {
    const e = new SyncEngine();
    e.put({ id: 42 as unknown as string, type: 'note', updated: 1, deleted: false, payload: {} } as never, 1);
    let sent = -1;
    await e.sync(async (req) => { sent = req.changes.length; return { cursor: 1, changes: [], rejected: [] }; });
    expect(sent).toBe(0);
    expect(e.refusals().map((r) => r.why)).toEqual(['bad_id']);
    expect(e.hasPending()).toBe(true);
  });

  it('reports the server\'s count of rows it could not name', async () => {
    const e = new SyncEngine();
    await e.sync(async () => ({ cursor: 1, changes: [], rejected: [], dropped: 2 }));
    expect(e.dropped()).toBe(2);
    await e.sync(async () => ({ cursor: 1, changes: [], rejected: [] }));
    expect(e.dropped(), 'and clears it when the next reply has none').toBe(0);
  });

  it('a full batch of refused-locally records does not spin the drain loop', async () => {
    const e = new SyncEngine();
    for (let i = 0; i < 600; i++) e.put(note(`bad.${i}`), 1);
    let rounds = 0;
    await e.sync(async () => { rounds++; return { cursor: 1, changes: [], rejected: [] }; });
    expect(rounds).toBe(1);
    expect(e.refusals().length).toBe(600);
  });
});

describe('protocolFault', () => {
  it('passes what core mints and names the first broken rule', async () => {
    const { protocolFault } = await import('../src/sync');
    const ok = { id: 'abc_1-2', type: 'note', updated: 5, payload: {} } as never;
    expect(protocolFault(ok)).toBeNull();
    expect(protocolFault({ ...(ok as object), id: '' } as never)).toBe('bad_id');
    expect(protocolFault({ ...(ok as object), id: 'x'.repeat(65) } as never)).toBe('bad_id');
    expect(protocolFault({ ...(ok as object), type: 'x'.repeat(21) } as never)).toBe('bad_type');
    expect(protocolFault({ ...(ok as object), updated: 0 } as never)).toBe('bad_updated');
    expect(protocolFault({ ...(ok as object), updated: 1.5 } as never)).toBe('bad_updated');
    expect(protocolFault({ ...(ok as object), updated: '5' } as never)).toBe('bad_updated');
  });
});
