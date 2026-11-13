import '../styles/day.css';
import { PHONE_TABS, dayView, type DayTab, type Lane, type ListRecord } from '../../packages/core/src/planner';
import { markRedraw } from '../inplace/Inline';
import { esc, isPhone, type PanelContext, type Unmount } from '../panelContext';
import * as notes from './day/DayNotes';
import { dayTabsHtml } from './day/DayTabs';
import { edits } from './day/edits';
import * as priorities from './day/PrioritiesSection';
import * as schedule from './day/ScheduleSection';
import * as chores from './day/ChoresSection';
import * as todo from './day/TodoSection';

/**
 * The Day panel: a composition of the schedule, priorities, to-do and notes sections. On a desktop they sit in two
 * columns (schedule and notes, priorities and to-do). On a phone they are the three bottom tabs of PHONE_TABS.day, and
 * the schedule timeline scrolls inside its tab. On a desktop the picker's Chores switch (ctx.chores) swaps the To-do section for the
 * day's chores (day/ChoresSection.ts); the rest follows the picker's lists as ever. A phone never draws this panel with Chores on: the shell draws its Chores view.
 *
 * The sections get a Kit instead of importing each other: lane header, counters and the save-button guard are the few pieces
 * more than one section needs. Who a new item is for comes from the top picker (newOwners); an edit never changes it (a schedule entry changes owners only by a drag or Alt+Left / Alt+Right across the Both view's thirds, ScheduleSection). Every
 * item is edited where it stands (day/edits.ts holds the one that is open; no window is opened for content).
 */

/** Column count class for a lane grid (n1 to n4, the most lanes a view can have). */
export const laneCols = (count: number) => `n${Math.min(Math.max(count, 1), 4)}`;
export const laneClass = (lane: number, span: 1 | 2 = 1) => `l${lane}${span === 2 ? ' w2' : ''}`;
export const listName = (lists: readonly ListRecord[], id: string) => lists.find(l => l.id === id)?.name ?? 'That list';

// ---- the kit --------------------------------------------------------------------------------------------------

export type Kit = {
  readonly phone: boolean;
  /** n1 to n4: the column class of a lane grid. */
  cols(count: number): string;
  /** l0 to l3 (and w2 for an entry spanning two lanes): the column of a cell in a lane grid. */
  lane(index: number, span?: 1 | 2): string;
  nameOf(listId: string): string;
  /** The lane names row; `corner` is a small word over the hour labels (the half of the day the schedule shows, on a phone). */
  laneHead(lanes: readonly Lane[], corner?: string): string;
  /** Sets a "14 / 18" counter element. */
  setCount(el: Element, text: string, over: boolean): void;
  /** Keeps a Save/Add button disabled while `valid()` is false or a write is in flight. Returns the way to stop. */
  guard(button: HTMLButtonElement, valid: () => boolean): () => void;
  /** Re-checks every guarded button (after a field changed). */
  refresh(): void;
};

const laneHead = (lanes: readonly Lane[], corner = '') => `<div class="day-lanehead ${laneCols(lanes.length)}" aria-hidden="true">${corner ? `<span class="day-corner" data-corner="${esc(corner)}">${esc(corner)}</span>` : ''}${
  lanes.map(l => `<span class="day-lane" data-c="${l.color}"><i class="day-sw"></i><span>${esc(l.name)}${l.you ? ' · you' : ''}</span></span>`).join('')}</div>`;

function makeKit(ctx: PanelContext): Kit & { closeAll(): void } {
  const guards = new Set<() => void>();
  const refresh = () => guards.forEach(run => run());
  return {
    phone: isPhone(),
    cols: laneCols,
    lane: laneClass,
    nameOf: id => listName(ctx.lists, id),
    laneHead,
    setCount(el, text, over) { el.textContent = text; (el as HTMLElement).dataset.over = String(over); },
    guard(button, valid) {
      const run = () => { button.disabled = ctx.busy || !valid(); };
      guards.add(run); run();
      return () => { guards.delete(run); };
    },
    refresh,
    closeAll() { guards.clear(); },
  };
}

// ---- the panel --------------------------------------------------------------------------------------------------

let tab: DayTab = 'schedule';
/** Set when a tab was chosen, so the redrawn bar gives the focus back to the tab that is now chosen. */
let refocus = false;
/** The Chores view hands the tab back: the next time this panel draws it is that tab. */
export const showTab = (next: string) => { if ((PHONE_TABS.day as readonly string[]).includes(next)) { tab = next as DayTab; } };

/** The phone tab on the screen, and the schedule's half: the phone menu shows its AM and PM switch and CalMind switch only on the Schedule tab. */
export const phoneTab = (): DayTab => tab;
export const half = schedule.half;
export const setHalf = schedule.setHalf;

/** Whether the Day holds words that were not saved and may not be on the page: the add field, an item put away with its save refused. */
export const unsent = () => edits.unsent || todo.unsentAdd();

export function html(ctx: PanelContext): string {
  const view = dayView(ctx.input, ctx.date);
  const kit = makeKit(ctx);
  // An edit belongs to its day and to an item that is on the page: another day, or a list chosen that hides it, puts it away.
  edits.page(ctx.date);
  const choresShown = !kit.phone && ctx.chores;
  const visible = new Set([...(choresShown ? [] : todo.keys(view)), ...priorities.keys(view), ...schedule.keys(view)]);
  edits.prune(key => visible.has(key));
  if (!kit.phone) {
    return `<div class="day-panel" data-panel="day" data-layout="wide"><div class="day-cols">
  <div class="day-col">${schedule.html(view, ctx, kit)}${notes.html(view, ctx, kit)}</div>
  <div class="day-col">${priorities.html(view, ctx, kit)}${choresShown ? chores.html(ctx) : todo.html(view, ctx, kit)}</div></div></div>`;
  }
  if (!PHONE_TABS.day.includes(tab)) { tab = PHONE_TABS.day[0]; }
  const body = tab === 'schedule' ? schedule.html(view, ctx, kit) : tab === 'todo' ? priorities.html(view, ctx, kit) + todo.html(view, ctx, kit) : notes.html(view, ctx, kit);
  return `<div class="day-panel" data-panel="day" data-layout="phone" data-tab="${tab}">
  <div class="day-body" role="tabpanel" id="day-tabpanel" aria-labelledby="day-tab-${tab}">${body}</div>
  ${dayTabsHtml(tab)}</div>`;
}

export function mount(root: HTMLElement, ctx: PanelContext): Unmount {
  const panel = root.querySelector<HTMLElement>('.day-panel')!;
  const abort = new AbortController();
  const kit = makeKit(ctx);
  const unmountSchedule = schedule.mount(panel, ctx, kit);
  priorities.mount(panel, ctx, kit);
  const unmountNotes = notes.mount(panel, ctx, kit);
  const unmountTodo = todo.mount(panel, ctx, kit);
  const unmountChores = chores.mount(panel, ctx);
  // After Enter or Escape on a row the keyboard goes back to that item's button (the redraw that follows a save has made it again).
  // A to-do whose day was changed is not in this list any more: the keyboard goes to the add field instead, or the first to-do when the list is full.
  const back = edits.takeBack();
  if (back) {
    const to = panel.querySelector<HTMLElement>(`:is(button,input)[data-key="${back}"]`)
      ?? (back.startsWith('todo:') ? panel.querySelector<HTMLElement>('[data-key="todo:add"]') ?? panel.querySelector<HTMLElement>('.day-todo .day-task-title') : null);
    to?.focus({ preventScroll: true });
  }
  // The bar is redrawn with the panel, so the chosen tab asks for the focus back; arrow keys, Home and End move as in Week and Month.
  const tabs = PHONE_TABS.day;
  // Chores is not a section of this panel: its tab hands the page to the Chores view (the bar there has the focus).
  const pick = (next: DayTab, button?: HTMLElement) => {
    if (next === 'chores') { button?.focus(); ctx.setChores(true); return; }
    tab = next; refocus = true; ctx.rerender();
  };
  const buttons = [...panel.querySelectorAll<HTMLElement>('.day-tab')];
  buttons.forEach((button, i) => {
    button.addEventListener('click', () => pick(button.dataset.tab as DayTab, button));
    button.addEventListener('keydown', event => {
      const to = event.key === 'ArrowRight' ? (i + 1) % tabs.length : event.key === 'ArrowLeft' ? (i + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
      if (to >= 0) { event.preventDefault(); pick(tabs[to], buttons[to]); }
    });
  });
  if (refocus) { refocus = false; panel.querySelector<HTMLElement>(`#day-tab-${tab}`)?.focus(); }
  // The layout is chosen when the markup is built, so crossing the phone breakpoint builds it again.
  window.matchMedia('(max-width: 760px)').addEventListener('change', () => ctx.rerender(), { signal: abort.signal });
  const off = ctx.state.subscribe(change => { if (change === 'busy') { kit.refresh(); } });
  return () => { markRedraw(); abort.abort(); off(); unmountSchedule(); unmountNotes(); unmountTodo(); unmountChores(); kit.closeAll(); };
}
