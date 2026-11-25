'use strict';

// What an update must be before MindSuite lets the macOS updater hand it to Squirrel.Mac. The zip has already been
// downloaded and its SHA-512 checked against the feed by electron-updater; this checks the app INSIDE it: the same app
// (bundle id) from the same Developer ID team as the copy that is running, hardened, an exact and newer version than the
// feed announced, and Apple's notarization. Squirrel.Mac then compares the code signature once more when it swaps the
// copy in. Nothing here installs anything.

const { execFile, spawnSync } = require('node:child_process');
const { mkdtemp, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const BUNDLE_ID = 'com.seancheren.mindsuite';
const APP_NAME = 'MindSuite.app';

/** codesign -dvv output as facts. Every field is null/false when the text does not say it. */
function parseSignature(text) {
  const value = key => new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1]?.trim() ?? null;
  const team = value('TeamIdentifier');
  return {
    identifier: value('Identifier'),
    team: team && team !== 'not set' && /^[A-Z0-9]{10}$/.test(team) ? team : null,
    adhoc: /^Signature=adhoc$/m.test(text) || /flags=0x[0-9a-f]+\([^)]*adhoc/.test(text),
    developerId: /^Authority=Developer ID Application: /m.test(text),
    hardened: /^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime/m.test(text),
    timestamp: /^Timestamp=/m.test(text),
  };
}

/** The signature facts of an app on disk (codesign writes them to stderr). */
function readSignature(bundle, { spawn = spawnSync } = {}) {
  try {
    const shown = spawn('/usr/bin/codesign', ['-dvv', bundle], { encoding: 'utf8', timeout: 10_000 });
    return parseSignature(`${shown.stderr ?? ''}${shown.stdout ?? ''}`);
  } catch { return parseSignature(''); }
}

const parseVersion = text => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? '').trim());
  return match ? match.slice(1).map(Number) : null;
};

/** Negative, zero or positive like a comparison; null when either side is not a plain x.y.z. */
function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

const first = text => String(text ?? '').trim().split('\n')[0].slice(0, 240);

/**
 * Throws an Error in plain words when the app at `bundle` is not an acceptable update for the running copy.
 *   announced   the version the feed promised
 *   running     { version, team }: the running copy
 *   notarized   'required' (always, outside tests) | 'skip' (only a test run with a loopback feed)
 *   run         async (file, args) => { stdout, stderr }; rejects on a non-zero exit
 */
async function verifyUpdateBundle({ bundle, announced, running, notarized = 'required', run = (file, args) => exec(file, args, { timeout: 120_000 }) }) {
  if (!running?.team) throw new Error('This copy of MindSuite has no Developer ID team to compare the update with.');
  if (compareVersions(announced, running.version) === null) throw new Error('The update does not announce a plain version.');
  try {
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  } catch (error) {
    throw new Error(`The downloaded app does not verify: ${first(error.stderr || error.message)}`);
  }
  let shown;
  try { shown = await run('/usr/bin/codesign', ['-dvv', bundle]); } catch (error) { throw new Error(`The downloaded app has no readable signature: ${first(error.stderr || error.message)}`); }
  const signature = parseSignature(`${shown.stderr ?? ''}${shown.stdout ?? ''}`);
  if (signature.adhoc || !signature.developerId) throw new Error('The downloaded app is not signed by a Developer ID.');
  if (signature.identifier !== BUNDLE_ID) throw new Error('The downloaded app is not MindSuite.');
  if (signature.team !== running.team) throw new Error('The downloaded app is signed by a different team than this copy.');
  if (!signature.hardened || !signature.timestamp) throw new Error('The downloaded app lacks the hardened runtime or a secure timestamp.');
  let version;
  try { version = (await run('/usr/bin/defaults', ['read', join(bundle, 'Contents/Info'), 'CFBundleShortVersionString'])).stdout.trim(); } catch { version = ''; }
  if (version !== announced) throw new Error(`The downloaded app is version ${version || 'unknown'}, not the announced ${announced}.`);
  if (!(compareVersions(version, running.version) > 0)) throw new Error(`Version ${version} is not newer than ${running.version}.`);
  if (notarized === 'required') {
    try {
      const assessed = await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', bundle]);
      if (!/Notarized Developer ID/.test(`${assessed.stderr ?? ''}${assessed.stdout ?? ''}`)) throw new Error('not notarized');
    } catch (error) {
      throw new Error(`Apple has not notarized the downloaded app: ${first(error.stderr || error.stdout || error.message)}`);
    }
  }
  return { version, team: signature.team };
}

/** Unpack the downloaded zip in a private folder, verify the one app inside, and always remove the folder. */
async function verifyUpdateZip(zip, options, { run = (file, args) => exec(file, args, { timeout: 120_000 }), makeTemp = () => mkdtemp(join(tmpdir(), 'mindsuite-update-')) } = {}) {
  const folder = await makeTemp();
  try {
    await run('/usr/bin/ditto', ['-x', '-k', zip, folder]);
    const names = (await readdir(folder)).filter(name => !name.startsWith('.') && name !== '__MACOSX');
    if (names.length !== 1 || names[0] !== APP_NAME) throw new Error(`The update holds ${names.length === 1 ? names[0] : `${names.length} items`}, not just ${APP_NAME}.`);
    return await verifyUpdateBundle({ ...options, bundle: join(folder, APP_NAME), run });
  } finally {
    // /bin/rm, not fs.rm: inside Electron fs treats the update's app.asar as an archive and refuses to delete it.
    await exec('/bin/rm', ['-rf', folder]).catch(() => {});
  }
}

module.exports = { BUNDLE_ID, APP_NAME, parseSignature, readSignature, compareVersions, verifyUpdateBundle, verifyUpdateZip };
