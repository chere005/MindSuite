import { PHONE_TABS, type DayTab } from '../../../packages/core/src/planner';
import { controlsSection } from '../week/PhoneTabs';

/**
 * The Day's phone bottom bar (PHONE_TABS.day). The Day panel draws it with the chosen tab's section above it; the Chores view draws
 * it again with Chores chosen, so the bar looks the same on both and a tap on another tab goes back to the planner.
 */
const TAB_LABEL: Record<DayTab, string> = { schedule: 'Schedule', todo: 'To-do', notes: 'Notes', chores: 'Chores' };
const icon = (path: string) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const TAB_ICON: Record<DayTab, string> = {
  schedule: icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  todo: icon('<path d="m4 6.5 1.5 1.5L8 5.5M4 12.5l1.5 1.5L8 11.5M4 18.5 5.5 20 8 17.5M11 7h9M11 13h9M11 19h9"/>'),
  notes: icon('<path d="M7 3.5h8l4 4v13H7z"/><path d="M15 3.5V8h4M10.5 12.5h6M10.5 16.5h6"/>'),
  chores: icon('<path d="M4 11.5 12 4.5l8 7M6 10v9.5h12V10M10 19.5v-5h4v5"/>'),
};

export const dayTabsHtml = (active: DayTab) => `<nav class="day-tabs" role="tablist" aria-label="Day sections">${PHONE_TABS.day.map(t =>
  `<button type="button" class="day-tab" role="tab" id="day-tab-${t}" aria-selected="${t === active}"${controlsSection(t, active) ? ' aria-controls="day-tabpanel"' : ''} tabindex="${t === active ? 0 : -1}" data-tab="${t}">${TAB_ICON[t]}<span>${TAB_LABEL[t]}</span></button>`).join('')}</nav>`;
