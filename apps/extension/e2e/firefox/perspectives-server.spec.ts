import { COMPARISON_PHRASE, type MockVerdict, STORY_PHRASE } from '@unalgorithm/ai/testing';
import { FIXTURE_LIST } from '@unalgorithm/outlets/testing';
import { BUCKET_LABELS } from '@unalgorithm/protocol';
import { type MockSearxng, startMockSearxng } from '@unalgorithm/research/testing';
import { FB_PUBLIC_FLAGGED } from '../fixtures.ts';
import {
  COVERED,
  coverageHit,
  coveredBucketInQuery,
  first8,
  GAPS,
  LINK_POST_TEXT,
  LINK_TITLE,
  LINK_URL,
  PERSPECTIVES,
  PERSPECTIVES_START,
  today,
} from '../perspectives-fixtures.ts';
import { useLocalServer } from '../server-lifecycle.ts';
import { aria, click, count, type FirefoxProfile, launchFirefox, pageText, visible } from './driver.ts';
import {
  allowLocal,
  expect,
  facebookFeed,
  facebookPost,
  GRANT_REQUESTS,
  seeResultHint,
  signInFromSettings,
  test,
  turnOnLabs,
} from './fixtures.ts';

/**
 * UnEcho Chamber through a self-hosted server in Firefox (P3-41, ADR 0008), as `../perspectives-server.spec.ts`
 * checks Chromium and Edge: the add-on, signed in to the real server with `PERSPECTIVES=on`, goes from the public
 * Facebook link share to the comparison on the Highlights page (opened as a tab beside the feed) with no key in the
 * browser. The comparison request carries the e2e build's fictional source list; unAlgorithm Cloud's own list is never
 * fetched, which the profile's proxy shows. Needs Postgres and Mailpit, so it runs only with `UA_SERVER_E2E=1`.
 */
const EMAIL = 'tester@example.com';
const FREE = 'Free on this server';
const COMPARE_TIMEOUT = 60_000;
const [FRIENDS_POST, SHARE] = [facebookPost(0), facebookPost(1)];
const startButton = (post: string) => `${post} unalgo-post >>> ${aria('button', PERSPECTIVES_START)}`;

function verdict(text: string): MockVerdict {
  const news = text.includes(FB_PUBLIC_FLAGGED);
  return { relevance: news ? 90 : 50, noise: [], topics: ['other'], isNews: news };
}

type Hit = { url: string; title: string; snippet: string; published: string | null };

/** As `../perspectives-server.spec.ts`: one article dated today per covered bucket, none for the gaps. */
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
  .serial('UnEcho Chamber through a self-hosted server in Firefox', () => {
    test.skip(process.env.UA_SERVER_E2E !== '1', 'needs Postgres and Mailpit');

    let searx: MockSearxng | undefined;
    let firefox: FirefoxProfile | undefined;
    const baseline = { model: 0, searches: 0 };

    test.beforeAll(async () => {
      searx = await startMockSearxng({ hits });
    });

    test.afterAll(async () => {
      try {
        await firefox?.close();
      } finally {
        await searx?.close();
      }
    });

    const started = useLocalServer(
      () => ({ FACTCHECK: 'on', PERSPECTIVES: 'on', SEARCH_PROVIDER: 'searxng', SEARCH_URL: searx?.url ?? '' }),
      { verdict },
    );

    test.beforeAll(async () => {
      const { ai } = started();
      baseline.model = ai.bodies.length;
      baseline.searches = searx?.queries.length ?? 0;
      firefox = await launchFirefox({ prefs: GRANT_REQUESTS });
    });

    test('test_firefox_perspectives_through_self_hosted_server', async () => {
      test.setTimeout(180_000);
      const profile = firefox as FirefoxProfile;
      const { server, ai } = started();
      allowLocal(profile);
      const options = await signInFromSettings(profile, server.url, EMAIL);
      await turnOnLabs(options, PERSPECTIVES);

      const facebook = await facebookFeed(profile);
      await visible(facebook, startButton(SHARE), 20_000);
      expect(await count(facebook, startButton(FRIENDS_POST))).toBe(0);

      // The price, before anything is sent.
      await click(facebook, startButton(SHARE));
      await expect.poll(() => pageText(facebook)).toContain(FREE);
      const searches = () => (searx?.queries ?? []).slice(baseline.searches);
      const modelBodies = () => ai.bodies.slice(baseline.model).filter(isPerspectivesRequest);
      expect(searches()).toEqual([]);
      expect(modelBodies()).toEqual([]);

      await click(facebook, `${SHARE} unalgo-post >>> ${aria('button', 'Compare')}`);
      await visible(facebook, `${SHARE} unalgo-post >>> ${aria('button', 'See result')}`, COMPARE_TIMEOUT);

      // One search per bucket: three found coverage, two are gaps.
      expect(searches()).toHaveLength(5);
      const panel = await profile.open('sidepanel.html');
      await facebook.bringToFront();
      await expect.poll(() => pageText(panel), { timeout: 15_000 }).toContain('AI-generated');
      // Each bucket by its label: coverage under Left, Center and Right, "No coverage found" under the two gaps.
      const buckets = await panel.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll('.ua-perspectives-bucket')].map((b) => [
            b.querySelector('.ua-perspectives-bucket-label')?.textContent?.trim() ?? '',
            { text: (b as HTMLElement).innerText, links: [...b.querySelectorAll('a')].map((a) => a.getAttribute('href')) },
          ]),
        ),
      );
      for (const bucket of COVERED) {
        const hit = coverageHit(bucket);
        expect(buckets[BUCKET_LABELS[bucket]]?.links).toContain(hit.url);
        expect(buckets[BUCKET_LABELS[bucket]]?.text).toContain(hit.outlet);
      }
      for (const bucket of GAPS) expect(buckets[BUCKET_LABELS[bucket]]?.text).toContain('No coverage found');
      const sheet = await pageText(panel);
      const agreed = await panel.waitForSelector(aria('region', 'Agreed across sides'));
      expect(await agreed?.$$eval('blockquote', (quotes) => quotes.map((q) => q.textContent))).toEqual([
        first8(coverageHit('left').passage),
        first8(coverageHit('center').passage),
      ]);
      expect(sheet).toContain(
        `Leans come from unAlgorithm Cloud's source list (version ${FIXTURE_LIST.version}), set by people with evidence, never by AI.`,
      );
      await seeResultHint(facebook, SHARE);

      // The model saw the link and its title, never the post's text; the server logged neither link nor title.
      const bodies = modelBodies();
      expect(bodies.some((b) => b.includes(STORY_PHRASE) && b.includes(LINK_TITLE))).toBe(true);
      expect(bodies.some((b) => b.includes(COMPARISON_PHRASE))).toBe(true);
      for (const body of bodies) expect(body).not.toContain(LINK_POST_TEXT);
      const logs = server.logs();
      expect(logs).not.toContain(LINK_URL);
      expect(logs).not.toContain(LINK_TITLE);
      // The e2e build carries its list; nothing went to unAlgorithm Cloud for one.
      expect(profile.proxy.refused.filter((target) => target.startsWith('cloud.unalgorithm.app'))).toEqual([]);
      expect(profile.proxy.requests.filter((r) => r.url.startsWith('https://cloud.unalgorithm.app'))).toEqual([]);
    });
  });
