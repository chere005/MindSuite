#!/usr/bin/env node
// Create (or inspect, rotate or back up) one app's Tauri update-signing key pair in the separate auto-locking keychain.
//
//   node tools/updater-keygen.mjs <App> [--pub-out FILE]            first key for an app
//   node tools/updater-keygen.mjs <App> --replace [--pub-out FILE]  rotate: new key live, old key kept as "prev"
//   node tools/updater-keygen.mjs <App> --status
//   node tools/updater-keygen.mjs <App> --drop-prev                 after the transitional release shipped: forget the old key
//   node tools/updater-keygen.mjs <App> --recover                   finish a rotation that was interrupted
//   node tools/updater-keygen.mjs <App> --export-backup FILE        two 0600 files (FILE and FILE.password) OUTSIDE any git work tree
//
// (tools/updater-keygen.sh is the same command.) The private key and its password are generated here, written into the
// keychain, checked by signing a file with them, and then the temporary key file is deleted (also when a check fails).
// Nothing secret is printed: the only output is the PUBLIC key, which belongs in the app's tauri.conf.json
// (plugins.updater.pubkey).
//
// ROTATION. Installed copies trust the OLD public key, so the first release that carries the new public key must still be
// signed by the OLD key; only the release after it is signed by the new one. --replace therefore never loses the old key:
//   1. the new key is made and written under the "next" slot; it is checked by signing a file with the values READ BACK;
//   2. the live key is copied to the "prev" slot (all three items, verified) BEFORE the live slot is touched;
//   3. next becomes live (verified by signing again) and the next slot is deleted.
// Every step leaves a complete old key (live or prev) and a complete new key (next or live) in the keychain, so an
// interruption between any two writes is repaired by --recover. Then: put the printed public key in tauri.conf.json, ship
// the transitional release with `publish-update.mjs --sign-with-prev-key`, ship later releases normally, and only when no
// installed copy can still be on the old key run --drop-prev.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as kc from './updater-keychain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.error('usage: updater-keygen.mjs <App> [--pub-out FILE] [--replace] | --status | --drop-prev | --recover | --export-backup FILE');
  process.exit(2);
}

const args = process.argv.slice(2);
const app = args.shift();
if (!app || app.startsWith('-')) usage();
kc.checkApp(app);
const opt = { pubOut: null, replace: false, status: false, backup: null, dropPrev: false, recover: false };
while (args.length) {
  const a = args.shift();
  if (a === '--pub-out') opt.pubOut = args.shift() || usage();
  else if (a === '--replace') opt.replace = true;
  else if (a === '--status') opt.status = true;
  else if (a === '--drop-prev') opt.dropPrev = true;
  else if (a === '--recover') opt.recover = true;
  else if (a === '--export-backup') opt.backup = args.shift() || usage();
  else usage();
}

process.on('exit', () => kc.lock());

// die() THROWS: callers further up (the try/finally that deletes the temporary key file) always get to run; the one
// outermost catch prints the message and exits.
class Refused extends Error {}
function die(msg) { throw new Refused(msg); }

/** Sign a probe file with exactly these values: proves a key set works before and after it becomes the live one. */
function probeSign(tauri, work, set, what) {
  const probe = path.join(work, 'probe.txt');
  rmSync(`${probe}.sig`, { force: true });
  writeFileSync(probe, 'probe\n');
  const r = spawnSync(tauri, ['signer', 'sign', '--app-version', '0.0.0', probe], {
    encoding: 'utf8', env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: set.privateKey, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: set.password },
  });
  if (r.status !== 0 || !existsSync(`${probe}.sig`)) die(`${what} could not sign a probe file`);
}

const sameSet = (a, b) => a.privateKey === b.privateKey && a.password === b.password && a.publicKey === b.publicKey;

function describe(app) {
  const live = kc.getSlot(app, '');
  const prev = kc.getSlot(app, 'prev');
  const next = kc.getSlot(app, 'next');
  return { live, prev, next };
}

const SYNCED = [/\/Mobile Documents\//, /\/Library\/CloudStorage\//, /\/iCloud/i, /\/Dropbox/i, /\/Google Drive/i, /\/OneDrive/i, /\/Box( Sync)?\//];

function main() {
  if (opt.status) {
    if (!kc.exists()) { console.log(`${app}: no updater keychain yet`); process.exit(1); }
    kc.unlock();
    const { live, prev, next } = describe(app);
    console.log(live.publicKey ? `${app}: key present\npublic key: ${live.publicKey}` : `${app}: no key`);
    if (!kc.slotEmpty(prev)) console.log(`previous key kept for the transitional release${kc.slotComplete(prev) ? '' : ' (INCOMPLETE)'}; public key: ${prev.publicKey || 'missing'}`);
    if (!kc.slotEmpty(next)) console.log('an interrupted rotation left a "next" key: run --recover');
    process.exit(live.publicKey ? 0 : 1);
  }

  if (opt.backup) {
    const dest = path.resolve(opt.backup);
    const pwDest = `${dest}.password`;
    if (existsSync(dest) || existsSync(pwDest)) die(`${dest} or ${pwDest} already exists`);
    const inGit = spawnSync('git', ['-C', path.dirname(dest), 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
    if (inGit.status === 0) die('refusing to write a private key inside a git work tree');
    kc.unlock();
    const { live } = describe(app);
    if (!live.privateKey || !live.password) die(`no key for ${app}`);
    // The key and its password go into SEPARATE files: together they are the signing key, so they must not travel together.
    writeFileSync(dest, `${JSON.stringify({ app, privateKey: live.privateKey, publicKey: live.publicKey })}\n`, { mode: 0o600 });
    chmodSync(dest, 0o600);
    writeFileSync(pwDest, `${live.password}\n`, { mode: 0o600 });
    chmodSync(pwDest, 0o600);
    console.log(`${app}: backup written to ${dest} (the key) and ${pwDest} (its password), mode 600.`);
    console.log('Keep the two files in different places, offline; either one alone cannot sign.');
    if (SYNCED.some((rx) => rx.test(`${dest}/`))) console.error('WARNING: this path looks cloud-synced; the files are now copied off this Mac. Move them to an offline volume and delete these.');
    process.exit(0);
  }

  const created = kc.ensure();
  kc.unlock();

  if (opt.dropPrev) {
    const { prev } = describe(app);
    if (kc.slotEmpty(prev)) die(`${app} holds no previous key`);
    kc.removeSlot(app, 'prev');
    console.log(`${app}: the previous update key was deleted. Installed copies still on it can no longer be updated.`);
    return;
  }

  const tauri = kc.findTauri(ROOT, app);
  const work = mkdtempSync(path.join(os.tmpdir(), 'updater-keygen-'));
  try {
    if (opt.recover) { recover(tauri, work); return; }

    const { live, prev, next } = describe(app);
    if (!kc.slotEmpty(next)) die(`an interrupted rotation left a "next" key for ${app}: run --recover first`);
    if (live.privateKey && !opt.replace) {
      die(`${app} already has an update key. Replacing it strands installed copies unless the old key is kept and signs the transitional release; pass --replace to rotate (the old key is kept as "previous").`);
    }
    if (!live.privateKey && opt.replace) die(`${app} has no key to replace`);
    if (opt.replace) {
      if (!kc.slotEmpty(prev)) die(`${app} still holds the previous key of an earlier rotation: ship its transitional release, then run --drop-prev`);
      if (!kc.slotComplete(live)) die(`the live key of ${app} is incomplete; restore it from the offline backup instead of rotating`);
    }

    const password = randomBytes(24).toString('hex');
    const keyFile = path.join(work, 'key');
    const gen = spawnSync(tauri, ['signer', 'generate', '--ci', '-w', keyFile, '-p', password], { encoding: 'utf8' });
    if (gen.status !== 0) die(`tauri signer generate failed: ${(gen.stderr || '').trim().split('\n').slice(-1)[0]}`);
    const fresh = { privateKey: readFileSync(keyFile, 'utf8').trim(), password, publicKey: readFileSync(`${keyFile}.pub`, 'utf8').trim() };
    // Prove the pair works before it is stored anywhere.
    probeSign(tauri, work, fresh, 'the new key');

    if (!opt.replace) {
      kc.putSlot(app, '', fresh);
      const back = kc.getSlot(app, '');
      if (!sameSet(back, fresh)) die('the keychain did not return what was stored');
      probeSign(tauri, work, back, 'the stored key');
    } else {
      kc.putSlot(app, 'next', fresh);
      const back = kc.getSlot(app, 'next');
      if (!sameSet(back, fresh)) { kc.removeSlot(app, 'next'); die('the keychain did not return what was stored; the live key was not touched'); }
      probeSign(tauri, work, back, 'the stored new key');
      rotate(tauri, work);
    }
    if (opt.pubOut) writeFileSync(opt.pubOut, `${fresh.publicKey}\n`);
    console.log(`${app}: update key ${opt.replace ? 'rotated' : created ? 'and keychain created' : 'created'} (${kc.keychainPath()})`);
    console.log(`public key: ${fresh.publicKey}`);
    if (opt.replace) {
      console.log('The OLD key is kept as "previous". Put the new public key in plugins.updater.pubkey, then ship the transitional release signed by the old key:');
      console.log(`  node tools/publish-update.mjs --app ${app} --sign-with-prev-key ...`);
      console.log('Later releases are signed by the new key. After that, and only then: node tools/updater-keygen.mjs ' + app + ' --drop-prev');
    }
    console.log('Back it up offline: node tools/updater-keygen.mjs ' + app + ' --export-backup <file outside any repo>');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** next -> live, old live -> prev. Idempotent: a repeat after an interruption finishes the job. */
function rotate(tauri, work) {
  const next = kc.getSlot(app, 'next');
  if (!kc.slotComplete(next)) die('the "next" key is incomplete');
  probeSign(tauri, work, next, 'the new key');
  // "prev" complete means the old key was already copied (by this rotation: --replace refuses an existing prev), so the
  // live slot may be half-written and must not be copied again.
  if (!kc.slotComplete(kc.getSlot(app, 'prev'))) {
    const old = kc.getSlot(app, '');
    if (!kc.slotComplete(old)) die(`the live key of ${app} is incomplete and there is no previous copy; restore it from the offline backup`);
    kc.putSlot(app, 'prev', old);
    if (!sameSet(kc.getSlot(app, 'prev'), old)) die('the keychain did not return the previous key; the live key was not touched');
  }
  kc.putSlot(app, '', next);
  const live = kc.getSlot(app, '');
  if (!sameSet(live, next)) die('the keychain did not return the new live key; run --recover');
  probeSign(tauri, work, live, 'the live key');
  kc.removeSlot(app, 'next');
}

function recover(tauri, work) {
  const { next } = describe(app);
  if (kc.slotEmpty(next)) { console.log(`${app}: no interrupted rotation`); return; }
  if (!kc.slotComplete(next)) {
    kc.removeSlot(app, 'next');
    console.log(`${app}: the interrupted run had not finished making its new key; it was discarded and the live key was never touched. Run again.`);
    return;
  }
  rotate(tauri, work);
  console.log(`${app}: the interrupted rotation was finished. New public key: ${kc.getSlot(app, '').publicKey}`);
  console.log('The old key is kept as "previous" (see --drop-prev).');
}

try {
  main();
} catch (e) {
  console.error(`updater-keygen: ${e.message}`);
  process.exit(1);
}
