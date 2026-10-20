import type { BrowserContext, Page } from '@playwright/test';
import { COMPARISON_PHRASE, type MockVerdict, STORY_PHRASE } from '@unalgorithm/ai/testing';
import { type MockSearxng, startMockSearxng } from '@unalgorithm/research/testing';
import {
  expect,
  expectReportsAsked,
  extensionIdOf,
  FB_PUBLIC_FLAGGED,
  facebookFeed,
  launchExtensionContext,
  test,
  turnOnLabs,
} from './fixtures.ts';
import {
  coverageHit,
  coveredBucketInQuery,
  expectComparisonSheet,
  LINK_POST_TEXT,
  LINK_TITLE,
  LINK_URL,
  PERSPECTIVES,
  perspectivesButton,
  today,
} from './perspectives-fixtures.ts';
import { useLocalServer } from './server-lifecycle.ts';
import { allowServer, signInFromSettings } from './server-sign-in.ts';

/**
 * UnEcho Chamber end to end through a self-hosted server (P3-41, RM3): the real extension in Chromium, signed in
 * to the real server process as shipped (`src/index.ts`, with no source list of its own: the comparison request carries
 * the e2e build's list, the fictional fixture, P3-77), goes from the public Facebook link share to the comparison in the
 * side panel with no key in the browser. The server runs on Postgres with `FACTCHECK=on` and `PERSPECTIVES=on`, the
 * mock OpenAI-compatible provider as its model (it answers the story and comparison prompts, P3-31) and the mock SearXNG
 * as its search provider. Like `factcheck-server.spec.ts` it needs Postgres and Mailpit, so it runs only with
 * `UA_SERVER_E2E=1` (the CI `server` job); elsewhere it is reported as skipped.
 */
const EMAIL = 'tester@example.com';
const FREE = 'Free on this server';
/** A comparison through the server: a job, the link resolution, five searches and two model calls. */
const COMPARE_TIMEOUT = { timeout: 60_000 };

/** Only the link share is news. */
function verdict(text: string): MockVerdict {
  const news = text.includes(FB_PUBLIC_FLAGGED);
  return { relevance: news ? 90 : 50, noise: [], topics: ['other'], isNews: news };
}

type Hit = { url: string; title: string; snippet: string; published: string | null };

/**
 * A bucket search (a query with a `site:` clause): one article dated today when the clause names a covered bucket's
 * domains, none for the two gaps. Any other query (`route-eval factcheck`'s) gets the mock's default: three undated hits.
 */
function hits(query: string): Hit[] {
  if (!query.includes('site:')) {
    const snippet = `Records show that ${query.slice(0, 80)}.`;
    return ['a', 'b', 'c'].map((l, i) => ({
      url: `https://${l}.example/record-${i + 1}`,
      title: `Record ${i + 1}`,
      snippet,
      published: null,
    }));
  }
  const bucket = coveredBucketInQuery(query);
  if (!bucket) return [];
  const hit = coverageHit(bucket);
  return [{ url: hit.url, title: hit.title, snippet: hit.passage, published: today() }];
}

const isPerspectivesRequest = (body: string) => body.includes(STORY_PHRASE) || body.includes(COMPARISON_PHRASE);

test.describe
  .serial('Other perspectives through a self-hosted server', () => {
    // First, so no beforeAll starts anything where there is no Postgres: the tests are reported as skipped.
    test.skip(process.env.UA_SERVER_E2E !== '1', 'needs Postgres and Mailpit');

    let searx: MockSearxng | undefined;
    let context: BrowserContext;
    let extensionId: string;
    let facebook: Page;
    /** Each mock's request count once the server is up: `route-eval` and `route-eval factcheck` have used both. */
    const baseline = { model: 0, searches: 0 };

    test.beforeAll(async () => {
      searx = await startMockSearxng({ hits });
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
        PERSPECTIVES: 'on',
        SEARCH_PROVIDER: 'searxng',
        SEARCH_URL: searx?.url ?? '',
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

    test('test_e2e_perspectives_through_self_hosted_server', async () => {
      test.setTimeout(180_000);
      const { server, ai } = started();
      await allowServer(context, extensionId);
      await signInFromSettings(context, extensionId, server.url, EMAIL);
      const options = await context.newPage();
      await options.goto(`chrome-extension://${extensionId}/options.html#/ai`);
      // Enabled because the server offers UnEcho Chamber.
      await turnOnLabs(options, PERSPECTIVES);

      facebook = await facebookFeed(context);
      const posts = facebook.locator('[role="feed"] > div');
      const [friends, share] = [posts.nth(0), posts.nth(1)];
      await expect(perspectivesButton(share)).toBeVisible({ timeout: 20_000 });
      await expect(perspectivesButton(friends)).toHaveCount(0);

      // The price, before anything is sent.
      const ui = share.locator('unalgo-post');
      await perspectivesButton(share).click();
      await expect(ui.getByText(FREE, { exact: true })).toBeVisible();
      const searches = () => (searx?.queries ?? []).slice(baseline.searches);
      const modelBodies = () => ai.bodies.slice(baseline.model).filter(isPerspectivesRequest);
      expect(searches()).toEqual([]);
      expect(modelBodies()).toEqual([]);

      await ui.getByRole('button', { name: 'Compare', exact: true }).click();
      await expect(ui.getByRole('button', { name: 'See result' })).toBeVisible(COMPARE_TIMEOUT);

      // One search per bucket: three found coverage, two are gaps.
      expect(searches()).toHaveLength(5);
      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      await facebook.bringToFront();
      await expectComparisonSheet(panel);

      // The model saw the link and its title, never the post's text; the server logged neither link nor title.
      const bodies = modelBodies();
      expect(bodies.some((b) => b.includes(STORY_PHRASE) && b.includes(LINK_TITLE))).toBe(true);
      expect(bodies.some((b) => b.includes(COMPARISON_PHRASE))).toBe(true);
      for (const body of bodies) expect(body).not.toContain(LINK_POST_TEXT);
      const logs = server.logs();
      expect(logs).not.toContain(LINK_URL);
      expect(logs).not.toContain(LINK_TITLE);
    });
  });
