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
  const gates: (() => void)[] = [], sent: Mutation[] = [], loads: (() => void)[] = [];
  const io: StateIo = {
    load: vi.fn(async (): Promise<Loaded> => { const held = db; await new Promise<void>(open => { loads.push(open); }); return held; }),
    send: vi.fn(async (m: Mutation) => {
      sent.push(m);
      await new Promise<void>(open => { gates.push(open); });
      if (m.action === 'edit' && m.kind === 'todo') {
        const i = db.tasks.findIndex(t => t.id === m.id);
        if (db.tasks[i]!.revision !== m.revision) { throw new ApiFailure('Changed elsewhere.', 409, 'stale'); }
        db = { ...db, revision: db.revision + 1, tasks: db.tasks.map((t, j) => (j === i ? { ...t, title: m.title, revision: t.revision + 1 } : t)) };
        return db;
      }
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
  return { state, io, sent, open, refuse, elsewhere, db: () => db, loads };
}
const done = (state: ReturnType<typeof createState>) => state.session.tasks.filter(t => t.done).map(t => t.id);


describe('review: polls and the write line', () => {
  it('a poll that left before the writes and answers between them does not roll the screen back', async () => {
    vi.useFakeTimers();
    const r = rig(['a', 'b']);
    void r.state.refresh();                       // a poll leaves holding the old store (nothing ticked)
    void r.state.send(tick('a', 3, true), { optimistic: true });
    void r.state.send(tick('b', 3, true), { optimistic: true });
    await r.open();                               // a answered, b on its way
    r.loads.shift()!(); await vi.advanceTimersByTimeAsync(0);   // the old poll answers now
    expect(done(r.state)).toEqual(['a', 'b']);
    void r.state.refresh();                       // a poll between the two writes
    expect(r.io.load).toHaveBeenCalledTimes(1);   // not sent while writes wait
    await r.open();
    expect(done(r.state)).toEqual(['a', 'b']);
    expect(r.db().tasks.every(t => t.done)).toBe(true);
    r.state.close(); vi.useRealTimers();
  });

  it('a rename (not optimistic) on its way, then a tick of the same to-do built from the screen', async () => {
    vi.useFakeTimers();
    const r = rig(['a']);
    const shown = r.state.session.tasks[0]!;
    const rename = r.state.send({ action: 'edit', kind: 'todo', id: 'a', revision: shown.revision, date: shown.date, owners: shown.owners, title: 'a2' } as Mutation);
    const t = r.state.session.tasks[0]!;          // what the circle's handler reads
    const ticked = r.state.send(tick('a', t.revision, true), { optimistic: true });
    await r.open(); await r.open();
    // Known limit: the tick was built on the revision the screen held, before the rename's answer, so it is refused as stale.
    expect(await rename).toMatchObject({ ok: true });
    expect(await ticked).toMatchObject({ ok: false, code: 'stale' });
    r.state.close(); vi.useRealTimers();
  });
});
