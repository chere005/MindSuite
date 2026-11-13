import '../styles/shell.css';
import { dayLabel, monthChoreGrid, periodStart, shiftPeriod, weekLetter, type View } from '../../packages/core/src/planner';
import { weekRange } from '../dates';
import { setTheme } from '../colors';
import { icons, isPhone, makeContext, TEXT_FIELD, type PanelModule, type Unmount } from '../panelContext';
import type { AppState } from '../state';
import { openDateSheet } from '../components/DateSheet';
import { encodePlace } from '../place';
import * as choresView from '../panels/chores/ChoresView';
import * as day from '../panels/DayPanel';
import * as month from '../panels/MonthPanel';
import * as week from '../panels/WeekPanel';
import * as listPicker from '../picker/ListPicker';
import { orphanDrafts, unsavedDrafts } from '../panels/week/noteDraft';
import { mayRedraw } from './redraw';
import { createDrawer, mountSidebar, sidebarHtml } from './Sidebar';
import { mountTopBar, topBarHtml } from './TopBar';

const PANELS: Record<View, PanelModule> = { day, week, month };
/** The scroll areas inside a panel that a redraw must not reset (the panel host itself is one too). */
const SCROLL_AREAS = '.day-timeline, .day-tasks, .wm-body, .wm-side, .wm-todos, .ch-scroll, .wm-chores, .wm-notes .wm-lanes';

/** The small line and the heading above the panel: the desktop page header, and screen-reader text on a phone. */
function headings(view: View, date: string, today: string): { eyebrow: string; title: string } {
  if (view === 'week') { return { eyebrow: `${weekRange(date, ' – ')} · ${date.slice(0, 4)} · Mon to Sun`, title: date === periodStart(today, 'week') ? 'This week' : weekRange(date) }; }
  if (view === 'month') { return { eyebrow: date.slice(0, 4), title: dayLabel(date, { month: 'long' }) }; }
  return { eyebrow: dayLabel(date, { month: 'long', day: 'numeric', year: 'numeric' }), title: date === today ? 'Today' : dayLabel(date, { weekday: 'long' }) };
}

/** The sign-in screens the page falls back to. Private rows are gone from the DOM when these show. */
export function renderClosed(root: HTMLElement) {
  document.body.classList.remove('drawer-open');
  root.innerHTML = '<main class="login"><h1>Sign in again</h1><p class="dim">Your private list has been closed.</p><a class="primary" href="./">Sign in</a></main>';
}
export function renderUnavailable(root: HTMLElement) {
  root.innerHTML = '<main class="login"><h1>Unable to open your day</h1><p class="dim">Your saved list is preserved. Reconnect and try again.</p><a class="primary" href="./">Try again</a></main>';
}

/** Builds the page and keeps it in step with the state. `tab` is the phone tab a page that reloaded itself puts the person back on. Returns what takes it down again. */
export function mountShell(root: HTMLElement, state: AppState, tab?: string | null): () => void {
  let unmount: Unmount | undefined, pending = false, panelAsked = false, pointerDown = false, touching = false;
  const ctx = makeContext(state, () => { pending = true; panelAsked = true; later(); }, message => {
    // Emptied first, so the same words said twice are read twice.
    const live = root.querySelector<HTMLElement>('#live')!;
    live.textContent = '';
    setTimeout(() => { live.textContent = message; }, 50);
  });
  setTheme(state.session.theme);
  // A page that reloaded itself with Chores on at phone width was on the phone's own tab (place.ts keeps only the flag).
  if (state.chores && isPhone()) { state.setChores(true, true); }
  root.innerHTML = `${sidebarHtml(ctx)}
<main id="content" class="content">
  ${topBarHtml(ctx)}
  <section class="page" aria-labelledby="day-title">
    <div class="page-header"><div class="titles"><h1 id="day-title"></h1><p class="eyebrow" id="full-date"></p></div>
      <div class="header-actions"><button id="prev-day" class="icon-button" type="button">${icons.left}</button><label class="date-jump" title="Jump to date">${icons.calendar}<input id="jump-date" type="date" aria-label="Jump to date" min="2000-01-01" max="2099-12-31"></label><button id="next-day" class="icon-button" type="button">${icons.right}</button></div></div>
    <div class="banner-slot"><div id="error" class="error-banner" role="alert" hidden><span id="error-message"></span><button id="refresh" class="text-button" type="button">Refresh</button></div></div>
    <div id="period-panel"></div>
    <p id="live" class="sr-only" role="status" aria-live="polite"></p>
  </section>
</main>`;
  const $ = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const host = $('#period-panel');
  const abort = new AbortController();
  const on = { signal: abort.signal };

  // Chores is a page of its own on a phone only (its Chores tab): that page leaves by another tab of the period's bar, which is the planner's tab next, and it has the focus.
  // A desktop never draws it: with the flag on the Day lists the chores in place of its to-dos, and the Month always shows them.
  const chores: PanelModule = {
    html: choresView.html,
    mount: (root, c) => choresView.mount(root, c, tab => {
      PANELS[state.view].showTab?.(tab);
      state.setChores(false);
      host.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus();
    }),
  };

  const drawer = createDrawer();
  const sidebar = mountSidebar(root, ctx, drawer, {
    read: () => ({ show: state.view === 'day' && isPhone() && !choresPage() && day.phoneTab() === 'schedule', half: day.half(), calmind: !state.calmindHidden }),
    setHalf: half => day.setHalf(half),
    toggleCalmind: () => { void state.setCalmindHidden(!state.calmindHidden); },
  });
  const topBar = mountTopBar(root, ctx, drawer, { picker: listPicker, dateSheet: { openDateSheet } });

  const listIds = () => new Set(state.session.lists.map(list => list.id));
  /** Whether the page shown is the phone's Chores view: the flag is on and the window is a phone (on the Week and the Month only when the phone's own tab turned it on, never the Day's switch). Widening the window with it on lands on the planner, the Day with its switch on. */
  const choresPage = () => ctx.choresPage;
  // The panel is rendered from scratch whenever the data changes, but not while that would cost the person something:
  // a write is in flight, a text field has focus or a pointer is down. It waits, then renders.
  // A redraw the panel itself asked for (a tab, an edit opened) does not wait for the writes the screen already answers (they are laid over the snapshot), only for one it cannot show.
  const quiet = () => mayRedraw({
    asked: panelAsked, busy: state.busy, queued: state.queued, settling: state.settling, pointerDown,
    textFocused: host.contains(document.activeElement?.matches(TEXT_FIELD) ? document.activeElement : null),
  });
  const syncBusy = () => host.querySelectorAll<HTMLButtonElement | HTMLInputElement>('[data-writes]').forEach(control => { control.disabled = state.busy; });
  /**
   * Remembers which control of the panel has the focus and returns what puts the focus on its twin in the new markup, so a
   * redraw (a poll with the other person's change, the end of a pending render) does not drop a keyboard or screen-reader
   * user's place. The twin is the element with the same tag and class in the same row (the closest [data-id]), or in the
   * whole panel when it has no row, at the same position among them. A panel that moved the focus itself while it mounted keeps it.
   */
  function rememberFocus(): () => void {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || el === host || !host.contains(el)) { return () => {}; }
    const rowId = el.closest<HTMLElement>('[data-id]')?.dataset.id;
    const twins = () => [...host.querySelectorAll<HTMLElement>(el.tagName.toLowerCase())]
      .filter(c => c.className === el.className && (rowId === undefined || c.closest<HTMLElement>('[data-id]')?.dataset.id === rowId));
    const at = twins().indexOf(el);
    return () => {
      const now = document.activeElement;
      if (now instanceof HTMLElement && now !== document.body && host.contains(now)) { return; }
      twins()[at]?.focus({ preventScroll: true });
    };
  }
  /**
   * Remembers how far the panel's scroll areas and the panel itself
   * are scrolled and returns what scrolls them back in the new markup, so a redraw (checking a row, opening or closing an edit, a poll with
   * the other person's change) does not throw a long list back to its top. It does so only for the same view, day and tab: going to
   * another day, tab or half of the schedule starts at the top.
   */
  function rememberScroll(): () => void {
    const root = () => host.querySelector<HTMLElement>('[data-panel]');
    const where = () => `${root()?.dataset.panel}|${state.date}|${root()?.dataset.tab ?? ''}|${host.querySelector<HTMLElement>('.day-sched')?.dataset.half ?? ''}`;
    const areas = () => [host, ...host.querySelectorAll<HTMLElement>(SCROLL_AREAS)];
    const [was, tops] = [where(), areas().map(area => [area === host ? '' : area.className, area.scrollTop, area.scrollLeft] as const)];
    return () => {
      if (where() !== was) { return; }
      areas().forEach((area, i) => {
        const [name, top, left] = tops[i] ?? ['', 0, 0];
        if (name !== (area === host ? '' : area.className)) { return; }
        if (top > 0) { area.scrollTop = top; }
        if (left > 0) { area.scrollLeft = left; }
      });
    };
  }
  /**
   * Brings a control the panel focused while it drew (the field of a row opened for editing, the add field, the item the keyboard returns to)
   * into the view of the scroll areas it is in, the nearest bit that shows it: the scroll was put back after the panel's own focus() scrolled.
   */
  function reveal(el: HTMLElement) {
    for (let area = el.parentElement; area && area !== document.body; area = area.parentElement) {
      if (area.scrollHeight > area.clientHeight && /auto|scroll/.test(getComputedStyle(area).overflowY)) {
        const [frame, box] = [area.getBoundingClientRect(), el.getBoundingClientRect()];
        const style = getComputedStyle(area);
        const top = frame.top + (parseFloat(style.scrollPaddingTop) || 0), bottom = frame.bottom - (parseFloat(style.scrollPaddingBottom) || 0);
        if (box.top < top) { area.scrollTop -= top - box.top; } else if (box.bottom > bottom) { area.scrollTop += box.bottom - bottom; }
      }
      if (area === host) { break; }
    }
  }
  function render(force: boolean) {
    if (!force && !quiet()) { pending = true; return; }
    pending = false; panelAsked = false;
    const restoreFocus = rememberFocus(), restoreScroll = rememberScroll();
    unmount?.();
    // Chores replaces the page of the open period on a phone, and the planner's panels know nothing of it.
    const panel = choresPage() ? chores : PANELS[state.view];
    host.dataset.view = state.view;
    host.classList.toggle('wide-month', state.view === 'month');
    host.innerHTML = panel.html(ctx);
    unmount = panel.mount(host, ctx);
    sidebar.drawTools();
    syncBusy();
    const moved = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement : null;
    restoreScroll();
    if (moved) { reveal(moved); }
    restoreFocus();
  }
  // A macrotask later, so the code that awaited a write has already cleared its form.
  function later() { setTimeout(() => { if (pending) { render(false); } reloadForRelease(); }, 0); }
  /**
   * The host serves another release than this page started under (a deploy, or a rollback): load it, but only when that costs the
   * person nothing. While a field has the focus, a pointer or a finger is down, a write is in flight or waiting for its save (a picker,
   * sidebar or theme save too), an edit is open, a dialog is open, or any unsent words are held (a note, an add box on the page or on
   * another day, a to-do put away after a refused save), it waits for the next quiet moment (every redraw, response, focus change and
   * lifted finger asks again). The load puts the person back where they were (place.ts).
   */
  function reloadForRelease() {
    if (!state.alive || !state.newRelease || !quietForRelease()) { return; }
    const open = host.querySelector<HTMLElement>('[data-panel]');
    // The planner's phone tab is on the panel's markup; the Chores view's own `data-tab` is not one.
    const place = { view: state.view, date: state.date, chores: state.chores, back: state.backTo, tab: open && open.dataset.panel !== 'chores' ? open.dataset.tab ?? null : null };
    try { history.replaceState(null, '', encodePlace(place)); } catch { /* a page that cannot say where it was starts on today */ }
    location.reload();
  }
  const unsentAdd = () => [...host.querySelectorAll<HTMLInputElement>('input[data-key]')].some(field => field.value.trim() !== '');
  const quietForRelease = () => !state.writing && !pointerDown && !touching && !document.activeElement?.matches(TEXT_FIELD)
    && !host.querySelector('[data-ip=text]') && !unsentAdd() && !Object.values(PANELS).some(panel => panel.unsent?.())
    && !document.querySelector('dialog[open], .manager-page') && !unsavedDrafts(state.drafts, state.session.notes, listIds()).length;

  function drawHeader() {
    const { eyebrow, title } = headings(state.view, state.date, state.today);
    $('#full-date').textContent = choresPage() ? choresEyebrow(eyebrow) : eyebrow;
    $('#day-title').textContent = title;
    $<HTMLInputElement>('#jump-date').value = state.date;
    $('#prev-day').setAttribute('aria-label', `Previous ${state.view}`);
    $('#next-day').setAttribute('aria-label', `Next ${state.view}`);
  }
  /** The Chores view keeps the planner's heading and says which week of the rhythm it is on the Day and the Week, and on the Month how many of its turns are done. */
  function choresEyebrow(eyebrow: string): string {
    if (state.view !== 'month') { return `${eyebrow} · Week ${weekLetter(state.date, state.session.rhythm.anchor)}`; }
    const { done, total } = monthChoreGrid(ctx.choreInput, state.date);
    return total ? `${eyebrow} · ${done} of ${total} done` : eyebrow;
  }
  function drawStatus() {
    topBar.drawStatus();
    $('#error-message').textContent = state.error;
    $('#error').hidden = !state.error;
    seatBanner();
  }
  /**
   * On a phone the banner lies over the top bar's date and its arrows, between the menu (or Back) and the picker (#146): the AM/PM switch,
   * the lane names and the panel stay in sight, and nothing moves. Its place is that stretch of the bar as drawn now (Back is wider than
   * the menu), given to the stylesheet as --ban-top, --ban-left and --ban-right; a desktop's banner keeps its own place.
   */
  function seatBanner() {
    const banner = $('#error');
    const nav = root.querySelector<HTMLElement>('.phone-nav'), page = root.querySelector<HTMLElement>('.page');
    if (banner.hidden || !isPhone() || !nav || !page || !nav.getClientRects().length) { ['--ban-top', '--ban-left', '--ban-right'].forEach(k => banner.style.removeProperty(k)); return; }
    const n = nav.getBoundingClientRect(), p = page.getBoundingClientRect();
    banner.style.setProperty('--ban-top', `${Math.round(n.top - p.top)}px`);
    banner.style.setProperty('--ban-left', `${Math.round(n.left - p.left)}px`);
    banner.style.setProperty('--ban-right', `${Math.round(p.right - n.right)}px`);
  }
  window.addEventListener('resize', seatBanner, on);
  const step = (amount: number) => ctx.go(shiftPeriod(state.date, amount, state.view));
  const drawSidebar = () => { topBar.drawSidebarButton(); sidebar.drawVisibility(state.sidebar === 'hidden', topBar.focusSidebarButton); };

  $('#prev-day').addEventListener('click', () => step(-1), on);
  $('#next-day').addEventListener('click', () => step(1), on);
  $<HTMLInputElement>('#jump-date').addEventListener('change', event => { const value = (event.target as HTMLInputElement).value; if (value) { ctx.go(value, true); } }, on);
  $('#refresh').addEventListener('click', () => { state.dismissError(); void state.refresh(); }, on);
  host.addEventListener('focusout', later, on);
  // The page (the Chores view or the planner's) is chosen by the window's width, so crossing the phone breakpoint draws it again.
  window.matchMedia('(max-width: 760px)').addEventListener('change', () => { drawHeader(); topBar.draw(); ctx.rerender(); }, on);
  document.addEventListener('pointerdown', () => { pointerDown = true; }, { capture: true, signal: abort.signal });
  for (const type of ['pointerup', 'pointercancel']) { document.addEventListener(type, () => { pointerDown = false; later(); }, { capture: true, signal: abort.signal }); }
  // A finger on the screen is a pointer that is down even once the browser has taken its gesture for a scroll (it then cancels the pointer and the touch goes on).
  const touch = (event: TouchEvent) => { touching = event.touches.length > 0; if (!touching) { later(); } };
  for (const type of ['touchstart', 'touchend', 'touchcancel']) { document.addEventListener(type, touch as EventListener, { capture: true, passive: true, signal: abort.signal }); }
  // A dialog (the list manager, the rhythm) closing is a quiet moment too.
  document.addEventListener('close', later, { capture: true, signal: abort.signal });
  window.addEventListener('blur', () => { pointerDown = false; touching = false; }, on);
  // Leaving warns only for a draft that still holds something to lose: its list exists and its text differs from the saved note.
  window.addEventListener('beforeunload', event => { if (unsavedDrafts(state.drafts, state.session.notes, listIds()).length) { event.preventDefault(); event.returnValue = ''; } }, on);
  window.addEventListener('pageshow', event => { if (event.persisted) { location.reload(); } }, on);

  function dispose() {
    abort.abort();
    unsubscribe();
    unmount?.(); unmount = undefined;
    topBar.dispose(); sidebar.dispose();
  }
  const unsubscribe = state.subscribe(change => {
    if (change === 'closed') { dispose(); renderClosed(root); }
    else if (change === 'nav' || change === 'chores') { drawHeader(); topBar.draw(); seatBanner(); sidebar.draw(); render(true); }
    else if (change === 'data' || change === 'selection') {
      for (const key of orphanDrafts(state.drafts.keys(), listIds())) { state.drafts.delete(key); }
      drawHeader(); topBar.draw(); sidebar.draw(); render(false);
    }
    else if (change === 'busy') { syncBusy(); if (!state.queued || (panelAsked && !state.busy)) { later(); } }
    else if (change === 'sidebar') { drawSidebar(); }
    else if (change === 'theme') { setTheme(state.theme); }
    else { drawStatus(); reloadForRelease(); }
  });

  if (tab) { PANELS[state.view].showTab?.(tab); }
  drawHeader(); topBar.draw(); drawStatus(); sidebar.draw(); drawSidebar(); render(true);
  sidebar.scrollToSelected();
  state.start();
  return dispose;
}
