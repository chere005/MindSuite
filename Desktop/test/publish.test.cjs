'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const lib = require('../tools/release-lib.cjs');
const { publish } = require('../tools/publish-desktop.cjs');

const REPO = 'o/MindSuite';

function release({ version = '0.4.0', releaseFlag = true, mutate = () => {} } = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'publish-test-'));
  const files = { [lib.dmgName(version)]: 'dmg', [lib.zipName(version)]: 'zip' };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(join(dir, name), text);
  const zipBytes = Buffer.from('zip');
  fs.writeFileSync(join(dir, 'latest-mac.yml'), lib.feedYaml({ version, file: lib.zipName(version), sha512: lib.sha512Base64(zipBytes), size: zipBytes.length, releaseDate: 'now' }));
  fs.writeFileSync(join(dir, 'SHA256SUMS'), [lib.dmgName(version), lib.zipName(version), 'latest-mac.yml'].map(name => lib.sha256Line(lib.sha256Hex(fs.readFileSync(join(dir, name))), name)).join(''));
  fs.writeFileSync(join(dir, 'release.json'), JSON.stringify({ version, repo: REPO, tag: lib.releaseTag(version), feedTag: lib.FEED_TAG, team: 'ABCDE12345', release: releaseFlag, files: [lib.dmgName(version), lib.zipName(version), 'latest-mac.yml', 'SHA256SUMS'] }));
  mutate(dir);
  const notes = join(dir, 'notes.md');
  fs.writeFileSync(notes, 'notes');
  return { dir, notes };
}

function deps({ live = null, tag = true, existing = [], assets = [] } = {}) {
  const calls = [];
  let uploaded = null;
  return {
    calls,
    deps: {
      gh: args => {
        calls.push(args.join(' '));
        if (args[1] === 'view' && args.includes('tagName')) return { status: existing.includes(args[2]) ? 0 : 1, stdout: '', stderr: 'release not found' };
        if (args[1] === 'view') return { status: 0, stdout: JSON.stringify({ assets: assets.map(name => ({ name })) }), stderr: '' };
        if (args[1] === 'upload' && args.some(a => a.endsWith('latest-mac.yml'))) uploaded = fs.readFileSync(args.find(a => a.endsWith('latest-mac.yml')), 'utf8');
        return { status: 0, stdout: '', stderr: '' };
      },
      fetchText: async () => (uploaded ?? live),
      hasTag: () => tag,
      verifyDmg: () => {},
      log: () => {},
    },
  };
}

const publishArgs = (built, extra = {}) => ({ dir: built.dir, repo: REPO, version: '0.4.0', notesFile: built.notes, ...extra });

test('publishes the release page first, the feed zip next and latest-mac.yml last, then prunes', async () => {
  const built = release();
  const { calls, deps: fakes } = deps({ assets: ['MindSuite-0.2.0-arm64-mac.zip', 'MindSuite-0.3.0-arm64-mac.zip', lib.zipName('0.4.0'), 'latest-mac.yml'] });
  const live = fs.readFileSync(join(built.dir, 'latest-mac.yml'), 'utf8').replace(/0\.4\.0/g, '0.3.0');
  fakes.fetchText = (original => async url => (calls.some(call => call.includes('upload') && call.includes('latest-mac.yml')) ? original(url) : live))(fakes.fetchText);
  await publish(publishArgs(built), fakes);
  const writes = calls.filter(call => /release (create|upload|delete-asset)/.test(call));
  assert.match(writes[0], /release create MindSuiteDesktop\/0\.4\.0 .*--verify-tag.*--latest=false/);
  assert.match(writes[1], /release create MindSuiteDesktop-updates .*--prerelease --latest=false/);
  assert.match(writes[2], /release upload MindSuiteDesktop-updates .*arm64-mac\.zip --repo o\/MindSuite --clobber/);
  assert.match(writes[3], /release upload MindSuiteDesktop-updates .*latest-mac\.yml/);
  assert.match(writes[4], /delete-asset MindSuiteDesktop-updates MindSuite-0\.2\.0-arm64-mac\.zip/);
  assert.equal(writes.length, 5);
  assert.equal(calls.some(call => /releases\/latest|--latest(?!=false)/.test(call)), false);
});

test('refuses a scratch build, a mismatch, a stale version, a missing tag and an existing release page', async () => {
  const cases = [
    [release({ releaseFlag: false }), {}, /scratch build/],
    [release({ mutate: dir => fs.appendFileSync(join(dir, lib.zipName('0.4.0')), 'x') }), {}, /SHA256SUMS/],
    [release({ mutate: dir => fs.writeFileSync(join(dir, 'latest-mac.yml'), fs.readFileSync(join(dir, 'latest-mac.yml'), 'utf8').replace('size: 3', 'size: 4')) }), {}, /SHA256SUMS/],
    [release(), { tag: false }, /not on origin/],
    [release(), { existing: ['MindSuiteDesktop/0.4.0'] }, /published once/],
    [release(), { live: lib.feedYaml({ version: '0.4.0', file: lib.zipName('0.4.0'), sha512: 'A'.repeat(86) + '==', size: 1, releaseDate: 'x' }) }, /not newer/],
    [release(), { live: lib.feedYaml({ version: '0.5.0', file: lib.zipName('0.5.0'), sha512: 'A'.repeat(86) + '==', size: 1, releaseDate: 'x' }) }, /not newer/],
  ];
  for (const [built, options, message] of cases) {
    const { calls, deps: fakes } = deps(options);
    await assert.rejects(publish(publishArgs(built), fakes), message);
    assert.equal(calls.some(call => /release (create|upload)/.test(call)), false, 'nothing was written');
  }
  const built = release();
  await assert.rejects(publish(publishArgs(built, { notesFile: join(built.dir, 'none.md') }), deps().deps), /no release notes/);
  await assert.rejects(publish(publishArgs(built, { version: '0.5.0' }), deps().deps), /package.json/);
});

test('a dry run writes nothing', async () => {
  const built = release();
  const { calls, deps: fakes } = deps();
  const steps = await publish(publishArgs(built, { dryRun: true }), fakes);
  assert.equal(steps.length, 4, "the page, the feed release, the zip and the feed document");
  assert.equal(calls.some(call => /release (create|upload|delete-asset)/.test(call)), false);
});
