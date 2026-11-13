import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { php, phpArgs } from './php-runtime.mjs';
export const root = fileURLToPath(new URL('..', import.meta.url));
export const password = 'planmind-test-only';
/** The site's auth library: PLANMIND_TEST_SITE_LIB, else a seancheren-site checkout beside PlanMind (standalone) or beside the MindSuite monorepo that holds PlanMind. */
export function siteLib() {
  if (process.env.PLANMIND_TEST_SITE_LIB) return process.env.PLANMIND_TEST_SITE_LIB;
  const candidates = [path.resolve(root, '../seancheren-site/lib'), path.resolve(root, '../../seancheren-site/lib')];
  return candidates.find(c => existsSync(path.join(c, 'auth.php'))) ?? candidates[0];
}
/** The two accounts the fixtures are written for, as the config's `people` names them: the v2 store fixture's person lists (order 0 the partner's, 1 the owner's), as server/tools/fixture-people.php reads them. */
export function fixturePeople() {
  const store = JSON.parse(readFileSync(path.join(root, 'server/tools/fixtures/v2-store.json'), 'utf8'));
  const [partner, owner] = Object.values(store.lists).filter(list => list.kind === 'person').sort((a, b) => a.order - b.order);
  return { owner: owner.id, partner: partner.id };
}
export async function fixture(port) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'planmind-test-'));
  const auth = path.join(dir, 'auth');
  const source = siteLib();
  await cp(source, auth, { recursive: true, filter: src => !/config(?:\.[^/\\]*)?\.php$/.test(src) });
  await mkdir(path.join(dir, 'sessions'));
  // CalMind's store for the Day's CalMind events: the run's own directory when one is named (e2e/calmind.spec.ts writes it), else an empty one.
  const calmind = process.env.PLANMIND_CALMIND_DIR || path.join(dir, 'calmind');
  await mkdir(calmind, { recursive: true });
  const hash = spawnSync(php, [...phpArgs, '-r', 'echo password_hash($argv[1], PASSWORD_DEFAULT);', password], { encoding: 'utf8' });
  if (hash.status !== 0) throw new Error('Could not create test password hash.');
  const quote = value => "'" + value.replaceAll('\\', '/').replaceAll("'", "\\'") + "'";
  const people = fixturePeople();
  await writeFile(path.join(auth, 'config.php'), `<?php return ['users'=>[${quote(people.owner)}=>${quote(hash.stdout)},${quote(people.partner)}=>${quote(hash.stdout)},'outsider'=>${quote(hash.stdout)}],'people'=>['owner'=>${quote(people.owner)},'partner'=>${quote(people.partner)}],'data_dir'=>${quote(path.join(dir, 'accounts'))},'data_key'=>'disposable-fixture-key','timezone'=>'America/Chicago','base'=>'','session_name'=>'PLANMIND_TEST'];`);
  const server = spawn(php, [...phpArgs, '-d', `session.save_path=${path.join(dir, 'sessions')}`, '-S', `127.0.0.1:${port}`, '-t', path.join(root, 'dist/public')], {
    cwd: root, env: { ...process.env, PLANMIND_SITE_LIB: auth, PLANMIND_DATA_DIR: path.join(dir, 'planner'), PLANMIND_LIB_DIR: path.join(root, 'server/lib'), PLANMIND_CALMIND_DIR: calmind }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = ''; server.stderr.on('data', data => { diagnostics += data; });
  const url = `http://127.0.0.1:${port}/PlanMind/`;
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw new Error(diagnostics);
    try { const response = await fetch(url); if (response.ok) return { server, dir, url, diagnostics: () => diagnostics }; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  server.kill(); throw new Error('Preview failed to start: ' + diagnostics);
}
