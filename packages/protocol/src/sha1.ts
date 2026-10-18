/**
 * SHA-1 of the UTF-8 bytes of `text`, as 40 lowercase hex characters (FIPS 180-4).
 *
 * Only here to reproduce the host Firefox puts in `identity.getRedirectURL()` (`geckoRedirectUri`), never for
 * security. Synchronous and plain TypeScript because the authorize request is checked with a synchronous zod refine
 * on the web page, in the extension and on the server, and WebCrypto's digest is async only.
 */
export function sha1Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  // The message, a 1 bit, zeros, then its length in bits as 64 bits: a whole number of 64-byte blocks.
  const message = new DataView(new ArrayBuffer(Math.ceil((bytes.length + 9) / 64) * 64));
  new Uint8Array(message.buffer).set(bytes);
  message.setUint8(bytes.length, 0x80);
  const bits = bytes.length * 8;
  message.setUint32(message.byteLength - 8, Math.floor(bits / 2 ** 32));
  message.setUint32(message.byteLength - 4, bits >>> 0);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let block = 0; block < message.byteLength; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = message.getUint32(block + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(word(w, i - 3) ^ word(w, i - 8) ^ word(w, i - 14) ^ word(w, i - 16), 1);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (rotl(a, 5) + f + e + k + word(w, i)) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, '0')).join('');
}

/** 32-bit left rotation, as an unsigned number. */
function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

/** `w[i]` for an index inside the 80-word schedule, which always holds a word. */
function word(w: Uint32Array, i: number): number {
  return w[i] ?? 0;
}
