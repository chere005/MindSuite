import { CAPS, resizeBoundary, resizeEvent, timeLabel, type BoundaryResize, type HandleEdge, type ScheduleEvent } from '../../../packages/core/src/planner';
import { createBubble, followPointer, minuteAt, shownOf } from './Gesture';

export { minuteAt };

/** "10:45a – 11:15a", the label shown while a handle moves. */
export const spanLabel = (start: number, length: number): string => `${timeLabel(start)} – ${timeLabel(start + length)}`;

/** The grab area is placed 2px beyond the edge it belongs to (the block's border and the grip's margin close the strip), so reach adds that. */
const GAP = 2;

/**
 * Where each grab area stands, as how far it is moved from its place just outside its edge (the start handle above the entry's top,
 * the end handle below its bottom): positive pulls it in over the entry, negative pushes it away. `room` is the part of the screen a
 * handle can be reached in, `box` the entry's block, `size` the heights of the two areas (0 for a handle that is not there).
 * - An area that would be out of reach is pulled in just far enough (an entry at 7a under the top, one at 8:30p over the tab bar).
 * - Two areas never overlap, so a press lands on one handle only: the top one belongs to the start, the one below it to the end.
 *   When pulling one in would lay it over the other (a short entry, under 88px for two 44px areas), the other one steps back
 *   outside: the one that is held at the edge of the screen stays and the other makes way; with neither held they share the shortfall.
 */
export function grabShifts(room: { top: number; bottom: number }, box: { top: number; bottom: number }, size: { start: number; end: number }): { start: number; end: number } {
  const reach = { start: size.start + GAP, end: size.end + GAP };
  // The start area spans [box.top - size.start + shift, box.top + shift], the end area [box.bottom - shift, box.bottom + size.end - shift].
  // A partly visible editor may need extra shift past its own edge. A wholly hidden editor keeps its handles with it.
  const startLimit = box.bottom <= room.top ? reach.start : Infinity;
  const endLimit = box.top >= room.bottom ? reach.end : Infinity;
  let start = size.start ? Math.min(Math.max(0, Math.ceil(room.top - (box.top - reach.start))), startLimit) : 0;
  let end = size.end ? Math.min(Math.max(0, Math.ceil(box.bottom + reach.end - room.bottom)), endLimit) : 0;
  // Leave one pixel between adjacent grips so rounding a fractional edge cannot give its last hit row to the other grip.
  const overlap = size.start && size.end ? Math.ceil(box.top + start - (box.bottom - end) + 1) : 0;
  if (overlap > 0) {
    if (end > 0 && start === 0) { start -= overlap; }
    else if (start > 0 && end === 0) { end -= overlap; }
    else { start -= Math.ceil(overlap / 2); end -= Math.ceil(overlap / 2); }
  }
  return { start, end };
}

export type HandleOptions = {
  /** The element whose box stands for data-span minutes from data-from (the page shown), so a pointer height maps to a minute. Read again on every move. */
  grid: HTMLElement;
  /** The event as drafted right now: its id (or a placeholder), day, owners, start and length. */
  current(): ScheduleEvent;
  /** The day's entries as the edit sees them (a bordering entry at the span an earlier drag gave it), so a handle can stop at a neighbour. Read when a drag begins. */
  events(): readonly ScheduleEvent[];
  /** Whether an edge that borders other entries is a shared boundary that moves them too (core resizeBoundary); else it stops at them (resizeEvent). */
  link: boolean;
  /** Told on every move with the snapped result, and the bordering entries' new spans. Nothing is saved here. */
  change(next: BoundaryResize): void;
  /** The part of the screen a handle can be reached in (top and bottom, in client pixels): what is above or below it is clipped or covered. */
  room(): { top: number; bottom: number };
};

export type Handles = {
  /** Takes the handles off again. */
  stop(): void;
  /** Moves a handle that would be out of reach (an entry at 7a under the top, one at 8:30p over the tab bar) in over its entry. Call after the block moved. */
  fit(): void;
};

/**
 * Adds a start handle at the top edge and an end handle at the bottom edge of an event block that is in edit
 * mode, and wires pointer dragging for both (mouse, pen and touch: the handle has touch-action none). Each
 * move asks core resizeBoundary (or resizeEvent) for the result (an edge shared with a bordering entry moves both), so the snap to 15 minutes, the 30-minute minimum, the window and
 * the neighbours are core's rules, not this file's. The label floats above the pointer. A drag that is cancelled
 * (Escape, the system, the window losing focus) puts the edge back where it was. A handle sits just outside its edge; where that is
 * out of reach it is pulled in over the entry, so every handle keeps its whole grab area, and two areas never overlap (grabShifts, as --shift, read by day.css).
 */
export function attachHandles(block: HTMLElement, o: HandleOptions): Handles {
  block.insertAdjacentHTML('beforeend',
    '<span class="day-handle" data-edge="start" aria-hidden="true"><i></i></span><span class="day-handle" data-edge="end" aria-hidden="true"><i></i></span>');
  const abort = new AbortController();
  let stop: (() => void) | undefined;
  const zones = [...block.querySelectorAll<HTMLElement>('.day-handle')];
  const zone = (edge: HandleEdge) => zones.find(el => el.dataset.edge === edge)!;
  const fit = () => {
    const box = block.getBoundingClientRect();
    // A short entry's title field can be taller than its marker. Keep both grips outside it where the timeline has room.
    const field = block.querySelector('.day-ev-input')?.getBoundingClientRect();
    const reach = { top: Math.min(box.top, field?.top ?? box.top), bottom: Math.max(box.bottom, field?.bottom ?? box.bottom) };
    const shift = grabShifts(o.room(), reach, { start: zone('start').offsetHeight, end: zone('end').offsetHeight });
    const outset = { start: box.top - reach.top, end: reach.bottom - box.bottom };
    for (const edge of ['start', 'end'] as const) {
      zone(edge).style.setProperty('--shift', `${shift[edge]}px`);
      zone(edge).style.setProperty('--field-outset', `${outset[edge]}px`);
    }
  };

  block.addEventListener('pointerdown', down => {
    const handle = (down.target as HTMLElement).closest<HTMLElement>('.day-handle');
    if (!handle || down.button > 0) { return; }
    // The handle is the drag: the entry under it does not also start to move, and the page does not select text or scroll.
    down.preventDefault(); down.stopPropagation();
    const edge = handle.dataset.edge as HandleEdge;
    const before = o.current(), around = o.events();
    const resize = (minute: number): BoundaryResize => o.link ? resizeBoundary(around, before, edge, minute) : { ...resizeEvent(around, before, edge, minute), linked: [] };
    const rect = o.grid.getBoundingClientRect();
    // The pointer keeps its distance from the edge it grabbed, so the edge does not jump to the pointer.
    const grab = minuteAt(down.clientY, rect.top, rect.height, shownOf(o.grid)) - (edge === 'start' ? before.start : before.start + before.length);
    const bubble = createBubble();
    block.dataset.drag = edge;
    const show = (event: PointerEvent) => { const now = o.current(); bubble.show(spanLabel(now.start, now.length), event.clientX, event.clientY); };
    show(down);
    stop = followPointer(handle, down, {
      move: event => {
        const box = o.grid.getBoundingClientRect();
        // An edge is kept inside the part of the day on the screen: a pointer past the grid puts it at the grid's end, not in the other page, and
        // never so near the end that none of the entry is left on the page (the start stops a step before the page ends, the end a step after it starts).
        const shown = shownOf(o.grid), step = CAPS.eventStep;
        const low = shown.from + (edge === 'end' ? step : 0), high = shown.to - (edge === 'start' ? step : 0);
        o.change(resize(Math.min(high, Math.max(low, minuteAt(event.clientY, box.top, box.height, shown) - grab))));
        fit();
        show(event);
      },
      end: cancelled => {
        // Asking for the edge where it was puts every entry of the boundary back as it was.
        if (cancelled) { o.change(resize(edge === 'start' ? before.start : before.start + before.length)); fit(); }
        delete block.dataset.drag;
        bubble.remove();
        stop = undefined;
      },
    });
  }, { signal: abort.signal });

  fit();
  return { stop: () => { stop?.(); abort.abort(); zones.forEach(el => el.remove()); }, fit };
}
