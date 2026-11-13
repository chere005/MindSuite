import { describe, it, expect, vi, afterEach } from 'vitest';
import { createApi, REQUEST_TIMEOUT_MS } from './api';

// No DOM: fetch is a stub that answers like api.php, with or without its release stamp.
const reply = (stamp: string | null, init: { status?: number; body?: unknown } = {}) =>
  new Response(JSON.stringify(init.body ?? { unchanged: true, revision: 5 }), { status: init.status ?? 200, headers: stamp === null ? {} : { 'X-PlanMind-Release': stamp } });
const make = (answer: () => Response | Promise<Response>) => {
  const fetchStub = vi.fn(async (..._args: unknown[]) => answer());
  vi.stubGlobal('fetch', fetchStub);
  const seen: (string | null)[] = [], signedOut = vi.fn();
  return { api: createApi({ csrf: () => 'token', signedOut, release: stamp => seen.push(stamp) }), seen, signedOut, fetchStub };
};
afterEach(() => vi.unstubAllGlobals());

describe('api', () => {
  it('hands every answer\'s release stamp over, or null when it had none', async () => {
    const { api, seen } = make(() => reply('20261102090000-1'));
    await api.load(5);
    await api.send({ action: 'savePrefs', selection: { base: 'alex', overlays: [] } });
    expect(seen).toEqual(['20261102090000-1', '20261102090000-1']);
    vi.stubGlobal('fetch', async () => reply(null));
    await api.load(5);
    expect(seen.at(-1)).toBeNull();
  });
  it('reads the stamp of a refusal too (a deploy shows in a 401 or a 503 as well)', async () => {
    const { api, seen, signedOut } = make(() => reply('20261102093000-2', { status: 401, body: { error: 'Sign in to open PlanMind.', code: 'unauthorized' } }));
    await expect(api.load()).rejects.toMatchObject({ status: 401 });
    expect(seen).toEqual(['20261102093000-2']);
    expect(signedOut).toHaveBeenCalledOnce();
  });
  it('hands over nothing when no answer arrived', async () => {
    const { api, seen } = make(() => { throw new TypeError('network'); });
    await expect(api.load()).rejects.toMatchObject({ message: 'Could not refresh.' });
    expect(seen).toEqual([]);
  });
  it('waits 45 s, not 15, before it calls a read or a write failed', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { api } = make(() => reply(null));
    await api.load(5);
    await api.send({ action: 'savePrefs', selection: { base: 'alex', overlays: [] } });
    expect(REQUEST_TIMEOUT_MS).toBe(45000);
    expect(timeout.mock.calls).toEqual([[45000], [45000]]);
    timeout.mockRestore();
  });
});
