import { type AIClient, AIError, type StructuredRequest } from '@unalgorithm/ai';
import {
  costMicros,
  FACTCHECK_COST_CEILING_MICROS,
  type LinkStatus,
  type NormalizedUsage,
  type PostForAI,
  type RetrievedSource,
  ZERO_USAGE,
} from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import { type FactcheckDeps, type LinkChecker, runFactcheck } from '../src/factcheck.ts';
import type { Retriever } from '../src/retriever.ts';
import { type RawVerdict, validateVerdicts } from '../src/validate.ts';

const POST: PostForAI = {
  ref: 'p1',
  platform: 'linkedin',
  text: 'The bridge opened in 1932 and cost $10 million.',
  textComplete: true,
  authorKind: 'person',
  isReshare: false,
  media: 'none',
};

const input = (uncachedInput: number): NormalizedUsage => ({ ...ZERO_USAGE, uncachedInput });
/** Haiku input is 0.1 micros a token, Sonnet input 2. */
const CLAIMS_1K = input(10_000);
const RESEARCH_250K = input(125_000);
const SMALL = input(100);

function source(id: string, domain: string, snippets: string[], url = `https://${domain}/${id}`): RetrievedSource {
  return { id, url, domain, title: `Title ${id}`, pageAge: null, snippets };
}

const SOURCES: RetrievedSource[] = [
  source('s1', 'www.example.com', ['The bridge opened in 1932 after four years of work.']),
  source('s2', 'news.other.org', ['Officials confirmed the bridge opened in 1932.']),
  source('s3', 'third.net', ['Construction ended in 1932.']),
  source('s4', 'uncited.net', ['Nobody cites this page.']),
];

const SUPPORTED: RawVerdict = {
  claimId: 'c1',
  verdict: 'supported',
  explanation: 'Two outlets report the same opening year.',
  citations: [
    { sourceId: 's1', quote: 'The bridge opened in 1932' },
    { sourceId: 's2', quote: 'confirmed the bridge opened in 1932' },
  ],
};

interface Fake {
  claimsUsage?: NormalizedUsage;
  researchUsage?: NormalizedUsage;
  verdicts?: RawVerdict[];
  sources?: RetrievedSource[];
}

function setup(fake: Fake = {}, extra: Partial<FactcheckDeps> = {}) {
  const requests: StructuredRequest[] = [];
  let retrieves = 0;
  const usages: { model: string; failed: boolean }[] = [];
  const client: AIClient = {
    kind: 'fake',
    async structured(req) {
      requests.push(req);
      if (req.schemaName === 'factcheck_claims') {
        return {
          text: JSON.stringify({ claims: [{ claim: 'The bridge opened in 1932.' }] }),
          usage: fake.claimsUsage ?? SMALL,
          model: req.model,
          mode: 'json-schema',
        };
      }
      return {
        text: JSON.stringify({ verdicts: fake.verdicts ?? [SUPPORTED] }),
        usage: SMALL,
        model: req.model,
        mode: 'json-schema',
      };
    },
    async listModels() {
      return [];
    },
  };
  const retriever: Retriever = {
    retrieve: async () => {
      retrieves++;
      return { notes: 'c1: sources agree.', sources: fake.sources ?? SOURCES, usage: fake.researchUsage ?? SMALL, model: 'm' };
    },
  };
  const deps: FactcheckDeps = { client, retriever, nonce: 'abc12345', now: () => new Date('2026-10-15T12:00:00Z'), ...extra };
  return {
    run: () => runFactcheck(POST, deps, { onUsage: (u) => usages.push({ model: u.model, failed: u.failed }) }),
    verdictCalls: () => requests.filter((r) => r.schemaName === 'factcheck_verdicts').length,
    retrieves: () => retrieves,
    usages,
  };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AIError);
    return (e as AIError).code;
  }
  throw new Error('expected the run to fail');
}

function statuses(entries: Record<string, LinkStatus>): ReadonlyMap<string, LinkStatus> {
  return new Map(Object.entries(entries));
}

describe('cost ceiling', () => {
  it('test_ceiling_stops_before_research', async () => {
    const t = setup({ claimsUsage: input(20_000) }, { maxCostMicros: 1_000 });
    expect(await codeOf(t.run())).toBe('truncated');
    expect(t.retrieves()).toBe(0);
    expect(t.verdictCalls()).toBe(0);
  });

  it('test_ceiling_stops_before_verdict', async () => {
    expect(costMicros('claude-haiku-5-5', CLAIMS_1K)).toBe(1_000);
    expect(costMicros('claude-sonnet-5-5', RESEARCH_250K)).toBe(250_000);
    const t = setup({ claimsUsage: CLAIMS_1K, researchUsage: RESEARCH_250K }, { maxCostMicros: FACTCHECK_COST_CEILING_MICROS });
    expect(await codeOf(t.run())).toBe('truncated');
    expect(t.retrieves()).toBe(1);
    expect(t.verdictCalls()).toBe(0);
    expect(t.usages).toEqual([
      { model: 'claude-haiku-5-5', failed: false },
      { model: 'claude-sonnet-5-5', failed: false },
    ]);
  });

  it('test_ceiling_ignored_when_unpriced', async () => {
    const t = setup(
      { claimsUsage: input(1_000_000), researchUsage: input(1_000_000) },
      { maxCostMicros: 1, models: { claims: 'local-a', research: 'local-b', verdict: 'local-c' } },
    );
    const out = await t.run();
    expect(out.costMicros).toBeUndefined();
    expect(t.verdictCalls()).toBe(1);
    expect(out.result.claims[0]?.verdict).toBe('supported');
  });
});

describe('link check', () => {
  it('test_link_check_gets_cited_urls_once_in_order', async () => {
    const calls: (readonly string[])[] = [];
    const linkCheck: LinkChecker = async (urls) => {
      calls.push(urls);
      return new Map();
    };
    const sources = [
      ...SOURCES,
      // Same page as s1 under another id.
      source('s10', 'www.example.com', ['The bridge opened in 1932.'], 'https://www.example.com/s1'),
    ];
    const verdicts: RawVerdict[] = [
      {
        ...SUPPORTED,
        citations: [
          { sourceId: 's10', quote: 'The bridge opened in 1932' },
          { sourceId: 's3', quote: 'ended in 1932' },
          { sourceId: 's1', quote: 'The bridge opened in 1932' },
          { sourceId: 's9', quote: 'unknown source' },
          { sourceId: 's3', quote: 'Construction ended' },
        ],
      },
    ];
    await setup({ sources, verdicts }, { linkCheck }).run();
    expect(calls).toEqual([['https://www.example.com/s1', 'https://third.net/s3']]);
  });

  it('test_dead_link_citation_dropped_and_counted', async () => {
    const verdicts: RawVerdict[] = [
      {
        ...SUPPORTED,
        citations: [
          { sourceId: 's1', quote: 'The bridge opened in 1932' },
          { sourceId: 's2', quote: 'confirmed the bridge opened in 1932' },
          { sourceId: 's3', quote: 'ended in 1932' },
        ],
      },
    ];
    const linkCheck: LinkChecker = async () =>
      statuses({ 'https://www.example.com/s1': 'dead', 'https://news.other.org/s2': 'live', 'https://third.net/s3': 'unknown' });
    const out = await setup({ verdicts }, { linkCheck }).run();
    expect(out.result.claims[0]?.citations.map((c) => c.sourceId)).toEqual(['s2', 's3']);
    expect(out.result.sources.map((s) => s.id)).toEqual(['s2', 's3']);
    expect(out.result.claims[0]?.verdict).toBe('supported');
    expect(out.stats.deadLink).toBe(1);
    expect(out.stats.kept).toBe(2);
  });

  it('test_dead_link_can_downgrade_to_unverifiable', async () => {
    const linkCheck: LinkChecker = async () => statuses({ 'https://news.other.org/s2': 'dead' });
    const out = await setup({}, { linkCheck }).run();
    expect(out.result.claims[0]?.verdict).toBe('unverifiable');
    expect(out.result.claims[0]?.downgraded).toBe('too-few-domains');
    expect(out.stats.deadLink).toBe(1);
  });

  it('test_link_check_rejection_keeps_citations', async () => {
    const linkCheck: LinkChecker = async () => {
      throw new Error('checker broke');
    };
    const out = await setup({}, { linkCheck }).run();
    expect(out.result.claims[0]?.verdict).toBe('supported');
    expect(out.result.claims[0]?.citations).toHaveLength(2);
    expect(out.stats.deadLink).toBe(0);
  });

  it('test_link_check_hang_ends_at_deadline', async () => {
    const linkCheck: LinkChecker = () => new Promise(() => {});
    expect(await codeOf(setup({}, { linkCheck, deadlineMs: 50 }).run())).toBe('timeout');
  });

  it('test_validate_stats_add_up_with_dead_links', () => {
    const out = validateVerdicts({
      claims: [{ id: 'c1', text: 'The bridge opened in 1932.' }],
      sources: SOURCES,
      verdicts: [
        {
          ...SUPPORTED,
          citations: [
            { sourceId: 's1', quote: 'The bridge opened in 1932' },
            { sourceId: 's2', quote: 'confirmed the bridge opened in 1932' },
            { sourceId: 's9', quote: 'unknown source' },
            { sourceId: 's3', quote: 'not on the page' },
          ],
        },
      ],
      blocked: [],
      dead: new Set(['s1']),
    });
    const { raw, kept, unknownSource, deadLink, blockedSource, quoteTooLong, quoteMismatch, duplicate } = out.stats;
    expect(raw).toBe(4);
    expect({ kept, unknownSource, deadLink, quoteMismatch }).toEqual({
      kept: 1,
      unknownSource: 1,
      deadLink: 1,
      quoteMismatch: 1,
    });
    expect(kept + unknownSource + deadLink + blockedSource + quoteTooLong + quoteMismatch + duplicate).toBe(raw);
  });
});
