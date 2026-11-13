/**
 * Who owns a title field's text (CalMind #167: a new note's title drops or
 * reorders letters typed fast).
 *
 * THE CAUSE, traced on the iOS simulator (docs/CONTINUATION.md, #167): every
 * keystroke comes back to React Native's iOS TextInput as Fabric state, and
 * `RCTTextInputComponentView _setAttributedString:` assigns the backing
 * view's `attributedText` whenever that state differs from the live text,
 * attributes included. For the FIRST letter typed into an empty UITextField
 * it does differ, with the same string: either native's own snapshot of the
 * letter (taken before UIKit gave it the field's attributes: NSFont and
 * NSColor only), or the controlled `value` coming back from React (no
 * paragraph style). UIKit runs the keystrokes already queued behind that
 * letter INSIDE the setter, while RN's `_comingFromJS` is set, so their
 * change events are dropped and JS never hears of them; the setter's one
 * letter then replaces them ("Keyboard" came back "Koard"), and RN's caret
 * restore, measured against the length before the setter, can put the next
 * letters mid-word ("Keybo probe title 2ard"). It needs keys queued at that
 * instant: a freshly launched app and fast typing, never a browser.
 *
 * So the fix closes both writes: the field is uncontrolled (no value to echo,
 * the rule below), and on iOS it is a UITextView, whose first letter already
 * carries the field's attributes when native snapshots it, so the echo
 * compares equal and nothing is assigned (TitleInput.tsx).
 *
 * THE RULE, so JS never writes into a field the user is typing in:
 *
 *  1. The native field owns its text. It is UNCONTROLLED: `defaultValue`, never
 *     `value`, frozen for the life of one `epoch`, so no store echo, however
 *     late or stale, can reach it (the controlled value's echo of the first
 *     letter was one of the two writes above).
 *  2. What the store holds is applied only while the field is not open
 *     (focused, or typed into since the last blur): a new `epoch` remounts a
 *     closed field on the stored title whenever the store differs from what
 *     the field holds. A rename from another device, or the date parsed out
 *     of a title on blur, therefore still show, and an echo of the user's own
 *     keystrokes never reaches an open field.
 *  3. `remeasure` (iOS only) also remounts, on the same text, a field that was
 *     mounted EMPTY and has been typed into, once it closes. React Native
 *     0.86 measures such a field by its placeholder for good: Fabric measures
 *     the native text only once the shadow state carries the React text's
 *     font scale, and an empty React text never sets it
 *     (BaseTextInputShadowNode attributedStringBoxToMeasure). So a long new
 *     title only wraps to its full height once its text is the
 *     `defaultValue`. Elsewhere the field is one line and a remount
 *     would only cost something: a browser blurs the field when the window
 *     loses focus, and a remount then would leave the caret nowhere to come
 *     back to.
 *
 * The placeholder is not text and not part of the rule: it follows the store
 * (a new note's generated date until its first letter, then "Title"), as it
 * always has. The trace saw it change mid-typing without a write to the text.
 *
 * Because focus and keystroke events can reach JS in either order, a
 * keystroke opens the session too, and a late focus is then a no-op.
 */
export type TitleField = {
  /** Bumped to remount the native field on a new `initial`. */
  epoch: number;
  /** The field's `defaultValue` for this epoch. Never changes within one. */
  initial: string;
  /** The last text the native field is known to hold. */
  native: string;
  /** Focused, or typed into since the last blur: JS must not write. */
  open: boolean;
};

export function initTitleField(stored: string): TitleField {
  return { epoch: 0, initial: stored, native: stored, open: false };
}

/**
 * Run on every render with the store's current title; returns `field` itself
 * when nothing changes. `remeasure` is clause 3 (TitleInput passes it on iOS).
 */
export function reconcileTitle(field: TitleField, stored: string, remeasure = false): TitleField {
  if (field.open) return field; // local edits win: the store is never read into an open field
  const typedIntoEmpty = remeasure && field.initial === '' && field.native !== '';
  if (stored !== field.native || typedIntoEmpty) {
    return { epoch: field.epoch + 1, initial: stored, native: stored, open: false };
  }
  return field;
}

/** Focus opens a session unless a keystroke already did. It never rewinds the text. */
export function focusTitle(field: TitleField): TitleField {
  return field.open ? field : { ...field, open: true };
}

/** A native edit: the typed text is what the field holds, whether or not focus has been heard of yet. */
export function editTitle(field: TitleField, typed: string): TitleField {
  return field.open && field.native === typed ? field : { ...field, native: typed, open: true };
}

/** Blur closes the session; the next `reconcileTitle` shows whatever the store settled on. */
export function blurTitle(field: TitleField): TitleField {
  return field.open ? { ...field, open: false } : field;
}

/** A title is one line: what the store gets from text that may carry a pasted newline. */
export function singleLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ');
}
