import { CLAIMS_PHRASE, type MockVerdict, VERDICT_PHRASE } from '@unalgorithm/ai/testing';
import { type MockSearxng, startMockSearxng } from '@unalgorithm/research/testing';
import type { Page } from 'puppeteer-core';
import { CHECK_FACTS, FB_FRIENDS_FLAGGED, FLAGGED, LINKEDIN_FLAGGED, linkedinShell } from '../fixtures.ts';
import { useLocalServer } from '../server-lifecycle.ts';
import { aria, click, count, type FirefoxProfile, fixturePage, launchFirefox, pageText, visible } from './driver.ts';
import {
  allowLocal,
  expect,
  facebookFeed,
  facebookPost,
  GRANT_REQUESTS,
  LINKEDIN_FEED,
  seeResultHint,
  signInFromSettings,
  test,
  turnOnLabs,
} from './fixtures.ts';

/**
 * Fact-check through a self-hosted server in Firefox (P3-24, ADR 0008), as `../factcheck-server.spec.ts` checks
 * Chromium and Edge: the add-on, signed in to the real server with `FACTCHECK=on`, the mock provider as its model and
 * the mock SearXNG as its search, goes from a flagged post to the result on the Highlights page with no key in the
 * browser. Firefox's sidebar can't be driven, so the page is opened as a tab beside the feed, which is what the sidebar
 * shows. Needs Postgres and Mailpit, so it runs only with `UA_SERVER_E2E=1`.
 */
const EMAIL = 'tester@example.com';
const FREE = 'Free on this server';
const CAP_REACHED = "You've reached today's fact-check limit on this server.";
const CHECK_TIMEOUT = { timeout: 60_000 };
const LINKEDIN_POST = '[componentkey="update-card-focusEEEkeyFirstDegree5"]';
const PUBLIC_POST = facebookPost(1);
const FRIENDS_POST = facebookPost(0);
const checkButton = (post: string) => `${post} unalgo-post >>> ${aria('button', CHECK_FACTS)}`;

function verdict(text: string): MockVerdict {
  const flagged = FLAGGED.some((phrase) => text.includes(phrase));
  return { relevance: flagged ? 90 : 50, noise: [], topics: ['other'], hasCheckableClaims: flagged };
}

const isFactcheckRequest = (body: string) => body.includes(CLAIMS_PHRASE) || body.includes(VERDICT_PHRASE);

test.describe
  .serial('fact-check through a self-hosted server in Firefox', () => {
    test.skip(process.env.UA_SERVER_E2E !== '1', 'needs Postgres and Mailpit');

    let searx: MockSearxng | undefined;
    let firefox: FirefoxProfile | undefined;
    let linkedin: Page;
    let facebook: Page;
    const baseline = { model: 0, searches: 0 };

    test.beforeAll(async () => {
      searx = await startMockSearxng();
    });

    // Declared before the server's, so the profile closes first, also when a test failed.
    test.afterAll(async () => {
      try {
        await firefox?.close();
      } finally {
        await searx?.close();
      }
    });

    const started = useLocalServer(
      () => ({ FACTCHECK: 'on', SEARCH_PROVIDER: 'searxng', SEARCH_URL: searx?.url ?? '', USER_DAILY_CHECK_CAP: '1' }),
      { verdict },
    );

    test.beforeAll(async () => {
      const { ai } = started();
      baseline.model = ai.bodies.length;
      baseline.searches = searx?.queries.length ?? 0;
      firefox = await launchFirefox({ prefs: GRANT_REQUESTS });
    });

    const profile = () => firefox as FirefoxProfile;
    const factcheckBodies = () => started().ai.bodies.slice(baseline.model).filter(isFactcheckRequest);
    const searches = () => (searx?.queries ?? []).slice(baseline.searches);

    test('test_firefox_server_labs_switch_enabled', async () => {
      test.setTimeout(120_000);
      const { server } = started();
      allowLocal(profile());
      const options = await signInFromSettings(profile(), server.url, EMAIL);
      // Enabled because the server offers fact-check; then turned on for the rest of the run.
      await turnOnLabs(options, 'Fact-check');
    });

    test('test_firefox_server_button_only_on_public_flagged_posts', async () => {
      linkedin = await fixturePage(profile(), LINKEDIN_FEED, linkedinShell());
      await visible(linkedin, checkButton(LINKEDIN_POST), 20_000);
      facebook = await facebookFeed(profile());
      await visible(facebook, checkButton(PUBLIC_POST), 20_000);
      expect(await count(facebook, checkButton(FRIENDS_POST))).toBe(0);
    });

    test('test_firefox_server_free_price_before_running', async () => {
      await click(linkedin, checkButton(LINKEDIN_POST));
      await expect.poll(() => pageText(linkedin)).toContain(FREE);
      expect(factcheckBodies()).toEqual([]);
      expect(searches()).toEqual([]);
    });

    test('test_firefox_server_result_reaches_highlights', async () => {
      test.setTimeout(90_000);
      await click(linkedin, `${LINKEDIN_POST} unalgo-post >>> ${aria('button', 'Check')}`);
      await visible(linkedin, `${LINKEDIN_POST} unalgo-post >>> ${aria('button', 'See result')}`, CHECK_TIMEOUT.timeout);

      // The mock's one claim is the post's first sentence, and the server searched it.
      const [claim] = searches();
      expect(claim).toContain(LINKEDIN_FLAGGED);

      // The Highlights page as a tab; bringing the feed to the front makes it the page's active tab in this window.
      const panel = await profile().open('sidepanel.html');
      await linkedin.bringToFront();
      await expect.poll(() => pageText(panel), { timeout: 15_000 }).toContain('AI-generated');
      const sheet = await pageText(panel);
      expect(sheet).toContain(claim ?? '');
      expect(sheet).toContain('Supported');
      expect(sheet).toContain('AI can be wrong, so open the sources.');
      expect(sheet).toMatch(/Checked /);
      // Sources from the mock SearXNG (on `*.example`, which the link check can't reach and keeps), with their quotes.
      expect(await count(panel, '.ua-factcheck-claim a[href^="https://a.example/"]')).toBeGreaterThan(0);
      expect(await panel.$eval('.ua-factcheck-claim blockquote', (q) => q.textContent)).toMatch(/^Records show that /);

      // The sidebar is closed, so the post says how to open it.
      await seeResultHint(linkedin, LINKEDIN_POST);
    });

    test('test_firefox_server_search_and_model_saw_only_public_posts', () => {
      expect(searches()).toHaveLength(1);
      expect(searches()[0]).toContain(LINKEDIN_FLAGGED);
      const bodies = factcheckBodies();
      expect(bodies.some((b) => b.includes(CLAIMS_PHRASE) && b.includes(LINKEDIN_FLAGGED))).toBe(true);
      expect(bodies.some((b) => b.includes(VERDICT_PHRASE))).toBe(true);
      for (const body of bodies) expect(body).not.toContain(FB_FRIENDS_FLAGGED);
    });

    test('test_firefox_server_daily_check_cap', async () => {
      await click(facebook, checkButton(PUBLIC_POST));
      await expect.poll(() => pageText(facebook)).toContain(FREE);
      const before = { model: started().ai.bodies.length, searches: searx?.queries.length };
      await click(facebook, `${PUBLIC_POST} unalgo-post >>> ${aria('button', 'Check')}`);
      await expect.poll(() => pageText(facebook), CHECK_TIMEOUT).toContain(CAP_REACHED);
      expect({ model: started().ai.bodies.length, searches: searx?.queries.length }).toEqual(before);
    });

    test('test_firefox_server_logs_hold_no_post_text', () => {
      const logs = started().server.logs();
      for (const phrase of FLAGGED) expect(logs).not.toContain(phrase);
      for (const query of searches()) expect(logs).not.toContain(query);
    });
  });
