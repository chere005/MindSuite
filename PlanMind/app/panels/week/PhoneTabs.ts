/**
 * The phone bottom tab bar of the Week and Month panels (PHONE_TABS). On desktop the bar is hidden by CSS and every
 * section shows; on a phone the panel's data-tab attribute decides which section is visible, so a tab change redraws nothing.
 * The Month bar has five tabs and shows only the active one's label (the others keep theirs as an accessible name); Week's three show all.
 */
import type { MonthTab, WeekTab } from '../../../packages/core/src/planner';
import { icons } from '../../panelContext';

export type TabKey = WeekTab | MonthTab;

const svg = (path: string) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const TABS: Record<TabKey, { label: string; icon: string }> = {
  calendar: { label: 'Calendar', icon: icons.calendar },
  priorities: { label: 'Priorities', icon: svg('<path d="M5 21V4m0 0h11l-2 4 2 4H5"/>') },
  todo: { label: 'To-do', icon: svg('<path d="m4 7 2 2 3-3M4 17l2 2 3-3M13 8h7M13 18h7"/>') },
  notes: { label: 'Notes', icon: svg('<path d="M6 3h8l5 5v13H6zM14 3v5h5M9 13h7M9 17h5"/>') },
  chores: { label: 'Chores', icon: svg('<path d="M4 11.5 12 4.5l8 7M6 10v9.5h12V10M10 19.5v-5h4v5"/>') },
};

/**
 * A tab controls a section only when that section is on the page: the planner's bar controls its own sections (its Chores tab
 * leads to the Chores view, a page of its own, so it controls none), and the Chores view's bar controls just the Chores page.
 */
export const controlsSection = (tab: string, active: string) => (active === 'chores') === (tab === 'chores');

export const tabBarHtml = (title: string, tabs: readonly TabKey[], active: TabKey) =>
  `<div class="wm-tabs" role="tablist" aria-label="${title}" data-n="${tabs.length}">${tabs.map(tab =>
    `<button type="button" role="tab" id="wm-tab-${tab}" data-tab="${tab}"${controlsSection(tab, active) ? ` aria-controls="wm-sec-${tab}"` : ''} aria-selected="${tab === active}" aria-label="${TABS[tab].label}" tabindex="${tab === active ? 0 : -1}">${TABS[tab].icon}<span>${TABS[tab].label}</span></button>`).join('')}</div>`;

/** Wires the bar inside `root`. `onSelect` lets the panel remember the tab across redraws; the Chores tab is not a section of the panel, so it calls `onChores` instead (the page becomes the Chores view). */
export function mountTabs(root: HTMLElement, onSelect: (tab: TabKey) => void, onChores: () => void): void {
  const panel = root.querySelector<HTMLElement>('.wm-panel')!;
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('.wm-tabs [role=tab]')];
  const select = (button: HTMLButtonElement, focus: boolean) => {
    if (button.dataset.tab === 'chores') { button.focus(); onChores(); return; }
    panel.dataset.tab = button.dataset.tab;
    for (const other of buttons) {
      other.setAttribute('aria-selected', String(other === button));
      other.tabIndex = other === button ? 0 : -1;
    }
    if (focus) { button.focus(); }
    onSelect(button.dataset.tab as TabKey);
  };
  buttons.forEach((button, i) => {
    button.onclick = () => select(button, false);
    button.onkeydown = event => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (step) { event.preventDefault(); select(buttons[(i + step + buttons.length) % buttons.length], true); }
    };
  });
}
