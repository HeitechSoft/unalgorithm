/**
 * "Other perspectives" in the background (P3-38): the registry by build mode, every gate, the own-key pipeline and its
 * ledger, only the link leaving, the server path (canonical link, cancel on tab close), one run per tab, and the
 * check of a server's leans against this build's registry. Extension storage is the WXT fake browser, API keys
 * fake-indexeddb, Anthropic the mock responder and the server a stubbed fetch; outlets are the fictional fixture.
 * Nothing real is called.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AnthropicRequestKind,
  mockAnthropicFetch,
  researchMessage,
  structuredMessage,
} from '@unalgorithm/ai/testing/anthropic';
import { type AISourceConfig, dayUsage, defaultDevice, sourceId } from '@unalgorithm/core';
import type { Registry } from '@unalgorithm/outlets';
import { FIXTURE_REGISTRY } from '@unalgorithm/outlets/testing';
import {
  AUTHORIZE_PAGE_PATH,
  LEAN_BUCKETS,
  PERSPECTIVES_JOBS_PATH,
  type PerspectivesResult,
  PerspectivesResultSchema,
  type PostKey,
  perspectivesJobCancelPath,
  perspectivesJobPath,
  type ServerInfo,
  type SharedLink,
  TOKEN_PATH,
} from '@unalgorithm/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { runPerspectivesViaServer } from '../src/background/factcheck-server.ts';
import { setSecret } from '../src/background/idb.ts';
import { type ServerAccount, serverAccountItem } from '../src/background/server-auth.ts';
import { forgetTab } from '../src/background/tabs.ts';
import { handlers } from '../src/entrypoints/background.ts';
import type { BgRequest } from '../src/lib/messages.ts';
import { leansMatchRegistry } from '../src/lib/outlets.ts';
import { deviceItem, type FactcheckEntry, factcheckItem, usageItem } from '../src/lib/storage.ts';

const reg = vi.hoisted(() => ({ value: null as Registry | null }));
vi.mock('../src/lib/outlets.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/outlets.ts')>()),
  perspectivesRegistry: () => reg.value,
}));
const auth = vi.hoisted(() => ({ getAccessToken: vi.fn() }));
vi.mock('../src/background/server-auth.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/background/server-auth.ts')>()),
  getAccessToken: auth.getAccessToken,
}));
vi.mock('../src/background/factcheck-server.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/background/factcheck-server.ts')>();
  return { ...actual, runPerspectivesViaServer: vi.fn(actual.runPerspectivesViaServer) };
});

const ANTHROPIC: AISourceConfig = { kind: 'anthropic', model: null };
const COMPATIBLE: AISourceConfig = {
  kind: 'openai-compatible',
  preset: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  auth: 'none',
  model: 'llama',
};
const ORIGIN = 'https://ai.example.org';
const SERVER: AISourceConfig = { kind: 'server', baseUrl: `${ORIGIN}/` };
const TAB = 7;
const FEED_URL = 'https://www.linkedin.com/feed/';
const feedTab = (id = TAB) => ({ tab: { id, url: FEED_URL }, url: FEED_URL }) as Browser.runtime.MessageSender;
const KEY = 'li:urn:li:activity:1' as PostKey;
const LINK: SharedLink = { url: 'https://news.example.com/a', title: 'City bridge reopens after repairs' };
const MARKER = 'POST-TEXT-MARKER-7f3a';
const JOB_ID = '0199d6a4-3f1e-7c2a-9b5d-2e8f4a6c1b3e';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

type Reply = { status: number; body: unknown };
type Responder = (body: Record<string, unknown>, kind: AnthropicRequestKind) => Reply;

function userText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? (body.messages as { role: string; content: unknown }[]) : [];
  const content = messages.find((m) => m.role === 'user')?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((b: { text?: string }) => b.text ?? '').join('') : '';
}

/** A working Anthropic: a story query, one recent result per bucket search, every source matched in the comparison. */
const happy: Responder = (body, kind) => {
  if (kind === 'story') return { status: 200, body: structuredMessage({ query: 'city bridge reopens' }) };
  if (kind === 'research') {
    const tools = (body.tools ?? []) as { allowed_domains?: string[] }[];
    const domain = tools[0]?.allowed_domains?.[0] ?? 'none.example';
    const url = `https://${domain}/news/bridge`;
    const text = `The city bridge reopened this week after repairs, ${domain} reported.`;
    const pageAge = new Date(Date.now() - 3_600_000).toISOString();
    return {
      status: 200,
      body: researchMessage({
        results: [{ url, title: 'Bridge reopens', pageAge }],
        notes: [{ text: 'Coverage found.', cites: [{ url, citedText: text }] }],
        searches: 1,
      }),
    };
  }
  if (kind === 'comparison') {
    const tags = [...userText(body).matchAll(/<source_\w+ id="(s\d+)"[^>]*>\n([^\n]*)/g)];
    const comparison = {
      matched: tags.map(([, id]) => id),
      agreed: [
        {
          text: 'Several outlets report the bridge reopened.',
          citations: tags.slice(0, 2).map(([, sourceId = '', text = '']) => ({
            sourceId,
            quote: text.split(/\s+/).slice(0, 8).join(' '),
          })),
        },
      ],
      differences: [],
      unique: [],
    };
    return { status: 200, body: structuredMessage(comparison, { model: 'claude-sonnet-5-5' }) };
  }
  return { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'unexpected request' } } };
};

let anthropic: ReturnType<typeof mockAnthropicFetch>;
let kinds: AnthropicRequestKind[];
/** Every fetch, Anthropic's or the server's. */
let requests: { url: URL; init: RequestInit }[];
type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** Anthropic answers its own host; `server` the rest. `beforeAnthropic` runs ahead of each Anthropic answer. */
function useNetwork(opts: { reply?: Responder; server?: Route; beforeAnthropic?: (kind: AnthropicRequestKind) => unknown } = {}) {
  kinds = [];
  requests = [];
  const reply = opts.reply ?? happy;
  anthropic = mockAnthropicFetch((body, kind) => {
    kinds.push(kind);
    return reply(body, kind);
  });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    requests.push({ url, init });
    if (url.hostname === 'api.anthropic.com') {
      const kind = String(init.body ?? '').includes('"tools"') ? 'research' : 'other';
      await opts.beforeAnthropic?.(kind as AnthropicRequestKind);
      return anthropic(input, init);
    }
    if (opts.server) return opts.server(url, init);
    return new Response('{}', { status: 404 });
  });
}

const INFO: ServerInfo = {
  v: 1,
  name: 'Example AI',
  version: '0.1.0',
  source: 'https://github.com/example/unalgorithm',
  billing: false,
  capabilities: { classify: true, sync: false, factcheck: true, perspectives: true },
  auth: { methods: ['email-otp'], authorizePath: AUTHORIZE_PAGE_PATH, tokenPath: TOKEN_PATH },
  limits: { maxPostsPerRequest: 12 },
};
const account = (info: ServerInfo = INFO): ServerAccount => ({
  origin: ORIGIN,
  email: 'ada@example.org',
  deviceId: '0199d6a4-3f1e-7c2a-9b5d-2e8f4a6c1b3d',
  signedInAt: Date.UTC(2026, 9, 12, 9),
  info,
  needsSignIn: false,
});

async function setup(over: { source?: AISourceConfig | null; labs?: boolean; info?: ServerInfo } = {}) {
  const device = defaultDevice('dev1');
  const source = over.source === undefined ? ANTHROPIC : over.source;
  await deviceItem.setValue({ ...device, aiSource: source, labs: { ...device.labs, perspectives: over.labs ?? true } });
  if (source?.kind === 'server') await serverAccountItem.setValue(account(over.info));
}

type PerspectivesMsg = Extract<BgRequest, { type: 'perspectives' }>;
function perspectives(over: Partial<PerspectivesMsg> & Record<string, unknown> = {}, sender = feedTab()) {
  const msg = { type: 'perspectives', key: KEY, link: LINK, platform: 'linkedin', ...over } as PerspectivesMsg;
  return handlers.perspectives(msg, sender);
}
const entries = async (tabId = TAB) => (await factcheckItem(tabId).getValue()).entries;

const outletName = (id: string) => FIXTURE_REGISTRY.outlets.find((o) => o.id === id)?.name ?? '';
/** A valid result naming one fixture outlet per bucket. */
function fixtureResult(): PerspectivesResult {
  return {
    v: 1,
    checkedAt: '2026-10-15T09:00:00.000Z',
    model: 'claude-sonnet-5-5',
    promptVersion: 1,
    registryVersion: FIXTURE_REGISTRY.meta.version,
    story: {
      url: LINK.url,
      query: 'city bridge reopens',
      from: '2026-10-12T09:00:00.000Z',
      to: '2026-10-15T09:00:00.000Z',
    },
    coverage: LEAN_BUCKETS.map((bucket, i) => ({ bucket, sourceIds: [`s${i + 1}`] })),
    agreed: [{ text: 'The bridge reopened.', citations: [{ sourceId: 's1', quote: 'The city bridge reopened' }] }],
    differences: [],
    unique: [],
    sources: LEAN_BUCKETS.map((bucket, i) => ({
      id: `s${i + 1}`,
      url: `https://${bucket}-a.example/news/bridge`,
      domain: `${bucket}-a.example`,
      title: 'Bridge reopens',
      pageAge: '2026-10-14',
      outletId: `fx-${bucket}-a`,
      outlet: outletName(`fx-${bucket}-a`),
      bucket,
    })),
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const job = (status: string, over: Record<string, unknown> = {}) => ({ v: 1, id: JOB_ID, status, ...over });
const isStart = (url: URL, init: RequestInit) => url.pathname === PERSPECTIVES_JOBS_PATH && init.method === 'POST';
const isPoll = (url: URL) => url.pathname === perspectivesJobPath(JOB_ID);
const isCancel = (url: URL) => url.pathname === perspectivesJobCancelPath(JOB_ID);
/** Starts running, then done with `result`. */
const doneServer =
  (result: PerspectivesResult): Route =>
  (url, init) => {
    if (isStart(url, init)) return json(202, job('running'));
    if (isPoll(url)) return json(200, job('done', { result }));
    return json(404, { code: 'not-available', message: 'nope' });
  };

beforeEach(async () => {
  fakeBrowser.reset();
  reg.value = FIXTURE_REGISTRY;
  auth.getAccessToken.mockReset();
  auth.getAccessToken.mockResolvedValue('access-token-1');
  vi.mocked(runPerspectivesViaServer).mockClear();
  vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation((async () => true) as never);
  vi.spyOn(fakeBrowser.sidePanel, 'open').mockImplementation((async () => undefined) as never);
  await setSecret(sourceId(ANTHROPIC), 'sk-ant-test');
  useNetwork();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.doUnmock('@unalgorithm/outlets');
});

describe('registry', () => {
  it('test_perspectives_registry_by_build_mode', async () => {
    const load = async () => {
      vi.resetModules();
      const mod = await vi.importActual<typeof import('../src/lib/outlets.ts')>('../src/lib/outlets.ts');
      return mod.perspectivesRegistry();
    };
    // The shipped draft, in this (non-e2e) mode.
    expect(import.meta.env.MODE).not.toBe('e2e');
    expect(await load()).toBeNull();

    vi.stubEnv('MODE', 'e2e');
    expect(await load()).toStrictEqual(FIXTURE_REGISTRY);
    vi.unstubAllEnvs();

    const ready: Registry = { ...FIXTURE_REGISTRY, meta: { ...FIXTURE_REGISTRY.meta, status: 'reviewed' } };
    vi.doMock('@unalgorithm/outlets', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@unalgorithm/outlets')>()),
      bundledRegistry: () => ready,
    }));
    expect(await load()).toBe(ready);
  });
});

describe('gates', () => {
  it('test_perspectives_bg_gates', async () => {
    const refusal = (code: string, message: string) => ({ ok: false, error: { code, message } });

    await setup({ labs: false });
    expect(await perspectives()).toStrictEqual(refusal('not-available', 'Turn on Other perspectives in Settings → Labs.'));

    await setup();
    reg.value = null;
    expect(await perspectives()).toStrictEqual(refusal('not-available', "Other perspectives isn't available yet."));
    reg.value = FIXTURE_REGISTRY;

    expect(await perspectives({ link: { url: 'javascript:alert(1)' } })).toStrictEqual(
      refusal('bad-request', "This link can't be compared."),
    );

    expect(await perspectives({ platform: 'facebook', audience: 'friends' })).toStrictEqual(
      refusal('not-available', 'Other perspectives works only on public posts.'),
    );

    await setup({ source: COMPATIBLE });
    expect(await perspectives()).toStrictEqual(
      refusal('unsupported', 'Other perspectives needs your own Anthropic key or a server that offers it.'),
    );

    await setup({ source: SERVER, info: { ...INFO, capabilities: { ...INFO.capabilities, perspectives: false } } });
    expect(await perspectives()).toStrictEqual(refusal('unsupported', "This server doesn't offer Other perspectives."));

    expect(requests).toHaveLength(0);
    expect(await entries()).toStrictEqual([]);
  });
});

describe('runs', () => {
  it('test_perspectives_bg_own_key_run_and_ledger', async () => {
    await setup();
    const seen: string[][] = [];
    useNetwork({
      beforeAnthropic: async () => {
        seen.push((await entries()).map((e) => e.status));
      },
    });
    const res = await perspectives();
    expect(res.ok).toBe(true);
    expect(kinds.filter((k) => k === 'story')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'research')).toHaveLength(5);
    expect(kinds.filter((k) => k === 'comparison')).toHaveLength(1);
    expect(kinds).toHaveLength(7);
    expect(seen.every((s) => s[0] === 'running')).toBe(true);

    const [entry] = await entries();
    expect(entry).toMatchObject({ key: KEY, task: 'perspectives', status: 'done', label: LINK.title });
    expect(entry?.result).toBeUndefined();
    expect(PerspectivesResultSchema.safeParse(entry?.perspectives).success).toBe(true);
    expect(entry?.perspectives?.sources).toHaveLength(5);
    if (res.ok) {
      expect(res.result).toStrictEqual(entry?.perspectives);
      expect(res.costMicros).toBe(entry?.costMicros);
    }

    const day = dayUsage(await usageItem.getValue());
    expect(day.posts).toBe(0);
    expect(day.calls).toBe(7);
    expect(day.failedCalls).toBe(0);
    expect(Object.values(day.byModel).reduce((n, m) => n + m.calls, 0)).toBe(7);
  });

  it('test_perspectives_bg_only_link_leaves', async () => {
    await setup();
    const res = await perspectives({ text: MARKER, link: { ...LINK, text: MARKER } as SharedLink });
    // A link carrying anything but a URL and a title is refused before anything is sent.
    expect(res).toStrictEqual({ ok: false, error: { code: 'bad-request', message: "This link can't be compared." } });
    expect(requests).toHaveLength(0);

    expect((await perspectives({ text: MARKER })).ok).toBe(true);
    expect(anthropic.bodies.length).toBeGreaterThan(0);
    for (const body of anthropic.bodies) expect(JSON.stringify(body)).not.toContain(MARKER);
    expect(JSON.stringify(await entries())).not.toContain(MARKER);
    expect(JSON.stringify(await usageItem.getValue())).not.toContain(MARKER);
    expect((await entries())[0]?.label).toBe(LINK.title);
  });

  it('test_perspectives_bg_server_path_and_tab_close', async () => {
    await setup({ source: SERVER });
    useNetwork({ server: doneServer(fixtureResult()) });
    const tracked = { url: 'https://news.example.com/a?utm_source=x&li_fat_id=y', title: LINK.title };
    const res = await perspectives({ link: tracked, platform: 'facebook', audience: 'public', text: MARKER });
    expect(res.ok).toBe(true);
    const [call] = vi.mocked(runPerspectivesViaServer).mock.calls;
    expect(call?.[1]).toStrictEqual({ link: LINK, platform: 'facebook', audience: 'public' });
    const start = requests.find((r) => isStart(r.url, r.init));
    expect(JSON.parse(String(start?.init.body))).toStrictEqual({ v: 1, link: LINK, platform: 'facebook', audience: 'public' });
    expect(JSON.stringify(requests.map((r) => [String(r.url), r.init.body]))).not.toMatch(/utm_source|li_fat_id|MARKER/);
    expect((await entries())[0]).toMatchObject({ task: 'perspectives', status: 'done', perspectives: fixtureResult() });

    // Closing the tab while the job runs cancels it on the server.
    await factcheckItem(TAB).removeValue();
    let polling!: () => void;
    const polled = new Promise<void>((r) => {
      polling = r;
    });
    useNetwork({
      server: (url, init) => {
        if (isStart(url, init)) return json(202, job('running'));
        if (isCancel(url)) return json(200, job('cancelled'));
        polling();
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      },
    });
    const pending = perspectives();
    await polled;
    expect(await entries()).toHaveLength(1);
    await forgetTab(TAB);
    expect((await pending).ok).toBe(false);
    const cancels = requests.filter((r) => isCancel(r.url));
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.init.method).toBe('POST');
    expect(await fakeBrowser.storage.session.get(`factcheck:${TAB}`)).toEqual({});
  });

  it('test_perspectives_bg_one_run_per_tab_and_old_entries', async () => {
    await setup();
    // A fact-check stored before RM3: no `task`.
    const old: FactcheckEntry = {
      key: 'li:urn:li:activity:0' as PostKey,
      label: 'An earlier post',
      startedAt: 1,
      status: 'done',
      result: {
        v: 1,
        checkedAt: '2026-10-14T09:00:00.000Z',
        model: 'claude-sonnet-5-5',
        promptVersion: 1,
        claims: [],
        sources: [],
      },
    };
    await factcheckItem(TAB).setValue({ entries: [old] });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let searching!: () => void;
    const started = new Promise<void>((r) => {
      searching = r;
    });
    useNetwork({
      beforeAnthropic: async (kind) => {
        if (kind !== 'research') return;
        searching();
        await gate;
      },
    });
    const first = perspectives();
    await started;
    expect(await perspectives()).toStrictEqual({
      ok: false,
      error: { code: 'rate-limit', message: 'A check or comparison is already running on this page.' },
    });
    release();
    expect((await first).ok).toBe(true);
    expect(kinds.filter((k) => k === 'story')).toHaveLength(1);

    const [comparison, factcheck] = await entries();
    expect(comparison?.task).toBe('perspectives');
    expect(factcheck).toStrictEqual(old);
    expect(factcheck?.task).toBeUndefined();
  });

  it('test_perspectives_bg_web_search_off', async () => {
    await setup();
    useNetwork({
      reply: (body, kind) =>
        kind === 'research'
          ? {
              status: 400,
              body: {
                type: 'error',
                error: { type: 'invalid_request_error', message: 'The web_search tool is not enabled for this organization.' },
              },
            }
          : happy(body, kind),
    });
    const error = { code: 'unsupported', message: "Web search isn't turned on for this Anthropic account." };
    expect(await perspectives()).toStrictEqual({ ok: false, error });
    expect((await entries())[0]).toMatchObject({ task: 'perspectives', status: 'failed', error });
  });

  it('test_perspectives_bg_server_leans_checked_against_own_registry', async () => {
    const valid = fixtureResult();
    expect(PerspectivesResultSchema.safeParse(valid).success).toBe(true);
    expect(leansMatchRegistry(valid, FIXTURE_REGISTRY)).toBe(true);

    const changed = (edit: (r: PerspectivesResult) => void) => {
      const r = structuredClone(valid);
      edit(r);
      return leansMatchRegistry(r, FIXTURE_REGISTRY);
    };
    const first = (r: PerspectivesResult) => r.sources[0] as PerspectivesResult['sources'][number];
    expect(changed((r) => void (first(r).bucket = 'right'))).toBe(false);
    expect(changed((r) => void (first(r).outletId = 'fx-left-b'))).toBe(false);
    expect(changed((r) => void (first(r).domain = 'nowhere.example'))).toBe(false);
    expect(changed((r) => void (first(r).url = 'https://nowhere.example/news/bridge'))).toBe(false);
    expect(changed((r) => void ((r.coverage[0] as { sourceIds: string[] }).sourceIds = ['s2']))).toBe(false);
    const unlabelled: Registry = {
      ...FIXTURE_REGISTRY,
      outlets: FIXTURE_REGISTRY.outlets.map((o) => (o.id === 'fx-left-a' ? { ...o, lean: null } : o)),
    };
    expect(leansMatchRegistry(valid, unlabelled)).toBe(false);

    // A server whose result carries a lean this build's registry doesn't hold: failed, nothing stored.
    await setup({ source: SERVER });
    const relabelled = structuredClone(valid);
    first(relabelled).bucket = 'center';
    useNetwork({ server: doneServer(relabelled) });
    const error = {
      code: 'not-available',
      message: "This server's outlet list doesn't match this version of UnAlgorithm, so the comparison isn't shown.",
    };
    expect(await perspectives()).toStrictEqual({ ok: false, error });
    const [entry] = await entries();
    expect(entry).toMatchObject({ task: 'perspectives', status: 'failed', error });
    expect(entry?.perspectives).toBeUndefined();
  });
});

describe('docs', () => {
  it('test_privacy_mentions_perspectives_flows', () => {
    const privacy = readFileSync(join(REPO_ROOT, 'PRIVACY.md'), 'utf8');
    const paragraph = (start: string) => privacy.split(/\n\n/).find((p) => p.startsWith(start)) ?? '';
    const ownKey = paragraph('**Other perspectives (Labs');
    const server = paragraph('**Other perspectives on your UnAlgorithm server');
    for (const p of [ownKey, server]) {
      expect(p).toContain('Other perspectives');
      expect(p).toMatch(/never the post's text|post's text is never sent/);
    }
    expect(ownKey).toContain('Anthropic');
    expect(server).toContain('10 minutes');
  });
});
