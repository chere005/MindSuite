import type { Lane, Person } from './model';
import { people } from './people';

/**
 * CalMind's events on the Day schedule (the owner, 2026-11-09). The server reads them from CalMind's own store, read-only, and sends
 * pieces already placed on planner days (server/lib/planner_calmind.php): a piece is one occurrence on one planner day, in planner
 * minutes (420 is 7a, 1860 is 7a the next morning). They are drawn under the planner's own entries, faint, and take no part in
 * anything the schedule decides: they are not entries, a tap goes through them, and an entry may be put on top of one.
 */
export type CalmindEvent = { id: string; owner: Person; date: string; start: number; length: number; text: string; color: string; both?: true };
/**
 * One all-day day of a CalMind event (#171, the owner, 2026-11-09): a whole day has no place on the hour grid, so these go in a compact strip
 * above it. The server sends one per event and planner day it covers: an all-day date D is on planner day D (D 7a to D+1 7a), and a
 * multi-day event is on each day from D through its end date. Read-only, like the pieces, and no part of anything the schedule decides.
 */
export type CalmindAllDay = { id: string; owner: Person; date: string; text: string; color: string; both?: true };
/** GET ?calmind=1&from=&to= (`allDay` is absent from an older server: none). */
export type CalmindReply = { events: CalmindEvent[]; allDay?: CalmindAllDay[] };
/** Whether the Day schedule shows CalMind's events: an account preference (the account library's prefs file, beside the theme). */
export type CalmindVisibility = 'shown' | 'hidden';
export type SetCalmindRequest = { action: 'setCalmind'; hidden: boolean };
export type SetCalmindReply = { calmind: CalmindVisibility };

/**
 * One drawn piece. `owners` is its owner, or both people when an event is on the designated Both calendar or appears on both
 * people's calendars: it is then one piece across both lanes, like an entry for both of us. `lane` is the left
 * lane it starts in and `span` how many lanes it covers; `x` and `w` are its left edge and width as fractions of the whole lane area.
 */
export type CalmindCell = { event: CalmindEvent; owners: Person[]; lane: number; span: 1 | 2; x: number; w: number };

/** The same event on both calendars: the same planner day, start, length and words (case and spacing aside). */
const sameKey = (e: CalmindEvent) => `${e.date}|${e.start}|${e.length}|${e.text.trim().replace(/\s+/g, ' ').toLowerCase()}`;
/** Both people, the owner first, as a piece for both of them names its owners. */
const bothPeople = (): Person[] => [people().owner, people().partner];
const displayOwners = (e: CalmindEvent): Person[] => e.both ? bothPeople() : [e.owner];
type Item = { event: CalmindEvent; both: boolean; col: number; cols: number };
const byTime = (a: Item, b: Item) => a.event.start - b.event.start || b.event.length - a.event.length || (a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0);
const overlaps = (a: CalmindEvent, b: CalmindEvent) => a.start < b.start + b.length && b.start < a.start + a.length;

/** Greedy columns over items sorted by time: each takes the first column free when it starts; a run of overlapping items shares `cols`. */
function columns(items: Item[]): void {
  let run: Item[] = [], ends: number[] = [], runEnd = -Infinity;
  const close = () => { run.forEach(i => { i.cols = ends.length; }); run = []; ends = []; };
  for (const item of items) {
    if (item.event.start >= runEnd) { close(); runEnd = -Infinity; }
    let col = ends.findIndex(end => end <= item.event.start);
    if (col < 0) { col = ends.length; ends.push(0); }
    ends[col] = item.event.start + item.event.length;
    runEnd = Math.max(runEnd, item.event.start + item.event.length);
    item.col = col;
    run.push(item);
  }
  close();
}

/** What the lane arrangement decides for a list of one day's items, shared by the timed pieces and the all-day strip. */
type LaneSplit<T> = { own: T[][]; paired: T[]; left: number; right: number; canSpan: boolean };
type Placed = { owner: Person; both?: true };

/**
 * Which lane each item starts in, and which items are ONE piece across the two people's lanes. The designated Both calendar appears in
 * either personal lane when the lanes are not side by side; side by side, an item on both people's calendars (`keyOf` equal) or on the
 * designated Both calendar is paired into one piece across both. Items are already limited to the day.
 */
function splitLanes<T extends Placed>(items: readonly T[], lanes: readonly Lane[], keyOf: (item: T) => string): LaneSplit<T> {
  const ai = lanes.findIndex(l => l.listId === people().partner), si = lanes.findIndex(l => l.listId === people().owner);
  const left = Math.min(ai, si), right = Math.max(ai, si);
  const canSpan = ai >= 0 && si >= 0 && right - left === 1;
  // When spanning, start each item in its real owner's lane so the pairing pass sees it exactly once.
  const own = lanes.map(({ listId }, i) => items.filter(e => e.owner === listId || !canSpan && e.both && (i === ai || i === si)));
  const paired: T[] = [];
  if (canSpan) {
    const rest = [...own[right]!];
    own[left] = own[left]!.filter(e => {
      const k = rest.findIndex(o => keyOf(o) === keyOf(e));
      if (k < 0 && !e.both) { return true; }
      const other = k >= 0 ? rest.splice(k, 1)[0] : undefined;
      paired.push(other?.both && !e.both ? other : e);
      return false;
    });
    own[right] = rest.filter(e => {
      if (!e.both) { return true; }
      paired.push(e);
      return false;
    });
  }
  return { own, paired, left, right, canSpan };
}

/**
 * The pieces of `date` in the lanes on the page. The designated Both calendar appears in either personal lane. A Both event,
 * when both lanes are on the page side by side, is one piece across them. Pieces
 * that overlap share their lane's width side by side; a piece across both lanes keeps to the inner side of each (the left lane's right
 * columns, the right lane's left ones), so it is one unbroken band and the lane's own pieces stand beside it.
 */
export function calmindCells(events: readonly CalmindEvent[], date: string, lanes: readonly Lane[]): CalmindCell[] {
  const L = lanes.length;
  const { own, paired, left, right } = splitLanes(events.filter(e => e.date === date && e.length > 0), lanes, sameKey);
  const out: CalmindCell[] = [];
  // The lanes no piece crosses: their own columns.
  own.forEach((list, i) => {
    if (i === left && paired.length || i === right && paired.length) { return; }
    const items = list.map(event => ({ event, both: false, col: 0, cols: 1 })).sort(byTime);
    columns(items);
    for (const it of items) { out.push({ event: it.event, owners: displayOwners(it.event), lane: i, span: 1, x: (i + it.col / it.cols) / L, w: 1 / (L * it.cols) }); }
  });
  if (!paired.length) { return out.sort((a, b) => a.event.start - b.event.start || a.x - b.x); }
  // The two lanes a piece crosses. The crossing pieces take columns among themselves (k of them where they overlap); in each lane the
  // lane's own pieces take theirs, and the crossing ones are added on the inner side: column j of k is the left lane's (n + k - 1 - j)th
  // and the right lane's jth (its own pieces then start at k), where n is the lane's own column count over that stretch.
  const span = paired.map(event => ({ event, both: true, col: 0, cols: 1 })).sort(byTime);
  columns(span);
  const place = (lane: number, inner: 'right' | 'left') => {
    const mine = own[lane]!.map(event => ({ event, both: false, col: 0, cols: 1 })).sort(byTime);
    columns(mine);
    // A run is a stretch where the lane's own and the crossing pieces overlap one another; each gets the run's column counts.
    const all = [...mine, ...span].sort(byTime);
    const where = new Map<Item, { col: number; cols: number }>();
    let i = 0;
    while (i < all.length) {
      let end = all[i]!.event.start + all[i]!.event.length, j = i + 1;
      while (j < all.length && all[j]!.event.start < end) { end = Math.max(end, all[j]!.event.start + all[j]!.event.length); j++; }
      const run = all.slice(i, j);
      const n = Math.max(0, ...run.filter(r => !r.both).map(r => r.col + 1)), k = Math.max(0, ...run.filter(r => r.both).map(r => r.col + 1));
      for (const r of run) {
        const col = r.both ? (inner === 'right' ? n + k - 1 - r.col : r.col) : (inner === 'right' ? r.col : k + r.col);
        where.set(r, { col, cols: n + k });
      }
      i = j;
    }
    return { mine, where };
  };
  const a = place(left, 'right'), b = place(right, 'left');
  for (const [lane, side] of [[left, a], [right, b]] as const) {
    for (const it of side.mine) { const p = side.where.get(it)!; out.push({ event: it.event, owners: [it.event.owner], lane, span: 1, x: (lane + p.col / p.cols) / L, w: 1 / (L * p.cols) }); }
  }
  for (const it of span) {
    const pa = a.where.get(it)!, pb = b.where.get(it)!;
    const x = (left + pa.col / pa.cols) / L, x2 = (right + (pb.col + 1) / pb.cols) / L;
    out.push({ event: it.event, owners: bothPeople().filter(p => lanes.some(l => l.listId === p)), lane: left, span: 2, x, w: x2 - x });
  }
  return out.sort((p, q) => p.event.start - q.event.start || p.x - q.x);
}


/** The same all-day event on both calendars: the same planner day and words (case and spacing aside). */
const sameDay = (e: CalmindAllDay) => `${e.date}|${e.text.trim().replace(/\s+/g, ' ').toLowerCase()}`;
const byWords = (a: CalmindAllDay, b: CalmindAllDay) => (a.text < b.text ? -1 : a.text > b.text ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** One all-day chip's place: its lane (the left one when it spans), how many lanes it covers and whom it is for. */
export type AllDayCell = { item: CalmindAllDay; owners: Person[]; lane: number; span: 1 | 2 };

/**
 * The all-day items of `date` in the lanes on the page, placed exactly as the timed pieces are (the same visibility, the same Both rules):
 * an item sits in its owner's lane; one on both people's calendars, or on the designated Both calendar, is a single chip across the two
 * lanes when they are side by side. Within a lane they are in alphabetical order.
 */
export function alldayCells(items: readonly CalmindAllDay[], date: string, lanes: readonly Lane[]): AllDayCell[] {
  const { own, paired, left } = splitLanes(items.filter(e => e.date === date), lanes, sameDay);
  const both = (e: CalmindAllDay): Person[] => e.both ? bothPeople() : [e.owner];
  const out: AllDayCell[] = [];
  own.forEach((list, lane) => { for (const item of [...list].sort(byWords)) { out.push({ item, owners: both(item), lane, span: 1 }); } });
  for (const item of [...paired].sort(byWords)) {
    out.push({ item, owners: bothPeople().filter(p => lanes.some(l => l.listId === p)), lane: left, span: 2 });
  }
  return out;
}

/** The most rows the all-day strip takes; a lane with more shows "+N" in its last row. */
export const ALLDAY_ROWS = 2;
/** One thing drawn in the strip: a chip (`cell`) or the "+N" of what did not fit (`more` items, listed in `hidden`), at a row and lane. */
export type AllDayChip = { row: number; lane: number; span: 1 | 2; cell: AllDayCell | null; more: number; hidden: CalmindAllDay[] };

/**
 * Lays the cells out in at most `rows` rows over `laneCount` lanes without moving anything the grid below decides. Chips across two
 * lanes take the first row with both lanes free, and never the last row while a lane has chips of its own to show (they would leave it
 * nowhere to say "+N"); then each lane's own chips fill its free rows. A lane that cannot show everything shows one fewer chip and a "+N"
 * in its last free row, N counting every item it hides (a hidden chip across two lanes counts in its left lane). A lane left with no free row gives up the last chip that crosses it to the "+N".
 * The result is sorted by row, then lane.
 */
export function alldayStrip(cells: readonly AllDayCell[], laneCount: number, rows = ALLDAY_ROWS): AllDayChip[] {
  const spans = cells.filter(c => c.span === 2), singles = cells.filter(c => c.span === 1);
  const spanRows = singles.length ? rows - 1 : rows;
  const shownSpans: Array<{ cell: AllDayCell; row: number }> = [];
  const hiddenSpans: AllDayCell[] = [];
  spans.forEach((cell, i) => { if (i < spanRows) { shownSpans.push({ cell, row: i }); } else { hiddenSpans.push(cell); } });
  const chips: AllDayChip[] = [];
  const settle = () => {
    chips.length = 0;
    for (const { cell, row } of shownSpans) { chips.push({ row, lane: cell.lane, span: 2, cell, more: 0, hidden: [] }); }
    const overflowLanes = new Set<number>();
    for (let lane = 0; lane < laneCount; lane++) {
      const taken = new Set(shownSpans.filter(({ cell }) => lane >= cell.lane && lane < cell.lane + cell.span).map(({ row }) => row));
      const free = Array.from({ length: rows }, (_, r) => r).filter(r => !taken.has(r));
      const mine = singles.filter(c => c.lane === lane).map(c => c.item);
      const hiddenHere = hiddenSpans.filter(c => c.lane === lane).map(c => c.item);
      if (!hiddenHere.length && mine.length <= free.length) {
        mine.forEach((item, i) => chips.push({ row: free[i]!, lane, span: 1, cell: singles.find(c => c.item === item)!, more: 0, hidden: [] }));
        continue;
      }
      if (!free.length) { overflowLanes.add(lane); continue; }
      const room = free.length - 1;
      mine.slice(0, room).forEach((item, i) => chips.push({ row: free[i]!, lane, span: 1, cell: singles.find(c => c.item === item)!, more: 0, hidden: [] }));
      const rest = [...mine.slice(room), ...hiddenHere];
      chips.push({ row: free[room]!, lane, span: 1, cell: null, more: rest.length, hidden: rest });
    }
    return overflowLanes;
  };
  for (let guard = 0; guard <= cells.length; guard++) {
    const stuck = settle();
    if (!stuck.size) { break; }
    // A lane with no free row: the last chip across it goes into the "+N".
    const crossing = shownSpans.map((x, i) => ({ x, i })).filter(({ x }) => [...stuck].some(l => l >= x.cell.lane && l < x.cell.lane + x.cell.span));
    const drop = crossing.at(-1);
    if (!drop) { break; }
    shownSpans.splice(drop.i, 1);
    hiddenSpans.push(drop.x.cell);
  }
  return chips.sort((a, b) => a.row - b.row || a.lane - b.lane);
}
