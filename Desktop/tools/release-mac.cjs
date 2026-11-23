#!/usr/bin/env node
'use strict';

// Build the MindSuite Desktop Mac release locally: staged hosted apps -> unsigned app -> Developer ID, hardened runtime,
// notarized and stapled app (tools/mac-sign-install.sh) -> zip + latest-mac.yml (the update feed document) -> dmg, notarized
// and stapled -> SHA256SUMS and release.json. Nothing is uploaded or installed; tools/publish-desktop.cjs publishes.
//
//   node tools/release-mac.cjs [--scratch] [--no-dmg] [--out DIR] [--repo OWNER/MindSuite]
//
// A release (no --scratch) needs a clean tracked tree and hosts only notarized, hardened NoteMind and ScrollMind builds
// (stage-local.cjs --release). --scratch keeps every step but marks the result as not releasable (publish refuses it).
// --no-dmg (scratch only) skips the dmg and its second Apple submission. The identity, team and notary profile come from
// .local/machine.env or MIND_SIGN_IDENTITY / MIND_NOTARY_PROFILE (see tools/mac-sign-install.sh).

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./release-lib.cjs');

const root = path.resolve(__dirname, '..');
const suite = path.resolve(root, '..');
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const scratch = flag('--scratch');
const noDmg = flag('--no-dmg');
const repo = option('--repo', 'chere005/MindSuite');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const out = path.resolve(option('--out', path.join(root, 'dist', scratch ? 'scratch' : 'release')));

function die(message) { console.error(`release-mac: ${message}`); process.exit(1); }
function say(message) { console.log(`release-mac: ${message}`); }
function run(file, fileArgs, { cwd = root, env = process.env, capture = false } = {}) {
  const result = spawnSync(file, fileArgs, { cwd, env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) die(`${path.basename(file)} ${fileArgs.slice(0, 2).join(' ')} failed${capture ? `: ${(result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' | ')}` : ''}`);
  return result.stdout;
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') die('macOS releases are Apple silicon only: run this with an arm64 node on an Apple silicon Mac.');
if (!scratch) {
  if (noDmg) die('a release always includes the notarized dmg; --no-dmg is for --scratch only');
  const dirty = run('git', ['status', '--porcelain', '--untracked-files=no', '--', '.'], { capture: true }).trim();
  if (dirty) die('tracked files under Desktop/ have uncommitted changes; a release is built from the commit that gets tagged');
}
if (!fs.existsSync(path.join(root, 'node_modules/.bin/electron-builder'))) die('run npm ci in Desktop first');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const unsigned = path.join(root, 'dist/mac-arm64/MindSuite.app');

// 1. stage the hosted apps and build the unsigned app, holding the heavy-build lock
say(`staging and building ${scratch ? 'a SCRATCH ' : ''}MindSuite ${version}`);
const stage = ['node', 'stage-local.cjs', ...(scratch ? [] : ['--release'])].join(' ');
fs.rmSync(path.join(root, 'dist/mac-arm64'), { recursive: true, force: true });
run('sh', ['-c', `. tools/heavy-lock.sh && heavy_lock "MindSuite Desktop release build" && ${stage} && node_modules/.bin/electron-builder --mac dir --arm64 --publish never`]);

// 2. what was built must be what the lane promises
const plist = key => run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(unsigned, 'Contents/Info.plist')], { capture: true }).trim();
if (plist('CFBundleShortVersionString') !== version) die('the built app version does not match package.json');
lib.checkAppFeedFile(fs.readFileSync(path.join(unsigned, 'Contents/Resources/app-update.yml'), 'utf8'), repo);
const staged = JSON.parse(fs.readFileSync(path.join(unsigned, 'Contents/Resources/mindsuite-local/MANIFEST.json'), 'utf8'));
if (!scratch && (!staged.release || !staged.notemind.notarized || !staged.scrollmind.notarized)) die('the hosted apps are not release builds');

// 3. sign (hardened runtime, every nested Mach-O including koffi.node and scroll-pen), notarize, staple, verify
run('plutil', ['-lint', path.join(root, 'entitlements.mac.plist')], { capture: true });
const signedDir = path.join(out, 'signed');
run('sh', [path.join(root, 'tools/mac-sign-install.sh'), '--no-install', '--out', signedDir,
  '--entitlements', path.join(root, 'entitlements.mac.plist'), '--nested-entitlements', path.join(root, 'entitlements.mac.plist'), unsigned]);
const app = path.join(signedDir, 'MindSuite.app');
const shown = spawnSync('/usr/bin/codesign', ['-dvv', app], { encoding: 'utf8' });
const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(`${shown.stderr}${shown.stdout}`)?.[1];
if (!team) die('the signed app has no team identifier');
if (team !== staged.team) die('the hosted apps are signed by a different team than MindSuite');
const entitlements = spawnSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', app], { encoding: 'utf8' });
const granted = [...`${entitlements.stdout}${entitlements.stderr}`.matchAll(/<key>([^<]+)<\/key>/g)].map(match => match[1]).sort();
if (granted.join() !== ['com.apple.security.cs.allow-jit', 'com.apple.security.device.camera'].join()) die(`unexpected entitlements: ${granted.join(', ')}`);
for (const nested of ['Contents/Resources/mindsuite-local/scrollmind/scroll-pen', 'Contents/Resources/mindsuite-local/notemind/node_modules/@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node']) {
  run('/usr/bin/codesign', ['--verify', '--strict', path.join(app, nested)], { capture: true });
}

// 4. the zip the updater downloads, and the feed document that describes exactly it
const zip = path.join(out, lib.zipName(version));
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
run('unzip', ['-tq', zip], { capture: true });
const data = fs.readFileSync(zip);
const feedText = lib.feedYaml({ version, file: path.basename(zip), sha512: lib.sha512Base64(data), size: data.length, releaseDate: new Date().toISOString() });
fs.writeFileSync(path.join(out, 'latest-mac.yml'), feedText);
(async () => {
  await lib.checkFeedAgainstZip(feedText, zip, version);
  // The zip must unpack to the same verified app.
  const probe = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mindsuite-zip-'));
  try {
    run('ditto', ['-x', '-k', zip, probe]);
    run('sh', [path.join(root, 'tools/mac-sign-install.sh'), '--verify-only', path.join(probe, 'MindSuite.app')], { capture: true });
  } finally { fs.rmSync(probe, { recursive: true, force: true }); }

  // 5. the dmg, notarized and stapled, then the shared gate over it and the app inside
  const files = [path.basename(zip), 'latest-mac.yml'];
  let dmg = null;
  if (!noDmg) {
    dmg = path.join(out, lib.dmgName(version));
    const folder = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mindsuite-dmg-'));
    try {
      run('ditto', [app, path.join(folder, 'MindSuite.app')]);
      fs.symlinkSync('/Applications', path.join(folder, 'Applications'));
      run('hdiutil', ['create', '-quiet', '-volname', 'MindSuite', '-srcfolder', folder, '-fs', 'HFS+', '-format', 'UDZO', '-ov', dmg]);
    } finally { fs.rmSync(folder, { recursive: true, force: true }); }
    // the dmg is signed by the same identity that signed the app (its leaf Authority line)
    const identity = /^Authority=(Developer ID Application: .*)$/m.exec(`${shown.stderr}${shown.stdout}`)?.[1];
    if (!identity) die('could not read the signing identity for the dmg');
    const profile = process.env.MIND_NOTARY_PROFILE || 'DisplayMind';
    run('bash', [path.join(suite, 'tools/ci/notarize-dmg.sh'), '--profile', profile, dmg], { env: { ...process.env, APPLE_SIGNING_IDENTITY: identity } });
    run('bash', [path.join(suite, 'tools/ci/verify-macos-dmg.sh'), dmg, 'MindSuite'], { env: { ...process.env, APPLE_TEAM_ID: team } });
    files.unshift(path.basename(dmg));
  }

  // 6. checksums and the record the publisher reads
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), files.map(name => lib.sha256Line(lib.sha256Hex(fs.readFileSync(path.join(out, name))), name)).join(''));
  const commit = run('git', ['rev-parse', 'HEAD'], { capture: true }).trim();
  fs.writeFileSync(path.join(out, 'release.json'), `${JSON.stringify({
    app: 'MindSuite', version, repo, tag: lib.releaseTag(version), feedTag: lib.FEED_TAG, team, commit,
    release: !scratch && !noDmg, files: [...files, 'SHA256SUMS'], hosted: { notemind: staged.notemind, scrollmind: staged.scrollmind },
  }, null, 2)}\n`);
  say(`${scratch ? 'scratch ' : ''}release ready in ${out}: ${files.join(', ')}`);
})().catch(error => die(error.message));
