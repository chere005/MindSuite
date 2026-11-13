import type { ListId, Owners } from '../../../packages/core/src/planner';
import { createEdits } from '../../inplace/session';

/**
 * The Day panel's one edit in place (the owner, 2026-10-31): a to-do, a priority line or a schedule entry, one at a time. The fields
 * are the union of what the three kinds edit; a kind leaves the others at their zero.
 */
export type DayFields = { text: string; date: string; start: number; length: number };
export type DayMeta = {
  kind: 'todo' | 'priority' | 'event';
  /** The stored record's id, or the id a new one will get (made once, so a retried add is the same add). */
  id: string;
  stored: boolean;
  owners: Owners;
  /** Priorities: the lane it was opened from and the line it was asked for. */
  listId: ListId;
  line: number;
  /** A new entry made with the Add schedule entry button (the keyboard path): Escape and Enter return the keyboard to it. */
  viaButton: boolean;
  /** A new to-do opened over the add field's line (a click on the empty field): Enter hands the keyboard back to the add field, so typing goes on. */
  viaAdd?: boolean;
  /**
   * A schedule entry: the bordering entries whose edge moved with one of its edges (a shared boundary dragged), at the span they will be
   * saved with and the revision they had. Saved with the entry in one write; leaving the edit with Escape drops them.
   */
  linked?: { id: string; revision: number; start: number; length: number }[];
  /** The revision this edit expects. A priority's own moves each add one; anything else makes the save stale on purpose. */
  revision: number;
};
export const edits = createEdits<DayFields, DayMeta>();
export const NONE = { text: '', date: '', start: 0, length: 0 } satisfies DayFields;
