import { expect, test } from 'vitest';
import {
  blurTitle, editTitle, focusTitle, initTitleField, reconcileTitle, singleLine, type TitleField,
} from '../src/components/titleFieldState';

// #167. The rule decides when JS may write into a title field: only by a new
// epoch (a remount on a new defaultValue), and only while the field is closed.

const BORN = 'Nov 10, 2026 at 5:30pm'; // a new note's generated title

/** ['blur', text]: the blur handler also writes the store (Notes parses a date there), in the same render. */
type Event = ['focus'] | ['type', string] | ['store', string] | ['blur'] | ['blur', string];

/**
 * TitleInput in miniature: every event is followed by a render, which runs
 * reconcileTitle with what the store holds now. A new note's generated title
 * reaches the field as '' (Notes shows it as the placeholder instead).
 * `remeasure` is what TitleInput passes on iOS.
 */
function drive(events: Event[], remeasure = false) {
  let title = BORN;
  const stored = () => (title === BORN ? '' : title);
  let field = initTitleField(stored());
  const writes: string[] = [];
  const fields: TitleField[] = [];
  for (const [kind, text] of events) {
    if (kind === 'focus') field = focusTitle(field);
    if (kind === 'type') { field = editTitle(field, text!); title = singleLine(text!); }
    if (kind === 'store') title = text!; // the store changing under the field: an echo, a sync, a parsed date
    if (kind === 'blur') { field = blurTitle(field); if (text !== undefined) title = text; }
    const next = reconcileTitle(field, stored(), remeasure);
    if (next.epoch !== field.epoch) writes.push(next.initial);
    field = next;
    fields.push(field);
  }
  return { field, writes, fields };
}

const BOTH = [false, true] as const;
const where = (remeasure: boolean) => (remeasure ? 'iOS' : 'web/Android');

test('a new note opens empty and closed', () => {
  expect(initTitleField('')).toEqual({ epoch: 0, initial: '', native: '', open: false });
});

for (const remeasure of BOTH) {
  test(`local edits win: an open field is never handed what the store holds (${where(remeasure)})`, () => {
    const typed = editTitle(focusTitle(initTitleField('')), 'Key');
    for (const stored of ['', 'K', 'Ke', 'Key', 'Keyboard', 'Renamed elsewhere']) {
      expect(reconcileTitle(typed, stored, remeasure)).toBe(typed); // same object: no render-time change at all
    }
  });

  test(`a late store echo never rewinds the field (${where(remeasure)})`, () => {
    const { field, writes } = drive([
      ['focus'], ['type', 'K'], ['type', 'Ke'], ['type', 'Key'],
      ['store', 'K'], // two keystrokes behind
      ['type', 'Keyb'], ['store', 'Ke'], ['store', 'Keyb'],
    ], remeasure);
    expect(writes).toEqual([]);
    expect(field.epoch).toBe(0);
    expect(field.native).toBe('Keyb');
  });

  test(`a focus event that arrives after the first keystrokes is a no-op (${where(remeasure)})`, () => {
    const typed = editTitle(initTitleField(''), 'Ke'); // keystrokes reached JS first
    expect(typed.open).toBe(true);
    expect(focusTitle(typed)).toBe(typed);
    const { writes, field } = drive([['type', 'K'], ['type', 'Ke'], ['focus'], ['type', 'Key']], remeasure);
    expect(writes).toEqual([]);
    expect(field.native).toBe('Key');
  });

  test(`what the store settles on after blur is shown: a parsed date, a rename from elsewhere (${where(remeasure)})`, () => {
    // Notes' onBlur takes "Dentist 8/3" apart into a title and a date.
    const parsed = drive([['focus'], ['type', 'Dentist 8/3'], ['blur', 'Dentist']], remeasure);
    expect(parsed.writes).toEqual(['Dentist']);
    expect(parsed.field).toMatchObject({ epoch: 1, initial: 'Dentist', native: 'Dentist', open: false });
    // Nobody is in the field: another device's rename lands at once.
    expect(drive([['store', 'Groceries']], remeasure).writes).toEqual(['Groceries']);
  });

  test(`a rename that arrives while the field is open waits for blur, then shows (${where(remeasure)})`, () => {
    const { writes, fields } = drive([['focus'], ['store', 'From the other phone'], ['blur']], remeasure);
    expect(fields[1]!.epoch).toBe(0);
    expect(writes).toEqual(['From the other phone']);
  });

  test(`a pasted newline reaches the store as a space, and the closed field shows the same (${where(remeasure)})`, () => {
    const { writes } = drive([['focus'], ['type', 'Soup\nand bread'], ['blur']], remeasure);
    expect(writes).toEqual(['Soup and bread']);
  });

  test(`a field mounted on its title and edited is not remounted on its own text (${where(remeasure)})`, () => {
    const { writes } = drive([['store', 'Dentist'], ['focus'], ['type', 'Dentist at noon'], ['blur'], ['focus'], ['blur']], remeasure);
    expect(writes).toEqual(['Dentist']); // the rename landing while closed, nothing after
    // Opened and closed with nothing typed: nothing.
    expect(reconcileTitle(blurTitle(focusTitle(initTitleField('Dentist'))), 'Dentist', remeasure).epoch).toBe(0);
  });

  test(`reconcile is stable: a second pass over its own result changes nothing (${where(remeasure)})`, () => {
    const states = [
      initTitleField(''),
      editTitle(initTitleField(''), 'K'),
      blurTitle(editTitle(initTitleField(''), 'K')),
      blurTitle(editTitle(initTitleField('Dentist'), 'Dentist 2')),
    ];
    for (const field of states) {
      for (const stored of ['', 'K', 'Dentist 2', 'Other']) {
        const once = reconcileTitle(field, stored, remeasure);
        expect(reconcileTitle(once, stored, remeasure)).toBe(once);
      }
    }
  });
}

test('iOS: a field mounted empty and typed into is remounted on exactly its own text when it closes', () => {
  // React Native measures it by its placeholder until its text is the
  // defaultValue; the remount writes nothing the field does not already hold.
  const { writes, field } = drive([['focus'], ['type', 'Dentist'], ['blur']], true);
  expect(writes).toEqual(['Dentist']);
  expect(field).toMatchObject({ open: false, native: 'Dentist', initial: 'Dentist', epoch: 1 });
  // Opened and closed again without a keystroke: nothing more.
  expect(drive([['focus'], ['type', 'Dentist'], ['blur'], ['focus'], ['blur']], true).writes).toEqual(['Dentist']);
  // Typed into and emptied again: it is still measured right, nothing to do.
  expect(drive([['focus'], ['type', 'D'], ['type', ''], ['blur']], true).writes).toEqual([]);
});

test('web/Android: closing a field whose text the store already holds remounts nothing', () => {
  // A browser blurs the field when its window loses focus and focuses the
  // same element when it comes back: a remount in between would lose the caret.
  const { writes, field } = drive([['focus'], ['type', 'Keyboard'], ['blur'], ['focus'], ['type', 'Keyboard probe']]);
  expect(writes).toEqual([]);
  expect(field).toMatchObject({ epoch: 0, native: 'Keyboard probe', open: true });
});

test('singleLine joins the lines a paste can bring', () => {
  expect(singleLine('Soup\nand bread')).toBe('Soup and bread');
  expect(singleLine('a \r\n  b\n\nc')).toBe('a b c');
  expect(singleLine('no newline')).toBe('no newline');
});

for (const remeasure of BOTH) {
  test(`over any interleaving of keystrokes, echoes and focus, nothing is written into the open field (${where(remeasure)})`, () => {
    const word = 'Keyboard probe title 1';
    let seed = 167;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let trial = 0; trial < 500; trial++) {
      const events: Event[] = [];
      let typed = 0;
      if (rnd() < 0.5) events.push(['focus']);
      while (typed < word.length) {
        const r = rnd();
        if (r < 0.55) events.push(['type', word.slice(0, ++typed)]);
        else if (r < 0.8) events.push(['store', word.slice(0, Math.floor(rnd() * (typed + 1)))]); // any older prefix
        else if (r < 0.9) events.push(['focus']); // a late or repeated focus
        else events.push(['store', 'Renamed elsewhere']);
      }
      const { fields } = drive(events, remeasure);
      // Before the field opens the store may still change it (that is a rename
      // landing, not an echo); from the moment it opens, nothing does.
      const opened = fields.findIndex((f) => f.open);
      const { epoch } = fields[opened]!;
      let last = '';
      events.forEach((event, i) => {
        if (event[0] === 'type') last = event[1];
        if (i < opened) return;
        expect(fields[i]!.epoch).toBe(epoch);
        if (last) expect(fields[i]!.native).toBe(last);
      });
      // The store ends where the last keystroke left it. Closing writes
      // nothing but exactly that, at most once, and never anything older.
      const closed = reconcileTitle(blurTitle(fields.at(-1)!), word, remeasure);
      expect(closed).toMatchObject({ native: word, open: false });
      if (closed.epoch !== epoch) expect(closed).toMatchObject({ epoch: epoch + 1, initial: word });
      expect(reconcileTitle(closed, word, remeasure)).toBe(closed);
    }
  });
}
