import type { WorkspaceDelta, WorkspaceState } from './model';

function merge<T extends { id: string }>(before: readonly T[], changes: readonly T[], deleted: readonly string[]): T[] {
  const rows = new Map(before.map(row => [row.id, row]));
  for (const id of deleted) rows.delete(id);
  for (const row of changes) rows.set(row.id, row);
  return [...rows.values()];
}

/** Apply a delta only to the identity and revision that requested it. Discard and refetch if either differs. */
export function applyDelta(state: WorkspaceState, delta: WorkspaceDelta): WorkspaceState {
  if (state.rev !== delta.since || state.me !== delta.me) throw new Error('Workspace delta does not match the open workspace.');
  if (!delta.changed) return state;
  if (delta.full) return delta.state;
  const projects = merge(state.projects, delta.projects, delta.deleted.projects)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const visible = new Set(projects.map(project => project.id));
  const tasks = merge(state.tasks, delta.tasks, delta.deleted.tasks)
    .filter(task => visible.has(task.project)).sort((a, b) => a.n - b.n);
  return {
    rev: delta.rev, me: state.me, projects, tasks, can: delta.can, team: delta.team,
    members: delta.members, activity: delta.activity, events: delta.events,
  };
}
