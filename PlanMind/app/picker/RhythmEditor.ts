import '../styles/picker.css';
import {
  CAPS, cadenceText, cadenceWith, choreAdd, choreEdit, choreStart, counter, newChoreOwners, nextOwners, rhythmAnchor, rhythmGroups, weekLetter,
  type CadenceChange, type ChoreRule, type Mutation, type RhythmGroupKey,
} from '../../packages/core/src/planner';
import { esc, icons, type PanelContext, type Unmount } from '../panelContext';
import type { SendResult } from '../state';

const DAY_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr'] as const;
const DAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] as const;
const NTHS = [[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [-1, 'Last']] as const;
const WEEKS = [['every', 'Every week'], ['A', 'Week A'], ['B', 'Week B']] as const;
const MONTHS = [['every', 'Every month'], ['odd', 'Odd months'], ['even', 'Even months']] as const;
const GROUP_LABEL: Record<RhythmGroupKey, string> = { daily: 'Daily (Sun–Fri)', weekly: 'Weekly', weekA: 'Week A', weekB: 'Week B', monthly: 'Monthly' };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A row of choices as buttons that each say whether they are on: one choice, named by its group. */
const chips = (label: string, key: string, options: readonly (readonly [string | number, string, string?])[], on: string | number) =>
  `<div class="rhythm-chips" role="group" aria-label="${esc(label)}">${options.map(([value, text, name]) =>
    `<button type="button" class="rhythm-chip" data-act="${key}" data-value="${value}" data-writes data-focus="${key}:${value}"${name ? ` aria-label="${esc(name)}"` : ''} aria-pressed="${value === on}">${esc(text)}</button>`).join('')}</div>`;

/**
 * The rhythm: the chore rules in five groups (Daily, Weekly, Week A, Week B, Monthly), each ending with an add line, and the switch that
 * says whether this week is Week A or Week B. A dialog like the list manager, appended to `host`; the returned function closes it. A rule's
 * circle is its default owner (a tap hands it to the next: the partner, the owner, Both) and saves; its title is edited where it stands (Enter or the
 * focus leaving saves, Escape cancels) and, while the row is open, so are its days and weeks or months, each saved when chosen (a rule
 * that changes week moves to that group); Delete is the red icon that deletes on its second press. A new rule is for both of us,
 * whatever the picker shows. Unsent text stays in this closure, so a refresh never loses it.
 */
export function openRhythmEditor(ctx: PanelContext, host: HTMLElement, onClose: () => void = () => {}): Unmount {
  const dialog = document.createElement('dialog');
  dialog.className = 'manager rhythm';
  dialog.setAttribute('aria-labelledby', 'rhythm-heading');
  dialog.innerHTML = `<div class="manager-head"><h2 id="rhythm-heading">The rhythm</h2><button type="button" class="icon-button" data-act="close" aria-label="Close the rhythm">${icons.close}</button></div>
<p class="error manager-message" role="alert"></p><div class="manager-body"></div>`;
  host.append(dialog);
  const body = dialog.querySelector<HTMLElement>('.manager-body')!, message = dialog.querySelector<HTMLElement>('.manager-message')!;

  // `revision` is the one the row was opened on, so a change that came in while the title was typed is a stale refusal, not a silent overwrite; after one the next save goes over it.
  let editing: { id: string; name: string; error: string; revision: number; stale: boolean } | null = null;
  let armed = false;
  let armedTimer: ReturnType<typeof setTimeout> | undefined;
  // True while the code rebuilds the dialog: a field going away is not the person leaving the row.
  let drawing = false;
  // Each group's add line keeps its text, and its id while the text stays the same, so a retry after a lost reply cannot add twice.
  const adds = new Map<RhythmGroupKey, { title: string; id: string; idTitle: string }>();
  const addOf = (group: RhythmGroupKey) => { let a = adds.get(group); if (!a) { a = { title: '', id: crypto.randomUUID(), idTitle: '' }; adds.set(group, a); } return a; };
  let pointerDown = false, pending = false, closed = false, refocus: string | undefined;
  const rules = () => ctx.session.chores;
  const ruleOf = (id: string) => rules().find(rule => rule.id === id);

  const marksOf = (rule: ChoreRule) => ctx.session.choreMarks.filter(mark => mark.ruleId === rule.id).length;
  const deleteLabel = (rule: ChoreRule) => { const marks = marksOf(rule); return `Delete ${rule.title}${marks ? ` with ${plural(marks, 'mark', 'marks')}` : ''}?`; };
  const ownerName = (rule: ChoreRule) => (rule.owners.length === 2 ? 'Both' : ctx.lists.find(l => l.id === rule.owners[0])?.name ?? 'Someone');
  const ownerColor = (rule: ChoreRule) => (rule.owners.length === 2 ? ctx.settings.bothColor : ctx.lists.find(l => l.id === rule.owners[0])?.color ?? 'gray');

  const ownerButton = (rule: ChoreRule) =>
    `<button type="button" class="rhythm-owner" data-act="owner" data-id="${esc(rule.id)}" data-writes data-focus="owner:${esc(rule.id)}" aria-label="${esc(`${rule.title}, for ${ownerName(rule)}. Tap to make it for ${ownerName({ ...rule, owners: nextOwners(rule.owners) })}`)}"><i class="swatch" data-c="${ownerColor(rule)}" aria-hidden="true"></i></button>`;

  function whenControls(rule: ChoreRule): string {
    const c = rule.cadence;
    if (c.kind === 'daily') { return ''; }
    const days = chips('Day of the week', 'day', DAY_SHORT.map((text, i) => [i, text, DAY_NAME[i]] as const), c.day);
    if (c.kind === 'weekly') { return `<div class="rhythm-when">${days}${chips('Which weeks', 'weeks', WEEKS, c.weeks)}</div>`; }
    return `<div class="rhythm-when">${chips('Which one in the month', 'nth', NTHS.map(([n, text]) => [n, text] as const), c.nth)}${days}${chips('Which months', 'months', MONTHS, c.months)}</div>`;
  }

  function ruleHtml(rule: ChoreRule): string {
    if (editing?.id !== rule.id) {
      const when = cadenceText(rule.cadence);
      return `<li class="manager-list rhythm-rule"><div class="manager-row">${ownerButton(rule)}<button type="button" class="manager-edit rhythm-title" data-act="edit" data-id="${esc(rule.id)}" data-focus="edit:${esc(rule.id)}" aria-label="Edit ${esc(rule.title)}"><span class="manager-name">${esc(rule.title)}</span>${when ? `<span class="rhythm-text">${esc(when)}</span>` : ''}</button></div></li>`;
    }
    return `<li class="manager-list open rhythm-rule" data-editing data-id="${esc(rule.id)}"><div class="manager-row">${ownerButton(rule)}
  <input class="manager-input" data-field="edit" data-focus="edit-name" aria-label="${esc(`Edit chore: ${rule.title}`)}" value="${esc(editing.name)}" autocomplete="off" spellcheck="false" enterkeyhint="done"><span class="manager-count" data-count="edit"></span>
  <span class="manager-del"${armed ? ' data-armed' : ''}><button type="button" class="manager-trash" data-act="delete" data-writes data-focus="delete" aria-label="${armed ? 'Confirm delete' : esc(`Delete chore: ${rule.title}`)}">${icons.trash}</button></span></div>
  ${whenControls(rule)}
  <p class="manager-row-message" role="status" aria-live="polite">${esc(editing.error || (armed ? deleteLabel(rule) : ''))}</p></li>`;
  }

  function html(): string {
    const full = rules().length >= CAPS.choresMax;
    const groups = rhythmGroups(rules()).map(group => {
      const add = addOf(group.key);
      const form = full ? '' : `<form class="rhythm-add" data-form="add" data-group="${group.key}"><label class="sr-only" for="rhythm-new-${group.key}">New chore in ${esc(GROUP_LABEL[group.key])}</label>
  <input id="rhythm-new-${group.key}" data-field="add" data-group="${group.key}" data-focus="new:${group.key}" value="${esc(add.title)}" autocomplete="off" spellcheck="false" placeholder="Add a chore…" enterkeyhint="done"><span class="manager-count" data-count="add:${group.key}"></span>
  <button type="submit" class="primary" data-writes data-focus="add:${group.key}">Add</button></form>`;
      return `<h3>${esc(GROUP_LABEL[group.key])}</h3><ul class="manager-lists">${group.rules.map(ruleHtml).join('')}</ul>${form}`;
    }).join('');
    const letter = weekLetter(ctx.today, ctx.session.rhythm.anchor);
    return `${groups}${full ? `<p class="dim">You have ${CAPS.choresMax} chores, the most there can be. Delete one to add another.</p>` : ''}
<h3>This week is</h3>${chips('This week is', 'letter', [['A', 'A', 'Week A'], ['B', 'B', 'Week B']], letter)}`;
  }

  /** Counters and the buttons that depend on the drafts or on a write in flight. Never rebuilds the form. */
  function sync() {
    const one = (el: HTMLElement | null, text: string, submit: HTMLButtonElement | null) => {
      if (!el) { return; }
      const trimmed = text.trim(), c = counter(trimmed, CAPS.choreTitleChars);
      el.textContent = trimmed ? `${c.used} / ${c.max}` : '';
      el.classList.toggle('over', c.over);
      if (submit) { submit.dataset.blocked = String(!trimmed || c.over); }
    };
    for (const group of Object.keys(GROUP_LABEL) as RhythmGroupKey[]) {
      one(dialog.querySelector(`[data-count="add:${group}"]`), addOf(group).title, dialog.querySelector(`[data-focus="add:${group}"]`));
    }
    one(dialog.querySelector('[data-count="edit"]'), editing?.name ?? '', null);
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

  /** The owner circle, or a day, week or month chosen: saved at once on the rule as it is now (only that field changes), the row staying open. */
  async function change(id: string, patch: Parameters<typeof choreEdit>[1]) {
    const rule = ruleOf(id);
    if (!rule) { say('That chore is gone.'); render(); return; }
    const result = await run(choreEdit(rule, patch), editing?.id === id);
    if (result.ok && editing?.id === id) { editing.revision = ruleOf(id)?.revision ?? editing.revision; }
    render();
  }

  async function addRule(group: RhythmGroupKey) {
    const add = addOf(group), title = add.title.trim();
    if (!title || counter(title, CAPS.choreTitleChars).over) { return; }
    if (add.idTitle !== title) { add.id = crypto.randomUUID(); add.idTitle = title; }
    const owners = newChoreOwners();
    if ((await run(choreAdd(add.id, { title, owners, cadence: choreStart(group, ctx.today) }))).ok) {
      adds.set(group, { title: '', id: crypto.randomUUID(), idTitle: '' });
      render(`new:${group}`);
    } else { render(); }
  }

  /** Brings the row's Delete control and message in line with `armed`, without drawing the row again. */
  function paintArmed(row: Element) {
    const rule = editing && ruleOf(editing.id);
    const trash = row.querySelector<HTMLElement>('.manager-trash')!;
    trash.setAttribute('aria-label', armed ? 'Confirm delete' : `Delete chore: ${rule?.title ?? ''}`);
    trash.closest('.manager-del')!.toggleAttribute('data-armed', armed);
    row.querySelector('.manager-row-message')!.textContent = editing?.error || (armed && rule ? deleteLabel(rule) : '');
  }

  /** Ends the edit of a row without writing. `focus` returns the keyboard to the row's button (Escape, Enter), not after the focus moved on its own. */
  function endEdit(focus: boolean) {
    const id = editing?.id;
    editing = null; armed = false;
    render(focus && id ? `edit:${id}` : undefined);
  }

  /** Enter, or the focus leaving the row: the title is one write. An emptied title on leaving cancels; on Enter it asks for text or Delete. */
  async function saveEdit(how: 'enter' | 'leave') {
    const mine = editing, rule = mine && ruleOf(mine.id);
    if (!mine || !rule) { say('That chore is gone.'); editing = null; render(); return; }
    const title = mine.name.trim();
    if (!title) {
      if (how === 'leave') { endEdit(false); } else { mine.error = 'Type a name, or use Delete.'; render('edit-name'); }
      return;
    }
    if (counter(title, CAPS.choreTitleChars).over) { mine.error = `Keep it to ${CAPS.choreTitleChars} characters.`; render(how === 'enter' ? 'edit-name' : undefined); return; }
    if (title === rule.title) { endEdit(how === 'enter'); return; }
    mine.error = '';
    const result = await run({ ...choreEdit(rule, { title }), revision: mine.stale ? rule.revision : mine.revision }, true);
    // Another row may have been opened while this one was written (the focus leaving a row is what saves it): that one is not this one's to end.
    if (editing !== mine) { render(); return; }
    if (result.ok) { endEdit(how === 'enter'); return; }
    // Stale: the title typed stays, and the next Enter saves it over the newer version.
    if (!result.skipped && result.code === 'stale') { mine.stale = true; mine.error = `${result.message} Enter saves yours over it, Escape keeps theirs.`; }
    render(how === 'enter' ? 'edit-name' : undefined);
  }

  async function remove() {
    const mine = editing, rule = mine && ruleOf(mine.id);
    if (!mine || !rule) { editing = null; armed = false; render(); return; }
    // Two presses: the first names what goes with the rule and turns the icon red, the second deletes; it disarms itself.
    if (!armed) { armed = true; mine.error = ''; render('delete'); clearTimeout(armedTimer); armedTimer = setTimeout(() => { if (armed && editing === mine) { armed = false; const row = dialog.querySelector('[data-editing]'); if (row) { paintArmed(row); } } }, 2500); return; }
    clearTimeout(armedTimer);
    const removed = (await run({ action: 'deleteChore', id: rule.id, revision: mine.stale ? rule.revision : mine.revision, confirm: true }, true)).ok;
    if (editing !== mine) { render(); return; }
    if (removed) { editing = null; armed = false; }
    render();
  }

  /** This week is A or B: the anchor is this week's Monday for A, last week's for B. */
  async function setLetter(letter: 'A' | 'B') {
    const rhythm = ctx.session.rhythm;
    if (weekLetter(ctx.today, rhythm.anchor) === letter) { return; }
    await run({ action: 'saveRhythm', anchor: rhythmAnchor(letter, ctx.today), revision: rhythm.revision });
    render();
  }

  const abort = new AbortController();
  const on = { signal: abort.signal };
  dialog.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!target) { return; }
    const act = target.dataset.act, value = target.dataset.value;
    if (act === 'close') { dialog.close(); }
    else if (act === 'owner') { const rule = ruleOf(target.dataset.id!); if (rule) { void change(rule.id, { owners: nextOwners(rule.owners) }); } }
    else if (act === 'edit') {
      const rule = ruleOf(target.dataset.id!);
      const same = editing?.id === rule?.id;
      editing = rule && !same ? { id: rule.id, name: rule.title, error: '', revision: rule.revision, stale: false } : null;
      armed = false;
      render(editing ? 'edit-name' : `edit:${target.dataset.id}`);
    }
    else if (act === 'delete') { void remove(); }
    else if (act === 'letter') { void setLetter(value as 'A' | 'B'); }
    else if ((act === 'day' || act === 'weeks' || act === 'nth' || act === 'months') && editing) {
      const rule = ruleOf(editing.id);
      const edit: CadenceChange = act === 'day' ? { day: Number(value) as 0 | 1 | 2 | 3 | 4 | 5 } : act === 'weeks' ? { weeks: value as 'every' | 'A' | 'B' }
        : act === 'nth' ? { nth: Number(value) as 1 | 2 | 3 | 4 | -1 } : { months: value as 'every' | 'odd' | 'even' };
      if (rule) { void change(rule.id, { cadence: cadenceWith(rule.cadence, edit) }); }
    }
  }, on);
  dialog.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.target as HTMLElement;
    if (form.dataset.form === 'add') { void addRule(form.dataset.group as RhythmGroupKey); }
  }, on);
  // One rule for leaving a row being edited: Enter in its title saves, Escape cancels, the focus moving to the row's choices or Delete keeps
  // editing, and the focus going anywhere else saves, as Enter would.
  dialog.addEventListener('keydown', event => {
    const row = (event.target as HTMLElement).closest('[data-editing]');
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
  // A press on a button of the row (a day, Delete) does not take the focus out of the title.
  dialog.addEventListener('mousedown', event => {
    const target = event.target as HTMLElement;
    if (editing && target.closest('[data-editing]') && !target.closest('input,label')) { event.preventDefault(); }
  }, on);
  dialog.addEventListener('input', event => {
    const input = event.target as HTMLInputElement, field = input.dataset.field;
    if (field === 'add') { addOf(input.dataset.group as RhythmGroupKey).title = input.value; }
    else if (field === 'edit' && editing) {
      editing.name = input.value;
      if (editing.error) { editing.error = ''; dialog.querySelector('.manager-row-message')!.textContent = ''; }
    }
    sync();
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
    clearTimeout(armedTimer);
    if (dialog.open) { dialog.close(); }
    dialog.remove();
    onClose();
  }
  dialog.addEventListener('close', dispose, { signal: abort.signal });

  render();
  dialog.showModal();
  return dispose;
}
