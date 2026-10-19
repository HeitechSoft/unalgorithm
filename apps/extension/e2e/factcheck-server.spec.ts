import type { BrowserContext, Page } from '@playwright/test';
import { CLAIMS_PHRASE, type MockVerdict, VERDICT_PHRASE } from '@unalgorithm/ai/testing';
import { type MockSearxng, startMockSearxng } from '@unalgorithm/research/testing';
import {
  CHECK_FACTS,
  expect,
  expectReportsAsked,
  extensionIdOf,
  FB_FRIENDS_FLAGGED,
  FLAGGED,
  facebookFeed,
  LINKEDIN_FLAGGED,
  launchExtensionContext,
  linkedinFeed,
  linkedinPost,
  seeResult,
  test,
  turnOnLabs,
} from './fixtures.ts';
import { useLocalServer } from './server-lifecycle.ts';
import { allowServer, signInFromSettings } from './server-sign-in.ts';

/**
 * Fact-check end to end through a self-hosted server (P3-24, RM2): the real extension in Chromium, signed in to the
 * real server process, goes from a flagged post to the result in the side panel with no key in the browser. The server
 * runs on Postgres with `FACTCHECK=on`, the mock OpenAI-compatible provider as its model and the mock SearXNG as its
 * search provider; the harness opens both eval gates (`route-eval`, `route-eval factcheck`). Like `cloud.spec.ts` it
 * needs Postgres and Mailpit, so it runs only with `UA_SERVER_E2E=1` (the CI `server` job).
 *
 * The tests run in order in one browser profile, the daily check cap last: with `USER_DAILY_CHECK_CAP=1` the first
 * check (the LinkedIn post) runs and the second (the public Facebook post) is refused.
 */
const EMAIL = 'tester@example.com';
const FREE = 'Free on this server';
const CAP_REACHED = "You've reached today's fact-check limit on this server.";
/** A check through the server: a job, a search per claim, the link check and the verdict. */
const CHECK_TIMEOUT = { timeout: 60_000 };

/** The fixture posts `factcheck.spec.ts` flags, flagged here too; every other post is ordinary. */
function verdict(text: string): MockVerdict {
  const flagged = FLAGGED.some((phrase) => text.includes(phrase));
  return { relevance: flagged ? 90 : 50, noise: [], topics: ['other'], hasCheckableClaims: flagged };
}

const isFactcheckRequest = (body: string) => body.includes(CLAIMS_PHRASE) || body.includes(VERDICT_PHRASE);

test.describe
  .serial('fact-check through a self-hosted server', () => {
    // First, so no beforeAll starts anything where there is no Postgres: the tests are reported as skipped.
    test.skip(process.env.UA_SERVER_E2E !== '1', 'needs Postgres and Mailpit');

    let searx: MockSearxng | undefined;
    let context: BrowserContext;
    let extensionId: string;
    let linkedin: Page;
    let facebook: Page;
    /** Each mock's request count once the server is up: `route-eval factcheck` has used both by then. */
    const baseline = { model: 0, searches: 0 };

    test.beforeAll(async () => {
      searx = await startMockSearxng();
    });

    // Declared before the server's, so the profile closes first, also when a test failed.
    test.afterAll(async () => {
      try {
        // No problem report without a Send click (ADR 0009 §1), as the `context` fixture checks its own.
        if (context) expectReportsAsked(context);
      } finally {
        try {
          await context?.close();
        } finally {
          await searx?.close();
        }
      }
    });

    const started = useLocalServer(
      () => ({
        FACTCHECK: 'on',
        SEARCH_PROVIDER: 'searxng',
        SEARCH_URL: searx?.url ?? '',
        USER_DAILY_CHECK_CAP: '1',
      }),
      { verdict },
    );

    test.beforeAll(async ({ extensionBrowser }) => {
      const { ai } = started();
      baseline.model = ai.bodies.length;
      baseline.searches = searx?.queries.length ?? 0;
      context = await launchExtensionContext(extensionBrowser);
      extensionId = await extensionIdOf(context);
    });

    /** The mock model's fact-check requests (claims and verdicts) since the baseline. */
    const factcheckBodies = () => started().ai.bodies.slice(baseline.model).filter(isFactcheckRequest);
    /** The mock SearXNG's queries since the baseline. */
    const searches = () => (searx?.queries ?? []).slice(baseline.searches);

    test('test_e2e_server_labs_switch_enabled', async () => {
      test.setTimeout(120_000);
      const { server } = started();
      await allowServer(context, extensionId);
      await signInFromSettings(context, extensionId, server.url, EMAIL);

      const options = await context.newPage();
      await options.goto(`chrome-extension://${extensionId}/options.html#/ai`);
      // Enabled because the server offers fact-check; then turned on for the rest of the run.
      await turnOnLabs(options);
    });

    test('test_e2e_server_button_only_on_public_flagged_posts', async () => {
      linkedin = await linkedinFeed(context);
      await expect(linkedinPost(linkedin).locator('unalgo-post').getByRole('button', { name: CHECK_FACTS })).toBeVisible({
        timeout: 20_000,
      });

      facebook = await facebookFeed(context);
      const [friends, publicPost] = [0, 1].map((i) => facebook.locator('[role="feed"] > div').nth(i));
      await expect(publicPost.locator('unalgo-post').getByRole('button', { name: CHECK_FACTS })).toBeVisible({
        timeout: 20_000,
      });
      await expect(friends.locator('unalgo-post').getByRole('button', { name: CHECK_FACTS })).toHaveCount(0);
      await expect(facebook.locator('unalgo-post').getByRole('button', { name: CHECK_FACTS })).toHaveCount(1);
    });

    test('test_e2e_server_free_price_before_running', async () => {
      const ui = linkedinPost(linkedin).locator('unalgo-post');
      await ui.getByRole('button', { name: CHECK_FACTS }).click();
      await expect(ui.getByText(FREE, { exact: true })).toBeVisible();
      await expect(ui.getByRole('button', { name: 'Check', exact: true })).toBeFocused();
      // Not confirmed yet: no claims request to the model, no search.
      expect(factcheckBodies()).toEqual([]);
      expect(searches()).toEqual([]);
    });

    test('test_e2e_server_result_in_side_panel', async () => {
      test.setTimeout(90_000);
      const ui = linkedinPost(linkedin).locator('unalgo-post');
      await ui.getByRole('button', { name: 'Check', exact: true }).click();
      await expect(ui.getByRole('button', { name: 'See result' })).toBeVisible(CHECK_TIMEOUT);

      // The mock's one claim is the post's first sentence, and the server searched it.
      const [claim] = searches();
      expect(claim).toContain(LINKEDIN_FLAGGED);

      // The side panel as a page; bringing the feed to the front makes it the panel's active tab.
      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      await linkedin.bringToFront();
      const sheet = panel.getByRole('region', { name: 'Fact-check' });
      await expect(sheet.getByText('AI-generated')).toBeVisible();
      const item = sheet.locator('.ua-factcheck-claim');
      await expect(item.getByText(claim ?? '', { exact: true })).toBeVisible();
      await expect(item.getByText('Supported', { exact: true })).toBeVisible();
      // Sources from the mock SearXNG (on `*.example`, which the link check can't reach and keeps), with their quotes.
      await expect(item.locator('a[href^="https://a.example/"]')).toBeVisible();
      await expect(item.locator('blockquote').first()).toHaveText(/^Records show that /);
      await expect(sheet.getByText(/^Checked /)).toBeVisible();
      await expect(sheet.getByText('AI can be wrong, so open the sources.')).toBeVisible();

      await seeResult(ui);
    });

    test('test_e2e_server_search_and_model_saw_only_public_posts', async () => {
      expect(searches()).toHaveLength(1);
      expect(searches()[0]).toContain(LINKEDIN_FLAGGED);
      const bodies = factcheckBodies();
      expect(bodies.some((b) => b.includes(CLAIMS_PHRASE) && b.includes(LINKEDIN_FLAGGED))).toBe(true);
      expect(bodies.some((b) => b.includes(VERDICT_PHRASE))).toBe(true);
      for (const body of bodies) expect(body).not.toContain(FB_FRIENDS_FLAGGED);
    });

    test('test_e2e_server_daily_check_cap', async () => {
      const publicPost = facebook.locator('[role="feed"] > div').nth(1);
      const ui = publicPost.locator('unalgo-post');
      await ui.getByRole('button', { name: CHECK_FACTS }).click();
      await expect(ui.getByText(FREE, { exact: true })).toBeVisible();
      const before = { model: started().ai.bodies.length, searches: searx?.queries.length };

      await ui.getByRole('button', { name: 'Check', exact: true }).click();
      await expect(ui.getByText(CAP_REACHED, { exact: true })).toBeVisible(CHECK_TIMEOUT);
      expect({ model: started().ai.bodies.length, searches: searx?.queries.length }).toEqual(before);
    });

    test('test_e2e_server_logs_hold_no_post_text', () => {
      const logs = started().server.logs();
      for (const phrase of FLAGGED) expect(logs).not.toContain(phrase);
      for (const query of searches()) expect(logs).not.toContain(query);
    });
  });
