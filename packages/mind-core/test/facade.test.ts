// @mind/core holds the shared module bodies in src/. Each linked app reaches a
// body through a one-line stub in its own packages/core/src (`export * from
// '@mind/core/<name>'`). This suite guards the package itself (its exports map,
// its closed import graph) and those app stubs, not the module behaviour (the
// rest of test/ owns that), bar normalize's default profile, which the app
// wrappers stand on. It never imports the package by its own name: every
// module is loaded by file path, so a broken exports map cannot hide behind a
// self-reference that happens to resolve.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalize, SUITE_SEEDS, type SeedProfile } from '../src/normalize';
import type { AnyRec } from '../src/types';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SUITE = resolve(PKG, '../..');
const SRC = join(PKG, 'src');

const manifest = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as {
  name: string;
  exports: Record<string, string>;
};
const entries = Object.entries(manifest.exports);
const exportKeys = new Set(Object.keys(manifest.exports));

const srcFiles = readdirSync(SRC)
  .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
  .sort();
// Every src file is a body (types.ts included); none is a stub of something else.
const bodies = srcFiles;

const ANY_REEXPORT = /\bexport\s*\*\s*(?:as\s+\w+\s+)?from\b/;
// Every relative specifier a module loads: `from '…'`, `import('…')`, `import '…'`.
const RELATIVE_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]*)['"]/gm;
// Any file that re-exports an @mind/core subpath, whatever its bytes.
const MIND_CORE_REEXPORT = /\bexport\s*\*\s*from\s*['"]@mind\/core\//;

describe('@mind/core exports map', () => {
  it('names the package and exports something', () => {
    expect(manifest.name).toBe('@mind/core');
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)('%s resolves to an existing ./src/*.ts file', (key, target) => {
    expect(key).toMatch(/^\.\/[a-z0-9-]+$/);
    expect(target).toBe(`./src/${key.slice(2)}.ts`);
    expect(existsSync(join(PKG, target)), `${key} -> ${target} is missing`).toBe(true);
  });

  it('exports every src/*.ts file but index.ts (nothing is unreachable)', () => {
    const files = srcFiles.map((f) => `./${f.slice(0, -3)}`).sort();
    expect(files).toEqual([...exportKeys].sort());
  });
});

describe('src bodies are a closed set', () => {
  it('has bodies, types.ts among them', () => {
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies).toContain('types.ts');
  });

  it.each(bodies)('%s has no re-export and no relative import outside src/', (file) => {
    const path = join(SRC, file);
    const text = readFileSync(path, 'utf8');
    expect(ANY_REEXPORT.test(text), `${file} contains an export * from; bodies are real code`).toBe(false);
    for (const m of text.matchAll(RELATIVE_SPEC)) {
      const spec = m[1] ?? '';
      const target = resolve(dirname(path), spec);
      const inside = relative(SRC, target).replace(/\\/g, '/');
      expect(inside.startsWith('..'), `${file} imports '${spec}', which leaves packages/mind-core/src`).toBe(false);
      const real = [target, `${target}.ts`].find((p) => existsSync(p) && p.endsWith('.ts'));
      expect(real, `${file} imports '${spec}', which does not resolve to a src/*.ts file`).toBeDefined();
    }
  });
});

// The linked apps, the subpaths each one carries as a one-line stub, and the
// exported names it owns outright. No group in tools/shared-files.json carries
// the stubs (they are one-line re-exports, not copies of one origin file), so
// this table is the declaration and the tests below are its check: a stub that
// gains a byte, turns into a copy of the body or disappears fails here.
//   - normalize (CalMind, ChefMind): the app-owned wrapper guarded further down.
//   - day, sync, types (AcctMind): AcctMind's own ledger modules, which share
//     only a file name with the @mind/core ones and import nothing from them.
const APPS: { app: string; stubs: string[]; owns: string[] }[] = [
  {
    app: 'CalMind',
    stubs: [
      'b64u', 'backup', 'chefdate', 'dailylog', 'day', 'folds', 'habit', 'ical', 'layout',
      'manage', 'markdown', 'notesplit', 'order', 'parse', 'pkce', 'recipe', 'repeats', 'richtext',
      'rrule', 'rules', 'search', 'sort', 'sync', 'types', 'undo', 'update', 'watch',
    ],
    owns: ['normalize'],
  },
  {
    app: 'ChefMind',
    stubs: [
      'b64u', 'backup', 'dailylog', 'day', 'folds', 'manage', 'notesplit', 'order', 'parse', 'pkce',
      'recipe', 'repeats', 'richtext', 'rules', 'search', 'sort', 'sync', 'types', 'undo', 'update',
    ],
    owns: ['normalize'],
  },
  { app: 'AcctMind', stubs: ['folds'], owns: ['day', 'sync', 'types'] },
  { app: 'PlanMind', stubs: ['parse'], owns: [] },
  { app: 'TaskMind', stubs: ['parse'], owns: [] },
];
const stubText = (name: string) => `export * from '@mind/core/${name}';\n`;
const appSrc = (app: string) => join(SUITE, app, 'packages/core/src');

describe('linked apps reach the package through one-line stubs', () => {
  // Each linked app's file: dependency must point at this package.
  it.each([
    'CalMind/packages/core',
    'ChefMind/packages/core',
    'AcctMind/packages/core',
    'PlanMind',
    'TaskMind',
  ])('%s depends on this package by file: link', (dir) => {
    const pkg = JSON.parse(readFileSync(join(SUITE, dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const spec = pkg.dependencies?.['@mind/core'] ?? '';
    expect(spec.startsWith('file:'), `${dir} @mind/core is '${spec}'`).toBe(true);
    expect(resolve(SUITE, dir, spec.slice(5))).toBe(PKG);
  });

  it.each(APPS)('$app carries a stub for exactly its subpaths, and owns the rest by name', ({ app, stubs, owns }) => {
    expect(stubs.length, `${app} declares no stubs: nothing would be checked`).toBeGreaterThan(0);
    for (const name of [...stubs, ...owns]) {
      expect(exportKeys.has(`./${name}`), `${app}: ${name} is not an exported @mind/core subpath`).toBe(true);
    }
    const files = readdirSync(appSrc(app)).filter((f) => f.endsWith('.ts'));
    // Every file named like an exported subpath is a declared stub or app-owned:
    // a second copy of a shared body cannot sit in an app under the same name.
    const named = files.map((f) => f.slice(0, -3)).filter((n) => exportKeys.has(`./${n}`));
    expect(named.filter((n) => !owns.includes(n)).sort(), `${app}: stubs on disk`).toEqual([...stubs].sort());
    for (const name of owns) expect(named, `${app} owns ${name}.ts, which is gone`).toContain(name);
    // And nothing else in the app re-exports @mind/core behind a stub's back.
    const reexporting = files
      .filter((f) => MIND_CORE_REEXPORT.test(readFileSync(join(appSrc(app), f), 'utf8')))
      .map((f) => f.slice(0, -3));
    expect(reexporting.filter((n) => !owns.includes(n)).sort(), `${app}: files re-exporting @mind/core`).toEqual(
      [...stubs].sort(),
    );
  });

  it.each(APPS.flatMap(({ app, stubs }) => stubs.map((name) => [app, name] as const)))(
    '%s packages/core/src/%s.ts is exactly the one-line stub',
    (app, name) => {
      expect(readFileSync(join(appSrc(app), `${name}.ts`), 'utf8')).toBe(stubText(name));
    },
  );
});

// normalize is the one shared body whose per-app value (the seed profile) is
// bound outside the package: each app's packages/core/src/normalize.ts is an
// app-owned wrapper that defaults it to its own appconfig.ts APP_SEEDS. No
// group in tools/shared-files.json carries the wrappers, so their sameness is
// guarded here.
describe('normalize: the shared default and the app wrappers', () => {
  // normalize mints fresh ids (newId), so two runs differ only in those: name
  // every minted id by the order it was added, wherever it is referenced.
  const canonical = (out: { added: AnyRec[]; edited: AnyRec[] }): string => {
    let s = JSON.stringify(out);
    out.added.forEach((r, i) => {
      s = s.split(r.id).join(`#${i}`);
    });
    return s;
  };
  // normalize edits the records it is handed, so every run gets its own copy.
  const run = (recs: AnyRec[], profile?: SeedProfile) =>
    canonical(profile ? normalize(structuredClone(recs), profile) : normalize(structuredClone(recs)));

  const rec = (id: string, type: string, payload: Record<string, unknown>): AnyRec =>
    ({ id, type, updated: 1, payload }) as unknown as AnyRec;
  const stores: [string, AnyRec[]][] = [
    ['an empty store', []],
    ['a folder with no section', [rec('f', 'folder', { name: 'f', color: '#fff', ord: 'f', app: 'reminders' })]],
    ['a reminder in a folder that is gone', [
      rec('f', 'folder', { name: 'f', color: '#fff', ord: 'f', app: 'reminders' }),
      rec('s', 'section', { name: 's', folderId: 'f', ord: 's' }),
      rec('r', 'reminder', { text: 'r', due: null, time: null, done: false, repeat: null, folderId: 'GONE', sectionId: 's', indent: 0, ord: 'r' }),
    ]],
    ['an event on a dead calendar and a habit in a dead section', [
      rec('e', 'event', { title: 'e', date: '2026-01-01', calendarId: 'GONE' }),
      rec('h', 'habit', { name: 'h', sectionId: 'GONE', ord: 'h' }),
    ]],
  ];

  it.each(stores)('with no profile it runs SUITE_SEEDS: %s', (_name, recs) => {
    expect(run(recs)).toBe(run(recs, SUITE_SEEDS));
  });

  it('and the comparison can tell two profiles apart', () => {
    const lists: SeedProfile = {
      reminders: { kind: 'lists', shopping: { name: 'S', color: '#000' }, pantry: { name: 'P', color: '#111' } },
      calendar: false,
      habits: false,
    };
    expect(run([], lists)).not.toBe(run([]));
  });

  it('CalMind and ChefMind wrap it with the same bytes, defaulting to APP_SEEDS ?? SUITE_SEEDS', () => {
    const [cal, chef] = ['CalMind', 'ChefMind'].map((app) =>
      readFileSync(join(SUITE, app, 'packages/core/src/normalize.ts'), 'utf8'),
    );
    expect(chef, 'ChefMind/packages/core/src/normalize.ts differs from CalMind').toBe(cal);
    expect(cal).toMatch(/^export \* from '@mind\/core\/normalize';$/m);
    expect(cal).toMatch(/^import \{ APP_SEEDS \} from '\.\/appconfig';$/m);
    expect(cal).toMatch(/^export function normalize\(recs: AnyRec\[\], profile: SeedProfile = APP_SEEDS \?\? SUITE_SEEDS\)/m);
    expect(cal).toMatch(/^  return sharedNormalize\(recs, profile\);$/m);
    expect(exportKeys.has('./normalize')).toBe(true);
  });
});
