import { choreDayLabel, weekChores, type ChoreGridCell, type ChoreGridRow, type WeekChores } from '../../../packages/core/src/planner';
import { esc, type PanelContext } from '../../panelContext';
import { sectionsHtml } from './ChoreRow';

/**
 * The Week's chores, a phone's Chores tab: "Week A" or "Week B", the grid of the daily chores (a cell for each day, a tap on today's or an
 * earlier day's toggles done), then a group for each day with that day's other turns. It lists the days that have rows (Friday and Saturday
 * always). A desktop has no Chores page: the Week there carries none, and the Day swaps its To-do list for the day's chores (day/ChoresSection.ts).
 */

const DAY_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const STATE_WORD: Record<ChoreGridCell['state'], string> = { off: 'day off', done: 'done', letgo: 'let go', upcoming: 'coming up', today: 'to do today', missed: 'missed', moved: 'sent to Friday' };

function cellHtml(row: ChoreGridRow, cell: ChoreGridCell): string {
  const name = `${row.title}, ${choreDayLabel(cell.date)}: ${STATE_WORD[cell.state]}`;
  const classes = `ch-cell ch-s-${cell.state}${cell.today ? ' today' : ''}`;
  if (cell.canToggle) {
    return `<td class="${classes}"><button type="button" class="ch-gbtn" data-act="cell" data-cell data-rule="${esc(row.rule.id)}" data-date="${cell.date}" aria-label="${esc(`${name}. Tap to mark it ${cell.state === 'done' ? 'not done' : 'done'}`)}">${cell.symbol}</button></td>`;
  }
  return `<td class="${classes}"><span class="ch-gsym" role="img" aria-label="${esc(name)}">${cell.symbol}</span></td>`;
}

function gridHtml(week: WeekChores): string {
  if (!week.grid.length) { return ''; }
  const head = week.columns.map((column, i) => `<th scope="col" class="ch-gcol${column.today ? ' today' : ''}"><span aria-hidden="true">${column.label}</span><span class="sr-only">${DAY_FULL[i]}</span></th>`).join('');
  const rows = week.grid.map(row => `<tr data-c="${row.color}"><th scope="row" class="ch-gname"><i class="ch-dot" aria-hidden="true"></i><span>${esc(row.title)}</span></th>${row.cells.map(cell => cellHtml(row, cell)).join('')}</tr>`).join('');
  return `<table class="ch-grid"><caption class="sr-only">Daily chores</caption><thead><tr><td></td>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function daysHtml(week: WeekChores): string {
  return week.columns.map(column => {
    const group = week.days.find(day => day.date === column.date);
    // A day with nothing to show is nothing.
    if (!group) { return ''; }
    const rows = sectionsHtml(group.sections, { labels: false });
    return `<section class="ch-dg${group.today ? ' today' : ''}" data-date="${group.date}"><h3 class="ch-label"><span>${esc(group.label)}</span>${group.today ? '<span class="ch-today">today</span>' : ''}</h3>${group.dayOff ? '<p class="ch-off">Day off</p>' : rows ? `<ul class="ch-list">${rows}</ul>` : ''}</section>`;
  }).join('');
}

export function html(ctx: PanelContext): string {
  const week = weekChores(ctx.choreInput, ctx.date);
  return `<div class="ch-week"><p class="ch-weekhead">${week.label}</p>${gridHtml(week)}<div class="ch-days">${daysHtml(week)}</div></div>`;
}
