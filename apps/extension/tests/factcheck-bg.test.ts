/**
 * Fact-check in the background (P3-06, P3-46): the gates, one check per tab, the three Anthropic calls, the OpenAI and
 * OpenAI-compatible modes, the usage ledger and the tab's session entries. Extension storage is the WXT fake browser,
 * API keys fake-indexeddb, and the network the mock Anthropic and OpenAI Responses responders from
 * @unalgorithm/ai/testing, the compat mock's answers and a stub Brave (nothing real is called).
 */
import { describeError } from '@unalgorithm/ai';
import { mockStructuredAnswer } from '@unalgorithm/ai/testing';
import {
  type AnthropicRequestKind,
  mockAnthropicFetch,
  researchMessage,
  structuredMessage,
} from '@unalgorithm/ai/testing/anthropic';
import {
  errorResponse,
  mockOpenAIResponsesFetch,
  mockResponsesAnswer,
  type ResponsesRequestKind,
  researchResponse,
  structuredResponse,
} from '@unalgorithm/ai/testing/openai-responses';
import { type AISourceConfig, dayUsage, defaultDevice, sourceId, type WebSearchKey } from '@unalgorithm/core';
import {
  AUTHORIZE_PAGE_PATH,
  costMicros,
  FACTCHECK_JOBS_PATH,
  FactcheckResultSchema,
  factcheckJobPath,
  type PostForAI,
  type PostKey,
  type ServerInfo,
  TOKEN_PATH,
} from '@unalgorithm/protocol';
import { CachedClaimSchema } from '@unalgorithm/research';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { CLAIM_CACHE_SECRET_ID, deviceClaimCache } from '../src/background/claim-cache.ts';
import { clearClaimChecks, getSecret, setSecret } from '../src/background/idb.ts';
import { serverAccountItem } from '../src/background/server-auth.ts';
import { forgetTab } from '../src/background/tabs.ts';
import { handlers } from '../src/entrypoints/background.ts';
import type { BgRequest } from '../src/lib/messages.ts';
import { deviceItem, factcheckItem, usageItem } from '../src/lib/storage.ts';

// The device's claim cache, as itself, watched: a server check must never create one.
vi.mock('../src/background/claim-cache.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/background/claim-cache.ts')>();
  return { ...actual, deviceClaimCache: vi.fn(actual.deviceClaimCache) };
});

const ANTHROPIC: AISourceConfig = { kind: 'anthropic', model: null };
const OPENAI: AISourceConfig = { kind: 'openai', model: null };
const TAB = 7;
const FEED_URL = 'https://www.linkedin.com/feed/';
const feedTab = (id = TAB, url = FEED_URL) => ({ tab: { id, url }, url }) as Browser.runtime.MessageSender;

const SOURCE_URL = 'https://news.example.org/bridge';
const QUOTE = 'The bridge opened in 1932 after four years of work.';

type Reply = { status: number; body: unknown };
type Responder = (body: Record<string, unknown>, kind: AnthropicRequestKind) => Reply;

const ok = (body: unknown): Reply => ({ status: 200, body });
const apiError = (status: number, type: string, message: string): Reply => ({
  status,
  body: { type: 'error', error: { type, message } },
});

/** A working Anthropic: one claim, one cited source, a supported verdict. */
const happy: Responder = (_body, kind) => {
  if (kind === 'claims') return ok(structuredMessage({ claims: [{ claim: 'The bridge opened in 1932.' }] }));
  if (kind === 'research')
    return ok(
      researchMessage({
        results: [{ url: SOURCE_URL, title: 'Bridge history' }],
        notes: [{ text: 'It opened in 1932.', cites: [{ url: SOURCE_URL, citedText: QUOTE }] }],
      }),
    );
  if (kind === 'verdict')
    return ok(
      structuredMessage(
        {
          verdicts: [
            {
              claimId: 'c1',
              verdict: 'supported',
              explanation: 'A history of the bridge gives the same year.',
              citations: [{ sourceId: 's1', quote: 'The bridge opened in 1932' }],
            },
          ],
        },
        { model: 'claude-sonnet-5-5' },
      ),
    );
  return apiError(400, 'invalid_request_error', 'unexpected request');
};

let fetchMock: ReturnType<typeof mockAnthropicFetch>;
let kinds: AnthropicRequestKind[];
function useAnthropic(reply: Responder) {
  kinds = [];
  fetchMock = mockAnthropicFetch((body, kind) => {
    kinds.push(kind);
    return reply(body, kind);
  });
  vi.stubGlobal('fetch', fetchMock);
}

let permitted: boolean;
/** Host patterns `permissions.contains` answers false for, on top of `permitted`. */
let deniedOrigins: Set<string>;
let panelOpen: ReturnType<typeof vi.fn>;

async function setup(over: { source?: AISourceConfig | null; labs?: boolean; webSearch?: WebSearchKey | null } = {}) {
  const device = defaultDevice('dev1');
  await deviceItem.setValue({
    ...device,
    aiSource: over.source === undefined ? ANTHROPIC : over.source,
    labs: { ...device.labs, factcheck: over.labs ?? true },
    webSearch: over.webSearch ?? null,
  });
}

const POST: Omit<PostForAI, 'ref'> = {
  platform: 'linkedin',
  text: 'The bridge opened in 1932 and cost $10 million to build, more than any bridge before it.',
  textComplete: true,
  authorKind: 'person',
  isReshare: false,
  media: 'none',
};
const KEY = 'li:urn:li:activity:1' as PostKey;

function factcheck(input: Omit<PostForAI, 'ref'> = POST, key: PostKey = KEY, sender = feedTab()) {
  const msg: Extract<BgRequest, { type: 'factcheck' }> = { type: 'factcheck', key, input };
  return handlers.factcheck(msg, sender);
}

const entries = async (tabId = TAB) => (await factcheckItem(tabId).getValue()).entries;

beforeEach(async () => {
  fakeBrowser.reset();
  permitted = true;
  deniedOrigins = new Set();
  vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation(
    (async (p: { origins?: string[] }) => permitted && !(p.origins ?? []).some((o) => deniedOrigins.has(o))) as never,
  );
  panelOpen = vi.fn(async () => undefined);
  vi.spyOn(fakeBrowser.sidePanel, 'open').mockImplementation(panelOpen as never);
  await setSecret(sourceId(ANTHROPIC), 'sk-ant-test');
  await setSecret(sourceId(OPENAI), 'sk-test');
  await clearClaimChecks();
  useAnthropic(happy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('gates', () => {
  it('test_factcheck_denied_from_non_feed_sender', async () => {
    await setup();
    const other = { tab: { id: 3, url: 'https://example.com/' }, url: 'https://example.com/' } as Browser.runtime.MessageSender;
    await expect(factcheck(POST, KEY, other)).rejects.toThrow(/not accepted/);
    const page = { url: 'chrome-extension://abc/options.html' } as Browser.runtime.MessageSender;
    await expect(factcheck(POST, KEY, page)).rejects.toThrow(/not accepted/);
    expect(fetchMock.bodies).toHaveLength(0);
    expect(panelOpen).not.toHaveBeenCalled();
  });

  it('test_factcheck_labs_off_unsupported_source_and_friends_post_send_nothing', async () => {
    await setup({ labs: false });
    expect(await factcheck()).toStrictEqual({
      ok: false,
      error: { code: 'not-available', message: 'Turn on Fact-check in Settings → AI.' },
    });

    await setup({ source: { kind: 'on-device' } });
    expect(await factcheck()).toStrictEqual({ ok: false, error: { code: 'unsupported', message: NEEDS_OWN_KEY } });

    await setup();
    const fbUrl = 'https://www.facebook.com/';
    const friends = { ...POST, platform: 'facebook' as const, audience: 'friends' as const };
    expect(await factcheck(friends, 'fb:1' as PostKey, feedTab(TAB, fbUrl))).toStrictEqual({
      ok: false,
      error: { code: 'not-available', message: 'Fact-check works only on public posts.' },
    });

    expect(fetchMock.bodies).toHaveLength(0);
    expect(await entries()).toStrictEqual([]);
  });

  it('test_factcheck_without_host_permission_sends_nothing', async () => {
    await setup();
    permitted = false;
    expect(await factcheck()).toStrictEqual({
      ok: false,
      error: { code: 'host-permission', message: describeError('host-permission', 'Anthropic') },
    });
    expect(fakeBrowser.permissions.contains).toHaveBeenCalledWith({ origins: ['https://api.anthropic.com/*'] });
    expect(fetchMock.bodies).toHaveLength(0);
    expect(await entries()).toStrictEqual([]);
  });

  it('test_factcheck_second_request_while_running_is_rate_limited', async () => {
    await setup();
    // The research call waits until released, so the first check is still running when the second one arrives.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inner = mockAnthropicFetch(happy);
    let researchStarted: () => void = () => undefined;
    const started = new Promise<void>((r) => {
      researchStarted = r;
    });
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.body ?? '').includes('"tools"')) {
        researchStarted();
        await gate;
      }
      return inner(url, init);
    });

    const first = factcheck();
    await started;
    expect(await factcheck()).toStrictEqual({
      ok: false,
      error: { code: 'rate-limit', message: 'A check is already running on this page.' },
    });
    expect((await entries()).map((e) => e.status)).toStrictEqual(['running']);
    release();
    const res = await first;
    expect(res.ok).toBe(true);
    expect((await entries()).map((e) => e.status)).toStrictEqual(['done']);
  });

  it('test_factcheck_concurrent_requests_make_one_check_and_stale_entry_does_not_block', async () => {
    await setup();
    // A `running` entry left by a worker that died mid-check.
    await factcheckItem(TAB).setValue({
      entries: [{ key: 'li:urn:li:activity:0' as PostKey, label: 'Earlier', startedAt: 1, status: 'running' }],
    });

    const [a, b] = await Promise.all([factcheck(), factcheck()]);
    const outcomes = [a, b].map((r) => (r.ok ? 'ok' : r.error.code)).sort();
    expect(outcomes).toStrictEqual(['ok', 'rate-limit']);
    expect(kinds.filter((k) => k === 'claims')).toHaveLength(1);

    const stored = await entries();
    expect(stored.map((e) => e.status)).toStrictEqual(['done', 'failed']);
    expect(stored[1]?.error?.code).toBe('timeout');
  });
});

describe('happy path', () => {
  it('test_factcheck_runs_three_calls_and_stores_done_entry', async () => {
    await setup();
    const res = await factcheck();
    expect(kinds).toStrictEqual(['claims', 'research', 'verdict']);
    expect(res.ok).toBe(true);
    const stored = await entries();
    expect(stored).toHaveLength(1);
    const [entry] = stored;
    expect(entry?.status).toBe('done');
    expect(entry?.key).toBe(KEY);
    expect(entry?.label).toBe(POST.text.slice(0, 80));
    expect(FactcheckResultSchema.safeParse(entry?.result).success).toBe(true);
    expect(entry?.result?.claims).toHaveLength(1);
    if (res.ok) {
      expect(res.result).toStrictEqual(entry?.result);
      expect(res.costMicros).toBe(entry?.costMicros);
    }
    expect(entry?.costMicros).toBeGreaterThan(0);
    expect(entry).not.toHaveProperty('chargedMicros');
  });

  it('test_factcheck_opens_side_panel_before_first_await', async () => {
    await setup();
    const order: string[] = [];
    panelOpen.mockImplementation(async () => {
      order.push('sidePanel.open');
    });
    const getItem = fakeBrowser.storage.local.get.bind(fakeBrowser.storage.local);
    vi.spyOn(fakeBrowser.storage.local, 'get').mockImplementation(((...args: Parameters<typeof getItem>) => {
      order.push('storage');
      return getItem(...args);
    }) as never);

    const pending = factcheck();
    // Called synchronously by the handler, before anything it awaits has resolved.
    expect(panelOpen).toHaveBeenCalledWith({ tabId: TAB });
    await pending;
    expect(order[0]).toBe('sidePanel.open');
    expect(order).toContain('storage');
  });

  it('test_factcheck_records_usage_without_posts', async () => {
    await setup();
    await factcheck();
    const day = dayUsage(await usageItem.getValue());
    expect(day.posts).toBe(0);
    expect(day.calls).toBe(3);
    expect(day.failedCalls).toBe(0);
    expect(day.byModel['claude-haiku-5-5']?.calls).toBe(1);
    expect(day.byModel['claude-haiku-5-5']?.usage.uncachedInput).toBe(1000);
    expect(day.byModel['claude-sonnet-5-5']?.calls).toBe(2);
    expect(day.byModel['claude-sonnet-5-5']?.usage.webSearches).toBe(3);
  });
});

describe('privacy', () => {
  it('test_factcheck_strips_extra_fields_from_request_bodies', async () => {
    await setup();
    const withAuthor = { ...POST, author: 'Jane Q. Example', authorUrl: 'https://www.linkedin.com/in/jane' };
    const res = await factcheck(withAuthor as Omit<PostForAI, 'ref'>);
    expect(res.ok).toBe(true);
    expect(fetchMock.bodies).toHaveLength(3);
    for (const body of fetchMock.bodies) {
      const text = JSON.stringify(body);
      expect(text).not.toContain('Jane Q. Example');
      expect(text).not.toContain('linkedin.com/in/jane');
    }
  });
});

describe('errors and storage', () => {
  it('test_factcheck_auth_error_stored_and_usage_recorded', async () => {
    await setup();
    useAnthropic((body, kind) =>
      kind === 'research' ? apiError(401, 'authentication_error', 'invalid x-api-key') : happy(body, kind),
    );
    const error = { code: 'auth', message: describeError('auth', 'Anthropic') };
    expect(await factcheck()).toStrictEqual({ ok: false, error });
    expect(kinds).toStrictEqual(['claims', 'research']);
    const [entry] = await entries();
    expect(entry).toMatchObject({ status: 'failed', error });

    const day = dayUsage(await usageItem.getValue());
    expect(day.posts).toBe(0);
    expect(day.calls).toBe(2);
    expect(day.failedCalls).toBe(1);
    expect(day.byModel['claude-haiku-5-5']?.usage.uncachedInput).toBe(1000);
  });

  it('test_factcheck_keeps_five_newest_entries', async () => {
    await setup();
    const keys: PostKey[] = [];
    for (let i = 1; i <= 6; i++) {
      const key = `li:urn:li:activity:${i}` as PostKey;
      keys.push(key);
      expect((await factcheck(POST, key)).ok).toBe(true);
    }
    const stored = await entries();
    expect(stored.map((e) => e.key)).toStrictEqual(keys.slice(1).reverse());
  });

  it('test_factcheck_entry_removed_when_tab_closes', async () => {
    await setup();
    await factcheck();
    const stored = async () => (await fakeBrowser.storage.session.get(`factcheck:${TAB}`))[`factcheck:${TAB}`];
    expect(await stored()).toBeDefined();
    await forgetTab(TAB);
    expect(await stored()).toBeUndefined();
  });

  it('test_factcheck_tab_closed_mid_check_stays_removed', async () => {
    await setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let researchStarted: () => void = () => undefined;
    const started = new Promise<void>((r) => {
      researchStarted = r;
    });
    const inner = mockAnthropicFetch(happy);
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.body ?? '').includes('"tools"')) {
        researchStarted();
        await gate;
      }
      return inner(url, init);
    });
    const stored = async () => (await fakeBrowser.storage.session.get(`factcheck:${TAB}`))[`factcheck:${TAB}`];

    // The tab closes while the check runs; the check still ends (and pays), but writes nothing back for the tab.
    const first = factcheck();
    await started;
    await forgetTab(TAB);
    release();
    expect((await first).ok).toBe(true);
    expect(await stored()).toBeUndefined();

    // The tab closes while the finished check is being written: the removal waits for the write, so nothing lingers.
    const getItem = fakeBrowser.storage.session.get.bind(fakeBrowser.storage.session);
    let closing: Promise<void> | undefined;
    vi.spyOn(fakeBrowser.storage.session, 'get').mockImplementation(((...args: Parameters<typeof getItem>) => {
      const read = getItem(...args);
      if (kinds.includes('verdict') && !closing) closing = forgetTab(TAB);
      return read;
    }) as never);
    useAnthropic(happy);
    expect((await factcheck()).ok).toBe(true);
    await closing;
    expect(closing).toBeDefined();
    vi.mocked(fakeBrowser.storage.session.get).mockRestore();
    expect(await stored()).toBeUndefined();
  });

  it('test_open_factcheck_opens_panel_for_feed_tab_only', async () => {
    const msg = { type: 'openFactcheck' } as const;
    expect(await handlers.openFactcheck(msg, feedTab(9))).toStrictEqual({ ok: true });
    expect(panelOpen).toHaveBeenCalledWith({ tabId: 9 });

    panelOpen.mockRejectedValueOnce(new Error('`sidePanel.open()` may only be called in response to a user gesture.'));
    expect(await handlers.openFactcheck(msg, feedTab(9))).toStrictEqual({ ok: false });

    panelOpen.mockClear();
    const page = { url: 'chrome-extension://abc/popup.html' } as Browser.runtime.MessageSender;
    await expect(handlers.openFactcheck(msg, page)).rejects.toThrow(/not accepted/);
    expect(panelOpen).not.toHaveBeenCalled();
  });

  it('test_factcheck_web_search_off_stores_unsupported_message', async () => {
    await setup();
    useAnthropic((body, kind) =>
      kind === 'research'
        ? apiError(400, 'invalid_request_error', 'The web_search tool is not enabled for this organization.')
        : happy(body, kind),
    );
    const error = { code: 'unsupported', message: "Web search isn't turned on for this Anthropic account." };
    expect(await factcheck()).toStrictEqual({ ok: false, error });
    const [entry] = await entries();
    expect(entry).toMatchObject({ status: 'failed', error });
  });
});

// ---------- own-key modes (P3-46): OpenAI, and an OpenAI-compatible server with a Brave key ----------

const NEEDS_OWN_KEY =
  'Fact-check needs your own Anthropic or OpenAI key, an AI server with a web search key, or a server that offers it.';
const COMPAT_BASE = 'http://localhost:11434/v1';
const COMPAT: AISourceConfig = {
  kind: 'openai-compatible',
  preset: 'ollama',
  baseUrl: COMPAT_BASE,
  auth: 'none',
  model: 'llama3.2',
};
const BRAVE: WebSearchKey = { provider: 'brave' };
const BRAVE_PATTERN = 'https://api.search.brave.com/*';
/** Two sentences, so the compat mock's one claim (the first sentence) is never the whole post. */
const POST_2: Omit<PostForAI, 'ref'> = {
  ...POST,
  text: 'The bridge opened in 1932. It cost $10 million to build, more than any bridge before it.',
};

const SOURCE_URL_2 = 'https://archive.example.com/bridge-records';
const QUOTE_2 = 'Records show the bridge opened in 1932.';

/** OpenAI with web search: the mock's claims, research over two cited sources, a supported verdict quoting both. */
function openaiAnswer(kind: ResponsesRequestKind, body: unknown): unknown {
  if (kind === 'verdict') {
    const citations = [
      { sourceId: 's1', quote: 'The bridge opened in 1932' },
      { sourceId: 's2', quote: 'the bridge opened in 1932' },
    ];
    const verdicts = [{ claimId: 'c1', verdict: 'supported', explanation: 'A history gives the same year.', citations }];
    return structuredResponse({ verdicts }, { model: 'gpt-5' });
  }
  if (kind !== 'research') return mockResponsesAnswer(body);
  const text = `${QUOTE} ${QUOTE_2}`;
  return researchResponse({
    searches: [{ urls: [SOURCE_URL, SOURCE_URL_2] }],
    text,
    citations: [
      { url: SOURCE_URL, title: 'Bridge history', start: 0, end: QUOTE.length },
      { url: SOURCE_URL_2, title: 'Bridge records', start: QUOTE.length + 1, end: text.length },
    ],
  });
}

const jsonResponse = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/**
 * Every request of an own-key run: OpenAI's host to the Responses mock, the compat base URL to the compat mock's
 * structured answers (chat/completions), Brave's host to `brave`; anything else fails the test.
 */
function useOwnKeyNetwork(
  opts: { openai?: (kind: ResponsesRequestKind, body: unknown) => unknown; brave?: (url: URL) => Response } = {},
) {
  const openai = mockOpenAIResponsesFetch(opts.openai ?? openaiAnswer);
  const net = { urls: [] as URL[], bodies: [] as string[], braveQueries: [] as string[], braveKeys: [] as (string | null)[] };
  const braveHit = () =>
    jsonResponse(200, { web: { results: [{ url: SOURCE_URL, title: 'Bridge history', description: QUOTE }] } });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    net.urls.push(url);
    net.bodies.push(typeof init.body === 'string' ? init.body : '');
    if (url.hostname === 'api.openai.com') return openai(input, init);
    if (url.hostname === 'api.search.brave.com') {
      net.braveQueries.push(url.searchParams.get('q') ?? '');
      net.braveKeys.push(new Headers(init.headers).get('x-subscription-token'));
      return (opts.brave ?? braveHit)(url);
    }
    if (`${url.origin}${url.pathname}`.startsWith(`${COMPAT_BASE}/`)) {
      const body = JSON.parse(String(init.body)) as { model: string; messages: { role: string; content: string }[] };
      const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
      return jsonResponse(200, {
        model: body.model,
        choices: [{ message: { content: JSON.stringify(mockStructuredAnswer(user).json) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 50 },
      });
    }
    throw new Error(`unexpected request to ${url.href}`);
  });
  return net;
}

describe('own-key modes', () => {
  beforeEach(async () => {
    await setSecret('search:brave', 'brave-test-key');
  });

  it('test_factcheck_openai_key_runs', async () => {
    await setup({ source: OPENAI });
    const net = useOwnKeyNetwork();
    const res = await factcheck();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.claims[0]?.verdict).toBe('supported');
    expect(net.urls.length).toBeGreaterThan(0);
    for (const url of net.urls) expect(url.hostname).toBe('api.openai.com');
    const research = net.bodies.map((b) => JSON.parse(b) as Record<string, unknown>).filter((b) => Array.isArray(b.tools));
    expect(research).toHaveLength(1);
    expect(research[0]?.model).toBe('gpt-5');
    expect(research[0]?.tools).toContainEqual(expect.objectContaining({ type: 'web_search' }));
    const [entry] = await entries();
    expect(entry?.status).toBe('done');
    if (res.ok) expect(entry?.result).toStrictEqual(res.result);
  });

  it('test_factcheck_compat_with_brave_runs', async () => {
    await setup({ source: COMPAT, webSearch: BRAVE });
    const net = useOwnKeyNetwork();
    const res = await factcheck(POST_2);
    expect(res.ok).toBe(true);

    const ai = net.urls.filter((u) => u.hostname !== 'api.search.brave.com');
    expect(ai.length).toBeGreaterThan(0);
    for (const url of ai) expect(url.href.startsWith(`${COMPAT_BASE}/`)).toBe(true);
    expect(net.braveQueries.length).toBeGreaterThan(0);
    for (const q of net.braveQueries) {
      expect(q.length).toBeLessThanOrEqual(200);
      expect(q).not.toBe(POST_2.text);
      expect(q).toBe('The bridge opened in 1932.');
    }
    expect(new Set(net.braveKeys)).toEqual(new Set(['brave-test-key']));
    // The search key only goes to Brave, never to the AI server.
    for (const [i, url] of net.urls.entries()) {
      if (url.hostname !== 'api.search.brave.com') expect(net.bodies[i]).not.toContain('brave-test-key');
    }

    const [entry] = await entries();
    expect(entry?.status).toBe('done');
    expect(entry?.costMicros).toBeUndefined();
    if (res.ok) expect(res.costMicros).toBeUndefined();
  });

  it('test_factcheck_new_kinds_public_only', async () => {
    const net = useOwnKeyNetwork();
    const friends = { ...POST, platform: 'facebook' as const, audience: 'friends' as const };
    const fb = feedTab(TAB, 'https://www.facebook.com/');
    for (const over of [{ source: OPENAI }, { source: COMPAT, webSearch: BRAVE }]) {
      await setup(over);
      expect(await factcheck(friends, 'fb:1' as PostKey, fb)).toStrictEqual({
        ok: false,
        error: { code: 'not-available', message: 'Fact-check works only on public posts.' },
      });
    }
    expect(net.urls).toHaveLength(0);
    expect(await entries()).toStrictEqual([]);
  });

  it('test_factcheck_compat_refusals', async () => {
    const net = useOwnKeyNetwork();
    await setup({ source: COMPAT });
    expect(await factcheck()).toStrictEqual({ ok: false, error: { code: 'unsupported', message: NEEDS_OWN_KEY } });

    await setup({ source: COMPAT, webSearch: { provider: 'tavily' } });
    expect(await factcheck()).toStrictEqual({
      ok: false,
      error: { code: 'no-key', message: 'Add a web search key in Settings → AI.' },
    });

    await setup({ source: { ...COMPAT, model: null } as AISourceConfig, webSearch: BRAVE });
    expect(await factcheck()).toStrictEqual({
      ok: false,
      error: { code: 'no-model', message: 'Choose a model in Settings → AI.' },
    });
    expect(net.urls).toHaveLength(0);
    expect(await entries()).toStrictEqual([]);
  });

  it('test_factcheck_permissions_per_provider', async () => {
    const net = useOwnKeyNetwork();
    await setup({ source: COMPAT, webSearch: BRAVE });
    deniedOrigins = new Set([BRAVE_PATTERN]);
    const brave = await factcheck(POST_2);
    expect(brave).toStrictEqual({
      ok: false,
      error: {
        code: 'host-permission',
        message: 'UnAlgorithm needs permission to reach Brave. Save your web search key again in Settings → AI.',
      },
    });
    expect(fakeBrowser.permissions.contains).toHaveBeenCalledWith({ origins: [BRAVE_PATTERN] });

    await setup({ source: OPENAI });
    deniedOrigins = new Set(['https://api.openai.com/*']);
    const openai = await factcheck();
    expect(openai).toStrictEqual({
      ok: false,
      error: { code: 'host-permission', message: describeError('host-permission', 'OpenAI') },
    });
    expect(openai.ok ? '' : openai.error.message).toContain('OpenAI');

    expect(net.urls).toHaveLength(0);
    expect(await entries()).toStrictEqual([]);
  });

  it('test_factcheck_provider_error_texts', async () => {
    await setup({ source: COMPAT, webSearch: BRAVE });
    useOwnKeyNetwork({ brave: () => jsonResponse(401, { error: 'unauthorized' }) });
    const braveError = { code: 'not-available', message: 'Your Brave key was refused. Check it in Settings → AI.' };
    expect(await factcheck(POST_2)).toStrictEqual({ ok: false, error: braveError });
    expect((await entries())[0]).toMatchObject({ status: 'failed', error: braveError });

    await factcheckItem(TAB).removeValue();
    await setup({ source: OPENAI });
    useOwnKeyNetwork({
      openai: (kind, body) =>
        kind === 'research' ? errorResponse(400, 'Tool web_search is not supported with this model.') : openaiAnswer(kind, body),
    });
    const openaiError = { code: 'unsupported', message: "Web search isn't available for this OpenAI key or model." };
    expect(await factcheck()).toStrictEqual({ ok: false, error: openaiError });
    expect((await entries())[0]).toMatchObject({ status: 'failed', error: openaiError });
  });

  it('test_factcheck_new_kinds_ledger', async () => {
    await setup({ source: OPENAI });
    useOwnKeyNetwork();
    expect((await factcheck()).ok).toBe(true);
    let day = dayUsage(await usageItem.getValue());
    expect(day.posts).toBe(0);
    expect(day.calls).toBe(3);
    expect(day.failedCalls).toBe(0);
    expect(day.byModel['gpt-5-mini']?.calls).toBe(1);
    expect(day.byModel['gpt-5']?.calls).toBe(2);

    // A failed research call is in the ledger too. The first check's two-domain answer is in the device's claim cache
    // (P3-60), which would answer this one without research.
    await usageItem.removeValue();
    await clearClaimChecks();
    useOwnKeyNetwork({
      openai: (kind, body) => (kind === 'research' ? errorResponse(500, 'server error') : openaiAnswer(kind, body)),
    });
    expect((await factcheck()).ok).toBe(false);
    day = dayUsage(await usageItem.getValue());
    expect(day.posts).toBe(0);
    expect(day.calls).toBe(2);
    expect(day.failedCalls).toBe(1);

    // OpenAI-compatible: every model call and the search step, none counted as a post.
    await usageItem.removeValue();
    await setup({ source: COMPAT, webSearch: BRAVE });
    useOwnKeyNetwork();
    expect((await factcheck(POST_2)).ok).toBe(true);
    day = dayUsage(await usageItem.getValue());
    expect(day.posts).toBe(0);
    expect(day.calls).toBeGreaterThanOrEqual(2);
    expect(day.byModel['llama3.2']?.calls).toBeGreaterThanOrEqual(2);
  });
});

describe('device claim cache', () => {
  const CLAIM = 'The bridge opened in 1932.';
  const NEWS = 'https://news.example.org/bridge';
  const RECORDS = 'https://records.example.net/opening';
  const KEY2 = 'li:urn:li:activity:2' as PostKey;

  /** One claim, two sources on two domains, a supported verdict: an answer the cache keeps. */
  const twoDomains: Responder = (_body, kind) => {
    if (kind === 'claims') return ok(structuredMessage({ claims: [{ claim: CLAIM }] }));
    if (kind === 'research')
      return ok(
        researchMessage({
          results: [
            { url: NEWS, title: 'Span history' },
            { url: RECORDS, title: 'City records' },
          ],
          notes: [
            {
              text: 'Both sources give the same year.',
              cites: [
                { url: NEWS, citedText: 'Traffic first crossed the span in 1932, after four years of work.' },
                { url: RECORDS, citedText: 'Opened to traffic in 1932 by the city council.' },
              ],
            },
          ],
        }),
      );
    if (kind === 'verdict')
      return ok(
        structuredMessage(
          {
            verdicts: [
              {
                claimId: 'c1',
                verdict: 'supported',
                explanation: 'Two independent sources give the same year.',
                citations: [
                  { sourceId: 's1', quote: 'Traffic first crossed the span in 1932' },
                  { sourceId: 's2', quote: 'Opened to traffic in 1932' },
                ],
              },
            ],
          },
          { model: 'claude-sonnet-5-5' },
        ),
      );
    return apiError(400, 'invalid_request_error', 'unexpected request');
  };

  /** Every `claimChecks` row, read on a connection of its own. */
  async function claimRows(): Promise<unknown[]> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('unalgorithm');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const req = db.transaction('claimChecks', 'readonly').objectStore('claimChecks').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  it('test_own_key_repeat_check_answered_from_device_cache', async () => {
    await setup();
    useAnthropic(twoDomains);
    expect((await factcheck()).ok).toBe(true);
    expect(kinds).toStrictEqual(['claims', 'research', 'verdict']);
    const [fresh] = await entries();
    expect(fresh?.result?.claims[0]?.cachedAt).toBeUndefined();
    // The first check made the only claims call so far: its cost is what the cached check costs.
    const claimsUsage = dayUsage(await usageItem.getValue()).byModel['claude-haiku-5-5']?.usage;
    const claimsCost = claimsUsage && costMicros('claude-haiku-5-5', claimsUsage);
    expect(claimsCost).toBeGreaterThan(0);

    // The same post met again, shared by another friend.
    useAnthropic(twoDomains);
    const second = await factcheck(POST, KEY2);
    expect(second.ok).toBe(true);
    expect(kinds).toStrictEqual(['claims']);
    expect(fetchMock.bodies).toHaveLength(1);
    const [entry] = await entries();
    expect(entry).toMatchObject({ key: KEY2, status: 'done', costMicros: claimsCost });
    expect(entry?.result?.claims).toHaveLength(1);
    expect(entry?.result?.claims[0]).toMatchObject({
      verdict: 'supported',
      explanation: 'Two independent sources give the same year.',
      cachedAt: expect.any(String),
    });
    expect(entry?.result?.sources.map((s) => s.url)).toStrictEqual([NEWS, RECORDS]);
  });

  it('test_device_cache_rows_hold_no_post_or_claim_text', async () => {
    await setup();
    useAnthropic(twoDomains);
    expect((await factcheck()).ok).toBe(true);
    const rows = (await claimRows()) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(Object.keys(row ?? {}).sort()).toStrictEqual(['entry', 'expiresAt', 'key']);
    expect(row?.key).toMatch(/^[0-9a-f]{64}$/);
    expect(CachedClaimSchema.safeParse(row?.entry).success).toBe(true);
    // The explanation repeats none of the post, so the device keeps it with the verdict.
    expect(row?.entry).toMatchObject({ explanation: 'Two independent sources give the same year.' });
    expect(typeof row?.expiresAt).toBe('number');
    const json = JSON.stringify(row).toLowerCase();
    expect(json).not.toContain(POST.text.toLowerCase());
    expect(json).not.toContain(CLAIM.toLowerCase().replace(/\.$/, ''));
    expect(json).not.toContain('activity');
  });

  it('test_server_source_never_uses_device_cache', async () => {
    const origin = 'https://ai.example.org';
    const info: ServerInfo = {
      v: 1,
      name: 'Example AI',
      version: '0.1.0',
      source: 'https://github.com/example/unalgorithm',
      billing: false,
      capabilities: { classify: true, sync: false, factcheck: true },
      auth: { methods: ['email-otp'], authorizePath: AUTHORIZE_PAGE_PATH, tokenPath: TOKEN_PATH },
      limits: { maxPostsPerRequest: 12 },
    };
    await setup({ source: { kind: 'server', baseUrl: `${origin}/` } });
    await serverAccountItem.setValue({
      origin,
      email: 'ada@example.org',
      deviceId: '0199d6a4-3f1e-7c2a-9b5d-2e8f4a6c1b3d',
      signedInAt: Date.now(),
      info,
      needsSignIn: false,
    });
    // A valid access token, so no refresh is attempted.
    await fakeBrowser.storage.session.set({
      serverAccess: { origin, token: 'access-token-1', expiresAt: Date.now() + 3_600_000 },
    });
    const jobId = '0199d6a4-3f1e-7c2a-9b5d-2e8f4a6c1b3e';
    const result = {
      v: 1,
      checkedAt: new Date().toISOString(),
      model: 'claude-sonnet-5-5',
      promptVersion: 1,
      claims: [],
      sources: [],
    };
    const paths: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === FACTCHECK_JOBS_PATH && init.method === 'POST')
        return new Response(JSON.stringify({ v: 1, id: jobId, status: 'running' }), { status: 202 });
      if (url.pathname === factcheckJobPath(jobId))
        return new Response(JSON.stringify({ v: 1, id: jobId, status: 'done', result }), { status: 200 });
      return new Response(JSON.stringify({ code: 'not-available', message: 'nope' }), { status: 404 });
    });
    await setSecret(CLAIM_CACHE_SECRET_ID, undefined);
    vi.mocked(deviceClaimCache).mockClear();

    expect(await factcheck()).toMatchObject({ ok: true });
    expect(paths).toContain(FACTCHECK_JOBS_PATH);
    expect(deviceClaimCache).not.toHaveBeenCalled();
    expect(await claimRows()).toStrictEqual([]);
    expect(await getSecret(CLAIM_CACHE_SECRET_ID)).toBeUndefined();
  });

  it('test_clear_data_removes_claim_checks', async () => {
    await setup();
    useAnthropic(twoDomains);
    expect((await factcheck()).ok).toBe(true);
    expect(await claimRows()).toHaveLength(1);
    const secret = await getSecret(CLAIM_CACHE_SECRET_ID);
    expect(secret).toBeDefined();

    const page = {} as Browser.runtime.MessageSender;
    expect(await handlers.clearData({ type: 'clearData', what: 'cache' }, page)).toStrictEqual({ ok: true });
    expect(await claimRows()).toStrictEqual([]);
    expect(await getSecret(CLAIM_CACHE_SECRET_ID)).toBe(secret);

    useAnthropic(twoDomains);
    expect((await factcheck(POST, KEY2)).ok).toBe(true);
    expect(kinds).toStrictEqual(['claims', 'research', 'verdict']);
    expect(await claimRows()).toHaveLength(1);
    expect(await handlers.clearData({ type: 'clearData', what: 'all' }, page)).toStrictEqual({ ok: true });
    expect(await claimRows()).toStrictEqual([]);
    expect(await getSecret(CLAIM_CACHE_SECRET_ID)).toBeUndefined();
  });
});
