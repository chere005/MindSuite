import type { ChoreInput, Lane, ListRecord, Mutation, Person, Selection, Session, Settings, View, ViewInput } from '../packages/core/src/planner';
import { resolveLanes } from '../packages/core/src/planner';
import type { AppState, Draft, SendResult } from './state';

/**
 * How the shell and the UI modules meet. Shell.ts imports the three panels, the list picker and the date sheet directly;
 * this file is their whole contract with it.
 *
 *   app/panels/DayPanel.ts, WeekPanel.ts, MonthPanel.ts   export html(ctx) and mount(root, ctx)       (PanelModule)
 *   app/panels/chores/ChoresView.ts                       the same, a phone's page drawn instead of the panel while ctx.chores is on
 *   app/picker/ListPicker.ts                              exports mount(root, ctx)                      (PickerModule)
 *   app/components/DateSheet.ts                           exports openDateSheet(ctx)                    (DateSheetModule)
 *
 * Rules for a panel:
 * - html(ctx) returns markup built from core view models (dayView, weekView, monthView) and escapes every
 *   stored string with esc(). mount(root, ctx) wires events inside root and returns what undoes it.
 * - Writes go through ctx.send(). The shell redraws the whole panel (html, then mount) when data changes, but never while
 *   a write is in flight, a text field or select inside it has focus, or a pointer is down;
 *   it redraws once that ends, after the code that awaited ctx.send() has run. A redraw puts the keyboard focus back on
 *   the same control (same tag and class, same row, same position) unless mount() moved the focus itself, so a panel need
 *   not do that for a plain button or checkbox. Keep unsent text in ctx.drafts (keyed by note key) or in the module, and
 *   read it back in html(): a redraw starts from html().
 * - An item is edited where it stands: the panel keeps the one open edit in its module (inplace/session.ts) and html() draws that
 *   row as a field, so a redraw never takes it down. No window opens for content.
 * - Mark every control that writes with the data-writes attribute; the shell disables them while a write runs.
 * - Colors come from data-c="<color key>" (styles/tones.css), never from inline styles.
 * - The shell gives the panel host a definite height on a phone (the top bar above, nothing below), so a panel
 *   can own its tab bar and scroll inside itself.
 */
export type PanelContext = {
  readonly state: AppState;
  readonly session: Session;
  /** The signed-in person. */
  readonly me: Person;
  readonly lists: readonly ListRecord[];
  readonly settings: Settings;
  readonly selection: Selection;
  /** Lane order: you, the other person, then overlays. */
  readonly lanes: Lane[];
  /** What dayView, weekView and monthView take (with today, the Day view of today carries earlier days' open to-dos). */
  readonly input: ViewInput;
  /** What dayChores, weekChores, monthChores and monthChoreGrid take: the snapshot's chart and today. There is no selection: chores are always for both of us. */
  readonly choreInput: ChoreInput;
  /** Whether Chores is on: a phone's Chores view shows instead of the planner's page (the shell draws ChoresView, not the panel of `view`); on a desktop it is the Day's Chores switch (the Day lists the chores in place of its to-dos). */
  readonly chores: boolean;
  /** Whether the page drawn is the phone's Chores view (the picker is locked on it): Chores is on at phone width, on the Day however it was turned on, on the Week and the Month only by the phone's own Chores tab. */
  readonly choresPage: boolean;
  readonly view: View;
  /** The view this Day was opened from (the Month), for the Back button; null otherwise. */
  readonly backTo: View | null;
  /** The open period: the day, the Monday or the first of the month. */
  readonly date: string;
  readonly today: string;
  /** The middle of the sidebar's date list. */
  readonly center: string;
  readonly busy: boolean;
  readonly drafts: Map<string, Draft>;
  /** One write. Resolves with the outcome; a failure has already been shown in the banner. */
  send(mutation: Mutation): Promise<SendResult>;
  setSelection(selection: Selection): void;
  /** Turns Chores on or off; from a phone it is that width's Chores tab, from a desktop the Day's switch. */
  setChores(on: boolean): void;
  go(date: string, recenter?: boolean): void;
  setView(view: View): void;
  /** Opens a day on the Day view from `from`, so Back can return there. */
  openDay(date: string, from: View): void;
  goBack(): void;
  /** Shows a message in the banner (a panel's own validation). */
  report(message: string): void;
  /** Asks for a render at the next quiet moment. */
  rerender(): void;
  /** Says something to a screen reader (a polite live region that outlives a redraw of the panel). */
  announce(message: string): void;
};
export type Unmount = () => void;
export interface PanelModule {
  html(ctx: PanelContext): string;
  mount(root: HTMLElement, ctx: PanelContext): Unmount;
  /** A phone panel's tab bar chooses the tab it shows next time: the Chores view leaves by another tab of the planner. */
  showTab?(tab: string): void;
  /** Whether the panel holds words that were never saved and are not necessarily on the page (a to-do put away after a refused save, the add box of another day): the page does not reload itself over them. */
  unsent?(): boolean;
}
export interface PickerModule { mount(root: HTMLElement, ctx: PanelContext): Unmount }
export interface DateSheetModule { openDateSheet(ctx: PanelContext): void }

export function makeContext(state: AppState, rerender: () => void, announce: (message: string) => void = () => {}): PanelContext {
  // What the view functions of core read as `data`: the snapshot with this person's own Both color in its settings (#138), rebuilt only when either changes.
  let held: { session: Session; settings: Settings; data: Session } | null = null;
  const personal = (): Session => {
    if (!held || held.session !== state.session || held.settings !== state.settings) { held = { session: state.session, settings: state.settings, data: { ...state.session, settings: state.settings } }; }
    return held.data;
  };
  return {
    state,
    get session() { return state.session; },
    get me() { return state.session.user; },
    get lists() { return state.session.lists; },
    get settings() { return state.settings; },
    get selection() { return state.selection; },
    get lanes() { return resolveLanes(state.selection, state.session.lists, state.session.user); },
    get input() { return { data: personal(), selection: state.selection, me: state.session.user, today: state.today }; },
    get choreInput() { return { data: personal(), today: state.today }; },
    get chores() { return state.chores; },
    get choresPage() { return state.chores && isPhone() && (state.view === 'day' || state.choresTab); },
    get view() { return state.view; },
    get backTo() { return state.backTo; },
    get date() { return state.date; },
    get today() { return state.today; },
    get center() { return state.center; },
    get busy() { return state.busy; },
    drafts: state.drafts,
    send: mutation => state.send(mutation),
    setSelection: selection => state.setSelection(selection),
    setChores: on => state.setChores(on, isPhone()),
    go: (date, recenter) => state.go(date, recenter),
    setView: view => state.setView(view),
    openDay: (date, from) => state.openDay(date, from),
    goBack: () => state.goBack(),
    report: message => state.report(message),
    rerender,
    announce,
  };
}

/** The phone layout (the media query the stylesheets use): a panel chooses its markup by it, and redraws when it flips. */
export const isPhone = () => window.matchMedia('(max-width: 760px)').matches;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** What the shell never draws a panel again under, and what a row being closed must therefore swap by itself. */
export const TEXT_FIELD = 'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]),textarea,select,[contenteditable=true]';

/** Escape a stored string for markup, in text and in quoted attributes. */
export const esc = (value: string) => value.replace(/[&<>"']/g, c => ESCAPES[c]);

const svg = (path: string, size = 20) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
/** Inline icons, drawn with currentColor. */
export const icons = {
  menu: svg('<path d="M4 6h16M4 12h16M4 18h16"/>'),
  left: svg('<path d="m14 6-6 6 6 6"/>'),
  right: svg('<path d="m10 6 6 6-6 6"/>'),
  close: svg('<path d="m6 6 12 12M18 6 6 18"/>'),
  calendar: svg('<rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4m8-4v4M4 10h16"/>'),
  calmind: svg('<rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4m8-4v4M4 10h16"/>', 14),
  check: svg('<path d="m5 12 5 5 9-10"/>', 25),
  done: svg('<path d="M20 6 9 17l-5-5"/>', 18),
  chevronDown: svg('<path d="m6 9 6 6 6-6"/>', 14),
  trash: svg('<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10.5 10.5v6M13.5 10.5v6"/>', 16),
  /** A window with its left panel marked: the sidebar toggle. */
  sidebar: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>'),
};
