#!/usr/bin/env node
// Create (or inspect, or back up) one app's Tauri update-signing key pair in the separate auto-locking keychain.
//
//   node tools/updater-keygen.mjs <App> [--pub-out FILE] [--replace]
//   node tools/updater-keygen.mjs <App> --status
//   node tools/updater-keygen.mjs <App> --export-backup FILE      (a 0600 file OUTSIDE any git work tree)
//
// (tools/updater-keygen.sh is the same command.) The private key and its password are generated here, written into the
// keychain, checked by signing a file with them, and then the temporary key file is deleted. Nothing secret is printed:
// the only output is the PUBLIC key, which belongs in the app's tauri.conf.json (plugins.updater.pubkey).
//
// Replacing a key strands every installed copy that trusts the old public key until a release signed by the OLD key
// ships the new one, so an existing key is never replaced without --replace.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as kc from './updater-keychain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.error('usage: updater-keygen.mjs <App> [--pub-out FILE] [--replace] | --status | --export-backup FILE');
  process.exit(2);
}

const args = process.argv.slice(2);
const app = args.shift();
if (!app || app.startsWith('-')) usage();
kc.checkApp(app);
const opt = { pubOut: null, replace: false, status: false, backup: null };
while (args.length) {
  const a = args.shift();
  if (a === '--pub-out') opt.pubOut = args.shift() || usage();
  else if (a === '--replace') opt.replace = true;
  else if (a === '--status') opt.status = true;
  else if (a === '--export-backup') opt.backup = args.shift() || usage();
  else usage();
}

process.on('exit', () => kc.lock());

function die(msg) { console.error(`updater-keygen: ${msg}`); process.exit(1); }

try {
  if (opt.status) {
    if (!kc.exists()) { console.log(`${app}: no updater keychain yet`); process.exit(1); }
    kc.unlock();
    const pub = kc.get(app, 'public-key');
    console.log(pub ? `${app}: key present\npublic key: ${pub}` : `${app}: no key`);
    process.exit(pub ? 0 : 1);
  }

  if (opt.backup) {
    const dest = path.resolve(opt.backup);
    if (existsSync(dest)) die(`${dest} already exists`);
    const inGit = spawnSync('git', ['-C', path.dirname(dest), 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
    if (inGit.status === 0) die('refusing to write a private key inside a git work tree');
    kc.unlock();
    const key = kc.get(app, 'private-key'); const pw = kc.get(app, 'password'); const pub = kc.get(app, 'public-key');
    if (!key || !pw) die(`no key for ${app}`);
    writeFileSync(dest, JSON.stringify({ app, privateKey: key, password: pw, publicKey: pub }) + '\n', { mode: 0o600 });
    chmodSync(dest, 0o600);
    console.log(`${app}: backup written to ${dest} (mode 600); keep it offline`);
    process.exit(0);
  }

  const created = kc.ensure();
  kc.unlock();
  if (kc.get(app, 'private-key') && !opt.replace) {
    die(`${app} already has an update key. Replacing it strands installed copies; pass --replace only to rotate (ship a release signed by the old key that carries the new public key first).`);
  }
  const tauri = kc.findTauri(ROOT, app);
  const work = mkdtempSync(path.join(os.tmpdir(), 'updater-keygen-'));
  try {
    const password = randomBytes(24).toString('hex');
    const keyFile = path.join(work, 'key');
    const gen = spawnSync(tauri, ['signer', 'generate', '--ci', '-w', keyFile, '-p', password], { encoding: 'utf8' });
    if (gen.status !== 0) die(`tauri signer generate failed: ${(gen.stderr || '').trim().split('\n').slice(-1)[0]}`);
    const privateKey = readFileSync(keyFile, 'utf8').trim();
    const publicKey = readFileSync(`${keyFile}.pub`, 'utf8').trim();
    // Prove the pair works before it becomes the only copy: sign a file with what the keychain will hold.
    const probe = path.join(work, 'probe.txt');
    writeFileSync(probe, 'probe\n');
    const sign = spawnSync(tauri, ['signer', 'sign', '--app-version', '0.0.0', probe], {
      encoding: 'utf8', env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: privateKey, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password },
    });
    if (sign.status !== 0 || !existsSync(`${probe}.sig`)) die('the new key could not sign a probe file; nothing was stored');
    kc.put(app, 'private-key', privateKey);
    kc.put(app, 'password', password);
    kc.put(app, 'public-key', publicKey);
    if (kc.get(app, 'private-key') !== privateKey || kc.get(app, 'password') !== password) die('the keychain did not return what was stored');
    if (opt.pubOut) writeFileSync(opt.pubOut, `${publicKey}\n`);
    console.log(`${app}: update key ${created ? 'and keychain created' : 'created'} (${kc.keychainPath()})`);
    console.log(`public key: ${publicKey}`);
    console.log('Back it up offline: node tools/updater-keygen.mjs ' + app + ' --export-backup <file outside any repo>');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
} catch (e) {
  die(e.message);
}
