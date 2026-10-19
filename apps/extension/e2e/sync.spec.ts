import type { BrowserContext, Page, Route } from '@playwright/test';
import type { Settings } from '@unalgorithm/core';
import { ACCOUNT_DEVICE_REVOKE_PATH, ACCOUNT_PAGE_PATH, SYNC_PUSH_PATH, SyncPushRequestSchema } from '@unalgorithm/protocol';
import { expect, extensionIdOf, launchExtensionContext, test, unaskedReports } from './fixtures.ts';
import { useLocalServer } from './server-lifecycle.ts';
import { allowServer, expectAccessible, expectDialogTrapsFocus, signInFromSettings } from './server-sign-in.ts';

/**
 * Settings sync end to end (CL3): two browser profiles with the real extension sign in to one real server process as
 * the same person, turn sync on, and keep each other's changes, while keys and tokens stay on each computer; one
 * profile then revokes the other. Like `cloud.spec.ts` it needs Postgres and Mailpit and the built `apps/web`, so it
 * runs only with `UA_SERVER_E2E=1`.
 */
const EMAIL = 'tester@example.com';
const SWITCH = 'Sync settings between your computers';
/** Every sync route of the local server (spaces, changes, push). */
const SYNC_ROUTES = 'http://127.0.0.1:*/v1/sync/**';
const SYNC_PREFIX = '/v1/sync/';
/** An Anthropic-shaped key saved on a: it must never travel in a sync request. */
const API_KEY = `sk-ant-api03-E2E${'A'.repeat(40)}`;
/** Device-local fields and the refresh token's store key: never in a sync request. */
const NEVER_SYNCED = ['aiSource', 'server-refresh', 'deviceId'];
const TOPIC_ID = 'e2e-gardening';
const PERSON_ID = 'e2e-ann';
/** How long a change may take to reach the other profile. */
const CONVERGE = { timeout: 15_000 };

/** One browser profile with the extension, and every request it sent to the local server (URL and body). */
interface Profile {
  name: 'a' | 'b';
  context: BrowserContext;
  extensionId: string;
  requests: { url: string; body: string }[];
}

/** `syncStatus`, `syncSetEnabled` and `syncNow` answer with the sync status (CL3-20); the fields read here. */
interface SyncStatusAnswer {
  enabled: boolean;
  state: 'off' | 'syncing' | 'ok' | 'problem';
  problem?: string;
}

test.describe
  .serial('two browser profiles', () => {
    // First, so beforeAll starts no server where there is no Postgres: the six tests are reported as skipped.
    test.skip(process.env.UA_SERVER_E2E !== '1', 'needs Postgres and Mailpit');

    let a: Profile;
    let b: Profile;

    test.beforeAll(async ({ extensionBrowser }) => {
      const launch = async (name: Profile['name']): Promise<Profile> => {
        const context = await launchExtensionContext(extensionBrowser);
        return { name, context, extensionId: await extensionIdOf(context), requests: [] };
      };
      a = await launch('a');
      b = await launch('b');
    });

    // Declared before the server's, so both profiles close first, also when a test failed.
    test.afterAll(async () => {
      // No problem report without a Send click (ADR 0009 §1), as the `context` fixture checks its own; read before the
      // profiles close, and checked after.
      const unasked = [a, b].flatMap((p) => (p ? unaskedReports(p.context) : []));
      const closing = await Promise.allSettled([a?.context.close(), b?.context.close()]);
      for (const result of closing) if (result.status === 'rejected') throw result.reason;
      expect(unasked, `problem reports sent without a Send click:\n${unasked.join('\n')}`).toEqual([]);
    });

    // The server and its mock AI provider; afterAll checks the process exited and the run's database is dropped.
    const started = useLocalServer();

    test('test_two_profiles_turn_on_sync', async () => {
      test.setTimeout(150_000);
      const { server } = started();
      for (const p of [a, b]) {
        await allowServer(p.context, p.extensionId, (url, body) => p.requests.push({ url, body }));
        await signInFromSettings(p.context, p.extensionId, server.url, EMAIL);
      }

      // The switch asks first; the dialog keeps Tab inside, and Escape closes it with sync still off and nothing sent.
      const options = optionsOf(a);
      const toggle = options.getByRole('switch', { name: SWITCH });
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expectDialogTrapsFocus(options, toggle, 2);
      expect(await syncStatus(a)).toMatchObject({ enabled: false });
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      expect(a.requests.filter((r) => isSync(r.url))).toEqual([]);

      await toggle.click();
      const ask = options.getByRole('alertdialog', { name: 'Turn on sync?' });
      await expect(ask).toBeVisible();
      await ask.getByRole('button', { name: 'Turn on sync', exact: true }).click();
      await send(b, { type: 'syncSetEnabled', enabled: true });

      for (const p of [a, b]) await expect.poll(() => syncStatus(p), CONVERGE).toMatchObject({ enabled: true, state: 'ok' });
    });

    test('test_strength_change_reaches_other_profile', async () => {
      expect((await settingsOf(b))?.platforms.linkedin.preset).not.toBe('calm');
      await act(a, { op: 'setPreset', platform: 'linkedin', preset: 'calm' });
      await expect.poll(async () => (await settingsOf(b))?.platforms.linkedin.preset, CONVERGE).toBe('calm');
    });

    test('test_concurrent_edits_both_survive', async () => {
      test.setTimeout(60_000);
      // b cannot reach the sync routes: registered last, this route wins over allowServer's.
      const offline = (route: Route) => route.abort();
      await b.context.route(SYNC_ROUTES, offline);
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
      await b.context.unroute(SYNC_ROUTES, offline);
      await send(b, { type: 'syncNow' });

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

    test('test_sync_payloads_never_carry_keys_or_tokens', async () => {
      const { server } = started();
      const saved = await send(a, { type: 'saveSource', config: { kind: 'anthropic', model: null }, apiKey: API_KEY });
      expect(saved).toMatchObject({ ok: true });

      // One more edit on a, after the key is stored, and the push it causes.
      const pushesFromA = () => a.requests.filter((r) => pathOf(r.url) === SYNC_PUSH_PATH).length;
      const before = pushesFromA();
      const reels = (await settingsOf(a))?.platforms.linkedin.filters.reels;
      await act(a, { op: 'setFilter', platform: 'linkedin', key: 'reels', value: !reels });
      await expect.poll(pushesFromA, CONVERGE).toBeGreaterThan(before);

      const refreshToken = await refreshTokenOf(a, server.url);
      expect(refreshToken).toEqual(expect.any(String));
      const secrets = [API_KEY, refreshToken as string, ...NEVER_SYNCED];

      // Every sync request since the start of the file, from both profiles.
      const sync = [...a.requests, ...b.requests].filter((r) => isSync(r.url));
      const pushes = sync.filter((r) => pathOf(r.url) === SYNC_PUSH_PATH);
      expect(b.requests.some((r) => pathOf(r.url) === SYNC_PUSH_PATH)).toBe(true);
      for (const push of pushes) {
        expect(() => SyncPushRequestSchema.parse(JSON.parse(push.body))).not.toThrow();
        for (const secret of secrets) expect(push.body).not.toContain(secret);
      }
      for (const request of sync) for (const secret of secrets) expect(request.url).not.toContain(secret);

      // Back to the server as a's AI source: the server card, and with it the banner test 6 reads, shows only when selected.
      const restored = await send(a, { type: 'saveSource', config: { kind: 'server', baseUrl: server.url } });
      expect(restored).toMatchObject({ ok: true });
    });

    test('test_account_page_lists_both_devices', async () => {
      const { server } = started();
      // a holds the web session from signing in.
      const page = await a.context.newPage();
      await page.goto(`${server.url}${ACCOUNT_PAGE_PATH}`);
      await expect(page.getByText(`Signed in as ${EMAIL}`)).toBeVisible();
      // One "Revoke" per device row; a closed dialog's buttons are hidden.
      await expect(page.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(2);
      await expectAccessible(page);
      await page.close();
    });

    test('test_revoked_profile_must_sign_in_again', async () => {
      test.setTimeout(60_000);
      const { server } = started();
      const options = optionsOf(b);
      // The innermost group with that heading: the AI pane's own list group holds the server card, and with it the
      // Sync group's rows, so without `hasNot` its rows would be counted too.
      const devices = options
        .locator('.ua-group')
        .filter({ has: options.getByRole('heading', { name: /^Devices signed in to / }) })
        .filter({ hasNot: options.locator('.ua-group') });
      const rows = devices.locator('.ua-row');
      await expect(rows).toHaveCount(2);
      await expect(rows.filter({ hasText: 'This computer' })).toHaveCount(1);
      const revoke = rows.filter({ hasNotText: 'This computer' }).getByRole('button', { name: /^Revoke / });

      // The revoke dialog keeps Tab inside and closes on Escape without a revoke request.
      const revokeRequests = () => b.requests.filter((r) => pathOf(r.url) === ACCOUNT_DEVICE_REVOKE_PATH);
      await expectDialogTrapsFocus(options, revoke, 2);
      expect(revokeRequests()).toEqual([]);

      const label = await revoke.getAttribute('aria-label');
      await revoke.click();
      const confirm = options.getByRole('alertdialog', { name: `${label}?` });
      await expect(confirm).toBeVisible();
      await confirm.getByRole('button', { name: 'Revoke', exact: true }).click();
      await expect(options.getByText('Revoked.', { exact: true })).toBeVisible();
      expect(revokeRequests()).toHaveLength(1);

      // a finds out at its next sync, and its server card asks it to sign in again.
      await expect.poll(async () => (await send<SyncStatusAnswer>(a, { type: 'syncNow' })).problem, CONVERGE).toBe('auth');
      const optionsA = optionsOf(a);
      await optionsA.reload();
      await expect(optionsA).toHaveURL(/\/options\.html#\/ai$/);
      await expect(optionsA.getByText(`Sign in to ${new URL(server.url).host} again.`, { exact: true })).toBeVisible();
    });
  });

/** The options page `signInFromSettings` left open on the AI pane; it stays open, so the long-poll loop runs. */
function optionsOf(p: Profile): Page {
  const page = p.context.pages().find((candidate) => candidate.url().includes('/options.html'));
  if (!page) throw new Error(`profile ${p.name} has no options page`);
  return page;
}

/** A message to the profile's background from its options page, as the extension's own pages send them. */
function send<T = unknown>(p: Profile, message: object): Promise<T> {
  return optionsOf(p).evaluate((m) => chrome.runtime.sendMessage(m), message) as Promise<T>;
}

function syncStatus(p: Profile): Promise<SyncStatusAnswer> {
  return send<SyncStatusAnswer>(p, { type: 'syncStatus' });
}

/** A settings change made the way the extension makes it, stamping its clocks (CL1-18). */
async function act(p: Profile, action: object): Promise<void> {
  expect(await send(p, { type: 'settingsAction', action })).toMatchObject({ ok: true });
}

async function settingsOf(p: Profile): Promise<Settings | undefined> {
  return optionsOf(p).evaluate(async () => (await chrome.storage.local.get('settings')).settings as Settings | undefined);
}

/** The refresh token the background keeps for the server, read from the extension's own IndexedDB. */
function refreshTokenOf(p: Profile, serverUrl: string): Promise<unknown> {
  return optionsOf(p).evaluate(
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

function isSync(url: string): boolean {
  return pathOf(url).startsWith(SYNC_PREFIX);
}
