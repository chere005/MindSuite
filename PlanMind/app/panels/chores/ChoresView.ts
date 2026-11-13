import '../../styles/chores.css';
import '../../styles/day.css';
import '../../styles/weekmonth.css';
import { PHONE_TABS, type View } from '../../../packages/core/src/planner';
import type { PanelContext, Unmount } from '../../panelContext';
import { dayTabsHtml } from '../day/DayTabs';
import { tabBarHtml } from '../week/PhoneTabs';
import { mountRows } from './ChoreRow';
import * as day from './DayChores';
import * as month from './MonthChores';
import * as week from './WeekChores';

/**
 * The Chores view: the household chart as a page of a phone's own, drawn by the shell instead of the Day, Week or Month panel while chores
 * mode is on (state.chores) at phone width. The planner's panels know nothing of it beyond their Chores tab, and chores ignore the picker: both
 * of us see every chore. It shows the open period (state.view and state.date), so the drawer, the arrows and the date sheet keep working; it
 * draws that period's bar at the bottom with Chores chosen, and leaves by another tab of it (`leave` hands that tab to the planner's panel).
 * A desktop never draws it: there the Day swaps its To-do list for the chores (day/ChoresSection.ts) and the Month calendar carries them.
 */

/** The bar of each period, with the id of the page it controls (the Day's tab panel, or the Week's and Month's Chores section). */
const BAR: Record<View, { tabs: readonly string[]; html: () => string; panel: string; labelled: string }> = {
  day: { tabs: PHONE_TABS.day, html: () => dayTabsHtml('chores'), panel: 'day-tabpanel', labelled: 'day-tab-chores' },
  week: { tabs: PHONE_TABS.week, html: () => tabBarHtml('Week sections', PHONE_TABS.week, 'chores'), panel: 'wm-sec-chores', labelled: 'wm-tab-chores' },
  month: { tabs: PHONE_TABS.month, html: () => tabBarHtml('Month sections', PHONE_TABS.month, 'chores'), panel: 'wm-sec-chores', labelled: 'wm-tab-chores' },
};
/** Set while the markup is built: the keyboard was on the bar (the Chores tab, which is all that has it), so the redrawn bar gets it back. */
let refocus = false;

function content(ctx: PanelContext): string {
  switch (ctx.view) {
    case 'day': return `<div class="ch-day">${day.html(ctx)}</div>`;
    case 'week': return week.html(ctx);
    case 'month': return month.listHtml(ctx);
  }
}

export function html(ctx: PanelContext): string {
  const view = ctx.view;
  refocus = document.activeElement instanceof HTMLElement && document.activeElement.getAttribute('role') === 'tab';
  const bar = BAR[view];
  // The Day's page holds the one list that scrolls inside itself; the Week's and the Month's scroll as a whole (the shell keeps their place across a redraw).
  const scroll = view === 'day' ? '' : ' ch-scroll';
  return `<div class="ch-view" data-panel="chores" data-layout="phone" data-period="${view}" data-tab="${view}">
  <div class="ch-body${scroll}" role="tabpanel" id="${bar.panel}" aria-labelledby="${bar.labelled}">${content(ctx)}</div>
  ${bar.html()}</div>`;
}

export function mount(root: HTMLElement, ctx: PanelContext, leave: (tab: string) => void): Unmount {
  const view = root.querySelector<HTMLElement>('.ch-view')!;
  const abort = new AbortController();
  const unmountRows = mountRows(view, ctx);
  const tabs = BAR[ctx.view].tabs, buttons = [...view.querySelectorAll<HTMLElement>('[role=tab]')];
  // Chores is the chosen tab, so any other one leaves; the arrow keys, Home and End move over the bar as they do on the planner's.
  buttons.forEach((button, i) => {
    button.addEventListener('click', () => { if (button.dataset.tab !== 'chores') { leave(button.dataset.tab!); } }, { signal: abort.signal });
    button.addEventListener('keydown', event => {
      const to = event.key === 'ArrowRight' ? (i + 1) % tabs.length : event.key === 'ArrowLeft' ? (i + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
      if (to < 0) { return; }
      event.preventDefault();
      if (tabs[to] !== 'chores') { leave(tabs[to]); }
    }, { signal: abort.signal });
  });
  if (refocus) { refocus = false; view.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus(); }
  return () => { abort.abort(); unmountRows(); };
}
