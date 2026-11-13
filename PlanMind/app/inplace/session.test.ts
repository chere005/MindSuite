import { describe, expect, it } from 'vitest';
import { createEdits, unsentRest } from './session';

// The rules of editing where an item stands: one edit at a time, and what was typed survives going elsewhere. No DOM.
type Meta = { id: string };
const fields = (text: string, start = 0) => ({ text, start });
const make = () => createEdits<{ text: string; start: number }, Meta>();

describe('edits in place', () => {
  it('one edit is open at a time: opening another puts the first away', () => {
    const edits = make();
    edits.open('todo:a', fields('Milk'), { id: 'a' });
    const second = edits.open('todo:b', fields('Eggs'), { id: 'b' });
    expect(edits.current).toBe(second);
    expect(edits.current?.key).toBe('todo:b');
  });

  it('opening another item first lets the open one save as the focus leaving it would', () => {
    const edits = make();
    const first = edits.open('todo:a', fields('Milk'), { id: 'a' });
    const saved: string[] = [];
    first.release = () => { saved.push(first.key); };
    edits.open('todo:b', fields('Eggs'), { id: 'b' });
    expect(saved).toEqual(['todo:a']);
  });

  it('what was typed in a stored item waits and comes back, saying so, when that item is opened again', () => {
    const edits = make();
    const first = edits.open('todo:a', fields('Milk'), { id: 'a' });
    first.draft.text = 'Milk and eggs';
    edits.open('todo:b', fields('Bread'), { id: 'b' });
    const again = edits.open('todo:a', fields('Milk'), { id: 'a' });
    expect(again.draft.text).toBe('Milk and eggs');
    expect(again.restored).toBe(true);
    // Back to what is stored: nothing to restore and no notice.
    again.draft.text = 'Milk';
    edits.open('todo:b', fields('Bread'), { id: 'b' });
    expect(edits.open('todo:a', fields('Milk'), { id: 'a' }).restored).toBe(false);
  });

  it('a draft that was not changed is not kept, and a new item is never kept', () => {
    const edits = make();
    edits.open('todo:a', fields('Milk'), { id: 'a' });
    const fresh = edits.open('event:new', fields('', 540), { id: 'n' });
    fresh.draft.text = 'Half typed';
    edits.open('todo:a', fields('Milk'), { id: 'a' });
    expect(edits.open('event:new', fields('', 600), { id: 'n2' }).draft).toEqual(fields('', 600));
    expect(edits.open('todo:a', fields('Milk'), { id: 'a' }).restored).toBe(false);
  });

  it('closing on purpose (saved, Escape, deleted) forgets the draft and says where the keyboard goes once', () => {
    const edits = make();
    const s = edits.open('todo:a', fields('Milk'), { id: 'a' });
    s.draft.text = 'Changed';
    edits.close('todo:a', 'todo:a');
    expect(edits.current).toBeNull();
    expect(edits.takeBack()).toBe('todo:a');
    expect(edits.takeBack()).toBeNull();
    expect(edits.open('todo:a', fields('Milk'), { id: 'a' }).draft.text).toBe('Milk');
  });

  it('a row whose write is in flight is not put away as a draft; if the write then fails, the text is kept', () => {
    const edits = make();
    const s = edits.open('todo:a', fields('Milk'), { id: 'a' });
    s.draft.text = 'Milk and eggs';
    s.saving = true;
    edits.open('todo:b', fields('Bread'), { id: 'b' });
    expect(edits.open('todo:a', fields('Milk'), { id: 'a' }).restored).toBe(false);
    edits.open('todo:b', fields('Bread'), { id: 'b' });
    // The write failed after the row was left.
    s.saving = false;
    edits.keep(s);
    expect(edits.open('todo:a', fields('Milk'), { id: 'a' }).draft.text).toBe('Milk and eggs');
    // It went through instead: nothing to keep.
    edits.open('todo:b', fields('Bread'), { id: 'b' });
    edits.forget('todo:a');
    expect(edits.open('todo:a', fields('Milk'), { id: 'a' }).restored).toBe(false);
  });

  it('words put away and not saved are unsent until the item is opened and settled again', () => {
    const edits = make();
    expect(edits.unsent).toBe(false);
    const s = edits.open('todo:a', fields('Milk'), { id: 'a' });
    // An open edit is on the page, in its field: it is not the put-away kind.
    s.draft.text = 'Milk and eggs';
    expect(edits.unsent).toBe(false);
    // Left with its save refused (a stale row): the words wait in the put-away drafts, off the page.
    edits.open('todo:b', fields('Bread'), { id: 'b' });
    expect(edits.unsent).toBe(true);
    // Nothing typed, nothing to lose; a new item's words are never kept.
    const quiet = make();
    quiet.open('todo:a', fields('Milk'), { id: 'a' });
    quiet.open('todo:b', fields('Bread'), { id: 'b' });
    expect(quiet.unsent).toBe(false);
    const fresh = quiet.open('todo:new:1', fields(''), { id: 'n' });
    fresh.draft.text = 'Half a thought';
    quiet.open('todo:b', fields('Bread'), { id: 'b' });
    expect(quiet.unsent).toBe(false);
    // Saved, cancelled or deleted: the draft goes with the item.
    edits.close('todo:a');
    expect(edits.unsent).toBe(false);
    // A save that failed after the row was left puts its words away too.
    const late = make(), l = late.open('todo:a', fields('Milk'), { id: 'a' });
    l.draft.text = 'Milk and eggs'; l.saving = true;
    late.open('todo:b', fields('Bread'), { id: 'b' });
    expect(late.unsent).toBe(false);
    l.saving = false; late.keep(l);
    expect(late.unsent).toBe(true);
    late.forget('todo:a');
    expect(late.unsent).toBe(false);
  });

  it('another page (a day, a week) puts the open edit away; the same page does not', () => {
    const edits = make();
    edits.page('2026-10-31');
    const s = edits.open('todo:a', fields('Milk'), { id: 'a' });
    s.draft.text = 'Changed';
    edits.page('2026-10-31');
    expect(edits.current).toBe(s);
    edits.page('2026-11-01');
    expect(edits.current).toBeNull();
    expect(edits.open('todo:a', fields('Milk'), { id: 'a' }).draft.text).toBe('Changed');
  });

  it('an edit whose item is no longer on the page is put away; a new item has no record to be missing', () => {
    const edits = make();
    edits.open('todo:a', fields('Milk'), { id: 'a' });
    edits.prune(key => key !== 'todo:a');
    expect(edits.current).toBeNull();
    const fresh = edits.open('priority:new:sam:1', fields(''), { id: 'p' });
    edits.prune(() => false);
    expect(edits.current).toBe(fresh);
  });

  it('what an add box holds after a write: nothing when only the sent words are left, what came after them otherwise', () => {
    expect(unsentRest('Buy milk', 'Buy milk')).toBe('');
    expect(unsentRest('  Buy milk  ', 'Buy milk')).toBe('');
    expect(unsentRest('Buy milkEggs', 'Buy milk')).toBe('Eggs');
    expect(unsentRest('Buy milk Eggs', 'Buy milk')).toBe(' Eggs');
    // The sent words were changed under the write: nothing is guessed, the box keeps what it has.
    expect(unsentRest('Buy oat milk', 'Buy milk')).toBe('Buy oat milk');
    expect(unsentRest('', 'Buy milk')).toBe('');
  });
});
