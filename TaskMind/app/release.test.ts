import { describe, it, expect } from 'vitest';
import { createReleaseWatch } from './release';

const A = '20261102090000-1', B = '20261102093000-2';

describe('the release stamp watch', () => {
  it('has seen nothing, so nothing changed', () => {
    expect(createReleaseWatch().changed).toBe(false);
  });
  it('remembers the first stamp as the page\'s own and stays quiet while every answer names it', () => {
    const watch = createReleaseWatch();
    watch.see(A); watch.see(A); watch.see(A);
    expect(watch.changed).toBe(false);
  });
  it('a later response that names another release is a change', () => {
    const watch = createReleaseWatch();
    watch.see(A);
    watch.see(B);
    expect(watch.changed).toBe(true);
    watch.see(B);
    expect(watch.changed).toBe(true);
  });
  it('the same version deployed twice is still another release: the stamp, not the version, is compared', () => {
    const watch = createReleaseWatch();
    watch.see('20261102090000-7');
    watch.see('20261102090500-7');
    expect(watch.changed).toBe(true);
  });
  it('a deploy rolled back while the page watches (A, B, A) is no change', () => {
    const watch = createReleaseWatch();
    watch.see(A); watch.see(B); watch.see(A);
    expect(watch.changed).toBe(false);
  });
  it('a rollback to an older release is a change as well', () => {
    const watch = createReleaseWatch();
    watch.see(B);
    watch.see(A);
    expect(watch.changed).toBe(true);
  });
  it('a response without a stamp, or with something that is not one, says nothing', () => {
    const watch = createReleaseWatch();
    watch.see(null); watch.see(undefined); watch.see('');
    expect(watch.changed).toBe(false);
    watch.see(A);
    for (const odd of [null, undefined, '', 'nginx', '2026-11-02', '20261102090000', '20261102090000-', ` ${B}`, `${B}\n`, `${B}; x`, '<b>', 'x'.repeat(200)]) { watch.see(odd); }
    expect(watch.changed).toBe(false);
  });
  it('a bad first answer does not become the page\'s own release', () => {
    const watch = createReleaseWatch();
    watch.see('garbled');
    watch.see(A);
    watch.see(A);
    expect(watch.changed).toBe(false);
    watch.see(B);
    expect(watch.changed).toBe(true);
  });
});
