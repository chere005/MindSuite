import '../styles/inplace.css';
import type { Mutation } from '../../packages/core/src/planner';
import { esc, icons, TEXT_FIELD, type PanelContext } from '../panelContext';
import type { SendResult } from '../state';
import type { Edits, Fields, Session } from './session';

/**
 * Editing where the item is. The pieces every section shares: the markup of the small controls that join a row while it is
 * edited, the wiring of the keyboard and the focus (one rule for leaving a row), and the path from Enter to a write.
 *
 * The rule for leaving, the same everywhere: Enter in a field saves. Escape cancels. Moving the focus to another field or
 * control of the same row (Tab, a click on its date or its Delete) keeps editing; the focus going anywhere else (Tab out of
 * the last control, a click on another item or on the page) saves, exactly as Enter would, and an empty new item is dropped.
 */

/** Said in a row that was opened again with the unsaved text it was left with. */
export const RESTORED = 'Your unsaved changes are back.';

/** The accessible names of an editor's controls: "Edit task: Buy milk". */
export const fieldName = (what: string, text: string) => `${what}${text ? `: ${text}` : ''}`;

/** The text field of a row being edited. `cls` lets the host's CSS size it like the text it replaces. */
export const textHtml = (name: string, value: string, cls: string, extra = '') =>
  `<input type="text" class="ip-input ${cls}" data-ip="text" aria-label="${esc(name)}" value="${esc(value)}" autocomplete="off" autocapitalize="sentences" spellcheck="false" enterkeyhint="done"${extra}>`;

export const countHtml = () => '<span class="ip-count" data-ip="count" aria-hidden="true"></span>';
export const errorHtml = (message: string) => `<span class="ip-error" data-ip="error" role="status" aria-live="polite">${esc(message)}</span>`;

/** Delete: the trash icon. The first press turns it red (it is armed), the second deletes; it disarms itself. `what` is the kind: "task", "priority", "entry". */
export const deleteHtml = (what: string, text: string, confirm: boolean) =>
  `<span class="ip-del-pair"${confirm ? ' data-confirm' : ''}><button type="button" class="ip-del" data-ip="del" data-writes aria-label="${confirm ? 'Confirm delete' : esc(`Delete ${fieldName(what, text)}`)}">${icons.trash}</button></span>`;

export const q = <T extends HTMLElement = HTMLElement>(root: ParentNode, name: string) => root.querySelector<T>(`[data-ip="${name}"]`);

/** Brings the parts of a row that depend on the session (not on the fields) in line with it. */
export function paintSession<D extends Fields, M>(root: HTMLElement, s: Session<D, M>, what: string, text: string, message: string) {
  const error = q(root, 'error');
  if (error && error.textContent !== message) { error.textContent = message; }
  root.toggleAttribute('data-error', message !== '');
  root.toggleAttribute('data-saving', s.saving);
  root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[data-ip],select[data-ip]').forEach(field => { if (field instanceof HTMLInputElement && field.type === 'text') { field.readOnly = s.saving; } });
  const del = q<HTMLButtonElement>(root, 'del');
  if (del) {
    root.toggleAttribute('data-confirm', s.confirm);
    root.querySelector('.ip-del-pair')?.toggleAttribute('data-confirm', s.confirm);
    del.setAttribute('aria-label', s.confirm ? 'Confirm delete' : `Delete ${fieldName(what, text)}`);
  }
}

export type RowHooks = {
  /** A field changed (text or date as typed; a select when chosen). */
  input(field: HTMLInputElement | HTMLSelectElement): void;
  commit(how: 'enter' | 'leave'): void;
  cancel(): void;
  /** Delete: the first press asks (confirm(true)), the second deletes. */
  press(): void;
  /** The focus leaving the pair, or the time running out: the first press is forgotten. `refocus` returns the keyboard to the field. */
  unpress(refocus: boolean): void;
  /** Alt+Up and Alt+Down in a field. */
  alt?(event: KeyboardEvent): void;
};

/** Wires one row that is being edited. `root` holds every field and control of the row. */
export function wireRow(root: HTMLElement, h: RowHooks) {
  rowHooks.set(root, h);
  root.addEventListener('input', event => { const field = event.target as HTMLElement; if (field.matches('input[data-ip],select[data-ip]')) { h.input(field as HTMLInputElement); } });
  root.addEventListener('change', event => { const field = event.target as HTMLElement; if (field.matches('select[data-ip],input[data-ip=date]')) { h.input(field as HTMLInputElement); } });
  root.addEventListener('keydown', event => {
    const target = event.target as HTMLElement;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); h.cancel(); return; }
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && h.alt) { event.preventDefault(); h.alt(event); return; }
    if (event.key === 'Enter' && !event.isComposing && target.matches('input[data-ip],select[data-ip]')) { event.preventDefault(); h.commit('enter'); }
  });
  root.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-ip=del]')) { h.press(); }
  });
  // The pointer never takes the focus out of the field when it presses a button or the padding of the row, so a press on Delete,
  // on a handle or on the block itself is not "leaving".
  root.addEventListener('mousedown', event => { if (!(event.target as HTMLElement).closest('input,select,textarea,label,option')) { event.preventDefault(); } });
  root.addEventListener('focusout', event => {
    if (releasing || redrawing || !root.isConnected) { return; }
    const to = event.relatedTarget as Node | null;
    // Another field or control of the same row keeps the row open (leaving Delete or Cancel for one of them forgets the first press, so
    // a stray Enter later does not delete). So does the window losing the focus: it comes back to the field.
    if (to && root.contains(to)) {
      if ((event.target as Element).closest('.ip-del-pair') && !(to as Element).closest('.ip-del-pair')) { h.unpress(false); }
      return;
    }
    if (!document.hasFocus()) { return; }
    h.commit('leave');
  });
}

/** Resolves when no write is in flight (a save asked for while another runs waits its turn). */
export const idle = (ctx: PanelContext): Promise<void> => ctx.busy ? new Promise(resolve => {
  const off = ctx.state.subscribe(change => { if (change === 'busy' && !ctx.busy) { off(); resolve(); } });
}) : Promise.resolve();

export type Plan =
  /** Nothing differs from what is stored: just close. */
  | { kind: 'none' }
  /** Nothing typed: a new item is dropped, a stored one keeps what it has. */
  | { kind: 'empty' }
  | { kind: 'invalid'; message: string }
  /** The record is gone (deleted elsewhere): nothing to save into. */
  | { kind: 'gone' }
  | { kind: 'send'; mutation: Mutation; said: string; focusKey?: string };

export type Host<D extends Fields, M> = {
  ctx: PanelContext;
  edits: Edits<D, M>;
  s: Session<D, M>;
  /** The row as it is on the page now (it is drawn again after every redraw of the panel). */
  root(): HTMLElement | null;
  /** Brings the whole row (counters, errors, controls) in line with the session. */
  paint(): void;
  plan(how: 'enter' | 'leave'): Plan;
  /** The item's own button, to return the keyboard to after Enter or Escape. */
  button: string;
  /** What Enter says on a stored item that was emptied (the default points at the row's Delete, which an entry does not have). */
  emptyMessage?: string;
  /** Puts the row's plain form in its place, as it reads now (what the redraw will make of it): used when the shell cannot draw the panel again. */
  swap(root: HTMLElement): void;
};

/** True while the code, not the person, takes the focus out of a row: that is not "leaving". */
let releasing = false;
/** True from the moment a panel is taken down until the redraw is done: a focused control going away with its row is not "leaving" either. */
let redrawing = false;
export function markRedraw() { redrawing = true; setTimeout(() => { redrawing = false; }, 0); }

/** Takes the focus out of the row (so the panel may be drawn again) when it is still in it. */
function release(root: HTMLElement | null) {
  const active = document.activeElement;
  if (!(root && root.isConnected && active instanceof HTMLElement && root.contains(active))) { return; }
  releasing = true;
  try { active.blur(); } finally { releasing = false; }
}

/** The row stays open but must be drawn again (a priority moved to another line): the field takes the focus back after the redraw. */
export function redraw<D extends Fields, M>(h: Host<D, M>) {
  h.s.focus = true;
  release(h.root());
  h.ctx.rerender();
}

/**
 * Ends the edit: the row goes back to plain text at the next redraw. The shell draws the panel again only when no text field of it
 * has the focus; when the focus went to one (the add box, a note) the row is swapped by hand for what the redraw will make of it,
 * so a closed row never stays on the page as a field.
 */
export function finish<D extends Fields, M>(h: Host<D, M>, focusKey?: string) {
  const root = h.root();
  h.edits.close(h.s.key, focusKey);
  release(root);
  h.ctx.rerender();
  const stuck = () => {
    const active = document.activeElement;
    return !!root && root.isConnected && active instanceof HTMLElement && active.matches(TEXT_FIELD) && !root.contains(active) && !!active.closest('#period-panel');
  };
  if (stuck()) { h.swap(root!); return; }
  // The focus leaving for a text field is reported before it has arrived (document.activeElement is the body while the old field
  // loses it), so the row of a close that happens in that event is checked once more when the focus has landed. The shell's own
  // redraw was asked for first, so it has either drawn the row away by then or skipped it because of that field.
  setTimeout(() => { if (stuck()) { h.swap(root!); } }, 0);
}

export function cancel<D extends Fields, M>(h: Host<D, M>) {
  if (h.edits.current !== h.s || h.s.saving) { return; }
  finish(h, h.button);
}

/** The result of a write, for the row that made it. */
function settle<D extends Fields, M>(h: Host<D, M>, result: SendResult, plan: Extract<Plan, { kind: 'send' }>, refocus: boolean) {
  const { ctx, s, edits } = h;
  s.saving = false;
  if (result.ok) {
    ctx.announce(plan.said);
    if (edits.current === s) { finish(h, refocus ? plan.focusKey ?? h.button : undefined); } else { edits.forget(s.key); }
    return;
  }
  if (result.skipped) { s.error = ''; h.paint(); return; }
  if (result.code === 'gone') {
    ctx.announce(result.message);
    if (edits.current === s) { finish(h); } else { edits.forget(s.key); }
    return;
  }
  edits.keep(s);
  // Stale: the text typed stays, and the next Enter saves it over the newer version.
  s.stale = result.code === 'stale';
  s.error = s.stale ? `${result.message} Enter saves yours over it, Escape keeps theirs.` : result.message;
  ctx.announce(s.error);
  h.paint();
}

/** Enter, or the focus leaving the row: one write when there is something valid to write. */
export async function commit<D extends Fields, M>(h: Host<D, M>, how: 'enter' | 'leave') {
  const { edits, s, ctx } = h;
  if (edits.current !== s || s.saving) { return; }
  const plan = h.plan(how);
  s.error = '';
  switch (plan.kind) {
    case 'none': finish(h, how === 'enter' ? h.button : undefined); return;
    case 'gone': ctx.report('That item is gone.'); finish(h); return;
    case 'empty':
      // Leaving a new item with nothing in it drops it; Enter on a stored item that was emptied asks for text or Delete.
      if (how === 'leave' || s.key.includes(':new')) { finish(h, how === 'enter' ? h.button : undefined); } else { s.error = h.emptyMessage ?? 'Type something, or use Delete.'; h.paint(); }
      return;
    case 'invalid': s.error = plan.message; h.paint(); return;
    case 'send': break;
  }
  s.saving = true;
  h.paint();
  await idle(ctx);
  settle(h, await ctx.send(plan.mutation), plan, how === 'enter');
}

/** Delete, after its second press. */
async function remove<D extends Fields, M>(h: Host<D, M>, mutation: Mutation, focusKey: string) {
  const { s, ctx } = h;
  s.saving = true; s.error = '';
  h.paint();
  await idle(ctx);
  settle(h, await ctx.send(mutation), { kind: 'send', mutation, said: 'Deleted.', focusKey }, true);
}

/** An armed delete forgets itself after this long (as CalMind's does), whatever the pointer or the keyboard did. */
const ARMED_MS = 2500;
const armedFor = new WeakMap<object, ReturnType<typeof setTimeout>>();
/** The hooks each row was wired with: a redraw wires a new row for the same edit, and the timer must act on the one on the page. */
const rowHooks = new WeakMap<Element, RowHooks>();
/** Forgets the first press after ARMED_MS, on the row that is on the page then (not the one the press was made on); a write still running waits. */
function disarmLater<D extends Fields, M>(h: Host<D, M>) {
  const { s } = h;
  clearTimeout(armedFor.get(s));
  armedFor.set(s, setTimeout(() => {
    if (!s.confirm) { return; }
    if (s.saving) { disarmLater(h); return; }
    const live = document.querySelector(`[data-editing][data-key="${CSS.escape(s.key)}"]`);
    const hooks = live ? rowHooks.get(live) : undefined;
    if (hooks) { hooks.unpress(false); } else { unpress(h, false); }
  }, ARMED_MS));
}

/**
 * The rule of the delete control: the first press asks, the second deletes. `focusKey` is where the keyboard goes afterwards, when
 * the person was on the keyboard (Delete had the focus); a pointer or a finger leaves the focus alone (a field taking it would open a phone's keyboard).
 */
export function press<D extends Fields, M>(h: Host<D, M>, mutation: () => Mutation | null, focusKey: string) {
  const { s } = h;
  if (h.edits.current !== s || s.saving) { return; }
  if (!s.confirm) { s.confirm = true; h.paint(); disarmLater(h); return; }
  // A delete that does not go through leaves the icon red; it forgets itself like any other first press.
  disarmLater(h);
  const m = mutation();
  const keyboard = !!h.root()?.querySelector('.ip-del-pair')?.contains(document.activeElement);
  if (m) { void remove(h, m, keyboard ? focusKey : ''); } else { finish(h); }
}

export function unpress<D extends Fields, M>(h: Host<D, M>, refocus: boolean) {
  clearTimeout(armedFor.get(h.s));
  if (!h.s.confirm) { return; }
  h.s.confirm = false;
  h.paint();
  if (refocus) { h.root()?.querySelector<HTMLElement>('[data-ip=text]')?.focus({ preventScroll: true }); }
}
