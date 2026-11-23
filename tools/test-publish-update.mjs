// Tests tools/publish-update.mjs, tools/updater-keygen.mjs and tools/updater-keychain.mjs: a REAL scratch keychain and the
// REAL `tauri signer` (a throwaway key made here), a STUB gh and stub codesign/spctl/stapler/lipo. Nothing leaves the
// machine. Run through `sh tools/ci/test-publish-update.sh` (it builds the Rust signature verifier this test calls).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as kc from './updater-keychain.mjs';
import { cmpVersions, versionOfAsset, feedUrl, feedTag } from './publish-update.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = mkdtempSync(path.join(os.tmpdir(), 'publish-update-test-'));
process.on('exit', () => rmSync(T, { recursive: true, force: true }));
const VERIFY = process.env.MIND_VERIFY_SIG_BIN;
assert.ok(VERIFY && existsSync(VERIFY), 'MIND_VERIFY_SIG_BIN must name the built verify_sig example (use tools/ci/test-publish-update.sh)');
const FULL = 'Developer ID Application: Test Person (TEAMID0000)';
const APP = 'TestApp';
const VERSION = '2.3.0';

// ---- stubs ----------------------------------------------------------------------------------------------------
const bin = path.join(T, 'bin'); mkdirSync(bin);
const stub = (name, body) => { writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(path.join(bin, name), 0o755); };
stub('codesign', `
[ "\${TEST_BAD:-0}" != 1 ] || exit 1
case "$1" in
  --verify) exit 0 ;;
  -dvv) echo "Authority=${FULL}" >&2; echo "CodeDirectory v=20500 flags=0x10000(runtime) hashes=1" >&2; echo "Timestamp=Nov 23, 2026" >&2; echo "TeamIdentifier=TEAMID0000" >&2 ;;
esac`);
stub('xcrun', `[ "\${TEST_BAD:-0}" != 1 ] || exit 1; exit 0`);
stub('spctl', `echo "source=Notarized Developer ID" >&2`);
stub('lipo', `echo arm64`);
stub('gh', `
echo "gh $*" >> "$GH_LOG"
S=$GH_STATE; mkdir -p "$S"
args=("$@")
case "$1 $2" in
  "repo view") echo OWNER/MindSuite ;;
  "release view")
    tag=$3
    if printf '%s\\n' "$@" | grep -qx -- --json; then ls "$S/$tag" 2>/dev/null; exit 0; fi
    [ -d "$S/$tag" ] ;;
  "release create") mkdir -p "$S/$3" ;;
  "release upload")
    tag=$3; shift 3
    while [ $# -gt 0 ]; do case "$1" in --*) break ;; *) cp "$1" "$S/$tag/" ;; esac; shift; done ;;
  "release download")
    tag=$3; dir=; pat=
    for ((i=0;i<\${#args[@]};i++)); do [ "\${args[$i]}" = --dir ] && dir=\${args[$((i+1))]}; [ "\${args[$i]}" = --pattern ] && pat=\${args[$((i+1))]}; done
    cp "$S/$tag/$pat" "$dir/" ;;
  "release delete-asset") rm -f "$S/$3/$4" ;;
esac`);

const kcPath = path.join(T, 'updater.keychain-db');
const baseEnv = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  MIND_UPDATER_KEYCHAIN: kcPath,
  MIND_UPDATER_KEYCHAIN_PASSWORD: 'keychain-test-password-0001',
  MIND_SIGN_IDENTITY: FULL,
  MIND_MACHINE_ENV: path.join(T, 'no-such-machine.env'),
  GH_STATE: path.join(T, 'gh-state'),
  GH_LOG: path.join(T, 'gh.log'),
};
process.env.MIND_UPDATER_KEYCHAIN = kcPath; process.env.MIND_UPDATER_KEYCHAIN_PASSWORD = baseEnv.MIND_UPDATER_KEYCHAIN_PASSWORD;
const node = (script, args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'tools', script), ...args], { encoding: 'utf8', env: { ...baseEnv, ...env } });
const out = (r) => `${r.stdout}${r.stderr}`;

// ---- fixtures -------------------------------------------------------------------------------------------------
function makeApp(dir, version) {
  const app = path.join(dir, 'Example.app');
  mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  writeFileSync(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>example</string><key>CFBundleIdentifier</key><string>com.example.fixture</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`);
  copyFileSync('/bin/ls', path.join(app, 'Contents/MacOS/example'));
  return app;
}
const win = path.join(T, 'win'); mkdirSync(win);
const nsis = path.join(win, `${APP}_${VERSION}_x64-setup.exe`); writeFileSync(nsis, Buffer.from('MZ-nsis-installer-bytes'));
const msi = path.join(win, `${APP}_${VERSION}_x64_en-US.msi`); writeFileSync(msi, Buffer.from('msi-installer-bytes'));
const app230 = makeApp(path.join(T, 'mac230'), VERSION);   // makeApp makes the folder tree itself

function publishArgs(extra = []) { return ['--app', APP, '--version', VERSION, '--mac-app', app230, '--win-nsis', nsis, '--win-msi', msi, '--repo', 'OWNER/MindSuite', ...extra]; }
function verify(pub, file, sig, version) { return spawnSync(VERIFY, [pub, file, sig, version], { encoding: 'utf8' }); }

let pubkey; let secretValues;
test('keygen creates the key in a scratch keychain, prints only the public key, and refuses to replace it', () => {
  const pubOut = path.join(T, 'TestApp.pub');
  const r = node('updater-keygen.mjs', [APP, '--pub-out', pubOut]);
  assert.equal(r.status, 0, out(r));
  pubkey = readFileSync(pubOut, 'utf8').trim();
  assert.match(out(r), new RegExp(pubkey.replace(/[+/]/g, '\\$&')));
  kc.unlock();
  secretValues = [kc.get(APP, 'private-key'), kc.get(APP, 'password')];
  kc.lock();
  assert.ok(secretValues.every((v) => v && v.length > 20));
  for (const v of secretValues) assert.ok(!out(r).includes(v), 'keygen printed a secret');
  const again = node('updater-keygen.mjs', [APP]);
  assert.notEqual(again.status, 0);
  assert.match(out(again), /already has an update key/);
  for (const v of secretValues) assert.ok(!out(again).includes(v));
  assert.notEqual(node('updater-keygen.mjs', ['Bad Name']).status, 0, 'a bad app name is refused');
  const status = node('updater-keygen.mjs', [APP, '--status']);
  assert.equal(status.status, 0); assert.ok(out(status).includes(pubkey));
  const noKey = node('updater-keygen.mjs', ['OtherApp', '--status']);
  assert.notEqual(noKey.status, 0);
});

test('a backup is a 0600 file, refused inside a git work tree and over an existing file', () => {
  const dest = path.join(T, 'backup.json');
  const r = node('updater-keygen.mjs', [APP, '--export-backup', dest]);
  assert.equal(r.status, 0, out(r));
  const j = JSON.parse(readFileSync(dest, 'utf8'));
  assert.equal(j.app, APP); assert.ok(j.privateKey && j.password && j.publicKey === pubkey);
  assert.equal(statSync(dest).mode & 0o777, 0o600);
  for (const v of secretValues) assert.ok(!out(r).includes(v));
  assert.notEqual(node('updater-keygen.mjs', [APP, '--export-backup', dest]).status, 0);
  assert.notEqual(node('updater-keygen.mjs', [APP, '--export-backup', path.join(ROOT, 'tools/never-written.json')]).status, 0);
  assert.ok(!existsSync(path.join(ROOT, 'tools/never-written.json')));
});

test('helpers: versions order and feed urls', () => {
  assert.equal(versionOfAsset('CalMind_2.3.0_aarch64.app.tar.gz', 'CalMind'), '2.3.0');
  assert.equal(versionOfAsset('latest.json', 'CalMind'), null);
  assert.equal(versionOfAsset('MealMind_2.3.0_x.gz', 'CalMind'), null);
  assert.ok(cmpVersions('2.10.0', '2.9.0') > 0 && cmpVersions('2.0.0', '2.0.0-beta.1') > 0 && cmpVersions('1.0.0', '1.0.0') === 0);
  assert.equal(feedTag('CalMind'), 'CalMind-updates');
  assert.equal(feedUrl('OWNER/MindSuite', 'CalMind'), 'https://github.com/OWNER/MindSuite/releases/download/CalMind-updates/latest.json');
  const r = node('publish-update.mjs', ['--app', 'CalMind', '--feed-url', '--repo', 'OWNER/MindSuite']);
  assert.equal(r.stdout.trim(), feedUrl('OWNER/MindSuite', 'CalMind'));
});

test('dry run writes signed artifacts and latest.json that the app side accepts', () => {
  const dir = path.join(T, 'feed1');
  const r = node('publish-update.mjs', publishArgs(['--dry-run', dir, '--notes', 'Fixes <b>things</b>']));
  assert.equal(r.status, 0, out(r));
  for (const v of secretValues) assert.ok(!out(r).includes(v), 'a secret was printed');
  const names = readdirSync(dir).sort();
  assert.deepEqual(names, [
    `${APP}_${VERSION}_aarch64.app.tar.gz`, `${APP}_${VERSION}_aarch64.app.tar.gz.sig`,
    `${APP}_${VERSION}_x64-setup.exe`, `${APP}_${VERSION}_x64-setup.exe.sig`,
    `${APP}_${VERSION}_x64_en-US.msi`, `${APP}_${VERSION}_x64_en-US.msi.sig`, 'latest.json'].sort());
  const feed = JSON.parse(readFileSync(path.join(dir, 'latest.json'), 'utf8'));
  assert.equal(feed.version, VERSION);
  assert.equal(feed.notes, 'Fixes <b>things</b>');
  assert.match(feed.pub_date, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual(Object.keys(feed.platforms).sort(), ['darwin-aarch64', 'windows-x86_64', 'windows-x86_64-msi', 'windows-x86_64-nsis']);
  const base = 'https://github.com/OWNER/MindSuite/releases/download/TestApp-updates/';
  assert.equal(feed.platforms['darwin-aarch64'].url, `${base}${APP}_${VERSION}_aarch64.app.tar.gz`);
  assert.equal(feed.platforms['windows-x86_64'].url, feed.platforms['windows-x86_64-nsis'].url, 'the plain windows entry is the NSIS installer');
  for (const [platform, p] of Object.entries(feed.platforms)) {
    const file = path.join(dir, decodeURIComponent(p.url.split('/').pop()));
    assert.equal(readFileSync(`${file}.sig`, 'utf8').trim(), p.signature, `${platform}: latest.json carries the .sig`);
    const ok = verify(pubkey, file, `${file}.sig`, VERSION);
    assert.equal(ok.status, 0, `${platform}: ${out(ok)}`);
    assert.notEqual(verify(pubkey, file, `${file}.sig`, '2.3.1').status, 0, `${platform}: another version must not verify`);
    const tampered = path.join(T, `tampered-${platform}`); writeFileSync(tampered, Buffer.concat([readFileSync(file), Buffer.from('x')]));
    assert.notEqual(verify(pubkey, tampered, `${file}.sig`, VERSION).status, 0, `${platform}: a changed file must not verify`);
  }
  // the macOS archive: the .app is the top folder and nothing carries ._ junk
  const list = spawnSync('tar', ['-tzf', path.join(dir, `${APP}_${VERSION}_aarch64.app.tar.gz`)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  assert.ok(list.length > 2 && list.every((l) => l.startsWith('Example.app/')) && !list.some((l) => l.includes('._')), list.join(','));
});

test('the real upload path (stub gh): artifacts first, latest.json last, a pre-release that is never Latest, prune and read-back', () => {
  rmSync(path.join(T, 'gh-state'), { recursive: true, force: true }); rmSync(baseEnv.GH_LOG, { force: true });
  const r = node('publish-update.mjs', publishArgs(['--notes', 'first']));
  assert.equal(r.status, 0, out(r));
  const log = readFileSync(baseEnv.GH_LOG, 'utf8').trim().split('\n');
  const create = log.findIndex((l) => l.startsWith('gh release create TestApp-updates'));
  assert.ok(create >= 0, 'the feed release was created');
  assert.match(log[create], /--prerelease/); assert.match(log[create], /--latest=false/);
  const uploads = log.map((l, i) => [l, i]).filter(([l]) => l.startsWith('gh release upload'));
  assert.equal(uploads.length, 2, 'two uploads: artifacts, then the feed');
  assert.ok(!uploads[0][0].includes('latest.json') && uploads[1][0].includes('latest.json') && !uploads[1][0].includes('.sig') , 'latest.json goes last and alone');
  assert.ok(uploads[0][1] > create && uploads[1][1] > uploads[0][1]);
  assert.ok(uploads.every(([l]) => l.includes('--clobber') && l.includes('--repo OWNER/MindSuite')));
  assert.ok(!log.some((l) => /--latest(\s|$)/.test(l)), 'no gh call marks anything Latest');
  assert.ok(log.some((l) => l.startsWith('gh release download TestApp-updates') && l.includes('latest.json')), 'the feed is read back');
  assert.deepEqual(readdirSync(path.join(T, 'gh-state/TestApp-updates')).filter((n) => !n.endsWith('.sig')).sort(),
    [`${APP}_${VERSION}_aarch64.app.tar.gz`, `${APP}_${VERSION}_x64-setup.exe`, `${APP}_${VERSION}_x64_en-US.msi`, 'latest.json'].sort());

  // two more versions: the oldest is pruned, latest.json always names the newest
  for (const v of ['2.4.0', '2.5.0']) {
    const mac = makeApp(path.join(T, `mac${v}`), v);
    const n = path.join(win, `${APP}_${v}_x64-setup.exe`); writeFileSync(n, `nsis ${v}`);
    const m = path.join(win, `${APP}_${v}_x64_en-US.msi`); writeFileSync(m, `msi ${v}`);
    const rr = node('publish-update.mjs', ['--app', APP, '--version', v, '--mac-app', mac, '--win-nsis', n, '--win-msi', m, '--repo', 'OWNER/MindSuite']);
    assert.equal(rr.status, 0, out(rr));
  }
  const left = readdirSync(path.join(T, 'gh-state/TestApp-updates'));
  assert.ok(!left.some((n) => n.includes('_2.3.0_')), `2.3.0 was pruned: ${left}`);
  assert.ok(left.some((n) => n.includes('_2.4.0_')) && left.some((n) => n.includes('_2.5.0_')) && left.includes('latest.json'));
  assert.equal(JSON.parse(readFileSync(path.join(T, 'gh-state/TestApp-updates/latest.json'), 'utf8')).version, '2.5.0');
  // release exists the second time: no second create
  const creates = readFileSync(baseEnv.GH_LOG, 'utf8').split('\n').filter((l) => l.startsWith('gh release create'));
  assert.equal(creates.length, 1);
});

test('refusals: nothing is signed or uploaded', () => {
  writeFileSync(baseEnv.GH_LOG, '');
  const cases = {
    'an app of another version': { args: publishArgs(['--version', '2.9.9', '--dry-run', path.join(T, 'r1')]), re: /not 2\.9\.9|does not look like version/ },
    'a Windows file of another version': { args: ['--app', APP, '--version', '2.3.0', '--mac-app', app230, '--win-nsis', path.join(win, `${APP}_2.4.0_x64-setup.exe`), '--dry-run', path.join(T, 'r2')], re: /does not look like version 2\.3\.0/ },
    'a bad version': { args: publishArgs(['--version', '2.3', '--dry-run', path.join(T, 'r3')]), re: /--version/ },
    'one platform only': { args: ['--app', APP, '--version', VERSION, '--mac-app', app230, '--dry-run', path.join(T, 'r4')], re: /both macOS and Windows/ },
    'no artifacts': { args: ['--app', APP, '--version', VERSION, '--dry-run', path.join(T, 'r5')], re: /nothing to publish/ },
    'an app without a key': { args: publishArgs(['--app', 'NoKeyApp', '--dry-run', path.join(T, 'r6')]), re: /no update key/ },
    'an app that does not verify': { args: publishArgs(['--dry-run', path.join(T, 'r7')]), env: { TEST_BAD: '1' }, re: /did not verify/ },
  };
  for (const [name, c] of Object.entries(cases)) {
    const r = node('publish-update.mjs', c.args, c.env || {});
    assert.notEqual(r.status, 0, `${name} was accepted`);
    assert.match(out(r), c.re, name);
    for (const v of secretValues) assert.ok(!out(r).includes(v));
  }
  for (const d of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']) assert.ok(!existsSync(path.join(T, d, 'latest.json')), `${d} wrote a feed`);
  assert.equal(readFileSync(baseEnv.GH_LOG, 'utf8'), '', 'a refused publish made no gh call');
  // one platform on purpose
  const ok = node('publish-update.mjs', ['--app', APP, '--version', VERSION, '--mac-app', app230, '--allow-partial', '--repo', 'OWNER/MindSuite', '--dry-run', path.join(T, 'r8')]);
  assert.equal(ok.status, 0, out(ok));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(T, 'r8/latest.json'), 'utf8')).platforms), ['darwin-aarch64']);
});
