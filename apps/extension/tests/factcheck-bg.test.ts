/**
 * Fact-check in the background (P3-06): the gates, one check per tab, the three Anthropic calls, the usage ledger and
 * the tab's session entries. Extension storage is the WXT fake browser, API keys fake-indexeddb, and the network the
 * mock Anthropic responder from @unalgorithm/ai/testing/anthropic (nothing real is called).
 */
import { describeError } from '@unalgorithm/ai';
import {
  type AnthropicRequestKind,
  mockAnthropicFetch,
  researchMessage,
  structuredMessage,
} from '@unalgorithm/ai/testing/anthropic';
import { type AISourceConfig, dayUsage, defaultDevice, sourceId } from '@unalgorithm/core';
import { FactcheckResultSchema, type PostForAI, type PostKey } from '@unalgorithm/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { setSecret } from '../src/background/idb.ts';
import { forgetTab } from '../src/background/tabs.ts';
import { handlers } from '../src/entrypoints/background.ts';
import type { BgRequest } from '../src/lib/messages.ts';
import { deviceItem, factcheckItem, usageItem } from '../src/lib/storage.ts';

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
let panelOpen: ReturnType<typeof vi.fn>;

async function setup(over: { source?: AISourceConfig | null; labs?: boolean } = {}) {
  const device = defaultDevice('dev1');
  await deviceItem.setValue({
    ...device,
    aiSource: over.source === undefined ? ANTHROPIC : over.source,
    labs: { ...device.labs, factcheck: over.labs ?? true },
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
  vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation((async () => permitted) as never);
  panelOpen = vi.fn(async () => undefined);
  vi.spyOn(fakeBrowser.sidePanel, 'open').mockImplementation(panelOpen as never);
  await setSecret(sourceId(ANTHROPIC), 'sk-ant-test');
  await setSecret(sourceId(OPENAI), 'sk-test');
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
      error: { code: 'not-available', message: 'Turn on Fact-check in Settings → Labs.' },
    });

    await setup({ source: OPENAI });
    expect(await factcheck()).toStrictEqual({
      ok: false,
      error: { code: 'unsupported', message: 'Fact-check needs your own Anthropic key.' },
    });

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
