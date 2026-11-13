import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('Mac release lanes reject an Intel host before building; iOS plans remain available', { skip: process.platform === 'win32' }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mindsuite-mac-target-'));
  try {
    const bin = join(tmp, 'bin'); mkdirSync(bin);
    const uname = join(bin, 'uname');
    writeFileSync(uname, '#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo "${TEST_UNAME_ARCH:-x86_64}";; esac\n'); chmodSync(uname, 0o755);
    for (const command of ['npm', 'npx', 'cargo', 'xcodebuild', 'xcrun', 'git', 'ditto', 'open', 'pkill']) {
      const shim = join(bin, command); writeFileSync(shim, '#!/bin/sh\necho "unexpected build" >&2\nexit 97\n'); chmodSync(shim, 0o755);
    }
    for (const app of ['CalMind', 'ChefMind', 'AcctMind', 'PlanMind', 'TaskMind', 'CoreMind']) {
      const fixture = join(tmp, app), scripts = join(fixture, app === 'CoreMind' ? 'bin' : 'tools');
      mkdirSync(scripts, { recursive: true });
      const source = app === 'CoreMind' ? 'CoreMind/bin/build-platforms.sh' : `${app}/tools/build-platforms.sh`;
      const script = join(scripts, 'build-platforms.sh'); copyFileSync(join(root, source), script);
      const tools = join(fixture, 'tools'); mkdirSync(tools, { recursive: true });
      if (app !== 'CoreMind') copyFileSync(join(root, app, 'tools', 'machine-env.sh'), join(tools, 'machine-env.sh'));
      writeFileSync(join(tools, 'heavy-lock.sh'), 'heavy_lock() { echo "unexpected build" >&2; return 1; }\nheavy_unlock() { :; }\n');
      const args = app === 'CoreMind' ? [script, 'CalMind', '--mac'] : [script, '--mac'];
      const result = spawnSync('sh', args, { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_UNAME_ARCH: 'x86_64', CARGO_BUILD_TARGET: '' } });
      assert.notEqual(result.status, 0, `${app} accepted an Intel Mac build`);
      assert.match(result.stderr, /Apple Silicon/, `${app} did not explain the refusal: ${result.stderr}`);
      assert.doesNotMatch(result.stderr, /unexpected build/, `${app} started a build`);
      const cross = spawnSync('sh', args, { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_UNAME_ARCH: 'arm64', CARGO_BUILD_TARGET: 'x86_64-apple-darwin' } });
      assert.notEqual(cross.status, 0, `${app} accepted an Intel cross-target`);
      assert.match(cross.stderr, /Apple Silicon/, `${app} did not explain the cross-target refusal: ${cross.stderr}`);
      assert.doesNotMatch(cross.stderr, /unexpected build/, `${app} started a cross-build`);
      const native = spawnSync('sh', args, { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_UNAME_ARCH: 'arm64', CARGO_BUILD_TARGET: 'aarch64-apple-darwin' } });
      assert.doesNotMatch(native.stderr, /Apple Silicon/, `${app} rejected Apple Silicon`);
      if (app !== 'CoreMind') {
        const ios = spawnSync('sh', [script, '--ios', '--dry-run'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
        assert.equal(ios.status, 0, `${app} blocked an iOS-only plan: ${ios.stderr}`);
      }
      if (app === 'PlanMind' || app === 'TaskMind') {
        const windows = spawnSync('sh', [script, '--windows', '--dry-run'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_UNAME_ARCH: 'x86_64' } });
        assert.equal(windows.status, 0, `${app} blocked a Windows plan: ${windows.stderr}`);
      }
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
