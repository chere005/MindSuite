import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { asciiBytes, pkceChallenge, pkceVerifierOk, sha256 } from '../src/pkce';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const text = (s: string) => new TextEncoder().encode(s);

describe('sha256 (FIPS 180-4, pure TS)', () => {
  it('matches the published vectors', () => {
    expect(hex(sha256(new Uint8Array(0)))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hex(sha256(text('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    // 56 bytes: the padding spills into a second block.
    expect(hex(sha256(text('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });
  it('agrees with node:crypto for every length from 0 to 200', () => {
    for (let n = 0; n <= 200; n++) {
      const data = new Uint8Array(randomBytes(n));
      expect(hex(sha256(data)), `length ${n}`).toBe(createHash('sha256').update(data).digest('hex'));
    }
  });
});

describe('PKCE S256', () => {
  it('reproduces the RFC 7636 appendix B pair', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  it('asciiBytes refuses anything above 0x7f', () => {
    expect(Array.from(asciiBytes('aZ'))).toEqual([97, 90]);
    expect(() => asciiBytes('café')).toThrow();
  });
  it('pkceVerifierOk takes 43 to 128 unreserved characters only', () => {
    expect(pkceVerifierOk('a'.repeat(42))).toBe(false);
    expect(pkceVerifierOk('a'.repeat(43))).toBe(true);
    expect(pkceVerifierOk('a'.repeat(128))).toBe(true);
    expect(pkceVerifierOk('a'.repeat(129))).toBe(false);
    for (const bad of ['+', '/', '=', ' ']) expect(pkceVerifierOk('a'.repeat(42) + bad)).toBe(false);
    expect(pkceVerifierOk('A._~-' + 'b'.repeat(40))).toBe(true);
  });
});
