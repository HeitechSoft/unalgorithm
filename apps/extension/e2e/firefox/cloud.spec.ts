import {
  ACCOUNT_PAGE_PATH,
  AUTHORIZE_PAGE_PATH,
  CLASSIFY_PATH,
  ClassifyRequestSchema,
  EMAIL_OTP_METHOD,
  FIREFOX_DEV_ADDON_ID,
  geckoRedirectUri,
  MAX_POSTS_PER_REQUEST,
  REVOKE_PATH,
  SERVER_INFO_PATH,
  ServerInfoSchema,
  TOKEN_PATH,
  TokenRequestSchema,
} from '@unalgorithm/protocol';
import type { Page } from 'puppeteer-core';
import { FIRST_DEGREE_POST } from '../../../../packages/platforms/fixtures/linkedin/y2026.ts';
import { useLocalServer } from '../server-lifecycle.ts';
import {
  aria,
  click,
  count,
  type FirefoxProfile,
  fill,
  firefoxDeviceName,
  navigate,
  pageText,
  reload,
  send,
  text,
  visible,
} from './driver.ts';
import { allowLocal, expect, expectAccessible, grantedTypes, SERVER_CONSENT, signInFromSettings, test } from './fixtures.ts';

/**
 * unAlgorithm Cloud in Firefox (ADR 0008), as `../cloud.spec.ts` checks Chromium and Edge: the add-on signs in to a
 * real server process through Firefox's own sign-in window with an emailed code, and the fixture feed is labelled by
 * the mock AI provider through that server. The self-hosted group needs Postgres and Mailpit and the built `apps/web`,
 * so it runs only with `UA_SERVER_E2E=1`; the Cloud group needs nothing but the profile's proxy.
 */
const SKIP = process.env.UA_SERVER_E2E !== '1';
const NEEDS = 'needs Postgres and Mailpit';

const EMAIL = 'tester@example.com';
/** The first-degree fixture post's text and its author: the author never leaves the browser, the text never reaches a log. */
const POST_TEXT = 'Which HR task would you automate first';
const AUTHOR = 'Morgan Ellis';
const FRIEND = '[componentkey="update-card-focusEEEkeyFirstDegree5"]';
const CLOUD = 'https://cloud.unalgorithm.app';
/** The balance pill's accessible name starts so (CL2-12). */
const BALANCE_PILL = 'Credit balance:';

test.describe('a self-hosted server', () => {
  test.skip(SKIP, NEEDS);

  // useLocalServer's afterAll checks the process exited and the run's database is gone, also when a test failed.
  const started = useLocalServer();

  test('test_firefox_self_hosted_sign_in_and_labels', async ({ firefox, feed }) => {
    test.setTimeout(150_000);
    const { ai, server } = started();
    const { url, logs } = server;
    const host = new URL(url).host;
    expect(FIRST_DEGREE_POST).toContain(POST_TEXT);
    expect(FIRST_DEGREE_POST).toContain(AUTHOR);

    // The harness lists the Firefox development id, so discovery says Firefox may sign in.
    const info = ServerInfoSchema.parse(await (await fetch(`${url}${SERVER_INFO_PATH}`)).json());
    expect(info.auth.clients).toContain('gecko');

    const sent: { url: string; body: string }[] = [];
    allowLocal(firefox, (requestUrl, body) => sent.push({ url: requestUrl, body }));

    // Sign in from Settings in Firefox's sign-in window; the sign-in page is checked at its email and code steps.
    const options = await signInFromSettings(firefox, url, EMAIL, (step, page) =>
      test.step(`test_firefox_authorize_page_accessibility (${step} step)`, () => expectAccessible(page)),
    );

    // The code exchange: the add-on's own id, the redirect address Firefox derives from it, and the profile's random
    // moz-extension origin, which the server's CORS answers. No device name: a temporary add-on gets no install prompt,
    // so technical and interaction data is off, and the sign-in click never asks for it (sync.spec.ts sends one).
    const exchange = firefox.proxy.requests.find((r) => r.method === 'POST' && r.url === `${url}${TOKEN_PATH}`);
    const request = TokenRequestSchema.parse(JSON.parse(exchange?.body ?? '{}'));
    expect(request).toMatchObject({
      grant_type: 'authorization_code',
      client_id: FIREFOX_DEV_ADDON_ID,
      redirect_uri: geckoRedirectUri(FIREFOX_DEV_ADDON_ID),
    });
    expect(request).not.toHaveProperty('device_name');
    expect(exchange?.headers.origin).toBe(firefox.base);
    // Firefox fetched the authorize page in the background first, then opened its window on it.
    expect(sent.filter((r) => new URL(r.url).pathname === AUTHORIZE_PAGE_PATH).length).toBeGreaterThan(0);

    // Privacy & Data names the server by its host, with the self-hosted recipient text.
    await navigate(options, `${firefox.base}/options.html#/privacy`);
    await expect.poll(() => options.evaluate(() => [...document.querySelectorAll('.flow-box')].at(-1)?.textContent)).toBe(host);
    expect(await pageText(options)).toContain(
      `goes from your browser to ${host}. That server is run by its owner, not HeitechSoft`,
    );

    // The feed, labelled by the mock provider through the server.
    const page = await feed();
    await page.waitForSelector(`${FRIEND}[data-unalgo-pick=""]`, { timeout: 20_000 });
    await expect.poll(() => pageText(page)).toContain('For you');

    // Only masked post text and batch-local refs reach the server, nothing about the author; nothing of the post reaches a log.
    const classifyBodies = sent.filter((r) => new URL(r.url).pathname === CLASSIFY_PATH).map((r) => r.body);
    expect(classifyBodies.length).toBeGreaterThan(0);
    for (const body of classifyBodies) {
      const classify = ClassifyRequestSchema.parse(JSON.parse(body));
      for (const post of classify.posts) expect(post.ref).toMatch(/^p\d+$/);
      expect(body).not.toContain(AUTHOR);
      expect(body).not.toContain('linkedin.com/in/');
    }
    expect(ai.bodies.some((b) => b.includes(POST_TEXT))).toBe(true);
    for (const body of ai.bodies) {
      expect(body).not.toContain(AUTHOR);
      expect(body).not.toContain('linkedin.com/in/');
    }
    expect(logs()).not.toContain(POST_TEXT);
    expect(logs()).not.toContain(AUTHOR);

    // A server that doesn't bill shows no balance (R5): no pill in the popup or in Settings, no credit banner.
    const popup = await firefox.open('popup.html');
    await expect.poll(() => pageText(popup)).toContain(`${host} · Ready`);
    expect(await count(popup, `[aria-label^="${BALANCE_PILL}"]`)).toBe(0);
    const popupText = await pageText(popup);
    expect(popupText).not.toContain('Your balance is low');
    expect(popupText).not.toContain('AI is paused');
    expect(await send(popup, { type: 'aiStatus' })).not.toHaveProperty('balance');

    // The account page (the sign-in window left a web session in this profile) lists this device, without a name.
    const account = await firefox.browser.newPage();
    await account.goto(`${url}${ACCOUNT_PAGE_PATH}`);
    await expect.poll(() => pageText(account)).toContain(`Signed in as ${EMAIL}`);
    expect(await pageText(account)).toContain('Unnamed device');
    expect(await pageText(account)).not.toContain(firefoxDeviceName());
    await expectAccessible(account);
    await account.close();

    await test.step('test_firefox_withdrawn_consent_sends_nothing_but_sign_out', async () => {
      const toServer = () => firefox.proxy.requests.filter((r) => r.url.startsWith(`${url}/`)).length;
      // Settings → AI lists the devices: this one, unnamed.
      await navigate(options, `${firefox.base}/options.html#/ai`);
      await expect.poll(() => pageText(options)).toContain('This computer');
      expect(await pageText(options)).toContain('Unnamed device');

      // Withdrawn in Firefox's add-ons page (the API it uses): nothing more reaches the server, the token included.
      await options.evaluate(() => browser.permissions.remove({ data_collection: ['authenticationInfo'] }));
      expect(await grantedTypes(options)).not.toContain('authenticationInfo');
      const sent = toServer();
      await reload(options);
      const posts = `unAlgorithm needs your permission to send posts to ${host}.`;
      const devices = `unAlgorithm needs your permission to send your account details to ${host}.`;
      await expect.poll(() => pageText(options)).toContain(devices);
      expect(await pageText(options)).toContain(posts);
      expect(await send(options, { type: 'serverDevices' })).toEqual({
        ok: false,
        error: { code: 'host-permission', message: devices },
      });
      expect(await send(options, { type: 'aiStatus' })).not.toHaveProperty('balance');
      // The feed again: AI pauses with the same words, and no post goes to the server.
      await reload(page);
      await expect
        .poll(async () => (await feedTabAi(options))?.message, { timeout: 15_000 })
        .toBe(`unAlgorithm needs your permission to send posts to ${host}. Open Settings → AI and allow it.`);
      expect(toServer()).toBe(sent);

      // Allow, from the click, in a Settings tab in front (a click needs it): the consent comes back, and the list is
      // asked for again.
      const settings = await firefox.open('options.html#/ai');
      await expect.poll(() => pageText(settings)).toContain(devices);
      expect(toServer()).toBe(sent);
      await click(settings, aria('button', 'Allow'));
      await expect.poll(() => grantedTypes(settings)).toEqual(SERVER_CONSENT);
      await expect.poll(() => pageText(settings)).not.toContain(devices);
      await expect.poll(() => pageText(settings)).not.toContain(posts);
      await expect.poll(() => pageText(settings)).toContain('This computer');
      expect(toServer()).toBeGreaterThan(sent);

      // Withdrawn again, signing out still ends the device on the server.
      await settings.evaluate(() => browser.permissions.remove({ data_collection: ['personallyIdentifyingInfo'] }));
      const revokes = () => firefox.proxy.requests.filter((r) => r.url === `${url}${REVOKE_PATH}`).length;
      expect(revokes()).toBe(0);
      await reload(settings);
      await click(settings, aria('button', 'Sign out'));
      await visible(settings, aria('textbox', 'Server address'));
      await expect.poll(revokes).toBe(1);
    });
  });
});

test.describe('unAlgorithm Cloud', () => {
  /**
   * Serves the Cloud's discovery document from the profile's proxy over TLS (no live Cloud). `clients` left out is a
   * server from before Firefox sign-in, which means Chrome and Edge only.
   */
  const serveDiscovery = (firefox: FirefoxProfile, clients?: string[]) => {
    const info = ServerInfoSchema.parse({
      v: 1,
      name: 'unAlgorithm Cloud',
      version: '0.1.0',
      source: 'https://github.com/HeitechSoft/unalgorithm',
      billing: false,
      capabilities: { classify: true, sync: false },
      auth: {
        methods: [EMAIL_OTP_METHOD],
        authorizePath: AUTHORIZE_PAGE_PATH,
        tokenPath: TOKEN_PATH,
        ...(clients ? { clients } : {}),
      },
      limits: { maxPostsPerRequest: MAX_POSTS_PER_REQUEST },
    });
    firefox.proxy.route(`${CLOUD}${SERVER_INFO_PATH}`, () => ({
      status: 200,
      // The real server answers discovery to any origin.
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      body: JSON.stringify(info),
    }));
  };

  test('test_firefox_cloud_origin_labels_and_recipient', async ({ firefox }) => {
    serveDiscovery(firefox, ['chromium', 'gecko']);
    const options = await firefox.open('options.html#/ai');
    expect(await send(options, { type: 'saveSource', config: { kind: 'server', baseUrl: CLOUD } })).toMatchObject({ ok: true });

    await navigate(options, `${firefox.base}/options.html#/privacy`);
    await expect.poll(() => pageText(options)).toContain('Post text goes from your browser to unAlgorithm Cloud');
    const recipient = await pageText(options);
    expect(recipient).toContain('HeitechSoft');
    expect(recipient).toContain('Anthropic');

    // Not signed in, so the popup asks for attention.
    const popup = await firefox.open('popup.html');
    await expect.poll(() => pageText(popup)).toContain('unAlgorithm Cloud · Needs attention');
  });

  test('test_firefox_refused_by_server_without_gecko_clients', async ({ firefox }) => {
    // A server that predates Firefox sign-in: its discovery names no clients.
    serveDiscovery(firefox);
    const options = await firefox.open('options.html#/ai');
    await click(options, text('unAlgorithm server'));
    await fill(options, 'Server address', CLOUD);
    await click(options, aria('button', 'Continue'));
    // Said at "Continue", before the person reads what is sent or any sign-in window opens.
    await expect.poll(() => pageText(options)).toContain("unAlgorithm Cloud doesn't accept sign-ins from Firefox yet.");
    expect(await count(options, aria('button', 'Sign in and turn on'))).toBe(0);
    expect(firefox.proxy.requests.some((r) => r.url.includes(AUTHORIZE_PAGE_PATH))).toBe(false);
    await visible(options, aria('textbox', 'Server address'));
  });
});

/** The AI state the LinkedIn feed tab reports (session storage, as the side panel reads it). */
function feedTabAi(page: Page): Promise<{ state: string; message?: string } | undefined> {
  return page.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
    if (tab?.id === undefined) return undefined;
    const session: Record<string, { ai?: { state: string; message?: string } }> = await chrome.storage.session.get(null);
    return session[`tab:${tab.id}`]?.ai;
  });
}
