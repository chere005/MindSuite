/**
 * When this page last read and wrote the shared iCloud Drive file.
 *
 * Plain bookkeeping for the wide sidebar's status line; the wording is core's
 * (`syncLine`). Nothing here decides anything.
 */
type Times = { readAt: number | null; savedAt: number | null };
let times: Times = { readAt: null, savedAt: null };
const handlers = new Set<() => void>();
const fire = () => handlers.forEach((h) => h());

export const markRead = (): void => { times = { ...times, readAt: Date.now() }; fire(); };
export const markSaved = (): void => { times = { ...times, savedAt: Date.now() }; fire(); };
export const fileTimes = (): Times => times;
export function onSyncChange(h: () => void): () => void {
  handlers.add(h);
  return () => { handlers.delete(h); };
}
