import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { php, phpArgs } from './php-runtime.mjs';
export const root = fileURLToPath(new URL('..', import.meta.url));
export const password = 'taskmind-test-only';
// A disposable server: a copy of the site's account library with its own config (three accounts: alex and sam are the seed team,
// outsider is an account that is not on it), a temporary data directory and session directory. Nothing of the real site is read
// but the library's code, and nothing leaves localhost.
export async function fixture(port) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'taskmind-test-'));
  const auth = path.join(dir, 'auth');
  const source = process.env.TASKMIND_TEST_SITE_LIB || path.resolve(root, '../seancheren-site/lib');
  await cp(source, auth, { recursive: true, filter: src => !/config(?:\.[^/\\]*)?\.php$/.test(src) });
  await mkdir(path.join(dir, 'sessions'));
  const hash = spawnSync(php, [...phpArgs, '-r', 'echo password_hash($argv[1], PASSWORD_DEFAULT);', password], { encoding: 'utf8' });
  if (hash.status !== 0) throw new Error('Could not create test password hash.');
  const quote = value => "'" + value.replaceAll('\\', '/').replaceAll("'", "\\'") + "'";
  await writeFile(path.join(auth, 'config.php'), `<?php return ['users'=>['alex'=>${quote(hash.stdout)},'sam'=>${quote(hash.stdout)},'outsider'=>${quote(hash.stdout)}],'taskmind_owners'=>['alex'],'taskmind_seed_admin'=>'sam','data_dir'=>${quote(path.join(dir, 'accounts'))},'data_key'=>'disposable-fixture-key','timezone'=>'America/Chicago','base'=>'','session_name'=>'TASKMIND_TEST'];`);
  const server = spawn(php, [...phpArgs, '-d', `session.save_path=${path.join(dir, 'sessions')}`, '-S', `127.0.0.1:${port}`, '-t', path.join(root, 'dist/public')], {
    cwd: root, env: { ...process.env, TASKMIND_SITE_LIB: auth, TASKMIND_DATA_DIR: path.join(dir, 'workspace'), TASKMIND_LIB_DIR: path.join(root, 'server/lib') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = ''; server.stderr.on('data', data => { diagnostics += data; });
  const url = `http://127.0.0.1:${port}/TaskMind/`;
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw new Error(diagnostics);
    try { const response = await fetch(url); if (response.ok) return { server, dir, url, diagnostics: () => diagnostics }; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  server.kill(); throw new Error('Preview failed to start: ' + diagnostics);
}
