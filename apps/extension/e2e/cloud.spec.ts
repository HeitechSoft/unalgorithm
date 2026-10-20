import type { BrowserContext } from '@playwright/test';
import {
  ACCOUNT_DELETE_PATH,
  ACCOUNT_DEVICE_REVOKE_PATH,
  ACCOUNT_PAGE_PATH,
  AUTHORIZE_PAGE_PATH,
  CLASSIFY_PATH,
  ClassifyRequestSchema,
  EMAIL_OTP_METHOD,
  MAX_POSTS_PER_REQUEST,
  SERVER_INFO_PATH,
  ServerInfoSchema,
  TOKEN_PATH,
} from '@unalgorithm/protocol';
import { FIRST_DEGREE_POST } from '../../../packages/platforms/fixtures/linkedin/y2026.ts';
import { expect, markTopicMore, test } from './fixtures.ts';
import { useLocalServer } from './server-lifecycle.ts';
import { allowServer, expectAccessible, expectDialogTrapsFocus, signInFromSettings } from './server-sign-in.ts';

/**
 * The walking skeleton end to end (CL1): a fresh extension signs in to a real server process with an emailed code, and
 * the fixture feed is labelled by the mock AI provider through that server. Needs Postgres and Mailpit
 * (`apps/server/compose.dev.yaml` locally, service containers in CI) and the built `apps/web`, so it runs only with
 * `UA_SERVER_E2E=1`.
 */
const SKIP = process.env.UA_SERVER_E2E !== '1';
const NEEDS = 'needs Postgres and Mailpit';

const EMAIL = 'tester@example.com';
/** The first-degree fixture post's text and its author: the author never leaves the browser, the text never reaches a log. */
const POST_TEXT = 'Which HR task would you automate first';
const AUTHOR = 'Morgan Ellis';
const CLOUD = 'https://cloud.unalgorithm.app';
/** The balance pill's accessible name (CL2-12). */
const BALANCE_PILL = /^Credit balance:/;
/** The operating system as a device name says it (device-name.ts). */
const OS_NAMES: Record<string, string> = { linux: 'Linux', win32: 'Windows', darwin: 'macOS' };

test.describe('a self-hosted server', () => {
  test.skip(SKIP, NEEDS);

  // test_harness_cleans_up: useLocalServer's afterAll, also when a test failed.
  const started = useLocalServer();

  test('test_self_hosted_sign_in_and_labels', async ({ context, extensionId, extensionBrowser, feed }) => {
    test.setTimeout(120_000);
    const { ai, server } = started();
    const { url, logs } = server;
    const host = new URL(url).host;
    expect(FIRST_DEGREE_POST).toContain(POST_TEXT);
    expect(FIRST_DEGREE_POST).toContain(AUTHOR);

    const classifyBodies: string[] = [];
    await allowServer(context, extensionId, (requestUrl, body) => {
      if (new URL(requestUrl).pathname === CLASSIFY_PATH) classifyBodies.push(body);
    });

    // Sign in from Settings with the emailed code; the sign-in page is checked at its email and code steps.
    await signInFromSettings(context, extensionId, url, EMAIL, (step, page) =>
      test.step(`test_authorize_page_accessibility (${step} step)`, () => expectAccessible(page)),
    );

    // The sign-in left a web session in this browser: the account page's confirm dialogs, as only a browser runs them.
    await test.step('test_account_dialogs_trap_focus', () => expectAccountDialogsTrapFocus(context, url));

    // Edge names this device by its brand (device-name.ts). With UA_EDGE another Chromium stands in for Edge.
    if (extensionBrowser === 'edge' && !process.env.UA_EDGE) {
      await test.step('test_edge_device_name', async () => {
        const account = await context.newPage();
        await account.goto(`${url}${ACCOUNT_PAGE_PATH}`);
        await expect(account.getByText(`Edge on ${OS_NAMES[process.platform] ?? process.platform}`)).toBeVisible();
        await account.close();
      });
    }

    // Privacy & Data names the server by its host, with the self-hosted recipient text.
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html#/privacy`);
    await expect(options.locator('.flow-box').last()).toHaveText(host);
    await expect(options.getByText(/not HeitechSoft/)).toContainText(host);

    // The feed, labelled by the mock provider through the server; the AI highlights by relevance once the person has
    // said what they want.
    await markTopicMore(context, extensionId);
    const page = await feed();
    const friend = page.locator('[componentkey="update-card-focusEEEkeyFirstDegree5"]');
    await expect(friend).toHaveAttribute('data-unalgo-pick', '', { timeout: 20_000 });
    await expect(friend.locator('unalgo-post').getByText('For you')).toBeVisible();

    // Only masked post text and batch-local refs reach the server, nothing about the author; nothing of the post reaches a log.
    expect(classifyBodies.length).toBeGreaterThan(0);
    for (const body of classifyBodies) {
      const request = ClassifyRequestSchema.parse(JSON.parse(body));
      for (const post of request.posts) expect(post.ref).toMatch(/^p\d+$/);
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

    // A server that doesn't bill shows no balance anywhere (R5): no pill in the popup or in Settings, no credit banner.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    // The footer names the server once `aiStatus` has answered, so what is absent below is absent from that answer.
    await expect(popup.getByText(`${host} · Ready`, { exact: true })).toBeVisible();
    await expect(popup.getByLabel(BALANCE_PILL)).toHaveCount(0);
    await expect(popup.getByText('Your balance is low', { exact: true })).toHaveCount(0);
    await expect(popup.getByText('AI is paused', { exact: true })).toHaveCount(0);
    await options.goto(`chrome-extension://${extensionId}/options.html#/ai`);
    await expect(options.getByText(`Signed in as ${EMAIL}`)).toBeVisible();
    expect(await options.evaluate(() => chrome.runtime.sendMessage({ type: 'aiStatus' }))).not.toHaveProperty('balance');
    await expect(options.getByLabel(BALANCE_PILL)).toHaveCount(0);
  });
});

test.describe('unAlgorithm Cloud', () => {
  test.skip(SKIP, NEEDS);

  test('test_cloud_origin_labels_and_recipient', async ({ context, extensionId }) => {
    // No live Cloud: only its discovery document, served here.
    const info = ServerInfoSchema.parse({
      v: 1,
      name: 'unAlgorithm Cloud',
      version: '0.1.0',
      source: 'https://github.com/HeitechSoft/unalgorithm',
      billing: false,
      capabilities: { classify: true, sync: false },
      auth: { methods: [EMAIL_OTP_METHOD], authorizePath: AUTHORIZE_PAGE_PATH, tokenPath: TOKEN_PATH },
      limits: { maxPostsPerRequest: MAX_POSTS_PER_REQUEST },
    });
    await context.route(`${CLOUD}${SERVER_INFO_PATH}`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(info) }),
    );

    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html#/ai`);
    const saved = await options.evaluate(
      (baseUrl) => chrome.runtime.sendMessage({ type: 'saveSource', config: { kind: 'server', baseUrl } }),
      CLOUD,
    );
    expect(saved).toMatchObject({ ok: true });

    await options.goto(`chrome-extension://${extensionId}/options.html#/privacy`);
    await expect(options.locator('.flow-box').last()).toHaveText('unAlgorithm Cloud');
    const recipient = options.getByText(/^Post text goes from your browser to unAlgorithm Cloud/);
    await expect(recipient).toContainText('HeitechSoft');
    await expect(recipient).toContainText('Anthropic');

    // Not signed in, so the popup asks for attention.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.getByText('unAlgorithm Cloud · Needs attention', { exact: true })).toBeVisible();
  });
});

/**
 * The account page's revoke and delete dialogs in Chromium, where jsdom has no modal dialog (CL3-17, CL3-18): the
 * revoke dialog opened from the row of the device the extension just signed in as, then the delete dialog; each is a
 * modal that opens on "Cancel", keeps Tab inside and closes on the Escape key, and neither request leaves the page.
 */
async function expectAccountDialogsTrapFocus(context: BrowserContext, serverUrl: string): Promise<void> {
  const page = await context.newPage();
  const posted: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') posted.push(new URL(request.url()).pathname);
  });
  await page.goto(`${serverUrl}${ACCOUNT_PAGE_PATH}`);
  await expect(page.getByText(`Signed in as ${EMAIL}`)).toBeVisible();
  // The extension's device is the one signed in; a closed dialog's buttons are hidden, so these are the rows'.
  const revoke = page.getByRole('button', { name: 'Revoke', exact: true });
  await expect(revoke).toHaveCount(1);

  await expectDialogTrapsFocus(page, revoke, 2);
  expect(posted).not.toContain(ACCOUNT_DEVICE_REVOKE_PATH);
  await expect(revoke).toHaveCount(1);

  // The delete dialog: its field and "Cancel" ("Delete account" stays disabled until the address is typed).
  await expectDialogTrapsFocus(page, page.getByRole('button', { name: 'Delete account…', exact: true }), 2);
  expect(posted).not.toContain(ACCOUNT_DELETE_PATH);
  await expect(page.getByText(`Signed in as ${EMAIL}`)).toBeVisible();
  await page.close();
}
