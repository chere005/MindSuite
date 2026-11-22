/**
 * The tree the typecheck and the suites read, as one hash.
 *
 *   node tools/gate-key.mjs            prints the key (64 hex) and nothing else
 *   node tools/gate-key.mjs --files    lists the paths it read, for the prover
 *
 * WHY IT EXISTS. A tdtp ran the same typecheck and the same core suite twice
 * over the same files, a few seconds apart: once in tools/dtp.sh's --full pass,
 * before anything is touched, and again inside deploy.sh. The bump between
 * them touches only version numbers, which neither tsc nor vitest reads. That
 * second run cost about seven seconds and proved nothing the first had not.
 *
 * So the --full pass records this key for the tree it just checked, and
 * deploy.sh skips its own run ONLY when the tree still hashes to the same key.
 * Anything else, such as a file another session saved mid-lane, a new file, or
 * an `npm install`, gives a different key, and deploy.sh then checks the tree
 * as it always did. That run can still fail and stop the deploy. The reuse is
 * proven by content on every run, never assumed and never by time:
 * tools/check-deploy-guards.sh breaks a copy of the tree in each way below and
 * watches the key move.
 *
 * WHAT IS IN IT. Everything tsc and vitest can read, plus more than they do.
 * Missing an input would be a hole; including too much only means a run that
 * did not need to happen. A key over a few named paths was proposed first, and
 * it had a hole. `tsc -p app` has no `include`, so it typechecks every
 * .ts/.tsx/.js under app/, dist's bundles included (expo's base sets allowJs).
 * A stray app/e2e/x.ts would have been checked by tsc and missed by the key.
 *   - app/, packages/ and spec/, whole, every file at any depth. Dot-dirs are
 *     included because vitest globs with `dot: true`. Left out: node_modules
 *     (keyed below), app/ios and app/android (excluded by expo's tsconfig, and
 *     no test reads them) and .DS_Store.
 *   - the shared @mind/core code outside this repo, reached through the
 *     file: link: ../packages/mind-core, whole (LINKED below), its own
 *     tsconfig.json included (it extends nothing, so vitest's transform
 *     reads no config beyond it). tsc --listFilesOnly names those files, and
 *     tools/check-deploy-guards.sh fails if one is not keyed.
 *   - the root files that configure either tool: tsconfig*.json,
 *     package.json, package-lock.json, .npmrc, and any vite/vitest/babel/
 *     postcss config or .env.
 *   - the desktop CSP source and configuration read by the app tests.
 *   - node_modules: npm's own record of what is installed,
 *     node_modules/.package-lock.json, which every install rewrites. Also the
 *     NAMES in each node_modules here, top level and @scope, so a package
 *     dropped in by hand also moves the key. Hashing all 42,000 files would
 *     cost more than the run this saves. The one thing left unkeyed is a hand
 *     edit inside an installed package mid-lane.
 *   - node's version, the platform, and TZ and NODE_OPTIONS from the
 *     environment.
 *
 * WHAT IS TAKEN OUT: exactly the fields the bump rewrites, and only in the
 * files the key reads. That is `version` in the root package.json,
 * `expo.version` in app/app.json, `version` in tauri.conf.json, and the workspace `version` fields
 * tools/sync-lock-versions.mjs rewrites in package-lock.json. No source file
 * imports a package.json; app/src/brand.ts imports app.json, but reads only
 * `expo.name`, and JSON imports are typed `string`, so the version's value
 * changes no typecheck or test result.
 *
 * NO KEY IS A SAFE ANSWER. Anything this cannot read plainly makes it exit
 * non-zero and print nothing: a symlinked directory it would have to follow,
 * a socket, an unreadable file. Both callers treat an empty key as "run the
 * checks", so a failure here costs seconds and never skips a gate.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo this file sits in, whatever directory it was called from: a key of
// the wrong tree would be a key that matches nothing, or worse, the wrong thing.
process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const TREES = ['app', 'packages', 'spec'];
// Shared code OUTSIDE this repo that tsc and vitest read through the file:
// link to @mind/core (node_modules/@mind/core -> ../packages/mind-core): the
// package itself, whose src/ holds the bodies this repo's one-line stubs
// re-export. The whole package is keyed, more than the stubs reach, which
// only costs a run that did not need to happen. Missing it means no key.
const LINKED = ['../packages/mind-core'];
const DESKTOP_TEST_INPUTS = ['desktop/csp.mjs', 'desktop/src-tauri/tauri.conf.json'];
// Excluded at the top of app/ only, as expo's tsconfig excludes them
// (`${configDir}/ios`). A nested ios/ (app/modules/native-ocr/ios) is kept.
const APP_SKIP = new Set(['app/ios', 'app/android']);
const ROOT_FILE =
  /^(tsconfig.*\.json|package\.json|package-lock\.json|\.npmrc|(vite|vitest|babel|postcss)\.config\..*|vitest\.workspace\..*|\.babelrc.*|\.env.*)$/;
const MODULE_DIRS = ['node_modules', 'app/node_modules', 'packages/core/node_modules'];

class Unkeyable extends Error {}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** Content, minus the fields the bump rewrites. */
function normalized(rel, buf) {
  if (rel === 'package.json' || rel === 'desktop/src-tauri/tauri.conf.json') {
    const j = JSON.parse(buf.toString('utf8'));
    delete j.version;
    return JSON.stringify(j);
  }
  if (rel === 'app/app.json') {
    const j = JSON.parse(buf.toString('utf8'));
    if (j.expo) delete j.expo.version;
    return JSON.stringify(j);
  }
  if (rel === 'package-lock.json') {
    // The same fields tools/sync-lock-versions.mjs writes, and no others.
    const j = JSON.parse(buf.toString('utf8'));
    delete j.version;
    for (const [dir, entry] of Object.entries(j.packages ?? {})) {
      if (!dir.startsWith('node_modules/') && entry) delete entry.version;
    }
    return JSON.stringify(j);
  }
  return buf;
}

const entries = []; // [relative path, digest]

function file(rel) {
  entries.push([rel, sha(normalized(rel, readFileSync(rel)))]);
}

function walk(rel) {
  const st = lstatSync(rel);
  if (st.isSymbolicLink()) {
    // tsc and vitest follow links, so a link to a directory would put a tree
    // the walk never saw into the check. Refuse to key it.
    if (statSync(rel).isDirectory()) throw new Unkeyable(`${rel} is a symlinked directory`);
    entries.push([rel, `link:${readlinkSync(rel)}:${sha(readFileSync(rel))}`]);
    return;
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(rel).sort()) {
      if (name === 'node_modules' || name === '.DS_Store') continue;
      const child = `${rel}/${name}`;
      if (APP_SKIP.has(child)) continue;
      walk(child);
    }
    return;
  }
  if (!st.isFile()) throw new Unkeyable(`${rel} is neither a file nor a directory`);
  file(rel);
}

function key() {
  for (const t of TREES) if (existsSync(t)) walk(t);
  for (const l of LINKED) {
    if (!existsSync(l)) throw new Unkeyable(`no ${l} to key the shared @mind/core code by`);
    walk(l);
  }
  for (const f of DESKTOP_TEST_INPUTS) walk(f);
  for (const name of readdirSync('.').sort()) {
    if (ROOT_FILE.test(name) && lstatSync(name).isFile()) file(name);
  }
  const hidden = 'node_modules/.package-lock.json';
  if (!existsSync(hidden)) throw new Unkeyable(`no ${hidden} to key the installed packages by`);
  file(hidden);
  for (const dir of MODULE_DIRS) {
    if (!existsSync(dir)) continue;
    const names = [];
    for (const n of readdirSync(dir).sort()) {
      names.push(n);
      if (n.startsWith('@') && statSync(join(dir, n)).isDirectory()) {
        for (const m of readdirSync(join(dir, n)).sort()) names.push(`${n}/${m}`);
      }
    }
    entries.push([`${dir}/<names>`, sha(names.join('\n'))]);
  }
  const env = [process.version, process.platform, process.arch, process.env.TZ ?? '', process.env.NODE_OPTIONS ?? ''];
  entries.push(['<env>', sha(env.join('\n'))]);

  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha(entries.map(([p, d]) => `${p}\0${d}`).join('\n'));
}

try {
  const k = key();
  if (process.argv.includes('--files')) {
    for (const [p] of entries) if (!p.includes('<')) console.log(p);
  } else {
    console.log(k);
  }
} catch (e) {
  console.error(`gate-key: ${e instanceof Unkeyable ? e.message : e} — no key, so the checks run`);
  process.exit(2);
}
