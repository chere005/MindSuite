import { dayLabel, shiftPeriod, type View } from '../../packages/core/src/planner';
import { weekRange } from '../dates';
import { icons, type DateSheetModule, type PanelContext, type PickerModule, type Unmount } from '../panelContext';
import { accountMenuHtml, drawAccount, mountAccountMenus } from './AccountMenu';
import type { Drawer } from './Sidebar';

const MODES: Record<View, string> = { day: 'Daily planner', week: 'Weekly planner', month: 'Monthly planner' };
const BACK_LABEL: Record<View, string> = { day: 'Day', week: 'Week', month: 'Month' };
/** What the date button opens, so its accessible name says more than the date. */
const CHOOSE: Record<View, string> = { day: 'Choose a date', week: 'Choose a week', month: 'Choose a month' };
/** The date in the phone top bar: "Fri, Oct 30", "Oct 26–Nov 1", "October 2026". */
const pillLabel = (view: View, date: string) =>
  view === 'week' ? weekRange(date) : view === 'month' ? dayLabel(date, { month: 'long', year: 'numeric' }) : dayLabel(date, { weekday: 'short', month: 'short', day: 'numeric' });

/** Top bar. Desktop: the sidebar button, planner name, status, the list picker, the account menu. Phone: menu, previous, date, next, the picker. */
export const topBarHtml = (ctx: PanelContext) => `<header class="topbar">
  <button id="back-view" class="back-button" type="button" hidden>${icons.left}<span id="back-label"></span></button>
  <button id="menu" class="icon-button mobile-only" aria-label="Open menu" aria-controls="sidebar" aria-expanded="false">${icons.menu}</button>
  <button id="sidebar-toggle" class="icon-button desktop-only" type="button" aria-controls="sidebar" aria-expanded="true" aria-label="Hide sidebar" title="Hide sidebar">${icons.sidebar}</button>
  <span id="mode-heading" class="eyebrow desktop-only"></span>
  <div class="phone-nav mobile-only"><button id="pill-prev" class="icon-button" type="button">${icons.left}</button><button id="date-pill" class="date-pill" type="button" aria-haspopup="dialog"></button><input id="pill-date" class="sr-only" type="date" tabindex="-1" aria-hidden="true" min="2000-01-01" max="2099-12-31"><button id="pill-next" class="icon-button" type="button">${icons.right}</button></div>
  <span class="grow"></span>
  <span id="sync-status" role="status"></span>
  <div id="picker-slot" class="picker-slot"></div>
  <div class="account desktop-only">${accountMenuHtml(ctx, 'bar')}</div>
</header>`;

export function mountTopBar(root: HTMLElement, ctx: PanelContext, drawer: Drawer, mods: { picker: PickerModule; dateSheet: DateSheetModule }) {
  const $ = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const step = (amount: number) => ctx.go(shiftPeriod(ctx.date, amount, ctx.view));
  $('#menu').onclick = () => drawer.open();
  // The button goes away with the press, so the keyboard goes to the date (a phone) or the sidebar button (a desktop) instead of the page body.
  $('#back-view').onclick = () => { ctx.goBack(); ($('#date-pill').getClientRects().length === 0 ? toggle : $('#date-pill')).focus(); };
  const toggle = $('#sidebar-toggle');
  toggle.onclick = () => ctx.state.setSidebar(ctx.state.sidebar === 'hidden' ? 'shown' : 'hidden');
  $('#pill-prev').onclick = () => step(-1);
  $('#pill-next').onclick = () => step(1);
  // The pill opens the date sheet. #pill-date is a hidden date input for entering a date by keyboard or script; it is not
  // in the tab order, and the phone e2e specs use it to jump to a far-away day.
  const native = $<HTMLInputElement>('#pill-date');
  $('#date-pill').onclick = () => mods.dateSheet.openDateSheet(ctx);
  native.onchange = () => { if (native.value) { ctx.go(native.value, true); } };
  const unmountPicker: Unmount = mods.picker.mount($('#picker-slot'), ctx);
  const unmountAccount = mountAccountMenus(root, ctx);
  return {
    /** The sidebar button says what it will do. The hiding itself is the sidebar's (Sidebar.drawVisibility). */
    drawSidebarButton() {
      const hidden = ctx.state.sidebar === 'hidden', label = hidden ? 'Show sidebar' : 'Hide sidebar';
      toggle.setAttribute('aria-expanded', String(!hidden)); toggle.setAttribute('aria-label', label); toggle.title = label;
    },
    focusSidebarButton() { toggle.focus(); },
    draw() {
      // Back to the month a day was opened from: it replaces the phone's menu button, and stands beside the sidebar button on a desktop.
      const back = ctx.backTo;
      $('#back-view').hidden = !back;
      $('#back-label').textContent = back ? BACK_LABEL[back] : '';
      $('#back-view').setAttribute('aria-label', back ? `Back to ${back}` : 'Back');
      root.querySelector('.topbar')?.toggleAttribute('data-back', !!back);
      $('#mode-heading').textContent = MODES[ctx.view];
      $('#date-pill').textContent = pillLabel(ctx.view, ctx.date);
      $('#date-pill').setAttribute('aria-label', `${pillLabel(ctx.view, ctx.date)}. ${CHOOSE[ctx.view]}`);
      drawAccount(root, ctx);
      $('#pill-prev').setAttribute('aria-label', `Previous ${ctx.view}`);
      $('#pill-next').setAttribute('aria-label', `Next ${ctx.view}`);
    },
    drawStatus() { $('#sync-status').textContent = ctx.state.status; },
    dispose() { unmountPicker(); unmountAccount(); },
  };
}
