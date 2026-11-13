import { CAPS, type CoreFunctions, type ListId, type Priority } from './model';

const LINES = Array.from({ length: CAPS.prioritySlots }, (_, i) => i + 1);

/** The record's line in one list, or null when it has none (stored data always has one for each owner). */
const lineIn = (item: Priority, listId: ListId): number | null => {
  const line = item.slots[listId];
  return Number.isInteger(line) && line >= 1 && line <= CAPS.prioritySlots ? line : null;
};
const onDay = (items: readonly Priority[], date: string, listId: ListId) => items.filter(p => p.date === date && p.owners.includes(listId));

export const suggestSlots: CoreFunctions['suggestSlots'] = (items, date, owners) => {
  if (owners.length === 0) return null;
  const taken = owners.map(owner => new Set(onDay(items, date, owner).map(p => lineIn(p, owner))));
  const shared = LINES.find(line => taken.every(used => !used.has(line)));
  if (shared !== undefined) return Object.fromEntries(owners.map(owner => [owner, shared]));
  const own = taken.map(used => LINES.find(line => !used.has(line)));
  if (own.includes(undefined)) return null;
  return Object.fromEntries(owners.map((owner, i) => [owner, own[i]!]));
};

export const pickSlots: CoreFunctions['pickSlots'] = (items, date, owners, selfId, prefer) => {
  const others = items.filter(p => p.id !== selfId);
  const free = (owner: ListId, line: number) => !others.some(p => p.date === date && p.slots[owner] === line);
  if (owners.every(owner => free(owner, prefer))) return Object.fromEntries(owners.map(owner => [owner, prefer]));
  return suggestSlots(others, date, [...owners]);
};

/**
 * Array move over the list's five lines, empty lines included: take the record out of its line and insert it
 * at the target, so the lines between shift by one and an empty line absorbs the gap. Only records whose
 * line changes are returned, ordered by new line. Unknown id or a target outside 1..5 returns no moves.
 */
export const arrangePriorities: CoreFunctions['arrangePriorities'] = (items, date, listId, id, toLine) => {
  if (!Number.isInteger(toLine) || toLine < 1 || toLine > CAPS.prioritySlots) return [];
  const lines: (Priority | null)[] = LINES.map(() => null);
  for (const item of onDay(items, date, listId)) {
    const line = lineIn(item, listId);
    if (line !== null && !lines[line - 1]) lines[line - 1] = item;
  }
  const from = lines.findIndex(p => p?.id === id);
  if (from < 0) return [];
  lines.splice(toLine - 1, 0, ...lines.splice(from, 1));
  return lines.flatMap((p, i) => (p && lineIn(p, listId) !== i + 1 ? [{ id: p.id, revision: p.revision, slot: i + 1 }] : []));
};
