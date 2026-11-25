'use strict';

const { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { dirname, join, relative, resolve } = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const pins = require('./runtime-pins.json');
const { parseSignature } = require('./update-guard.cjs');
// `--release` (or MINDSUITE_STAGE_RELEASE=1): the hosted apps must be notarized, hardened Developer ID builds. A scratch or
// local build only needs them to be intact, signed by a Developer ID, and the pinned versions.
const release = process.argv.includes('--release') || process.env.MINDSUITE_STAGE_RELEASE === '1';

async function digestFile(file) { return createHash('sha256').update(await readFile(file)).digest('hex'); }

/** One digest for a folder: every file's relative path and content hash, in name order. */
async function digestTree(root) {
  const lines = [];
  async function walk(folder) {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(folder, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) lines.push(`${relative(root, file)}\0${await digestFile(file)}\n`);
    }
  }
  await walk(root);
  return createHash('sha256').update(lines.join('')).digest('hex');
}

/** Facts about a hosted app bundle; throws unless it is intact, pinned and signed by a Developer ID. */
async function inspectSource(app, name) {
  const pin = pins[name];
  await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const { stdout: bundleId } = await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(app, 'Contents/Info.plist')]);
  const { stdout: version } = await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')]);
  if (bundleId.trim() !== pin.bundleId || version.trim() !== pin.version) {
    throw new Error(`The hosted ${name} runtime requires ${pin.bundleId} ${pin.version} (runtime-pins.json); found ${bundleId.trim()} ${version.trim()}.`);
  }
  const shown = await exec('/usr/bin/codesign', ['-dvv', app]).catch(error => error);
  const signature = parseSignature(`${shown.stderr ?? ''}${shown.stdout ?? ''}`);
  if (signature.adhoc || !signature.developerId || !signature.team) throw new Error(`The hosted ${name} app is not signed by a Developer ID.`);
  const assessed = await exec('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app]).catch(error => error);
  const notarized = /Notarized Developer ID/.test(`${assessed.stderr ?? ''}${assessed.stdout ?? ''}`);
  if (release && (!notarized || !signature.hardened)) {
    throw new Error(`A release hosts only the notarized, hardened ${name} build; this one is ${notarized ? 'notarized' : 'not notarized'} and ${signature.hardened ? 'hardened' : 'not hardened'}. Release ${name} first.`);
  }
  return { version: version.trim(), team: signature.team, notarized, hardened: signature.hardened };
}

async function stageNoteMind(build) {
  const app = resolve(process.env.MINDSUITE_NOTEMIND_APP || '/Applications/NoteMind.app');
  const facts = await inspectSource(app, 'notemind');
  const source = join(app, 'Contents/Resources/app');
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  if (pkg.name !== 'notemind' || pkg.version !== pins.notemind.version || pkg.main !== 'src/main.cjs') {
    throw new Error('The hosted NoteMind runtime requires the pinned NoteMind app.');
  }
  const target = join(build, 'notemind');
  await mkdir(target);
  for (const file of ['src', 'node_modules', 'package.json', 'LICENSE', 'THIRD-PARTY-NOTICES.txt']) {
    await cp(join(source, file), join(target, file), { recursive: true });
  }
  return { ...facts, sha256: await digestTree(target) };
}

async function stage() {
  const asar = await import('@electron/asar');
  const calmind = resolve(process.env.MINDSUITE_CALMIND_DIST || join(__dirname, '../CalMind/apps/app/dist'));
  const scrollmind = resolve(process.env.MINDSUITE_SCROLLMIND_APP || '/Applications/ScrollMind.app');
  const source = join(scrollmind, 'Contents/Resources');
  const archive = join(source, 'app.asar');
  const scrollFacts = await inspectSource(scrollmind, 'scrollmind');
  const pkg = JSON.parse(asar.extractFile(archive, 'package.json'));
  if (pkg.name !== 'scrollmind') throw new Error('The selected app bundle is not ScrollMind.');

  const html = await readFile(join(calmind, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/src="\/calmind\/([^"]+\.js)"/g)].map((match) => match[1]);
  if (!scripts.length) throw new Error('Export CalMind for web with its /calmind/ base path first.');
  await Promise.all(scripts.map(file => access(join(calmind, file))));

  const target = join(__dirname, 'runtime');
  const build = await mkdtemp(join(__dirname, 'runtime-'));
  try {
    await cp(calmind, join(build, 'calmind'), {
      recursive: true,
      filter: file => !['.sources.json', 'sw.js'].includes(relative(calmind, file)),
    });
    const scrollDir = join(build, 'scrollmind');
    const backend = new Set(['documents.cjs', 'workspace.cjs', 'storage.cjs', 'document-io.cjs',
      'preload.cjs', 'native-pen.cjs', 'pen-access.cjs', 'icloud-copy.cjs']);
    for (const item of asar.listPackage(archive)) {
      const file = item.slice(1);
      if (file.split('/').some(part => part.startsWith('.'))) continue;
      if (!/^src\/(core|renderer)\/.+\.(mjs|css|html)$/.test(file)
          && !(file.startsWith('src/main/') && backend.has(file.slice('src/main/'.length)))) continue;
      const dest = join(scrollDir, file);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, asar.extractFile(archive, file));
    }
    await access(join(scrollDir, 'src/renderer/index.html'));
    await access(join(scrollDir, 'src/main/preload.cjs'));
    const helper = join(scrollDir, 'scroll-pen');
    await cp(join(source, 'scroll-pen'), helper);
    await chmod(helper, 0o755);
    await writeFile(join(scrollDir, 'version.json'), JSON.stringify({ version: pkg.version }));
    const noteFacts = await stageNoteMind(build);
    if (noteFacts.team !== scrollFacts.team) throw new Error('The hosted NoteMind and ScrollMind apps are signed by different teams.');
    // What went into this build, kept inside the app (Resources/mindsuite-local/MANIFEST.json) and read by the release script.
    await writeFile(join(build, 'MANIFEST.json'), JSON.stringify({
      release,
      team: noteFacts.team,
      notemind: noteFacts,
      scrollmind: { ...scrollFacts, sha256: { 'app.asar': await digestFile(archive), 'scroll-pen': await digestFile(helper) } },
      calmind: { sha256: await digestFile(join(calmind, 'index.html')) },
    }, null, 2) + '\n');
    await rm(target, { recursive: true, force: true });
    await rename(build, target);
  } finally {
    await rm(build, { recursive: true, force: true });
  }
}

stage().catch(error => {
  console.error(`Cannot stage the local apps: ${error.message}`);
  process.exitCode = 1;
});
