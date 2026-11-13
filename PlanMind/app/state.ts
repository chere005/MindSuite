import { DEFAULT_SIDEBAR, mutationKeys, periodStart, predict, predictable, type CalmindAllDay, type CalmindEvent, type CalmindReply, type SetCalmindReply, type SetBothColorReply, type ColorKey, personalSettings, type Settings, periodWindow, resolveSelection, shiftPeriod, todayIn, type ApiErrorCode, type Mutation, type Selection, type Session, type SetThemeReply, type SidebarState, type Snapshot, type View } from '../packages/core/src/planner';
import { shiftDate } from '../packages/core/src/parse';
import { ApiFailure, type Loaded } from './api';
import type { Place } from './place';
import type { ReleaseWatch } from './release';

/** An unsent text a panel keeps in memory (never in browser storage), keyed by note key. */
export type Draft = { text: string; revision: number };
/** What changed, so the shell redraws only what it must. */
export type Change = 'data' | 'selection' | 'chores' | 'sidebar' | 'theme' | 'nav' | 'busy' | 'status' | 'closed';
export type SendResult = { ok: true } | { ok: false; message: string; code: ApiErrorCode | null; uncertain: boolean; skipped?: true };
export type StateIo = {
  load(since?: number): Promise<Loaded>;
  send(mutation: Mutation): Promise<Snapshot>;
  /** The account's color theme; resolves with the theme the server stored. */
  setTheme(theme: string): Promise<SetThemeReply>;
  /** CalMind's events on the planner days `from` to `to` (left out: none are drawn). */
  calmind?(from: string, to: string): Promise<CalmindReply>;
  /** Whether the Day shows CalMind's events; resolves with what the server stored. */
  setCalmind?(hidden: boolean): Promise<SetCalmindReply>;
  /** This person's own color for Both (an account preference); resolves with the color the server stored. */
  setBothColor?(color: ColorKey): Promise<SetBothColorReply>;
  hidden(): boolean;
  /** What every response's release stamp was fed to: when the host serves another release than the page started under, `changed` is true. */
  release?: Pick<ReleaseWatch, 'changed'>;
};
export type ThemeResult = { ok: true } | { ok: false; message: string };

export const POLL_MS = 12000;
export const PREFS_DEBOUNCE_MS = 400;
/** CalMind's events are asked for again every this many polls (a minute), and for the days around the open one. */
export const CALMIND_EVERY = 5;
export const CALMIND_BEFORE = 3, CALMIND_AFTER = 27;
const UNCERTAIN = 'The connection was interrupted. Your change may have saved. Refresh before retrying; your draft is still here.';
const sameSelection = (a: Selection, b: Selection) => a.base === b.base && a.overlays.length === b.overlays.length && a.overlays.every((id, i) => id === b.overlays[i]);

/**
 * The one holder of what the page knows: the latest snapshot, the picker selection, whether the Chores view is on, whether the
 * desktop sidebar is shown, which period is open, unsent drafts and the status of writes. Nothing here is written to browser storage.
 * - A response older than the revision held is ignored, and a failed read never replaces state.
 * - The snapshot's `prefs` are read once, at load. Later responses only heal the selection against the lists.
 * - Writes go out one at a time, in the order they were made; a poll waits for them. A write the screen can answer at once (`send(..., { optimistic: true })`:
 *   a tick, a chore mark, an entry moved) is laid over the snapshot as it will read once saved (core optimistic.ts) until its reply arrives, so the screen answers
 *   without waiting and a poll cannot put older state over it. A refused or failed write takes only its own change off again (and any later write built on the same record).
 * - `place` is where a page that reloaded itself for a new release puts the person back (the view, the period, Chores, the Back); without one it starts on today's Day.
 */
export function createState(initial: Session, io: StateIo, place?: Omit<Place, 'tab'>) {
  let session = initial;
  let selection = resolveSelection(initial.prefs.selection, initial.lists);
  // Anything the server did not say is 'hidden' reads as shown.
  let sidebar: SidebarState = initial.prefs.sidebar === 'hidden' ? 'hidden' : DEFAULT_SIDEBAR;
  // The theme on screen, and the last one the server confirmed. A pick shows at once but is only believed once it is saved.
  let theme = initial.theme, savedTheme = initial.theme, themeTry = 0;
  let today = todayIn(initial.timezone);
  let view: View = place?.view ?? 'day', anchor = place?.date ?? today, date = periodStart(anchor, view), center = date;
  // The Chores flag: on a phone the Chores view replaces the planner's page (its Chores tab); on a desktop it is the picker's Chores switch, which swaps the Day's To-do section for the day's chores. One flag, so
  // a window crossing the phone breakpoint with it on lands on the other page of the same thing. In memory only (a reload is back on the planner unless it put the person back, place.ts), and the picker selection is not touched by it.
  let chores = place?.chores ?? false;
  // Whether the phone's own Chores tab turned it on (as against the desktop Day's switch): the Week's and the Month's phone pages are Chores pages only then, so the Day's switch, which is the Day's alone, leaves a narrowed window's Week and Month on their planner tabs.
  let choresTab = false;
  // The view a Day was opened from (a tap on a day of the Month), so a Back button can return to it; choosing a view by hand forgets it.
  let backTo: View | null = place?.back ?? null;
  let fetching = false, alive = true;
  // The writes made and not yet answered, in order; the first is the one on its way. `optimistic` ones show on the screen at once.
  type Entry = { mutation: Mutation; optimistic: boolean; keys: string[]; started: boolean; waiters: ((result: SendResult) => void)[] };
  let queue: Entry[] = [], pumping = false, wasBusy = false, queueVersion = 0;
  let shown: { base: Session; version: number; value: Session } | null = null;
  /** Whether a write the screen does not answer by itself is waiting or on its way (forms are held and a redraw waits for it). */
  const isBusy = () => queue.some(entry => !entry.optimistic);
  const emitBusy = () => { const now = isBusy(); if (now !== wasBusy) { wasBusy = now; emit('busy'); } };
  /** The snapshot as the screen reads it: the server's, with the unanswered optimistic writes laid over it. */
  function display(): Session {
    if (!queue.some(entry => entry.optimistic)) { return session; }
    if (shown && shown.base === session && shown.version === queueVersion) { return shown.value; }
    const value = queue.reduce((data, entry) => (entry.optimistic ? predict(data, entry.mutation, session.user) : data), session);
    shown = { base: session, version: queueVersion, value };
    return value;
  }
  let status = 'Up to date';
  let error: { message: string; source: 'write' | 'poll' | 'panel' } | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  // Saves nobody waits for (the picker, the sidebar, the theme) have no `busy`, but they are in flight all the same: a reload now would cut them off.
  let quietWrites = 0;
  // Whether this device changed the sidebar since it last told the server. Only then does a save carry it (the server keeps the
  // stored value otherwise), so a picker change here never puts a stale sidebar over another device's choice.
  let sidebarDirty = false;
  let stopTimers: (() => void) | undefined;
  // CalMind's events (the Day schedule draws them faint, under the planner's own entries): what was last read, for which days, and
  // whether this account hides them. A failed read keeps what is held (and is asked again at the next poll); nothing is stored.
  let calmindHidden = initial.calmind === 'hidden';
  let calmindEvents: CalmindEvent[] = [], calmindAllDay: CalmindAllDay[] = [], calmindRange: { from: string; to: string } | null = null;
  let calmindFetching = false, calmindTicks = 0, calmindTry = 0;
  // This person's own color for Both: the one the server last confirmed, and a pick on screen while it saves (null: the household default).
  let bothColor: ColorKey | null = initial.bothColor ?? null, bothTry = 0, bothSaving = false;
  let bothConfirmed: ColorKey | null = bothColor, bothQueue: Promise<void> | null = null;
  let settingsFor: { settings: Settings; mine: ColorKey | null; value: Settings } | null = null;
  const drafts = new Map<string, Draft>();
  const listeners = new Set<(change: Change) => void>();
  const emit = (change: Change) => { for (const fn of [...listeners]) fn(change); };
  const setStatus = (text: string) => { status = text; emit('status'); };
  const setError = (message: string, source: 'write' | 'poll' | 'panel') => { error = { message, source }; emit('status'); };
  /** A quiet write is over, answered or not: the last one tells the shell, which may be waiting for it to load a new release. */
  const quietWriteEnded = () => { quietWrites--; if (alive && quietWrites === 0) { emit('status'); } };

  /** Takes a snapshot in when it is newer than the one held. Returns whether anything changed. */
  function applyResponse(response: Loaded): boolean {
    if (!alive || 'unchanged' in response || response.revision <= session.revision) { return false; }
    session = { ...session, ...response, prefs: session.prefs };
    // A full answer to a read (not to a write) says this person's stored Both color, so a pick made on another device arrives with the next change; one of ours in flight is not overruled.
    if ('bothColor' in response && !bothSaving) { bothColor = (response as Session).bothColor ?? null; bothConfirmed = bothColor; }
    selection = resolveSelection(selection, session.lists);
    emit('data');
    return true;
  }

  function checkToday() {
    const next = todayIn(session.timezone);
    if (next === today) { return; }
    const following = date === periodStart(today, view);
    today = next;
    if (following) { anchor = next; date = center = periodStart(next, view); }
    emit('nav');
  }

  /**
   * Reads CalMind's events when the open Day is outside the days held (or `again`, the poll's minute): the open day, a few days before and
   * four weeks after. Only for the Day view, only while they are shown, one read at a time; a failure keeps what is held.
   */
  async function syncCalmind(again = false): Promise<void> {
    if (!io.calmind || calmindHidden || view !== 'day' || calmindFetching || !alive || io.hidden()) { return; }
    const held = calmindRange && date >= calmindRange.from && date <= calmindRange.to;
    if (held && !again) { return; }
    const from = held ? calmindRange!.from : shiftDate(date, -CALMIND_BEFORE, 'day'), to = held ? calmindRange!.to : shiftDate(date, CALMIND_AFTER, 'day');
    calmindFetching = true;
    try {
      const reply = await io.calmind(from, to);
      if (!alive || !Array.isArray(reply?.events)) { return; }
      // An older server sends no all-day list: none.
      const allDay = Array.isArray(reply.allDay) ? reply.allDay : [];
      const changed = JSON.stringify(reply.events) !== JSON.stringify(calmindEvents) || JSON.stringify(allDay) !== JSON.stringify(calmindAllDay);
      calmindEvents = reply.events; calmindAllDay = allDay; calmindRange = { from, to };
      if (changed && !calmindHidden) { emit('data'); }
    } catch { /* kept as it was; the next poll asks again */ }
    finally { calmindFetching = false; }
  }

  /** A poll. Skipped while hidden, while a write is in flight or while another poll runs. */
  async function refresh(): Promise<void> {
    checkToday();
    calmindTicks = (calmindTicks + 1) % CALMIND_EVERY;
    void syncCalmind(calmindTicks === 0);
    if (fetching || queue.length > 0 || !alive || io.hidden()) { return; }
    fetching = true;
    try {
      const response = await io.load(session.revision);
      // A write that began meanwhile has a newer answer than this poll.
      if (!alive || queue.length > 0) { return; }
      applyResponse(response);
      if (error?.source === 'poll') { error = null; }
      setStatus('Up to date');
    } catch (e) {
      if (alive) {
        setStatus('Connection interrupted');
        setError(e instanceof Error ? e.message : 'Could not refresh.', 'poll');
      }
    } finally { fetching = false; }
  }

  const SKIPPED: SendResult = { ok: false, message: '', code: null, uncertain: false, skipped: true };
  /**
   * One write. It joins the line behind the writes already made and resolves when it has been answered. A write the screen cannot answer by itself is
   * refused (skipped) while another of that kind is waiting, as before. An optimistic write shows at once; a not yet sent one for the same record
   * is folded into it (a tick and its undo make one write that ends where the last press left it).
   */
  function send(mutation: Mutation, options: { optimistic?: boolean } = {}): Promise<SendResult> {
    if (!alive) { return Promise.resolve(SKIPPED); }
    const optimistic = options.optimistic === true && predictable(mutation);
    if (!optimistic && isBusy()) { return Promise.resolve(SKIPPED); }
    const keys = mutationKeys(mutation);
    return new Promise<SendResult>(resolve => {
      const last = optimistic && keys.length === 1 ? queue.map(e => e.keys.includes(keys[0]!)).lastIndexOf(true) : -1;
      const merge = last >= 0 && !queue[last]!.started && queue[last]!.optimistic && queue[last]!.keys.length === 1 ? queue[last]! : null;
      if (merge) {
        merge.mutation = { ...mutation, revision: (merge.mutation as { revision: number }).revision } as Mutation;
        merge.waiters.push(resolve);
      } else {
        queue.push({ mutation, optimistic, keys, started: false, waiters: [resolve] });
      }
      queueVersion++;
      error = null; status = 'Saving…';
      if (optimistic) { emit('data'); }
      emitBusy(); emit('status');
      void pump();
    });
  }

  async function pump(): Promise<void> {
    if (pumping) { return; }
    pumping = true;
    let reload = false;
    try {
      while (alive && queue.length > 0) {
        const entry = queue[0]!;
        entry.started = true;
        let reply: Snapshot | null = null, failure: ApiFailure | null = null;
        try { reply = await io.send(entry.mutation); }
        catch (e) { failure = e instanceof ApiFailure ? e : new ApiFailure(e instanceof Error ? e.message : 'Unable to save.', 0, null); }
        if (!alive) { return; }
        queue.shift(); queueVersion++;
        if (reply) {
          if (!applyResponse(reply)) { emit('data'); }
          if (queue.length === 0) { setStatus('Saved'); }
          entry.waiters.forEach(done => done({ ok: true }));
        } else if (failure) {
          const message = failure.uncertain ? UNCERTAIN : failure.message;
          // The record changed or went away under us, or the outcome is unknown: show what is true now.
          if (failure.code === 'stale' || failure.code === 'gone' || failure.uncertain) { reload = true; }
          // Writes built on this one's record cannot stand without it.
          const behind = queue.filter(other => other.keys.some(key => entry.keys.includes(key)));
          queue = queue.filter(other => !behind.includes(other));
          error = { message, source: 'write' }; status = 'Needs attention';
          emit('data'); emit('status');
          entry.waiters.forEach(done => done({ ok: false, message, code: failure!.code, uncertain: failure!.uncertain }));
          behind.forEach(other => other.waiters.forEach(done => done(SKIPPED)));
        }
        emitBusy();
      }
    } finally {
      pumping = false;
      emitBusy();
      if (reload && alive) { void refresh(); }
    }
  }

  /** Best effort and silent: the in-memory selection and sidebar apply whether or not this lands. A failed save keeps the sidebar owed for the next one. */
  function savePrefs() {
    saveTimer = undefined;
    if (!alive) { return; }
    const withSidebar = sidebarDirty;
    sidebarDirty = false;
    quietWrites++;
    io.send(withSidebar ? { action: 'savePrefs', selection, sidebar } : { action: 'savePrefs', selection }).then(applyResponse, () => { sidebarDirty ||= withSidebar; }).finally(quietWriteEnded);
  }
  /** One write for whatever changed in the last moment: the picker and the sidebar share it. */
  function schedulePrefs() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePrefs, PREFS_DEBOUNCE_MS);
  }

  function go(next: string, recenter = false) {
    anchor = next;
    date = periodStart(next, view);
    if (recenter || !periodWindow(center, view).includes(date)) { center = date; }
    emit('nav');
    void syncCalmind();
  }

  return {
    get session() { return display(); },
    /** The settings the views read: the household's, with `bothColor` this person's own pick when they made one (core personalSettings). */
    get settings(): Settings {
      if (!settingsFor || settingsFor.settings !== session.settings || settingsFor.mine !== bothColor) {
        settingsFor = { settings: session.settings, mine: bothColor, value: personalSettings(session.settings, bothColor) };
      }
      return settingsFor.value;
    },
    /** This person's own pick for Both, or null while they have none. */
    get bothColor() { return bothColor; },
    get selection() { return selection; },
    /** Whether Chores is on: a phone's Chores view instead of the planner's page for the open period, a desktop Day's chores in place of its to-dos. */
    get chores() { return chores; },
    /** Whether the phone's Chores tab (and not the Day's switch) is what turned Chores on. */
    get choresTab() { return choresTab; },
    /** Whether the desktop sidebar is shown. The phone's drawer is not part of it. */
    get sidebar() { return sidebar; },
    /** The theme on screen: the last pick while it saves, the stored one after a failure. */
    get theme() { return theme; },
    get view() { return view; },
    /** The view to go back to from this Day (the Month it was opened from), or null. */
    get backTo() { return backTo; },
    /** The open period: the day, the Monday or the first of the month. */
    get date() { return date; },
    /** The middle of the 15-row date list; moves with shiftCenter. */
    get center() { return center; },
    get today() { return today; },
    get busy() { return isBusy(); },
    /** Whether the host now serves another release than the one this page started under (the shell reloads at a quiet moment). */
    get newRelease() { return io.release?.changed ?? false; },
    /** Whether a change of the picker or sidebar is still waiting for its save (a reload now would lose it). */
    get prefsPending() { return saveTimer !== undefined; },
    /** Whether any write of this page is under way or waiting: a save in flight, a picker or sidebar change waiting for its pause or its answer, a theme being stored. A reload now would lose it. */
    get writing() { return queue.length > 0 || saveTimer !== undefined || quietWrites > 0; },
    get status() { return status; },
    /** CalMind's events the Day draws: none while this account hides them. */
    get calmindEvents(): readonly CalmindEvent[] { return calmindHidden ? [] : calmindEvents; },
    /** CalMind's all-day events the Day's strip draws: none while this account hides CalMind. */
    get calmindAllDay(): readonly CalmindAllDay[] { return calmindHidden ? [] : calmindAllDay; },
    /** Whether this account hides CalMind's events on the Day. */
    get calmindHidden() { return calmindHidden; },
    get error() { return error?.message ?? ''; },
    get alive() { return alive; },
    drafts,
    subscribe(fn: (change: Change) => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
    applyResponse,
    refresh,
    send,
    go,
    setView(next: View) { view = next; backTo = null; go(anchor, true); },
    /** Opens a day on the Day view from another view; Back returns to that view, on the period that holds the day. */
    openDay(day: string, from: View) { view = 'day'; backTo = from; go(day, true); },
    goBack() { if (!backTo) { return; } view = backTo; backTo = null; go(anchor, true); },
    shiftCenter(amount: number) { center = shiftPeriod(center, amount, view); emit('nav'); },
    /** The picker's state: kept in memory at once, saved to the server after a short pause. */
    setSelection(next: Selection) {
      const resolved = resolveSelection(next, session.lists);
      if (sameSelection(resolved, selection)) { return; }
      selection = resolved;
      emit('selection');
      schedulePrefs();
    },
    /** Turns Chores on or off (the phone's Chores tab, the desktop Day's switch; `phone` says it was the tab); the open period and the picker selection stay as they are. */
    setChores(next: boolean, phone = false) {
      choresTab = next && phone;
      if (next === chores) { return; }
      chores = next;
      emit('chores');
    },
    /** Shows or hides the desktop sidebar: kept in memory at once, saved with the picker state after the same short pause. */
    setSidebar(next: SidebarState) {
      if (next === sidebar) { return; }
      sidebar = next;
      sidebarDirty = true;
      emit('sidebar');
      schedulePrefs();
    },
    /**
     * Picks a theme: it shows at once ('theme' change) and is saved through the account preference. When the save fails
     * (or its answer cannot be read) the theme on screen goes back to the last one the server confirmed and the result says why,
     * so the page never shows a theme that was not stored. Of several picks in flight, only the newest decides.
     */
    async saveTheme(next: string): Promise<ThemeResult> {
      const mine = ++themeTry;
      theme = next; emit('theme');
      quietWrites++;
      try {
        const reply = await io.setTheme(next);
        // An answer that does not name the theme asked for is not a confirmation.
        if (reply?.theme !== next) { throw new ApiFailure('Your theme could not be saved.', 200, 'unavailable'); }
        savedTheme = next;
        if (mine === themeTry && alive) { theme = savedTheme; emit('theme'); }
        return { ok: true };
      } catch (e) {
        if (mine === themeTry && alive) { theme = savedTheme; emit('theme'); }
        const failure = e instanceof ApiFailure ? e : null;
        return { ok: false, message: failure?.uncertain ? 'Could not confirm the change, so your theme stays as it was.' : failure?.message || 'Your theme could not be saved.' };
      } finally { quietWriteEnded(); }
    },
    /**
     * Hides or shows CalMind's events on the Day: at once on the screen, then saved as an account preference. When the save fails the
     * choice on the screen goes back to the stored one and the banner says why. Of several presses in flight, only the newest decides.
     */
    async setCalmindHidden(next: boolean): Promise<void> {
      if (next === calmindHidden) { return; }
      const mine = ++calmindTry, before = calmindHidden;
      calmindHidden = next; emit('data');
      if (!next) { void syncCalmind(true); }
      if (!io.setCalmind) { return; }
      quietWrites++;
      try {
        const reply = await io.setCalmind(next);
        if (reply?.calmind !== (next ? 'hidden' : 'shown')) { throw new ApiFailure('That could not be saved.', 200, 'unavailable'); }
      } catch (e) {
        if (mine === calmindTry && alive) {
          calmindHidden = before; emit('data');
          setError(e instanceof ApiFailure && !e.uncertain ? e.message : 'Could not save whether CalMind events show.', 'panel');
        }
      } finally { quietWriteEnded(); }
    },
    /**
     * Picks this person's own color for Both (the owner, 2026-11-09): it shows at once and is saved as an account preference, so the other
     * person's Both color does not move. When the save fails (or its answer is not the color asked for) the screen goes back to the
     * stored color and the result says why. Of several picks in flight, only the newest decides.
     */
    async saveBothColor(next: ColorKey): Promise<ThemeResult> {
      if (next === (bothColor ?? session.settings.bothColor)) { return { ok: true }; }
      const mine = ++bothTry;
      bothColor = next; bothSaving = true; emit('data');
      if (!io.setBothColor) { bothConfirmed = next; bothSaving = false; return { ok: true }; }
      const previous = bothQueue;
      let release!: () => void;
      bothQueue = new Promise<void>(resolve => { release = resolve; });
      quietWrites++;
      try {
        if (previous) { await previous; }
        const reply = await io.setBothColor(next);
        if (reply?.bothColor !== next) { throw new ApiFailure('That color could not be saved.', 200, 'unavailable'); }
        bothConfirmed = next;
        return { ok: true };
      } catch (e) {
        if (mine === bothTry && alive) { bothColor = bothConfirmed; emit('data'); }
        const failure = e instanceof ApiFailure ? e : null;
        return { ok: false, message: failure?.uncertain ? 'Could not confirm the change, so your Both color stays as it was.' : failure?.message || 'That color could not be saved.' };
      } finally { release(); if (mine === bothTry) { bothSaving = false; bothQueue = null; } quietWriteEnded(); }
    },
    /** Shows a message in the shell's banner (a panel's own validation, for instance). */
    report(message: string) { setError(message, 'panel'); },
    dismissError() { error = null; emit('status'); },
    /** Starts the poll (every POLL_MS), and polls again when the page returns or the network does. Returns stop. */
    start(): () => void {
      stopTimers?.();
      const tick = () => { void refresh(); };
      const timer = setInterval(tick, POLL_MS);
      const visibility = () => {
        if (!document.hidden) { tick(); }
        else if (saveTimer !== undefined) { clearTimeout(saveTimer); savePrefs(); }
      };
      document.addEventListener('visibilitychange', visibility);
      void syncCalmind();
      window.addEventListener('online', tick);
      stopTimers = () => { clearInterval(timer); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('online', tick); stopTimers = undefined; };
      return stopTimers;
    },
    /** The session is gone: stop everything and let the shell close the view. */
    close() {
      if (!alive) { return; }
      alive = false;
      const unanswered = queue; queue = [];
      unanswered.forEach(entry => entry.waiters.forEach(done => done(SKIPPED)));
      clearTimeout(saveTimer);
      stopTimers?.();
      drafts.clear();
      emit('closed');
    },
  };
}
export type AppState = ReturnType<typeof createState>;
