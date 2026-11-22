// tools/mindsuite-release.mjs against disposable repositories: a bare "origin" and clones of it in
// a temp folder, git with no user or system config, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  NOTES, STATE, checkTag, insertEntry, main, nextMinor, publish, record, tagVersion, init,
} from './mindsuite-release.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'mindsuite-release.mjs');
const ENV = { ...process.env };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete ENV[key];
Object.assign(ENV, {
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
});

const APPS = {
  CalMind: { repo: 'MindSuite', tag: 'CalMind/2.0.0' },
  PlanMind: { repo: 'MindSuite', tag: 'PlanMind/1.0.0' },
  DisplayMind: { repo: 'DisplayMind', tag: 'v1.0.0' },
};
const STATE_1 = { version: '1.0.0', apps: APPS };
const DATE = '2026-11-22';

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function put(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

/** origin.git with one commit on main, and a clone `work` of it. */
function fixture(t, files = { 'README.md': 'suite\n' }) {
  const dir = mkdtempSync(join(tmpdir(), 'mindsuite-release-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origin = join(dir, 'origin.git');
  git(dir, 'init', '--quiet', '--bare', '-b', 'main', origin);
  const seed = join(dir, 'seed');
  git(dir, 'init', '--quiet', '-b', 'main', seed);
  for (const [rel, text] of Object.entries(files)) put(seed, rel, text);
  git(seed, 'add', '-A');
  git(seed, 'commit', '--quiet', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '--quiet', 'origin', 'main');
  const work = join(dir, 'work');
  git(dir, 'clone', '--quiet', origin, work);
  return { dir, origin, work, seed };
}

function run(repo, args, logs = []) {
  return main([...args, '--repo', repo, '--date', DATE], { env: ENV, log: (m) => logs.push(m) });
}

function initArgs() {
  return ['init', '1.0.0', 'CalMind=MindSuite:CalMind/2.0.0', 'PlanMind=MindSuite:PlanMind/1.0.0',
    'DisplayMind=DisplayMind:v1.0.0'];
}

test('tag shapes and versions', () => {
  assert.equal(tagVersion('CalMind/2.1.0'), '2.1.0');
  assert.equal(tagVersion('v1.4.0'), '1.4.0');
  assert.equal(tagVersion('1.4.0'), '1.4.0');
  assert.throws(() => tagVersion('CalMind/legacy/1.0.0'));
  assert.equal(checkTag('CalMind', APPS.CalMind, 'CalMind/2.1.0'), '2.1.0');
  assert.throws(() => checkTag('CalMind', APPS.CalMind, 'PlanMind/2.1.0'), /CalMind\/x\.y\.z/);
  assert.throws(() => checkTag('DisplayMind', APPS.DisplayMind, 'DisplayMind/1.1.0'), /no prefix/);
});

test('the next minor skips versions whose tag already exists', () => {
  assert.equal(nextMinor('1.0.0'), '1.1.0');
  assert.equal(nextMinor('1.4.0', new Set(['1.5.0', '1.6.0'])), '1.7.0');
  assert.equal(nextMinor('1.9.2'), '1.10.0');
});

test('record bumps the minor, names the matching tag and lists the suite', () => {
  const first = init(null, null, { version: '1.0.0', apps: APPS, date: DATE, intro: 'First.' });
  const r = record(first.state, first.notes, { app: 'CalMind', tag: 'CalMind/2.1.0', date: '2026-11-23' });
  assert.equal(r.state.version, '1.1.0');
  assert.equal(r.state.apps.CalMind.tag, 'CalMind/2.1.0');
  assert.equal(r.state.apps.PlanMind.tag, 'PlanMind/1.0.0');
  assert.equal(r.message, 'MindSuite 1.1.0: CalMind/2.1.0');
  assert.match(r.notes, /## MindSuite 1\.1\.0 \(2026-11-23\)\n\nMatches CalMind 2\.1\.0: `CalMind\/2\.1\.0`\.\n\nSuite: CalMind 2\.1\.0 · PlanMind 1\.0\.0 · DisplayMind 1\.0\.0\./);
  assert.ok(r.notes.indexOf('## MindSuite 1.1.0') < r.notes.indexOf('## MindSuite 1.0.0'), 'newest entry first');
  assert.match(r.notes, /\| DisplayMind \| 1\.0\.0 \| `v1\.0\.0` \(DisplayMind repo\) \|/);
  const ext = record(r.state, r.notes, { app: 'DisplayMind', tag: 'v1.1.0', date: '2026-11-24' });
  assert.equal(ext.message, 'MindSuite 1.2.0: v1.1.0 (DisplayMind)');
  assert.match(ext.notes, /Matches DisplayMind 1\.1\.0: `v1\.1\.0` \(DisplayMind repo\)\./);
});

test('record refuses what it cannot name and skips what it already names', () => {
  assert.equal(record(null, null, { app: 'CalMind', tag: 'CalMind/2.1.0', date: DATE }), null);
  assert.equal(record(STATE_1, '', { app: 'CalMind', tag: 'CalMind/2.0.0', date: DATE }), null);
  assert.throws(() => record(STATE_1, '', { app: 'HomeMind', tag: 'v1.0.0', date: DATE }), /not a MindSuite app/);
  assert.throws(() => record(STATE_1, '', { app: 'CalMind', tag: 'CalMind/1.9.0', date: DATE }), /not newer/);
  assert.throws(() => init(STATE_1, '', { version: '2.0.0', apps: APPS, date: DATE, intro: 'x' }), /already has a version/);
});

test('insertEntry keeps the head and puts the new entry first', () => {
  const a = insertEntry(null, '## MindSuite 1.0.0 (d)\n\nA.\n');
  const b = insertEntry(a, '## MindSuite 1.1.0 (d)\n\nB.\n');
  assert.ok(b.startsWith('# MindSuite releases\n'));
  assert.ok(b.indexOf('## MindSuite 1.1.0') < b.indexOf('## MindSuite 1.0.0'));
  assert.equal(b.match(/## MindSuite/g).length, 2);
  assert.equal(insertEntry(b, '## MindSuite 1.2.0 (d)\n\nC.\n').match(/\n\n\n/g), null, 'no blank-line pile-up');
  assert.throws(() => insertEntry('# no marker\n', 'x'), /marker/);
});

test('init then record publish to origin, tag annotated, and fast-forward a clean checkout', (t) => {
  const { origin, work } = fixture(t);
  put(work, 'README.md', 'someone else is editing this\n');   // unstaged work in the checkout
  put(work, 'scratch.txt', 'untracked\n');
  const logs = [];
  const one = run(work, initArgs(), logs);
  assert.equal(one.tag, 'MindSuite/1.0.0');
  assert.equal(git(origin, 'rev-parse', 'main'), one.commit);
  assert.equal(git(origin, 'cat-file', '-t', 'MindSuite/1.0.0'), 'tag');
  assert.equal(git(origin, 'rev-parse', 'MindSuite/1.0.0^{commit}'), one.commit);
  assert.equal(git(work, 'rev-parse', 'HEAD'), one.commit, 'checkout fast-forwarded');
  assert.equal(readFileSync(join(work, 'README.md'), 'utf8'), 'someone else is editing this\n', 'unstaged edit kept');
  assert.equal(readFileSync(join(work, 'scratch.txt'), 'utf8'), 'untracked\n');
  assert.equal(JSON.parse(readFileSync(join(work, STATE), 'utf8')).version, '1.0.0');

  const two = run(work, ['record', 'CalMind', 'CalMind/2.1.0', '--no-push'], logs);
  assert.equal(two.state.version, '1.1.0');
  assert.equal(git(origin, 'rev-parse', 'main'), one.commit, '--no-push leaves origin alone');
  git(work, 'tag', '-d', 'MindSuite/1.1.0');

  git(work, 'tag', '-a', 'CalMind/2.1.0', '-m', 'CalMind 2.1.0');
  git(work, 'push', '--quiet', 'origin', 'refs/tags/CalMind/2.1.0');
  const three = run(work, ['record', 'CalMind', 'CalMind/2.1.0'], logs);
  assert.equal(three.tag, 'MindSuite/1.1.0');
  assert.equal(git(origin, 'log', '-1', '--format=%s', 'main'), 'MindSuite 1.1.0: CalMind/2.1.0');
  assert.equal(git(origin, 'rev-parse', 'main^'), one.commit);
  const notes = git(origin, 'show', `main:${NOTES}`);
  assert.ok(notes.indexOf('## MindSuite 1.1.0') < notes.indexOf('## MindSuite 1.0.0'));
  assert.equal(run(work, ['record', 'CalMind', 'CalMind/2.1.0'], logs), null, 'a second record is a no-op');
  assert.equal(git(origin, 'rev-parse', 'main'), three.commit);
});

test('record refuses an app tag that is not on its origin', (t) => {
  const { work } = fixture(t);
  run(work, initArgs());
  assert.throws(() => run(work, ['record', 'CalMind', 'CalMind/2.1.0']), /not on CalMind's origin/);
});

test('an app in its own repo is checked against that repo\'s origin', (t) => {
  const suite = fixture(t);
  const app = fixture(t, { 'VERSION': '1.1.0\n' });
  run(suite.work, initArgs());
  git(app.work, 'tag', '-a', 'v1.1.0', '-m', 'DisplayMind 1.1.0');
  assert.throws(() => run(suite.work, ['record', 'DisplayMind', 'v1.1.0', '--app-repo', app.work]), /not on DisplayMind's origin/);
  git(app.work, 'push', '--quiet', 'origin', 'refs/tags/v1.1.0');
  const r = run(suite.work, ['record', 'DisplayMind', 'v1.1.0', '--app-repo', app.work]);
  assert.equal(r.state.version, '1.1.0');
  assert.equal(git(suite.origin, 'log', '-1', '--format=%s', 'main'), 'MindSuite 1.1.0: v1.1.0 (DisplayMind)');
});

test('without a MindSuite version an app release records nothing', (t) => {
  const { origin, work } = fixture(t);
  git(work, 'tag', '-a', 'CalMind/1.78.0', '-m', 'x');
  git(work, 'push', '--quiet', 'origin', 'refs/tags/CalMind/1.78.0');
  const before = git(origin, 'rev-parse', 'main');
  const logs = [];
  assert.equal(run(work, ['record', 'CalMind', 'CalMind/1.78.0'], logs), null);
  assert.equal(git(origin, 'rev-parse', 'main'), before);
  assert.match(logs.join('\n'), /no version yet/);
});

test('a push race is retried from the new tip and a taken version is skipped', (t) => {
  const { origin, work, seed } = fixture(t);
  run(work, initArgs());
  git(seed, 'pull', '--quiet', 'origin', 'main');
  // An aborted run once pushed the MindSuite/1.1.0 tag without its commit.
  git(seed, 'tag', '-a', 'MindSuite/1.1.0', '-m', 'stray');
  git(seed, 'push', '--quiet', 'origin', 'refs/tags/MindSuite/1.1.0');
  let raced = false;
  const logs = [];
  const out = publish({
    repo: work, env: ENV, log: (m) => logs.push(m),
    change: (state, notes, taken) => {
      if (!raced) {          // someone else moves main after our fetch
        raced = true;
        put(seed, 'other.txt', 'x\n');
        git(seed, 'add', 'other.txt');
        git(seed, 'commit', '--quiet', '-m', 'other');
        git(seed, 'push', '--quiet', 'origin', 'main');
      }
      return record(state, notes, { app: 'PlanMind', tag: 'PlanMind/1.1.0', date: DATE, taken });
    },
  });
  assert.equal(out.state.version, '1.2.0');
  assert.match(logs.join('\n'), /push refused \(attempt 1\/3\)/);
  assert.equal(git(origin, 'log', '-1', '--format=%s', 'main^'), 'other');
  assert.equal(git(origin, 'show', 'main:other.txt'), 'x');
  assert.equal(git(work, 'tag', '--list', 'MindSuite/1.2.0'), 'MindSuite/1.2.0');
});

test('staged work in any checkout of main keeps local main where it is', (t) => {
  const { origin, work } = fixture(t);
  put(work, 'README.md', 'staged by someone\n');
  git(work, 'add', 'README.md');
  const before = git(work, 'rev-parse', 'HEAD');
  const logs = [];
  run(work, initArgs(), logs);
  assert.equal(git(work, 'rev-parse', 'refs/heads/main'), before);
  assert.notEqual(git(origin, 'rev-parse', 'main'), before);
  assert.match(logs.join('\n'), /has staged work; left local main/);
  assert.equal(git(work, 'diff', '--cached', '--name-only'), 'README.md', 'their staged work untouched');
});

test('every clean checkout of main follows it; one left behind by an earlier release stays as it was', (t) => {
  const { dir, origin, work } = fixture(t);
  const second = join(dir, 'second');
  git(work, 'worktree', 'add', '--quiet', '--force', second, 'main');   // main checked out twice, as in a release worktree
  put(second, 'notes.txt', 'unstaged edit in the second checkout\n');
  const logs = [];
  const one = run(work, initArgs(), logs);
  for (const w of [work, second]) {
    assert.equal(git(w, 'rev-parse', 'HEAD'), one.commit);
    assert.equal(git(w, 'status', '--porcelain', '--untracked-files=no'), '', `${w} has no reversals`);
    assert.equal(JSON.parse(readFileSync(join(w, STATE), 'utf8')).version, '1.0.0');
  }
  assert.equal(readFileSync(join(second, 'notes.txt'), 'utf8'), 'unstaged edit in the second checkout\n');
  // A release made in `second` moves main under `work`, whose index stays at the old tip.
  const staleTree = git(work, 'write-tree');
  put(second, 'app.txt', 'v2\n');
  git(second, 'add', 'app.txt');
  git(second, 'commit', '--quiet', '-m', 'app 2');
  git(second, 'push', '--quiet', 'origin', 'main');
  git(second, 'tag', '-a', 'CalMind/2.1.0', '-m', 'x');
  git(second, 'push', '--quiet', 'origin', 'refs/tags/CalMind/2.1.0');
  const two = run(second, ['record', 'CalMind', 'CalMind/2.1.0'], logs);
  assert.equal(git(second, 'rev-parse', 'HEAD'), two.commit);
  assert.equal(git(second, 'status', '--porcelain', '--untracked-files=no'), '');
  assert.equal(git(work, 'write-tree'), staleTree, 'the stale checkout keeps exactly its index');
  assert.match(logs.join('\n'), /already behind its HEAD/);
  assert.equal(git(origin, 'rev-parse', 'main'), two.commit);
});

test('local commits origin lacks keep local main where it is', (t) => {
  const { origin, work } = fixture(t);
  put(work, 'mine.txt', 'unpushed\n');
  git(work, 'add', 'mine.txt');
  git(work, 'commit', '--quiet', '-m', 'unpushed');
  const mine = git(work, 'rev-parse', 'HEAD');
  const logs = [];
  const one = run(work, initArgs(), logs);
  assert.equal(git(work, 'rev-parse', 'HEAD'), mine, 'never rebased or moved');
  assert.equal(git(origin, 'rev-parse', 'main'), one.commit);
  assert.equal(git(origin, 'rev-parse', 'main^'), git(work, 'rev-parse', 'HEAD^'), 'the unpushed commit was not pushed');
  assert.match(logs.join('\n'), /local main has commits origin\/main lacks/);
});

test('check validates the recorded state, and the CLI runs as a script', (t) => {
  const { work } = fixture(t);
  run(work, initArgs());
  const logs = [];
  const state = run(work, ['check'], logs);
  assert.equal(state.version, '1.0.0');
  assert.match(logs[0], /MindSuite 1\.0\.0: CalMind 2\.0\.0 · PlanMind 1\.0\.0 · DisplayMind 1\.0\.0/);
  const r = spawnSync(process.execPath, [SCRIPT, 'check', '--repo', work], { env: ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /MindSuite 1\.0\.0/);
  const bad = spawnSync(process.execPath, [SCRIPT, 'record', 'CalMind'], { env: ENV, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /usage/);
});
