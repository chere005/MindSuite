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

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/*
 * Two projects, one run. The first is this package's own tests (test/ here);
 * the second is the shared suite in packages/mind-core, so every app runs the
 * same vectors and canon tests from one copy, minus facade.test.ts (see below). `vitest run order` filters both.
 */
export default defineConfig({
  test: {
    projects: [
      { extends: true, test: { name: 'chefmind', include: ['test/**/*.test.ts'] } },
      {
        extends: true,
        test: {
          name: '@mind/core',
          root: fileURLToPath(new URL('../../../packages/mind-core', import.meta.url)),
          include: ['test/**/*.test.ts'],
          // facade.test.ts reads every app's packages/core stubs and sibling
          // apps' package.json files: none of them is in this app's gate
          // key, so a key match must never skip it. The
          // mind-core suite (npm run check:mind-core) runs it.
          exclude: ['test/facade.test.ts'],
        },
      },
    ],
  },
});
