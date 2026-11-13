import { describe, it, expect } from 'vitest';

/**
 * The pin took.
 *
 * The suite's vitest config sets TZ=America/Chicago (it used to be a
 * `TZ=... vitest` shell prefix, which cmd.exe cannot run). Nothing else
 * checks that it applied: lose it and every test simply runs in whatever zone
 * the machine is in, with dates off the server's.
 */
describe('the test clock', () => {
  it('is America/Chicago, whatever the machine is set to', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/Chicago');
  });

  it('and Date agrees, not just Intl', () => {
    // 2026-01-15T12:00:00Z is 06:00 in Chicago (CST, UTC-6).
    expect(new Date('2026-01-15T12:00:00Z').getHours()).toBe(6);
  });
});
