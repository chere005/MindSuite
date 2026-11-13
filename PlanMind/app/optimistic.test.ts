import { describe, it, expect, vi } from 'vitest';
import { ApiFailure, type Loaded } from './api';
import { createState, type StateIo } from './state';
import { predict, type Mutation, type Session, type Task } from '../packages/core/src/planner';

// The write line: one write on its way at a time, in order; ticks and moves show at once and come off again, alone, when refused.
const stamp = { revision: 1, updatedAt: '2026-10-30T00:00:00Z' };
const lists = [
  { id: 'sam', kind: 'person', name: 'Sam', color: 'yellow', order: 0, ...stamp }, { id: 'alex', kind: 'person', name: 'Alex', color: 'green', order: 1, ...stamp },
] as Session['lists'];
const todo = (id: string, over: Partial<Task> = {}): Task => ({ id, scope: 'day', date: '2040-01-04', owners: ['alex'], title: id, done: false, revision: 3, createdBy: 'alex', updatedBy: 'alex', createdAt: '', updatedAt: '', ...over }) as Task;
const session = (revision: number, tasks: Task[]): Session => ({
  v: 5, revision, lists, settings: { bothColor: 'purple', revision: 1, updatedAt: stamp.updatedAt }, tasks, priorities: [], events: [], notes: [],
  chores: [], choreMarks: [], rhythm: { anchor: '2026-11-02', start: '2026-11-02', revision: 1, updatedBy: 'alex', updatedAt: stamp.updatedAt },
  prefs: { selection: { base: 'alex', overlays: [] }, sidebar: 'shown' }, user: 'alex', csrf: 't', timezone: 'America/Chicago', theme: 'midnight',
}) as Session;
const tick = (id: string, revision: number, done: boolean): Mutation => ({ action: 'complete', id, revision, done });

/** A server in a variable: each write waits on a gate the test opens, and applies `complete` the way the real one does (stale when the revision differs). */
function rig(ids: string[]) {
  let db = session(10, ids.map(id => todo(id)));
  const gates: (() => void)[] = [], sent: Mutation[] = [];
  const io: StateIo = {
    load: vi.fn(async (): Promise<Loaded> => ({ unchanged: true, revision: db.revision })),
    send: vi.fn(async (m: Mutation) => {
      sent.push(m);
      await new Promise<void>(open => { gates.push(open); });
      if (m.action !== 'complete') { throw new Error('unexpected'); }
      const at = db.tasks.findIndex(t => t.id === m.id);
      if (at < 0 || db.tasks[at]!.revision !== m.revision) { throw new ApiFailure('Changed elsewhere.', 409, 'stale'); }
      if (db.tasks[at]!.done === m.done) { return db; }
      db = { ...db, revision: db.revision + 1, tasks: db.tasks.map((t, i) => (i === at ? { ...t, done: m.done, revision: t.revision + 1 } : t)) };
      return db;
    }),
    setTheme: vi.fn(async (theme: string) => ({ theme })), hidden: () => false,
  };
  const state = createState(db, io);
  const open = async () => { gates.shift()!(); await vi.advanceTimersByTimeAsync(0); };
  const refuse = (id: string, revision: number) => { db = { ...db, tasks: db.tasks.map(t => (t.id === id ? { ...t, revision } : t)) }; };
  const elsewhere = () => { db = { ...db, revision: db.revision + 1 }; };
  return { state, io, sent, open, refuse, elsewhere, db: () => db };
}
const done = (state: ReturnType<typeof createState>) => state.session.tasks.filter(t => t.done).map(t => t.id);

describe('the write line', () => {
  it('shows five ticks made within one round trip, sends them in order and ends with all five saved', async () => {
    vi.useFakeTimers();
    const r = rig(['a', 'b', 'c', 'd', 'e']);
    const results = ['a', 'b', 'c', 'd', 'e'].map(id => r.state.send(tick(id, 3, true), { optimistic: true }));
    expect(done(r.state)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(r.state.busy).toBe(false);
    expect(r.state.writing).toBe(true);
    for (let i = 0; i < 5; i++) { await r.open(); }
    expect((await Promise.all(results)).every(x => x.ok)).toBe(true);
    expect(r.sent.map(m => (m as { id: string }).id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(r.db().tasks.every(t => t.done)).toBe(true);
    expect(done(r.state)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(r.state.writing).toBe(false);
    r.state.close(); vi.useRealTimers();
  });

  it('keeps the tick on screen when a poll with older state arrives while the write is on its way', async () => {
    vi.useFakeTimers();
    const r = rig(['a']);
    void r.state.send(tick('a', 3, true), { optimistic: true });
    r.elsewhere();   // someone else's change lands first
    r.state.applyResponse(session(11, [todo('a')]));   // a poll that has theirs, without ours
    expect(done(r.state)).toEqual(['a']);
    await r.open();
    expect(done(r.state)).toEqual(['a']);
    r.state.close(); vi.useRealTimers();
  });

  it('folds a tick and its undo, made behind a write on its way, into one write', async () => {
    vi.useFakeTimers();
    const r = rig(['a', 'b']);
    void r.state.send(tick('a', 3, true), { optimistic: true });
    void r.state.send(tick('b', 3, true), { optimistic: true });
    const undo = r.state.send(tick('b', 4, false), { optimistic: true });
    expect(done(r.state)).toEqual(['a']);
    await r.open(); await r.open();
    expect((await undo).ok).toBe(true);
    expect(r.sent).toHaveLength(2);
    expect(r.sent[1]).toMatchObject({ id: 'b', revision: 3, done: false });
    expect(done(r.state)).toEqual(['a']);
    r.state.close(); vi.useRealTimers();
  });

  it('a tick then its undo while the tick is in flight: two writes, the end is unticked', async () => {
    vi.useFakeTimers();
    const r = rig(['a']);
    void r.state.send(tick('a', 3, true), { optimistic: true });
    const undo = r.state.send(tick('a', 4, false), { optimistic: true });
    expect(done(r.state)).toEqual([]);
    await r.open(); await r.open();
    expect((await undo).ok).toBe(true);
    expect(r.db().tasks[0]!.done).toBe(false);
    expect(done(r.state)).toEqual([]);
    r.state.close(); vi.useRealTimers();
  });

  it('a refused write takes off its own change and the writes built on it, and no other', async () => {
    vi.useFakeTimers();
    const r = rig(['a', 'b']);
    r.refuse('a', 7);   // someone changed a: our tick is stale
    const first = r.state.send(tick('a', 3, true), { optimistic: true });
    void r.state.send(tick('b', 3, true), { optimistic: true });
    const undo = r.state.send(tick('a', 4, false), { optimistic: true });
    await r.open();
    expect(await first).toMatchObject({ ok: false, code: 'stale' });
    expect(await undo).toMatchObject({ ok: false, skipped: true });
    expect(r.state.error).toBe('Changed elsewhere.');
    expect(done(r.state)).toEqual(['b']);
    await r.open();
    expect(done(r.state)).toEqual(['b']);
    expect(r.db().tasks.find(t => t.id === 'b')!.done).toBe(true);
    r.state.close(); vi.useRealTimers();
  });

  it('a write that is not shown by itself is refused while another of its kind waits, but queues behind ticks', async () => {
    vi.useFakeTimers();
    const r = rig(['a']);
    void r.state.send(tick('a', 3, true), { optimistic: true });
    const plain = r.state.send({ action: 'delete', id: 'zz', revision: 1, confirm: true });
    expect(r.state.busy).toBe(true);
    expect(await r.state.send({ action: 'delete', id: 'yy', revision: 1, confirm: true })).toMatchObject({ skipped: true });
    void plain;
    r.state.close(); vi.useRealTimers();
  });
});

describe('predict', () => {
  it('is idempotent and leaves a record that is already past the write alone', () => {
    const data = session(10, [todo('a')]);
    const once = predict(data, { action: 'complete', id: 'a', revision: 3, done: true, doneOn: '2040-01-05' }, 'alex');
    expect(once.tasks[0]).toMatchObject({ done: true, revision: 4, doneOn: '2040-01-05' });
    expect(predict(once, { action: 'complete', id: 'a', revision: 3, done: true, doneOn: '2040-01-05' }, 'alex').tasks[0]).toMatchObject({ done: true, revision: 4 });
    const past = session(10, [todo('a', { revision: 9 })]);
    expect(predict(past, tick('a', 3, true), 'alex')).toBe(past);
  });
  it('marks and unmarks a chore turn the way the server stores it', () => {
    const data = session(10, []);
    const marked = predict(data, { action: 'markChore', ruleId: 'r', date: '2040-01-04', state: 'done', moved: false, revision: 0 }, 'alex');
    expect(marked.choreMarks).toMatchObject([{ id: 'r:2040-01-04', state: 'done', revision: 1 }]);
    expect(predict(marked, { action: 'markChore', ruleId: 'r', date: '2040-01-04', state: 'open', moved: false, revision: 1 }, 'alex').choreMarks).toEqual([]);
  });
});
