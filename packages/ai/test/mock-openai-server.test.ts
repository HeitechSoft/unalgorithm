import { buildInterestProfile, defaultSettings } from '@unalgorithm/core';
import type { PostForAI } from '@unalgorithm/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyPosts, memoryCapabilities, openaiCompatibleClient } from '../src/index.ts';
import { fencedBlocks, fencedPosts, fencedSourceLines } from '../src/testing/fenced-posts.ts';
import { type MockOpenAI, type MockOpenAIOptions, startMockOpenAI } from '../src/testing/mock-openai-server.ts';

const profile = buildInterestProfile(defaultSettings());

const post = (ref: string, text: string): PostForAI => ({
  ref,
  platform: 'linkedin',
  text,
  textComplete: true,
  authorKind: 'person',
  isReshare: false,
  media: 'none',
});

let mock: MockOpenAI | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function start(opts?: MockOpenAIOptions): Promise<MockOpenAI> {
  mock = await startMockOpenAI(opts);
  return mock;
}

function classify(m: MockOpenAI, posts: PostForAI[]) {
  const client = openaiCompatibleClient({ baseUrl: m.baseUrl, capabilities: memoryCapabilities() });
  return classifyPosts(client, posts, { model: 'mock-model', profile });
}

/** The classification for one ref, failing the test if that post did not succeed. */
function okFor(out: Awaited<ReturnType<typeof classify>>, ref: string) {
  const o = out.byRef.get(ref);
  if (!o?.ok) throw new Error(`${ref} was not classified: ${o?.error.code ?? 'missing'}`);
  return o.classification;
}

describe('startup and models', () => {
  it('test_mock_starts_on_random_loopback_port', async () => {
    const m = await start();
    expect(m.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(m.url).not.toMatch(/:0$/);
    expect(m.baseUrl).toBe(`${m.url}/v1`);
  });

  it('test_mock_lists_mock_model', async () => {
    const m = await start();
    const res = await fetch(`${m.baseUrl}/models`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: 'mock-model' }] });
  });
});

describe('classification', () => {
  it('test_mock_default_verdicts_through_compat_client', async () => {
    const m = await start();
    const out = await classify(m, [post('p1', 'AI agents at work'), post('p2', 'Lunch photos')]);
    const ai = okFor(out, 'p1');
    const lunch = okFor(out, 'p2');
    expect(ai).toMatchObject({ relevance: 92, topics: ['automation'], noise: [], reason: 'Test verdict.' });
    expect(lunch).toMatchObject({ relevance: 40, topics: ['other'], noise: [], isNews: false, hasCheckableClaims: false });
    expect(out.model).toBe('mock-model');
  });

  it('test_mock_reports_fixed_usage', async () => {
    const m = await start();
    const out = await classify(m, [post('p1', 'AI agents at work'), post('p2', 'Lunch photos')]);
    expect(out.calls).toBe(1);
    expect(out.usage).toEqual({
      uncachedInput: 1000,
      cacheRead: 0,
      cacheWrite: 0,
      output: 100,
      webSearches: 0,
      estimated: false,
    });
  });

  it('test_mock_answers_any_post_id', async () => {
    const m = await start();
    const out = await classify(m, [post('pk_abc', 'Automating invoices'), post('p7', 'Lunch photos')]);
    expect(okFor(out, 'pk_abc').relevance).toBe(92);
    expect(okFor(out, 'p7').relevance).toBe(40);
  });

  it('test_mock_custom_verdict', async () => {
    const m = await start({ verdict: () => ({ relevance: 10, noise: ['engagement-bait'], topics: ['x'] }) });
    const out = await classify(m, [post('p1', 'AI agents at work')]);
    expect(okFor(out, 'p1')).toMatchObject({ relevance: 10, noise: ['engagement-bait'], topics: ['x'] });
  });
});

describe('failure and lifecycle', () => {
  it('test_mock_fail_next_is_one_shot', async () => {
    const m = await start();
    m.failNext(500, 'echo: secret text');
    const posts = [post('p1', 'AI agents at work'), post('p2', 'Lunch photos')];
    const failed = await classify(m, posts);
    for (const ref of ['p1', 'p2']) {
      const o = failed.byRef.get(ref);
      expect(o?.ok).toBe(false);
      if (o && !o.ok) {
        expect(o.error.code).toBe('overloaded');
        expect(o.error.message).toContain('echo: secret text');
      }
    }
    const next = await classify(m, posts);
    expect(okFor(next, 'p1').relevance).toBe(92);
    expect(okFor(next, 'p2').relevance).toBe(40);
  });

  it('test_mock_fail_next_sends_raw_body', async () => {
    const m = await start();
    m.failNext(500, 'echo: secret text');
    const res = await fetch(`${m.baseUrl}/chat/completions`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('echo: secret text');
  });

  it('test_mock_records_bodies', async () => {
    const m = await start();
    await classify(m, [post('p1', 'AI agents at work')]);
    m.failNext(503, 'busy');
    await classify(m, [post('p2', 'Lunch photos')]);
    await classify(m, [post('p3', 'Lunch photos'), post('p4', 'More lunch')]);
    await fetch(`${m.baseUrl}/models`);
    expect(m.bodies).toHaveLength(3);
    for (const b of m.bodies) expect(JSON.parse(b)).toMatchObject({ model: 'mock-model', messages: expect.any(Array) });
    expect(m.bodies[1]).toContain('Lunch photos');
  });

  it('test_mock_close_releases_port', async () => {
    const m = await start();
    await fetch(`${m.baseUrl}/models`);
    await expect(m.close()).resolves.toBeUndefined();
    await expect(fetch(`${m.baseUrl}/models`)).rejects.toThrow();
  }, 15_000);
});

describe('fenced block scanners', () => {
  it('test_fenced_scanners_read_prompt_tags', () => {
    const user = [
      'Nonce: N1',
      '<post_N1 id="p1" kind="x">\nfirst post\nsecond line\n</post_N1>',
      '<post_N1 id="">\nempty id\n</post_N1>',
      '<post_N1 id="p2">same line</post_N1>',
      '<post_N1 id="p3">\n\n</post_N1>',
      '<source_N1 id="s1" url="https://a.example/">\nAlpha text\nmore</source_N1>',
      '<source_N1 id="x2">\nnot a source id\n</source_N1>',
      '<source_N1 id="s22">\nBeta',
    ].join('\n');
    expect(fencedPosts(user)).toEqual([
      { id: 'p1', text: 'first post\nsecond line' },
      { id: 'p3', text: '' },
    ]);
    expect(fencedBlocks(user, 'post').map((b) => b.body)).toEqual(['first post\nsecond line', 'empty id', '']);
    expect(fencedBlocks(user, 'post')[0]?.attrs).toBe(' id="p1" kind="x"');
    expect(fencedSourceLines(user)).toEqual([
      { id: 's1', line: 'Alpha text' },
      { id: 's22', line: 'Beta' },
    ]);
  });

  it('test_fenced_scanners_linear_on_hostile_input', () => {
    const hostile = [
      '<post_a id="p'.repeat(20_000),
      '<post_a\n'.repeat(20_000),
      `${'<post_a>\n'.repeat(20_000)}x`,
      '<source_a id="s1"'.repeat(20_000),
      '<link_a'.repeat(20_000),
    ];
    for (const text of hostile) {
      const started = performance.now();
      fencedPosts(text);
      fencedBlocks(text, 'post');
      fencedBlocks(text, 'link');
      fencedSourceLines(text);
      expect(performance.now() - started).toBeLessThan(100);
    }
  });
});
