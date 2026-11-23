'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdir, mkdtemp } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
  updateEligibility, loopbackFeed, checkFeedFile, guardedMacUpdater, createUpdater, FIRST_CHECK_MS, CHECK_EVERY_MS,
} = require('../updater.cjs');
const { parseSignature, compareVersions, verifyUpdateBundle, verifyUpdateZip } = require('../update-guard.cjs');

const TEAM = 'ABCDE12345';
const signed = { developerId: true, adhoc: false, team: TEAM, hardened: true, timestamp: true, identifier: 'com.seancheren.mindsuite' };
const base = { platform: 'darwin', arch: 'arm64', packaged: true, testing: false, feedOverride: false, hasFeedFile: true, bundle: '/Applications/MindSuite.app', signature: signed };

test('only a Developer ID signed, packaged, replaceable arm64 Mac install updates itself', () => {
  assert.equal(updateEligibility(base).ok, true);
  for (const change of [
    { packaged: false }, { hasFeedFile: false }, { platform: 'win32' }, { platform: 'linux' }, { arch: 'x64' },
    { signature: null }, { signature: { ...signed, adhoc: true } }, { signature: { ...signed, developerId: false } },
    { signature: { ...signed, team: null } }, { signature: { ...signed, hardened: false } },
    { bundle: '/Volumes/MindSuite/MindSuite.app' }, { bundle: '/private/var/x/AppTranslocation/y/d/MindSuite.app' }, { bundle: '/Applications/MindSuite' },
  ]) {
    const result = updateEligibility({ ...base, ...change });
    assert.equal(result.ok, false, JSON.stringify(change));
    assert.match(result.why, /\S/);
  }
});

test('tests update only through an explicit loopback feed, and still only a signed packaged copy', () => {
  assert.equal(updateEligibility({ ...base, testing: true }).ok, false);
  assert.equal(updateEligibility({ ...base, testing: true, feedOverride: true, hasFeedFile: false }).ok, true);
  assert.equal(updateEligibility({ ...base, testing: true, feedOverride: true, signature: null }).ok, false);
  assert.equal(updateEligibility({ ...base, testing: true, feedOverride: true, packaged: false }).ok, false);
  assert.equal(loopbackFeed('http://127.0.0.1:8123/feed'), 'http://127.0.0.1:8123/feed');
  assert.equal(loopbackFeed('http://localhost:9/'), 'http://localhost:9/');
  for (const value of ['https://example.com/feed', 'http://example.com/', 'http://127.0.0.1.evil.test/', 'file:///tmp/feed', 'nonsense', undefined]) assert.equal(loopbackFeed(value), null, String(value));
});

test('the packaged feed file must be the one fixed https address', () => {
  const url = 'https://github.com/chere005/MindSuite/releases/download/MindSuiteDesktop-updates';
  checkFeedFile(`provider: generic\nurl: ${url}\nchannel: latest\n`, url);
  checkFeedFile(`provider: generic\nurl: ${url}/\n`, url);
  for (const text of ['', `provider: github\nurl: ${url}\n`, 'provider: generic\nurl: http://github.com/chere005/MindSuite/releases/download/MindSuiteDesktop-updates\n',
    `provider: generic\nurl: ${url}-evil\n`, 'provider: generic\nurl: https://github.com/chere005/MindSuite/releases/latest/download\n']) {
    assert.throws(() => checkFeedFile(text, url), /update feed/, text);
  }
});

test('codesign output becomes facts, never more than it says', () => {
  const text = `Identifier=com.seancheren.mindsuite\nCodeDirectory v=20500 size=452 flags=0x10000(runtime) hashes=3+7 location=embedded\nAuthority=Developer ID Application: Someone (${TEAM})\nTimestamp=Nov 23, 2026 at 6:28:27 AM\nTeamIdentifier=${TEAM}\n`;
  assert.deepEqual(parseSignature(text), { identifier: 'com.seancheren.mindsuite', team: TEAM, adhoc: false, developerId: true, hardened: true, timestamp: true });
  const adhoc = parseSignature('Identifier=x\nCodeDirectory v=20400 size=433 flags=0x2(adhoc) hashes=3+7\nSignature=adhoc\nTeamIdentifier=not set\n');
  assert.equal(adhoc.adhoc, true);
  assert.equal(adhoc.team, null);
  assert.equal(adhoc.developerId, false);
  assert.equal(parseSignature('').hardened, false);
  assert.equal(compareVersions('0.4.0', '0.3.0') > 0, true);
  assert.equal(compareVersions('0.3.0', '0.3.0'), 0);
  assert.equal(compareVersions('0.3.0-beta', '0.3.0'), null);
});

// A stand-in for codesign, defaults and spctl: the update bundle's facts are the test's variables.
function tools({ identifier = 'com.seancheren.mindsuite', team = TEAM, version = '0.4.0', hardened = true, adhoc = false, developerId = true, timestamp = true, verifies = true, notarized = true } = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    if (file.endsWith('codesign') && args[0] === '--verify') { if (!verifies) throw Object.assign(new Error('bad'), { stderr: 'a sealed resource is missing\n' }); return { stdout: '', stderr: '' }; }
    if (file.endsWith('codesign')) {
      return { stdout: '', stderr: [`Identifier=${identifier}`, `CodeDirectory v=20500 flags=0x${hardened ? '10000(runtime)' : '0(none)'}`, adhoc ? 'Signature=adhoc' : '', developerId ? `Authority=Developer ID Application: Someone (${team})` : '', timestamp ? 'Timestamp=now' : '', `TeamIdentifier=${team}`].join('\n') };
    }
    if (file.endsWith('defaults')) return { stdout: `${version}\n`, stderr: '' };
    if (file.endsWith('spctl')) { if (!notarized) throw Object.assign(new Error('rejected'), { stderr: 'rejected\nsource=Unnotarized Developer ID\n' }); return { stdout: '', stderr: 'accepted\nsource=Notarized Developer ID\n' }; }
    throw new Error('unexpected ' + file);
  };
  return { run, calls };
}
const options = (extra = {}) => ({ bundle: '/x/MindSuite.app', announced: '0.4.0', running: { version: '0.3.0', team: TEAM }, ...extra });

test('an update must be the same app, same team, hardened, exact, newer and notarized', async () => {
  assert.deepEqual(await verifyUpdateBundle({ ...options(), run: tools().run }), { version: '0.4.0', team: TEAM });
  const refused = [
    [{ verifies: false }, /does not verify/], [{ adhoc: true, developerId: false }, /Developer ID/], [{ developerId: false }, /Developer ID/],
    [{ identifier: 'com.example.other' }, /not MindSuite/], [{ team: 'ZZZZZ99999' }, /different team/], [{ hardened: false }, /hardened/], [{ timestamp: false }, /hardened/],
    [{ version: '0.4.1' }, /not the announced/], [{ version: '0.3.0' }, /not the announced/], [{ notarized: false }, /not notarized/],
  ];
  for (const [change, message] of refused) await assert.rejects(verifyUpdateBundle({ ...options(), run: tools(change).run }), message, JSON.stringify(change));
  await assert.rejects(verifyUpdateBundle({ ...options({ announced: '0.3.0' }), run: tools({ version: '0.3.0' }).run }), /not newer/);
  await assert.rejects(verifyUpdateBundle({ ...options({ announced: '0.4.0-beta' }), run: tools().run }), /plain version/);
  await assert.rejects(verifyUpdateBundle({ ...options({ running: { version: '0.3.0', team: null } }), run: tools().run }), /no Developer ID team/);
});

test('only a test run with a loopback feed may skip notarization, and nothing else is skipped', async () => {
  const lax = tools({ notarized: false });
  await verifyUpdateBundle({ ...options({ notarized: 'skip' }), run: lax.run });
  assert.equal(lax.calls.some(call => call[0].endsWith('spctl')), false);
  await assert.rejects(verifyUpdateBundle({ ...options({ notarized: 'skip' }), run: tools({ notarized: false, team: 'ZZZZZ99999' }).run }), /different team/);
});

test('the downloaded zip is unpacked privately, must hold only MindSuite.app, and is always removed', async () => {
  const folders = [];
  async function check(contents, run = tools().run) {
    const makeTemp = async () => { const folder = await mkdtemp(join(tmpdir(), 'updater-test-')); folders.push(folder); return folder; };
    const unpack = async (file, args) => {
      if (file.endsWith('ditto')) { for (const name of contents) await mkdir(join(args.at(-1), name), { recursive: true }); return { stdout: '', stderr: '' }; }
      return run(file, args);
    };
    return verifyUpdateZip('/x/update.zip', options(), { run: unpack, makeTemp });
  }
  assert.equal((await check(['MindSuite.app'])).version, '0.4.0');
  await assert.rejects(check(['MindSuite.app', 'Extra.app']), /2 items/);
  await assert.rejects(check(['Other.app']), /not just MindSuite.app/);
  await assert.rejects(check(['MindSuite.app'], tools({ team: 'ZZZZZ99999' }).run), /different team/);
  for (const folder of folders) await assert.rejects(require('node:fs/promises').stat(folder), { code: 'ENOENT' });
});

test('the guarded updater verifies the zip before Squirrel.Mac gets it, and a failure stages nothing', async () => {
  const order = [];
  class Fake extends EventEmitter {
    constructor() { super(); this.updateInfoAndProvider = { info: { version: '0.4.0' } }; }
    async updateDownloaded() { order.push('squirrel'); return 'staged'; }
  }
  const verify = async (file, details) => { order.push(`verify ${file} ${details.announced} ${details.running.team} ${details.notarized}`); if (file.includes('bad')) throw new Error('not notarized'); };
  const Guarded = guardedMacUpdater(Fake, { verify, getRunning: () => ({ version: '0.3.0', team: TEAM }) });
  const updater = new Guarded();
  assert.equal(await updater.updateDownloaded({}, { downloadedFile: '/c/good.zip' }), 'staged');
  assert.deepEqual(order, [`verify /c/good.zip 0.4.0 ${TEAM} required`, 'squirrel']);
  order.length = 0;
  await assert.rejects(updater.updateDownloaded({}, { downloadedFile: '/c/bad.zip' }), /not notarized/);
  assert.deepEqual(order, [`verify /c/bad.zip 0.4.0 ${TEAM} required`]);
});

function harness({ result, download = 'ok', answers = [] } = {}) {
  const updater = new EventEmitter();
  const calls = { checks: 0, downloads: 0, installs: 0, quits: 0, dialogs: [], logs: [] };
  updater.checkForUpdates = async () => { calls.checks++; if (result instanceof Error) throw result; return result; };
  updater.downloadUpdate = async () => {
    calls.downloads++;
    if (download === 'fail') throw new Error('net::ERR_INTERNET_DISCONNECTED');
    updater.emit('update-downloaded', { version: result.updateInfo.version });
  };
  updater.quitAndInstall = (...args) => { calls.quits++; calls.quitArgs = args; };
  const dialog = { showMessageBox: async (...args) => { const dialogOptions = args.at(-1); calls.dialogs.push(dialogOptions); return { response: answers.shift() ?? 0 }; } };
  const timers = [];
  const controller = createUpdater({
    autoUpdater: updater, dialog, getWindow: () => null, version: '0.3.0', install: () => { calls.installs++; },
    log: (level, text) => calls.logs.push([level, text]),
    setTimer: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; },
    setRepeat: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; },
    clear: timer => { timer.cleared = true; },
  });
  return { updater, calls, controller, timers };
}
const newer = (version = '0.4.0') => ({ isUpdateAvailable: true, updateInfo: { version } });

test('the updater asks, downloads only after Download, and restarts only after Restart', async () => {
  const { updater, calls, controller } = harness({ result: newer(), answers: [0, 0] });
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false, 'nothing installs behind the app\'s back');
  assert.equal(updater.allowDowngrade, false);
  await controller.check();
  assert.equal(calls.downloads, 1);
  assert.equal(calls.installs, 1);
  assert.match(calls.dialogs[0].message, /MindSuite 0\.4\.0 is available/);
  assert.match(calls.dialogs[1].message, /0\.4\.0 is ready/);
  controller.quitAndInstall();
  assert.deepEqual(calls.quitArgs, [false, true]);
  controller.quitAndInstall(false);
  assert.deepEqual(calls.quitArgs, [false, false]);
});

test('Later is remembered per version for background checks; a manual check asks again', async () => {
  const { calls, controller } = harness({ result: newer(), answers: [1, 1] });
  await controller.check();
  await controller.check();
  assert.equal(calls.dialogs.length, 1);
  assert.equal(calls.downloads, 0);
  await controller.check({ manual: true });
  assert.equal(calls.dialogs.length, 2);
});

test('an update that is not newer, or a failed check, is quiet unless the person asked', async () => {
  for (const result of [{ isUpdateAvailable: false, updateInfo: { version: '0.3.0' } }, newer('0.3.0'), newer('0.2.0'), newer('not-a-version')]) {
    const { calls, controller } = harness({ result });
    await controller.check();
    assert.equal(calls.dialogs.length, 0, JSON.stringify(result));
    await controller.check({ manual: true });
    assert.match(calls.dialogs[0].message, /up to date/);
  }
  const { calls, controller } = harness({ result: new Error('offline') });
  await controller.check();
  assert.equal(calls.dialogs.length, 0);
  await controller.check({ manual: true });
  assert.match(calls.dialogs[0].message, /could not check/);
});

test('a download that the guard rejects is reported and never offers a restart', async () => {
  const { calls, controller } = harness({ result: newer(), download: 'fail', answers: [0] });
  await controller.check();
  assert.equal(calls.installs, 0);
  assert.match(calls.dialogs.at(-1).message, /could not download/);
});

test('checks start 20 s after launch and then every 12 hours, and stop on dispose', () => {
  const { controller, timers } = harness({ result: newer() });
  controller.start();
  assert.deepEqual(timers.map(timer => timer.ms), [FIRST_CHECK_MS, CHECK_EVERY_MS]);
  controller.dispose();
  assert.equal(timers.every(timer => timer.cleared), true);
});
