/**
 * Settings sync, one run (R15 to R17): pull, apply without echo, push, resync after 410, the problems a run reports,
 * and that keys and tokens never reach a payload. The server is the in-memory fake behind an injected fetch, the device
 * token a stubbed `getAccessToken`; extension storage is the WXT fake browser and the clock a fake `Date`.
 */
import {
  defaultDevice,
  defaultSettings,
  presetOf,
  SETTINGS_VERSION,
  type Settings,
  type SettingsClocks,
} from '@unalgorithm/core';
import {
  AUTHORIZE_PAGE_PATH,
  formatHlc,
  hlcMs,
  type ServerInfo,
  SYNC_CHANGES_PATH,
  SYNC_MAX_HLC_AHEAD_MS,
  SYNC_PUSH_PATH,
  SYNC_SPACES_PATH,
  type SyncItem,
  TOKEN_PATH,
} from '@unalgorithm/protocol';
import { applyRemoteItems, validateSettingsItem } from '@unalgorithm/sync';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { setSecret } from '../src/background/idb.ts';
import { markNeedsSignIn, type ServerAccount, serverAccountItem } from '../src/background/server-auth.ts';
import { type SyncDeps, syncOnce } from '../src/background/sync-client.ts';
import type { BrowserKind } from '../src/lib/browser-kind.ts';
import { applyRemoteSettings, updateSettings, upgradeStoredSettings } from '../src/lib/settings-store.ts';
import {
  DEFAULT_SYNC_STATE,
  deviceItem,
  lastHlcItem,
  learnedItem,
  readSettings,
  type SyncState,
  settingsClocksItem,
  settingsItem,
  syncStateItem,
  votesItem,
} from '../src/lib/storage.ts';
import { createFakeSyncServer, type FakeSyncServer } from './support/fake-sync-server.ts';

// Vitest builds for Chrome; the Firefox case switches `browserKind()`.
const env = vi.hoisted(() => ({ kind: 'chrome' as BrowserKind }));
vi.mock('../src/lib/browser-kind.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/browser-kind.ts')>()),
  browserKind: () => env.kind,
}));

const ORIGIN = 'https://sync.example.org';
const EMAIL = 'ada@example.org';
const TOKEN = 'access-token-marker-7f3a';
const NOW = Date.UTC(2026, 9, 14, 9);
const DAY = 24 * 3600_000;
/** This computer. */
const LOCAL = '0199d6a5-7a20-7d41-8c3e-5f9a0b1c2d4e';
/** Another computer of the same account. */
const OTHER = '0199d6a4-3f1e-7c2a-9b5d-2e8f4a6c1b3d';

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

const hlc = (ms: number, device = OTHER, counter = 0) => formatHlc({ ms, counter, device });
const topic = (label: string) => ({ label, keywords: [], addedAt: 1 });
const live = (key: string, value: unknown, at: string): SyncItem =>
  ({ collection: 'settings', key, hlc: at, deleted: false, value }) as SyncItem;
const tombstone = (key: string, at: string): SyncItem => ({ collection: 'settings', key, hlc: at, deleted: true });

function account(over: Partial<ServerAccount> = {}): ServerAccount {
  return { origin: ORIGIN, email: EMAIL, deviceId: 'server-device-1', signedInAt: NOW, info: INFO, needsSignIn: false, ...over };
}

let server: FakeSyncServer;
let deps: Partial<SyncDeps> & { getAccessToken: ReturnType<typeof vi.fn> };

function makeDeps(fake: FakeSyncServer): typeof deps {
  return {
    fetch: fake.fetch,
    getAccessToken: vi.fn(async () => TOKEN),
    markNeedsSignIn: vi.fn(markNeedsSignIn),
    now: () => Date.now(),
    uuid: () => crypto.randomUUID(),
  };
}

const run = (opts: Parameters<typeof syncOnce>[0] = {}, over: Partial<SyncDeps> = {}) => syncOnce(opts, { ...deps, ...over });
const state = () => syncStateItem.getValue();
const enable = (over: Partial<SyncState> = {}) =>
  syncStateItem.setValue({ ...DEFAULT_SYNC_STATE, known: {}, enabled: true, origin: ORIGIN, email: EMAIL, ...over });
/** Writes settings and clocks as earlier edits on this computer left them. */
async function seedLocal(mutate: (s: Settings) => void, clocks: SettingsClocks) {
  const s = defaultSettings();
  mutate(s);
  await settingsItem.setValue(s);
  await settingsClocksItem.setValue(clocks);
}
const pushedKeys = (fake = server) => fake.pushBodies().flatMap((b) => b.items.map((i) => i.key));

beforeEach(async () => {
  fakeBrowser.reset();
  env.kind = 'chrome';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  await deviceItem.setValue(defaultDevice(LOCAL));
  await serverAccountItem.setValue(account());
  await enable();
  server = createFakeSyncServer();
  deps = makeDeps(server);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('guards', () => {
  it('test_sync_once_unavailable_without_consent_or_account', async () => {
    await enable({ enabled: false });
    const off = await state();
    expect(await run()).toStrictEqual({ ok: false, problem: 'unavailable' });
    expect(await state()).toStrictEqual(off);

    await enable();
    await serverAccountItem.setValue(null);
    const signedOut = await state();
    expect(await run()).toStrictEqual({ ok: false, problem: 'unavailable' });
    expect(await state()).toStrictEqual(signedOut);
    expect(server.calls).toHaveLength(0);

    await serverAccountItem.setValue(account({ needsSignIn: true }));
    expect(await run()).toStrictEqual({ ok: false, problem: 'auth' });
    expect((await state()).problem).toBe('auth');
    // A stored `auth` keeps telling the person to sign in again.
    expect(await run()).toStrictEqual({ ok: false, problem: 'auth' });
    expect((await state()).problem).toBe('auth');
    expect(server.calls).toHaveLength(0);
  });
});

describe('firefox consent', () => {
  it('test_firefox_sync_waits_for_consent', async () => {
    env.kind = 'firefox';
    let granted: string[] = ['websiteContent'];
    // `as never`: spyOn picks the callback overload, typed as returning void.
    vi.spyOn(fakeBrowser.permissions, 'getAll').mockImplementation((async () => ({
      origins: [],
      permissions: [],
      data_collection: granted,
    })) as never);
    // The settings name the people you always show or hide, and go with the account: post text alone isn't enough, nor
    // is all but one of the types the sign-in asked for. Technical and interaction data (the device name) isn't one.
    const cloudData = ['websiteContent', 'personalCommunications', 'personallyIdentifyingInfo', 'authenticationInfo'];
    for (const missing of cloudData) {
      granted = cloudData.filter((type) => type !== missing);
      expect(await run(), missing).toStrictEqual({ ok: false, problem: 'consent' });
    }
    expect((await state()).problem).toBe('consent');
    expect(server.calls).toHaveLength(0);
    expect(deps.getAccessToken).not.toHaveBeenCalled();

    granted = cloudData;
    expect(await run()).toMatchObject({ ok: true });
    expect((await state()).problem).toBeNull();
    expect(server.calls.length).toBeGreaterThan(0);

    // A server on this computer needs the same: it is outside the browser.
    granted = [];
    const local = 'http://127.0.0.1:8787';
    await serverAccountItem.setValue(account({ origin: local }));
    await enable({ origin: local });
    const before = server.calls.length;
    expect(await run()).toStrictEqual({ ok: false, problem: 'consent' });
    expect(server.calls).toHaveLength(before);
    granted = cloudData;
    expect(await run()).toMatchObject({ ok: true });
    expect(server.calls.length).toBeGreaterThan(before);
  });

  it('test_firefox_consent_withdrawn_during_a_run_stops_it', async () => {
    env.kind = 'firefox';
    const cloudData = ['websiteContent', 'personalCommunications', 'personallyIdentifyingInfo', 'authenticationInfo'];
    let granted = cloudData;
    // `as never`: spyOn picks the callback overload, typed as returning void.
    vi.spyOn(fakeBrowser.permissions, 'getAll').mockImplementation((async () => ({
      origins: [],
      permissions: [],
      data_collection: granted,
    })) as never);
    // A local edit, so the run has something to push after its pull.
    await updateSettings((s) => {
      s.platforms.linkedin.preset = 'calm';
    });
    // Withdrawn in Firefox's add-ons page once the server has answered the run's first request.
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const answer = await server.fetch(input, init);
      granted = ['websiteContent'];
      return answer;
    }) as unknown as typeof globalThis.fetch;
    expect(await run({}, { fetch })).toStrictEqual({ ok: false, problem: 'consent' });
    expect(server.calls).toHaveLength(1);
    expect(server.pushBodies()).toHaveLength(0);
    expect((await state()).problem).toBe('consent');
  });

  it('test_chrome_sync_never_asks_for_consent', async () => {
    const getAll = vi.spyOn(fakeBrowser.permissions, 'getAll');
    expect(await run()).toMatchObject({ ok: true });
    expect(getAll).not.toHaveBeenCalled();
  });
});

describe('pull and apply', () => {
  it('test_first_sync_applies_remote_items', async () => {
    const modeHlc = hlc(NOW - 2000);
    const interestHlc = hlc(NOW - 1000);
    server.put(live('display.mode', 'hide', modeHlc));
    server.put(live('interests.more.x', topic('X'), interestHlc));
    await lastHlcItem.setValue(hlc(NOW - 5000, LOCAL));
    const stateWrites = vi.spyOn(syncStateItem, 'setValue');
    const settingsWrites = vi.spyOn(settingsItem, 'setValue');
    const clockWrites = vi.spyOn(settingsClocksItem, 'setValue');

    expect(await run()).toStrictEqual({ ok: true, pulled: 2, pushed: 0 });

    expect(server.calls.map((c) => c.path)).toStrictEqual([SYNC_SPACES_PATH, SYNC_CHANGES_PATH]);
    expect(server.calls[1]?.query.since).toBe('0');
    const settings = await readSettings();
    expect(settings.display.mode).toBe('hide');
    expect(settings.interests.more.x).toStrictEqual(topic('X'));
    const clocks = await settingsClocksItem.getValue();
    expect(clocks['display.mode']).toBe(modeHlc);
    expect(clocks['interests.more.x']).toBe(interestHlc);
    const st = await state();
    expect(st.known).toStrictEqual({ 'display.mode': modeHlc, 'interests.more.x': interestHlc });
    expect(st.cursor).toBe(server.cursor);
    expect(st.problem).toBeNull();
    expect(st.lastSyncAt).toBe(NOW);
    expect(await lastHlcItem.getValue()).toBe(interestHlc);

    // `known` is saved before the settings and clocks are written, the cursor after.
    const order = (spy: typeof stateWrites, match: (s: SyncState) => boolean) =>
      spy.mock.invocationCallOrder[spy.mock.calls.findIndex(([s]) => match(s))] ?? Number.NaN;
    const knownSaved = order(stateWrites, (s) => Object.hasOwn(s.known, 'display.mode'));
    const cursorSaved = order(stateWrites, (s) => s.cursor === server.cursor);
    const settingsSaved = settingsWrites.mock.invocationCallOrder[0] ?? Number.NaN;
    const clocksSaved = clockWrites.mock.invocationCallOrder[0] ?? Number.NaN;
    expect(knownSaved).toBeLessThan(settingsSaved);
    expect(knownSaved).toBeLessThan(clocksSaved);
    expect(cursorSaved).toBeGreaterThan(clocksSaved);

    // A page that applies nothing (an item older than the local clock) leaves the last HLC alone.
    const lastBefore = await lastHlcItem.getValue();
    server.put(live('display.mode', 'dim', hlc(NOW - 3000)));
    expect(await run()).toMatchObject({ ok: true, pulled: 1 });
    expect((await readSettings()).display.mode).toBe('hide');
    expect(await lastHlcItem.getValue()).toBe(lastBefore);
  });

  it('test_large_pull_page_is_read', async () => {
    // One page over serverRequest's 64 KiB default: the pull reads up to a full page (PULL_MAX_BYTES).
    const keywords = Array.from({ length: 6 }, (_, k) => `${k}${'x'.repeat(38)}`);
    for (let i = 0; i < 300; i++) server.put(live(`interests.more.t${i}`, { ...topic(`T${i}`), keywords }, hlc(NOW - 1000)));
    expect(await run()).toStrictEqual({ ok: true, pulled: 300, pushed: 0 });
    expect(Object.keys((await readSettings()).interests.more)).toHaveLength(300);
  });

  it('test_remote_apply_does_not_echo', async () => {
    server.put(live('display.mode', 'hide', hlc(NOW - 2000)));
    server.put(live('interests.more.x', topic('X'), hlc(NOW - 1000)));
    expect(await run()).toMatchObject({ ok: true, pulled: 2 });
    expect(await run()).toStrictEqual({ ok: true, pulled: 0, pushed: 0 });
    expect(server.pushBodies()).toHaveLength(0);
  });

  it('test_pull_pages_and_snapshot_flag', async () => {
    server = createFakeSyncServer({ pageSize: 2 });
    deps = makeDeps(server);
    for (const id of ['a', 'b', 'c']) server.put(live(`interests.more.${id}`, topic(id), hlc(NOW - 1000)));

    expect(await run({ waitSeconds: 20 })).toMatchObject({ ok: true, pulled: 3 });
    const first = server.changesCalls().map((c) => c.query);
    expect(first.map((q) => [q.since, q.snapshot, q.wait])).toStrictEqual([
      ['0', '0', '20'],
      ['2', '1', '0'],
    ]);

    for (const id of ['d', 'e', 'f']) server.put(live(`interests.more.${id}`, topic(id), hlc(NOW - 500)));
    expect(await run({ waitSeconds: 20 })).toMatchObject({ ok: true, pulled: 3 });
    const second = server
      .changesCalls()
      .slice(first.length)
      .map((c) => [c.query.since, c.query.snapshot, c.query.wait]);
    expect(second).toStrictEqual([
      ['3', '0', '20'],
      ['5', '0', '0'],
    ]);
    expect(Object.keys((await readSettings()).interests.more).sort()).toStrictEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  describe('test_server_tombstone_reaches_device_starting_over', () => {
    const X = 'interests.more.x';
    const localX = hlc(NOW - 3000, LOCAL);
    const gone = hlc(NOW - 2000);

    async function expectConverged() {
      expect((await readSettings()).interests.more).not.toHaveProperty('x');
      expect((await state()).known[X]).toBe(gone);
      expect(await run()).toMatchObject({ ok: true });
      expect(pushedKeys()).not.toContain(X);
      expect(server.pushBodies()).toHaveLength(0);
    }

    beforeEach(async () => {
      server.put(live(X, topic('X'), hlc(NOW - 4000)));
      server.put(tombstone(X, gone));
      await seedLocal((s) => (s.interests.more.x = topic('X')), { [X]: localX });
    });

    it('after signing out and in again', async () => {
      // CL3-20 reset the state on sign-out; sync is on again for the same account.
      await enable();
      expect(await run()).toMatchObject({ ok: true });
      await expectConverged();
    });

    it('after an account switch', async () => {
      await enable({ email: 'old@example.org', spaceId: crypto.randomUUID(), cursor: 9, known: { [X]: localX } });
      expect(await run()).toStrictEqual({ ok: false, problem: 'unavailable' });
      expect(server.calls).toHaveLength(0);
      const reset = await state();
      await enable({ ...reset, enabled: true });
      expect(await run()).toMatchObject({ ok: true });
      await expectConverged();
    });

    it('after a 410', async () => {
      await enable({ spaceId: server.spaceId, epoch: server.epoch, cursor: 1, known: { [X]: localX } });
      server.newEpoch();
      expect(await run()).toMatchObject({ ok: true });
      expect(server.changesCalls().map((c) => c.query.since)).toStrictEqual(['1', '0']);
      await expectConverged();
    });
  });

  it('test_first_pull_prefers_server_copy', async () => {
    const preset = 'platforms.linkedin.preset';
    const starter = 'interests.more.ai-tech';
    const mine = 'interests.more.mine';
    const paged = createFakeSyncServer({ pageSize: 1 });
    for (const fake of [server, paged]) {
      fake.put(live(preset, 'calm', hlc(NOW - 9000)));
      fake.put(tombstone(starter, hlc(NOW - 8000)));
    }
    const onboarding = async () => {
      await seedLocal(
        (s) => {
          s.platforms.linkedin.preset = 'light';
          s.interests.more['ai-tech'] = topic('AI & tech');
          s.interests.more.mine = topic('Mine');
        },
        { [preset]: hlc(NOW - 1000, LOCAL), [starter]: hlc(NOW - 1000, LOCAL, 1), [mine]: hlc(NOW - 1000, LOCAL, 2) },
      );
      await enable({ firstPull: true });
    };
    const expectServerCopyWon = async (fake: FakeSyncServer) => {
      const s = await readSettings();
      expect(s.platforms.linkedin.preset).toBe('calm');
      expect(s.interests.more).not.toHaveProperty('ai-tech');
      expect(s.interests.more.mine).toStrictEqual(topic('Mine'));
      expect(pushedKeys(fake)).toStrictEqual([mine]);
      expect((await state()).firstPull).toBe(false);
    };

    await onboarding();
    expect(await run()).toMatchObject({ ok: true, pulled: 2, pushed: 1 });
    await expectServerCopyWon(server);

    // Two pages: the server's copy keeps winning until the whole pull is applied.
    await onboarding();
    deps = makeDeps(paged);
    const saves = vi.spyOn(syncStateItem, 'setValue');
    expect(await run()).toMatchObject({ ok: true, pulled: 2, pushed: 1 });
    expect(paged.changesCalls()).toHaveLength(2);
    expect(saves.mock.calls.find(([s]) => s.cursor === 1)?.[0].firstPull).toBe(true);
    await expectServerCopyWon(paged);

    // A later 410 resync applies with plain LWW: a local edit newer than the server's item survives.
    await updateSettings((s) => {
      s.display.mode = 'dim';
    });
    paged.put(live('display.mode', 'hide', hlc(NOW - 500)));
    paged.newEpoch();
    expect(await run()).toMatchObject({ ok: true });
    expect((await readSettings()).display.mode).toBe('dim');
    expect(paged.item('display.mode')).toMatchObject({ value: 'dim' });
  });
});

describe("settings version 2: Facebook's Balanced hides people you don't follow", () => {
  const FB = 'platforms.facebook';
  /** What a computer on version 1 sends when its person picks Balanced on Facebook after Calm. */
  const balancedFromVersion1 = (at: string): SyncItem[] => [
    live(`${FB}.preset`, 'balanced', at),
    live(`${FB}.filters.notFollowed`, false, at),
    live(`${FB}.filters.reels`, false, at),
    live(`${FB}.filters.reshares`, false, at),
    live(`${FB}.ai.noise.promotional`, false, at),
    live(`${FB}.ai.noise.low-effort`, false, at),
    live(`${FB}.ai.lowRelevance`, false, at),
  ];
  const facebook = async () => (await readSettings()).platforms.facebook;

  /** This computer picked Calm, then Balanced, on version 1 and synced it; then it updated to version 2. */
  async function updatedFromVersion1(): Promise<SyncItem[]> {
    const mine = balancedFromVersion1(hlc(NOW - 5 * DAY, LOCAL));
    for (const item of mine) server.put(item);
    const v1 = defaultSettings();
    v1.platforms.facebook.filters.notFollowed = false;
    await settingsItem.setValue({ ...v1, version: 1 });
    await settingsClocksItem.setValue(Object.fromEntries(mine.map((item) => [item.key, item.hlc])));
    await enable({ known: Object.fromEntries(mine.map((item) => [item.key, item.hlc])) });
    expect(await facebook()).toMatchObject({ preset: 'balanced', filters: { notFollowed: true } });
    return mine;
  }

  it('test_sync_sends_the_upgrade_once_and_never_undoes_it', async () => {
    const mine = await updatedFromVersion1();
    // The background stores the upgrade when it starts: the new value gets a clock right after the old one, once.
    expect(await upgradeStoredSettings()).toBe(true);
    expect(await upgradeStoredSettings()).toBe(false);
    expect(await settingsItem.getValue()).toMatchObject({
      version: SETTINGS_VERSION,
      platforms: { facebook: { filters: { notFollowed: true } } },
    });
    const stamp = hlc(NOW - 5 * DAY, LOCAL, 1);
    expect((await settingsClocksItem.getValue())[`${FB}.filters.notFollowed`]).toBe(stamp);
    expect(await run()).toStrictEqual({ ok: true, pulled: mine.length, pushed: 1 });
    expect(pushedKeys()).toStrictEqual([`${FB}.filters.notFollowed`]);
    expect(server.item(`${FB}.filters.notFollowed`)).toMatchObject({ value: true, hlc: stamp });
    expect(await run()).toMatchObject({ ok: true, pushed: 0 });

    // Another computer, still on version 1, picks Balanced again: read as today's Balanced, and nothing goes back.
    for (const item of balancedFromVersion1(hlc(NOW - DAY))) server.put(item);
    expect(await run()).toMatchObject({ ok: true, pushed: 0 });
    const fb = await facebook();
    expect(fb.filters.notFollowed).toBe(true);
    expect(presetOf('facebook', fb)).toBe('balanced');
    expect(await run()).toMatchObject({ ok: true, pushed: 0 });
    expect(pushedKeys()).toStrictEqual([`${FB}.filters.notFollowed`]);

    // The person turns the rule off here: that is a choice, sent and kept.
    await updateSettings((s) => {
      s.platforms.facebook.filters.notFollowed = false;
      s.platforms.facebook.preset = presetOf('facebook', s.platforms.facebook);
    });
    expect(await run()).toMatchObject({ ok: true, pushed: 2 });
    expect(server.item(`${FB}.filters.notFollowed`)).toMatchObject({ value: false });
    expect(server.item(`${FB}.preset`)).toMatchObject({ value: 'custom' });
    expect(presetOf('facebook', await facebook())).toBe('custom');
  });

  it('test_the_first_write_after_the_update_carries_the_upgrade', async () => {
    await updatedFromVersion1();
    // An edit, or a remote apply, before the background stored the upgrade stores it with its clock all the same.
    await updateSettings((s) => {
      s.display.mode = 'dim';
    });
    expect(await settingsItem.getValue()).toMatchObject({
      version: SETTINGS_VERSION,
      platforms: { facebook: { filters: { notFollowed: true } } },
    });
    expect(await upgradeStoredSettings()).toBe(false);
    expect(await run()).toMatchObject({ ok: true, pushed: 2 });
    expect(pushedKeys().sort()).toStrictEqual(['display.mode', `${FB}.filters.notFollowed`]);
  });
});

describe('settings version 3: hidden posts in a row each keep their own line', () => {
  const GROUP = 'display.groupRuns';
  /** This computer on version 2, with grouping as version 2 left it, then updated to version 3. */
  async function storedByVersion2(clocks: SettingsClocks): Promise<void> {
    const v2 = defaultSettings();
    v2.display.groupRuns = true;
    await settingsItem.setValue({ ...v2, version: 2 });
    await settingsClocksItem.setValue(clocks);
  }

  it('test_an_untouched_default_moves_and_nothing_is_sent', async () => {
    await storedByVersion2({});
    // Read before the background stores the upgrade (a page, a content script): already the new default.
    expect((await readSettings()).display.groupRuns).toBe(false);
    expect(await upgradeStoredSettings()).toBe(true);
    expect(await settingsItem.getValue()).toMatchObject({ version: SETTINGS_VERSION, display: { groupRuns: false } });
    expect(await settingsClocksItem.getValue()).toStrictEqual({});
    // A default is never sent: each computer moves its own when it updates.
    expect(await run()).toStrictEqual({ ok: true, pulled: 0, pushed: 0 });
    expect(server.item(GROUP)).toBeUndefined();

    // Turned on here: a choice like any other, sent, and a computer still on version 2 gets it as it is.
    await updateSettings((s) => {
      s.display.groupRuns = true;
    });
    expect(await run()).toMatchObject({ ok: true, pushed: 1 });
    expect(server.item(GROUP)).toMatchObject({ value: true });
  });

  it('test_a_choice_from_any_computer_survives_the_update', async () => {
    // The person turned grouping off and on again on another computer, and this one pulled it while on version 2.
    const chose = hlc(NOW - 3 * DAY);
    server.put(live(GROUP, true, chose));
    await storedByVersion2({ [GROUP]: chose });
    await enable({ known: { [GROUP]: chose } });
    expect(await upgradeStoredSettings()).toBe(true);
    expect(await settingsItem.getValue()).toMatchObject({ version: SETTINGS_VERSION, display: { groupRuns: true } });
    expect((await settingsClocksItem.getValue())[GROUP]).toBe(chose);
    // Nothing to send, and the computers agree.
    expect(await run()).toMatchObject({ ok: true, pushed: 0 });
    expect((await readSettings()).display.groupRuns).toBe(true);

    // Turned off on a computer still on version 2: it applies here.
    server.put(live(GROUP, false, hlc(NOW - DAY)));
    expect(await run()).toMatchObject({ ok: true, pushed: 0 });
    expect((await readSettings()).display.groupRuns).toBe(false);
  });
});

describe('push', () => {
  it('test_local_edit_pushed_and_known', async () => {
    expect(await run()).toMatchObject({ ok: true });
    await updateSettings((s) => {
      s.display.showAuthor = false;
    });
    const stamp = (await settingsClocksItem.getValue())['display.showAuthor'];

    expect(await run()).toStrictEqual({ ok: true, pulled: 0, pushed: 1 });
    const bodies = server.pushBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.items).toStrictEqual([live('display.showAuthor', false, stamp ?? '')]);
    expect((await state()).known['display.showAuthor']).toBe(stamp);
    expect(server.item('display.showAuthor')).toMatchObject({ value: false, hlc: stamp });
  });

  it('test_push_retry_keeps_push_id', async () => {
    await updateSettings((s) => {
      s.display.showAuthor = false;
    });
    server.failNext(SYNC_PUSH_PATH, 'network');
    expect(await run()).toMatchObject({ ok: true, pushed: 1 });
    const [a, b] = server.pushBodies();
    expect(a?.pushId).toBe(b?.pushId);

    await updateSettings((s) => {
      s.display.tips = false;
    });
    server.failNext(SYNC_PUSH_PATH, 'network', 2);
    expect(await run()).toStrictEqual({ ok: false, problem: 'network' });
    const [c, d] = server.pushBodies().slice(2);
    expect(c?.pushId).toBe(d?.pushId);
    expect(c?.pushId).not.toBe(a?.pushId);
    expect((await state()).problem).toBe('network');
  });

  it('test_push_rejections', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    await updateSettings((s) => {
      s.display.showAuthor = false;
      s.display.tips = false;
    });
    server.reject('display.showAuthor', 'clock-ahead');
    server.reject('display.tips', 'invalid');

    expect(await run()).toStrictEqual({ ok: false, problem: 'clock' });
    const { known, problem } = await state();
    expect(problem).toBe('clock');
    expect(known).not.toHaveProperty(['display.showAuthor']);
    expect(known['display.tips']).toBe((await settingsClocksItem.getValue())['display.tips']);
    expect(debug).toHaveBeenCalledWith('[unAlgorithm] sync rejected', 1);

    expect(await run()).toStrictEqual({ ok: false, problem: 'clock' });
    expect(server.pushBodies()[1]?.items.map((i) => i.key)).toStrictEqual(['display.showAuthor']);
  });

  it('test_future_clocks_restamped_after_clock_fix', async () => {
    server = createFakeSyncServer({ now: () => NOW });
    deps = makeDeps(server);
    const at = (ms: number) => {
      vi.setSystemTime(ms);
      return { now: () => ms };
    };

    // An edit stamped a few minutes ahead, within the bound: accepted, and kept later.
    let clock = at(NOW + 5 * 60_000);
    await updateSettings((s) => {
      s.display.showReason = false;
    });
    expect(await run({}, clock)).toMatchObject({ ok: true, pushed: 1 });
    const kept = (await settingsClocksItem.getValue())['display.showReason'] ?? '';

    // A day ahead: the edit is refused, and while the clock is still wrong nothing is re-stamped.
    clock = at(NOW + DAY);
    await updateSettings((s) => {
      s.display.showAuthor = false;
    });
    const ahead = (await settingsClocksItem.getValue())['display.showAuthor'] ?? '';
    expect(hlcMs(ahead)).toBe(NOW + DAY);
    expect(await run({}, clock)).toStrictEqual({ ok: false, problem: 'clock' });
    expect((await state()).known).not.toHaveProperty(['display.showAuthor']);
    expect(await run({}, clock)).toStrictEqual({ ok: false, problem: 'clock' });
    expect((await settingsClocksItem.getValue())['display.showAuthor']).toBe(ahead);

    // Back to real time: only the clock beyond the bound gets a fresh stamp, and it is pushed.
    clock = at(NOW);
    expect(await run({}, clock)).toStrictEqual({ ok: true, pulled: 0, pushed: 1 });
    const clocks = await settingsClocksItem.getValue();
    expect(clocks['display.showAuthor']).toBe(hlc(NOW, LOCAL));
    expect(clocks['display.showReason']).toBe(kept);
    const newest = Object.values(clocks).sort().at(-1);
    expect(await lastHlcItem.getValue()).toBe(newest);
    expect(Object.values(clocks).every((c) => hlcMs(c) <= NOW + SYNC_MAX_HLC_AHEAD_MS)).toBe(true);
    expect(server.item('display.showAuthor')).toMatchObject({ hlc: hlc(NOW, LOCAL), value: false });
    const st = await state();
    expect(st.problem).toBeNull();
    expect(st.known['display.showAuthor']).toBe(hlc(NOW, LOCAL));
  });

  it('test_slow_clock_keeps_received_stamps', async () => {
    // The server and another computer have the right time; this computer runs an hour slow.
    server = createFakeSyncServer({ now: () => NOW });
    deps = makeDeps(server);
    const slow = NOW - 3600_000;
    vi.setSystemTime(slow);
    const clock = { now: () => slow };
    server.put(live('display.mode', 'hide', hlc(NOW)));
    expect(await run({}, clock)).toMatchObject({ ok: true, pulled: 1 });
    expect(await run({}, clock)).toMatchObject({ ok: true });
    // A stamp the server accepted is never re-stamped here: only stamps it refused as clock-ahead are.
    expect((await settingsClocksItem.getValue())['display.mode']).toBe(hlc(NOW));

    // Edited here after the other computer's edit: the HLC stamps it above the received stamp, so it wins everywhere.
    await updateSettings((s) => {
      s.display.mode = 'dim';
    });
    expect(await run({}, clock)).toMatchObject({ ok: true, pushed: 1 });
    expect(server.item('display.mode')).toMatchObject({ value: 'dim', hlc: hlc(NOW, LOCAL, 1) });
    expect((await settingsClocksItem.getValue())['display.mode']).toBe(hlc(NOW, LOCAL, 1));
  });
});

describe('resync and errors', () => {
  it('test_resync_after_410_drops_old_entries', async () => {
    expect(await run()).toMatchObject({ ok: true });
    const firstEpoch = server.epoch;
    const old = hlc(NOW - 9000, LOCAL);
    const recent = hlc(NOW - 1000, LOCAL);
    // Both were pushed once; another device deleted them, and the tombstones were cleaned up.
    await seedLocal(
      (s) => {
        s.interests.more.old = topic('Old');
        s.interests.more.recent = topic('Recent');
      },
      { 'interests.more.old': old, 'interests.more.recent': recent },
    );
    await syncStateItem.setValue({
      ...(await state()),
      known: { 'interests.more.old': old, 'interests.more.recent': recent },
    });
    server.newEpoch(hlc(NOW - 5000));

    expect(await run()).toMatchObject({ ok: true, pushed: 1 });
    const paths = server.calls.slice(2).map((c) => c.path);
    expect(paths).toStrictEqual([SYNC_CHANGES_PATH, SYNC_SPACES_PATH, SYNC_CHANGES_PATH, SYNC_PUSH_PATH]);
    const [refused, again] = server.changesCalls().slice(1);
    expect(refused?.query.epoch).toBe(firstEpoch);
    expect(again?.query).toMatchObject({ epoch: server.epoch, since: '0' });
    const more = (await readSettings()).interests.more;
    expect(more).not.toHaveProperty('old');
    expect(more.recent).toStrictEqual(topic('Recent'));
    expect(await settingsClocksItem.getValue()).not.toHaveProperty(['interests.more.old']);
    expect(pushedKeys()).toStrictEqual(['interests.more.recent']);
    expect((await state()).epoch).toBe(server.epoch);

    // A second 410 in the same run is a server problem.
    server.failNext(SYNC_CHANGES_PATH, { status: 410, body: { code: 'resync-required', message: '' } }, 2);
    expect(await run()).toStrictEqual({ ok: false, problem: 'server' });
  });

  it('test_interrupted_resync_drops_on_next_run_and_keeps_unsent_entries', async () => {
    expect(await run()).toMatchObject({ ok: true });
    const old = hlc(NOW - 9000, LOCAL);
    // Added while this computer could not sync: older than the cleaned-up deletion, but never on the server.
    const offline = hlc(NOW - 8000, LOCAL);
    await seedLocal(
      (s) => {
        s.interests.more.old = topic('Old');
        s.interests.more.offline = topic('Offline');
      },
      { 'interests.more.old': old, 'interests.more.offline': offline },
    );
    await syncStateItem.setValue({ ...(await state()), known: { 'interests.more.old': old } });
    server.newEpoch(hlc(NOW - 5000));

    // The 410, then the download from 0 fails: the run ends before it could drop anything.
    server.failNext(SYNC_CHANGES_PATH, { status: 410, body: { code: 'resync-required', message: '' } });
    server.failNext(SYNC_CHANGES_PATH, 'network');
    expect(await run()).toStrictEqual({ ok: false, problem: 'network' });
    expect(pushedKeys()).toStrictEqual([]);

    // The next run finishes the resync: the entry deleted elsewhere goes, the one that never reached the server stays.
    expect(await run()).toMatchObject({ ok: true, pushed: 1 });
    const more = (await readSettings()).interests.more;
    expect(more).not.toHaveProperty('old');
    expect(more.offline).toStrictEqual(topic('Offline'));
    expect(pushedKeys()).toStrictEqual(['interests.more.offline']);
    expect(server.item('interests.more.old')).toBeUndefined();
    expect((await state()).resyncKnown).toBeNull();
  });

  it('test_sync_http_problems', async () => {
    // One 401: one forced refresh and a retry.
    server.failNext(SYNC_SPACES_PATH, { status: 401 });
    expect(await run()).toMatchObject({ ok: true });
    expect(deps.getAccessToken).toHaveBeenCalledWith(ORIGIN, { forceRefresh: true });
    expect(deps.getAccessToken.mock.calls.filter((c) => c[1]?.forceRefresh)).toHaveLength(1);

    // 413 on the push.
    await updateSettings((s) => {
      s.display.tips = false;
    });
    server.failNext(SYNC_PUSH_PATH, { status: 413, body: { code: 'quota-exceeded', message: 'Full.' } });
    expect(await run()).toStrictEqual({ ok: false, problem: 'quota' });
    expect((await state()).problem).toBe('quota');

    // 429 and 5xx.
    server.failNext(SYNC_CHANGES_PATH, { status: 429, body: { code: 'rate-limited', message: 'Slow down.' } });
    expect(await run()).toStrictEqual({ ok: false, problem: 'server' });

    // The caller's own signal: no problem written.
    expect(await run()).toMatchObject({ ok: true });
    const aborted = new AbortController();
    aborted.abort();
    expect(await run({ signal: aborted.signal })).toStrictEqual({ ok: false, problem: 'network', aborted: true });
    expect((await state()).problem).toBeNull();

    // Two 401s: the account is marked, and the next run asks to sign in again without a request.
    server.failNext(SYNC_CHANGES_PATH, { status: 401 }, 2);
    expect(await run()).toStrictEqual({ ok: false, problem: 'auth' });
    expect(deps.markNeedsSignIn).toHaveBeenCalledWith(ORIGIN);
    expect((await serverAccountItem.getValue())?.needsSignIn).toBe(true);
    const requests = server.calls.length;
    expect(await run()).toStrictEqual({ ok: false, problem: 'auth' });
    expect(server.calls).toHaveLength(requests);
    expect((await state()).problem).toBe('auth');

    // A server without sync.
    fakeBrowser.reset();
    await deviceItem.setValue(defaultDevice(LOCAL));
    await serverAccountItem.setValue(account());
    await enable();
    const noSync = createFakeSyncServer({ noSync: true });
    expect(await run({}, { fetch: noSync.fetch })).toStrictEqual({ ok: false, problem: 'unavailable' });
    expect(noSync.calls.map((c) => c.path)).toStrictEqual([SYNC_SPACES_PATH]);
    expect((await state()).problem).toBe('unavailable');
  });

  it('test_account_switch_resets_state', async () => {
    server.put(live('display.mode', 'hide', hlc(NOW - 1000)));
    for (const next of [account({ origin: 'https://other.example.org' }), account({ email: 'grace@example.org' })]) {
      await enable();
      expect(await run()).toMatchObject({ ok: true });
      expect((await state()).spaceId).not.toBeNull();
      await serverAccountItem.setValue(next);
      const requests = server.calls.length;

      expect(await run()).toStrictEqual({ ok: false, problem: 'unavailable' });
      expect(await state()).toStrictEqual({ ...DEFAULT_SYNC_STATE, origin: next.origin, email: next.email });
      expect(await run()).toStrictEqual({ ok: false, problem: 'unavailable' });
      expect(server.calls).toHaveLength(requests);
      await serverAccountItem.setValue(account());
    }
  });

  it('test_gone_space_refetched', async () => {
    await updateSettings((s) => {
      s.display.tips = false;
    });
    expect(await run()).toMatchObject({ ok: true, pushed: 1 });
    const oldSpace = server.spaceId;
    server.replaceSpace();
    server.put(live('display.mode', 'hide', hlc(NOW - 1000)));

    expect(await run()).toStrictEqual({ ok: true, pulled: 1, pushed: 1 });
    const changes = server.changesCalls().slice(1);
    expect(changes.map((c) => [c.query.spaceId, c.query.since])).toStrictEqual([
      [oldSpace, '0'],
      [server.spaceId, '0'],
    ]);
    const st = await state();
    expect(st.spaceId).toBe(server.spaceId);
    // `known` started over, so the edit the old space held is pushed to the new one.
    expect(server.item('display.tips')).toMatchObject({ value: false });
    expect((await readSettings()).display.mode).toBe('hide');

    const notFound = { status: 404, body: { code: 'not-found', message: 'No such space.' } };
    server.failNext(SYNC_CHANGES_PATH, notFound, 2);
    expect(await run()).toStrictEqual({ ok: false, problem: 'server' });
  });
});

describe('settings lock', () => {
  /** Web Locks as the browser shares them between an extension's pages and its worker: one queue per name. */
  function fakeLocks() {
    const tails = new Map<string, Promise<unknown>>();
    const request = vi.fn((name: string, fn: (lock: unknown) => Promise<unknown>) => {
      const run = (tails.get(name) ?? Promise.resolve()).then(() => fn({ name, mode: 'exclusive' }));
      tails.set(
        name,
        run.catch(() => undefined),
      );
      return run;
    });
    return { request, query: vi.fn() };
  }

  const remoteMode = (s: Settings, c: SettingsClocks) => {
    const r = applyRemoteItems(s, c, [live('display.mode', 'hide', hlc(NOW - 1000))]);
    return r.ok ? r : null;
  };

  async function expectBoth() {
    const s = await readSettings();
    expect(s.display.showAuthor).toBe(false);
    expect(s.display.mode).toBe('hide');
    const clocks = await settingsClocksItem.getValue();
    expect(clocks['display.mode']).toBe(hlc(NOW - 1000));
    expect(clocks['display.showAuthor']).toBeDefined();
  }

  it('test_settings_lock_shared_with_pages', async () => {
    const locks = fakeLocks();
    Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
    try {
      vi.resetModules();
      const page = await import('../src/lib/settings-store.ts');
      vi.resetModules();
      const background = await import('../src/lib/settings-store.ts');
      expect(page.updateSettings).not.toBe(background.updateSettings);
      await Promise.all([
        page.updateSettings((s) => {
          s.display.showAuthor = false;
        }),
        background.applyRemoteSettings(remoteMode),
      ]);
      await expectBoth();
      expect(locks.request).toHaveBeenCalledTimes(2);
      expect(locks.request.mock.calls.map((c) => c[0])).toStrictEqual(['ua-settings', 'ua-settings']);
    } finally {
      Reflect.deleteProperty(navigator, 'locks');
    }

    // Without Web Locks (jsdom), both use the module lock.
    fakeBrowser.reset();
    await deviceItem.setValue(defaultDevice(LOCAL));
    expect(navigator.locks).toBeUndefined();
    await Promise.all([
      updateSettings((s) => {
        s.display.showAuthor = false;
      }),
      applyRemoteSettings(remoteMode),
    ]);
    await expectBoth();
  });
});

describe('privacy', () => {
  it('test_sync_payloads_never_carry_keys_or_tokens', async () => {
    const anthropicKey = `sk-ant-api03-${'abcdefghij'.repeat(3)}`;
    const bearer = 'compat-bearer-marker-55c1';
    const refresh = 'refresh-token-marker-91d2';
    const pastedKey = `sk-ant-api03-${'zyxwvutsrq'.repeat(3)}`;
    await setSecret('anthropic', anthropicKey);
    await setSecret('compat:http://localhost:11434', bearer);
    await setSecret(`server-refresh:${ORIGIN}`, refresh);
    await deviceItem.setValue({ ...defaultDevice(LOCAL), aiSource: { kind: 'anthropic', model: null } });
    await learnedItem.setValue({ weights: { 'learned-marker-topic': 2 }, events: [], decayedAt: 0 });
    await votesItem.setValue({ 'vote-marker-post': 'more' });
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    server.put(live('display.mode', 'hide', hlc(NOW - 1000)));

    await updateSettings((s) => {
      s.display.showAuthor = false;
      s.interests.about = `I work on ${pastedKey} things`;
      s.interests.more.ai = topic('AI');
    });
    expect(await run()).toMatchObject({ ok: true, pushed: 2 });

    const secrets = [anthropicKey, pastedKey, bearer, refresh, TOKEN];
    const forbidden = [...secrets, 'aiSource', 'server-refresh', 'deviceId', 'learned-marker', 'vote-marker'];
    expect(server.calls.length).toBeGreaterThan(2);
    for (const call of server.calls) {
      for (const marker of forbidden) {
        expect(call.url).not.toContain(marker);
        expect(call.rawBody ?? '').not.toContain(marker);
      }
      expect(call.authorization).toBe(`Bearer ${TOKEN}`);
    }
    const pushed = server.pushBodies().flatMap((b) => b.items);
    expect(pushed.map((i) => i.key).sort()).toStrictEqual(['display.showAuthor', 'interests.more.ai']);
    expect(pushed.every(validateSettingsItem)).toBe(true);
  });
});
