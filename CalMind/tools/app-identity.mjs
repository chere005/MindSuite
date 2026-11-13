/**
 * Which app this checkout builds, for the shared build tools.
 *
 * tools/source-digest.mjs, tools/patch-web-html.mjs, tools/sw.js and
 * desktop/stage-dist.sh are the same code in every app that carries them;
 * the only things that ever differed between those copies were per-app
 * values — where the Expo app lives, the prefix on cache names and element
 * ids, and the name a failed boot and the web manifest show. Each of those
 * now comes from ONE app-owned place, so the tools themselves stay
 * byte-identical to canon:
 *
 *   tools/app-identity.json   (app-owned; canon's copy holds CalMind's values)
 *     appDir   the Expo app, relative to the checkout root ("apps/app", "app")
 *     id       lower-case prefix for cache names and the head patch's element
 *              ids ("calmind" → cache `calmind-<bundle>`, `<style id="calmind-bg">`)
 *   <appDir>/app.json
 *     expo.name   the display name ("CalMind"), the name Expo already
 *                 builds the app under — not repeated in the file above
 *
 * Everything is read relative to THIS file, not the working directory, so
 * the answer does not depend on where a tool was started from. A value that
 * is missing or malformed throws: a build that cannot say which app it is
 * must not guess, because a wrong id silently shares (or deletes) another
 * app's service-worker caches on a shared origin.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, 'tools', 'app-identity.json');

function fail(what) {
  throw new Error(`app-identity: ${what} (${CONFIG})`);
}

const raw = JSON.parse(readFileSync(CONFIG, 'utf8'));

/** The Expo app's directory, relative to the checkout root. */
export const APP_DIR = raw.appDir;
if (typeof APP_DIR !== 'string' || !/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(APP_DIR)) {
  fail(`appDir must be a plain relative path like "apps/app", got ${JSON.stringify(APP_DIR)}`);
}

/** Lower-case prefix for cache names and element ids. */
export const APP_ID = raw.id;
if (typeof APP_ID !== 'string' || !/^[a-z][a-z0-9]*$/.test(APP_ID)) {
  fail(`id must be lower-case letters and digits, got ${JSON.stringify(APP_ID)}`);
}

const appJson = JSON.parse(readFileSync(join(ROOT, APP_DIR, 'app.json'), 'utf8'));

/** The display name: app.json's expo.name. Letters, digits and spaces only,
 *  because it is written into an inline script and a JSON manifest as is. */
export const APP_NAME = appJson?.expo?.name;
if (typeof APP_NAME !== 'string' || !/^[A-Za-z0-9 ]+$/.test(APP_NAME)) {
  fail(`${APP_DIR}/app.json expo.name must be letters, digits and spaces, got ${JSON.stringify(APP_NAME)}`);
}
