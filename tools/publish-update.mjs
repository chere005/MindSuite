#!/usr/bin/env node
// Publish one app's auto-update feed entry: sign the update artifacts with the app's update key, write latest.json, and
// upload it to the app's FIXED feed release LAST.
//
//   node tools/publish-update.mjs --app CalMind --version 2.3.0 \
//        --mac-app path/to/CalMind.app                       the stapled, notarized app that was installed/released
//        --win-nsis path/to/CalMind_2.3.0_x64-setup.exe      the Windows updater artifacts (either or both)
//        --win-msi  path/to/CalMind_2.3.0_x64_en-US.msi
//        [--notes-file docs/releases/2.3.0.md | --notes TEXT] [--repo OWNER/MindSuite]
//        [--dry-run DIR]                                      write the feed files into DIR; touch no network
//        [--mac-archive file.app.tar.gz]                      a prebuilt archive instead of --mac-app
//        [--allow-partial] [--keep 2] [--tauri PATH]
//        [--prerelease]       allow a pre-release version (a feed every installed copy follows is for releases)
//        [--force-feed]       allow a version that is not newer than the one latest.json holds now
//        [--sign-with-prev-key]  sign with the PREVIOUS key (the transitional release of a key rotation, see updater-keygen.mjs)
//        [--conf FILE]        the app's tauri.conf.json (default: <App>/*/src-tauri/tauri.conf.json), whose plugins.updater.pubkey the key must match
//   node tools/publish-update.mjs --app CalMind --preflight [--sign-with-prev-key]
//                              check, with no artifacts, that a publish WOULD be able to sign: the tauri CLI supports
//                              `signer sign --app-version`, and the keychain's key is the one the app trusts. dtp runs it BEFORE it ships anything.
//   node tools/publish-update.mjs --app CalMind --feed-url --repo OWNER/MindSuite    print the endpoint to configure
//
// THE FEED. Every app has ONE fixed release, tagged "<App>-updates" (a pre-release, never "Latest"), whose assets are the
// versioned update artifacts, their .sig files, and latest.json. The endpoint an app's tauri.conf.json carries is
//   https://github.com/OWNER/MindSuite/releases/download/<App>-updates/latest.json
// which never changes, however many apps release and whichever release the repo calls Latest (docs/PUBLISH.md, "Updates").
//
// ORDER. Artifacts and signatures are uploaded first, latest.json LAST: a client never sees a feed that names a file that is
// not there yet. `gh release upload --clobber` deletes the old asset and then uploads the new one, so it is NOT atomic: a
// failed latest.json upload is retried, and if it still fails the tool says plainly that the feed is missing and must be
// restored by running it again. After the upload the feed is downloaded again and compared.
//
// GUARDS. A pre-release version, and a version that is not strictly newer than the one latest.json holds, are refused
// before anything is signed (--prerelease, --force-feed), so a stray run cannot move every installed copy to an rc or back.
//
// WHAT IS SIGNED. macOS: the .app that passed `mac-sign-install.sh --verify-only` (Developer ID, hardened runtime,
// notarized, stapled, arm64; its CFBundleShortVersionString must equal --version), re-archived as <App>_<v>_aarch64.app.tar.gz
// with the .app as the top folder and no resource-fork or xattr junk. Windows: the installer file itself (Tauri v2 updates
// run the installer). Each is signed by `tauri signer sign --app-version <v>`, so the signature's trusted comment carries the
// version, which the app enforces (requireSignedVersion). Windows installers are NOT Authenticode signed by decision;
// the minisign signature and HTTPS protect the update.
//
// KEYS. The private key and its password come from the separate auto-locking keychain (tools/updater-keychain.mjs), reach
// the signer only through its environment, and are never printed. The keychain is locked again on exit.
//
// THE KEY MUST BE THE ONE THE APP TRUSTS. Before anything is signed, the keychain's public key is compared with
// plugins.updater.pubkey in the app's tauri.conf.json (what every installed copy carries), and after signing every .sig is
// verified against that public key (tools/minisign-verify.mjs). A recreated keychain, a key rotated without its pubkey being
// committed, or a pubkey changed without its key refuses the publish: a feed signed by a key nobody trusts would look healthy
// and silently strand every installed copy. While a rotation's previous key is still kept (updater-keygen.mjs --drop-prev not
// run yet) a publish without --sign-with-prev-key is refused as well: installed copies still trust the OLD key.
//
// Tests: sh tools/ci/test-publish-update.sh (real keychain scratch + real tauri signer; stub gh, codesign, spctl, stapler).
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as kc from './updater-keychain.mjs';
import { verifySignature } from './minisign-verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function die(msg) { console.error(`publish-update: ${msg}`); process.exit(1); }
function usage() {
  console.error('usage: publish-update.mjs --app <App> --version <x.y.z> [--mac-app APP | --mac-archive TGZ] [--win-nsis EXE] [--win-msi MSI]\n'
    + '       [--notes-file FILE | --notes TEXT] [--repo OWNER/MindSuite] [--dry-run DIR] [--allow-partial] [--keep N] [--tauri PATH]\n       [--prerelease] [--force-feed] [--sign-with-prev-key] [--conf FILE]\n'
    + '       publish-update.mjs --app <App> --preflight [--sign-with-prev-key] [--conf FILE] [--tauri PATH]\n'
    + '       publish-update.mjs --app <App> --feed-url --repo OWNER/MindSuite');
  process.exit(2);
}

export function parseArgs(argv) {
  const o = { keep: 2 };
  const a = [...argv];
  const next = () => { const v = a.shift(); if (v === undefined) usage(); return v; };
  while (a.length) {
    const k = a.shift();
    switch (k) {
      case '--app': o.app = next(); break;
      case '--version': o.version = next(); break;
      case '--mac-app': o.macApp = next(); break;
      case '--mac-archive': o.macArchive = next(); break;
      case '--win-nsis': o.winNsis = next(); break;
      case '--win-msi': o.winMsi = next(); break;
      case '--notes-file': o.notesFile = next(); break;
      case '--notes': o.notes = next(); break;
      case '--repo': o.repo = next(); break;
      case '--dry-run': o.dryRun = next(); break;
      case '--allow-partial': o.allowPartial = true; break;
      case '--prerelease': o.prerelease = true; break;
      case '--force-feed': o.forceFeed = true; break;
      case '--sign-with-prev-key': o.prevKey = true; break;
      case '--keep': o.keep = Number(next()); break;
      case '--tauri': o.tauri = next(); break;
      case '--feed-url': o.feedUrl = true; break;
      case '--preflight': o.preflight = true; break;
      case '--conf': o.conf = next(); break;
      default: console.error(`unknown option ${k}`); usage();
    }
  }
  return o;
}

export const feedTag = (app) => `${app}-updates`;
export const feedUrl = (repo, app) => `https://github.com/${repo}/releases/download/${feedTag(app)}/latest.json`;
const assetUrl = (repo, app, name) => `https://github.com/${repo}/releases/download/${feedTag(app)}/${encodeURIComponent(name)}`;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.error) die(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) die(`${cmd} ${args.slice(0, 3).join(' ')} failed (${r.status}): ${((r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | '))}`);
  return r.stdout;
}

/** Newest-first order of dotted versions in asset names: `<App>_<version>_...`. */
export function versionOfAsset(name, app) {
  const m = name.match(new RegExp(`^${app}_(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)_`));
  return m ? m[1] : null;
}
export function cmpVersions(a, b) {
  const split = (v) => { const [core, ...pre] = v.split('-'); return { core: core.split('.').map(Number), pre: pre.length ? pre.join('-').split('.') : null }; };
  const x = split(a), y = split(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;               // a release is newer than its own pre-release
  if (!y.pre) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === q) continue;
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

function macVerifyScript(app) {
  for (const a of [app, 'CalMind']) {
    const p = path.join(ROOT, a, 'tools/mac-sign-install.sh');
    if (existsSync(p)) return p;
  }
  die('no tools/mac-sign-install.sh found to verify the macOS app');
}

/** Archive an .app as <App>_<v>_aarch64.app.tar.gz: the .app is the top folder, no ._ files, no xattr junk. */
function archiveApp(appDir, outFile) {
  const parent = path.dirname(appDir);
  const base = path.basename(appDir);
  const flags = ['--no-xattrs'];
  if (spawnSync('tar', ['--no-mac-metadata', '--version'], { stdio: 'ignore' }).status === 0) flags.push('--no-mac-metadata');
  run('tar', [...flags, '-czf', outFile, '-C', parent, base], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const list = run('tar', ['-tzf', outFile]).split('\n').filter(Boolean);
  const verbose = run('tar', ['-tvzf', outFile]).split('\n').filter(Boolean);
  const why = checkBundleArchive(base, list, verbose);
  if (why) die(why);
}

/**
 * What the updater will do with this archive: tauri-plugin-updater drops the FIRST path component of EVERY entry and merges
 * the rest into one tree that becomes the installed app. So every entry must sit under the one `<base>/` folder, in plain
 * names (no `..`, no leading `./`, no absolute path), and nothing may be a hard link, a device/fifo, or a symlink that is
 * absolute or climbs (a later entry could be written through it). `list` is `tar -tzf`, `verbose` is `tar -tvzf` (the same
 * entries in the same order). Returns the reason it is unsafe, or null.
 */
export function checkBundleArchive(base, list, verbose) {
  if (list.some((l) => /(^|\/)\._/.test(l))) return 'the archive holds ._ metadata files';
  if (verbose.length !== list.length) return 'the archive listing is ambiguous (an entry name holds a newline)';
  const plain = (p) => p.split('/').every((c, i, a) => (c !== '' || i === a.length - 1) && c !== '.' && c !== '..');
  for (const [i, l] of list.entries()) {
    if (l.startsWith('/') || !plain(l) || !(l === `${base}/` || l.startsWith(`${base}/`))) return `the archive's entry ${JSON.stringify(l)} is not a plain path under the top folder ${base}`;
    const v = verbose[i];
    const kind = v[0];
    if (!'-dl'.includes(kind)) return `the archive's entry ${JSON.stringify(l)} is a kind an app does not have (${kind})`;
    if (kind === '-' && / link to /.test(v)) return `the archive's entry ${JSON.stringify(l)} is a hard link`;
    if (kind === 'l') {
      const target = v.slice(v.lastIndexOf(' -> ') + 4);
      if (target.startsWith('/') || target.split('/').some((c) => c === '..' || c === '.')) return `the archive's symlink ${JSON.stringify(l)} is absolute or climbs: ${target}`;
    }
  }
  return null;
}

function plistVersion(appDir) {
  return run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(appDir, 'Contents/Info.plist')]).trim();
}

/** Where the app's tauri.conf.json is: --conf, else the one shell the app has (<App>/<shell>/src-tauri/tauri.conf.json). */
function findConf(app, given) {
  if (given) { if (!existsSync(given)) die(`no such file: ${given}`); return path.resolve(given); }
  const hits = ['native', 'desktop', ''].map((sub) => path.join(ROOT, app, sub, 'src-tauri/tauri.conf.json')).filter((f) => existsSync(f));
  if (hits.length !== 1) die(`${hits.length ? 'more than one' : 'no'} ${app}/*/src-tauri/tauri.conf.json found; pass --conf FILE`);
  return hits[0];
}

/** plugins.updater.pubkey of the app: the key every installed copy trusts. */
function committedPubkey(app, given) {
  const file = findConf(app, given);
  let key;
  try { key = JSON.parse(readFileSync(file, 'utf8'))?.plugins?.updater?.pubkey; } catch (e) { die(`${file} is not valid JSON: ${e.message}`); }
  if (typeof key !== 'string' || !key) die(`${file} has no plugins.updater.pubkey: the app carries no update key to match`);
  return { key: key.trim(), file };
}

/** The tauri CLI must know `signer sign --app-version` (tauri-cli 2.12 and later): an older one fails AFTER the tag. */
function checkSigner(tauri) {
  const r = spawnSync(tauri, ['signer', 'sign', '--help'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) die(`the tauri CLI (${tauri}) could not be run: ${r.error?.message || (r.stderr || '').trim().split('\n')[0]}`);
  if (!`${r.stdout}${r.stderr}`.includes('--app-version')) die(`the tauri CLI (${tauri}) is too old: its \`signer sign\` has no --app-version (tauri-cli 2.12 or later is needed). Run npm ci in the app that holds it, or set TAURI_BIN.`);
}

/**
 * Pick the keychain slot to sign with and prove it is the one the app trusts. Needs the keychain unlocked; the caller locks it.
 *   default: the live key, which must equal the committed pubkey;
 *   --sign-with-prev-key: the previous key (installed copies still trust it); the committed pubkey must be the live key
 *   (the transitional build carries the new key) or still that previous key.
 * A kept previous key without the flag is refused: the transitional release has not been published.
 */
function selectKey(app, prevFlag, confOpt) {
  const { key: committed, file } = committedPubkey(app, confOpt);
  const live = kc.getSlot(app, '');
  const prev = kc.getSlot(app, 'prev');
  if (!kc.slotEmpty(prev) && !prevFlag) {
    die(`${app} still holds the previous update key of a rotation: installed copies trust the OLD key, so a release signed by the new one would be rejected by all of them without a word. Publish the transitional release with --sign-with-prev-key (dtp: MIND_SIGN_WITH_PREV_KEY=1), then run tools/updater-keygen.mjs ${app} --drop-prev.`);
  }
  const set = prevFlag ? prev : live;
  if (!kc.slotComplete(set)) die(prevFlag ? `${app} holds no previous update key (a rotation made by updater-keygen.mjs --replace keeps one)` : `no update key for ${app}: run tools/updater-keygen.sh ${app}`);
  const trusted = prevFlag ? [live.publicKey, prev.publicKey] : [live.publicKey];
  if (!trusted.includes(committed)) {
    die(`the update key in the keychain does not match plugins.updater.pubkey in ${path.relative(ROOT, file)}: the app trusts ${committed.slice(-24)}..., the keychain signs as ${(set.publicKey || '').slice(-24)}.... A feed signed with it would be rejected by every installed copy. Restore the right key from its offline backup, or (a deliberate rotation) use tools/updater-keygen.mjs --replace and commit the new pubkey.`);
  }
  return { set, committed };
}

function sign(tauri, file, version, secrets) {
  const r = spawnSync(tauri, ['signer', 'sign', '--app-version', version, file], {
    encoding: 'utf8',
    env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: secrets.key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: secrets.password },
  });
  if (r.status !== 0 || !existsSync(`${file}.sig`)) die(`tauri signer sign failed for ${path.basename(file)}: ${(r.stderr || '').trim().split('\n').slice(-1)[0]}`);
  const sig = readFileSync(`${file}.sig`, 'utf8').trim();
  // the signature must verify against the public key of the key that signed it (with the file's own bytes, and the version
  // in its trusted comment): the key and its public half belong together, and what is uploaded is what a client accepts
  const v = verifySignature({ pubkey: secrets.publicKey, data: readFileSync(file), signature: sig, version });
  if (!v.ok) die(`the signature of ${path.basename(file)} does not verify against the update public key: ${v.why}`);
  return sig;
}

const UPLOAD_TRIES = 3;
/** `gh release upload --clobber`, retried. Returns true when it worked; dies on the last failure unless `soft`. */
function upload(repo, tag, filesToSend, what, soft = false) {
  let last = '';
  for (let i = 1; i <= UPLOAD_TRIES; i++) {
    const r = spawnSync('gh', ['release', 'upload', tag, ...filesToSend, '--clobber', '--repo', repo], { encoding: 'utf8' });
    if (r.status === 0) return true;
    last = (r.stderr || r.stdout || r.error?.message || '').trim().split('\n').slice(-1)[0];
    if (i < UPLOAD_TRIES) spawnSync('sleep', [String(Number(process.env.MIND_UPLOAD_RETRY_WAIT ?? 3))]);
  }
  if (soft) return false;
  return die(`uploading ${what} failed ${UPLOAD_TRIES} times: ${last}`);
}

/** The version latest.json holds now, or null when the feed release or its latest.json does not exist yet. */
function currentFeedVersion(repo, tag, stage) {
  const view = spawnSync('gh', ['release', 'view', tag, '--repo', repo, '--json', 'assets', '-q', '.assets[].name'], { encoding: 'utf8' });
  if (view.status !== 0) {
    // a missing release is fine (first publish); anything else (network, auth) must not be mistaken for it
    if (/not found|404/i.test(`${view.stderr}${view.stdout}`)) return null;
    die(`could not read the feed release ${tag}: ${(view.stderr || view.stdout || '').trim().split('\n')[0]}`);
  }
  if (!view.stdout.split('\n').includes('latest.json')) return null;
  const dir = mkdtempSync(path.join(stage, 'cur-'));
  run('gh', ['release', 'download', tag, '--repo', repo, '--pattern', 'latest.json', '--dir', dir, '--clobber']);
  let v;
  try { v = JSON.parse(readFileSync(path.join(dir, 'latest.json'), 'utf8')).version; } catch { die('the live latest.json is not valid JSON; restore it, or pass --force-feed'); }
  if (typeof v !== 'string' || !SEMVER.test(v)) die('the live latest.json has no valid version; restore it, or pass --force-feed');
  return v;
}

/** True when the live latest.json names only files that are on the feed release (and their .sig files). */
function feedIsComplete(repo, tag, stage) {
  const view = spawnSync('gh', ['release', 'view', tag, '--repo', repo, '--json', 'assets', '-q', '.assets[].name'], { encoding: 'utf8' });
  if (view.status !== 0) return false;
  const names = view.stdout.split('\n').filter(Boolean);
  const dir = mkdtempSync(path.join(stage, 'complete-'));
  const dl = spawnSync('gh', ['release', 'download', tag, '--repo', repo, '--pattern', 'latest.json', '--dir', dir, '--clobber'], { encoding: 'utf8' });
  if (dl.status !== 0) return false;
  let feed;
  try { feed = JSON.parse(readFileSync(path.join(dir, 'latest.json'), 'utf8')); } catch { return false; }
  const entries = Object.values(feed.platforms || {});
  if (entries.length === 0) return false;
  return entries.every((p) => {
    const n = decodeURIComponent(String(p.url || '').split('/').pop());
    return n && names.includes(n) && names.includes(`${n}.sig`);
  });
}

function mustContainVersion(file, version) {
  // an installer for another version is the classic mix-up: Tauri names files <App>_<version>_...
  if (!path.basename(file).includes(`_${version}_`)) die(`${path.basename(file)} does not look like version ${version} (no "_${version}_" in its name)`);
  if (!existsSync(file) || !statSync(file).isFile()) die(`no such file: ${file}`);
}

export function buildFeed({ app, version, notes, repo, entries }) {
  const platforms = {};
  for (const [key, e] of Object.entries(entries)) platforms[key] = { signature: e.signature, url: assetUrl(repo, app, e.name) };
  return { version, notes: notes || '', pub_date: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), platforms };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.app) usage();
  kc.checkApp(o.app);
  const repo = o.repo || process.env.MIND_FEED_REPO || (o.dryRun ? 'OWNER/MindSuite' : null);
  if (o.feedUrl) {
    if (!repo) die('--feed-url needs --repo OWNER/MindSuite');
    console.log(feedUrl(repo, o.app));
    return;
  }
  if (o.preflight) {
    // Nothing to sign and nothing to upload: only "could a publish sign, with the key the app trusts?"
    process.on('exit', () => kc.lock());
    checkSigner(o.tauri || kc.findTauri(ROOT, o.app));
    kc.unlock();
    selectKey(o.app, !!o.prevKey, o.conf);
    kc.lock();
    console.log(`publish-update: ${o.app}: the update key matches the app's pubkey and the tauri CLI can sign`);
    return;
  }
  if (!o.version || !SEMVER.test(o.version)) die('--version x.y.z is required');
  const version = o.version;
  if (version.includes('-') && !o.prerelease) die(`${version} is a pre-release; the feed is what every installed copy follows. Pass --prerelease to publish it on purpose.`);
  const wantMac = o.macApp || o.macArchive;
  const wantWin = o.winNsis || o.winMsi;
  if (!wantMac && !wantWin) die('nothing to publish: pass --mac-app and/or --win-nsis/--win-msi');
  if (!o.allowPartial && !(wantMac && wantWin)) die('both macOS and Windows artifacts are required (the feed is replaced as a whole); pass --allow-partial to publish one platform on purpose');
  if (o.macApp && o.macArchive) die('--mac-app and --mac-archive are exclusive');
  if (!Number.isInteger(o.keep) || o.keep < 1) die('--keep must be a positive integer');
  const realUpload = !o.dryRun;
  const feedRepo = repo || run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: ROOT }).trim();
  const tag = feedTag(o.app);
  let notes = o.notes || '';
  if (o.notesFile) notes = readFileSync(o.notesFile, 'utf8').trim();
  notes = notes.slice(0, 4000);

  const stage = mkdtempSync(path.join(os.tmpdir(), 'publish-update-'));
  process.on('exit', () => { try { rmSync(stage, { recursive: true, force: true }); } catch { /* best effort */ } kc.lock(); });

  // ---- 0. the feed must not go backwards (before anything is signed) ----------------------------------------------
  if (realUpload) {
    const cur = currentFeedVersion(feedRepo, tag, stage);
    if (cur && !o.forceFeed && cmpVersions(version, cur) === 0 && feedIsComplete(feedRepo, tag, stage)) {
      // A re-run after an upload that DID land (the read-back or the prune failed afterwards): the feed is live, current and
      // every file it names is on the release, so there is nothing to retry. A rebuild of the same version is never pushed.
      console.log(`the feed ${feedUrl(feedRepo, o.app)} already holds ${cur} and every file it names is on the release: nothing to publish (--force-feed re-signs and re-uploads on purpose)`);
      return;
    }
    if (cur && !o.forceFeed && cmpVersions(version, cur) <= 0) {
      die(`the feed already holds ${cur}; ${version} is not newer. Every installed copy would be moved ${cmpVersions(version, cur) === 0 ? 'to a rebuild of the same version' : 'back'}. Pass --force-feed to do it on purpose.`);
    }
  }
  // ---- 0b. the key must be the one the app trusts, and the CLI must be able to sign (before anything is built or signed) ------
  const tauri = o.tauri || kc.findTauri(ROOT, o.app);
  checkSigner(tauri);
  kc.unlock();
  const chosen = selectKey(o.app, !!o.prevKey, o.conf);
  const secrets = { key: chosen.set.privateKey, password: chosen.set.password, publicKey: chosen.set.publicKey };
  kc.lock();
  const files = [];       // files to upload, artifacts and signatures, in order
  const entries = {};

  // ---- 1. gather and verify the artifacts (nothing signed yet) -----------------------------------------------
  let macFile = null;
  if (wantMac) {
    let appDir = o.macApp ? path.resolve(o.macApp) : null;
    if (o.macArchive) {
      const src = path.resolve(o.macArchive);
      if (!existsSync(src)) die(`no such file: ${src}`);
      const x = path.join(stage, 'extracted');
      mkdirSync(x);
      run('tar', ['-xzf', src, '-C', x]);
      const apps = readdirSync(x).filter((n) => n.endsWith('.app'));
      if (apps.length !== 1) die('the archive must hold exactly one .app at its top');
      appDir = path.join(x, apps[0]);
    }
    if (!appDir || !existsSync(path.join(appDir, 'Contents/Info.plist'))) die(`not an app bundle: ${appDir}`);
    if (plistVersion(appDir) !== version) die(`the app is version ${plistVersion(appDir)}, not ${version}`);
    // Developer ID, hardened runtime, timestamp, notarized, stapled, arm64 only: the same verification the install step does.
    const v = spawnSync('bash', [macVerifyScript(o.app), '--verify-only', appDir], { encoding: 'utf8' });
    if (v.status !== 0) die(`the macOS app did not verify:\n${(v.stderr || v.stdout || '').trim()}`);
    macFile = path.join(stage, `${o.app}_${version}_aarch64.app.tar.gz`);
    archiveApp(appDir, macFile);
  }
  const win = [];
  if (o.winNsis) { mustContainVersion(o.winNsis, version); win.push({ kind: 'nsis', src: path.resolve(o.winNsis) }); }
  if (o.winMsi) { mustContainVersion(o.winMsi, version); win.push({ kind: 'msi', src: path.resolve(o.winMsi) }); }
  for (const w of win) {
    w.file = path.join(stage, path.basename(w.src));
    copyFileSync(w.src, w.file);
  }

  // ---- 2. sign (the key was chosen and checked in 0b) ---------------------------------------------------------------
  if (macFile) {
    const sig = sign(tauri, macFile, version, secrets);
    entries['darwin-aarch64'] = { name: path.basename(macFile), signature: sig };
    files.push(macFile, `${macFile}.sig`);
  }
  for (const w of win) {
    const sig = sign(tauri, w.file, version, secrets);
    entries[`windows-x86_64-${w.kind}`] = { name: path.basename(w.file), signature: sig };
    files.push(w.file, `${w.file}.sig`);
  }
  // plain `windows-x86_64` is what a client falls back to: NSIS when there is one, else the MSI
  const fallback = entries['windows-x86_64-nsis'] || entries['windows-x86_64-msi'];
  if (fallback) entries['windows-x86_64'] = fallback;

  // ---- 3. latest.json -----------------------------------------------------------------------------------------
  const feed = buildFeed({ app: o.app, version, notes, repo: feedRepo, entries });
  const latest = path.join(stage, 'latest.json');
  writeFileSync(latest, `${JSON.stringify(feed, null, 2)}\n`);

  // ---- 4a. dry run: a local directory, in the order the real upload uses ------------------------------------------
  if (o.dryRun) {
    const dir = path.resolve(o.dryRun);
    mkdirSync(dir, { recursive: true });
    for (const f of files) copyFileSync(f, path.join(dir, path.basename(f)));
    copyFileSync(latest, path.join(dir, 'latest.json'));          // last, as in the real upload
    console.log(`dry run: ${files.length} artifact files and latest.json written to ${dir}; nothing uploaded`);
    console.log(`feed: ${feedUrl(feedRepo, o.app)}`);
    return;
  }

  // ---- 4b. the real upload: feed release ensured, artifacts, then latest.json LAST --------------------------------
  const gh = (args, extra = {}) => run('gh', [...args, '--repo', feedRepo], extra);
  const exists = spawnSync('gh', ['release', 'view', tag, '--repo', feedRepo], { encoding: 'utf8' }).status === 0;
  if (!exists) {
    gh(['release', 'create', tag, '--title', `${o.app} update feed`, '--notes', `Update feed for ${o.app}. Not a release to download: latest.json and the update archives live here.`, '--prerelease', '--latest=false']);
  }
  upload(feedRepo, tag, files, 'the update artifacts');
  // --clobber deletes the old latest.json first: if this upload fails for good, the fixed feed URL answers 404.
  if (!upload(feedRepo, tag, [latest], 'latest.json', true)) {
    die(`latest.json could not be uploaded after ${UPLOAD_TRIES} tries and the OLD one may already be deleted: the feed ${feedUrl(feedRepo, o.app)} may answer 404 until you run publish-update again with the same arguments (the artifacts are already up; a missing latest.json does not block a re-run)`);
  }

  // ---- 5. read it back ---------------------------------------------------------------------------------------
  const back = mkdtempSync(path.join(stage, 'back-'));
  gh(['release', 'download', tag, '--pattern', 'latest.json', '--dir', back, '--clobber']);
  const got = JSON.parse(readFileSync(path.join(back, 'latest.json'), 'utf8'));
  if (JSON.stringify(got) !== JSON.stringify(feed)) die('the downloaded latest.json is not what was uploaded');
  const names = gh(['release', 'view', tag, '--json', 'assets', '-q', '.assets[].name']).split('\n').filter(Boolean);
  for (const [platform, p] of Object.entries(got.platforms)) {
    const n = decodeURIComponent(p.url.split('/').pop());
    if (!names.includes(n) || !names.includes(`${n}.sig`)) die(`the feed names ${n} for ${platform} but it is not on the release`);
  }

  // ---- 6. prune: keep this version and the previous ones, newest first ---------------------------------------------
  const versions = [...new Set(names.map((n) => versionOfAsset(n, o.app)).filter(Boolean))].sort(cmpVersions).reverse();
  const keepSet = new Set(versions.slice(0, o.keep));
  keepSet.add(version);
  for (const n of names) {
    const v = versionOfAsset(n, o.app);
    if (v && !keepSet.has(v)) {
      // The feed is already live and verified: a failed prune must not fail the publish (a re-run would be refused as "not newer").
      const d = spawnSync('gh', ['release', 'delete-asset', tag, n, '--yes', '--repo', feedRepo], { encoding: 'utf8' });
      if (d.status !== 0) console.warn(`publish-update: could not prune ${n} (${(d.stderr || d.stdout || '').trim().split('\n')[0]}); the feed is live, it only keeps an old file`);
    }
  }
  console.log(`published ${o.app} ${version} to ${feedUrl(feedRepo, o.app)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
