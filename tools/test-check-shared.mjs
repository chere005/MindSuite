import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import path, { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nativePath, pathProblem, validateManifest } from './check-shared.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-shared.mjs');
const POSIX_ONLY = { skip: process.platform === 'win32' };

// A git that reads no user or system configuration and no ambient repository.
const CLEAN_ENV = { ...process.env };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'SHARED_FILES', 'MIND_SITE_DIR']) delete CLEAN_ENV[key];
Object.assign(CLEAN_ENV, {
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
});

const SAME = 'export const a = 1;\n';
const BASIC = {
  version: 1,
  groups: [
    { id: 'alpha', origin: 'CalMind/lib/a.ts', copies: ['ChefMind/lib/a.ts', 'PlanMind/lib/a.ts'], note: 'first' },
    { id: 'beta', origin: 'CalMind/lib/b.ts', copies: ['ChefMind/lib/b.ts'] },
  ],
};
const BASIC_FILES = {
  'CalMind/lib/a.ts': SAME,
  'ChefMind/lib/a.ts': SAME,
  'PlanMind/lib/a.ts': SAME,
  'CalMind/lib/b.ts': 'b\n',
  'ChefMind/lib/b.ts': 'b\n',
};

function put(root, rel, content) {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function sh(cwd, command, args, env = CLEAN_ENV) {
  const r = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `${command} ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/**
 * A disposable suite: <tmp>/suite (a copy of the checker under tools/, the manifest and `files`),
 * with <tmp> as the place where sibling checkouts live. `git` makes the suite a repository with
 * everything committed.
 */
function makeSuite(t, { files = BASIC_FILES, manifest = BASIC, git = false } = {}) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'check-shared-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'suite');
  mkdirSync(join(root, 'tools'), { recursive: true });
  copyFileSync(SCRIPT, join(root, 'tools', 'check-shared.mjs'));
  if (manifest !== null) writeFileSync(join(root, 'tools', 'shared-files.json'), typeof manifest === 'string' ? manifest : `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [rel, content] of Object.entries(files)) put(root, rel, content);
  const suite = {
    parent,
    root,
    read: (rel) => readFileSync(join(root, ...rel.split('/')), 'utf8'),
    put: (rel, content) => put(root, rel, content),
    git: (...args) => sh(root, 'git', ['-c', 'commit.gpgsign=false', ...args]),
    commit: () => { suite.git('add', '-A'); suite.git('commit', '-q', '-m', 'fixture'); },
    run(args = [], { env = {}, cwd = parent, replaceEnv = false } = {}) {
      const r = spawnSync(process.execPath, [join(root, 'tools', 'check-shared.mjs'), ...args], {
        cwd, encoding: 'utf8', env: replaceEnv ? env : { ...CLEAN_ENV, ...env },
      });
      const lines = r.stdout.split('\n').filter((l) => l !== '');
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, lines, last: lines.at(-1) };
    },
  };
  if (git) {
    suite.git('init', '-q');
    suite.commit();
  }
  return suite;
}

function flipFirstByte(suite, rel) {
  const abs = join(suite.root, ...rel.split('/'));
  const bytes = readFileSync(abs);
  bytes[0] ^= 0x01;
  writeFileSync(abs, bytes);
}

// -------------------------------------------------------------------------------------------
// Compare mode
// -------------------------------------------------------------------------------------------

test('match: identical copies pass and the last line is the summary', (t) => {
  const s = makeSuite(t);
  const r = s.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.lines.includes('compared 3 file(s)'), r.stdout);
  assert.equal(r.last, '2 group(s): 0 drifted, 0 failures');
  assert.equal(r.stderr, '');
});

test('the root comes from the script location, not the working directory', (t) => {
  const s = makeSuite(t);
  assert.equal(s.run([], { cwd: tmpdir() }).status, 0);
  assert.equal(s.run([], { cwd: join(s.root, 'CalMind') }).status, 0);
});

test('drift: one changed byte fails and names the copy and its origin', (t) => {
  const s = makeSuite(t);
  flipFirstByte(s, 'ChefMind/lib/a.ts');
  const r = s.run();
  assert.equal(r.status, 1);
  assert.ok(r.lines.includes('FAIL drift alpha: ChefMind/lib/a.ts differs from CalMind/lib/a.ts'), r.stdout);
  assert.ok(r.lines.includes('compared 3 file(s)'), r.stdout);
  assert.equal(r.last, '2 group(s): 1 drifted, 1 failures');
});

test('drift: a missing trailing newline and a CRLF are drift too', (t) => {
  const s = makeSuite(t);
  s.put('ChefMind/lib/a.ts', 'export const a = 1;');
  s.put('PlanMind/lib/a.ts', 'export const a = 1;\r\n');
  const r = s.run();
  assert.equal(r.status, 1);
  assert.equal(r.last, '2 group(s): 2 drifted, 2 failures');
});

test('a missing copy fails and is not counted as compared', (t) => {
  const s = makeSuite(t);
  rmSync(join(s.root, 'PlanMind', 'lib', 'a.ts'));
  const r = s.run();
  assert.equal(r.status, 1);
  assert.ok(r.lines.includes('FAIL missing alpha: PlanMind/lib/a.ts is gone'), r.stdout);
  assert.ok(r.lines.includes('compared 2 file(s)'), r.stdout);
  assert.equal(r.last, '2 group(s): 0 drifted, 1 failures');
});

test('a missing origin fails once and its copies are not compared', (t) => {
  const s = makeSuite(t);
  rmSync(join(s.root, 'CalMind', 'lib', 'b.ts'));
  const r = s.run();
  assert.equal(r.status, 1);
  assert.ok(r.lines.includes('FAIL missing beta: origin CalMind/lib/b.ts is gone'), r.stdout);
  assert.ok(r.lines.includes('compared 2 file(s)'), r.stdout);
  assert.equal(r.last, '2 group(s): 0 drifted, 1 failures');
});

test('a directory in place of a file fails', (t) => {
  const s = makeSuite(t);
  rmSync(join(s.root, 'ChefMind', 'lib', 'b.ts'));
  mkdirSync(join(s.root, 'ChefMind', 'lib', 'b.ts'));
  const r = s.run();
  assert.equal(r.status, 1);
  assert.ok(r.lines.some((l) => l.startsWith('FAIL invalid beta: ChefMind/lib/b.ts')), r.stdout);
});

test('a symlink in place of a copy fails, even one that points at identical bytes', POSIX_ONLY, (t) => {
  const s = makeSuite(t);
  rmSync(join(s.root, 'ChefMind', 'lib', 'b.ts'));
  symlinkSync(join(s.root, 'CalMind', 'lib', 'b.ts'), join(s.root, 'ChefMind', 'lib', 'b.ts'));
  const r = s.run();
  assert.equal(r.status, 1);
  assert.ok(r.lines.some((l) => l.startsWith('FAIL invalid beta: ChefMind/lib/b.ts')), r.stdout);
});

test('zero files compared is a failure: no groups', (t) => {
  const s = makeSuite(t, { manifest: { version: 1, groups: [] } });
  const r = s.run();
  assert.equal(r.status, 1);
  assert.ok(r.lines.includes('compared 0 file(s)'), r.stdout);
  assert.ok(r.lines.includes('FAIL nothing checked: no file was compared'), r.stdout);
  assert.equal(r.last, '0 group(s): 0 drifted, 1 failures');
});

test('zero files compared is a failure: every file gone', (t) => {
  const s = makeSuite(t, { files: {} });
  const r = s.run();
  assert.equal(r.status, 1);
  assert.ok(r.lines.includes('compared 0 file(s)'), r.stdout);
  assert.ok(r.lines.includes('FAIL nothing checked: no file was compared'), r.stdout);
  assert.match(r.last, /^2 group\(s\): 0 drifted, [1-9]\d* failures$/);
});

test('zero files compared is a failure: only a skipped external entry', (t) => {
  const manifest = { version: 1, groups: [], external: [{ id: 'site-lib', origin: 'CalMind/lib/a.ts', repo: 'seancheren-site', path: 'lib/a.ts' }] };
  const s = makeSuite(t, { manifest });
  const r = s.run(['--external']);
  assert.equal(r.status, 1);
  assert.ok(r.lines.includes(`external site-lib: skipped (no checkout at ${join(s.parent, 'seancheren-site')})`), r.stdout);
  assert.ok(r.lines.includes('FAIL nothing checked: no file was compared'), r.stdout);
});

// -------------------------------------------------------------------------------------------
// Schema
// -------------------------------------------------------------------------------------------

const g = (over = {}) => ({ id: 'one', origin: 'CalMind/x', copies: ['ChefMind/x'], ...over });
const INVALID = [
  ['wrong version', { version: 2, groups: [g()] }, '"version" must be 1'],
  ['no version', { groups: [g()] }, '"version" must be 1'],
  ['groups missing', { version: 1 }, '"groups" must be an array'],
  ['groups not an array', { version: 1, groups: {} }, '"groups" must be an array'],
  ['top-level not an object', [], 'manifest must be a JSON object'],
  ['unknown top-level key', { version: 1, groups: [g()], extra: 1 }, 'unknown key "extra"'],
  ['external not an array', { version: 1, groups: [g()], external: {} }, '"external" must be an array'],
  ['group not an object', { version: 1, groups: ['x'] }, 'groups[0] must be an object'],
  ['id not kebab', { version: 1, groups: [g({ id: 'Not_Kebab' })] }, 'must be a kebab-case string'],
  ['id missing', { version: 1, groups: [g({ id: undefined })] }, 'must be a kebab-case string'],
  ['duplicate ids', { version: 1, groups: [g(), g({ origin: 'A/y', copies: ['B/y'] })] }, 'is not unique'],
  ['origin missing', { version: 1, groups: [g({ origin: undefined })] }, 'groups[0].origin must be a non-empty string'],
  ['absolute origin', { version: 1, groups: [g({ origin: '/etc/hosts' })] }, 'groups[0].origin is absolute'],
  ['dot-dot in the middle', { version: 1, groups: [g({ origin: 'CalMind/../x' })] }, "has a '..' segment"],
  ['leading dot-dot', { version: 1, groups: [g({ copies: ['../outside'] })] }, "has a '..' segment"],
  ['backslash separator', { version: 1, groups: [g({ origin: 'CalMind\\x' })] }, "uses a backslash"],
  ['backslash dot-dot', { version: 1, groups: [g({ copies: ['..\\outside'] })] }, "uses a backslash"],
  ['drive letter', { version: 1, groups: [g({ origin: 'C:/x' })] }, 'starts with a drive letter'],
  ['drive letter without slash', { version: 1, groups: [g({ origin: 'C:x' })] }, 'starts with a drive letter'],
  ['dot segment', { version: 1, groups: [g({ origin: './x' })] }, "has a '.' segment"],
  ['trailing slash', { version: 1, groups: [g({ copies: ['ChefMind/x/'] })] }, 'empty segment'],
  ['double slash', { version: 1, groups: [g({ copies: ['ChefMind//x'] })] }, 'empty segment'],
  ['into .git', { version: 1, groups: [g({ copies: ['.git/config'] })] }, 'points into .git'],
  ['into .GIT', { version: 1, groups: [g({ copies: ['sub/.GIT/config'] })] }, 'points into .git'],
  ['control character', { version: 1, groups: [g({ copies: ['ChefMind/x\ny'] })] }, 'control character'],
  ['empty copies', { version: 1, groups: [g({ copies: [] })] }, 'copies must be a non-empty array'],
  ['copies not an array', { version: 1, groups: [g({ copies: 'ChefMind/x' })] }, 'copies must be a non-empty array'],
  ['copy not a string', { version: 1, groups: [g({ copies: [3] })] }, 'copies[0] must be a non-empty string'],
  ['origin among copies', { version: 1, groups: [g({ copies: ['ChefMind/x', 'CalMind/x'] })] }, 'is also one of its copies'],
  ['same copy twice', { version: 1, groups: [g({ copies: ['ChefMind/x', 'ChefMind/x'] })] }, 'more than once'],
  ['path in two groups', { version: 1, groups: [g(), g({ id: 'two', origin: 'CalMind/y' })] }, 'is in two groups'],
  ['origin of one is copy of another', { version: 1, groups: [g(), g({ id: 'two', origin: 'ChefMind/x', copies: ['PlanMind/x'] })] }, 'is in two groups'],
  ['unknown group key', { version: 1, groups: [g({ copy: ['x'] })] }, 'unknown key "copy"'],
  ['note not a string', { version: 1, groups: [g({ note: 7 })] }, 'note must be a string'],
  ['external without repo', { version: 1, groups: [g()], external: [{ id: 'e', origin: 'A/x', path: 'x' }] }, 'repo must be a single directory name'],
  ['external repo with a slash', { version: 1, groups: [g()], external: [{ id: 'e', origin: 'A/x', repo: 'a/b', path: 'x' }] }, 'repo must be a single directory name'],
  ['external repo dot-dot', { version: 1, groups: [g()], external: [{ id: 'e', origin: 'A/x', repo: '..', path: 'x' }] }, 'repo must be a single directory name'],
  ['external path escapes', { version: 1, groups: [g()], external: [{ id: 'e', origin: 'A/x', repo: 'site', path: '../x' }] }, "has a '..' segment"],
  ['external id clashes with a group', { version: 1, groups: [g()], external: [{ id: 'one', origin: 'A/x', repo: 'site', path: 'x' }] }, 'is not unique'],
  ['external repeated', { version: 1, groups: [g()], external: [{ id: 'e1', origin: 'A/x', repo: 'site', path: 'x' }, { id: 'e2', origin: 'A/y', repo: 'site', path: 'x' }] }, 'repeats site/x'],
  ['external unknown key', { version: 1, groups: [g()], external: [{ id: 'e', origin: 'A/x', repo: 'site', path: 'x', file: 1 }] }, 'unknown key "file"'],
];

for (const [name, manifest, fragment] of INVALID) {
  test(`schema: ${name} is refused before any file is compared`, (t) => {
    const s = makeSuite(t, { manifest });
    // Files exist and one is drifted: a comparison would show it.
    s.put('CalMind/x', 'a');
    s.put('ChefMind/x', 'b');
    const r = s.run(['--external']);
    assert.equal(r.status, 1, r.stdout);
    assert.ok(r.lines.some((l) => l.startsWith('FAIL schema: ') && l.includes(fragment)), `wanted "${fragment}" in:\n${r.stdout}`);
    assert.ok(!r.lines.some((l) => l.startsWith('compared ')), r.stdout);
    assert.match(r.last, /^0 group\(s\): 0 drifted, [1-9]\d* failures$/);
  });
}

test('schema: invalid JSON, an absent manifest and a BOM', (t) => {
  const broken = makeSuite(t, { manifest: '{ "version": 1, ' });
  const r = broken.run();
  assert.equal(r.status, 1);
  assert.ok(r.lines.some((l) => l.startsWith('FAIL schema: the manifest is not valid JSON')), r.stdout);
  assert.match(r.last, /^0 group\(s\): 0 drifted, 1 failures$/);

  const absent = makeSuite(t, { manifest: null });
  const a = absent.run();
  assert.equal(a.status, 1);
  assert.ok(a.lines.some((l) => l.startsWith('FAIL schema: cannot read the manifest')), a.stdout);

  const bom = makeSuite(t, { manifest: `\uFEFF${JSON.stringify(BASIC)}` });
  assert.equal(bom.run().status, 0);
});

test('schema: every problem is listed, one line each', (t) => {
  const s = makeSuite(t, { manifest: { version: 3, groups: [g({ id: 'BAD' }), g({ origin: '../x' })] } });
  const r = s.run();
  assert.equal(r.status, 1);
  const schema = r.lines.filter((l) => l.startsWith('FAIL schema: '));
  assert.ok(schema.length >= 3, r.stdout);
  assert.equal(r.last, `0 group(s): 0 drifted, ${schema.length} failures`);
});

test('pathProblem and validateManifest are POSIX-only and normalise nothing', () => {
  for (const ok of ['a', 'a/b.ts', 'CalMind/packages/core/src/x.ts', 'a b/c', '.hidden/x', 'a.git/x']) assert.equal(pathProblem(ok), null, ok);
  for (const bad of ['', 'a\\b', '..\\a', '/a', 'C:\\a', 'C:/a', 'a/../b', '../a', 'a/./b', 'a//b', 'a/', '.git/x', 'x/.git', 5, null, undefined]) {
    assert.notEqual(pathProblem(bad), null, String(bad));
  }
  const v = validateManifest(BASIC);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.groups.map((x) => x.id), ['alpha', 'beta']);
  assert.equal(v.groups[1].note, '');
});

test('JSON paths map to native paths segment by segment (Windows included)', () => {
  assert.equal(nativePath('/suite', 'CalMind/lib/a.ts', path.posix), '/suite/CalMind/lib/a.ts');
  assert.equal(nativePath('C:\\suite', 'CalMind/lib/a.ts', path.win32), 'C:\\suite\\CalMind\\lib\\a.ts');
});

test('the checker imports only node: built-ins', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  const specifiers = [...source.matchAll(/^\s*(?:import|\}\s*from)\b[^'"\n]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  const bare = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(bare.length >= 4, `found ${bare.length} imports`);
  for (const spec of new Set([...specifiers, ...bare])) assert.ok(spec.startsWith('node:'), `non-built-in import ${spec}`);
  assert.doesNotMatch(source, /\brequire\(|\bimport\(/);
});

// -------------------------------------------------------------------------------------------
// --app
// -------------------------------------------------------------------------------------------

test('--app compares only groups with a member under the directory', (t) => {
  const s = makeSuite(t);
  flipFirstByte(s, 'ChefMind/lib/b.ts'); // beta drifts; PlanMind is only in alpha
  const planmind = s.run(['--app', 'PlanMind']);
  assert.equal(planmind.status, 0, planmind.stdout);
  assert.ok(planmind.lines.includes('compared 2 file(s)'), planmind.stdout);
  assert.equal(planmind.last, '1 group(s): 0 drifted, 0 failures');

  const chefmind = s.run(['--app', 'ChefMind']);
  assert.equal(chefmind.status, 1);
  assert.equal(chefmind.last, '2 group(s): 1 drifted, 1 failures');

  const origin = s.run(['--app', 'CalMind']); // an origin directory selects its groups too
  assert.equal(origin.status, 1);
  assert.equal(origin.last, '2 group(s): 1 drifted, 1 failures');
});

test('--app accepts a trailing slash, --app=Dir, and a nested directory', (t) => {
  const s = makeSuite(t);
  for (const args of [['--app', 'PlanMind/'], ['--app=PlanMind'], ['--app', 'PlanMind/lib']]) {
    const r = s.run(args);
    assert.equal(r.status, 0, `${args}: ${r.stdout}${r.stderr}`);
    assert.equal(r.last, '1 group(s): 0 drifted, 0 failures');
  }
});

test('--app with an unknown directory exits 1 and names the valid ones', (t) => {
  const s = makeSuite(t);
  for (const bad of ['Nope', 'Cal', 'PlanMin', '', '..', '/', 'PlanMind\\lib']) {
    const r = s.run(['--app', bad]);
    assert.equal(r.status, 1, `"${bad}"`);
    assert.match(r.stderr, /directories with shared files: CalMind, ChefMind, PlanMind/, bad);
  }
  assert.equal(s.run(['--app']).status, 1);
});

test('unknown arguments exit 1; --help exits 0', (t) => {
  const s = makeSuite(t);
  for (const args of [['--nope'], ['extra'], ['--list=1'], ['--app', 'A', '--app', 'B']]) {
    const r = s.run(args);
    assert.equal(r.status, 1, String(args));
    assert.match(r.stderr, /check-shared:/);
  }
  const help = s.run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^usage: node tools\/check-shared\.mjs/);
});

// -------------------------------------------------------------------------------------------
// --external
// -------------------------------------------------------------------------------------------

const WITH_EXTERNAL = {
  ...BASIC,
  // The same origin may serve a group and an external entry.
  external: [{ id: 'site-lib', origin: 'CalMind/lib/a.ts', repo: 'seancheren-site', path: 'lib/a.ts', note: 'site copy' }],
};

test('--external is opt-in', (t) => {
  const s = makeSuite(t, { manifest: WITH_EXTERNAL });
  const r = s.run();
  assert.equal(r.status, 0, r.stdout);
  assert.ok(!r.stdout.includes('external'), r.stdout);
  assert.ok(r.lines.includes('compared 3 file(s)'), r.stdout);
});

test('--external skips an absent checkout without counting it as compared', (t) => {
  const s = makeSuite(t, { manifest: WITH_EXTERNAL });
  const r = s.run(['--external']);
  assert.equal(r.status, 0, r.stdout);
  assert.ok(r.lines.includes(`external site-lib: skipped (no checkout at ${join(s.parent, 'seancheren-site')})`), r.stdout);
  assert.ok(r.lines.includes('compared 3 file(s)'), r.stdout);
  assert.equal(r.last, '2 group(s): 0 drifted, 0 failures');
});

test('--external compares the sibling checkout and counts it', (t) => {
  const s = makeSuite(t, { manifest: WITH_EXTERNAL });
  mkdirSync(join(s.parent, 'seancheren-site', 'lib'), { recursive: true });
  writeFileSync(join(s.parent, 'seancheren-site', 'lib', 'a.ts'), SAME);
  const ok = s.run(['--external']);
  assert.equal(ok.status, 0, ok.stdout);
  assert.ok(ok.lines.includes('compared 4 file(s)'), ok.stdout);
  assert.ok(!ok.stdout.includes('skipped'), ok.stdout);

  writeFileSync(join(s.parent, 'seancheren-site', 'lib', 'a.ts'), `${SAME}// edited\n`);
  const bad = s.run(['--external']);
  assert.equal(bad.status, 1);
  assert.ok(bad.lines.includes('FAIL drift external site-lib: seancheren-site/lib/a.ts differs from CalMind/lib/a.ts'), bad.stdout);
  assert.equal(bad.last, '2 group(s): 1 drifted, 1 failures');
});

test('--external: a checkout that lacks the file fails', (t) => {
  const s = makeSuite(t, { manifest: WITH_EXTERNAL });
  mkdirSync(join(s.parent, 'seancheren-site'));
  const r = s.run(['--external']);
  assert.equal(r.status, 1);
  assert.ok(r.lines.includes('FAIL missing external site-lib: seancheren-site/lib/a.ts is gone'), r.stdout);
});

test('--external: MIND_SITE_DIR overrides the sibling directory', (t) => {
  const s = makeSuite(t, { manifest: WITH_EXTERNAL });
  mkdirSync(join(s.parent, 'seancheren-site', 'lib'), { recursive: true });
  writeFileSync(join(s.parent, 'seancheren-site', 'lib', 'a.ts'), 'a stale sibling\n');
  const elsewhere = join(s.parent, 'elsewhere');
  mkdirSync(join(elsewhere, 'lib'), { recursive: true });
  writeFileSync(join(elsewhere, 'lib', 'a.ts'), SAME);
  const r = s.run(['--external'], { env: { MIND_SITE_DIR: elsewhere } });
  assert.equal(r.status, 0, r.stdout);
  assert.ok(r.lines.includes('compared 4 file(s)'), r.stdout);

  const absent = s.run(['--external'], { env: { MIND_SITE_DIR: join(s.parent, 'nowhere') } });
  assert.equal(absent.status, 0, absent.stdout);
  assert.ok(absent.lines.includes(`external site-lib: skipped (no checkout at ${join(s.parent, 'nowhere')})`), absent.stdout);
});

test('--external follows --app by the external origin', (t) => {
  const s = makeSuite(t, { manifest: WITH_EXTERNAL });
  assert.ok(!s.run(['--external', '--app', 'PlanMind']).stdout.includes('external'));
  assert.ok(s.run(['--external', '--app', 'CalMind']).stdout.includes('external site-lib: skipped'));
});

// -------------------------------------------------------------------------------------------
// --list
// -------------------------------------------------------------------------------------------

test('--list prints the groups of a manifest passed through SHARED_FILES', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'check-shared-list-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify(WITH_EXTERNAL));
  // The real script against the real root: --list reads no shared file.
  const absolute = spawnSync(process.execPath, [SCRIPT, '--list'], { cwd: dir, encoding: 'utf8', env: { ...CLEAN_ENV, SHARED_FILES: join(dir, 'fixture.json') } });
  assert.equal(absolute.status, 0, absolute.stderr);
  assert.deepEqual(absolute.stdout.trimEnd().split('\n'), [
    'alpha: CalMind/lib/a.ts -> 2 copies (first)',
    '  ChefMind/lib/a.ts',
    '  PlanMind/lib/a.ts',
    'beta: CalMind/lib/b.ts -> 1 copy',
    '  ChefMind/lib/b.ts',
    'external site-lib: CalMind/lib/a.ts <-> seancheren-site/lib/a.ts (site copy)',
    '2 group(s), 1 external',
  ]);
  // A relative SHARED_FILES resolves against the working directory.
  const relative = spawnSync(process.execPath, [SCRIPT, '--list', '--app', 'PlanMind'], { cwd: dir, encoding: 'utf8', env: { ...CLEAN_ENV, SHARED_FILES: 'fixture.json' } });
  assert.equal(relative.status, 0, relative.stderr);
  assert.deepEqual(relative.stdout.trimEnd().split('\n'), ['alpha: CalMind/lib/a.ts -> 2 copies (first)', '  ChefMind/lib/a.ts', '  PlanMind/lib/a.ts', '1 group(s), 0 external']);
});

test('--list refuses an invalid manifest and SHARED_FILES redirects a compare run', (t) => {
  const s = makeSuite(t, { manifest: { version: 9, groups: [] } });
  const r = s.run(['--list']);
  assert.equal(r.status, 1);
  assert.ok(r.lines.some((l) => l.startsWith('FAIL schema: ')), r.stdout);

  writeFileSync(join(s.parent, 'other.json'), JSON.stringify(BASIC));
  const other = s.run([], { env: { SHARED_FILES: join(s.parent, 'other.json') } });
  assert.equal(other.status, 0, other.stdout);
  assert.equal(other.last, '2 group(s): 0 drifted, 0 failures');
});

// -------------------------------------------------------------------------------------------
// --fix
// -------------------------------------------------------------------------------------------

function drifted(t, extra = {}) {
  // Committed state already differs from the origin: ChefMind a drifts, PlanMind a is absent, b is fine.
  const files = { ...BASIC_FILES, 'ChefMind/lib/a.ts': 'old\n', ...extra };
  delete files['PlanMind/lib/a.ts'];
  return makeSuite(t, { files, git: true });
}

test('--fix all on a clean tree copies the origin over drifted and missing copies, and stages nothing', (t) => {
  const s = drifted(t);
  const head = s.git('rev-parse', 'HEAD');
  const r = s.run(['--fix', 'all']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.lines.includes('wrote ChefMind/lib/a.ts (from CalMind/lib/a.ts)'), r.stdout);
  assert.ok(r.lines.includes('wrote PlanMind/lib/a.ts (from CalMind/lib/a.ts)'), r.stdout);
  assert.equal(r.last, 'fix: 2 file(s) written, 1 already identical, 0 failure(s)');
  assert.equal(s.read('ChefMind/lib/a.ts'), SAME);
  assert.equal(s.read('PlanMind/lib/a.ts'), SAME);
  assert.equal(s.git('rev-parse', 'HEAD'), head, 'no commit');
  assert.equal(s.git('diff', '--cached', '--name-only'), '', 'nothing staged');
  assert.equal(s.run().status, 0, 'the compare run is green afterwards');
});

test('--fix <id> touches only that group', (t) => {
  const s = drifted(t, { 'ChefMind/lib/b.ts': 'also old\n' });
  const r = s.run(['--fix', 'alpha']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.read('ChefMind/lib/a.ts'), SAME);
  assert.equal(s.read('ChefMind/lib/b.ts'), 'also old\n');
  assert.equal(s.run(['--fix=beta']).status, 0);
  assert.equal(s.read('ChefMind/lib/b.ts'), 'b\n');
});

test('--fix with an unknown id exits 1 and lists the groups', (t) => {
  const s = drifted(t);
  const r = s.run(['--fix', 'gamma']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no group "gamma"; groups: alpha, beta/);
  assert.equal(s.read('ChefMind/lib/a.ts'), 'old\n');
});

test('--fix refuses a copy with an unstaged change and writes nothing', (t) => {
  const s = drifted(t);
  s.put('ChefMind/lib/b.ts', 'my work in progress\n');
  const r = s.run(['--fix', 'all']);
  assert.equal(r.status, 1);
  assert.ok(r.lines.some((l) => l.startsWith('FAIL refused: 1 copy path(s) have uncommitted changes')), r.stdout);
  assert.equal(s.read('ChefMind/lib/b.ts'), 'my work in progress\n');
  assert.equal(s.read('ChefMind/lib/a.ts'), 'old\n', 'the clean drifted copy was not fixed either');
  assert.ok(!existsSync(join(s.root, 'PlanMind', 'lib', 'a.ts')));
});

test('--fix refuses a staged change and a deleted tracked copy', (t) => {
  const staged = drifted(t);
  staged.put('ChefMind/lib/a.ts', 'staged edit\n');
  staged.git('add', 'ChefMind/lib/a.ts');
  assert.equal(staged.run(['--fix', 'alpha']).status, 1);
  assert.equal(staged.read('ChefMind/lib/a.ts'), 'staged edit\n');

  const deleted = drifted(t);
  rmSync(join(deleted.root, 'ChefMind', 'lib', 'a.ts'));
  assert.equal(deleted.run(['--fix', 'alpha']).status, 1);
  assert.ok(!existsSync(join(deleted.root, 'ChefMind', 'lib', 'a.ts')));
});

test('--fix <id> ignores dirt in other groups', (t) => {
  const s = drifted(t);
  s.put('ChefMind/lib/b.ts', 'dirty, but beta is not the target\n');
  const r = s.run(['--fix', 'alpha']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.read('ChefMind/lib/a.ts'), SAME);
  assert.equal(s.read('ChefMind/lib/b.ts'), 'dirty, but beta is not the target\n');
});

test('--fix refuses an existing copy that git does not track', (t) => {
  const s = drifted(t);
  s.put('PlanMind/lib/a.ts', 'never committed\n');
  const r = s.run(['--fix', 'alpha']);
  assert.equal(r.status, 1);
  assert.ok(r.lines.some((l) => l.startsWith('FAIL refused: untracked file(s) would be overwritten: PlanMind/lib/a.ts')), r.stdout);
  assert.equal(s.read('PlanMind/lib/a.ts'), 'never committed\n');
  assert.equal(s.read('ChefMind/lib/a.ts'), 'old\n');
});

test('--fix fails closed when git status itself fails: not a repository', (t) => {
  const s = makeSuite(t, { files: { ...BASIC_FILES, 'ChefMind/lib/a.ts': 'old\n' }, git: false });
  const r = s.run(['--fix', 'all'], { env: { GIT_CEILING_DIRECTORIES: s.parent } });
  assert.equal(r.status, 1, r.stdout);
  assert.ok(r.lines.some((l) => l.startsWith('FAIL refused: git status failed (exit ')), r.stdout);
  assert.equal(s.read('ChefMind/lib/a.ts'), 'old\n');
});

test('--fix fails closed when git status itself fails: git cannot be started', (t) => {
  const s = drifted(t);
  const empty = join(s.parent, 'empty-path');
  mkdirSync(empty);
  const r = s.run(['--fix', 'all'], { env: { PATH: empty }, replaceEnv: true });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(r.lines.some((l) => l.startsWith('FAIL refused: git status failed (ENOENT)')), r.stdout);
  assert.equal(s.read('ChefMind/lib/a.ts'), 'old\n');
});

test('--fix fails closed when git status exits non-zero: a fake git', POSIX_ONLY, (t) => {
  const s = drifted(t);
  const bin = join(s.parent, 'fake-bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nexit 3\n');
  chmodSync(join(bin, 'git'), 0o755);
  const r = s.run(['--fix', 'all'], { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  assert.equal(r.status, 1);
  assert.ok(r.lines.some((l) => l.startsWith('FAIL refused: git status failed (exit 3)')), r.stdout);
  assert.equal(s.read('ChefMind/lib/a.ts'), 'old\n');
});

test('--fix refuses when an origin is gone, writing nothing', (t) => {
  const s = drifted(t);
  rmSync(join(s.root, 'CalMind', 'lib', 'a.ts'));
  s.git('add', '-A');
  s.git('commit', '-q', '-m', 'origin removed');
  const r = s.run(['--fix', 'all']);
  assert.equal(r.status, 1);
  assert.ok(r.lines.includes('FAIL missing alpha: origin CalMind/lib/a.ts is gone'), r.stdout);
  assert.equal(s.read('ChefMind/lib/a.ts'), 'old\n');
});

test('--fix does not write through a symlinked copy', POSIX_ONLY, (t) => {
  const s = drifted(t);
  writeFileSync(join(s.parent, 'target.txt'), 'outside\n');
  rmSync(join(s.root, 'ChefMind', 'lib', 'a.ts'));
  symlinkSync(join(s.parent, 'target.txt'), join(s.root, 'ChefMind', 'lib', 'a.ts'));
  s.commit();
  const r = s.run(['--fix', 'alpha']);
  assert.equal(r.status, 1);
  assert.ok(r.lines.some((l) => l.startsWith('FAIL invalid alpha: ChefMind/lib/a.ts')), r.stdout);
  assert.equal(readFileSync(join(s.parent, 'target.txt'), 'utf8'), 'outside\n');
});

test('--fix treats glob characters in a copy path literally', POSIX_ONLY, (t) => {
  const manifest = { version: 1, groups: [{ id: 'star', origin: 'CalMind/s.txt', copies: ['ChefMind/s*.txt'] }] };
  const s = makeSuite(t, { manifest, files: { 'CalMind/s.txt': 'new\n', 'ChefMind/s*.txt': 'old\n', 'ChefMind/sdirty.txt': 'tracked\n' }, git: true });
  s.put('ChefMind/sdirty.txt', 'edited, and matched by the glob s*.txt\n');
  const r = s.run(['--fix', 'star']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.read('ChefMind/s*.txt'), 'new\n');
  assert.equal(s.read('ChefMind/sdirty.txt'), 'edited, and matched by the glob s*.txt\n');
});

test('--fix checks every batch of a long copy list', (t) => {
  const copies = Array.from({ length: 250 }, (_, i) => `Many/c${i}.txt`);
  const manifest = { version: 1, groups: [{ id: 'many', origin: 'CalMind/o.txt', copies }] };
  const files = { 'CalMind/o.txt': 'origin\n', ...Object.fromEntries(copies.map((c) => [c, 'old\n'])) };
  const s = makeSuite(t, { manifest, files, git: true });
  s.put('Many/c240.txt', 'dirty in the last batch\n');
  const refused = s.run(['--fix', 'many']);
  assert.equal(refused.status, 1);
  assert.equal(s.read('Many/c0.txt'), 'old\n');
  s.git('checkout', '--', 'Many/c240.txt');
  const ok = s.run(['--fix', 'many']);
  assert.equal(ok.status, 0, ok.stdout);
  assert.equal(ok.last, 'fix: 250 file(s) written, 0 already identical, 0 failure(s)');
  assert.equal(s.read('Many/c249.txt'), 'origin\n');
});

test('--fix cannot be combined with --list or --external, and needs a value', (t) => {
  const s = drifted(t);
  assert.equal(s.run(['--fix', 'all', '--list']).status, 1);
  assert.equal(s.run(['--fix', 'all', '--external']).status, 1);
  assert.equal(s.run(['--fix']).status, 1);
  assert.equal(s.run(['--fix', '--list']).status, 1);
  assert.equal(s.read('ChefMind/lib/a.ts'), 'old\n');
});

test('--fix refuses an invalid manifest', (t) => {
  const s = makeSuite(t, { manifest: { version: 1, groups: [g({ copies: ['../outside'] })] }, git: true });
  const r = s.run(['--fix', 'all']);
  assert.equal(r.status, 1);
  assert.ok(r.lines.some((l) => l.startsWith('FAIL schema: ')), r.stdout);
});
