/**
 * The thin HTTP edge: suite-style action posts, bearer token, JSON both ways.
 * Every failure becomes an Error carrying the server's message, so screens can
 * show it verbatim.
 *
 * With the suite's shared sign-in on (docs/api.md, "Shared sign-in") the WEB
 * build sends no token at all: the person signs in at /account/ and this file
 * carries the suite cookie, with its CSRF secret on every write. Native and the
 * desktop shell sign in through the suite's page /account/app/ (appsignin.ts) when the
 * API says it takes that, and keep the bearer login otherwise. See "Shared sign-in" below.
 */
import type { SyncRequest, SyncResponse, Transport } from '@calmind/core';

export type Session = {
  token: string;
  username: string;
  serverUrl: string;
  /** Signed in through the suite's account page (app sign-in); the token is the same calmind-scoped bearer. */
  suite?: boolean;
};

/**
 * How long a request may hang before it is treated as a failure.
 *
 * `fetch` has no timeout of its own on the web, so a connection that is
 * ACCEPTED and never answered — a captive portal, a dead middlebox, a server
 * that stalls — never settles either way. It is not the same as a refused
 * connection, which rejects at once and is already handled: the app simply
 * waits, and goes on saying "Syncing…" for as long as it is left.
 *
 * 60 seconds because that is NSURLSession's own default, which the native
 * builds have always had. This is the web catching up with the platform rather
 * than a number invented here, and it is comfortably above a slow first sync
 * (a batch is capped at 500 records) while still being finite.
 */
const REQUEST_TIMEOUT_MS = 60_000;

export type Reply = { ok?: boolean; error?: string; shared?: boolean } & Record<string, unknown>;

/** One POST: the status and the parsed body (null when it is not JSON). Throws only when the request itself fails. */
async function rawPost(
  serverUrl: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ status: number; data: Reply | null }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      // Every call names this app's space, not only sync: the server follows the chefmind hold for it (CalMind
      // server/lib/app.php, SUITE_SPACE_APPS), so sign-in and sync are judged on the same switch.
      body: JSON.stringify({ ...body, space: SYNC_SPACE }),
      signal: ctl.signal,
    });
    const data = (await res.json().catch(() => null)) as Reply | null;
    return { status: res.status, data };
  } finally {
    // Cover headers and body: a stalled JSON stream must not outlive the request deadline.
    // In the finally, so a request that FAILS does not leave a timer holding
    // the event loop open — which on native is a warning and on the web is a
    // slow leak of one per failed request.
    clearTimeout(timer);
  }
}

/** One POST with no session and a short timeout, the status and body left to the caller (the sign-in mode probe, the code redeem). */
export function apiProbe(
  serverUrl: string,
  body: Record<string, unknown>,
  timeoutMs = 8_000,
): Promise<{ status: number; data: Reply | null }> {
  return rawPost(serverUrl, body, {}, timeoutMs);
}

function answer<T>(r: { status: number; data: Reply | null }): T {
  if (!r.data || r.data.ok !== true) {
    throw new ApiError(r.data?.error ?? `server error (${r.status})`, r.status, r.data?.shared === true);
  }
  return r.data as unknown as T;
}

/**
 * `token` is a bearer token, or a cookie session's stand-in (cookieToken), or
 * nothing for the calls that need no session.
 */
export async function apiPost<T = Record<string, unknown>>(
  serverUrl: string,
  body: Record<string, unknown>,
  token?: string,
): Promise<T> {
  const asUser = cookieUserOf(token);
  if (asUser !== null) return cookiePost<T>(serverUrl, body, asUser);
  return answer<T>(await rawPost(serverUrl, body, token ? { Authorization: `Bearer ${token}` } : {}));
}

export class ApiError extends Error {
  /** `shared`: the server's reply carried `shared: true`, i.e. the suite's shared sign-in answered. */
  constructor(message: string, public status: number, public shared = false) {
    super(message);
  }
}

export const login = (url: string, username: string, password: string) =>
  apiPost<Session>(url, { action: 'login', username, password });
export const signup = (url: string, username: string, email: string, password: string) =>
  apiPost<Session>(url, { action: 'signup', username, email, password });
export const recover = (url: string, username: string) => apiPost(url, { action: 'recover', username });
export const reset = (url: string, username: string, code: string, password: string) =>
  apiPost<Session>(url, { action: 'reset', username, code, password });
export const changePassword = (s: Session, oldPass: string, newPass: string) =>
  apiPost<{ token: string }>(s.serverUrl, { action: 'change_password', old: oldPass, new: newPass }, s.token);
export const deleteAccount = (s: Session) =>
  apiPost(s.serverUrl, { action: 'delete_account' }, s.token);
/** The last logout still in flight: a sign-in check made right after Log out waits for it (settleLogout). */
let lastLogout: Promise<unknown> | null = null;
export const logout = (s: Session) => {
  const p = apiPost(s.serverUrl, { action: 'logout' }, s.token).catch(() => null);
  lastLogout = p;
  void p.then(() => {
    if (lastLogout === p) lastLogout = null;
    learned = null;
  });
  return p;
};

// ------------------------------------------------------------------ shared sign-in (web build)
//
// Dual mode, decided by the SERVER (docs/api.md). While the suite's shared
// sign-in is off for this instance, or this app is held, nothing below runs: the
// API answers the legacy way and the web build signs in with the form and a
// bearer token, as ever. Once it is on, every auth error carries `shared: true`
// and the browser has the suite cookie from /account/:
//
//  - The web build never asks for a password and never holds a token. A person
//    with no session is sent to /account/?next=<this page's path> and comes back
//    signed in.
//  - The session it keeps is `{ token: cookieToken(user), username, serverUrl }`.
//    That string is a stand-in, not a credential: it is never sent anywhere, and
//    it names the person so a cookie that changed under this page (another tab
//    signed in as somebody else) is noticed rather than written into the wrong
//    account's store.
//  - Every action but whoami carries X-CSRF-Token, a per-session secret learned
//    from whoami and held in MEMORY only.
//  - Only a page served from the API's own origin can do any of this. Native has
//    no `location`, the desktop shell's origin is not the API's, and metro's is
//    not either: they keep a bearer token. Native and the desktop shell get it by
//    signing in at the suite's /account/app/ in the system browser (appsignin.ts,
//    when the API's signin_info says it takes that) and fall back to the form,
//    which still works against a server that is not on shared sign-in.

const COOKIE_PREFIX = 'cookie:';

/** A cookie session's stand-in for a token. Not a credential. */
export const cookieToken = (username: string): string => COOKIE_PREFIX + username;

/** The person a cookie session's stand-in names, or null when `token` is anything else. */
export function cookieUserOf(token: string | undefined): string | null {
  return typeof token === 'string' && token.startsWith(COOKIE_PREFIX) ? token.slice(COOKIE_PREFIX.length) : null;
}

const pageHref = (): string | null => (typeof location !== 'undefined' && typeof location.href === 'string' ? location.href : null);

/** The page and the API as URLs, when this page may use the suite cookie with that API: web, same origin, not the desktop shell. */
function sameOriginWeb(page: string | null, serverUrl: string): { page: URL; api: URL } | null {
  if (!page) return null;
  try {
    const p = new URL(page);
    const a = new URL(serverUrl, page);
    if (p.protocol !== 'http:' && p.protocol !== 'https:') return null;
    if (p.hostname === 'tauri.localhost') return null;
    return a.origin === p.origin ? { page: p, api: a } : null;
  } catch {
    return null;
  }
}

/** Can this page use the suite cookie with `serverUrl`? False on native, in the desktop shell and under metro. */
export function cookieApi(serverUrl: string, page: string | null = pageHref()): boolean {
  return sameOriginWeb(page, serverUrl) !== null;
}

/**
 * Where to send a person who has no session: this origin's /account/ with this
 * page's PATH as `next`, or null when the page may not use the cookie.
 *
 * Path only: no origin, no query, no fragment, so nothing a link can smuggle in
 * becomes the return target (the site checks it again: mss_next). A path the
 * site would refuse anyway is left out, and /account/ then returns to the suite
 * home. The local fixtures that serve an instance under /test or /dev keep that
 * prefix for /account/ as well (the site's mss_url_prefix).
 */
export function accountUrl(serverUrl: string, page: string | null = pageHref()): string | null {
  const w = sameOriginWeb(page, serverUrl);
  if (!w) return null;
  const path = w.page.pathname;
  const prefix = /^\/(test|dev)\//.test(path) ? `/${path.split('/')[1]}` : '';
  const safe = path.startsWith('/') && !path.startsWith('//') && path.length <= 2048 && !/[\x00-\x20\x7f\\%]/.test(path);
  return `${prefix}/account/` + (safe ? `?next=${encodeURIComponent(path)}` : '');
}

/**
 * Where "Manage your account" goes under the shared sign-in, where the password (and everything else about the account)
 * is the suite's: on a page served from the API's origin, accountUrl (same origin, path-only `next`); anywhere else
 * (native, the desktop shell) the instance's /account/ as an absolute URL on the API's origin, for the system browser,
 * keeping a /test or /dev prefix of the API path. Null when the API URL is not http(s).
 */
export function manageAccountUrl(serverUrl: string, page: string | null = pageHref()): { url: string; web: boolean } | null {
  const web = accountUrl(serverUrl, page);
  if (web) return { url: web, web: true };
  try {
    const a = new URL(serverUrl);
    if (a.protocol !== 'https:' && a.protocol !== 'http:') return null;
    const prefix = /^\/(test|dev)\//.test(a.pathname) ? `/${a.pathname.split('/')[1]}` : '';
    return { url: `${a.origin}${prefix}/account/`, web: false };
  } catch {
    return null;
  }
}

/** Is this session the suite's (a cookie session), or did the server just say so (a 403 with `shared: true`)? */
export function sharedAccount(token: string | undefined, error?: unknown): boolean {
  return cookieUserOf(token) !== null || (error instanceof ApiError && error.shared && error.status === 403);
}

const REDIRECT_MARK = 'mindsuite.signin.redirected';
const RAPID_MS = 5_000;
const RETURN_MS = 10 * 60_000;

/** Did this page load come from this origin's /account/ (the sign-in page sent the person back)? */
function arrivedFromAccount(referrer: string | null, page: string | null): boolean {
  if (!referrer || !page) return false;
  try {
    const from = new URL(referrer);
    return from.origin === new URL(page).origin && /^\/((test|dev)\/)?account(\/|$)/.test(from.pathname);
  } catch {
    return false;
  }
}

/**
 * May this tab send the person to /account/ now? The mark says when this tab last did, and a good session clears it, so
 * a mark means "sent there, and not signed in since". With a mark: not when it is under five seconds old (a rapid loop,
 * whatever the browser tells us), and not when the page was reached from this origin's /account/ within ten minutes (the
 * sign-in page sent the person back and the API still refuses: a loop only the person can see, since the account page
 * itself never redirects on its own). Not when sessionStorage cannot say either, because then no loop could be stopped.
 * The caller shows a "Sign in" button instead, and a person who presses it is not a loop.
 */
export function claimAccountRedirect(
  now = Date.now(),
  referrer: string | null = typeof document !== 'undefined' ? document.referrer : null,
  page: string | null = pageHref(),
): boolean {
  try {
    const last = Number(sessionStorage.getItem(REDIRECT_MARK));
    if (Number.isFinite(last) && last > 0) {
      if (now - last < RAPID_MS) return false;
      if (now - last < RETURN_MS && arrivedFromAccount(referrer, page)) return false;
    }
    sessionStorage.setItem(REDIRECT_MARK, String(now));
    return true;
  } catch {
    return false;
  }
}

function clearRedirectMark(): void {
  try { sessionStorage.removeItem(REDIRECT_MARK); } catch { /* the mark only stops a loop */ }
}

/** What the sign-in check found. */
export type SharedProbe =
  | { kind: 'cookie'; username: string }       // the suite cookie is a good session: use it
  | { kind: 'account'; url: string }           // shared sign-in, no session: send them to this /account/ URL
  | { kind: 'unavailable'; message: string }   // shared sign-in, but it cannot answer right now
  | { kind: 'legacy' }                         // the API answered and is not shared: the app's own sign-in
  | { kind: 'unknown' };                       // no usable answer (offline, a timeout, not JSON): the app's own sign-in

const PROBE_TIMEOUT_MS = 8_000;

/** The CSRF secret of the cookie session this page is using, in memory only. */
let learned: { api: string; user: string; csrf: string } | null = null;
let learning: { key: string; promise: Promise<string> } | null = null;

/** Wait (briefly) for a Log out that is still in flight, so a check made right after it cannot find the old cookie. */
async function settleLogout(): Promise<void> {
  const p = lastLogout;
  if (!p) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([p, new Promise<void>((done) => { timer = setTimeout(done, PROBE_TIMEOUT_MS); })]);
  clearTimeout(timer);
}

/**
 * Ask the API who this browser is (whoami, no token), once, and say what the
 * page should do: use the cookie, go to /account/, show why it cannot, or fall
 * back to the app's own form. Native and the desktop shell are always 'legacy'.
 */
export async function probeSharedSignIn(serverUrl: string): Promise<SharedProbe> {
  if (!cookieApi(serverUrl)) return { kind: 'legacy' };
  await settleLogout();
  let r: { status: number; data: Reply | null };
  try {
    r = await rawPost(serverUrl, { action: 'whoami' }, {}, PROBE_TIMEOUT_MS);
  } catch {
    return { kind: 'unknown' };
  }
  const d = r.data;
  if (!d) return { kind: 'unknown' };
  if (d.ok === true && typeof d.username === 'string' && d.username !== '' && typeof d.csrf === 'string' && d.csrf !== '') {
    learned = { api: serverUrl, user: d.username, csrf: d.csrf };
    clearRedirectMark();
    return { kind: 'cookie', username: d.username };
  }
  if (d.shared === true) {
    const url = r.status === 401 ? accountUrl(serverUrl) : null;
    if (url) return { kind: 'account', url };
    return { kind: 'unavailable', message: typeof d.error === 'string' && d.error ? d.error : 'sign-in is unavailable right now' };
  }
  return { kind: 'legacy' };
}

/** The CSRF secret for this cookie session, learned from whoami. Throws a 401 when the cookie is gone or belongs to somebody else. */
async function csrfFor(serverUrl: string, user: string): Promise<string> {
  if (learned && learned.api === serverUrl && learned.user === user) return learned.csrf;
  const key = `${serverUrl}\n${user}`;
  if (learning && learning.key === key) return learning.promise;
  const promise = (async () => {
    const d = answer<{ username?: unknown; csrf?: unknown }>(await rawPost(serverUrl, { action: 'whoami' }, {}));
    if (typeof d.username !== 'string' || typeof d.csrf !== 'string' || d.csrf === '') throw new ApiError('sign-in required', 401, true);
    // The cookie is the browser's, not this page's: another tab may have signed in as someone else. Never act as them here.
    if (d.username !== user) throw new ApiError('signed in as someone else', 401, true);
    learned = { api: serverUrl, user, csrf: d.csrf };
    return d.csrf;
  })();
  learning = { key, promise };
  try {
    return await promise;
  } finally {
    if (learning?.promise === promise) learning = null;
  }
}

/** A call made as the cookie session of `user`: no Authorization header, the CSRF secret on every write. */
async function cookiePost<T>(serverUrl: string, body: Record<string, unknown>, user: string): Promise<T> {
  if (!cookieApi(serverUrl)) throw new ApiError('sign-in required', 401, true);   // a cookie session where the cookie cannot go
  const read = body.action === 'whoami';
  for (let attempt = 0; ; attempt++) {
    const csrf = read ? null : await csrfFor(serverUrl, user);
    const r = await rawPost(serverUrl, body, csrf ? { 'X-CSRF-Token': csrf } : {});
    // The secret is per session: a sign-in in another tab replaced it. Learn it again once (csrfFor also checks WHO is signed in).
    if (!read && attempt === 0 && r.status === 403 && r.data?.shared === true && r.data.error === 'csrf') {
      learned = null;
      continue;
    }
    return answer<T>(r);
  }
}

/**
 * WHICH STORE ON THE SERVER THIS APP IS.
 *
 * ChefMind shares CalMind's accounts — same server, same users, same tokens
 * (the owner, 2026-08-21: "we might as well reuse calmind logins") — and keeps its
 * own reminders and notes ("its own separate store"). The server holds one
 * record file per user per space: records-<user>.json is CalMind's, and
 * records-chef-<user>.json is this one. Sending the space is the whole of the
 * separation, so it is a constant here rather than anything configurable: a
 * ChefMind build that could be pointed at CalMind's records would merge two
 * apps' stores into whichever one synced last.
 *
 * An OLD server that does not know the parameter ignores it and answers out of
 * the shared file. That is the failure mode to keep in mind when this is
 * deployed ahead of the API — the guard for it is deploy order, not code.
 */
export const SYNC_SPACE = 'chef';

/** The core engine's transport, bound to a session. */
export const syncTransport = (s: Session): Transport => async (req: SyncRequest) => {
  const r = await apiPost<SyncResponse>(
    s.serverUrl,
    { action: 'sync', space: SYNC_SPACE, cursor: req.cursor, changes: req.changes },
    s.token,
  );
  return { cursor: r.cursor, changes: r.changes, rejected: r.rejected };
};
