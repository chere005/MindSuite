/**
 * A stable fingerprint of the source the web export is built FROM.
 *
 * Written into `dist/build.json` by the export and re-computed by the e2e
 * suite before it runs. If they disagree, the dist is stale and the suite
 * refuses rather than reporting on code nobody is looking at — a green run
 * against last week's bundle is worse than no run, because it is believed.
 *
 * tools/dist-key.mjs keys the deploy's gesture verdict by build.json's
 * `digest`, so whatever this covers, that key covers too.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/** Everything that ends up in the bundle. Order-stable, so the hash is too. */
export const SOURCES = ['packages/core/src', 'apps/app/src', 'apps/app/App.tsx', 'apps/app/index.ts'];

/** Shared code OUTSIDE this app that the bundle reaches through the file:
 *  link to @mind/core (node_modules/@mind/core -> ../packages/mind-core).
 *  Files in packages/core/src that are one-line `@mind/core/<name>` stubs
 *  hold no code; it is in these stubs and in the packages/mind-core bodies
 *  they re-export. Each file here is walked and every relative `from '…'` in
 *  it is followed to the file it names, so a new stub pointing somewhere new
 *  is covered too. Same reach as CalMind's and ChefMind's digests. */
export const LINKED = ['../packages/mind-core/src'];

const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs|json)$/;
const RELATIVE_FROM = /\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g;

/** The file a relative import names, as a bundler would find it, or null. */
function resolveRelative(from, spec) {
  const base = join(dirname(from), spec);
  for (const p of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, 'index.ts')]) {
    if (existsSync(p) && statSync(p).isFile() && CODE.test(p)) return p;
  }
  return null;
}

/** Every LINKED file, plus what those files re-export, followed to the end,
 *  sorted. A LINKED directory that is missing is an error, never a shorter
 *  digest: the app cannot be built without it, so neither can a fingerprint. */
export function linkedFiles(root = process.cwd()) {
  const seen = new Set();
  const queue = [];
  for (const l of LINKED) {
    const dir = join(root, l);
    if (!existsSync(dir)) throw new Error(`no ${dir} to key the shared @mind/core code by`);
    queue.push(...walk(dir).filter((f) => CODE.test(f)));
  }
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of readFileSync(f, 'utf8').matchAll(RELATIVE_FROM)) {
      const target = resolveRelative(f, m[1]);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return [...seen].sort();
}

export function sourceDigest(root = process.cwd()) {
  const h = createHash('sha256');
  for (const entry of SOURCES) {
    for (const f of walk(join(root, entry))) {
      h.update(f.slice(root.length)).update(readFileSync(f));
    }
  }
  // Named by their path from this app's root with forward slashes, so the
  // same tree digests the same on every OS.
  for (const f of linkedFiles(root)) {
    h.update(`linked\0${relative(root, f).replace(/\\/g, '/')}\0`).update(readFileSync(f));
  }
  return h.digest('hex').slice(0, 16);
}

function walk(p) {
  if (!statSync(p).isDirectory()) return [p];
  const out = [];
  for (const name of readdirSync(p).sort()) out.push(...walk(join(p, name)));
  return out;
}
