import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { geckoRedirectUri, sha1Hex } from '../src/index.ts';

/** node:crypto over the same UTF-8 bytes Firefox hashes (TextEncoder, so a lone surrogate becomes U+FFFD). */
function reference(text: string): string {
  return createHash('sha1').update(new TextEncoder().encode(text)).digest('hex');
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Deterministic text over ASCII, Latin, CJK and astral characters, so failures can be replayed. */
function randomText(seed: number, length: number): string {
  let state = seed;
  const next = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state;
  };
  const ranges: [number, number][] = [
    [0x20, 0x7e],
    [0xa0, 0x24f],
    [0x4e00, 0x9fff],
    [0x1f300, 0x1faff],
  ];
  let text = '';
  for (let i = 0; i < length; i++) {
    const [lo, hi] = ranges[next() % ranges.length] ?? [0x61, 0x7a];
    text += String.fromCodePoint(lo + (next() % (hi - lo + 1)));
  }
  return text;
}

describe('sha1Hex', () => {
  it('test_sha1_known_vectors', () => {
    // FIPS 180 examples, the last one spanning two blocks.
    expect(sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(sha1Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('84983e441c3bd26ebaae4aa1f95129e5e54670f1');
    expect(sha1Hex('a'.repeat(1_000_000))).toBe('34aa973cd4c4daa4f61eeb2bdbad27316534016f');
  });

  it('test_sha1_firefox_redirect_vector', () => {
    // Firefox's own identity test: getRedirectURL() for this add-on id.
    expect(sha1Hex('identity@mozilla.org')).toBe('35b64b676900f491c00e7f618d43f7040e88422e');
    expect(geckoRedirectUri('identity@mozilla.org')).toBe(
      'https://35b64b676900f491c00e7f618d43f7040e88422e.extensions.allizom.org/',
    );
  });

  it('test_sha1_matches_node_at_padding_edges', () => {
    // 55 bytes is the most that fits one block with its padding; 56 to 63 need a second; 64 fills one exactly.
    for (const length of [0, 1, 54, 55, 56, 57, 62, 63, 64, 65, 66, 118, 119, 120, 127, 128, 129, 191, 192, 193]) {
      const text = 'x'.repeat(length);
      expect(sha1Hex(text), `${length} bytes`).toBe(reference(text));
    }
    for (let length = 0; length <= 300; length++) {
      const text = String.fromCharCode(...Array.from({ length }, (_, i) => 0x21 + ((i * 7) % 94)));
      expect(sha1Hex(text), `${length} bytes`).toBe(reference(text));
    }
  });

  it('test_sha1_hashes_utf8_bytes', () => {
    const texts = [
      'ü@é',
      'ä'.repeat(28), // 56 bytes
      `${'x'.repeat(54)}é`, // 56 bytes, the last character split across the edge
      `${'x'.repeat(62)}€`, // 65 bytes
      `${'x'.repeat(60)}😀`, // 64 bytes, one astral character
      '日本語のアドオン@example.com',
      'a\u0000b',
      '\ud800', // lone surrogate: hashed as U+FFFD, as TextEncoder gives it
      '{12345678-1234-1234-1234-123456789abc}',
      'feed@unalgorithmfeed.com',
      'FEED@UNALGORITHMFEED.COM',
    ];
    for (const text of texts) expect(sha1Hex(text), JSON.stringify(text)).toBe(reference(text));
    expect(utf8Length(texts[1] ?? '')).toBe(56);
    expect(utf8Length(texts[2] ?? '')).toBe(56);
    expect(utf8Length(texts[3] ?? '')).toBe(65);
    expect(utf8Length(texts[4] ?? '')).toBe(64);
  });

  it('test_sha1_matches_node_on_random_text', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const text = randomText(seed, seed % 90);
      expect(sha1Hex(text), JSON.stringify(text)).toBe(reference(text));
    }
  });

  it('test_sha1_is_40_lowercase_hex', () => {
    for (const text of ['', 'a', 'feed-dev@unalgorithmfeed.com', randomText(7, 70)]) {
      expect(sha1Hex(text)).toMatch(/^[0-9a-f]{40}$/);
    }
    // Leading zero bytes keep their digits.
    const zeroLed = Array.from({ length: 2000 }, (_, i) => `id${i}@example.com`).find((id) => reference(id).startsWith('00'));
    expect(zeroLed).toBeDefined();
    expect(sha1Hex(zeroLed ?? '')).toBe(reference(zeroLed ?? ''));
  });
});
