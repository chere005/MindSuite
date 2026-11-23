'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const lib = require('../tools/release-lib.cjs');

const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
const read = file => readFileSync(join(__dirname, '..', file), 'utf8');
const SHA = 'A'.repeat(86) + '==';

test('the feed document names one zip with its version, hash and size', () => {
  const text = lib.feedYaml({ version: '0.4.0', file: lib.zipName('0.4.0'), sha512: SHA, size: 5, releaseDate: '2026-11-23T00:00:00.000Z' });
  assert.deepEqual(lib.parseFeed(text), { version: '0.4.0', file: 'MindSuite-0.4.0-arm64-mac.zip', sha512: SHA, size: 5 });
  assert.throws(() => lib.feedYaml({ version: '0.4', file: 'a.zip', sha512: SHA, size: 5, releaseDate: 'x' }), /x\.y\.z/);
  assert.throws(() => lib.feedYaml({ version: '0.4.0', file: '../MindSuite-0.4.0-.zip', sha512: SHA, size: 5, releaseDate: 'x' }), /plain/);
  assert.throws(() => lib.feedYaml({ version: '0.4.0', file: 'MindSuite-0.5.0-arm64-mac.zip', sha512: SHA, size: 5, releaseDate: 'x' }), /version/);
  assert.throws(() => lib.feedYaml({ version: '0.4.0', file: lib.zipName('0.4.0'), sha512: 'short', size: 5, releaseDate: 'x' }), /SHA-512/);
  assert.throws(() => lib.feedYaml({ version: '0.4.0', file: lib.zipName('0.4.0'), sha512: SHA, size: 0, releaseDate: 'x' }), /empty/);
  assert.throws(() => lib.parseFeed(text.replace('path: MindSuite-0.4.0-arm64-mac.zip', 'path: other.zip')), /two different/);
});

test('a feed must describe exactly the zip it ships with', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'release-test-'));
  try {
    const zip = join(folder, lib.zipName('0.4.0'));
    writeFileSync(zip, 'zip bytes');
    const make = bytes => lib.feedYaml({ version: '0.4.0', file: lib.zipName('0.4.0'), sha512: lib.sha512Base64(bytes), size: bytes.length, releaseDate: 'now' });
    await lib.checkFeedAgainstZip(make(Buffer.from('zip bytes')), zip, '0.4.0');
    await assert.rejects(lib.checkFeedAgainstZip(make(Buffer.from('other bytes')), zip, '0.4.0'), /size and SHA-512/);
    await assert.rejects(lib.checkFeedAgainstZip(make(Buffer.from('zip bytes')), zip, '0.5.0'), /does not name/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('release names are fixed and never use the repository-wide Latest address', () => {
  assert.equal(lib.releaseTag('0.4.0'), 'MindSuiteDesktop/0.4.0');
  assert.equal(lib.feedUrl('o/MindSuite'), 'https://github.com/o/MindSuite/releases/download/MindSuiteDesktop-updates');
  assert.doesNotMatch(lib.feedUrl('o/MindSuite'), /latest/i);
  assert.equal(lib.sha256Line('ab', 'f.zip'), 'ab  f.zip\n');
});

test('the packaged feed file, the app and the release lane agree on one fixed feed', () => {
  lib.checkAppFeedFile(read('app-update.yml'), 'chere005/MindSuite');
  assert.match(read('main.cjs'), new RegExp(lib.feedUrl('chere005/MindSuite').replace(/[.]/g, '\\.')));
  assert.ok(pkg.build.mac.extraResources.some(entry => entry.from === 'app-update.yml' && entry.to === 'app-update.yml'));
  assert.equal(pkg.dependencies['electron-updater'], '6.8.12', 'the updater hand-off the guard overrides is pinned exactly');
  assert.equal(pkg.build.mac.identity, '-', 'electron-builder only builds; tools/mac-sign-install.sh signs');
  assert.equal(pkg.build.mac.notarize, false);
  assert.doesNotMatch(JSON.stringify(pkg), /signCommand|certificateFile|certificateSubjectName|azureSignOptions|--latest(?!=false)/);
});

test('entitlements grant exactly JIT and the camera', () => {
  const keys = [...read('entitlements.mac.plist').matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map(match => match[1]);
  assert.deepEqual(keys, ['com.apple.security.cs.allow-jit', 'com.apple.security.device.camera']);
  assert.match(read('entitlements.mac.plist'), /never asks for the microphone/);
  assert.match(JSON.stringify(pkg.build.mac.extendInfo), /NSCameraUsageDescription/);
  assert.doesNotMatch(JSON.stringify(pkg.build.mac.extendInfo), /Microphone/);
});

test('the hosted apps are pinned, and a release stages only notarized builds', () => {
  const pins = JSON.parse(read('runtime-pins.json'));
  assert.deepEqual(Object.keys(pins).sort(), ['notemind', 'scrollmind']);
  for (const pin of Object.values(pins)) assert.match(pin.version, /^\d+\.\d+\.\d+$/);
  assert.match(read('stage-local.cjs'), /notarized, hardened/);
  assert.match(read('tools/release-mac.cjs'), /'--release'/);
});
