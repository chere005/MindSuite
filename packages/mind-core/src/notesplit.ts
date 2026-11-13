/**
 * Splitting a note too long to sync into several that fit (#75).
 *
 * The server refuses a record whose payload is over 64KB of JSON (app.php
 * MAX_PAYLOAD), and the app says so and can open the note — but the only way
 * out was to cut it by hand. A split keeps every word: the note keeps the
 * first part, and the rest become new notes right after it in the same
 * section, titled "(1/3)", "(2/3)", "(3/3)".
 *
 * WHAT THE LIMIT MEASURES. The server counts `strlen(json_encode($payload))`
 * — PHP's default encoding, which writes every non-ASCII character as a
 * `\uXXXX` escape (six bytes; twelve for an emoji's surrogate pair) and every
 * '/' as '\/'. JSON.stringify's length is a different, smaller number, so a
 * split measured in it could produce parts the server still refuses.
 * `phpJsonBytes` counts the server's way.
 *
 * WHERE IT CUTS. Paragraphs first (a blank line), then lines, then — only for
 * a single line longer than a whole part, which real writing rarely has —
 * characters, never inside a surrogate pair. Parts are packed greedily, so a
 * split makes as few notes as fit.
 *
 * WHAT IT WILL NOT SPLIT. A recipe or a daily log: their shape is more than a
 * body (ingredients and steps, dated cards), and cutting the body in two would
 * leave two halves that are not a recipe or a log. Those say `null`; the app
 * then offers only "open it to shorten it".
 */
import { byRecOrd, ordBetween } from './order';
import { newId, type AnyRec, type Note, type Rec } from './types';

/** app.php MAX_PAYLOAD — bytes of PHP-encoded JSON per record. */
export const MAX_PAYLOAD_BYTES = 65536;

/** Each part aims under this, leaving room for the server's own framing. */
export const SPLIT_TARGET_BYTES = 60000;

/** The length PHP's json_encode would give `v`, in bytes. */
export function phpJsonBytes(v: unknown): number {
  const s = JSON.stringify(v) ?? 'null';
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // JSON.stringify already escapes quotes, backslashes and control
    // characters exactly as PHP does (same lengths); what differs is '/' and
    // everything outside ASCII, which PHP escapes per UTF-16 unit.
    n += c === 0x2f ? 2 : c < 0x80 ? 1 : 6;
  }
  return n;
}

/** Is this note over the server's limit? */
export function noteTooLong(note: Rec<'note'>): boolean {
  return phpJsonBytes(note.payload) > MAX_PAYLOAD_BYTES;
}

/** Can this note be split at all (see the header)? */
export function noteSplittable(note: Rec<'note'>): boolean {
  const p = note.payload;
  return !p.recipe && (p.noteType ?? 'note') === 'note' && !(p.logCards && p.logCards.length > 0);
}

/** The PHP-encoded size of a string as a JSON string body, without quotes. */
function strBytes(s: string): number {
  return phpJsonBytes(s) - 2;
}

/** Cut one oversized piece into chunks of at most `budget` bytes. */
function hardCut(piece: string, budget: number): string[] {
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (let i = 0; i < piece.length; i++) {
    let ch = piece.charAt(i);
    const c = piece.charCodeAt(i);
    // Never part a surrogate pair: take the low half with the high one.
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < piece.length) {
      ch += piece.charAt(i + 1);
      i++;
    }
    const b = strBytes(ch);
    if (curBytes + b > budget && cur !== '') {
      out.push(cur);
      cur = '';
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  if (cur !== '') out.push(cur);
  return out;
}

/**
 * The body in parts of at most `budget` bytes each, cut at the largest
 * boundary that fits. Joining the parts with the separators they were cut at
 * gives the body back exactly; the parts themselves are trimmed of the
 * separator only, never of content.
 */
export function splitBody(body: string, budget: number): string[] {
  if (budget < 16) throw new Error('splitBody: budget too small');
  if (strBytes(body) <= budget) return [body];
  // Units: paragraphs; any paragraph over budget becomes its lines; any line
  // over budget becomes character chunks. Each unit remembers the separator
  // that preceded it so a part never starts with one.
  type Unit = { text: string; sep: string };
  const units: Unit[] = [];
  const paras = body.split('\n\n');
  paras.forEach((para, pi) => {
    const psep = pi === 0 ? '' : '\n\n';
    if (strBytes(para) <= budget) {
      units.push({ text: para, sep: psep });
      return;
    }
    para.split('\n').forEach((line, li) => {
      const lsep = li === 0 ? psep : '\n';
      if (strBytes(line) <= budget) {
        units.push({ text: line, sep: lsep });
        return;
      }
      hardCut(line, budget).forEach((chunk, ci) => units.push({ text: chunk, sep: ci === 0 ? lsep : '' }));
    });
  });
  const parts: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const u of units) {
    const add = cur === '' ? u.text : u.sep + u.text;
    const addBytes = strBytes(add);
    if (cur !== '' && curBytes + addBytes > budget) {
      parts.push(cur);
      cur = u.text;
      curBytes = strBytes(u.text);
    } else {
      cur += add;
      curBytes += addBytes;
    }
  }
  if (cur !== '' || parts.length === 0) parts.push(cur);
  return parts;
}

function partTitle(title: string, i: number, n: number): string {
  const t = title.trim();
  return t === '' ? `(${i}/${n})` : `${t} (${i}/${n})`;
}

export type NoteSplit = { keep: Rec<'note'>; added: Rec<'note'>[] };

/**
 * The note as several that each fit, or null when it needs no split or cannot
 * be split. `siblings` are the records around it (any type; only notes in its
 * section are read) so the new parts land right after it, before whatever
 * came next. Records come back unstamped — the caller `put`s them.
 */
export function splitNote(
  note: Rec<'note'>,
  siblings: AnyRec[],
  opts: { target?: number; newId?: () => string } = {},
): NoteSplit | null {
  if (!noteSplittable(note) || !noteTooLong(note)) return null;
  const target = opts.target ?? SPLIT_TARGET_BYTES;
  const mint = opts.newId ?? (() => newId());
  // The body's budget is what is left of a part once everything else in the
  // payload — the longest title a part will carry included — is counted.
  const longestTitle = partTitle(note.payload.title, 999, 999);
  const frame = phpJsonBytes({ ...note.payload, title: longestTitle, body: '' });
  const budget = target - frame;
  if (budget < 1024) return null; // the rest of the payload is the problem, not the body
  const bodies = splitBody(note.payload.body, budget);
  if (bodies.length < 2) return null;
  const n = bodies.length;

  // The next note in the same section, so the parts go between the two.
  const section = siblings
    .filter((r): r is Rec<'note'> => r.type === 'note' && !r.deleted && r.id !== note.id
      && (r as Rec<'note'>).payload.sectionId === note.payload.sectionId)
    .sort(byRecOrd);
  const next = section.find((r) => r.payload.ord > note.payload.ord);
  let lo = note.payload.ord;
  const added: Rec<'note'>[] = [];
  for (let i = 1; i < n; i++) {
    let ord: string;
    try {
      ord = ordBetween(lo, next?.payload.ord ?? null);
    } catch {
      ord = ordBetween(lo, null); // no room before the next one: after it is still in order among the parts
    }
    lo = ord;
    const payload: Note = { ...note.payload, title: partTitle(note.payload.title, i + 1, n), body: bodies[i] ?? '', ord };
    added.push({ id: mint(), type: 'note', updated: note.updated, payload } as Rec<'note'>);
  }
  const keep: Rec<'note'> = {
    ...note,
    payload: { ...note.payload, title: partTitle(note.payload.title, 1, n), body: bodies[0] ?? '' },
  };
  return { keep, added };
}
