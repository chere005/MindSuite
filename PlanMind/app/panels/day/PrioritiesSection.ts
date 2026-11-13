import {
  CAPS, arrangePriorities, counter, dayView, newOwners, pickSlots, suggestSlots, textLimit,
  type DayView, type Lane, type ListId, type Priority, type PriorityCell,
} from '../../../packages/core/src/planner';
import { RESTORED, cancel, commit, countHtml, deleteHtml, errorHtml, fieldName, paintSession, press, q, redraw, textHtml, unpress, wireRow, type Host, type Plan } from '../../inplace/Inline';
import type { Session } from '../../inplace/session';
import { esc, type PanelContext } from '../../panelContext';
import type { Kit } from '../DayPanel';
import { edits, NONE, type DayFields, type DayMeta } from './edits';

type DaySession = Session<DayFields, DayMeta>;

const keyOf = (id: string) => `priority:${id}`;
/** A blank cell is a new priority waiting to be written: the key names the list and the line. */
const blankKey = (listId: ListId, line: number) => `priority:new:${listId}:${line}`;

const cellHtml = (cell: PriorityCell, ctx: PanelContext, kit: Kit) => {
  const text = cell.item.text;
  const who = cell.linked ? 'Both' : kit.nameOf(cell.item.owners[0]);
  return `<button type="button" class="day-cell ${kit.lane(cell.lane, cell.span)}" data-c="${cell.color}" data-id="${esc(cell.item.id)}" data-key="${keyOf(cell.item.id)}" data-lane="${cell.lane}" data-line="${cell.line}" aria-label="${esc(`Priority ${cell.line}: ${text}, ${who}`)}" title="${esc(text)}"><span>${esc(text)}</span></button>`;
};

/** An empty cell: a tap makes a priority for that lane's list on that line (the middle third of a row of two, in the Both view, one for both). */
const blankHtml = (kit: Kit, lane: Lane, index: number, line: number) =>
  `<button type="button" class="day-cell day-blank ${kit.lane(index)}" data-key="${blankKey(lane.listId, line)}" data-lane="${index}" data-line="${line}" aria-label="${esc(`Add priority ${line} for ${lane.name}`)}"></button>`;

/** The cell being edited: its text becomes a field of the same size; the counter, Move up and down and Delete join it. */
const editCellHtml = (cell: PriorityCell, s: DaySession, kit: Kit) => `<div class="day-cell day-editing ${kit.lane(cell.lane, cell.span)}" data-editing data-c="${cell.color}" data-id="${esc(cell.item.id)}" data-key="${keyOf(cell.item.id)}" data-lane="${cell.lane}" data-line="${cell.line}">
  ${textHtml(fieldName(`Edit priority ${cell.line}`, cell.item.text), s.draft.text, 'day-cell-input')}${countHtml()}
  <span class="ip-moves"><button type="button" class="day-move" data-ip="up" aria-label="Move up">↑</button><button type="button" class="day-move" data-ip="down" aria-label="Move down">↓</button></span>
  ${deleteHtml('priority', cell.item.text, s.confirm)}${errorHtml(s.error)}</div>`;

export function html(view: DayView, ctx: PanelContext, kit: Kit): string {
  const open = edits.current;
  const rows = view.priorities.map(row => {
    const covered = new Set<number>();
    const cells = row.cells.map(cell => {
      covered.add(cell.lane); if (cell.span === 2) { covered.add(cell.lane + 1); }
      // A linked priority on different lines of the two lists is two cells: the one in the lane it was opened from is the one edited.
      const mine = open?.key === keyOf(cell.item.id) && view.lanes[cell.lane]?.listId === open.meta.listId;
      return { lane: cell.lane, html: mine ? editCellHtml(cell, open!, kit) : cellHtml(cell, ctx, kit) };
    });
    // A new priority for both of us (the middle third of a row, in the Both view) is one edit over both blanks. It is kept under the
    // left lane's blank key, so the keyboard comes back to that blank when it is left.
    const wide = view.lanes.length === 2 && covered.size === 0;
    const linkedKey = wide ? blankKey(view.lanes[0].listId, row.line) : '';
    if (wide && open?.key === linkedKey && open.meta.kind === 'priority' && open.meta.owners.length > 1) {
      const color = newOwners(ctx.selection, ctx.lists, ctx.settings).color;
      cells.push({
        lane: 0,
        html: `<div class="day-cell day-editing day-blank-edit ${kit.lane(0, 2)}" data-editing data-c="${color}" data-key="${linkedKey}" data-lane="0" data-line="${row.line}">${textHtml(`New priority ${row.line} for ${view.lanes.map(l => l.name).join(' and ')}`, open.draft.text, 'day-cell-input')}${countHtml()}${errorHtml(open.error)}</div>`,
      });
      return `<li class="day-prow" data-line="${row.line}"><span class="day-num">${row.line}.</span><div class="day-pcells ${kit.cols(view.lanes.length)}">${cells.map(c => c.html).join('')}</div></li>`;
    }
    let plain = 0;
    view.lanes.forEach((lane, i) => {
      if (covered.has(i)) { return; }
      const key = blankKey(lane.listId, row.line);
      cells.push({
        lane: i,
        html: open?.key === key
          ? `<div class="day-cell day-editing day-blank-edit ${kit.lane(i)}" data-editing data-c="${lane.color}" data-key="${key}" data-lane="${i}" data-line="${row.line}">${textHtml(`New priority ${row.line} for ${lane.name}`, open.draft.text, 'day-cell-input')}${countHtml()}${errorHtml(open.error)}</div>`
          : (plain++, blankHtml(kit, lane, i, row.line)),
      });
    });
    cells.sort((a, b) => a.lane - b.lane);
    // A screen reader's way to a priority for both of us (the middle third is a pointer's): hidden, and not in the tab order.
    const both = plain === 2 && view.lanes.length === 2 && newOwners(ctx.selection, ctx.lists, ctx.settings).owners.length === 2;
    if (both) { cells.push({ lane: 2, html: `<button type="button" class="sr-only" tabindex="-1" data-both aria-label="${esc(`Add priority ${row.line} for ${view.lanes.map(l => l.name).join(' and ')}`)}"></button>` }); }
    return `<li class="day-prow" data-line="${row.line}"><span class="day-num">${row.line}.</span><div class="day-pcells ${kit.cols(view.lanes.length)}">${cells.map(c => c.html).join('')}</div></li>`;
  });
  return `<section class="day-sec day-prio" aria-label="Priorities">
  <h2 class="day-label">Priorities</h2>
  ${kit.laneHead(view.lanes)}
  <ol class="day-prows">${rows.join('')}</ol>
</section>`;
}

/** The keys of the stored priorities on the page. */
export const keys = (view: DayView) => view.priorities.flatMap(row => row.cells.map(cell => keyOf(cell.item.id)));

/** A blank line of the Both view is cut in thirds across its width: the outer ones are the two lanes, the middle one is a priority for both. */
type Aim = { lane: number; span: 1 | 2; line: number; /** The blank cells it covers, first to last. */ from: HTMLElement; to: HTMLElement };

export function mount(panel: HTMLElement, ctx: PanelContext, kit: Kit): void {
  const section = panel.querySelector<HTMLElement>('.day-prio');
  if (!section) { return; }

  /**
   * What a pointer at `clientX` over a row's cells would make, or null when there is nothing to make there. Two blank cells in the
   * Both view are cut in thirds; anywhere else a blank cell is its own lane (a keyboard activation has no position, so it is the
   * cell's own lane). The click and the hover both ask here.
   */
  function aim(cells: HTMLElement, target: HTMLElement, clientX: number): Aim | null {
    const line = Number(cells.closest<HTMLElement>('.day-prow')?.dataset.line);
    const blanks = [...cells.querySelectorAll<HTMLButtonElement>(':scope > button.day-blank')];
    if (!Number.isInteger(line) || !blanks.length) { return null; }
    const both = blanks.length === 2 && ctx.lanes.length === 2 && newOwners(ctx.selection, ctx.lists, ctx.settings).owners.length === 2;
    const box = cells.getBoundingClientRect(), across = box.width ? (clientX - box.left) / box.width : 0;
    if (both && across >= 1 / 3 && across < 2 / 3) { return { lane: 0, span: 2, line, from: blanks[0], to: blanks[1] }; }
    // The gap between the two cells belongs to the lane on the side the pointer is on.
    const own = target.closest<HTMLButtonElement>('button.day-blank') ?? (both ? blanks[across < 0.5 ? 0 : 1] : null);
    const lane = own ? Number(own.dataset.lane) : -1;
    return own && ctx.lanes[lane] ? { lane, span: 1, line, from: own, to: own } : null;
  }
  const colorOf = (at: Aim) => (at.span === 2 ? newOwners(ctx.selection, ctx.lists, ctx.settings).color : ctx.lanes[at.lane].color);

  // The hover: the cell a tap would make, drawn where it will sit and in the color of whoever it is for. A pointer only (day.css hides it
  // without hover). Each place is a new element and the old one is removed, as the schedule's preview does.
  let ghost: HTMLElement | null = null;
  let ghostAt = '';
  const hideGhost = () => { ghostAt = ''; ghost?.remove(); ghost = null; };
  section.addEventListener('mousemove', event => {
    const target = event.target as HTMLElement, cells = target.closest<HTMLElement>('.day-pcells');
    const at = cells ? aim(cells, target, event.clientX) : null;
    if (!cells || !at) { hideGhost(); return; }
    const where = `${at.line}:${at.lane}:${at.span}`;
    if (where === ghostAt && ghost?.isConnected) { return; }
    hideGhost();
    ghostAt = where;
    ghost = document.createElement('div');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.className = 'day-cell day-newcell';
    ghost.dataset.c = colorOf(at);
    // Over the blank cells it covers, and out of the grid's flow (a grid item would push the blanks to another row).
    Object.assign(ghost.style, { left: `${at.from.offsetLeft}px`, top: `${at.from.offsetTop}px`, width: `${at.to.offsetLeft + at.to.offsetWidth - at.from.offsetLeft}px`, height: `${at.from.offsetHeight}px` });
    cells.append(ghost);
  });
  section.addEventListener('mouseleave', hideGhost);
  // A scroll moves the lines under a resting pointer without a mouse move, so the ghost would sit on a line the pointer has left. The
  // panel outlives this section, so the listener takes itself off once the section is gone.
  const scroller = section.closest<HTMLElement>('#period-panel');
  const scrolled = () => { if (!section.isConnected) { scroller?.removeEventListener('scroll', scrolled); } hideGhost(); };
  scroller?.addEventListener('scroll', scrolled, { passive: true });

  section.addEventListener('click', event => {
    const target = event.target as HTMLElement, cells = target.closest<HTMLElement>('.day-pcells');
    const hidden = target.closest<HTMLElement>('button[data-both]');
    let at = cells && !target.closest('[data-editing]') && !target.closest('button.day-cell:not(.day-blank)') ? aim(cells, target, event.clientX) : null;
    // The other ways to a priority for both of us, with no pointer to place in the middle third: the hidden button (a screen reader's),
    // and Shift on a blank cell (the keyboard's).
    if (cells && (hidden || (event.shiftKey && at && at.span === 1))) {
      const blanks = [...cells.querySelectorAll<HTMLElement>(':scope > button.day-blank')];
      if (blanks.length === 2 && ctx.lanes.length === 2 && newOwners(ctx.selection, ctx.lists, ctx.settings).owners.length === 2) { at = { lane: 0, span: 2, line: Number(cells.closest<HTMLElement>('.day-prow')?.dataset.line), from: blanks[0], to: blanks[1] }; }
    }
    if (at) {
      // A new priority is for the lane that was tapped, or for both of us from the middle third. Its id is made once, so a retried add is the same add.
      const lane = ctx.lanes[at.lane], owners = newOwners(ctx.selection, ctx.lists, ctx.settings, at.span === 2 ? undefined : lane.listId).owners;
      edits.open(blankKey(lane.listId, at.line), NONE, { kind: 'priority', id: crypto.randomUUID(), stored: false, owners, listId: lane.listId, line: at.line, viaButton: false, revision: 0 });
      ctx.rerender();
      return;
    }
    const cell = target.closest<HTMLButtonElement>('button.day-cell');
    if (!cell) { return; }
    const lane = ctx.lanes[Number(cell.dataset.lane)];
    const item = ctx.session.priorities.find(p => p.id === cell.dataset.id) ?? null;
    if (!lane || !item) { return; }
    // An existing priority keeps its owners (an edit never hands it to another list).
    edits.open(keyOf(item.id), { ...NONE, text: item.text }, { kind: 'priority', id: item.id, stored: true, owners: item.owners, listId: lane.listId, line: Number(cell.dataset.line), viaButton: false, revision: item.revision });
    ctx.rerender();
  });

  const s = edits.current;
  if (s?.meta.kind === 'priority') { mountEdit(panel, ctx, kit, s); }
}

function mountEdit(panel: HTMLElement, ctx: PanelContext, kit: Kit, s: DaySession) {
  const { id, stored, owners, listId } = s.meta;
  const root = panel.querySelector<HTMLElement>(`[data-editing][data-key="${s.key}"]`);
  const item = (): Priority | null => (stored ? ctx.session.priorities.find(p => p.id === id) ?? null : null);
  if (!root || (stored && !item())) { return; }
  const lineNow = () => item()?.slots[listId] ?? s.meta.line;
  const slotsFor = () => item()?.slots ?? pickSlots(ctx.session.priorities, ctx.date, owners, null, lineNow());
  const verdict = () => {
    const text = s.draft.text.trim();
    const size = counter(text, textLimit('priority', 'day', owners.length > 1));
    const slots = slotsFor();
    const full = slots ? undefined : owners.find(o => !suggestSlots(ctx.session.priorities.filter(p => p.id !== id), ctx.date, [o]));
    const message = size.over ? `Keep it to ${size.max} characters.` : !slots ? `${kit.nameOf(full ?? owners[0])} already has ${CAPS.prioritySlots} priorities that day.` : '';
    return { size, slots, message, ok: text !== '' && message === '' };
  };
  const moves = [...root.querySelectorAll<HTMLButtonElement>('.day-move')];
  const paint = () => {
    const v = verdict();
    kit.setCount(q(root, 'count')!, `${v.size.used} / ${v.size.max}`, v.size.over);
    paintSession(root, s, 'priority', item()?.text ?? '', s.error || v.message || (s.restored ? RESTORED : '') || (s.confirm && owners.length > 1 ? 'Deletes it for both of us.' : ''));
    if (moves.length) { moves[0].disabled = lineNow() <= 1; moves[1].disabled = lineNow() >= CAPS.prioritySlots; }
  };
  const plan = (): Plan => {
    const text = s.draft.text.trim(), v = verdict(), now = item();
    if (stored && !now) { return { kind: 'gone' }; }
    if (text === '') { return { kind: 'empty' }; }
    if (!v.ok || !v.slots) { return { kind: 'invalid', message: v.message }; }
    if (!now) { return { kind: 'send', said: 'Saved.', focusKey: keyOf(id), mutation: { action: 'add', kind: 'priority', id, date: ctx.date, owners, slots: v.slots, text } }; }
    if (text === now.text) { return { kind: 'none' }; }
    return { kind: 'send', said: 'Saved.', mutation: { action: 'edit', kind: 'priority', id, revision: s.stale ? now.revision : s.meta.revision, date: now.date, owners, slots: v.slots, text } };
  };
  const swap = (cell: HTMLElement) => {
    const view = dayView(ctx.input, ctx.date), now = view.priorities.flatMap(r => r.cells).find(c => c.item.id === id && view.lanes[c.lane]?.listId === listId);
    const lane = view.lanes.findIndex(l => l.listId === listId);
    const line = Number(cell.dataset.line);
    if (now) { cell.outerHTML = cellHtml(now, ctx, kit); }
    else if (!stored && owners.length > 1 && view.lanes.length === 2) { cell.outerHTML = view.lanes.map((l, i) => blankHtml(kit, l, i, line)).join(''); }
    else if (lane >= 0) { cell.outerHTML = blankHtml(kit, view.lanes[lane], lane, line); }
    else { cell.remove(); }
  };
  const host: Host<DayFields, DayMeta> = { ctx, edits, s, root: () => root, paint, plan, swap, button: stored ? keyOf(id) : s.key };
  s.release = () => void commit(host, 'leave');
  /** One line up or down in this list only: its own write, the text typed stays in the field. */
  async function move(direction: number) {
    const now = item();
    if (!now || s.saving || ctx.busy) { return; }
    const batch = arrangePriorities(ctx.session.priorities, ctx.date, listId, id, lineNow() + direction);
    if (!batch.length) { return; }
    s.error = '';
    const result = await ctx.send({ action: 'movePriorities', date: ctx.date, listId, moves: batch });
    if (result.ok) { s.meta.revision += 1; ctx.announce(`Priority moved to line ${lineNow() + direction}.`); redraw(host); }
    else if (!result.skipped) { s.error = result.message; ctx.announce(result.message); paint(); }
  }
  wireRow(root, {
    input: field => { s.draft.text = field.value; s.error = ''; s.restored = false; paint(); },
    commit: how => void commit(host, how),
    cancel: () => cancel(host),
    press: () => press(host, () => (item() ? { action: 'delete', id, revision: s.stale ? item()!.revision : s.meta.revision, confirm: true } : null), blankKey(listId, lineNow())),
    unpress: refocus => unpress(host, refocus),
    alt: event => void move(event.key === 'ArrowDown' ? 1 : -1),
  });
  moves.forEach(button => button.addEventListener('click', () => void move(button.dataset.ip === 'down' ? 1 : -1)));
  paint();
  if (s.focus) {
    s.focus = false;
    const field = q<HTMLInputElement>(root, 'text')!;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }
}
