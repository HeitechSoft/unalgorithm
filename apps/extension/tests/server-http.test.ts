/**
 * Signed-in requests from the background to the server (R10, R11, R15): the device's bearer token, one forced refresh
 * after a 401, no cookies, no redirects, a bounded wait, and a result for every failure. The network is a stubbed fetch,
 * the device token a stubbed `getAccessToken` and the sign-in mark a stubbed `markNeedsSignIn`.
 */
import { AIError, describeError } from '@unalgorithm/ai';
import { SYNC_CHANGES_PATH, SYNC_MAX_WAIT_SECONDS, SYNC_PUSH_PATH } from '@unalgorithm/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ServerHttpDeps, type ServerResult, serverRequest } from '../src/background/server-http.ts';

const ORIGIN = 'https://ai.example.org';
const TIMEOUT_MS = 30_000;
const SPACE = '0199d6a4-3f1e-7c2a-9b5d-2e8f4a6c1b3d';
const EPOCH = '0199d6a5-7a20-7d41-8c3e-5f9a0b1c2d4e';

const AUTH: ServerResult = { ok: false, status: 0, reason: 'auth' };
const NETWORK: ServerResult = { ok: false, status: 0, reason: 'network' };
const ABORTED: ServerResult = { ok: false, status: 0, reason: 'aborted' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const unauthorized = () => json({ code: 'auth-required', message: 'Sign in again.' }, 401);

interface Call {
  url: string;
  init: RequestInit;
}

/** A server that answers the nth request with `answer(n, call)`. */
function fakeServer(answer: (n: number, call: Call) => Response | Promise<Response> = () => json({ v: 1 })) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return answer(calls.length, call);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

/** Hands out `access-1`, then `access-2` once a refresh is forced. */
function tokens() {
  let issued = 1;
  return vi.fn(async (_origin: string, opts: { forceRefresh?: boolean } = {}) => {
    if (opts.forceRefresh) issued++;
    return `access-${issued}`;
  });
}

function deps(fetch: typeof globalThis.fetch, over: Partial<ServerHttpDeps> = {}) {
  return {
    fetch,
    getAccessToken: tokens(),
    markNeedsSignIn: vi.fn(async (_origin: string) => undefined),
    ...over,
  } satisfies ServerHttpDeps;
}

const header = (c: Call | undefined, name: string) => new Headers(c?.init.headers).get(name);

/** Rejects like fetch does once `signal` fires (at once when it already has). */
function hangUntilAborted(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('requests', () => {
  it('test_server_request_shape', async () => {
    const s = fakeServer();
    const d = deps(s.fetch);
    const query = { spaceId: SPACE, epoch: EPOCH, since: '42', wait: String(SYNC_MAX_WAIT_SECONDS) };
    const got = await serverRequest(ORIGIN, SYNC_CHANGES_PATH, { query, timeoutMs: TIMEOUT_MS }, d);

    expect(got).toStrictEqual({ ok: true, status: 200, body: { v: 1 } });
    const [get] = s.calls;
    const url = new URL(get?.url ?? '');
    expect(url.origin + url.pathname).toBe(`${ORIGIN}${SYNC_CHANGES_PATH}`);
    expect(Object.fromEntries(url.searchParams)).toStrictEqual(query);
    expect(get?.init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error' });
    expect(get?.init.body).toBeUndefined();
    expect(get?.init.signal).toBeInstanceOf(AbortSignal);
    expect(header(get, 'authorization')).toBe('Bearer access-1');
    expect(header(get, 'content-type')).toBeNull();
    expect(d.getAccessToken).toHaveBeenCalledExactlyOnceWith(ORIGIN);

    // A POST sends its body as JSON; without a query the URL has no search part.
    const body = { v: 1, spaceId: SPACE, pushId: EPOCH, items: [{ key: 'display.mode', value: 'dim' }] };
    await serverRequest(ORIGIN, SYNC_PUSH_PATH, { method: 'POST', body, timeoutMs: TIMEOUT_MS }, d);
    const post = s.calls[1];
    expect(post?.url).toBe(`${ORIGIN}${SYNC_PUSH_PATH}`);
    expect(post?.init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' });
    expect(JSON.parse(String(post?.init.body))).toStrictEqual(body);
    expect(header(post, 'content-type')).toBe('application/json');
    expect(header(post, 'authorization')).toBe('Bearer access-1');

    // The token travels in the header only: never in the URL, the body or the result.
    for (const c of s.calls) expect(`${c.url} ${String(c.init.body)}`).not.toContain('access-1');
    expect(JSON.stringify(got)).not.toContain('access-1');
    expect(d.markNeedsSignIn).not.toHaveBeenCalled();
  });

  it('test_server_request_results', async () => {
    const quota = { code: 'quota-exceeded', message: 'This space is full.' };
    const cases: [string, () => Response, ServerResult][] = [
      ['200', () => json({ v: 1, cursor: 7 }), { ok: true, status: 200, body: { v: 1, cursor: 7 } }],
      ['204', () => new Response(null, { status: 204 }), { ok: true, status: 204, body: null }],
      ['413', () => json(quota, 413), { ok: false, status: 413, body: quota }],
      // A body that isn't JSON is null, whatever the status.
      ['200 not JSON', () => new Response('<html>OK</html>', { status: 200 }), { ok: true, status: 200, body: null }],
      ['502 not JSON', () => new Response('<html>Bad gateway</html>', { status: 502 }), { ok: false, status: 502, body: null }],
      ['404 empty', () => new Response(null, { status: 404 }), { ok: false, status: 404, body: null }],
    ];
    for (const [name, answer, expected] of cases) {
      const s = fakeServer(answer);
      const d = deps(s.fetch);
      expect(
        await serverRequest(ORIGIN, SYNC_PUSH_PATH, { method: 'POST', body: {}, timeoutMs: TIMEOUT_MS }, d),
        name,
      ).toStrictEqual(expected);
      // Only a 401 asks for another token.
      expect(s.calls, name).toHaveLength(1);
      expect(d.getAccessToken, name).toHaveBeenCalledOnce();
      expect(d.markNeedsSignIn, name).not.toHaveBeenCalled();
    }
  });

  it('test_server_request_max_bytes', async () => {
    // An answer over the default 64 KiB: dropped by default, read when the caller allows more.
    const big = { v: 1, items: Array.from({ length: 200 }, (_, i) => ({ key: `k${i}`, value: 'x'.repeat(500) })) };
    expect(JSON.stringify(big).length).toBeGreaterThan(64 * 1024);
    const get = (maxBytes?: number) =>
      serverRequest(ORIGIN, SYNC_CHANGES_PATH, { timeoutMs: TIMEOUT_MS, maxBytes }, deps(fakeServer(() => json(big)).fetch));
    expect(await get()).toStrictEqual({ ok: true, status: 200, body: null });
    expect(await get(1024 * 1024)).toStrictEqual({ ok: true, status: 200, body: big });
  });

  it('test_server_request_never_leaves_origin', async () => {
    for (const path of ['//evil.example/x', 'https://evil.example/v1/sync/push', 'http://ai.example.org/v1/sync/push']) {
      const s = fakeServer();
      const d = deps(s.fetch);
      expect(await serverRequest(ORIGIN, path, { timeoutMs: TIMEOUT_MS }, d), path).toStrictEqual(NETWORK);
      expect(s.fetch, path).not.toHaveBeenCalled();
      // No token is read (nor refreshed) for a request that never goes out.
      expect(d.getAccessToken, path).not.toHaveBeenCalled();
    }

    // An origin that isn't one: no request either.
    const s = fakeServer();
    const d = deps(s.fetch);
    expect(await serverRequest('not a server', SYNC_CHANGES_PATH, { timeoutMs: TIMEOUT_MS }, d)).toStrictEqual(NETWORK);
    expect(s.fetch).not.toHaveBeenCalled();
    expect(d.getAccessToken).not.toHaveBeenCalled();
  });
});

describe('auth', () => {
  it('test_server_request_refreshes_once', async () => {
    const s = fakeServer((n) => (n === 1 ? unauthorized() : json({ v: 1, accepted: 1 })));
    const getAccessToken = tokens();
    const d = deps(s.fetch, { getAccessToken });
    const body = { v: 1, items: [] };
    const got = await serverRequest(ORIGIN, SYNC_PUSH_PATH, { method: 'POST', body, timeoutMs: TIMEOUT_MS }, d);

    expect(got).toStrictEqual({ ok: true, status: 200, body: { v: 1, accepted: 1 } });
    expect(getAccessToken.mock.calls).toStrictEqual([[ORIGIN], [ORIGIN, { forceRefresh: true }]]);
    expect(s.calls.map((c) => header(c, 'authorization'))).toStrictEqual(['Bearer access-1', 'Bearer access-2']);
    // The retry is the same request.
    expect(s.calls.map((c) => JSON.parse(String(c.init.body)))).toStrictEqual([body, body]);
    expect(s.calls.map((c) => c.url)).toStrictEqual([`${ORIGIN}${SYNC_PUSH_PATH}`, `${ORIGIN}${SYNC_PUSH_PATH}`]);
    expect(d.markNeedsSignIn).not.toHaveBeenCalled();
  });

  it('test_server_request_double_401', async () => {
    const s = fakeServer(unauthorized);
    const d = deps(s.fetch);
    expect(await serverRequest(ORIGIN, SYNC_CHANGES_PATH, { timeoutMs: TIMEOUT_MS }, d)).toStrictEqual(AUTH);
    expect(s.calls).toHaveLength(2);
    expect(d.getAccessToken).toHaveBeenCalledTimes(2);
    expect(d.markNeedsSignIn).toHaveBeenCalledExactlyOnceWith(ORIGIN);

    // The balance refresh leaves signing in again to the classify path (CL2-10).
    const quiet = fakeServer(unauthorized);
    const q = deps(quiet.fetch);
    const opts = { timeoutMs: TIMEOUT_MS, markNeedsSignIn: false };
    expect(await serverRequest(ORIGIN, SYNC_CHANGES_PATH, opts, q)).toStrictEqual(AUTH);
    expect(quiet.calls).toHaveLength(2);
    expect(q.markNeedsSignIn).not.toHaveBeenCalled();

    // Marking the account can fail; the answer is the same.
    const failing = deps(fakeServer(unauthorized).fetch, {
      markNeedsSignIn: vi.fn(async () => {
        throw new Error('Storage is gone.');
      }),
    });
    await expect(serverRequest(ORIGIN, SYNC_CHANGES_PATH, { timeoutMs: TIMEOUT_MS }, failing)).resolves.toStrictEqual(AUTH);
  });

  it('test_server_request_token_failure', async () => {
    const cases: [string, unknown, ServerResult][] = [
      ['auth-required', new AIError('auth-required', describeError('auth-required', 'ai.example.org')), AUTH],
      ['overloaded', new AIError('overloaded', describeError('overloaded')), NETWORK],
      ['network', new AIError('network', describeError('network')), NETWORK],
      ['permission', new AIError('permission', "ai.example.org doesn't accept sign-ins from this extension."), NETWORK],
      ['rate-limit', new AIError('rate-limit', describeError('rate-limit')), NETWORK],
      ['unknown', new AIError('unknown', describeError('unknown')), NETWORK],
      ['plain Error', new Error('IndexedDB is gone.'), NETWORK],
      ['not an Error', 'nope', NETWORK],
    ];
    for (const [name, err, expected] of cases) {
      const s = fakeServer();
      const d = deps(s.fetch, { getAccessToken: vi.fn(async () => Promise.reject(err)) });
      await expect(serverRequest(ORIGIN, SYNC_CHANGES_PATH, { timeoutMs: TIMEOUT_MS }, d), name).resolves.toStrictEqual(expected);
      expect(s.fetch, name).not.toHaveBeenCalled();
      expect(d.markNeedsSignIn, name).not.toHaveBeenCalled();
    }

    // The forced refresh after a 401 fails: no retry, and the account isn't marked here (`getAccessToken` marks it
    // itself when the server refuses the refresh token).
    for (const [name, err, expected] of [
      ['overloaded', new AIError('overloaded', describeError('overloaded')), NETWORK],
      ['auth-required', new AIError('auth-required', describeError('auth-required', 'ai.example.org')), AUTH],
    ] as const) {
      const s = fakeServer(unauthorized);
      const getAccessToken = vi.fn(async (_origin: string, opts: { forceRefresh?: boolean } = {}) =>
        opts.forceRefresh ? Promise.reject(err) : 'access-1',
      );
      const d = deps(s.fetch, { getAccessToken });
      await expect(serverRequest(ORIGIN, SYNC_CHANGES_PATH, { timeoutMs: TIMEOUT_MS }, d), name).resolves.toStrictEqual(expected);
      expect(getAccessToken.mock.calls, name).toStrictEqual([[ORIGIN], [ORIGIN, { forceRefresh: true }]]);
      expect(s.calls, name).toHaveLength(1);
      expect(d.markNeedsSignIn, name).not.toHaveBeenCalled();
    }
  });
});

describe('failures', () => {
  it('test_server_request_network_abort_timeout', async () => {
    // The request never gets an answer.
    const down = fakeServer(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(serverRequest(ORIGIN, SYNC_CHANGES_PATH, { timeoutMs: TIMEOUT_MS }, deps(down.fetch))).resolves.toStrictEqual(
      NETWORK,
    );
    // Nor a whole one: the body breaks off.
    const cut = fakeServer(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('The connection was reset.'));
            },
          }),
          { status: 200 },
        ),
    );
    await expect(serverRequest(ORIGIN, SYNC_CHANGES_PATH, { timeoutMs: TIMEOUT_MS }, deps(cut.fetch))).resolves.toStrictEqual(
      NETWORK,
    );

    // The caller aborts while the request runs, or before it starts.
    const hanging = fakeServer((_n, call) => hangUntilAborted(call.init.signal));
    const controller = new AbortController();
    const running = serverRequest(
      ORIGIN,
      SYNC_CHANGES_PATH,
      { timeoutMs: TIMEOUT_MS, signal: controller.signal },
      deps(hanging.fetch),
    );
    await vi.waitFor(() => expect(hanging.calls).toHaveLength(1));
    // The caller's signal joins the timeout: not passed on as it is.
    expect(hanging.calls[0]?.init.signal).not.toBe(controller.signal);
    controller.abort();
    expect(await running).toStrictEqual(ABORTED);
    const early = deps(fakeServer((_n, call) => hangUntilAborted(call.init.signal)).fetch);
    expect(
      await serverRequest(ORIGIN, SYNC_CHANGES_PATH, { timeoutMs: TIMEOUT_MS, signal: AbortSignal.abort() }, early),
    ).toStrictEqual(ABORTED);

    // The timeout fires: that is the network's failure, not the caller's.
    const timeouts: AbortController[] = [];
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const t = new AbortController();
      timeouts.push(t);
      return t.signal;
    });
    const slow = fakeServer((_n, call) => hangUntilAborted(call.init.signal));
    const waiting = serverRequest(ORIGIN, SYNC_CHANGES_PATH, { timeoutMs: TIMEOUT_MS }, deps(slow.fetch));
    await vi.waitFor(() => expect(slow.calls).toHaveLength(1));
    expect(timeout).toHaveBeenCalledExactlyOnceWith(TIMEOUT_MS);
    // Without a caller's signal, the timeout is the request's only signal.
    expect(slow.calls[0]?.init.signal).toBe(timeouts[0]?.signal);
    timeouts[0]?.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    expect(await waiting).toStrictEqual(NETWORK);

    // With a caller's signal that hasn't fired, a timeout is still `network`.
    const both = fakeServer((_n, call) => hangUntilAborted(call.init.signal));
    const caller = new AbortController();
    const joined = serverRequest(ORIGIN, SYNC_CHANGES_PATH, { timeoutMs: 25_000, signal: caller.signal }, deps(both.fetch));
    await vi.waitFor(() => expect(both.calls).toHaveLength(1));
    expect(timeout).toHaveBeenLastCalledWith(25_000);
    timeouts[1]?.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    expect(await joined).toStrictEqual(NETWORK);
    expect(caller.signal.aborted).toBe(false);

    // A retry after a 401 gets a timeout of its own.
    timeout.mockClear();
    const retried = fakeServer((n) => (n === 1 ? unauthorized() : json({ v: 1 })));
    expect(await serverRequest(ORIGIN, SYNC_CHANGES_PATH, { timeoutMs: TIMEOUT_MS }, deps(retried.fetch))).toMatchObject({
      ok: true,
    });
    expect(timeout.mock.calls).toStrictEqual([[TIMEOUT_MS], [TIMEOUT_MS]]);
  });
});
