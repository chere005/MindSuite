import type { Owners } from '../../packages/core/src/planner';

/**
 * Who the add line of a to-do list is for after an Enter. A new to-do written over a blank line (aimed at one person's side, or at both)
 * is added by Enter and the keyboard moves to the add line to type the next one: that line is for the SAME people as the to-do just
 * entered, so a run of Enters keeps writing one person's list. Without it the add line would follow the top picker, which under Both
 * means both of us.
 *
 * The people are remembered only while the person keeps writing, and dropped for good (not suspended) when
 *  - the picker's selection changes, or the day, week or month shown changes (`owners` sees it: `where` and `picker` differ from the ones
 *    the people were remembered under);
 *  - Escape is pressed, a blank line is aimed at (it carries its own people), the add line or its row is left for anywhere else, or
 *    a to-do is closed by anything but Enter (`drop`).
 * An add line nobody came to by Enter follows the picker as before. Nothing here touches the DOM, the clock or browser storage.
 */
export function createCarry() {
  let held: { owners: Owners; where: string; picker: string } | null = null;
  return {
    /** Whether people are remembered now (they may still turn out to belong to another page: `owners` decides). */
    get active() { return held !== null; },
    /** Enter added a to-do for `owners` on page `where` under the picker `picker`, and the keyboard goes to the add line. */
    set(owners: Owners, where: string, picker: string) { held = { owners: [...owners], where, picker }; },
    drop() { held = null; },
    /** Who the add line is for on page `where` under `picker`: the remembered people, else `picked` (what the picker says). */
    owners(where: string, picker: string, picked: Owners): Owners {
      if (held && (held.where !== where || held.picker !== picker)) { held = null; }
      return held ? held.owners : picked;
    },
  };
}
