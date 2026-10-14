import type { BrowserContext, Page } from '@playwright/test';
import type { TabState } from '@unalgorithm/core';
import { FIRST_DEGREE_POST } from '../../../packages/platforms/fixtures/linkedin/y2026.ts';
import { expect, test } from './fixtures.ts';
import { BILLING_FIXTURE_MODULE } from './server-harness.ts';
import { useLocalServer } from './server-lifecycle.ts';
import { signInFromSettings } from './server-sign-in.ts';

/**
 * Credits end to end (CL2): the real server process with the public test billing module (100 micro-dollars a post),
 * and the real extension showing the balance, lowering it as the feed is classified, and pausing AI at $0 while rules
 * keep hiding posts (R5, R27, R31). The server's tests prove the module over HTTP; only this shows what a person sees.
 * Like `cloud.spec.ts` it needs Postgres and Mailpit and the built `apps/web`, so it runs only with `UA_SERVER_E2E=1`.
 */
const SKIP = process.env.UA_SERVER_E2E !== '1';
const NEEDS = 'needs Postgres and Mailpit';

const EMAIL = 'tester@example.com';
/** The first-degree fixture post's text: it reaches the AI provider only through a classify the server allowed. */
const POST_TEXT = 'Which HR task would you automate first';
const FRIEND = '[componentkey="update-card-focusEEEkeyFirstDegree5"]';
const PROMOTED = '[componentkey="update-card-focusBBBkeyPromoted0002"]';
/** The balance pill's accessible name (CL2-12). */
const BALANCE_PILL = /^Credit balance:/;
/** R27, the end of every "balance is empty" message. */
const ADD_CREDIT_OR_SWITCH = 'Add credit, or switch to on-device or your own key.';
/** How long the feed stays open at $0 with nothing reaching the AI provider. */
const PAUSED_WATCH_MS = 10_000;

test.describe('a server that bills', () => {
  test.skip(SKIP, NEEDS);
  // test_credits_harness_cleans_up: useLocalServer's afterAll, also when the test failed.
  const started = useLocalServer(billingEnv(1_000_000));

  test('test_billing_server_shows_and_lowers_balance', async ({ context, extensionId, feed }) => {
    test.setTimeout(120_000);
    const { server } = started();
    await signIn(context, extensionId, server.url);

    // Before any post is classified: the whole starter balance, read from the server.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(footerPill(popup)).toHaveText('$1.00 left · about 6,800 posts');

    // The feed, classified through the server, which charges the fixture's 100 micro-dollars a post.
    const page = await feed();
    await expect(page.locator(FRIEND)).toHaveAttribute('data-unalgo-pick', '', { timeout: 20_000 });

    // One to 100 posts leave $0.99, in the popup and under the account in Settings.
    const lowered = /^\$0\.99 left · about [\d,]+ posts$/;
    await popup.reload();
    await expect(footerPill(popup)).toHaveText(lowered);
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html#/ai`);
    const account = options.locator('.ua-card').filter({ hasText: `Signed in as ${EMAIL}` });
    await expect(account.getByRole('button', { name: BALANCE_PILL })).toHaveText(lowered);

    expect(server.logs()).not.toContain(POST_TEXT);
  });
});

test.describe('a server whose balance is empty', () => {
  test.skip(SKIP, NEEDS);
  // test_credits_harness_cleans_up: useLocalServer's afterAll, also when the test failed.
  const started = useLocalServer(billingEnv(0));

  test('test_empty_balance_pauses_ai_and_keeps_rules', async ({ context, extensionId, feed }) => {
    test.setTimeout(120_000);
    const { ai, server } = started();
    // `route-eval` classified the eval set through the mock in beforeAll; from here on nothing may reach it.
    const before = ai.bodies.length;
    expect(FIRST_DEGREE_POST).toContain(POST_TEXT);
    await signIn(context, extensionId, server.url);

    const page = await feed();
    const opened = Date.now();
    // Rules keep hiding posts.
    await expect(page.locator(PROMOTED)).toHaveAttribute('data-unalgo', 'collapsed');

    // The server refused the classify (402), and the feed tab reports AI paused with the R27 sentence.
    await expect
      .poll(async () => (await feedTabState(context, extensionId))?.ai, { timeout: 15_000 })
      .toMatchObject({ state: 'paused', code: 'insufficient-credits', message: expect.stringContaining(ADD_CREDIT_OR_SWITCH) });

    // Ten seconds on the feed: no AI label, and the mock provider heard nothing of it.
    await page.waitForTimeout(Math.max(0, opened + PAUSED_WATCH_MS - Date.now()));
    await expect(page.locator(FRIEND)).not.toHaveAttribute('data-unalgo-pick');
    await expect(page.locator('[data-unalgo-pick]')).toHaveCount(0);
    expect(ai.bodies.length).toBe(before);
    for (const body of ai.bodies) expect(body).not.toContain(POST_TEXT);

    // The popup: an empty pill, and the paused banner with both ways out.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(footerPill(popup)).toHaveText('$0.00 left');
    const paused = popup.getByRole('status').filter({ hasText: 'AI is paused' });
    await expect(paused).toContainText(ADD_CREDIT_OR_SWITCH);
    await expect(paused.getByRole('button', { name: 'Add credit', exact: true })).toBeVisible();
    await expect(paused.getByRole('button', { name: 'Switch AI', exact: true })).toBeVisible();
  });
});

/** The server's variables for the fixture billing module, every account starting at `startMicros`. */
function billingEnv(startMicros: number): Record<string, string> {
  return {
    BILLING: 'module',
    BILLING_MODULE: BILLING_FIXTURE_MODULE,
    BILLING_FIXTURE_START_MICROS: String(startMicros),
  };
}

/** Lets the extension reach the local server, then signs in from Settings with an emailed code. */
async function signIn(context: BrowserContext, extensionId: string, serverUrl: string): Promise<void> {
  await context.route('http://127.0.0.1:*/**', (route) => route.continue());
  // Where the sign-in page sends the browser back; the extension reads the address from the tab and closes it.
  await context.route(`https://${extensionId}.chromiumapp.org/**`, (route) => route.fulfill({ status: 200, body: 'ok' }));
  await signInFromSettings(context, extensionId, serverUrl, EMAIL);
}

/** The balance pill in the popup's footer. */
function footerPill(popup: Page) {
  return popup.locator('footer').getByRole('button', { name: BALANCE_PILL });
}

/**
 * The feed tab's state as its content script reports it: WXT's `session:tab:<id>` item (the `tab:<id>` key of
 * `chrome.storage.session`), read in the extension's service worker, where session storage is open.
 */
async function feedTabState(context: BrowserContext, extensionId: string): Promise<TabState | undefined> {
  const worker =
    context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${extensionId}/`)) ??
    (await context.waitForEvent('serviceworker'));
  return worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
    if (tab?.id === undefined) return undefined;
    const session: Record<string, unknown> = await chrome.storage.session.get(null);
    return session[`tab:${tab.id}`] as TabState | undefined;
  });
}
