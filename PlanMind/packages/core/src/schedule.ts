import { itemColor } from './colors';
import { CAPS, type CoreFunctions, type Owners, type ScheduleEvent } from './model';
import { blankAim, blankThirds } from './selection';

const { eventStartMin: DAY_START, eventEndMin: DAY_END, eventStep: STEP, eventMinLength: MIN_LENGTH } = CAPS;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const sharesOwner = (a: readonly string[], b: readonly string[]) => a.some(id => b.includes(id));
/** Events of the same day in any of the owners' lanes, leaving out one id. */
const sameLanes = (events: readonly ScheduleEvent[], date: string, owners: Owners, ignoreId?: string) =>
  events.filter(e => e.date === date && e.id !== ignoreId && sharesOwner(e.owners, owners));

/** Nearest quarter-hour (halves round up). The trailing + 0 turns -0 into 0. */
export const snapQuarter: CoreFunctions['snapQuarter'] = minutes => Math.round(minutes / STEP) * STEP + 0;

/** The length may be left out (a new entry): it then defaults to CAPS.eventDefaultLength, half an hour. */
export const clampEvent = ((start: number, length: number = CAPS.eventDefaultLength) => {
  const len = clamp(snapQuarter(length), MIN_LENGTH, DAY_END - DAY_START);
  return { start: clamp(snapQuarter(start), DAY_START, DAY_END - len), length: len };
}) satisfies CoreFunctions['clampEvent'];

/** Half-open spans, so one event ending where the next starts is fine. Like PHP find_event_overlap, the earliest start wins. */
export const findEventOverlap: CoreFunctions['findEventOverlap'] = (events, date, owners, start, length, ignoreId) => {
  let found: ScheduleEvent | null = null;
  for (const e of sameLanes(events, date, owners, ignoreId)) {
    if (e.start < start + length && start < e.start + e.length && (!found || e.start < found.start)) found = e;
  }
  return found;
};

export const freeStartNear: CoreFunctions['freeStartNear'] = (events, date, owners, start, length, ignoreId) => {
  const len = clampEvent(start, length).length;
  const target = snapQuarter(start);
  const others = sameLanes(events, date, owners, ignoreId);
  let best: number | null = null;
  for (let s = DAY_START; s + len <= DAY_END; s += STEP) {
    if (others.some(e => e.start < s + len && s < e.start + e.length)) continue;
    if (best === null || Math.abs(s - target) < Math.abs(best - target)) best = s;
  }
  return best;
};

/** The lengths a new entry tries, longest first: only the default, which is also the minimum. */
const NEW_LENGTHS = [CAPS.eventDefaultLength];

/** Where a new entry goes when no place is asked for: the nearest free start for the default half hour. */
export const freeSpanNear: CoreFunctions['freeSpanNear'] = (events, date, owners, start) => {
  for (const length of NEW_LENGTHS) {
    const free = freeStartNear(events, date, owners, start, length);
    if (free !== null) return { start: free, length };
  }
  return null;
};

/**
 * Fit the default half hour in the free stretch at the pointer, moving earlier only as far as needed. A shorter gap
 * has no landing. If the pointer's time is occupied, try the nearest free start. The hidden half counts as occupied.
 */
export const fitNewEntry: CoreFunctions['fitNewEntry'] = (events, date, owners, pointer) => {
  const at = clamp(snapQuarter(pointer), DAY_START, DAY_END - STEP);
  const preferred = at - at % MIN_LENGTH;
  const others = sameLanes(events, date, owners);
  if (!others.some(e => e.start < at + STEP && at < e.start + e.length)) {
    const from = Math.max(DAY_START, ...others.filter(e => e.start + e.length <= at).map(e => e.start + e.length));
    const to = Math.min(DAY_END, ...others.filter(e => e.start >= at + STEP).map(e => e.start));
    const length = NEW_LENGTHS.find(len => to - from >= len);
    return length === undefined ? null : { start: clamp(preferred, from, to - length), length };
  }
  return freeSpanNear(events, date, owners, at);
};

/**
 * The other edge stays where it is. A handle stops at the nearest neighbour on its own side, in any lane
 * the event occupies; a neighbour that already overlaps the event (not possible in stored data) is ignored.
 */
export const resizeEvent: CoreFunctions['resizeEvent'] = (events, event, edge, targetMinute) => {
  const end = event.start + event.length;
  const target = snapQuarter(targetMinute);
  const others = sameLanes(events, event.date, event.owners, event.id);
  if (edge === 'start') {
    const floor = Math.max(DAY_START, ...others.filter(e => e.start + e.length <= event.start).map(e => e.start + e.length));
    const start = clamp(target, floor, end - MIN_LENGTH);
    return { start, length: end - start };
  }
  const ceiling = Math.min(DAY_END, ...others.filter(e => e.start >= end).map(e => e.start));
  return { start: event.start, length: clamp(target, event.start + MIN_LENGTH, ceiling) - event.start };
};

/**
 * A shared boundary: the entries in this one's lanes whose bordering edge is the dragged edge move with it. The boundary is held between
 * the dragged entry's minimum and the far side of every bordering entry less its minimum, and, as resizeEvent does, by the window and the
 * nearest other entry on each side, in the lanes of whichever entry grows into it.
 */
export const resizeBoundary: CoreFunctions['resizeBoundary'] = (events, event, edge, targetMinute) => {
  const at = edge === 'start' ? event.start : event.start + event.length;
  const linked = sameLanes(events, event.date, event.owners, event.id)
    .filter(e => (edge === 'end' ? e.start : e.start + e.length) === at);
  if (!linked.length) return { ...resizeEvent(events, event, edge, targetMinute), linked: [] };
  const moving = new Set([event.id, ...linked.map(e => e.id)]);
  const rest = events.filter(e => !moving.has(e.id));
  // Each entry of the boundary may grow only as far as its own lanes are free, and may shrink only to the minimum.
  let low: number = DAY_START, high: number = DAY_END;
  for (const e of [event, ...linked]) {
    const end = e.start + e.length;
    const before = edge === 'end' ? e.id === event.id : e.id !== event.id;   // this entry lies before the boundary
    const others = sameLanes(rest, e.date, e.owners);
    if (before) {
      low = Math.max(low, e.start + MIN_LENGTH);
      high = Math.min(high, ...others.filter(o => o.start >= end).map(o => o.start));
    } else {
      high = Math.min(high, end - MIN_LENGTH);
      low = Math.max(low, ...others.filter(o => o.start + o.length <= e.start).map(o => o.start + o.length));
    }
  }
  // Not possible with stored data (the boundary already sits inside every limit), but never move anything then.
  const b = low > high ? at : clamp(snapQuarter(targetMinute), low, high);
  const span = (e: ScheduleEvent, before: boolean) => before ? { start: e.start, length: b - e.start } : { start: b, length: e.start + e.length - b };
  return {
    ...span(event, edge === 'end'),
    linked: linked.map(e => ({ id: e.id, ...span(e, edge === 'start') })),
  };
};

/** The quarter of an hour row under the pointer, so a 15-minute gap remains distinct when fitting a half-hour entry. */
export const slotStart: CoreFunctions['slotStart'] = (hour, fraction) =>
  DAY_START + hour * 60 + clamp(Math.floor(fraction * (60 / STEP)), 0, 60 / STEP - 1) * STEP;

/** A dragged event lands on the nearest free quarter-hour in the lanes it will occupy: its own owners, or the `owners` a drag across the Both view's thirds asks for. */
export const moveEvent: CoreFunctions['moveEvent'] = (events, event, targetStart, owners = event.owners) =>
  freeStartNear(events, event.date, owners, clampEvent(targetStart, event.length).start, event.length, event.id);

export const moveAim: CoreFunctions['moveAim'] = (sel, lists, settings, lanes, owners, across) =>
  blankThirds(sel, lists, settings, lanes) ? blankAim(sel, lists, settings, lanes, across) : { side: 'only', owners, color: itemColor(owners, lists, settings) };

/** The middle of each third: left, both, right. */
const THIRDS = [1 / 6, 1 / 2, 5 / 6];
export const stepAim: CoreFunctions['stepAim'] = (sel, lists, settings, lanes, owners, direction) => {
  if (!blankThirds(sel, lists, settings, lanes)) return null;
  const lane = lanes.findIndex(l => l.listId === owners[0]);
  const here = owners.length > 1 ? 1 : lane === 0 ? 0 : lane === 1 ? 2 : -1;
  const next = here < 0 ? undefined : THIRDS[here + direction];
  return next === undefined ? null : blankAim(sel, lists, settings, lanes, next);
};

export const stepEvent: CoreFunctions['stepEvent'] = (events, event, direction) => {
  const start = event.start + direction * STEP;
  if (start < DAY_START || start + event.length > DAY_END) return { ok: false, reason: 'window' };
  const clash = findEventOverlap(events, event.date, event.owners, start, event.length, event.id);
  return clash ? { ok: false, reason: 'overlap', with: clash } : { ok: true, start };
};

/** 9a, 9:15a, 12p, 12:15p. On the hour it matches the SCHEDULE_ROWS labels. */
export const timeLabel: CoreFunctions['timeLabel'] = minutes => {
  const day = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const hour = Math.floor(day / 60), minute = day % 60;
  return `${hour % 12 || 12}${minute ? `:${String(minute).padStart(2, '0')}` : ''}${hour < 12 ? 'a' : 'p'}`;
};

/** A window of the day the schedule shows (planner minutes): AM and PM are two of them. `span` is the minutes the grid box stands for, which PM keeps at AM's 14 hours. */
export type SpanWindow = { from: number; to: number; span: number };
/**
 * Where a span of the day sits in a window, for every item the Day draws on its grid (the planner's own entries and CalMind's events alike, so they
 * cannot drift apart): `y` and `h` are fractions of the window's `span`, `q` the first row of a grid of `step`-minute rows (1-based) and `n` its
 * rows (fractional when the span is not on the step, as CalMind's can be), and `clip` names the ends the window cuts off ("top", "bottom", both
 * or none). Null when none of the span is in the window.
 */
export type SpanBox = { y: number; h: number; q: number; n: number; clip: string };
export function spanBox(start: number, length: number, win: SpanWindow, step: number = STEP): SpanBox | null {
  const end = start + length, from = Math.max(start, win.from), to = Math.min(end, win.to);
  if (!(to > from)) return null;
  return { y: (from - win.from) / win.span, h: (to - from) / win.span, q: (from - win.from) / step + 1, n: (to - from) / step, clip: [start < win.from ? 'top' : '', end > win.to ? 'bottom' : ''].filter(Boolean).join(' ') };
}
