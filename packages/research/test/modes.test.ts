import { type AIClient, AIError, type ResearchRequest, type StructuredRequest } from '@unalgorithm/ai';
import { FIXTURE_LIST } from '@unalgorithm/outlets/testing';
import { costMicros, type NormalizedUsage, type PostForAI, type RetrievedSource, ZERO_USAGE } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import { runFactcheck } from '../src/factcheck.ts';
import {
  factcheckDepsForMode,
  OPENAI_FACTCHECK_MODELS,
  OPENAI_PERSPECTIVES_MODELS,
  type OwnKeyMode,
  perspectivesDepsForMode,
  WebSearchFailure,
} from '../src/modes.ts';
import { runPerspectives } from '../src/perspectives.ts';
import { aiRetriever } from '../src/retriever.ts';
import type { SearchHit, SearchOptions, SearchProvider } from '../src/search.ts';

const NONCE = 'abc12345';
const NOW = new Date('2026-10-15T12:00:00.000Z');
const POST: PostForAI = {
  ref: 'p1',
  platform: 'linkedin',
  text: 'The bridge opened in 1932, cost $10 million and is 2 km long.',
  textComplete: true,
  authorKind: 'person',
  isReshare: false,
  media: 'none',
};
const LINK = { url: 'https://news.example.com/2026/10/14/council-bridge', title: 'Council approves the bridge' };
const USAGE: NormalizedUsage = { ...ZERO_USAGE, uncachedInput: 100, output: 10 };

function source(id: string, domain: string): RetrievedSource {
  return { id, url: `https://${domain}/${id}`, domain, title: `Title ${id}`, pageAge: null, snippets: ['A snippet.'] };
}

/** A client that answers every structured step by schema name and records research requests. */
function stubClient(opts: { sources?: RetrievedSource[] } = {}) {
  const structured: StructuredRequest[] = [];
  const research: ResearchRequest[] = [];
  const client: AIClient & { research: NonNullable<AIClient['research']> } = {
    kind: 'stub',
    async structured(req) {
      structured.push(req);
      const data =
        req.schemaName === 'factcheck_claims'
          ? {
              claims: [{ claim: 'The bridge opened in 1932.' }, { claim: 'It cost $10 million.' }, { claim: 'It is 2 km long.' }],
            }
          : req.schemaName === 'factcheck_verdicts'
            ? { verdicts: [] }
            : req.schemaName === 'perspectives_story'
              ? { query: 'council bridge vote' }
              : {};
      return { text: JSON.stringify(data), usage: USAGE, model: req.model, mode: 'json-schema' };
    },
    async listModels() {
      return [];
    },
    async research(req) {
      research.push(req);
      return { notes: '', sources: opts.sources ?? [], usage: USAGE, model: req.model, searchErrors: [] };
    },
  };
  return { client, structured, research };
}

function stubSearch(fail?: AIError): SearchProvider & { queries: string[] } {
  const queries: string[] = [];
  return {
    id: 'brave',
    queries,
    async search(query: string, _opts: SearchOptions): Promise<SearchHit[]> {
      queries.push(query);
      if (fail) throw fail;
      return [{ url: `https://news.example/${queries.length}`, title: 'Bridge', snippet: 'The bridge opened.', published: null }];
    },
  };
}

const retrieveReq = {
  claims: [{ id: 'c1', text: 'The bridge opened in 1932.' }],
  maxSearches: 3,
  blockedDomains: [],
  nonce: NONCE,
};
const bucketReq = { query: 'q', domains: ['a.example'], from: NOW, to: NOW, nonce: NONCE };

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('deps per mode', () => {
  it('test_modes_anthropic_matches_rm1_deps', async () => {
    const { client, research } = stubClient();
    const fc = factcheckDepsForMode(client, { kind: 'anthropic' });
    expect(fc.models).toBeUndefined();
    expect(fc.client).toBe(client);
    await fc.retriever.retrieve(retrieveReq);
    expect(research.map((r) => r.model)).toEqual(['claude-sonnet-5-5']);

    const pd = perspectivesDepsForMode(client, { kind: 'anthropic' }, FIXTURE_LIST);
    expect(pd.searcher.model).toBe('claude-haiku-5-5');
    expect(pd.models).toBeUndefined();
    expect(pd.registry).toBe(FIXTURE_LIST);
    for (const d of [fc, pd]) {
      expect(d).not.toHaveProperty('maxCostMicros');
      expect(d).not.toHaveProperty('linkCheck');
      expect(d).not.toHaveProperty('resolveLink');
    }
  });

  it('test_modes_openai_models', async () => {
    const { client, research } = stubClient();
    const fc = factcheckDepsForMode(client, { kind: 'openai' });
    expect(fc.models).toEqual(OPENAI_FACTCHECK_MODELS);
    await fc.retriever.retrieve(retrieveReq);
    expect(research.map((r) => r.model)).toEqual(['gpt-5']);

    const pd = perspectivesDepsForMode(client, { kind: 'openai' }, FIXTURE_LIST);
    expect(pd.models).toEqual(OPENAI_PERSPECTIVES_MODELS);
    expect(pd.searcher.model).toBe('gpt-5-mini');
    await pd.searcher.search(bucketReq);
    expect(research.at(-1)?.model).toBe('gpt-5-mini');
  });

  it('test_modes_compat_searches_with_provider', async () => {
    const { client, research, structured } = stubClient();
    const search = stubSearch();
    const mode: OwnKeyMode = { kind: 'openai-compatible', model: 'llama3.2', search };
    const models: string[] = [];
    await runFactcheck(
      POST,
      { ...factcheckDepsForMode(client, mode), nonce: NONCE, now: () => NOW },
      { onUsage: (u) => models.push(u.model) },
    );
    expect(research).toHaveLength(0);
    expect(search.queries).toHaveLength(3);
    expect(structured.map((r) => r.model)).toEqual(['llama3.2', 'llama3.2']);
    expect(models.length).toBeGreaterThanOrEqual(3);
    expect(new Set(models)).toEqual(new Set(['llama3.2']));
  });

  it('test_modes_compat_search_failure_tagged', async () => {
    const { client } = stubClient();
    const fail = new AIError('not-available', 'The search provider is not available.', { retryAfterMs: 5_000 });
    const mode: OwnKeyMode = { kind: 'openai-compatible', model: 'llama3.2', search: stubSearch(fail) };

    const fcErr = await rejection(runFactcheck(POST, { ...factcheckDepsForMode(client, mode), nonce: NONCE, now: () => NOW }));
    expect(fcErr).toBeInstanceOf(WebSearchFailure);
    expect(fcErr).toBeInstanceOf(AIError);
    expect(fcErr).toMatchObject({ provider: 'brave', code: 'not-available', retryAfterMs: 5_000, cause: fail });

    const pd = perspectivesDepsForMode(client, mode, FIXTURE_LIST);
    const pErr = await rejection(runPerspectives(LINK, { ...pd, nonce: NONCE, now: () => NOW }));
    expect(pErr).toBeInstanceOf(WebSearchFailure);
    expect(pErr).toMatchObject({ provider: 'brave', code: 'not-available' });
  });

  it('reference fact-check usage at the OpenAI models', () => {
    const at = (model: string, u: Partial<NormalizedUsage>) => costMicros(model, { ...ZERO_USAGE, ...u }) ?? Number.NaN;
    const total =
      at(OPENAI_FACTCHECK_MODELS.claims, { uncachedInput: 1_000, output: 100 }) +
      at(OPENAI_FACTCHECK_MODELS.research, { uncachedInput: 30_000, output: 1_500, webSearches: 3 }) +
      at(OPENAI_FACTCHECK_MODELS.verdict, { uncachedInput: 2_000, output: 400 });
    expect(total).toBe(89_450);
  });
});

describe('retriever', () => {
  it('test_ai_retriever_drops_blocked_sources', async () => {
    const { client } = stubClient({ sources: [source('s1', 'satire.example'), source('s2', 'news.example')] });
    const res = await aiRetriever(client, 'gpt-5').retrieve({ ...retrieveReq, blockedDomains: ['satire.example'] });
    expect(res.sources).toEqual([source('s2', 'news.example')]);
  });
});
