/**
 * Ed25519 signing and verification of the registry with the review panel's key. Node only: never imported by
 * `src/index.ts`, which the extension bundles.
 */
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { Registry } from './schema.ts';

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sorted(v)]));
  }
  return value;
}

/** `JSON.stringify` with object keys sorted at every level and no whitespace: the bytes the panel signs. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sorted(value));
}

/** Base64 Ed25519 signature of the registry's canonical form. Throws on a key that is not an Ed25519 private key. */
export function signRegistry(reg: Registry, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The panel key must be an Ed25519 private key.');
  return sign(null, Buffer.from(canonicalJson(reg)), key).toString('base64');
}

/** True only when the signature verifies with the panel public key; false (never throws) on a malformed key or signature. */
export function verifyRegistry(reg: Registry, signatureB64: string, publicKeyPem: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    const sig = Buffer.from(signatureB64.trim(), 'base64');
    if (sig.length !== 64) return false;
    return verify(null, Buffer.from(canonicalJson(reg)), key, sig);
  } catch {
    return false;
  }
}
