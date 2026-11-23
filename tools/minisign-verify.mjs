// Verify a Tauri update signature the way the app's updater does (minisign: Ed25519 over the file, or over its BLAKE2b-512
// hash for the prehashed "ED" form `tauri signer sign` writes; then the global signature over the trusted comment), with
// Node's own crypto: no dependency, nothing to build. tools/publish-update.mjs uses it to prove that what it just signed is
// accepted by the public key an installed copy trusts (plugins.updater.pubkey).
//
//   verifySignature({ pubkey, data, signature, version? })  -> { ok: true, trustedComment } or { ok: false, why }
//
// `pubkey` and `signature` are exactly what tauri.conf.json and latest.json carry: the base64 of a minisign text file.
// tools/test-publish-update.mjs checks this module against the Rust verifier that the updater harness builds
// (tools/updater-harness/examples/verify_sig.rs), so the two cannot drift apart unnoticed.
import { createHash, createPublicKey, verify } from 'node:crypto';

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');   // DER prefix of a raw 32-byte Ed25519 public key

const b64 = (s) => Buffer.from(String(s).trim(), 'base64');
const lines = (buf) => buf.toString('utf8').split(/\r?\n/);

/** A minisign public key out of the base64 text-file form: { keyId (8 bytes), key (32 bytes) }; throws on anything else. */
export function parsePublicKey(pubkey) {
  const l = lines(b64(pubkey));
  const raw = b64(l.find((x) => x && !x.startsWith('untrusted comment:')) || '');
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== 'Ed') throw new Error('not a minisign public key');
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10, 42) };
}

const edKey = (raw) => createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' });

export function verifySignature({ pubkey, data, signature, version }) {
  let pk;
  try { pk = parsePublicKey(pubkey); } catch (e) { return { ok: false, why: e.message }; }
  const l = lines(b64(signature));
  const sigLine = l[1];
  const tcLine = l[2] || '';
  const globalLine = l[3];
  if (!sigLine || !tcLine.startsWith('trusted comment: ') || !globalLine) return { ok: false, why: 'not a minisign signature' };
  const sig = b64(sigLine);
  const global = b64(globalLine);
  if (sig.length !== 74 || global.length !== 64) return { ok: false, why: 'not a minisign signature' };
  const alg = sig.subarray(0, 2).toString();
  if (alg !== 'Ed' && alg !== 'ED') return { ok: false, why: `unknown signature algorithm ${alg}` };
  if (!sig.subarray(2, 10).equals(pk.keyId)) return { ok: false, why: 'the signature was made by another key (key id differs)' };
  const key = edKey(pk.key);
  const message = alg === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  if (!verify(null, message, key, sig.subarray(10))) return { ok: false, why: 'the signature does not verify against the public key' };
  const trustedComment = tcLine.slice('trusted comment: '.length);
  if (!verify(null, Buffer.concat([sig.subarray(10), Buffer.from(trustedComment, 'utf8')]), key, global)) return { ok: false, why: 'the trusted comment is not covered by the signature' };
  if (version !== undefined && !trustedComment.split('\t').includes(`version:${version}`)) return { ok: false, why: `the trusted comment carries no version:${version}` };
  return { ok: true, trustedComment };
}
