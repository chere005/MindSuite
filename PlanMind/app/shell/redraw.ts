/**
 * Whether the shell may draw the panel again now: `asked` is a redraw the panel itself asked for (a tab, an edit opened), which waits only for
 * a write it cannot show (`busy`) or a refusal not yet settled; any other redraw (data arriving) waits while any write is `queued`.
 * Either waits while a pointer or finger is down or a text field of the panel has the focus.
 */
export type RedrawFacts = { asked: boolean; busy: boolean; queued: boolean; settling: boolean; pointerDown: boolean; textFocused: boolean };
export const mayRedraw = (facts: RedrawFacts): boolean => !(facts.asked ? facts.busy || facts.settling : facts.queued) && !facts.pointerDown && !facts.textFocused;
