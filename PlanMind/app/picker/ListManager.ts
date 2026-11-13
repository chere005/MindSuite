import '../styles/picker.css';
import { CAPS, COLOR_KEYS, counter, listDeleteImpact, nextCustomColor, type ColorKey, type ListRecord, type Mutation } from '../../packages/core/src/planner';
import { esc, icons, type PanelContext, type Unmount } from '../panelContext';
import type { SendResult } from '../state';

const colorName = (key: ColorKey) => key[0].toUpperCase() + key.slice(1);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const deleteLabel = (ctx: PanelContext, list: ListRecord) => {
  const { items, notes } = listDeleteImpact(ctx.session, list.id);
  const taken = [items && plural(items, 'item', 'items'), notes && plural(notes, 'note', 'notes')].filter(Boolean).join(' and ');
  return `Delete ${list.name}${taken ? ` with ${taken}` : ''}?`;
};

/** A row of color swatches as radio buttons: one choice, reachable by arrow keys, named by the color. */
const tray = (group: string, chosen: ColorKey, label: string) => `<div class="tray" role="radiogroup" aria-label="${esc(label)}">${COLOR_KEYS.map(key =>
  `<label class="tray-swatch" data-c="${key}"><input type="radio" name="tray-${group}" value="${key}" data-tray="${group}" data-focus="tray:${group}:${key}"${group === 'new' || group === 'edit' ? '' : ' data-writes'} aria-label="${colorName(key)}"${key === chosen ? ' checked' : ''}><span class="tray-dot"></span></label>`).join('')}</div>`;

/**
 * The manager: recolor the two people's lists and Both; add, rename, recolor and delete custom lists. An in-page panel (the owner, 2026-11-09: no dialog
 * layer) appended to `host`, the page's content column, over the page under the top bar; Escape, its Close button or the returned function closes and removes it, and the focus
 * starts on its heading. It is not modal: the top bar and sidebar stay in reach. Colors of the two people's lists and Both save when picked. A custom list is edited
 * in its own row (the owner, 2026-10-31: no window for editing content): its name becomes a field there, a swatch row and Delete
 * join it; Enter, or the focus leaving the row, saves name and color together, Escape cancels. Unsent text stays in this
 * closure, so a refresh never loses it.
 */
export function openListManager(ctx: PanelContext, host: HTMLElement, onClose: () => void = () => {}): Unmount {
  const abort = new AbortController();
  const dialog = document.createElement('section');
  dialog.className = 'manager manager-page';
  dialog.setAttribute('role', 'region');
  dialog.setAttribute('aria-labelledby', 'manager-heading');
  dialog.innerHTML = `<div class="manager-head"><h2 id="manager-heading" tabindex="-1">Manage lists</h2><button type="button" class="icon-button" data-act="close" aria-label="Close lists">${icons.close}</button></div>
<p class="error manager-message" role="alert"></p><div class="manager-body"></div>`;
  host.append(dialog);
  // The panel covers the page under the top bar (which stays, picker included); the page behind it is out of reach of the keyboard and of assistive technology until it closes.
  const page = host.querySelector<HTMLElement>('.page');
  page?.setAttribute('inert', '');
  const place = () => { const bar = host.querySelector<HTMLElement>('.topbar'); dialog.style.setProperty('--top', `${bar ? bar.offsetHeight : 0}px`); };
  place();
  window.addEventListener('resize', place, { signal: abort.signal });
  const body = dialog.querySelector<HTMLElement>('.manager-body')!, message = dialog.querySelector<HTMLElement>('.manager-message')!;

  // Drafts. The new list keeps its id while its name stays the same, so a retry after a lost reply cannot add twice.
  // `revision` is the one the row was opened on, so a change that came in while the name was typed is a stale refusal, not a silent overwrite; after one the next save goes over it.
  let editing: { id: string; name: string; color: ColorKey; error: string; revision: number; stale: boolean } | null = null;
  let armed = false;
  let armedTimer: ReturnType<typeof setTimeout> | undefined;
  // True while the code rebuilds the dialog: a field going away is not the person leaving the row.
  let drawing = false;
  let add = { name: '', color: nextCustomColor(ctx.lists), id: crypto.randomUUID(), idName: '' };
  let pointerDown = false, pending = false, closed = false, refocus: string | undefined;
  const customLists = () => ctx.lists.filter(l => l.kind === 'custom').sort((a, b) => a.order - b.order);

  function html(): string {
    const custom = customLists();
    // The two people's lists by their stored names (each one's id, capitalized), in list order, then Both.
    const people = ctx.lists.filter(l => l.kind === 'person').sort((a, b) => a.order - b.order);
    const fixed = [...people.map(l => ({ id: l.id, name: l.name, color: l.color })), { id: 'both', name: 'Both', color: ctx.settings.bothColor }];
    const colors = fixed.map(f => `<div class="color-line"><span class="color-name"><i class="swatch" data-c="${f.color}" aria-hidden="true"></i>${esc(f.name)}</span>${tray(f.id, f.color, `Color for ${f.name}`)}</div>`).join('');
    const rows = custom.map(list => {
      if (editing?.id !== list.id) {
        return `<li class="manager-list"><button type="button" class="manager-edit" data-act="edit" data-id="${esc(list.id)}" data-focus="edit:${esc(list.id)}" aria-label="Edit ${esc(list.name)}"><i class="swatch" data-c="${list.color}" aria-hidden="true"></i><span class="manager-name">${esc(list.name)}</span></button></li>`;
      }
      // The row being edited: the name is a field of the same size, the counter and Delete join it, the swatches sit under it.
      const impact = armed ? deleteLabel(ctx, list) : '';
      return `<li class="manager-list open" data-editing data-id="${esc(list.id)}"><div class="manager-row"><i class="swatch" data-c="${editing.color}" aria-hidden="true"></i>
  <input class="manager-input" id="manager-edit-name" data-field="edit" data-focus="edit-name" aria-label="${esc(`Edit list: ${list.name}`)}" value="${esc(editing.name)}" autocomplete="off" spellcheck="false" enterkeyhint="done"><span class="manager-count" data-count="edit"></span>
  <span class="manager-del"${armed ? ' data-armed' : ''}><button type="button" class="manager-trash" data-act="delete" data-writes data-focus="delete" aria-label="${armed ? 'Confirm delete' : esc(`Delete list: ${list.name}`)}">${icons.trash}</button></span></div>
  ${tray('edit', editing.color, `Color for ${list.name}`)}
  <p class="manager-row-message" role="status" aria-live="polite">${esc(editing.error || impact)}</p></li>`;
    }).join('');
    const addForm = custom.length >= CAPS.customListsMax
      ? `<p class="dim">You have ${CAPS.customListsMax} lists, the most there can be. Delete one to add another.</p>`
      : `<h3>Add a list</h3><form class="manager-add" data-form="add"><label for="manager-new-name">New list name</label>
  <div class="name-line"><input id="manager-new-name" data-field="add" data-focus="new-name" value="${esc(add.name)}" autocomplete="off" spellcheck="false" placeholder="Camping, Home, Gifts…"><span class="manager-count" data-count="add"></span></div>
  ${tray('new', add.color, 'Color for the new list')}
  <button type="submit" class="primary" data-writes data-focus="add">Add list</button></form>`;
    return `<h3>Colors</h3><p class="dim">${people.map(p => esc(p.name)).join(' and ')} stay. Both is not a list: it shows the two together, and its color marks what you share, and each of you picks your own: yours does not change the other person's.</p>${colors}
<h3>Your lists <span>${custom.length} of ${CAPS.customListsMax}</span></h3>${custom.length ? '' : '<p class="dim">No lists of your own yet.</p>'}<ul class="manager-lists">${rows}</ul>${addForm}`;
  }

  /** Counters and the buttons that depend on the drafts or on a write in flight. Never rebuilds the form. */
  function sync() {
    const name = (text: string) => ({ text: text.trim(), count: counter(text.trim(), CAPS.listNameChars) });
    for (const [kind, text, submit] of [['add', add.name, 'add'], ['edit', editing?.name ?? '', 'save']] as const) {
      const count = dialog.querySelector<HTMLElement>(`[data-count="${kind}"]`);
      if (!count) { continue; }
      const { text: trimmed, count: c } = name(text);
      count.textContent = `${c.used} / ${c.max}`;
      count.classList.toggle('over', c.over);
      const button = dialog.querySelector<HTMLButtonElement>(`[data-focus="${submit}"]`);
      if (button) { button.dataset.blocked = String(!trimmed || c.over); }
    }
    dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>('[data-writes]').forEach(control => { control.disabled = ctx.busy || control.dataset.blocked === 'true'; });
  }

  function render(focus?: string) {
    if (closed) { return; }
    pending = false;
    const active = document.activeElement instanceof HTMLElement && dialog.contains(document.activeElement) ? document.activeElement.dataset.focus : undefined;
    drawing = true;
    body.innerHTML = html();
    sync();
    const key = focus ?? active ?? refocus;
    refocus = undefined;
    if (key) { body.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`)?.focus(); }
    drawing = false;
  }
  // Data from the server redraws the dialog, but never under a text field that has focus or a pointer that is down.
  const quiet = () => !pointerDown && !(document.activeElement instanceof HTMLInputElement && document.activeElement.matches('[data-field]') && dialog.contains(document.activeElement));
  const flush = () => setTimeout(() => { if (pending && quiet()) { render(); } }, 0);

  const say = (text: string) => { message.textContent = text; };
  /** One write. A failure is shown in the dialog (the page banner is behind it), in the row being edited when `row` is set; a skipped one (busy) is silent. */
  async function run(mutation: Mutation, row = false): Promise<SendResult> {
    say('');
    // Controls disable while the write runs, which drops focus; the redraw afterwards gives it back.
    refocus = document.activeElement instanceof HTMLElement && dialog.contains(document.activeElement) ? document.activeElement.dataset.focus : undefined;
    const result = await ctx.send(mutation);
    if (!result.ok && !result.skipped) { if (row && editing) { editing.error = result.message; } else { say(result.message); } }
    return result;
  }
  const listOf = (id: string) => ctx.lists.find(l => l.id === id);

  async function recolor(group: string, color: ColorKey) {
    if (group === 'both') { const saved = await ctx.state.saveBothColor(color); if (!saved.ok) { say(saved.message); } }
    else if (listOf(group)?.kind === 'person') { const list = listOf(group); if (list) { await run({ action: 'saveList', id: group, color, revision: list.revision }); } }
    render();
  }

  async function addList() {
    const name = add.name.trim();
    if (!name || counter(name, CAPS.listNameChars).over) { return; }
    if (add.idName !== name) { add.id = crypto.randomUUID(); add.idName = name; }
    if ((await run({ action: 'saveList', id: add.id, name, color: add.color, revision: 0 })).ok) {
      add = { name: '', color: nextCustomColor(ctx.lists), id: crypto.randomUUID(), idName: '' };
      render('new-name');
    } else { render(); }
  }

  /** Brings the row's Delete control and message in line with `armed`, without drawing the row again. */
  function paintArmed(row: Element) {
    const list = editing && listOf(editing.id);
    const trash = row.querySelector<HTMLElement>('.manager-trash')!;
    trash.setAttribute('aria-label', armed ? 'Confirm delete' : `Delete list: ${list?.name ?? ''}`);
    trash.closest('.manager-del')!.toggleAttribute('data-armed', armed);
    row.querySelector('.manager-row-message')!.textContent = editing?.error || (armed && list ? deleteLabel(ctx, list) : '');
  }

  /** Ends the edit of a row without writing. `focus` returns the keyboard to the row's button (Escape, Enter), not after the focus moved on its own. */
  function endEdit(focus: boolean) {
    const id = editing?.id;
    editing = null; armed = false;
    render(focus && id ? `edit:${id}` : undefined);
  }

  /** Enter, or the focus leaving the row: name and color are one write. An emptied name on leaving cancels; on Enter it asks for text or Delete. */
  async function saveEdit(how: 'enter' | 'leave') {
    const mine = editing, list = mine && listOf(mine.id);
    if (!mine || !list) { say('That list is gone.'); editing = null; render(); return; }
    const name = mine.name.trim();
    if (!name) {
      if (how === 'leave') { endEdit(false); } else { mine.error = 'Type a name, or use Delete.'; render('edit-name'); }
      return;
    }
    if (counter(name, CAPS.listNameChars).over) { mine.error = `Keep it to ${CAPS.listNameChars} characters.`; render(how === 'enter' ? 'edit-name' : undefined); return; }
    if (name === list.name && mine.color === list.color) { endEdit(how === 'enter'); return; }
    mine.error = '';
    const result = await run({ action: 'saveList', id: list.id, name, color: mine.color, revision: mine.stale ? list.revision : mine.revision }, true);
    // Another row may have been opened while this one was written (the focus leaving a row is what saves it): that one is not this one's to end.
    if (editing !== mine) { render(); return; }
    if (result.ok) { endEdit(how === 'enter'); return; }
    // Stale: the name typed stays, and the next Enter saves it over the newer version.
    if (!result.skipped && result.code === 'stale') { mine.stale = true; mine.error = `${result.message} Enter saves yours over it, Escape keeps theirs.`; }
    render(how === 'enter' ? 'edit-name' : undefined);
  }

  async function remove() {
    const mine = editing, list = mine && listOf(mine.id);
    if (!mine || !list) { editing = null; armed = false; render(); return; }
    // Two presses: the first names what goes with the list and turns the icon red, the second deletes; it disarms itself.
    if (!armed) { armed = true; mine.error = ''; render('delete'); clearTimeout(armedTimer); armedTimer = setTimeout(() => { if (armed && editing === mine) { armed = false; const row = dialog.querySelector('[data-editing]'); if (row) { paintArmed(row); } } }, 2500); return; }
    clearTimeout(armedTimer);
    const removed = (await run({ action: 'deleteList', id: list.id, revision: list.revision, confirm: true }, true)).ok;
    if (editing !== mine) { render(); return; }
    if (removed) { editing = null; armed = false; render('new-name'); } else { render(); }
  }

  const on = { signal: abort.signal };
  dialog.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!target) { return; }
    const act = target.dataset.act;
    if (act === 'close') { dispose(); }
    else if (act === 'edit') {
      const list = listOf(target.dataset.id!);
      const same = editing?.id === list?.id;
      editing = list && !same ? { id: list.id, name: list.name, color: list.color, error: '', revision: list.revision, stale: false } : null;
      armed = false;
      render(editing ? 'edit-name' : `edit:${target.dataset.id}`);
    }
    else if (act === 'delete') { void remove(); }
  }, on);
  dialog.addEventListener('submit', event => {
    event.preventDefault();
    const form = (event.target as HTMLElement).dataset.form;
    if (form === 'add') { void addList(); }
  }, on);
  // One rule for leaving a row being edited: Enter in its name saves, Escape cancels, the focus moving to the row's swatches or Delete keeps
  // editing, and the focus going anywhere else saves, as Enter would.
  dialog.addEventListener('keydown', event => {
    const row = (event.target as HTMLElement).closest('[data-editing]');
    if (event.key === 'Escape' && !(row && editing)) { event.preventDefault(); event.stopPropagation(); dispose(); return; }
    if (!row || !editing) { return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); endEdit(true); }
    else if (event.key === 'Enter' && (event.target as HTMLElement).matches('[data-field=edit]') && !event.isComposing) { event.preventDefault(); void saveEdit('enter'); }
  }, on);
  dialog.addEventListener('focusout', event => {
    const row = (event.target as HTMLElement).closest('[data-editing]');
    const to = event.relatedTarget as HTMLElement | null;
    if (drawing || !row || !editing) { return; }
    if (to && row.contains(to)) {
      // Leaving Delete for another part of the row forgets the first press, so a stray Enter later does not delete.
      if (armed && (event.target as HTMLElement).closest('.manager-del') && !to.closest('.manager-del')) { armed = false; paintArmed(row); }
      return;
    }
    if (!document.hasFocus()) { return; }
    void saveEdit('leave');
  }, on);
  // A press on a button of the row (Delete, Cancel) does not take the focus out of the name.
  dialog.addEventListener('mousedown', event => {
    const target = event.target as HTMLElement;
    if (editing && target.closest('[data-editing]') && !target.closest('input,label')) { event.preventDefault(); }
  }, on);
  dialog.addEventListener('input', event => {
    const field = (event.target as HTMLInputElement).dataset.field;
    if (field === 'add') { add.name = (event.target as HTMLInputElement).value; }
    else if (field === 'edit' && editing) {
      editing.name = (event.target as HTMLInputElement).value;
      if (editing.error) { editing.error = ''; dialog.querySelector('.manager-row-message')!.textContent = ''; }
    }
    sync();
  }, on);
  dialog.addEventListener('change', event => {
    const radio = event.target as HTMLInputElement;
    const group = radio.dataset.tray;
    if (!group) { return; }
    const color = radio.value as ColorKey;
    if (group === 'new') { add.color = color; }
    else if (group === 'edit' && editing) { editing.color = color; dialog.querySelector('[data-editing] .swatch')?.setAttribute('data-c', color); }
    else { void recolor(group, color); }
  }, on);
  dialog.addEventListener('pointerdown', () => { pointerDown = true; }, { capture: true, signal: abort.signal });
  for (const type of ['pointerup', 'pointercancel']) { dialog.addEventListener(type, () => { pointerDown = false; flush(); }, { capture: true, signal: abort.signal }); }
  dialog.addEventListener('focusout', flush, on);

  const unsubscribe = ctx.state.subscribe(change => {
    if (change === 'data') { pending = true; if (quiet()) { render(); } }
    else if (change === 'busy') { sync(); if (!ctx.busy) { flush(); } }
  });
  function dispose() {
    if (closed) { return; }
    closed = true;
    abort.abort();
    unsubscribe();
    page?.removeAttribute('inert');
    // The shell treats a closing panel as a quiet moment, as it does a closing dialog.
    dialog.dispatchEvent(new Event('close'));
    dialog.remove();
    onClose();
  }

  render();
  dialog.querySelector<HTMLElement>('#manager-heading')!.focus();
  return dispose;
}
