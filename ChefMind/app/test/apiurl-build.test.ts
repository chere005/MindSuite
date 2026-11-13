// #166: EXPO_PUBLIC_API_URL must reach the bundle (Metro cache key) and the
// desktop CSP (connect-src).
import { describe, expect, test } from 'vitest';
import { publicEnvCacheVersion } from '../metro-cache.js';
import { connectOrigin, cspFor, tauriConfigOverride, configuredApiUrl } from '../../desktop/csp.mjs';
import { readFileSync } from 'node:fs';

const conf = JSON.parse(readFileSync(new URL('../../desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const CSP: string = conf.app.security.csp;

describe('Metro cache key', () => {
  test('unset env keeps the base version', () => {
    expect(publicEnvCacheVersion({ PATH: '/bin' }, '1.0')).toBe('1.0');
  });
  test('changing EXPO_PUBLIC_API_URL changes the key; the same value does not', () => {
    const a = publicEnvCacheVersion({ EXPO_PUBLIC_API_URL: 'https://a.example/api' });
    const b = publicEnvCacheVersion({ EXPO_PUBLIC_API_URL: 'https://b.example/api' });
    expect(a).not.toBe(b);
    expect(a).not.toBe('1.0');
    expect(publicEnvCacheVersion({ EXPO_PUBLIC_API_URL: 'https://a.example/api', OTHER: 'x' })).toBe(a);
  });
});

describe('desktop CSP follows the configured API', () => {
  test('default stays seancheren.com', () => {
    expect(connectOrigin(undefined)).toBe('https://seancheren.com');
    expect(connectOrigin('  ')).toBe('https://seancheren.com');
    expect(tauriConfigOverride(undefined, conf)).toBeNull();
    expect(CSP).toContain("connect-src 'self' https://seancheren.com;");
  });
  test('a configured URL replaces only the connect-src origin', () => {
    const out = cspFor(CSP, 'https://test.seancheren.com/calmind/api/index.php');
    expect(out).toContain("connect-src 'self' https://test.seancheren.com;");
    expect(out).not.toContain('https://seancheren.com');
    expect(out.replace('https://test.seancheren.com', 'https://seancheren.com')).toBe(CSP);
    expect(cspFor(CSP, 'http://127.0.0.1:8788/api/index.php')).toContain("connect-src 'self' http://127.0.0.1:8788;");
    const o = tauriConfigOverride('https://x.example:8443/api', conf);
    expect(o!.app.security.csp).toContain('https://x.example:8443;');
  });
  test('garbage fails loudly', () => {
    expect(() => connectOrigin('not a url')).toThrow();
    expect(() => connectOrigin('ftp://x.example/')).toThrow();
  });
  test('env is read from the environment first, then app/.env.local', () => {
    expect(configuredApiUrl({ EXPO_PUBLIC_API_URL: 'https://e.example/api' } as unknown as NodeJS.ProcessEnv)).toBe('https://e.example/api');
    expect(configuredApiUrl({} as unknown as NodeJS.ProcessEnv, '/nonexistent')).toBeUndefined();
  });
});
