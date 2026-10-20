import { balanceLine, type TabState } from '@unalgorithm/core';
import type { Page } from 'puppeteer-core';
import { FIRST_DEGREE_POST } from '../../../../packages/platforms/fixtures/linkedin/y2026.ts';
import { BILLING_FIXTURE_MODULE } from '../server-harness.ts';
import { useLocalServer } from '../server-lifecycle.ts';
import { aria, attribute, type FirefoxProfile, pageText, reload, sleep, visible } from './driver.ts';
import { allowLocal, expect, markTopicMore, signInFromSettings, test } from './fixtures.ts';

/**
 * Credits in Firefox (CL2, ADR 0008), as `../credits.spec.ts` checks Chromium and Edge: the real server with the
 * public test billing module (100 micro-dollars a post), the balance in the popup and Settings, lowered as the feed is
 * classified, and AI paused at $0 while rules keep hiding posts. Needs Postgres and Mailpit and the built `apps/web`,
 * so it runs only with `UA_SERVER_E2E=1`.
 */
const SKIP = process.env.UA_SERVER_E2E !== '1';
const NEEDS = 'needs Postgres and Mailpit';

const EMAIL = 'tester@example.com';
/** The first-degree fixture post's text: it reaches the AI provider only through a classify the server allowed. */
const POST_TEXT = 'Which HR task would you automate first';
const FRIEND = '[componentkey="update-card-focusEEEkeyFirstDegree5"]';
const PROMOTED = '[componentkey="update-card-focusBBBkeyPromoted0002"]';
/** The balance pill (CL2-12), by its accessible name. */
const PILL = 'button[aria-label^="Credit balance:"]';
/** R27, the end of every "balance is empty" message. */
const ADD_CREDIT_OR_SWITCH = 'Add credit, or switch to your own key, or to on-device AI where your browser offers it.';
/** How long the feed stays open at $0 with nothing reaching the AI provider. */
const PAUSED_WATCH_MS = 10_000;

test.describe('a server that bills', () => {
  test.skip(SKIP, NEEDS);
  const started = useLocalServer(billingEnv(1_000_000));

  test('test_firefox_billing_server_shows_and_lowers_balance', async ({ firefox, feed }) => {
    test.setTimeout(150_000);
    const { server } = started();
    const options = await signIn(firefox, server.url);

    // Before any post is classified: the whole starter balance, read from the server, at today's price card.
    const popup = await firefox.open('popup.html');
    await expect.poll(() => footerPill(popup)).toBe(balanceLine(1_000_000, new Date()));

    // The feed, classified through the server, which charges the fixture's 100 micro-dollars a post. The AI highlights
    // by relevance once the person has said what they want, so the pick shows the classify was paid for.
    await markTopicMore(firefox);
    const page = await feed();
    await page.waitForSelector(`${FRIEND}[data-unalgo-pick=""]`, { timeout: 20_000 });

    // One to 100 posts leave $0.99, in the popup and under the account in Settings.
    const lowered = /^\$0\.99 left · about [\d,]+ posts$/;
    await reload(popup);
    await expect.poll(() => footerPill(popup)).toMatch(lowered);
    await reload(options);
    await expect.poll(() => accountPill(options)).toMatch(lowered);

    expect(server.logs()).not.toContain(POST_TEXT);
  });
});

test.describe('a server whose balance is empty', () => {
  test.skip(SKIP, NEEDS);
  const started = useLocalServer(billingEnv(0));

  test('test_firefox_empty_balance_pauses_ai_and_keeps_rules', async ({ firefox, feed }) => {
    test.setTimeout(150_000);
    const { ai, server } = started();
    // `route-eval` classified the eval set through the mock in beforeAll; from here on nothing may reach it.
    const before = ai.bodies.length;
    expect(FIRST_DEGREE_POST).toContain(POST_TEXT);
    const options = await signIn(firefox, server.url);
    // A topic marked More, so no pick below is because the AI is paused, not because it has nothing to go on.
    await markTopicMore(firefox);

    const page = await feed();
    const opened = Date.now();
    // Rules keep hiding posts.
    await page.waitForSelector(`${PROMOTED}[data-unalgo="collapsed"]`);

    // The server refused the classify (402), and the feed tab reports AI paused with the R27 sentence.
    await expect
      .poll(async () => (await feedTabState(options))?.ai, { timeout: 15_000 })
      .toMatchObject({ state: 'paused', code: 'insufficient-credits', message: expect.stringContaining(ADD_CREDIT_OR_SWITCH) });

    // Ten seconds on the feed: no AI label, and the mock provider heard nothing of it.
    await sleep(Math.max(0, opened + PAUSED_WATCH_MS - Date.now()));
    expect(await attribute(page, FRIEND, 'data-unalgo-pick')).toBeNull();
    expect(await page.$('[data-unalgo-pick]')).toBeNull();
    expect(ai.bodies.length).toBe(before);
    for (const body of ai.bodies) expect(body).not.toContain(POST_TEXT);

    // The popup: an empty pill, and the paused banner with both ways out.
    const popup = await firefox.open('popup.html');
    await expect.poll(() => footerPill(popup)).toBe('$0.00 left');
    const text = await pageText(popup);
    expect(text).toContain('AI is paused');
    expect(text).toContain(ADD_CREDIT_OR_SWITCH);
    await visible(popup, aria('button', 'Add credit'));
    await visible(popup, aria('button', 'Switch AI'));
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

/** Lets the profile reach the local server, then signs in from Settings; returns the options page. */
function signIn(firefox: FirefoxProfile, serverUrl: string): Promise<Page> {
  allowLocal(firefox);
  return signInFromSettings(firefox, serverUrl, EMAIL);
}

/** The text of the balance pill in the popup's footer, or null while there is none. */
function footerPill(popup: Page): Promise<string | null> {
  return popup.evaluate((pill) => document.querySelector(`footer ${pill}`)?.textContent ?? null, PILL);
}

/** The text of the balance pill under the account in Settings → AI, or null while there is none. */
function accountPill(options: Page): Promise<string | null> {
  return options.evaluate(
    (pill, email) =>
      [...document.querySelectorAll('.ua-card')]
        .find((card) => card.textContent?.includes(`Signed in as ${email}`))
        ?.querySelector(pill)?.textContent ?? null,
    PILL,
    EMAIL,
  );
}

/**
 * The feed tab's state as its content script reports it: WXT's `session:tab:<id>` item (the `tab:<id>` key of
 * `storage.session`), read from an extension page, since BiDi can't reach Firefox's background page.
 */
function feedTabState(page: Page): Promise<TabState | undefined> {
  return page.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
    if (tab?.id === undefined) return undefined;
    const session: Record<string, unknown> = await chrome.storage.session.get(null);
    return session[`tab:${tab.id}`] as TabState | undefined;
  });
}
