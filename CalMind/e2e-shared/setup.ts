/**
 * A fresh scratch world per run: both data directories, the scratch site config (shared sign-in on, CalMind not held) and the
 * two shared-store accounts the specs sign in with. The teardown removes it, after checking that it is the directory this
 * harness made (a direct child of the real temp directory, named for this port, not a link).
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ACCOUNTS, DIR, PORT, phpEnv } from './port';
import { writeSite } from './site';

function removeScratch(): void {
  let st;
  try { st = lstatSync(DIR); } catch { return; }
  const real = realpathSync(DIR);
  if (st.isSymbolicLink() || dirname(real) !== realpathSync(tmpdir()) || !basename(real).startsWith(`calmind-shared-e2e-${PORT}`)) {
    throw new Error('refusing to remove an unexpected shared-login scratch directory');
  }
  rmSync(real, { recursive: true, force: true, maxRetries: 5 });
}

export default async function setup() {
  removeScratch();
  mkdirSync(join(DIR, 'calmind'), { recursive: true, mode: 0o700 });
  mkdirSync(join(DIR, 'site'), { recursive: true, mode: 0o700 });
  writeSite('on');
  const accounts = Object.entries(ACCOUNTS).map(([user, password]) => `${user}:${password}`);
  execFileSync('php', [join(__dirname, 'seed.php'), ...accounts], { env: { ...process.env, ...phpEnv() }, stdio: 'inherit' });
  return async () => { removeScratch(); };
}
