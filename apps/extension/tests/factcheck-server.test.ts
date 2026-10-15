/**
 * Fact-check through the person's UnAlgorithm server (P3-21): the gates, the job's start and long polls, the refusals
 * in fact-check words, the settlement, the cancel on tab close and at the deadline, and the derived offer item. The
 * server is a stubbed fetch answering the job paths and the device token a stubbed `getAccessToken`; extension storage
 * is the WXT fake browser. Nothing real is called.
 */
import { describeError } from '@unalgorithm/ai';
import { defaultDevice, serverOfferFrom } from '@unalgorithm/core';
import {
  AUTHORIZE_PAGE_PATH,
  FACTCHECK_JOBS_PATH,
  type FactcheckResult,
  FactcheckResultSchema,
  factcheckJobCancelPath,
  factcheckJobPath,
  type PostForAI,
  type PostKey,
  type ServerInfo,
  TOKEN_PATH,
} from '@unalgorithm/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { FACTCHECK_SERVER_DEADLINE_MS, runFactcheckViaServer } from '../src/background/factcheck-server.ts';
import { type ServerAccount, serverAccountItem, syncServerOffer } from '../src/background/server-auth.ts';
import { forgetTab } from '../src/background/tabs.ts';
import { handlers } from '../src/entrypoints/background.ts';
import type { BgRequest } from '../src/lib/messages.ts';
import { serverLabel } from '../src/lib/server-label.ts';
import { deviceItem, factcheckItem, serverOfferItem } from '../src/lib/storage.ts';

const auth = vi.hoisted(() => ({ getAccessToken: vi.fn() }));
vi.mock('../src/background/server-auth.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/background/server-auth.ts')>()),
  getAccessToken: auth.getAccessToken,
}));

const ORIGIN = 'https://ai.example.org';
const CFG = { kind: 'server', baseUrl: `${ORIGIN}/` } as const;
const TOKEN = 'access-token-1';
const JOB_ID = '0199d6a4-3f1e-7c2a-9b5d-2e8f4a6c1b3e';
const TAB = 7;
const FEED_URL = 'https://www.linkedin.com/feed/';
const feedTab = (id = TAB) => ({ tab: { id, url: FEED_URL }, url: FEED_URL }) as Browser.runtime.MessageSender;
const SERVER_TEXT = 'Visit evil.example to pay';

const INFO: ServerInfo = {
  v: 1,
  name: 'Example AI',
  version: '0.1.0',
  source: 'https://github.com/example/unalgorithm',
  billing: false,
  capabilities: { classify: true, sync: false, factcheck: true },
  auth: { methods: ['email-otp'], authorizePath: AUTHORIZE_PAGE_PATH, tokenPath: TOKEN_PATH },
  limits: { maxPostsPerRequest: 12 },
};

const account = (over: Partial<ServerAccount> = {}): ServerAccount => ({
  origin: ORIGIN,
  email: 'ada@example.org',
  deviceId: '0199d6a4-3f1e-7c2a-9b5d-2e8f4a6c1b3d',
  signedInAt: Date.UTC(2026, 9, 12, 9),
  info: INFO,
  needsSignIn: false,
  ...over,
});

const RESULT: FactcheckResult = {
  v: 1,
  checkedAt: '2026-10-15T09:00:00.000Z',
  model: 'claude-sonnet-5-5',
  promptVersion: 1,
  claims: [],
  sources: [],
};

const POST: Omit<PostForAI, 'ref'> = {
  platform: 'linkedin',
  text: 'The bridge opened in 1932 and cost $10 million to build, more than any bridge before it.',
  textComplete: true,
  authorKind: 'person',
  isReshare: false,
  media: 'none',
};
const KEY = 'li:urn:li:activity:1' as PostKey;

const job = (status: string, over: Record<string, unknown> = {}) => ({ v: 1, id: JOB_ID, status, ...over });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const serverError = (status: number, code: string) => json(status, { code, message: SERVER_TEXT });

type Call = { url: URL; init: RequestInit };
let calls: Call[];
/** A fake server: `route` answers every request; each request is recorded. */
function useServer(route: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  calls = [];
  const fetchMock = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return route(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const isStart = (url: URL, init: RequestInit) => url.pathname === FACTCHECK_JOBS_PATH && init.method === 'POST';
const isPoll = (url: URL) => url.pathname === factcheckJobPath(JOB_ID);
const isCancel = (url: URL) => url.pathname === factcheckJobCancelPath(JOB_ID);
const cancels = () => calls.filter((c) => isCancel(c.url));

/** Starts running, one poll still running, then done. */
const happyServer = (doneOver: Record<string, unknown> = {}) => {
  let polls = 0;
  return (url: URL, init: RequestInit) => {
    if (isStart(url, init)) return json(202, job('running'));
    if (isPoll(url)) return json(200, ++polls < 2 ? job('running') : job('done', { result: RESULT, ...doneOver }));
    return json(404, { code: 'not-available', message: 'nope' });
  };
};

async function setup(over: { account?: ServerAccount | null } = {}) {
  const device = defaultDevice('dev1');
  await deviceItem.setValue({ ...device, aiSource: CFG, labs: { ...device.labs, factcheck: true } });
  const acct = over.account === undefined ? account() : over.account;
  if (acct) await serverAccountItem.setValue(acct);
}

function factcheck(input: Omit<PostForAI, 'ref'> = POST, sender = feedTab()) {
  const msg: Extract<BgRequest, { type: 'factcheck' }> = { type: 'factcheck', key: KEY, input };
  return handlers.factcheck(msg, sender);
}
const entries = async () => (await factcheckItem(TAB).getValue()).entries;
const notes = () => ({ settlement: vi.fn(async () => undefined), refused: vi.fn(async () => undefined) });
const run = (note = notes(), signal = new AbortController().signal) =>
  runFactcheckViaServer(account(), { ...POST, ref: 'p1' }, { signal, note });
const title = serverLabel(ORIGIN).title;

beforeEach(() => {
  fakeBrowser.reset();
  auth.getAccessToken.mockReset();
  auth.getAccessToken.mockResolvedValue(TOKEN);
  vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation((async () => true) as never);
  vi.spyOn(fakeBrowser.sidePanel, 'open').mockImplementation((async () => undefined) as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('gates', () => {
  it('test_server_factcheck_unsupported_without_offer', async () => {
    const fetchMock = useServer(happyServer());
    const unsupported = { ok: false, error: { code: 'unsupported', message: "This server doesn't offer fact-check." } };
    const cases: (ServerAccount | null)[] = [
      null,
      account({ origin: 'https://other.example.org' }),
      account({ info: { ...INFO, capabilities: { classify: true, sync: false } } }),
      account({ needsSignIn: true }),
    ];
    for (const acct of cases) {
      await fakeBrowser.storage.local.clear();
      await setup({ account: acct });
      expect(await factcheck()).toEqual(unsupported);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await entries()).toEqual([]);
  });

  it('test_server_factcheck_refuses_non_public_post', async () => {
    const fetchMock = useServer(happyServer());
    await setup();
    const friends: Omit<PostForAI, 'ref'> = { ...POST, platform: 'facebook', audience: 'friends' };
    expect(await factcheck(friends)).toEqual({
      ok: false,
      error: { code: 'not-available', message: 'Fact-check works only on public posts.' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await entries()).toEqual([]);
  });
});

describe('job flow', () => {
  it('test_server_factcheck_start_poll_done', async () => {
    useServer(happyServer());
    await setup();
    const answer = await factcheck({ ...POST, author: 'Ada Lovelace' } as Omit<PostForAI, 'ref'>);
    expect(answer).toEqual({ ok: true, result: RESULT });

    const starts = calls.filter((c) => isStart(c.url, c.init));
    expect(starts).toHaveLength(1);
    const [start] = starts;
    if (!start) throw new Error('no start request');
    expect(start.url.origin).toBe(ORIGIN);
    expect(start.init.credentials).toBe('omit');
    expect((start.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(String(start.init.body));
    expect(body).toEqual({ v: 1, post: { ...POST, ref: 'p1' } });
    expect(body.post).not.toHaveProperty('author');

    const polls = calls.filter((c) => isPoll(c.url));
    expect(polls).toHaveLength(2);
    for (const p of polls) {
      expect(p.url.searchParams.get('wait')).toBe('1');
      expect(p.init.credentials).toBe('omit');
    }
    expect(cancels()).toHaveLength(0);

    const [entry] = await entries();
    expect(entry?.status).toBe('done');
    expect(entry).not.toHaveProperty('costMicros');
    expect(FactcheckResultSchema.safeParse(entry?.result).success).toBe(true);
  });

  it('test_server_factcheck_error_texts', async () => {
    let note = notes();
    useServer(() => serverError(402, 'insufficient-credits'));
    expect(await run(note)).toEqual({
      ok: false,
      error: { code: 'insufficient-credits', message: describeError('insufficient-credits', title) },
    });
    expect(note.refused).toHaveBeenCalledWith(ORIGIN, account().deviceId);

    useServer(() => serverError(429, 'cap-reached'));
    expect(await run()).toEqual({
      ok: false,
      error: { code: 'cap-reached', message: "You've reached today's fact-check limit on this server." },
    });

    useServer(() => serverError(429, 'rate-limit'));
    expect(await run()).toMatchObject({
      error: { code: 'rate-limit', message: 'A check is already running. Try again in a minute.' },
    });

    useServer((url, init) =>
      isStart(url, init)
        ? json(202, job('running'))
        : json(200, job('failed', { error: { code: 'truncated', message: SERVER_TEXT } })),
    );
    note = notes();
    const truncated = await run(note);
    expect(truncated).toEqual({
      ok: false,
      error: { code: 'truncated', message: 'This check stopped before it finished, so nothing was charged.' },
    });
    expect(note.refused).not.toHaveBeenCalled();

    useServer(() => serverError(503, 'not-available'));
    expect(await run()).toMatchObject({ error: { message: "This server doesn't offer fact-check right now." } });

    // Through the background too: the stored entry carries the extension's words, never the server's.
    useServer(() => serverError(429, 'cap-reached'));
    await setup();
    await factcheck();
    const [entry] = await entries();
    expect(entry?.status).toBe('failed');
    expect(entry?.error?.code).toBe('cap-reached');
    expect(JSON.stringify(await fakeBrowser.storage.session.get(null))).not.toContain(SERVER_TEXT);
  });

  it('test_server_factcheck_records_settlement', async () => {
    const billing = { chargedMicros: 120_000, balanceMicros: 4_880_000 };
    useServer(happyServer({ billing }));
    const note = notes();
    expect(await run(note)).toEqual({ ok: true, result: RESULT, chargedMicros: 120_000 });
    expect(note.settlement).toHaveBeenCalledTimes(1);
    expect(note.settlement).toHaveBeenCalledWith(ORIGIN, account().deviceId, billing);
  });

  it('test_server_job_returns_charged_amount', async () => {
    const billing = { chargedMicros: 412, balanceMicros: 900_000 };
    useServer(happyServer({ billing }));
    expect(await run()).toEqual({ ok: true, result: RESULT, chargedMicros: 412 });

    useServer(happyServer());
    expect(await run()).not.toHaveProperty('chargedMicros');

    useServer((url, init) =>
      isStart(url, init)
        ? json(202, job('running'))
        : json(200, job('failed', { error: { code: 'truncated', message: SERVER_TEXT }, billing })),
    );
    const failed = await run();
    expect(failed.ok).toBe(false);
    expect(failed).not.toHaveProperty('chargedMicros');
  });

  it('test_entry_keeps_charged_amount', async () => {
    useServer(happyServer({ billing: { chargedMicros: 412, balanceMicros: 900_000 } }));
    await setup();
    expect(await factcheck()).toEqual({ ok: true, result: RESULT, chargedMicros: 412 });
    const [entry] = await entries();
    expect(entry).toMatchObject({ status: 'done', chargedMicros: 412 });
    expect(entry).not.toHaveProperty('costMicros');
  });

  it('test_server_factcheck_lost_job', async () => {
    useServer((url, init) => (isStart(url, init) ? json(202, job('running')) : json(404, { code: 'unknown', message: 'gone' })));
    expect(await run()).toEqual({
      ok: false,
      error: { code: 'unknown', message: 'The server lost this check (it may have restarted). Try again.' },
    });
  });

  it('test_server_factcheck_cancel_on_tab_close', async () => {
    let polling!: () => void;
    const polled = new Promise<void>((resolve) => {
      polling = resolve;
    });
    useServer((url, init) => {
      if (isStart(url, init)) return json(202, job('running'));
      if (isCancel(url)) return json(200, job('cancelled'));
      polling();
      // A long poll that only ends when its request is aborted.
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    await setup();
    const pending = factcheck();
    await polled;
    expect(await entries()).toHaveLength(1);

    await forgetTab(TAB);
    const answer = await pending;
    expect(answer.ok).toBe(false);

    const sent = cancels();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.init.method).toBe('POST');
    expect(sent[0]?.init.signal?.aborted).toBe(false);
    expect(await fakeBrowser.storage.session.get(`factcheck:${TAB}`)).toEqual({});
  });

  it('test_server_factcheck_cancel_when_tab_closes_during_start', async () => {
    let received!: () => void;
    const starting = new Promise<void>((resolve) => {
      received = resolve;
    });
    let answerStart!: () => void;
    useServer((url, init) => {
      if (isStart(url, init)) {
        received();
        // The server already holds the job; its 202 comes back after the tab closed. A real fetch rejects once its
        // signal aborts, and the job id (the only way to cancel it) would be lost.
        return new Promise<Response>((resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          answerStart = () => resolve(json(202, job('running')));
        });
      }
      if (isCancel(url)) return json(202, job('cancelled'));
      return json(200, job('running'));
    });
    await setup();
    const pending = factcheck();
    await starting;

    await forgetTab(TAB);
    answerStart();
    expect((await pending).ok).toBe(false);

    expect(cancels()).toHaveLength(1);
    expect(calls.filter((c) => isPoll(c.url))).toHaveLength(0);
    expect(await fakeBrowser.storage.session.get(`factcheck:${TAB}`)).toEqual({});
  });

  it('test_server_factcheck_deadline_cancels', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 15, 9));
    const startedAt = Date.now();
    const pollTimeouts: number[] = [];
    useServer((url, init) => {
      if (isStart(url, init)) return json(202, job('running'));
      if (isCancel(url)) return json(200, job('cancelled'));
      // Each long poll takes its full wait on the fake clock.
      vi.setSystemTime(Date.now() + 20_000);
      pollTimeouts.push(Date.now() - startedAt);
      return json(200, job('running'));
    });
    expect(await run()).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(cancels()).toHaveLength(1);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(FACTCHECK_SERVER_DEADLINE_MS);
    // No poll starts after the deadline.
    expect(Math.max(...pollTimeouts)).toBeLessThanOrEqual(FACTCHECK_SERVER_DEADLINE_MS);
  });
});

describe('offer item', () => {
  it('test_sync_server_offer_follows_account', async () => {
    await serverAccountItem.setValue(account());
    const unwatch = syncServerOffer();
    try {
      await vi.waitFor(async () => expect(await serverOfferItem.getValue()).toEqual(serverOfferFrom(account())));
      expect(await serverOfferItem.getValue()).toMatchObject({ origin: ORIGIN, factcheck: true });

      const priced = account({
        info: { ...INFO, billing: true, jobPrices: { factcheck: { typicalMicros: 100_000, maxMicros: 400_000 } } },
      });
      await serverAccountItem.setValue(priced);
      await vi.waitFor(async () =>
        expect(await serverOfferItem.getValue()).toMatchObject({
          billing: true,
          factcheckPrice: { typicalMicros: 100_000, maxMicros: 400_000 },
        }),
      );
      const stored = JSON.stringify(await serverOfferItem.getValue());
      for (const secret of [priced.email, priced.deviceId, TOKEN]) expect(stored).not.toContain(secret);

      await serverAccountItem.removeValue();
      await vi.waitFor(async () => expect(await serverOfferItem.getValue()).toBeNull());
    } finally {
      unwatch();
    }
  });
});
