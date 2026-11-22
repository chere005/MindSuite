import { expect, test, vi } from 'vitest';
import { apiProbe } from '../src/api';

test('the sign-in probe deadline includes a stalled JSON body after headers arrive', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  let body: ReadableStreamDefaultController<Uint8Array> | undefined;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    signal = init.signal!;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { body = controller; } });
    signal.addEventListener('abort', () => body?.error(new DOMException('Aborted', 'AbortError')));
    return new Response(stream, { headers: { 'Content-Type': 'application/json' } });
  }));
  let settled = false;
  const result = apiProbe('https://fixture.invalid/api', { action: 'signin_info' });
  void result.then(() => { settled = true; });
  try {
    await vi.advanceTimersByTimeAsync(8_001);
    expect(settled, 'headers alone must not cancel the deadline while the body is still pending').toBe(true);
    expect(signal?.aborted).toBe(true);
    expect((await result).data).toBeNull();
  } finally {
    body?.error(new Error('fixture closed'));
    await result;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
