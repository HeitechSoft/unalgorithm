/** base64url without padding. */
export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Opaque reference for a post when it leaves the device: `pk_` + base64url(sha256(postKey)).
 * Servers can de-duplicate and cache by it without learning the platform id.
 */
export async function toPostRef(postKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(postKey));
  return `pk_${b64url(new Uint8Array(digest))}`;
}

/** Random UUID v4 (device ids). */
export function uuid(): string {
  return crypto.randomUUID();
}

/** Time-ordered UUID v7 for ids created on a client (list entries, feedback events). */
export function uuidv7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let ts = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts & 0xff;
    ts = Math.floor(ts / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
