import { noteLanes, textLimit, type DayView, type NoteLane } from '../../../packages/core/src/planner';
import { esc, type PanelContext } from '../../panelContext';
import type { Kit } from '../DayPanel';
import { editDraft, noteState, rebaseDraft, settleDraft } from '../week/noteDraft';

// The lane a phone shows when there is more than one (one text area on screen).
let phoneLane = '';

const MAX = () => textLimit('note', 'day', false);

function noteHtml(nl: NoteLane, ctx: PanelContext, index: number): string {
  // The text and the counter follow noteState, as the Week and Month blocks do: the draft while it differs from the saved note.
  const { text, count: size } = noteState(nl, ctx.drafts.get(nl.key), MAX());
  return `<div class="day-note" data-c="${nl.lane.color}" data-key="${esc(nl.key)}" data-list="${esc(nl.lane.listId)}">
  <label class="day-note-name" for="day-note-${index}"><i class="day-sw"></i>${esc(nl.lane.name)}${nl.lane.you ? ' · you' : ''}</label>
  <textarea id="day-note-${index}" class="day-note-text" aria-label="Notes for ${esc(nl.lane.name)}" placeholder="Notes for the day…">${esc(text)}</textarea>
  <div class="day-note-foot"><span class="day-note-meta"><span class="day-count" data-over="${size.over}">${size.used} / ${size.max}</span><span class="day-note-status" aria-live="polite"></span><button type="button" class="day-note-reload" hidden>Reload saved</button><button type="button" class="day-note-keep" hidden>Keep mine</button></span><button type="button" class="primary day-note-save">Save</button></div>
</div>`;
}

export function html(view: DayView, ctx: PanelContext, kit: Kit): string {
  const lanes = view.notes;
  if (kit.phone && lanes.length > 1) {
    if (!lanes.some(n => n.lane.listId === phoneLane)) { phoneLane = lanes[0].lane.listId; }
    const shown = lanes.findIndex(n => n.lane.listId === phoneLane);
    return `<section class="day-sec day-notes" aria-label="Notes">
  <div class="day-seg" role="group" aria-label="Whose notes">${lanes.map(n => `<button type="button" class="day-segbtn" data-c="${n.lane.color}" data-list="${esc(n.lane.listId)}" aria-pressed="${n.lane.listId === phoneLane}"><i class="day-sw"></i>${esc(n.lane.name)}</button>`).join('')}</div>
  ${noteHtml(lanes[shown], ctx, shown)}</section>`;
  }
  return `<section class="day-sec day-notes" aria-label="Notes">
  <h2 class="day-label">Notes</h2>
  <div class="day-notelanes ${kit.cols(lanes.length)}">${lanes.map((n, i) => noteHtml(n, ctx, i)).join('')}</div>
</section>`;
}

export function mount(panel: HTMLElement, ctx: PanelContext, kit: Kit): () => void {
  const section = panel.querySelector<HTMLElement>('.day-notes');
  if (!section) { return () => {}; }
  const watchers: ResizeObserver[] = [];
  section.querySelectorAll<HTMLElement>('.day-segbtn').forEach(button => button.addEventListener('click', () => { phoneLane = button.dataset.list!; ctx.rerender(); }));

  section.querySelectorAll<HTMLElement>('.day-note').forEach(block => {
    const key = block.dataset.key!, listId = block.dataset.list!;
    const q = <T extends HTMLElement>(selector: string) => block.querySelector<T>(selector)!;
    const area = q<HTMLTextAreaElement>('.day-note-text'), save = q<HTMLButtonElement>('.day-note-save');
    const status = q('.day-note-status'), reload = q('.day-note-reload'), keep = q('.day-note-keep'), count = q('.day-count');
    let failure = '';
    // Desktop notes grow up to the CSS height limit. A phone's box fills the tab instead.
    const grow = () => {
      if (kit.phone) { return; }
      const top = area.scrollTop;
      area.style.removeProperty('--h');
      area.style.setProperty('--h', `${area.scrollHeight}px`);
      area.scrollTop = top;
    };
    if (!kit.phone) {
      let width = 0;
      const watch = new ResizeObserver(() => { if (area.clientWidth !== width) { width = area.clientWidth; grow(); } });
      watch.observe(area); watchers.push(watch);
      grow();
    }
    // The lane as the session holds it now, not as it was when the block was drawn.
    const current = (): NoteLane => noteLanes(ctx.session.notes, 'day', ctx.date, 'notes', [ctx.lanes.find(l => l.listId === listId)!])[0];
    const state = () => noteState(current(), ctx.drafts.get(key), MAX());

    function draw() {
      const s = state();
      kit.setCount(count, `${s.count.used} / ${s.count.max}`, s.count.over);
      status.textContent = failure || (s.moved ? 'Changed elsewhere' : s.dirty ? 'Unsaved' : current().note ? 'Saved' : '');
      // The saved note moved on after this draft began: take the saved text, or keep mine over it.
      reload.hidden = !s.moved; keep.hidden = !s.moved;
    }
    kit.guard(save, () => { const s = state(); return s.dirty && !s.count.over; });
    draw();

    area.addEventListener('input', () => { grow(); editDraft(ctx.drafts, current(), area.value); failure = ''; draw(); kit.refresh(); });
    keep.addEventListener('click', () => { rebaseDraft(ctx.drafts, current()); failure = ''; draw(); kit.refresh(); });
    reload.addEventListener('click', () => {
      ctx.drafts.delete(key); failure = '';
      area.value = current().note?.text ?? '';
      grow();
      draw(); kit.refresh();
    });
    save.addEventListener('click', async () => {
      const draft = ctx.drafts.get(key), s = state();
      if (!draft || !s.dirty || s.count.over || save.disabled) { return; }
      const result = await ctx.send({ action: 'saveNote', scope: 'day', period: ctx.date, listId, field: 'notes', text: s.text, revision: draft.revision });
      // Only what was sent is cleared; text typed while the write ran stays a draft, now based on the saved revision.
      if (result.ok) { settleDraft(ctx.drafts, key, s.text, current().revision); failure = ''; }
      else if (!result.skipped) { failure = result.message; }
      draw(); kit.refresh();
    });
  });
  return () => watchers.forEach(w => w.disconnect());
}
