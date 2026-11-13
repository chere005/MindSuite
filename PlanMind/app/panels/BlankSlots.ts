import '../styles/day.css';
import { blankAim, blankThirds, newOwners, rowDone, type BlankAim, type TodoRow } from '../../packages/core/src/planner';
import { esc, type PanelContext } from '../panelContext';

/**
 * The blank ruled lines of a to-do list (the Day's 13 slots, the Week's 13 and the Month's 8) are cut like the schedule and the
 * priorities. In the Both view the left third of a blank line makes a to-do for the left lane's person (the signed-in one), the middle
 * third one linked to-do for both, the right third the right lane's person. A pointer sees the cell a click will make, in that owner's
 * color (the hover ghost, `.day-cell.day-newcell` like the priorities'); a finger has no hover and just taps. Where one list is shown there
 * are no thirds: the line is that list's. The click and the ghost both ask `aimAt`, which asks core `blankAim`, so they cannot disagree.
 *
 * The three lists share this: each draws its blank lines (`blankLine`) and says what opening a new to-do is (`open`).
 */

export type BlankSpec = {
  /** The list that holds the ruled lines. */
  list: HTMLElement;
  /** Selector of a blank line. Each carries data-slot, its ruled line number. */
  slot: string;
  /** The add field's line holds a form. While the field holds unsent text a pointer on that line means the text, not a new to-do. */
  typed(): boolean;
  /** Puts the caret in the add field (the old reply of a tap on its line when it holds text). */
  focusAdd(): void;
  /** A new to-do is wanted on `slot` for `aim.owners`. `onAdd` is true when the slot is the add field's line: Enter then hands the keyboard back to the add field. */
  open(aim: BlankAim, slot: HTMLElement, onAdd: boolean): void;
};

/** Who a new to-do is for, as a screen reader's name reads it: "Alex", "Alex and Sam" (the signed-in person first, as the lanes are). */
export const forNames = (ctx: PanelContext, owners: readonly string[]) =>
  [...owners].sort((a, b) => Number(b === ctx.me) - Number(a === ctx.me)).map(id => ctx.lists.find(l => l.id === id)?.name ?? 'That list').join(' and ');

/** The color of a new to-do's owners: the Both color for the two people, the list's own color for one. */
export const ownerColor = (ctx: PanelContext, owners: readonly string[]) =>
  owners.length > 1 ? ctx.settings.bothColor : ctx.lists.find(l => l.id === owners[0])?.color ?? 'gray';

/** The accessible name of the field of a new to-do: "New to-do for Alex and Sam". */
export const newName = (ctx: PanelContext, owners: readonly string[]) => `New to-do for ${forNames(ctx, owners)}`;

/**
 * A screen reader's way to a to-do for both of us (the middle third is a pointer's): a hidden button, not in the tab order. It is in
 * the add field's line only (the other blank lines are paper a screen reader skips), and only where the line is cut in thirds.
 */
export function bothButton(ctx: PanelContext): string {
  if (!blankThirds(ctx.selection, ctx.lists, ctx.settings, ctx.lanes)) { return ''; }
  return `<button type="button" class="sr-only" tabindex="-1" data-both aria-label="${esc(`Add to-do for ${forNames(ctx, newOwners(ctx.selection, ctx.lists, ctx.settings).owners)}`)}"></button>`;
}

export function mountBlanks(ctx: PanelContext, spec: BlankSpec): () => void {
  const { list } = spec;
  const slotOf = (target: Element | null) => {
    const slot = target?.closest<HTMLElement>(spec.slot) ?? null;
    return slot && list.contains(slot) ? slot : null;
  };
  /** The add field's own line with text in it is the text's: pointing at it is not asking for a new to-do. */
  const pointable = (slot: HTMLElement) => !(slot.querySelector('form') && spec.typed());
  /** What a pointer at `clientX` over the slot would make: the one decision the click and the hover both ask. */
  const aimAt = (slot: HTMLElement, clientX: number, both: boolean): BlankAim => {
    const box = slot.getBoundingClientRect();
    return blankAim(ctx.selection, ctx.lists, ctx.settings, ctx.lanes, box.width ? (clientX - box.left) / box.width : Number.NaN, both);
  };

  // The hover: a pointer only (day.css hides it without hover). Each place is a new element and the old one is removed.
  let ghost: HTMLElement | null = null;
  let ghostAt = '';
  const hide = () => { ghostAt = ''; ghost?.remove(); ghost = null; };
  list.addEventListener('mousemove', event => {
    const slot = slotOf(event.target as Element);
    if (!slot || !pointable(slot)) { hide(); return; }
    const aim = aimAt(slot, event.clientX, event.shiftKey);
    const where = `${slot.dataset.slot}:${aim.side}:${aim.color}`;
    if (where === ghostAt && ghost?.isConnected) { return; }
    hide();
    ghostAt = where;
    ghost = document.createElement('div');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.className = 'day-cell day-newcell todo-newcell';
    ghost.dataset.c = aim.color;
    ghost.dataset.side = aim.side;
    slot.append(ghost);
  });
  list.addEventListener('mouseleave', hide);
  // A scroll moves the lines under a resting pointer without a mouse move, so the ghost would sit on a line the pointer has left. Scroll
  // events do not bubble: the panel (and the Month's side column inside it) is listened to while capturing. The panel outlives this list.
  const scroller = list.closest<HTMLElement>('#period-panel');
  const scrolled = () => { if (!list.isConnected) { scroller?.removeEventListener('scroll', scrolled, true); } hide(); };
  scroller?.addEventListener('scroll', scrolled, { capture: true, passive: true });

  // The add field is a text field on the first blank line. Pointed at while empty it is a line like the others (the click asks the third
  // it was in), so a press on it does not put the caret there; the keyboard still does (Tab), and so does a tap while it holds text.
  // Not moving the focus must not keep the press from doing what a press on any other blank line does: take the focus off whatever was
  // being edited (a to-do row, a priority, the notes), which saves it and lets the panel be drawn again for the new to-do.
  list.addEventListener('mousedown', event => {
    const target = event.target as HTMLElement, slot = slotOf(target);
    if (event.button !== 0 || !slot || !target.closest('input') || !pointable(slot)) { return; }
    event.preventDefault();
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== target) { active.blur(); }
  });
  list.addEventListener('click', event => {
    const target = event.target as HTMLElement, slot = slotOf(target);
    if (!slot) { return; }
    const hidden = target.closest('button[data-both]');
    // Add (a control of the add form) and anything else with a job of its own are not the line.
    if (!hidden && target.closest('button,a')) { return; }
    if (!hidden && !pointable(slot)) { spec.focusAdd(); return; }
    // Shift on a click, and the hidden button, are the other ways to a to-do for both of us (no pointer to place in the middle third).
    spec.open(aimAt(slot, hidden ? Number.NaN : event.clientX, !!hidden || event.shiftKey), slot, !!slot.querySelector('form'));
  });

  return () => { hide(); scroller?.removeEventListener('scroll', scrolled, true); };
}

/**
 * Puts the row of a to-do that was drawn by hand where the next drawing would put it, for the places that cannot draw the list again (the
 * editor of a row closed with the focus in another text field). The list is the open rows from the top, the blank lines, then the done rows
 * at the bottom: an open row goes ahead of the first open row that follows it in the view's order, else after the last open row (at the
 * top when there is none), so ahead of the blank lines and the add field; a done row goes the same way among the done rows, else at the
 * bottom of the list. `el` is the row or editor being replaced; `isDone` says which section a row on the page is in.
 */
export function seatRow(el: HTMLElement, html: string, now: TodoRow, view: { todosOpen: readonly TodoRow[]; todosDone: readonly TodoRow[] }, isDone: (row: HTMLElement) => boolean): void {
  const list = el.parentElement;
  if (!list) { return; }
  const done = rowDone(now);
  const order = (done ? view.todosDone : view.todosOpen).map(r => r.item.id);
  const later = new Set(order.slice(order.indexOf(now.item.id) + 1));
  // Rows are the children that carry an id (an editor of a new to-do and the blank lines do not).
  const kin = [...list.querySelectorAll<HTMLElement>(':scope > [data-id]')].filter(row => row !== el && isDone(row) === done);
  const next = kin.find(row => later.has(row.dataset.id ?? ''));
  el.remove();
  if (next) { next.insertAdjacentHTML('beforebegin', html); }
  else if (kin.length) { kin[kin.length - 1].insertAdjacentHTML('afterend', html); }
  else { list.insertAdjacentHTML(done ? 'beforeend' : 'afterbegin', html); }
}
