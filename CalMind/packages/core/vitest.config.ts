/**
 * The core suite's clock, pinned where every platform can read it.
 *
 * The `test` script used to be `TZ=America/Chicago vitest`, a POSIX env
 * prefix that cmd.exe (npm's script shell on Windows) reads as a command
 * name, so the suite never ran there. Setting it here works on every shell:
 * this file is loaded in vitest's main process before any worker starts or
 * any test module is imported, and the workers inherit the environment.
 *
 * Why Chicago: the server keeps America/Chicago, and test/gridfuzz.test.ts
 * catches a local-midnight bug only outside UTC. test/timezone.test.ts
 * asserts the pin took, so a pin that silently stops applying fails loudly.
 */
process.env.TZ = 'America/Chicago';

import { defineConfig } from 'vitest/config';

// The shared suite lives in packages/mind-core and runs here as a second
// project under mind-core's own config; this project is CalMind's own core
// suite (the app-owned tests only).
export default defineConfig({
  test: {
    projects: [
      { extends: true, test: { name: 'calmind-core', include: ['test/**/*.test.ts'] } },
      '../../../packages/mind-core',
    ],
  },
});
