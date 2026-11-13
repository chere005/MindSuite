import { describe, it, expect } from 'vitest';
import type { Note, NoteLane } from '../../../packages/core/src/planner';
import type { Draft } from '../../state';
import { editDraft, noteState, orphanDrafts, rebaseDraft, settleDraft, unsavedDrafts } from './noteDraft';

const KEY = 'week:2026-10-26:sam:priorities';
const lane = (text: string | null, revision = 0): NoteLane => ({
  lane: { listId: 'sam', name: 'Sam', color: 'yellow', you: false }, key: KEY, revision,
  note: text === null ? null : { key: KEY, scope: 'week', period: '2026-10-26', listId: 'sam', field: 'priorities', text, revision, updatedBy: 'alex', updatedAt: 'x' } as Note,
});
const drafts = (entries: [string, Draft][] = []) => new Map(entries);

describe('noteState', () => {
  it('shows the saved note when there is no draft, and counts it', () => {
    expect(noteState(lane('abc', 2), undefined, 10)).toMatchObject({ text: 'abc', dirty: false, moved: false, count: { used: 3, max: 10, over: false } });
    expect(noteState(lane(null), undefined, 10)).toMatchObject({ text: '', dirty: false });
  });
  it('shows a draft that differs from the saved note, and a draft equal to it is not dirty', () => {
    expect(noteState(lane('abc', 2), { text: 'abcd', revision: 2 }, 10)).toMatchObject({ text: 'abcd', dirty: true, moved: false });
    expect(noteState(lane('abc', 2), { text: 'abc', revision: 1 }, 10)).toMatchObject({ text: 'abc', dirty: false, moved: false });
  });
  it('moved means the saved note changed after the draft began; only a dirty draft can be moved', () => {
    expect(noteState(lane('theirs', 3), { text: 'mine', revision: 2 }, 10)).toMatchObject({ dirty: true, moved: true });
    expect(noteState(lane('mine', 3), { text: 'mine', revision: 2 }, 10).moved).toBe(false);
  });
  it('counts code points and goes over only past the limit', () => {
    expect(noteState(lane(null), { text: '😀😀😀', revision: 0 }, 3).count).toEqual({ used: 3, max: 3, over: false });
    expect(noteState(lane(null), { text: '😀😀😀😀', revision: 0 }, 3).count.over).toBe(true);
  });
});

describe('editDraft', () => {
  it('starts a draft at the revision on screen and keeps that revision while typing continues', () => {
    const map = drafts();
    editDraft(map, lane('abc', 2), 'abcd');
    expect(map.get(KEY)).toEqual({ text: 'abcd', revision: 2 });
    editDraft(map, lane('abc', 5), 'abcde');
    expect(map.get(KEY)).toEqual({ text: 'abcde', revision: 2 });
  });
  it('drops the draft when the text is back to what is saved', () => {
    const map = drafts([[KEY, { text: 'abcd', revision: 2 }]]);
    editDraft(map, lane('abc', 2), 'abc');
    expect(map.size).toBe(0);
    editDraft(map, lane(null), '');
    expect(map.size).toBe(0);
  });
});

describe('settleDraft and rebaseDraft', () => {
  it('a saved draft is cleared; text typed during the write stays, on the new revision', () => {
    const cleared = drafts([[KEY, { text: 'sent', revision: 2 }]]);
    settleDraft(cleared, KEY, 'sent', 3);
    expect(cleared.size).toBe(0);
    const typed = drafts([[KEY, { text: 'sent and more', revision: 2 }]]);
    settleDraft(typed, KEY, 'sent', 3);
    expect(typed.get(KEY)).toEqual({ text: 'sent and more', revision: 3 });
    settleDraft(drafts(), KEY, 'sent', 3);
  });
  it('keep mine moves the draft onto the revision now saved', () => {
    const map = drafts([[KEY, { text: 'mine', revision: 2 }]]);
    rebaseDraft(map, lane('theirs', 4));
    expect(map.get(KEY)).toEqual({ text: 'mine', revision: 4 });
    expect(noteState(lane('theirs', 4), map.get(KEY), 10).moved).toBe(false);
    rebaseDraft(drafts(), lane('theirs', 4));
  });
});

describe('orphanDrafts', () => {
  const ids = new Set(['sam', 'alex', 'cccccccc-0000-4000-8000-000000000000']);
  it('names the drafts of lists that are gone, in every scope (a Day note too)', () => {
    const keys = [
      'week:2026-10-26:sam:priorities', 'month:2026-10-01:dddddddd-0000-4000-8000-000000000000:notes',
      'week:2026-10-26:eeeeeeee-0000-4000-8000-000000000000:priorities', 'month:2026-10-01:cccccccc-0000-4000-8000-000000000000:notes',
      'day:2026-10-30:eeeeeeee-0000-4000-8000-000000000000:notes', 'day:2026-10-30:alex:notes',
    ];
    expect(orphanDrafts(keys, ids)).toEqual([
      'month:2026-10-01:dddddddd-0000-4000-8000-000000000000:notes', 'week:2026-10-26:eeeeeeee-0000-4000-8000-000000000000:priorities',
      'day:2026-10-30:eeeeeeee-0000-4000-8000-000000000000:notes',
    ]);
  });
});

describe('unsavedDrafts', () => {
  const ids = new Set(['sam', 'alex']);
  const saved = [{ key: 'day:2026-10-30:alex:notes', text: 'saved' }];
  it('names a draft that differs from the saved note, or from nothing when there is no note', () => {
    const map = drafts([['day:2026-10-30:alex:notes', { text: 'edited', revision: 1 }], ['week:2026-10-26:sam:priorities', { text: 'new', revision: 0 }]]);
    expect(unsavedDrafts(map, saved, ids)).toEqual(['day:2026-10-30:alex:notes', 'week:2026-10-26:sam:priorities']);
  });
  it('ignores a draft that equals the saved text (the other person saved the same words), and the draft of a deleted list', () => {
    const map = drafts([['day:2026-10-30:alex:notes', { text: 'saved', revision: 1 }], ['day:2026-10-30:eeeeeeee-0000-4000-8000-000000000000:notes', { text: 'lost', revision: 0 }]]);
    expect(unsavedDrafts(map, saved, ids)).toEqual([]);
  });
});
