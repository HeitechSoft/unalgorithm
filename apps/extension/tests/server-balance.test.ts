/**
 * The server balance in the background (R5, R27, R31): what classify answers and 402s record, when `aiStatus` asks the
 * server's balance endpoint, and which account a value belongs to. The network is a stubbed fetch and the device token a
 * stubbed `getAccessToken`; extension storage is the WXT fake browser and the clock a fake `Date`.
 */
import { AIError, describeError } from '@unalgorithm/ai';
import { type AISourceConfig, buildInterestProfile, defaultDevice, defaultSettings } from '@unalgorithm/core';
import {
  AUTHORIZE_PAGE_PATH,
  CLASSIFY_PATH,
  type ClassifyRequest,
  type ClassifyResponse,
  CREDIT_BALANCE_PATH,
  type CreditBalance,
  type PostForAI,
  SERVER_INFO_PATH,
  type ServerInfo,
  TOKEN_PATH,
} from '@unalgorithm/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { aiStatus } from '../src/background/ai.ts';
import { getSecret, setSecret } from '../src/background/idb.ts';
import {
  isTrustedServerOrigin,
  REDISCOVER_MIN_INTERVAL_MS,
  refreshServerInfo,
  type ServerAccount,
  serverAccountItem,
} from '../src/background/server-auth.ts';
import {
  BALANCE_MAX_AGE_MS,
  BALANCE_WAIT_MS,
  noteRefused,
  noteSettlement,
  refreshBalance,
  type StoredBalance,
  serverBalanceItem,
} from '../src/background/server-balance.ts';
import { classifyViaServer } from '../src/background/server-source.ts';
import { PINNED_CLOUD_ORIGIN } from '../src/lib/server-label.ts';
import { deviceItem } from '../src/lib/storage.ts';

// `aiStatus` takes no dependencies: the device token comes from this stub, the network from a stubbed global fetch.
const auth = vi.hoisted(() => ({ getAccessToken: vi.fn() }));
vi.mock('../src/background/server-auth.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/background/server-auth.ts')>()),
  getAccessToken: auth.getAccessToken,
}));

const ORIGIN = PINNED_CLOUD_ORIGIN;
const CFG = { kind: 'server', baseUrl: ORIGIN } as const;
const NOW = Date.UTC(2026, 9, 14, 9);
const MINUTE = 60_000;
const DEVICE_A = '0199d6a4-3f1e-7c2a-9b5d-2e8f4a6c1b3d';
const DEVICE_B = '0199d6a5-7a20-7d41-8c3e-5f9a0b1c2d4e';
const REFRESH_KEY = `server-refresh:${ORIGIN}`;

const INFO: ServerInfo = {
  v: 1,
  name: 'UnAlgorithm',
  version: '0.2.0',
  source: 'https://github.com/HeitechSoft/unalgorithm',
  billing: true,
  capabilities: { classify: true, sync: false },
  auth: { methods: ['email-otp'], authorizePath: AUTHORIZE_PAGE_PATH, tokenPath: TOKEN_PATH },
  limits: { maxPostsPerRequest: 12 },
};
/** What every CL1-era account stored: signed in before its server advertised billing. */
const OLD_INFO: ServerInfo = { ...INFO, version: '0.1.0', billing: false };

const account = (over: Partial<ServerAccount> = {}): ServerAccount => ({
  origin: ORIGIN,
  email: 'ada@example.org',
  deviceId: DEVICE_A,
  signedInAt: NOW,
  info: INFO,
  needsSignIn: false,
  ...over,
});

const stored = (over: Partial<StoredBalance> = {}): StoredBalance => ({
  origin: ORIGIN,
  deviceId: DEVICE_A,
  balanceMicros: 500_000,
  source: 'classify',
  updatedAt: NOW,
  ...over,
});

const balanceBody = (micros: number, over: Partial<CreditBalance> = {}): CreditBalance => ({
  v: 1,
  balanceMicros: micros,
  promoMicros: micros,
  purchasedMicros: 0,
  promoExpiresAt: '2027-01-12T09:00:00.000Z',
  starter: 'active',
  ...over,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const BILLING = { chargedMicros: 300, balanceMicros: 999_700 };

function answer(req: ClassifyRequest, billing?: ClassifyResponse['billing']): ClassifyResponse {
  return {
    v: 1,
    results: req.posts.map((p) => ({
      ref: p.ref,
      status: 'ok',
      classification: { relevance: 60, noise: [], topics: [], reason: 'A post.', isNews: false, hasCheckableClaims: false },
    })),
    source: { kind: 'server', model: 'mock-model', promptVersion: 1 },
    ...(billing ? { billing } : {}),
  };
}

interface Call {
  url: string;
  init: RequestInit;
}

/** A server: the balance endpoint, discovery and classify, each replaceable. */
function fakeServer(
  opts: {
    balance?: (n: number) => Response | Promise<Response>;
    info?: () => Response | Promise<Response>;
    classify?: (req: ClassifyRequest) => Response | Promise<Response>;
  } = {},
) {
  const calls: Call[] = [];
  let balances = 0;
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const { pathname } = new URL(url);
    if (pathname === CREDIT_BALANCE_PATH) return (opts.balance ?? (() => json(balanceBody(970_000))))(++balances);
    if (pathname === SERVER_INFO_PATH) return (opts.info ?? (() => json(INFO)))();
    if (pathname === CLASSIFY_PATH) {
      return (opts.classify ?? ((req) => json(answer(req, BILLING))))(JSON.parse(String(init.body)) as ClassifyRequest);
    }
    return new Response('Not found', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  const to = (path: string) => calls.filter((c) => new URL(c.url).pathname === path);
  return { fetch, calls, balanceCalls: () => to(CREDIT_BALANCE_PATH), discoveryCalls: () => to(SERVER_INFO_PATH) };
}

/** A promise the test settles. */
function gate<T>() {
  let open!: (value: T) => void;
  let fail!: (err: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

/** Hands out `access-1`, then `access-2` once a refresh is forced. */
function tokens() {
  let issued = 1;
  return vi.fn(async (_origin: string, opts: { forceRefresh?: boolean } = {}) => {
    if (opts.forceRefresh) issued++;
    return `access-${issued}`;
  });
}

const OPTS = (() => {
  const profile = buildInterestProfile(defaultSettings());
  return { profile, profileHash: 'abc123', locale: 'en-CA' };
})();
const posts = async (): Promise<PostForAI[]> => [
  {
    ref: 'p1',
    platform: 'linkedin',
    text: 'A post',
    textComplete: true,
    authorKind: 'person',
    isReshare: false,
    media: 'none',
  },
];
const codes = (outcome: Awaited<ReturnType<typeof classifyViaServer>>) =>
  [...outcome.byRef.values()].map((r) => (r.ok ? 'ok' : r.error.code));
const bearer = (c: Call | undefined) => new Headers(c?.init.headers).get('authorization');

async function setSource(cfg: AISourceConfig | null) {
  await deviceItem.setValue({ ...defaultDevice('dev1'), aiSource: cfg });
}

beforeEach(async () => {
  fakeBrowser.reset();
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  auth.getAccessToken.mockReset();
  auth.getAccessToken.mockImplementation(tokens());
  await setSource(CFG);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('recording', () => {
  it('test_settlement_is_stored', async () => {
    await serverAccountItem.setValue(account());
    const s = fakeServer();
    const outcome = await classifyViaServer(CFG, await posts(), OPTS, { fetch: s.fetch, getAccessToken: tokens() });

    expect(codes(outcome)).toStrictEqual(['ok']);
    expect(await serverBalanceItem.getValue()).toStrictEqual({
      origin: ORIGIN,
      deviceId: DEVICE_A,
      balanceMicros: 999_700,
      source: 'classify',
      updatedAt: NOW,
    });

    // An answer without `billing` (a self-hosted server) stores nothing.
    await serverBalanceItem.setValue(null);
    const free = fakeServer({ classify: (req) => json(answer(req)) });
    await classifyViaServer(CFG, await posts(), OPTS, { fetch: free.fetch, getAccessToken: tokens() });
    expect(await serverBalanceItem.getValue()).toBeNull();

    // Nobody signed in to this server: nothing to record it for.
    await serverAccountItem.setValue(account({ origin: 'https://ai.example.org' }));
    await classifyViaServer(CFG, await posts(), OPTS, { fetch: s.fetch, getAccessToken: tokens() });
    expect(await serverBalanceItem.getValue()).toBeNull();

    // A caller that read the account already passes it, and replaceable recorders get the account's device.
    const settlement = vi.fn(async () => undefined);
    const refused = vi.fn(async () => undefined);
    await classifyViaServer(CFG, await posts(), OPTS, {
      fetch: s.fetch,
      getAccessToken: tokens(),
      account: account({ deviceId: DEVICE_B }),
      noteBalance: { settlement, refused },
    });
    expect(settlement).toHaveBeenCalledExactlyOnceWith(ORIGIN, DEVICE_B, BILLING);
    expect(refused).not.toHaveBeenCalled();

    // A storage failure never fails the posts.
    vi.spyOn(serverBalanceItem, 'setValue').mockRejectedValue(new Error('Session storage is gone.'));
    await serverAccountItem.setValue(account());
    const kept = await classifyViaServer(CFG, await posts(), OPTS, { fetch: s.fetch, getAccessToken: tokens() });
    expect(codes(kept)).toStrictEqual(['ok']);
  });

  it('test_refusal_stores_zero', async () => {
    const empty = () => json({ code: 'insufficient-credits', message: 'Top up at example.com.' }, 402);
    const s = fakeServer({ classify: empty });
    const run = async () => classifyViaServer(CFG, await posts(), OPTS, { fetch: s.fetch, getAccessToken: tokens() });

    // Without an account nothing is recorded: the posts fail exactly as they always did.
    const before = await run();
    expect(await serverBalanceItem.getValue()).toBeNull();

    await serverAccountItem.setValue(account());
    const after = await run();
    expect(await serverBalanceItem.getValue()).toStrictEqual({
      origin: ORIGIN,
      deviceId: DEVICE_A,
      balanceMicros: 0,
      source: 'refused',
      updatedAt: NOW,
    });
    expect(codes(after)).toStrictEqual(['insufficient-credits']);
    const message = describeError('insufficient-credits', 'UnAlgorithm Cloud');
    for (const r of after.byRef.values()) expect(r.ok ? undefined : r.error.message).toBe(message);
    expect(after).toStrictEqual(before);
    expect(after).toMatchObject({ calls: 1, failedCalls: 1 });
  });
});

describe('refresh', () => {
  it('test_status_fetches_when_billing_advertised', async () => {
    await serverAccountItem.setValue(account());
    const s = fakeServer();
    vi.stubGlobal('fetch', s.fetch);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const status = await aiStatus();

    expect(status).toMatchObject({ kind: 'server', label: 'UnAlgorithm Cloud', state: 'ready' });
    expect(status).not.toHaveProperty('message');
    expect(status.balance).toStrictEqual({
      balanceMicros: 970_000,
      low: false,
      empty: false,
      accountUrl: 'https://cloud.unalgorithm.app/account',
      updatedAt: NOW,
    });
    expect(s.calls).toHaveLength(1);
    const [call] = s.balanceCalls();
    expect(call?.url).toBe(`${ORIGIN}${CREDIT_BALANCE_PATH}`);
    expect(call?.init.method ?? 'GET').toBe('GET');
    expect(call?.init).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(call?.init.body).toBeUndefined();
    expect(bearer(call)).toBe('Bearer access-1');
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(auth.getAccessToken).toHaveBeenCalledExactlyOnceWith(ORIGIN);
    expect(await serverBalanceItem.getValue()).toStrictEqual(
      stored({ balanceMicros: 970_000, source: 'endpoint', updatedAt: NOW }),
    );
  });

  it('test_status_uses_fresh_value', async () => {
    await serverAccountItem.setValue(account());
    await serverBalanceItem.setValue(stored({ updatedAt: NOW - 4 * MINUTE }));
    const answers = gate<Response>();
    const s = fakeServer({ balance: () => answers.promise });
    vi.stubGlobal('fetch', s.fetch);

    // Younger than five minutes: shown as it is, nothing is asked.
    expect((await aiStatus()).balance).toMatchObject({ balanceMicros: 500_000, updatedAt: NOW - 4 * MINUTE });
    expect(s.calls).toHaveLength(0);

    // Stale: still shown at once, and one request starts, however often the popup asks while it runs.
    vi.setSystemTime(NOW + 2 * MINUTE);
    expect(NOW + 2 * MINUTE - (NOW - 4 * MINUTE)).toBeGreaterThan(BALANCE_MAX_AGE_MS);
    expect((await aiStatus()).balance).toMatchObject({ balanceMicros: 500_000, updatedAt: NOW - 4 * MINUTE });
    await vi.waitFor(() => expect(s.balanceCalls()).toHaveLength(1));
    expect((await aiStatus()).balance).toMatchObject({ balanceMicros: 500_000 });

    // The request in flight answers (`refreshBalance` joins it); the next `aiStatus` has the new value.
    answers.open(json(balanceBody(970_000)));
    expect(await refreshBalance(account())).toMatchObject({ balanceMicros: 970_000, source: 'endpoint' });
    const next = (await aiStatus()).balance;
    expect(next).toMatchObject({ balanceMicros: 970_000, updatedAt: Date.now() });
    expect(next?.updatedAt).toBeGreaterThanOrEqual(NOW + 2 * MINUTE);
    expect(s.balanceCalls()).toHaveLength(1);
  });

  it('test_self_hosted_has_no_balance', async () => {
    await serverAccountItem.setValue(account({ info: OLD_INFO }));
    const s = fakeServer();
    vi.stubGlobal('fetch', s.fetch);

    const status = await aiStatus();
    expect(status).toMatchObject({ state: 'ready' });
    expect(status).not.toHaveProperty('balance');
    expect(s.calls).toHaveLength(0);

    // A balance some answer carried doesn't make the server one that bills.
    await serverBalanceItem.setValue(stored());
    const again = await aiStatus();
    expect(again).not.toHaveProperty('balance');
    expect(again).toMatchObject({ state: 'ready' });
    expect(s.calls).toHaveLength(0);
    expect(await refreshBalance(account({ info: OLD_INFO }), { fetch: s.fetch })).toStrictEqual(stored());
    expect(s.calls).toHaveLength(0);
  });

  it('test_billing_answer_rediscovers_server', async () => {
    // Its own stretch of time, so no other test's discovery throttles this one.
    let clock = NOW + 60 * MINUTE;
    const later = () => {
      clock += REDISCOVER_MIN_INTERVAL_MS + MINUTE;
      vi.setSystemTime(clock);
    };
    later();
    let document: () => Response | Promise<Response> = () => json(OLD_INFO);
    const s = fakeServer({ info: () => document() });
    vi.stubGlobal('fetch', s.fetch);
    let pending: Promise<void> | undefined;
    const rediscover = vi.fn((origin: string) => (pending = refreshServerInfo(origin)));
    const classify = async (fetch = s.fetch) =>
      classifyViaServer(CFG, await posts(), OPTS, { fetch, getAccessToken: tokens(), rediscover });
    const refused = fakeServer({ classify: () => json({ code: 'insufficient-credits', message: 'Empty.' }, 402) });

    const old = account({ info: OLD_INFO });
    await serverAccountItem.setValue(old);
    await setSecret(REFRESH_KEY, 'refresh-token-1-0123456789abcdef');

    // The document still says false: the account stays as it is, and nothing is shown.
    await classify();
    await pending;
    expect(rediscover).toHaveBeenCalledExactlyOnceWith(ORIGIN);
    expect(s.discoveryCalls().map((c) => c.url)).toStrictEqual([`${ORIGIN}${SERVER_INFO_PATH}`]);
    expect(await serverAccountItem.getValue()).toStrictEqual(old);
    expect(await aiStatus()).not.toHaveProperty('balance');
    expect(s.balanceCalls()).toHaveLength(0);

    // Another answer within the interval asks for nothing; a 402 later on asks again, once.
    await classify();
    await pending;
    expect(s.discoveryCalls()).toHaveLength(1);
    later();
    await classify(refused.fetch);
    await pending;
    expect(s.discoveryCalls()).toHaveLength(2);
    await classify(refused.fetch);
    await pending;
    expect(s.discoveryCalls()).toHaveLength(2);
    expect(await serverAccountItem.getValue()).toStrictEqual(old);

    // Discovery fails: nothing changes.
    later();
    document = () => Promise.reject(new TypeError('Failed to fetch'));
    await classify();
    await pending;
    expect(s.discoveryCalls()).toHaveLength(3);
    expect(await serverAccountItem.getValue()).toStrictEqual(old);
    expect(await aiStatus()).not.toHaveProperty('balance');

    // The document now advertises billing: only `info` changes, and the balance shows.
    later();
    document = () => json(INFO);
    await classify();
    await pending;
    expect(s.discoveryCalls()).toHaveLength(4);
    expect(await serverAccountItem.getValue()).toStrictEqual({ ...old, info: INFO });
    expect(await getSecret(REFRESH_KEY)).toBe('refresh-token-1-0123456789abcdef');
    expect((await aiStatus()).balance).toMatchObject({ balanceMicros: 999_700, empty: false });
    // Now advertised: the next answers leave discovery alone.
    rediscover.mockClear();
    await classify();
    expect(rediscover).not.toHaveBeenCalled();

    // Someone signs in as another account while the server answers: the document isn't stored for them.
    later();
    await serverAccountItem.setValue(old);
    const late = gate<Response>();
    document = () => late.promise;
    await classify();
    await vi.waitFor(() => expect(s.discoveryCalls()).toHaveLength(5));
    const other = account({ deviceId: DEVICE_B, email: 'grace@example.org', info: OLD_INFO });
    await serverAccountItem.setValue(other);
    late.open(json(INFO));
    await pending;
    expect(await serverAccountItem.getValue()).toStrictEqual(other);
  });

  it('test_refresh_failures_keep_value', async () => {
    const acc = account();
    await serverAccountItem.setValue(acc);
    const value = stored({ updatedAt: NOW - 10 * MINUTE });
    await serverBalanceItem.setValue(value);
    const refresh = (balance: (n: number) => Response | Promise<Response>) => {
      const s = fakeServer({ balance });
      const token = tokens();
      return { s, token, run: () => refreshBalance(acc, { fetch: s.fetch, getAccessToken: token, now: () => NOW }) };
    };
    const unauthorized = () => json({ code: 'auth-required', message: 'Sign in again.' }, 401);

    // A 401 and a 401 again: one forced refresh, one retry, and the stored value stays.
    const twice = refresh(unauthorized);
    expect(await twice.run()).toStrictEqual(value);
    expect(twice.token.mock.calls).toStrictEqual([[ORIGIN], [ORIGIN, { forceRefresh: true }]]);
    expect(twice.s.balanceCalls().map(bearer)).toStrictEqual(['Bearer access-1', 'Bearer access-2']);

    for (const [name, balance] of [
      ['500', () => json({ code: 'unknown', message: 'Something broke.' }, 500)],
      ['network', () => Promise.reject(new TypeError('Failed to fetch'))],
      ['parts that do not add up', () => json(balanceBody(970_000, { promoMicros: 500_000 }))],
      ['not JSON', () => new Response('<html>Bad gateway</html>', { status: 200 })],
    ] as const) {
      const failed = refresh(balance);
      expect(await failed.run(), name).toStrictEqual(value);
      expect(failed.s.balanceCalls(), name).toHaveLength(1);
      expect(failed.token, name).toHaveBeenCalledOnce();
    }
    expect(await serverBalanceItem.getValue()).toStrictEqual(value);
    // The classify path decides when to sign in again (CL1-17), never the balance.
    expect(await serverAccountItem.getValue()).toStrictEqual(acc);

    // A 401 and then an answer: the retry's value is stored.
    const retried = refresh((n) => (n === 1 ? unauthorized() : json(balanceBody(970_000))));
    expect(await retried.run()).toStrictEqual(stored({ balanceMicros: 970_000, source: 'endpoint', updatedAt: NOW }));
    expect(retried.token).toHaveBeenCalledTimes(2);
    expect(await serverBalanceItem.getValue()).toStrictEqual(
      stored({ balanceMicros: 970_000, source: 'endpoint', updatedAt: NOW }),
    );
  });

  it('test_refresh_keeps_newer_value', async () => {
    const acc = account();
    await serverAccountItem.setValue(acc);
    await serverBalanceItem.setValue(stored({ updatedAt: NOW - 10 * MINUTE }));
    const answers = [gate<Response>(), gate<Response>(), gate<Response>()];
    const s = fakeServer({ balance: (n) => answers[n - 1]?.promise ?? json(balanceBody(970_000)) });
    vi.stubGlobal('fetch', s.fetch);
    /** A stale value starts a refresh: `aiStatus` answers at once, and the balance request is in flight. */
    const staleRefresh = async (requests: number) => {
      await aiStatus();
      await vi.waitFor(() => expect(s.balanceCalls()).toHaveLength(requests));
    };

    // A feed batch's 402 lands while the request runs: the server read its balance before that, and the 0 stays.
    await staleRefresh(1);
    await noteRefused(ORIGIN, DEVICE_A, NOW);
    answers[0]?.open(json(balanceBody(970_000)));
    const refused = stored({ balanceMicros: 0, source: 'refused', updatedAt: NOW });
    expect(await refreshBalance(acc)).toStrictEqual(refused);
    expect(await serverBalanceItem.getValue()).toStrictEqual(refused);
    const empty = await aiStatus();
    expect(empty).toMatchObject({ state: 'needs-attention', balance: { balanceMicros: 0, empty: true } });
    expect(empty.message).toBe(describeError('insufficient-credits', 'UnAlgorithm Cloud'));
    expect(s.balanceCalls()).toHaveLength(1);

    // So does a classify answer's balance.
    vi.setSystemTime(NOW + 6 * MINUTE);
    await staleRefresh(2);
    await noteSettlement(ORIGIN, DEVICE_A, { chargedMicros: 300, balanceMicros: 1_000 }, NOW + 6 * MINUTE);
    answers[1]?.open(json(balanceBody(970_000)));
    const settled = stored({ balanceMicros: 1_000, source: 'classify', updatedAt: NOW + 6 * MINUTE });
    expect(await refreshBalance(acc)).toStrictEqual(settled);
    expect(await serverBalanceItem.getValue()).toStrictEqual(settled);

    // "Erase everything" while the request runs: the answer isn't written back.
    vi.setSystemTime(NOW + 12 * MINUTE);
    await staleRefresh(3);
    await fakeBrowser.storage.session.clear();
    answers[2]?.open(json(balanceBody(970_000)));
    expect(await refreshBalance(acc)).toBeUndefined();
    expect(await serverBalanceItem.getValue()).toBeNull();
  });
});

describe('waiting and failures', () => {
  it('test_status_never_waits_on_stale_refresh', async () => {
    const acc = account();
    await serverAccountItem.setValue(acc);
    await serverBalanceItem.setValue(stored({ updatedAt: NOW - 10 * MINUTE }));
    const never = gate<Response>();
    const s = fakeServer({ balance: () => never.promise });
    vi.stubGlobal('fetch', s.fetch);

    expect((await aiStatus()).balance).toMatchObject({ balanceMicros: 500_000, updatedAt: NOW - 10 * MINUTE });
    await vi.waitFor(() => expect(s.balanceCalls()).toHaveLength(1));

    // Let the hanging request end, so it doesn't outlive this test.
    never.fail(new TypeError('Failed to fetch'));
    expect(await refreshBalance(acc)).toStrictEqual(stored({ updatedAt: NOW - 10 * MINUTE }));
  });

  it('test_status_wait_is_capped_without_value', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: NOW });
    const acc = account();
    await serverAccountItem.setValue(acc);
    const never = gate<Response>();
    const s = fakeServer({ balance: () => never.promise });
    vi.stubGlobal('fetch', s.fetch);

    let answered = false;
    const status = aiStatus().finally(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(BALANCE_WAIT_MS - 1);
    expect(answered).toBe(false);
    expect(s.balanceCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(answered).toBe(true);
    const result = await status;
    expect(result).not.toHaveProperty('balance');
    expect(result).toMatchObject({ state: 'ready' });

    // The request carries on, and its answer is there for the next `aiStatus`.
    never.open(json(balanceBody(970_000)));
    expect(await refreshBalance(acc)).toMatchObject({ balanceMicros: 970_000, source: 'endpoint' });
    expect((await aiStatus()).balance).toMatchObject({ balanceMicros: 970_000 });
    expect(s.balanceCalls()).toHaveLength(1);
  });

  it('test_status_survives_token_failure', async () => {
    const acc = account();
    await serverAccountItem.setValue(acc);
    const s = fakeServer();
    vi.stubGlobal('fetch', s.fetch);

    for (const err of [
      new AIError('network', describeError('network')),
      new AIError('auth-required', 'Sign in to UnAlgorithm Cloud again.'),
    ]) {
      auth.getAccessToken.mockRejectedValue(err);
      await serverBalanceItem.setValue(null);
      const status = await aiStatus();
      expect(status, err.code).toMatchObject({ state: 'ready' });
      expect(status, err.code).not.toHaveProperty('balance');

      // With a stale value stored, that value is shown.
      await serverBalanceItem.setValue(stored({ updatedAt: NOW - 10 * MINUTE }));
      expect((await aiStatus()).balance, err.code).toMatchObject({ balanceMicros: 500_000 });
      await refreshBalance(acc);
    }
    expect(s.calls).toHaveLength(0);
    expect(await serverAccountItem.getValue()).toStrictEqual(acc);
  });
});

describe('status', () => {
  it('test_low_and_empty_flags', async () => {
    await serverAccountItem.setValue(account());
    const s = fakeServer();
    vi.stubGlobal('fetch', s.fetch);
    const flags = async (balanceMicros: number) => {
      await serverBalanceItem.setValue(stored({ balanceMicros }));
      return aiStatus();
    };

    const low = await flags(150_000);
    expect(low.balance).toMatchObject({ balanceMicros: 150_000, low: true, empty: false });
    expect(low).toMatchObject({ state: 'ready' });
    expect(low).not.toHaveProperty('message');
    expect((await flags(199_999)).balance).toMatchObject({ low: true, empty: false });
    expect((await flags(200_000)).balance).toMatchObject({ low: false, empty: false });

    const empty = await flags(0);
    expect(empty.balance).toMatchObject({ balanceMicros: 0, low: false, empty: true });
    expect(empty.state).toBe('needs-attention');
    expect(empty.message).toBe(describeError('insufficient-credits', 'UnAlgorithm Cloud'));
    expect(empty.message).toMatch(/Add credit, or switch to on-device or your own key\.$/);
    expect(s.calls).toHaveLength(0);
  });

  it('test_no_balance_for_other_source_or_sign_in', async () => {
    await serverAccountItem.setValue(account());
    await serverBalanceItem.setValue(stored({ balanceMicros: 0, source: 'refused', updatedAt: NOW - 10 * MINUTE }));
    const s = fakeServer();
    vi.stubGlobal('fetch', s.fetch);

    await setSource({ kind: 'anthropic', model: null });
    const anthropic = await aiStatus();
    expect(anthropic).not.toHaveProperty('balance');
    expect(anthropic).toMatchObject({ kind: 'anthropic', state: 'ready' });

    await setSource({ kind: 'server', baseUrl: 'https://ai.example.org' });
    expect(await aiStatus()).not.toHaveProperty('balance');
    await setSource(null);
    expect(await aiStatus()).not.toHaveProperty('balance');

    // Signing in again comes first: no balance, and the sign-in message stands.
    await setSource(CFG);
    await serverAccountItem.setValue(account({ needsSignIn: true }));
    const signIn = await aiStatus();
    expect(signIn).not.toHaveProperty('balance');
    expect(signIn).toMatchObject({ state: 'needs-attention', message: 'Sign in to UnAlgorithm Cloud again.' });
    await serverAccountItem.setValue(null);
    expect(await aiStatus()).not.toHaveProperty('balance');

    expect(s.calls).toHaveLength(0);
    expect(auth.getAccessToken).not.toHaveBeenCalled();
  });

  it('test_account_url_only_for_safe_origins', async () => {
    for (const origin of [ORIGIN, 'http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
      expect(isTrustedServerOrigin(new URL(origin)), origin).toBe(true);
    }
    for (const origin of ['http://ai.example.org', 'http://127.0.0.2:8787', 'ftp://ai.example.org', 'file:///tmp/x']) {
      expect(isTrustedServerOrigin(new URL(origin)), origin).toBe(false);
    }

    const s = fakeServer();
    vi.stubGlobal('fetch', s.fetch);
    const urlFor = async (origin: string) => {
      await setSource({ kind: 'server', baseUrl: origin });
      await serverAccountItem.setValue(account({ origin }));
      await serverBalanceItem.setValue(stored({ origin }));
      return (await aiStatus()).balance?.accountUrl;
    };
    expect(await urlFor(ORIGIN)).toBe('https://cloud.unalgorithm.app/account');
    expect(await urlFor('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787/account');
    expect(await urlFor('http://[::1]:8787')).toBe('http://[::1]:8787/account');
    // Discovery never accepts this address, so only tampered storage gets here: no link.
    expect(await urlFor('http://ai.example.org')).toBeNull();
    expect(s.calls).toHaveLength(0);
  });

  it('test_balance_belongs_to_account', async () => {
    const a = account();
    await serverAccountItem.setValue(a);
    await serverBalanceItem.setValue(stored({ balanceMicros: 0, source: 'refused' }));
    const s = fakeServer();
    vi.stubGlobal('fetch', s.fetch);
    expect(await aiStatus()).toMatchObject({ state: 'needs-attention', balance: { empty: true } });
    expect(s.calls).toHaveLength(0);

    // Signed out, then in as someone else on the same server: session storage still holds A's refusal.
    const b = account({ deviceId: DEVICE_B, email: 'grace@example.org' });
    await serverAccountItem.setValue(b);
    const status = await aiStatus();
    expect(s.balanceCalls()).toHaveLength(1);
    expect(status.state).not.toBe('needs-attention');
    expect(status).not.toHaveProperty('message');
    expect(status.balance).toMatchObject({ balanceMicros: 970_000, empty: false, low: false });

    // A's request was in flight when B signed in; its settlement belongs to A and isn't shown to B.
    await serverAccountItem.setValue(a);
    const swap = fakeServer({
      classify: async (req) => {
        await serverAccountItem.setValue(b);
        return json(answer(req, { chargedMicros: 300, balanceMicros: 1_000 }));
      },
    });
    await classifyViaServer(CFG, await posts(), OPTS, { fetch: swap.fetch, getAccessToken: tokens() });
    expect(await serverBalanceItem.getValue()).toMatchObject({ deviceId: DEVICE_A, balanceMicros: 1_000 });
    const next = await aiStatus();
    expect(next.balance?.balanceMicros).not.toBe(1_000);
    expect(next.balance).toMatchObject({ balanceMicros: 970_000, low: false, empty: false });
  });
});
