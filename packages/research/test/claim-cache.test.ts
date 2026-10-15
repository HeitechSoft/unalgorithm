import { createHmac } from 'node:crypto';
import { CLAIM_CACHE_TTL_MS, type FactcheckClaim, type FactcheckSource, type PostForAI } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import {
  type CachedClaim,
  cacheEntryFor,
  hmacClaimKeyer,
  memoryClaimCache,
  normalizeClaim,
  replayCached,
} from '../src/claim-cache.ts';

const SECRET = new Uint8Array(32).fill(7);
const OTHER = new Uint8Array(32).fill(9);

const POST: PostForAI = {
  ref: 'p1',
  platform: 'linkedin',
  text: 'Big news today: the city council finally approved the new harbour bridge budget.',
  textComplete: true,
  authorKind: 'person',
  isReshare: false,
  media: 'none',
  link: { domain: 'example.net', title: 'Harbour bridge budget approved after a long night of debate' },
};

const src = (id: string, domain: string, title = `Title ${id}`): FactcheckSource => ({
  id,
  url: `https://${domain}/${id}`,
  domain,
  title,
  pageAge: '2 days',
});
const SOURCES = [src('s1', 'www.example.com'), src('s2', 'news.other.org'), src('s3', 'third.net')];

const CLAIM: FactcheckClaim = {
  id: 'c1',
  claim: 'The council approved the bridge budget.',
  verdict: 'supported',
  explanation: 'Two outlets report the approval.',
  citations: [
    { sourceId: 's1', quote: 'the council voted to approve the budget' },
    { sourceId: 's2', quote: 'approval came late on Tuesday' },
  ],
};
const AT = '2026-10-15T12:34:56.789Z';

describe('keys', () => {
  it('test_claim_key_normalized_hmac_hex', async () => {
    const key = hmacClaimKeyer(SECRET);
    const a = await key('The bridge opened in 1932.');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await key('  the BRIDGE opened in 1932 ')).toBe(a);
    expect(normalizeClaim('  the BRIDGE opened in 1932 ')).toBe('the bridge opened in 1932');
    const node = createHmac('sha256', SECRET)
      .update(`factcheck-claim/v2\n${normalizeClaim('The bridge opened in 1932.')}`)
      .digest('hex');
    expect(a).toBe(node);
    expect(await hmacClaimKeyer(OTHER)('The bridge opened in 1932.')).not.toBe(a);
    for (const word of ['bridge', 'opened', '1932', 'the']) expect(a).not.toContain(word);

    const pairs: [string, string][] = [
      ['Temperatures fell to -5 °C.', 'Temperatures fell to 5 °C.'],
      ['It cost $5 million.', 'It cost €5 million.'],
      ['Prices rose 5%.', 'Prices rose 5.'],
    ];
    for (const [x, y] of pairs) expect(await key(x), `${x} / ${y}`).not.toBe(await key(y));
  });

  it('test_claim_keyer_rejects_short_secret', () => {
    expect(() => hmacClaimKeyer(new Uint8Array(16))).toThrow(TypeError);
  });
});

describe('entries', () => {
  it('test_entry_keeps_only_verdict_citations_and_time', () => {
    const entry = cacheEntryFor(CLAIM, SOURCES, POST, AT);
    expect(entry).not.toBeNull();
    expect(Object.keys(entry ?? {}).sort()).toEqual(['checkedAt', 'citations', 'v', 'verdict']);
    for (const c of entry?.citations ?? []) expect(Object.keys(c).sort()).toEqual(['domain', 'quote', 'title', 'url']);
    expect(entry).toEqual({
      v: 1,
      verdict: 'supported',
      checkedAt: '2026-10-15T12:00:00.000Z',
      citations: [
        { url: 'https://www.example.com/s1', domain: 'www.example.com', title: 'Title s1', quote: CLAIM.citations[0]?.quote },
        { url: 'https://news.other.org/s2', domain: 'news.other.org', title: 'Title s2', quote: CLAIM.citations[1]?.quote },
      ],
    });
    const json = JSON.stringify(entry);
    expect(json).not.toContain(CLAIM.claim);
    expect(json).not.toContain(CLAIM.explanation);
    expect(json).not.toContain(POST.text);
    expect(json).not.toContain('2 days');
  });

  it('test_entry_skips_unverifiable_and_downgraded', () => {
    expect(cacheEntryFor({ ...CLAIM, verdict: 'unverifiable' }, SOURCES, POST, AT)).toBeNull();
    expect(cacheEntryFor({ ...CLAIM, downgraded: 'too-few-domains' }, SOURCES, POST, AT)).toBeNull();
  });

  it('test_entry_drops_post_echo_and_platform_sources', () => {
    const third = { sourceId: 's3', quote: 'a third independent report' };
    // Six consecutive words of the post text.
    const echo = cacheEntryFor(
      {
        ...CLAIM,
        citations: [...CLAIM.citations, { sourceId: 's3', quote: 'He said the city council finally approved the new plan' }],
      },
      SOURCES,
      POST,
      AT,
    );
    expect(echo?.citations.map((c) => c.domain)).toEqual(['www.example.com', 'news.other.org']);
    // Five consecutive words are kept.
    const five = cacheEntryFor(
      { ...CLAIM, citations: [...CLAIM.citations, { sourceId: 's3', quote: 'the city council finally approved a plan' }] },
      SOURCES,
      POST,
      AT,
    );
    expect(five?.citations).toHaveLength(3);
    // A title repeating six words of the link title.
    const titled = [...SOURCES.slice(0, 2), src('s3', 'third.net', 'Report: harbour bridge budget approved after a long wait')];
    const title = cacheEntryFor({ ...CLAIM, citations: [...CLAIM.citations, third] }, titled, POST, AT);
    expect(title?.citations.map((c) => c.domain)).toEqual(['www.example.com', 'news.other.org']);
    // A short post quoted whole.
    const short = { ...POST, text: 'Bridge-opening was 1932', link: undefined };
    const whole = cacheEntryFor(
      { ...CLAIM, citations: [...CLAIM.citations, { sourceId: 's3', quote: 'they said bridge opening was 1932 indeed' }] },
      SOURCES,
      short,
      AT,
    );
    expect(whole?.citations).toHaveLength(2);
    // Platforms are never kept, whatever the quote.
    const platforms = [src('s1', 'www.example.com'), src('s2', 'www.facebook.com'), src('s3', 'linkedin.com')];
    const onPlatform = cacheEntryFor(
      {
        ...CLAIM,
        citations: [CLAIM.citations[0] as FactcheckClaim['citations'][number], { sourceId: 's2', quote: 'x y' }, third],
      },
      platforms,
      POST,
      AT,
    );
    expect(onPlatform).toBeNull();
    // Dropping leaves one domain: null.
    const one = cacheEntryFor(
      {
        ...CLAIM,
        citations: [
          CLAIM.citations[0] as FactcheckClaim['citations'][number],
          { sourceId: 's2', quote: 'the city council finally approved the new harbour bridge' },
        ],
      },
      SOURCES,
      POST,
      AT,
    );
    expect(one).toBeNull();
  });

  it('test_entry_drops_post_echo_in_unspaced_scripts', () => {
    // Chinese, Japanese and Thai put no spaces between words: a whole sentence must not count as one word.
    const posts = [
      { text: '據報導大橋於1932年開通市長說這是偉大的成就', echo: '新聞稿指出據報導大橋於1932年開通市長說這是偉大的成就' },
      { text: '橋は1932年に開通したと市長が述べた', echo: '報道によると橋は1932年に開通したと市長が述べた' },
      {
        text: 'สะพานเปิดในปี1932นายกเทศมนตรีกล่าวว่าเป็นความสำเร็จที่ยิ่งใหญ่',
        echo: 'รายงานว่าสะพานเปิดในปี1932นายกเทศมนตรีกล่าวว่าเป็นความสำเร็จที่ยิ่งใหญ่',
      },
    ];
    for (const { text, echo } of posts) {
      const post = { ...POST, text, link: undefined };
      const entry = cacheEntryFor(
        { ...CLAIM, citations: [...CLAIM.citations, { sourceId: 's3', quote: echo }] },
        SOURCES,
        post,
        AT,
      );
      expect(
        entry?.citations.map((c) => c.quote),
        text,
      ).toEqual(CLAIM.citations.map((c) => c.quote));
      const titled = [...SOURCES.slice(0, 2), src('s3', 'third.net', echo)];
      const byTitle = cacheEntryFor(
        { ...CLAIM, citations: [...CLAIM.citations, { sourceId: 's3', quote: 'a third independent report' }] },
        titled,
        post,
        AT,
      );
      expect(byTitle?.citations, text).toHaveLength(2);
    }
    // A shared word or two is not an echo.
    const kept = cacheEntryFor(
      { ...CLAIM, citations: [...CLAIM.citations, { sourceId: 's3', quote: '大橋全長兩公里' }] },
      SOURCES,
      { ...POST, text: posts[0]?.text ?? '', link: undefined },
      AT,
    );
    expect(kept?.citations).toHaveLength(3);
  });
});

const ENTRY: CachedClaim = {
  v: 1,
  verdict: 'disputed',
  checkedAt: '2026-10-15T10:00:00.000Z',
  citations: [
    { url: 'https://a.com/1', domain: 'a.com', title: 'A', quote: 'q a' },
    { url: 'https://b.org/1', domain: 'news.b.org', title: 'B', quote: 'q b' },
    { url: 'https://c.net/1', domain: 'c.net', title: 'C', quote: 'q c' },
  ],
};
const NOW = Date.parse('2026-10-15T12:00:00.000Z');

describe('replay', () => {
  it('test_replay_rejects_malformed_blocked_dead_and_expired', () => {
    expect(replayCached(ENTRY, { blocked: [], now: NOW })).toEqual(ENTRY);
    expect(replayCached({ ...ENTRY, claim: 'x' }, { blocked: [], now: NOW })).toBeNull();
    expect(replayCached({ ...ENTRY, verdict: 'unverifiable' }, { blocked: [], now: NOW })).toBeNull();
    expect(replayCached('nope', { blocked: [], now: NOW })).toBeNull();
    // One blocked domain leaves two.
    expect(replayCached(ENTRY, { blocked: ['b.org'], now: NOW })).toEqual({
      ...ENTRY,
      citations: [ENTRY.citations[0], ENTRY.citations[2]],
    });
    const two = { ...ENTRY, citations: ENTRY.citations.slice(0, 2) };
    expect(replayCached(two, { blocked: ['b.org'], now: NOW })).toBeNull();
    expect(replayCached(two, { blocked: [], deadUrls: new Set(['https://a.com/1']), now: NOW })).toBeNull();
    const at = Date.parse(ENTRY.checkedAt);
    expect(replayCached(ENTRY, { blocked: [], now: at + CLAIM_CACHE_TTL_MS - 1 })).toEqual(ENTRY);
    expect(replayCached(ENTRY, { blocked: [], now: at + CLAIM_CACHE_TTL_MS })).toBeNull();
    expect(replayCached(ENTRY, { blocked: [], now: at - 1 })).toBeNull();
  });
});

describe('memory store', () => {
  it('test_memory_cache_round_trip_not_found_and_expiry', async () => {
    let now = NOW;
    const cache = memoryClaimCache({ secret: SECRET, now: () => now });
    const k = await cache.key('The bridge opened in 1932.');
    expect(k).toBe(await hmacClaimKeyer(SECRET)('the bridge opened in 1932'));
    expect((await cache.get([k])).size).toBe(0);
    const second = { ...ENTRY, verdict: 'supported' as const };
    await cache.put([
      { key: k, entry: ENTRY },
      { key: k, entry: second },
    ]);
    expect((await cache.get([k, 'other'])).get(k)).toEqual(ENTRY);
    expect((await cache.get(['other'])).size).toBe(0);
    // An unexpired entry is kept, not replaced.
    await cache.put([{ key: k, entry: second }]);
    expect((await cache.get([k])).get(k)).toEqual(ENTRY);
    now = Date.parse(ENTRY.checkedAt) + CLAIM_CACHE_TTL_MS;
    expect((await cache.get([k])).size).toBe(0);
  });
});
