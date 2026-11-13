import '../styles/chores.css';
import '../styles/weekmonth.css';
import { PHONE_TABS, monthChoreCells, monthView, type MonthTab } from '../../packages/core/src/planner';
import { markRedraw } from '../inplace/Inline';
import { isPhone, type PanelContext, type Unmount } from '../panelContext';
import { mountRows } from './chores/ChoreRow';
import { listHtml } from './chores/MonthChores';
import { dropOrphanDrafts, mountNotes, noteBlocksHtml, type NoteSpec } from './NoteSection';
import { gridHtml, mountGrid, notesFrom } from './month/MonthGrid';
import { mountTabs, tabBarHtml } from './week/PhoneTabs';
import { mountTodos, todoSectionHtml } from './week/PeriodTodos';

/**
 * Month: a six-row Monday-first calendar of the month's chores (the same ones, whoever the picker shows: chores are always for both of us) with Priorities and To-do
 * in a column on its left and Notes in the leftover cells of the sixth row (Thursday to Sunday, after the muted next-month days, as the wireframe draws it). A phone shows
 * one of Calendar, Priorities, To-do, Notes and Chores at a time behind the bottom tabs; its Calendar tab draws a bar for each chore in its cell and, under the grid, the
 * month's chores as the Chores page lists them, all in one scroll. Priorities and Notes are a text block for each lane, stacked in the narrow places.
 */
let tab: MonthTab = PHONE_TABS.month[0];
/** The Chores view hands the tab back: the next time this panel draws it is that tab. */
export const showTab = (next: string) => { if ((PHONE_TABS.month as readonly string[]).includes(next)) { tab = next as MonthTab; } };

const specs = (ctx: PanelContext): Record<'priorities' | 'notes', NoteSpec> => ({
  priorities: { scope: 'month', period: ctx.date, field: 'priorities', label: 'priorities', placeholder: 'What matters this month…' },
  notes: { scope: 'month', period: ctx.date, field: 'notes', label: 'notes', placeholder: 'Ideas, plans, things to remember…' },
});

export function html(ctx: PanelContext): string {
  dropOrphanDrafts(ctx);
  const view = monthView(ctx.input, ctx.date), note = specs(ctx), phone = isPhone();
  const cells = monthChoreCells(ctx.choreInput, ctx.date);
  return `<div class="wm-panel wm-month" data-panel="month" data-tab="${tab}"><div class="wm-body"><div class="wm-grid">
  <div class="wm-side">
    <section class="wm-sec" id="wm-sec-priorities" data-sec="priorities" aria-labelledby="wm-h-priorities"><h2 class="panel-label" id="wm-h-priorities">Priorities</h2>${noteBlocksHtml(ctx, note.priorities, view.priorities)}</section>
    <section class="wm-sec" id="wm-sec-todo" data-sec="todo" aria-labelledby="wm-h-todo"><h2 class="panel-label" id="wm-h-todo">To-do</h2>${todoSectionHtml(ctx, 'month', view.todosOpen, view.todosDone)}</section>
  </div>
  ${gridHtml(ctx, cells, view.grid, phone)}${phone ? `<div class="wm-chorelist">${listHtml(ctx)}</div>` : ''}
  <section class="wm-sec wm-notes" id="wm-sec-notes" data-sec="notes" data-from="${notesFrom(view.grid)}" aria-labelledby="wm-h-notes"><h2 class="panel-label" id="wm-h-notes">Notes</h2>${noteBlocksHtml(ctx, note.notes, view.notes)}</section>
</div></div>${tabBarHtml('Month sections', PHONE_TABS.month, tab)}</div>`;
}

export function mount(root: HTMLElement, ctx: PanelContext): Unmount {
  mountTabs(root, next => { tab = next as MonthTab; }, () => ctx.setChores(true));
  const undo = [mountGrid(root, ctx), mountRows(root.querySelector<HTMLElement>('.wm-panel')!, ctx), mountNotes(root, ctx), mountTodos(root, ctx, 'month')];
  return () => { markRedraw(); for (const fn of undo) { fn(); } };
}
