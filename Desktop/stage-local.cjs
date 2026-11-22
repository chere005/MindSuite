'use strict';

const { access, chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } = require('node:fs/promises');
const { dirname, join, relative, resolve } = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);

async function stageNoteMind(build) {
  const app = resolve(process.env.MINDSUITE_NOTEMIND_APP || '/Applications/NoteMind.app');
  await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const { stdout: bundleId } = await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(app, 'Contents/Info.plist')]);
  const source = join(app, 'Contents/Resources/app');
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  if (bundleId.trim() !== 'com.seancheren.notemind' || pkg.name !== 'notemind'
      || pkg.version !== '1.2.0' || pkg.main !== 'src/main.cjs') {
    throw new Error('The hosted NoteMind runtime requires the signed NoteMind 1.2.0 app.');
  }
  const target = join(build, 'notemind');
  await mkdir(target);
  for (const file of ['src', 'node_modules', 'package.json', 'LICENSE', 'THIRD-PARTY-NOTICES.txt']) {
    await cp(join(source, file), join(target, file), { recursive: true });
  }
}

async function stage() {
  const asar = await import('@electron/asar');
  const calmind = resolve(process.env.MINDSUITE_CALMIND_DIST || join(__dirname, '../CalMind/apps/app/dist'));
  const scrollmind = resolve(process.env.MINDSUITE_SCROLLMIND_APP || '/Applications/ScrollMind.app');
  const source = join(scrollmind, 'Contents/Resources');
  const archive = join(source, 'app.asar');
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
    await stageNoteMind(build);
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
