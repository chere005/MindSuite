#!/usr/bin/env node
/**
 * `tauri build` / `tauri dev`, with the build-time API's origin in the CSP.
 *
 * WHY. `EXPO_PUBLIC_API_URL` points an export at another server (config.ts),
 * and Expo inlines it into the bundle — but the desktop window's CSP in
 * tauri.conf.json only lets the page talk to https://seancheren.com. A desktop
 * build pointed anywhere else then fails every request as "Load failed" while
 * the phone, built from the same export, works (paid for once already, by the
 * TestCalMind fork, 2026-09-16). So the setting was build-time everywhere
 * except the one place that also had to agree with it.
 *
 * WHAT. With the variable unset this is exactly `tauri <args>`: the CSP stays
 * as committed and the release builds are byte-for-byte what they were. With
 * it set, the API's ORIGIN is added to `connect-src` through Tauri's own
 * `--config` merge, so tauri.conf.json is never rewritten mid-build. And the
 * export has to agree: a stale `apps/app/dist` built without the variable
 * would ship a window whose CSP allows one server while its code calls
 * another, so that refuses rather than building.
 *
 *   EXPO_PUBLIC_API_URL=https://test.seancheren.com/calmind/api/index.php \
 *     npm run export:web && npm -w desktop run build
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The origin a build-time API URL needs, or null when none is set. */
export function apiOrigin(apiUrl) {
  const raw = typeof apiUrl === 'string' ? apiUrl.trim() : '';
  if (raw === '') return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`EXPO_PUBLIC_API_URL is not a URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`EXPO_PUBLIC_API_URL must be http(s): ${raw}`);
  }
  return url.origin;
}

/** The CSP with `origin` allowed in connect-src; unchanged if it already is. */
export function connectCsp(csp, origin) {
  if (!origin) return csp;
  const parts = csp.split(';').map((p) => p.trim()).filter(Boolean);
  const i = parts.findIndex((p) => p.split(/\s+/)[0] === 'connect-src');
  if (i < 0) return [...parts, `connect-src 'self' ${origin}`].join('; ');
  const sources = parts[i].split(/\s+/).slice(1);
  if (sources.includes(origin)) return csp;
  parts[i] = ['connect-src', ...sources, origin].join(' ');
  return parts.join('; ');
}

/**
 * The value Expo's export sees: the process environment first, then the env
 * files Expo itself loads for a production export, in its order. ARCHITECTURE
 * documents `apps/app/.env.local` as a place to set it, and a value the export
 * read but this did not would be exactly the mismatch this script exists for.
 */
export function buildApiUrl(env, appDir) {
  const fromEnv = (env.EXPO_PUBLIC_API_URL ?? '').trim();
  if (fromEnv !== '') return fromEnv;
  for (const name of ['.env.production.local', '.env.local', '.env.production', '.env']) {
    const p = join(appDir, name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?EXPO_PUBLIC_API_URL\s*=\s*(.*?)\s*$/.exec(line);
      if (m) return m[1].replace(/^(['"])(.*)\1$/, '$2').trim();
    }
  }
  return '';
}

/** Does any JS file under `dir` carry `needle`? The export inlines the URL. */
function exportCarries(dir, needle) {
  if (!existsSync(dir)) return false;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (exportCarries(p, needle)) return true;
    } else if (name.endsWith('.js') && readFileSync(p, 'utf8').includes(needle)) {
      return true;
    }
  }
  return false;
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const conf = JSON.parse(readFileSync(join(here, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const base = conf.app.security.csp;
  const apiUrl = buildApiUrl(process.env, join(here, '..', 'apps', 'app'));
  const origin = apiOrigin(apiUrl);
  const csp = connectCsp(base, origin);
  const extra = [];
  if (origin) {
    const dist = join(here, '..', 'apps', 'app', 'dist');
    if (!exportCarries(dist, apiUrl)) {
      console.error(`refusing: EXPO_PUBLIC_API_URL is ${apiUrl}, but apps/app/dist was exported without it.`);
      console.error('  Export with the same value first: npm run export:web');
      process.exit(1);
    }
    if (csp !== base) extra.push('--config', JSON.stringify({ app: { security: { csp } } }));
    console.log(`desktop: API ${apiUrl} — connect-src allows ${origin}`);
  }
  // The workspace's own CLI, so a direct `node tauri-build.mjs` runs the same
  // tauri an `npm run` would; PATH is the fallback for an unusual install.
  const local = [join(here, 'node_modules', '.bin', 'tauri'), join(here, '..', 'node_modules', '.bin', 'tauri')]
    .find((p) => existsSync(p));
  const r = spawnSync(local ?? 'tauri', [...process.argv.slice(2), ...extra], {
    cwd: here,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.error) {
    console.error(`could not run tauri: ${r.error.message}`);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
