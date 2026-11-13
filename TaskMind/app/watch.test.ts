import { describe, expect, it, vi } from 'vitest';
import { createReleaseWatch } from './release';
import { createWatch } from './watch';

const session = { status: 200, body: { ok: true, me: 'alex', role: 'owner', name: '', csrf: 'x', theme: 'midnight' } };
const setup = (answer: () => Promise<unknown>, hidden = false) => {
  const release = createReleaseWatch(), closed = vi.fn(), reload = vi.fn();
  const watch = createWatch({ load: answer as never, release, hidden: () => hidden, closed, reload });
  return { watch, release, closed, reload };
};

describe('the session watch', () => {
  it('closes the view when the session ended or the person left the team', async () => {
    const out = setup(async () => ({ status: 401, body: null }));
    await out.watch.tick();
    expect(out.closed).toHaveBeenCalledWith('signedOut');
    const gone = setup(async () => ({ status: 403, body: null }));
    await gone.watch.tick();
    expect(gone.closed).toHaveBeenCalledWith('denied');
    await gone.watch.tick();
    expect(gone.closed).toHaveBeenCalledOnce();
  });
  it('leaves the page alone when the read failed: a failed read is not an empty workspace', async () => {
    for (const reply of [null, { status: 503, body: null }, { status: 200, body: 'junk' }]) {
      const out = setup(async () => reply);
      await out.watch.tick();
      expect(out.closed).not.toHaveBeenCalled();
      expect(out.reload).not.toHaveBeenCalled();
    }
  });
  it('reloads when the host serves another release', async () => {
    const out = setup(async () => session);
    out.release.see('20261102090000-1');
    await out.watch.tick();
    expect(out.reload).not.toHaveBeenCalled();
    out.release.see('20261102093000-2');
    await out.watch.tick();
    expect(out.reload).toHaveBeenCalledOnce();
  });
  it('does not ask while the tab is hidden, or while an earlier ask is still on its way', async () => {
    const load = vi.fn(async () => session);
    const hiddenOut = setup(load, true);
    await hiddenOut.watch.tick();
    expect(load).not.toHaveBeenCalled();
    let release!: (v: unknown) => void;
    const slow = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const out = setup(slow as never);
    const first = out.watch.tick();
    await out.watch.tick();
    expect(slow).toHaveBeenCalledOnce();
    release(session);
    await first;
    const again = out.watch.tick();
    expect(slow).toHaveBeenCalledTimes(2);
    release(session);
    await again;
  });
});
