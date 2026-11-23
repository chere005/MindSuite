/**
 * Draw a long list in slices, so the screen is usable before it is complete.
 *
 * A ledger of two thousand rows is some eighty thousand components, and mounting
 * them in one go held the screen still for most of a second (four, at ten
 * thousand) before the first row appeared — and every tap on the tab bar waited
 * for it. The rows are all still drawn: the first `first` at once, then a
 * slice more on each turn of the event loop (see `nextReached`), so a tap or a
 * keystroke is answered between slices rather than after the whole list.
 *
 * The count only ever grows while rows are missing and never shrinks (a search
 * that narrows the list and is then cleared brings every row straight back, as
 * it always did), and a list shorter than `first` is drawn whole, in the same
 * render as before.
 */
import { useEffect, useState } from 'react';

export const FIRST_ROWS = 50;
export const MORE_ROWS = 150;
/** The largest slice: a turn of the event loop never mounts more rows than this. */
export const MAX_ROWS = 500;

/**
 * Rows drawn after a slice that brought the list to `reached` rows.
 *
 * A fixed step of 150 made ten thousand rows take ten seconds to draw (three
 * and a half in one block): every slice costs a layout pass that also walks
 * what is already drawn, and there were sixty-six of them. The step grows with
 * the list, up to MAX_ROWS, so the slices stay short and there are far fewer.
 */
export function nextReached(reached: number, step = MORE_ROWS): number {
  return reached + Math.min(MAX_ROWS, Math.max(step, Math.floor(reached / 3)));
}

/** How many of `total` rows to draw now. */
export function useProgressive(total: number, first = FIRST_ROWS, step = MORE_ROWS): number {
  const [reached, setReached] = useState(first);
  useEffect(() => {
    if (reached >= total) return undefined;
    const id = setTimeout(() => setReached((n) => nextReached(n, step)), 0);
    return () => clearTimeout(id);
  }, [reached, total, step]);
  return Math.min(reached, total);
}

/** What a list drew for one section the last time it committed. */
export type DrawnSection = { limit: number; count: number };

/**
 * How many rows of each section to draw, given how many rows the whole list may
 * draw now (`drawn`, from `useProgressive`) and what each section drew when the
 * list last committed (`prev`, by section id).
 *
 * A row that is on screen stays on screen: a section never draws fewer rows than
 * it already did (unless it has fewer, or is folded), so growing the budget, an
 * unfold, a sync or an insert tears down nothing and remounts nothing. A section
 * that had drawn ALL its rows keeps drawing all of them when a few more arrive
 * (up to MAX_ROWS at once: a bigger arrival is sliced like a first mount). Only
 * the budget beyond what is already drawn is handed out, in section order.
 */
export function sectionLimits(
  sections: readonly { id: string; count: number; shut: boolean }[],
  prev: ReadonlyMap<string, DrawnSection>,
  drawn: number,
): number[] {
  const base = sections.map(({ id, count, shut }) => {
    const was = prev.get(id);
    if (shut || was === undefined) return 0;
    if (was.limit >= was.count && count - was.count <= MAX_ROWS) return count;
    return Math.min(was.limit, count);
  });
  let spare = Math.max(0, drawn - base.reduce((a, b) => a + b, 0));
  return sections.map(({ count, shut }, at) => {
    const have = base[at] ?? 0;
    if (shut) return 0;
    const more = Math.min(spare, count - have);
    spare -= more;
    return have + more;
  });
}
