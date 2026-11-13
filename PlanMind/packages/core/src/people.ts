import { PERSON_ROLES, type People, type PersonId, type PersonRole } from './model';

/**
 * The household's two accounts, by role. Code speaks in roles (owner, partner, both); which account holds each role comes only
 * from the server's private config, sent with the session (`Session.people`) and set here once when the app loads (app/main.ts).
 * Tests set the people their fixtures are written for. Until it is set, every helper here throws: nothing guesses an account.
 * Stored records keep the account ids (owners, createdBy, note keys); these helpers only say which id is which person.
 */
let current: People | null = null;

/** A login name as the site stores it: lowercase, short, and never a view name or a role word (those would confuse ids with roles). */
const ACCOUNT = /^[a-z][a-z0-9_-]{0,31}$/;
const NOT_AN_ACCOUNT = new Set(['both', 'all', 'owner', 'partner']);

/** The two accounts when `value` names them correctly (two distinct well-formed ids under `owner` and `partner`), else null. */
export function parsePeople(value: unknown): People | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { owner, partner } = value as Record<string, unknown>;
  const ok = (id: unknown): id is PersonId => typeof id === 'string' && ACCOUNT.test(id) && !NOT_AN_ACCOUNT.has(id);
  return ok(owner) && ok(partner) && owner !== partner ? { owner, partner } : null;
}

/** Sets the two accounts (from the session). Throws, setting nothing, when `value` does not name them correctly. */
export function setPeople(value: unknown): People {
  const people = parsePeople(value);
  if (!people) throw new Error('The planner does not know its two people.');
  return (current = people);
}

/** The two accounts. Throws until setPeople has run. */
export function people(): People {
  if (!current) throw new Error('The planner does not know its two people yet.');
  return current;
}

/** The two people's list ids in list order (PERSON_ROLES: the partner's, then the owner's). */
export const personLists = (): PersonId[] => PERSON_ROLES.map(role => people()[role]);

/** The owners of a linked item, which is ONE record of both people: their two ids, sorted (the canonical form). */
export const bothOwners = (): PersonId[] => [...personLists()].sort();

/** Whether `id` is one of the two people. */
export const isPerson = (id: unknown): id is PersonId => typeof id === 'string' && personLists().includes(id);

/** The role of an account, or null for anything else (a custom list, a view name). */
export const roleOf = (id: string): PersonRole | null => (id === people().owner ? 'owner' : id === people().partner ? 'partner' : null);

/** The other one of the two people. */
export const otherPerson = (me: PersonId): PersonId => (me === people().partner ? people().owner : people().partner);
