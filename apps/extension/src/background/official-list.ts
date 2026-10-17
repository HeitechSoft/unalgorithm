/**
 * UnAlgorithm Cloud's published source list (decision D98): every extension reads it for UnEcho Chamber, whatever its AI
 * source, and only while UnEcho Chamber is on. At most one request a day, counted from the last request whether it was
 * answered or not; anonymous (no cookie, no referrer, no header but Accept, nothing about the person); and a copy is
 * kept only when it passes the schema and the list rules, so any failure keeps the last good copy. E2E builds use the
 * fixture (`storedOfficialList`) and never reach the real Cloud. No host permission: the Cloud answers CORS for any
 * origin (D96).
 */
import { createLock, type Device } from '@unalgorithm/core';
import { CLOUD_ORIGIN, OUTLETS_JSON_PATH } from '@unalgorithm/protocol';
import { validOfficialList } from '../lib/outlets.ts';
import { officialListItem, readDevice, watchDevice } from '../lib/storage.ts';
import { readBoundedJson } from './bounded-body.ts';

export const OFFICIAL_LIST_URL = `${CLOUD_ORIGIN}${OUTLETS_JSON_PATH}`;
export const OFFICIAL_LIST_EVERY_MS = 24 * 60 * 60_000;
export const MAX_OFFICIAL_LIST_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15_000;

export interface OfficialListDeps {
  fetch: typeof fetch;
  now: () => number;
  device: () => Promise<Device>;
}

const withLock = createLock();

/**
 * Asks for the Cloud's list when UnEcho Chamber is on and the last request is at least a day old. Keeps the stored copy
 * on any failure. Never throws; logs nothing about the list or the answer.
 */
export async function refreshOfficialList(deps: Partial<OfficialListDeps> = {}): Promise<'skipped' | 'updated' | 'kept'> {
  if (import.meta.env.MODE === 'e2e') return 'skipped';
  const d: OfficialListDeps = {
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    device: readDevice,
    ...deps,
  };
  // One at a time: a second wake waits, then finds this request's `checkedAt` and skips.
  return withLock(async () => {
    try {
      if (!(await d.device()).labs.perspectives) return 'skipped';
      const stored = await officialListItem.getValue();
      const now = d.now();
      // A last request more than a day in the future (a clock set wrong, then put right) doesn't hold the list back.
      if (Math.abs(now - (Number(stored?.checkedAt) || 0)) < OFFICIAL_LIST_EVERY_MS) return 'skipped';
      const list = stored?.list ?? null;
      // Before the request: a crash, a failure or a second wake within the day never asks again.
      await officialListItem.setValue({ list, checkedAt: now });
      const res = await d.fetch(OFFICIAL_LIST_URL, {
        method: 'GET',
        // No cookie: the Cloud's account page keeps a session cookie on the same host, and it stays off this request.
        credentials: 'omit',
        // Revalidates with the ETag the Cloud sent, so an unchanged list costs a 304 and no body.
        cache: 'no-cache',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        return 'kept';
      }
      const fresh = validOfficialList(await readBoundedJson(res, MAX_OFFICIAL_LIST_BYTES));
      if (!fresh) return 'kept';
      // A valid list replaces the last one, with or without leans: it is what the Cloud publishes now.
      await officialListItem.setValue({ list: fresh, checkedAt: now });
      return 'updated';
    } catch {
      // Network error, timeout, a refused redirect or storage: the stored copy stays as it was.
      return 'kept';
    }
  });
}

/**
 * At start (each service-worker start) and whenever UnEcho Chamber is turned on. Returns the function that stops
 * watching (tests).
 */
export function startOfficialListUpdates(): () => void {
  void refreshOfficialList();
  return watchDevice((device, previous) => {
    if (device.labs.perspectives && !previous?.labs.perspectives) void refreshOfficialList();
  });
}
