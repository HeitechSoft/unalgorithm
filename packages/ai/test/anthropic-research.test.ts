import { FactcheckSourceSchema } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import { AIError, anthropicClient, memoryCapabilities, type ResearchRequest } from '../src/index.ts';
import {
  type AnthropicRequestKind,
  mockAnthropicFetch,
  requestKind,
  researchMessage,
  structuredMessage,
} from '../src/testing/mock-anthropic.ts';

type Reply = { status: number; body: unknown };

/** A mock fetch answering from a queue (a 500 once it runs out). */
function queued(replies: Reply[]) {
  return mockAnthropicFetch(() => replies.shift() ?? { status: 500, body: { type: 'error', error: { message: 'none' } } });
}

function clientWith(fetch: typeof globalThis.fetch) {
  const client = anthropicClient({ apiKey: 'sk-ant-test', capabilities: memoryCapabilities(), fetch });
  if (!client.research) throw new Error('research missing');
  return client.research.bind(client);
}

const req = (over: Partial<ResearchRequest> = {}): ResearchRequest => ({
  model: 'claude-sonnet-5-5',
  system: 'Research the claims.',
  user: 'Claims: the moon is made of cheese.',
  maxSearches: 5,
  blockedDomains: ['satire.example', 'farm.example'],
  effort: 'low',
  maxOutputTokens: 4000,
  ...over,
});

const ok = (body: unknown): Reply => ({ status: 200, body });
const r = (url: string, title = 'Title') => ({ url, title });
const basic = () => researchMessage({ results: [r('https://a.example/1')], notes: [{ text: 'Notes.' }] });
const apiError = (status: number, message: string): Reply => ({
  status,
  body: { type: 'error', error: { type: 'invalid_request_error', message } },
});

async function rejection(p: Promise<unknown>): Promise<AIError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AIError) return e;
    throw e;
  }
  throw new Error('expected a rejection');
}

/** The one tool of a research body. */
const tool = (body: Record<string, unknown>) => (body.tools as Record<string, unknown>[])[0] ?? {};

describe('anthropic research: request shape', () => {
  it('test_research_sends_web_search_tool_with_max_uses_callers_and_blocklist', async () => {
    const f = queued([ok(basic())]);
    await clientWith(f)(req({ maxSearches: 4 }));
    const body = f.bodies[0] ?? {};
    expect(body.tools).toHaveLength(1);
    expect(tool(body)).toEqual({
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: 4,
      allowed_callers: ['direct'],
      blocked_domains: ['satire.example', 'farm.example'],
    });
  });

  it('test_research_omits_blocked_domains_when_empty', async () => {
    const f = queued([ok(basic())]);
    await clientWith(f)(req({ blockedDomains: [] }));
    expect('blocked_domains' in tool(f.bodies[0] ?? {})).toBe(false);
  });

  it('test_research_sends_no_output_format', async () => {
    const f = queued([ok(basic())]);
    await clientWith(f)(req());
    const config = (f.bodies[0]?.output_config ?? {}) as Record<string, unknown>;
    expect(config.format).toBeUndefined();
    expect(config.effort).toBe('low');
  });
});

describe('anthropic research: parsing', () => {
  it('test_research_assigns_ids_in_order_and_dedupes_urls', async () => {
    const msg = researchMessage({
      results: [r('https://a.example/1'), r('https://b.example/2'), r('https://a.example/1', 'Again'), r('https://c.example/3')],
      notes: [{ text: 'Notes.' }],
    });
    const out = await clientWith(queued([ok(msg)]))(req());
    expect(out.sources.map((s) => [s.id, s.url, s.title])).toEqual([
      ['s1', 'https://a.example/1', 'Title'],
      ['s2', 'https://b.example/2', 'Title'],
      ['s3', 'https://c.example/3', 'Title'],
    ]);
  });

  it('test_research_skips_non_http_urls_strips_www_caps_twenty', async () => {
    const results = [
      r('ftp://files.example/x'),
      r('javascript:alert(1)'),
      r(`https://long.example/${'a'.repeat(2048)}`),
      { url: 'https://WWW.News.Example/story', title: 'T'.repeat(400), pageAge: 'x'.repeat(100) },
      ...Array.from({ length: 25 }, (_, i) => r(`https://site${i}.example/`)),
    ];
    const out = await clientWith(queued([ok(researchMessage({ results, notes: [] }))]))(req());
    expect(out.sources).toHaveLength(20);
    expect(out.sources[0]).toMatchObject({ id: 's1', domain: 'news.example' });
    expect(out.sources[0]?.title).toHaveLength(300);
    expect(out.sources[0]?.pageAge).toHaveLength(64);
    expect(out.sources[19]?.id).toBe('s20');
    expect(out.sources.some((s) => !s.url.startsWith('https://'))).toBe(false);
    for (const s of out.sources) expect(FactcheckSourceSchema.safeParse(s).success).toBe(true);
  });

  it('test_research_attaches_cited_text_to_matching_source', async () => {
    const msg = researchMessage({
      results: [r('https://a.example/1'), r('https://b.example/2')],
      notes: [
        { text: 'First. ', cites: [{ url: 'https://b.example/2', citedText: 'B says so.' }] },
        {
          text: 'Second.',
          cites: [
            { url: 'https://b.example/2', citedText: 'B says so.' },
            { url: 'https://a.example/1', citedText: 'A says otherwise.' },
          ],
        },
      ],
    });
    const out = await clientWith(queued([ok(msg)]))(req());
    expect(out.notes).toBe('First. Second.');
    expect(out.sources.find((s) => s.id === 's1')?.snippets).toEqual(['A says otherwise.']);
    expect(out.sources.find((s) => s.id === 's2')?.snippets).toEqual(['B says so.']);
    expect(JSON.stringify(out)).not.toContain('MOCK-ENCRYPTED');
  });

  it('test_research_citation_to_unretrieved_url_adds_no_source', async () => {
    const msg = researchMessage({
      results: [r('https://a.example/1')],
      notes: [{ text: 'Notes.', cites: [{ url: 'https://elsewhere.example/', citedText: 'Invented.' }] }],
    });
    const out = await clientWith(queued([ok(msg)]))(req());
    expect(out.sources).toHaveLength(1);
    expect(out.sources[0]?.snippets).toEqual([]);
    expect(JSON.stringify(out)).not.toContain('Invented.');
  });

  it('test_research_counts_web_searches', async () => {
    const out = await clientWith(queued([ok(researchMessage({ results: [r('https://a.example/1')], notes: [], searches: 4 }))]))(
      req(),
    );
    expect(out.usage.webSearches).toBe(4);
    expect(out.usage).toMatchObject({ uncachedInput: 20_000, output: 1500 });
  });
});

describe('anthropic research: continuation', () => {
  it('test_research_continues_pause_turn_and_sums_usage', async () => {
    const first = researchMessage({ results: [r('https://a.example/1')], notes: [], searches: 2, stopReason: 'pause_turn' });
    const second = researchMessage({
      results: [r('https://b.example/2')],
      notes: [{ text: 'Done.', cites: [{ url: 'https://a.example/1', citedText: 'From the first call.' }] }],
      searches: 1,
    });
    const f = queued([ok(first), ok(second)]);
    const out = await clientWith(f)(req({ maxSearches: 5 }));
    expect(f.bodies).toHaveLength(2);
    const messages = (f.bodies[1]?.messages ?? []) as { role: string; content: unknown }[];
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ role: 'assistant', content: first.content });
    expect(tool(f.bodies[1] ?? {}).max_uses).toBe(3);
    expect(out.usage).toMatchObject({ uncachedInput: 40_000, output: 3000, webSearches: 3 });
    expect(out.sources.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(out.sources[0]?.snippets).toEqual(['From the first call.']);
  });

  it('test_research_stops_after_two_continuations', async () => {
    const paused = (url: string) => ok(researchMessage({ results: [r(url)], notes: [], searches: 1, stopReason: 'pause_turn' }));
    const f = queued([
      paused('https://a.example/'),
      paused('https://b.example/'),
      paused('https://c.example/'),
      paused('https://d.example/'),
    ]);
    const out = await clientWith(f)(req({ maxSearches: 5 }));
    expect(f.bodies).toHaveLength(3);
    expect(out.sources).toHaveLength(3);
    expect(out.usage.webSearches).toBe(3);
  });

  it('test_research_timeout_is_not_retried_and_spans_continuations', async () => {
    const first = researchMessage({ results: [r('https://a.example/1')], notes: [], searches: 1, stopReason: 'pause_turn' });
    let calls = 0;
    const answered = mockAnthropicFetch(() => ok(first));
    const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      calls++;
      if (calls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return answered(input, init);
      }
      // Never answers: only the SDK's timeout ends it.
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as typeof globalThis.fetch;
    const started = Date.now();
    const e = await rejection(clientWith(fetch)(req({ timeoutMs: 500 })));
    const elapsed = Date.now() - started;
    expect(e.code).toBe('timeout');
    expect(e.usage?.webSearches).toBe(1);
    expect(calls).toBe(2);
    expect(elapsed).toBeLessThan(500 + 150);
  });
});

describe('anthropic research: errors', () => {
  it('test_research_all_searches_unavailable_throws_overloaded_with_usage', async () => {
    const msg = researchMessage({ results: [], notes: [{ text: 'Could not search.' }], searches: 1, searchError: 'unavailable' });
    const e = await rejection(clientWith(queued([ok(msg)]))(req()));
    expect(e.code).toBe('overloaded');
    expect(e.message).toBe('Web search is unavailable right now.');
    expect(e.usage).toMatchObject({ uncachedInput: 20_000, webSearches: 1 });
  });

  it('test_research_refusal_throws_refusal_with_usage', async () => {
    const msg = { ...researchMessage({ results: [], notes: [] }), stop_reason: 'refusal' };
    const e = await rejection(clientWith(queued([ok(msg)]))(req()));
    expect(e.code).toBe('refusal');
    expect(e.usage?.uncachedInput).toBe(20_000);
  });

  it('test_research_web_search_400_maps_to_unsupported', async () => {
    const f = queued([apiError(400, 'The web_search tool is not enabled for this organization.')]);
    const e = await rejection(clientWith(f)(req()));
    expect(e.code).toBe('unsupported');
    expect(f.bodies).toHaveLength(1);
  });

  it('test_research_401_maps_to_auth', async () => {
    const e = await rejection(clientWith(queued([apiError(401, 'invalid x-api-key')]))(req()));
    expect(e.code).toBe('auth');
  });
});

describe('mock anthropic responder', () => {
  const format = (prop: string) => ({
    output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: { [prop]: {} } } } },
  });

  it('test_mock_request_kind_detects_each_kind', () => {
    const kinds: AnthropicRequestKind[] = [
      requestKind(format('results')),
      requestKind(format('claims')),
      requestKind({ tools: [{ type: 'web_search_20260209' }], output_config: { effort: 'low' } }),
      requestKind(format('verdicts')),
      requestKind(format('other')),
      requestKind({ messages: [] }),
      requestKind(null),
    ];
    expect(kinds).toEqual(['classify', 'claims', 'research', 'verdict', 'unknown', 'unknown', 'unknown']);
  });

  it('test_mock_fetch_records_bodies_in_order', async () => {
    const seen: AnthropicRequestKind[] = [];
    const f = mockAnthropicFetch((_body, kind) => {
      seen.push(kind);
      return ok(kind === 'research' ? basic() : structuredMessage({ claims: [] }));
    });
    const client = anthropicClient({ apiKey: 'k', capabilities: memoryCapabilities(), fetch: f });
    await client.structured({
      model: 'claude-haiku-5-5',
      system: 's',
      user: 'first',
      jsonSchema: { type: 'object', properties: { claims: { type: 'array' } } },
      schemaName: 'claims',
      effort: 'low',
      maxOutputTokens: 100,
    });
    await client.research?.(req({ user: 'second' }));
    expect(f.bodies.map((b) => (b.messages as { content: string }[])[0]?.content)).toEqual(['first', 'second']);
    expect(seen).toEqual(['claims', 'research']);
  });
});
