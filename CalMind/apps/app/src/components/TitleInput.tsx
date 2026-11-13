import React, { useState } from 'react';
import { Platform, TextInput, type TextInputProps } from 'react-native';
import { blurTitle, editTitle, focusTitle, initTitleField, reconcileTitle, singleLine } from './titleFieldState';

type TitleInputProps = Omit<TextInputProps, 'value' | 'defaultValue' | 'placeholder' | 'multiline'> & {
  /** The title as the store holds it (what the field should show once nobody is typing). */
  stored: string;
  /** What to show while the field is empty. */
  placeholder: string;
};

/**
 * A title the user types into and the store also holds (#167: a new note's
 * title dropped or reordered letters typed fast). Shared by every platform:
 * iOS, Android, web, and the desktop app, which runs the web build.
 *
 * Two decisions, each closing one of the two writes that lost the letters on
 * iOS (the trace is in titleFieldState.ts):
 *
 *  - UNCONTROLLED, on every platform: the field keeps its own text and
 *    `stored` only replaces it, by remounting, while the field is not open and
 *    the store holds something different (a rename from elsewhere, a date
 *    parsed out on blur). JS never writes into a field somebody is typing in,
 *    so a controlled value's echo cannot either, and IME composition, paste,
 *    undo and the caret stay the platform's own.
 *  - On iOS the field is a UITextView (`multiline`, Return still ending the
 *    edit), not a UITextField. React Native echoes every keystroke back to
 *    the field as Fabric state; a UITextField's first letter is snapshotted
 *    before UIKit has given it the field's attributes, so that echo is
 *    re-assigned and the keystrokes queued behind it are erased. A UITextView
 *    has its attributes when the snapshot is taken, so the echo is skipped.
 *    It stays scrollable: a field mounted empty is one line tall until it
 *    closes (titleFieldState.ts, clause 3), and scrolling keeps the line
 *    being typed in view meanwhile, as a single-line field's sideways
 *    scroll did. Closed, it wraps to the whole title.
 */
const IOS = Platform.OS === 'ios';

export const TitleInput = React.forwardRef<TextInput, TitleInputProps>(function TitleInput(
  { stored, placeholder, onFocus, onBlur, onChangeText, ...rest }, ref,
) {
  const [field, setField] = useState(() => initTitleField(stored));
  // Derived during render, like useNoteScoped: the wrong text is never drawn once.
  const settled = reconcileTitle(field, stored, IOS);
  if (settled !== field) setField(settled);
  return (
    <TextInput
      {...rest}
      {...(IOS ? { multiline: true, submitBehavior: 'blurAndSubmit' as const } : null)}
      ref={ref}
      key={settled.epoch}
      defaultValue={settled.initial}
      placeholder={placeholder}
      onFocus={(event) => { setField(focusTitle); onFocus?.(event); }}
      onBlur={(event) => { setField(blurTitle); onBlur?.(event); }}
      onChangeText={(text) => {
        setField((current) => editTitle(current, text));
        // A pasted newline cannot be a title's; the store gets it as a space,
        // and the field shows the same once it is closed.
        onChangeText?.(singleLine(text));
      }}
    />
  );
});
