/**
 * Whether the shell may draw the panel again now. The panel is drawn from the state's display: the server's snapshot with the writes not yet
 * answered laid over it (core optimistic.ts), so a row that was just checked is drawn crossed out in its place among the done rows without
 * waiting for the reply. What still holds a redraw back:
 * - a write the screen cannot answer by itself is in flight (`busy`), because a form waits for its answer;
 * - a write was just refused and the code that awaited it has not run yet (`settling`), so a form shows its reason first;
 * - a pointer or finger is down (a touch's click included, until it has been delivered), a key is held on a control of the panel, or a text field of the panel has the focus, so nothing moves under the person's hand.
 * Optimistic writes in flight (`queued` with no `busy`) do not hold it back, whoever asked for the redraw: they are laid over the snapshot, and
 * the redraw they cause is their answer. (Until 0.31.0 the shell waited for the last write of a run to return, which on a slow connection showed
 * a check-off's cross-out and its move seconds late.)
 */
export type RedrawFacts = { busy: boolean; settling: boolean; pointerDown: boolean; keyDown: boolean; textFocused: boolean };
export const mayRedraw = (facts: RedrawFacts): boolean => !facts.busy && !facts.settling && !facts.pointerDown && !facts.keyDown && !facts.textFocused;
