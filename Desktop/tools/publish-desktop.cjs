#!/usr/bin/env node
'use strict';

// Publish a MindSuite Desktop release that tools/release-mac.cjs built. NOTHING runs from the build or a test.
//
//   node tools/publish-desktop.cjs --dir dist/release [--repo OWNER/MindSuite] [--keep 2] [--dry-run]
//
// Order: the checks, the release page MindSuiteDesktop/<version> (dmg, zip, SHA256SUMS; never flagged Latest), then the
// fixed feed release MindSuiteDesktop-updates: the zip first, latest-mac.yml LAST (installed copies only see a new version
// once everything it points at is there), a read-back of the feed, and the pruning of zips beyond --keep. The tag of the
// release page must already be on origin (the release lane pushes it with main). The feed release is created by this
// script through `gh release create`, a pre-release, so it is never Latest and no tag is pushed.
//
// Refused: a scratch build, an artifact set that does not match release.json or SHA256SUMS, a feed that does not describe
// the zip, a version that is not newer than the live feed's, a missing notes file.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./release-lib.cjs');

const root = path.resolve(__dirname, '..');
const suite = path.resolve(root, '..');

function run(file, args, { cwd = root, env = process.env } = {}) {
  const result = spawnSync(file, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

const compare = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

/**
 * deps: { gh(args) -> {status, stdout, stderr}, fetchText(url) -> string|null (null when 404), hasTag(tag) -> boolean,
 *         verifyDmg(dmg, team) -> void (throws), log(text) }
 */
async function publish({ dir, repo = 'chere005/MindSuite', keep = 2, dryRun = false, notesFile, version }, deps) {
  const { gh, fetchText, hasTag, verifyDmg, log } = deps;
  const fail = message => { throw new Error(message); };
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8'));
  if (record.release !== true) fail('this is a scratch build (release.json says release: false); build a release with npm run release:mac');
  if (record.version !== version) fail(`the build is version ${record.version}, package.json is ${version}`);
  if (record.tag !== lib.releaseTag(version) || record.feedTag !== lib.FEED_TAG || record.repo !== repo) fail('release.json names another tag, feed or repository');
  const zip = lib.zipName(version), dmg = lib.dmgName(version);
  for (const name of [dmg, zip, 'latest-mac.yml', 'SHA256SUMS']) if (!fs.existsSync(path.join(dir, name))) fail(`${name} is missing from ${dir}`);
  if (JSON.stringify([...record.files].sort()) !== JSON.stringify([dmg, zip, 'latest-mac.yml', 'SHA256SUMS'].sort())) fail('release.json lists other files than the release');
  const sums = new Map(fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n').map(line => { const [hex, name] = line.split(/ {2}/); return [name, hex]; }));
  for (const name of [dmg, zip, 'latest-mac.yml']) {
    if (sums.get(name) !== lib.sha256Hex(fs.readFileSync(path.join(dir, name)))) fail(`${name} does not match SHA256SUMS`);
  }
  const feedText = fs.readFileSync(path.join(dir, 'latest-mac.yml'), 'utf8');
  await lib.checkFeedAgainstZip(feedText, path.join(dir, zip), version);
  if (!notesFile || !fs.existsSync(notesFile)) fail(`no release notes at ${notesFile || 'Desktop/docs/releases/<version>.md'}`);
  verifyDmg(path.join(dir, dmg), record.team);

  const live = await fetchText(`${lib.feedUrl(repo)}/latest-mac.yml`);
  if (live) {
    const liveVersion = lib.parseFeed(live).version;
    if (compare(version, liveVersion) <= 0) fail(`${version} is not newer than the live feed's ${liveVersion}`);
  }
  if (!hasTag(record.tag)) fail(`${record.tag} is not on origin; the release lane pushes the tag first`);

  const steps = [];
  const doGh = (args, why) => {
    steps.push(`gh ${args.join(' ')}`);
    if (dryRun) return { status: 0, stdout: '', stderr: '' };
    const result = gh(args);
    if (result.status !== 0) fail(`${why} failed: ${(result.stderr || result.stdout).trim().split('\n')[0]}`);
    return result;
  };
  const file = name => path.join(dir, name);
  const page = gh(['release', 'view', record.tag, '--repo', repo, '--json', 'tagName']);
  if (page.status === 0) fail(`${record.tag} already has a release page; versions are published once`);
  doGh(['release', 'create', record.tag, file(dmg), file(zip), file('SHA256SUMS'), '--repo', repo, '--verify-tag', '--title', `MindSuite ${version}`, '--notes-file', notesFile, '--latest=false'], 'the release page');
  const feedRelease = gh(['release', 'view', lib.FEED_TAG, '--repo', repo, '--json', 'tagName']);
  if (feedRelease.status !== 0) {
    doGh(['release', 'create', lib.FEED_TAG, '--repo', repo, '--prerelease', '--latest=false', '--target', 'main', '--title', 'MindSuite Desktop updates', '--notes', 'The fixed update feed of MindSuite Desktop. Not a release: install from a MindSuite Desktop release page.'], 'the feed release');
  }
  doGh(['release', 'upload', lib.FEED_TAG, file(zip), '--repo', repo, '--clobber'], 'the feed zip upload');
  doGh(['release', 'upload', lib.FEED_TAG, file('latest-mac.yml'), '--repo', repo, '--clobber'], 'the feed document upload');
  if (!dryRun) {
    const back = await fetchText(`${lib.feedUrl(repo)}/latest-mac.yml`);
    if (back !== feedText) fail('the live feed does not read back as what was uploaded; run this again');
    const listed = JSON.parse(doGh(['release', 'view', lib.FEED_TAG, '--repo', repo, '--json', 'assets'], 'listing the feed').stdout || '{"assets":[]}').assets
      .map(asset => ({ name: asset.name, version: /^MindSuite-(\d+\.\d+\.\d+)-arm64-mac\.zip$/.exec(asset.name)?.[1] })).filter(asset => asset.version)
      .sort((a, b) => compare(b.version, a.version));
    for (const old of listed.slice(Math.max(1, keep))) doGh(['release', 'delete-asset', lib.FEED_TAG, old.name, '--repo', repo, '--yes'], 'pruning');
  }
  log(`${dryRun ? 'would publish' : 'published'} MindSuite ${version}`);
  return steps;
}

module.exports = { publish };

if (require.main === module) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const repo = option('--repo', 'chere005/MindSuite');
  const gh = list => run(process.env.MIND_GH || 'gh', list);
  publish({
    dir: path.resolve(option('--dir', path.join(root, 'dist/release'))), repo, keep: Number(option('--keep', 2)), dryRun: args.includes('--dry-run'),
    version: pkg.version, notesFile: path.join(root, 'docs/releases', `${pkg.version}.md`),
  }, {
    gh,
    fetchText: async url => { const response = await fetch(url, { redirect: 'follow' }); return response.status === 404 ? null : response.ok ? response.text() : (() => { throw new Error(`${url}: HTTP ${response.status}`); })(); },
    hasTag: tag => run('git', ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`]).status === 0,
    verifyDmg: (dmg, team) => {
      const result = run('bash', [path.join(suite, 'tools/ci/verify-macos-dmg.sh'), dmg, 'MindSuite'], { env: { ...process.env, APPLE_TEAM_ID: team } });
      if (result.status !== 0) throw new Error(`the dmg fails verification: ${result.stderr.trim()}`);
    },
    log: console.log,
  }).catch(error => { console.error(`publish-desktop: ${error.message}`); process.exit(1); });
}
