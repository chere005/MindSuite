import { readFile, writeFile, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// assets/logo.svg owns the mark; the square mobile cut and every export follow it.
const root = fileURLToPath(new URL('..', import.meta.url));
const at = (name) => path.join(root, name);
const rounded = await readFile(at('assets/logo.svg'), 'utf8');
const mark = rounded.match(/<path\b[^>]*\bd="([^"]+)"[^>]*\bstroke="(#[a-f\d]{6})"/i);
if (!mark) throw new Error('assets/logo.svg must contain the canonical path and stroke colour.');
const [, drawing, colour] = mark;
function replaceOne(source, pattern, replacement) {
  if ((source.match(pattern) ?? []).length !== 1) throw new Error('Expected exactly one logo definition.');
  return source.replace(pattern, replacement);
}
function normalizedIcns(bytes) {
  if (bytes.length < 8 || bytes.toString('ascii', 0, 4) !== 'icns' || bytes.readUInt32BE(4) !== bytes.length) {
    throw new Error('Invalid generated ICNS header.');
  }
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    if (bytes.length - offset < 8) throw new Error('Truncated generated ICNS chunk.');
    const length = bytes.readUInt32BE(offset + 4);
    if (length < 8 || length > bytes.length - offset) throw new Error('Invalid generated ICNS chunk length.');
    chunks.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  if (!chunks.length) throw new Error('Generated ICNS contains no image chunks.');
  // Tauri emits chunks from an unordered map. Change only their order, retaining every encoded payload.
  chunks.sort((a, b) => Buffer.compare(a.subarray(0, 4), b.subarray(0, 4)) || Buffer.compare(a, b));
  return Buffer.concat([bytes.subarray(0, 8), ...chunks]);
}

let square = await readFile(at('assets/logo-square.svg'), 'utf8');
square = replaceOne(square, /\bd="[^"]+"/g, `d="${drawing}"`);
square = replaceOne(square, /\bstroke="#[a-f\d]{6}"/gi, `stroke="${colour}"`);
let shell = await readFile(at('app/shell/Shell.ts'), 'utf8');
shell = replaceOne(shell, /stroke\.setAttribute\('d', '[^']*'\);/g, `stroke.setAttribute('d', '${drawing}');`);
shell = replaceOne(shell, /stroke: '#[a-f\d]{6}'/gi, `stroke: '${colour}'`);

const work = await mkdtemp(path.join(tmpdir(), 'TaskMind-icons-'));
try {
  // Tauri renders SVG directly; only mobile icons use the full-bleed cut.
  await writeFile(path.join(work, 'mobile.svg'), square);
  const cli = at('native/node_modules/.bin/tauri');
  for (const [input, output] of [[at('assets/logo.svg'), 'desktop'], [path.join(work, 'mobile.svg'), 'mobile']]) {
    const result = spawnSync(process.execPath, [cli, 'icon', input, '--output', path.join(work, output), '--ios-color', '#111111'], { cwd: root, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw result.error ?? new Error('Tauri icon generation failed.');
  }
  // Retain the platform formats this repo ships; unrelated generated formats stay in the scratch directory.
  const listed = spawnSync('git', ['ls-files', '-z', '--', 'native/src-tauri/icons'], { cwd: root, encoding: 'utf8' });
  if (listed.error || listed.status !== 0) throw listed.error ?? new Error('Could not list the tracked icon formats.');
  const files = listed.stdout.split('\0').filter(Boolean);
  if (!files.length) throw new Error('No tracked native icons found.');
  const exports = files.map((file) => {
    const relative = file.slice('native/src-tauri/icons/'.length);
    return { source: path.join(work, /^(ios|android)\//.test(relative) ? 'mobile' : 'desktop', relative), target: at(file) };
  });
  // Check the complete generated set before replacing any shipped asset.
  for (const item of exports) {
    const bytes = await readFile(item.source);
    if (path.extname(item.source) === '.icns') await writeFile(item.source, normalizedIcns(bytes));
  }
  await writeFile(at('assets/logo-square.svg'), square);
  await writeFile(at('server/public/TaskMind/icon.svg'), rounded);
  await writeFile(at('app/shell/Shell.ts'), shell);
  for (const item of exports) await copyFile(item.source, item.target);
  console.log(`Updated TaskMind's web mark and ${exports.length} native icon assets.`);
} finally {
  await rm(work, { recursive: true, force: true });
}
