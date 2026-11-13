/**
 * Refuse to run the gesture suite against a stale export.
 *
 * The specs drive `apps/app/dist`, not the source, so an edit that never
 * made it through `npm run export:web` is tested in its absence — and the
 * suite says PASS for code that isn't there, or FAIL for a fix that is.
 * That is the worst kind of green: it looks like an answer. It has cost
 * real time twice (a `cd` left the shell in apps/app, the export's `&&`
 * chain short-circuited, and the run afterwards quietly used yesterday's
 * bundle), and TESTING.md already names a stale dist as the usual reason a
 * spec disagrees with dev.
 *
 * So: compare the source against the export and stop with an instruction
 * rather than a mystery.
 *
 * BY CONTENT, since 2026-08-12, and mtime only as the fallback. Two sessions
 * share this repo and an ordinary git operation in the other one rewrites
 * files to identical content — the mtime moves, the code does not. That read
 * as STALE three times in one session for `packages/core/src/order.ts`, which
 * had no diff against HEAD. Three needless re-exports is how a gate starts
 * being worked around. See tools/source-digest.mjs; the export writes a hash
 * per file and this compares them, which also lets the error NAME what
 * changed instead of pointing at whichever file was touched last.
 */
import { statSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// Shared with the writer so the two cannot disagree about what a source is,
// in the mtime fallback too: the list includes the shared @mind/core code
// outside this app (../packages/mind-core and the canon it re-exports).

// Loaded with a NATIVE import: Playwright's CJS hook rewrites a required .mjs
// to CommonJS, and the helper's `import.meta` (tools/app-identity.mjs) is a
// syntax error there — every spec died in globalSetup before it started.
// `new Function` keeps the transform from turning this import() into require().
const nativeImport = new Function('p', 'return import(p)') as (p: string) => Promise<any>;

const BUILT = 'apps/app/dist/index.html';
const MANIFEST = 'apps/app/dist/.sources.json';

export default async function checkExportIsFresh() {
  const { changedSince, sourceFiles } = await nativeImport(
    pathToFileURL(join(__dirname, '..', 'tools', 'source-digest.mjs')).href,
  );
  if (!existsSync(BUILT)) {
    throw new Error(`No web export at ${BUILT}. Run: npm run export:web`);
  }
  // The content answer, when the export left one behind.
  if (existsSync(MANIFEST)) {
    let recorded: Record<string, string> | null = null;
    try {
      recorded = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, string>;
    } catch {
      // A manifest that will not parse tells us nothing; fall through to
      // mtimes rather than treat an unreadable file as agreement.
      recorded = null;
    }
    if (recorded) {
      const changed: string[] = changedSince(recorded);
      if (changed.length === 0) return;
      throw new Error(
        `The web export is STALE — ${changed.length} source file(s) changed since it was built:\n` +
          changed.slice(0, 8).map((f) => `  · ${f}`).join('\n') +
          (changed.length > 8 ? `\n  · …and ${changed.length - 8} more` : '') +
          `\nThe specs drive the export, so this run would test the old bundle.\n` +
          `Run: npm run export:web`,
      );
    }
  }

  // No manifest (an export from before this existed, or one that did not
  // finish): the original mtime rule, which is right more often than not.
  const built = statSync(BUILT).mtimeMs;
  let newest = { at: 0, file: '' };
  for (const file of sourceFiles() as string[]) {
    const at = statSync(file).mtimeMs;
    if (at > newest.at) newest = { at, file };
  }
  if (newest.at > built) {
    const behind = Math.round((newest.at - built) / 1000);
    throw new Error(
      `The web export is STALE — ${newest.file} is ${behind}s newer than ${BUILT}.\n` +
        `The specs drive the export, so this run would test the old bundle.\n` +
        `Run: npm run export:web`,
    );
  }
}
