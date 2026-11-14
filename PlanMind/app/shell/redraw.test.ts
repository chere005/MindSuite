import { describe, it, expect } from 'vitest';
import { mayRedraw, type RedrawFacts } from './redraw';

const calm: RedrawFacts = { busy: false, settling: false, pointerDown: false, keyDown: false, textFocused: false };

describe('the shell redraw decision', () => {
  it('draws when nothing holds it', () => { expect(mayRedraw(calm)).toBe(true); });
  // Optimistic writes in flight are not a fact of the decision at all: they hold nothing, so a check-off shows before its reply.
  it.each(['busy', 'settling', 'pointerDown', 'keyDown', 'textFocused'] as const)('holds while %s', key => {
    expect(mayRedraw({ ...calm, [key]: true })).toBe(false);
  });
  it('holds while several things hold, and draws once every one is let go', () => {
    expect(mayRedraw({ ...calm, pointerDown: true, keyDown: true })).toBe(false);
    expect(mayRedraw({ ...calm })).toBe(true);
  });
});
