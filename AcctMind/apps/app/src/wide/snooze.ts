/**
 * The wide Budget's Snooze column writes through this.
 *
 * App.tsx provides it around WideApp with the SAME write the phone's snooze
 * box makes: core's `putSnooze` for the month on screen, then `commit`
 * (which is a no-op on a read-only ledger). Null means nobody above can
 * write, and the column draws a plain ✓ or nothing, no box.
 */
import { createContext } from 'react';

export type SnoozeLine = (lineId: string, next: boolean) => void;

export const SnoozeLineContext = createContext<SnoozeLine | null>(null);
