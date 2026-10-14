import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { describeError } from '@unalgorithm/ai';
import {
  formatHlc,
  REVOKE_PATH,
  SERVER_INFO_PATH,
  ServerInfoSchema,
  SYNC_CHANGES_PATH,
  SYNC_PUSH_PATH,
  SYNC_SPACE_MAX_ITEMS,
  SYNC_SPACES_PATH,
  SyncChangesResponseSchema,
  SyncErrorSchema,
  type SyncItem,
  type SyncPushRequest,
  SyncPushResponseSchema,
  type SyncSpace,
  SyncSpacesResponseSchema,
  type TokenResponse,
} from '@unalgorithm/protocol';
import { SETTINGS_COLLECTION } from '@unalgorithm/sync';
import { asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncItems, syncPushes, syncSpaces } from '../src/db/schema.ts';
import { SYNC_REQUESTS_PER_MINUTE } from '../src/routes/sync.ts';
import { createSpaceNotifier } from '../src/sync/notifier.ts';
import { userSpaceAccess } from '../src/sync/spaces.ts';
import { DEV_EXTENSION_ID, DEV_EXTENSION_ORIGIN, postJson, signInDevice } from './support/sign-in.ts';
import { createTestApp, type TestAppOptions, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const TOM = 'tom@example.com';
const ANA = 'ana@example.com';
const INSTANCE = 'Test server';
const AUTH_REQUIRED = { code: 'auth-required', message: describeError('auth-required', INSTANCE) };
const NOT_FOUND = { code: 'not-found', message: 'Not found.' };

/** A long-poll's wait in the tests below, in seconds. */
const WAIT_S = 5;
/** A wait that ran its course: timers may fire a millisecond early, and the request's own work comes on top. */
const WAITED_MS = WAIT_S * 1000 - 100;
/** "About 5 s": room for a loaded machine, far below a second wait. */
const WAITED_AT_MOST_MS = WAIT_S * 1000 + 3_000;

type TestApp = Awaited<ReturnType<typeof syncApp>>;

/** Apps a test opened, closed after it whatever the outcome; fake timers and spies are put back too. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A test server with Tom's two signed-in devices (laptop and desktop) and Ana's one. */
async function syncApp(options: TestAppOptions = {}) {
  const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: `${TOM},${ANA}` }), ...options });
  cleanup.push(t.close);
  const laptop = await signInDevice(t.app, t.outbox, TOM);
  const desktop = await signInDevice(t.app, t.outbox, TOM);
  const ana = await signInDevice(t.app, t.outbox, ANA);
  return { ...t, laptop, desktop, ana };
}

const bearer = (tokens: TokenResponse | null): Record<string, string> =>
  tokens ? { Authorization: `Bearer ${tokens.access_token}` } : {};

/** `GET /v1/sync/spaces` with this device's token, or none. */
const spaces = (t: TestApp, tokens: TokenResponse | null) =>
  Promise.resolve(t.app.request(SYNC_SPACES_PATH, { headers: bearer(tokens) }));

interface ChangesQuery {
  spaceId: string;
  epoch: string;
  since: number;
  wait?: number;
}

/** The changes route's path with this query. */
function changesPath(q: ChangesQuery): string {
  const query = new URLSearchParams(Object.entries(q).map(([k, v]): [string, string] => [k, String(v)]));
  return `${SYNC_CHANGES_PATH}?${query}`;
}

/** `GET /v1/sync/changes` with this device's token, or none; `signal` stands for the client's connection. */
function changes(t: TestApp, tokens: TokenResponse | null, q: ChangesQuery, signal?: AbortSignal): Promise<Response> {
  return Promise.resolve(t.app.request(changesPath(q), { headers: bearer(tokens), signal }));
}

/** The app on a loopback port, served as `startServer` serves it; closed after the test. */
async function serveOnLoopback(t: TestApp): Promise<{ server: Server; url: string }> {
  // Without `createServer` options, serve() builds a node:http server.
  const server = serve({ fetch: t.app.fetch, hostname: '127.0.0.1', port: 0 }) as Server;
  await once(server, 'listening');
  cleanup.push(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** `POST /v1/sync/push` with this device's token, or none. */
const push = (t: TestApp, tokens: TokenResponse | null, body: unknown) => postJson(t.app, SYNC_PUSH_PATH, body, bearer(tokens));

/** The device's one space, from the spaces route. */
async function spaceOf(t: TestApp, tokens: TokenResponse): Promise<SyncSpace> {
  const res = await spaces(t, tokens);
  expect(res.status).toBe(200);
  const [space, ...more] = SyncSpacesResponseSchema.parse(await res.json()).spaces;
  expect(more).toEqual([]);
  if (!space) throw new Error('No space was listed.');
  return space;
}

/** Changes of `space` after `since`. */
const since = (space: SyncSpace, cursor: number, wait?: number): ChangesQuery => ({
  spaceId: space.id,
  epoch: space.epoch,
  since: cursor,
  ...(wait === undefined ? {} : { wait }),
});

/** A stamp `agoMs` before the server's clock, from Tom's laptop. */
const stamp = (agoMs: number) => formatHlc({ ms: Date.now() - agoMs, counter: 0, device: 'toms-laptop' });

function live(key: string, value: unknown, hlc = stamp(60_000)): SyncItem {
  return { collection: SETTINGS_COLLECTION, key, hlc, deleted: false, value } as SyncItem;
}

/** An interest entry's value (`TopicSchema`). */
const topic = (label: string) => ({ label, keywords: [], addedAt: 1 });

function pushBody(space: Pick<SyncSpace, 'id' | 'epoch'>, items: SyncItem[], pushId = randomUUID()): SyncPushRequest {
  return { v: 1, spaceId: space.id, epoch: space.epoch, pushId, items };
}

/** Everything a push can change in the database. */
async function stored(t: TestApp) {
  const db = t.deps.db.db;
  return {
    spaces: await db.select().from(syncSpaces).orderBy(asc(syncSpaces.id)),
    items: await db.select().from(syncItems).orderBy(asc(syncItems.spaceId), asc(syncItems.seq)),
    pushes: await db.select().from(syncPushes).orderBy(asc(syncPushes.pushId)),
  };
}

async function expectRefused(res: Response): Promise<void> {
  expect(res.status).toBe(401);
  expect(res.headers.get('www-authenticate')).toBe('Bearer');
  expect(await res.json()).toEqual(AUTH_REQUIRED);
}

/** A sync refusal: its status and `SyncErrorSchema` body with the code's fixed message. */
async function expectSyncError(res: Response, status: number, code: string, message: string): Promise<void> {
  expect(res.status).toBe(status);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(SyncErrorSchema.parse(await res.json())).toEqual({ code, message });
}

/** A request and how long it took to answer, in ms. */
async function timed(request: Promise<Response>): Promise<{ res: Response; ms: number }> {
  const started = performance.now();
  const res = await request;
  return { res, ms: performance.now() - started };
}

/** Whether a promise has settled, read without waiting on it. */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value: T | undefined } = { settled: false, value: undefined };
  void promise.then((value) => {
    state.settled = true;
    state.value = value;
  });
  return state;
}

describe('discovery and auth', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_discovery_advertises_sync', async () => {
    const t = await createTestApp();
    cleanup.push(t.close);
    const doc = ServerInfoSchema.parse(await (await t.app.request(SERVER_INFO_PATH)).json());
    expect(doc.capabilities).toEqual({ classify: true, sync: true });
  });

  it('test_sync_routes_require_device', async () => {
    const t = await syncApp();
    const space = await spaceOf(t, t.laptop);
    const all = (tokens: TokenResponse | null) => [
      spaces(t, tokens),
      changes(t, tokens, since(space, 0)),
      push(t, tokens, pushBody(space, [live('display.mode', 'hide')])),
    ];

    for (const res of await Promise.all(all(null))) await expectRefused(res);
    // A token in another scheme is no bearer token.
    const basic = await t.app.request(SYNC_SPACES_PATH, { headers: { Authorization: `Basic ${t.laptop.access_token}` } });
    await expectRefused(basic);

    // "Sign out" revokes the laptop; its access token has not expired, and the desktop is still signed in.
    const signOut = { refresh_token: t.laptop.refresh_token, client_id: DEV_EXTENSION_ID };
    expect((await postJson(t.app, REVOKE_PATH, signOut, { Origin: DEV_EXTENSION_ORIGIN })).status).toBe(200);
    for (const res of await Promise.all(all(t.laptop))) await expectRefused(res);
    expect((await spaces(t, t.desktop)).status).toBe(200);
    // Nothing was written by the refused pushes.
    expect((await stored(t)).items).toEqual([]);
  });
});

describe('round trip', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_spaces_route_returns_personal_space', async () => {
    const t = await syncApp();
    const res = await spaces(t, t.laptop);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = SyncSpacesResponseSchema.parse(await res.json());
    expect(body.spaces).toHaveLength(1);
    const [space] = body.spaces;
    expect(space).toMatchObject({ kind: 'user', access: 'read-write' });

    // The same space on every call, from either of the account's devices.
    expect(await spaceOf(t, t.laptop)).toEqual(space);
    expect(await spaceOf(t, t.desktop)).toEqual(space);
  });

  it('test_push_then_pull_between_devices', async () => {
    const t = await syncApp();
    const space = await spaceOf(t, t.laptop);
    const items = [live('display.mode', 'hide'), live('interests.more.climate', topic('Climate'))];

    const pushed = await push(t, t.laptop, pushBody(space, items));
    expect(pushed.status).toBe(200);
    expect(pushed.headers.get('cache-control')).toBe('no-store');
    expect(SyncPushResponseSchema.parse(await pushed.json())).toEqual({
      v: 1,
      results: [
        { collection: SETTINGS_COLLECTION, key: 'display.mode', status: 'applied', seq: 1 },
        { collection: SETTINGS_COLLECTION, key: 'interests.more.climate', status: 'applied', seq: 2 },
      ],
    });

    const pulled = await changes(t, t.desktop, since(space, 0));
    expect(pulled.status).toBe(200);
    expect(pulled.headers.get('cache-control')).toBe('no-store');
    const body = SyncChangesResponseSchema.parse(await pulled.json());
    expect(body).toMatchObject({ v: 1, spaceId: space.id, epoch: space.epoch, cursor: 2, more: false });
    expect(body.items).toEqual(items.map((item, i) => ({ ...item, seq: i + 1 })));

    const after = SyncChangesResponseSchema.parse(await (await changes(t, t.desktop, since(space, body.cursor))).json());
    expect(after).toMatchObject({ cursor: 2, more: false, items: [] });
  });

  it('test_sync_routes_isolate_accounts', async () => {
    const t = await syncApp();
    const toms = await spaceOf(t, t.laptop);
    expect((await push(t, t.laptop, pushBody(toms, [live('display.mode', 'hide')]))).status).toBe(200);
    const before = await stored(t);

    // Ana gets exactly what an id no space has gets.
    await expectSyncError(await changes(t, t.ana, since(toms, 0)), 404, 'not-found', 'Not found.');
    await expectSyncError(await changes(t, t.ana, since(toms, 0, 1)), 404, 'not-found', 'Not found.');
    const theirs = pushBody(toms, [live('display.mode', 'dim', stamp(1_000))]);
    await expectSyncError(await push(t, t.ana, theirs), 404, 'not-found', 'Not found.');
    const nobody = { ...toms, id: randomUUID() };
    expect(await (await changes(t, t.ana, since(nobody, 0))).json()).toEqual(NOT_FOUND);
    expect(await (await push(t, t.ana, pushBody(nobody, [live('display.mode', 'dim')]))).json()).toEqual(NOT_FOUND);
    expect(await stored(t)).toEqual(before);

    // Ana's list holds her own space only.
    const anas = await spaceOf(t, t.ana);
    expect(anas.id).not.toBe(toms.id);
    expect(await stored(t)).toMatchObject({ items: before.items, pushes: before.pushes });
  });

  it('test_read_only_space_refuses_push', async () => {
    const t = await syncApp({ syncAccess: (space, who) => (userSpaceAccess(space, who) ? 'read' : null) });
    const space = await spaceOf(t, t.laptop);
    expect(space.access).toBe('read');
    const before = await stored(t);

    const res = await push(t, t.laptop, pushBody(space, [live('display.mode', 'hide')]));
    await expectSyncError(res, 403, 'read-only', "This space can't be changed from here.");
    expect(await stored(t)).toEqual(before);
    expect(before.items).toEqual([]);
    expect(before.pushes).toEqual([]);

    const read = await changes(t, t.desktop, since(space, 0));
    expect(read.status).toBe(200);
    expect(SyncChangesResponseSchema.parse(await read.json())).toMatchObject({ cursor: 0, items: [] });
  });
});

describe('long-poll and refusals', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_changes_wait_wakes_on_push', async () => {
    const notifier = createSpaceNotifier();
    const t = await syncApp({ syncNotifier: notifier });
    const space = await spaceOf(t, t.desktop);
    const item = live('display.mode', 'hide');

    // The push is sent right after the request starts: the route subscribes before it reads, so it is woken either way.
    const waiting = changes(t, t.desktop, since(space, 0, WAIT_S));
    const pushed = await push(t, t.laptop, pushBody(space, [item]));
    const pushedAt = performance.now();
    expect(pushed.status).toBe(200);
    const woken = await waiting;
    expect(performance.now() - pushedAt).toBeLessThan(300);
    expect(woken.status).toBe(200);
    const body = SyncChangesResponseSchema.parse(await woken.json());
    expect(body.items).toEqual([{ ...item, seq: 1 }]);
    expect(notifier.waiting(space.id)).toBe(0);

    // A push that commits and notifies between the request's read and its wait still wakes it: the route subscribed
    // before it read. Made certain here: the push runs as soon as the read's transaction ends, before the route goes on.
    const second = live('interests.more.climate', topic('Climate'));
    const db = t.deps.db.db;
    const transaction = db.transaction.bind(db);
    let between: Promise<Response> | undefined;
    vi.spyOn(db, 'transaction').mockImplementation(async (run, config) => {
      const result = await transaction(run, config);
      // `readChanges` is the changes route's one transaction, and the only read-only one.
      if (config?.accessMode === 'read only' && !between) {
        between = push(t, t.laptop, pushBody(space, [second]));
        expect((await between).status).toBe(200);
      }
      return result;
    });
    const raced = await timed(changes(t, t.desktop, since(space, body.cursor, WAIT_S)));
    vi.mocked(db.transaction).mockRestore();
    expect(between).toBeDefined();
    expect(raced.res.status).toBe(200);
    const racedBody = SyncChangesResponseSchema.parse(await raced.res.json());
    expect(racedBody.items).toEqual([{ ...second, seq: 2 }]);
    expect(raced.ms).toBeLessThan(WAITED_MS);
    expect(notifier.waiting(space.id)).toBe(0);
    const { cursor } = racedBody;

    // Requests that never wait unregister too: one that finds items at once, and one refused with 410. Each registers
    // as it begins; left behind, four of them would fill the space, and no later long-poll on it would be woken.
    const otherEpoch = { ...space, epoch: randomUUID() };
    for (let i = 0; i < 2; i++) {
      const found = await timed(changes(t, t.desktop, since(space, 0, WAIT_S)));
      expect(found.res.status).toBe(200);
      expect(SyncChangesResponseSchema.parse(await found.res.json()).items).toHaveLength(2);
      expect(found.ms).toBeLessThan(WAITED_MS);
      const refused = await timed(changes(t, t.laptop, since(otherEpoch, 0, WAIT_S)));
      expect(refused.res.status).toBe(410);
      expect(refused.ms).toBeLessThan(WAITED_MS);
    }
    expect(notifier.waiting(space.id)).toBe(0);

    // Nothing pushed: each answers after the wait, with nothing. Four fill the space; the fifth, sent once they wait, is
    // not registered, and still waits its time instead of answering at once.
    const devices = [t.laptop, t.desktop, t.laptop, t.desktop];
    const four = devices.map((device) => timed(changes(t, device, since(space, cursor, WAIT_S))));
    await vi.waitUntil(() => notifier.waiting(space.id) === 4, { timeout: PGLITE_TIMEOUT, interval: 5 });
    const fifth = timed(changes(t, t.laptop, since(space, cursor, WAIT_S)));

    for (const { res, ms } of await Promise.all([...four, fifth])) {
      expect(res.status).toBe(200);
      expect(SyncChangesResponseSchema.parse(await res.json())).toMatchObject({ cursor, items: [] });
      expect(ms).toBeGreaterThanOrEqual(WAITED_MS);
      expect(ms).toBeLessThan(WAITED_AT_MOST_MS);
    }
    expect(notifier.waiting(space.id)).toBe(0);

    // A client that goes away frees its place at once instead of holding it for the whole wait.
    const connection = new AbortController();
    const gone = timed(changes(t, t.desktop, since(space, cursor, WAIT_S), connection.signal));
    await vi.waitUntil(() => notifier.waiting(space.id) === 1, { timeout: PGLITE_TIMEOUT, interval: 5 });
    connection.abort();
    const { ms } = await gone;
    expect(ms).toBeLessThan(WAITED_MS);
    expect(notifier.waiting(space.id)).toBe(0);
  });

  it('test_changes_wait_ends_when_server_stops', async () => {
    const stopping = new AbortController();
    const notifier = createSpaceNotifier();
    const t = await syncApp({ syncNotifier: notifier, stopping: stopping.signal });
    const space = await spaceOf(t, t.desktop);
    // Over a real socket: its connection outlives an answer unless the answer closes it.
    const { server, url } = await serveOnLoopback(t);
    const before = await fetch(`${url}${SYNC_SPACES_PATH}`, { headers: bearer(t.desktop) });
    expect(before.status).toBe(200);
    expect(before.headers.get('connection')).not.toBe('close');
    await before.body?.cancel();

    const waiting = fetch(`${url}${changesPath(since(space, 0, WAIT_S))}`, { headers: bearer(t.desktop) });
    await vi.waitUntil(() => notifier.waiting(space.id) === 1, { timeout: PGLITE_TIMEOUT, interval: 5 });

    // As `startServer` stops: the signal first, then no new connections.
    const stoppedAt = performance.now();
    stopping.abort();
    const closed = new Promise<number>((resolve) => server.close(() => resolve(performance.now() - stoppedAt)));
    // The long-poll answers its first, empty read at once, and closes its connection, so the stop is not held open.
    const res = await waiting;
    expect(performance.now() - stoppedAt).toBeLessThan(1_000);
    expect(res.status).toBe(200);
    expect(res.headers.get('connection')).toBe('close');
    expect(SyncChangesResponseSchema.parse(await res.json())).toMatchObject({ cursor: 0, items: [] });
    // Well before a kept-alive connection would go idle (4 s in Node's fetch, 5 s in its server).
    expect(await closed).toBeLessThan(2_000);
    expect(notifier.waiting(space.id)).toBe(0);

    // A request still arriving on an open connection is answered at once, and closes it too.
    const late = await timed(changes(t, t.desktop, since(space, 0, WAIT_S)));
    expect(late.res.status).toBe(200);
    expect(late.res.headers.get('connection')).toBe('close');
    expect(late.ms).toBeLessThan(WAITED_MS);
    expect((await spaces(t, t.laptop)).headers.get('connection')).toBe('close');
    expect(notifier.waiting(space.id)).toBe(0);
  });

  it('test_sync_refusal_statuses', async () => {
    const t = await syncApp();
    const space = await spaceOf(t, t.laptop);
    const RESYNC = "Sync must start again from this server's copy.";

    // Another epoch, for a read and for a push.
    const otherEpoch = { ...space, epoch: randomUUID() };
    const read = await changes(t, t.laptop, since(otherEpoch, 0));
    await expectSyncError(read, 410, 'resync-required', RESYNC);
    const pushed = await push(t, t.laptop, pushBody(otherEpoch, [live('display.mode', 'hide')]));
    await expectSyncError(pushed, 410, 'resync-required', RESYNC);
    // A cursor ahead of the server, and a long-poll that is refused before it waits.
    await expectSyncError(await changes(t, t.laptop, since(space, 7)), 410, 'resync-required', RESYNC);
    await expectSyncError(await changes(t, t.laptop, since(otherEpoch, 0, WAIT_S)), 410, 'resync-required', RESYNC);

    const resyncs = t.events().filter((e) => e.event === 'sync.resync');
    expect(resyncs).toEqual([
      expect.objectContaining({ level: 'info', rid: read.headers.get('x-request-id'), reason: 'epoch' }),
      expect.objectContaining({ level: 'info', rid: pushed.headers.get('x-request-id'), reason: 'epoch' }),
      expect.objectContaining({ reason: 'rewound' }),
      expect.objectContaining({ reason: 'epoch' }),
    ]);

    // Over quota: a full space refuses a new key, and nothing is written.
    await t.deps.db.db.update(syncSpaces).set({ itemCount: SYNC_SPACE_MAX_ITEMS }).where(eq(syncSpaces.id, space.id));
    const before = await stored(t);
    const full = await push(t, t.laptop, pushBody(space, [live('display.mode', 'hide')]));
    await expectSyncError(full, 413, 'quota-exceeded', 'Your synced settings are larger than this server allows.');
    expect(await stored(t)).toEqual(before);
    const quota = t.events().filter((e) => e.event === 'sync.quota');
    expect(quota).toEqual([expect.objectContaining({ level: 'warn', rid: full.headers.get('x-request-id') })]);
  });

  it('test_sync_rate_limit_per_user', async () => {
    const t = await syncApp();
    const toms = await spaceOf(t, t.laptop);
    const anas = await spaceOf(t, t.ana);
    expect(SYNC_REQUESTS_PER_MINUTE).toBe(120);
    // Only Date is faked, and it stands still: every request below falls in the same instant.
    vi.useFakeTimers({ toFake: ['Date'] });

    // Changes and pushes share one bucket per account, whichever of its devices sends them.
    for (let i = 0; i < SYNC_REQUESTS_PER_MINUTE - 1; i++) {
      expect((await changes(t, i % 2 === 0 ? t.laptop : t.desktop, since(toms, 0))).status).toBe(200);
    }
    expect((await push(t, t.laptop, pushBody(toms, [live('display.mode', 'hide')]))).status).toBe(200);

    const limited = await changes(t, t.desktop, since(toms, 0));
    expect(limited.status).toBe(429);
    // The bucket refills two a second, so the next request is half a second away: Retry-After rounds up.
    expect(limited.headers.get('retry-after')).toBe('1');
    expect(await limited.json()).toEqual({ code: 'rate-limit', message: describeError('rate-limit', INSTANCE) });
    const refusedPush = await push(t, t.laptop, pushBody(toms, [live('display.mode', 'dim', stamp(1_000))]));
    expect(refusedPush.status).toBe(429);
    // Listing spaces is not limited.
    expect((await spaces(t, t.laptop)).status).toBe(200);

    // Ana's requests are her own.
    expect((await changes(t, t.ana, since(anas, 0))).status).toBe(200);
    expect((await push(t, t.ana, pushBody(anas, [live('display.mode', 'hide')]))).status).toBe(200);

    vi.setSystemTime(Date.now() + 500);
    expect((await changes(t, t.desktop, since(toms, 0))).status).toBe(200);
  });
});

describe('notifier', () => {
  const SPACE = 'space-a';
  const OTHER = 'space-b';

  it('test_notifier_limits_and_cleanup', async () => {
    vi.useFakeTimers();
    const notifier = createSpaceNotifier();
    const flush = () => vi.advanceTimersByTimeAsync(0);

    // A fifth waiter on a full space is not registered: a notify does not wake it, it waits its time, and it is never
    // counted.
    const four = Array.from({ length: 4 }, () => track(notifier.subscribe(SPACE).wait(10_000)));
    const fifth = track(notifier.subscribe(SPACE).wait(1_000));
    expect(notifier.waiting(SPACE)).toBe(4);
    await vi.advanceTimersByTimeAsync(500);
    expect(fifth.settled).toBe(false);
    expect(notifier.waiting(SPACE)).toBe(4);
    notifier.notify(SPACE);
    await flush();
    expect(four.map((w) => w.value)).toEqual([true, true, true, true]);
    expect(fifth.settled).toBe(false);
    expect(notifier.waiting(SPACE)).toBe(0);
    await vi.advanceTimersByTimeAsync(499);
    expect(fifth.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fifth).toEqual({ settled: true, value: false });

    // Its signal ends it at once, an aborted one before it starts too.
    const full = Array.from({ length: 4 }, () => track(notifier.subscribe(SPACE).wait(10_000)));
    const controller = new AbortController();
    const aborted = track(notifier.subscribe(SPACE).wait(10_000, controller.signal));
    const early = track(notifier.subscribe(SPACE).wait(10_000, AbortSignal.abort()));
    await flush();
    expect(early).toEqual({ settled: true, value: false });
    expect(aborted.settled).toBe(false);
    controller.abort();
    await flush();
    expect(aborted).toEqual({ settled: true, value: false });
    expect(notifier.waiting(SPACE)).toBe(4);

    // A registered waiter: false after its timeout, and at once when its signal aborts. Spaces are apart.
    const other = track(notifier.subscribe(OTHER).wait(2_000));
    const otherController = new AbortController();
    const otherAborted = track(notifier.wait(OTHER, 10_000, otherController.signal));
    expect(notifier.waiting(OTHER)).toBe(2);
    otherController.abort();
    await flush();
    expect(otherAborted).toEqual({ settled: true, value: false });
    expect(notifier.waiting(OTHER)).toBe(1);
    notifier.notify(SPACE);
    await flush();
    expect(full.map((w) => w.value)).toEqual([true, true, true, true]);
    expect(other.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(other).toEqual({ settled: true, value: false });

    // Every waiter has finished: none is registered, and no timer is left behind.
    expect(notifier.waiting(SPACE)).toBe(0);
    expect(notifier.waiting(OTHER)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('test_notifier_close_ends_waits', async () => {
    vi.useFakeTimers();
    const notifier = createSpaceNotifier({ maxWaitersPerSpace: 1 });
    const flush = () => vi.advanceTimersByTimeAsync(0);

    // A registered wait, one on a full space, and a subscription whose wait has not started.
    const registered = track(notifier.wait(SPACE, 10_000));
    const unregistered = track(notifier.wait(SPACE, 10_000));
    const reading = notifier.subscribe(OTHER);
    expect(notifier.waiting(SPACE)).toBe(1);
    expect(notifier.waiting(OTHER)).toBe(1);
    notifier.close();
    notifier.close();
    await flush();
    expect(registered).toEqual({ settled: true, value: false });
    expect(unregistered).toEqual({ settled: true, value: false });
    expect(notifier.waiting(SPACE)).toBe(0);
    expect(notifier.waiting(OTHER)).toBe(0);

    // From now on every wait resolves false at once, and nothing is registered or woken.
    const late = track(reading.wait(10_000));
    const fresh = notifier.subscribe(SPACE);
    expect(notifier.waiting(SPACE)).toBe(0);
    const freshWait = track(fresh.wait(10_000));
    notifier.notify(SPACE);
    await flush();
    expect(late).toEqual({ settled: true, value: false });
    expect(freshWait).toEqual({ settled: true, value: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('test_notifier_subscribe_before_read', async () => {
    vi.useFakeTimers();
    const notifier = createSpaceNotifier({ maxWaitersPerSpace: 2 });
    const flush = () => vi.advanceTimersByTimeAsync(0);

    // A notify between subscribe and wait is kept: the wait resolves true at once.
    const sub = notifier.subscribe(SPACE);
    notifier.notify(SPACE);
    expect(notifier.waiting(SPACE)).toBe(1);
    const woken = track(sub.wait(10_000));
    await flush();
    expect(woken).toEqual({ settled: true, value: true });
    expect(notifier.waiting(SPACE)).toBe(0);
    sub.cancel();

    // Cancelled before its wait: unregistered at once (twice is fine), and no later notify reaches it.
    const cancelled = notifier.subscribe(SPACE);
    expect(notifier.waiting(SPACE)).toBe(1);
    cancelled.cancel();
    cancelled.cancel();
    expect(notifier.waiting(SPACE)).toBe(0);
    notifier.notify(SPACE);
    const late = track(cancelled.wait(10_000));
    await flush();
    expect(late).toEqual({ settled: true, value: false });

    // Cancelling frees its place in a full space.
    const a = notifier.subscribe(SPACE);
    const b = notifier.subscribe(SPACE);
    a.cancel();
    const c = track(notifier.wait(SPACE, 10_000));
    expect(notifier.waiting(SPACE)).toBe(2);
    notifier.notify(SPACE);
    await flush();
    expect(c.value).toBe(true);
    b.cancel();
    expect(notifier.waiting(SPACE)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('privacy and CORS', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_sync_logs_hold_no_content', async () => {
    let readOnly = false;
    const t = await syncApp({
      syncAccess: (space, who) => {
        const access = userSpaceAccess(space, who);
        return access && readOnly ? 'read' : access;
      },
    });
    const toms = await spaceOf(t, t.laptop);
    const anas = await spaceOf(t, t.ana);
    const MARKER_KEY = 'interests.more.marker-7f3a1c';
    const MARKER_VALUE = 'Marker-label-9d3e05';
    const items = [live(MARKER_KEY, topic(MARKER_VALUE)), live('display.mode', 'collapse')];

    // A round trip, woken from a long-poll.
    const waiting = changes(t, t.desktop, since(toms, 0, WAIT_S));
    const pushId = randomUUID();
    expect((await push(t, t.laptop, pushBody(toms, items, pushId))).status).toBe(200);
    expect(SyncChangesResponseSchema.parse(await (await waiting).json()).items).toHaveLength(2);
    // A retry, and a stale write.
    expect((await push(t, t.laptop, pushBody(toms, items, pushId))).status).toBe(200);
    const older = live('display.mode', 'dim', stamp(120_000));
    expect((await push(t, t.desktop, pushBody(toms, [older]))).status).toBe(200);
    // Refusals: another account, another epoch, read-only and over quota.
    expect((await changes(t, t.ana, since(toms, 0))).status).toBe(404);
    expect((await push(t, t.ana, pushBody(toms, items))).status).toBe(404);
    expect((await changes(t, t.laptop, { ...since(toms, 0), epoch: randomUUID() })).status).toBe(410);
    readOnly = true;
    expect((await push(t, t.laptop, pushBody(toms, items))).status).toBe(403);
    readOnly = false;
    await t.deps.db.db.update(syncSpaces).set({ itemCount: SYNC_SPACE_MAX_ITEMS }).where(eq(syncSpaces.id, toms.id));
    expect((await push(t, t.laptop, pushBody(toms, [live('interests.more.other-2b9c', topic('Other'))]))).status).toBe(413);

    // Counts and reasons only.
    const pushes = t.events().filter((e) => e.event === 'sync.push');
    expect(pushes.map(({ t: _t, rid, ...rest }) => ({ ...rest, rid: typeof rid }))).toEqual([
      { level: 'info', event: 'sync.push', rid: 'string', applied: 2, stale: 0, rejected: 0, replayed: false },
      { level: 'info', event: 'sync.push', rid: 'string', applied: 0, stale: 0, rejected: 0, replayed: true },
      { level: 'info', event: 'sync.push', rid: 'string', applied: 0, stale: 1, rejected: 0, replayed: false },
    ]);
    const resync = t.events().filter((e) => e.event === 'sync.resync');
    expect(resync.map(({ t: _t, rid: _rid, ...rest }) => rest)).toEqual([
      { level: 'info', event: 'sync.resync', reason: 'epoch' },
    ]);
    expect(t.events().filter((e) => e.event === 'sync.quota')).toHaveLength(1);

    const hlcs = [...items, older].map((i) => i.hlc);
    const secrets = [toms.id, anas.id, MARKER_KEY, 'marker-7f3a1c', MARKER_VALUE, 'collapse', ...hlcs];
    expect(t.lines.length).toBeGreaterThan(0);
    for (const secret of secrets) expect(t.lines.filter((line) => line.includes(secret))).toEqual([]);
  });

  it('test_sync_cors_preflight', async () => {
    const t = await createTestApp();
    cleanup.push(t.close);
    for (const [path, method] of [
      [SYNC_PUSH_PATH, 'POST'],
      [SYNC_CHANGES_PATH, 'GET'],
      [SYNC_SPACES_PATH, 'GET'],
    ] as const) {
      const res = await t.app.request(path, {
        method: 'OPTIONS',
        headers: {
          Origin: DEV_EXTENSION_ORIGIN,
          'Access-Control-Request-Method': method,
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe(DEV_EXTENSION_ORIGIN);
      expect(res.headers.get('access-control-allow-methods')).toContain(method);
      expect(res.headers.get('access-control-allow-headers')).toBe('authorization,content-type');
    }
    // The answers carry it too, so the extension can read a refusal.
    const refused = await t.app.request(SYNC_SPACES_PATH, { headers: { Origin: DEV_EXTENSION_ORIGIN } });
    expect(refused.status).toBe(401);
    expect(refused.headers.get('access-control-allow-origin')).toBe(DEV_EXTENSION_ORIGIN);
  });
});
