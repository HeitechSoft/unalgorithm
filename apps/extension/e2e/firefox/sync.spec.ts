import type { Settings } from '@unalgorithm/core';
import { ACCOUNT_DEVICE_REVOKE_PATH, ACCOUNT_PAGE_PATH, SYNC_PUSH_PATH, SyncPushRequestSchema } from '@unalgorithm/protocol';
import type { Page } from 'puppeteer-core';
import { useLocalServer } from '../server-lifecycle.ts';
import {
  aria,
  click,
  count,
  type FirefoxProfile,
  firefoxDeviceName,
  launchFirefox,
  pageText,
  reload,
  send,
  visible,
} from './driver.ts';
import {
  allowLocal,
  expect,
  expectAccessible,
  expectDialogTrapsFocus,
  GRANT_REQUESTS,
  keepTechnicalData,
  signInFromSettings,
  test,
} from './fixtures.ts';

/**
 * Settings sync in Firefox (CL3, ADR 0008), as `../sync.spec.ts` checks Chromium and Edge: two Firefox profiles with
 * the add-on sign in to one real server as the same person, turn sync on and keep each other's changes, while keys and
 * tokens stay on each computer; the devices list names a "Firefox on Linux", which kept Firefox's technical and
 * interaction data, and shows b, which didn't, unnamed, and b revokes a. Each profile has its own random moz-extension
 * origin and its own proxy, which records what it sent. Needs Postgres and Mailpit and the built `apps/web`, so it runs
 * only with `UA_SERVER_E2E=1`.
 */
const EMAIL = 'tester@example.com';
const SWITCH = 'Sync settings between your computers';
const SYNC_PREFIX = '/v1/sync/';
/** An Anthropic-shaped key saved on a: it must never travel in a sync request. */
const API_KEY = `sk-ant-api03-E2E${'A'.repeat(40)}`;
/** Device-local fields and the refresh token's store key: never in a sync request. */
const NEVER_SYNCED = ['aiSource', 'server-refresh', 'deviceId'];
const TOPIC_ID = 'e2e-gardening';
const PERSON_ID = 'e2e-ann';
/** How long a change may take to reach the other profile. */
const CONVERGE = { timeout: 15_000 };

interface Profile {
  name: 'a' | 'b';
  firefox: FirefoxProfile;
  /** The options page the sign-in left on the AI pane; it stays open, so the long-poll loop runs. */
  options: Page;
}

interface SyncStatusAnswer {
  enabled: boolean;
  state: 'off' | 'syncing' | 'ok' | 'problem';
  problem?: string;
}

test.describe
  .serial('two Firefox profiles', () => {
    // First, so beforeAll starts nothing where there is no Postgres: the tests are reported as skipped.
    test.skip(process.env.UA_SERVER_E2E !== '1', 'needs Postgres and Mailpit');

    const profiles: Partial<Record<Profile['name'], FirefoxProfile>> = {};
    let a: Profile;
    let b: Profile;

    test.beforeAll(async () => {
      profiles.a = await launchFirefox({ prefs: GRANT_REQUESTS });
      profiles.b = await launchFirefox({ prefs: GRANT_REQUESTS });
    });

    // Declared before the server's, so both profiles close first, also when a test failed.
    test.afterAll(async () => {
      const closing = await Promise.allSettled(Object.values(profiles).map((p) => p.close()));
      for (const result of closing) if (result.status === 'rejected') throw result.reason;
    });

    const started = useLocalServer();

    test('test_firefox_two_profiles_turn_on_sync', async () => {
      test.setTimeout(180_000);
      const { server } = started();
      const signIn = async (name: Profile['name']): Promise<Profile> => {
        const firefox = profiles[name] as FirefoxProfile;
        allowLocal(firefox);
        // a as a person who left Firefox's install choice on; b as one who turned it off.
        if (name === 'a') await keepTechnicalData(firefox);
        return { name, firefox, options: await signInFromSettings(firefox, server.url, EMAIL) };
      };
      a = await signIn('a');
      b = await signIn('b');
      // Two installs, two random origins: the server's CORS answers each.
      expect(a.firefox.base).not.toBe(b.firefox.base);

      // The switch asks first; the dialog keeps Tab inside, and Escape closes it with sync still off and nothing sent.
      const toggle = aria('switch', SWITCH);
      expect(await checked(a.options, toggle)).toBe('false');
      await expectDialogTrapsFocus(a.options, toggle, 2);
      expect(await syncStatus(a)).toMatchObject({ enabled: false });
      expect(syncRequests(a)).toEqual([]);

      await click(a.options, toggle);
      await visible(a.options, aria('alertdialog', 'Turn on sync?'));
      await click(a.options, aria('button', 'Turn on sync'));
      await send(b.options, { type: 'syncSetEnabled', enabled: true });

      for (const p of [a, b]) await expect.poll(() => syncStatus(p), CONVERGE).toMatchObject({ enabled: true, state: 'ok' });
    });

    test('test_firefox_strength_change_reaches_other_profile', async () => {
      expect((await settingsOf(b))?.platforms.linkedin.preset).not.toBe('calm');
      await act(a, { op: 'setPreset', platform: 'linkedin', preset: 'calm' });
      await expect.poll(async () => (await settingsOf(b))?.platforms.linkedin.preset, CONVERGE).toBe('calm');
    });

    test('test_firefox_concurrent_edits_both_survive', async () => {
      test.setTimeout(60_000);
      // b cannot reach the sync routes: the newest route is asked first, so this one wins over allowLocal's.
      const online = b.firefox.proxy.route(/^http:\/\/127\.0\.0\.1:\d+\/v1\/sync\//, () => 'abort');
      await act(a, {
        op: 'addTopic',
        list: 'more',
        id: TOPIC_ID,
        topic: { label: 'Gardening', keywords: ['gardening'], addedAt: Date.now() },
      });
      await act(b, {
        op: 'addPersonRule',
        platform: 'linkedin',
        list: 'alwaysHide',
        id: PERSON_ID,
        rule: { label: 'Ann Example', match: 'li:in:ann-example', addedAt: Date.now() },
      });
      online();
      await send(b.options, { type: 'syncNow' });

      for (const p of [a, b]) {
        await expect
          .poll(async () => {
            const settings = await settingsOf(p);
            return {
              topic: settings?.interests.more[TOPIC_ID]?.label,
              person: settings?.platforms.linkedin.alwaysHide[PERSON_ID]?.match,
            };
          }, CONVERGE)
          .toEqual({ topic: 'Gardening', person: 'li:in:ann-example' });
      }
      const more = (await settingsOf(a))?.interests.more ?? {};
      expect(Object.entries(more).filter(([id, topic]) => id === TOPIC_ID || topic.label === 'Gardening')).toHaveLength(1);
    });

    test('test_firefox_sync_payloads_never_carry_keys_or_tokens', async () => {
      const { server } = started();
      expect(
        await send(a.options, { type: 'saveSource', config: { kind: 'anthropic', model: null }, apiKey: API_KEY }),
      ).toMatchObject({
        ok: true,
      });

      // One more edit on a, after the key is stored, and the push it causes.
      const pushesFromA = () => syncRequests(a).filter((r) => pathOf(r.url) === SYNC_PUSH_PATH).length;
      const before = pushesFromA();
      const reels = (await settingsOf(a))?.platforms.linkedin.filters.reels;
      await act(a, { op: 'setFilter', platform: 'linkedin', key: 'reels', value: !reels });
      await expect.poll(pushesFromA, CONVERGE).toBeGreaterThan(before);

      const refreshToken = await refreshTokenOf(a, server.url);
      expect(refreshToken).toEqual(expect.any(String));
      const secrets = [API_KEY, refreshToken as string, ...NEVER_SYNCED];

      // Every sync request since the start of the file, from both profiles, as their proxies saw them.
      const sync = [...syncRequests(a), ...syncRequests(b)];
      const pushes = sync.filter((r) => pathOf(r.url) === SYNC_PUSH_PATH);
      expect(syncRequests(b).some((r) => pathOf(r.url) === SYNC_PUSH_PATH)).toBe(true);
      for (const push of pushes) {
        expect(() => SyncPushRequestSchema.parse(JSON.parse(push.body))).not.toThrow();
        for (const secret of secrets) expect(push.body).not.toContain(secret);
      }
      for (const request of sync) for (const secret of secrets) expect(request.url).not.toContain(secret);

      // Back to the server as a's AI source.
      expect(await send(a.options, { type: 'saveSource', config: { kind: 'server', baseUrl: server.url } })).toMatchObject({
        ok: true,
      });
    });

    test('test_firefox_device_names_follow_technical_data', async () => {
      const { server } = started();
      const name = firefoxDeviceName();
      // Settings → AI on b: a by its Firefox name, and b, this computer, unnamed: it signed in without technical and
      // interaction data, and works the same.
      await reload(b.options);
      await expect
        .poll(() => deviceRows(b.options))
        .toEqual(expect.arrayContaining([expect.stringContaining('This computer'), expect.stringContaining('Last used')]));
      const rows = await deviceRows(b.options);
      expect(rows).toHaveLength(2);
      const mine = rows.find((row) => row.includes('This computer'));
      const other = rows.find((row) => row.includes('Last used'));
      expect(mine).toContain('Unnamed device');
      expect(mine).not.toContain(name);
      expect(other).toContain(name);

      // The account page (a holds the web session from signing in): one "Revoke" per device row.
      const page = await a.firefox.browser.newPage();
      await page.goto(`${server.url}${ACCOUNT_PAGE_PATH}`);
      await expect.poll(() => pageText(page)).toContain(`Signed in as ${EMAIL}`);
      expect(await count(page, aria('button', 'Revoke'))).toBe(2);
      const text = await pageText(page);
      expect(text).toContain(name);
      expect(text).toContain('Unnamed device');
      await expectAccessible(page);
      await page.close();
    });

    test('test_firefox_revoked_profile_must_sign_in_again', async () => {
      test.setTimeout(60_000);
      const { server } = started();
      const revoke = aria('button', `Revoke ${firefoxDeviceName()}`);
      expect(await count(b.options, revoke)).toBe(1);

      // The revoke dialog keeps Tab inside and closes on Escape without a revoke request.
      const revokeRequests = () => b.firefox.proxy.requests.filter((r) => pathOf(r.url) === ACCOUNT_DEVICE_REVOKE_PATH);
      await expectDialogTrapsFocus(b.options, revoke, 2);
      expect(revokeRequests()).toEqual([]);

      await click(b.options, revoke);
      await visible(b.options, aria('alertdialog', `Revoke ${firefoxDeviceName()}?`));
      await click(b.options, aria('button', 'Revoke'));
      await expect.poll(() => pageText(b.options)).toContain('Revoked.');
      expect(revokeRequests()).toHaveLength(1);

      // a finds out at its next sync, and its server card asks it to sign in again.
      await expect
        .poll(async () => (await send<SyncStatusAnswer>(a.options, { type: 'syncNow' })).problem, CONVERGE)
        .toBe('auth');
      await reload(a.options);
      await expect.poll(() => pageText(a.options)).toContain(`Sign in to ${new URL(server.url).host} again.`);
    });
  });

/** Every request the profile sent to a sync route. */
function syncRequests(p: Profile) {
  return p.firefox.proxy.requests.filter((r) => r.url.startsWith('http://127.0.0.1:') && pathOf(r.url).startsWith(SYNC_PREFIX));
}

function syncStatus(p: Profile): Promise<SyncStatusAnswer> {
  return send<SyncStatusAnswer>(p.options, { type: 'syncStatus' });
}

/** A settings change made the way the extension makes it, stamping its clocks (CL1-18). */
async function act(p: Profile, action: object): Promise<void> {
  expect(await send(p.options, { type: 'settingsAction', action })).toMatchObject({ ok: true });
}

function settingsOf(p: Profile): Promise<Settings | undefined> {
  return p.options.evaluate(async () => (await chrome.storage.local.get('settings')).settings as Settings | undefined);
}

/** `aria-checked` of the element matching `selector`. */
async function checked(page: Page, selector: string): Promise<string | null> {
  const handle = await page.waitForSelector(selector);
  return (await handle?.evaluate((el) => el.getAttribute('aria-checked'))) ?? null;
}

/**
 * The rows of the "Devices signed in to …" group, as text. The innermost group with that heading: the AI pane's own
 * list group holds the server card, and with it the devices group.
 */
function deviceRows(options: Page): Promise<string[]> {
  return options.evaluate(() => {
    const groups = [...document.querySelectorAll('.ua-group')].filter(
      (g) =>
        [...g.querySelectorAll('h1, h2, h3, h4, [role="heading"]')].some((h) =>
          h.textContent?.startsWith('Devices signed in to '),
        ) && !g.querySelector('.ua-group'),
    );
    return [...(groups[0]?.querySelectorAll('.ua-row') ?? [])].map((row) => (row as HTMLElement).innerText);
  });
}

/** The refresh token the background keeps for the server, read from the extension's own IndexedDB. */
function refreshTokenOf(p: Profile, serverUrl: string): Promise<unknown> {
  return p.options.evaluate(
    (key) =>
      new Promise<unknown>((resolve, reject) => {
        const open = indexedDB.open('unalgorithm');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const get = db.transaction('secrets', 'readonly').objectStore('secrets').get(key);
          get.onsuccess = () => {
            db.close();
            resolve(get.result);
          };
          get.onerror = () => reject(get.error);
        };
      }),
    `server-refresh:${serverUrl}`,
  );
}

function pathOf(url: string): string {
  return new URL(url).pathname;
}
