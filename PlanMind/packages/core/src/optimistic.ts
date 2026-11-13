import type { ChoreMark, Mutation, ScheduleEvent, Snapshot, Task } from './model';

/**
 * What the screen shows for a write that has not been answered yet. The server decides every write, so this only repeats the part of its
 * answer the person can already see (a box ticked, an entry moved, a chore marked); the reply replaces it. Each prediction sets its fields
 * absolutely, and the record's revision to the one the write will give it (the revision the write was built from, plus one), so laying the same
 * write over a snapshot that already holds it changes nothing. A record that is already past the write's revision (someone else's newer change)
 * is left alone: the write will be refused as stale, and the screen then shows what is true.
 */
type Data = Pick<Snapshot, 'tasks' | 'events' | 'choreMarks'>;

/** Whether a mutation has a prediction at all (the writes the app lets the screen answer at once). */
export const predictable = (mutation: Mutation): boolean =>
  mutation.action === 'complete' || mutation.action === 'markChore' || (mutation.action === 'edit' && mutation.kind === 'event');

/**
 * The records a mutation changes, as keys: two writes that share one are about the same record (the later one was built on the earlier,
 * so it cannot stand when the earlier is refused). Writes that touch no predicted record have none.
 */
export function mutationKeys(mutation: Mutation): string[] {
  if (mutation.action === 'complete') { return [`task:${mutation.id}`]; }
  if (mutation.action === 'markChore') { return [`mark:${mutation.ruleId}:${mutation.date}`]; }
  if (mutation.action === 'edit' && mutation.kind === 'event') { return [`event:${mutation.id}`]; }
  if (mutation.action === 'editEvents') { return mutation.edits.map(edit => `event:${edit.id}`); }
  return [];
}

/** `data` with the mutation laid over it, or `data` itself when nothing shows (no prediction, a record gone or already past it). `actor` stamps a mark that did not exist. */
export function predict<T extends Data>(data: T, mutation: Mutation, actor: ChoreMark['updatedBy']): T {
  if (mutation.action === 'complete') {
    const at = data.tasks.findIndex(task => task.id === mutation.id);
    const task = data.tasks[at];
    if (!task || task.revision > mutation.revision + 1 || task.done === mutation.done) { return data; }
    const next: Task = { ...task, done: mutation.done, revision: mutation.revision + 1 };
    delete next.doneOn;
    if (mutation.doneOn !== undefined) { next.doneOn = mutation.doneOn; }
    return { ...data, tasks: data.tasks.map((t, i) => (i === at ? next : t)) };
  }
  if (mutation.action === 'edit' && mutation.kind === 'event') {
    const at = data.events.findIndex(event => event.id === mutation.id);
    const event = data.events[at];
    if (!event || event.revision > mutation.revision + 1) { return data; }
    const next: ScheduleEvent = { ...event, date: mutation.date, owners: mutation.owners, text: mutation.text, start: mutation.start, length: mutation.length, revision: mutation.revision + 1 };
    return { ...data, events: data.events.map((e, i) => (i === at ? next : e)) };
  }
  if (mutation.action === 'markChore') {
    const id = `${mutation.ruleId}:${mutation.date}`;
    const at = data.choreMarks.findIndex(mark => mark.id === id);
    const mark = data.choreMarks[at];
    if (mark && mark.revision > mutation.revision + 1) { return data; }
    // An open, unmoved turn without an override of its own has no mark.
    if (mutation.state === 'open' && !mutation.moved && !mutation.owners) {
      return mark ? { ...data, choreMarks: data.choreMarks.filter(m => m !== mark) } : data;
    }
    const next: ChoreMark = {
      id, ruleId: mutation.ruleId, date: mutation.date, state: mutation.state, moved: mutation.moved, ...(mutation.owners ? { owners: mutation.owners } : {}),
      revision: mutation.revision + 1, updatedBy: mark?.updatedBy ?? actor, updatedAt: mark?.updatedAt ?? '',
    };
    return { ...data, choreMarks: mark ? data.choreMarks.map(m => (m === mark ? next : m)) : [...data.choreMarks, next] };
  }
  return data;
}
