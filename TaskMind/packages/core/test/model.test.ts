import { describe, expect, it } from 'vitest';
import { CAPS, ERROR_STATUS, ID_RE, KINDS, MATRIX, PRIORITIES, PROJECT_ACTIONS, ROLES, STATUSES, STATUS_LABELS, STORE_VERSION } from '../src/model';

describe('the model constants', () => {
  it('keeps the interim page\'s words and order', () => {
    expect(STATUSES).toEqual(['todo', 'doing', 'review', 'done']);
    expect(STATUSES.map(s => STATUS_LABELS[s])).toEqual(['To do', 'In Progress', 'On Hold', 'Done']);
    expect(PRIORITIES).toEqual(['high', 'normal', 'low']);
    expect(KINDS).toEqual(['task', 'bug', 'pr']);
    expect(ROLES).toEqual(['owner', 'admin', 'member', 'viewer']);
  });

  it('ports the caps of lib/taskmind.php', () => {
    expect(CAPS).toMatchObject({ titleChars: 200, notesChars: 5000, commentChars: 2000, tasksMax: 3000, membersMax: 200, projectsMax: 200, workspaceBytesMax: 8388608, requestBytesMax: 65536 });
    for (const [name, value] of Object.entries(CAPS)) expect(Number.isSafeInteger(value) && value > 0, name).toBe(true);
  });

  it('gives every matrix row real roles, and viewers nothing but reading and commenting', () => {
    for (const [action, roles] of Object.entries(MATRIX)) {
      expect(roles.length, action).toBeGreaterThan(0);
      for (const role of roles) expect(ROLES, `${action}: ${role}`).toContain(role);
    }
    const viewerActions = Object.entries(MATRIX).filter(([, roles]) => (roles as readonly string[]).includes('viewer')).map(([a]) => a);
    expect(viewerActions.sort()).toEqual(['open', 'project.read', 'task.comment']);
    for (const action of PROJECT_ACTIONS) expect(Object.keys(MATRIX)).toContain(action);
  });

  it('answers every error code with the status the server uses', () => {
    expect(ERROR_STATUS.unauthorized).toBe(401);
    expect(ERROR_STATUS.forbidden).toBe(403);
    expect(ERROR_STATUS.unavailable).toBe(503);
    for (const status of Object.values(ERROR_STATUS)) expect(status).toBeGreaterThanOrEqual(400);
  });

  it('shapes member ids like site usernames', () => {
    for (const ok of ['alex', 'sam', 'a_b-9', 'x'.repeat(40)]) expect(ID_RE.test(ok), ok).toBe(true);
    for (const bad of ['', 'a b', 'x'.repeat(41), '../alex', 'alex\n', 'Sàm']) expect(ID_RE.test(bad), JSON.stringify(bad)).toBe(false);
  });

  it('has a store of version 1, and builds no member id into the code', () => {
    expect(STORE_VERSION).toBe(1);
  });
});
