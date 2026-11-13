import { describe, expect, test } from 'vitest';
import { SharedWrites } from '../src/sharedwrites';

// A partner's shared lists with a fake API that decides, per request, WHEN it
// answers and WHETHER it fails: every reply is held until the test releases it,
// in whatever order the test likes.

type R = { id: string; deleted?: boolean; updated?: number; payload: { done?: boolean; title?: string } };
type Held = { arg: unknown; ok: () => void; fail: () => void };

function setup(serverRows: R[] = []) {
  const server = new Map(serverRows.map((r) => [r.id, r]));
  const putCalls: Array<Held & { rec: R }> = [];
  const pullCalls: Array<Held & { snapshot: R[] }> = [];
  const views: R[][] = [];
  const troubles: number[] = [];
  const w = new SharedWrites<R, string>(
    {
      put: (_partner, rec) => new Promise<void>((ok, fail) => {
        putCalls.push({ arg: rec, rec, ok: () => { if (rec.deleted) server.delete(rec.id); else server.set(rec.id, rec); ok(); }, fail: () => fail(new Error('refused')) });
      }),
      pull: () => new Promise((ok, fail) => {
        // The server's state AT THE MOMENT THE PULL IS SENT is what it will answer with.
        const snapshot = Array.from(server.values());
        pullCalls.push({ arg: null, snapshot, ok: () => ok({ partners: ['p'], partner: 'p', records: snapshot }), fail: () => fail(new Error('down')) });
      }),
    },
    { onView: (v) => views.push(v), onPulled: () => {}, onTrouble: () => troubles.push(views.length) },
  );
  return { w, putCalls, pullCalls, views, troubles, server };
}

const row = (id: string, done = false, title = id): R => ({ id, updated: 1, payload: { done, title } });
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const done = (w: SharedWrites<R, string>, id: string) => w.view().find((r) => r.id === id)?.payload.done;

describe('(a) a write is drawn in the same task', () => {
  test('a changed record shows before any request has been answered', async () => {
    const t = setup([row('a')]);
    const p = t.w.pull(); t.pullCalls[0].ok(); await p;
    void t.w.put('p', { ...row('a'), payload: { done: true, title: 'a' } });
    expect(done(t.w, 'a')).toBe(true);
    expect(t.views.at(-1)!.find((r) => r.id === 'a')!.payload.done).toBe(true);
  });

  test('a new record appears and a deleted one leaves, at once', async () => {
    const t = setup([row('a')]);
    const p = t.w.pull(); t.pullCalls[0].ok(); await p;
    void t.w.put('p', row('new'));
    expect(t.w.view().map((r) => r.id).sort()).toEqual(['a', 'new']);
    void t.w.put('p', { ...row('a'), deleted: true });
    expect(t.w.view().map((r) => r.id)).toEqual(['new']);
  });
});

describe('(b) writes go out in order, each from the latest picture', () => {
  test('the second write waits for the first and carries a later stamp', async () => {
    const t = setup([row('a')]);
    const p = t.w.pull(); t.pullCalls[0].ok(); await p;
    void t.w.put('p', { ...row('a'), payload: { done: true } });
    void t.w.put('p', { ...row('a'), payload: { done: false } });
    expect(t.putCalls).toHaveLength(1);
    // The second tap already acts on, and shows, what the first made.
    expect(done(t.w, 'a')).toBe(false);
    t.putCalls[0].ok(); await settle();
    expect(t.putCalls).toHaveLength(2);
    expect(t.putCalls[1].rec.updated!).toBeGreaterThan(t.putCalls[0].rec.updated!);
    expect(t.putCalls[0].rec.payload.done).toBe(true);
    expect(t.putCalls[1].rec.payload.done).toBe(false);
  });

  test('two writes in one millisecond still go out with increasing stamps', async () => {
    const sent: number[] = [];
    const w = new SharedWrites<R, string>(
      { put: async (_p, rec) => { sent.push(rec.updated!); }, pull: () => new Promise(() => {}) },
      { onView: () => {}, onPulled: () => {}, onTrouble: () => {} }, () => 1000);
    void w.put('p', row('a'));
    void w.put('p', row('b'));
    await settle();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBeGreaterThan(sent[0]);
  });
});

describe('(c) a pull never overturns a newer write', () => {
  test('a pull sent before a write and answered after it leaves the write in place', async () => {
    const t = setup([row('a')]);
    const first = t.w.pull(); t.pullCalls[0].ok(); await first;
    const stale = t.w.pull(); // a background pull, sent before the write
    void t.w.put('p', { ...row('a'), payload: { done: true } });
    t.putCalls[0].ok(); await settle();           // acknowledged...
    t.pullCalls[1].ok(); await stale;             // ...and only then does the old pull land
    expect(done(t.w, 'a')).toBe(true);
    // the re-read sent after the acknowledgement settles it
    t.pullCalls[2].ok(); await settle();
    expect(done(t.w, 'a')).toBe(true);
    expect(t.w.unsettled()).toBe(0);
  });

  test('while the write is in flight a pull cannot bring the old copy back', async () => {
    const t = setup([row('a')]);
    const first = t.w.pull(); t.pullCalls[0].ok(); await first;
    void t.w.put('p', { ...row('a'), payload: { done: true } });
    const pulled = t.w.pull(); t.pullCalls[1].ok(); await pulled; // old server copy
    expect(done(t.w, 'a')).toBe(true);
  });

  test('replies arriving out of order: the older pull is dropped', async () => {
    const t = setup([row('a', false)]);
    const older = t.w.pull();
    t.server.set('a', row('a', true));
    const newer = t.w.pull();
    t.pullCalls[1].ok(); await newer;
    t.pullCalls[0].ok(); await older;
    expect(done(t.w, 'a')).toBe(true);
  });

  test('once a pull sent after the acknowledgement lands, the server copy is what is drawn', async () => {
    const t = setup([row('a')]);
    const first = t.w.pull(); t.pullCalls[0].ok(); await first;
    void t.w.put('p', { ...row('a'), payload: { done: true } });
    t.putCalls[0].ok(); await settle();
    // the partner changes it again before the re-read
    t.pullCalls[1].snapshot[0] = { ...row('a'), updated: 9e15, payload: { done: false, title: 'theirs' } };
    t.pullCalls[1].ok(); await settle();
    expect(t.w.view()[0].payload.title).toBe('theirs');
  });
});

describe('(d) a refused write takes back exactly its own change', () => {
  test('the row returns to what the server holds, and the person is told once', async () => {
    const t = setup([row('a')]);
    const p = t.w.pull(); t.pullCalls[0].ok(); await p;
    void t.w.put('p', { ...row('a'), payload: { done: true } });
    expect(done(t.w, 'a')).toBe(true);
    t.putCalls[0].fail(); await settle();
    expect(done(t.w, 'a')).toBe(false);
    expect(t.troubles).toHaveLength(1);
  });

  test('a failed new record vanishes; a failed delete comes back', async () => {
    const t = setup([row('a')]);
    const p = t.w.pull(); t.pullCalls[0].ok(); await p;
    void t.w.put('p', row('new'));
    void t.w.put('p', { ...row('a'), deleted: true });
    expect(t.w.view().map((r) => r.id)).toEqual(['new']);
    t.putCalls[0].fail(); await settle();
    t.putCalls[1].fail(); await settle();
    expect(t.w.view().map((r) => r.id)).toEqual(['a']);
    expect(t.troubles).toHaveLength(2);
  });

  test('later queued writes on the SAME record are taken back and never sent; other records are untouched', async () => {
    const t = setup([row('a'), row('b')]);
    const p = t.w.pull(); t.pullCalls[0].ok(); await p;
    void t.w.put('p', { ...row('a'), payload: { done: true } });
    void t.w.put('p', { ...row('b'), payload: { done: true } });
    void t.w.put('p', { ...row('a'), payload: { done: false, title: 'edited' } });
    t.putCalls[0].fail(); await settle();
    expect(done(t.w, 'a')).toBe(false);
    expect(t.w.view().find((r) => r.id === 'a')!.payload.title).toBe('a'); // the edit went with it
    expect(done(t.w, 'b')).toBe(true);
    // only b is sent next; a's second write never is
    expect(t.putCalls).toHaveLength(2);
    expect(t.putCalls[1].rec.id).toBe('b');
    t.putCalls[1].ok(); await settle();
    expect(t.putCalls).toHaveLength(2);
    expect(done(t.w, 'b')).toBe(true);
  });

  test('an earlier acknowledged write on the same record survives a later failure', async () => {
    const t = setup([row('a')]);
    const p = t.w.pull(); t.pullCalls[0].ok(); await p;
    void t.w.put('p', { ...row('a'), payload: { done: true } });
    t.putCalls[0].ok(); await settle();
    void t.w.put('p', { ...row('a'), payload: { done: false } });
    t.putCalls[1].fail(); await settle();
    expect(done(t.w, 'a')).toBe(true);
  });
});

describe('(e) the grace: undo after the pull has landed', () => {
  test('tick, pull lands, tick again: the row is never missing and ends undone', async () => {
    const t = setup([row('a')]);
    const p = t.w.pull(); t.pullCalls[0].ok(); await p;
    const before = t.w.view()[0];
    void t.w.put('p', { ...before, payload: { ...before.payload, done: true } });
    t.putCalls[0].ok(); await settle();
    t.pullCalls[1].ok(); await settle(); // the re-read has landed: server says done
    expect(done(t.w, 'a')).toBe(true);
    // the undo tap, inside the grace: drawn undone in the same task
    void t.w.put('p', { ...before });
    expect(t.w.view().map((r) => r.id)).toEqual(['a']);
    expect(done(t.w, 'a')).toBe(false);
    t.putCalls[1].ok(); await settle();
    t.pullCalls[2].ok(); await settle();
    expect(done(t.w, 'a')).toBe(false);
  });
});

describe('reset', () => {
  test('a reply to a request from before a sign-out is ignored', async () => {
    const t = setup([row('a')]);
    const p = t.w.pull();
    t.w.reset();
    t.pullCalls[0].ok(); await p;
    expect(t.w.view()).toEqual([]);
  });
});
