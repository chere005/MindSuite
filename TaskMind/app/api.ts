import {
  ERROR_STATUS, RELEASE_HEADER, type ApiError, type Reply, type WorkspaceMutation,
  type WorkspaceRead, type WorkspaceState, type WorkspaceWrite,
} from '../packages/core/src/taskmind';
import { STAMP } from './release';

/** How long a request may take before it is called failed. A deploy makes the host answer slowly (tens of seconds). */
export const REQUEST_TIMEOUT_MS = 45000;

type Deps = {
  /** Every response that was read says which release answered (X-TaskMind-Release), or null when it carried no stamp. */
  release?: (stamp: string | null) => void;
};
type Result<T> = { ok: true; body: T } | { ok: false; status: number; body: ApiError | null } | null;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLive(value: Record<string, unknown>): boolean {
  return isObject(value.can) && isObject(value.team) && Array.isArray(value.members)
    && Array.isArray(value.activity) && Array.isArray(value.events);
}

function isState(value: unknown): value is WorkspaceState {
  return isObject(value) && typeof value.me === 'string' && Number.isSafeInteger(value.rev)
    && Array.isArray(value.projects) && Array.isArray(value.tasks) && isLive(value);
}

function isRead(value: unknown): value is WorkspaceRead {
  if (!isObject(value) || value.ok !== true) return false;
  if ('state' in value) return isState(value.state);
  const { delta } = value;
  if (!isObject(delta) || typeof delta.me !== 'string' || !Number.isSafeInteger(delta.rev)
    || !Number.isSafeInteger(delta.since)) return false;
  if (delta.changed === false) return delta.rev === delta.since;
  if (delta.changed !== true) return false;
  if (delta.full === true) return isState(delta.state) && delta.state.me === delta.me && delta.state.rev === delta.rev;
  return delta.full === false && Array.isArray(delta.projects) && Array.isArray(delta.tasks) && isLive(delta)
    && isObject(delta.deleted) && Array.isArray(delta.deleted.projects) && Array.isArray(delta.deleted.tasks);
}

function isWrite(value: unknown): value is WorkspaceWrite {
  return isObject(value) && value.ok === true && typeof value.id === 'string' && (value.closed === true || isRead(value));
}

function workspaceResult<T>(reply: Reply, valid: (body: unknown) => body is T): Result<T> {
  if (reply === null) return null;
  const { status, body } = reply;
  if (status === 200 && valid(body)) return { ok: true, body };
  const error = isObject(body) && typeof body.error === 'string' && typeof body.code === 'string' && Object.hasOwn(ERROR_STATUS, body.code);
  return { ok: false, status, body: error ? body as ApiError : null };
}

/** The one place that talks to the API. Nothing private is cached, and writes are sent once. */
export function createApi({ release }: Deps = {}) {
  async function request(query = '', init: RequestInit = { method: 'GET' }): Promise<Reply> {
    let response: Response;
    try {
      response = await fetch('./api.php' + query, {
        ...init, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    const stamp = response.headers.get(RELEASE_HEADER);
    release?.(stamp !== null && STAMP.test(stamp) ? stamp : null);
    let body: unknown;
    try { body = await response.json(); }
    catch { body = null; }
    return { status: response.status, body };
  }

  return {
    /** GET the signed-in member's session. */
    session: () => request(),
    /** Read an authorized snapshot, or changes from the caller's current revision. */
    async workspace(since?: number): Promise<Result<WorkspaceRead>> {
      const query = new URLSearchParams({ view: 'workspace' });
      if (since !== undefined) query.set('since', String(since));
      return workspaceResult(await request('?' + query), isRead);
    },
    /** A null answer leaves the write unconfirmed. Reconcile against the server before deciding what to do. */
    async change(csrf: string, mutation: WorkspaceMutation): Promise<Result<WorkspaceWrite>> {
      return workspaceResult(await request('', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(mutation),
      }), isWrite);
    },
  };
}
export type Api = ReturnType<typeof createApi>;
