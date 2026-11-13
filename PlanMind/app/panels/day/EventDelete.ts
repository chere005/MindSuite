import type { ScheduleEvent } from '../../../packages/core/src/planner';
import { icons, type PanelContext } from '../../panelContext';

/**
 * Deleting a schedule entry (the owner, 2026-11-01): swipe the entry sideways, then tap Delete. The swipe (EventDrag tells us) turns the
 * right end of the block into a red Delete button; one tap on it deletes, a tap anywhere else, Escape or a scroll puts it away. The
 * keyboard's way is the Delete or Backspace key on the focused entry, which opens the same button and moves the focus to it; a screen
 * reader's is the hidden "Delete <entry>" button after each entry (it is not in the tab order), which does the same. An entry that is
 * being edited has no Delete (leave it with Enter or Escape first); there is no strip of controls over the schedule any more.
 */
export type DeleteHost = {
  ctx: PanelContext;
  /** The `.day-evs` element the blocks are in. */
  evs: HTMLElement;
  byId(id: string | undefined): ScheduleEvent | null;
};

export type EventDelete = {
  /** Shows Delete on this block; `focus` also moves the keyboard to it. */
  open(block: HTMLElement, focus?: boolean): void;
  close(): void;
  detach(): void;
};

/**
 * The entry that shows Delete. It outlives the panel being drawn again (a poll, the focus leaving an entry that was being edited): the
 * new panel shows Delete on it again, while it is still there and not being edited.
 */
let swiped: string | null = null;

export function attachEventDelete(section: HTMLElement, host: DeleteHost): EventDelete {
  const { ctx, evs } = host;
  const abort = new AbortController();
  let block: HTMLElement | null = null, button: HTMLButtonElement | null = null;
  /** False from a swipe until its pointer is up: the click that ends the swipe is on the block and must not put Delete away at once. */
  let armed = true;

  /** Takes Delete off the page (the person has not decided anything: `swiped` stays). */
  function drop() {
    // Forgotten first: taking the focused Delete out of the page blurs it, and that blur must find nothing to close.
    const was = block, gone = button;
    block = button = null;
    was?.removeAttribute('data-swiped');
    gone?.remove();
    return was;
  }
  function close(refocus = false) {
    swiped = null;
    const was = drop();
    if (refocus && was?.isConnected) { was.focus({ preventScroll: true }); }
  }
  /** The click that comes with the release of a swipe is not a tap on the entry. */
  function holdClick() {
    armed = false;
    const arm = () => { document.removeEventListener('pointerup', arm, true); document.removeEventListener('pointercancel', arm, true); setTimeout(() => { armed = true; }, 0); };
    document.addEventListener('pointerup', arm, true);
    document.addEventListener('pointercancel', arm, true);
  }

  async function remove() {
    const event = block ? host.byId(block.dataset.id) : null;
    if (!event) { close(); return; }
    // A write is in flight: Delete stays for another tap.
    if (ctx.busy) { ctx.announce('Still saving. Try again in a moment.'); return; }
    // The Delete that had the keyboard goes with the entry: the keyboard goes back to the schedule's own button.
    if (button && document.activeElement === button) { section.querySelector<HTMLElement>('.day-addentry')?.focus({ preventScroll: true }); }
    close();
    // A failed delete is shown by the shell, as for every write; the entry stays where it was.
    const result = await ctx.send({ action: 'delete', id: event.id, revision: event.revision, confirm: true });
    if (result.ok) { ctx.announce(`Deleted ${event.text || 'the entry'}.`); }
  }

  /** `quiet`: shown again after a redraw, with no pointer down (nothing to hold back). */
  function open(next: HTMLElement, focus = false, quiet = false) {
    const event = host.byId(next.dataset.id);
    if (!event || next.hidden || next.classList.contains('day-editing')) { return; }
    if (block === next) { if (focus) { button?.focus(); } else if (!quiet) { holdClick(); } return; }
    drop();
    block = next;
    swiped = event.id;
    const linked = event.owners.length > 1;
    button = document.createElement('button');
    button.type = 'button';
    button.className = `day-ev-del ${[...next.classList].filter(c => /^(l\d|w2)$/.test(c)).join(' ')}`;
    button.dataset.writes = '';
    button.setAttribute('aria-label', `Delete ${event.text || 'the entry'}${linked ? ', for both of us' : ''}`);
    button.innerHTML = icons.trash;
    button.style.setProperty('--q', next.dataset.q ?? '1');
    button.style.setProperty('--n', next.dataset.n ?? '1');
    next.setAttribute('data-swiped', '');
    next.after(button);
    if (focus) { button.focus(); } else if (!quiet) { holdClick(); }
  }

  // One Delete at a time, and only until the person does something else.
  document.addEventListener('pointerdown', down => {
    const target = down.target as HTMLElement;
    // A press on Delete is its tap, and one on the entry itself is put away by its click (below), which must still find it open.
    if (block && !target.closest('.day-ev-del') && target.closest('.day-ev') !== block) { close(); }
  }, { capture: true, signal: abort.signal });
  // A tap on the entry that shows Delete only puts Delete away; it does not open the editor.
  section.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    if (target.closest('.day-ev-del')) { void remove(); return; }
    // The hidden button for a screen reader: the same as Delete on the focused entry.
    const hidden = target.closest<HTMLElement>('[data-del-for]');
    if (hidden) {
      event.stopPropagation(); event.preventDefault();
      const entry = [...evs.querySelectorAll<HTMLElement>('.day-ev')].find(b => b.dataset.id === hidden.dataset.delFor);
      if (entry) { open(entry, true); }
      return;
    }
    if (block && armed && target.closest('.day-ev') === block) { event.stopPropagation(); event.preventDefault(); close(); }
  }, { capture: true, signal: abort.signal });
  section.addEventListener('keydown', key => {
    const target = key.target as HTMLElement;
    const entry = target.closest<HTMLElement>('.day-ev:not(.day-editing)');
    if ((key.key === 'Delete' || key.key === 'Backspace') && entry === target && !key.altKey && !key.ctrlKey && !key.metaKey) { key.preventDefault(); open(entry, true); }
  }, { signal: abort.signal });
  // Escape puts Delete away wherever the focus is (a swipe with a mouse or a finger does not focus anything in Safari); it takes the
  // key only when the focus is on the entry or its Delete, where the key has no other use.
  document.addEventListener('keydown', key => {
    if (key.key !== 'Escape' || !block) { return; }
    const own = key.target === button || key.target === block;
    if (own) { key.preventDefault(); key.stopPropagation(); }
    close(own);
  }, { capture: true, signal: abort.signal });
  section.addEventListener('focusout', event => {
    const to = event.relatedTarget as Node | null;
    if (block && !(to && (block.contains(to) || button?.contains(to)))) { close(); }
  }, { signal: abort.signal });
  const scroller = section.closest<HTMLElement>('#period-panel');
  scroller?.addEventListener('scroll', () => close(), { passive: true, signal: abort.signal });

  // The panel was drawn again while Delete was showing: show it again on the same entry.
  if (swiped) {
    const again = [...evs.querySelectorAll<HTMLElement>('.day-ev:not(.day-editing)')].find(b => b.dataset.id === swiped);
    if (again) { open(again, false, true); } else { swiped = null; }
  }

  return { open, close: () => close(), detach: () => { abort.abort(); drop(); } };
}
