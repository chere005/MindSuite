import { describe, it, expect } from 'vitest';
import {
  MAX_PAYLOAD_BYTES, SPLIT_TARGET_BYTES, noteSplittable, noteTooLong, phpJsonBytes, splitBody, splitNote,
} from '../src/notesplit';
import { byRecOrd } from '../src/order';
import type { AnyRec, Rec } from '../src/types';

const note = (id: string, body: string, ord = 'V', extra: Record<string, unknown> = {}): Rec<'note'> => ({
  id, type: 'note', updated: 100,
  payload: { title: 'War and Peace', body, date: null, folderId: 'f', sectionId: 's', ord, ...extra },
} as Rec<'note'>);

/** What app.php's strlen(json_encode(...)) would say, from PHP's own rules. */
describe('phpJsonBytes counts the way the server does', () => {
  it('matches JSON.stringify for plain ASCII', () => {
    expect(phpJsonBytes({ a: 'hello', b: [1, 2] })).toBe(JSON.stringify({ a: 'hello', b: [1, 2] }).length);
  });
  it("counts '/' as two and each non-ASCII UTF-16 unit as six", () => {
    expect(phpJsonBytes('a/b')).toBe(JSON.stringify('a/b').length + 1);
    expect(phpJsonBytes('é')).toBe(2 + 6);
    expect(phpJsonBytes('😀')).toBe(2 + 12);
    expect(phpJsonBytes('\n')).toBe(4);
  });
});

describe('splitBody', () => {
  const sizeOf = (s: string) => phpJsonBytes(s) - 2;

  it('leaves a body that fits alone', () => {
    expect(splitBody('short', 100)).toEqual(['short']);
  });

  it('cuts at paragraphs, packs greedily, and joins back to the exact body', () => {
    const paras = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} `.repeat(20).trim());
    const body = paras.join('\n\n');
    const parts = splitBody(body, 1500);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(sizeOf(p)).toBeLessThanOrEqual(1500);
    expect(parts.join('\n\n')).toBe(body);
    for (const p of parts) expect(p.startsWith('\n')).toBe(false);
  });

  it('falls back to lines inside a paragraph too big for a part', () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i} `.repeat(10)).join('\n');
    const parts = splitBody(body, 2000);
    for (const p of parts) expect(sizeOf(p)).toBeLessThanOrEqual(2000);
    expect(parts.join('\n')).toBe(body);
  });

  it('hard-cuts a single enormous line without splitting a surrogate pair', () => {
    const body = '😀'.repeat(1000) + 'x'.repeat(5000);
    const parts = splitBody(body, 1000);
    for (const p of parts) {
      expect(sizeOf(p)).toBeLessThanOrEqual(1000);
      expect(/[\ud800-\udbff]$/.test(p), 'no part ends on a high surrogate').toBe(false);
      expect(/^[\udc00-\udfff]/.test(p), 'no part starts on a low surrogate').toBe(false);
    }
    expect(parts.join('')).toBe(body);
  });
});

describe('splitNote', () => {
  // ~70KB of ASCII, the e2e's "War and Peace", in paragraphs.
  const big = Array.from({ length: 700 }, (_, i) => `${i} ` + 'word '.repeat(19)).join('\n\n');
  let n = 0;
  const ids = () => `part${++n}`;

  it('does nothing to a note that fits, a recipe, or a daily log', () => {
    expect(splitNote(note('a', 'small'), [])).toBeNull();
    expect(splitNote(note('r', big, 'V', { recipe: true }), [])).toBeNull();
    expect(splitNote(note('d', big, 'V', { noteType: 'daily-log' }), [])).toBeNull();
    expect(noteSplittable(note('x', big))).toBe(true);
  });

  it('every part fits under the server limit, measured the server way, and no word is lost', () => {
    const orig = note('n1', big);
    expect(noteTooLong(orig)).toBe(true);
    const out = splitNote(orig, [], { newId: ids })!;
    const all = [out.keep, ...out.added];
    expect(all.length).toBe(2);
    for (const r of all) {
      expect(phpJsonBytes(r.payload)).toBeLessThanOrEqual(SPLIT_TARGET_BYTES);
      expect(phpJsonBytes(r.payload)).toBeLessThan(MAX_PAYLOAD_BYTES);
    }
    expect(all.map((r) => r.payload.body).join('\n\n')).toBe(big);
  });

  it('measures non-ASCII as PHP does, so a short-looking Greek note still splits enough', () => {
    const greek = Array.from({ length: 300 }, () => 'αβγδε '.repeat(10)).join('\n\n'); // ~18K chars, ~110KB to PHP
    expect(JSON.stringify(greek).length).toBeLessThan(MAX_PAYLOAD_BYTES);
    const out = splitNote(note('g', greek), [], { newId: ids })!;
    expect(out, 'it is too long by the server measure even though JS calls it small').not.toBeNull();
    for (const r of [out.keep, ...out.added]) expect(phpJsonBytes(r.payload)).toBeLessThanOrEqual(SPLIT_TARGET_BYTES);
  });

  it('keeps the original id, titles the parts (i/n), and places them right after it, before the next note', () => {
    const orig = note('n1', big + '\n\n' + big, 'V');
    const nextNote = note('n2', 'next', 'W');
    const other = note('o', 'other section', 'VV', { sectionId: 'elsewhere' });
    const out = splitNote(orig, [orig, nextNote, other] as AnyRec[], { newId: ids })!;
    expect(out.keep.id).toBe('n1');
    const n = 1 + out.added.length;
    expect(out.keep.payload.title).toBe(`War and Peace (1/${n})`);
    out.added.forEach((r, i) => {
      expect(r.payload.title).toBe(`War and Peace (${i + 2}/${n})`);
      expect(r.payload.sectionId).toBe('s');
      expect(r.payload.folderId).toBe('f');
    });
    const order = [out.keep, ...out.added, nextNote].sort(byRecOrd).map((r) => r.id);
    expect(order).toEqual(['n1', ...out.added.map((r) => r.id), 'n2']);
  });

  it('an untitled note gets bare (i/n) titles', () => {
    const out = splitNote(note('u', big, 'V', { title: '' }), [], { newId: ids })!;
    expect(out.keep.payload.title).toBe('(1/2)');
    expect(out.added[0]?.payload.title).toBe('(2/2)');
  });
});
