/**
 * Unsaved typing that has to outlive a screen remount. Crossing 900 px swaps
 * the phone frame for the wide one (or back), which mounts the screens again;
 * a half-typed inline retype in Reminders would otherwise be thrown away.
 * App clears it whenever the section changes, so it never outlives the visit.
 */
export const inlineCarry: { id: string | null; text: string } = { id: null, text: '' };
