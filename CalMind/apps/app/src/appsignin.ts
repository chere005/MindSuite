/**
 * App sign-in: the flow, with no platform in it (the browsers are in appsignin-browser.ts).
 *
 * A native app or the desktop shell on a server that is on the suite's shared sign-in shows no username and password
 * form. One "Sign in" opens the site's /account/app/ in the system's authentication browser, where the person signs in
 * as on the web (a password, a passkey, a password manager) and confirms; the browser comes back to the app's own return
 * address with a one-time code, which the app redeems at its API (signin_redeem) for the same calmind-scoped bearer token
 * the form gives. OAuth 2.0 authorization code with PKCE S256 (RFC 8252, RFC 7636): no client secret, no refresh token.
 * docs/api.md "App sign-in". Nothing here logs, and nothing is stored but the final session (the caller keeps that).
 */
import { bytesToB64u, pkceChallenge } from '@calmind/core';
import { ApiError, apiPost, apiProbe, type Session } from './api';

/** What signin_info said. */
export type SignInFacts =
  | { kind: 'answer'; shared: boolean; appSignIn: boolean }
  | { kind: 'unavailable'; message: string }   // shared, but it cannot answer now (503 shared:true)
  | { kind: 'unknown' };                       // no usable answer: offline, timeout, not JSON, another status

/**
 * POST signin_info. 200 ok -> the answer; 400 (an API that predates it) -> not shared; any status with JSON `shared: true`
 * and not ok -> unavailable (its words); anything else, or a throw -> unknown.
 */
export async function signInFacts(serverUrl: string): Promise<SignInFacts> {
  try {
    const { status, data } = await apiProbe(serverUrl, { action: 'signin_info' });
    if (status === 200 && data?.ok === true) return { kind: 'answer', shared: data.shared === true, appSignIn: data.app_signin === true };
    if (status === 400) return { kind: 'answer', shared: false, appSignIn: false };
    if (data && data.ok !== true && data.shared === true) {
      return { kind: 'unavailable', message: typeof data.error === 'string' && data.error ? data.error : 'sign-in is unavailable right now' };
    }
    return { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}

/** What the sign-in card shows: the one button, the old form, a refusal, or "could not reach the server". */
export type LoginGate = 'app' | 'form' | 'unavailable' | 'offline';

/** answer shared and app_signin -> 'app'; any other answer -> 'form'; unavailable -> 'unavailable'; unknown -> 'offline'. */
export function gateFor(f: SignInFacts): LoginGate {
  if (f.kind === 'answer') return f.shared && f.appSignIn ? 'app' : 'form';
  return f.kind === 'unavailable' ? 'unavailable' : 'offline';
}

/** https://host[/test|/dev]/account/ of the API's instance (never the page's origin), or null when the API is not http(s). */
export function accountBase(serverUrl: string): string | null {
  try {
    const a = new URL(serverUrl);
    if (a.protocol !== 'https:' && a.protocol !== 'http:') return null;
    const prefix = /^\/(test|dev)\//.test(a.pathname) ? `/${a.pathname.split('/')[1]}` : '';
    return `${a.origin}${prefix}/account/`;
  } catch {
    return null;
  }
}

/** The page to open: accountBase + app/ and the five parameters, in this order. Built by hand (no URLSearchParams on native). */
export function authorizeUrl(
  serverUrl: string,
  p: { app: string; redirectUri: string; state: string; challenge: string },
): string | null {
  const base = accountBase(serverUrl);
  if (!base) return null;
  const q: Array<[string, string]> = [
    ['app', p.app], ['redirect_uri', p.redirectUri], ['state', p.state],
    ['code_challenge', p.challenge], ['code_challenge_method', 'S256'],
  ];
  return `${base}app/?` + q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

export type Returned = { kind: 'code'; code: string } | { kind: 'cancel' } | { kind: 'error'; message: string };

const NOT_FINISHED = 'That sign-in did not finish. Press Sign in to try again.';

function queryOf(q: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of q.split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    const k = i < 0 ? pair : pair.slice(0, i);
    const v = i < 0 ? '' : pair.slice(i + 1);
    try {
      if (!(k in out)) out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      return {};
    }
  }
  return out;
}

/**
 * Read what the browser came back with. The part before '?' must be the return address (a scheme return also
 * arrives as "scheme:///signin" or "scheme://signin": React Native may normalise the slashes). Then the state must be
 * ours, error=access_denied is a cancel, temporarily_unavailable and every other error are words, and a code must be 64 hex.
 */
export function readReturn(returned: string, redirectUri: string, state: string): Returned {
  const bad: Returned = { kind: 'error', message: NOT_FINISHED };
  if (returned.includes('#')) return bad;
  const at = returned.indexOf('?');
  const base = at < 0 ? returned : returned.slice(0, at);
  const scheme = /^([a-z][a-z0-9.+-]*):\/signin$/.exec(redirectUri)?.[1];
  const same = base === redirectUri || (scheme !== undefined && (base === `${scheme}:///signin` || base === `${scheme}://signin`));
  if (!same || at < 0) return bad;
  const q = queryOf(returned.slice(at + 1));
  if (q.state !== state) return bad;
  if (q.error === 'access_denied') return { kind: 'cancel' };
  if (q.error === 'temporarily_unavailable') return { kind: 'error', message: 'Sign-in is not available right now. Try again later.' };
  if (q.error !== undefined || typeof q.code !== 'string' || !/^[a-f0-9]{64}$/.test(q.code)) return bad;
  return { kind: 'code', code: q.code };
}

/** The platform half: where the browser returns to, how to show the page, how to stop waiting. */
export type ReturnBrowser = {
  /** The return address for this sign-in (the desktop shell starts its one-shot loopback listener here). */
  prepare(state: string): Promise<string>;
  /** Show the page; the URL the browser came back to, or null when the person closed it. Rejects with an Error whose message is shown. */
  open(url: string, returnTo: string): Promise<string | null>;
  /** Stop waiting (desktop); a no-op elsewhere. */
  cancel(): Promise<void>;
};

export type AppSignIn = { kind: 'ok'; session: Session } | { kind: 'cancel' } | { kind: 'error'; message: string };

/** The words for a failed redeem. */
export function redeemMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 400) return 'That sign-in expired. Press Sign in to try again.';
    if (e.status === 429) return 'Too many sign-ins just now. Try again in a while.';
    if (e.status === 503) return 'Sign-in is unavailable right now. Try again soon.';
  }
  if (e instanceof TypeError || (e as { name?: string } | null)?.name === 'AbortError') {
    return 'Could not reach the server. Check your connection and try again.';
  }
  return 'Could not sign in. Try again.';
}

/**
 * The whole flow: a PKCE verifier and a state from 32 random bytes each, the return address from the browser, the page in
 * the system browser, the return read and checked, then the code redeemed with the verifier. `random` is injected so a
 * test can be deterministic; the app passes the platform's secure source.
 */
export async function signInThroughAccount(
  serverUrl: string,
  app: string,
  browser: ReturnBrowser,
  random: (n: number) => Uint8Array,
): Promise<AppSignIn> {
  const verifier = bytesToB64u(random(32));
  const challenge = pkceChallenge(verifier);
  const state = bytesToB64u(random(32));
  let returnTo: string;
  let returned: string | null;
  try {
    returnTo = await browser.prepare(state);
    const url = authorizeUrl(serverUrl, { app, redirectUri: returnTo, state, challenge });
    if (!url) throw new Error('Could not find the sign-in page.');
    returned = await browser.open(url, returnTo);
  } catch (e) {
    await browser.cancel().catch(() => undefined);
    return { kind: 'error', message: e instanceof Error && e.message ? e.message : 'Could not sign in. Try again.' };
  }
  if (returned === null) return { kind: 'cancel' };
  const r = readReturn(returned, returnTo, state);
  if (r.kind !== 'code') return r;
  try {
    const s = await apiPost<{ token: string; username: string }>(serverUrl, {
      action: 'signin_redeem', code: r.code, code_verifier: verifier, redirect_uri: returnTo,
    });
    return { kind: 'ok', session: { token: s.token, username: s.username, serverUrl, suite: true } };
  } catch (e) {
    return { kind: 'error', message: redeemMessage(e) };
  }
}
