import { dayLabel, people, periodStart, periodWindow } from '../../packages/core/src/planner';
import { monthShort, weekRange } from '../dates';
import { esc, icons, type PanelContext } from '../panelContext';
import { accountMenuHtml } from './AccountMenu';

/**
 * What the phone's menu shows for the Day schedule: the half of the day and CalMind's events. `show` is true on a phone's Day Schedule tab only;
 * the Shell reads it from the Day panel, and `setHalf` and `toggleCalmind` act on it (the Shell draws the panel again).
 */
export type DayTools = { read(): { show: boolean; half: 'am' | 'pm'; calmind: boolean }; setHalf(half: 'am' | 'pm'): void; toggleCalmind(): void };

export type Drawer = { open(): void; close(): void; readonly isOpen: boolean };

/** The phone drawer: the sidebar slides over the page, the page goes inert, focus stays inside. */
export function createDrawer(): Drawer {
  let isOpen = false;
  const $ = (id: string) => document.getElementById(id)!;
  return {
    get isOpen() { return isOpen; },
    open() {
      isOpen = true; document.body.classList.add('drawer-open'); $('content').inert = true;
      $('sidebar').setAttribute('role', 'dialog'); $('sidebar').setAttribute('aria-modal', 'true');
      $('menu').setAttribute('aria-expanded', 'true'); $('drawer-close').focus();
      $('dates').querySelector('.date-row.selected')?.scrollIntoView({ block: 'center' });
    },
    close() {
      if (!isOpen) { return; }
      isOpen = false; document.body.classList.remove('drawer-open'); $('content').inert = false;
      $('sidebar').removeAttribute('role'); $('sidebar').removeAttribute('aria-modal');
      $('menu').setAttribute('aria-expanded', 'false'); $('menu').focus();
    },
  };
}

/** The two people as the footer names them, the owner first: their lists' stored names (each one's id, capitalized). */
const footerNames = (ctx: PanelContext) => {
  const { owner, partner } = people();
  return [owner, partner].map(id => esc(ctx.lists.find(l => l.id === id)?.name ?? '')).join(' &amp; ');
};

export const sidebarHtml = (ctx: PanelContext) => `<button id="scrim" class="scrim" aria-label="Close menu"></button>
<aside id="sidebar" class="sidebar" aria-label="Menu">
  <div class="sidebar-brand"><img class="brand-small" src="./icon.svg" alt="" width="30" height="30"><strong>PlanMind</strong><button id="drawer-close" class="icon-button mobile-only" aria-label="Close menu">${icons.close}</button></div>
  <div class="view-switch" role="group" aria-label="Planner view"><button data-view="month" aria-pressed="false">Month</button><button data-view="week" aria-pressed="false">Week</button><button data-view="day" aria-pressed="true">Day</button></div>
  <div class="sidebar-heading"><span id="month-label"></span><button id="today" class="quiet-button">Today</button></div>
  <div class="week-nav"><button id="earlier" class="icon-button" aria-label="Earlier dates">${icons.left}</button><span id="dates-heading">Your days</span><button id="later" class="icon-button" aria-label="Later dates">${icons.right}</button></div>
  <nav id="dates" class="dates" aria-label="Choose a day"></nav>
  <div id="day-tools" class="drawer-day" role="group" aria-label="Schedule" hidden>
    <span class="drawer-day-label">Schedule</span>
    <div class="view-switch" role="group" aria-label="Part of the day"><button type="button" data-half="am" aria-pressed="true">AM</button><button type="button" data-half="pm" aria-pressed="false">PM</button></div>
    <button type="button" id="calmind-switch" class="drawer-switch" role="switch" aria-checked="true"><span class="drawer-switch-icon" aria-hidden="true">${icons.calmind}</span><span class="drawer-switch-label">CalMind events</span><span class="picker-toggle" aria-hidden="true"></span></button>
  </div>
  <div class="drawer-account">${accountMenuHtml(ctx, 'drawer')}</div>
  <div class="sidebar-footer"><span class="private-dot"></span><span>${footerNames(ctx)}</span></div>
</aside>`;

// Sentence case, as the wireframes write them.
const HEADINGS = { day: 'Your days', week: 'Monday–Sunday', month: 'Your months' } as const;

export function mountSidebar(root: HTMLElement, ctx: PanelContext, drawer: Drawer, tools: DayTools) {
  const $ = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const selectedRow = () => $('#dates').querySelector('.date-row.selected');
  const abort = new AbortController();
  const on = { signal: abort.signal };

  // The rows are rebuilt only when the list itself changes, so a poll leaves them (and a keyboard user's focus) where they are.
  let shape = '';
  function draw() {
    const { view, date, center, today } = ctx;
    const next = [view, date, center, today].join('|');
    if (next === shape) { return; }
    shape = next;
    $('#month-label').textContent = dayLabel(center, { month: 'long', year: 'numeric' });
    $('#dates-heading').textContent = HEADINGS[view];
    root.querySelectorAll<HTMLElement>('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
    const rows = periodWindow(center, view).map(d => {
      const current = d === periodStart(today, view), year = d.slice(0, 4);
      // One line, as the wireframes draw it: "26  Monday", "26  Oct 26–Nov 1", "10  Oct 2026".
      const label = view === 'week' ? `${weekRange(d)}, ${year}, Monday to Sunday${current ? ', This week' : ''}`
        : view === 'month' ? dayLabel(d, { month: 'long', year: 'numeric' }) + (current ? ', This month' : '')
        : dayLabel(d, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) + (current ? ', Today' : '');
      const number = view === 'month' ? d.slice(5, 7) : d.slice(-2);
      const name = view === 'week' ? weekRange(d) : view === 'month' ? monthShort(d) : current ? 'Today' : dayLabel(d, { weekday: 'long' });
      return `<button type="button" class="date-row${d === date ? ' selected' : ''}" data-date="${d}" aria-current="${d === date ? 'date' : 'false'}" aria-label="${esc(label)}"><span class="date-number">${number}</span><span class="date-label">${esc(name)}</span></button>`;
    });
    $('#dates').innerHTML = rows.join('');
  }

  // The Day's schedule choices. Choosing closes the menu (focus goes back to the hamburger) so the page shows the result, and a screen reader hears it.
  function drawTools() {
    const now = tools.read();
    $('#day-tools').hidden = !now.show;
    root.querySelectorAll<HTMLElement>('#day-tools [data-half]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.half === now.half)));
    $('#calmind-switch').setAttribute('aria-checked', String(now.calmind));
  }
  root.querySelectorAll<HTMLElement>('#day-tools [data-half]').forEach(button => button.addEventListener('click', () => {
    const half = button.dataset.half === 'pm' ? 'pm' : 'am';
    drawer.close(); tools.setHalf(half); ctx.announce(`${half === 'pm' ? 'PM' : 'AM'}: the schedule shows ${half === 'pm' ? '9p to 7a' : '7a to 9p'}.`); ctx.rerender();
  }, on));
  $('#calmind-switch').addEventListener('click', () => {
    const next = $('#calmind-switch').getAttribute('aria-checked') !== 'true';
    drawer.close(); tools.toggleCalmind(); ctx.announce(`CalMind events ${next ? 'shown' : 'hidden'}.`);
  }, on);
  $('#dates').addEventListener('click', event => {
    const date = (event.target as HTMLElement).closest<HTMLElement>('.date-row')?.dataset.date;
    if (date) { ctx.go(date); drawer.close(); }
  }, on);
  root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.addEventListener('click', () => ctx.setView(button.dataset.view as 'day' | 'week' | 'month'), on));
  $('#today').addEventListener('click', () => { ctx.go(ctx.today, true); selectedRow()?.scrollIntoView({ block: 'center' }); }, on);
  $('#earlier').addEventListener('click', () => ctx.state.shiftCenter(-7), on);
  $('#later').addEventListener('click', () => ctx.state.shiftCenter(7), on);
  $('#drawer-close').addEventListener('click', () => drawer.close(), on);
  $('#scrim').addEventListener('click', () => drawer.close(), on);
  document.addEventListener('keydown', event => {
    // A window over the drawer (Settings) takes the Escape, and the Tab, itself.
    if (!drawer.isOpen || document.querySelector('dialog[open]')) { return; }
    if (event.key === 'Escape') { event.preventDefault(); drawer.close(); }
    if (event.key === 'Tab') {
      const buttons = [...$('#sidebar').querySelectorAll<HTMLButtonElement>('button')].filter(b => b.getClientRects().length);
      const first = buttons[0], last = buttons.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }, on);
  window.matchMedia('(min-width: 761px)').addEventListener('change', event => { if (event.matches) { drawer.close(); } }, on);

  return {
    draw,
    drawTools,
    /**
     * Shows or hides the sidebar on a desktop (from 761px; the phone's drawer is not part of it). Hidden, it is display:none,
     * so it is out of the tab order and the accessibility tree; focus that was inside it goes to `fallback`.
     */
    drawVisibility(hidden: boolean, fallback: () => void) {
      root.classList.toggle('sidebar-collapsed', hidden);
      if (hidden && $('#sidebar').contains(document.activeElement)) { fallback(); }
      if (!hidden) { selectedRow()?.scrollIntoView({ block: 'center' }); }
    },
    scrollToSelected() { selectedRow()?.scrollIntoView({ block: 'center' }); },
    dispose() { abort.abort(); },
  };
}
