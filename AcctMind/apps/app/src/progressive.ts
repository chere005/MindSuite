/**
 * Draw a long list in slices, so the screen is usable before it is complete.
 *
 * A ledger of two thousand rows is some eighty thousand components, and mounting
 * them in one go held the screen still for most of a second (four, at ten
 * thousand) before the first row appeared — and every tap on the tab bar waited
 * for it. The rows are all still drawn: the first `first` at once, then `step`
 * more on each turn of the event loop, so a tap or a keystroke is answered
 * between slices rather than after the whole list.
 *
 * The count only ever grows while rows are missing and never shrinks (a search
 * that narrows the list and is then cleared brings every row straight back, as
 * it always did), and a list shorter than `first` is drawn whole, in the same
 * render as before.
 */
import { useEffect, useState } from 'react';

export const FIRST_ROWS = 50;
export const MORE_ROWS = 150;

/** How many of `total` rows to draw now. */
export function useProgressive(total: number, first = FIRST_ROWS, step = MORE_ROWS): number {
  const [reached, setReached] = useState(first);
  useEffect(() => {
    if (reached >= total) return undefined;
    const id = setTimeout(() => setReached((n) => n + step), 0);
    return () => clearTimeout(id);
  }, [reached, total, step]);
  return Math.min(reached, total);
}
