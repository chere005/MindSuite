import { describe, expect, it } from 'vitest';
import { can, canMap, roleCan, roleOf, sees } from '../src/access';
import type { Member } from '../src/model';

const member = (id: string, role: Member['role']): Member => ({ id, role, name: '', added: 0, by: '' });
const team = [member('alex', 'owner'), member('sam', 'admin'), member('max', 'member'), member('val', 'viewer'), member('eve', 'member')];
const open = { visibility: 'team' as const, owner: 'eve', members: [] };
const secret = { visibility: 'private' as const, owner: 'eve', members: ['max'] };

describe('the matrix by role', () => {
  it('answers a person who is not on the team with no, for everything', () => {
    expect(roleOf(team, 'outsider')).toBe('');
    for (const action of Object.keys(canMap('owner'))) expect(can(team, 'outsider', action as never, { project: open }), action).toBe(false);
  });

  it('lets a viewer open, read and comment, and nothing else', () => {
    expect(canMap('viewer')).toMatchObject({ open: true, 'project.read': true, 'task.comment': true, 'task.write': false, 'project.create': false, 'member.add': false });
    expect(can(team, 'val', 'task.write', { project: open })).toBe(false);
    expect(can(team, 'val', 'task.comment', { project: open })).toBe(true);
  });

  it('reserves deleting a project and moving ownership for the owner', () => {
    expect(can(team, 'alex', 'project.delete', { project: open })).toBe(true);
    expect(can(team, 'sam', 'project.delete', { project: open })).toBe(false);
    expect(roleCan('admin', 'ownership.transfer')).toBe(false);
    expect(roleCan('owner', 'ownership.transfer')).toBe(true);
  });

  it('lets a plain member change project settings only on a project they own', () => {
    expect(can(team, 'eve', 'project.update', { project: open })).toBe(true);
    expect(can(team, 'max', 'project.update', { project: open })).toBe(false);
    expect(can(team, 'sam', 'project.update', { project: open })).toBe(true);
  });

  it('lets only an owner make or touch an owner', () => {
    expect(can(team, 'sam', 'member.add', { role: 'owner' })).toBe(false);
    expect(can(team, 'alex', 'member.add', { role: 'owner' })).toBe(true);
    expect(can(team, 'sam', 'member.add', { role: 'member' })).toBe(true);
    expect(can(team, 'sam', 'member.role', { target: 'alex', role: 'member' })).toBe(false);
    expect(can(team, 'sam', 'member.role', { target: 'max', role: 'owner' })).toBe(false);
    expect(can(team, 'sam', 'member.role', { target: 'max', role: 'admin' })).toBe(true);
    expect(can(team, 'sam', 'member.remove', { target: 'alex' })).toBe(false);
    expect(can(team, 'alex', 'member.remove', { target: 'sam' })).toBe(true);
  });

  it('refuses a project action with no project to look at', () => {
    expect(can(team, 'alex', 'task.write')).toBe(false);
  });
});

describe('private projects', () => {
  it('are seen by owners, admins, the project owner and its members, and nobody else', () => {
    expect(sees('owner', 'alex', secret)).toBe(true);
    expect(sees('admin', 'sam', secret)).toBe(true);
    expect(sees('member', 'eve', secret)).toBe(true);
    expect(sees('member', 'max', secret)).toBe(true);
    expect(sees('viewer', 'val', secret)).toBe(false);
    expect(sees('member', 'zed', secret)).toBe(false);
    expect(sees('', 'alex', secret)).toBe(false);
  });

  it('keep a hidden project\'s actions closed even to a role the matrix allows', () => {
    expect(can(team, 'val', 'task.comment', { project: secret })).toBe(false);
    expect(can(team, 'max', 'task.write', { project: secret })).toBe(true);
    expect(sees('viewer', 'val', open)).toBe(true);
  });
});
