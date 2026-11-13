import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Shared sign-in, web build (api.ts). While the server is on the suite's shared
// sign-in the web build holds no token: it asks whoami, sends the person to
// /account/?next=<path> and comes back on the suite cookie, with the CSRF
// secret on every write. Native, the desktop shell and a server that is not on
// shared sign-in keep the bearer login byte for byte.

const PAGE = 'https://seancheren.com/calmind/';
const API = 'https://seancheren.com/calmind/api/index.php';

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
type Reply = { status?: number; body?: unknown; raw?: string };

/** A fresh copy of the module (it keeps the CSRF secret in memory), with fetch scripted. */
async function load(replies: Array<Reply | Error | ((c: Call) => Reply | Error)>) {
  vi.resetModules();
  const calls: Call[] = [];
  const queue = [...replies];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const call = { url, headers: { ...init.headers }, body: JSON.parse(init.body) as Record<string, unknown> };
    calls.push(call);
    const next = queue.shift();
    if (next === undefined) throw new Error(`unscripted request: ${init.body}`);
    const r = typeof next === 'function' ? next(call) : next;
    if (r instanceof Error) throw r;
    return new Response(r.raw ?? JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }));
  const api = await import('../src/api');
  return { api, calls };
}

const WHOAMI_OK = (username = 'alex', csrf = 'secret-1'): Reply => ({ body: { ok: true, username, csrf } });
const SHARED_401: Reply = { status: 401, body: { ok: false, error: 'auth required', shared: true } };
const LEGACY_401: Reply = { status: 401, body: { ok: false, error: 'auth required' } };

function memoryStorage(failing = false) {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => { if (failing) throw new Error('blocked'); return m.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (failing) throw new Error('blocked'); m.set(k, String(v)); },
    removeItem: (k: string) => { if (failing) throw new Error('blocked'); m.delete(k); },
    _m: m,
  };
}

beforeEach(() => {
  vi.stubGlobal('location', { href: PAGE });
  vi.stubGlobal('sessionStorage', memoryStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('accountUrl: where a person with no session is sent', () => {
  test('the account page of the same origin, with this page\'s path as next', async () => {
    const { api } = await load([]);
    expect(api.accountUrl(API, PAGE)).toBe('/account/?next=%2Fcalmind%2F');
    expect(api.accountUrl('https://test.seancheren.com/calmind/api/index.php', 'https://test.seancheren.com/calmind/'))
      .toBe('/account/?next=%2Fcalmind%2F');
  });

  test('ChefMind\'s page reaches CalMind\'s API on the same origin and returns to ChefMind', async () => {
    const { api } = await load([]);
    expect(api.accountUrl(API, 'https://seancheren.com/ChefMind/')).toBe('/account/?next=%2FChefMind%2F');
  });

  test('path only: no query, no fragment, never an origin', async () => {
    const { api } = await load([]);
    const u = api.accountUrl(API, 'https://seancheren.com/calmind/?next=https://evil.example/&a=1#frag')!;
    expect(u).toBe('/account/?next=%2Fcalmind%2F');
    expect(u.startsWith('/') && !u.startsWith('//')).toBe(true);
    expect(decodeURIComponent(u)).not.toMatch(/:\/\/|evil/);
  });

  test('a fixture that serves an instance under /test or /dev keeps the prefix for /account/', async () => {
    const { api } = await load([]);
    expect(api.accountUrl('http://127.0.0.1:9000/test/calmind/api/index.php', 'http://127.0.0.1:9000/test/calmind/'))
      .toBe('/test/account/?next=%2Ftest%2Fcalmind%2F');
    expect(api.accountUrl('http://127.0.0.1:9000/dev/calmind/api/index.php', 'http://127.0.0.1:9000/dev/calmind/'))
      .toBe('/dev/account/?next=%2Fdev%2Fcalmind%2F');
    // Only those two names, and only as the first segment.
    expect(api.accountUrl('https://seancheren.com/x/test/api/index.php', 'https://seancheren.com/x/test/'))
      .toBe('/account/?next=%2Fx%2Ftest%2F');
  });

  test('a path the site would refuse is left out, never smuggled', async () => {
    const { api } = await load([]);
    expect(api.accountUrl('https://seancheren.com/api', 'https://seancheren.com//evil.example/')).toBe('/account/');
    expect(api.accountUrl(API, 'https://seancheren.com/a%5Cb/')).toBe('/account/');
    expect(api.accountUrl(API, 'https://seancheren.com/a%20b/')).toBe('/account/');
    // The URL parser resolves dot segments itself, so they arrive as the plain path they name.
    expect(api.accountUrl(API, 'https://seancheren.com/calmind/%2e%2e/')).toBe('/account/?next=%2F');
  });

  test('null where the page may not use the cookie: another origin, the desktop shell, native', async () => {
    const { api } = await load([]);
    expect(api.accountUrl('https://seancheren.com/calmind/api/index.php', 'https://dev.seancheren.com/calmind/')).toBeNull();
    expect(api.accountUrl('http://127.0.0.1:8788/api/index.php', 'http://localhost:8081/')).toBeNull();
    expect(api.accountUrl(API, 'tauri://localhost/index.html')).toBeNull();
    expect(api.accountUrl(API, 'http://tauri.localhost/index.html')).toBeNull();
    expect(api.accountUrl(API, null)).toBeNull();
    expect(api.cookieApi(API, PAGE)).toBe(true);
    expect(api.cookieApi(API, null)).toBe(false);
    expect(api.cookieApi('not a url', PAGE)).toBe(true);   // a relative URL resolves against the page: same origin
  });
});

describe('cookie session stand-in', () => {
  test('names the person, is never a bearer token', async () => {
    const { api } = await load([]);
    expect(api.cookieUserOf(api.cookieToken('alex'))).toBe('alex');
    expect(api.cookieUserOf('a'.repeat(64))).toBeNull();
    expect(api.cookieUserOf('')).toBeNull();
    expect(api.cookieUserOf(undefined)).toBeNull();
  });
});

describe('claimAccountRedirect: one redirect, then show the person', () => {
  const FROM_ACCOUNT = 'https://seancheren.com/account/?next=%2Fcalmind%2F';

  test('allowed once, refused inside five seconds, allowed again after', async () => {
    const { api } = await load([]);
    expect(api.claimAccountRedirect(1_000_000, '', PAGE)).toBe(true);
    expect(api.claimAccountRedirect(1_002_000, '', PAGE)).toBe(false);
    expect(api.claimAccountRedirect(1_004_999, '', PAGE)).toBe(false);
    expect(api.claimAccountRedirect(1_005_001, '', PAGE)).toBe(true);
  });

  test('sent to /account/ and sent straight back to an API that still refuses: the loop is refused, however long they took', async () => {
    const { api } = await load([]);
    expect(api.claimAccountRedirect(1_000_000, '', PAGE)).toBe(true);
    expect(api.claimAccountRedirect(1_090_000, FROM_ACCOUNT, PAGE), 'back from /account/ ninety seconds later').toBe(false);
    expect(api.claimAccountRedirect(1_000_000 + 11 * 60_000, FROM_ACCOUNT, PAGE), 'a tab left for eleven minutes may try again').toBe(true);
  });

  test('without a mark the referrer alone refuses nothing (a long-lived tab that needs signing in again, a reload)', async () => {
    const { api } = await load([]);
    expect(api.claimAccountRedirect(1_000_000, FROM_ACCOUNT, PAGE)).toBe(true);
  });

  test('only this origin\'s /account/ counts as having come from the account page', async () => {
    const { api } = await load([]);
    const verdict = (ref: string | null) => {
      vi.stubGlobal('sessionStorage', memoryStorage());           // a tab that was sent to /account/ a minute ago
      sessionStorage.setItem('mindsuite.signin.redirected', String(1_000_000));
      return api.claimAccountRedirect(1_060_000, ref, PAGE);
    };
    for (const ref of ['https://seancheren.com/test/account/', 'https://seancheren.com/dev/account', 'https://seancheren.com/account']) {
      expect(verdict(ref), ref).toBe(false);
    }
    // Another origin's account page, another page of ours, or no referrer at all are ordinary visits.
    for (const ref of ['https://evil.example/account/', 'https://seancheren.com/accounting/', 'not a url', '', null]) {
      expect(verdict(ref), String(ref)).toBe(true);
    }
  });

  test('refused when sessionStorage cannot say: a loop could not be stopped', async () => {
    vi.stubGlobal('sessionStorage', memoryStorage(true));
    const { api } = await load([]);
    expect(api.claimAccountRedirect(1_000_000, '', PAGE)).toBe(false);
  });
});

describe('probeSharedSignIn: what does this browser have?', () => {
  test('shared sign-in, no session: go to /account/ (and the request carries no credential)', async () => {
    const { api, calls } = await load([SHARED_401]);
    expect(await api.probeSharedSignIn(API)).toEqual({ kind: 'account', url: '/account/?next=%2Fcalmind%2F' });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ action: 'whoami', space: 'chef' });
    expect(Object.keys(calls[0].headers).map((h) => h.toLowerCase()).sort()).toEqual(['content-type']);
  });

  test('a good cookie is the session, and a later redirect is allowed again', async () => {
    const { api } = await load([WHOAMI_OK('alex', 's1')]);
    api.claimAccountRedirect(Date.now(), '', PAGE);
    expect(await api.probeSharedSignIn(API)).toEqual({ kind: 'cookie', username: 'alex' });
    expect(api.claimAccountRedirect(Date.now(), '', PAGE)).toBe(true);   // the mark was cleared by the good session
  });

  test('a legacy server (401 without shared) keeps the form', async () => {
    const { api } = await load([LEGACY_401]);
    expect(await api.probeSharedSignIn(API)).toEqual({ kind: 'legacy' });
  });

  test('a reply that is JSON but neither shared nor a session is legacy (a stubbed API)', async () => {
    const { api } = await load([{ body: { ok: true } }]);
    expect(await api.probeSharedSignIn(API)).toEqual({ kind: 'legacy' });
  });

  test('a switched-on server that cannot read its store says so; no form', async () => {
    const { api } = await load([{ status: 503, body: { ok: false, error: 'sign-in unavailable', shared: true } }]);
    expect(await api.probeSharedSignIn(API)).toEqual({ kind: 'unavailable', message: 'sign-in unavailable' });
  });

  test('a shared 403 (cross-site) is unavailable, not a redirect', async () => {
    const { api } = await load([{ status: 403, body: { ok: false, error: 'cross-site request', shared: true } }]);
    expect((await api.probeSharedSignIn(API)).kind).toBe('unavailable');
  });

  test('no usable answer is "unknown": offline, not JSON', async () => {
    const off = await load([new TypeError('Failed to fetch')]);
    expect(await off.api.probeSharedSignIn(API)).toEqual({ kind: 'unknown' });
    const html = await load([{ status: 502, raw: '<html>bad gateway</html>' }]);
    expect(await html.api.probeSharedSignIn(API)).toEqual({ kind: 'unknown' });
  });

  test('native, the desktop shell and metro never ask: legacy with no request', async () => {
    vi.stubGlobal('location', undefined);
    const native = await load([]);
    expect(await native.api.probeSharedSignIn(API)).toEqual({ kind: 'legacy' });
    expect(native.calls).toHaveLength(0);
    vi.stubGlobal('location', { href: 'tauri://localhost/index.html' });
    const tauri = await load([]);
    expect(await tauri.api.probeSharedSignIn('https://seancheren.com/calmind/api/index.php')).toEqual({ kind: 'legacy' });
    expect(tauri.calls).toHaveLength(0);
  });

  test('waits for a Log out still in flight, so the old cookie cannot sign the person straight back in', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const order: string[] = [];
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => {
      const action = (JSON.parse(init.body) as { action: string }).action;
      order.push(action);
      if (action === 'logout') await gate;
      return new Response(JSON.stringify(action === 'whoami' ? { ok: false, error: 'auth required', shared: true } : { ok: true }), { status: action === 'whoami' ? 401 : 200 });
    }));
    const api = await import('../src/api');
    // The cookie session already knows its secret (it just signed in), so logout needs no whoami first.
    vi.mocked(fetch).mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true, username: 'alex', csrf: 'c' })));
    await api.probeSharedSignIn(API);   // consumes the scripted cookie answer: learned
    order.length = 0;
    const out = api.logout({ token: api.cookieToken('alex'), username: 'alex', serverUrl: API });
    const probing = api.probeSharedSignIn(API);
    await new Promise((r) => setTimeout(r, 20));
    expect(order, 'the probe has not asked while logout is pending').toEqual(['logout']);
    release();
    await out;
    expect((await probing).kind).toBe('account');
    expect(order).toEqual(['logout', 'whoami']);
  });
});

describe('apiPost as the cookie session', () => {
  const session = (api: typeof import('../src/api')) => api.cookieToken('alex');

  test('learns the secret from whoami once, then sends it on every write and never an Authorization header', async () => {
    const { api, calls } = await load([WHOAMI_OK('alex', 'secret-1'), { body: { ok: true, n: 1 } }, { body: { ok: true, n: 2 } }]);
    await api.apiPost(API, { action: 'sync', cursor: 0, changes: [] }, session(api));
    await api.apiPost(API, { action: 'sync', cursor: 1, changes: [] }, session(api));
    expect(calls.map((c) => c.body.action)).toEqual(['whoami', 'sync', 'sync']);
    expect(calls[0].headers['X-CSRF-Token']).toBeUndefined();   // whoami is a read
    expect(calls[1].headers['X-CSRF-Token']).toBe('secret-1');
    expect(calls[2].headers['X-CSRF-Token']).toBe('secret-1');
    for (const c of calls) {
      expect(Object.keys(c.headers).some((h) => h.toLowerCase() === 'authorization'), 'no bearer, ever').toBe(false);
      expect(JSON.stringify(c)).not.toContain('cookie:');
    }
  });

  test('a secret the probe just learned is used without asking again', async () => {
    const { api, calls } = await load([WHOAMI_OK('alex', 'from-probe'), { body: { ok: true } }]);
    await api.probeSharedSignIn(API);
    await api.apiPost(API, { action: 'sync', cursor: 0, changes: [] }, session(api));
    expect(calls.map((c) => c.body.action)).toEqual(['whoami', 'sync']);
    expect(calls[1].headers['X-CSRF-Token']).toBe('from-probe');
  });

  test('two writes started together ask whoami once', async () => {
    const { api, calls } = await load([WHOAMI_OK(), { body: { ok: true } }, { body: { ok: true } }]);
    await Promise.all([
      api.apiPost(API, { action: 'sync' }, session(api)),
      api.apiPost(API, { action: 'shared_pull' }, session(api)),
    ]);
    expect(calls.filter((c) => c.body.action === 'whoami')).toHaveLength(1);
  });

  test('a changed secret (another tab signed in again) is learned once more and the write retried', async () => {
    const { api, calls } = await load([
      WHOAMI_OK('alex', 'old'),
      { status: 403, body: { ok: false, error: 'csrf', shared: true } },
      WHOAMI_OK('alex', 'new'),
      { body: { ok: true } },
    ]);
    await api.apiPost(API, { action: 'sync' }, session(api));
    expect(calls.map((c) => [c.body.action, c.headers['X-CSRF-Token'] ?? null])).toEqual([
      ['whoami', null], ['sync', 'old'], ['whoami', null], ['sync', 'new'],
    ]);
  });

  test('a second csrf refusal is an error, not a loop', async () => {
    const csrf = { status: 403, body: { ok: false, error: 'csrf', shared: true } };
    const { api, calls } = await load([WHOAMI_OK(), csrf, WHOAMI_OK(), csrf]);
    await expect(api.apiPost(API, { action: 'sync' }, session(api))).rejects.toMatchObject({ status: 403, shared: true, message: 'csrf' });
    expect(calls).toHaveLength(4);
  });

  test('a cookie that now belongs to somebody else never carries this person\'s data', async () => {
    const { api, calls } = await load([WHOAMI_OK('sam', 'theirs')]);
    await expect(api.apiPost(API, { action: 'sync', cursor: 0, changes: [{ id: 'x' }] }, session(api)))
      .rejects.toMatchObject({ status: 401, shared: true });
    expect(calls.map((c) => c.body.action), 'the write was never sent').toEqual(['whoami']);
  });

  test('the cookie is gone: a 401 that says shared, so the store signs out and the card sends them to /account/', async () => {
    const { api } = await load([SHARED_401]);
    const err = await api.apiPost(API, { action: 'sync' }, session(api)).catch((e) => e);
    expect(err).toBeInstanceOf(api.ApiError);
    expect(err).toMatchObject({ status: 401, shared: true, message: 'auth required' });
  });

  test('a cookie session where the cookie cannot go is refused with no request', async () => {
    vi.stubGlobal('location', { href: 'tauri://localhost/index.html' });
    const { api, calls } = await load([]);
    await expect(api.apiPost(API, { action: 'sync' }, session(api))).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(0);
  });

  test('logout carries the secret and forgets it', async () => {
    const { api, calls } = await load([WHOAMI_OK('alex', 'c1'), { body: { ok: true } }, WHOAMI_OK('alex', 'c2'), { body: { ok: true } }]);
    await api.logout({ token: session(api), username: 'alex', serverUrl: API });
    expect(calls.map((c) => c.body.action)).toEqual(['whoami', 'logout']);
    expect(calls[1].headers['X-CSRF-Token']).toBe('c1');
    await api.apiPost(API, { action: 'sync' }, session(api));
    expect(calls[2].body.action, 'asks again: the old secret died with the session').toBe('whoami');
    expect(calls[3].headers['X-CSRF-Token']).toBe('c2');
  });
});

describe('the bearer login is unchanged', () => {
  test('a token goes out as Authorization, with no CSRF header and no whoami', async () => {
    const tok = 'a'.repeat(64);
    const { api, calls } = await load([{ body: { ok: true } }]);
    await api.apiPost(API, { action: 'sync' }, tok);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization).toBe(`Bearer ${tok}`);
    expect(calls[0].headers['X-CSRF-Token']).toBeUndefined();
  });

  test('every call names the chef space, so the server judges it on the chefmind hold', async () => {
    const ok = { body: { ok: true, token: tok64(), username: 'alex' } };
    const { api, calls } = await load([ok, ok, ok, ok]);
    await api.login(API, 'alex', 'pw');
    await api.apiPost(API, { action: 'whoami' }, tok64());
    await api.logout({ token: tok64(), username: 'alex', serverUrl: API });
    await api.apiPost(API, { action: 'sync', space: 'elsewhere' }, tok64());
    expect(calls.map((c) => [c.body.action, c.body.space])).toEqual([['login', 'chef'], ['whoami', 'chef'], ['logout', 'chef'], ['sync', 'chef']]);
  });

  test('no token sends no credential (login, signup, recover, the public request page)', async () => {
    const { api, calls } = await load([{ body: { ok: true, token: tok64(), username: 'alex' } }]);
    await api.login(API, 'alex', 'pw');
    expect(Object.keys(calls[0].headers).map((h) => h.toLowerCase()).sort()).toEqual(['content-type']);
  });

  test('errors keep the server\'s words and status, and `shared` only when the server said it', async () => {
    const legacy = await load([{ status: 401, body: { ok: false, error: 'wrong username or password' } }]);
    const e1 = await legacy.api.login(API, 'alex', 'x').catch((e) => e);
    expect(e1).toMatchObject({ message: 'wrong username or password', status: 401, shared: false });
    const dead = await load([{ status: 500, raw: 'oops' }]);
    const e2 = await dead.api.apiPost(API, { action: 'sync' }, tok64()).catch((e) => e);
    expect(e2).toMatchObject({ message: 'server error (500)', status: 500, shared: false });
    const shared = await load([{ status: 401, body: { ok: false, error: 'bad token', shared: true } }]);
    const e3 = await shared.api.apiPost(API, { action: 'sync' }, tok64()).catch((e) => e);
    expect(e3).toMatchObject({ message: 'bad token', status: 401, shared: true });
  });
});

describe('Manage your account (shared sign-in: the password and the account are the suite\'s)', () => {
  test('on the API\'s own origin: same-origin, path-only /account/?next=<this page>', async () => {
    const { api } = await load([]);
    expect(api.manageAccountUrl(API, 'https://seancheren.com/calmind/?x=1#y')).toEqual({ url: '/account/?next=%2Fcalmind%2F', web: true });
    expect(api.manageAccountUrl('https://seancheren.com/test/calmind/api/index.php', 'https://seancheren.com/test/calmind/'))
      .toEqual({ url: '/test/account/?next=%2Ftest%2Fcalmind%2F', web: true });
  });

  test('native and the desktop shell: the instance\'s /account/ on the API\'s origin, for the system browser', async () => {
    const { api } = await load([]);
    expect(api.manageAccountUrl(API, null)).toEqual({ url: 'https://seancheren.com/account/', web: false });
    expect(api.manageAccountUrl('https://test.seancheren.com/calmind/api/index.php', null)).toEqual({ url: 'https://test.seancheren.com/account/', web: false });
    expect(api.manageAccountUrl('https://seancheren.com/dev/calmind/api/index.php', 'http://tauri.localhost/')).toEqual({ url: 'https://seancheren.com/dev/account/', web: false });
    expect(api.manageAccountUrl('not a url', null)).toBeNull();
    expect(api.manageAccountUrl('file:///x/api/index.php', null)).toBeNull();
  });

  test('a cookie session is shared; a bearer one only once the server answers 403 shared', async () => {
    const { api } = await load([]);
    expect(api.sharedAccount(api.cookieToken('alex'))).toBe(true);
    expect(api.sharedAccount(tok64())).toBe(false);
    expect(api.sharedAccount(undefined)).toBe(false);
    expect(api.sharedAccount(tok64(), new api.ApiError('change it at /account/', 403, true))).toBe(true);
    expect(api.sharedAccount(tok64(), new api.ApiError('forbidden', 403, false)), 'a legacy 403 is an error').toBe(false);
    expect(api.sharedAccount(tok64(), new api.ApiError('auth required', 401, true)), 'a shared 401 is a sign-in, not this').toBe(false);
    expect(api.sharedAccount(tok64(), new Error('offline'))).toBe(false);
  });

  test('change_password and delete_account answered 403 shared reach the screen as that answer, not a plain error', async () => {
    const refusal: Reply = { status: 403, body: { ok: false, error: 'change it at /account/', shared: true } };
    const { api } = await load([refusal, refusal]);
    const s = { token: tok64(), username: 'alex', serverUrl: API };
    expect(api.sharedAccount(s.token, await api.changePassword(s, 'a', 'b').catch((e) => e))).toBe(true);
    expect(api.sharedAccount(s.token, await api.deleteAccount(s).catch((e) => e))).toBe(true);
  });
});

function tok64() { return 'b'.repeat(64); }
