import { MATRIX, PROJECT_ACTIONS, type AccessContext, type CoreFunctions, type Member, type Role } from './model';

/** The role of `user` in the team, or '' when they are not on it. */
export function roleOf(members: readonly Member[], user: string): Role | '' {
  return members.find(m => m.id === user)?.role ?? '';
}

export const roleCan: CoreFunctions['roleCan'] = (role, action) =>
  role !== '' && Object.hasOwn(MATRIX, action) && (MATRIX[action] as readonly Role[]).includes(role);

/** Owners and admins see every project; a team project every member; a private one its owner and the people on it. */
export const sees: CoreFunctions['sees'] = (role, user, project) => {
  if (role === '') return false;
  if (role === 'owner' || role === 'admin' || project.visibility !== 'private') return true;
  return project.owner === user || project.members.includes(user);
};

/**
 * May `user` do `action`? The matrix row first, then what the action touches: a project row needs a project the user can
 * see (a missing one and a hidden one look the same), a plain member updates only a project they own, an owner is made and
 * touched only by an owner. Not on the team or an unknown action: no. The server asks the same question and is the authority.
 */
export const can: CoreFunctions['can'] = (members, user, action, ctx: AccessContext = {}) => {
  const role = roleOf(members, user);
  if (!roleCan(role, action)) return false;
  const project = ctx.project;
  if (project !== undefined) {
    if (!sees(role, user, project)) return false;
  } else if (PROJECT_ACTIONS.includes(action)) {
    return false;
  }
  const targetRole = ctx.target === undefined ? '' : roleOf(members, ctx.target);
  switch (action) {
    case 'project.update': return role !== 'member' || project?.owner === user;
    case 'member.add': return (ctx.role ?? 'member') !== 'owner' || role === 'owner';
    case 'member.role': return role === 'owner' || (targetRole !== 'owner' && ctx.role !== 'owner');
    case 'member.remove': return role === 'owner' || targetRole !== 'owner';
    default: return true;
  }
};

/** What a role can do whatever the project: the answers the page uses to show and hide controls. */
export function canMap(role: Role | ''): Record<keyof typeof MATRIX, boolean> {
  return Object.fromEntries(Object.keys(MATRIX).map(action => [action, roleCan(role, action as keyof typeof MATRIX)])) as Record<keyof typeof MATRIX, boolean>;
}
