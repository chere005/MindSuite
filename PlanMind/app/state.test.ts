import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiFailure, type Loaded } from './api';
import { makeContext } from './panelContext';
import { createReleaseWatch } from './release';
import { createState, type StateIo } from './state';
import { choreMark, choreTurns, dayChores, type ChoreMark, type ChoreRule, type ListRecord, type Mutation, type Session, type Snapshot } from '../packages/core/src/planner';

// Runs in `npm run test:core` (vitest.config.ts includes app/**/*.test.ts) on a fake clock, with no DOM.
const stamp = { revision: 1, updatedAt: '2026-10-30T00:00:00Z' };
const A = 'aaaaaaaa-0000-4000-8000-000000000000', B = 'bbbbbbbb-0000-4000-8000-000000000000';
const lists: ListRecord[] = [
  { id: 'sam', kind: 'person', name: 'Sam', color: 'yellow', order: 0, ...stamp }, { id: 'alex', kind: 'person', name: 'Alex', color: 'green', order: 1, ...stamp },
  { id: A, kind: 'custom', name: 'A', color: 'blue', order: 2, ...stamp }, { id: B, kind: 'custom', name: 'B', color: 'red', order: 3, ...stamp },
];
const task = (n: number) => ({ id: `t${n}` }) as unknown as Snapshot['tasks'][number];
const session = (revision: number, over: Partial<Session> = {}): Session => ({
  v: 5, revision, lists, settings: { bothColor: 'purple', revision: 1, updatedAt: stamp.updatedAt }, tasks: [], priorities: [], events: [], notes: [],
  chores: [], choreMarks: [], rhythm: { anchor: '2026-11-02', start: '2026-11-02', revision: 1, updatedBy: 'alex', updatedAt: stamp.updatedAt },
  prefs: { selection: { base: A, overlays: [] }, sidebar: 'shown' }, user: 'alex', csrf: 'token', timezone: 'America/Chicago', theme: 'midnight', ...over,
});
const complete: Mutation = { action: 'complete', id: 'x', revision: 1, done: true };
const unchanged = async (): Promise<Loaded> => ({ unchanged: true, revision: 5 });

let sent: Mutation[], io: StateIo & { load: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; setTheme: ReturnType<typeof vi.fn> }, state: ReturnType<typeof createState>;
beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  io = { load: vi.fn(unchanged), send: vi.fn(async (m: Mutation) => { sent.push(m); return session(6); }), setTheme: vi.fn(async (theme: string) => ({ theme })), hidden: () => false };
  state = createState(session(5), io);
});
afterEach(() => vi.useRealTimers());

describe('selection', () => {
  it('is read from prefs at load and resolved against the lists', () => {
    expect(state.selection).toEqual({ base: A, overlays: [] });
    expect(createState(session(5, { prefs: { selection: { base: 'gone', overlays: [A] }, sidebar: 'shown' } }), io).selection).toEqual({ base: 'both', overlays: [A] });
  });
  it('is saved once, 400 ms after the last change, with the last value', () => {
    state.setSelection({ base: 'both', overlays: [A] });
    vi.advanceTimersByTime(300);
    state.setSelection({ base: 'both', overlays: [A, B] });
    vi.advanceTimersByTime(399);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([{ action: 'savePrefs', selection: { base: 'both', overlays: [A, B] } }]);
    expect(state.selection).toEqual({ base: 'both', overlays: [A, B] });
  });
  it('an unchanged selection is not saved', () => {
    state.setSelection({ base: A, overlays: [] });
    state.setSelection({ base: A, overlays: [A] });
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(0);
  });
  it('a failing save is silent and the selection still applies', async () => {
    io.send.mockRejectedValue(new ApiFailure('Down', 0, null, undefined, true));
    state.setSelection({ base: 'alex', overlays: [] });
    vi.advanceTimersByTime(400);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.selection.base).toBe('alex');
    expect(state.error).toBe('');
  });
  it('closing cancels a pending save', () => {
    state.setSelection({ base: 'alex', overlays: [] });
    state.close();
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(0);
  });
});

describe('sidebar', () => {
  it('is shown unless the server said hidden, and any other word reads as shown', () => {
    expect(state.sidebar).toBe('shown');
    expect(createState(session(5, { prefs: { selection: { base: A, overlays: [] }, sidebar: 'hidden' } }), io).sidebar).toBe('hidden');
    for (const odd of ['Hidden', 'collapsed', '', undefined, null, 1, true]) {
      expect(createState(session(5, { prefs: { selection: { base: A, overlays: [] }, sidebar: odd as never } }), io).sidebar).toBe('shown');
    }
    expect(createState(session(5, { prefs: { selection: { base: A, overlays: [] } } as never }), io).sidebar).toBe('shown');
  });
  it('changes at once, tells the shell, and is saved 400 ms later with the selection', () => {
    const seen: string[] = [];
    state.subscribe(change => seen.push(change));
    state.setSidebar('hidden');
    expect(state.sidebar).toBe('hidden');
    expect(seen).toEqual(['sidebar']);
    vi.advanceTimersByTime(399);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([{ action: 'savePrefs', selection: { base: A, overlays: [] }, sidebar: 'hidden' }]);
  });
  it('shares the one pause with the picker: one write carries both', () => {
    state.setSelection({ base: 'alex', overlays: [] });
    vi.advanceTimersByTime(200);
    state.setSidebar('hidden');
    vi.advanceTimersByTime(399);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([{ action: 'savePrefs', selection: { base: 'alex', overlays: [] }, sidebar: 'hidden' }]);
  });
  it('only the save that follows a sidebar change carries it: a picker change on a stale device never undoes another device\'s choice', () => {
    // This device loaded 'hidden' and has not touched the sidebar since; another device may have shown it meanwhile.
    const stale = createState(session(5, { prefs: { selection: { base: A, overlays: [] }, sidebar: 'hidden' } }), io);
    stale.setSelection({ base: 'alex', overlays: [] });
    vi.advanceTimersByTime(400);
    expect(sent).toEqual([{ action: 'savePrefs', selection: { base: 'alex', overlays: [] } }]);
    stale.setSidebar('shown');
    vi.advanceTimersByTime(400);
    stale.setSelection({ base: A, overlays: [] });
    vi.advanceTimersByTime(400);
    expect(sent.map(m => m.action === 'savePrefs' && 'sidebar' in m)).toEqual([false, true, false]);
  });
  it('the same value changes and saves nothing; toggling back before the pause still saves the last value', () => {
    state.setSidebar('shown');
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(0);
    state.setSidebar('hidden');
    state.setSidebar('shown');
    vi.advanceTimersByTime(400);
    expect(sent).toEqual([{ action: 'savePrefs', selection: { base: A, overlays: [] }, sidebar: 'shown' }]);
  });
  it('a sidebar change whose save failed is sent again with the next save', async () => {
    io.send.mockImplementationOnce(async (m: Mutation) => { sent.push(m); throw new ApiFailure('Down', 0, null, undefined, true); });
    state.setSidebar('hidden');
    vi.advanceTimersByTime(400);
    await vi.advanceTimersByTimeAsync(0);
    state.setSelection({ base: 'alex', overlays: [] });
    vi.advanceTimersByTime(400);
    expect(sent.map(m => m.action === 'savePrefs' && m.sidebar)).toEqual(['hidden', 'hidden']);
  });
  it('is saved at once when the page is hidden, and closing cancels a pending save', () => {
    state.setSidebar('hidden');
    state.close();
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(0);
  });
  it('a failing save is silent and the sidebar stays as chosen; a later poll never moves it', async () => {
    io.send.mockRejectedValue(new ApiFailure('Down', 0, null, undefined, true));
    state.setSidebar('hidden');
    vi.advanceTimersByTime(400);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.sidebar).toBe('hidden');
    expect(state.error).toBe('');
    state.applyResponse(session(9, { prefs: { selection: { base: A, overlays: [] }, sidebar: 'shown' } }));
    expect(state.sidebar).toBe('hidden');
  });
});

describe('theme', () => {
  it('starts as the account\'s stored theme', () => {
    expect(state.theme).toBe('midnight');
    expect(createState(session(5, { theme: 'olive' }), io).theme).toBe('olive');
  });
  it('shows a pick at once and keeps it once the server says it stored it', async () => {
    const seen: string[] = [];
    state.subscribe(change => seen.push(`${change}:${state.theme}`));
    const saving = state.saveTheme('sage');
    expect(state.theme).toBe('sage');
    expect(seen).toEqual(['theme:sage']);
    expect(await saving).toEqual({ ok: true });
    expect(io.setTheme).toHaveBeenCalledWith('sage');
    expect(state.theme).toBe('sage');
  });
  it('goes back to the last stored theme when the save is refused, and says why', async () => {
    await state.saveTheme('forest');
    io.setTheme.mockRejectedValueOnce(new ApiFailure('Your theme could not be saved.', 503, 'unavailable'));
    const seen: string[] = [];
    state.subscribe(change => seen.push(`${change}:${state.theme}`));
    expect(await state.saveTheme('sage')).toEqual({ ok: false, message: 'Your theme could not be saved.' });
    expect(state.theme).toBe('forest');
    // Then the end of the write itself (a shell waiting to load a new release asks again).
    expect(seen).toEqual(['theme:sage', 'theme:forest', 'status:forest']);
  });
  it('a lost answer is not a confirmation: back to the stored theme, with its own words', async () => {
    io.setTheme.mockRejectedValueOnce(new ApiFailure('The request was interrupted.', 0, null, undefined, true));
    const result = await state.saveTheme('olive');
    expect(result).toEqual({ ok: false, message: 'Could not confirm the change, so your theme stays as it was.' });
    expect(state.theme).toBe('midnight');
  });
  it('an answer that does not name the theme asked for is not believed', async () => {
    io.setTheme.mockResolvedValueOnce({ theme: 'midnight' });
    expect((await state.saveTheme('sage')).ok).toBe(false);
    expect(state.theme).toBe('midnight');
    io.setTheme.mockResolvedValueOnce(undefined);
    expect((await state.saveTheme('sage')).ok).toBe(false);
    expect(state.theme).toBe('midnight');
  });
  it('of two picks in flight the newest decides, whichever answer comes last', async () => {
    let first!: (v: { theme: string }) => void, second!: (e: Error) => void;
    io.setTheme.mockImplementationOnce(() => new Promise(resolve => { first = resolve; }));
    io.setTheme.mockImplementationOnce(() => new Promise((_, reject) => { second = reject; }));
    const a = state.saveTheme('sage'), b = state.saveTheme('forest');
    expect(state.theme).toBe('forest');
    first({ theme: 'sage' });
    await a;
    expect(state.theme).toBe('forest');
    second(new ApiFailure('Your theme could not be saved.', 503, 'unavailable'));
    expect((await b).ok).toBe(false);
    // The older pick was confirmed, so that is where the page goes back to.
    expect(state.theme).toBe('sage');
  });
  it('is no planner write: it never blocks, and never touches the busy flag or the revision', async () => {
    const seen: string[] = [];
    state.subscribe(change => seen.push(change));
    await state.saveTheme('sage');
    expect(seen).not.toContain('busy');
    expect(state.busy).toBe(false);
    expect(state.session.revision).toBe(5);
    expect(sent).toEqual([]);
  });
});

describe('applyResponse', () => {
  it('ignores older, equal and unchanged answers, takes a newer one, and never takes prefs from it', () => {
    const seen: string[] = [];
    state.subscribe(change => seen.push(change));
    expect(state.applyResponse(session(4, { tasks: [task(1)] }))).toBe(false);
    expect(state.applyResponse(session(5, { tasks: [task(1)] }))).toBe(false);
    expect(state.applyResponse({ unchanged: true, revision: 9 })).toBe(false);
    expect(state.session.tasks).toEqual([]);
    expect(seen).toEqual([]);
    expect(state.applyResponse(session(6, { tasks: [task(2)], prefs: { selection: { base: 'alex', overlays: [] }, sidebar: 'shown' } }))).toBe(true);
    expect(state.session.tasks).toEqual([task(2)]);
    expect(state.selection.base).toBe(A);
    expect(state.session.prefs.selection.base).toBe(A);
    expect(seen).toEqual(['data']);
  });
  it('heals a selection whose list is gone', () => {
    state.applyResponse(session(6, { lists: lists.filter(l => l.id !== A) }));
    expect(state.selection.base).toBe('both');
  });
});

describe('chores', () => {
  const dishes: ChoreRule = { id: 'c0de0000-0000-4000-8000-000000000001', title: 'Dishes', owners: ['alex'], cadence: { kind: 'daily' }, order: 1, revision: 1, updatedBy: 'alex', updatedAt: stamp.updatedAt };
  const DAY = '2026-11-03';
  const samDone: ChoreMark = { id: `${dishes.id}:${DAY}`, ruleId: dishes.id, date: DAY, state: 'done', moved: false, revision: 1, updatedBy: 'sam', updatedAt: stamp.updatedAt };
  const withRule = (revision: number, over: Partial<Session> = {}) => session(revision, { chores: [dishes], ...over });
  const dayOf = (s: ReturnType<typeof createState>) => dayChores({ data: s.session, today: DAY }, DAY);

  it('arrive in the first snapshot with the rules and the rhythm', () => {
    const s = createState(withRule(5), io);
    expect(s.session.chores).toEqual([dishes]);
    expect(s.session.rhythm).toMatchObject({ anchor: '2026-11-02', start: '2026-11-02' });
    expect(dayOf(s).sections.map(section => section.kind)).toEqual(['open']);
  });
  it('take the other person\'s marks in from a poll, so the Day shows their check', async () => {
    const s = createState(withRule(5), io);
    io.load.mockResolvedValueOnce(withRule(6, { choreMarks: [samDone] }));
    await s.refresh();
    expect(s.session.choreMarks).toEqual([samDone]);
    expect(dayOf(s).sections.map(section => section.kind)).toEqual(['done']);
    // The same revision is nothing new: a poll that says "unchanged" keeps what is held.
    await s.refresh();
    expect(s.session.choreMarks).toEqual([samDone]);
  });
  it('send a tap as one markChore and keep the reply\'s marks', async () => {
    const s = createState(withRule(5), io);
    const turn = choreTurns(s.session, DAY, DAY)[0];
    const write = choreMark(turn, 'check');
    io.send.mockResolvedValueOnce(withRule(6, { choreMarks: [{ ...samDone, updatedBy: 'alex' }] }));
    expect(await s.send(write)).toEqual({ ok: true });
    expect(io.send).toHaveBeenCalledExactlyOnceWith({ action: 'markChore', ruleId: dishes.id, date: DAY, state: 'done', moved: false, revision: 0 });
    expect(s.session.choreMarks.map(m => [m.state, m.updatedBy])).toEqual([['done', 'alex']]);
  });
  it('a refused mark (stale) reports it, reloads, and then shows what is true', async () => {
    const s = createState(withRule(5), io);
    io.send.mockRejectedValueOnce(new ApiFailure('This chore changed on another device. Refresh to see the latest.', 409, 'stale'));
    io.load.mockResolvedValueOnce(withRule(6, { choreMarks: [samDone] }));
    const result = await s.send(choreMark(choreTurns(s.session, DAY, DAY)[0], 'letgo'));
    expect(result).toMatchObject({ ok: false, code: 'stale' });
    await vi.waitFor(() => expect(s.session.choreMarks).toEqual([samDone]));
    expect(dayOf(s).sections.map(section => section.kind)).toEqual(['done']);
  });
  it('an older snapshot never takes marks away', () => {
    const s = createState(withRule(7, { choreMarks: [samDone] }), io);
    expect(s.applyResponse(withRule(6))).toBe(false);
    expect(s.session.choreMarks).toEqual([samDone]);
  });

  it('are on or off in memory: turning them on keeps the period and the stored selection, and says so once', () => {
    const s = createState(withRule(5), io);
    const seen: string[] = [];
    s.subscribe(change => { if (change === 'chores' || change === 'selection' || change === 'nav') { seen.push(change); } });
    expect(s.chores).toBe(false);
    s.setView('week');
    seen.length = 0;
    s.setChores(true);
    s.setChores(true);
    expect([s.chores, s.view, s.selection]).toEqual([true, 'week', { base: A, overlays: [] }]);
    expect(seen).toEqual(['chores']);
    // Moving through periods and views stays on Chores; only turning it off leaves.
    s.go('2026-12-01');
    s.setView('month');
    expect(s.chores).toBe(true);
    s.setChores(false);
    expect(s.chores).toBe(false);
    expect(seen.at(-1)).toBe('chores');
    expect(io.send).not.toHaveBeenCalled();
  });

  it('the phone shows its Chores page on the Day however Chores was turned on, on the Week and the Month only from its own Chores tab (the Day\'s switch is the Day\'s alone)', () => {
    const width = (phone: boolean) => vi.stubGlobal('window', { matchMedia: () => ({ matches: phone, addEventListener: () => {} }) });
    try {
      const s = createState(withRule(5), io);
      const ctx = makeContext(s, () => {});
      // The desktop's switch on the Day, then the Week and the Month, then a window narrowed to a phone: the Day is Chores, the Week and the Month stay planner pages.
      width(false);
      ctx.setChores(true);
      expect([s.chores, s.choresTab, ctx.choresPage]).toEqual([true, false, false]);
      width(true);
      expect(ctx.choresPage, 'the Day').toBe(true);
      s.setView('week');
      expect([s.chores, ctx.choresPage], 'the Week').toEqual([true, false]);
      s.setView('month');
      expect(ctx.choresPage, 'the Month').toBe(false);
      s.setView('day');
      expect(ctx.choresPage).toBe(true);
      // The phone's own tab: a Chores page on every view, and still one after a round trip through a desktop width.
      ctx.setChores(false);
      s.setView('month');
      ctx.setChores(true);
      expect([s.choresTab, ctx.choresPage]).toEqual([true, true]);
      width(false);
      expect(ctx.choresPage, 'a desktop never draws it').toBe(false);
      width(true);
      expect(ctx.choresPage).toBe(true);
      s.setView('week');
      expect(ctx.choresPage).toBe(true);
      // Off is off, and the desktop's switch after it is not the tab.
      ctx.setChores(false);
      width(false);
      ctx.setChores(true);
      expect([s.choresTab, ctx.choresPage]).toEqual([false, false]);
      width(true);
      expect(ctx.choresPage, 'the Week').toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });

  it('ignore the picker: Alex alone, Sam alone and a custom list all list every chore, and so does the other person signed in', () => {
    const samCat: ChoreRule = { ...dishes, id: 'c0de0000-0000-4000-8000-000000000002', title: 'Cat bowls', owners: ['sam'], order: 2 };
    const both: ChoreRule = { ...dishes, id: 'c0de0000-0000-4000-8000-000000000003', title: 'Mail & papers', owners: ['sam', 'alex'], order: 3 };
    // The Day lists chores from today on: the clock is on DAY, not the real date.
    vi.setSystemTime(new Date(`${DAY}T18:00:00Z`));
    const s = createState(withRule(5, { chores: [dishes, samCat, both] }), io);
    const ctx = makeContext(s, () => {});
    const listed = () => dayChores(ctx.choreInput, DAY).sections.flatMap(section => section.rows.map(row => row.title));
    for (const selection of [{ base: 'alex', overlays: [] }, { base: 'sam', overlays: [] }, { base: A, overlays: [] }, { base: 'both', overlays: [B] }]) {
      s.setSelection(selection);
      expect(s.selection.base, 'the selection really changed').toBe(selection.base);
      expect(listed(), `with ${selection.base} picked`).toEqual(['Dishes', 'Cat bowls', 'Mail & papers']);
    }
    const sam = makeContext(createState(withRule(5, { chores: [dishes, samCat, both], user: 'sam', prefs: { selection: { base: 'sam', overlays: [] }, sidebar: 'shown' } }), io), () => {});
    expect(dayChores(sam.choreInput, DAY).sections.flatMap(section => section.rows.map(row => row.title))).toEqual(['Dishes', 'Cat bowls', 'Mail & papers']);
  });
});

describe('writes and polls', () => {
  it('allows one write at a time, reports a failure, and reloads after a stale one', async () => {
    let fail!: () => void;
    io.send.mockImplementation(() => new Promise((_resolve, reject) => { fail = () => reject(new ApiFailure('Refresh to see the latest.', 409, 'stale')); }));
    const first = state.send(complete);
    expect(state.busy).toBe(true);
    expect(await state.send(complete)).toMatchObject({ ok: false, skipped: true });
    fail();
    expect(await first).toMatchObject({ ok: false, code: 'stale', uncertain: false, message: 'Refresh to see the latest.' });
    expect(state.busy).toBe(false);
    expect(state.error).toBe('Refresh to see the latest.');
    await vi.waitFor(() => expect(io.load).toHaveBeenCalledWith(5));
  });
  it('says an interrupted write may have saved', async () => {
    io.send.mockRejectedValue(new ApiFailure('Down', 0, null, undefined, true));
    const result = await state.send(complete);
    expect(result).toMatchObject({ ok: false, uncertain: true });
    expect(state.error).toContain('may have saved');
  });
  it('a poll is skipped while hidden; a failed one leaves the data alone and a good one clears the warning', async () => {
    io.hidden = () => true;
    await state.refresh();
    expect(io.load).not.toHaveBeenCalled();
    io.hidden = () => false;
    io.load.mockRejectedValueOnce(new ApiFailure('Down', 503, 'unavailable'));
    await state.refresh();
    expect([state.session.revision, state.status, state.error]).toEqual([5, 'Connection interrupted', 'Down']);
    await state.refresh();
    expect([state.status, state.error]).toEqual(['Up to date', '']);
  });
  it('a poll answer that arrives while a write is in flight is dropped', async () => {
    let answer!: (loaded: Loaded) => void, finish!: () => void;
    io.load.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    io.send.mockImplementation(() => new Promise(resolve => { finish = () => resolve(session(7, { tasks: [task(7)] })); }));
    const poll = state.refresh();
    const write = state.send(complete);
    answer(session(6, { tasks: [task(6)] }));
    await poll;
    expect(state.session.tasks).toEqual([]);
    finish();
    await write;
    expect(state.session.tasks).toEqual([task(7)]);
  });
  it('closing stops writes and tells the shell', async () => {
    const seen: string[] = [];
    state.subscribe(change => seen.push(change));
    state.close();
    expect(seen).toEqual(['closed']);
    expect(await state.send(complete)).toMatchObject({ ok: false, skipped: true });
    expect(io.send).not.toHaveBeenCalled();
  });
});

describe('the day rolling over', () => {
  // Sunday 29 November 2026, 23:59:50 in Chicago (CST); twenty seconds later it is Monday the 30th.
  const BEFORE = '2026-11-30T05:59:50Z', MONDAY_NIGHT = '2026-12-01T05:59:50Z';
  const at = (iso: string) => { vi.setSystemTime(new Date(iso)); return createState(session(5), io); };
  const pass = async (s: ReturnType<typeof createState>, seconds = 20) => { vi.setSystemTime(new Date(Date.now() + seconds * 1000)); await s.refresh(); };

  it('moves a Day view that follows today to the new day, and the date list with it', async () => {
    const s = at(BEFORE), seen: string[] = [];
    s.subscribe(change => seen.push(change));
    expect([s.today, s.date, s.center]).toEqual(['2026-11-29', '2026-11-29', '2026-11-29']);
    await pass(s);
    expect([s.today, s.date, s.center]).toEqual(['2026-11-30', '2026-11-30', '2026-11-30']);
    expect(seen).toContain('nav');
  });
  it('moves a Week view that follows this week to the new Monday, and a Month view to the new month', async () => {
    const week = at(BEFORE);
    week.setView('week');
    expect(week.date).toBe('2026-11-23');
    await pass(week);
    expect([week.today, week.date, week.center]).toEqual(['2026-11-30', '2026-11-30', '2026-11-30']);
    const month = at(MONDAY_NIGHT);
    month.setView('month');
    expect(month.date).toBe('2026-11-01');
    await pass(month);
    expect([month.today, month.date, month.center]).toEqual(['2026-12-01', '2026-12-01', '2026-12-01']);
  });
  it('leaves a person who is looking at another day, week or month where they are, and only moves today', async () => {
    const day = at(BEFORE);
    day.go('2026-12-05');
    await pass(day);
    expect([day.today, day.date]).toEqual(['2026-11-30', '2026-12-05']);
    const week = at(BEFORE);
    week.setView('week'); week.go('2026-12-07');
    await pass(week);
    expect([week.today, week.date]).toEqual(['2026-11-30', '2026-12-07']);
    const month = at(MONDAY_NIGHT);
    month.setView('month'); month.go('2027-02-01');
    await pass(month);
    expect([month.today, month.date]).toEqual(['2026-12-01', '2027-02-01']);
  });
  it('says nothing when the day has not changed', async () => {
    const s = at(BEFORE), seen: string[] = [];
    s.subscribe(change => seen.push(change));
    await pass(s, 5);
    expect(seen).not.toContain('nav');
    expect(s.today).toBe('2026-11-29');
  });
});

describe('start', () => {
  // A page of its own: a document and a window that only record their listeners.
  function page() {
    const listeners = new Map<string, Set<() => void>>();
    const target = (name: string) => ({
      addEventListener: (type: string, fn: () => void) => { (listeners.get(`${name}:${type}`) ?? listeners.set(`${name}:${type}`, new Set()).get(`${name}:${type}`)!).add(fn); },
      removeEventListener: (type: string, fn: () => void) => { listeners.get(`${name}:${type}`)?.delete(fn); },
    });
    const doc = { hidden: false, ...target('document') };
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', target('window'));
    return { doc, fire: (name: string, type: string) => listeners.get(`${name}:${type}`)?.forEach(fn => fn()), count: (name: string, type: string) => listeners.get(`${name}:${type}`)?.size ?? 0 };
  }
  afterEach(() => vi.unstubAllGlobals());

  it('polls every 12 seconds with the revision held, and stops when told to', async () => {
    page();
    const stop = state.start();
    await vi.advanceTimersByTimeAsync(11999);
    expect(io.load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(io.load).toHaveBeenCalledTimes(1);
    expect(io.load).toHaveBeenLastCalledWith(5);
    await vi.advanceTimersByTimeAsync(12000);
    expect(io.load).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(io.load).toHaveBeenCalledTimes(2);
  });
  it('polls at once when the network comes back or the page becomes visible again, and not while it is hidden', async () => {
    const browser = page();
    state.start();
    browser.fire('window', 'online');
    await vi.advanceTimersByTimeAsync(0);
    expect(io.load).toHaveBeenCalledTimes(1);
    browser.doc.hidden = false;
    browser.fire('document', 'visibilitychange');
    await vi.advanceTimersByTimeAsync(0);
    expect(io.load).toHaveBeenCalledTimes(2);
    browser.doc.hidden = true;
    browser.fire('document', 'visibilitychange');
    await vi.advanceTimersByTimeAsync(0);
    expect(io.load).toHaveBeenCalledTimes(2);
  });
  it('saves a waiting selection at once when the page is hidden, and starting again replaces the old timers', async () => {
    const browser = page();
    state.start();
    state.start();
    expect(browser.count('window', 'online')).toBe(1);
    expect(browser.count('document', 'visibilitychange')).toBe(1);
    state.setSelection({ base: 'alex', overlays: [] });
    expect(sent).toHaveLength(0);
    browser.doc.hidden = true;
    browser.fire('document', 'visibilitychange');
    expect(sent).toEqual([{ action: 'savePrefs', selection: { base: 'alex', overlays: [] } }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(1);
  });
  it('closing removes the listeners', () => {
    const browser = page();
    state.start();
    state.close();
    expect(browser.count('window', 'online')).toBe(0);
    expect(browser.count('document', 'visibilitychange')).toBe(0);
  });
});

describe('selection swaps and gone records', () => {
  it('swapping one overlay for another is saved once, with the new one', () => {
    state.setSelection({ base: 'both', overlays: [A] });
    vi.advanceTimersByTime(100);
    state.setSelection({ base: 'both', overlays: [B] });
    vi.advanceTimersByTime(400);
    expect(sent).toEqual([{ action: 'savePrefs', selection: { base: 'both', overlays: [B] } }]);
    expect(state.selection).toEqual({ base: 'both', overlays: [B] });
  });
  it('a write on a record that is gone shows the message and reads the list again, like a stale one', async () => {
    io.send.mockRejectedValue(new ApiFailure('That to-do was deleted.', 409, 'gone'));
    expect(await state.send(complete)).toMatchObject({ ok: false, code: 'gone', message: 'That to-do was deleted.' });
    expect(state.error).toBe('That to-do was deleted.');
    await vi.waitFor(() => expect(io.load).toHaveBeenCalledWith(5));
  });
});

describe('navigation', () => {
  // Today is whatever the machine says; these tests set the clock to Wednesday 18 November 2026 noon in Chicago.
  beforeEach(() => { vi.setSystemTime(new Date('2026-11-18T18:00:00Z')); state = createState(session(5), io); });

  it('go keeps the date list where it is while the day is inside it, and moves it when the day is outside or when asked', () => {
    expect([state.today, state.date, state.center]).toEqual(['2026-11-18', '2026-11-18', '2026-11-18']);
    state.go('2026-11-24');
    expect([state.date, state.center]).toEqual(['2026-11-24', '2026-11-18']);
    state.go('2026-11-26');
    expect([state.date, state.center]).toEqual(['2026-11-26', '2026-11-26']);
    state.go('2026-11-27', true);
    expect([state.date, state.center]).toEqual(['2026-11-27', '2026-11-27']);
  });
  it('setView opens the period that holds the day last chosen, and coming back gives the day again', () => {
    state.go('2026-11-20');
    state.setView('week');
    expect([state.view, state.date, state.center]).toEqual(['week', '2026-11-16', '2026-11-16']);
    state.setView('month');
    expect([state.view, state.date, state.center]).toEqual(['month', '2026-11-01', '2026-11-01']);
    state.setView('day');
    expect([state.view, state.date]).toEqual(['day', '2026-11-20']);
  });
  it('shiftCenter moves the date list by days, weeks or months, and tells the shell', () => {
    const seen: string[] = [];
    state.subscribe(change => seen.push(change));
    state.shiftCenter(-7);
    expect(state.center).toBe('2026-11-11');
    state.setView('week');
    state.shiftCenter(1);
    expect(state.center).toBe('2026-11-23');
    state.setView('month');
    state.shiftCenter(-2);
    expect(state.center).toBe('2026-09-01');
    expect(seen.filter(change => change === 'nav')).toHaveLength(5); // three shifts and two view changes
  });
});

describe('opening a day from the Month, and Back', () => {
  // Same clock as above: Wednesday 18 November 2026 noon in Chicago.
  beforeEach(() => { vi.setSystemTime(new Date('2026-11-18T18:00:00Z')); state = createState(session(5), io); });
  const seat = () => [state.view, state.date, state.center, state.backTo];

  it('nothing is to go back to until a day is opened from another view', () => {
    expect(state.backTo).toBeNull();
    state.go('2026-11-24');
    state.setView('month');
    state.setView('day');
    expect(state.backTo).toBeNull();
  });
  it('openDay(date, "month") shows that day on the Day view, centres the date list on it and remembers the Month, with one tell of the change', () => {
    state.setView('month');
    const seen: string[] = [];
    state.subscribe(change => seen.push(change));
    state.openDay('2026-11-24', 'month');
    expect(seat()).toEqual(['day', '2026-11-24', '2026-11-24', 'month']);
    expect(seen).toEqual(['nav']);
  });
  it('openDay takes a day of another month (a muted cell of the grid) as it is', () => {
    state.setView('month');
    state.openDay('2026-12-02', 'month');
    expect(seat()).toEqual(['day', '2026-12-02', '2026-12-02', 'month']);
  });
  it('goBack returns to the Month that holds the day, forgets the Back, and centres the date list on that month', () => {
    state.setView('month');
    state.openDay('2026-11-24', 'month');
    state.goBack();
    expect(seat()).toEqual(['month', '2026-11-01', '2026-11-01', null]);
  });
  it('goBack from a day stepped to with go() returns to the month of THAT day, not the month the Day was opened from', () => {
    state.openDay('2026-11-30', 'month');
    state.go('2026-12-01');
    expect(state.backTo).toBe('month');
    state.goBack();
    expect(seat()).toEqual(['month', '2026-12-01', '2026-12-01', null]);
    state.openDay('2026-12-01', 'month');
    state.go('2026-11-30', true);
    state.goBack();
    expect(seat()).toEqual(['month', '2026-11-01', '2026-11-01', null]);
  });
  it('goBack from another view puts the Day on the period of that view', () => {
    state.openDay('2026-11-20', 'week');
    state.goBack();
    expect(seat()).toEqual(['week', '2026-11-16', '2026-11-16', null]);
  });
  it('goBack with nothing to go back to changes nothing and tells nobody', () => {
    state.go('2026-11-24');
    const seen: string[] = [];
    state.subscribe(change => seen.push(change));
    state.goBack();
    expect(seat()).toEqual(['day', '2026-11-24', '2026-11-18', null]);
    expect(seen).toEqual([]);
    // And a second Back, right after one that worked, is the same no-op.
    state.openDay('2026-11-24', 'month');
    state.goBack();
    const after = seat();
    seen.length = 0;
    state.goBack();
    expect(seat()).toEqual(after);
    expect(seen).toEqual([]);
  });
  it('setView forgets the Back, whichever view is chosen, so a hand-picked view is not a way back', () => {
    for (const next of ['day', 'week', 'month'] as const) {
      state.openDay('2026-11-24', 'month');
      state.setView(next);
      expect(state.backTo, next).toBeNull();
      expect(state.view).toBe(next);
      state.goBack();
      expect(state.view, `Back after choosing ${next}`).toBe(next);
    }
  });
  it('setView("day") on the Day opened from the Month keeps the day and only forgets the Back', () => {
    state.openDay('2026-11-24', 'month');
    state.setView('day');
    expect(seat()).toEqual(['day', '2026-11-24', '2026-11-24', null]);
  });
  it('go keeps the Back while the person steps from day to day, with or without moving the date list', () => {
    state.openDay('2026-11-24', 'month');
    state.go('2026-11-25');
    expect(seat()).toEqual(['day', '2026-11-25', '2026-11-24', 'month']);
    state.go('2026-12-20', true);
    expect(seat()).toEqual(['day', '2026-12-20', '2026-12-20', 'month']);
    state.shiftCenter(7);
    expect(state.backTo).toBe('month');
  });
  it('the day rolling over leaves the Back alone', () => {
    state.openDay('2026-11-24', 'month');
    vi.setSystemTime(new Date('2026-11-19T18:00:00Z'));
    void state.refresh();
    expect(state.today).toBe('2026-11-19');
    expect(seat()).toEqual(['day', '2026-11-24', '2026-11-24', 'month']);
  });
});

describe('a new release', () => {
  it('is known to the state from the watch it is given, and an app without one never sees a change', () => {
    expect(state.newRelease).toBe(false);
    const watch = createReleaseWatch();
    const watched = createState(session(5), { ...io, release: watch });
    watch.see('20261102090000-1');
    expect(watched.newRelease).toBe(false);
    watch.see('20261102093000-2');
    expect(watched.newRelease).toBe(true);
  });
  it('a change of the picker or the sidebar is pending until its save has been sent', () => {
    expect(state.prefsPending).toBe(false);
    state.setSidebar('hidden');
    expect(state.prefsPending).toBe(true);
    vi.advanceTimersByTime(400);
    expect(state.prefsPending).toBe(false);
  });
  describe('writing: no write of the page may be cut off by a reload', () => {
    /** A request the test answers when it chooses (the host takes tens of seconds during a deploy). */
    const held = <T>() => { let settle!: (value: T) => void, fail!: (error: unknown) => void; const promise = new Promise<T>((resolve, reject) => { settle = resolve; fail = reject; }); return { promise, settle, fail }; };
    it('is false at rest, and true for a write in flight, as before', async () => {
      expect(state.writing).toBe(false);
      const answer = held<Snapshot>();
      io.send.mockReturnValueOnce(answer.promise);
      const sending = state.send(complete);
      expect(state.writing).toBe(true);
      answer.settle(session(6) as unknown as Snapshot);
      await sending;
      expect(state.writing).toBe(false);
    });
    it('a picker or sidebar save is writing from the change to its answer, not only until the request is sent', async () => {
      const answer = held<Snapshot>();
      io.send.mockReturnValueOnce(answer.promise);
      state.setSidebar('hidden');
      expect(state.writing).toBe(true);
      vi.advanceTimersByTime(400);
      // The request is out (the 400 ms pause is over, `busy` was never set) and the host has not answered.
      expect(state.prefsPending).toBe(false);
      expect(state.busy).toBe(false);
      expect(state.writing).toBe(true);
      answer.settle(session(6) as unknown as Snapshot);
      await vi.advanceTimersByTimeAsync(0);
      expect(state.writing).toBe(false);
    });
    it('a save that fails ends the writing too, and a theme being stored is writing until it is answered', async () => {
      const refused = held<Snapshot>();
      io.send.mockReturnValueOnce(refused.promise);
      state.setSelection({ base: 'both', overlays: [A] });
      vi.advanceTimersByTime(400);
      expect(state.writing).toBe(true);
      refused.fail(new ApiFailure('Down', 0, null, undefined, true));
      await vi.advanceTimersByTimeAsync(0);
      expect(state.writing).toBe(false);
      const stored = held<{ theme: string }>();
      io.setTheme.mockReturnValueOnce(stored.promise);
      const saving = state.saveTheme('sage');
      expect(state.writing).toBe(true);
      stored.settle({ theme: 'sage' });
      await saving;
      expect(state.writing).toBe(false);
      io.setTheme.mockRejectedValueOnce(new ApiFailure('Down', 0, null, undefined, true));
      await state.saveTheme('forest');
      expect(state.writing).toBe(false);
    });
    it('the shell is told when the last of them ends, once, so it can load the release it was waiting to', async () => {
      const prefs = held<Snapshot>(), theme = held<{ theme: string }>();
      io.send.mockReturnValueOnce(prefs.promise);
      io.setTheme.mockReturnValueOnce(theme.promise);
      state.setSidebar('hidden');
      vi.advanceTimersByTime(400);
      const saving = state.saveTheme('sage');
      const seen: string[] = [];
      state.subscribe(change => seen.push(change));
      prefs.settle(session(6) as unknown as Snapshot);
      await vi.advanceTimersByTimeAsync(0);
      // The theme is still going out: not yet.
      expect(seen.filter(change => change === 'status')).toEqual([]);
      expect(state.writing).toBe(true);
      theme.settle({ theme: 'sage' });
      await saving;
      expect(seen.filter(change => change === 'status')).toEqual(['status']);
      expect(state.writing).toBe(false);
    });
  });
  it('starts where the place says, and on today\'s Day without one', () => {
    vi.setSystemTime(new Date('2026-11-18T18:00:00Z'));
    const seat = (s: typeof state) => [s.view, s.date, s.center, s.backTo, s.chores];
    expect(seat(createState(session(5), io))).toEqual(['day', '2026-11-18', '2026-11-18', null, false]);
    // A Wednesday of a far week: the week view is on its Monday.
    expect(seat(createState(session(5), io, { view: 'week', date: '2041-03-06', chores: false, back: null }))).toEqual(['week', '2041-03-04', '2041-03-04', null, false]);
    expect(seat(createState(session(5), io, { view: 'month', date: '2041-06-15', chores: true, back: null }))).toEqual(['month', '2041-06-01', '2041-06-01', null, true]);
    const opened = createState(session(5), io, { view: 'day', date: '2041-06-15', chores: false, back: 'month' });
    expect(seat(opened)).toEqual(['day', '2041-06-15', '2041-06-15', 'month', false]);
    // The Back works from there as from a Day the person opened by hand.
    opened.goBack();
    expect(seat(opened)).toEqual(['month', '2041-06-01', '2041-06-01', null, false]);
  });
});

describe('the Both color is per person (#138)', () => {
  const withBoth = (over: Partial<Session> = {}, extra: Partial<StateIo> = {}) => {
    const setBothColor = vi.fn(async (color: string) => ({ bothColor: color }));
    const made = createState(session(5, over), { ...io, setBothColor: setBothColor as unknown as StateIo['setBothColor'], ...extra });
    return { made, setBothColor };
  };
  it('reads the household default until a pick, then the pick', () => {
    expect(state.settings.bothColor).toBe('purple');
    expect(state.settings).toBe(state.session.settings);
    expect(withBoth({ bothColor: 'teal' }).made.settings.bothColor).toBe('teal');
    expect(withBoth({ bothColor: null }).made.settings.bothColor).toBe('purple');
  });
  it('makeContext hands the views the personal settings', () => {
    const ctx = makeContext(withBoth({ bothColor: 'orange' }).made, () => {});
    expect(ctx.settings.bothColor).toBe('orange');
    // The view functions of core read the same color through `data`, so a Both item is drawn in it.
    expect(ctx.input.data.settings.bothColor).toBe('orange');
    expect(ctx.choreInput.data.settings.bothColor).toBe('orange');
    expect(ctx.input.data).toBe(ctx.input.data);
  });
  it('a pick shows at once, is saved through the account preference and not as a planner mutation', async () => {
    const { made, setBothColor } = withBoth();
    const done = made.saveBothColor('red');
    expect(made.settings.bothColor).toBe('red');
    expect(await done).toEqual({ ok: true });
    expect(setBothColor).toHaveBeenCalledWith('red');
    expect(sent).toHaveLength(0);
    expect(made.session.settings.bothColor).toBe('purple');
  });
  it('a failed save puts the stored color back and says why', async () => {
    const { made } = withBoth({ bothColor: 'teal' }, { setBothColor: async () => { throw new ApiFailure('Down', 503, 'unavailable'); } });
    const result = await made.saveBothColor('red');
    expect(result).toEqual({ ok: false, message: 'Down' });
    expect(made.settings.bothColor).toBe('teal');
  });
  it('an answer naming another color is not a confirmation', async () => {
    const { made } = withBoth({}, { setBothColor: async () => ({ bothColor: 'blue' }) });
    expect((await made.saveBothColor('red')).ok).toBe(false);
    expect(made.settings.bothColor).toBe('purple');
  });
  it('a pick made on another device arrives with the next full answer, but not over one in flight', async () => {
    const { made } = withBoth({ bothColor: 'teal' });
    io.load.mockResolvedValue({ ...session(6), bothColor: 'pink' });
    const { made: fresh } = withBoth({ bothColor: 'teal' }, { load: io.load as unknown as StateIo['load'] });
    await fresh.refresh();
    expect(fresh.settings.bothColor).toBe('pink');
    expect(made.settings.bothColor).toBe('teal');
  });
  it('picking the color already shown writes nothing', async () => {
    const { made, setBothColor } = withBoth();
    expect(await made.saveBothColor('purple')).toEqual({ ok: true });
    expect(setBothColor).not.toHaveBeenCalled();
  });
  it('a duplicate pick while saving does not prevent later refreshes', async () => {
    let finish!: (value: { bothColor: 'red' }) => void;
    const pending = new Promise<{ bothColor: 'red' }>(resolve => { finish = resolve; });
    const { made } = withBoth({}, { setBothColor: () => pending });
    const first = made.saveBothColor('red');
    await made.saveBothColor('red');
    finish({ bothColor: 'red' });
    await first;
    io.load.mockResolvedValue({ ...session(6), bothColor: 'pink' });
    await made.refresh();
    expect(made.settings.bothColor).toBe('pink');
  });
  it('serializes successive picks and restores the last confirmed color on failure', async () => {
    let finish!: (value: { bothColor: 'red' }) => void;
    const pending = new Promise<{ bothColor: 'red' }>(resolve => { finish = resolve; });
    const save = vi.fn().mockReturnValueOnce(pending).mockRejectedValueOnce(new ApiFailure('Down', 503, 'unavailable'));
    const { made } = withBoth({}, { setBothColor: save });
    const first = made.saveBothColor('red');
    const second = made.saveBothColor('blue');
    expect(save).toHaveBeenCalledTimes(1);
    finish({ bothColor: 'red' });
    await first;
    expect((await second).ok).toBe(false);
    expect(made.settings.bothColor).toBe('red');
  });
});

describe("CalMind's all-day events (#171)", () => {
  // start() needs a document and a window to listen on.
  beforeEach(() => {
    const target = () => ({ addEventListener: () => {}, removeEventListener: () => {} });
    vi.stubGlobal('document', { hidden: false, ...target() });
    vi.stubGlobal('window', target());
  });
  afterEach(() => vi.unstubAllGlobals());
  const item = { id: 'alex:a:2026-11-10:2026-11-10', owner: 'alex' as const, date: '2026-11-10', text: 'Anniversary', color: '#3366cc' };
  const withCalmind = (reply: unknown) => {
    const calmind = vi.fn(async () => reply as never);
    return { made: createState(session(5), { ...io, calmind, setCalmind: async (hidden: boolean) => ({ calmind: hidden ? 'hidden' : 'shown' }) }), calmind };
  };
  it('holds the all-day list beside the timed one and hands it out until this account hides CalMind', async () => {
    const { made, calmind } = withCalmind({ events: [], allDay: [item] });
    const stop = made.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calmind).toHaveBeenCalled();
    expect(made.calmindAllDay).toEqual([item]);
    await made.setCalmindHidden(true);
    expect(made.calmindAllDay).toEqual([]);
    stop(); made.close();
  });
  it('an older server sends no all-day list: none, and nothing breaks', async () => {
    const { made } = withCalmind({ events: [] });
    const stop = made.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(made.calmindAllDay).toEqual([]);
    stop(); made.close();
  });
  it('a change in the all-day list alone redraws the page', async () => {
    const reply = { events: [], allDay: [] as unknown[] };
    const { made } = withCalmind(reply);
    const changes: string[] = [];
    made.subscribe(c => changes.push(c));
    const stop = made.start();
    await vi.advanceTimersByTimeAsync(0);
    const before = changes.filter(c => c === 'data').length;
    reply.allDay = [item];
    await vi.advanceTimersByTimeAsync(13000 * 5);
    expect(changes.filter(c => c === 'data').length).toBeGreaterThan(before);
    expect(made.calmindAllDay).toEqual([item]);
    stop(); made.close();
  });
});
