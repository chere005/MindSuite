import {
  CAPS, SCHEDULE_ROWS, alldayCells, alldayStrip, blankThirds, calmindCells, counter, itemColor, eventCells, findEventOverlap, fitNewEntry, freeSpanNear, moveAim, moveEvent, newOwners, resizeEvent, slotStart, spanBox, stepAim, stepEvent, textLimit, timeLabel,
  type AllDayChip, type BoundaryResize, type CalmindCell, type DayView, type EventCell, type Owners, type ScheduleEvent,
} from '../../../packages/core/src/planner';
import { RESTORED, cancel, commit, fieldName, idle, paintSession, q, textHtml, wireRow, type Host, type Plan } from '../../inplace/Inline';
import type { Session } from '../../inplace/session';
import { esc, icons, type PanelContext } from '../../panelContext';
import type { Kit } from '../DayPanel';
import { edits, NONE, type DayFields, type DayMeta } from './edits';
import { attachEventDelete } from './EventDelete';
import { attachEventDrag } from './EventDrag';
import { attachHandles, spanLabel, type Handles } from './EventHandles';

type DaySession = Session<DayFields, DayMeta>;

/**
 * The schedule has two pages behind an AM and PM switch. AM is the day as it always was, 7a to 9p (14 hour rows); PM starts where AM ended,
 * at 9p, and runs through the night to 7a (ten rows, at the same row height, so a row is the same size on both pages; the night after a date
 * belongs to that date, so an entry at 2a is on the PM page of the evening before). The choice is kept while the
 * page is open; the page always opens on AM.
 */
type Half = 'am' | 'pm';
type Win = { from: number; to: number; span: number; half: Half };
/** The grid box is 14 hours tall on both pages: AM fills it, PM uses its top ten. */
const SPAN = 14 * 60;
const WINDOWS: Record<Half, Win> = {
  am: { from: CAPS.eventStartMin, to: CAPS.eventStartMin + SPAN, span: SPAN, half: 'am' },
  pm: { from: CAPS.eventStartMin + SPAN, to: CAPS.eventEndMin, span: SPAN, half: 'pm' },
};
let chosen: Half = 'am';
/** The half on the screen (the phone menu's AM and PM switch says it). */
export const half = (): Half => chosen;
/** Chooses the half; the entry being edited is saved first, as for the desktop switch. The caller draws the panel again. */
export function setHalf(next: Half) { edits.current?.release?.(); chosen = next; }
const windowOf = (): Win => {
  // The entry being edited stays on the screen: a page that has none of it (it was drafted on the other page, or the other page was asked
  // for while the entry could not be saved yet) gives way to the page it is on.
  const open = edits.current?.meta.kind === 'event' ? edits.current : null;
  if (open && !shape(open.draft.start, open.draft.start + open.draft.length, WINDOWS[chosen])) { chosen = chosen === 'am' ? 'pm' : 'am'; }
  return WINDOWS[chosen];
};

/** Where a span sits on the grid of a window: its first quarter-hour row, its rows, and which of its ends the window cuts off. Null when none of it shows. */
const shape = (start: number, end: number, win: Win) => spanBox(start, end - start, win);
/** Puts a block on the grid at a span (a move shows before the page is drawn again); false, and the block hidden, when none of it is in the window. */
function seat(block: HTMLElement, start: number, length: number, win: Win): boolean {
  const at = shape(start, start + length, win);
  block.hidden = !at;
  if (!at) { return false; }
  block.dataset.q = String(at.q); block.dataset.n = String(at.n); block.dataset.clip = at.clip;
  place(block);
  return true;
}
const keyOf = (id: string) => `event:${id}`;
/** The entry the keyboard returns to when the panel is drawn again after a key moved it to another third: its block has another class then (its lane), which the shell's way of putting the focus back goes by. */
let focusAfter: string | null = null;
/** What an entry's editor last put in the shell's banner (kept across redraws, so the one who said it can take it back). */
let said = '';
const NEW_KEY = 'event:new';

/** Blocks sit on the grid by custom properties set here (not inline style in the markup), read by day.css. */
const place = (el: HTMLElement) => {
  el.style.setProperty('--q', el.dataset.q!);
  el.style.setProperty('--n', el.dataset.n!);
};
/**
 * A block shows as many lines of its words as its height holds (--lines, read by .day-ev-text), and an ellipsis after the last one when
 * there is more. A hidden block or one with no room still gets one line. The words are never cut at a number of characters.
 */
function fitLines(el: HTMLElement) {
  const text = el.querySelector<HTMLElement>('.day-ev-text');
  if (!text) { return; }
  const box = getComputedStyle(el), line = parseFloat(getComputedStyle(text).lineHeight) || 15;
  const room = el.clientHeight - (parseFloat(box.paddingTop) || 0) - (parseFloat(box.paddingBottom) || 0);
  el.style.setProperty('--lines', String(Math.max(1, Math.floor((room + 0.5) / line))));
}

/** What a screen reader says for a block: the words, when, and whose. */
const spoken = (text: string, start: number, end: number, who: string) => `${text}, ${timeLabel(start)} to ${timeLabel(end)}, ${who}`;
/** Brings a block's time and spoken label in line with where it now sits (a move shows before the page is drawn again). */
function retime(block: HTMLElement, text: string, start: number, length: number) {
  block.querySelector('.day-ev-time')!.textContent = timeLabel(start);
  block.setAttribute('aria-label', spoken(text, start, start + length, block.dataset.who ?? ''));
}

/** Brings a block's lane, color and spoken owner in line with the cell it now stands for (a drag across the Both view's thirds shows before the page is drawn again). */
function reskin(block: HTMLElement, cell: EventCell, kit: Kit) {
  block.classList.remove('l0', 'l1', 'l2', 'l3', 'w2');
  block.classList.add(...kit.lane(cell.lane, cell.span).split(' '));
  block.dataset.c = cell.color;
  block.dataset.who = cell.linked ? 'Both' : kit.nameOf(cell.item.owners[0]);
}

/** The entry as the open edit holds it now: what the block shows and what the handles and the drag move. */
const draftOf = (s: DaySession, ctx: PanelContext): ScheduleEvent => ({
  id: s.meta.id, date: ctx.date, owners: s.meta.owners, text: s.draft.text.trim(), start: s.draft.start, length: s.draft.length,
  revision: s.meta.revision, createdBy: ctx.me, updatedBy: ctx.me, createdAt: '', updatedAt: '', ak: '',
});

/** The day's entries with the spans the open edit gives the entries that border it (a shared boundary dragged), before they are saved. */
function withLinked(events: readonly ScheduleEvent[], s: DaySession | null): readonly ScheduleEvent[] {
  const linked = s?.meta.linked;
  if (!linked?.length) { return events; }
  return events.map(e => { const l = linked.find(x => x.id === e.id); return l ? { ...e, start: l.start, length: l.length } : e; });
}

function eventHtml(cell: EventCell, kit: Kit, win: Win): string {
  const at = shape(cell.start, cell.end, win);
  if (!at) { return ''; }
  const { item } = cell;
  const text = item.text || 'New entry';
  const who = cell.linked ? 'Both' : kit.nameOf(item.owners[0]);
  return `<button type="button" class="day-ev ${kit.lane(cell.lane, cell.span)}" data-c="${cell.color}" data-id="${esc(item.id)}" data-key="${keyOf(item.id)}" data-who="${esc(who)}" data-q="${at.q}" data-n="${at.n}" data-clip="${at.clip}" aria-label="${esc(spoken(text, cell.start, cell.end, who))}" title="${esc(item.text)}"><span class="day-ev-time">${timeLabel(cell.start)}</span><span class="day-ev-text">${esc(text)}</span></button>`
    // The way to Delete for a screen reader (a swipe or a key is not one): hidden, and not in the tab order.
    + `<button type="button" class="sr-only" tabindex="-1" data-del-for="${esc(item.id)}">${esc(`Delete ${text}, ${timeLabel(cell.start)} to ${timeLabel(cell.end)}${cell.linked ? ', for both of us' : ''}`)}</button>`;
}

/**
 * The block being edited: its title is a field in the block, the start and end handles are added when it is mounted. The words are all
 * that is typed (the field stops at the limit, so there is no counter); the time and the length are set by dragging the block or a
 * handle. Nothing hangs over the schedule while an entry is edited but a small pill with its start and end (the owner, 2026-11-02; see
 * mountEdit): a message goes to the shell's banner, and Delete is a swipe on the entry (EventDelete).
 */
function editBlockHtml(cell: EventCell, primary: boolean, s: DaySession, kit: Kit, win: Win): string {
  const at = shape(cell.start, cell.end, win);
  if (!at) { return ''; }
  const { item } = cell;
  const who = cell.linked ? 'Both' : kit.nameOf(item.owners[0]);
  const field = primary
    ? textHtml(s.meta.stored ? fieldName('Edit entry', s.base.text) : 'New entry', s.draft.text, 'day-ev-input', ` maxlength="${textLimit('event', 'day', cell.linked)}"`)
    : `<span class="day-ev-text">${esc(s.draft.text.trim() || 'New entry')}</span>`;
  return `<div class="day-ev day-editing ${kit.lane(cell.lane, cell.span)}" data-editing${primary ? ' data-primary' : ''} data-c="${cell.color}" data-id="${esc(item.id)}" data-key="${s.key}" data-who="${esc(who)}" data-q="${at.q}" data-n="${at.n}" data-clip="${at.clip}"><span class="day-ev-time">${timeLabel(cell.start)}</span>${field}</div>`;
}

/** A stored entry's cell at the span the open edit gives it, when it borders the entry being edited and their boundary was dragged. */
function pendingCell(cell: EventCell, open: DaySession | null): EventCell {
  const l = open?.meta.linked?.find(x => x.id === cell.item.id);
  return l ? { ...cell, item: { ...cell.item, start: l.start, length: l.length }, start: l.start, end: l.start + l.length } : cell;
}

/** The AM and PM switch of a desktop (a phone has it in the menu behind the hamburger, Sidebar.ts): which half of the day the grid shows. */
const halfSwitchHtml = (win: Win) => `<div class="day-half" role="group" aria-label="Part of the day">${(['am', 'pm'] as const).map(h =>
  `<button type="button" data-half="${h}" aria-pressed="${win.half === h}">${h === 'am' ? 'AM' : 'PM'}</button>`).join('')}</div>`;

/** The button that hides or shows CalMind's events (pressed while they show), beside the AM and PM switch on a desktop; a phone has it in the menu. The owner, 2026-11-09. */
const calmindButtonHtml = (hidden: boolean) =>
  `<button type="button" class="day-calbtn" aria-pressed="${!hidden}" title="${hidden ? 'Show' : 'Hide'} CalMind events">${icons.calmind}<span>CalMind</span></button>`;
const toolsHtml = (win: Win, hidden: boolean) => `<div class="day-schedtools">${calmindButtonHtml(hidden)}${halfSwitchHtml(win)}</div>`;

/**
 * A CalMind event: faint, under the planner's own entries, and not a control (a tap or a hover goes through it to the slot under it,
 * so an entry can be put on top of it). Its place is a fraction of the window and of the lanes (custom properties set in mount, as for
 * the entries), since CalMind's times are not on the quarter hours; overlapping ones share their lane's width (core calmindCells).
 */
function calmindHtml(cell: CalmindCell, color: string, win: Win): string {
  const { event } = cell;
  // The same function that seats the planner's own entries, so the two cannot drift apart.
  const at = spanBox(event.start, event.length, win);
  if (!at) { return ''; }
  const end = event.start + event.length;
  return `<div class="day-cal" role="listitem" data-c="${color}" data-span="${cell.span}" data-cal="${esc(event.color)}" data-clip="${at.clip}" data-n="${at.n}" data-y="${at.y}" data-h="${at.h}"`
    + ` data-x="${cell.x}" data-w="${cell.w}" aria-label="${esc(`CalMind${cell.owners.length === 2 ? ', both of you' : ''}: ${event.text}, ${timeLabel(event.start)} to ${timeLabel(end)}`)}">`
    + `<span class="day-cal-in"><span class="day-cal-time">${timeLabel(event.start)}</span><span class="day-cal-text">${esc(event.text)}</span></span></div>`;
}
/**
 * The strip of CalMind's all-day events above the timeline (#171, the owner, 2026-11-09): read-only, outside the grid so nothing in it moves a
 * timed card or a slot, and absent (no element at all) when the day has none. A chip sits in its owner's lane column, or across both;
 * a lane with more than fits ends in a "+N" that lists what it hides. Its look is the timed cards' (calmindStyle in day.css).
 */
function alldayHtml(chips: readonly AllDayChip[], view: DayView, ctx: PanelContext, kit: Kit): string {
  if (!chips.length) { return ''; }
  const rows = Math.max(...chips.map(c => c.row)) + 1;
  const cells = chips.map(chip => {
    const where = `data-row="${chip.row}" data-lane="${chip.lane}" data-span="${chip.span}"`;
    if (!chip.cell) {
      const names = chip.hidden.map(h => h.text).join(', ');
      return `<div class="day-ad day-ad-more" role="listitem" ${where} data-c="${view.lanes[chip.lane]!.color}" title="${esc(names)}" aria-label="${esc(`${chip.more} more CalMind all-day events: ${names}`)}"><span class="day-ad-in"><span class="day-ad-text">+${chip.more}</span></span></div>`;
    }
    const { item, owners } = chip.cell;
    const color = owners.length === 2 ? itemColor(owners, ctx.lists, ctx.settings) : view.lanes[chip.lane]!.color;
    return `<div class="day-ad" role="listitem" ${where} data-c="${color}" data-cal="${esc(item.color)}" title="${esc(item.text)}" aria-label="${esc(`CalMind all day${owners.length === 2 ? ', both of you' : ''}: ${item.text}`)}"><span class="day-ad-in"><span class="day-ad-text">${esc(item.text)}</span></span></div>`;
  }).join('');
  return `<div class="day-allday" data-rows="${rows}"><span class="day-allday-gut" aria-hidden="true">all day</span><div class="day-allday-chips ${kit.cols(view.lanes.length)}" role="list" aria-label="CalMind all-day events">${cells}</div></div>`;
}
/** Puts the CalMind events where their data says, and gives each (and each all-day chip) its calendar's color (only a #rrggbb is taken). */
function placeCalmind(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('.day-cal').forEach(el => {
    for (const k of ['y', 'h', 'x', 'w'] as const) { el.style.setProperty(`--c${k}`, el.dataset[k] ?? '0'); }
  });
  root.querySelectorAll<HTMLElement>('.day-cal, .day-ad').forEach(el => {
    const hex = el.dataset.cal ?? '';
    if (/^#[0-9a-f]{6}$/.test(hex)) { el.style.setProperty('--cal', hex); }
  });
}

export function html(view: DayView, ctx: PanelContext, kit: Kit): string {
  const win = windowOf();
  // The hour rows of the window; data-hour counts from 7a whatever the window, so a tap means the same hour in every window.
  const hours = SCHEDULE_ROWS.map((label, hour) => ({ label, hour })).filter(({ hour }) => CAPS.eventStartMin + hour * 60 >= win.from && CAPS.eventStartMin + hour * 60 < win.to);
  const slots = hours.flatMap(({ label, hour }) => view.lanes.map((lane, i) =>
    `<button type="button" class="day-slot" tabindex="-1" data-lane="${i}" data-hour="${hour}" aria-label="Add to ${esc(lane.name)} at ${label}"></button>`)).join('');
  const open = edits.current?.meta.kind === 'event' ? edits.current : null;
  const drafted = open ? eventCells([draftOf(open, ctx)], ctx.date, ctx.lanes, ctx.lists, ctx.settings) : [];
  const hidden = ctx.state.calmindHidden;
  const cals = calmindCells(ctx.state.calmindEvents, ctx.date, view.lanes).map(cell => calmindHtml(cell, cell.owners.length === 2 ? itemColor(cell.owners, ctx.lists, ctx.settings) : view.lanes[cell.lane]!.color, win)).join('');
  const allday = alldayHtml(alldayStrip(alldayCells(ctx.state.calmindAllDay, ctx.date, view.lanes), view.lanes.length), view, ctx, kit);
  // The switch sits on the Schedule heading's line on a desktop (no room for a row of its own). A phone has it, and the CalMind button, in the menu behind the hamburger,
  // and the page says which half it shows in the corner of the lane names, over the hour labels.
  const heading = kit.phone ? `<h2 class="day-label" aria-label="Schedule, ${win.half === 'am' ? 'AM' : 'PM'}">Schedule</h2>` : '<h2 class="day-label">Schedule</h2>';
  return `<section class="day-sec day-sched" aria-label="Schedule" data-half="${win.half}">
  <div class="day-sechead">${heading}<button type="button" class="day-skip day-addentry" data-key="${NEW_KEY}">Add schedule entry</button>${kit.phone ? '' : toolsHtml(win, hidden)}</div>
  ${kit.laneHead(view.lanes, kit.phone ? win.half === 'am' ? 'AM' : 'PM' : '')}${allday}
  <div class="day-timeline" role="region" aria-label="Schedule timeline" tabindex="0"><div class="day-grid"><div class="day-hours" aria-hidden="true">${hours.map(({ label }) => `<span>${label}</span>`).join('')}</div>
    <div class="day-lanes ${kit.cols(view.lanes.length)}" data-from="${win.from}" data-to="${win.to}" data-span="${win.span}"><div class="day-slots">${slots}</div>${cals ? `<div class="day-cals" role="list" aria-label="CalMind events">${cals}</div>` : ''}<div class="day-evs">${
      view.schedule.filter(cell => cell.item.id !== open?.meta.id).map(cell => eventHtml(pendingCell(cell, open), kit, win)).join('')}${
      drafted.map((cell, i) => editBlockHtml(cell, i === 0, open!, kit, win)).join('')}</div></div></div></div>
</section>`;
}

/** The keys of the stored entries on the page. */
export const keys = (view: DayView) => view.schedule.map(cell => keyOf(cell.item.id));

export function mount(panel: HTMLElement, ctx: PanelContext, kit: Kit): () => void {
  const section = panel.querySelector<HTMLElement>('.day-sched');
  if (!section) { return () => {}; }
  const lanesEl = section.querySelector<HTMLElement>('.day-lanes')!, evs = section.querySelector<HTMLElement>('.day-evs')!;
  const win = windowOf();
  evs.querySelectorAll<HTMLElement>('.day-ev').forEach(place);
  placeCalmind(section);
  /** The edit that is open, if any: its block is a draft, and moving it changes the draft, not the stored entry. */
  const s = edits.current?.meta.kind === 'event' ? edits.current : null;
  const timeline = section.querySelector<HTMLElement>('.day-timeline')!;
  const panelScroll = panel.closest<HTMLElement>('#period-panel') ?? panel;
  const scrollers = [timeline, panelScroll];
  /** Handles must fit inside the visible part of the timeline, including when a short desktop scrolls the panel. */
  const room = () => {
    const box = timeline.getBoundingClientRect(), frame = panelScroll.getBoundingClientRect();
    return { top: Math.max(box.top, frame.top), bottom: Math.min(box.bottom, frame.bottom) };
  };
  const cleanups: Array<() => void> = [];
  // Overlay scrollbars take pointer hits without reducing clientWidth. Leave their strip clear of cards and lane labels.
  const fitScrollbar = () => section.toggleAttribute('data-overlay-scrollbar',
    timeline.scrollHeight > timeline.clientHeight && timeline.offsetWidth === timeline.clientWidth);
  let scrollbarFrame = 0;
  const scrollbarSize = new ResizeObserver(() => {
    cancelAnimationFrame(scrollbarFrame);
    scrollbarFrame = requestAnimationFrame(fitScrollbar);
  });
  fitScrollbar();
  scrollbarSize.observe(timeline);
  scrollbarSize.observe(lanesEl);
  cleanups.push(() => { scrollbarSize.disconnect(); cancelAnimationFrame(scrollbarFrame); });
  const sized = new ResizeObserver(blocks => blocks.forEach(b => fitLines(b.target as HTMLElement)));
  evs.querySelectorAll<HTMLElement>('.day-ev').forEach(block => { fitLines(block); sized.observe(block); });
  cleanups.push(() => sized.disconnect());
  if (focusAfter) {
    const again = [...evs.querySelectorAll<HTMLElement>('.day-ev:not(.day-editing)')].find(b => b.dataset.id === focusAfter);
    focusAfter = null;
    again?.focus({ preventScroll: true });
  }
  /** Brings the open edit's block, selects and counter in line with its draft (set when the edit is mounted). */
  let syncDraft: (() => void) | null = null;
  const byId = (id: string | undefined) => ctx.session.events.find(e => e.id === id) ?? null;

  if (s) { cleanups.push(mountEdit(s)); }

  /** The open edit: the handles, the counter and the keys. */
  function mountEdit(s: DaySession): () => void {
    const { id, stored } = s.meta;
    // Who the entry is for can change while it is open (a drag across the Both view's thirds): everything reads it live.
    const owners = () => s.meta.owners;
    const blocks = [...evs.querySelectorAll<HTMLElement>('.day-ev[data-editing]')];
    const root = blocks.find(b => b.hasAttribute('data-primary'));
    if (!root) { return () => {}; }
    const now = () => byId(id);
    /** The day as this edit sees it: the entries that border it at the spans a dragged boundary gave them. */
    const day = () => withLinked(ctx.session.events, s);
    let handles: Handles[] = [];

    const verdict = () => {
      const text = s.draft.text.trim();
      const size = counter(text, textLimit('event', 'day', owners().length > 1));
      const clash = findEventOverlap(day(), ctx.date, owners(), s.draft.start, s.draft.length, id);
      const message = size.over ? `Keep it to ${size.max} characters.` : clash ? `Overlaps “${clash.text}” (${spanLabel(clash.start, clash.length)}).` : '';
      return { size, message, ok: text !== '' && message === '' };
    };
    let toldRestored = false;
    function paint() {
      // The row has no room for a message: a refused or stale save is said in the shell's banner (and read out), once, and taken
      // back when the draft is changed so that it no longer applies.
      const message = s.error;
      if (message && message !== said) { ctx.report(message); said = message; }
      else if (!message && said) { ctx.report(''); said = ''; }
      if (s.restored && !toldRestored) { toldRestored = true; ctx.announce(RESTORED); }
      paintSession(root!, s, 'entry', s.base.text, message);
    }
    /** Brings everything that shows the draft in line with it, without rebuilding the block a handle may be holding. */
    function sync() {
      const d = draftOf(s, ctx);
      const cells = eventCells([d], ctx.date, ctx.lanes, ctx.lists, ctx.settings);
      blocks.forEach((block, i) => {
        if (cells[i]) { reskin(block, cells[i], kit); }
        seat(block, d.start, d.length, win);
        block.querySelector('.day-ev-time')!.textContent = timeLabel(d.start);
        const text = block.querySelector('.day-ev-text');
        if (text) { text.textContent = d.text || 'New entry'; }
      });
      handles.forEach(h => h.fit());
      placeWhen();
      paint();
    }
    const plan = (): Plan => {
      const text = s.draft.text.trim(), v = verdict(), stored_ = now();
      if (stored && !stored_) { return { kind: 'gone' }; }
      if (text === '') { return { kind: 'empty' }; }
      if (!v.ok) { return { kind: 'invalid', message: v.message }; }
      if (!stored_) { return { kind: 'send', said: 'Saved.', focusKey: keyOf(id), mutation: { action: 'add', kind: 'event', id, date: ctx.date, owners: owners(), text, start: s.draft.start, length: s.draft.length } }; }
      // The entries that border it and moved with a dragged boundary (one that is gone since is left out: its room is free).
      const moved = (s.meta.linked ?? []).flatMap(l => {
        const e = byId(l.id);
        return e && (e.start !== l.start || e.length !== l.length) ? [{ id: e.id, revision: s.stale ? e.revision : l.revision, date: e.date, owners: e.owners, text: e.text, start: l.start, length: l.length }] : [];
      });
      if (!moved.length && text === stored_.text && s.draft.start === stored_.start && s.draft.length === stored_.length && owners().join() === stored_.owners.join()) { return { kind: 'none' }; }
      // Text, owners, start and length go in one write, so the handles and the words cannot disagree.
      const self = { id, revision: s.stale ? stored_.revision : s.meta.revision, date: stored_.date, owners: owners(), text, start: s.draft.start, length: s.draft.length };
      // With the entries of a shared boundary, all of them in one write that is taken or refused whole.
      if (moved.length) { return { kind: 'send', said: 'Saved.', mutation: { action: 'editEvents', edits: [self, ...moved] } }; }
      return { kind: 'send', said: 'Saved.', mutation: { action: 'edit', kind: 'event', ...self } };
    };
    /**
     * The entry's span ("7:30p – 8:30p") as a small pill by its top edge, above the start grip, or below the end grip when the grid has no
     * room above (an entry at 7a; a phone's tab bar counts as the end of the room below). It is not part of the block: it is placed, with
     * no effect on the layout, by custom properties, and nothing in the page can be pressed through it. It follows every change of the draft
     * (sync), and gives way to the drag's own bubble while a handle or the block itself is dragged. The owner, 2026-11-02: "show start and end
     * time as a small hover when editing a schedule item".
     */
    const when = document.createElement('div');
    when.className = 'day-when';
    when.setAttribute('aria-hidden', 'true');
    when.hidden = true;
    evs.append(when);
    /**
     * The pill keeps clear of the whole of what stands at the entry's edge: its block and its grips as they are drawn right now (a grip
     * is pulled in or steps out where the screen has no room, EventHandles.fit), not a fixed distance from the block. Any block being
     * lifted, this one or another, hides it: the drag's own bubble is then the one time label.
     */
    const GAP = 2;
    const reachOf = () => {
      const box = root!.getBoundingClientRect();
      let top = box.top, bottom = box.bottom;
      for (const grip of root!.querySelectorAll<HTMLElement>('.day-handle i')) {
        const r = grip.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom); }
      }
      return { top, bottom };
    };
    function placeWhen() {
      const reach = room(), block = root!.getBoundingClientRect();
      when.hidden = !!evs.querySelector('.day-ev[data-moving], .day-ev[data-drag]') || root!.hidden || block.bottom <= reach.top || block.top >= reach.bottom;
      if (when.hidden) { return; }
      when.textContent = spanLabel(s.draft.start, s.draft.length);
      when.dataset.c = root!.dataset.c ?? '';
      const w = when.offsetWidth, h = when.offsetHeight;
      const edge = reachOf(), grid = evs.getBoundingClientRect();
      const up = edge.top - GAP - h, down = edge.bottom + GAP;
      const top = up >= Math.max(grid.top, reach.top) ? up : down + h <= reach.bottom ? down : Math.max(up, reach.top);
      // Over the middle of the block, where the grips are; never past the schedule's left or right edge.
      const left = Math.min(Math.max(2, root!.offsetLeft + root!.offsetWidth / 2 - w / 2), Math.max(2, evs.clientWidth - w - 2));
      when.style.setProperty('--wx', `${Math.round(left)}px`);
      when.style.setProperty('--wy', `${Math.round(top - grid.top)}px`);
    }
    const watchDrag = new MutationObserver(placeWhen);
    watchDrag.observe(evs, { attributes: true, attributeFilter: ['data-moving', 'data-drag'], subtree: true });
    /** The entry's own extras come down: the handles, the pill, and what listens to the page for them. */
    const stop = () => { scrollers.forEach(el => el.removeEventListener('scroll', settle)); window.removeEventListener('resize', settle); watch.disconnect(); watchDrag.disconnect(); when.remove(); handles.forEach(h => h.stop()); handles = []; };
    const swap = () => {
      stop();
      blocks.forEach(block => block.remove());
      const now = byId(id);
      if (now) { evs.insertAdjacentHTML('beforeend', eventCells([now], ctx.date, ctx.lanes, ctx.lists, ctx.settings).map(cell => eventHtml(cell, kit, win)).join(''));  evs.querySelectorAll<HTMLElement>('.day-ev').forEach(block => { place(block); fitLines(block); sized.observe(block); }); }
    };
    const host: Host<DayFields, DayMeta> = { ctx, edits, s, root: () => root, paint, plan, swap, button: stored ? keyOf(id) : s.meta.viaButton ? NEW_KEY : '', emptyMessage: 'Type something, or press Escape to leave it as it was.' };
    s.release = () => void commit(host, 'leave');
    const step = (direction: 1 | -1) => {
      const next = stepEvent(day(), draftOf(s, ctx), direction);
      if (next.ok && !shape(next.start, next.start + s.draft.length, win)) { ctx.announce(`Cannot move ${direction > 0 ? 'later' : 'earlier'} on this half of the day: switch to ${win.half === 'am' ? 'PM' : 'AM'}.`); return; }
      if (next.ok) {
        s.draft.start = next.start; s.error = ''; s.restored = false;
        sync();
        q<HTMLInputElement>(root!, 'text')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        ctx.announce(spanLabel(next.start, s.draft.length));
      }
      else { ctx.announce(next.reason === 'window' ? `Cannot move ${direction > 0 ? 'later' : 'earlier'}: it is at the ${direction > 0 ? 'end' : 'start'} of the schedule.` : `Cannot move ${direction > 0 ? 'later' : 'earlier'}: it would overlap ${next.with.text}.`); }
    };
    /**
     * A handle's result: the entry's new span, and the new spans of the entries that border it when their shared boundary moved (kept in
     * the edit, drawn at once, saved with the entry). A span with none of the entry on this half of the day is not taken.
     */
    const resized = (next: BoundaryResize): boolean => {
      if (!shape(next.start, next.start + next.length, win)) { return false; }
      s.draft.start = next.start; s.draft.length = next.length; s.error = ''; s.restored = false;
      if (next.linked.length) {
        const kept = (s.meta.linked ?? []).filter(l => !next.linked.some(n => n.id === l.id));
        s.meta.linked = [...kept, ...next.linked.map(n => ({ ...n, revision: (s.meta.linked ?? []).find(l => l.id === n.id)?.revision ?? byId(n.id)?.revision ?? 0 }))];
        for (const n of next.linked) {
          const e = byId(n.id);
          evs.querySelectorAll<HTMLElement>('.day-ev:not(.day-editing)').forEach(block => {
            if (block.dataset.id === n.id && e) { seat(block, n.start, n.length, win); retime(block, e.text || 'New entry', n.start, n.length); }
          });
        }
      }
      sync();
      return true;
    };
    /** The keyboard's way to drag the bottom handle: a quarter hour longer or shorter, as far as the window, the minimum and a neighbour allow (it stops at a bordering entry; only a handle's drag moves a shared boundary). */
    const lengthen = (direction: 1 | -1) => {
      const draft = draftOf(s, ctx), next: BoundaryResize = { ...resizeEvent(day(), draft, 'end', draft.start + draft.length + direction * CAPS.eventStep), linked: [] };
      const word = direction > 0 ? 'longer' : 'shorter';
      if (next.length === draft.length) { ctx.announce(`Cannot make it ${word}.`); }
      else if (!resized(next)) { ctx.announce(`Cannot make it ${word} on this half of the day: switch to ${win.half === 'am' ? 'PM' : 'AM'}.`); }
      else { ctx.announce(spanLabel(next.start, next.length)); }
    };
    wireRow(root, {
      input: field => {
        s.error = ''; s.restored = false;
        s.draft.text = field.value;
        sync();
      },
      commit: how => void commit(host, how),
      cancel: () => cancel(host),
      // Delete is not a control of the row: it is a swipe on the entry (EventDelete).
      press: () => {},
      unpress: () => {},
      alt: event => (event.shiftKey ? lengthen : step)(event.key === 'ArrowDown' ? 1 : -1),
    });
    blocks.forEach(block => handles.push(attachHandles(block, { grid: lanesEl, current: () => draftOf(s, ctx), events: day, link: stored, room, change: next => { resized(next); } })));
    // The page scrolling or the window changing size moves the entry under the handles: where each may go is worked out again.
    function settle() { handles.forEach(h => h.fit()); placeWhen(); }
    scrollers.forEach(el => el.addEventListener('scroll', settle, { passive: true }));
    window.addEventListener('resize', settle);
    const watch = new ResizeObserver(settle);
    watch.observe(lanesEl);
    watch.observe(timeline);
    syncDraft = sync;
    sync();
    if (s.focus) {
      s.focus = false;
      const field = q<HTMLInputElement>(root, 'text')!;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }
    // Leaving the edit takes its message out of the banner.
    return () => { stop(); if (said && edits.current !== s) { ctx.report(''); said = ''; } };
  }

  /** One write that moves a stored entry to a new start, and to other owners when it was dragged across the Both view's thirds. Text and length stay as stored; the write carries its revision. */
  const moveTo = (event: ScheduleEvent, start: number, owners: Owners = event.owners) =>
    ctx.send({ action: 'edit', kind: 'event', id: event.id, revision: event.revision, date: event.date, owners, text: event.text, start, length: event.length });
  /** Whom a drag or a key may make an entry for, and how it is said: the thirds of the Both view, a person by name ("you" for the signed-in one), both of us as "both of you". */
  const forWhom = (owners: Owners) => owners.length > 1 ? 'both of you' : owners[0] === ctx.me ? 'you' : kit.nameOf(owners[0]);

  // Dragging an entry: the block follows the pointer in 15-minute steps and lands on the nearest free quarter hour in its lanes.
  // A block that is being edited is a draft (nothing is written until Enter or the focus leaves); any other block is written on the
  // drop, and snaps back when the write is refused or stale (the shell then shows why and reads the day again, as for every write).
  // Delete is a swipe on an entry, then a tap on the Delete it shows (the keyboard: Delete or Backspace on the entry).
  const deleter = attachEventDelete(section, { ctx, evs, byId });
  const detachDrag = attachEventDrag(section, {
    grid: lanesEl,
    swipe: block => deleter.open(block),
    lifted: () => deleter.close(),
    events: () => withLinked(ctx.session.events, s),
    eventOf: block => {
      if (block.classList.contains('day-editing')) { return s ? draftOf(s, ctx) : null; }
      // The write in flight decides what the entry is now: a press on it waits for that, and says so.
      if (ctx.busy) { ctx.announce('Still saving. Try again in a moment.'); return null; }
      return byId(block.dataset.id);
    },
    visible: (start, length) => !!shape(start, start + length, win),
    // In the Both view with the two lanes the pointer's third says whom the entry is for; anywhere else a drag keeps its owners.
    aim: (event, across) => {
      const aimed = moveAim(ctx.selection, ctx.lists, ctx.settings, ctx.lanes, event.owners, across);
      return aimed.side === 'only' ? null : { owners: aimed.owners, label: aimed.side === 'both' ? 'Both' : kit.nameOf(aimed.owners[0]) };
    },
    preview: (block, event, start, owners) => {
      if (block.classList.contains('day-editing')) { if (s && shape(start, start + s.draft.length, win)) { s.draft.start = start; s.meta.owners = owners; s.error = ''; s.restored = false; syncDraft?.(); } return; }
      const cell = eventCells([{ ...event, owners }], ctx.date, ctx.lanes, ctx.lists, ctx.settings)[0];
      if (cell) { reskin(block, cell, kit); }
      seat(block, start, event.length, win);
      retime(block, event.text || 'New entry', start, event.length);
    },
    // A save that the press itself started (it took the focus out of an entry being edited) is waited for.
    drop: async (block, event, start, owners) => { if (block.classList.contains('day-editing')) { return true; } await idle(ctx); return (await moveTo(event, start, owners)).ok; },
  });

  // Alt+Up and Alt+Down move the focused entry by 15 minutes, through the same write, and say what happened. Presses that come
  // while a write is in flight wait in line (each one a step from where the last landed); a step that fails drops the ones behind it.
  let line: Promise<void> = Promise.resolve(), waiting = 0, generation = 0;
  async function stepKey(id: string, later: boolean, turn: number) {
    const event = byId(id);
    if (!event || turn !== generation) { return; }
    const step = stepEvent(ctx.session.events, event, later ? 1 : -1);
    const name = event.text || 'The entry';
    // A move that takes the entry out of the half on the screen is not made (the edit's own step says the same).
    if (step.ok && !shape(step.start, step.start + event.length, win)) { generation++; ctx.announce(`${name} cannot move ${later ? 'later' : 'earlier'} on this half of the day: switch to ${win.half === 'am' ? 'PM' : 'AM'}.`); return; }
    if (!step.ok) { generation++; ctx.announce(step.reason === 'window' ? `${name} cannot move ${later ? 'later' : 'earlier'}: it is at the ${later ? 'end' : 'start'} of the schedule.` : `${name} cannot move ${later ? 'later' : 'earlier'}: it would overlap ${step.with.text}.`); return; }
    const result = await moveTo(event, step.start);
    if (!result.ok) { generation++; } else { focusAfter = id; }
    ctx.announce(result.ok ? `${name} moved to ${spanLabel(step.start, event.length)}.` : result.skipped ? '' : result.message);
  }
  /**
   * Alt+Left and Alt+Right in the Both view with the two lanes: the focused entry is for the next one over (one person, Both, the other; the left lane
   * is the signed-in person), placed at the nearest free quarter hour for them and saved in one write, like a drag across the thirds. It
   * is said out loud: "Dinner is for both of you, 6:45p – 7:30p."
   */
  async function sideKey(id: string, direction: -1 | 1, turn: number) {
    const event = byId(id);
    if (!event || turn !== generation) { return; }
    const name = event.text || 'The entry';
    const aim = stepAim(ctx.selection, ctx.lists, ctx.settings, ctx.lanes, event.owners, direction);
    if (!aim) { generation++; ctx.announce(`${name} is for ${forWhom(event.owners)}: it cannot go further ${direction < 0 ? 'left' : 'right'}.`); return; }
    const start = moveEvent(ctx.session.events, event, event.start, aim.owners);
    if (start === null) { generation++; ctx.announce(`${name} cannot be for ${forWhom(aim.owners)}: there is no room.`); return; }
    if (!shape(start, start + event.length, win)) { generation++; ctx.announce(`${name} cannot be for ${forWhom(aim.owners)} on this half of the day: switch to ${win.half === 'am' ? 'PM' : 'AM'}.`); return; }
    const result = await moveTo(event, start, aim.owners);
    if (!result.ok) { generation++; } else { focusAfter = id; }
    ctx.announce(result.ok ? `${name} is for ${forWhom(aim.owners)}, ${spanLabel(start, event.length)}.` : result.skipped ? '' : result.message);
  }
  section.addEventListener('keydown', key => {
    const block = (key.target as HTMLElement).closest<HTMLElement>('.day-ev:not(.day-editing)');
    const sideways = key.key === 'ArrowLeft' || key.key === 'ArrowRight';
    if (!block || !key.altKey || (key.key !== 'ArrowUp' && key.key !== 'ArrowDown' && !sideways)) { return; }
    const id = block.dataset.id;
    // Outside the Both view's thirds the keys are not ours (Alt+Left is the browser's Back on some systems).
    if (sideways && !blankThirds(ctx.selection, ctx.lists, ctx.settings, ctx.lanes)) { return; }
    key.preventDefault();
    if (!id || !byId(id)) { return; }
    // A write that is not one of these steps (a to-do, a note) is in flight: say so instead of dropping the press without a word.
    if (ctx.busy && waiting === 0) { ctx.announce('Still saving. Try again in a moment.'); return; }
    const turn = generation;
    waiting++;
    const run = sideways ? () => sideKey(id, key.key === 'ArrowRight' ? 1 : -1, turn) : () => stepKey(id, key.key === 'ArrowDown', turn);
    line = line.then(run).catch(() => { generation++; }).finally(() => { waiting--; });
  });
  /** The day's entries as a new one has to fit around them: the open entry counts at the span its draft has now (a new one only once it has words, as without them leaving drops it). */
  function occupied(): ScheduleEvent[] {
    const open = edits.current?.meta.kind === 'event' ? edits.current : null;
    if (!open) { return ctx.session.events; }
    const rest = withLinked(ctx.session.events, open).filter(e => e.id !== open.meta.id);
    return open.meta.stored || open.draft.text.trim() ? [...rest, draftOf(open, ctx)] : rest;
  }
  /**
   * What a new entry for these owners has to fit around: the day's entries, and, with a half of the day on the screen, the other half
   * as taken (a wall): a new entry is wholly in the half that is shown (the other half is a switch away), so it is never cut at the edge.
   */
  function around(owners: ScheduleEvent['owners']): ScheduleEvent[] {
    const wall = (from: number, to: number): ScheduleEvent[] => to > from
      ? [{ id: `wall:${from}`, date: ctx.date, owners, text: '', start: from, length: to - from, revision: 0, createdBy: ctx.me, updatedBy: ctx.me, createdAt: '', updatedAt: '', ak: '' }] : [];
    return [...occupied(), ...wall(CAPS.eventStartMin, win.from), ...wall(win.to, CAPS.eventEndMin)];
  }
  /**
   * Where a tap on a slot starts a new entry: the precise hit time (core slotStart) and the half-hour placement the core
   * gives an entry there (fitNewEntry: the free stretch around the pointer, else the nearest free start). With two lanes and the Both
   * view, the schedule is cut in thirds across its width: the outer thirds are the lanes and the middle third is one entry for both
   * (the linked one). The click and the hover preview both ask here.
   * `found` is null when those lanes have no room; the whole answer is null when the slot is not a lane of the page any more.
   */
  function landing(slot: HTMLElement, clientX: number, clientY: number) {
    const lane = ctx.lanes[Number(slot.dataset.lane)];
    if (!lane) { return null; }
    const wide = ctx.lanes.length === 2 && newOwners(ctx.selection, ctx.lists, ctx.settings).owners.length === 2;
    const grid = lanesEl.getBoundingClientRect(), across = grid.width ? (clientX - grid.left) / grid.width : 0;
    const linked = wide && across >= 1 / 3 && across < 2 / 3;
    const { owners, color } = linked ? newOwners(ctx.selection, ctx.lists, ctx.settings) : newOwners(ctx.selection, ctx.lists, ctx.settings, lane.listId);
    const box = slot.getBoundingClientRect();
    return { lane, linked, owners, color, found: fitNewEntry(around(owners), ctx.date, owners, slotStart(Number(slot.dataset.hour), box.height ? (clientY - box.top) / box.height : 0)) };
  }
  /** The hover preview: the span a tap would give the new entry, drawn where that entry will sit. A pointer only (day.css hides it without hover). */
  // Each place is a new element and the old one is removed (a box moved by changing its grid row left stale dashed boxes behind in WebKit).
  let preview: HTMLElement | null = null;
  let previewAt = '';
  const hidePreview = () => { previewAt = ''; preview?.remove(); preview = null; };
  section.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch' || event.buttons !== 0) { hidePreview(); return; }
    const slot = (event.target as HTMLElement).closest<HTMLElement>('.day-slot');
    const landed = slot ? landing(slot, event.clientX, event.clientY) : null;
    const found = landed?.found;
    if (!slot || !landed || !found) { hidePreview(); return; }
    const at = `${landed.linked ? 'both' : slot.dataset.lane}:${found.start}:${found.length}`;
    if (at === previewAt) { return; }
    previewAt = at;
    preview?.remove();
    preview = document.createElement('div');
    preview.setAttribute('aria-hidden', 'true');
    preview.className = `day-preview ${landed.linked ? kit.lane(0, 2) : kit.lane(Number(slot.dataset.lane))}`;
    preview.dataset.c = landed.color;
    preview.style.setProperty('--q', String((found.start - win.from) / CAPS.eventStep + 1));
    preview.style.setProperty('--n', String(found.length / CAPS.eventStep));
    preview.textContent = spanLabel(found.start, found.length);
    evs.append(preview);
  });
  section.addEventListener('pointerleave', hidePreview);
  // Changes in layout can move an occupied interval under a resting pointer before the browser sends another move.
  scrollers.forEach(el => el.addEventListener('scroll', hidePreview, { passive: true }));
  window.addEventListener('resize', hidePreview);
  cleanups.push(() => {
    scrollers.forEach(el => el.removeEventListener('scroll', hidePreview));
    window.removeEventListener('resize', hidePreview);
  });
  /** Where "no room" is said to be: the page of the day on the screen. */
  const part = win.half === 'am' ? ' before 9p' : ' after 9p';
  /**
   * A tap on an empty slot while something was being edited only puts that edit away, and the keyboard with it (the owner, 2026-11-01: it was
   * awkward to hide the keyboard when the same tap also started another entry). Read at the press, since the edit is already closing by the click.
   */
  let awayTap = false;
  section.addEventListener('pointerdown', down => {
    hidePreview();
    awayTap = !!edits.current && !!(down.target as HTMLElement).closest('.day-slot');
  }, { capture: true });
  section.addEventListener('pointercancel', () => { awayTap = false; hidePreview(); });
  section.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    const away = awayTap && !!target.closest('.day-slot');   // a press that began on a slot and was an edit's tap away
    awayTap = false;
    if (away) {
      edits.current?.release?.();
      (document.activeElement as HTMLElement | null)?.blur?.();
      hidePreview();
      return;
    }
    if (target.closest('.day-calbtn')) {
      void ctx.state.setCalmindHidden(!ctx.state.calmindHidden);
      return;
    }
    const half = target.closest<HTMLElement>('[data-half]:is(button)');
    if (half) {
      // Leaving the entry being edited saves it first; then the other half is drawn.
      edits.current?.release?.();
      chosen = half.dataset.half === 'pm' ? 'pm' : 'am';
      ctx.rerender();
      return;
    }
    const block = target.closest<HTMLElement>('.day-ev:not(.day-editing)');
    const slot = target.closest<HTMLElement>('.day-slot');
    if (block) {
      const stored = byId(block.dataset.id);
      if (stored) { open(stored); }
    } else if (slot) {
      const landed = landing(slot, event.clientX, event.clientY);
      if (!landed) { return; }
      const { lane, linked, owners, found } = landed;
      if (!found) { ctx.report(linked ? `There is no room left${part}.` : `${lane.name} has no room left${part}.`); } else { openNew(owners, found.start, found.length); }
    } else if (target.closest('.day-addentry')) {
      const { owners } = newOwners(ctx.selection, ctx.lists, ctx.settings);
      const found = freeSpanNear(around(owners), ctx.date, owners, Math.min(Math.max(9 * 60, win.from), win.to - CAPS.eventDefaultLength));
      if (!found) { ctx.report(`There is no room left${part}.`); } else { openNew(owners, found.start, found.length, true); }
    }
  });

  /** A stored entry keeps its owners and the revision it was opened on. */
  function open(event: ScheduleEvent) {
    edits.open(keyOf(event.id), { ...NONE, text: event.text, start: event.start, length: event.length }, { kind: 'event', id: event.id, stored: true, owners: event.owners, listId: '', line: 0, viaButton: false, revision: event.revision });
    ctx.rerender();
  }
  /** A new entry: the id is made once, so a retried add is the same add. */
  function openNew(owners: ScheduleEvent['owners'], start: number, length: number, viaButton = false) {
    edits.open(NEW_KEY, { ...NONE, start, length }, { kind: 'event', id: crypto.randomUUID(), stored: false, owners, listId: '', line: 0, viaButton, revision: 0 });
    ctx.rerender();
  }
  return () => { detachDrag(); deleter.detach(); cleanups.forEach(run => run()); };
}
