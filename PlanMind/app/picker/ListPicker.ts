import '../styles/picker.css';
import { CAPS, pickerColors, pickerRows, selectOnly, toggleOverlay, type ColorKey, type PickerRow } from '../../packages/core/src/planner';
import { esc, isPhone, type PanelContext, type Unmount } from '../panelContext';
import { openListManager } from './ListManager';
import { openRhythmEditor } from './RhythmEditor';

const CHEVRON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const HOUSE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11.5 12 4.5l8 7M6 10v9.5h12V10M10 19.5v-5h4v5"/></svg>';
const TICK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';

/** One color is a disc, several are equal slices from the top (CalMind's PieDot). Drawn as SVG paths, so no inline style. */
function pie(colors: ColorKey[]): string {
  const n = colors.length, point = (turn: number) => `${(12 + 10 * Math.sin(turn * 2 * Math.PI)).toFixed(2)} ${(12 - 10 * Math.cos(turn * 2 * Math.PI)).toFixed(2)}`;
  const slices = n === 1
    ? `<circle class="pie-slice" data-c="${colors[0]}" cx="12" cy="12" r="10"/>`
    : colors.map((color, i) => `<path class="pie-slice" data-c="${color}" d="M12 12 L${point(i / n)} A10 10 0 0 1 ${point((i + 1) / n)} Z"/>`).join('');
  return `<svg class="pie" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">${slices}<circle class="pie-ring" cx="12" cy="12" r="10.5"/></svg>`;
}

/**
 * The round list picker beside the account. Tapping a row shows that list alone; ticking a custom list's box adds
 * it on top of the view. The state lives in ctx.state (it saves the choice a moment after the last change); this
 * file draws the button and the menu from core's pickerRows and calls selectOnly and toggleOverlay.
 *
 * On a desktop's Day the menu ends its rows with a Chores switch (a house, on or off): on, the Day's To-do section lists the day's chores instead (chores
 * ignore the lists, and the Schedule, Priorities and Notes keep following the selection, which the switch never touches); off, the to-dos are back. It is
 * not in the menu on the Week or the Month (the Month's calendar always shows the chores). On a phone the Chores tab turns the Chores view on, so there is no
 * switch, and the button is a grey, locked house while it is on. "The rhythm…" is in the menu on the Day and the Month, not on the Week.
 */
export function mount(root: HTMLElement, ctx: PanelContext): Unmount {
  root.innerHTML = `<div class="picker">
  <button id="picker-button" class="picker-button" type="button" aria-expanded="false" aria-controls="picker-menu"><span class="picker-pie"></span><span class="picker-name"></span><span class="picker-chevron">${CHEVRON}</span></button>
  <div id="picker-menu" class="picker-menu" role="group" aria-label="Lists" hidden><ul class="picker-rows"></ul><p class="picker-hint" role="status"></p><button type="button" class="picker-manage">Manage lists…</button><button type="button" class="picker-rhythm">The rhythm…</button></div>
</div>`;
  const $ = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const picker = $('.picker'), button = $<HTMLButtonElement>('#picker-button'), menu = $('#picker-menu'), rows = $('.picker-rows'), hint = $('.picker-hint'), rhythmButton = $<HTMLButtonElement>('.picker-rhythm');
  const abort = new AbortController();
  const on = { signal: abort.signal };
  let open = false, limitHint = false, manager: Unmount | undefined, rhythm: Unmount | undefined;

  const rowHtml = (row: PickerRow) => {
    const color = row.kind === 'both' ? ctx.settings.bothColor : row.color!;
    // A box only where the row has one. The two people's lists under Both are on screen without a box of their own: a plain mark.
    const side = row.canCheck
      ? `<input type="checkbox" class="picker-box" data-id="${esc(row.id)}" aria-label="Show ${esc(row.label)}"${row.checked ? ' checked' : ''}${row.checkDisabled ? ' aria-disabled="true"' : ''}>`
      : row.checked && !row.selected ? `<span class="picker-mark" aria-hidden="true">${TICK}</span><span class="sr-only">shown</span>` : '';
    return `<li class="picker-row${row.selected ? ' selected' : ''}" data-kind="${row.kind}"><button type="button" class="picker-select" data-id="${esc(row.id)}"${row.selected ? ' aria-current="true"' : ''}><span class="swatch" data-c="${color}" aria-hidden="true"></span><span class="picker-label">${esc(row.label)}</span></button>${side}</li>`;
  };

  /** The Day's Chores switch: a desktop's Day only. */
  const choresRowHtml = () => `<li class="picker-row" data-kind="chores"><button type="button" role="switch" class="picker-select picker-switch" data-id="chores" aria-checked="${ctx.chores}"><span class="picker-house" aria-hidden="true">${HOUSE}</span><span class="picker-label">Chores</span><span class="picker-toggle" aria-hidden="true"></span></button></li>`;
  const hasSwitch = () => !isPhone() && ctx.view === 'day';

  function drawMenu() {
    const focused = document.activeElement instanceof HTMLElement && menu.contains(document.activeElement) ? document.activeElement : null;
    const was = focused ? { id: focused.dataset.id, box: focused.matches('.picker-box') } : null;
    const list = pickerRows(ctx.lists, ctx.selection);
    const firstCustom = list.findIndex(row => row.kind === 'custom');
    rows.innerHTML = list.map((row, i) => (i === firstCustom ? '<li class="picker-divider" aria-hidden="true"></li>' : '') + rowHtml(row)).join('') + (hasSwitch() ? choresRowHtml() : '');
    rhythmButton.hidden = ctx.view === 'week';
    const full = list.some(row => row.checkDisabled);
    if (!full) { limitHint = false; }
    // Always present, so a screen reader hears the text appear; empty, it takes no room.
    hint.textContent = limitHint ? `Up to ${CAPS.maxOverlays} extra lists` : '';
    // The row that had the focus may be gone (the Chores switch when the window became a phone, or the view left the Day): the chosen row takes it, so it never falls to the page.
    if (was) {
      const same = [...menu.querySelectorAll<HTMLElement>(was.box ? '.picker-box' : '.picker-select')].find(el => el.dataset.id === was.id);
      (same ?? menu.querySelector<HTMLElement>('.picker-row.selected .picker-select') ?? menu.querySelector<HTMLElement>('.picker-select'))?.focus();
    }
  }

  function drawButton() {
    // On a phone the Chores tab is what turns the view on, so the button has nothing to open: a grey house that says where you are.
    const locked = ctx.choresPage;
    button.toggleAttribute('data-chores', locked);
    button.toggleAttribute('data-locked', locked);
    if (locked) {
      // The keyboard may be on a row of the menu that is going away (the Chores row, as the window became a phone): it goes to the button, never to the page.
      setOpen(false, menu.contains(document.activeElement));
      button.setAttribute('aria-disabled', 'true');
      button.removeAttribute('aria-expanded'); button.removeAttribute('aria-controls');
      button.setAttribute('aria-label', 'Chores');
      $('.picker-pie').innerHTML = `<span class="picker-house">${HOUSE}</span>`;
      $('.picker-name').textContent = 'Chores';
      return;
    }
    button.removeAttribute('aria-disabled');
    button.setAttribute('aria-expanded', String(open)); button.setAttribute('aria-controls', 'picker-menu');
    const list = pickerRows(ctx.lists, ctx.selection);
    const names = [...list.filter(row => row.selected), ...list.filter(row => row.kind === 'custom' && row.checked && !row.selected)].map(row => row.label);
    $('.picker-pie').innerHTML = pie(pickerColors(ctx.selection, ctx.lists, ctx.settings));
    $('.picker-name').textContent = names.join(' + ');
    button.setAttribute('aria-label', `Lists: ${names.join(' + ')}`);
  }

  function setOpen(next: boolean, focusBack = false) {
    open = next;
    menu.hidden = !next;
    button.setAttribute('aria-expanded', String(next));
    if (next) { limitHint = false; drawMenu(); (menu.querySelector<HTMLElement>('.picker-row.selected .picker-select') ?? menu.querySelector<HTMLElement>('.picker-select'))?.focus(); }
    else if (focusBack) { button.focus(); }
  }

  button.addEventListener('click', () => { if (!button.hasAttribute('data-locked')) { setOpen(!open); } }, on);
  menu.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    const select = target.closest<HTMLElement>('.picker-select');
    if (select) {
      // Chores is a switch, not a list: it leaves the selection as it is.
      if (select.dataset.id === 'chores') { ctx.setChores(!ctx.chores); } else { ctx.setSelection(selectOnly(select.dataset.id!)); }
      setOpen(false, true);
      return;
    }
    if (target.closest('.picker-manage')) {
      setOpen(false);
      manager?.();
      manager = openListManager(ctx, root.closest<HTMLElement>('.content') ?? root, () => { manager = undefined; button.focus(); });
    } else if (target.closest('.picker-rhythm')) {
      setOpen(false);
      rhythm?.();
      rhythm = openRhythmEditor(ctx, root, () => { rhythm = undefined; button.focus(); });
    }
  }, on);
  menu.addEventListener('change', event => {
    const box = event.target as HTMLInputElement;
    if (!box.matches('.picker-box')) { return; }
    const { selection, rejected } = toggleOverlay(ctx.selection, box.dataset.id!, ctx.lists);
    limitHint = rejected === 'overlay_limit';
    ctx.setSelection(selection);
    // Always redraw: a refused box has already flipped on its own and must go back to what the selection says.
    drawMenu();
  }, on);
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false, true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { return; }
    const selects = [...menu.querySelectorAll<HTMLElement>('.picker-select, .picker-manage, .picker-rhythm:not([hidden])')];
    const at = selects.indexOf((event.target as HTMLElement).closest<HTMLElement>('.picker-select, .picker-manage, .picker-rhythm')!);
    if (at < 0) { return; }
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? selects.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + selects.length) % selects.length;
    selects[next].focus();
  }, on);
  // Outside the picker closes it, whether the pointer or the keyboard got there.
  document.addEventListener('pointerdown', event => { if (open && !picker.contains(event.target as Node)) { setOpen(false); } }, { capture: true, signal: abort.signal });
  picker.addEventListener('focusout', event => { const to = event.relatedTarget as Node | null; if (open && to && !picker.contains(to)) { setOpen(false); } }, on);

  const unsubscribe = ctx.state.subscribe(change => {
    if (change !== 'data' && change !== 'selection' && change !== 'chores' && change !== 'nav') { return; }
    drawButton();
    if (open) { drawMenu(); }
  });
  // The phone's locked button and the desktop's Chores switch follow the layout, also in a menu that is open while the window crosses 760px.
  window.matchMedia('(max-width: 760px)').addEventListener('change', () => { drawButton(); if (open) { drawMenu(); } }, on);
  drawButton();
  return () => {
    abort.abort();
    unsubscribe();
    manager?.();
    rhythm?.();
    root.replaceChildren();
  };
}
