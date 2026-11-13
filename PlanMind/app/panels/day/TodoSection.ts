import {
  CAPS, counter, dayLabel, dayView, fullOwnerOnEdit, newOwners, rowDone, textLimit, todoCounter, todoSlots,
  type BlankAim, type DayView, type Task, type TodoRow,
} from '../../../packages/core/src/planner';
import { RESTORED, cancel, commit, countHtml, deleteHtml, errorHtml, fieldName, paintSession, press, q, textHtml, unpress, wireRow, type Host, type Plan } from '../../inplace/Inline';
import { unsentRest, type Session } from '../../inplace/session';
import { esc, type PanelContext } from '../../panelContext';
import { bothButton, mountBlanks, newName, ownerColor, seatRow } from '../BlankSlots';
import type { Kit } from '../DayPanel';
import { edits, NONE, type DayFields, type DayMeta } from './edits';

type DaySession = Session<DayFields, DayMeta>;

// ---- the add field: the first empty slot ----------------------------------------------------------------------

// Unsent text survives a re-render, and the retry of a failed add reuses its id, so a lost reply cannot add twice.
const todoAdd = { title: '', id: crypto.randomUUID(), refocus: false, error: '' };
/** Whether the add field holds words that were not sent (it is one for every day, so it may not be on the page). */
export const unsentAdd = () => todoAdd.title.trim() !== '';
const fullMessage = (kit: Kit, id: string) => `${kit.nameOf(id)} already has ${CAPS.dayTodosPerList} things to do that day.`;

/** Who a new to-do is for (the top picker: its base list, or both of us under Both) and whether that leaves room for it. Carried to-dos count on today. */
function addState(ctx: PanelContext) {
  const { owners } = newOwners(ctx.selection, ctx.lists, ctx.settings);
  const counts = owners.map(o => todoCounter(ctx.session.tasks, ctx.date, o, undefined, ctx.today));
  const full = counts.findIndex(c => c.over);
  return { owners, used: Math.max(0, ...counts.map(c => c.used)), full: full >= 0 ? owners[full] : '' };
}

/**
 * What the To-do list shows: the open rows from the top, the blank ruled lines under them (the add field the first), and the done rows stacked
 * at the bottom (crossed out, in the same list); or the open rows that did not fit the 13 slots, behind "+N more". Done rows are never hidden
 * and never behind a button; they do not count against the 13 open ones, but they take the last lines of the 13, so the blank lines shrink.
 */
type Shown = 'open' | 'more';
let shown: Shown = 'open', shownDate = '';

function listing(view: DayView, ctx: PanelContext) {
  if (shownDate !== ctx.date) { shown = 'open'; shownDate = ctx.date; }
  const { filled, more, done, empty } = todoSlots(view.todosOpen, view.todosDone);
  if (shown === 'more' && !more.length) { shown = 'open'; }
  return { mode: shown, rows: shown === 'more' ? more : filled, done: shown === 'more' ? [] : done, free: shown === 'open' ? empty : 0, more };
}

const LIST_NAME: Record<Shown, string> = { open: 'To do', more: 'More to do' };
const keyOf = (id: string) => `todo:${id}`;
/** Shown beside Confirm delete for an item that belongs to both lists. */
const BOTH_NOTE = 'Deletes it for both of us.';
/** Where a carried-over to-do comes from, as the muted chip on its row reads: "from Mon Oct 27". */
const fromChip = (item: Task) => `from ${dayLabel(item.date, { weekday: 'short' })} ${dayLabel(item.date, { month: 'short', day: 'numeric' })}`;
/** Where a to-do done on a later day went, as the muted chip on its unchecked row on its own day reads: "→ Tue 3". */
const wentChip = (day: string) => `→ ${dayLabel(day, { weekday: 'short' })} ${dayLabel(day, { day: 'numeric' })}`;

/**
 * The circle of a row that points at the day its to-do was done on (`wentTo`) is unchecked and does nothing here: the to-do is done, on that day
 * (aria-disabled keeps it in the reading order, and its name says so). It is not a write control, so the shell never disables it.
 */
const rowShell = (kit: Kit, row: TodoRow, inner: string, editing = false) => {
  const { item, color, linked, wentTo } = row, done = rowDone(row);
  const circle = wentTo
    ? `<input type="checkbox" class="day-circle" data-c="${color}" aria-disabled="true" aria-label="${esc(`Done on ${dayLabel(wentTo, { weekday: 'short', month: 'short', day: 'numeric' })}: ${item.title}`)}">`
    : `<input type="checkbox" class="day-circle" data-c="${color}" data-writes${done ? ' checked' : ''} aria-label="${done ? 'Reopen' : 'Complete'} ${esc(item.title)}">`;
  return `<li class="day-task${done ? ' day-done' : ''}${editing ? ' day-editing' : ''}" data-id="${esc(item.id)}" data-row="todo"${wentTo ? ' data-went' : ''}${editing ? ` data-editing data-key="${keyOf(item.id)}"` : ''}>
  ${circle}
  ${inner}
  <span class="day-who sr-only" data-c="${color}">${esc(linked ? 'Both' : kit.nameOf(item.owners[0]))}</span></li>`;
};

const todoRow = (kit: Kit, row: TodoRow) => rowShell(kit, row, `<button type="button" class="day-task-title" data-key="${keyOf(row.item.id)}" aria-label="Edit ${esc(row.item.title)}">${esc(row.item.title)}</button>${row.carried ? `<span class="day-from">${esc(fromChip(row.item))}</span>` : row.wentTo ? `<span class="day-from day-went">${esc(wentChip(row.wentTo))}</span>` : ''}`);

/** The row being edited: the title becomes a field of the same size, and the counter, the day and Delete join it. */
function editRow(kit: Kit, row: TodoRow, s: DaySession) {
  const { item } = row;
  return rowShell(kit, row, `${textHtml(fieldName('Edit task', item.title), s.draft.text, 'day-task-title')}
  ${countHtml()}<input type="date" class="ip-date" data-ip="date" aria-label="Day" min="2000-01-01" max="2099-12-31" value="${esc(s.draft.date)}" required>
  ${deleteHtml('task', item.title, s.confirm)}${errorHtml(s.error)}`, true);
}

/** A ruled line with a faint empty circle, like the paper planner's. It is paper: a click on it starts a to-do for whoever the third it is in is for (BlankSlots). */
const GHOST = '<span class="day-ghost" aria-hidden="true"></span>';
/** `line` is the slot's ruled line counted from the top, 1 to 13 (14 for the add field's line when 13 open rows already fill the slots): the open rows above it take the first lines, the done rows are not numbered. */
const blankSlot = (line: number) => `<li class="day-free" data-row="free" data-slot="${line}" aria-hidden="true">${GHOST}</li>`;
/** The first empty slot: the add field. Enter (or Add, which shows once there is text) puts the to-do on this line. */
const addSlot = (ctx: PanelContext, phone: boolean, line: number) => `<li class="day-free day-free-add" data-row="add" data-slot="${line}">${GHOST}<form class="day-add" autocomplete="off" novalidate>
    <input class="day-add-title" data-key="todo:add" aria-label="New task" value="${esc(todoAdd.title)}" placeholder="${phone ? 'Add…' : `Add something for ${ctx.date === ctx.today ? 'today' : 'this day'}…`}" enterkeyhint="done">
    <span class="day-count" data-kind="chars"></span>
    <button type="submit" class="primary day-add-go" hidden>Add</button></form>${bothButton(ctx)}</li>`;

/** A new to-do is one edit over a blank slot, named for its ruled line; it has no stored record yet, so the key says ":new". */
const newKey = (line: number) => `todo:new:${line}`;
/** The slot being written on: a circle in the owner's color and the field, like a priority's blank cell being edited. */
const newRow = (ctx: PanelContext, s: DaySession, line: number) => `<li class="day-task day-editing day-new" data-editing data-row="new" data-key="${s.key}" data-slot="${line}" data-c="${ownerColor(ctx, s.meta.owners)}">
  <span class="day-circle" aria-hidden="true"></span>
  ${textHtml(newName(ctx, s.meta.owners), s.draft.text, 'day-task-title')}${countHtml()}${errorHtml(s.error)}</li>`;

export function html(view: DayView, ctx: PanelContext, kit: Kit): string {
  const phone = kit.phone;
  const { mode, rows, done, free, more } = listing(view, ctx);
  const open = edits.current;
  const canAdd = mode === 'open' && !addState(ctx).full;
  // The slots between the open rows and the done rows are blank lines, the first of them the add field. When those rows of a Both or overlay view
  // (or the done rows of a busy day) already fill the 13 slots while neither list is full, the add field is one more line under the open rows,
  // above the done ones. A new to-do being written takes the blank line it was started on (or the first one when rows came in above it), so it is never lost under a full list.
  const creating = mode === 'open' && open?.meta.kind === 'todo' && !open.meta.stored ? open : null;
  const count = Math.max(free, canAdd ? 1 : 0, creating ? 1 : 0);
  const at = creating ? Math.min(Math.max(creating.meta.line - rows.length - 1, 0), count - 1) : -1;
  const slots = Array.from({ length: count }, (_, i) => {
    const line = rows.length + 1 + i;
    return i === at ? newRow(ctx, creating!, line) : canAdd && i === 0 ? addSlot(ctx, phone, line) : blankSlot(line);
  }).join('');
  const rowHtml = (r: TodoRow) => (open?.key === keyOf(r.item.id) ? editRow(kit, r, open) : todoRow(kit, r));
  const buttons = mode !== 'open' ? '<button type="button" class="day-more" data-list="open">Back to to-do</button>'
    : more.length > 0 ? `<button type="button" class="day-more" data-list="more">+${more.length} more</button>` : '';
  return `<section class="day-sec day-todo" aria-label="To-do">
  <div class="day-todohead"><h2 class="day-label">To-do</h2><span class="day-count" data-kind="todos"></span></div>
  <p class="day-msg" aria-live="polite" hidden></p>
  <ul class="day-tasks" aria-label="${LIST_NAME[mode]}">${rows.map(rowHtml).join('')}${slots}${done.map(rowHtml).join('')}</ul>
  ${buttons ? `<div class="day-more-row">${buttons}</div>` : ''}
</section>`;
}

/** A message hangs under its row (past the row's own line on a desktop); in a list that scrolls it may be past the list's edge, so it is brought into view. */
const showMessage = (root: HTMLElement) => { const error = q(root, 'error'); if (error?.textContent) { error.scrollIntoView({ block: 'nearest' }); } };

/** The keys of the to-dos on the page, for putting away an edit whose row is not there any more. */
export const keys = (view: DayView) => [...view.todosOpen, ...view.todosDone].map(r => keyOf(r.item.id));

export function mount(panel: HTMLElement, ctx: PanelContext, kit: Kit): () => void {
  const section = panel.querySelector<HTMLElement>('.day-todo');
  if (!section) { return () => {}; }
  const find = <T extends HTMLElement>(selector: string) => section.querySelector<T>(selector);
  // The add field exists only while there is a slot for it and room in the list: when 13 are open there is just the message.
  const title = find<HTMLInputElement>('.day-add-title'), go = find<HTMLButtonElement>('.day-add-go'), form = find<HTMLFormElement>('.day-add');
  const msg = find('.day-msg')!, chars = find('[data-kind=chars]'), todos = find('[data-kind=todos]')!;
  if (todoAdd.refocus) { todoAdd.refocus = false; title?.focus(); }

  const state = () => {
    const add = addState(ctx);
    const text = (title?.value ?? todoAdd.title).trim();
    const size = counter(text, textLimit('todo', 'day', add.owners.length > 1));
    return { ...add, size, text };
  };
  function draw() {
    const s = state();
    if (chars) { kit.setCount(chars, s.text ? `${s.size.used} / ${s.size.max}` : '', s.size.over); }
    if (go) { go.hidden = s.text === ''; }
    kit.setCount(todos, `${s.used} of ${CAPS.dayTodosPerList}`, !!s.full);
    const message = s.full ? fullMessage(kit, s.full) : s.size.over ? `Keep it to ${s.size.max} characters.` : todoAdd.error;
    msg.textContent = message; msg.hidden = !message;
  }
  if (go) { kit.guard(go, () => { const s = state(); return s.text !== '' && !s.size.over && !s.full; }); }
  draw();

  title?.addEventListener('input', () => { todoAdd.title = title.value; todoAdd.error = ''; draw(); kit.refresh(); });
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    const s = state();
    if (!go || go.disabled) { return; }
    const result = await ctx.send({ action: 'add', kind: 'todo', id: todoAdd.id, scope: 'day', date: ctx.date, owners: s.owners, title: s.text });
    if (result.ok) {
      // Clear only what was sent; text typed while the write ran stays.
      todoAdd.title = unsentRest(todoAdd.title, s.text);
      todoAdd.id = crypto.randomUUID();
      todoAdd.refocus = true;
      todoAdd.error = '';
      // The panel is not drawn again under a focused field (Enter leaves the focus in it): let go, so the new line shows and the next empty slot takes the field.
      title?.blur();
      ctx.rerender();
    } else if (!result.skipped) { todoAdd.error = result.message; draw(); }
  });

  // Complete/reopen, and open the row's field (a done row is one of the same list: it is crossed out and sits at the bottom, under the blank lines).
  const list = section;
  const found = (event: Event) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-row=todo]')?.dataset.id;
    return ctx.session.tasks.find(t => t.id === id);
  };
  // A tick says which page it was made on (the day shown): a carried row ticked on today is done on today, its own day showing it unchecked.
  list.addEventListener('change', event => {
    const task = found(event), box = event.target as HTMLInputElement;
    if (!task || box.type !== 'checkbox') { return; }
    box.checked = task.done;
    void ctx.send({ action: 'complete', id: task.id, revision: task.revision, done: !task.done, ...(task.done ? {} : { doneOn: ctx.date }) });
  });
  // The circle of a to-do that was done on another day (its own day shows it unchecked) does nothing: its click is not a tick.
  list.addEventListener('click', event => {
    if ((event.target as HTMLElement).closest('input.day-circle[aria-disabled=true]')) { event.preventDefault(); }
  });
  list.addEventListener('click', event => {
    const target = event.target as HTMLElement, task = found(event);
    if (task && target.closest('button.day-task-title, .day-from')) { open(task); }
  });
  // An empty slot is a place to write: a click on any blank line starts a to-do there, for whoever the third of it is in is for (BlankSlots).
  const blanks = find<HTMLElement>('.day-tasks');
  const unmountBlanks = blanks ? mountBlanks(ctx, {
    list: blanks, slot: '.day-free', typed: () => (title?.value ?? todoAdd.title).trim() !== '', focusAdd: () => title?.focus(), open: (aim, slot, onAdd) => openNew(aim, Number(slot.dataset.slot), onAdd),
  }) : () => {};
  section.querySelectorAll<HTMLElement>('.day-more').forEach(button => button.addEventListener('click', () => { shown = button.dataset.list as Shown; ctx.rerender(); }));

  /** A new to-do over a blank slot: its id is made once, so a retried add is the same add. The add field lets go first (the panel is not drawn under it). */
  function openNew(aim: BlankAim, line: number, viaAdd: boolean) {
    title?.blur();
    edits.open(newKey(line), { ...NONE, date: ctx.date }, { kind: 'todo', id: crypto.randomUUID(), stored: false, owners: aim.owners, listId: '', line, viaButton: false, viaAdd, revision: 0 });
    ctx.rerender();
  }

  function open(task: Task) {
    // The revision is the one this edit opened on, so a change by the other person is a stale refusal, not a silent overwrite.
    // Who the to-do is for is not editable: it keeps its owners (to hand it to someone else, add it again under their list).
    edits.open(keyOf(task.id), { ...NONE, text: task.title, date: task.date }, { kind: 'todo', id: task.id, stored: true, owners: task.owners, listId: '', line: 0, viaButton: false, revision: task.revision });
    ctx.rerender();
  }

  const s = edits.current;
  if (s?.meta.kind === 'todo') { (s.meta.stored ? mountEdit : mountNew)(panel, ctx, kit, s); }
  return unmountBlanks;
}

/** A new to-do being written over a blank slot: Enter or the focus leaving adds it, Escape gives the blank back. */
function mountNew(panel: HTMLElement, ctx: PanelContext, kit: Kit, s: DaySession) {
  const root = panel.querySelector<HTMLElement>(`[data-editing][data-key="${s.key}"]`);
  if (!root) { return; }
  const { id, owners } = s.meta;
  const stored = () => ctx.session.tasks.some(t => t.id === id);
  const verdict = () => {
    const text = s.draft.text.trim();
    const size = counter(text, textLimit('todo', 'day', owners.length > 1));
    // Carried-over to-dos count on today, as the server counts them.
    const full = owners.find(o => todoCounter(ctx.session.tasks, ctx.date, o, undefined, ctx.today).over);
    const message = full ? fullMessage(kit, full) : size.over ? `Keep it to ${size.max} characters.` : '';
    return { size, message, ok: text !== '' && message === '' };
  };
  const paint = () => {
    const v = verdict();
    kit.setCount(q(root, 'count')!, `${v.size.used} / ${v.size.max}`, v.size.over);
    paintSession(root, s, 'task', '', s.error || v.message || (s.restored ? RESTORED : ''));
    showMessage(root);
  };
  const plan = (): Plan => {
    const text = s.draft.text.trim(), v = verdict();
    // The add went through and only its reply was lost: it is there, there is nothing more to write.
    if (stored()) { return { kind: 'none' }; }
    if (text === '') { return { kind: 'empty' }; }
    if (!v.ok) { return { kind: 'invalid', message: v.message }; }
    // Written over the add field's line (a click on the empty field): the keyboard goes back to the add field to type the next one, as after
    // Enter in it, unless this to-do fills the list and the field is gone; written over another blank line, it goes to the new to-do.
    return { kind: 'send', said: 'Saved.', focusKey: s.meta.viaAdd && roomAfter() ? 'todo:add' : keyOf(id), mutation: { action: 'add', kind: 'todo', id, scope: 'day', date: ctx.date, owners, title: text } };
  };
  // Whether the add field is still drawn once this to-do is in: it is not when the list the field adds to has no room left.
  const roomAfter = () => addState(ctx).owners.every(o => todoCounter(ctx.session.tasks, ctx.date, o, undefined, ctx.today).used + (owners.includes(o) ? 1 : 0) < CAPS.dayTodosPerList);
  // Closed by hand where the panel cannot be drawn again: the to-do if it was added, the blank line it was written on if not. An open to-do
  // goes after the last open row (ahead of the blank lines), where the next drawing will put it.
  const swap = (row: HTMLElement) => {
    const view = dayView(ctx.input, ctx.date), now = [...view.todosOpen, ...view.todosDone].find(r => r.item.id === id);
    if (!now) { row.outerHTML = blankSlot(Number(row.dataset.slot)); return; }
    seatRow(row, todoRow(kit, now), now, view, li => li.classList.contains('day-done'));
  };
  // Escape and Enter on an empty field return the keyboard to the add field (or the first to-do when the list has none).
  const host: Host<DayFields, DayMeta> = { ctx, edits, s, root: () => root, paint, plan, swap, button: 'todo:add' };
  s.release = () => void commit(host, 'leave');
  wireRow(root, {
    input: field => { s.draft.text = field.value; s.error = ''; s.restored = false; paint(); },
    commit: how => void commit(host, how),
    cancel: () => cancel(host),
    press: () => {},
    unpress: refocus => unpress(host, refocus),
  });
  paint();
  if (s.focus) {
    s.focus = false;
    const field = q<HTMLInputElement>(root, 'text')!;
    field.focus({ preventScroll: false });
    field.setSelectionRange(field.value.length, field.value.length);
  }
}

function mountEdit(panel: HTMLElement, ctx: PanelContext, kit: Kit, s: DaySession) {
  const root = panel.querySelector<HTMLElement>(`[data-editing][data-key="${keyOf(s.meta.id)}"]`);
  const task = () => ctx.session.tasks.find(t => t.id === s.meta.id);
  if (!root || !task()) { return; }
  const verdict = () => {
    const t = task()!, text = s.draft.text.trim();
    const size = counter(text, textLimit('todo', 'day', t.owners.length > 1));
    const full = fullOwnerOnEdit(ctx.session.tasks, t, s.draft.date, t.owners, ctx.today);
    const message = full ? fullMessage(kit, full) : size.over ? `Keep it to ${size.max} characters.` : !/^20\d\d-\d\d-\d\d$/.test(s.draft.date) ? 'Choose a valid day.' : '';
    return { size, message, ok: text !== '' && message === '' };
  };
  const paint = () => {
    const t = task();
    if (!t) { return; }
    const v = verdict();
    kit.setCount(q(root, 'count')!, `${v.size.used} / ${v.size.max}`, v.size.over);
    paintSession(root, s, 'task', t.title, s.error || v.message || (s.restored ? RESTORED : '') || (s.confirm && t.owners.length > 1 ? BOTH_NOTE : ''));
    showMessage(root);
  };
  const plan = (): Plan => {
    const t = task();
    if (!t) { return { kind: 'gone' }; }
    const text = s.draft.text.trim(), v = verdict();
    if (text === '') { return { kind: 'empty' }; }
    if (!v.ok) { return { kind: 'invalid', message: v.message }; }
    if (text === t.title && s.draft.date === t.date) { return { kind: 'none' }; }
    // A to-do given another day leaves this list: say where it went, since the item the keyboard was on is gone.
    const said = s.draft.date === t.date ? 'Saved.' : `Saved. Moved to ${dayLabel(s.draft.date, { weekday: 'short', month: 'short', day: 'numeric' })}.`;
    return { kind: 'send', said, mutation: { action: 'edit', kind: 'todo', id: t.id, revision: s.stale ? t.revision : s.meta.revision, date: s.draft.date, owners: t.owners, title: text } };
  };
  const swap = (row: HTMLElement) => {
    const view = dayView(ctx.input, ctx.date), now = [...view.todosOpen, ...view.todosDone].find(r => r.item.id === s.meta.id);
    if (now) { seatRow(row, todoRow(kit, now), now, view, li => li.classList.contains('day-done')); } else { row.remove(); }
  };
  const host: Host<DayFields, DayMeta> = { ctx, edits, s, root: () => root, paint, plan, swap, button: keyOf(s.meta.id) };
  s.release = () => void commit(host, 'leave');
  wireRow(root, {
    input: field => { if (field.dataset.ip === 'date') { s.draft.date = field.value; } else { s.draft.text = field.value; } s.error = ''; s.restored = false; paint(); },
    commit: how => void commit(host, how),
    cancel: () => cancel(host),
    press: () => press(host, () => { const t = task(); return t ? { action: 'delete', id: t.id, revision: s.stale ? t.revision : s.meta.revision, confirm: true } : null; }, 'todo:add'),
    unpress: refocus => unpress(host, refocus),
  });
  paint();
  if (s.focus) {
    s.focus = false;
    const field = q<HTMLInputElement>(root, 'text')!;
    field.focus({ preventScroll: false });
    field.setSelectionRange(field.value.length, field.value.length);
  }
}
