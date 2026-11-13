#!/usr/bin/env node
// Does every shared file still carry the bytes of its origin?
//
//   node tools/check-shared.mjs                  every group in tools/shared-files.json
//   node tools/check-shared.mjs --app CalMind    only groups with a member under CalMind/
//   node tools/check-shared.mjs --external       also compare the external entries
//   node tools/check-shared.mjs --fix <id|all>   copy origin over the copies (clean tree only)
//   node tools/check-shared.mjs --list           print the groups
//
// tools/shared-files.json (version 1) lists byte-identical copies, paths relative to the suite
// root (the directory above tools/), always written with '/':
//   { "version": 1,
//     "groups":   [{ "id": "kebab-id", "origin": "CalMind/x", "copies": ["ChefMind/x"], "note": "" }],
//     "external": [{ "id": "kebab-id", "origin": "packages/mind-server/lib/x.php",
//                    "repo": "seancheren-site", "path": "lib/x.php", "note": "" }] }
// SHARED_FILES names another manifest file (its paths still resolve from the suite root).
//
// The checker is fail-closed. It exits 1 when the manifest breaks the schema, a file is missing or
// is not a plain file, a copy differs from its origin, or no file was compared at all (a check that
// compared nothing is not a pass). The last line of a compare run is always
//   <N> group(s): <D> drifted, <F> failures
// where D counts differing copies and F counts every FAIL line (drift included).
//
// --external compares each external entry's origin with <repo>/<path> in a sibling checkout
// (../<repo>, or $MIND_SITE_DIR for the seancheren-site repo). An absent checkout prints
// `external <id>: skipped (no checkout at <dir>)` and does not count as compared.
//
// --fix never stages or commits. It refuses unless `git status --porcelain --untracked-files=no`
// over the copies succeeds and prints nothing, and unless every existing copy is tracked, so no
// uncommitted work can be overwritten.
//
// Node built-ins only.
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SUITE_ROOT = path.resolve(HERE, '..');
export const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SITE_REPO = 'seancheren-site';
const GIT_BATCH = 100; // pathspecs per git call: keeps a long list under the Windows command-line limit

// ---------------------------------------------------------------------------------------------
// Paths. JSON paths are POSIX ('/'), parsed with path.posix rules and mapped to native ones only
// at the file system boundary.
// ---------------------------------------------------------------------------------------------

/** Why a JSON path is unacceptable, or null. */
export function pathProblem(value) {
  if (typeof value !== 'string' || value === '') return 'must be a non-empty string';
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'contains a control character';
  if (value.includes('\\')) return "uses a backslash (JSON paths use '/')";
  if (value.startsWith('/')) return 'is absolute';
  if (/^[A-Za-z]:/.test(value)) return 'starts with a drive letter';
  const segments = value.split('/');
  if (segments.some((s) => s === '')) return "has an empty segment ('//' or a trailing '/')";
  if (segments.some((s) => s === '.')) return "has a '.' segment";
  if (segments.some((s) => s === '..')) return "has a '..' segment";
  if (segments.some((s) => s.toLowerCase() === '.git')) return 'points into .git';
  if (path.posix.normalize(value) !== value) return 'is not in normal form';
  return null;
}

/** A relative JSON path as a native path below `root`. `pathMod` is injectable for tests. */
export function nativePath(root, rel, pathMod = path) {
  return pathMod.join(root, ...rel.split('/'));
}

function isInside(rootAbs, abs) {
  const rel = path.relative(rootAbs, abs);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// ---------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------

const GROUP_KEYS = new Set(['id', 'origin', 'copies', 'note']);
const EXTERNAL_KEYS = new Set(['id', 'origin', 'repo', 'path', 'note']);
const TOP_KEYS = new Set(['version', 'groups', 'external']);

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** Validate a parsed manifest. Returns { errors, groups, external }; errors empty means usable. */
export function validateManifest(data) {
  const errors = [];
  const groups = [];
  const external = [];
  if (!isObject(data)) return { errors: ['manifest must be a JSON object'], groups, external };
  for (const key of Object.keys(data)) if (!TOP_KEYS.has(key)) errors.push(`unknown key "${key}"`);
  if (data.version !== 1) errors.push('"version" must be 1');
  if (!Array.isArray(data.groups)) errors.push('"groups" must be an array');
  if (data.external !== undefined && !Array.isArray(data.external)) errors.push('"external" must be an array');

  const ids = new Set();
  const claimed = new Map(); // path -> group id, for "no path in two groups"
  const note = (where, v) => { if (v !== undefined && typeof v !== 'string') errors.push(`${where}.note must be a string`); };
  const checkId = (where, id) => {
    if (typeof id !== 'string' || !KEBAB.test(id)) { errors.push(`${where}.id must be a kebab-case string`); return false; }
    if (ids.has(id)) { errors.push(`${where}.id "${id}" is not unique`); return false; }
    ids.add(id);
    return true;
  };
  const checkPath = (where, value) => {
    const problem = pathProblem(value);
    if (problem) errors.push(`${where} ${problem}`);
    return problem === null;
  };

  (Array.isArray(data.groups) ? data.groups : []).forEach((g, i) => {
    const where = `groups[${i}]`;
    if (!isObject(g)) { errors.push(`${where} must be an object`); return; }
    for (const key of Object.keys(g)) if (!GROUP_KEYS.has(key)) errors.push(`${where} has unknown key "${key}"`);
    const idOk = checkId(where, g.id);
    const originOk = checkPath(`${where}.origin`, g.origin);
    note(where, g.note);
    let copiesOk = false;
    if (!Array.isArray(g.copies) || g.copies.length === 0) {
      errors.push(`${where}.copies must be a non-empty array`);
    } else {
      copiesOk = g.copies.map((c, j) => checkPath(`${where}.copies[${j}]`, c)).every(Boolean);
    }
    const label = idOk ? g.id : where;
    if (originOk && copiesOk) {
      if (g.copies.includes(g.origin)) errors.push(`${where}.origin "${g.origin}" is also one of its copies`);
      for (const p of [g.origin, ...g.copies]) {
        if (claimed.has(p)) {
          errors.push(claimed.get(p) === label
            ? `${where} lists "${p}" more than once`
            : `"${p}" is in two groups (${claimed.get(p)} and ${label})`);
        } else claimed.set(p, label);
      }
    }
    if (idOk && originOk && copiesOk) groups.push({ id: g.id, origin: g.origin, copies: [...g.copies], note: g.note ?? '' });
  });

  const seenExternal = new Set();
  (Array.isArray(data.external) ? data.external : []).forEach((e, i) => {
    const where = `external[${i}]`;
    if (!isObject(e)) { errors.push(`${where} must be an object`); return; }
    for (const key of Object.keys(e)) if (!EXTERNAL_KEYS.has(key)) errors.push(`${where} has unknown key "${key}"`);
    const idOk = checkId(where, e.id);
    const originOk = checkPath(`${where}.origin`, e.origin);
    const pathOk = checkPath(`${where}.path`, e.path);
    let repoOk = typeof e.repo === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(e.repo) && e.repo !== '..';
    if (!repoOk) errors.push(`${where}.repo must be a single directory name`);
    note(where, e.note);
    if (repoOk && pathOk) {
      const key = `${e.repo}/${e.path}`;
      if (seenExternal.has(key)) { errors.push(`${where} repeats ${key}`); repoOk = false; }
      seenExternal.add(key);
    }
    if (idOk && originOk && pathOk && repoOk) external.push({ id: e.id, origin: e.origin, repo: e.repo, path: e.path, note: e.note ?? '' });
  });

  return { errors, groups, external };
}

// ---------------------------------------------------------------------------------------------
// File access
// ---------------------------------------------------------------------------------------------

/** Read a plain file below `base` (a real path). Never follows a link out of `base`. */
function readPlain(base, rel) {
  const abs = nativePath(base, rel);
  let st;
  try { st = lstatSync(abs); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { ok: false, kind: 'missing', msg: 'is gone' };
    return { ok: false, kind: 'unreadable', msg: `cannot be inspected (${e.code ?? e.message})` };
  }
  if (!st.isFile()) return { ok: false, kind: 'invalid', msg: 'is not a plain file (a link or a directory)' };
  try {
    if (!isInside(base, realpathSync(abs))) return { ok: false, kind: 'invalid', msg: 'resolves outside its root' };
    return { ok: true, data: readFileSync(abs) };
  } catch (e) {
    return { ok: false, kind: 'unreadable', msg: `cannot be read (${e.code ?? e.message})` };
  }
}

function realDir(dir) {
  try { return statSync(dir).isDirectory() ? realpathSync(dir) : null; } catch { return null; }
}

// ---------------------------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------------------------

function compare({ realRoot, groups, external, withExternal, env, say }) {
  let compared = 0;
  let drifted = 0;
  let failures = 0;
  const fail = (line) => { failures += 1; say(`FAIL ${line}`); };

  for (const g of groups) {
    const origin = readPlain(realRoot, g.origin);
    if (!origin.ok) { fail(`${origin.kind} ${g.id}: origin ${g.origin} ${origin.msg}`); continue; }
    for (const copy of g.copies) {
      const c = readPlain(realRoot, copy);
      if (!c.ok) { fail(`${c.kind} ${g.id}: ${copy} ${c.msg}`); continue; }
      compared += 1;
      if (!origin.data.equals(c.data)) { drifted += 1; fail(`drift ${g.id}: ${copy} differs from ${g.origin}`); }
    }
  }

  if (withExternal) {
    for (const e of external) {
      const dirName = e.repo === SITE_REPO && env.MIND_SITE_DIR ? env.MIND_SITE_DIR : path.join(path.dirname(realRoot), e.repo);
      const base = realDir(dirName);
      if (!base) { say(`external ${e.id}: skipped (no checkout at ${dirName})`); continue; }
      const origin = readPlain(realRoot, e.origin);
      if (!origin.ok) { fail(`${origin.kind} external ${e.id}: origin ${e.origin} ${origin.msg}`); continue; }
      const c = readPlain(base, e.path);
      if (!c.ok) { fail(`${c.kind} external ${e.id}: ${e.repo}/${e.path} ${c.msg}`); continue; }
      compared += 1;
      if (!origin.data.equals(c.data)) { drifted += 1; fail(`drift external ${e.id}: ${e.repo}/${e.path} differs from ${e.origin}`); }
    }
  }
  return { compared, drifted, failures };
}

function git(root, args, env) {
  return spawnSync('git', ['--no-optional-locks', '--literal-pathspecs', '-C', root, ...args], { encoding: 'utf8', env });
}

/** null when git says the copies are clean and tracked; otherwise the reason to refuse. */
function refuseUnlessClean(root, copies, env) {
  for (let i = 0; i < copies.length; i += GIT_BATCH) {
    const batch = copies.slice(i, i + GIT_BATCH);
    const status = git(root, ['status', '--porcelain', '--untracked-files=no', '--', ...batch], env);
    if (status.error || status.status !== 0) {
      return `git status failed (${status.error ? status.error.code ?? status.error.message : `exit ${status.status}`}): cannot prove the copies are clean`;
    }
    const dirty = status.stdout.split('\n').filter((l) => l.trim() !== '');
    if (dirty.length > 0) {
      return `${dirty.length} copy path(s) have uncommitted changes:\n${dirty.slice(0, 10).map((l) => `  ${l}`).join('\n')}`;
    }
    const tracked = git(root, ['ls-files', '-z', '--', ...batch], env);
    if (tracked.error || tracked.status !== 0) {
      return `git ls-files failed (${tracked.error ? tracked.error.code ?? tracked.error.message : `exit ${tracked.status}`}): cannot prove the copies are tracked`;
    }
    const known = new Set(tracked.stdout.split('\0').filter(Boolean));
    const untracked = batch.filter((p) => existsSync(nativePath(root, p)) && !known.has(p));
    if (untracked.length > 0) return `untracked file(s) would be overwritten: ${untracked.slice(0, 10).join(', ')}`;
  }
  return null;
}

function fix({ root, realRoot, targets, env, say }) {
  const plan = [];
  let failures = 0;
  const fail = (line) => { failures += 1; say(`FAIL ${line}`); };

  for (const g of targets) {
    const origin = readPlain(realRoot, g.origin);
    if (!origin.ok) { fail(`${origin.kind} ${g.id}: origin ${g.origin} ${origin.msg}`); continue; }
    for (const copy of g.copies) {
      const abs = nativePath(realRoot, copy);
      let ancestor = path.dirname(abs);
      while (!existsSync(ancestor) && ancestor !== path.dirname(ancestor)) ancestor = path.dirname(ancestor);
      let ancestorOk = false;
      try { ancestorOk = ancestor === realRoot || isInside(realRoot, realpathSync(ancestor)); } catch { /* stays false */ }
      if (!ancestorOk) { fail(`invalid ${g.id}: ${copy} would be written outside the suite root`); continue; }
      const current = readPlain(realRoot, copy);
      if (!current.ok && current.kind !== 'missing') { fail(`${current.kind} ${g.id}: ${copy} ${current.msg}`); continue; }
      plan.push({ g, copy, abs, originAbs: nativePath(realRoot, g.origin), same: current.ok && current.data.equals(origin.data), data: origin.data });
    }
  }
  if (failures > 0) { say(`fix: refused, ${failures} failure(s); nothing written`); return 1; }

  const reason = refuseUnlessClean(root, targets.flatMap((g) => g.copies), env);
  if (reason) { say(`FAIL refused: ${reason}`); say('fix: refused; nothing written'); return 1; }

  let written = 0;
  let identical = 0;
  for (const step of plan) {
    if (step.same) { identical += 1; continue; }
    try {
      mkdirSync(path.dirname(step.abs), { recursive: true });
      copyFileSync(step.originAbs, step.abs);
    } catch (e) { fail(`write ${step.g.id}: ${step.copy} (${e.code ?? e.message})`); continue; }
    const after = readPlain(realRoot, step.copy);
    if (!after.ok || !after.data.equals(step.data)) { fail(`write ${step.g.id}: ${step.copy} differs from ${step.g.origin} after the copy`); continue; }
    written += 1;
    say(`wrote ${step.copy} (from ${step.g.origin})`);
  }
  say(`fix: ${written} file(s) written, ${identical} already identical, ${failures} failure(s)`);
  return failures === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

const USAGE = `usage: node tools/check-shared.mjs [--app <Dir>] [--external]
       node tools/check-shared.mjs --fix <id|all> [--app <Dir>]
       node tools/check-shared.mjs --list [--app <Dir>]
SHARED_FILES=<file> reads another manifest; MIND_SITE_DIR names the seancheren-site checkout.`;

function parseArgs(argv) {
  const opts = { app: null, external: false, fix: null, list: false, help: false };
  const value = (flag, i, inline) => {
    if (inline !== undefined) return [inline, i];
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${flag} needs a value`);
    return [argv[i + 1], i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const eq = argv[i].indexOf('=');
    const [flag, inline] = argv[i].startsWith('--') && eq > 0 ? [argv[i].slice(0, eq), argv[i].slice(eq + 1)] : [argv[i], undefined];
    if (flag === '--app') {
      if (opts.app !== null) throw new Error('--app was given twice');
      [opts.app, i] = value(flag, i, inline);
    } else if (flag === '--fix') {
      if (opts.fix !== null) throw new Error('--fix was given twice');
      [opts.fix, i] = value(flag, i, inline);
    } else if (flag === '--external' && inline === undefined) opts.external = true;
    else if (flag === '--list' && inline === undefined) opts.list = true;
    else if ((flag === '--help' || flag === '-h') && inline === undefined) opts.help = true;
    else throw new Error(`unknown argument "${argv[i]}"`);
  }
  if (opts.fix !== null && opts.list) throw new Error('--fix and --list cannot be combined');
  if (opts.fix !== null && opts.external) throw new Error('--fix does not take --external');
  return opts;
}

function underDir(member, dir) { return member === dir || member.startsWith(`${dir}/`); }

/**
 * Run the checker. Returns the exit code; prints through `out` (stdout) and `err` (stderr).
 * `root` is the suite root: JSON paths resolve from it.
 */
export function main(argv, { env = process.env, cwd = process.cwd(), root = SUITE_ROOT, out = console.log, err = console.error } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { err(`check-shared: ${e.message}\n${USAGE}`); return 1; }
  if (opts.help) { out(USAGE); return 0; }

  const compareMode = !opts.list && opts.fix === null;
  const file = env.SHARED_FILES ? path.resolve(cwd, env.SHARED_FILES) : path.join(root, 'tools', 'shared-files.json');
  const finish = (errors) => {
    for (const m of errors) out(`FAIL schema: ${m}`);
    if (compareMode) out(`0 group(s): 0 drifted, ${errors.length} failures`);
    return 1;
  };

  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { return finish([`cannot read the manifest (${e.code ?? e.message})`]); }
  let data;
  try { data = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { return finish([`the manifest is not valid JSON (${e.message})`]); }
  const manifest = validateManifest(data);
  if (manifest.errors.length > 0) return finish(manifest.errors);

  let { groups, external } = manifest;
  if (opts.app !== null) {
    const dir = opts.app.replace(/\/+$/, '');
    const members = [...groups.flatMap((g) => [g.origin, ...g.copies]), ...external.map((e) => e.origin)];
    if (pathProblem(dir) !== null || !members.some((m) => underDir(m, dir))) {
      const valid = [...new Set(members.map((m) => m.split('/')[0]))].sort();
      err(`check-shared: no group has a member under "${opts.app}/"; directories with shared files: ${valid.join(', ')}`);
      return 1;
    }
    groups = groups.filter((g) => [g.origin, ...g.copies].some((m) => underDir(m, dir)));
    external = external.filter((e) => underDir(e.origin, dir));
  }

  if (opts.list) {
    for (const g of groups) {
      out(`${g.id}: ${g.origin} -> ${g.copies.length} cop${g.copies.length === 1 ? 'y' : 'ies'}${g.note ? ` (${g.note})` : ''}`);
      for (const c of g.copies) out(`  ${c}`);
    }
    for (const e of external) out(`external ${e.id}: ${e.origin} <-> ${e.repo}/${e.path}${e.note ? ` (${e.note})` : ''}`);
    out(`${groups.length} group(s), ${external.length} external`);
    return 0;
  }

  let realRoot;
  try { realRoot = realpathSync(root); } catch (e) { return finish([`the suite root cannot be resolved (${e.code ?? e.message})`]); }

  if (opts.fix !== null) {
    const targets = opts.fix === 'all' ? groups : groups.filter((g) => g.id === opts.fix);
    if (targets.length === 0) {
      err(`check-shared: no group "${opts.fix}"; groups: ${groups.map((g) => g.id).join(', ') || '(none)'}`);
      return 1;
    }
    return fix({ root: realRoot, realRoot, targets, env, say: out });
  }

  const { compared, drifted, failures } = compare({ realRoot, groups, external, withExternal: opts.external, env, say: out });
  out(`compared ${compared} file(s)`);
  let failed = failures;
  if (compared === 0) { out('FAIL nothing checked: no file was compared'); failed += 1; }
  out(`${groups.length} group(s): ${drifted} drifted, ${failed} failures`);
  return failed === 0 ? 0 : 1;
}

function isMain() {
  try { return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}
if (isMain()) process.exitCode = main(process.argv.slice(2));
