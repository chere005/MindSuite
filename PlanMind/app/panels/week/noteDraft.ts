/**
 * The unsent-text rules of the Week and Month text blocks (also used by the Month panel; its Priorities and Notes
 * behave as Week's). Pure functions over the shared drafts map, so they are tested without a browser.
 *
 * A draft is kept only while it differs from the saved note, keyed by the note key, so it belongs to a list and a
 * period and not to a lane position: changing the picker selection never loses one. It remembers the revision the
 * person was looking at when they began, so a save made elsewhere meanwhile is a stale write, never an overwrite.
 */
import { counter, type Counter, type Note, type NoteLane } from '../../../packages/core/src/planner';
import type { Draft } from '../../state';

export type NoteState = {
  /** What the text area shows: the draft while it differs from the saved note, else the saved note. */
  text: string;
  dirty: boolean;
  /** The saved note changed after this draft began. */
  moved: boolean;
  count: Counter;
};

export function noteState(lane: NoteLane, draft: Draft | undefined, max: number): NoteState {
  const saved = lane.note?.text ?? '';
  const dirty = draft !== undefined && draft.text !== saved;
  const text = dirty ? draft.text : saved;
  return { text, dirty, moved: dirty && draft.revision !== lane.revision, count: counter(text, max) };
}

/** After a keystroke: no draft once the text is back to what is saved; a new draft starts at the revision on screen. */
export function editDraft(drafts: Map<string, Draft>, lane: NoteLane, text: string): void {
  if (text === (lane.note?.text ?? '')) { drafts.delete(lane.key); return; }
  drafts.set(lane.key, { text, revision: drafts.get(lane.key)?.revision ?? lane.revision });
}

/** After a save of `sent` that the server accepted as `revision`: drop the draft, or keep what was typed meanwhile on the new revision. */
export function settleDraft(drafts: Map<string, Draft>, key: string, sent: string, revision: number): void {
  const draft = drafts.get(key);
  if (!draft) { return; }
  if (draft.text === sent) { drafts.delete(key); } else { draft.revision = revision; }
}

/** "Keep mine": the person has seen the newer note and chooses their text over it. */
export function rebaseDraft(drafts: Map<string, Draft>, lane: NoteLane): void {
  const draft = drafts.get(lane.key);
  if (draft) { draft.revision = lane.revision; }
}

/** Drafts of any scope (day, week, month) whose list no longer exists: they cannot be saved or seen, so they are dropped. */
export function orphanDrafts(keys: Iterable<string>, listIds: ReadonlySet<string>): string[] {
  return [...keys].filter(key => !listIds.has(key.split(':')[2]));
}

/**
 * The keys of drafts that still hold something to lose: their list exists and their text differs from the saved note
 * (an absent note is empty text). This, not the size of the map, decides whether leaving the page warns.
 */
export function unsavedDrafts(drafts: ReadonlyMap<string, Draft>, notes: readonly Pick<Note, 'key' | 'text'>[], listIds: ReadonlySet<string>): string[] {
  const saved = new Map(notes.map(note => [note.key, note.text]));
  return [...drafts].filter(([key, draft]) => listIds.has(key.split(':')[2]) && draft.text !== (saved.get(key) ?? '')).map(([key]) => key);
}
