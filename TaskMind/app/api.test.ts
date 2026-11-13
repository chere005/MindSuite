import { describe, it, expect, vi, afterEach } from 'vitest';
import { createApi, REQUEST_TIMEOUT_MS } from './api';

// No DOM: fetch is a stub that answers like api.php, with or without its release stamp.
const reply = (stamp: string | null, init: { status?: number; body?: unknown } = {}) =>
  new Response(JSON.stringify(init.body ?? { ok: true, me: 'alex', role: 'owner' }), { status: init.status ?? 200, headers: stamp === null ? {} : { 'X-TaskMind-Release': stamp } });
const make = (answer: () => Response | Promise<Response>) => {
  const fetchStub = vi.fn(async (..._args: unknown[]) => answer());
  vi.stubGlobal('fetch', fetchStub);
  const seen: (string | null)[] = [];
  return { api: createApi({ release: stamp => seen.push(stamp) }), seen, fetchStub };
};
afterEach(() => vi.unstubAllGlobals());

describe('api', () => {
  it('returns the status and the body, and reads the session from ./api.php with the cookie and no cache', async () => {
    const { api, fetchStub } = make(() => reply('20261102090000-1'));
    expect(await api.session()).toEqual({ status: 200, body: { ok: true, me: 'alex', role: 'owner' } });
    expect(fetchStub.mock.calls[0][0]).toBe('./api.php');
    expect(fetchStub.mock.calls[0][1]).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
  });
  it('hands every answer\'s release stamp over, or null when it had none or a garbled one', async () => {
    const { api, seen } = make(() => reply('20261102090000-1'));
    await api.session();
    vi.stubGlobal('fetch', async () => reply(null));
    await api.session();
    vi.stubGlobal('fetch', async () => reply('nginx'));
    await api.session();
    expect(seen).toEqual(['20261102090000-1', null, null]);
  });
  it('reads a refusal as an answer, with its stamp (a deploy shows in a 401 or a 503 as well)', async () => {
    const { api, seen } = make(() => reply('20261102093000-2', { status: 401, body: { error: 'Sign in to open TaskMind.', code: 'unauthorized' } }));
    expect(await api.session()).toMatchObject({ status: 401, body: { code: 'unauthorized' } });
    expect(seen).toEqual(['20261102093000-2']);
  });
  it('keeps the status when the body is not JSON', async () => {
    const { api } = make(() => new Response('<html>host error</html>', { status: 502 }));
    expect(await api.session()).toEqual({ status: 502, body: null });
  });
  it('returns null when no answer arrived, and tells the release watch nothing', async () => {
    const { api, seen } = make(() => { throw new TypeError('network'); });
    expect(await api.session()).toBeNull();
    expect(seen).toEqual([]);
  });
  it('waits 45 s, not 15, before it calls a read failed', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { api } = make(() => reply(null));
    await api.session();
    expect(REQUEST_TIMEOUT_MS).toBe(45000);
    expect(timeout.mock.calls).toEqual([[45000]]);
    timeout.mockRestore();
  });
});

describe('workspace API', () => {
  it('requests changes after the in-memory revision with no cache', async () => {
    const body = { ok: true, delta: { me: 'alex', rev: 7, since: 7, changed: false } };
    const { api, fetchStub } = make(() => reply(null, { body }));
    expect(await api.workspace(7)).toEqual({ ok: true, body });
    expect(fetchStub.mock.calls[0]).toMatchObject(['./api.php?view=workspace&since=7', {
      method: 'GET', credentials: 'same-origin', cache: 'no-store',
    }]);
  });

  it('keeps a write unconfirmed on network failure and never sends it again', async () => {
    const { api, fetchStub } = make(() => { throw new TypeError('network'); });
    const mutation = { op: 'project.add', requestId: 'operation-1', base: 1, data: { name: 'Workspace' } } as const;
    expect(await api.change('csrf', mutation)).toBeNull();
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0]).toMatchObject(['./api.php', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'X-CSRF-Token': 'csrf', 'Content-Type': 'application/json' }, body: JSON.stringify(mutation),
    }]);
  });

  it('does not accept an incomplete workspace delta', async () => {
    const { api } = make(() => reply(null, { body: { ok: true, delta: { me: 'alex', rev: 8, since: 7, changed: true } } }));
    expect(await api.workspace(7)).toEqual({ ok: false, status: 200, body: null });
  });
});
