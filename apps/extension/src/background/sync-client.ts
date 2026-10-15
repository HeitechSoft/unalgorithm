import {
  hlcMs,
  SYNC_CHANGES_PATH,
  SYNC_MAX_HLC_AHEAD_MS,
  SYNC_MAX_ITEM_BYTES,
  SYNC_MAX_PUSH_BYTES,
  SYNC_MAX_PUSH_ITEMS,
  SYNC_PULL_LIMIT,
  SYNC_PUSH_PATH,
  SYNC_SPACES_PATH,
  SyncChangesResponseSchema,
  SyncErrorSchema,
  type SyncItem,
  SyncPushResponseSchema,
  SyncSpacesResponseSchema,
  uuid,
} from '@unalgorithm/protocol';
import { applyRemoteItems, changedItems, dropAfterResync } from '@unalgorithm/sync';
import { applyRemoteSettings, restampFutureClocks } from '../lib/settings-store.ts';
import {
  DEFAULT_SYNC_STATE,
  lastHlcItem,
  readSettings,
  type SyncProblem,
  type SyncState,
  settingsClocksItem,
  syncStateItem,
} from '../lib/storage.ts';
import { serverAccountItem } from './server-auth.ts';
import { type ServerHttpDeps, serverRequest } from './server-http.ts';

/**
 * Settings sync, one run (R15 to R17): pull the space's changes since the cursor and fold them into `local:settings`
 * field by field without stamping them again (echo suppression), push the fields edited here, and start over from the
 * server's copy after `410 resync-required`. It reads only `local:settings` and its clocks: API keys, endpoint tokens
 * and the refresh token (IndexedDB), device state, learned topics and votes never reach a payload, and the access token
 * travels only in the `Authorization` header (`serverRequest`). Scheduling and the on/off switch are CL3-20's.
 */

export interface SyncDeps extends ServerHttpDeps {
  now: () => number;
  uuid: () => string;
}

export type SyncOutcome =
  | { ok: true; pulled: number; pushed: number }
  | {
      ok: false;
      problem: SyncProblem;
      /** The caller's own signal fired (CL3-20 restarts at once, no backoff). */
      aborted?: true;
    };

/** Ends the run with a problem (`aborted`: the caller's signal fired, nothing is saved). */
class Stop {
  constructor(
    readonly problem: SyncProblem,
    readonly aborted = false,
  ) {}
}
/** 410 resync-required: start over from the server's copy. */
class Resync {}
/** 404 not-found on changes or push: the space is gone or not this account's. */
class Gone {}

const BASE_TIMEOUT_MS = 30_000;
/** A full page of changes: every item at its largest, plus room for keys, clocks and the envelope. */
export const PULL_MAX_BYTES = SYNC_PULL_LIMIT * (SYNC_MAX_ITEM_BYTES + 1024) + 64 * 1024;
const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

/** Runs one sync for the signed-in account. Never rejects for a server or network failure. */
export async function syncOnce(
  opts: { waitSeconds?: number; signal?: AbortSignal } = {},
  deps: Partial<SyncDeps> = {},
): Promise<SyncOutcome> {
  const { now, uuid: newId, ...http } = { now: Date.now, uuid, ...deps };
  const account = await serverAccountItem.getValue();
  const stored = await syncStateItem.getValue();
  if (!stored.enabled || !account) return { ok: false, problem: 'unavailable' };
  const st: SyncState = structuredClone(stored);
  const save = () => syncStateItem.setValue(structuredClone(st));
  if (account.needsSignIn) {
    st.problem = 'auth';
    await save();
    return { ok: false, problem: 'auth' };
  }
  // The state, and the consent behind it, belong to one server and one account.
  if (st.origin !== account.origin || st.email !== account.email) {
    await syncStateItem.setValue({ ...DEFAULT_SYNC_STATE, known: {}, origin: account.origin, email: account.email });
    return { ok: false, problem: 'unavailable' };
  }
  const { origin } = account;

  /** A fast clock stamped edits the server refuses; once the clock is right again, they get stamps it accepts. */
  const recoverClock = async () => {
    const last = await lastHlcItem.getValue();
    if (last && hlcMs(last) > now() + SYNC_MAX_HLC_AHEAD_MS) await restampFutureClocks(now());
  };

  /** One request; anything but a 2xx answer is thrown as the step it leads to. */
  const call = async (
    path: string,
    init: { query?: Record<string, string>; body?: unknown; wait?: number; maxBytes?: number },
  ): Promise<unknown> => {
    const r = await serverRequest(
      origin,
      path,
      {
        method: init.body === undefined ? 'GET' : 'POST',
        query: init.query,
        body: init.body,
        timeoutMs: BASE_TIMEOUT_MS + (init.wait ?? 0) * 1000,
        signal: opts.signal,
        maxBytes: init.maxBytes,
      },
      http,
    );
    if (r.ok) return r.body;
    if ('reason' in r) throw r.reason === 'aborted' ? new Stop('network', true) : new Stop(r.reason);
    const code = SyncErrorSchema.safeParse(r.body).data?.code;
    if (r.status === 410) throw new Resync();
    if (r.status === 404 && path === SYNC_SPACES_PATH) throw new Stop('unavailable');
    if (r.status === 404 && code === 'not-found') throw new Gone();
    if (r.status === 413 && code === 'quota-exceeded') throw new Stop('quota');
    throw new Stop('server');
  };

  const fetchSpace = async () => {
    const parsed = SyncSpacesResponseSchema.safeParse(await call(SYNC_SPACES_PATH, {}));
    const space = parsed.data?.spaces.find((s) => s.kind === 'user');
    if (!space) throw new Stop('server');
    Object.assign(st, { spaceId: space.id, epoch: space.epoch, cursor: 0, known: {} });
    await save();
  };

  let pulled = 0;
  let pushed = 0;
  /** The long-poll wait goes with the run's first changes request only. */
  let wait = opts.waitSeconds ?? 0;

  /** Pages of changes until `more` is false; returns every key received and the floor, for a resync. */
  const pull = async () => {
    const serverKeys = new Set<string>();
    let gcFloorHlc = '';
    const fromZero = st.cursor === 0;
    for (;;) {
      const since = st.cursor;
      const query = {
        spaceId: st.spaceId ?? '',
        epoch: st.epoch ?? '',
        since: String(since),
        limit: String(SYNC_PULL_LIMIT),
        wait: String(wait),
        snapshot: fromZero && since > 0 ? '1' : '0',
      };
      const body = await call(SYNC_CHANGES_PATH, { query, wait, maxBytes: PULL_MAX_BYTES });
      wait = 0;
      const page = SyncChangesResponseSchema.safeParse(body).data;
      // A page that does not move the cursor forward would page forever.
      if (!page || (page.more && page.cursor <= since)) throw new Stop('server');
      const items: SyncItem[] = page.items.map(({ seq: _seq, ...item }) => item);
      // The server holds these HLCs: saved before the clocks change, so a clocks watcher never sees a local edit.
      for (const item of items) {
        st.known[item.key] = item.hlc;
        serverKeys.add(item.key);
      }
      await save();
      await applyRemoteSettings((s, c) => {
        const r = applyRemoteItems(s, c, items, { preferRemote: st.firstPull });
        return r.ok && r.applied.length ? r : null;
      });
      pulled += items.length;
      gcFloorHlc = page.gcFloorHlc;
      // The cursor moves only after the apply: a crash in between pulls the page again.
      st.cursor = page.cursor;
      if (!page.more) st.firstPull = false;
      await save();
      if (!page.more) return { serverKeys, gcFloorHlc };
    }
  };

  /** Pushes every item newer than what the server holds; says whether any came back stale or clock-ahead. */
  const push = async () => {
    const { items, withheld } = changedItems(await readSettings(), await settingsClocksItem.getValue(), st.known);
    if (withheld.length) console.debug('[UnAlgorithm] sync withheld', withheld.length);
    let stale = false;
    let clockAhead = false;
    let rejected = 0;
    // Requests of at most SYNC_MAX_PUSH_ITEMS items and SYNC_MAX_PUSH_BYTES of JSON (a pushId is a 36-character uuid).
    const overhead = bytes({ v: 1, spaceId: st.spaceId, epoch: st.epoch, pushId: '0'.repeat(36), items: [] });
    const chunks: SyncItem[][] = [];
    let size = 0;
    for (const item of items) {
      const add = bytes(item) + 1;
      const last = chunks.at(-1);
      if (last && last.length < SYNC_MAX_PUSH_ITEMS && size + add <= SYNC_MAX_PUSH_BYTES) {
        last.push(item);
        size += add;
      } else {
        chunks.push([item]);
        size = overhead + add;
      }
    }
    for (const chunk of chunks) {
      const body = { v: 1, spaceId: st.spaceId, epoch: st.epoch, pushId: newId(), items: chunk };
      let answer: unknown;
      try {
        answer = await call(SYNC_PUSH_PATH, { body });
      } catch (err) {
        // Same pushId: the server answers a repeat with its first answer.
        if (!(err instanceof Stop) || err.problem !== 'network' || err.aborted) throw err;
        answer = await call(SYNC_PUSH_PATH, { body });
      }
      const results = SyncPushResponseSchema.safeParse(answer).data?.results;
      if (!results) throw new Stop('server');
      const sent = new Map(chunk.map((item) => [item.key, item]));
      for (const result of results) {
        const item = sent.get(result.key);
        if (!item) continue;
        if (result.status === 'applied') {
          st.known[item.key] = item.hlc;
          pushed++;
        } else if (result.status === 'stale') {
          stale = true;
        } else if (result.reason === 'clock-ahead') {
          clockAhead = true;
        } else {
          // Refused for good: never sent again.
          st.known[item.key] = item.hlc;
          rejected++;
        }
      }
      await save();
    }
    if (rejected) console.debug('[UnAlgorithm] sync rejected', rejected);
    return { stale, clockAhead };
  };

  try {
    await recoverClock();
    let resyncing = false;
    let refetched = false;
    for (;;) {
      try {
        if (resyncing || !st.spaceId) await fetchSpace();
        const { serverKeys, gcFloorHlc } = await pull();
        if (resyncing) {
          await applyRemoteSettings((s, c) => {
            const r = dropAfterResync(s, c, serverKeys, gcFloorHlc);
            return r.dropped.length ? { ...r, maxHlc: null } : null;
          });
        }
        const { stale, clockAhead } = await push();
        // Another device pushed between this run's pull and its push: that change is picked up now.
        if (stale) await pull();
        if (clockAhead) {
          await recoverClock();
          throw new Stop('clock');
        }
        break;
      } catch (err) {
        if (err instanceof Resync && !resyncing) {
          resyncing = true;
        } else if (err instanceof Gone && !refetched) {
          refetched = true;
          Object.assign(st, { spaceId: null, epoch: null, cursor: 0, known: {} });
          await save();
        } else if (err instanceof Resync || err instanceof Gone) {
          throw new Stop('server');
        } else {
          throw err;
        }
      }
    }
  } catch (err) {
    if (!(err instanceof Stop)) throw err;
    if (err.aborted) return { ok: false, problem: 'network', aborted: true };
    st.problem = err.problem;
    await save();
    return { ok: false, problem: err.problem };
  }
  st.lastSyncAt = now();
  st.problem = null;
  await save();
  return { ok: true, pulled, pushed };
}
