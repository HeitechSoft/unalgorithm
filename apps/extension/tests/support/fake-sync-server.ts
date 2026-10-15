/**
 * A sync server in memory for the extension's sync tests (CL3-19, CL3-20), behind a `fetch` the tests inject or stub.
 * One personal space, decided with `@unalgorithm/sync` and parsed with the protocol schemas: changes pages with `more`
 * and a cursor (tombstones included from `since = 0`, as CL3-06 answers), `410` for another epoch or a cursor ahead of
 * the server, `404 not-found` for another space, pushes idempotent per `pushId`, `clock-ahead` for stamps too far past
 * `now()`. Tests script failures with `failNext` and per-key refusals with `reject`; every request is recorded.
 */
import {
  HLC_ZERO,
  hlcMs,
  SYNC_CHANGES_PATH,
  SYNC_MAX_HLC_AHEAD_MS,
  SYNC_PUSH_PATH,
  SYNC_SPACES_PATH,
  SyncChangesQuerySchema,
  type SyncChangesResponse,
  type SyncItem,
  SyncPushRequestSchema,
  type SyncPushResponse,
  type SyncPushResult,
  type SyncRejectReason,
  uuid,
} from '@unalgorithm/protocol';
import { containsCredential, decide, validateSettingsItem } from '@unalgorithm/sync';

export interface FakeSyncCall {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  /** The parsed JSON body of a POST. */
  body: unknown;
  /** The raw body text of a POST. */
  rawBody: string | null;
  authorization: string | null;
}

export type FakeAnswer = { status: number; body?: unknown } | 'network';

export interface FakeSyncServerOptions {
  /** The server's clock for `clock-ahead` (default `Date.now`). */
  now?: () => number;
  /** Items per changes page, under the client's `limit`. */
  pageSize?: number;
  /** A server without sync: every sync path answers 404. */
  noSync?: boolean;
}

interface Stored {
  item: SyncItem;
  seq: number;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const syncError = (code: string, status: number) => json({ code, message: 'refused' }, status);

export function createFakeSyncServer(opts: FakeSyncServerOptions = {}) {
  const now = opts.now ?? (() => Date.now());
  let spaceId = uuid();
  let epoch = uuid();
  let seq = 0;
  let gcFloorHlc = HLC_ZERO;
  let items = new Map<string, Stored>();
  const pushAnswers = new Map<string, SyncPushResponse>();
  const scripted: { path: string; answer: FakeAnswer }[] = [];
  const refusals = new Map<string, SyncRejectReason>();
  const calls: FakeSyncCall[] = [];

  /** Writes an item as another device's push would. */
  function put(item: SyncItem): number {
    seq++;
    items.set(item.key, { item, seq });
    return seq;
  }

  function changes(query: Record<string, string>): Response {
    const q = SyncChangesQuerySchema.safeParse(query);
    if (!q.success) return json({ code: 'invalid-request', message: 'bad query' }, 400);
    if (q.data.spaceId !== spaceId) return syncError('not-found', 404);
    if (q.data.epoch !== epoch || q.data.since > seq) return syncError('resync-required', 410);
    const limit = Math.min(q.data.limit, opts.pageSize ?? q.data.limit);
    const after = [...items.values()].filter((s) => s.seq > q.data.since).sort((a, b) => a.seq - b.seq);
    const page = after.slice(0, limit);
    const more = after.length > limit;
    const answer: SyncChangesResponse = {
      v: 1,
      spaceId,
      epoch,
      cursor: more ? (page.at(-1)?.seq ?? seq) : seq,
      more,
      gcFloorHlc,
      items: page.map((s) => ({ ...s.item, seq: s.seq })),
    };
    return json(answer);
  }

  function push(body: unknown): Response {
    const req = SyncPushRequestSchema.safeParse(body);
    if (!req.success) return json({ code: 'invalid-request', message: 'bad push' }, 400);
    if (req.data.spaceId !== spaceId) return syncError('not-found', 404);
    if (req.data.epoch !== epoch) return syncError('resync-required', 410);
    const repeat = pushAnswers.get(req.data.pushId);
    if (repeat) return json(repeat);
    const results = req.data.items.map((item): SyncPushResult => {
      const { collection, key } = item;
      const refused = refusals.get(key);
      if (refused) return { collection, key, status: 'rejected', reason: refused };
      if (!validateSettingsItem(item)) return { collection, key, status: 'rejected', reason: 'invalid' };
      if (containsCredential(key.split('.')) || (!item.deleted && containsCredential(item.value))) {
        return { collection, key, status: 'rejected', reason: 'credential' };
      }
      if (hlcMs(item.hlc) > now() + SYNC_MAX_HLC_AHEAD_MS) {
        return { collection, key, status: 'rejected', reason: 'clock-ahead' };
      }
      const stored = items.get(key);
      const decision = decide(
        'lww-map',
        stored && { hlc: stored.item.hlc, deleted: stored.item.deleted, deviceId: null, expiresAt: null },
        item,
        { deviceId: 'device', now: now() },
      );
      if (decision.kind !== 'write') return { collection, key, status: 'stale' };
      return { collection, key, status: 'applied', seq: put(item) };
    });
    const answer: SyncPushResponse = { v: 1, results };
    pushAnswers.set(req.data.pushId, answer);
    return json(answer);
  }

  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const rawBody = typeof init.body === 'string' ? init.body : null;
    const call: FakeSyncCall = {
      method: init.method ?? 'GET',
      url: url.href,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: rawBody === null ? undefined : JSON.parse(rawBody),
      rawBody,
      authorization: new Headers(init.headers).get('authorization'),
    };
    calls.push(call);
    if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const i = scripted.findIndex((s) => s.path === call.path);
    const answer = i >= 0 ? scripted.splice(i, 1)[0]?.answer : undefined;
    if (answer) {
      if (answer === 'network') throw new TypeError('Failed to fetch');
      return answer.status === 401 && answer.body === undefined
        ? new Response(null, { status: 401 })
        : json(answer.body ?? null, answer.status);
    }
    if (opts.noSync) return json({ code: 'not-found', message: 'no route' }, 404);
    if (call.path === SYNC_SPACES_PATH) {
      return json({ v: 1, spaces: [{ id: spaceId, kind: 'user', access: 'read-write', epoch }] });
    }
    if (call.path === SYNC_CHANGES_PATH) return changes(call.query);
    if (call.path === SYNC_PUSH_PATH && call.method === 'POST') return push(call.body);
    return json({ code: 'not-found', message: 'no route' }, 404);
  };

  return {
    fetch: fetch as typeof globalThis.fetch,
    calls,
    put,
    /** The next `times` requests to `path` get `answer` instead (a status and body, or a network failure). */
    failNext(path: string, answer: FakeAnswer, times = 1) {
      for (let n = 0; n < times; n++) scripted.push({ path, answer });
    },
    /** Every push of `key` is refused with `reason` (`undefined` stops refusing it). */
    reject(key: string, reason: SyncRejectReason | undefined) {
      if (reason) refusals.set(key, reason);
      else refusals.delete(key);
    },
    /** The space starts over (a restore): a new epoch, the items kept, `gcFloorHlc` as given. */
    newEpoch(floor: string = HLC_ZERO) {
      epoch = uuid();
      gcFloorHlc = floor;
    },
    /** The account was deleted and created again: another space, empty. The old one answers 404. */
    replaceSpace() {
      spaceId = uuid();
      epoch = uuid();
      seq = 0;
      gcFloorHlc = HLC_ZERO;
      items = new Map();
    },
    get spaceId() {
      return spaceId;
    },
    get epoch() {
      return epoch;
    },
    get cursor() {
      return seq;
    },
    /** What the server holds for `key`. */
    item(key: string): SyncItem | undefined {
      return items.get(key)?.item;
    },
    /** Every changes request so far. */
    changesCalls: () => calls.filter((c) => c.path === SYNC_CHANGES_PATH),
    /** The bodies of every push request so far. */
    pushBodies: () => calls.filter((c) => c.path === SYNC_PUSH_PATH).map((c) => c.body as { pushId: string; items: SyncItem[] }),
  };
}

export type FakeSyncServer = ReturnType<typeof createFakeSyncServer>;
