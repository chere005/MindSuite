/**
 * The desktop window's CSP has to allow the server the bundle calls (#80).
 *
 * `EXPO_PUBLIC_API_URL` makes the API a build-time setting, and the desktop
 * build (desktop/tauri-build.mjs) adds that URL's origin to connect-src. These
 * pin the merge, and the one pairing nothing else checks: the DEFAULT server
 * in config.ts must already be allowed by the committed tauri.conf.json, or the
 * desktop app fails every request as "Load failed" while the phone works.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiOrigin, buildApiUrl, connectCsp } from '../../../desktop/tauri-build.mjs';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const conf = JSON.parse(read('../../../desktop/src-tauri/tauri.conf.json'));
const BASE = conf.app.security.csp;

describe('the desktop CSP follows the build-time API', () => {
  it('unset or blank means the committed CSP, untouched', () => {
    expect(apiOrigin(undefined)).toBeNull();
    expect(apiOrigin('  ')).toBeNull();
    expect(connectCsp(BASE, null)).toBe(BASE);
  });

  it('a URL contributes its ORIGIN, not its path', () => {
    expect(apiOrigin('https://test.seancheren.com/calmind/api/index.php')).toBe('https://test.seancheren.com');
    expect(apiOrigin('http://127.0.0.1:8788/api/index.php')).toBe('http://127.0.0.1:8788');
  });

  it('refuses something that is not an http(s) URL rather than guessing', () => {
    expect(() => apiOrigin('seancheren.com/calmind')).toThrow(/not a URL/);
    expect(() => apiOrigin('ftp://example.com/api')).toThrow(/http/);
  });

  it('adds the origin to connect-src and leaves every other directive alone', () => {
    const out = connectCsp(BASE, 'https://test.seancheren.com');
    expect(out).toContain("connect-src 'self' https://seancheren.com https://test.seancheren.com");
    const others = (csp) => csp.split(';').map((p) => p.trim()).filter((p) => !p.startsWith('connect-src'));
    expect(others(out)).toEqual(others(BASE));
  });

  it('is idempotent, and adds the directive if a CSP has none', () => {
    const once = connectCsp(BASE, 'https://test.seancheren.com');
    expect(connectCsp(once, 'https://test.seancheren.com')).toBe(once);
    expect(connectCsp("default-src 'self'", 'https://x.example')).toBe("default-src 'self'; connect-src 'self' https://x.example");
  });

  it('reads the value the export reads: the environment, then .env.local, then .env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'calmind-env-'));
    expect(buildApiUrl({}, dir), 'no env, no files').toBe('');
    writeFileSync(join(dir, '.env'), 'EXPO_PUBLIC_API_URL=https://from-env-file.example/api\n');
    expect(buildApiUrl({}, dir)).toBe('https://from-env-file.example/api');
    writeFileSync(join(dir, '.env.local'), '# local\nEXPO_PUBLIC_API_URL="https://from-local.example/api"\n');
    expect(buildApiUrl({}, dir), '.env.local beats .env, quotes stripped').toBe('https://from-local.example/api');
    expect(buildApiUrl({ EXPO_PUBLIC_API_URL: 'https://from-shell.example/api' }, dir), 'the shell beats both')
      .toBe('https://from-shell.example/api');
  });

  it("config.ts's default server is already allowed by the committed CSP", () => {
    const m = /const PROD_API = '([^']+)'/.exec(read('../src/config.ts'));
    expect(m, 'PROD_API not found in config.ts — this check is not running').not.toBeNull();
    expect(connectCsp(BASE, apiOrigin(m[1])), 'tauri.conf.json connect-src lacks the default API').toBe(BASE);
  });
});
