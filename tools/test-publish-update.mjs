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
import { verifySignature } from './minisign-verify.mjs';

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
    if printf '%s\\n' "$@" | grep -q 'latest.json$' && [ -f "$S/../fail-latest" ]; then
      n=$(cat "$S/../fail-latest"); if [ "$n" -gt 0 ]; then echo $((n-1)) > "$S/../fail-latest"; rm -f "$S/$tag/latest.json"; echo "HTTP 502" >&2; exit 1; fi
    fi
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
  MIND_UPLOAD_RETRY_WAIT: '0',
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

// a stand-in tauri.conf.json: the key an installed copy of the app trusts (plugins.updater.pubkey)
let confSeq = 0;
function writeConf(pub) { const f = path.join(T, `tauri-${confSeq++}.conf.json`); writeFileSync(f, JSON.stringify({ plugins: { updater: { pubkey: pub } } })); return f; }
let CONF;   // TestApp's, set when its key is made
function publishArgs(extra = []) { return ['--app', APP, '--version', VERSION, '--mac-app', app230, '--win-nsis', nsis, '--win-msi', msi, '--repo', 'OWNER/MindSuite', '--conf', CONF, ...extra]; }
function verify(pub, file, sig, version) { return spawnSync(VERIFY, [pub, file, sig, version], { encoding: 'utf8' }); }

let pubkey; let secretValues; let otherPub;
test('keygen creates the key in a scratch keychain, prints only the public key, and refuses to replace it', () => {
  const pubOut = path.join(T, 'TestApp.pub');
  const r = node('updater-keygen.mjs', [APP, '--pub-out', pubOut]);
  assert.equal(r.status, 0, out(r));
  pubkey = readFileSync(pubOut, 'utf8').trim();
  CONF = writeConf(pubkey);
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

test('a backup is two 0600 files (key, password) outside git, refused over existing files', () => {
  const dest = path.join(T, 'backup.json');
  const r = node('updater-keygen.mjs', [APP, '--export-backup', dest]);
  assert.equal(r.status, 0, out(r));
  const j = JSON.parse(readFileSync(dest, 'utf8'));
  assert.equal(j.app, APP); assert.ok(j.privateKey && j.publicKey === pubkey);
  assert.equal(j.password, undefined, 'the key file must not carry its password');
  assert.ok(!readFileSync(dest, 'utf8').includes(secretValues[1]), 'the password is in the key file');
  assert.equal(readFileSync(`${dest}.password`, 'utf8').trim(), secretValues[1]);
  assert.equal(statSync(dest).mode & 0o777, 0o600); assert.equal(statSync(`${dest}.password`).mode & 0o777, 0o600);
  for (const v of secretValues) assert.ok(!out(r).includes(v));
  assert.notEqual(node('updater-keygen.mjs', [APP, '--export-backup', dest]).status, 0);
  assert.notEqual(node('updater-keygen.mjs', [APP, '--export-backup', path.join(ROOT, 'tools/never-written.json')]).status, 0);
  assert.ok(!existsSync(path.join(ROOT, 'tools/never-written.json')) && !existsSync(path.join(ROOT, 'tools/never-written.json.password')));
  const synced = path.join(T, 'Dropbox'); mkdirSync(synced);
  const w = node('updater-keygen.mjs', [APP, '--export-backup', path.join(synced, 'k.json')]);
  assert.equal(w.status, 0, out(w)); assert.match(w.stderr, /cloud-synced/);
});

test('a failed check never leaves the key file in the temp dir', () => {
  const tmp = path.join(T, 'keygen-tmp'); mkdirSync(tmp);
  const real = kc.findTauri(ROOT, APP);
  const wrapper = path.join(T, 'tauri-no-sign'); writeFileSync(wrapper, `#!/bin/bash\n[ "$1 $2" != "signer sign" ] || { echo refused >&2; exit 1; }\nexec "${real}" "$@"\n`); chmodSync(wrapper, 0o755);
  const r = node('updater-keygen.mjs', ['NoSignApp'], { TMPDIR: tmp, TAURI_BIN: wrapper });
  assert.notEqual(r.status, 0); assert.match(out(r), /could not sign a probe/);
  assert.deepEqual(readdirSync(tmp), [], 'the temporary key file was left behind');
  kc.unlock(); assert.equal(kc.get('NoSignApp', 'private-key'), null, 'a key that cannot sign was stored'); kc.lock();
});

test('rotation keeps the old key as "prev", never loses it, and the transitional release is signed by it', () => {
  const R = 'RotApp';
  assert.equal(node('updater-keygen.mjs', [R, '--replace']).status, 1, '--replace without a key is refused');
  const first = node('updater-keygen.mjs', [R]); assert.equal(first.status, 0, out(first));
  kc.unlock(); const A = kc.getSlot(R, ''); kc.lock();
  assert.ok(kc.slotComplete(A));
  const rot = node('updater-keygen.mjs', [R, '--replace']);
  assert.equal(rot.status, 0, out(rot));
  kc.unlock(); const live = kc.getSlot(R, ''); const prev = kc.getSlot(R, 'prev'); const next = kc.getSlot(R, 'next'); kc.lock();
  assert.ok(kc.slotComplete(live) && live.publicKey !== A.publicKey, 'a new key is live');
  assert.deepEqual(prev, A, 'the old key is kept whole');
  assert.ok(kc.slotEmpty(next), 'the next slot is cleaned up');
  for (const v of [live.privateKey, live.password, A.privateKey, A.password]) assert.ok(!out(rot).includes(v), 'a secret was printed');
  assert.match(out(rot), new RegExp(live.publicKey.replace(/[+/]/g, '\\$&')));
  assert.match(out(node('updater-keygen.mjs', [R, '--status'])), /previous key kept/);
  // a second rotation is refused until the first one is finished
  assert.match(out(node('updater-keygen.mjs', [R, '--replace'])), /--drop-prev/);
  // while the previous key is kept, a plain publish is refused (installed copies still trust the OLD key); the transitional
  // release is signed by the OLD key and carries the NEW pubkey; only after --drop-prev does the new key sign normally
  otherPub = A.publicKey;
  const confNew = writeConf(live.publicKey), confOld = writeConf(A.publicKey);
  const base = ['--app', R, '--version', VERSION, '--mac-app', app230, '--allow-partial', '--repo', 'OWNER/MindSuite'];
  const sigOk = (dir, pub) => { const f = path.join(dir, `${R}_${VERSION}_aarch64.app.tar.gz`); return verify(pub, f, `${f}.sig`, VERSION).status === 0; };
  const d1 = path.join(T, 'rot-new');
  const plain = node('publish-update.mjs', [...base, '--conf', confNew, '--dry-run', d1]);
  assert.notEqual(plain.status, 0); assert.match(out(plain), /previous update key.*--sign-with-prev-key/s); assert.ok(!existsSync(d1), 'a refused publish wrote a feed');
  const d2 = path.join(T, 'rot-prev'); const tr = node('publish-update.mjs', [...base, '--conf', confNew, '--sign-with-prev-key', '--dry-run', d2]);
  assert.equal(tr.status, 0, out(tr));
  assert.ok(sigOk(d2, A.publicKey) && !sigOk(d2, live.publicKey), '--sign-with-prev-key signs with the old key');
  for (const v of [A.privateKey, A.password]) assert.ok(!out(tr).includes(v));
  // before the new pubkey is committed the app still trusts the old key: signing with it is fine too
  assert.equal(node('publish-update.mjs', [...base, '--conf', confOld, '--sign-with-prev-key', '--dry-run', path.join(T, 'rot-old-conf')]).status, 0);
  // a pubkey that is neither is refused
  const stray = node('publish-update.mjs', [...base, '--conf', CONF, '--sign-with-prev-key', '--dry-run', path.join(T, 'rot-stray')]);
  assert.notEqual(stray.status, 0); assert.match(out(stray), /does not match plugins\.updater\.pubkey/);
  // the preflight says the same without any artifact
  assert.notEqual(node('publish-update.mjs', ['--app', R, '--preflight', '--conf', confNew]).status, 0);
  assert.equal(node('publish-update.mjs', ['--app', R, '--preflight', '--sign-with-prev-key', '--conf', confNew]).status, 0);
  // finishing the rotation
  assert.equal(node('updater-keygen.mjs', [R, '--drop-prev']).status, 0);
  assert.notEqual(node('publish-update.mjs', [...base, '--conf', confNew, '--sign-with-prev-key', '--dry-run', path.join(T, 'rot-gone')]).status, 0);
  const d3 = path.join(T, 'rot-after'); assert.equal(node('publish-update.mjs', [...base, '--conf', confNew, '--dry-run', d3]).status, 0);
  assert.ok(sigOk(d3, live.publicKey) && !sigOk(d3, A.publicKey), 'after --drop-prev the new key signs');
  assert.notEqual(node('updater-keygen.mjs', [R, '--drop-prev']).status, 0, 'nothing left to drop');
});

test('an interrupted rotation is repaired by --recover and never loses either key', () => {
  const mk = (name) => { assert.equal(node('updater-keygen.mjs', [name]).status, 0); kc.unlock(); const x = kc.getSlot(name, ''); kc.lock(); return x; };
  const A = mk('RotSrcA'), B = mk('RotSrcB');
  const cases = {
    'crashed before the old key was copied': () => { kc.putSlot('RotCrash', '', A); kc.putSlot('RotCrash', 'next', B); },
    'crashed with the live slot half rewritten': () => { kc.putSlot('RotCrash', '', A); kc.putSlot('RotCrash', 'prev', A); kc.putSlot('RotCrash', 'next', B); kc.putSlot('RotCrash', '', { ...A, password: B.password }); },
  };
  for (const [name, setup] of Object.entries(cases)) {
    kc.unlock(); kc.removeSlot('RotCrash', ''); kc.removeSlot('RotCrash', 'prev'); kc.removeSlot('RotCrash', 'next'); setup(); kc.lock();
    assert.match(out(node('updater-keygen.mjs', ['RotCrash', '--replace'])), /--recover/, `${name}: a new rotation must wait`);
    const r = node('updater-keygen.mjs', ['RotCrash', '--recover']);
    assert.equal(r.status, 0, `${name}: ${out(r)}`);
    kc.unlock(); const got = { live: kc.getSlot('RotCrash', ''), prev: kc.getSlot('RotCrash', 'prev'), next: kc.getSlot('RotCrash', 'next') }; kc.lock();
    assert.deepEqual(got.live, B, `${name}: the new key is live`); assert.deepEqual(got.prev, A, `${name}: the old key is kept`); assert.ok(kc.slotEmpty(got.next));
  }
  // a "next" that was never finished is discarded and the live key is untouched
  kc.unlock(); kc.removeSlot('RotCrash', ''); kc.removeSlot('RotCrash', 'prev'); kc.putSlot('RotCrash', '', A); kc.putSlot('RotCrash', 'next', B); kc.remove('RotCrash', 'private-key.next'); kc.lock();
  assert.equal(node('updater-keygen.mjs', ['RotCrash', '--recover']).status, 0);
  kc.unlock(); assert.deepEqual(kc.getSlot('RotCrash', ''), A); assert.ok(kc.slotEmpty(kc.getSlot('RotCrash', 'next'))); kc.lock();
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
    // the node verifier publish-update.mjs relies on agrees with the Rust one the apps use
    const sigText = readFileSync(`${file}.sig`, 'utf8'); const bytes = readFileSync(file);
    assert.equal(verifySignature({ pubkey, data: bytes, signature: sigText, version: VERSION }).ok, true, `${platform}: node verifier`);
    assert.equal(verifySignature({ pubkey, data: bytes, signature: sigText, version: '2.3.1' }).ok, false);
    assert.equal(verifySignature({ pubkey, data: Buffer.concat([bytes, Buffer.from('x')]), signature: sigText, version: VERSION }).ok, false);
    assert.equal(verifySignature({ pubkey: otherPub, data: bytes, signature: sigText, version: VERSION }).ok, false, 'another key');
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
    const rr = node('publish-update.mjs', ['--app', APP, '--version', v, '--mac-app', mac, '--win-nsis', n, '--win-msi', m, '--repo', 'OWNER/MindSuite', '--conf', CONF]);
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
    'a Windows file of another version': { args: ['--app', APP, '--version', '2.3.0', '--mac-app', app230, '--win-nsis', path.join(win, `${APP}_2.4.0_x64-setup.exe`), '--conf', CONF, '--dry-run', path.join(T, 'r2')], re: /does not look like version 2\.3\.0/ },
    'a bad version': { args: publishArgs(['--version', '2.3', '--dry-run', path.join(T, 'r3')]), re: /--version/ },
    'one platform only': { args: ['--app', APP, '--version', VERSION, '--mac-app', app230, '--conf', CONF, '--dry-run', path.join(T, 'r4')], re: /both macOS and Windows/ },
    'no artifacts': { args: ['--app', APP, '--version', VERSION, '--conf', CONF, '--dry-run', path.join(T, 'r5')], re: /nothing to publish/ },
    'an app without a key': { args: publishArgs(['--app', 'NoKeyApp', '--dry-run', path.join(T, 'r6')]), re: /no update key/ },
    'a keychain key that is not the one the app trusts': { args: publishArgs(['--conf', writeConf(otherPub), '--dry-run', path.join(T, 'r9')]), re: /does not match plugins\.updater\.pubkey/ },
    'a conf without a pubkey': { args: publishArgs(['--conf', (() => { const f = path.join(T, 'nopub.json'); writeFileSync(f, '{}'); return f; })(), '--dry-run', path.join(T, 'r10')]), re: /no plugins\.updater\.pubkey/ },
    'a tauri CLI that cannot bind a version': { args: publishArgs(['--tauri', (() => { const f = path.join(T, 'old-tauri'); writeFileSync(f, '#!/bin/bash\necho "Usage: tauri signer sign [OPTIONS] <FILE>"\n'); chmodSync(f, 0o755); return f; })(), '--dry-run', path.join(T, 'r11')]), re: /too old.*--app-version/s },
    'an app that does not verify': { args: publishArgs(['--dry-run', path.join(T, 'r7')]), env: { TEST_BAD: '1' }, re: /did not verify/ },
  };
  for (const [name, c] of Object.entries(cases)) {
    const r = node('publish-update.mjs', c.args, c.env || {});
    assert.notEqual(r.status, 0, `${name} was accepted`);
    assert.match(out(r), c.re, name);
    for (const v of secretValues) assert.ok(!out(r).includes(v));
  }
  for (const d of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r9', 'r10', 'r11']) assert.ok(!existsSync(path.join(T, d, 'latest.json')), `${d} wrote a feed`);
  assert.equal(readFileSync(baseEnv.GH_LOG, 'utf8'), '', 'a refused publish made no gh call');
  // one platform on purpose
  const ok = node('publish-update.mjs', ['--app', APP, '--version', VERSION, '--mac-app', app230, '--allow-partial', '--repo', 'OWNER/MindSuite', '--conf', CONF, '--dry-run', path.join(T, 'r8')]);
  assert.equal(ok.status, 0, out(ok));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(T, 'r8/latest.json'), 'utf8')).platforms), ['darwin-aarch64']);
});

// ---- feed guards, upload retries --------------------------------------------------------------------------------
function release(v) {
  const mac = makeApp(path.join(T, `mac-${v}`), v);
  const n = path.join(win, `${APP}_${v}_x64-setup.exe`); writeFileSync(n, `nsis ${v}`);
  const m = path.join(win, `${APP}_${v}_x64_en-US.msi`); writeFileSync(m, `msi ${v}`);
  return ['--app', APP, '--version', v, '--mac-app', mac, '--win-nsis', n, '--win-msi', m, '--repo', 'OWNER/MindSuite', '--conf', CONF];
}
const feedFile = () => path.join(T, 'gh-state/TestApp-updates/latest.json');
const feedVersion = () => JSON.parse(readFileSync(feedFile(), 'utf8')).version;

test('the feed refuses pre-releases and versions that are not newer, before anything is signed', () => {
  assert.equal(feedVersion(), '2.5.0');
  const rc = node('publish-update.mjs', [...release('2.6.0-rc.1'), '--dry-run', path.join(T, 'rc-dry')]);
  assert.notEqual(rc.status, 0); assert.match(out(rc), /pre-release/); assert.ok(!existsSync(path.join(T, 'rc-dry')));
  const rcOk = node('publish-update.mjs', [...release('2.6.0-rc.1'), '--prerelease', '--dry-run', path.join(T, 'rc-ok')]);
  assert.equal(rcOk.status, 0, out(rcOk));
  writeFileSync(baseEnv.GH_LOG, '');
  for (const v of ['2.3.1']) {
    const r = node('publish-update.mjs', release(v));
    assert.notEqual(r.status, 0, `${v} was accepted`); assert.match(out(r), /not newer/);
    assert.equal(feedVersion(), '2.5.0', 'the feed was changed');
  }
  // the SAME version with a complete feed is a finished publish (a re-run after the read-back or the prune failed): success, nothing sent
  const same = node('publish-update.mjs', release('2.5.0'));
  assert.equal(same.status, 0, out(same)); assert.match(out(same), /already holds 2\.5\.0.*nothing to publish/s);
  assert.equal(feedVersion(), '2.5.0', 'the feed was changed');
  // the SAME version with a file the feed names missing is NOT finished: refused, not reported as current
  const feedDir = path.dirname(feedFile());
  const named = Object.values(JSON.parse(readFileSync(feedFile(), 'utf8')).platforms)[0].url.split('/').pop();
  const sig = `${decodeURIComponent(named)}.sig`;
  const sigBody = readFileSync(path.join(feedDir, sig));
  rmSync(path.join(feedDir, sig));
  const broken = node('publish-update.mjs', release('2.5.0'));
  assert.notEqual(broken.status, 0); assert.match(out(broken), /not newer/);
  writeFileSync(path.join(feedDir, sig), sigBody);
  const log = readFileSync(baseEnv.GH_LOG, 'utf8');
  assert.ok(!/release upload|release create|delete-asset/.test(log), `a refused publish uploaded: ${log}`);
  // on purpose
  const forced = node('publish-update.mjs', [...release('2.4.0'), '--force-feed']);
  assert.equal(forced.status, 0, out(forced)); assert.equal(feedVersion(), '2.4.0');
});

test('a failing latest.json upload is retried, and a hard failure says the feed must be restored', () => {
  const counter = path.join(T, 'fail-latest');
  writeFileSync(counter, '2\n');
  const ok = node('publish-update.mjs', release('2.7.0'));
  assert.equal(ok.status, 0, out(ok)); assert.equal(feedVersion(), '2.7.0');
  const tries = readFileSync(baseEnv.GH_LOG, 'utf8').split('\n').filter((l) => l.startsWith('gh release upload') && l.includes('latest.json'));
  assert.ok(tries.length >= 3, `retried: ${tries.length}`);
  writeFileSync(counter, '9\n');
  const bad = node('publish-update.mjs', release('2.8.0'));
  assert.notEqual(bad.status, 0); assert.match(out(bad), /feed .*may answer 404.*run publish-update again/s);
  assert.ok(!existsSync(feedFile()), 'the stub fixture models the deleted latest.json');
  // the re-run restores it (a missing latest.json does not block the version check)
  rmSync(counter);
  const again = node('publish-update.mjs', release('2.8.0'));
  assert.equal(again.status, 0, out(again)); assert.equal(feedVersion(), '2.8.0');
});
