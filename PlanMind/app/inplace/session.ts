/**
 * The one item of a panel that is being edited where it stands (the owner, 2026-10-31: no window for editing content).
 *
 * A panel keeps one `Edits` for all its sections. `current` is the open edit; the markup of its row is drawn from it, so a
 * redraw of the panel (the other person's change, a finished write) never takes the field down. Opening another item puts the
 * first one away: what it holds that was not saved waits in `kept` and comes back when that item is opened again. Nothing
 * here touches the DOM, the clock or browser storage.
 */
export type Fields = Record<string, string | number>;

export type Session<D extends Fields, M> = {
  /** Names the item: 'todo:<id>', 'priority:<id>', 'priority:new:<list>:<line>', 'event:<id>', 'event:new'. A new item has no stored record yet. */
  readonly key: string;
  /** What the section needs to save it: owners, revision, the id a new item will get. */
  readonly meta: M;
  /** The fields as the record has them (or empty, for a new item). */
  readonly base: D;
  /** What the fields hold now. */
  draft: D;
  /** Why the last save did not happen. Shown in the row. */
  error: string;
  /** Delete was pressed once: its icon is red until the second press, the focus leaving it or a few seconds. */
  confirm: boolean;
  /** Take the keyboard focus into the text field the next time the row is drawn. */
  focus: boolean;
  /** The last save was refused as stale: the text typed is kept and the next save goes over the newer version. */
  stale: boolean;
  /** The draft came back from an earlier opening and differs from what is stored. */
  restored: boolean;
  /** A write for this row is in flight; the field is read-only until it ends. */
  saving: boolean;
  /** Saves what the row holds as the focus leaving it would (the section sets it when the row is drawn). Opening another item calls it. */
  release?: () => void;
};

export const sameFields = (a: Fields, b: Fields) => Object.keys({ ...a, ...b }).every(name => a[name] === b[name]);

/**
 * What an add box holds after a write that sent `sent` (trimmed) from it: nothing when it still holds just that, and what was typed
 * after it while the write ran otherwise ("Buy milk" sent, "Buy milkEggs" now: "Eggs"). Text the sent words are no longer at the start of stays whole.
 */
export function unsentRest(current: string, sent: string): string {
  const lead = current.length - current.trimStart().length;
  const rest = current.startsWith(sent, lead) ? current.slice(lead + sent.length) : current;
  return rest.trim() === '' ? '' : rest;
}

export function createEdits<D extends Fields, M>() {
  let current: Session<D, M> | null = null;
  /** Unsaved drafts of stored items that were put away. */
  const kept = new Map<string, D>();
  /** Where the keyboard focus goes after the redraw that follows a save or Escape: the key of an item's button. */
  let back: string | null = null;
  /** Which page of the panel the edit belongs to (a day, a week); another page puts it away. */
  let scope = '';
  /** Whether a put-away draft of this key is worth keeping (a new item's is not). */
  const worth = (key: string) => !key.includes(':new');

  function leave() {
    const s = current;
    current = null;
    // A row whose write is in flight settles itself (a failure puts its draft in `kept`).
    if (s && !s.saving && worth(s.key) && !sameFields(s.draft, s.base)) { kept.set(s.key, { ...s.draft }); }
  }

  return {
    get current() { return current; },
    /** Whether a put-away item holds words that were never saved (its save was refused or failed after the row was left): they are not on the page, but a reload would lose them. */
    get unsent() { return kept.size > 0; },
    /** The panel shows another page: whatever was open is put away. */
    page(next: string) { if (next !== scope) { scope = next; leave(); } },
    /** Opening another item is the focus leaving the open one: it is saved (an empty new one is dropped), then put away; its kept draft comes back. */
    open(key: string, base: D, meta: M): Session<D, M> {
      current?.release?.();
      leave();
      const was = kept.get(key);
      kept.delete(key);
      current = { key, meta, base, draft: was ? { ...was } : { ...base }, error: '', confirm: false, focus: true, stale: false, restored: !!was && !sameFields(was, base), saving: false };
      return current;
    },
    /** Done with `key` (saved, cancelled or deleted): its kept draft goes too. `focusKey` is where the keyboard goes next. */
    close(key: string, focusKey?: string) {
      if (current?.key === key) { current = null; }
      kept.delete(key);
      back = focusKey ?? null;
    },
    /** A save that failed after the row was put away: the text typed waits for the next opening. */
    keep(s: Session<D, M>) { if (current !== s && worth(s.key) && !sameFields(s.draft, s.base)) { kept.set(s.key, { ...s.draft }); } },
    /** Takes the key the focus should go to, once. */
    takeBack(): string | null { const key = back; back = null; return key; },
    /** The row was left while its write ran and the write went through: the draft is not needed. */
    forget(key: string) { kept.delete(key); },
    /** Puts away the open edit when its item is not on the page any more (another list chosen, the record gone). */
    prune(visible: (key: string) => boolean) { if (current && !current.key.includes(':new') && !visible(current.key)) { leave(); } },
  };
}
export type Edits<D extends Fields, M> = ReturnType<typeof createEdits<D, M>>;
