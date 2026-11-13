/**
 * The per-lane text blocks of the Week and Month panels (spec 7.6): one block for each lane, in lane order, each a
 * colored card with the list's name over a text area and its own Save. Week has Priorities; Month has Priorities and Notes.
 *
 * The Month's Priorities boxes on a desktop are as tall as their words (`data-fit`: mountNotes writes the height they need to --fit and weekmonth.css
 * gives them that height, up to their share of the side column); a Week and every phone layout keep a box of fixed size. The Month's Notes on a desktop are a compact box of
 * about two lines in the sixth calendar row that scrolls inside itself (`data-cue`: only the shadow along its bottom edge that says there are more words is kept up to date).
 *
 * The text a block shows comes from noteState: the draft in ctx.drafts while it differs from the saved note, else
 * the saved note. A draft lives in memory under the note key, so a re-render, a poll or a picker change keeps it.
 */
import { noteLanes, textLimit, type NoteField, type NoteLane } from '../../packages/core/src/planner';
import { esc, type PanelContext, type Unmount } from '../panelContext';
import { editDraft, noteState, orphanDrafts, rebaseDraft, settleDraft } from './week/noteDraft';

/** What the twin that measures a box takes from it: everything that decides how its words wrap and how tall they are. */
const TWIN_STYLES = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'wordSpacing', 'tabSize', 'textIndent', 'textTransform', 'whiteSpace', 'wordBreak', 'overflowWrap', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const;

export type NoteSpec = {
  scope: 'week' | 'month';
  period: string;
  field: NoteField;
  /** Lower case noun for the text area's name: "Sam priorities". */
  label: string;
  placeholder: string;
};

/** Drafts of lists that no longer exist cannot be saved or seen; dropping them keeps the leave-page warning honest. */
export function dropOrphanDrafts(ctx: PanelContext): void {
  for (const key of orphanDrafts(ctx.drafts.keys(), new Set(ctx.lists.map(list => list.id)))) { ctx.drafts.delete(key); }
}

const block = (ctx: PanelContext, spec: NoteSpec, nl: NoteLane) => {
  const { lane } = nl;
  const text = noteState(nl, ctx.drafts.get(nl.key), textLimit('note', spec.scope, false)).text;
  // The leading newline is swallowed by the HTML parser, so a note that itself begins with a line break survives.
  return `<section class="wm-lane" data-c="${lane.color}" data-key="${esc(nl.key)}" data-list="${esc(lane.listId)}" data-scope="${spec.scope}" data-period="${spec.period}" data-field="${spec.field}">
  <header class="wm-lane-head"><span class="wm-swatch tone-dot" aria-hidden="true"></span><h3 title="${esc(lane.name)}">${esc(lane.name)}</h3>${lane.you ? '<span class="wm-you">you</span>' : ''}</header>
  <textarea class="wm-text"${spec.scope === 'month' ? (spec.field === 'priorities' ? ' data-fit' : ' data-cue') : ''} aria-label="${esc(lane.name)} ${spec.label}" placeholder="${esc(spec.placeholder)}">\n${esc(text)}</textarea>
  <div class="wm-lane-foot"><span class="wm-count"></span><span class="wm-state" role="status"></span><span class="wm-cue" aria-hidden="true"></span>
    <button type="button" class="text-button" data-act="reload" hidden>Reload saved</button><button type="button" class="text-button" data-act="keep" hidden>Keep mine</button>
    <button type="button" class="primary" data-act="save" disabled>Save</button></div>
</section>`;
};

/** One block per lane of `lanes` (the view model's NoteLane list). */
export const noteBlocksHtml = (ctx: PanelContext, spec: NoteSpec, lanes: NoteLane[]) =>
  `<div class="wm-lanes">${lanes.map(nl => block(ctx, spec, nl)).join('')}</div>`;

/** Wires every text block inside `root`. */
export function mountNotes(root: HTMLElement, ctx: PanelContext): Unmount {
  const blocks = [...root.querySelectorAll<HTMLElement>('.wm-lane')];
  // Week and Month text share one limit (CAPS.docChars).
  const max = textLimit('note', 'week', false);
  const nameOf = (id: string) => ctx.lists.find(list => list.id === id)?.name ?? id;

  // The lane as the session holds it now, not as it was when the block was drawn.
  const current = (el: HTMLElement): NoteLane => {
    const { scope, period, field, list } = el.dataset;
    const lane = ctx.lanes.find(l => l.listId === list)!;
    return noteLanes(ctx.session.notes, scope as 'week' | 'month', period!, field as NoteField, [lane])[0];
  };

  function paint(el: HTMLElement) {
    const nl = current(el), state = noteState(nl, ctx.drafts.get(nl.key), max);
    const q = <T extends HTMLElement>(selector: string) => el.querySelector<T>(selector)!;
    q('.wm-count').textContent = `${state.count.used} / ${state.count.max}`;
    q('.wm-count').classList.toggle('over', state.count.over);
    const by = nl.note?.updatedBy;
    const sentence = state.count.over ? `Use at most ${max} characters.`
      : state.moved ? `${by === ctx.me ? 'Changed on another device' : `${nameOf(by ?? '')} saved a newer version`} since you began.`
      : '';
    q('.wm-state').textContent = sentence || (state.dirty ? 'Unsaved' : nl.note ? 'Saved' : '');
    // The Month's compact Notes card has no room for a sentence: a short cue (aria-hidden; the status above says it whole) takes the count's or Save's place, with the sentence for a tooltip.
    const badge = q('.wm-cue');
    badge.textContent = state.count.over ? 'Too long' : state.moved ? 'Newer version' : '';
    badge.title = sentence;
    el.toggleAttribute('data-notice', state.count.over || state.moved);
    el.toggleAttribute('data-moved', state.moved);
    // The Month's compact Notes card lets Reload saved take the place of the word Unsaved, and drops Save while a notice is up (weekmonth.css).
    el.toggleAttribute('data-dirty', state.dirty);
    q('[data-act=reload]').hidden = !state.dirty;
    q('[data-act=keep]').hidden = !state.moved;
    q<HTMLButtonElement>('[data-act=save]').disabled = !state.dirty || state.count.over || ctx.busy;
  }

  // A box that grows with its words is as tall as its content needs. The height is measured on a hidden twin of the box (same width, font and padding, no height of its own), never
  // on the box itself: releasing the live box to measure it makes the column's other scrollers (the to-do list, the other card) roomier for a moment, and WebKit clamps their scroll
  // positions for good when that happens. The twin's height is written for the CSS to use.
  const fit = (text: HTMLTextAreaElement) => {
    if (!text.offsetWidth) { return; }
    const style = getComputedStyle(text), twin = text.ownerDocument.createElement('textarea');
    twin.setAttribute('aria-hidden', 'true');
    twin.tabIndex = -1;
    twin.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;height:0;min-height:0;max-height:none;margin:0;border:0;overflow:hidden;resize:none;box-sizing:border-box';
    for (const name of TWIN_STYLES) { twin.style[name] = style[name]; }
    // The width the words wrap in: the box's own, less a scrollbar that takes room (it has no border).
    twin.style.width = `${text.getBoundingClientRect().width - Math.max(0, text.offsetWidth - text.clientWidth)}px`;
    twin.value = text.value;
    text.ownerDocument.body.append(twin);
    const height = `${twin.scrollHeight}px`;
    twin.remove();
    if (text.style.getPropertyValue('--fit') !== height) { text.style.setProperty('--fit', height); }
  };
  // A box that holds more words than it shows says so with a shadow along its bottom edge (weekmonth.css) until it is scrolled to the end: a cut that lands on a line boundary looks like the end of the list.
  const cue = (text: HTMLTextAreaElement) => text.toggleAttribute('data-more', text.scrollTop + text.clientHeight < text.scrollHeight - 1);
  // The words wrap again when the column changes width (and a box on a hidden phone tab measures nothing until it is shown). The new height
  // is written a frame later: a box resized by the observer's own callback would make the browser report a resize loop. Any change of size (the other card growing
  // takes room from this one) updates the cue.
  const widths = new Map<Element, number>();
  const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
    for (const { target, contentRect } of entries) {
      cue(target as HTMLTextAreaElement);
      if (!target.hasAttribute('data-fit') || widths.get(target) === contentRect.width) { continue; }
      widths.set(target, contentRect.width);
      requestAnimationFrame(() => { if (target.isConnected) { fit(target as HTMLTextAreaElement); } });
    }
  });

  for (const el of blocks) {
    const text = el.querySelector<HTMLTextAreaElement>('.wm-text')!;
    const grows = text.hasAttribute('data-fit');
    const cues = grows || text.hasAttribute('data-cue');
    if (grows) { fit(text); }
    if (cues) { cue(text); text.onscroll = () => cue(text); watch?.observe(text); }
    const reload = el.querySelector<HTMLButtonElement>('[data-act=reload]')!;
    let armed = false;
    text.oninput = () => { editDraft(ctx.drafts, current(el), text.value); if (grows) { fit(text); } if (cues) { cue(text); } paint(el); };
    el.querySelector<HTMLButtonElement>('[data-act=keep]')!.onclick = () => { rebaseDraft(ctx.drafts, current(el)); paint(el); };
    // A first press asks; the second throws the draft away and shows what is saved.
    reload.onclick = () => {
      if (!armed) { armed = true; reload.textContent = 'Discard draft?'; return; }
      ctx.drafts.delete(current(el).key);
      ctx.rerender();
      void ctx.state.refresh();
    };
    el.querySelector<HTMLButtonElement>('[data-act=save]')!.onclick = async () => {
      const nl = current(el), draft = ctx.drafts.get(nl.key), state = noteState(nl, draft, max);
      if (!draft || !state.dirty || state.count.over) { return; }
      const { scope, period, field, list } = el.dataset;
      const result = await ctx.send({ action: 'saveNote', scope: scope as 'week' | 'month', period: period!, listId: list!, field: field as NoteField, text: state.text, revision: draft.revision });
      // Only what was sent is cleared; text typed while the write ran stays, now based on the saved revision.
      if (result.ok) { settleDraft(ctx.drafts, nl.key, state.text, current(el).revision); }
      if (el.isConnected) { paint(el); }
    };
    paint(el);
  }
  // The Month's Notes cards sit in a strip that scrolls sideways when the lanes do not fit side by side (weekmonth.css). A card the keyboard or a click reaches is brought whole into view; only the strip
  // is scrolled (scrollIntoView would also move the clipped block around it).
  const strip = root.querySelector<HTMLElement>('[data-sec=notes] .wm-lanes');
  const reveal = (event: FocusEvent) => {
    const lane = (event.target as HTMLElement).closest<HTMLElement>('.wm-lane');
    if (!strip || !lane || strip.scrollWidth <= strip.clientWidth) { return; }
    const [around, card] = [strip.getBoundingClientRect(), lane.getBoundingClientRect()];
    if (card.left < around.left) { strip.scrollLeft += card.left - around.left; } else if (card.right > around.right) { strip.scrollLeft += card.right - around.right; }
  };
  strip?.addEventListener('focusin', reveal);
  // Save is not marked data-writes: the shell would re-enable it after every render and write, even with nothing to save.
  // Paint owns it (no draft, over the limit, or a write running) and repaints whenever a write starts or ends.
  const stop = ctx.state.subscribe(change => { if (change === 'busy') { blocks.forEach(paint); } });
  return () => { stop(); watch?.disconnect(); strip?.removeEventListener('focusin', reveal); };
}
