// The separate, auto-locking keychain that holds the per-app Tauri update-signing keys.
//
//   - The keys live ONLY here: never in a repo, a GitHub secret, a log or an environment file. The public key is the only
//     part that is committed (plugins.updater.pubkey in the app's tauri.conf.json).
//   - It is a keychain of its own (default ~/Library/Keychains/mindsuite-updater.keychain-db, MIND_UPDATER_KEYCHAIN
//     overrides), never added to the search list and never the default keychain. It locks itself 300 s after it is
//     unlocked and when the Mac sleeps, and every tool here locks it again on exit.
//   - Its own password is random and kept as one item in the login keychain ("MindSuite updater keychain"), so a release
//     lane can unlock it unattended. MIND_UPDATER_KEYCHAIN_PASSWORD supplies it instead (a test keychain, or a person who
//     keeps it in their head); then nothing is written to the login keychain.
//   - Secrets reach `security` on STDIN (`security -i`), never in argv, and leave it on stdout straight into a variable.
//     The one place a secret is in argv is `tauri signer generate -p <password>` for a few milliseconds at key creation,
//     because that command takes its password no other way.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const LOGIN_SERVICE = 'MindSuite updater keychain';
const LOGIN_ACCOUNT = 'mindsuite-updater';
const SAFE = /^[A-Za-z0-9+/=_.:-]+$/;

export function keychainPath(env = process.env) {
  return env.MIND_UPDATER_KEYCHAIN || path.join(os.homedir(), 'Library/Keychains/mindsuite-updater.keychain-db');
}

export function checkApp(app) {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(app || '')) throw new Error(`not an app name: ${app}`);
  return app;
}

const service = (app, kind) => `mindsuite-updater/${checkApp(app)}/${kind}`;

function quoted(s) {
  if (/["\n\r\\]/.test(s)) throw new Error('a value for security -i holds a quote, backslash or newline');
  return `"${s}"`;
}

/** Run one `security -i` command line; the line (and any secret in it) goes over stdin. */
function secI(line, run = spawnSync) {
  const r = run('security', ['-i'], { input: `${line}\n`, encoding: 'utf8' });
  if (r.error) throw new Error(`security: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`security failed (${r.status}): ${(r.stderr || '').trim().split('\n')[0] || 'no message'}`);
  return r.stdout || '';
}

function loginPassword(env) {
  const r = spawnSync('security', ['find-generic-password', '-s', LOGIN_SERVICE, '-a', LOGIN_ACCOUNT, '-w'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.replace(/\n$/, '');
}

function keychainPassword(env) {
  return env.MIND_UPDATER_KEYCHAIN_PASSWORD || loginPassword(env);
}

export function exists(env = process.env) {
  return existsSync(keychainPath(env));
}

/** Create the keychain on first use. The password is stored BEFORE the keychain exists, so a crash cannot strand it. */
export function ensure(env = process.env) {
  const kc = keychainPath(env);
  if (existsSync(kc)) return false;
  let pw = env.MIND_UPDATER_KEYCHAIN_PASSWORD;
  if (!pw) {
    pw = randomBytes(24).toString('hex');
    secI(`add-generic-password -U -s ${quoted(LOGIN_SERVICE)} -a ${quoted(LOGIN_ACCOUNT)} -w ${quoted(pw)} ${quoted(path.join(os.homedir(), 'Library/Keychains/login.keychain-db'))}`);
  }
  secI(`create-keychain -p ${quoted(pw)} ${quoted(kc)}`);
  // -l lock when the Mac sleeps, -u lock after the timeout, -t seconds
  secI(`set-keychain-settings -l -u -t 300 ${quoted(kc)}`);
  return true;
}

export function unlock(env = process.env) {
  const kc = keychainPath(env);
  if (!existsSync(kc)) throw new Error(`no updater keychain at ${kc} (run tools/updater-keygen.sh <App> first)`);
  const pw = keychainPassword(env);
  if (!pw) throw new Error('the updater keychain password is not available (login keychain item missing; set MIND_UPDATER_KEYCHAIN_PASSWORD)');
  secI(`unlock-keychain -p ${quoted(pw)} ${quoted(kc)}`);
}

export function lock(env = process.env) {
  const kc = keychainPath(env);
  if (existsSync(kc)) spawnSync('security', ['lock-keychain', kc], { stdio: 'ignore' });
}

export function put(app, kind, value, env = process.env) {
  if (!SAFE.test(value)) throw new Error(`the ${kind} value is not plain base64/hex text`);
  secI(`add-generic-password -U -s ${quoted(service(app, kind))} -a ${quoted(kind)} -w ${quoted(value)} ${quoted(keychainPath(env))}`);
}

/** The stored value, or null when there is none. The keychain must be unlocked. */
export function get(app, kind, env = process.env) {
  const r = spawnSync('security', ['find-generic-password', '-s', service(app, kind), '-a', kind, '-w', keychainPath(env)], { encoding: 'utf8' });
  if (r.status === 44) return null;
  if (r.status !== 0) throw new Error(`security find-generic-password failed (${r.status}): ${(r.stderr || '').trim().split('\n')[0]}`);
  return r.stdout.replace(/\n$/, '');
}

// A key set is three items (private key, its password, public key). A SLOT names a copy of the set: '' is the live one, 'next'
// a freshly made one that is not yet live, 'prev' the one a rotation replaced (kept so the transitional release can still be
// signed by the key the installed copies trust).
const SLOT_ITEMS = [['password', 'password'], ['publicKey', 'public-key'], ['privateKey', 'private-key']];   // private key LAST
export const slotKind = (kind, slot) => (slot ? `${kind}.${slot}` : kind);

/** { privateKey, password, publicKey }: each the stored value or null. */
export function getSlot(app, slot = '', env = process.env) {
  const out = {};
  for (const [field, kind] of SLOT_ITEMS) out[field] = get(app, slotKind(kind, slot), env);
  return out;
}
export const slotComplete = (set) => !!(set && set.privateKey && set.password && set.publicKey);
export const slotEmpty = (set) => !(set.privateKey || set.password || set.publicKey);
/** Write a whole set; the private key goes last, so a live private key means the others were written before it. */
export function putSlot(app, slot, set, env = process.env) {
  for (const [field, kind] of SLOT_ITEMS) put(app, slotKind(kind, slot), set[field], env);
}
export function removeSlot(app, slot, env = process.env) {
  for (const [, kind] of SLOT_ITEMS) remove(app, slotKind(kind, slot), env);
}

export function remove(app, kind, env = process.env) {
  spawnSync('security', ['delete-generic-password', '-s', service(app, kind), '-a', kind, keychainPath(env)], { stdio: 'ignore' });
}

/** Where a tauri CLI is: TAURI_BIN, the app's own node_modules, any app's, then PATH. */
export function findTauri(root, app, env = process.env) {
  if (env.TAURI_BIN) return env.TAURI_BIN;
  const candidates = [];
  for (const sub of ['', 'native', 'desktop']) candidates.push(path.join(root, app, sub, 'node_modules/.bin/tauri'));
  for (const a of ['PlanMind', 'TaskMind', 'CalMind', 'MealMind', 'AcctMind']) for (const sub of ['native', 'desktop', '']) candidates.push(path.join(root, a, sub, 'node_modules/.bin/tauri'));
  const found = candidates.find((c) => existsSync(c));
  if (found) return found;
  const which = spawnSync('which', ['tauri'], { encoding: 'utf8' });
  if (which.status === 0) return which.stdout.trim();
  throw new Error('no tauri CLI found: run npm ci in the app, or set TAURI_BIN');
}
