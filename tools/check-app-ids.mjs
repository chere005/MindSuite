#!/usr/bin/env node
// Do the apps' sign-in ids agree everywhere they are spelled?
//
//   node tools/check-app-ids.mjs
//
// App sign-in couples four places, and nothing else compares them:
//   - each app's app.json: expo.slug (APP_ID, sent as /account/app/?app=) and expo.scheme (the
//     redirect "<scheme>:/signin"), which must equal ios.bundleIdentifier and android.package;
//   - its desktop shell's tauri.conf.json identifier, "<scheme>.desktop";
//   - the client registry MSA_APP_SIGNIN_CLIENTS (packages/mind-server/lib/mindsuite-app-signin.php):
//     the slug is a key there and the scheme is that client's scheme;
//   - CalMind's SUITE_SPACE_APPS (CalMind/server/lib/app.php): every app it maps a space to is a
//     registry key, because signin_redeem takes the client key from the space, not the request.
// A registry key that is no app's slug is reported too: a client nothing signs in as.
//
// Fail-closed: a file that is missing, or a constant this reader cannot parse exactly, is a
// failure, never a skip. Node built-ins only.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SUITE_ROOT = path.resolve(HERE, '..');

/** The apps that sign in through /account/app/: their app.json and desktop config, from the suite root. */
export const APPS = [
  { app: 'CalMind', appJson: 'CalMind/apps/app/app.json', tauri: 'CalMind/desktop/src-tauri/tauri.conf.json' },
  { app: 'MealMind', appJson: 'MealMind/app/app.json', tauri: 'MealMind/desktop/src-tauri/tauri.conf.json' },
];
export const REGISTRY = 'packages/mind-server/lib/mindsuite-app-signin.php';
export const SPACE_APPS = 'CalMind/server/lib/app.php';

function read(root, rel) {
  const abs = path.join(root, ...rel.split('/'));
  if (!existsSync(abs)) throw new Error(`${rel}: missing`);
  return readFileSync(abs, 'utf8');
}

/** The body of `const NAME = [ ... ];` (top level, one per file). */
function constBody(text, name, rel) {
  const all = [...text.matchAll(new RegExp(`^const ${name} = \\[([\\s\\S]*?)\\];`, 'gm'))];
  if (all.length !== 1) throw new Error(`${rel}: expected one "const ${name} = [...];", found ${all.length}`);
  return all[0][1];
}

/** Every match of `entry` in `body`, which must hold nothing else but whitespace. */
function entries(body, entry, name, rel) {
  const found = [...body.matchAll(entry)];
  const rest = body.replace(entry, '').trim();
  if (rest !== '') throw new Error(`${rel}: ${name} holds something this check cannot read: ${JSON.stringify(rest.slice(0, 80))}`);
  return found;
}

export function readRegistry(root) {
  const text = read(root, REGISTRY);
  const body = constBody(text, 'MSA_APP_SIGNIN_CLIENTS', REGISTRY);
  const rows = entries(body, /'([^']*)'\s*=>\s*\[\s*'name'\s*=>\s*'([^']*)'\s*,\s*'scheme'\s*=>\s*'([^']*)'\s*\]\s*,?/g,
    'MSA_APP_SIGNIN_CLIENTS', REGISTRY);
  const out = new Map();
  for (const [, key, name, scheme] of rows) {
    if (out.has(key)) throw new Error(`${REGISTRY}: MSA_APP_SIGNIN_CLIENTS lists '${key}' twice`);
    out.set(key, { name, scheme });
  }
  return out;
}

export function readSpaceApps(root) {
  const text = read(root, SPACE_APPS);
  const body = constBody(text, 'SUITE_SPACE_APPS', SPACE_APPS);
  return entries(body, /'([^']*)'\s*=>\s*'([^']*)'\s*,?/g, 'SUITE_SPACE_APPS', SPACE_APPS).map(([, space, app]) => ({ space, app }));
}

/** Every disagreement, as one sentence each; empty when the ids agree. Throws when a file cannot be read. */
export function appIdProblems(root = SUITE_ROOT) {
  const problems = [];
  const registry = readRegistry(root);
  if (registry.size === 0) problems.push(`${REGISTRY}: MSA_APP_SIGNIN_CLIENTS is empty`);
  const slugs = new Set();
  for (const { app, appJson, tauri } of APPS) {
    let expo;
    try { expo = JSON.parse(read(root, appJson)).expo ?? {}; } catch (e) { throw new Error(`${appJson}: ${e.message}`); }
    const slug = expo.slug;
    const scheme = expo.scheme;
    slugs.add(slug);
    const client = typeof slug === 'string' ? registry.get(slug) : undefined;
    if (!client) {
      problems.push(`${app}: expo.slug '${slug}' is not a client in ${REGISTRY} (MSA_APP_SIGNIN_CLIENTS)`);
    } else if (client.scheme !== scheme) {
      problems.push(`${app}: expo.scheme '${scheme}' is not the registry's scheme '${client.scheme}' for '${slug}'`);
    }
    const ios = expo.ios?.bundleIdentifier;
    const android = expo.android?.package;
    if (ios !== scheme) problems.push(`${app}: ios.bundleIdentifier '${ios}' is not expo.scheme '${scheme}'`);
    if (android !== scheme) problems.push(`${app}: android.package '${android}' is not expo.scheme '${scheme}'`);
    let identifier;
    try { identifier = JSON.parse(read(root, tauri)).identifier; } catch (e) { throw new Error(`${tauri}: ${e.message}`); }
    if (identifier !== `${scheme}.desktop`) problems.push(`${app}: ${tauri} identifier '${identifier}' is not '${scheme}.desktop'`);
  }
  for (const key of registry.keys()) {
    if (!slugs.has(key)) problems.push(`${REGISTRY}: client '${key}' is no app's expo.slug (APPS in tools/check-app-ids.mjs)`);
  }
  for (const { space, app } of readSpaceApps(root)) {
    if (!registry.has(app)) problems.push(`${SPACE_APPS}: SUITE_SPACE_APPS maps space '${space}' to '${app}', which is not a client in ${REGISTRY}`);
  }
  return problems;
}

export function main({ root = SUITE_ROOT, out = console.log, err = console.error } = {}) {
  let problems;
  try {
    problems = appIdProblems(root);
  } catch (e) {
    err(`FAIL ${e.message}`);
    return 1;
  }
  for (const p of problems) err(`FAIL ${p}`);
  out(`app ids: ${APPS.length} apps, ${problems.length} problem(s)`);
  return problems.length === 0 ? 0 : 1;
}

function isMain() {
  try { return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}
if (isMain()) process.exitCode = main();
