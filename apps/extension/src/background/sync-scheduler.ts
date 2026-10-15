import { SYNC_MAX_WAIT_SECONDS } from '@unalgorithm/protocol';
import { changedItems } from '@unalgorithm/sync';
import { browser } from 'wxt/browser';
import { FEED_TAB_URLS } from '../lib/feed-hosts.ts';
import type { SyncStatus } from '../lib/messages.ts';
import { serverLabel } from '../lib/server-label.ts';
import {
  DEFAULT_SYNC_STATE,
  readSettings,
  type SyncProblem,
  type SyncState,
  settingsClocksItem,
  syncStateItem,
} from '../lib/storage.ts';
import { discoverServer, serverAccountItem } from './server-auth.ts';
import { type SyncOutcome, syncOnce } from './sync-client.ts';

/**
 * When settings sync runs (R15, CL3-20): right after a local edit (2-second debounce), as soon as another device pushes
 * (back-to-back long-polls while a feed tab or an extension page is open), every 30 seconds otherwise (an alarm), and
 * when the service worker wakes. Every `syncOnce` goes through one runner, so two runs never read-modify-write
 * `local:syncState` or push the same items at the same time. Sync is off until the person turns it on.
 */

export const SYNC_ALARM = 'ua-sync';
/** Chrome's minimum alarm period. */
const ALARM_PERIOD_MINUTES = 0.5;
const EDIT_DEBOUNCE_MS = 2_000;
/** Worker start runs at once when the last sync is older than this. */
const WAKE_STALE_MS = 10_000;
/** Waits after the 1st, 2nd and later problems in a row. */
const BACKOFF_MS = [5_000, 30_000, 60_000] as const;
/** A long-poll answered empty within FAST_ANSWER_MS is followed by FAST_ANSWER_GAP_MS, so the loop never spins. */
const FAST_ANSWER_MS = 1_000;
const FAST_ANSWER_GAP_MS = 2_000;

const PROBLEM_TEXT: Record<SyncProblem, (title: string) => string> = {
  auth: (t) => `Sign in to ${t} again to keep syncing.`,
  network: (t) => `Couldn't reach ${t}. Sync tries again soon.`,
  quota: (t) => `Your synced settings are larger than ${t} allows. Remove some exceptions or interests.`,
  clock: () => "This computer's date or time looks wrong, so sync is paused. Check the clock, then try again.",
  server: (t) => `${t} had a problem. Sync tries again soon.`,
  unavailable: (t) => `${t} doesn't offer sync.`,
};

interface Run {
  promise: Promise<SyncOutcome>;
  longPoll: boolean;
  abort: AbortController;
}

/** The one `syncOnce` in flight. */
let inFlight: Run | null = null;
/** The wait-0 run that starts once an aborted long-poll has returned; callers arriving meanwhile join it. */
let queued: Promise<SyncOutcome> | null = null;
/** Sign-out, the switch: while held, no run starts (a run in flight would write its state back over theirs). */
let holds = 0;
let loop: Promise<void> | null = null;
let debounce: ReturnType<typeof setTimeout> | undefined;

const HELD: SyncOutcome = { ok: false, problem: 'unavailable', aborted: true };
/** The loop's waits; stopping sync cuts them short, so a stopped loop ends at once. */
const sleepers = new Set<() => void>();
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      sleepers.delete(wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    sleepers.add(wake);
  });
const busy = () => queued ?? inFlight?.promise ?? null;

function start(longPoll: boolean): Promise<SyncOutcome> {
  if (holds) return Promise.resolve(HELD);
  const abort = new AbortController();
  const run: Run = { promise: Promise.resolve(HELD), longPoll, abort };
  run.promise = (async () => {
    try {
      return await syncOnce({ waitSeconds: longPoll ? SYNC_MAX_WAIT_SECONDS : 0, signal: abort.signal });
    } catch (err) {
      console.debug('[UnAlgorithm] sync failed', err);
      return { ok: false, problem: 'server' } as const;
    } finally {
      if (inFlight === run) inFlight = null;
    }
  })();
  inFlight = run;
  return run.promise;
}

/** A wait-0 run: joins one in flight, or aborts a waiting long-poll and runs once it has returned. */
function runNow(): Promise<SyncOutcome> {
  if (queued) return queued;
  const current = inFlight;
  if (!current) return start(false);
  if (!current.longPoll) return current.promise;
  current.abort.abort();
  queued = current.promise.then(() => {
    queued = null;
    return start(false);
  });
  return queued;
}

/** Stops every run, waits for it to return, then writes; nothing starts meanwhile. */
async function quiesce(write: () => Promise<void>): Promise<void> {
  holds++;
  try {
    for (const wake of [...sleepers]) wake();
    for (let pending = busy(); pending; pending = busy()) {
      inFlight?.abort.abort();
      await pending;
    }
    await write();
  } finally {
    holds--;
  }
}

const hasLocalEdits = async (st: SyncState) =>
  changedItems(await readSettings(), await settingsClocksItem.getValue(), st.known).items.length > 0;

/** A feed tab or one of the extension's pages (tab, popup, side panel) is open. */
async function activeSurface(): Promise<boolean> {
  const tabs = await browser.tabs.query({ url: FEED_TAB_URLS }).catch(() => []);
  if (tabs.length) return true;
  try {
    // Chrome 116+ (the manifest's minimum is 130).
    return (await browser.runtime.getContexts({ contextTypes: ['TAB', 'POPUP', 'SIDE_PANEL'] })).length > 0;
  } catch {
    return false;
  }
}

/**
 * Long-polls back to back while sync is on, the account is signed in and someone is using a feed or the extension.
 * Each answer writes `local:syncState`, an extension API call that keeps the worker alive while it is in use. With
 * nobody left, the loop stops; the alarm keeps the 30-second rhythm and starts it again.
 */
async function longPollLoop(): Promise<void> {
  let problems = 0;
  for (;;) {
    if (holds) return;
    const st = await syncStateItem.getValue();
    const account = await serverAccountItem.getValue();
    if (!st.enabled || !account || account.needsSignIn || !(await activeSurface())) return;
    const pending = busy();
    if (pending) {
      await pending;
      continue;
    }
    // An edit landed after the last push: this run pushes it without waiting.
    const longPoll = !(await hasLocalEdits(st));
    if (holds || busy()) continue;
    const startedAt = Date.now();
    const outcome = await start(longPoll);
    if (outcome.ok) {
      problems = 0;
      const empty = outcome.pulled === 0 && outcome.pushed === 0;
      if (longPoll && empty && Date.now() - startedAt < FAST_ANSWER_MS) await sleep(FAST_ANSWER_GAP_MS);
    } else if (!outcome.aborted) {
      await sleep(BACKOFF_MS[Math.min(problems, BACKOFF_MS.length - 1)] ?? 60_000);
      problems++;
    }
    // Aborted by this scheduler (a trigger, the switch): straight back, no backoff.
  }
}

function ensureLongPoll(): void {
  if (loop) return;
  loop = longPollLoop()
    .catch((err: unknown) => console.debug('[UnAlgorithm] sync loop stopped', err))
    .finally(() => {
      loop = null;
    });
}

async function createAlarm(): Promise<void> {
  await browser.alarms?.create(SYNC_ALARM, { periodInMinutes: ALARM_PERIOD_MINUTES });
}

async function clearAlarm(): Promise<void> {
  await browser.alarms?.clear(SYNC_ALARM);
}

export async function syncStatus(): Promise<SyncStatus> {
  const [account, st] = await Promise.all([serverAccountItem.getValue(), syncStateItem.getValue()]);
  if (!account) return { available: false, enabled: false, state: 'off', lastSyncAt: st.lastSyncAt };
  const syncing = !!queued || (!!inFlight && !inFlight.longPoll);
  const problem = st.problem ?? undefined;
  let state: SyncStatus['state'] = st.enabled ? 'ok' : 'off';
  if (problem) state = 'problem';
  // A waiting long-poll is not syncing; a wait-0 run is.
  if (st.enabled && syncing) state = 'syncing';
  return {
    available: true,
    enabled: st.enabled,
    state,
    lastSyncAt: st.lastSyncAt,
    ...(problem ? { problem, message: PROBLEM_TEXT[problem](serverLabel(account.origin).title) } : {}),
  };
}

/** One sync now (single-flight), then the long-poll loop when it can run. */
export async function runSync(): Promise<SyncStatus> {
  if ((await syncStateItem.getValue()).enabled) {
    await runNow();
    ensureLongPoll();
  }
  return syncStatus();
}

/** The switch. Turning it on checks that the server offers sync; turning it off leaves local settings as they are. */
export async function setSyncEnabled(enabled: boolean): Promise<SyncStatus> {
  if (!enabled) {
    await quiesce(async () => {
      await clearAlarm();
      await syncStateItem.setValue({ ...(await syncStateItem.getValue()), enabled: false, problem: null });
    });
    return syncStatus();
  }
  const account = await serverAccountItem.getValue();
  if (!account) return syncStatus();
  const found = await discoverServer(account.origin);
  const offered = found.ok && found.info.capabilities.sync === true;
  await quiesce(async () => {
    const st = await syncStateItem.getValue();
    // The state, and the consent behind it, belong to one server and one account.
    const base: SyncState =
      st.origin === account.origin && st.email === account.email
        ? st
        : { ...DEFAULT_SYNC_STATE, known: {}, origin: account.origin, email: account.email };
    if (!offered) {
      await clearAlarm();
      await syncStateItem.setValue({ ...base, enabled: false, problem: 'unavailable' });
      return;
    }
    // Turning sync on lets the server's copy win on the first pull (CL3-19).
    await syncStateItem.setValue({ ...base, enabled: true, problem: null, firstPull: base.enabled ? base.firstPull : true });
  });
  if (!offered) return syncStatus();
  await createAlarm();
  return runSync();
}

/** After a sign-out or "Erase everything": sync is off again until the person turns it on. */
export async function resetSync(): Promise<void> {
  clearTimeout(debounce);
  await quiesce(async () => {
    await clearAlarm();
    await syncStateItem.setValue({ ...DEFAULT_SYNC_STATE, known: {} });
  });
}

/** Called synchronously at the top of `defineBackground`, so the alarm and storage listeners wake the worker. */
export function initSync(): void {
  const log = (err: unknown) => console.debug('[UnAlgorithm] sync', err);
  browser.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM) runSync().catch(log);
  });

  // A remote apply saves `known` before the clocks (CL3-19), so it leaves nothing to push and starts no run.
  settingsClocksItem.watch(() => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      void (async () => {
        const st = await syncStateItem.getValue();
        if (st.enabled && (await hasLocalEdits(st))) await runSync();
      })().catch(log);
    }, EDIT_DEBOUNCE_MS);
  });

  void (async () => {
    const st = await syncStateItem.getValue();
    if (!st.enabled) return;
    // Chrome clears alarms when the extension updates and may on a browser restart.
    if (browser.alarms && !(await browser.alarms.get(SYNC_ALARM))) await createAlarm();
    if (st.lastSyncAt === null || Date.now() - st.lastSyncAt > WAKE_STALE_MS) await runSync();
    else ensureLongPoll();
  })().catch(log);
}
