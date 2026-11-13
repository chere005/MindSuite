import '../../styles/chores.css';
import type { PanelContext } from '../../panelContext';
import { mountRows } from '../chores/ChoreRow';
import * as list from '../chores/DayChores';

/**
 * A desktop Day's Chores: while the picker's Chores switch is on, this takes the place of the To-do section (the same box, the same height, under Priorities)
 * and lists the day's chores as the Chores page did: today's, Missed (Fri / Let go) or Friday's Catch-up, turns sent to Friday or let go with their undo chips,
 * the done pile at the bottom, a cadence badge on a weekly, Week A / B or monthly one, and Saturday as a day off. Chores ignore the picker's lists: both of us
 * see every chore, while the Schedule, Priorities and Notes keep following the selection. The list scrolls inside itself when it is long.
 */
export const html = (ctx: PanelContext) => `<section class="day-sec day-chores" aria-label="Chores">
  <div class="day-todohead"><h2 class="day-label">Chores</h2></div>
  ${list.html(ctx)}
</section>`;

/** The circle, the title (the owner cycle), Fri, Let go and the undo chips write through ChoreRow's one listener set. */
export function mount(panel: HTMLElement, ctx: PanelContext): () => void {
  const section = panel.querySelector<HTMLElement>('.day-chores');
  return section ? mountRows(section, ctx) : () => {};
}
