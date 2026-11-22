#!/usr/bin/env node
// MindSuite's own version (the owner, 2026-11-22: "this is MindSuite 1.0 ... app a part of MindSuite
// will bump the minor version of mindsuite with at least a note about which tag it matches").
//
// mindsuite.json            {version, apps: {App: {repo, tag}}}: the suite's version and the tag of
//                           every app at that version. Written only by this script.
// docs/MINDSUITE-RELEASES.md one entry per MindSuite release, newest first.
// MindSuite/<x.y.z>         the annotated tag on the commit that wrote that version.
//
// Every app lane calls `record` right after its own release tag is on origin; the MindSuite minor
// goes up by one and the entry names the app tag it matches, with the whole suite listed beside it.
// The commit is built from origin/main with Git plumbing in a private index, so no checkout (and no
// one else's uncommitted work) is touched; afterwards each checkout of main whose index is clean is
// fast-forwarded. A lost push race (someone else moved main) is retried from the new tip.
//
//   node tools/mindsuite-release.mjs record <App> <tag> [--app-repo DIR] [--date YYYY-MM-DD]
//   node tools/mindsuite-release.mjs init <x.y.z> <App>=<repo>:<tag>... [--date YYYY-MM-DD]
//   node tools/mindsuite-release.mjs check
// Options: --repo DIR (the MindSuite checkout; default this script's), --no-push (commit and tag
// locally only), --dry-run (print the entry, change nothing).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const STATE = 'mindsuite.json';
export const NOTES = 'docs/MINDSUITE-RELEASES.md';
export const TAG_PREFIX = 'MindSuite/';
const MARK = '<!-- releases: newest first; written by tools/mindsuite-release.mjs -->';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(v) {
  const m = SEMVER.exec(String(v));
  if (!m) throw new Error(`not a version: ${v}`);
  return m.slice(1).map(Number);
}

export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** The version inside an app tag: CalMind/2.1.0 -> 2.1.0, v1.4.0 -> 1.4.0, 1.4.0 -> 1.4.0. */
export function tagVersion(tag) {
  const m = /^(?:[A-Za-z]+\/|v)?(\d+\.\d+\.\d+)$/.exec(String(tag));
  if (!m) throw new Error(`not a release tag: ${tag}`);
  return m[1];
}

/** A tag fits its app: monorepo apps tag <App>/x.y.z, the other repos x.y.z or vx.y.z. */
export function checkTag(app, entry, tag) {
  const version = tagVersion(tag);
  if (entry.repo === 'MindSuite') {
    if (tag !== `${app}/${version}`) throw new Error(`${app} tags look like ${app}/x.y.z, not ${tag}`);
  } else if (/\//.test(tag)) {
    throw new Error(`${app} lives in its own repo; its tags have no prefix (${tag})`);
  }
  return version;
}

/** The next free minor after `version`, skipping any MindSuite tag that already exists. */
export function nextMinor(version, taken = new Set()) {
  let [major, minor] = parseVersion(version);
  let next;
  do { minor += 1; next = `${major}.${minor}.0`; } while (taken.has(next));
  return next;
}

export function validateState(state) {
  if (!state || typeof state !== 'object') throw new Error(`${STATE} is not an object`);
  parseVersion(state.version);
  if (!state.apps || typeof state.apps !== 'object' || !Object.keys(state.apps).length) {
    throw new Error(`${STATE} lists no apps`);
  }
  for (const [app, entry] of Object.entries(state.apps)) {
    if (!/^[A-Z][A-Za-z]*$/.test(app)) throw new Error(`bad app name ${app}`);
    if (!entry || typeof entry.repo !== 'string' || !/^[A-Za-z][A-Za-z-]*$/.test(entry.repo)) {
      throw new Error(`${app} has no repo`);
    }
    checkTag(app, entry, entry.tag);
  }
  return state;
}

export function stateText(state) {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function shown(app, entry) {
  const v = tagVersion(entry.tag);
  return entry.repo === 'MindSuite' ? `${app} ${v}` : `${app} ${v}`;
}

function tagCell(entry) {
  return entry.repo === 'MindSuite' ? `\`${entry.tag}\`` : `\`${entry.tag}\` (${entry.repo} repo)`;
}

export function suiteLine(state) {
  return Object.entries(state.apps).map(([app, entry]) => shown(app, entry)).join(' · ');
}

export function initEntry(state, date, intro) {
  const rows = Object.entries(state.apps).map(([app, entry]) =>
    `| ${app} | ${tagVersion(entry.tag)} | ${tagCell(entry)} |`);
  return [
    `## MindSuite ${state.version} (${date})`,
    '',
    intro,
    '',
    '| App | Version | Tag |',
    '|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

export function minorEntry(state, app, date) {
  const entry = state.apps[app];
  return [
    `## MindSuite ${state.version} (${date})`,
    '',
    `Matches ${app} ${tagVersion(entry.tag)}: ${tagCell(entry)}.`,
    '',
    `Suite: ${suiteLine(state)}.`,
    '',
  ].join('\n');
}

export const NOTES_HEAD = [
  '# MindSuite releases',
  '',
  'MindSuite has a version of its own, kept in `mindsuite.json` with the tag of every app at that',
  'version. MindSuite 1.0.0 is the set of every app\'s first major release; from then on each app',
  'release bumps the MindSuite minor and adds an entry here naming the app tag it matches. Each',
  'version is tagged `MindSuite/<x.y.z>` in this repo. `tools/mindsuite-release.mjs` writes both',
  'files; the app release lanes call it after their own tag is pushed.',
  '',
  MARK,
  '',
].join('\n');

/** Put an entry in front of the others (after the head), creating the file's head when absent. */
export function insertEntry(notes, entry) {
  if (!notes) return `${NOTES_HEAD}${entry}`;
  const at = notes.indexOf(MARK);
  if (at < 0) throw new Error(`${NOTES} has lost its marker line`);
  const after = at + MARK.length;
  const rest = notes.slice(after).replace(/^\n+/, '');
  return `${notes.slice(0, after)}\n\n${entry}${rest ? `\n${rest}` : ''}`;
}

/**
 * Record one app release. Returns null when there is nothing to do (no MindSuite version yet, or
 * this tag is already the recorded one); throws for an unknown app, a wrong tag or a step back.
 */
export function record(state, notes, { app, tag, date, taken = new Set() }) {
  if (!state) return null;
  validateState(state);
  const entry = state.apps[app];
  if (!entry) throw new Error(`${app} is not a MindSuite app (${Object.keys(state.apps).join(', ')})`);
  const version = checkTag(app, entry, tag);
  if (entry.tag === tag) return null;
  if (compareVersions(version, tagVersion(entry.tag)) <= 0) {
    throw new Error(`${tag} is not newer than the recorded ${entry.tag}`);
  }
  const next = {
    version: nextMinor(state.version, taken),
    apps: { ...state.apps, [app]: { ...entry, tag } },
  };
  return {
    state: next,
    notes: insertEntry(notes, minorEntry(next, app, date)),
    message: `MindSuite ${next.version}: ${tag}${entry.repo === 'MindSuite' ? '' : ` (${entry.repo})`}`,
  };
}

export function init(state, notes, { version, apps, date, intro }) {
  if (state) throw new Error(`MindSuite already has a version (${state.version})`);
  const next = validateState({ version, apps });
  return {
    state: next,
    notes: insertEntry(notes, initEntry(next, date, intro)),
    message: `MindSuite ${version}`,
  };
}

// ---- Git ----------------------------------------------------------------------------------------

export function makeGit(cwd, env = process.env) {
  return function git(args, { input, allowFail = false, extraEnv } = {}) {
    const r = spawnSync('git', args, {
      cwd, input, encoding: 'utf8', env: extraEnv ? { ...env, ...extraEnv } : env,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error) throw r.error;
    if (r.status !== 0 && !allowFail) {
      throw new Error(`git ${args.join(' ')} failed (${r.status}): ${(r.stderr || '').trim()}`);
    }
    return allowFail ? r : r.stdout;
  };
}

function readAt(git, rev, path) {
  const r = git(['show', `${rev}:${path}`], { allowFail: true });
  return r.status === 0 ? r.stdout : null;
}

function takenVersions(git) {
  const out = git(['tag', '--list', `${TAG_PREFIX}*`]);
  return new Set(out.split('\n').filter(Boolean).map((t) => t.slice(TAG_PREFIX.length)));
}

/** Commit `files` (path -> text) on top of `base` without touching any index or working tree. */
export function commitFiles(git, base, files, message) {
  const tmp = mkdtempSync(join(tmpdir(), 'mindsuite-index-'));
  try {
    const extraEnv = { GIT_INDEX_FILE: join(tmp, 'index') };
    git(['read-tree', base], { extraEnv });
    for (const [path, text] of Object.entries(files)) {
      const blob = git(['hash-object', '-w', '--stdin'], { input: text }).trim();
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { extraEnv });
    }
    const tree = git(['write-tree'], { extraEnv }).trim();
    return git(['commit-tree', tree, '-p', base, '-m', message]).trim();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function worktreesOnMain(git) {
  const trees = [];
  let cur = null;
  for (const line of git(['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9) }; trees.push(cur); }
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7);
    else if (cur && line === 'bare') cur.bare = true;
  }
  return trees.filter((t) => t.branch === 'refs/heads/main' && !t.bare);
}

/**
 * Bring local main up to `target`, a descendant of it. The branch is shared by every worktree that
 * has it checked out, so it moves only when each of them can take it: a worktree whose index is
 * the old tip's tree follows with a two-tree read-tree (unrelated unstaged edits are kept); one
 * whose index is an older tip's tree (left behind by a release made in another worktree) stays
 * exactly as stale as it was. Staged work of anyone's, or local commits origin lacks, keep local
 * main where it is: the next lane's own pull brings it forward.
 */
export function fastForwardCheckouts(git, target, log = console.log, env = process.env) {
  const old = git(['rev-parse', '--verify', '--quiet', 'refs/heads/main'], { allowFail: true }).stdout.trim();
  if (!old || old === target) return;
  if (git(['merge-base', '--is-ancestor', old, target], { allowFail: true }).status !== 0) {
    log(`MindSuite: local main has commits origin/main lacks; left it at ${old.slice(0, 7)}`);
    return;
  }
  const oldTree = git(['rev-parse', `${old}^{tree}`]).trim();
  const earlier = new Set(git(['log', '--format=%T', '-n', '200', old]).split('\n').filter(Boolean));
  const plan = [];
  for (const t of worktreesOnMain(git)) {
    const g = makeGit(t.path, env);
    const w = g(['write-tree'], { allowFail: true });
    const tree = w.status === 0 ? w.stdout.trim() : '';
    if (tree === oldTree) plan.push({ t, g, follow: true });
    else if (tree && earlier.has(tree)) plan.push({ t, g, follow: false });
    else {
      log(`MindSuite: ${t.path} has staged work; left local main at ${old.slice(0, 7)} (origin/main is ahead)`);
      return;
    }
  }
  git(['update-ref', 'refs/heads/main', target, old]);
  for (const { t, g, follow } of plan) {
    if (!follow) {
      log(`MindSuite: ${t.path} was already behind its HEAD (a release made in another worktree); left as it was`);
      continue;
    }
    const r = g(['read-tree', '-m', '-u', old, target], { allowFail: true });
    if (r.status !== 0) {
      log(`MindSuite: could not bring ${t.path} forward (${(r.stderr || '').trim()}); there: git read-tree -m -u ${old} ${target}`);
    }
  }
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Fetch origin's main and MindSuite tags, build the change from origin/main, tag and push both
 * atomically. `change(state, notes, taken)` returns {state, notes, message} or null.
 */
export function publish({ repo, change, push = true, dryRun = false, log = console.log, env = process.env, tries = 3 }) {
  const git = makeGit(repo, env);
  for (let attempt = 1; attempt <= tries; attempt++) {
    git(['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main',
      `+refs/tags/${TAG_PREFIX}*:refs/tags/${TAG_PREFIX}*`]);
    const base = git(['rev-parse', 'refs/remotes/origin/main']).trim();
    const stateText0 = readAt(git, base, STATE);
    const state = stateText0 ? JSON.parse(stateText0) : null;
    const result = change(state, readAt(git, base, NOTES), takenVersions(git));
    if (!result) return null;
    if (dryRun) { log(result.notes.split(MARK)[1]?.trim().split('\n## ')[0] ?? ''); return { ...result, dryRun: true }; }
    const tag = `${TAG_PREFIX}${result.state.version}`;
    const commit = commitFiles(git, base, { [STATE]: stateText(result.state), [NOTES]: result.notes }, result.message);
    git(['tag', '-a', tag, '-m', `MindSuite ${result.state.version}`, commit]);
    if (!push) return { ...result, commit, tag };
    const r = git(['push', '--atomic', '--quiet', 'origin', `${commit}:refs/heads/main`, `refs/tags/${tag}`], { allowFail: true });
    if (r.status === 0) {
      git(['update-ref', 'refs/remotes/origin/main', commit]);
      fastForwardCheckouts(git, commit, log, env);
      log(`MindSuite ${result.state.version}: ${result.message.replace(/^MindSuite [^:]+: ?/, '') || 'tagged'} (${tag})`);
      return { ...result, commit, tag };
    }
    git(['tag', '-d', tag], { allowFail: true });
    log(`MindSuite: push refused (attempt ${attempt}/${tries}): ${(r.stderr || '').trim()}`);
  }
  throw new Error('MindSuite: gave up after repeated push refusals');
}

/** The app's tag must be on its own origin before MindSuite names it. */
export function tagOnOrigin(appRepo, tag, env = process.env) {
  const r = makeGit(appRepo, env)(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], { allowFail: true });
  return r.status === 0 && r.stdout.trim().length > 0;
}

function parseArgs(argv) {
  const opts = { positional: [], push: true, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') opts.repo = argv[++i];
    else if (a === '--app-repo') opts.appRepo = argv[++i];
    else if (a === '--date') opts.date = argv[++i];
    else if (a === '--intro') opts.intro = argv[++i];
    else if (a === '--no-push') opts.push = false;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

export function main(argv = process.argv.slice(2), { env = process.env, log = console.log } = {}) {
  const opts = parseArgs(argv);
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = resolve(opts.repo || join(here, '..'));
  const date = opts.date || today();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`bad --date ${date}`);
  const [cmd, ...rest] = opts.positional;
  if (cmd === 'record') {
    const [app, tag] = rest;
    if (!app || !tag || rest.length !== 2) throw new Error('usage: record <App> <tag>');
    const appRepo = resolve(opts.appRepo || repo);
    if (!opts.dryRun && opts.push && !tagOnOrigin(appRepo, tag, env)) {
      throw new Error(`${tag} is not on ${app}'s origin yet; push it first`);
    }
    const out = publish({
      repo, push: opts.push, dryRun: opts.dryRun, log, env,
      change: (state, notes, taken) => {
        if (!state) { log(`MindSuite has no version yet; ${tag} not recorded`); return null; }
        const r = record(state, notes, { app, tag, date, taken });
        if (!r) log(`MindSuite ${state.version} already names ${tag}`);
        return r;
      },
    });
    return out;
  }
  if (cmd === 'init') {
    const [version, ...pairs] = rest;
    const apps = {};
    for (const p of pairs) {
      const m = /^([A-Za-z]+)=([A-Za-z-]+):(.+)$/.exec(p);
      if (!m) throw new Error(`expected App=repo:tag, got ${p}`);
      apps[m[1]] = { repo: m[2], tag: m[3] };
    }
    const intro = opts.intro || 'The first numbered MindSuite release: every app at its first major-version release.';
    return publish({
      repo, push: opts.push, dryRun: opts.dryRun, log, env,
      change: (state, notes) => init(state, notes, { version, apps, date, intro }),
    });
  }
  if (cmd === 'check') {
    const git = makeGit(repo, env);
    const text = readAt(git, 'HEAD', STATE);
    if (!text) { log('MindSuite has no version yet'); return null; }
    const state = validateState(JSON.parse(text));
    const notes = readAt(git, 'HEAD', NOTES) || '';
    if (!notes.includes(`## MindSuite ${state.version} (`)) throw new Error(`${NOTES} has no entry for ${state.version}`);
    log(`MindSuite ${state.version}: ${suiteLine(state)}`);
    return state;
  }
  throw new Error('usage: mindsuite-release.mjs record <App> <tag> | init <x.y.z> <App>=<repo>:<tag>... | check');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}
