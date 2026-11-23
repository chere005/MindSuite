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
// Tests: sh tools/ci/test-publish-update.sh (real keychain scratch + real tauri signer; stub gh, codesign, spctl, stapler).
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as kc from './updater-keychain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function die(msg) { console.error(`publish-update: ${msg}`); process.exit(1); }
function usage() {
  console.error('usage: publish-update.mjs --app <App> --version <x.y.z> [--mac-app APP | --mac-archive TGZ] [--win-nsis EXE] [--win-msi MSI]\n'
    + '       [--notes-file FILE | --notes TEXT] [--repo OWNER/MindSuite] [--dry-run DIR] [--allow-partial] [--keep N] [--tauri PATH]\n       [--prerelease] [--force-feed] [--sign-with-prev-key]\n'
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
  if (list.some((l) => /(^|\/)\._/.test(l))) die('the archive holds ._ metadata files');
  if (!list.every((l) => l === `${base}/` || l.startsWith(`${base}/`))) die(`the archive's top folder is not ${base}`);
}

function plistVersion(appDir) {
  return run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(appDir, 'Contents/Info.plist')]).trim();
}

function sign(tauri, file, version, secrets) {
  const r = spawnSync(tauri, ['signer', 'sign', '--app-version', version, file], {
    encoding: 'utf8',
    env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: secrets.key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: secrets.password },
  });
  if (r.status !== 0 || !existsSync(`${file}.sig`)) die(`tauri signer sign failed for ${path.basename(file)}: ${(r.stderr || '').trim().split('\n').slice(-1)[0]}`);
  const sig = readFileSync(`${file}.sig`, 'utf8').trim();
  const text = Buffer.from(sig, 'base64').toString('utf8');
  if (!text.includes(`\tversion:${version}`) && !text.includes(` version:${version}`)) die(`the signature of ${path.basename(file)} does not carry version ${version}`);
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
    if (cur && !o.forceFeed && cmpVersions(version, cur) <= 0) {
      die(`the feed already holds ${cur}; ${version} is not newer. Every installed copy would be moved ${cmpVersions(version, cur) === 0 ? 'to a rebuild of the same version' : 'back'}. Pass --force-feed to do it on purpose.`);
    }
  }
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

  // ---- 2. sign (the only step that touches the key) ---------------------------------------------------------
  const tauri = o.tauri || kc.findTauri(ROOT, o.app);
  kc.unlock();
  const slot = o.prevKey ? 'prev' : '';
  const key = kc.get(o.app, kc.slotKind('private-key', slot));
  const password = kc.get(o.app, kc.slotKind('password', slot));
  if (!key || !password) die(o.prevKey ? `${o.app} holds no previous update key (a rotation made by updater-keygen.mjs --replace keeps one)` : `no update key for ${o.app}: run tools/updater-keygen.sh ${o.app}`);
  const secrets = { key, password };
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
  kc.lock();
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
    if (v && !keepSet.has(v)) gh(['release', 'delete-asset', tag, n, '--yes']);
  }
  console.log(`published ${o.app} ${version} to ${feedUrl(feedRepo, o.app)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
