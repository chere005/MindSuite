import type { ApiError, ApiErrorCode, CalmindReply, CapName, Mutation, Session, SetBothColorReply, SetBothColorRequest, ColorKey, SetCalmindReply, SetCalmindRequest, SetThemeReply, SetThemeRequest, Snapshot, SnapshotUnchanged } from '../packages/core/src/planner';
import { RELEASE_HEADER } from './release';

/** Everything GET can answer: the first load is a Session, a poll a Snapshot, or "unchanged" for ?since=. */
export type Loaded = Session | Snapshot | SnapshotUnchanged;

/** What a failed request carries. `code` is the server's ApiErrorCode, or null when no reply was read. */
export class ApiFailure extends Error {
  constructor(message: string, readonly status: number, readonly code: ApiErrorCode | null, readonly cap?: CapName, readonly uncertain = false) { super(message); }
}

/** Used only when the server sent no text of its own. */
const FALLBACK: Partial<Record<ApiErrorCode, string>> = {
  unauthorized: 'Sign in to open PlanMind.', forbidden: 'This planner is private to the two people who share it.', csrf: 'Your session changed. Reload before saving.',
  payload_too_large: 'That is too much to send at once.', unsupported_media: 'The request could not be sent.', method_not_allowed: 'The request could not be sent.',
  rate_limited: 'Too many attempts. Try again in a moment.', store_full: 'The planner is full.',
  unavailable: 'Your list could not be loaded or saved. Your last saved data is preserved.',
};
const BY_STATUS: Record<number, ApiErrorCode> = { 400: 'invalid', 401: 'unauthorized', 403: 'forbidden', 405: 'method_not_allowed', 409: 'stale', 413: 'payload_too_large', 415: 'unsupported_media', 429: 'rate_limited' };

/** How long a request may take before it is called failed. A deploy makes the host answer slowly (tens of seconds), and a write cut off early has an unknown outcome. */
export const REQUEST_TIMEOUT_MS = 45000;

type Deps = {
  /** The CSRF token of the current session, read at send time. */
  csrf: () => string;
  /** A 401 or 403 (including a CSRF rejection) needs a new session: the view must close at once. */
  signedOut: () => void;
  /** Every response that was read says which release answered (X-PlanMind-Release), or null when it carried no stamp. */
  release?: (stamp: string | null) => void;
};

/** The one place that talks to ./api.php. Never touches the DOM or any browser storage. */
export function createApi({ csrf, signedOut, release }: Deps) {
  async function call(mutation?: Mutation | SetThemeRequest | SetCalmindRequest | SetBothColorRequest, since?: number, query?: string): Promise<unknown> {
    const write = mutation !== undefined;
    let response: Response;
    try {
      response = await fetch(query !== undefined ? `./api.php?${query}` : since === undefined ? './api.php' : `./api.php?since=${since}`, {
        method: write ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: write ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() } : {},
        ...(write ? { body: JSON.stringify(mutation) } : {}),
      });
    } catch {
      // No reply was read. For a write the outcome is unknown: it may have saved.
      throw new ApiFailure(write ? 'The request was interrupted.' : 'Could not refresh.', 0, null, undefined, write);
    }
    release?.(response.headers.get(RELEASE_HEADER));
    let body: unknown;
    try { body = await response.json(); }
    catch { body = null; }
    if (response.ok && body !== null && typeof body === 'object') { return body; }
    const failed = (body ?? {}) as Partial<ApiError>;
    const code = failed.code ?? (response.ok ? 'unavailable' : BY_STATUS[response.status] ?? (response.status >= 500 ? 'unavailable' : 'invalid'));
    if (response.status === 401 || response.status === 403) { signedOut(); }
    // A 2xx whose body cannot be read leaves a write's outcome unknown.
    throw new ApiFailure(failed.error || FALLBACK[code] || 'The request could not be completed.', response.status, code, failed.cap, response.ok && write);
  }
  return {
    /** GET. With `since`, the server may answer `{unchanged: true}` instead of the whole snapshot. */
    load: (since?: number) => call(undefined, since) as Promise<Loaded>,
    /** POST one mutation; the reply is the caller's whole snapshot. */
    send: (mutation: Mutation) => call(mutation) as Promise<Snapshot>,
    /** POST the person's color theme (an account preference, not planner data); the reply names the theme the server stored. */
    setTheme: (theme: string) => call({ action: 'setTheme', theme }) as Promise<SetThemeReply>,
    /** GET CalMind's events on the planner days `from` to `to` (read from CalMind's store by the server, read-only). */
    calmind: (from: string, to: string) => call(undefined, undefined, `calmind=1&from=${from}&to=${to}`) as Promise<CalmindReply>,
    /** POST whether the Day shows CalMind's events (an account preference beside the theme); the reply names what the server stored. */
    setCalmind: (hidden: boolean) => call({ action: 'setCalmind', hidden }) as Promise<SetCalmindReply>,
    /** POST this person's own color for Both (an account preference, not planner data); the reply names the color the server stored. */
    setBothColor: (bothColor: ColorKey | null) => call({ action: 'setBothColor', bothColor }) as Promise<SetBothColorReply>,
  };
}
export type Api = ReturnType<typeof createApi>;
