/**
 * The Month calendar: 42 cells (six Monday-first rows) that show the month's chores, and nothing else that is planned. A cell is a plain box with the
 * date number as its button (it opens that day) and, on a desktop, that day's chores as the owner-tinted chips of the Chores page (ChoreRow.ts: the circle
 * checks it, the title hands that turn to the next owner); on a phone a thin bar in the owner's color for each of the first three turns and "+n" for the
 * rest, with the whole list under the grid (MonthChores.ts). The empty part of a cell opens its day too. Week A rows are the tinted ones, Week B rows plain;
 * a Saturday is hatched, in the month or not. monthChoreCells decides all of that; this file only draws it.
 */
import { choreBars, dayLabel, type MonthCell, type MonthChoreCell } from '../../../packages/core/src/planner';
import { esc, type PanelContext, type Unmount } from '../../panelContext';
import { rowHtml } from '../chores/ChoreRow';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WEEKS = 6;

/**
 * The first day column (1 to 7) of the sixth grid row that the Notes block takes on desktop: Thursday, as the approved
 * wireframe draws it, so Monday to Wednesday of that row stay muted next-month days and the Notes sit in the cells after them.
 * Only when the month itself reached past Wednesday of that row would they start later, after its last day. Core's
 * monthView always gives six rows, so the cells the block covers are never days of the month and nothing planned is hidden.
 */
export const NOTES_FROM = 4;
export const notesFrom = (grid: readonly MonthCell[]): number =>
  Math.max(NOTES_FROM, grid.slice((WEEKS - 1) * 7).map(cell => cell.inMonth).lastIndexOf(true) + 2);

const FULL = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' } as const;

/** What the cell holds below its number: the chips of a desktop, the bars of a phone (hidden from a screen reader, the number's name says how many). */
function turns(c: MonthChoreCell, phone: boolean): string {
  if (!c.rows.length) { return ''; }
  if (phone) {
    const { bars, more } = choreBars(c.rows);
    return `<span class="wm-bars" aria-hidden="true">${bars.map(row => `<i class="wm-bar" data-c="${row.color}" data-state="${row.state}"></i>`).join('')}${more ? `<span class="wm-more">+${more}</span>` : ''}</span>`;
  }
  return `<ul class="ch-list wm-chores" aria-label="Chores, ${esc(dayLabel(c.date, { weekday: 'long', month: 'long', day: 'numeric' }))}">${c.rows.map(row => rowHtml(row, { letter: false, tip: true })).join('')}</ul>`;
}

const cell = (ctx: PanelContext, c: MonthChoreCell, index: number, from: number, phone: boolean) => {
  const label = `${dayLabel(c.date, FULL)}${phone && c.rows.length ? `, ${c.rows.length} ${c.rows.length === 1 ? 'chore' : 'chores'}` : ''}`;
  const covered = index >= (WEEKS - 1) * 7 + from - 1;
  const today = c.date === ctx.today;
  return `<div class="wm-day${c.inMonth ? '' : ' out'}${today ? ' today' : ''}" data-date="${c.date}"${c.letter ? ` data-letter="${c.letter}"` : ''}${c.saturday ? ' data-sat' : ''}${covered ? ' data-covered' : ''}>
  <button type="button" class="wm-day-num" data-date="${c.date}"${today ? ' aria-current="date"' : ''} aria-label="${esc(label)}">${Number(c.date.slice(8))}</button>${turns(c, phone)}</div>`;
};

/** The weekday header and the cells; the layout (desktop grid with the side column, phone tab) is CSS. */
export const gridHtml = (ctx: PanelContext, cells: readonly MonthChoreCell[], grid: readonly MonthCell[], phone: boolean) => {
  const from = notesFrom(grid);
  return `<div class="wm-days" id="wm-sec-calendar" data-sec="calendar" aria-label="Calendar"><span class="wm-corner" aria-hidden="true"></span>${DAYS.map((d, i) => `<span class="wm-dow"><span class="wm-dow-full">${d}</span><span class="wm-dow-letter" aria-hidden="true">${WEEKDAY[i][0]}</span></span>`).join('')}${cells.map((c, i) => cell(ctx, c, i, from, phone)).join('')}</div>`;
};

/**
 * The date number opens that day on the Day view, with Back to this month in the top bar, and so does the empty part of the cell (a mouse or a finger;
 * the number is the keyboard's way in). A chip does its own work (the rows are wired by mountRows) and never opens the day.
 */
export function mountGrid(root: HTMLElement, ctx: PanelContext): Unmount {
  const days = root.querySelector<HTMLElement>('.wm-days')!;
  days.onclick = event => {
    const target = event.target as HTMLElement;
    if (target.closest('.ch-row') || (target.closest('button, input') && !target.closest('.wm-day-num'))) { return; }
    const date = target.closest<HTMLElement>('.wm-day')?.dataset.date;
    if (!date) { return; }
    ctx.openDay(date, 'month');
  };
  return () => { days.onclick = null; };
}
