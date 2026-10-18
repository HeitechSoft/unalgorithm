import { AIError, memoryCapabilities, openaiCompatibleClient } from '@unalgorithm/ai';
import { startMockOpenAI } from '@unalgorithm/ai/testing';
import { FIXTURE_LIST } from '@unalgorithm/outlets/testing';
import { costMicros, LEAN_BUCKETS, PerspectivesResultSchema, type SharedLink, ZERO_USAGE } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import { fakeSearcher, MOCK_NONCE, MOCK_NOW, mockClient, userText } from '../eval/perspectives-score.ts';
import type { BucketSearcher } from '../src/coverage.ts';
import {
  canonicalLink,
  PERSPECTIVES_MODELS,
  type PerspectivesDeps,
  type PerspectivesOptions,
  runPerspectives,
  storyWindow,
} from '../src/perspectives.ts';
import { COMPARISON_SYSTEM, PERSPECTIVES_PROMPT_VERSION, STORY_SYSTEM } from '../src/perspectives-prompts.ts';

const NONCE = MOCK_NONCE;
const NOW = MOCK_NOW;
const LINK: SharedLink = { url: 'https://news.example.com/2026/10/14/council-bridge', title: 'Council approves the bridge' };
const LEAN_WORDS = /\b(left|right|lean|leans|center|centre|liberal|conservative)\b/i;

type Log = string[];

function systemText(body: Record<string, unknown>): string {
  return Array.isArray(body.system) ? body.system.map((b: { text?: string }) => b.text ?? '').join('') : String(body.system);
}

function deps(client: PerspectivesDeps['client'], searcher: BucketSearcher, over: Partial<PerspectivesDeps> = {}) {
  return { client, searcher, registry: FIXTURE_LIST, now: () => NOW, nonce: NONCE, ...over } satisfies PerspectivesDeps;
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('runPerspectives: input and link', () => {
  it('test_perspectives_refuses_non_link_input', async () => {
    const bad = [{ ...LINK, text: 'Read this outrageous story!' }, { url: 'ftp://news.example.com/story' }, { url: 'not a url' }];
    for (const link of bad) {
      const { client, kinds } = mockClient();
      const searcher = fakeSearcher();
      const err = await rejection(runPerspectives(link as SharedLink, deps(client, searcher)));
      expect(err).toBeInstanceOf(AIError);
      expect(err).toMatchObject({ code: 'bad-request', message: 'This link cannot be compared.' });
      expect(kinds).toEqual([]);
      expect(searcher.calls).toEqual([]);
    }
  });

  it('test_canonical_link_strips_tracking', () => {
    expect(canonicalLink('HTTPS://News.Example.com:443/a?utm_source=x&id=7&fbclid=y&li_fat_id=z&msclkid=w#top')).toBe(
      'https://news.example.com/a?id=7',
    );
    expect(canonicalLink('https://news.example.com/a?utm_medium=x&gclid=1')).toBe('https://news.example.com/a');
    expect(canonicalLink('ftp://news.example.com/a')).toBeNull();
    expect(canonicalLink('not a url')).toBeNull();
    expect(canonicalLink(`https://news.example.com/${'a'.repeat(2048)}`)).toBeNull();
  });

  it('test_story_window_anchor', () => {
    expect(storyWindow('https://news.example.com/2026/10/10/story', NOW)).toEqual({
      from: new Date('2026-10-07T00:00:00Z'),
      to: new Date('2026-10-13T00:00:00Z'),
    });
    const undated = { from: new Date('2026-10-12T12:00:00Z'), to: NOW };
    expect(storyWindow('https://news.example.com/story', NOW)).toEqual(undated);
    expect(storyWindow('https://news.example.com/2026/10/20/story', NOW)).toEqual(undated);
  });

  it('test_perspectives_resolved_link_used', async () => {
    const resolved = await runPerspectives(
      LINK,
      deps(mockClient().client, fakeSearcher(), { resolveLink: async () => 'https://news.example.com/final?utm_medium=x' }),
    );
    expect(resolved.result.story.url).toBe('https://news.example.com/final');

    const failing = await runPerspectives(
      LINK,
      deps(mockClient().client, fakeSearcher(), { resolveLink: () => Promise.reject(new Error('network down')) }),
    );
    expect(failing.result.story.url).toBe(LINK.url);

    const refused = await runPerspectives(
      LINK,
      deps(mockClient().client, fakeSearcher(), { resolveLink: async () => 'ftp://x' }),
    );
    expect(refused.result.story.url).toBe(LINK.url);

    const controller = new AbortController();
    const reason = new Error('cancelled by the user');
    const { client, kinds } = mockClient();
    const usage: unknown[] = [];
    const err = await rejection(
      runPerspectives(
        LINK,
        deps(client, fakeSearcher(), {
          resolveLink: async () => {
            controller.abort(reason);
            return null;
          },
        }),
        { signal: controller.signal, onUsage: (u) => usage.push(u) },
      ),
    );
    expect(err).toBe(reason);
    expect(kinds).toEqual([]);
    expect(usage).toEqual([]);
  });
});

describe('runPerspectives: pipeline', () => {
  it('test_perspectives_steps_and_gaps', async () => {
    const log: Log = [];
    const { client } = mockClient({ log });
    const searcher = fakeSearcher({ buckets: ['left', 'center', 'right'], log });
    const run = await runPerspectives(LINK, deps(client, searcher));

    expect(log).toEqual(['story', 'search', 'search', 'search', 'search', 'search', 'comparison']);
    expect(PerspectivesResultSchema.safeParse(run.result).success).toBe(true);
    const byBucket = Object.fromEntries(run.result.coverage.map((c) => [c.bucket, c.sourceIds]));
    expect(byBucket).toEqual({ left: ['s1'], 'lean-left': [], center: ['s2'], 'lean-right': [], right: ['s3'] });
    expect(run.result).toMatchObject({
      v: 1,
      checkedAt: NOW.toISOString(),
      model: 'claude-sonnet-5-5',
      registryVersion: FIXTURE_LIST.version,
      story: { url: LINK.url, query: 'council bridge vote', from: '2026-10-11T00:00:00.000Z', to: NOW.toISOString() },
    });
    expect(run.result.agreed).toHaveLength(1);
    expect(run.stats.comparison?.tooFewBuckets).toBe(false);
    for (const call of searcher.calls) expect(call).toMatchObject({ query: 'council bridge vote', nonce: NONCE });
  });

  it('test_perspectives_result_names_its_list', async () => {
    const run = await runPerspectives(LINK, deps(mockClient().client, fakeSearcher({ buckets: ['left', 'center', 'right'] })));
    expect(run.result).toMatchObject({ list: 'cloud', registryVersion: '1' });
    expect(PerspectivesResultSchema.parse(run.result)).toEqual(run.result);

    // A person's own list: its kind and version, whatever its outlets.
    const own = { ...FIXTURE_LIST, kind: 'own' as const, version: '7' };
    const empty = await runPerspectives(LINK, deps(mockClient().client, fakeSearcher(), { registry: own }));
    expect(empty.result).toMatchObject({ list: 'own', registryVersion: '7', sources: [] });

    expect(PerspectivesResultSchema.safeParse({ ...run.result, list: 'panel' }).success).toBe(false);
    const { list: _list, ...unnamed } = run.result;
    expect(PerspectivesResultSchema.safeParse(unnamed).success).toBe(false);
  });

  it('test_perspectives_no_coverage_skips_comparison', async () => {
    const { client, kinds } = mockClient();
    const run = await runPerspectives(LINK, deps(client, fakeSearcher()));
    expect(kinds).toEqual(['story']);
    expect(run.result.coverage).toEqual(LEAN_BUCKETS.map((bucket) => ({ bucket, sourceIds: [] })));
    expect(run.result).toMatchObject({ model: 'claude-haiku-5-5', agreed: [], differences: [], unique: [], sources: [] });
    expect(run.stats.comparison).toBeNull();
    expect(PerspectivesResultSchema.safeParse(run.result).success).toBe(true);
  });

  it('test_perspectives_query_fallback', async () => {
    const run = await runPerspectives(LINK, deps(mockClient({ query: '   ' }).client, fakeSearcher()));
    expect(run.result.story.query).toBe(LINK.title);

    const { client, kinds } = mockClient({ query: '' });
    const searcher = fakeSearcher();
    const usage: { model: string }[] = [];
    const err = await rejection(runPerspectives({ url: LINK.url }, deps(client, searcher), { onUsage: (u) => usage.push(u) }));
    expect(err).toMatchObject({ code: 'bad-request', message: 'This link has no story to compare.' });
    expect(kinds).toEqual(['story']);
    expect(usage).toEqual([expect.objectContaining({ model: PERSPECTIVES_MODELS.query, failed: false })]);
    expect(searcher.calls).toEqual([]);
  });
});

describe('runPerspectives: privacy and neutrality', () => {
  it('test_perspectives_requests_carry_only_link_and_no_lean', async () => {
    const { client, fetch } = mockClient();
    await runPerspectives(LINK, deps(client, fakeSearcher({ buckets: ['left', 'center', 'right'] })));
    const [storyBody, comparisonBody] = fetch.bodies;
    if (!storyBody || !comparisonBody) throw new Error('expected two requests');

    expect(userText(storyBody)).toBe(
      `Nonce: ${NONCE}\nWrite a neutral search query for the story behind this link.\n\n` +
        `<link_${NONCE} url="${LINK.url}">\n${LINK.title}\n</link_${NONCE}>`,
    );

    const user = userText(comparisonBody);
    const tags = [...user.matchAll(new RegExp(`<source_${NONCE} ([^>]*)>`, 'g'))];
    expect(tags).toHaveLength(3);
    for (const [, attrs = ''] of tags) {
      expect([...attrs.matchAll(/(\w+)="[^"]*"/g)].map((m) => m[1])).toEqual(['id', 'outlet', 'domain', 'title', 'date']);
    }
    const outside = user.replace(new RegExp(`<source_${NONCE} [\\s\\S]*?</source_${NONCE}>`, 'g'), '');
    for (const text of [outside, systemText(comparisonBody), systemText(storyBody), STORY_SYSTEM, COMPARISON_SYSTEM]) {
      expect(text).not.toMatch(LEAN_WORDS);
      for (const bucket of LEAN_BUCKETS) expect(text).not.toMatch(new RegExp(`\\b${bucket}\\b`, 'i'));
    }
    expect(comparisonBody.tools).toBeUndefined();
  });
});

describe('runPerspectives: limits', () => {
  it('test_perspectives_ceiling_deadline_abort', async () => {
    const storyCost = costMicros(PERSPECTIVES_MODELS.query, { ...ZERO_USAGE, uncachedInput: 1_000, output: 100 }) ?? 0;
    const ceilingSearcher = fakeSearcher();
    const ceiling = await rejection(
      runPerspectives(LINK, deps(mockClient().client, ceilingSearcher, { maxCostMicros: storyCost - 1 })),
    );
    expect(ceiling).toMatchObject({ code: 'truncated' });
    expect(ceilingSearcher.calls).toEqual([]);

    const hanging = fakeSearcher({ hang: true });
    const timeout = await rejection(runPerspectives(LINK, deps(mockClient().client, hanging, { deadlineMs: 50 })));
    expect(timeout).toMatchObject({ code: 'timeout' });
    expect(hanging.calls).toHaveLength(5);

    const reason = new Error('stopped');
    const controller = new AbortController();
    const { client, kinds } = mockClient({ delayMs: 20 });
    const pending = runPerspectives(LINK, deps(client, fakeSearcher()), { signal: controller.signal });
    controller.abort(reason);
    expect(await rejection(pending)).toBe(reason);
    expect(kinds).toEqual([]);
  });

  it('test_perspectives_usage_and_cost', async () => {
    const reports: Parameters<NonNullable<PerspectivesOptions['onUsage']>>[0][] = [];
    const run = await runPerspectives(LINK, deps(mockClient().client, fakeSearcher({ buckets: ['left', 'center', 'right'] })), {
      onUsage: (u) => reports.push(u),
    });
    expect(reports.map((r) => r.model)).toEqual([
      PERSPECTIVES_MODELS.query,
      ...Array(5).fill(PERSPECTIVES_MODELS.search),
      PERSPECTIVES_MODELS.compare,
    ]);
    const sum = reports.reduce((acc, r) => acc + (costMicros(r.model, r.usage) ?? Number.NaN), 0);
    expect(run.costMicros).toBe(sum);
    expect(run.costMicros).toBeGreaterThan(0);

    const provider = await runPerspectives(LINK, deps(mockClient().client, fakeSearcher({ usage: ZERO_USAGE })));
    expect(provider.costMicros).toBe(costMicros(PERSPECTIVES_MODELS.query, { ...ZERO_USAGE, uncachedInput: 1_000, output: 100 }));
  });
});

describe('runPerspectives: self-hosted mock', () => {
  it('test_perspectives_through_mock_openai_server', async () => {
    const mock = await startMockOpenAI();
    try {
      const client = openaiCompatibleClient({ baseUrl: mock.baseUrl, capabilities: memoryCapabilities() });
      const models = { query: 'mock-model', compare: 'mock-model' };
      const run = await runPerspectives(LINK, deps(client, fakeSearcher({ buckets: ['left', 'center', 'right'] }), { models }));
      expect(mock.bodies).toHaveLength(2);
      expect(run.result.story.query).toBe(LINK.title);
      expect(run.result.agreed).toHaveLength(1);
      expect(run.result.coverage.filter((c) => c.sourceIds.length > 0)).toHaveLength(3);
      expect(PerspectivesResultSchema.safeParse(run.result).success).toBe(true);
    } finally {
      await mock.close();
    }
  });
});

describe('runPerspectives: the UnEcho Chamber rename (P3-63)', () => {
  it('test_perspectives_prompt_version_unchanged_by_rename', () => {
    // The rename touched only names people read; no prompt text names the feature, so the prompts are unchanged.
    expect(PERSPECTIVES_PROMPT_VERSION).toBe(1);
  });
});
