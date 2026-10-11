import { describe, expect, it } from 'vitest';
import {
  ClassifyRequestSchema,
  compareHlc,
  costMicros,
  formatHlc,
  parseHlc,
  platformOfKey,
  tickHlc,
  toPostRef,
  uuidv7,
} from '../src/index.ts';

describe('post refs', () => {
  it('hashes post keys so servers never see platform ids', async () => {
    const ref = await toPostRef('li:urn:li:activity:7001');
    expect(ref).toMatch(/^pk_[A-Za-z0-9_-]{43}$/);
    expect(ref).not.toContain('7001');
    expect(await toPostRef('li:urn:li:activity:7001')).toBe(ref);
  });

  it('finds the platform of a key', () => {
    expect(platformOfKey('fb:123')).toBe('facebook');
    expect(platformOfKey('li:ck:abc')).toBe('linkedin');
    expect(platformOfKey('xx:1')).toBeUndefined();
  });
});

describe('hybrid logical clock', () => {
  it('orders stamps by time, then counter, as plain strings', () => {
    const a = tickHlc(undefined, 'devA', 1000);
    const b = tickHlc(a, 'devA', 1000);
    const c = tickHlc(b, 'devA', 999); // clock went backwards: still increases
    expect(compareHlc(a, b)).toBe(-1);
    expect(compareHlc(b, c)).toBe(-1);
    expect(parseHlc(c)).toEqual({ ms: 1000, counter: 2, device: 'devA' });
    expect(formatHlc(parseHlc(c))).toBe(c);
  });
});

describe('uuidv7', () => {
  it('is time ordered', () => {
    expect(uuidv7(1000) < uuidv7(2000)).toBe(true);
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('cost', () => {
  it('prices Haiku 5.5 classification at well under a cent per batch', () => {
    const micros = costMicros('claude-haiku-5-5', {
      uncachedInput: 2400,
      cacheRead: 1500,
      cacheWrite: 0,
      output: 360,
      webSearches: 0,
      estimated: false,
    });
    expect(micros).toBe(435);
    expect(
      costMicros('unknown-model', { uncachedInput: 1, cacheRead: 0, cacheWrite: 0, output: 0, webSearches: 0, estimated: false }),
    ).toBeUndefined();
  });
});

describe('contracts', () => {
  it('rejects author names smuggled into a classify request', () => {
    const base = {
      v: 1,
      profile: { v: 1, interests: [], lessOf: [], about: '', examples: [] },
      profileHash: 'x',
      locale: 'en',
    };
    const post = {
      ref: 'p1',
      platform: 'linkedin',
      text: 'hi',
      textComplete: true,
      authorKind: 'person',
      isReshare: false,
      media: 'none',
    };
    expect(ClassifyRequestSchema.safeParse({ ...base, posts: [post] }).success).toBe(true);
    const parsed = ClassifyRequestSchema.parse({ ...base, posts: [{ ...post, authorName: 'Jane Doe' }] });
    expect(JSON.stringify(parsed)).not.toContain('Jane Doe');
  });
});
