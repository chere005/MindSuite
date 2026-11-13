import '../styles/weekmonth.css';
import { PHONE_TABS, weekView, type WeekTab } from '../../packages/core/src/planner';
import { markRedraw } from '../inplace/Inline';
import type { PanelContext, Unmount } from '../panelContext';
import { dropOrphanDrafts, mountNotes, noteBlocksHtml, type NoteSpec } from './NoteSection';
import { mountTabs, tabBarHtml } from './week/PhoneTabs';
import { mountTodos, todoSectionHtml, unsent as unsentTodos } from './week/PeriodTodos';

/**
 * Week: Priorities (a text block for each lane) and To-do (one reminder list for the week). Desktop shows both side
 * by side; a phone shows one at a time behind the bottom tabs and scrolls inside the panel.
 */
// The tab stays chosen while the week changes or the panel redraws.
let tab: WeekTab = PHONE_TABS.week[0];
/** The Chores view hands the tab back: the next time this panel draws it is that tab. */
export const showTab = (next: string) => { if ((PHONE_TABS.week as readonly string[]).includes(next)) { tab = next as WeekTab; } };

/** Unsent to-do words of a week or a month (the Month's to-do list is this one too, so its panel needs no check of its own). */
export const unsent = unsentTodos;

const priorities = (ctx: PanelContext): NoteSpec => ({ scope: 'week', period: ctx.date, field: 'priorities', label: 'priorities', placeholder: 'What matters this week…' });

export function html(ctx: PanelContext): string {
  dropOrphanDrafts(ctx);
  const view = weekView(ctx.input, ctx.date);
  return `<div class="wm-panel wm-week" data-panel="week" data-tab="${tab}"><div class="wm-body">
  <section class="wm-sec" id="wm-sec-priorities" data-sec="priorities" aria-labelledby="wm-h-priorities"><h2 class="panel-label" id="wm-h-priorities">Priorities</h2>${noteBlocksHtml(ctx, priorities(ctx), view.priorities)}</section>
  <section class="wm-sec" id="wm-sec-todo" data-sec="todo" aria-labelledby="wm-h-todo"><h2 class="panel-label" id="wm-h-todo">To-do</h2>${todoSectionHtml(ctx, 'week', view.todosOpen, view.todosDone)}</section>
</div>${tabBarHtml('Week sections', PHONE_TABS.week, tab)}</div>`;
}

export function mount(root: HTMLElement, ctx: PanelContext): Unmount {
  mountTabs(root, next => { tab = next as WeekTab; }, () => ctx.setChores(true));
  const undo = [mountNotes(root, ctx), mountTodos(root, ctx, 'week')];
  return () => { markRedraw(); for (const fn of undo) { fn(); } };
}
