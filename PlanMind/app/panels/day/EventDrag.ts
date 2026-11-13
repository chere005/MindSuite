import { CAPS, moveEvent, type Owners, type ScheduleEvent } from '../../../packages/core/src/planner';
import { createBubble, followPointer, minuteAt, shownOf } from './Gesture';
import { spanLabel } from './EventHandles';

/** A mouse or pen moves an entry once the pointer is this far (px) from where it went down; a click that does not move opens it. */
export const MOVE_THRESHOLD = 4;
/** A finger presses and holds this long (ms) before the entry lifts; moving more than TOUCH_SLOP px before that is a scroll. */
export const HOLD_MS = 400;
export const TOUCH_SLOP = 8;
/** A press that goes this far (px) mostly sideways, to the left, is a swipe: it shows the entry's Delete instead of moving it. */
export const SWIPE_PX = 28;

export type MoveHost = {
  /** The element whose box stands for data-span minutes from data-from (the page shown). Read again on every move, so a layout that flexes or scrolls mid-drag is followed. */
  grid: HTMLElement;
  /** The entry a block stands for (its draft while it is being edited), or null when it cannot be moved. */
  eventOf(block: HTMLElement): ScheduleEvent | null;
  events(): readonly ScheduleEvent[];
  /** Whether a block at this start and length has any of itself on the screen (a half of the day hides the rest); a move to a place where it has none is not followed. */
  visible?(start: number, length: number): boolean;
  /**
   * In the Both view with exactly the two people's lanes: whom the entry is for with its centre `across` the width of the grid (0 at the
   * left edge, 1 at the right; the thirds of core moveAim), and the word the bubble ends with ("Both") while that is not who it is for
   * already. Null in any other view, where a drag never changes owners; without this member it never does.
   */
  aim?(event: ScheduleEvent, across: number): { owners: Owners; label: string } | null;
  /** Shows the block at this start and for these owners (the entry's own unless `aim` said otherwise). Called on every step, and with the old ones again when the move is cancelled. */
  preview(block: HTMLElement, event: ScheduleEvent, start: number, owners: Owners): void;
  /** The pointer was released over a new start and owners. Resolves with whether it stuck; false puts the block back. */
  drop(block: HTMLElement, event: ScheduleEvent, start: number, owners: Owners): Promise<boolean>;
  /** A block was lifted to be moved (anything shown beside it, like its Delete, is put away). */
  lifted?(block: HTMLElement): void;
  /** A swipe to the left on a block that is not being edited (the block's own Delete shows); without it a sideways press is only a move. */
  swipe?(block: HTMLElement): void;
};

/**
 * Moving an entry by dragging it (spec: UX-NOTES, interaction draft). On a desktop: press the block and move more than 4 px; a
 * click without movement is not a drag and opens the editor as before. On a touch screen: press and hold about 0.4 s without
 * scrolling, the block lifts, then drag. The block follows the pointer in 15-minute steps and lands on the nearest free quarter
 * hour (core moveEvent), showing "10:45a – 11:15a" while it moves. In the Both view it also follows the pointer across the thirds
 * (host.aim: one person, Both, the other), lands where a start is free in the lanes of whoever it is then for, and the bubble ends with "· Both"
 * while that is a change; in any other view it keeps its owners and its lane. The third is that of the block's centre carried by the
 * pointer's sideways travel, so a press anywhere on a block and a drag straight up or down never changes whom it is for. Escape and a
 * cancelled pointer put it back. The drop is one call to `host.drop`.
 */
export function attachEventDrag(section: HTMLElement, host: MoveHost): () => void {
  const abort = new AbortController();
  let busy = false;

  /**
   * A drag must not also end as a click that opens the editor. The click comes with the release of the pointer, which for an
   * Escape is later than the end of the drag, so the guard stays until the pointer is up (and the click, if any, has gone by).
   */
  const swallowClick = () => {
    const stop = (event: Event) => { event.stopPropagation(); event.preventDefault(); };
    section.addEventListener('click', stop, { capture: true, once: true });
    const disarm = () => {
      document.removeEventListener('pointerup', disarm, true); document.removeEventListener('pointercancel', disarm, true);
      setTimeout(() => section.removeEventListener('click', stop, true), 0);
    };
    document.addEventListener('pointerup', disarm, true);
    document.addEventListener('pointercancel', disarm, true);
  };

  section.addEventListener('pointerdown', down => {
    const target = down.target as HTMLElement;
    const block = target.closest<HTMLElement>('.day-ev');
    // The handles and the strip of controls under an edited block are not the block: they do their own thing.
    if (!block || busy || !down.isPrimary || down.button > 0 || target.closest('.day-handle')) { return; }
    const event = host.eventOf(block);
    if (!event) { return; }
    const touch = down.pointerType === 'touch';
    const startX = down.clientX, startY = down.clientY;
    // The block being edited is not a control: pressing it would pull the focus out of the entry's field (and with it Escape and the
    // save on leaving). A mouse or pen press on the block outside the field is kept from doing that; a click still comes. A press on
    // the field itself is the person placing the caret: it only becomes a move when it goes mostly up or down (sideways is a text
    // selection). Whatever else takes the focus gives it back at the end.
    // Pressing another entry while a field is open is the focus leaving it (its text is saved first). Chromium moves the focus to the pressed
    // button; WebKit does not focus buttons, so the field would stay open and unsaved: take the focus out of it here.
    const open = document.activeElement;
    if (!touch && open instanceof HTMLInputElement && section.contains(open) && !block.contains(open)) { open.blur(); }
    const focused = document.activeElement;
    const inField = !!target.closest('input');
    if (!touch && !inField && block.classList.contains('day-editing')) { down.preventDefault(); }
    const keepFocus = () => { if (focused instanceof HTMLElement && focused.isConnected && focused !== document.activeElement && (!document.activeElement || document.activeElement === document.body)) { focused.focus({ preventScroll: true }); } };
    let lifted = false, cancelDrag: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new AbortController();
    // Long press: the system would otherwise offer a menu or a text selection on a block of text. Held until the gesture is over.
    const noMenu = (menu: Event) => menu.preventDefault();
    if (touch) { document.addEventListener('contextmenu', noMenu); }
    const over = () => document.removeEventListener('contextmenu', noMenu);

    const lift = () => {
      lifted = true;
      idle.abort();
      busy = true;
      host.lifted?.(block);
      block.dataset.moving = '';
      if (touch) { navigator.vibrate?.(10); }
      const rect = host.grid.getBoundingClientRect();
      // The pointer keeps its place on the entry, so the block does not jump to the pointer.
      const grab = minuteAt(touch ? startY : down.clientY, rect.top, rect.height, shownOf(host.grid)) - event.start;
      // Where the block's centre is across the grid; the sideways travel of the pointer carries it (see attachEventDrag).
      const mid = block.getBoundingClientRect();
      const anchor = mid.left + mid.width / 2 - rect.left;
      const bubble = createBubble();
      // The last place and owners that were free: the preview stays there while the pointer is over a place that is not.
      const sameOwners = (a: Owners, b: Owners) => a.join() === b.join();
      // The bubble names whom the entry would be for only where the drag changes it ("7:30p – 8p · Both"): a drag along its own lane reads as it always did.
      const named = (aim: { owners: Owners; label: string } | null) => aim && !sameOwners(aim.owners, event.owners) ? aim.label : '';
      let at = event.start, who = event.owners, label = '';
      const show = (x: number, y: number) => bubble.show(`${spanLabel(at, event.length)}${label ? ` · ${label}` : ''}`, x, y);
      show(startX, startY);
      cancelDrag = followPointer(block, down, {
        move: move => {
          const box = host.grid.getBoundingClientRect();
          // With only a half of the day on the screen, the block stays at least partly in it (the other half is a switch away).
          const shown = shownOf(host.grid);
          const target = Math.min(shown.to - CAPS.eventStep, Math.max(shown.from - event.length + CAPS.eventStep, minuteAt(move.clientY, box.top, box.height, shown) - grab));
          const aim = host.aim?.(event, (anchor + move.clientX - startX) / Math.max(1, box.width)) ?? null;
          const owners = aim ? aim.owners : event.owners;
          const found = moveEvent(host.events(), event, target, owners);
          // No start is free for those owners (or none of the block would show): it stays at the last good place, with the last good owners.
          if (found !== null && !(host.visible && !host.visible(found, event.length)) && (found !== at || !sameOwners(owners, who))) {
            at = found; who = owners; label = named(aim);
            host.preview(block, event, at, who);
          }
          show(move.clientX, move.clientY);
        },
        end: cancelled => {
          bubble.remove();
          over();
          delete block.dataset.moving;
          keepFocus();
          swallowClick();
          if (cancelled || (at === event.start && sameOwners(who, event.owners))) { host.preview(block, event, event.start, event.owners); busy = false; return; }
          void host.drop(block, event, at, who).then(stuck => { if (!stuck) { host.preview(block, event, event.start, event.owners); } }).finally(() => { busy = false; });
        },
      });
    };

    const hold = (move: PointerEvent) => {
      if (move.pointerId !== down.pointerId) { return; }
      const dx = move.clientX - startX, dy = move.clientY - startY, far = Math.hypot(dx, dy);
      // Sideways to the left is a swipe, not a move or a scroll: it waits for SWIPE_PX, and turns into a move (or a scroll) only if it
      // goes up or down instead. A block being edited has no swipe (its field is where a sideways drag selects text).
      const sideways = !!host.swipe && !block.classList.contains('day-editing') && dx < 0 && Math.abs(dx) > 1.5 * Math.abs(dy);
      if (sideways && -dx >= SWIPE_PX) { clear(); swallowClick(); host.swipe!(block); return; }
      if (sideways && far > (touch ? TOUCH_SLOP : MOVE_THRESHOLD)) { clearTimeout(timer); return; }
      if (touch ? far > TOUCH_SLOP : far > MOVE_THRESHOLD && (!inField || Math.abs(dy) > Math.abs(dx))) {
        if (touch) { clear(); return; }   // it is a scroll: leave it to the browser
        lift();
      }
    };
    const clear = () => { clearTimeout(timer); idle.abort(); over(); };
    const release = (event: PointerEvent) => { if (event.pointerId === down.pointerId && !lifted) { clear(); } };
    document.addEventListener('pointermove', hold, { signal: idle.signal });
    document.addEventListener('pointerup', release, { signal: idle.signal });
    document.addEventListener('pointercancel', release, { signal: idle.signal });
    if (touch) { timer = setTimeout(() => { if (!lifted) { lift(); } }, HOLD_MS); }
    abort.signal.addEventListener('abort', () => { clear(); cancelDrag?.(); }, { once: true });
  }, { signal: abort.signal });

  return () => abort.abort();
}
