import { monthChores } from '../../../packages/core/src/planner';
import { esc, type PanelContext } from '../../panelContext';
import { rowHtml } from './ChoreRow';

/**
 * The Month's chores as a list: a "Monthly" group with the month's monthly turns, then a group for each Monday-to-Sunday week that touches the month,
 * named "Nov 2–8 · Week A", with that week's Week A / Week B turns that fall in the month. Every row is a chip tinted by its owner that says its day
 * ("Thu 12"), a button that opens that Day. A phone draws it under the planner's Month grid and on the Chores tab; a desktop has no list, its calendar
 * carries the same turns in each day (panels/month/MonthGrid.ts). The chores that happen every day or every week are on the Day and the Week.
 */
export function listHtml(ctx: PanelContext): string {
  const month = monthChores(ctx.choreInput, ctx.date);
  const group = (label: string, rows: string) => (rows ? `<h3 class="ch-label">${esc(label)}</h3><ul class="ch-list">${rows}</ul>` : '');
  return `<div class="ch-month">${group('Monthly', month.monthly.map(row => rowHtml(row, { date: true })).join(''))}${month.weeks.map(week => group(week.label, week.rows.map(row => rowHtml(row, { date: true, letter: false })).join(''))).join('')}</div>`;
}
