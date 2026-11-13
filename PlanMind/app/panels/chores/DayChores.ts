import { dayChores } from '../../../packages/core/src/planner';
import type { PanelContext } from '../../panelContext';
import { sectionsHtml } from './ChoreRow';

/**
 * The Day's chores: today's open turns, then what the week missed (Missed, or Catch-up on a Friday), turns moved or let go, and the
 * done pile at the bottom; a weekly, Week A / Week B or monthly row says so in a badge. Saturday is a day off and has nothing else. A
 * phone fits it on one screen (rows 34px, shrinking to 30px, and the list scrolling inside itself past that); a desktop draws the same list
 * in the box of the Day's To-do list while the picker's Chores switch is on (day/ChoresSection.ts).
 */
export function html(ctx: PanelContext): string {
  const day = dayChores(ctx.choreInput, ctx.date);
  if (day.dayOff) { return '<p class="ch-off">Day off</p>'; }
  return `<ul class="ch-list ch-scroll" aria-label="Chores">${sectionsHtml(day.sections, { badge: true, letter: false })}</ul>`;
}
