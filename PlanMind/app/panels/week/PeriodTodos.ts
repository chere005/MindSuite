/**
 * The to-do list of a week or a month (spec 6.1, 7.3), drawn like the Day's: ruled lines like the paper planner's, the open rows in `pos`
 * order from the top, the blank lines under them and the done rows (crossed out) stacked at the bottom of the same list, a colored circle for each item's owner (Both color when linked; the name is there for a screen reader), the add field on
 * the first blank line and faint circles on the blank ones. Week and Month share it. No caps beyond the data limits; the server answers `limit` and the banner says so.
 */
import { counter, dayLabel, monthView, newOwners, periodBlankLines, periodStart, textLimit, weekView, type BlankAim, type ListId, type Owners, type Task, type TodoRow } from '../../../packages/core/src/planner';
import { RESTORED, cancel, commit, countHtml, deleteHtml, errorHtml, fieldName, paintSession, press, q, textHtml, unpress, wireRow, type Host, type Plan } from '../../inplace/Inline';
import { createEdits, unsentRest, type Session } from '../../inplace/session';
import { esc, type PanelContext, type Unmount } from '../../panelContext';
import { bothButton, mountBlanks, newName, ownerColor, seatRow } from '../BlankSlots';

export type TodoScope = 'week' | 'month';

// Unsent text survives a redraw, and a failed add retries with the same id, so a lost reply cannot add twice.
type AddState = { title: string; id: string; refocus: boolean };
const adds = new Map<string, AddState>();
const addState = (scope: TodoScope, date: string): AddState => {
  const key = `${scope}:${date}`;
  let state = adds.get(key);
  if (!state) { state = { title: '', id: crypto.randomUUID(), refocus: false }; adds.set(key, state); }
  return state;
};

/** The one to-do of a week or a month that is being edited where it stands (no window). */
type EditFields = { text: string; date: string };
/** A new to-do (`stored` false) is written over the blank line `line`; it has no record yet and its owners come from the third it was started in. */
type EditMeta = { id: string; scope: TodoScope; owners: Owners; revision: number; listId: ListId; stored: boolean; line: number; viaAdd?: boolean };
const edits = createEdits<EditFields, EditMeta>();
/** Whether words of a week or a month are unsent that the page may not show: an add box of another one, a put-away to-do whose save did not go through. */
export const unsent = () => edits.unsent || [...adds.values()].some(add => add.title.trim() !== '');
type EditSession = Session<EditFields, EditMeta>;
const keyOf = (id: string) => `wm:todo:${id}`;
const ADD_KEY = 'wm:add';

const ownerName = (ctx: PanelContext, owners: Owners) => owners.length > 1 ? 'Both' : ctx.lists.find(l => l.id === owners[0])?.name ?? 'List';
/** The counter shows only near the limit; a title of 500 characters is rare and the live count is for that moment. */
const nearLimit = (used: number, max: number) => used >= Math.floor(max * 0.8);

/** The ruled lines a list shows at least, so an empty list still looks like a page to write on. */
const MIN_LINES: Record<TodoScope, number> = { week: 13, month: 8 };
const GHOST = '<span class="wm-ghost" aria-hidden="true"></span>';
/** `line` is the ruled line's number, counted from the top of the list. A click on a blank line starts a to-do there (BlankSlots). */
const blankLine = (line: number) => `<li class="wm-free" data-slot="${line}" aria-hidden="true">${GHOST}</li>`;
const newKey = (line: number) => `wm:todo:new:${line}`;

const rowShell = (ctx: PanelContext, { item, color }: TodoRow, inner: string, editing = false) => `<li class="wm-todo${item.done ? ' done' : ''}${editing ? ' wm-editing' : ''}" data-id="${esc(item.id)}" data-c="${color}"${editing ? ` data-editing data-key="${keyOf(item.id)}"` : ''}>
  <input type="checkbox" class="wm-check" data-writes${item.done ? ' checked' : ''} aria-label="${item.done ? 'Reopen' : 'Complete'} ${esc(item.title)}">
  ${inner}
  <span class="wm-owner sr-only">${esc(ownerName(ctx, item.owners))}</span></li>`;

const plainRow = (ctx: PanelContext, r: TodoRow) => rowShell(ctx, r, `<button type="button" class="wm-todo-title" data-key="${keyOf(r.item.id)}" aria-label="Edit ${esc(r.item.title)}">${esc(r.item.title)}</button>`);

/** The row being edited: the title becomes a field of the same size, and the counter, the date and Delete join it. */
const editRow = (ctx: PanelContext, r: TodoRow, s: EditSession) => rowShell(ctx, r, `${textHtml(fieldName('Edit to-do', r.item.title), s.draft.text, 'wm-todo-title')}
  ${countHtml()}<input type="date" class="ip-date" data-ip="date" aria-label="${s.meta.scope === 'week' ? 'Week of' : 'Month of'}" min="2000-01-01" max="2099-12-31" value="${esc(s.draft.date)}" required>
  ${deleteHtml('to-do', r.item.title, s.confirm)}${errorHtml(s.error)}`, true);

/** The blank line being written on: a circle in the owner's color and the field, like a priority's blank cell being edited. */
const newRow = (ctx: PanelContext, s: EditSession, line: number) => `<li class="wm-todo wm-editing wm-new" data-editing data-key="${s.key}" data-slot="${line}" data-c="${ownerColor(ctx, s.meta.owners)}">
  <span class="wm-check" aria-hidden="true"></span>
  ${textHtml(newName(ctx, s.meta.owners), s.draft.text, 'wm-todo-title')}${countHtml()}${errorHtml(s.error)}</li>`;

export function todoSectionHtml(ctx: PanelContext, scope: TodoScope, open: TodoRow[], done: TodoRow[]): string {
  const add = addState(scope, ctx.date);
  // An edit belongs to its week or month and to a to-do that is on the page.
  edits.page(`${scope}:${ctx.date}`);
  const shown = new Set([...open, ...done].map(r => keyOf(r.item.id)));
  edits.prune(key => shown.has(key));
  const editing = edits.current;
  const draw = (r: TodoRow) => (editing?.key === keyOf(r.item.id) ? editRow(ctx, r, editing) : plainRow(ctx, r));
  const length = counter(add.title.trim(), textLimit('todo', scope, false));
  // The first blank line is the add field (Enter adds; Add shows once there is text); the rest are blank lines down to the page's minimum, less the done rows,
  // which are the last lines of the page.
  const addLine = (line: number) => `<li class="wm-free wm-free-add" data-slot="${line}">${GHOST}<form class="wm-add" aria-label="Add a to-do" autocomplete="off" novalidate>
    <input class="wm-add-title" data-key="${ADD_KEY}" aria-label="New to-do" placeholder="Add something for this ${scope}…" autocomplete="off" value="${esc(add.title)}" enterkeyhint="done">
    <span class="wm-add-count"${nearLimit(length.used, length.max) ? '' : ' hidden'}>${length.used} / ${length.max}</span>
    <button class="primary wm-add-go" type="submit" data-writes${add.title.trim() ? '' : ' hidden'}>Add</button></form>${bothButton(ctx)}</li>`;
  // A new to-do being written takes the blank line it was started on (the first one when rows came in above it).
  const creating = editing && !editing.meta.stored ? editing : null;
  // One list: the open rows, then the blank lines (at least one, the add line), then the done rows at the bottom.
  const total = periodBlankLines(MIN_LINES[scope], open.length, done.length);
  const at = creating ? Math.min(Math.max(creating.meta.line - open.length - 1, 0), total - 1) : -1;
  const lines = Array.from({ length: total }, (_, i) => {
    const line = open.length + 1 + i;
    return i === at ? newRow(ctx, creating!, line) : i === 0 ? addLine(line) : blankLine(line);
  }).join('');
  return `<ul class="wm-todos" aria-label="To-do">${open.map(draw).join('')}${lines}${done.map(draw).join('')}</ul>`;
}

export function mountTodos(root: HTMLElement, ctx: PanelContext, scope: TodoScope): Unmount {
  const find = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector);
  const add = addState(scope, ctx.date);
  // The add line is the first blank line; a new to-do being written over it takes its place, so the add field may not be on the page.
  const title = find<HTMLInputElement>('.wm-add-title'), addCount = find('.wm-add-count'), go = find<HTMLButtonElement>('.wm-add-go'), form = find<HTMLFormElement>('.wm-add');
  const max = textLimit('todo', scope, false);

  if (add.refocus) { add.refocus = false; title?.focus(); }
  if (title && addCount && go && form) {
    title.oninput = () => {
      add.title = title.value;
      const length = counter(title.value.trim(), max);
      addCount.textContent = `${length.used} / ${length.max}`;
      addCount.hidden = !nearLimit(length.used, length.max);
      go.hidden = title.value.trim() === '';
    };
    form.onsubmit = async event => {
      event.preventDefault();
      const text = title.value.trim();
      // Who a new to-do is for follows the top picker: its base list, or both of us when the base is Both.
      const { owners } = newOwners(ctx.selection, ctx.lists, ctx.settings);
      if (!text) { return; }
      if (counter(text, max).over) { ctx.report(`Use at most ${max} characters.`); return; }
      const result = await ctx.send({ action: 'add', kind: 'todo', id: add.id, scope, date: ctx.date, owners, title: text });
      if (!result.ok) { return; }
      // Only what was sent is cleared; text typed while the write ran stays. The shell redraws once the field is left,
      // so leave it here and take focus again on the redraw.
      add.title = unsentRest(add.title, text);
      add.id = crypto.randomUUID();
      add.refocus = true;
      title.value = add.title;
      go.hidden = add.title.trim() === '';
      title.blur();
    };
  }

  const found = (event: Event): Task | undefined => {
    const id = (event.target as HTMLElement).closest<HTMLElement>('.wm-todo')?.dataset.id;
    return ctx.session.tasks.find(t => t.id === id);
  };
  root.querySelectorAll<HTMLElement>('.wm-todos').forEach(list => {
    list.addEventListener('change', event => {
      const task = found(event), box = event.target as HTMLInputElement;
      if (!task || box.type !== 'checkbox') { return; }
      box.checked = task.done;
      void ctx.send({ action: 'complete', id: task.id, revision: task.revision, done: !task.done });
    });
    list.addEventListener('click', event => {
      const task = found(event);
      if (!task || !(event.target as HTMLElement).closest('button.wm-todo-title')) { return; }
      // The revision is the one this edit opened on, so the other person's change is a stale refusal, not a silent overwrite.
      // The to-do keeps its owners: an edit changes the words and the day.
      edits.open(keyOf(task.id), { text: task.title, date: task.date }, { id: task.id, scope, owners: task.owners, revision: task.revision, listId: '', stored: true, line: 0 });
      ctx.rerender();
    });
  });
  // A blank ruled line is a place to write: a click on it starts a to-do there, for whoever the third of it is in is for (BlankSlots), as on the Day.
  const blanks = find<HTMLElement>('ul.wm-todos[aria-label="To-do"]');
  const unmountBlanks = blanks ? mountBlanks(ctx, {
    list: blanks, slot: '.wm-free', typed: () => (title?.value ?? add.title).trim() !== '', focusAdd: () => title?.focus(),
    open: (aim: BlankAim, slot, onAdd) => {
      const line = Number(slot.dataset.slot);
      title?.blur();
      edits.open(newKey(line), { text: '', date: ctx.date }, { id: crypto.randomUUID(), scope, owners: aim.owners, revision: 0, listId: '', stored: false, line, viaAdd: onAdd });
      ctx.rerender();
    },
  }) : () => {};

  const s = edits.current;
  if (s) { (s.meta.stored ? mountEdit : mountNew)(root, ctx, scope, s); }
  // After Enter or Escape the keyboard goes back to that to-do's button.
  // A to-do given another week or month is not in this list any more: the keyboard goes to the add field.
  const back = edits.takeBack();
  if (back) { (root.querySelector<HTMLElement>(`:is(button,input)[data-key="${back}"]`) ?? (back.startsWith('wm:todo:') ? root.querySelector<HTMLElement>(`input[data-key="${ADD_KEY}"]`) : null))?.focus({ preventScroll: true }); }
  return unmountBlanks;
}

/** A new to-do being written over a blank line: Enter or the focus leaving adds it, Escape gives the blank back. */
function mountNew(root: HTMLElement, ctx: PanelContext, scope: TodoScope, s: EditSession) {
  const row = root.querySelector<HTMLElement>(`[data-editing][data-key="${s.key}"]`);
  if (!row) { return; }
  const { id, owners } = s.meta;
  const stored = () => ctx.session.tasks.some(t => t.id === id);
  const verdict = () => {
    const text = s.draft.text.trim(), size = counter(text, textLimit('todo', scope, owners.length > 1));
    const message = size.over ? `Keep it to ${size.max} characters.` : '';
    return { size, message, ok: text !== '' && message === '' };
  };
  const paint = () => {
    const v = verdict();
    q(row, 'count')!.textContent = `${v.size.used} / ${v.size.max}`;
    q(row, 'count')!.dataset.over = String(v.size.over);
    paintSession(row, s, 'to-do', '', s.error || v.message || (s.restored ? RESTORED : ''));
  };
  const plan = (): Plan => {
    const text = s.draft.text.trim(), v = verdict();
    // The add went through and only its reply was lost: it is there, there is nothing more to write.
    if (stored()) { return { kind: 'none' }; }
    if (text === '') { return { kind: 'empty' }; }
    if (!v.ok) { return { kind: 'invalid', message: v.message }; }
    // Written over the add field's line (a click on the empty field): the keyboard goes back to the add field to type the next one, as after Enter in it.
    return { kind: 'send', said: 'Saved.', focusKey: s.meta.viaAdd ? ADD_KEY : keyOf(id), mutation: { action: 'add', kind: 'todo', id, scope, date: ctx.date, owners, title: text } };
  };
  // Closed by hand where the panel cannot be drawn again: the to-do if it was added, the blank line it was written on if not.
  // An open to-do goes after the last open row (ahead of the blank lines), where the next drawing will put it.
  const swap = (el: HTMLElement) => {
    const view = scope === 'week' ? weekView(ctx.input, ctx.date) : monthView(ctx.input, ctx.date), now = [...view.todosOpen, ...view.todosDone].find(r => r.item.id === id);
    if (!now) { el.outerHTML = blankLine(Number(el.dataset.slot)); return; }
    seatRow(el, plainRow(ctx, now), now, view, li => li.classList.contains('done'));
  };
  const host: Host<EditFields, EditMeta> = { ctx, edits, s, root: () => row, paint, plan, swap, button: ADD_KEY };
  s.release = () => void commit(host, 'leave');
  wireRow(row, {
    input: field => { s.draft.text = field.value; s.error = ''; s.restored = false; paint(); },
    commit: how => void commit(host, how),
    cancel: () => cancel(host),
    press: () => {},
    unpress: refocus => unpress(host, refocus),
  });
  paint();
  if (s.focus) {
    s.focus = false;
    const field = q<HTMLInputElement>(row, 'text')!;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }
}

function mountEdit(root: HTMLElement, ctx: PanelContext, scope: TodoScope, s: EditSession) {
  const row = root.querySelector<HTMLElement>(`[data-editing][data-key="${s.key}"]`);
  const task = () => ctx.session.tasks.find(t => t.id === s.meta.id);
  if (!row || !task()) { return; }
  const dateOf = () => (/^20\d\d-\d\d-\d\d$/.test(s.draft.date) ? periodStart(s.draft.date, scope) : '');
  const verdict = () => {
    const t = task()!, text = s.draft.text.trim();
    const size = counter(text, textLimit('todo', scope, t.owners.length > 1));
    const message = size.over ? `Keep it to ${size.max} characters.` : dateOf() === '' ? 'Choose a valid day.' : '';
    return { size, message, ok: text !== '' && message === '' };
  };
  const paint = () => {
    const t = task();
    if (!t) { return; }
    const v = verdict();
    q(row, 'count')!.textContent = `${v.size.used} / ${v.size.max}`;
    q(row, 'count')!.dataset.over = String(v.size.over);
    paintSession(row, s, 'to-do', t.title, s.error || v.message || (s.restored ? RESTORED : '') || (s.confirm && t.owners.length > 1 ? 'Deletes it for both of us.' : ''));
  };
  const plan = (): Plan => {
    const t = task();
    if (!t) { return { kind: 'gone' }; }
    const text = s.draft.text.trim(), v = verdict(), date = dateOf();
    if (text === '') { return { kind: 'empty' }; }
    if (!v.ok) { return { kind: 'invalid', message: v.message }; }
    if (text === t.title && date === t.date) { return { kind: 'none' }; }
    // The date is any day of the week or month wanted: the to-do belongs to the Monday or the 1st it falls in.
    const said = date === t.date ? 'Saved.' : `Saved. Moved to ${scope === 'week' ? `the week of ${dayLabel(date, { month: 'short', day: 'numeric' })}` : dayLabel(date, { month: 'long', year: 'numeric' })}.`;
    return { kind: 'send', said, mutation: { action: 'edit', kind: 'todo', id: t.id, revision: s.stale ? t.revision : s.meta.revision, date, owners: t.owners, title: text } };
  };
  const swap = (el: HTMLElement) => {
    const view = scope === 'week' ? weekView(ctx.input, ctx.date) : monthView(ctx.input, ctx.date), now = [...view.todosOpen, ...view.todosDone].find(r => r.item.id === s.meta.id);
    if (now) { seatRow(el, plainRow(ctx, now), now, view, li => li.classList.contains('done')); } else { el.remove(); }
  };
  const host: Host<EditFields, EditMeta> = { ctx, edits, s, root: () => row, paint, plan, swap, button: keyOf(s.meta.id) };
  s.release = () => void commit(host, 'leave');
  wireRow(row, {
    input: field => { if (field.dataset.ip === 'date') { s.draft.date = field.value; } else { s.draft.text = field.value; } s.error = ''; s.restored = false; paint(); },
    commit: how => void commit(host, how),
    cancel: () => cancel(host),
    press: () => press(host, () => { const t = task(); return t ? { action: 'delete', id: t.id, revision: s.stale ? t.revision : s.meta.revision, confirm: true } : null; }, ADD_KEY),
    unpress: refocus => unpress(host, refocus),
  });
  paint();
  if (s.focus) {
    s.focus = false;
    const field = q<HTMLInputElement>(row, 'text')!;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }
}
