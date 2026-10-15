import { buildInterestProfile, defaultSettings } from '@unalgorithm/core';
import { describe, expect, it } from 'vitest';
import {
  AIError,
  citedText,
  classifyPosts,
  memoryCapabilities,
  openaiClient,
  type ResearchRequest,
  type StructuredRequest,
} from '../src/index.ts';
import {
  errorResponse,
  mockOpenAIResponsesFetch,
  mockResponsesAnswer,
  type ResponsesRequestKind,
  researchResponse,
  responsesRequestKind,
  structuredResponse,
} from '../src/testing/mock-openai-responses.ts';
import { CLAIMS_PHRASE, COMPARISON_PHRASE, STORY_PHRASE, VERDICT_PHRASE } from '../src/testing/mock-openai-server.ts';

type Answer = Parameters<typeof mockOpenAIResponsesFetch>[0];

function clientOver(answer: Answer) {
  const fetch = mockOpenAIResponsesFetch(answer);
  const client = openaiClient({ apiKey: 'sk-test', capabilities: memoryCapabilities(), fetch });
  if (!client.research) throw new Error('research missing');
  return { client, research: client.research.bind(client), fetch };
}

const req = (over: Partial<ResearchRequest> = {}): ResearchRequest => ({
  model: 'gpt-5',
  system: 'Research the claims.',
  user: 'Claims: the moon is made of cheese.',
  maxSearches: 4,
  blockedDomains: ['satire.example', 'farm.example'],
  effort: 'low',
  maxOutputTokens: 4000,
  ...over,
});

const basic = () => researchResponse({ searches: [{ urls: ['https://a.example/1'] }], text: 'Notes.', citations: [] });

async function rejection(p: Promise<unknown>): Promise<AIError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AIError) return e;
    throw e;
  }
  throw new Error('expected a rejection');
}

const tool = (body: Record<string, unknown>) => (body.tools as Record<string, unknown>[])[0] ?? {};

describe('openai research: request', () => {
  it('test_openai_research_request_shape', async () => {
    const { research, fetch } = clientOver(() => basic());
    await research(req());
    await research(req({ allowedDomains: ['a.example', 'b.example'] }));
    expect(fetch.bodies).toHaveLength(2);
    const [plain = {}, allowed = {}] = fetch.bodies;
    expect(plain.tools).toHaveLength(1);
    expect(tool(plain)).toEqual({ type: 'web_search', user_location: { type: 'approximate' } });
    expect(plain.max_tool_calls).toBe(4);
    expect(plain.include).toContain('web_search_call.action.sources');
    expect(plain.store).toBe(false);
    expect(plain.instructions).toBe('Research the claims.');
    expect(plain.input).toBe('Claims: the moon is made of cheese.');
    expect(plain.reasoning).toEqual({ effort: 'low' });
    expect(JSON.stringify(plain)).not.toContain('blocked_domains');
    expect(JSON.stringify(plain)).not.toContain('satire.example');
    expect(tool(allowed)).toEqual({
      type: 'web_search',
      user_location: { type: 'approximate' },
      filters: { allowed_domains: ['a.example', 'b.example'] },
    });
    expect(JSON.stringify(allowed)).not.toContain('blocked_domains');
  });

  it('test_openai_research_no_sdk_retry', async () => {
    const { research, fetch } = clientOver(() => errorResponse(500, 'The server had an error.'));
    const e = await rejection(research(req()));
    expect(e.code).toBe('overloaded');
    expect(fetch.bodies).toHaveLength(1);
  });

  it('test_openai_reasoning_headroom', async () => {
    const sreq = (model: string): StructuredRequest => ({
      model,
      system: 'Classify.',
      user: 'Posts.',
      jsonSchema: { type: 'object' },
      schemaName: 'classify',
      effort: 'medium',
      maxOutputTokens: 1500,
    });
    const { client, research, fetch } = clientOver(() => structuredResponse({ ok: true }));
    await client.structured(sreq('gpt-5'));
    await client.structured(sreq('gpt-4.1-mini'));
    expect(fetch.bodies[0]?.max_output_tokens).toBe(7500);
    expect(fetch.bodies[1]).toEqual({
      model: 'gpt-4.1-mini',
      instructions: 'Classify.',
      input: 'Posts.',
      max_output_tokens: 1500,
      store: false,
      prompt_cache_key: 'unalgorithm-classify-v1',
      text: { format: { type: 'json_schema', name: 'classify', schema: { type: 'object' }, strict: true } },
      reasoning: { effort: 'medium' },
    });
    // Research too: low effort on a reasoning model adds 2,000.
    await research(req({ maxOutputTokens: 4000 })).catch(() => undefined);
    expect(fetch.bodies[2]?.max_output_tokens).toBe(6000);
  });
});

describe('openai research: parsing', () => {
  it('test_openai_research_sources_from_search_calls', async () => {
    const { research } = clientOver(() =>
      researchResponse({
        searches: [
          { urls: ['https://a.example/1', 'https://b.example/2?utm_source=openai'] },
          { urls: ['https://a.example/1', 'https://c.example/3'] },
        ],
        text: 'Notes.',
        citations: [],
      }),
    );
    const out = await research(req());
    expect(out.sources.map((s) => [s.id, s.url, s.domain])).toEqual([
      ['s1', 'https://a.example/1', 'a.example'],
      ['s2', 'https://b.example/2', 'b.example'],
      ['s3', 'https://c.example/3', 'c.example'],
    ]);
    expect(out.usage.webSearches).toBe(2);
    expect(out.usage).toMatchObject({ uncachedInput: 20_000, output: 1500 });
    expect(out.notes).toBe('Notes.');
    expect(out.searchErrors).toEqual([]);
    expect(out.model).toBe('gpt-5');
  });

  it('test_openai_cited_text_and_titles', async () => {
    const markerA = '([a.example](https://a.example/x?utm_source=openai))';
    const markerB = '([b.example](https://b.example/y?utm_source=openai))';
    const markerC = '([c.example](https://c.example/z?utm_source=openai))';
    const text = `Intro. Water boils at 100 C at sea level. ${markerA}\nInflation was 3.5 percent in 2025. ${markerB} Data from a.example says so. ${markerC}`;
    const at = (s: string) => ({ start: text.indexOf(s), end: text.indexOf(s) + s.length });
    const { research } = clientOver(() =>
      researchResponse({
        searches: [{ urls: ['https://a.example/x?utm_source=openai', 'https://b.example/y'] }],
        text,
        citations: [
          { url: 'https://a.example/x?utm_source=openai', title: 'Boiling', ...at(markerA) },
          { url: 'https://b.example/y?utm_source=openai', title: 'Prices', ...at(markerB) },
          { url: 'https://b.example/y', title: 'Prices again', ...at('3.5 percent') },
          { url: 'https://c.example/z?utm_source=openai', title: 'Uncited', ...at(markerC) },
        ],
      }),
    );
    const out = await research(req());
    expect(out.sources).toHaveLength(2);
    expect(out.sources[0]).toMatchObject({
      url: 'https://a.example/x',
      title: 'Boiling',
      snippets: ['Water boils at 100 C at sea level.'],
    });
    expect(out.sources[1]).toMatchObject({
      url: 'https://b.example/y',
      title: 'Prices',
      snippets: ['Inflation was 3.5 percent in 2025.', '3.5 percent'],
    });
    expect(out.sources.some((s) => s.domain === 'c.example')).toBe(false);
  });

  it('citedText keeps dotted hosts and decimals inside one sentence and strips link syntax', () => {
    const text = 'One. Per [the report](https://r.example/p) from a.example, 2.5 rose! ([r](https://r.example/p))';
    const start = text.lastIndexOf('([r]');
    expect(citedText(text, start, text.length)).toBe('Per the report from a.example, 2.5 rose!');
    expect(citedText('Plain span here.', 6, 10)).toBe('span');
    expect(citedText('x'.repeat(700), 0, 700)).toHaveLength(600);
  });
});

describe('openai research: errors', () => {
  it('test_openai_research_error_mapping', async () => {
    const failed = clientOver(() =>
      researchResponse({ searches: [{ urls: [], status: 'failed' }], text: 'No luck.', citations: [] }),
    );
    expect((await rejection(failed.research(req()))).code).toBe('overloaded');

    const unsupported = clientOver(() => errorResponse(400, 'web_search is not supported for this model'));
    const u = await rejection(unsupported.research(req()));
    expect(u.code).toBe('unsupported');
    expect(u.usage).toBeDefined();

    const truncated = clientOver(() =>
      researchResponse({ searches: [{ urls: ['https://a.example/1'] }], text: 'Cut', citations: [], status: 'incomplete' }),
    );
    const t = await rejection(truncated.research(req()));
    expect(t.code).toBe('truncated');
    expect(t.usage).toMatchObject({ uncachedInput: 20_000, output: 1500, webSearches: 1 });
  });
});

describe('mock Responses responder', () => {
  it('test_responses_request_kind_and_mock_fetch', async () => {
    const body = (input: string, extra: Record<string, unknown> = {}) => ({ model: 'gpt-5-mini', input, ...extra });
    expect(responsesRequestKind(body('x', { tools: [{ type: 'web_search' }] }))).toBe('research');
    expect(responsesRequestKind(body(`${CLAIMS_PHRASE} in this post.`))).toBe('claims');
    expect(responsesRequestKind(body(`${VERDICT_PHRASE} claims.`))).toBe('verdict');
    expect(responsesRequestKind(body(`${STORY_PHRASE} for this link.`))).toBe('story');
    expect(responsesRequestKind(body(`${COMPARISON_PHRASE} report it.`))).toBe('comparison');
    expect(responsesRequestKind(body('Classify these posts.'))).toBe('classify');
    expect(responsesRequestKind('not a body')).toBe('unknown');

    const kinds: ResponsesRequestKind[] = [];
    const { client, research } = clientOver((kind, b) => {
      kinds.push(kind);
      return kind === 'research' ? basic() : mockResponsesAnswer(b);
    });
    const profile = buildInterestProfile(defaultSettings());
    const post = {
      ref: 'p1',
      platform: 'linkedin' as const,
      text: 'How AI automation changes work.',
      textComplete: true,
      authorKind: 'person' as const,
      isReshare: false,
      media: 'none' as const,
    };
    const classified = await classifyPosts(client, [post], { model: 'gpt-5-mini', profile });
    expect(classified.byRef.get('p1')).toMatchObject({ ok: true, classification: { relevance: 92 } });
    const story = await client.structured({
      model: 'gpt-5-mini',
      system: 'Story.',
      user: `${STORY_PHRASE}.\n<link_ab12 id="l1">\nRates rise again\n</link_ab12>`,
      jsonSchema: { type: 'object' },
      schemaName: 'story',
      effort: 'low',
      maxOutputTokens: 200,
    });
    expect(JSON.parse(story.text)).toEqual({ query: 'Rates rise again' });
    expect((await research(req())).sources).toHaveLength(1);
    expect(kinds).toEqual(['classify', 'story', 'research']);
  });
});
