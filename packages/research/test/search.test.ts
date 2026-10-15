import { AIError } from '@unalgorithm/ai';
import { FactcheckSourceSchema, MAX_RETRIEVED_SOURCES, ZERO_USAGE } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import type { RetrieveRequest } from '../src/retriever.ts';
import { createSearchProvider, type SearchHit, type SearchProvider, searchRetriever } from '../src/search.ts';
import { startMockSearxng } from '../src/testing/mock-searxng.ts';

interface Recorded {
  url: string;
  init: RequestInit;
}

/** A fake fetch answering every request with `answer()` and recording what was sent. */
function fakeFetch(answer: () => Response): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return answer();
  }) as typeof fetch;
  return { fetch: f, calls };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

function headersOf(init: RequestInit): Record<string, string> {
  return Object.fromEntries(new Headers(init.headers).entries());
}

async function caught(p: Promise<unknown>): Promise<AIError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AIError);
  return err as AIError;
}

describe('createSearchProvider', () => {
  it('test_create_search_provider_requires_url_or_key', () => {
    const cases = [
      { cfg: { provider: 'searxng' as const }, field: 'url' },
      { cfg: { provider: 'searxng' as const, url: 'ftp://secret-host.internal' }, field: 'url' },
      { cfg: { provider: 'brave' as const }, field: 'apiKey' },
      { cfg: { provider: 'tavily' as const, apiKey: '   ' }, field: 'apiKey' },
      { cfg: { provider: 'brave' as const, url: 'http://searxng:8080' }, field: 'apiKey' },
    ];
    for (const { cfg, field } of cases) {
      let err: unknown;
      try {
        createSearchProvider(cfg);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(TypeError);
      const message = (err as TypeError).message;
      expect(message).toContain(field);
      expect(message).not.toContain('secret-host');
      expect(message).not.toContain('searxng:8080');
    }
    expect(createSearchProvider({ provider: 'searxng', url: 'http://searxng:8080/' }).id).toBe('searxng');
    expect(createSearchProvider({ provider: 'tavily', apiKey: 'k' }).id).toBe('tavily');
  });
});

describe('search adapters', () => {
  it('test_searxng_request_and_mapping', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({
        query: 'q',
        results: [
          { url: 'https://a.example/1', title: 'A', content: 'Alpha', publishedDate: '2026-01-02T00:00:00', engine: 'x' },
          { url: 'https://b.example/2', title: 'B' },
          { url: 'https://c.example/3', title: 'C', content: null, publishedDate: null },
        ],
      }),
    );
    const provider = createSearchProvider({ provider: 'searxng', url: 'http://searxng:8080/', fetch });
    const hits = await provider.search('bridge opened 1932', { count: 2 });
    expect(calls).toHaveLength(1);
    const sent = new URL(calls[0]!.url);
    expect(`${sent.origin}${sent.pathname}`).toBe('http://searxng:8080/search');
    expect(sent.searchParams.get('q')).toBe('bridge opened 1932');
    expect(sent.searchParams.get('format')).toBe('json');
    expect(sent.searchParams.get('safesearch')).toBe('0');
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.redirect).toBe('error');
    expect(calls[0]!.init.credentials).toBe('omit');
    expect(hits).toEqual<SearchHit[]>([
      { url: 'https://a.example/1', title: 'A', snippet: 'Alpha', published: '2026-01-02T00:00:00' },
      { url: 'https://b.example/2', title: 'B', snippet: '', published: null },
    ]);
  });

  it('test_brave_request_and_mapping', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({
        type: 'search',
        web: {
          results: [
            { url: 'https://a.example/1', title: 'A', description: 'Alpha <strong>one</strong>', page_age: '2025-03-01' },
            { url: 'https://b.example/2', title: 'B' },
          ],
        },
      }),
    );
    const provider = createSearchProvider({ provider: 'brave', apiKey: 'brave-key', fetch });
    const hits = await provider.search('bridge', { count: 5 });
    const sent = new URL(calls[0]!.url);
    expect(`${sent.origin}${sent.pathname}`).toBe('https://api.search.brave.com/res/v1/web/search');
    expect(sent.searchParams.get('q')).toBe('bridge');
    expect(sent.searchParams.get('count')).toBe('5');
    expect(calls[0]!.init.method).toBe('GET');
    const headers = headersOf(calls[0]!.init);
    expect(headers['x-subscription-token']).toBe('brave-key');
    expect(headers.accept).toBe('application/json');
    expect(hits).toEqual<SearchHit[]>([
      { url: 'https://a.example/1', title: 'A', snippet: 'Alpha <strong>one</strong>', published: '2025-03-01' },
      { url: 'https://b.example/2', title: 'B', snippet: '', published: null },
    ]);
    // No `web` block: no hits.
    const empty = createSearchProvider({ provider: 'brave', apiKey: 'k', fetch: fakeFetch(() => json({})).fetch });
    expect(await empty.search('x', { count: 5 })).toEqual([]);
  });

  it('test_tavily_request_and_mapping', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({
        query: 'bridge',
        answer: null,
        results: [
          { url: 'https://a.example/1', title: 'A', content: 'Alpha', score: 0.9, published_date: '2024-05-06' },
          { url: 'https://b.example/2', title: 'B', content: 'Beta', score: 0.8 },
        ],
      }),
    );
    const provider = createSearchProvider({ provider: 'tavily', apiKey: 'tvly-key', fetch });
    const hits = await provider.search('bridge', { count: 4 });
    expect(calls[0]!.url).toBe('https://api.tavily.com/search');
    expect(calls[0]!.init.method).toBe('POST');
    expect(headersOf(calls[0]!.init).authorization).toBe('Bearer tvly-key');
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ query: 'bridge', max_results: 4, search_depth: 'basic', include_answer: false });
    expect(hits).toEqual<SearchHit[]>([
      { url: 'https://a.example/1', title: 'A', snippet: 'Alpha', published: '2024-05-06' },
      { url: 'https://b.example/2', title: 'B', snippet: 'Beta', published: null },
    ]);
  });

  it('test_search_errors_are_fixed_messages', async () => {
    const query = 'the secret claim text';
    const search = (answer: () => Response) =>
      createSearchProvider({ provider: 'brave', apiKey: 'brave-key', fetch: fakeFetch(answer).fetch }).search(query, {
        count: 5,
      });

    const refused = await caught(search(() => new Response(`Bad token for query "${query}"`, { status: 401 })));
    expect(refused.code).toBe('not-available');
    expect(refused.message).toBe('The search provider refused the request.');
    expect(refused.message).not.toContain(query);

    const limited = await caught(search(() => new Response(query, { status: 429, headers: { 'retry-after': '7' } })));
    expect(limited.code).toBe('rate-limit');
    expect(limited.retryAfterMs).toBe(7000);

    const down = await caught(search(() => new Response(query, { status: 503 })));
    expect(down.code).toBe('overloaded');

    const notJson = await caught(search(() => new Response(`<html>${query}</html>`, { status: 200 })));
    expect(notJson.code).toBe('unknown');

    const huge = await caught(search(() => new Response(`{"results":[],"pad":"${'x'.repeat(2 * 1024 * 1024)}"}`)));
    expect(huge.code).toBe('unknown');

    for (const err of [limited, down, notJson, huge]) {
      expect(err.message).not.toContain(query);
      expect(err.message).not.toContain('brave-key');
    }

    // The caller's abort rethrows its own reason.
    const controller = new AbortController();
    const reason = new Error('stopped');
    controller.abort(reason);
    await expect(
      createSearchProvider({ provider: 'brave', apiKey: 'k', fetch: fakeFetch(() => json({})).fetch }).search('x', {
        count: 1,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });
});

const CLAIMS = [
  { id: 'c1', text: 'The bridge opened in 1932.' },
  { id: 'c2', text: 'It cost $10 million.' },
  { id: 'c3', text: 'It is the longest in the state.' },
];

function request(over: Partial<RetrieveRequest> = {}): RetrieveRequest {
  return { claims: CLAIMS, maxSearches: 5, blockedDomains: [], nonce: 'abc12345', ...over };
}

/** A provider answering each query with `hits(query, n)`, where n counts searches from 1. */
function fakeProvider(hits: (query: string, n: number) => SearchHit[] | Error): {
  provider: SearchProvider;
  calls: { query: string; count: number; signal?: AbortSignal }[];
} {
  const calls: { query: string; count: number; signal?: AbortSignal }[] = [];
  return {
    calls,
    provider: {
      id: 'searxng',
      async search(query, opts) {
        calls.push({ query, ...opts });
        const out = hits(query, calls.length);
        if (out instanceof Error) throw out;
        return out;
      },
    },
  };
}

const hit = (url: string, snippet = 'Some text.', over: Partial<SearchHit> = {}): SearchHit => ({
  url,
  title: 'Title',
  snippet,
  published: null,
  ...over,
});

describe('searchRetriever', () => {
  it('test_search_retriever_one_search_per_claim_capped', async () => {
    const long = { id: 'c1', text: 'x'.repeat(250) };
    const { provider, calls } = fakeProvider(() => []);
    const controller = new AbortController();
    await searchRetriever(provider, { resultsPerClaim: 3 }).retrieve(
      request({ claims: [long, CLAIMS[1]!, CLAIMS[2]!], maxSearches: 2, signal: controller.signal }),
    );
    expect(calls.map((c) => c.query)).toEqual(['x'.repeat(200), CLAIMS[1]!.text]);
    expect(calls.every((c) => c.count === 3 && c.signal === controller.signal)).toBe(true);

    const all = fakeProvider(() => []);
    await searchRetriever(all.provider).retrieve(request());
    expect(all.calls.map((c) => c.query)).toEqual(CLAIMS.map((c) => c.text));
    expect(all.calls[0]!.count).toBe(5);
  });

  it('test_search_retriever_drops_bad_blocked_and_empty_hits', async () => {
    const { provider } = fakeProvider(() => [
      hit('javascript:alert(1)'),
      hit('ftp://files.example/a'),
      hit(`https://long.example/${'a'.repeat(2048)}`),
      hit('https://blocked.example/a'),
      hit('https://news.blocked.example/a'),
      hit('https://empty.example/a', '  <b> </b> '),
      // The URL parser accepts a host over 253 characters, which FactcheckSourceSchema (the wire shape) refuses.
      hit(`https://${Array.from({ length: 5 }, () => 'h'.repeat(60)).join('.')}.example/a`),
      hit('https://notblocked.example/a'),
      hit('http://Good.Example/b'),
    ]);
    const res = await searchRetriever(provider).retrieve(request({ claims: [CLAIMS[0]!], blockedDomains: ['blocked.example'] }));
    expect(res.sources.map((s) => s.url)).toEqual(['https://notblocked.example/a', 'http://good.example/b']);
    expect(res.sources.map((s) => s.domain)).toEqual(['notblocked.example', 'good.example']);
  });

  it('test_search_retriever_dedupes_and_numbers_sources', async () => {
    const { provider } = fakeProvider((_q, n) =>
      n === 1
        ? [hit('https://a.example/x#one'), hit('https://b.example/y')]
        : [hit('https://a.example/x#two'), hit('https://c.example/z'), hit('https://b.example/y')],
    );
    const res = await searchRetriever(provider).retrieve(request({ claims: CLAIMS.slice(0, 2) }));
    expect(res.sources.map((s) => [s.id, s.url])).toEqual([
      ['s1', 'https://a.example/x#one'],
      ['s2', 'https://b.example/y'],
      ['s3', 'https://c.example/z'],
    ]);

    const many = fakeProvider((_q, n) => Array.from({ length: 10 }, (_, i) => hit(`https://d${n}-${i}.example/`)));
    const capped = await searchRetriever(many.provider, { resultsPerClaim: 10 }).retrieve(request());
    expect(capped.sources).toHaveLength(MAX_RETRIEVED_SOURCES);
    expect(capped.sources.map((s) => s.id)).toEqual(Array.from({ length: 20 }, (_, i) => `s${i + 1}`));
    // The third search would add nothing: the cap is reached after two.
    expect(many.calls).toHaveLength(2);
  });

  it('test_search_retriever_cleans_snippets', async () => {
    const { provider } = fakeProvider(() => [
      hit('https://a.example/', '<strong>AT&amp;T</strong>   said', {
        title: `<b>T</b>${'t'.repeat(400)}`,
        published: 'p'.repeat(100),
      }),
      hit('https://b.example/', `&quot;a&quot; &lt;b&gt; &#39;c&#39; &amp;lt; ${'w '.repeat(800)}`),
    ]);
    const res = await searchRetriever(provider).retrieve(request({ claims: [CLAIMS[0]!] }));
    const [a, b] = res.sources;
    expect(a!.snippets).toEqual(['AT&T said']);
    expect(a!.title).toBe(`T${'t'.repeat(299)}`);
    expect(a!.pageAge).toBe('p'.repeat(64));
    expect(b!.snippets[0]!.startsWith(`"a" <b> 'c' &lt; w w`)).toBe(true);
    expect(b!.snippets[0]!.length).toBe(1000);
  });

  it('test_search_retriever_result_shape', async () => {
    const { provider } = fakeProvider((q) => [
      hit('https://a.example/1', `About ${q}`, { published: '2025-01-01' }),
      hit('https://b.example/2', `More on ${q}`),
    ]);
    const res = await searchRetriever(provider).retrieve(request());
    expect(res.notes).toBe('');
    expect(res.usage).toEqual(ZERO_USAGE);
    expect(res.model).toBe('search:searxng');
    expect(res.sources).toHaveLength(2);
    for (const source of res.sources) {
      const { snippets, ...rest } = source;
      expect(FactcheckSourceSchema.parse(rest)).toEqual(rest);
      expect(snippets).toHaveLength(1);
    }
  });

  it('test_search_retriever_fails_on_one_failed_search', async () => {
    const failure = new AIError('rate-limit', 'The search provider is limiting requests.');
    const { provider, calls } = fakeProvider((_q, n) => (n === 2 ? failure : [hit('https://a.example/')]));
    await expect(searchRetriever(provider).retrieve(request())).rejects.toBe(failure);
    expect(calls).toHaveLength(2);
  });
});

describe('startMockSearxng', () => {
  it('test_mock_searxng_answers_adapter_shape', async () => {
    const mock = await startMockSearxng();
    try {
      const provider = createSearchProvider({ provider: 'searxng', url: mock.url });
      const query = 'The bridge opened in 1932 and was, at the time, the longest suspension bridge anywhere in the world.';
      const hits = await provider.search(query, { count: 5 });
      expect(mock.queries).toEqual([query]);
      expect(hits.map((h) => new URL(h.url).hostname)).toEqual(['a.example', 'b.example', 'c.example']);
      expect(hits.every((h) => h.snippet === `Records show that ${query.slice(0, 80)}.`)).toBe(true);

      mock.failNext(503, 'down');
      expect((await caught(provider.search('again', { count: 5 }))).code).toBe('overloaded');
      expect(mock.queries).toEqual([query, 'again']);

      const res = await searchRetriever(provider).retrieve(request({ claims: [CLAIMS[0]!] }));
      expect(res.sources.map((s) => s.domain)).toEqual(['a.example', 'b.example', 'c.example']);
    } finally {
      await mock.close();
    }
  });
});
