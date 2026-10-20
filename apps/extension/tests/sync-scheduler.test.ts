/**
 * When settings sync runs (CL3-20): the three sync messages and their sender check, the switch and its discovery check,
 * the debounced push after a local edit, the long-poll loop while a feed or an extension page is open, its backoff, the
 * alarm, single-flight runs, and the clean-up on sign-out and "Erase everything". `syncOnce` is a stand-in that honours
 * its abort signal (`sync-scheduler-remote.test.ts` runs the real one); extension storage and alarms are the WXT fake
 * browser and timers are fake.
 */
import { defaultDevice, defaultSettings } from '@unalgorithm/core';
import {
  AUTHORIZE_PAGE_PATH,
  formatHlc,
  type ServerInfo,
  SYNC_MAX_WAIT_SECONDS,
  type SyncItem,
  TOKEN_PATH,
} from '@unalgorithm/protocol';
import { applyRemoteItems, changedItems } from '@unalgorithm/sync';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { type ServerAccount, serverAccountItem } from '../src/background/server-auth.ts';
import type { SyncOutcome } from '../src/background/sync-client.ts';
import { initSync, resetSync, runSync, SYNC_ALARM } from '../src/background/sync-scheduler.ts';
import { handlers } from '../src/entrypoints/background.ts';
import { FEED_TAB_URLS } from '../src/lib/feed-hosts.ts';
import { PINNED_CLOUD_ORIGIN } from '../src/lib/server-label.ts';
import { applyRemoteSettings, replaceSettings, updateSettings } from '../src/lib/settings-store.ts';
import {
  DEFAULT_SYNC_STATE,
  deviceItem,
  readSettings,
  type SyncProblem,
  type SyncState,
  settingsClocksItem,
  settingsItem,
  syncStateItem,
} from '../src/lib/storage.ts';
import { manifestFor } from '../wxt.config.ts';

const mocks = vi.hoisted(() => ({ syncOnce: vi.fn(), discoverServer: vi.fn(), signOut: vi.fn() }));
vi.mock('../src/background/sync-client.ts', () => ({ syncOnce: mocks.syncOnce }));
vi.mock('../src/background/server-auth.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/background/server-auth.ts')>()),
  discoverServer: mocks.discoverServer,
  signOut: mocks.signOut,
}));

type Sender = Browser.runtime.MessageSender;

const ORIGIN = 'https://sync.example.org';
const EMAIL = 'ada@example.org';
const NOW = Date.UTC(2026, 9, 14, 9);
const LOCAL = '0199d6a5-7a20-7d41-8c3e-5f9a0b1c2d4e';
const OTHER = '0199d6a4-3f1e-7c2a-9b5d-2e8f4a6c1b3d';
const LINKEDIN = 'https://www.linkedin.com/feed/';
const LONG = SYNC_MAX_WAIT_SECONDS;

const INFO: ServerInfo = {
  v: 1,
  name: 'Example sync server',
  version: '0.3.0',
  source: 'https://github.com/HeitechSoft/unalgorithm',
  billing: false,
  capabilities: { classify: true, sync: true },
  auth: { methods: ['email-otp'], authorizePath: AUTHORIZE_PAGE_PATH, tokenPath: TOKEN_PATH },
  limits: { maxPostsPerRequest: 12 },
};

const account = (over: Partial<ServerAccount> = {}): ServerAccount => ({
  origin: ORIGIN,
  email: EMAIL,
  deviceId: 'server-device-1',
  signedInAt: NOW,
  info: INFO,
  needsSignIn: false,
  ...over,
});
const tab = (id: number, url: string) => ({ id, url }) as Browser.tabs.Tab;
const feedTab = (): Sender => ({ tab: tab(7, LINKEDIN), url: LINKEDIN });
const page = (): Sender => ({
  tab: tab(3, fakeBrowser.runtime.getURL('/options.html')),
  url: fakeBrowser.runtime.getURL('/options.html'),
});
const enabledState = (over: Partial<SyncState> = {}): SyncState => ({
  ...DEFAULT_SYNC_STATE,
  known: {},
  enabled: true,
  origin: ORIGIN,
  email: EMAIL,
  spaceId: 'space-1',
  epoch: 'epoch-1',
  lastSyncAt: NOW,
  ...over,
});

// ---------- the syncOnce stand-in ----------

interface FakeRun {
  wait: number;
  aborted: boolean;
  settled: boolean;
  answer: (outcome: SyncOutcome) => void;
}
const OK_EMPTY: SyncOutcome = { ok: true, pulled: 0, pushed: 0 };
const PULLED: SyncOutcome = { ok: true, pulled: 1, pushed: 0 };
const PROBLEM: SyncOutcome = { ok: false, problem: 'network' };
let runs: FakeRun[] = [];
let active = 0;
let maxActive = 0;
/** Wait-0 runs answer at once, pushing what changed as the real run would; long-polls wait for the test. */
let autoAnswer = true;

/** What a push does to the state: the server now holds every changed item. */
async function pushEverything(): Promise<number> {
  const st = await syncStateItem.getValue();
  const { items } = changedItems(await readSettings(), await settingsClocksItem.getValue(), st.known);
  for (const item of items) st.known[item.key] = item.hlc;
  await syncStateItem.setValue(st);
  return items.length;
}

function fakeSyncOnce(opts: { waitSeconds?: number; signal?: AbortSignal } = {}): Promise<SyncOutcome> {
  return new Promise((resolve) => {
    active++;
    maxActive = Math.max(maxActive, active);
    const run: FakeRun = {
      wait: opts.waitSeconds ?? 0,
      aborted: false,
      settled: false,
      answer: (outcome) => {
        if (run.settled) return;
        run.settled = true;
        active--;
        resolve(outcome);
      },
    };
    runs.push(run);
    opts.signal?.addEventListener('abort', () => {
      run.aborted = true;
      run.answer({ ok: false, problem: 'network', aborted: true });
    });
    if (run.wait === 0 && autoAnswer) void pushEverything().then((pushed) => run.answer({ ok: true, pulled: 0, pushed }));
  });
}

const alarm = () => ({ name: SYNC_ALARM, scheduledTime: Date.now() }) as Browser.alarms.Alarm;
const quickRuns = () => runs.filter((r) => r.wait === 0);
const lastRun = () => {
  const run = runs.at(-1);
  if (!run) throw new Error('no run yet');
  return run;
};

/** Lets storage and the scheduler's promise chains finish (setImmediate is not faked). */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

let feedTabs: Browser.tabs.Tab[] = [];
let pages: Browser.runtime.ExtensionContext[] = [];
const query = () => vi.mocked(fakeBrowser.tabs.query);

beforeEach(async () => {
  fakeBrowser.reset();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOW);
  runs = [];
  active = 0;
  maxActive = 0;
  autoAnswer = true;
  feedTabs = [];
  pages = [];
  mocks.syncOnce.mockReset().mockImplementation(fakeSyncOnce);
  mocks.discoverServer.mockReset().mockResolvedValue({ ok: true, origin: ORIGIN, info: INFO });
  mocks.signOut.mockReset().mockResolvedValue(undefined);
  vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation((async () => feedTabs) as never);
  vi.spyOn(fakeBrowser.runtime, 'getContexts').mockImplementation((async () => pages) as never);
  await deviceItem.setValue(defaultDevice(LOCAL));
});

afterEach(async () => {
  // Stops a loop still waiting, so the next test starts from nothing.
  await resetSync();
  await settle();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('messages', () => {
  it('test_sync_messages_only_from_extension_pages', async () => {
    await serverAccountItem.setValue(account());
    await syncStateItem.setValue(enabledState());
    for (const msg of [{ type: 'syncStatus' }, { type: 'syncSetEnabled', enabled: true }, { type: 'syncNow' }] as const) {
      const handler = handlers[msg.type] as unknown as (m: typeof msg, s: Sender) => Promise<unknown>;
      await expect(handler(msg, feedTab())).rejects.toThrow(`${msg.type} is not accepted from this sender`);
    }
    await settle();
    expect(mocks.syncOnce).not.toHaveBeenCalled();
    expect(mocks.discoverServer).not.toHaveBeenCalled();
    expect(await fakeBrowser.alarms.getAll()).toStrictEqual([]);
  });

  it('test_sync_status_before_sign_in', async () => {
    expect(await handlers.syncStatus({ type: 'syncStatus' }, page())).toStrictEqual({
      available: false,
      enabled: false,
      state: 'off',
      lastSyncAt: null,
    });
  });

  it('test_sync_enable_checks_discovery', async () => {
    await serverAccountItem.setValue(account());
    // A state left from another account is replaced, not reused.
    await syncStateItem.setValue(enabledState({ enabled: false, email: 'someone@example.org', cursor: 9 }));
    const on = await handlers.syncSetEnabled({ type: 'syncSetEnabled', enabled: true }, page());
    expect(mocks.discoverServer).toHaveBeenCalledExactlyOnceWith(ORIGIN);
    expect(on).toMatchObject({ available: true, enabled: true, state: 'ok' });
    expect(await syncStateItem.getValue()).toMatchObject({
      enabled: true,
      origin: ORIGIN,
      email: EMAIL,
      firstPull: true,
      cursor: 0,
      problem: null,
    });
    expect(await fakeBrowser.alarms.get(SYNC_ALARM)).toMatchObject({ name: 'ua-sync', periodInMinutes: 0.5 });
    expect(runs.map((r) => r.wait)).toStrictEqual([0]);

    // Turning it on again while on leaves the first-pull flag as the first pull left it.
    await syncStateItem.setValue({ ...(await syncStateItem.getValue()), firstPull: false });
    await handlers.syncSetEnabled({ type: 'syncSetEnabled', enabled: true }, page());
    expect(await syncStateItem.getValue()).toMatchObject({ enabled: true, firstPull: false });

    // Off: the alarm goes, local settings stay.
    await updateSettings((s) => {
      s.display.showAuthor = false;
    });
    const off = await handlers.syncSetEnabled({ type: 'syncSetEnabled', enabled: false }, page());
    expect(off).toMatchObject({ enabled: false, state: 'off' });
    expect(await fakeBrowser.alarms.get(SYNC_ALARM)).toBeUndefined();
    expect((await readSettings()).display.showAuthor).toBe(false);

    // A server without sync, or one that can't be reached: sync stays off.
    for (const found of [
      { ok: true, origin: ORIGIN, info: { ...INFO, capabilities: { classify: true, sync: false } } },
      { ok: false, error: { code: 'network', message: 'offline' } },
    ]) {
      mocks.discoverServer.mockResolvedValueOnce(found);
      await syncStateItem.setValue({ ...DEFAULT_SYNC_STATE, known: {} });
      runs = [];
      const refused = await handlers.syncSetEnabled({ type: 'syncSetEnabled', enabled: true }, page());
      expect(refused).toStrictEqual({
        available: true,
        enabled: false,
        state: 'problem',
        lastSyncAt: null,
        problem: 'unavailable',
        message: "sync.example.org doesn't offer sync.",
      });
      expect((await syncStateItem.getValue()).enabled).toBe(false);
      expect(await fakeBrowser.alarms.get(SYNC_ALARM)).toBeUndefined();
      expect(runs).toStrictEqual([]);
    }
  });

  it('test_sync_problem_messages_name_server', async () => {
    const expected: Record<SyncProblem, string> = {
      auth: 'Sign in to {title} again to keep syncing.',
      network: "Couldn't reach {title}. Sync tries again soon.",
      quota: 'Your synced settings are larger than {title} allows. Remove some exceptions or interests.',
      clock: "This computer's date or time looks wrong, so sync is paused. Check the clock, then try again.",
      server: '{title} had a problem. Sync tries again soon.',
      unavailable: "{title} doesn't offer sync.",
      consent: 'unAlgorithm needs your permission to send your settings to {title}.',
    };
    for (const [origin, title] of [
      [ORIGIN, 'sync.example.org'],
      [PINNED_CLOUD_ORIGIN, 'unAlgorithm Cloud'],
    ] as const) {
      await serverAccountItem.setValue(account({ origin }));
      for (const [problem, text] of Object.entries(expected) as [SyncProblem, string][]) {
        await syncStateItem.setValue(enabledState({ origin, problem }));
        expect(await handlers.syncStatus({ type: 'syncStatus' }, page())).toStrictEqual({
          available: true,
          enabled: true,
          state: 'problem',
          lastSyncAt: NOW,
          problem,
          message: text.replace('{title}', title),
        });
      }
    }
    await syncStateItem.setValue(enabledState());
    expect(await handlers.syncStatus({ type: 'syncStatus' }, page())).toStrictEqual({
      available: true,
      enabled: true,
      state: 'ok',
      lastSyncAt: NOW,
    });
  });
});

describe('scheduling', () => {
  it('test_local_edit_debounced_remote_apply_ignored', async () => {
    await serverAccountItem.setValue(account());
    await syncStateItem.setValue(enabledState());
    feedTabs = [tab(7, LINKEDIN)];
    initSync();
    await settle();
    expect(runs.map((r) => r.wait)).toStrictEqual([LONG]);
    const waiting = lastRun();

    // Three edits within the window: one run, 2 s after the last, and nothing aborted before then.
    for (const mode of ['hide', 'dim', 'collapse'] as const) {
      await updateSettings((s) => {
        s.display.mode = mode;
        s.display.showAuthor = mode === 'collapse';
      });
      await advance(500);
    }
    await advance(1_400);
    expect(waiting.aborted).toBe(false);
    expect(quickRuns()).toHaveLength(0);
    await advance(100);
    expect(waiting.aborted).toBe(true);
    expect(quickRuns()).toHaveLength(1);
    expect(maxActive).toBe(1);
    // The loop goes back to waiting.
    expect(lastRun().wait).toBe(LONG);
    expect(lastRun().settled).toBe(false);

    // Another device's change, applied as the sync client does it (`known` first, then settings and clocks): no run.
    const remote = lastRun();
    const item = {
      collection: 'settings',
      key: 'interests.more.x',
      hlc: formatHlc({ ms: NOW + 10_000, counter: 0, device: OTHER }),
      deleted: false,
      value: { label: 'X', keywords: [], addedAt: 1 },
    } as SyncItem;
    const st = await syncStateItem.getValue();
    await syncStateItem.setValue({ ...st, known: { ...st.known, [item.key]: item.hlc } });
    const before = await settingsClocksItem.getValue();
    expect(
      await applyRemoteSettings((s, c) => {
        const r = applyRemoteItems(s, c, [item]);
        return r.ok && r.applied.length ? r : null;
      }),
    ).toBe(true);
    expect(await settingsClocksItem.getValue()).not.toStrictEqual(before);
    await advance(5_000);
    expect(quickRuns()).toHaveLength(1);
    expect(remote.aborted).toBe(false);
  });

  it('test_long_poll_runs_only_with_surface', async () => {
    await serverAccountItem.setValue(account());
    await syncStateItem.setValue(enabledState());
    initSync();
    await settle();
    // No feed tab, no extension page: no loop.
    expect(runs).toStrictEqual([]);
    expect(query()).toHaveBeenCalledWith({ url: FEED_TAB_URLS });

    // A LinkedIn tab: back-to-back long-polls.
    feedTabs = [tab(7, LINKEDIN)];
    await runSync();
    await settle();
    expect(runs.map((r) => r.wait)).toStrictEqual([0, LONG]);
    for (let n = 0; n < 3; n++) {
      lastRun().answer(PULLED);
      await settle();
    }
    expect(runs.map((r) => r.wait)).toStrictEqual([0, LONG, LONG, LONG, LONG]);

    // A local edit aborts the waiting call through its signal once the debounce fires.
    const waiting = lastRun();
    await updateSettings((s) => {
      s.display.showAuthor = false;
    });
    await advance(1_900);
    expect(waiting.aborted).toBe(false);
    await advance(100);
    expect(waiting.aborted).toBe(true);
    expect(runs.map((r) => r.wait).slice(-2)).toStrictEqual([0, LONG]);

    // The tab closes: the loop stops after its current answer.
    feedTabs = [];
    const count = runs.length;
    lastRun().answer(PULLED);
    await advance(60_000);
    expect(runs).toHaveLength(count);

    // An extension page (the popup) is enough on its own.
    pages = [{ contextType: 'POPUP' } as Browser.runtime.ExtensionContext];
    await runSync();
    await settle();
    expect(runs.map((r) => r.wait).slice(count)).toStrictEqual([0, LONG]);
  });

  it('test_long_poll_backoff', async () => {
    await serverAccountItem.setValue(account());
    await syncStateItem.setValue(enabledState());
    feedTabs = [tab(7, LINKEDIN)];
    initSync();
    await settle();
    expect(runs).toHaveLength(1);

    /** Answers the waiting call and checks how long the loop waits before the next one. */
    async function expectGap(outcome: SyncOutcome, gap: number) {
      const count = runs.length;
      lastRun().answer(outcome);
      await settle();
      if (gap > 0) {
        await advance(gap - 1);
        expect(runs, `before ${gap} ms`).toHaveLength(count);
        await advance(1);
      }
      expect(runs, `after ${gap} ms`).toHaveLength(count + 1);
      expect(lastRun().wait).toBe(LONG);
    }

    // A slow answer with something in it: straight on (the first answer took 3 s).
    await advance(3_000);
    await expectGap(PULLED, 0);
    await expectGap(PROBLEM, 5_000);
    await expectGap(PROBLEM, 30_000);
    await expectGap(PROBLEM, 60_000);
    await expectGap(PROBLEM, 60_000);
    // Back to no wait after a success.
    await advance(3_000);
    await expectGap(PULLED, 0);
    await expectGap(PROBLEM, 5_000);
    // The scheduler's own abort restarts at once and leaves the backoff where it was.
    await expectGap({ ok: false, problem: 'network', aborted: true }, 0);
    await expectGap(PROBLEM, 30_000);
    await advance(1_500);
    await expectGap(PULLED, 0);
    // An empty answer in under a second: at least 2 s before the next.
    await expectGap(OK_EMPTY, 2_000);
    // An empty answer after the full wait: straight on.
    await advance(LONG * 1000);
    await expectGap(OK_EMPTY, 0);
  });

  it('test_alarm_and_wake_single_flight', async () => {
    await serverAccountItem.setValue(account());
    const tick = () => fakeBrowser.alarms.onAlarm.trigger(alarm());

    // Off: neither worker start nor the alarm runs anything.
    await syncStateItem.setValue(enabledState({ enabled: false, lastSyncAt: null }));
    initSync();
    await settle();
    await tick();
    await settle();
    expect(runs).toStrictEqual([]);

    // On, last sync a minute ago: worker start runs one; so does the alarm.
    fakeBrowser.reset();
    await serverAccountItem.setValue(account());
    await syncStateItem.setValue(enabledState({ lastSyncAt: NOW - 60_000 }));
    initSync();
    await settle();
    expect(runs.map((r) => r.wait)).toStrictEqual([0]);
    await tick();
    await settle();
    expect(runs.map((r) => r.wait)).toStrictEqual([0, 0]);

    // Concurrent runs share one syncOnce.
    autoAnswer = false;
    const together = Promise.all([runSync(), tick(), handlers.syncNow({ type: 'syncNow' }, page()), runSync()]);
    await settle();
    expect(runs).toHaveLength(3);
    expect((await handlers.syncStatus({ type: 'syncStatus' }, page())).state).toBe('syncing');
    lastRun().answer(OK_EMPTY);
    await together;
    expect(runs).toHaveLength(3);

    // syncNow while a long-poll waits: the long-poll is aborted, then one wait-0 run after it has returned.
    feedTabs = [tab(7, LINKEDIN)];
    const first = runSync();
    await settle();
    lastRun().answer(OK_EMPTY);
    await first;
    await settle();
    const waiting = lastRun();
    expect(waiting.wait).toBe(LONG);
    expect((await handlers.syncStatus({ type: 'syncStatus' }, page())).state).toBe('ok');
    const now = handlers.syncNow({ type: 'syncNow' }, page());
    const joined = runSync();
    await settle();
    expect(waiting.aborted).toBe(true);
    expect(quickRuns().filter((r) => !r.settled)).toHaveLength(1);
    lastRun().answer(OK_EMPTY);
    await Promise.all([now, joined]);
    await settle();
    expect(lastRun().wait).toBe(LONG);
    expect(maxActive).toBe(1);
  });

  it('test_alarm_recreated_on_start', async () => {
    await serverAccountItem.setValue(account());
    await syncStateItem.setValue(enabledState({ enabled: false }));
    initSync();
    await settle();
    expect(await fakeBrowser.alarms.getAll()).toStrictEqual([]);

    // An update cleared the alarm while sync was on.
    fakeBrowser.reset();
    await serverAccountItem.setValue(account());
    await syncStateItem.setValue(enabledState());
    initSync();
    await settle();
    expect(await fakeBrowser.alarms.getAll()).toMatchObject([{ name: 'ua-sync', periodInMinutes: 0.5 }]);
  });

  it('test_browser_restart_brings_the_alarm_back', async () => {
    await serverAccountItem.setValue(account());
    await syncStateItem.setValue(enabledState());
    initSync();
    await settle();
    // Firefox starts the background at browser start only for an `onStartup` listener; registered every time.
    expect(fakeBrowser.runtime.onStartup.hasListeners()).toBe(true);
    expect(await fakeBrowser.alarms.getAll()).toMatchObject([{ name: 'ua-sync' }]);

    // A restart: Firefox's alarms were in memory and are gone, and the background starts for `onStartup`.
    await fakeBrowser.alarms.clearAll();
    initSync();
    await fakeBrowser.runtime.onStartup.trigger();
    await settle();
    expect(await fakeBrowser.alarms.getAll()).toMatchObject([{ name: 'ua-sync', periodInMinutes: 0.5 }]);
    // The start syncs once when the last sync is old; the event itself adds nothing.
    expect(runs.map((r) => r.wait)).toStrictEqual([]);
    vi.setSystemTime(NOW + 60_000);
    initSync();
    await fakeBrowser.runtime.onStartup.trigger();
    await settle();
    expect(runs.map((r) => r.wait)).toStrictEqual([0]);
  });

  it('test_long_poll_stops_while_consent_is_missing', async () => {
    await serverAccountItem.setValue(account());
    await syncStateItem.setValue(enabledState());
    feedTabs = [tab(7, LINKEDIN)];
    initSync();
    await settle();
    expect(runs.map((r) => r.wait)).toStrictEqual([LONG]);
    lastRun().answer({ ok: false, problem: 'consent' });
    await settle();
    // No retries on a timer: nothing changes until the person allows it (Settings syncs then), and the alarm checks.
    await advance(5 * 60_000);
    expect(runs).toHaveLength(1);
    await fakeBrowser.alarms.onAlarm.trigger(alarm());
    await settle();
    expect(runs.map((r) => r.wait)).toStrictEqual([LONG, 0, LONG]);
  });

  it('test_alarm_tick_restarts_long_poll', async () => {
    await serverAccountItem.setValue(account());
    await syncStateItem.setValue(enabledState());
    initSync();
    await settle();
    expect(runs).toStrictEqual([]);

    feedTabs = [tab(7, LINKEDIN)];
    await fakeBrowser.alarms.onAlarm.trigger(alarm());
    await settle();
    expect(runs.map((r) => r.wait)).toStrictEqual([0, LONG]);
  });
});

describe('sign-out and erase', () => {
  it('test_sign_out_resets_sync', async () => {
    await serverAccountItem.setValue(account());
    await syncStateItem.setValue(enabledState({ known: { 'display.mode': 'x' }, cursor: 12 }));
    await fakeBrowser.alarms.create(SYNC_ALARM, { periodInMinutes: 0.5 });
    feedTabs = [tab(7, LINKEDIN)];
    initSync();
    await settle();
    const waiting = lastRun();
    expect(waiting.wait).toBe(LONG);

    expect(await handlers.serverSignOut({ type: 'serverSignOut' }, page())).toStrictEqual({ ok: true });
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith(ORIGIN);
    expect(waiting.aborted).toBe(true);
    expect(await syncStateItem.getValue()).toStrictEqual(DEFAULT_SYNC_STATE);
    expect(await fakeBrowser.alarms.getAll()).toStrictEqual([]);
    const count = runs.length;
    await advance(120_000);
    expect(runs).toHaveLength(count);

    // Signing in again (the account is back): sync stays off until the person turns it on.
    await serverAccountItem.setValue(account());
    expect(await handlers.syncStatus({ type: 'syncStatus' }, page())).toStrictEqual({
      available: true,
      enabled: false,
      state: 'off',
      lastSyncAt: null,
    });
  });

  it('test_erase_removes_settings_and_clocks', async () => {
    vi.useRealTimers();
    await serverAccountItem.setValue(account());
    await syncStateItem.setValue(enabledState());
    await updateSettings((s) => {
      s.display.showAuthor = false;
    });
    expect(Object.keys(await settingsClocksItem.getValue())).not.toHaveLength(0);

    expect(await handlers.clearData({ type: 'clearData', what: 'all' }, page())).toStrictEqual({ ok: true });
    // Removed, not just emptied (the fake storage reports a missing key as undefined).
    expect(await fakeBrowser.storage.local.get(['settings', 'settingsClocks', 'syncState'])).toEqual({});

    // "Erase everything" then writes the defaults: they stay at clock 0.
    await replaceSettings(defaultSettings());
    expect(await fakeBrowser.storage.local.get('settingsClocks')).toEqual({});
    expect(await settingsItem.getValue()).toBeNull();
  });
});

describe('manifest', () => {
  it('test_manifest_alarms_only_with_cloud', () => {
    // Required in every browser: Firefox can't make `alarms` optional at all.
    for (const browser of ['chrome', 'edge', 'firefox']) {
      vi.stubEnv('UA_CLOUD', undefined);
      expect(manifestFor('production', browser).permissions, browser).not.toContain('alarms');
      for (const mode of ['development', 'e2e']) expect(manifestFor(mode, browser).permissions, browser).toContain('alarms');
      vi.stubEnv('UA_CLOUD', '1');
      expect(manifestFor('production', browser).permissions, browser).toContain('alarms');
      for (const mode of ['production', 'development', 'e2e'])
        expect(manifestFor(mode, browser).optional_permissions ?? [], browser).not.toContain('alarms');
    }
    vi.unstubAllEnvs();
  });
});
