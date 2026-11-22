import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APPS, REGISTRY, SPACE_APPS, SUITE_ROOT, appIdProblems } from './check-app-ids.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-app-ids.mjs');
const FILES = [REGISTRY, SPACE_APPS, ...APPS.flatMap((a) => [a.appJson, a.tauri])];

/** A disposable suite root holding copies of the real files the check reads. */
function suite(t) {
  const root = mkdtempSync(join(tmpdir(), 'check-app-ids-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const rel of FILES) {
    const to = join(root, ...rel.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(SUITE_ROOT, ...rel.split('/')), to);
  }
  const edit = (rel, fn) => {
    const abs = join(root, ...rel.split('/'));
    const before = readFileSync(abs, 'utf8');
    const after = fn(before);
    assert.notEqual(after, before, `the fixture edit changed nothing in ${rel}`);
    writeFileSync(abs, after);
  };
  const editJson = (rel, fn) => edit(rel, (s) => { const j = JSON.parse(s); fn(j); return `${JSON.stringify(j, null, 2)}\n`; });
  return { root, edit, editJson };
}

const meal = APPS.find((a) => a.app === 'MealMind');

test('the checked-in ids agree', () => {
  assert.deepEqual(appIdProblems(), []);
});

test('the command exits 0 on the checked-in tree and 1 on a broken one', (t) => {
  const ok = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const s = suite(t);
  mkdirSync(join(s.root, 'tools'), { recursive: true });
  copyFileSync(SCRIPT, join(s.root, 'tools', 'check-app-ids.mjs'));
  s.editJson(meal.appJson, (j) => { j.expo.slug = 'nosuchapp'; });
  const bad = spawnSync(process.execPath, [join(s.root, 'tools', 'check-app-ids.mjs')], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /expo\.slug 'nosuchapp' is not a client/);
});

test('a slug that is not a registry client is reported (and the client nothing signs in as)', (t) => {
  const s = suite(t);
  s.editJson(meal.appJson, (j) => { j.expo.slug = 'nosuchapp'; });
  const p = appIdProblems(s.root);
  assert.ok(p.some((x) => /MealMind: expo\.slug 'nosuchapp' is not a client/.test(x)), p.join('\n'));
  assert.ok(p.some((x) => /is no app's expo\.slug/.test(x)), p.join('\n'));
});

test('a scheme that is not the registry client\'s scheme is reported', (t) => {
  const s = suite(t);
  s.edit(REGISTRY, (txt) => txt.replace(/('scheme' => ')com\.seancheren\.mealmind(')/, '$1com.seancheren.nosuchapp$2'));
  const p = appIdProblems(s.root);
  assert.ok(p.some((x) => /MealMind: expo\.scheme '.*' is not the registry's scheme 'com\.seancheren\.nosuchapp'/.test(x)), p.join('\n'));
});

test('a bundle id, package or desktop identifier off the scheme is reported', (t) => {
  const s = suite(t);
  s.editJson(meal.appJson, (j) => { j.expo.ios.bundleIdentifier = 'com.seancheren.nosuchapp'; j.expo.android.package = 'com.seancheren.nosuchapp'; });
  s.editJson(meal.tauri, (j) => { j.identifier = 'com.seancheren.nosuchapp.desktop'; });
  const p = appIdProblems(s.root);
  assert.ok(p.some((x) => /MealMind: ios\.bundleIdentifier/.test(x)), p.join('\n'));
  assert.ok(p.some((x) => /MealMind: android\.package/.test(x)), p.join('\n'));
  assert.ok(p.some((x) => /MealMind: .*tauri\.conf\.json identifier/.test(x)), p.join('\n'));
});

test('a SUITE_SPACE_APPS app that is not a registry client is reported', (t) => {
  const s = suite(t);
  s.edit(SPACE_APPS, (txt) => txt.replace(/^(const SUITE_SPACE_APPS = \['chef' => ')[^']*(')/m, '$1nosuchapp$2'));
  const p = appIdProblems(s.root);
  assert.deepEqual(p, [`${SPACE_APPS}: SUITE_SPACE_APPS maps space 'chef' to 'nosuchapp', which is not a client in ${REGISTRY}`]);
});

test('a constant it cannot read exactly fails closed', (t) => {
  const s = suite(t);
  s.edit(SPACE_APPS, (txt) => txt.replace(/^const SUITE_SPACE_APPS = \[/m, 'const SUITE_SPACE_APPS = [/* x */ '));
  assert.throws(() => appIdProblems(s.root), /SUITE_SPACE_APPS holds something this check cannot read/);
  const r = suite(t);
  r.edit(REGISTRY, (txt) => txt.replace(/^const MSA_APP_SIGNIN_CLIENTS = /m, 'const MSA_APP_SIGNIN_CLIENT_LIST = '));
  assert.throws(() => appIdProblems(r.root), /expected one "const MSA_APP_SIGNIN_CLIENTS/);
});
