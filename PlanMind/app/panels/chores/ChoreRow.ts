import '../../styles/chores.css';
import { choreMark, choreTurns, type ChoreRow, type ChoreRowKind, type ChoreSection, type ChoreTap } from '../../../packages/core/src/planner';
import { esc, type PanelContext } from '../../panelContext';
import type { SendResult } from '../../state';

/**
 * The one chore row of the Chores view (Day, Week and Month), and how a tap on it is written. A row is a turn (a rule on a date) as chores.ts
 * describes it: an open row has a circle (done / not done) and its title, which is a button that hands that one turn to the next owner;
 * a missed row also has "Fri" (send it to the catch-up Friday) and "Let go"; a catch-up row says where it is from and has "Let go"; a
 * row sent away or let go by hand is dim with a chip that takes that back; a done row is crossed out. Every control that writes has
 * data-writes. The colour of the circle is the owner's (data-c). Which turn a row is comes from its data-rule and data-date, read
 * again from the snapshot at tap time, so a row that went stale in the markup still writes against the revision held now. The Day's rows
 * say how often they come in a quiet badge ("Weekly", "Week A", "Week B", "Monthly"; none on a daily chore) before their other chips. The Month's
 * rows are chips tinted by their owner (data-state says missed, for its left edge), in the phone's list and in the calendar's cells (panels/month/MonthGrid.ts); the date chip of the list opens that Day.
 */

export type RowOptions = {
  /** The Day's cadence badge (core's `badge`), in place of the bare A / B chip. */
  badge?: boolean;
  /** The phone's month list: a chip with the day of the turn ("Thu 12"), a button that opens that Day. */
  date?: boolean;
  /** Week A / Week B chip; the Month's week groups and the calendar's gutter already say it. */
  letter?: boolean;
  /** The whole title as a tooltip: the calendar's chips are narrow and end a long title in an ellipsis. */
  tip?: boolean;
};

/** What a screen reader hears on the title button: who the turn is for, and what a tap does. */
const titleName = (row: ChoreRow) => `${row.title}, for ${row.ownerName}. Tap to make it for ${row.nextOwnerName}`;

function controls(row: ChoreRow): string {
  const label = esc(row.title);
  switch (row.kind) {
    case 'missed': return `<button type="button" class="ch-btn" data-act="move" data-writes aria-label="Move ${label} to Friday">Fri</button><button type="button" class="ch-btn" data-act="letgo" data-writes aria-label="Let go of ${label}">Let go</button>`;
    case 'catchup': return `<button type="button" class="ch-btn" data-act="letgo" data-writes aria-label="Let go of ${label}">Let go</button>`;
    default: return '';
  }
}

export function rowHtml(row: ChoreRow, options: RowOptions = {}): string {
  const label = esc(row.title);
  const tip = options.tip ? ` title="${label}"` : '';
  const chips = [
    options.badge && row.badge ? `<span class="ch-chip ch-badge" data-cadence="${row.cadence}">${esc(row.badge)}</span>` : '',
    options.letter !== false && row.chip ? `<span class="ch-chip" aria-label="Week ${row.chip}">${row.chip}</span>` : '',
    row.from ? `<span class="ch-chip">from ${esc(row.from)}</span>` : '',
    options.date ? `<button type="button" class="ch-chip ch-date" data-act="day" data-date="${row.date}" aria-label="Open ${esc(row.dateLabel)}">${esc(row.dateLabel)}</button>` : '',
  ].join('');
  const shell = (inner: string) => `<li class="ch-row ch-${row.kind}" data-id="${esc(row.id)}" data-rule="${esc(row.rule.id)}" data-date="${row.date}" data-kind="${row.kind}" data-state="${row.state}" data-c="${row.color}">${inner}</li>`;
  // Sent to Friday, or let go by hand: no circle, the row is dim and its chip takes the choice back.
  if (row.kind === 'moved') {
    return shell(`<span class="ch-ghost" aria-hidden="true"></span><span class="ch-title"${tip}>${label}</span>${chips}<button type="button" class="ch-chip ch-undo" data-act="unmove" data-writes aria-label="${label} was sent to Friday. Undo">→ Fri</button>`);
  }
  if (row.kind === 'letgo') {
    return shell(`<span class="ch-ghost" aria-hidden="true"></span><span class="ch-title"${tip}>${label}</span>${chips}<button type="button" class="ch-chip ch-undo" data-act="unletgo" data-writes aria-label="${label} was let go. Undo">Let go</button>`);
  }
  return shell(`<input type="checkbox" class="ch-circle" data-writes${row.done ? ' checked' : ''} aria-label="${row.done ? 'Reopen' : 'Complete'} ${label}">
  <button type="button" class="ch-title"${tip} data-act="owner" data-writes aria-label="${esc(titleName(row))}">${label}</button>${chips}${controls(row)}`);
}

/** A group of rows, in the flat list the page draws: its label (Missed, Catch-up) as an item of its own when it has one. */
export function sectionsHtml(sections: readonly ChoreSection[], options: RowOptions & { labels?: boolean } = {}): string {
  return sections.map(section => `${section.label && options.labels !== false ? `<li class="ch-label" data-kind="${section.kind}">${esc(section.label)}</li>` : ''}${section.rows.map(row => rowHtml(row, options)).join('')}`).join('');
}

const ACTS: Record<string, ChoreTap> = { owner: 'owner', move: 'move', unmove: 'unmove', letgo: 'letgo', unletgo: 'unletgo' };

/** The turn a row or a grid cell is, read from the snapshot held now. */
export function turnAt(ctx: PanelContext, rule: string, date: string) {
  return choreTurns(ctx.choreInput.data, ctx.today, date).find(turn => turn.rule.id === rule) ?? null;
}

/**
 * Wires every chore row (and Week grid cell) inside `root`: the circle writes done / not done, the title button its owner cycle, and
 * the small buttons Fri, Let go and their undo chips; a day button (the Month list's date chip) opens that Day (the calendar's own date numbers are MonthGrid's).
 * One listener each, so a redraw of the panel needs nothing taken down but these.
 */
export function mountRows(root: HTMLElement, ctx: PanelContext): () => void {
  const abort = new AbortController();
  const on = { signal: abort.signal };
  const write = (rule: string, date: string, kind: ChoreRowKind | undefined, tap: ChoreTap): Promise<SendResult> | undefined => {
    const turn = turnAt(ctx, rule, date);
    return turn ? ctx.send(choreMark({ ...turn, kind }, tap)) : undefined;
  };
  root.addEventListener('change', event => {
    const box = event.target as HTMLInputElement;
    const row = box.closest<HTMLElement>('.ch-row');
    if (!row || !box.matches('.ch-circle')) { return; }
    const { rule, date, kind } = row.dataset;
    // The tick the browser just made stays on screen while the write is on its way (the reply redraws the row); a write that did not happen puts the box back to what is stored.
    const stored = turnAt(ctx, rule!, date!)?.state === 'done';
    const sent = write(rule!, date!, kind as ChoreRowKind, 'check');
    if (!sent) { box.checked = stored; return; }
    void sent.then(result => { if (!result.ok && box.isConnected) { box.checked = stored; } });
  }, on);
  root.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!target) { return; }
    if (target.dataset.act === 'day') { ctx.openDay(target.dataset.date!, ctx.view); return; }
    const cell = target.closest<HTMLElement>('[data-cell]');
    if (cell) { write(cell.dataset.rule!, cell.dataset.date!, undefined, 'check'); return; }
    const row = target.closest<HTMLElement>('.ch-row');
    const tap = ACTS[target.dataset.act ?? ''];
    if (row && tap) { write(row.dataset.rule!, row.dataset.date!, row.dataset.kind as ChoreRowKind, tap); }
  }, on);
  return () => abort.abort();
}
