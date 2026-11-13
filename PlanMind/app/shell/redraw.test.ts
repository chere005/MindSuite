import { describe, it, expect } from 'vitest';
import { mayRedraw, type RedrawFacts } from './redraw';

const calm: RedrawFacts = { asked: false, busy: false, queued: false, settling: false, pointerDown: false, textFocused: false };

describe('the shell redraw decision', () => {
  it('draws when nothing holds it', () => { expect(mayRedraw(calm)).toBe(true); });
  it('draws while only optimistic writes are in flight: a check-off shows before its reply', () => {
    expect(mayRedraw({ ...calm, queued: true })).toBe(true);
  });
  it('draws a redraw the panel asked for while optimistic writes are in flight too', () => {
    expect(mayRedraw({ ...calm, asked: true, queued: true })).toBe(true);
  });
  it.each(['busy', 'settling', 'pointerDown', 'textFocused'] as const)('holds while %s, even with optimistic writes queued', key => {
    expect(mayRedraw({ ...calm, queued: true, [key]: true })).toBe(false);
    expect(mayRedraw({ ...calm, asked: true, queued: true, [key]: true })).toBe(false);
  });
});
