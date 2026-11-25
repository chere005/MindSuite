'use strict';

// Pure helpers of the release lane (tools/release-mac.cjs and tools/publish-desktop.cjs); tested in test/release.test.cjs.

const { createHash } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { basename } = require('node:path');

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const VERSION = /^\d+\.\d+\.\d+$/;

/** The fixed, per-app feed: one pre-release of the public repository holds latest-mac.yml and the zip it names. */
const FEED_TAG = 'MindSuiteDesktop-updates';
const feedUrl = repo => `https://github.com/${repo}/releases/download/${FEED_TAG}`;
/** The release page of one version (its own tag; never flagged Latest). */
const releaseTag = version => `MindSuiteDesktop/${version}`;
const zipName = version => `MindSuite-${version}-arm64-mac.zip`;
const dmgName = version => `MindSuite-${version}-arm64.dmg`;

/** The electron-updater feed document (latest-mac.yml) for the one zip. */
function feedYaml({ version, file, sha512, size, releaseDate }) {
  if (!VERSION.test(version)) throw new Error('The update feed needs a plain x.y.z version.');
  if (!SAFE_NAME.test(file) || !file.includes(`-${version}-`)) throw new Error('The update file name must be plain and carry its version between dashes.');
  if (!/^[A-Za-z0-9+/]{86}==$/.test(sha512)) throw new Error('The update feed needs a base64 SHA-512.');
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('The update file is empty.');
  return [`version: ${version}`, 'files:', `  - url: ${file}`, `    sha512: ${sha512}`, `    size: ${size}`, `path: ${file}`, `sha512: ${sha512}`, `releaseDate: '${releaseDate}'`, ''].join('\n');
}

/** Read a feed back as {version, file, sha512, size}; throws on anything the writer above would not have written. */
function parseFeed(text) {
  const field = key => new RegExp(`^${key}:\\s*'?([^'\\n]+)'?\\s*$`, 'm').exec(text)?.[1];
  const entry = /^files:\n {2}- url: (\S+)\n {4}sha512: (\S+)\n {4}size: (\d+)\n/m.exec(text);
  if (!entry || (text.match(/^ {2}- url:/gm) || []).length !== 1) throw new Error('The feed must list exactly one file.');
  const result = { version: field('version'), file: entry[1], sha512: entry[2], size: Number(entry[3]) };
  if (field('path') !== result.file || field('sha512') !== result.sha512) throw new Error('The feed names two different files.');
  return result;
}

const sha512Base64 = data => createHash('sha512').update(data).digest('base64');
const sha256Hex = data => createHash('sha256').update(data).digest('hex');

/** The feed must describe exactly these bytes. */
async function checkFeedAgainstZip(feedText, zipFile, version) {
  const feed = parseFeed(feedText);
  const data = await readFile(zipFile);
  if (feed.version !== version || feed.file !== basename(zipFile) || feed.file !== zipName(version)) throw new Error('The feed does not name this release\'s zip.');
  if (feed.size !== data.length || feed.sha512 !== sha512Base64(data)) throw new Error('The feed does not match the zip\'s size and SHA-512.');
  return feed;
}

/** sha256sum format: "<hex>  <name>\n". */
const sha256Line = (hex, name) => `${hex}  ${name}\n`;

/** The app-update.yml electron-builder put in the app must be the generic provider at the fixed https feed. */
function checkAppFeedFile(text, repo) {
  const provider = /^provider:\s*(\S+)\s*$/m.exec(text)?.[1];
  const url = /^url:\s*(\S+)\s*$/m.exec(text)?.[1]?.replace(/\/+$/, '');
  if (provider !== 'generic' || url !== feedUrl(repo)) throw new Error(`The packaged app's update feed is not ${feedUrl(repo)}.`);
}

module.exports = {
  FEED_TAG, feedUrl, releaseTag, zipName, dmgName, feedYaml, parseFeed, sha512Base64, sha256Hex, checkFeedAgainstZip, sha256Line, checkAppFeedFile,
};
