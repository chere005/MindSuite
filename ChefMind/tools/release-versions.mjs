/**
 * The app's version, read from EVERY file that carries it, and checked for
 * agreement. The release workflow's `prepare` job and tools/preflight.sh both
 * run this, so "what is the version" has one answer.
 *
 *   node tools/release-versions.mjs            print the version; exit 1 if the files disagree
 *   node tools/release-versions.mjs 1.30.0     the same, and exit 1 unless that is the version
 *
 * The files that move together (the five tools/dtp.sh bumps):
 *   package.json, app/app.json (expo.version), desktop/package.json,
 *   desktop/src-tauri/tauri.conf.json, desktop/src-tauri/Cargo.toml.
 * The lockfiles mirror them (package-lock.json by tools/sync-lock-versions.mjs,
 * Cargo.lock only when cargo is on the lane's PATH), so they are reported as
 * warnings, never as a reason to refuse: a stale lock does not change what ships.
 *
 * stdout is the version and nothing else (so `v=$(node ...)` works); every
 * diagnostic goes to stderr. Under GitHub Actions the failures are also
 * written as ::error annotations naming the files.
 */
import { readFileSync, existsSync } from 'node:fs';

const tag = process.argv[2] ?? '';
const onCI = process.env.GITHUB_ACTIONS === 'true';
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));

const files = [
  ['package.json', () => json('package.json').version],
  ['app/app.json', () => json('app/app.json').expo?.version],
  ['desktop/package.json', () => json('desktop/package.json').version],
  ['desktop/src-tauri/tauri.conf.json', () => json('desktop/src-tauri/tauri.conf.json').version],
  [
    'desktop/src-tauri/Cargo.toml',
    () => {
      // The [package] table is the first one; its version line is the app's.
      const m = readFileSync('desktop/src-tauri/Cargo.toml', 'utf8').match(/^version\s*=\s*"([^"]+)"/m);
      return m?.[1];
    },
  ],
];

const read = (get) => {
  try {
    const v = get();
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
};

const fail = (title, msg) => {
  if (onCI) console.error(`::error title=${title}::${msg}`);
  console.error(`${title}: ${msg}`);
  process.exit(1);
};

const found = files.map(([path, get]) => [path, read(get)]);
for (const [path, v] of found) console.error(`  ${path.padEnd(36)} ${v ?? '(no version found)'}`);

const missing = found.filter(([, v]) => v === null).map(([p]) => p);
if (missing.length) fail('Version unreadable', `no version in ${missing.join(', ')}`);

const distinct = [...new Set(found.map(([, v]) => v))];
if (distinct.length > 1) {
  fail(
    'Version files disagree',
    `these files must carry one version: ${found.map(([p, v]) => `${p}=${v}`).join(', ')}`,
  );
}
const version = distinct[0];

if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail('Not a version', `'${version}' is not <major>.<minor>.<patch>[-pre]`);
}
if (tag && tag !== version) {
  fail(
    'Tag and version differ',
    `the tag is ${tag} but ${found.map(([p]) => p).join(', ')} all say ${version}. Tags are bare versions (no "v"): tag the commit that carries the version.`,
  );
}

// Lockfiles: warn only.
const warn = (msg) => console.error(onCI ? `::warning title=Stale lockfile::${msg}` : `warning: ${msg}`);
try {
  if (existsSync('package-lock.json')) {
    const lock = json('package-lock.json');
    for (const [label, v] of [['package-lock.json', lock.version], ['package-lock.json (root package)', lock.packages?.['']?.version], ['package-lock.json (desktop)', lock.packages?.desktop?.version]]) {
      if (v && v !== version) warn(`${label} says ${v}, the app is ${version} (node tools/sync-lock-versions.mjs)`);
    }
  }
  if (existsSync('desktop/src-tauri/Cargo.lock')) {
    const m = readFileSync('desktop/src-tauri/Cargo.lock', 'utf8').match(/name = "chefmind-desktop"\r?\nversion = "([^"]+)"/);
    if (m && m[1] !== version) warn(`desktop/src-tauri/Cargo.lock says ${m[1]}, the app is ${version}`);
  }
} catch {
  // A lockfile that cannot be read is not the release's problem.
}

console.log(version);
