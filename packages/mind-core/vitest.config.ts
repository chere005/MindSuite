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

// No `vitest/config` import: this package has no node_modules of its own (the
// runner lives in CoreMind/node_modules), so a bare specifier would not resolve.
export default {};
