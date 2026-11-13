import { CAPS } from '../../../packages/core/src/planner';

/**
 * The plumbing every pointer drag of the schedule shares: the pointer is captured by one element, and the gesture ends
 * exactly once, whichever way it ends (release, cancel by the system, lost capture, Escape, the window losing focus), so a
 * draft is never left half-moved.
 */

/**
 * The part of the day a schedule grid shows, in minutes (data-from, data-to and data-span on it): `from` is its first minute, `to` where the
 * day on that page ends, `span` how many minutes the whole box stands for (the PM page has ten hours but the box keeps the AM's 14-hour scale).
 */
export type Shown = { from: number; to: number; span: number };
export const shownOf = (grid: HTMLElement): Shown => {
  const from = Number(grid.dataset.from) || CAPS.eventStartMin, to = Number(grid.dataset.to) || 21 * 60;
  return { from, to, span: Number(grid.dataset.span) || to - from };
};

/** The minute under a pointer, for a box that stands for `shown.span` minutes from `shown.from`. The box is read live on every call. */
export const minuteAt = (clientY: number, top: number, height: number, shown: Shown = { from: CAPS.eventStartMin, to: 21 * 60, span: 14 * 60 }): number =>
  shown.from + ((clientY - top) / Math.max(1, height)) * shown.span;

/** How long before it leaves the glass a finger's place is taken as where it rested, and how far it may have moved since for that to hold. */
const REST_MS = 80, REST_PX = 8;
const SCROLL_EDGE = 28, SCROLL_SPEED = 8;

const noSelect = (event: Event) => event.preventDefault();

export type GestureHandlers = {
  move(event: PointerEvent): void;
  /** Once, at the end. `cancelled` is true for anything but a release of the pointer. */
  end(cancelled: boolean): void;
};

/**
 * Follows the pointer that went down as `down`, until it is released or the gesture is cancelled. Moves and the release come
 * to `target` (it captures the pointer), wherever the pointer is on the screen or beyond the window. Returns the way to
 * cancel it from the outside.
 */
export function followPointer(target: HTMLElement, down: PointerEvent, h: GestureHandlers): () => void {
  let done = false;
  let scrollFrame = 0;
  try { target.setPointerCapture(down.pointerId); } catch { /* the pointer is already gone; pointercancel or up ends it */ }
  document.documentElement.classList.add('dragging');
  // Clear the mouse selection WebKit can start on press. Clearing a touch selection can scroll a focused edit field
  // back into view, changing the time under the finger just as a handle is grabbed.
  if (down.pointerType !== 'touch') { getSelection()?.removeAllRanges(); }
  document.addEventListener('selectstart', noSelect, true);
  document.addEventListener('dragstart', noSelect, true);
  const mine = (event: PointerEvent) => event.pointerId === down.pointerId;
  const finish = (cancelled: boolean) => {
    if (done) { return; }
    done = true;
    cancelAnimationFrame(scrollFrame);
    document.documentElement.classList.remove('dragging');
    document.removeEventListener('selectstart', noSelect, true);
    document.removeEventListener('dragstart', noSelect, true);
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', cancel);
    target.removeEventListener('lostpointercapture', cancel);
    document.removeEventListener('keydown', key, true);
    window.removeEventListener('blur', cancel);
    document.removeEventListener('touchmove', stopScroll);
    document.removeEventListener('scroll', scrolled, true);
    if (target.hasPointerCapture?.(down.pointerId)) { try { target.releasePointerCapture(down.pointerId); } catch { /* released with the pointer */ } }
    h.end(cancelled);
  };
  let last = down;
  // A finger rolls a few pixels BACK in its last moments on the glass: when a touch
  // leaves with a small reversal of the way it was going (less than REST_PX, in the last REST_MS), it dropped where it rested, not where
  // it left. A finger still going the same way, or going on further, drops where it left.
  const trail: Array<{ t: number; x: number; y: number }> = [];
  const rested = (event: PointerEvent): PointerEvent => {
    if (event.pointerType !== 'touch') { return event; }
    const at = [...trail].reverse().findIndex(p => event.timeStamp - p.t >= REST_MS);
    if (at < 0) { return event; }
    const i = trail.length - 1 - at, rest = trail[i];
    const dx = event.clientX - rest.x, dy = event.clientY - rest.y;
    if (Math.hypot(dx, dy) >= REST_PX) { return event; }
    const before = trail.slice(0, i).reverse().find(p => Math.hypot(rest.x - p.x, rest.y - p.y) >= 3);
    if (!before || (rest.x - before.x) * dx + (rest.y - before.y) * dy >= 0) { return event; }
    return { clientX: rest.x, clientY: rest.y, pointerId: event.pointerId, pointerType: event.pointerType, timeStamp: event.timeStamp } as PointerEvent;
  };
  const move = (event: PointerEvent) => {
    if (!mine(event)) { return; }
    last = event;
    if (event.pointerType === 'touch') { trail.push({ t: event.timeStamp, x: event.clientX, y: event.clientY }); if (trail.length > 24) { trail.shift(); } }
    h.move(event);
  };
  const up = (event: PointerEvent) => { if (mine(event)) { h.move(rested(event)); finish(false); } };
  // A scroll while the button is down (a wheel, the page moving under a still pointer) shifts the grid, not the pointer: the
  // preview and the label follow what is under the pointer now, so the drop lands where the block was shown.
  const scrolled = () => h.move(last);
  // A held finger cannot swipe the timeline, so approaching either edge pans it while the same drag stays active.
  const timeline = down.pointerType === 'touch' ? target.closest<HTMLElement>('.day-timeline') : null;
  if (timeline) {
    const pan = () => {
      const { top, bottom } = timeline.getBoundingClientRect();
      const distance = Math.max(0, last.clientY - (bottom - SCROLL_EDGE)) - Math.max(0, top + SCROLL_EDGE - last.clientY);
      if (distance) { timeline.scrollTop += Math.sign(distance) * Math.min(SCROLL_SPEED, Math.ceil(Math.abs(distance) / 4)); }
      scrollFrame = requestAnimationFrame(pan);
    };
    scrollFrame = requestAnimationFrame(pan);
  }
  const cancel = () => finish(true);
  // Escape cancels the drag and nothing else: the editor behind it stays.
  const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(true); } };
  // A finger that is dragging must not also scroll the page. This is only reached once the drag is on (the long press is
  // over and nothing has scrolled), so a swipe that began as a scroll was never taken over.
  const stopScroll = (event: TouchEvent) => { if (event.cancelable) { event.preventDefault(); } };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', cancel);
  target.addEventListener('lostpointercapture', cancel);
  document.addEventListener('keydown', key, true);
  window.addEventListener('blur', cancel);
  document.addEventListener('touchmove', stopScroll, { passive: false });
  document.addEventListener('scroll', scrolled, true);
  return cancel;
}

/** The "10:45a – 11:15a" label that floats above the pointer while an entry moves, clear of the finger. */
export function createBubble() {
  const el = document.createElement('div');
  el.className = 'day-bubble';
  el.setAttribute('aria-hidden', 'true');
  document.body.append(el);
  return {
    show(text: string, x: number, y: number) {
      el.textContent = text;
      const width = el.offsetWidth;
      el.style.setProperty('--bx', `${Math.round(Math.min(Math.max(8, x - width / 2), innerWidth - width - 8))}px`);
      // Above the pointer: a hand reaches the screen from below, so what is above is never under it.
      el.style.setProperty('--by', `${Math.round(Math.max(8, y - 64))}px`);
    },
    remove() { el.remove(); },
  };
}
