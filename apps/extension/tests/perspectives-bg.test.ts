/**
 * UnEcho Chamber in the background (P3-38, P3-46, P3-77): the chosen source list and its gate, every gate, the own-key
 * pipeline (Anthropic, OpenAI, OpenAI-compatible with a Brave key) on the chosen list and its ledger, only the link and
 * the list's web addresses leaving, the server path (canonical link, the list in the body, cancel on tab close), one run
 * per tab, and the check of every lean against the list sent.
 * Extension storage is the WXT fake browser, API keys fake-indexeddb, Anthropic and OpenAI the mock responders, the
 * compat server, Brave and the unAlgorithm server stubbed fetches; outlets are the fictional fixture. Nothing real is
 * called.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mockStructuredAnswer } from '@unalgorithm/ai/testing';
import {
  type AnthropicRequestKind,
  mockAnthropicFetch,
  researchMessage,
  structuredMessage,
} from '@unalgorithm/ai/testing/anthropic';
import {
  mockOpenAIResponsesFetch,
  mockResponsesAnswer,
  type ResponsesRequestKind,
  researchResponse,
} from '@unalgorithm/ai/testing/openai-responses';
import {
  type AISourceConfig,
  dayUsage,
  defaultDevice,
  defaultSettings,
  type OwnOutlet,
  sourceId,
  type WebSearchKey,
} from '@unalgorithm/core';
import {
  type ListedOutlet,
  outletForHost,
  outletsIn,
  ownSourceList,
  type SourceList,
  sourceListFromWire,
  wireList,
} from '@unalgorithm/outlets';
import { FIXTURE_LIST, FIXTURE_OFFICIAL_LIST } from '@unalgorithm/outlets/testing';
import {
  AUTHORIZE_PAGE_PATH,
  LEAN_BUCKETS,
  type LeanBucket,
  PERSPECTIVES_JOBS_PATH,
  type PerspectivesList,
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
import { chosenList, listReady, matchLeans, namedListProblems } from '../src/lib/outlets.ts';
import { deviceItem, type FactcheckEntry, factcheckItem, officialListItem, settingsItem, usageItem } from '../src/lib/storage.ts';

/** `refuse`: the leans check refuses every result (an own-key mismatch, which the real pipeline can't produce). */
const leans = vi.hoisted(() => ({ refuse: false }));
vi.mock('../src/lib/outlets.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/outlets.ts')>();
  return {
    ...actual,
    matchLeans: (...args: Parameters<typeof actual.matchLeans>) => (leans.refuse ? null : actual.matchLeans(...args)),
  };
});
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

async function setup(
  over: { source?: AISourceConfig | null; labs?: boolean; info?: ServerInfo; webSearch?: WebSearchKey | null } = {},
) {
  const device = defaultDevice('dev1');
  const source = over.source === undefined ? ANTHROPIC : over.source;
  await deviceItem.setValue({
    ...device,
    aiSource: source,
    labs: { ...device.labs, perspectives: over.labs ?? true },
    webSearch: over.webSearch ?? null,
  });
  if (source?.kind === 'server') await serverAccountItem.setValue(account(over.info));
}

type PerspectivesMsg = Extract<BgRequest, { type: 'perspectives' }>;
function perspectives(over: Partial<PerspectivesMsg> & Record<string, unknown> = {}, sender = feedTab()) {
  const msg = { type: 'perspectives', key: KEY, link: LINK, platform: 'linkedin', ...over } as PerspectivesMsg;
  return handlers.perspectives(msg, sender);
}
const entries = async (tabId = TAB) => (await factcheckItem(tabId).getValue()).entries;

/**
 * A valid result on `list`: one source per bucket with an outlet, on that bucket's first outlet (by id) and its first web
 * address, named as `list` names it; the other buckets are gaps.
 */
function resultFor(list: SourceList): PerspectivesResult {
  const picked = LEAN_BUCKETS.flatMap((bucket) => {
    const outlet = outletsIn(list, bucket)[0];
    return outlet ? [{ bucket, outlet }] : [];
  });
  return {
    v: 1,
    checkedAt: '2026-10-15T09:00:00.000Z',
    model: 'claude-sonnet-5-5',
    promptVersion: 1,
    registryVersion: list.version,
    list: list.kind,
    story: {
      url: LINK.url,
      query: 'city bridge reopens',
      from: '2026-10-12T09:00:00.000Z',
      to: '2026-10-15T09:00:00.000Z',
    },
    coverage: LEAN_BUCKETS.map((bucket) => {
      const i = picked.findIndex((p) => p.bucket === bucket);
      return { bucket, sourceIds: i < 0 ? [] : [`s${i + 1}`] };
    }),
    agreed: [{ text: 'The bridge reopened.', citations: [{ sourceId: 's1', quote: 'The city bridge reopened' }] }],
    differences: [],
    unique: [],
    sources: picked.map(({ bucket, outlet }, i) => ({
      id: `s${i + 1}`,
      url: `https://${outlet.domains[0]}/news/bridge`,
      domain: outlet.domains[0] as string,
      title: 'Bridge reopens',
      pageAge: '2026-10-14',
      outletId: outlet.id,
      outlet: outlet.name,
      bucket,
    })),
  };
}
/** A valid result naming one fixture outlet per bucket, as the fixture list names it. */
const fixtureResult = (): PerspectivesResult => resultFor(FIXTURE_LIST);
/** What a server answers for `list`: the list it was sent, its outlets `o1`…`oN` named by web address. */
const serverAnswer = (list: SourceList): PerspectivesResult => resultFor(sourceListFromWire(wireList(list) as PerspectivesList));
/** Each source's web address with the outlet id and name `list` gives it. */
const namesOn = (r: PerspectivesResult | undefined, list: SourceList) =>
  (r?.sources ?? []).map((s) => [s.domain, outletForHost(list, s.domain)?.id, outletForHost(list, s.domain)?.name]);
const namesIn = (r: PerspectivesResult | undefined) => (r?.sources ?? []).map((s) => [s.domain, s.outletId, s.outlet]);

const own = (name: string, domains: string[], bucket: LeanBucket | null): OwnOutlet => ({ name, domains, bucket, addedAt: 1 });
/**
 * The person's own list: the fixture's outlets without its Right ones, under their own ids and names ("My Left A" on
 * `left-a.example`). Unbalanced: no outlet in Right.
 */
const MY_OUTLETS: Record<string, OwnOutlet> = Object.fromEntries(
  FIXTURE_LIST.outlets
    .filter((o) => o.lean && o.lean.bucket !== 'right')
    .map((o) => [`my-${o.id.slice(3)}`, own(`My ${o.name.slice('Fixture '.length)}`, [...o.domains], o.lean?.bucket ?? null)]),
);
/** Settings with the person's own list chosen, holding `outlets`. */
async function chooseOwnList(outlets: Record<string, OwnOutlet>) {
  const settings = defaultSettings();
  settings.perspectives = { list: 'own', outlets };
  await settingsItem.setValue(settings);
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
  leans.refuse = false;
  // unAlgorithm Cloud's list (the default choice), stored: the fictional fixture.
  await officialListItem.setValue({ list: FIXTURE_OFFICIAL_LIST, checkedAt: 1 });
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
});

describe('the chosen list', () => {
  it('test_chosen_list_and_ready', async () => {
    const settings = defaultSettings();
    // unAlgorithm Cloud's stored copy (the default choice), or null before the first one.
    expect(chosenList(settings, FIXTURE_OFFICIAL_LIST)).toStrictEqual(FIXTURE_LIST);
    expect(chosenList(settings, null)).toBeNull();
    // The person's own, whatever the Cloud's.
    settings.perspectives = { list: 'own', outlets: MY_OUTLETS };
    expect(chosenList(settings, FIXTURE_OFFICIAL_LIST)).toStrictEqual(ownSourceList(MY_OUTLETS));
    expect(chosenList(settings, null)?.kind).toBe('own');

    // Ready: an outlet with a lean and no list problem. Unbalanced warns, never blocks (D101).
    expect(listReady(FIXTURE_LIST)).toBe(true);
    expect(listReady(ownSourceList(MY_OUTLETS))).toBe(true);
    expect(listReady(ownSourceList({ 'my-a': own('My A', ['a.example'], 'center') }))).toBe(true);
    expect(listReady(null)).toBe(false);
    expect(listReady(ownSourceList({}))).toBe(false);
    expect(listReady(ownSourceList({ 'my-a': own('My A', ['a.example'], null) }))).toBe(false);
    expect(listReady({ ...FIXTURE_LIST, outlets: FIXTURE_LIST.outlets.map((o) => ({ ...o, lean: null })) })).toBe(false);
    expect(listReady(ownSourceList({ ...MY_OUTLETS, 'my-zz-copy': own('My Copy', ['left-a.example'], 'right') }))).toBe(false);

    // A list's problems name the outlet by its name, keeping its id to reach it; a cap names none, and a repeated id
    // is about the id itself.
    expect(
      namedListProblems(ownSourceList({ ...MY_OUTLETS, 'my-zz-copy': own('My Copy', ['left-a.example'], 'right') })),
    ).toEqual([
      {
        code: 'domain-taken',
        outletId: 'my-zz-copy',
        name: 'My Copy',
        text: 'My Copy: another outlet already lists one of its web addresses.',
      },
    ]);
    const [first] = FIXTURE_LIST.outlets;
    expect(
      namedListProblems({ outlets: [...FIXTURE_LIST.outlets, { ...(first as ListedOutlet), domains: ['twin.example'] }] }),
    ).toEqual([{ code: 'duplicate-id', outletId: first?.id, name: first?.name, text: `Two outlets have the id ${first?.id}.` }]);
    expect(namedListProblems(FIXTURE_LIST)).toEqual([]);

    // E2E builds read the fixture as the Cloud's list, and never fetch.
    expect(import.meta.env.MODE).not.toBe('e2e');
    vi.stubEnv('MODE', 'e2e');
    vi.resetModules();
    const e2e = await vi.importActual<typeof import('../src/lib/outlets.ts')>('../src/lib/outlets.ts');
    expect(e2e.chosenList(defaultSettings(), e2e.storedOfficialList({ list: null, checkedAt: 0 }))).toStrictEqual(FIXTURE_LIST);
    vi.unstubAllEnvs();
  });

  it('test_perspectives_refuses_list_not_ready', async () => {
    const refusal = (message: string) => ({ ok: false, error: { code: 'not-available', message } });
    const CLOUD = "unAlgorithm Cloud's source list has no outlets with a lean yet. You can use your own list in Settings → AI.";
    const OWN = 'Your source list has no outlets with a lean yet. Add some in Settings → AI.';
    const noLean = { ...FIXTURE_OFFICIAL_LIST, outlets: FIXTURE_OFFICIAL_LIST.outlets.map((o) => ({ ...o, lean: null })) };
    useNetwork({ server: doneServer(fixtureResult()) });
    for (const source of [ANTHROPIC, SERVER]) {
      await setup({ source });
      // unAlgorithm Cloud's list chosen (the default): its stored copy has no lean, or none is stored yet.
      await officialListItem.setValue({ list: noLean, checkedAt: 1 });
      expect(await perspectives()).toStrictEqual(refusal(CLOUD));
      await officialListItem.setValue({ list: null, checkedAt: 1 });
      expect(await perspectives()).toStrictEqual(refusal(CLOUD));
      // Your own list chosen: empty, or no outlet with a lean.
      await chooseOwnList({});
      expect(await perspectives()).toStrictEqual(refusal(OWN));
      await chooseOwnList({ 'my-a': own('My A', ['a.example'], null) });
      expect(await perspectives()).toStrictEqual(refusal(OWN));
      // A web address in two of your outlets: what to fix, naming the outlet by its name, never its id.
      await chooseOwnList({ ...MY_OUTLETS, 'my-zz-copy': own('My Copy', ['left-a.example'], 'right') });
      expect(await perspectives()).toStrictEqual(
        refusal(
          'Your source list needs fixing in Settings → AI: My Copy: another outlet already lists one of its web addresses.',
        ),
      );
      await settingsItem.removeValue();
      await officialListItem.setValue({ list: FIXTURE_OFFICIAL_LIST, checkedAt: 1 });
    }
    // Nothing was sent, and no comparison started.
    expect(requests).toHaveLength(0);
    expect(await entries()).toStrictEqual([]);
  });
});

describe('gates', () => {
  it('test_perspectives_bg_gates', async () => {
    const refusal = (code: string, message: string) => ({ ok: false, error: { code, message } });

    await setup({ labs: false });
    expect(await perspectives()).toStrictEqual(refusal('not-available', 'Turn on UnEcho Chamber in Settings → AI.'));

    await setup();
    expect(await perspectives({ link: { url: 'javascript:alert(1)' } })).toStrictEqual(
      refusal('bad-request', "This link can't be compared."),
    );

    expect(await perspectives({ platform: 'facebook', audience: 'friends' })).toStrictEqual(
      refusal('not-available', 'UnEcho Chamber works only on public posts.'),
    );
    // A platform or audience the protocol doesn't know can't be shown public, and never leaves as sent.
    const unknownPlaces = [
      { platform: 'Facebook', audience: 'friends' },
      { platform: MARKER },
      { platform: 'linkedin', audience: MARKER },
    ];
    for (const place of unknownPlaces) {
      expect(await perspectives(place as never)).toStrictEqual(
        refusal('not-available', 'UnEcho Chamber works only on public posts.'),
      );
    }
    await setup({ source: SERVER });
    for (const place of unknownPlaces) {
      expect(await perspectives(place as never)).toStrictEqual(
        refusal('not-available', 'UnEcho Chamber works only on public posts.'),
      );
    }

    await setup({ source: COMPATIBLE });
    expect(await perspectives()).toStrictEqual(
      refusal(
        'unsupported',
        'UnEcho Chamber needs your own Anthropic or OpenAI key, an AI server with a web search key, or a server that offers it.',
      ),
    );

    await setup({ source: SERVER, info: { ...INFO, capabilities: { ...INFO.capabilities, perspectives: false } } });
    expect(await perspectives()).toStrictEqual(refusal('unsupported', "This server doesn't offer UnEcho Chamber."));

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
    const list = wireList(FIXTURE_LIST);
    expect(call?.[1]).toStrictEqual({ link: LINK, platform: 'facebook', audience: 'public', list });
    const start = requests.find((r) => isStart(r.url, r.init));
    expect(JSON.parse(String(start?.init.body))).toStrictEqual({
      v: 1,
      link: LINK,
      platform: 'facebook',
      audience: 'public',
      list,
    });
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

  it('test_perspectives_openai_and_compat_link_only', async () => {
    const OPENAI: AISourceConfig = { kind: 'openai', model: null };
    await setSecret(sourceId(OPENAI), 'sk-test');
    await setSecret('search:brave', 'brave-test-key');
    // Dated in the path (OpenAI's sources carry no date) or by `page_age` (Brave), inside the story's window.
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const articleUrl = (domain: string) => `https://${domain}/${day.replaceAll('-', '/')}/bridge`;
    const articleText = (domain: string) => `The city bridge reopened this week after repairs, ${domain} reported.`;

    /** OpenAI: the mock's story query and comparison; each bucket search answers one article on its first allowed domain. */
    const openaiAnswer = (kind: ResponsesRequestKind, body: unknown): unknown => {
      if (kind !== 'research') return mockResponsesAnswer(body);
      const tools = ((body as { tools?: { filters?: { allowed_domains?: string[] } }[] }).tools ?? []) as {
        filters?: { allowed_domains?: string[] };
      }[];
      const domain = tools[0]?.filters?.allowed_domains?.[0] ?? 'none.example';
      const text = articleText(domain);
      return researchResponse({
        searches: [{ urls: [articleUrl(domain)] }],
        text,
        citations: [{ url: articleUrl(domain), title: 'Bridge reopens', start: 0, end: text.length }],
        model: 'gpt-5-mini',
      });
    };
    const net = { urls: [] as URL[], bodies: [] as string[], braveQueries: [] as string[] };
    const openai = mockOpenAIResponsesFetch(openaiAnswer);
    const jsonOk = (data: unknown) =>
      new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      net.urls.push(url);
      net.bodies.push(typeof init.body === 'string' ? init.body : '');
      if (url.hostname === 'api.openai.com') return openai(input, init);
      if (url.hostname === 'api.search.brave.com') {
        const q = url.searchParams.get('q') ?? '';
        net.braveQueries.push(q);
        const domain = /site:([^\s)]+)/.exec(q)?.[1] ?? 'none.example';
        const hit = { url: articleUrl(domain), title: 'Bridge reopens', description: articleText(domain), page_age: day };
        return jsonOk({ web: { results: [hit] } });
      }
      if (url.href.startsWith('http://localhost:11434/v1/')) {
        const body = JSON.parse(String(init.body)) as { model: string; messages: { role: string; content: string }[] };
        const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
        return jsonOk({
          model: body.model,
          choices: [{ message: { content: JSON.stringify(mockStructuredAnswer(user).json) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1000, completion_tokens: 50 },
        });
      }
      throw new Error(`unexpected request to ${url.href}`);
    });
    const tracked = { url: `${LINK.url}?utm_source=x&li_fat_id=y`, title: LINK.title };
    const sent = () => JSON.stringify(net.urls.map((u, i) => [u.href, net.bodies[i]]));

    // OpenAI: only the canonical link and title leave, and only to OpenAI.
    await setup({ source: OPENAI });
    const viaOpenai = await perspectives({ link: tracked, text: MARKER });
    expect(viaOpenai.ok).toBe(true);
    for (const url of net.urls) expect(url.hostname).toBe('api.openai.com');
    expect(sent()).not.toMatch(/POST-TEXT-MARKER|utm_source|li_fat_id/);
    expect(sent()).toContain(LINK.url);
    expect((await entries())[0]).toMatchObject({ task: 'perspectives', status: 'done' });
    expect((await entries())[0]?.perspectives?.sources).toHaveLength(5);

    // OpenAI-compatible with a Brave key: five searches, one per bucket, each on that bucket's fixture domains only.
    await factcheckItem(TAB).removeValue();
    net.urls.length = 0;
    net.bodies.length = 0;
    await setup({ source: COMPATIBLE, webSearch: { provider: 'brave' } });
    const viaCompat = await perspectives({ link: tracked, text: MARKER });
    expect(viaCompat.ok).toBe(true);
    expect(net.braveQueries).toHaveLength(5);
    const sites = net.braveQueries.map((q) => [...q.matchAll(/site:([^\s)]+)/g)].map((m) => m[1]).sort());
    const expected = LEAN_BUCKETS.map((bucket) => [`${bucket}-a.example`, `${bucket}-b.example`]);
    expect([...sites].sort()).toStrictEqual([...expected].sort());
    for (const url of net.urls) {
      if (url.hostname !== 'api.search.brave.com') expect(url.href.startsWith('http://localhost:11434/v1/')).toBe(true);
    }
    expect(sent()).not.toMatch(/POST-TEXT-MARKER|utm_source|li_fat_id/);
    const [entry] = await entries();
    expect(entry).toMatchObject({ task: 'perspectives', status: 'done' });
    expect(entry?.costMicros).toBeUndefined();

    // A result whose leans don't match the list sent is refused, on own keys as on a server.
    leans.refuse = true;
    expect(await perspectives()).toMatchObject({ ok: false, error: { code: 'not-available' } });
    expect((await entries())[0]).toMatchObject({ status: 'failed' });

    // Every model call is in the ledger, none counted as a post.
    const ledger = dayUsage(await usageItem.getValue());
    expect(ledger.posts).toBe(0);
    expect(ledger.byModel['gpt-5']?.calls).toBe(1);
    expect(ledger.byModel['gpt-5-mini']?.calls).toBe(6);
    // Two compat runs of seven calls: the story query, five bucket searches (zero usage, under the model) and the comparison.
    expect(ledger.byModel.llama?.calls).toBe(14);
  });

  it('test_perspectives_server_body_carries_wire_list', async () => {
    // unAlgorithm Cloud's list (the fixture): its wire list goes, never an outlet's name or id.
    await setup({ source: SERVER });
    const answer = serverAnswer(FIXTURE_LIST);
    useNetwork({ server: doneServer(answer) });
    const res = await perspectives();
    expect(res.ok).toBe(true);
    const start = requests.find((r) => isStart(r.url, r.init));
    const body = JSON.parse(String(start?.init.body)) as { list: unknown };
    expect(body.list).toStrictEqual(wireList(FIXTURE_LIST));
    const sent = String(start?.init.body);
    for (const o of FIXTURE_LIST.outlets) {
      expect(sent).not.toContain(o.name);
      expect(sent).not.toContain(`"${o.id}"`);
    }
    // The server named its outlets by web address; the stored result carries the chosen list's ids and names.
    const [entry] = await entries();
    expect(entry).toMatchObject({ task: 'perspectives', status: 'done', listWarnings: [] });
    expect(namesIn(answer).every(([domain, id, name]) => /^o\d+$/.test(String(id)) && name === domain)).toBe(true);
    expect(namesIn(entry?.perspectives)).toStrictEqual(namesOn(answer, FIXTURE_LIST));
    expect(namesIn(entry?.perspectives).every(([, , name]) => String(name).startsWith('Fixture '))).toBe(true);
    expect({ ...entry?.perspectives, sources: [] }).toStrictEqual({ ...answer, sources: [] });
    if (res.ok) expect(res.result).toStrictEqual(entry?.perspectives);

    // Your own list: its outlets with a lean go (sorted by id, no Right), and its own names come back.
    await factcheckItem(TAB).removeValue();
    await chooseOwnList(MY_OUTLETS);
    const mine = ownSourceList(MY_OUTLETS);
    const myAnswer = serverAnswer(mine);
    useNetwork({ server: doneServer(myAnswer) });
    expect((await perspectives()).ok).toBe(true);
    const myStart = requests.find((r) => isStart(r.url, r.init));
    const myList = (JSON.parse(String(myStart?.init.body)) as { list: PerspectivesList }).list;
    expect(myList).toStrictEqual(wireList(mine));
    expect(myList.kind).toBe('own');
    expect(myList.outlets).toHaveLength(8);
    expect(String(myStart?.init.body)).not.toMatch(/My |"my-/);
    const [mineEntry] = await entries();
    expect(mineEntry?.listWarnings).toStrictEqual(['No outlets in Right.']);
    expect(namesIn(mineEntry?.perspectives)).toStrictEqual(namesOn(myAnswer, mine));
    expect(namesIn(mineEntry?.perspectives).every(([, id, name]) => MY_OUTLETS[String(id)]?.name === name)).toBe(true);
  });

  it('test_perspectives_own_key_runs_on_chosen_list', async () => {
    await setup();
    await chooseOwnList(MY_OUTLETS);
    const res = await perspectives();
    expect(res.ok, JSON.stringify(res)).toBe(true);
    // The pipeline ran on your list: a search per bucket with an outlet, on its web addresses only (no Right).
    expect(kinds.filter((k) => k === 'research')).toHaveLength(4);
    const searched = anthropic.bodies.flatMap(
      (b) => ((b as { tools?: { allowed_domains?: string[] }[] }).tools ?? [])[0]?.allowed_domains ?? [],
    );
    const domains = Object.values(MY_OUTLETS).flatMap((o) => o.domains);
    expect([...searched].sort()).toStrictEqual([...domains].sort());
    // Stored with your list's ids and names, the list it used, and its warnings as they were at the start.
    const [entry] = await entries();
    expect(entry).toMatchObject({ task: 'perspectives', status: 'done', listWarnings: ['No outlets in Right.'] });
    const result = entry?.perspectives;
    expect(result?.list).toBe('own');
    expect(result?.registryVersion).toBe('');
    expect(result?.sources).toHaveLength(4);
    for (const source of result?.sources ?? []) {
      expect(MY_OUTLETS[source.outletId]?.name, source.outletId).toBe(source.outlet);
      expect(source.outlet).toMatch(/^My /);
    }
    expect(result?.coverage.find((c) => c.bucket === 'right')?.sourceIds).toStrictEqual([]);
  });

  it('test_match_leans_refuses_foreign_leans', async () => {
    const valid = fixtureResult();
    expect(PerspectivesResultSchema.safeParse(valid).success).toBe(true);
    expect(matchLeans(valid, FIXTURE_LIST)).toStrictEqual(valid);
    // A server's own ids and names (web addresses) give way to the list's; nothing else changes.
    const answer = serverAnswer(FIXTURE_LIST);
    const named = matchLeans(answer, FIXTURE_LIST);
    expect(namesIn(named ?? undefined)).toStrictEqual(namesOn(answer, FIXTURE_LIST));
    expect({ ...named, sources: [] }).toStrictEqual({ ...answer, sources: [] });

    const changed = (edit: (r: PerspectivesResult) => void) => {
      const r = structuredClone(valid);
      edit(r);
      return matchLeans(r, FIXTURE_LIST);
    };
    const first = (r: PerspectivesResult) => r.sources[0] as PerspectivesResult['sources'][number];
    // A bucket the list doesn't give that outlet, an outlet or a page off the list, a row of another bucket's source.
    expect(changed((r) => void (first(r).bucket = 'right'))).toBeNull();
    expect(changed((r) => void (first(r).domain = 'nowhere.example'))).toBeNull();
    expect(changed((r) => void (first(r).url = 'https://nowhere.example/news/bridge'))).toBeNull();
    expect(changed((r) => void (first(r).url = 'https://left-b.example/news/bridge'))).toBeNull();
    expect(changed((r) => void ((r.coverage[0] as { sourceIds: string[] }).sourceIds = ['s2']))).toBeNull();
    // Another list's result: an own list's for a Cloud run, or another version of the Cloud's.
    expect(changed((r) => void (r.list = 'own'))).toBeNull();
    expect(changed((r) => void (r.registryVersion = '2'))).toBeNull();
    // An outlet the list sent without a lean.
    const unlabelled: SourceList = {
      ...FIXTURE_LIST,
      outlets: FIXTURE_LIST.outlets.map((o) => (o.id === 'fx-left-a' ? { ...o, lean: null } : o)),
    };
    expect(matchLeans(valid, unlabelled)).toBeNull();
    // Another outlet's id or name beside this outlet's lean: replaced by the list's own.
    const renamed = changed((r) => {
      first(r).outletId = 'fx-right-a';
      first(r).outlet = 'Fixture Right A';
    });
    expect(renamed?.sources[0]).toMatchObject({ outletId: 'fx-left-a', outlet: 'Fixture Left A', bucket: 'left' });
    // A repeated source id (the schema allows it): the right row's `s1` would show the left outlet under Right.
    type Row = { sourceIds: string[] };
    const repeated = structuredClone(valid);
    (repeated.sources[4] as PerspectivesResult['sources'][number]).id = 's1';
    (repeated.coverage[0] as Row).sourceIds = [];
    (repeated.coverage[4] as Row).sourceIds = ['s1'];
    expect(PerspectivesResultSchema.safeParse(repeated).success).toBe(true);
    expect(matchLeans(repeated, FIXTURE_LIST)).toBeNull();

    // A server whose result carries a lean the list sent doesn't hold, or names another list: failed, nothing stored.
    await setup({ source: SERVER });
    const error = {
      code: 'not-available',
      message: "This result doesn't match your source list, so it isn't shown.",
    };
    const edits: ((r: PerspectivesResult) => void)[] = [(r) => void (first(r).bucket = 'center'), (r) => void (r.list = 'own')];
    let foreign = answer;
    useNetwork({ server: (url, init) => doneServer(foreign)(url, init) });
    for (const edit of edits) {
      await factcheckItem(TAB).removeValue();
      foreign = structuredClone(answer);
      edit(foreign);
      expect(await perspectives()).toStrictEqual({ ok: false, error });
      const [entry] = await entries();
      expect(entry).toMatchObject({ task: 'perspectives', status: 'failed', error });
      expect(entry?.perspectives).toBeUndefined();
    }
  });
});

describe('docs', () => {
  it('test_privacy_mentions_perspectives_flows', () => {
    const privacy = readFileSync(join(REPO_ROOT, 'PRIVACY.md'), 'utf8');
    const paragraph = (start: string) => privacy.split(/\n\n/).find((p) => p.startsWith(start)) ?? '';
    const ownKey = paragraph('**UnEcho Chamber (off by default');
    const server = paragraph('**UnEcho Chamber on your unAlgorithm server');
    for (const p of [ownKey, server]) {
      expect(p).toContain('UnEcho Chamber');
      expect(p).toMatch(/never the post's text|post's text is never sent/);
    }
    expect(ownKey).toContain('Anthropic');
    expect(ownKey).toContain('OpenAI');
    expect(server).toContain('10 minutes');
    // P3-46: the own AI server with a web search key, and its optional permission.
    const compat = paragraph('**Fact-check and UnEcho Chamber with your own AI server and a web search key');
    expect(compat).toMatch(/only to the AI server address you entered/);
    expect(compat).toMatch(/never sent to Brave or\s+Tavily/);
    expect(compat).toContain('"unAlgorithm"');
    expect(privacy).toContain('| Optional: access to a web search service |');
  });
});
