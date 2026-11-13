/**
 * What the web export was built FROM, by content.
 *
 * e2e/freshness.ts used to answer "is the export current?" by comparing
 * mtimes, and that is not the same question. Two sessions share this repo, and
 * an ordinary `git` operation in the other one — a pull with autostash, a
 * checkout, a stash pop — rewrites files it is restoring to identical content.
 * Their mtimes move; nothing about the code changes. On 2026-08-12 that made a
 * perfectly current export read as STALE three times in one session, each time
 * naming `packages/core/src/order.ts`, which had no diff against HEAD at all.
 *
 * A gate that cries wolf is on its way to being deleted by whoever it blocks
 * first — deploy-test.sh says as much about hiding a gate's reason. So the
 * question is asked by CONTENT: the export writes down a hash per source file,
 * and freshness compares hashes. A touched file is fresh. A changed one is not,
 * and can be named, which is more use than "the newest file" ever was.
 *
 * Written by tools/patch-web-html.mjs, which is the last step of
 * `npm run export:web`, and read by e2e/freshness.ts.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { APP_DIR } from './app-identity.mjs';

/** Everything the bundle is built from. Kept here so the writer and the
 *  reader cannot disagree about what counts as a source. The app's own
 *  directory comes from tools/app-identity.json; the paths stay relative to
 *  the working directory (the checkout root), as the recorded keys are.
 *  app.json is in it because src/brand.ts imports it (the app's name), so
 *  the bundle changes with it. */
export const SOURCES = [
  `${APP_DIR}/src`,
  `${APP_DIR}/App.tsx`,
  `${APP_DIR}/index.ts`,
  `${APP_DIR}/app.json`,
  'packages/core/src',
];

/** Shared code OUTSIDE this app that the bundle reaches through the file:
 *  link to @mind/core. Several files in packages/core/src are one-line
 *  re-exports of `@mind/core/<name>`; the code itself is in these stubs and in
 *  whatever they re-export (packages/mind-core). Hashing only this app's tree
 *  left them out, so an edit to the shared parser read as a FRESH export. Each
 *  file here is walked, and every relative `from '…'` in it is followed to the
 *  file it names, so a new stub pointing somewhere new is covered too. */
export const LINKED = ['../packages/mind-core/src'];

const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs|json)$/;
const RELATIVE_FROM = /\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g;

function walk(path, out) {
  if (!existsSync(path)) return;
  const st = statSync(path);
  if (!st.isDirectory()) {
    if (CODE.test(path)) out.push(path);
    return;
  }
  for (const entry of readdirSync(path).sort()) walk(join(path, entry), out);
}

/** The file a relative import names, as a bundler would find it, or null. */
function resolveRelative(from, spec) {
  const base = join(dirname(from), spec);
  for (const p of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, 'index.ts')]) {
    if (existsSync(p) && statSync(p).isFile() && CODE.test(p)) return p;
  }
  return null;
}

/** Every LINKED file, plus what those files re-export, followed to the end. */
function linkedFiles() {
  const seen = new Set();
  const queue = [];
  for (const l of LINKED) walk(l, queue);
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of readFileSync(f, 'utf8').matchAll(RELATIVE_FROM)) {
      const target = resolveRelative(f, m[1]);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return [...seen];
}

/** Every source file the digest covers, sorted. */
export function sourceFiles() {
  const files = [];
  for (const s of SOURCES) walk(s, files);
  for (const f of linkedFiles()) if (!files.includes(f)) files.push(f);
  return files.sort();
}

/** `{ 'relative/path.ts': '<sha256>' }` for every source file, sorted. */
export function sourceHashes() {
  const files = sourceFiles();
  const out = {};
  for (const f of files) {
    out[f] = createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16);
  }
  return out;
}

/** What changed between a recorded map and the tree as it is now. */
export function changedSince(recorded) {
  const now = sourceHashes();
  const changed = [];
  for (const [f, h] of Object.entries(now)) {
    if (recorded[f] === undefined) changed.push(`${f} (new)`);
    else if (recorded[f] !== h) changed.push(f);
  }
  for (const f of Object.keys(recorded)) {
    if (now[f] === undefined) changed.push(`${f} (deleted)`);
  }
  return changed;
}
