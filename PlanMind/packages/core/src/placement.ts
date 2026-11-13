import { itemColor } from './colors';
import { CAPS, type CoreFunctions, type EventCell, type Lane, type NoteField, type Owners, type PriorityCell, type Scope, type Task, type TodoRow } from './model';

/** Lane indexes, ascending, of the lanes that show any of the owners. */
export const ownerLanes = (owners: Owners, lanes: readonly Lane[]): number[] =>
  owners.flatMap(id => lanes.findIndex(l => l.listId === id)).filter(i => i >= 0).sort((a, b) => a - b);
/** An item is visible when any of its owners is a lane. */
export const inLanes = (owners: Owners, lanes: readonly Lane[]): boolean => owners.some(id => lanes.some(l => l.listId === id));

/** `${scope}:${period}:${listId}:${field}`, the same key the server stores a note under. */
export const noteKey = (scope: Scope, period: string, listId: string, field: NoteField): string => `${scope}:${period}:${listId}:${field}`;

/** A linked item spans only when both its owner lanes are on screen side by side (Both is the only view that does that). */
const spans = (lane: number[]): boolean => lane.length === 2 && lane[1] === lane[0] + 1;

/** The day a done day to-do was ticked on when that is later than its own: its own day shows it unchecked, pointing there. */
const wentOn = (task: Task): string | undefined => (task.scope === 'day' && task.done && task.doneOn !== undefined && task.doneOn > task.date ? task.doneOn : undefined);
/** A row that is a checked, crossed-out one: done, and not the unchecked pointer of a to-do ticked on another day. */
export const rowDone = (row: TodoRow): boolean => row.item.done && row.wentTo === undefined;
/** Open rows, then the pointers to another day (the to-do is done: they never push a real open one behind "+N more"), then the done rows. */
const rank = (row: TodoRow): number => (rowDone(row) ? 2 : row.wentTo === undefined ? 0 : 1);

export const visibleTodos: CoreFunctions['visibleTodos'] = (tasks, scope, date, lanes, lists, settings) =>
  tasks
    .filter(t => t.scope === scope && t.date === date && inLanes(t.owners, lanes))
    .map((item): TodoRow => ({ item, color: itemColor(item.owners, lists, settings), linked: item.owners.length > 1, ...(wentOn(item) ? { wentTo: wentOn(item) } : {}) }))
    .sort((a, b) => rank(a) - rank(b) || a.item.pos - b.item.pos || (a.item.id < b.item.id ? -1 : 1));

/** An open day to-do dated before `today` stands on today's own Day view as well (the owner, 2026-10-31); `date` is the day being viewed. */
export const isCarried = (task: Task, date: string, today: string | undefined): boolean =>
  today === date && task.scope === 'day' && !task.done && task.date < date;

/** Oldest day first, each day in its own order, so the longest-waiting to-do is on the top line. */
export const carriedTodos: CoreFunctions['carriedTodos'] = (tasks, date, today, lanes, lists, settings) =>
  tasks
    .filter(t => isCarried(t, date, today) && inLanes(t.owners, lanes))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || a.pos - b.pos || (a.id < b.id ? -1 : 1))
    .map(item => ({ item, color: itemColor(item.owners, lists, settings), linked: item.owners.length > 1, carried: true as const }));

/** A carried row ticked on `date` sits in that day's done pile (the owner, 2026-11-02): oldest day first, like the open carried rows, each day in its own order. */
export const accomplishedTodos: CoreFunctions['accomplishedTodos'] = (tasks, date, lanes, lists, settings) =>
  tasks
    .filter(t => t.scope === 'day' && t.done && t.doneOn === date && t.date < date && inLanes(t.owners, lanes))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || a.pos - b.pos || (a.id < b.id ? -1 : 1))
    .map(item => ({ item, color: itemColor(item.owners, lists, settings), linked: item.owners.length > 1, carried: true as const }));

export const priorityCells: CoreFunctions['priorityCells'] = (items, date, lanes, lists, settings) => {
  const cells: PriorityCell[] = [];
  for (const item of items) {
    if (item.date !== date) continue;
    const color = itemColor(item.owners, lists, settings), linked = item.owners.length > 1;
    const shown = ownerLanes(item.owners, lanes);
    const lines = item.owners.map(owner => item.slots[owner]);
    if (spans(shown) && Number.isInteger(lines[0]) && lines.every(line => line === lines[0])) {
      cells.push({ item, lane: shown[0], span: 2, line: lines[0], color, linked });
      continue;
    }
    item.owners.forEach((owner, i) => {
      const lane = lanes.findIndex(l => l.listId === owner);
      if (lane >= 0 && Number.isInteger(lines[i])) cells.push({ item, lane, span: 1, line: lines[i], color, linked });
    });
  }
  return cells.sort((a, b) => a.line - b.line || a.lane - b.lane);
};

export const eventCells: CoreFunctions['eventCells'] = (items, date, lanes, lists, settings) => {
  const cells: EventCell[] = [];
  for (const item of items) {
    if (item.date !== date) continue;
    const color = itemColor(item.owners, lists, settings), linked = item.owners.length > 1;
    const shown = ownerLanes(item.owners, lanes);
    const base = { item, start: item.start, end: item.start + item.length, color, linked };
    if (spans(shown)) cells.push({ ...base, lane: shown[0], span: 2 });
    else for (const lane of shown) cells.push({ ...base, lane, span: 1 });
  }
  return cells.sort((a, b) => a.start - b.start || a.lane - b.lane);
};

export const noteLanes: CoreFunctions['noteLanes'] = (notes, scope, period, field, lanes) =>
  lanes.map(lane => {
    const key = noteKey(scope, period, lane.listId, field);
    const note = notes.find(n => n.key === key) ?? null;
    return { lane, key, note, revision: note?.revision ?? 0 };
  });
