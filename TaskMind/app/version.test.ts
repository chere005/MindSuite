import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A release is one version in four places; dtp tags package.json's, so the native shell must say the same.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const json = (path: string) => JSON.parse(read(path)) as { version: string };

describe('the version', () => {
  it('is the same in the app and in every native manifest', () => {
    const version = json('package.json').version;
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(json('native/package.json').version).toBe(version);
    expect(json('native/src-tauri/tauri.conf.json').version).toBe(version);
    expect(/^version = "([^"]+)"$/m.exec(read('native/src-tauri/Cargo.toml'))?.[1]).toBe(version);
    expect(new RegExp(`name = "taskmind"\\nversion = "${version.replaceAll('.', '\\.')}"`).test(read('native/src-tauri/Cargo.lock'))).toBe(true);
  });
  it('gives the native shell the app\'s identifier and no IPC capability', () => {
    const conf = json('native/src-tauri/tauri.conf.json') as unknown as { identifier: string; app: { security: { capabilities: unknown[] } } };
    expect(conf.identifier).toBe('com.seancheren.taskmind');
    expect(conf.app.security.capabilities).toEqual([]);
  });
});
