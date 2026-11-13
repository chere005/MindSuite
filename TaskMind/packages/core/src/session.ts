import type { CoreFunctions, Session } from './model';

/**
 * Which screen the shell shows for the answer to its first GET of api.php. Only a well-formed member session opens the app:
 * 401 means signed out, 403 means signed in but not on the team, and anything else (no reply, a host error, a body that is not
 * a session) is "offline", never an empty app, so a failed read can never look like an empty workspace.
 */
export const screenFor: CoreFunctions['screenFor'] = reply => {
  if (reply === null) return 'offline';
  if (reply.status === 401) return 'signedOut';
  if (reply.status === 403) return 'denied';
  return reply.status === 200 && isSession(reply.body) ? 'signedIn' : 'offline';
};

export function isSession(body: unknown): body is Session {
  if (body === null || typeof body !== 'object') return false;
  const s = body as Partial<Session>;
  return s.ok === true && typeof s.me === 'string' && s.me !== '' && typeof s.role === 'string' && ['owner', 'admin', 'member', 'viewer'].includes(s.role);
}

/** The initials shown in a member's avatar: the first letters of up to two words of the name, else of the username. */
export function initials(name: string, id: string): string {
  const words = (name.trim() || id).split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

/** A member's name on the page: the one they were given, else the username with a capital. */
export function displayName(name: string, id: string): string {
  const given = name.trim();
  return given !== '' ? given : id.charAt(0).toUpperCase() + id.slice(1);
}
