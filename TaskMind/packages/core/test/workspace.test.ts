import { describe, expect, it } from 'vitest';
import { applyDelta, canMap, type Project, type Task, type WorkspaceLive, type WorkspaceState } from '../src/taskmind';

const project = (id: string, order: number): Project => ({
  id, order, name: id, color: '#7d8590', repo: '', private: false, blurb: '', about: '', health: 'on_track',
  owner: 'alex', archived: false, created: 0, facts: {}, visibility: 'team', members: [], lead: '', goal: '',
  start: '', due: '', sections: [], updates: [], rv: 1, can: { write: false, comment: true, settings: false, delete: false },
});
const task = (n: number, project: string): Task => ({
  id: String(n), n, project, parent: '', title: '', notes: '', status: 'todo', assignee: '', priority: 'normal',
  kind: 'task', due: '', labels: [], order: n, by: 'alex', created: 0, updated: 0, done_at: 0, source: {}, comments: [],
  start: '', depends: [], estimate: 0, section: '', repeat: null, followers: [], origin: {}, rv: 1,
});
const live: WorkspaceLive = { can: canMap('viewer'), team: { name: 'Team', rv: 1 }, members: [], activity: [], events: [] };
const state: WorkspaceState = {
  ...live, me: 'val', rev: 1, projects: [project('a', 1), project('b', 2)], tasks: [task(1, 'a'), task(2, 'b'), task(3, 'b')],
};

describe('workspace deltas', () => {
  it('merges changed rows and removes a deleted project, its tasks and explicit task deletions', () => {
    const next = applyDelta(state, {
      ...live, me: 'val', since: 1, rev: 2, changed: true, full: false,
      deleted: { projects: ['a'], tasks: ['3'] },
      projects: [project('c', 0)], tasks: [{ ...task(2, 'b'), title: 'Updated' }, task(4, 'c')],
    });
    expect(next.projects.map(row => row.id)).toEqual(['c', 'b']);
    expect(next.tasks.map(row => [row.id, row.title])).toEqual([['2', 'Updated'], ['4', '']]);
    expect(state.tasks.map(row => row.id)).toEqual(['1', '2', '3']);
  });

  it('replaces the whole snapshot on a visibility change', () => {
    const filtered: WorkspaceState = { ...state, rev: 2, projects: [], tasks: [] };
    expect(applyDelta(state, { me: 'val', since: 1, rev: 2, changed: true, full: true, state: filtered })).toBe(filtered);
  });

  it('keeps an unchanged workspace and refuses deltas from a different identity or base revision', () => {
    expect(applyDelta(state, { me: 'val', since: 1, rev: 1, changed: false })).toBe(state);
    expect(() => applyDelta(state, { me: 'max', since: 1, rev: 1, changed: false })).toThrow();
    expect(() => applyDelta(state, { me: 'val', since: 2, rev: 2, changed: false })).toThrow();
  });
});
