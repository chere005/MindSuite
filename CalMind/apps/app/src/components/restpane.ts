/**
 * The wide Calendar's resting right pane: the screen hands WideShell the node
 * for the selected day, and WideShell draws it while no item is open. A
 * one-slot store rather than context, because the producer (the Calendar
 * screen) sits inside the shell's main pane and the consumer is its sibling.
 */
import type { ReactNode } from 'react';
import { useSyncExternalStore } from 'react';

let node: ReactNode = null;
const subs = new Set<() => void>();

export function setRestingPane(next: ReactNode) {
  if (next === node) return;
  node = next;
  subs.forEach((f) => f());
}

export function useRestingPane(): ReactNode {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => node);
}
