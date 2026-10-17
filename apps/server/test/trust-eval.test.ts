import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mockStructuredAnswer } from '@unalgorithm/ai/testing';
import { mockAnthropicFetch, researchMessage, structuredMessage } from '@unalgorithm/ai/testing/anthropic';
import {
  mockOpenAIResponsesFetch,
  type ResponsesRequestKind,
  researchResponse,
  structuredResponse,
} from '@unalgorithm/ai/testing/openai-responses';
import { neutralize } from '@unalgorithm/core';
import { FIXTURE_LIST, FIXTURE_OFFICIAL_LIST } from '@unalgorithm/outlets/testing';
import type { LinkStatus } from '@unalgorithm/protocol';
import { FACTCHECK_PROMPT_VERSION, type LinkChecker, PERSPECTIVES_PROMPT_VERSION } from '@unalgorithm/research';
import { FACTCHECK_EVAL_SET, type FactcheckEvalReport, trustGates } from '@unalgorithm/research/eval';
import { type PerspectivesEvalReport, perspectivesTrustGates } from '@unalgorithm/research/eval/perspectives';
import { type EvalRecord, EvalRecordSchema, parseEvalResults } from '@unalgorithm/research/eval/results';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BAD_LIST, EMPTY_LIST, main, NO_REGISTRY, type TrustEvalDeps } from '../src/cli/trust-eval.ts';
import { SERVER_VERSION } from '../src/config.ts';

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

/** An empty environment that records every variable read. */
function watchedEnv(): { env: Record<string, string | undefined>; reads: PropertyKey[] } {
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
  return { env, reads };
}

/**
 * Anthropic's side of `mockDepsFor`, on `mockAnthropicFetch`: claims tagged `[eval fc-NN]`, one web search finding two
 * `.example` sources whose cited passages hold the quotes, verdict `expect[0]`. `failFor` answers that item's claims
 * request with a refused key (a provider error).
 */
function anthropicFetch(failFor?: string) {
  const ok = (body: unknown) => ({ status: 200, body });
  return mockAnthropicFetch((body, kind) => {
    const text = JSON.stringify(body);
    if (kind === 'claims') {
      const item = fenced.find((f) => text.includes(f.json))?.item;
      if (!item) throw new Error('claims for a post outside the eval set');
      if (item.id === failFor) {
        return { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } };
      }
      return ok(structuredMessage({ claims: [{ claim: `[eval ${item.id}] The main claim of this post.` }] }));
    }
    const id = /\[eval (fc-\d+)\]/.exec(text)?.[1] ?? '';
    const item = byId.get(id);
    if (!item) throw new Error(`a ${kind} request outside the eval set`);
    if (kind === 'research') {
      const urls = urlsOf(id);
      return ok(
        researchMessage({
          results: urls.map((url, i) => ({ url, title: `Evidence ${i + 1}` })),
          notes: urls.map((url, i) => ({
            text: `Source ${i + 1} addresses the claim.`,
            cites: [{ url, citedText: `Records reviewed for item ${id} address this claim in source ${i + 1}.` }],
          })),
        }),
      );
    }
    const citations = ['s1', 's2'].map((sourceId) => ({ sourceId, quote: `Records reviewed for item ${id}` }));
    const verdicts = [{ claimId: 'c1', verdict: item.expect[0], explanation: 'Mock verdict.', citations }];
    return ok(structuredMessage({ verdicts }, { model: 'claude-sonnet-5-5' }));
  });
}

/** An OpenAI-compatible endpoint (the shared structured mock) and Brave, on one `fetch` that records URLs and tokens. */
function compatFetch() {
  const urls: string[] = [];
  const tokens: (string | null)[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
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
  return { fetch: fn as unknown as typeof globalThis.fetch, urls, tokens };
}

/** A results file in a fresh temporary directory, holding `text`. */
async function resultsFileWith(text: string): Promise<{ url: URL; read: () => Promise<string>; remove: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'unalgorithm-eval-results-'));
  const file = join(dir, 'results.json');
  await writeFile(file, text, 'utf8');
  return {
    url: pathToFileURL(file),
    read: () => readFile(file, 'utf8'),
    remove: () => rm(dir, { recursive: true, force: true }),
  };
}

/** A saved copy of a server's `/outlets.json` (by default the fictional fixture's) in a fresh temporary directory. */
async function listFileWith(content: unknown = FIXTURE_OFFICIAL_LIST): Promise<{ path: string; remove: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'unalgorithm-eval-list-'));
  const path = join(dir, 'outlets.json');
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return { path, remove: () => rm(dir, { recursive: true, force: true }) };
}

describe('trust eval: offline', () => {
  it('test_trust_eval_offline_factcheck', async () => {
    const { env, reads } = watchedEnv();
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
    const { fetch, urls, tokens } = compatFetch();
    const env = {
      COMPAT_BASE_URL: 'http://ai.example:11434/v1',
      COMPAT_MODEL: 'llama3.2',
      SEARCH_PROVIDER: 'brave',
      SEARCH_API_KEY: 'brave-test-token',
    };
    const smoke = FACTCHECK_EVAL_SET.filter((i) => i.smoke).length;
    const { out } = await run(['--mode', 'compat', '--live'], env, { fetch, linkCheck: liveChecker() });

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

  it('test_trust_eval_perspectives_needs_a_list', async () => {
    expect(NO_REGISTRY).toBe(
      "UnEcho Chamber needs a source list with leans: pass --list <file>, a saved copy of a server's /outlets.json.",
    );
    for (const mode of ['anthropic', 'openai']) {
      const { env, reads } = watchedEnv();
      const fetch = openaiFetch();
      const { code, out, err } = await run(['--mode', mode, '--task', 'perspectives', '--live'], env, { fetch });
      expect(code, mode).toBe(2);
      expect(err).toEqual([NO_REGISTRY]);
      expect(out).toEqual([]);
      // Before any key is read or anything is sent.
      expect(reads).toEqual([]);
      expect(fetch.spy).not.toHaveBeenCalled();
    }
  });

  it('test_trust_eval_reads_list_file', async () => {
    // The fixture without its Right outlets, at a version of its own: the run uses exactly what the file holds.
    const noRight = {
      ...FIXTURE_OFFICIAL_LIST,
      version: '42',
      outlets: FIXTURE_OFFICIAL_LIST.outlets.filter((o) => o.lean?.bucket !== 'right'),
    };
    const list = await listFileWith(noRight);
    const env = {
      COMPAT_BASE_URL: 'http://ai.example:11434/v1',
      COMPAT_MODEL: 'm',
      SEARCH_PROVIDER: 'brave',
      SEARCH_API_KEY: 'k',
    };
    try {
      const compat = compatFetch();
      const { code, out, err } = await run(['--mode', 'compat', '--task', 'perspectives', '--live', '--list', list.path], env, {
        fetch: compat.fetch,
        linkCheck: liveChecker(),
      });
      expect(err).toEqual([]);
      expect(code).not.toBe(2);
      // The balance warnings come before the run.
      expect(out[0]).toBe("The source list isn't balanced: No outlets in Right.");
      expect(out[1]).toMatch(/^Live run: \d+ comparisons on compat/);
      const queries = compat.urls
        .filter((u) => u.startsWith('https://api.search.brave.com/'))
        .map((u) => new URL(u).searchParams.get('q') ?? '');
      expect(queries.length).toBeGreaterThan(0);
      expect(queries.some((q) => q.includes('site:left-a.example'))).toBe(true);
      expect(queries.some((q) => q.includes('site:right-'))).toBe(false);
    } finally {
      await list.remove();
    }

    // A file that isn't a sound list with a lean: refused before any key is read.
    const [first, second] = FIXTURE_OFFICIAL_LIST.outlets;
    if (!first || !second) throw new Error('the fixture has outlets');
    for (const [content, message] of [
      ['not json', BAD_LIST],
      [{ ...FIXTURE_OFFICIAL_LIST, v: 2 }, BAD_LIST],
      [
        { ...FIXTURE_OFFICIAL_LIST, outlets: [first, { ...second, id: first.id }] },
        "The --list file's source list needs fixing: Two outlets have the id fx-left-a.",
      ],
      [{ ...FIXTURE_OFFICIAL_LIST, outlets: FIXTURE_OFFICIAL_LIST.outlets.map((o) => ({ ...o, lean: null })) }, EMPTY_LIST],
    ] as const) {
      const bad = await listFileWith(content);
      try {
        const { env: watched, reads } = watchedEnv();
        const fetch = openaiFetch();
        const { code, out, err } = await run(
          ['--mode', 'openai', '--task', 'perspectives', '--live', '--list', bad.path],
          watched,
          {
            fetch,
          },
        );
        expect(code).toBe(2);
        expect(err).toEqual([message]);
        expect(out).toEqual([]);
        expect(reads).toEqual([]);
        expect(fetch.spy).not.toHaveBeenCalled();
      } finally {
        await bad.remove();
      }
    }
    const missing = await run(
      ['--mode', 'openai', '--task', 'perspectives', '--live', '--list', join(tmpdir(), 'no-such-list.json')],
      {},
    );
    expect(missing.code).toBe(2);
    expect(missing.err).toEqual([BAD_LIST]);

    // `--list` is for live UnEcho Chamber runs only.
    for (const argv of [
      ['--mode', 'openai', '--live', '--list', 'outlets.json'],
      ['--mode', 'openai', '--task', 'perspectives', '--list', 'outlets.json'],
      ['--mode', 'openai', '--task', 'perspectives', '--live', '--list'],
    ]) {
      const { code, err } = await run(argv, {});
      expect(code, argv.join(' ')).toBe(2);
      expect(err.join('\n')).toContain('usage: pnpm eval:trust');
    }
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

const RECORDED = 'Recorded in packages/research/eval/results.json. Run pnpm format and pnpm docs:site, then commit both files.';
const NOT_RECORDED = 'Not recorded: the run hit provider errors.';

/** A record already in the file: a run appends after it and leaves it as it was. */
const EARLIER: EvalRecord = {
  task: 'factcheck',
  mode: 'openai',
  ranOn: '2026-10-01',
  promptVersion: 2,
  serverVersion: '0.3.0',
  items: 56,
  gates: { provenance: { value: 1, min: 1, passed: true } },
  passed: false,
  agreement: 0.5,
  meanCostMicros: null,
};

describe('trust eval: record', () => {
  it('test_record_needs_live_all', async () => {
    const file = await resultsFileWith('[]\n');
    try {
      for (const argv of [
        ['--mode', 'anthropic', '--record'],
        ['--mode', 'anthropic', '--live', '--record'],
        ['--mode', 'anthropic', '--all', '--record'],
        ['--mode', 'openai', '--task', 'perspectives', '--live', '--record'],
      ]) {
        const { env, reads } = watchedEnv();
        const fetch = anthropicFetch();
        const { code, out, err } = await run(argv, env, { fetch, resultsFile: file.url });
        expect(code, argv.join(' ')).toBe(2);
        expect(err.join('\n')).toContain('usage: pnpm eval:trust --mode anthropic|openai|compat');
        expect(err.join('\n')).toContain('--record');
        expect(out).toEqual([]);
        expect(reads).toEqual([]);
        expect(fetch.bodies).toEqual([]);
      }
      expect(await file.read()).toBe('[]\n');
    } finally {
      await file.remove();
    }
  });

  it('test_record_appends_one_content_free_record', async () => {
    const file = await resultsFileWith(`${JSON.stringify([EARLIER], null, 2)}\n`);
    const key = 'sk-ant-test-secret-value';
    const deadItems = ['fc-01', 'fc-02', 'fc-03'];
    try {
      const { code, out } = await run(
        ['--mode', 'anthropic', '--live', '--all', '--record'],
        { ANTHROPIC_API_KEY: key },
        {
          fetch: anthropicFetch(),
          linkCheck: liveChecker((u) => deadItems.some((id) => u.startsWith(`https://${id}.`))),
          resultsFile: file.url,
          // 23:30 in Toronto on 15 October is 16 October in UTC.
          now: () => new Date('2026-10-15T23:30:00-04:00'),
        },
      );
      const report = reportOf(out) as unknown as FactcheckEvalReport;
      const gates = trustGates(report);
      expect(report).toMatchObject({ total: 56, providerErrors: [], pairsScored: 20 });
      // A failed run is recorded too, and keeps its exit code.
      expect(gates.liveLinks.passed).toBe(false);
      expect(code).toBe(1);
      expect(out.at(-1)).toBe(RECORDED);

      const text = await file.read();
      const records = parseEvalResults(text);
      expect(text).toBe(`${JSON.stringify(records, null, 2)}\n`);
      expect(records).toHaveLength(2);
      expect(records[0]).toEqual(EARLIER);
      expect(EvalRecordSchema.parse(records[1])).toEqual({
        task: 'factcheck',
        mode: 'anthropic',
        ranOn: '2026-10-16',
        promptVersion: FACTCHECK_PROMPT_VERSION,
        serverVersion: SERVER_VERSION,
        items: 56,
        gates: { slantFlip: gates.slantFlip, provenance: gates.provenance, liveLinks: gates.liveLinks },
        passed: false,
        agreement: report.agreement,
        meanCostMicros: report.meanCostMicros ?? null,
      });
      expect(records[1]?.meanCostMicros).toBeGreaterThan(0);

      // Content-free (decision D81): no item, link, key or failure reason.
      expect(report.failures.length).toBeGreaterThan(0);
      expect(text).not.toContain('fc-');
      expect(text).not.toContain('http');
      expect(text).not.toContain(key);
      for (const failure of report.failures) {
        expect(text).not.toContain(failure.id);
        expect(text).not.toContain(failure.reason);
      }
    } finally {
      await file.remove();
    }
  });

  it('test_record_skipped_on_provider_errors', async () => {
    const file = await resultsFileWith('[]\n');
    try {
      const { code, out } = await run(
        ['--mode', 'anthropic', '--live', '--all', '--record'],
        { ANTHROPIC_API_KEY: 'sk-ant-test-key' },
        { fetch: anthropicFetch('fc-05'), linkCheck: liveChecker(), resultsFile: file.url },
      );
      expect(reportOf(out).providerErrors).toEqual(['auth']);
      expect(out.at(-1)).toBe(NOT_RECORDED);
      expect(out).not.toContain(RECORDED);
      expect(code).toBe(1);
      expect(await file.read()).toBe('[]\n');
    } finally {
      await file.remove();
    }
  });

  it('test_record_compat_and_perspectives_fields', async () => {
    const file = await resultsFileWith('[]\n');
    const secrets = {
      COMPAT_BASE_URL: 'http://ai.example:11434/v1',
      COMPAT_MODEL: 'private-model-7b',
      COMPAT_API_KEY: 'compat-secret-key',
      SEARCH_API_KEY: 'brave-test-token',
    };
    const env = { ...secrets, SEARCH_PROVIDER: 'brave' };
    const list = await listFileWith();
    try {
      const factcheck = await run(['--mode', 'compat', '--live', '--all', '--record'], env, {
        fetch: compatFetch().fetch,
        linkCheck: liveChecker(),
        resultsFile: file.url,
      });
      expect(factcheck.out.at(-1)).toBe(RECORDED);

      const perspectives = await run(
        ['--mode', 'compat', '--task', 'perspectives', '--live', '--all', '--record', '--list', list.path],
        env,
        { fetch: compatFetch().fetch, linkCheck: liveChecker(), resultsFile: file.url },
      );
      expect(perspectives.out.at(-1)).toBe(RECORDED);

      const text = await file.read();
      const records = parseEvalResults(text);
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        task: 'factcheck',
        mode: 'compat',
        searchProvider: 'brave',
        promptVersion: FACTCHECK_PROMPT_VERSION,
        items: 56,
      });
      expect(records[0]).not.toHaveProperty('registryVersion');
      const report = reportOf(perspectives.out) as unknown as PerspectivesEvalReport;
      const gates = perspectivesTrustGates(report);
      expect(records[1]).toEqual({
        task: 'perspectives',
        mode: 'compat',
        searchProvider: 'brave',
        ranOn: '2026-10-15',
        promptVersion: PERSPECTIVES_PROMPT_VERSION,
        registryVersion: FIXTURE_LIST.version,
        serverVersion: SERVER_VERSION,
        items: 10,
        gates: { provenance: gates.provenance, leanIntegrity: gates.leanIntegrity, liveLinks: gates.liveLinks },
        passed: gates.passed,
        agreement: report.coverageMatch,
        meanCostMicros: report.meanCostMicros ?? null,
      });
      for (const value of Object.values(secrets)) expect(text).not.toContain(value);
      expect(text).not.toContain('ai.example');
      expect(text).not.toContain('pv-');
    } finally {
      await file.remove();
      await list.remove();
    }
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
