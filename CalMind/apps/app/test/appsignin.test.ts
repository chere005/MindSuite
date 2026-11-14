import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { pkceChallenge } from '@calmind/core';
import app from '../app.json';

// App sign-in (src/appsignin.ts, src/appsignin-browser.ts): the flow with fake browsers and a scripted fetch. App-neutral:
// the same bytes run in CalMind and ChefMind, each against its own app.json and api.ts.

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Linking: { openURL: vi.fn(async () => undefined) },
}));
vi.mock('expo-web-browser', () => ({
  openAuthSessionAsync: vi.fn(),
  dismissAuthSession: vi.fn(),
}));
vi.mock('expo-crypto', () => ({
  getRandomBytes: (n: number) => new Uint8Array(n).fill(7),
}));

const SCHEME = (app.expo as { scheme?: string }).scheme as string;
const RETURN = `${SCHEME}:/signin`;
const API = 'https://seancheren.com/calmind/api/index.php';
const STATE = 'S'.repeat(43);
const CODE = 'ab'.repeat(32);

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };
type Reply = { status?: number; body?: unknown; raw?: string } | Error;

/** A fresh copy of the modules with fetch scripted. */
async function load(replies: Reply[] = []) {
  vi.resetModules();
  const calls: Call[] = [];
  const queue = [...replies];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
    const next = queue.shift();
    if (next === undefined) throw new Error(`unscripted request: ${init.body}`);
    if (next instanceof Error) throw next;
    return new Response(next.raw ?? JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
  }));
  const flow = await import('../src/appsignin');
  const api = await import('../src/api');
  return { flow, api, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
});

describe('the app declares what the flow needs', () => {
  test('APP_ID is the slug and APP_SCHEME is the bundle id on both platforms', async () => {
    const brand = await import('../src/brand');
    const e = app.expo as { slug: string; scheme?: string; ios: { bundleIdentifier: string }; android: { package: string } };
    expect(brand.APP_ID).toBe(e.slug);
    expect(brand.APP_SCHEME).toBe(e.scheme);
    expect(e.scheme).toBe(e.ios.bundleIdentifier);
    expect(e.scheme).toBe(e.android.package);
    expect(e.scheme).toBe(`com.seancheren.${e.slug}`);
  });
});

describe('authorizeUrl', () => {
  const p = { app: 'calmind', redirectUri: RETURN, state: STATE, challenge: 'C'.repeat(43) };
  const tail = `app/?app=calmind&redirect_uri=${encodeURIComponent(RETURN)}&state=${STATE}&code_challenge=${'C'.repeat(43)}&code_challenge_method=S256`;
  test('the API\'s own origin and instance prefix, with exactly the five parameters in order', async () => {
    const { flow } = await load();
    expect(flow.authorizeUrl(API, p)).toBe(`https://seancheren.com/account/${tail}`);
    expect(flow.authorizeUrl('https://test.seancheren.com/calmind/api/index.php', p)).toBe(`https://test.seancheren.com/account/${tail}`);
    expect(flow.authorizeUrl('https://seancheren.com/test/calmind/api/index.php', p)).toBe(`https://seancheren.com/test/account/${tail}`);
    expect(flow.authorizeUrl('https://seancheren.com/dev/calmind/api/index.php', p)).toBe(`https://seancheren.com/dev/account/${tail}`);
    expect(flow.authorizeUrl('https://seancheren.com/x/test/api/index.php', p)).toBe(`https://seancheren.com/account/${tail}`);
  });
  test('null for an API that is not http(s)', async () => {
    const { flow } = await load();
    expect(flow.authorizeUrl('not a url', p)).toBeNull();
    expect(flow.authorizeUrl('file:///x', p)).toBeNull();
  });
});

describe('readReturn', () => {
  const q = (s: string) => `${RETURN}?${s}`;
  test('a good code', async () => {
    const { flow } = await load();
    expect(flow.readReturn(q(`code=${CODE}&state=${STATE}`), RETURN, STATE)).toEqual({ kind: 'code', code: CODE });
  });
  test('the slash normalisations of a scheme return, and nothing else', async () => {
    const { flow } = await load();
    for (const base of [`${SCHEME}:///signin`, `${SCHEME}://signin`]) {
      expect(flow.readReturn(`${base}?code=${CODE}&state=${STATE}`, RETURN, STATE)).toEqual({ kind: 'code', code: CODE });
    }
    for (const base of [`${SCHEME}:/signin/`, `${SCHEME}:/other`, 'com.evil.app:/signin', `${SCHEME}://evil/signin`]) {
      expect(flow.readReturn(`${base}?code=${CODE}&state=${STATE}`, RETURN, STATE).kind, base).toBe('error');
    }
  });
  test('the loopback return is exact', async () => {
    const { flow } = await load();
    const lb = 'http://127.0.0.1:49152/signin';
    expect(flow.readReturn(`${lb}?code=${CODE}&state=${STATE}`, lb, STATE)).toEqual({ kind: 'code', code: CODE });
    expect(flow.readReturn(`http://127.0.0.1:49153/signin?code=${CODE}&state=${STATE}`, lb, STATE).kind).toBe('error');
    expect(flow.readReturn(`http://localhost:49152/signin?code=${CODE}&state=${STATE}`, lb, STATE).kind).toBe('error');
    // The scheme slash variants are for schemes only.
    expect(flow.readReturn(`http://127.0.0.1:49152//signin?code=${CODE}&state=${STATE}`, lb, STATE).kind).toBe('error');
  });
  test('a state that is not ours is an error, whatever else it says', async () => {
    const { flow } = await load();
    const words = 'That sign-in did not finish. Press Sign in to try again.';
    expect(flow.readReturn(q(`code=${CODE}&state=other`), RETURN, STATE)).toEqual({ kind: 'error', message: words });
    expect(flow.readReturn(q(`code=${CODE}`), RETURN, STATE)).toEqual({ kind: 'error', message: words });
    expect(flow.readReturn(q('error=access_denied&state=other'), RETURN, STATE)).toEqual({ kind: 'error', message: words });
    expect(flow.readReturn(RETURN, RETURN, STATE).kind).toBe('error');
  });
  test('access_denied cancels; temporarily_unavailable and every other error are words', async () => {
    const { flow } = await load();
    expect(flow.readReturn(q(`error=access_denied&state=${STATE}`), RETURN, STATE)).toEqual({ kind: 'cancel' });
    expect(flow.readReturn(q(`error=temporarily_unavailable&state=${STATE}`), RETURN, STATE))
      .toEqual({ kind: 'error', message: 'Sign-in is not available right now. Try again later.' });
    expect(flow.readReturn(q(`error=invalid_request&state=${STATE}`), RETURN, STATE).kind).toBe('error');
    expect(flow.readReturn(q(`error=access_denied&code=${CODE}&state=${STATE}`), RETURN, STATE)).toEqual({ kind: 'cancel' });
  });
  test('a code that is not 64 lower-case hex, a fragment, a repeated key', async () => {
    const { flow } = await load();
    for (const code of ['', 'ab'.repeat(31), 'AB'.repeat(32), 'zz'.repeat(32), `${CODE}0`]) {
      expect(flow.readReturn(q(`code=${code}&state=${STATE}`), RETURN, STATE).kind, code).toBe('error');
    }
    expect(flow.readReturn(`${q(`code=${CODE}&state=${STATE}`)}#x`, RETURN, STATE).kind).toBe('error');
    // The first value of a key counts: a second "state" cannot replace the checked one.
    expect(flow.readReturn(q(`code=${CODE}&state=other&state=${STATE}`), RETURN, STATE).kind).toBe('error');
    expect(flow.readReturn(q(`code=${CODE}&state=other&%73tate=${STATE}`), RETURN, STATE).kind).toBe('error');
    expect(flow.readReturn(q(`code=%zz&state=${STATE}`), RETURN, STATE).kind).toBe('error');
  });
});

/** A fake return browser: records what it was asked and answers from a script. */
function fakeBrowser(answer: (url: string, returnTo: string) => string | null | Error, returnTo = RETURN) {
  const seen = { prepared: [] as string[], opened: [] as string[], cancelled: 0 };
  return {
    seen,
    browser: {
      prepare: async (state: string) => { seen.prepared.push(state); return returnTo; },
      open: async (url: string, to: string) => {
        seen.opened.push(url);
        const a = answer(url, to);
        if (a instanceof Error) throw a;
        return a;
      },
      cancel: async () => { seen.cancelled++; },
    },
  };
}
let tick = 0;
const rnd = (n: number) => new Uint8Array(n).map((_, i) => (i * 7 + ++tick) & 0xff);
const param = (url: string, k: string) => new URL(url).searchParams.get(k) ?? '';

describe('signInThroughAccount', () => {
  test('success: one redeem with the verifier of the opened challenge, and the session', async () => {
    const { flow, calls } = await load([{ body: { ok: true, token: 'f'.repeat(64), username: 'alex' } }]);
    const fb = fakeBrowser((url) => `${RETURN}?code=${CODE}&state=${param(url, 'state')}`);
    const r = await flow.signInThroughAccount(API, 'calmind', fb.browser, rnd);
    expect(r).toEqual({ kind: 'ok', session: { token: 'f'.repeat(64), username: 'alex', serverUrl: API, suite: true } });
    expect(calls).toHaveLength(1);
    const b = calls[0]!.body;
    expect(b.action).toBe('signin_redeem');
    expect(b.code).toBe(CODE);
    expect(b.redirect_uri).toBe(RETURN);
    expect(typeof b.code_verifier).toBe('string');
    expect(String(b.code_verifier)).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(pkceChallenge(String(b.code_verifier))).toBe(param(fb.seen.opened[0]!, 'code_challenge'));
    expect(param(fb.seen.opened[0]!, 'app')).toBe('calmind');
    expect(param(fb.seen.opened[0]!, 'redirect_uri')).toBe(RETURN);
    expect(param(fb.seen.opened[0]!, 'code_challenge_method')).toBe('S256');
    expect(fb.seen.prepared[0]).toBe(param(fb.seen.opened[0]!, 'state'));
    expect(calls[0]!.headers.Authorization).toBeUndefined();
  });
  test('a closed browser is a cancel with no request', async () => {
    const { flow, calls } = await load();
    const fb = fakeBrowser(() => null);
    expect(await flow.signInThroughAccount(API, 'calmind', fb.browser, rnd)).toEqual({ kind: 'cancel' });
    expect(calls).toHaveLength(0);
  });
  test('access_denied from the page is a cancel; a state mismatch is an error; neither makes a request', async () => {
    const { flow, calls } = await load();
    const denied = fakeBrowser((url) => `${RETURN}?error=access_denied&state=${param(url, 'state')}`);
    expect(await flow.signInThroughAccount(API, 'calmind', denied.browser, rnd)).toEqual({ kind: 'cancel' });
    const forged = fakeBrowser(() => `${RETURN}?code=${CODE}&state=${'x'.repeat(43)}`);
    const r = await flow.signInThroughAccount(API, 'calmind', forged.browser, rnd);
    expect(r.kind).toBe('error');
    expect(calls).toHaveLength(0);
  });
  test('a browser that cannot open says so, and is told to stop waiting', async () => {
    const { flow, calls } = await load();
    const fb = fakeBrowser(() => new Error('Could not open your browser.'));
    expect(await flow.signInThroughAccount(API, 'calmind', fb.browser, rnd)).toEqual({ kind: 'error', message: 'Could not open your browser.' });
    expect(fb.seen.cancelled).toBe(1);
    expect(calls).toHaveLength(0);
  });
  test('a redeem that fails says why, in the four sets of words', async () => {
    const run = async (reply: Reply) => {
      const { flow } = await load([reply]);
      const fb = fakeBrowser((url) => `${RETURN}?code=${CODE}&state=${param(url, 'state')}`);
      return flow.signInThroughAccount(API, 'calmind', fb.browser, rnd);
    };
    expect(await run({ status: 400, body: { ok: false, error: 'that sign-in expired; try again', shared: true } }))
      .toEqual({ kind: 'error', message: 'That sign-in expired. Press Sign in to try again.' });
    expect(await run({ status: 429, body: { ok: false, error: 'too many', shared: true } }))
      .toEqual({ kind: 'error', message: 'Too many sign-ins just now. Try again in a while.' });
    expect(await run({ status: 503, body: { ok: false, error: 'sign-in unavailable', shared: true } }))
      .toEqual({ kind: 'error', message: 'Sign-in is unavailable right now. Try again soon.' });
    expect(await run(new TypeError('Network request failed')))
      .toEqual({ kind: 'error', message: 'Could not reach the server. Check your connection and try again.' });
    expect(await run({ status: 500, raw: 'oops' })).toEqual({ kind: 'error', message: 'Could not sign in. Try again.' });
  });
});

describe('signInFacts and gateFor', () => {
  const gate = async (reply: Reply) => {
    const { flow } = await load([reply]);
    const f = await flow.signInFacts(API);
    return { f, g: flow.gateFor(f) };
  };
  test('shared with app sign-in is the app card', async () => {
    expect(await gate({ body: { ok: true, shared: true, app_signin: true } })).toEqual({ f: { kind: 'answer', shared: true, appSignIn: true }, g: 'app' });
  });
  test('not shared, or shared on a site that predates the feature, or an API that predates signin_info: the form', async () => {
    expect((await gate({ body: { ok: true, shared: false, app_signin: false } })).g).toBe('form');
    expect((await gate({ body: { ok: true, shared: true, app_signin: false } })).g).toBe('form');
    expect((await gate({ status: 400, body: { ok: false, error: 'unknown action' } })).g).toBe('form');
  });
  test('a shared server that cannot answer is "unavailable" with its words', async () => {
    expect(await gate({ status: 503, body: { ok: false, error: 'sign-in unavailable', shared: true } }))
      .toEqual({ f: { kind: 'unavailable', message: 'sign-in unavailable' }, g: 'unavailable' });
  });
  test('no usable answer is offline: non-JSON, another status, a throw, an abort', async () => {
    expect((await gate({ status: 500, raw: '<html>' })).g).toBe('offline');
    expect((await gate({ status: 502, body: { ok: false } })).g).toBe('offline');
    expect((await gate(new TypeError('Network request failed'))).g).toBe('offline');
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect((await gate(abort)).g).toBe('offline');
  });
  test('the probe sends signin_info with no token', async () => {
    const { flow, calls } = await load([{ body: { ok: true, shared: true, app_signin: true } }]);
    await flow.signInFacts(API);
    expect(calls[0]!.body.action).toBe('signin_info');
    expect(calls[0]!.headers.Authorization).toBeUndefined();
  });
});

describe('appsignin-browser', () => {
  test('nativeBrowser opens an auth session on the scheme, not ephemeral', async () => {
    vi.resetModules();
    const wb = await import('expo-web-browser');
    const { nativeBrowser } = await import('../src/appsignin-browser');
    const b = nativeBrowser(SCHEME);
    expect(await b.prepare('s')).toBe(RETURN);
    vi.mocked(wb.openAuthSessionAsync).mockResolvedValueOnce({ type: 'success', url: `${RETURN}?code=1` });
    expect(await b.open('https://x/', RETURN)).toBe(`${RETURN}?code=1`);
    expect(wb.openAuthSessionAsync).toHaveBeenCalledWith('https://x/', RETURN, { preferEphemeralSession: false });
    vi.mocked(wb.openAuthSessionAsync).mockResolvedValueOnce({ type: 'cancel' } as never);
    expect(await b.open('https://x/', RETURN)).toBeNull();
    vi.mocked(wb.openAuthSessionAsync).mockResolvedValueOnce({ type: 'dismiss' } as never);
    expect(await b.open('https://x/', RETURN)).toBeNull();
    await b.cancel();
    expect(wb.dismissAuthSession).toHaveBeenCalled();
  });

  test('desktopBrowser: the commands and arguments, in order, and the loopback address', async () => {
    vi.resetModules();
    const { desktopBrowser } = await import('../src/appsignin-browser');
    const log: Array<[string, unknown]> = [];
    const invoke = async (cmd: string, args?: Record<string, unknown>) => {
      log.push([cmd, args]);
      if (cmd === 'signin_listen') return 49152;
      if (cmd === 'signin_wait') return `code=${CODE}&state=${STATE}`;
      return undefined;
    };
    const b = desktopBrowser(invoke);
    const to = await b.prepare(STATE);
    expect(to).toBe('http://127.0.0.1:49152/signin');
    expect(await b.open('https://seancheren.com/account/app/?x=1', to)).toBe(`${to}?code=${CODE}&state=${STATE}`);
    await b.cancel();
    expect(log).toEqual([
      ['signin_listen', { state: STATE }],
      ['open_in_browser', { url: 'https://seancheren.com/account/app/?x=1' }],
      ['signin_wait', undefined],
      ['signin_cancel', undefined],
    ]);
  });

  test('desktopBrowser: a closed wait is null; a timeout, another failure and an unopenable browser have their words', async () => {
    vi.resetModules();
    const { desktopBrowser } = await import('../src/appsignin-browser');
    const make = (wait: () => Promise<unknown>, open: () => Promise<unknown> = async () => undefined) =>
      desktopBrowser(async (cmd) => (cmd === 'signin_wait' ? wait() : cmd === 'open_in_browser' ? open() : 1));
    expect(await make(async () => null).open('u', RETURN)).toBeNull();
    await expect(make(() => Promise.reject('timeout')).open('u', RETURN)).rejects.toThrow('The browser did not come back. Press Sign in to try again.');
    await expect(make(() => Promise.reject('boom')).open('u', RETURN)).rejects.toThrow('Could not sign in. Try again.');
    await expect(make(async () => null, () => Promise.reject('no browser')).open('u', RETURN)).rejects.toThrow('Could not open your browser.');
  });

  test('returnBrowser picks the desktop shell when it is there, native with a scheme, and nothing on the web', async () => {
    vi.resetModules();
    const rn = await import('react-native');
    const mod = await import('../src/appsignin-browser');
    (rn.Platform as { OS: string }).OS = 'ios';
    expect(mod.inDesktopShell()).toBe(false);
    expect(mod.returnBrowser()).not.toBeNull();
    (rn.Platform as { OS: string }).OS = 'android';
    expect(mod.returnBrowser()).not.toBeNull();
    (rn.Platform as { OS: string }).OS = 'web';
    expect(mod.returnBrowser()).toBeNull();
    const invoke = vi.fn(async (cmd: string) => (cmd === 'signin_listen' ? 5000 : undefined));
    (globalThis as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
    expect(mod.inDesktopShell()).toBe(true);
    const b = mod.returnBrowser()!;
    expect(await b.prepare(STATE)).toBe('http://127.0.0.1:5000/signin');
    (globalThis as { __TAURI__?: unknown }).__TAURI__ = { core: {} };
    expect(mod.inDesktopShell()).toBe(false);
    (rn.Platform as { OS: string }).OS = 'ios';
  });

  test('openInBrowser uses the shell\'s system browser inside it and Linking elsewhere', async () => {
    vi.resetModules();
    const rn = await import('react-native');
    const mod = await import('../src/appsignin-browser');
    await mod.openInBrowser('https://seancheren.com/account/');
    expect(rn.Linking.openURL).toHaveBeenCalledWith('https://seancheren.com/account/');
    const invoke = vi.fn(async () => undefined);
    (globalThis as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
    await mod.openInBrowser('https://seancheren.com/account/');
    expect(invoke).toHaveBeenCalledWith('open_in_browser', { url: 'https://seancheren.com/account/' });
    expect(rn.Linking.openURL).toHaveBeenCalledTimes(1);
  });

  test('randomBytes is the platform source', async () => {
    vi.resetModules();
    const mod = await import('../src/appsignin-browser');
    expect(Array.from(mod.randomBytes(4))).toEqual([7, 7, 7, 7]);
  });
});

beforeEach(() => { tick = 0; });
