import { mockStructuredAnswer } from '@unalgorithm/ai/testing';
import {
  mockOpenAIResponsesFetch,
  type ResponsesRequestKind,
  researchResponse,
  structuredResponse,
} from '@unalgorithm/ai/testing/openai-responses';
import { neutralize } from '@unalgorithm/core';
import type { LinkStatus } from '@unalgorithm/protocol';
import type { LinkChecker } from '@unalgorithm/research';
import { FACTCHECK_EVAL_SET } from '@unalgorithm/research/eval';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, NO_REGISTRY, type TrustEvalDeps } from '../src/cli/trust-eval.ts';

/** The egress module with `createEgress` spied: its `checkLinks` answers every URL live, with no DNS or HTTP. */
const egress = vi.hoisted(() => ({
  checkLinks: vi.fn(async (urls: readonly string[]) => new Map(urls.map((u) => [u, 'live' as const]))),
  createEgress: vi.fn(),
}));
vi.mock('../src/net/egress.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/net/egress.ts')>();
  egress.createEgress.mockImplementation(() => ({ checkLinks: egress.checkLinks }));
  return { ...original, createEgress: egress.createEgress };
});

const globalFetch = vi.fn(async () => {
  throw new Error('a test reached the global fetch');
});

beforeEach(() => {
  globalFetch.mockClear();
  egress.createEgress.mockClear();
  egress.checkLinks.mockClear();
  vi.stubGlobal('fetch', globalFetch);
});

afterEach(() => {
  // test_trust_eval_never_uses_global_fetch (AC 10): no test may reach the network.
  expect(globalFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

const NOW = new Date('2026-10-15T12:00:00.000Z');

async function run(argv: string[], env: Record<string, string | undefined>, deps: TrustEvalDeps = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, env, { out: (l) => out.push(l), err: (l) => err.push(l), now: () => NOW, ...deps });
  return { code, out, err, all: [...out, ...err] };
}

/** The JSON report printed between the spend line (live) and the gate lines. */
function reportOf(out: string[]): Record<string, unknown> {
  const start = out.findIndex((l) => l.startsWith('{'));
  return JSON.parse(out[start] ?? '{}') as Record<string, unknown>;
}

const byId = new Map(FACTCHECK_EVAL_SET.map((i) => [i.id, i]));
const fenced = FACTCHECK_EVAL_SET.map((item) => ({ item, json: JSON.stringify(neutralize(item.post.text)).slice(1, -1) }));
const urlsOf = (id: string) => [`https://${id}.example.com/evidence`, `https://${id}.example.org/evidence`];

/**
 * OpenAI's side of `mockDepsFor`: claims tagged `[eval fc-NN]`, research over two `.example` sources whose cited
 * sentences are the quotes, verdict `expect[0]`.
 */
function openaiAnswer(kind: ResponsesRequestKind, body: unknown): unknown {
  const text = JSON.stringify(body);
  if (kind === 'claims') {
    const item = fenced.find((f) => text.includes(f.json))?.item;
    if (!item) throw new Error('claims for a post outside the eval set');
    return structuredResponse({ claims: [{ claim: `[eval ${item.id}] The main claim of this post.` }] });
  }
  const id = /\[eval (fc-\d+)\]/.exec(text)?.[1] ?? '';
  const item = byId.get(id);
  if (!item) throw new Error(`a ${kind} request outside the eval set`);
  if (kind === 'research') {
    const urls = urlsOf(id);
    const [a, b] = [1, 2].map((n) => `Records reviewed for item ${id} address this claim in source ${n}.`) as [string, string];
    const notes = `${a} ${b}`;
    return researchResponse({
      searches: [{ urls }],
      text: notes,
      citations: [
        { url: urls[0] ?? '', title: 'Evidence 1', start: 0, end: a.length },
        { url: urls[1] ?? '', title: 'Evidence 2', start: a.length + 1, end: notes.length },
      ],
    });
  }
  const citations = ['s1', 's2'].map((sourceId) => ({ sourceId, quote: `Records reviewed for item ${id}` }));
  const verdicts = [{ claimId: 'c1', verdict: item.expect[0], explanation: 'Mock verdict.', citations }];
  return structuredResponse({ verdicts }, { model: 'gpt-5' });
}

/** The OpenAI mock responder behind a `fetch` that also records every request's URL. */
function openaiFetch() {
  const inner = mockOpenAIResponsesFetch(openaiAnswer);
  const urls: string[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input instanceof Request ? input.url : input));
    return inner(input, init);
  });
  return Object.assign(fn as unknown as typeof fetch, { urls, bodies: inner.bodies, spy: fn });
}

const liveChecker = (dead: (url: string) => boolean = () => false): LinkChecker & { calls: number } => {
  const fn = async (urls: readonly string[]) => {
    fn.calls++;
    return new Map<string, LinkStatus>(urls.map((u) => [u, dead(u) ? 'dead' : 'live']));
  };
  fn.calls = 0;
  return fn;
};

describe('trust eval: offline', () => {
  it('test_trust_eval_offline_factcheck', async () => {
    const reads: PropertyKey[] = [];
    const env = new Proxy({} as Record<string, string | undefined>, {
      get: (_t, key) => {
        reads.push(key);
        return undefined;
      },
      has: (_t, key) => {
        reads.push(key);
        return false;
      },
    });
    const fetch = vi.fn();
    const { code, out } = await run(['--mode', 'openai'], env, { fetch: fetch as unknown as typeof globalThis.fetch });

    expect(code).toBe(0);
    const report = reportOf(out);
    expect(report).toMatchObject({ total: 56, provenance: 1, links: null });
    const gates = out.slice(-3);
    expect(gates).toEqual([
      'slant flip 1.00 (offline mock, not measured)',
      'provenance 1.00 (offline mock, not measured)',
      'live links none (offline mock, not measured)',
    ]);
    expect(out.join('\n')).not.toMatch(/PASSED|FAILED/);
    expect(fetch).not.toHaveBeenCalled();
    expect(reads).toEqual([]);
    expect(egress.createEgress).not.toHaveBeenCalled();
  });

  it('test_trust_eval_offline_perspectives', async () => {
    const { code, out } = await run(['--mode', 'compat', '--task', 'perspectives'], {});
    expect(code).toBe(0);
    expect(reportOf(out)).toMatchObject({ total: 10, provenance: 1, leanIntegrity: 1, links: null });
    expect(out.slice(-3)).toEqual([
      'provenance 1.00 (offline mock, not measured)',
      'lean integrity 1.00 (offline mock, not measured)',
      'live links none (offline mock, not measured)',
    ]);
  });
});

describe('trust eval: live on mocked transports', () => {
  it('test_trust_eval_live_needs_keys', async () => {
    const fetch = openaiFetch();
    const a = await run(['--mode', 'anthropic', '--live'], { OPENAI_API_KEY: 'sk-other-secret' }, { fetch });
    expect(a.code).toBe(2);
    expect(a.err.join('\n')).toContain('ANTHROPIC_API_KEY');

    const secret = 'sk-compat-secret-value';
    const c = await run(
      ['--mode', 'compat', '--live'],
      { COMPAT_BASE_URL: 'http://ai.example/v1', COMPAT_MODEL: 'llama3.2', COMPAT_API_KEY: secret, SEARCH_PROVIDER: 'brave' },
      { fetch },
    );
    expect(c.code).toBe(2);
    expect(c.err.join('\n')).toContain('SEARCH_API_KEY');
    for (const line of [...a.all, ...c.all]) {
      expect(line).not.toContain(secret);
      expect(line).not.toContain('sk-other-secret');
    }
    expect(fetch.spy).not.toHaveBeenCalled();
  });

  it('test_trust_eval_live_openai_spend_line_and_hosts', async () => {
    const fetch = openaiFetch();
    const linkCheck = liveChecker();
    const { out } = await run(['--mode', 'openai', '--live', '--all'], { OPENAI_API_KEY: 'sk-test-key' }, { fetch, linkCheck });

    expect(out[0]).toBe('Live run: 56 checks on openai, about $5.04 on your OpenAI account.');
    expect(fetch.urls.length).toBeGreaterThan(0);
    for (const url of fetch.urls) expect(new URL(url).hostname).toBe('api.openai.com');
    const research = fetch.bodies.filter((b) => Array.isArray(b.tools));
    expect(research).toHaveLength(56);
    for (const body of research) expect(body.model).toBe('gpt-5');
    expect(out.join('\n')).not.toContain('sk-test-key');
  });

  it('test_trust_eval_live_compat_hosts', async () => {
    const urls: string[] = [];
    const tokens: (string | null)[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      urls.push(url);
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.startsWith('https://api.search.brave.com/')) {
        tokens.push(new Headers(init.headers).get('x-subscription-token'));
        return json({ web: { results: [{ url: 'https://news.example/a', title: 'A', description: 'The record says so.' }] } });
      }
      const body = JSON.parse(String(init.body)) as { model: string; messages: { role: string; content: string }[] };
      const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
      return json({
        choices: [{ message: { content: JSON.stringify(mockStructuredAnswer(user).json) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
        model: body.model,
      });
    });
    const env = {
      COMPAT_BASE_URL: 'http://ai.example:11434/v1',
      COMPAT_MODEL: 'llama3.2',
      SEARCH_PROVIDER: 'brave',
      SEARCH_API_KEY: 'brave-test-token',
    };
    const smoke = FACTCHECK_EVAL_SET.filter((i) => i.smoke).length;
    const { out } = await run(['--mode', 'compat', '--live'], env, {
      fetch: fetch as unknown as typeof globalThis.fetch,
      linkCheck: liveChecker(),
    });

    expect(out[0]).toBe(
      `Live run: ${smoke} checks on compat: your endpoint's own price, plus up to ${3 * smoke} searches on your Brave key.`,
    );
    const ai = urls.filter((u) => !u.startsWith('https://api.search.brave.com/'));
    expect(ai.length).toBeGreaterThan(0);
    for (const url of ai) expect(url.startsWith('http://ai.example:11434/v1/')).toBe(true);
    expect(tokens.length).toBeGreaterThan(0);
    expect(new Set(tokens)).toEqual(new Set(['brave-test-token']));
    expect(out.join('\n')).not.toContain('brave-test-token');
  });

  it('test_trust_eval_live_links_gate', async () => {
    const env = { OPENAI_API_KEY: 'sk-test-key' };
    const deadItems = ['fc-01', 'fc-02', 'fc-03'];
    const dead = await run(['--mode', 'openai', '--live', '--all'], env, {
      fetch: openaiFetch(),
      linkCheck: liveChecker((u) => deadItems.some((id) => u.startsWith(`https://${id}.`))),
    });
    expect(reportOf(dead.out)).toMatchObject({ pairsScored: 20, pairConsistency: 1, provenance: 1 });
    expect(reportOf(dead.out).links).toEqual({ live: 106, dead: 6, unknown: 0 });
    expect(dead.out.slice(-3)).toEqual([
      'slant flip 1.00 (min 0.95) PASSED',
      'provenance 1.00 PASSED',
      'live links 0.95 (min 0.97) FAILED',
    ]);
    expect(dead.code).toBe(1);

    const live = await run(['--mode', 'openai', '--live', '--all'], env, { fetch: openaiFetch(), linkCheck: liveChecker() });
    expect(live.out.at(-1)).toBe('live links 1.00 (min 0.97) PASSED');
    expect(live.code).toBe(0);
  });

  it('smoke gates read not measured', async () => {
    const { code, out } = await run(
      ['--mode', 'openai', '--live'],
      { OPENAI_API_KEY: 'sk-test-key' },
      {
        fetch: openaiFetch(),
        linkCheck: liveChecker(),
      },
    );
    expect(out.slice(-3)).toEqual([
      'slant flip not measured (smoke run)',
      'provenance not measured (smoke run)',
      'live links not measured (smoke run)',
    ]);
    expect(code).toBe(0);
  });

  it('test_trust_eval_perspectives_needs_reviewed_registry', async () => {
    const fetch = openaiFetch();
    const { code, err } = await run(
      ['--mode', 'openai', '--task', 'perspectives', '--live'],
      { OPENAI_API_KEY: 'sk-k' },
      {
        fetch,
      },
    );
    expect(code).toBe(2);
    expect(err).toEqual([NO_REGISTRY]);
    expect(NO_REGISTRY).toBe('UnEcho Chamber needs a reviewed outlet registry; this build has none.');
    expect(fetch.spy).not.toHaveBeenCalled();
  });

  it('test_trust_eval_uses_egress_link_check', async () => {
    const { code } = await run(['--mode', 'openai', '--live'], { OPENAI_API_KEY: 'sk-test-key' }, { fetch: openaiFetch() });
    expect(code).toBe(0);
    expect(egress.createEgress).toHaveBeenCalledTimes(1);
    expect(egress.createEgress.mock.calls[0]?.[0]).toMatchObject({ publicUrl: 'http://localhost' });
    expect(egress.checkLinks).toHaveBeenCalled();
    for (const [urls] of egress.checkLinks.mock.calls) for (const url of urls) expect(url).toMatch(/\.example\.(com|org)\//);
  });
});

describe('trust eval: arguments', () => {
  it('test_trust_eval_usage_errors', async () => {
    for (const argv of [
      ['--mode', 'openai', '--all'],
      ['--mode', 'gemini'],
      ['--mode', 'openai', '--task', 'foo'],
      [],
      ['--mode', 'openai', '--verbose'],
    ]) {
      const { code, err, out } = await run(argv, {});
      expect(code, argv.join(' ')).toBe(2);
      expect(err.join('\n')).toContain('usage: pnpm eval:trust --mode anthropic|openai|compat');
      expect(out).toEqual([]);
    }
  });
});
