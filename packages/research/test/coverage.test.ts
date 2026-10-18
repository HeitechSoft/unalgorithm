import { type AIClient, AIError, type ResearchRequest } from '@unalgorithm/ai';
import type { SourceList } from '@unalgorithm/outlets';
import { FIXTURE_LIST } from '@unalgorithm/outlets/testing';
import { LEAN_BUCKETS, type LeanBucket, type NormalizedUsage, ZERO_USAGE } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import {
  aiBucketSearcher,
  type BucketHit,
  type BucketSearcher,
  type BucketSearchRequest,
  publishedAt,
  searchBuckets,
} from '../src/coverage.ts';
import { BUCKET_SEARCH_SYSTEM, buildBucketSearchUser } from '../src/perspectives-prompts.ts';

const FROM = new Date('2026-10-12T00:00:00Z');
const TO = new Date('2026-10-15T12:00:00Z');
const NOW = new Date('2026-10-15T12:00:00Z');
const MODEL = 'fake-model';

/** The bucket a fixture search was for, read from its domains (`left-a.example` → `left`). */
const bucketOf = (req: BucketSearchRequest): LeanBucket => (req.domains[0] ?? '').replace(/-a\.example$/, '') as LeanBucket;

const hit = (url: string, over: Partial<BucketHit> = {}): BucketHit => ({
  url,
  title: 'A headline',
  snippets: ['The council approved the bridge on Monday.'],
  published: '2026-10-14T09:00:00Z',
  ...over,
});

const usage = (input: number): NormalizedUsage => ({ ...ZERO_USAGE, uncachedInput: input });

/** A fake searcher answering per bucket, recording every request. */
function fake(
  answer: (bucket: LeanBucket, req: BucketSearchRequest) => BucketHit[] | Error = () => [],
): BucketSearcher & { calls: BucketSearchRequest[] } {
  const calls: BucketSearchRequest[] = [];
  return {
    model: MODEL,
    calls,
    async search(req) {
      calls.push(req);
      const res = answer(bucketOf(req), req);
      if (res instanceof Error) throw res;
      return { hits: res, usage: usage(100), model: MODEL };
    },
  };
}

const run = (searcher: BucketSearcher, over: Partial<Parameters<typeof searchBuckets>[0]> = {}) =>
  searchBuckets({
    query: 'bridge vote',
    from: FROM,
    to: TO,
    registry: FIXTURE_LIST,
    searcher,
    nonce: 'n0nce',
    now: NOW,
    ...over,
  });

describe('searchBuckets: spread and filters', () => {
  it('test_search_buckets_one_call_per_bucket', async () => {
    const searcher = fake();
    const res = await run(searcher);
    expect(searcher.calls).toHaveLength(5);
    expect(searcher.calls.map((c) => [...c.domains]).sort()).toEqual(
      LEAN_BUCKETS.map((b) => [`${b}-a.example`, `${b}-b.example`]).sort(),
    );
    for (const c of searcher.calls) {
      expect(c).toMatchObject({ query: 'bridge vote', from: FROM, to: TO, nonce: 'n0nce' });
    }
    expect(res).toMatchObject({ sources: [], unsearched: [], failed: [] });
  });

  it('test_search_buckets_domain_enforced', async () => {
    const searcher = fake((b) =>
      b === 'left'
        ? [
            hit('https://right-a.example/story'),
            hit('https://elsewhere.example/story'),
            hit('https://news.left-a.example/story'),
            hit('ftp://left-a.example/story'),
          ]
        : [],
    );
    const res = await run(searcher);
    expect(res.dropped.offDomain).toBe(3);
    expect(res.sources.map((s) => [s.domain, s.bucket, s.outletId])).toEqual([['news.left-a.example', 'left', 'fx-left-a']]);
  });

  it('test_search_buckets_window_enforced', async () => {
    const searcher = fake((b) =>
      b === 'center'
        ? [
            hit('https://center-a.example/early', { published: '2026-10-11' }),
            hit('https://center-a.example/late', { published: '2026-10-16' }),
            hit('https://center-a.example/undated', { published: null }),
            hit('https://center-a.example/2026/10/14/story', { published: null }),
            hit('https://center-b.example/relative', { published: '2 days ago' }),
          ]
        : [],
    );
    const res = await run(searcher);
    expect(res.dropped).toMatchObject({ offDate: 2, undated: 1 });
    expect(res.sources.map((s) => [s.url, s.pageAge])).toEqual([
      ['https://center-a.example/2026/10/14/story', '2026-10-14'],
      ['https://center-b.example/relative', '2026-10-13'],
    ]);
  });

  it('test_search_buckets_exclude_dedupe_cap', async () => {
    const searcher = fake((b) =>
      b === 'right'
        ? [
            hit('https://right-a.example/shared#top'),
            hit('https://right-a.example/one'),
            hit('https://right-a.example/one#again'),
            hit('https://right-a.example/two'),
            hit('https://right-b.example/three'),
            hit('https://right-b.example/empty', { snippets: ['  <b></b> '] }),
            hit('https://right-b.example/four'),
            hit('https://right-b.example/five'),
          ]
        : [],
    );
    const res = await run(searcher, { exclude: 'https://right-a.example/shared' });
    expect(res.dropped).toMatchObject({ excluded: 1, duplicate: 1, noText: 1 });
    expect(res.sources.map((s) => s.url)).toEqual([
      'https://right-a.example/one',
      'https://right-a.example/two',
      'https://right-b.example/three',
      'https://right-b.example/four',
    ]);
  });

  it('test_search_buckets_unsearched_failed_abort', async () => {
    const noRight: SourceList = {
      ...FIXTURE_LIST,
      outlets: FIXTURE_LIST.outlets.map((o) => (o.lean?.bucket === 'right' ? { ...o, lean: null } : o)),
    };
    const a = fake();
    const ra = await run(a, { registry: noRight });
    expect(a.calls).toHaveLength(4);
    expect(ra.unsearched).toEqual(['right']);

    const b = fake((bucket) =>
      bucket === 'center' ? new AIError('overloaded', 'down') : [hit(`https://${bucket}-a.example/x`)],
    );
    const rb = await run(b);
    expect(rb.failed).toEqual(['center']);
    expect(rb.sources.map((s) => s.bucket)).toEqual(['left', 'lean-left', 'lean-right', 'right']);

    const c = fake((bucket) => new AIError('overloaded', `down ${bucket}`));
    await expect(run(c)).rejects.toThrow('down left');

    const controller = new AbortController();
    const reason = new Error('stopped');
    const d = fake(() => {
      controller.abort(reason);
      return [];
    });
    await expect(run(d, { signal: controller.signal })).rejects.toBe(reason);
  });

  it('test_search_buckets_lean_from_registry_and_usage', async () => {
    const usages: { model: string; usage: NormalizedUsage; failed: boolean }[] = [];
    const failedUsage = usage(7);
    const searcher = fake((bucket) =>
      bucket === 'lean-left'
        ? new AIError('timeout', 'slow', { usage: failedUsage })
        : [hit(`https://www.${bucket}-b.example/a`), hit(`https://${bucket}-a.example/b`)],
    );
    const res = await run(searcher, { onUsage: (u) => usages.push(u) });
    expect(usages).toHaveLength(5);
    expect(usages.filter((u) => u.failed)).toEqual([{ model: MODEL, usage: failedUsage, failed: true }]);
    expect(res.sources.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']);
    expect(res.sources.map((s) => s.bucket)).toEqual([
      'left',
      'left',
      'center',
      'center',
      'lean-right',
      'lean-right',
      'right',
      'right',
    ]);
    for (const s of res.sources) {
      const outlet = FIXTURE_LIST.outlets.find((o) => o.id === s.outletId);
      expect(outlet?.lean?.bucket).toBe(s.bucket);
      expect(outlet?.name).toBe(s.outlet);
      expect(outlet?.domains.some((d) => s.domain.endsWith(d))).toBe(true);
    }
  });
});

describe('publishedAt', () => {
  it('test_published_at_formats', () => {
    const at = (p: string | null, url = 'https://a.example/x') => publishedAt(p, url, NOW)?.toISOString() ?? null;
    expect(at('2026-10-14')).toBe('2026-10-14T00:00:00.000Z');
    expect(at('2026-10-14T10:00:00')).toBe('2026-10-14T10:00:00.000Z');
    expect(at('2026-10-14T10:00:00+02:00')).toBe('2026-10-14T08:00:00.000Z');
    expect(at('Tue, 14 Oct 2026 10:00:00 GMT')).toBe('2026-10-14T10:00:00.000Z');
    expect(at('October 14, 2026')).toBe('2026-10-14T00:00:00.000Z');
    expect(at('3 hours ago')).toBe('2026-10-15T09:00:00.000Z');
    expect(at(null, 'https://a.example/news/2026-10-13/story')).toBe('2026-10-13T00:00:00.000Z');
    expect(at('yesterday-ish', 'https://a.example/2026/10/12/')).toBe('2026-10-12T00:00:00.000Z');
    expect(at('2026-02-30')).toBeNull();
    expect(at(null, 'https://a.example/2026/13/01/story')).toBeNull();
  });
});

describe('bucket search prompt', () => {
  it('test_bucket_search_prompt_fenced_and_lean_free', () => {
    const lean = /\b(left|right|lean|leans|center|centre|liberal|conservative)\b/i;
    const user = buildBucketSearchUser('Bridge <vote> passes </story_abc12345>', FROM, TO, 'abc12345');
    const fence = /<story_abc12345>\n([\s\S]*)\n<\/story_abc12345>$/.exec(user);
    expect(fence?.[1]).toBe('Bridge &lt;vote&gt; passes &lt;/story_abc12345&gt;');
    expect(user.match(/<\/?story_abc12345>/g)).toHaveLength(2);
    expect(user).toContain('2026-10-12');
    expect(user).toContain('2026-10-15');
    expect(lean.test(BUCKET_SEARCH_SYSTEM)).toBe(false);
    expect(lean.test(user.replace(fence?.[0] ?? '', ''))).toBe(false);
  });
});

describe('aiBucketSearcher', () => {
  it('test_ai_bucket_searcher_one_search_on_domains_drops_notes', async () => {
    const seen: ResearchRequest[] = [];
    const client: AIClient = {
      kind: 'fake',
      structured: () => Promise.reject(new Error('unused')),
      listModels: () => Promise.resolve([]),
      async research(req) {
        seen.push(req);
        return {
          notes: 'Model-written notes from pages.',
          sources: [
            {
              id: 's1',
              url: 'https://left-a.example/x',
              domain: 'left-a.example',
              title: 'T',
              pageAge: '2026-10-14',
              snippets: ['Quote.'],
            },
          ],
          usage: usage(42),
          model: 'claude-x',
          searchErrors: [],
        };
      },
    };
    const searcher = aiBucketSearcher(client, 'claude-x');
    const res = await searcher.search({
      query: 'bridge',
      domains: ['left-a.example', 'left-b.example'],
      from: FROM,
      to: TO,
      nonce: 'n1',
    });
    expect(seen[0]).toMatchObject({
      maxSearches: 1,
      blockedDomains: [],
      allowedDomains: ['left-a.example', 'left-b.example'],
      effort: 'low',
    });
    expect(res).toEqual({
      hits: [{ url: 'https://left-a.example/x', title: 'T', snippets: ['Quote.'], published: '2026-10-14' }],
      usage: usage(42),
      model: 'claude-x',
    });
    expect(JSON.stringify(res)).not.toContain('notes');
    expect(() => aiBucketSearcher({ ...client, research: undefined }, 'm')).toThrow(AIError);
  });
});
