// The desktop shell's Content-Security-Policy follows the API the app was
// built against (EXPO_PUBLIC_API_URL, see app/src/config.ts). tauri.conf.json
// keeps the default policy (connect-src https://seancheren.com); a build with
// the variable set gets the same policy with that origin swapped for the
// configured server's, so pointing the app at another server also lets the
// webview reach it.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ORIGIN = 'https://seancheren.com';

/** The origin an API url allows. Unset/blank is the default; anything that is
 *  not an http(s) url throws, so a typo fails the build instead of shipping a
 *  shell that cannot reach its server. */
export function connectOrigin(apiUrl) {
  const raw = typeof apiUrl === 'string' ? apiUrl.trim() : '';
  if (raw === '') return DEFAULT_ORIGIN;
  let u;
  try { u = new URL(raw); } catch { throw new Error(`EXPO_PUBLIC_API_URL is not a url: ${raw}`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`EXPO_PUBLIC_API_URL must be http(s): ${raw}`);
  return u.origin;
}

/** `csp` with the default connect-src origin replaced by the one `apiUrl` names. */
export function cspFor(csp, apiUrl) {
  const origin = connectOrigin(apiUrl);
  const re = new RegExp(`(connect-src[^;]*?)${DEFAULT_ORIGIN.replace(/[.]/g, '\\.')}`);
  if (!re.test(csp)) throw new Error(`no ${DEFAULT_ORIGIN} in connect-src of the configured CSP`);
  return csp.replace(re, `$1${origin}`);
}

/** EXPO_PUBLIC_API_URL as Expo will see it: the environment, then app/.env.local, then app/.env. */
export function configuredApiUrl(env = process.env, appDir = join(here, '..', 'app')) {
  if (env.EXPO_PUBLIC_API_URL != null) return env.EXPO_PUBLIC_API_URL;
  for (const f of ['.env.local', '.env']) {
    const p = join(appDir, f);
    if (!existsSync(p)) continue;
    const m = /^\s*(?:export\s+)?EXPO_PUBLIC_API_URL\s*=\s*(.*?)\s*$/m.exec(readFileSync(p, 'utf8'));
    if (m) return m[1].replace(/^(["'])(.*)\1$/, '$2');
  }
  return undefined;
}

/** The `--config` JSON merge for tauri, or null when the default stands. */
export function tauriConfigOverride(apiUrl, conf = JSON.parse(readFileSync(join(here, 'src-tauri', 'tauri.conf.json'), 'utf8'))) {
  if (connectOrigin(apiUrl) === DEFAULT_ORIGIN) return null;
  return { app: { security: { csp: cspFor(conf.app.security.csp, apiUrl) } } };
}
