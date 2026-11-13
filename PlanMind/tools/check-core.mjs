import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// check:core = every shared file of this app still carries the bytes of its origin (tools/shared-files.json at the suite root).
const APP = 'PlanMind';
const checker = fileURLToPath(new URL('../../tools/check-shared.mjs', import.meta.url));
const stop = (message) => { console.error(`check:core: ${message}`); process.exit(1); };

if (!existsSync(checker)) stop('tools/check-shared.mjs is missing at the suite root.');
const run = spawnSync(process.execPath, [checker, '--app', APP], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
process.stdout.write(run.stdout ?? '');
if (run.error) stop(`tools/check-shared.mjs could not run (${run.error.code ?? run.error.message}).`);
if (run.status !== 0) process.exit(run.status ?? 1);
const compared = /^compared (\d+) file\(s\)$/m.exec(run.stdout);
if (!compared || Number(compared[1]) === 0) stop('No shared files checked.');
