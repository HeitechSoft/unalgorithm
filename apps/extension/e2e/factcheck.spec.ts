import type { BrowserContext, Locator, Page } from '@playwright/test';
import {
  type AnthropicRequestKind,
  classifyMessage,
  requestKind,
  researchMessage,
  structuredMessage,
} from '@unalgorithm/ai/testing/anthropic';
import {
  CHECK_FACTS,
  CORS,
  checkButtons,
  expect,
  FACTCHECK_SOURCES,
  FB_FRIENDS_FLAGGED,
  FLAGGED,
  facebookFeed,
  linkedinPost,
  runCheck as runCheckAt,
  saveSource,
  seeResult,
  storedChecks,
  test,
  turnOnLabs,
} from './fixtures.ts';

/**
 * Fact-check end to end (P3-09): the real extension in Chromium goes from a flagged post to a stored, validated result
 * with nothing but a mocked api.anthropic.com, answered through `context.route` by the P3-02 responder. Every other
 * request is aborted by the fixtures. No server, no Docker.
 */

/** An Anthropic-shaped key: only the mock ever sees it. */
const API_KEY = `sk-ant-api03-E2E${'F'.repeat(40)}`;
const PRICE = 'About $0.12 on your Anthropic account';

const SOURCES = FACTCHECK_SOURCES;
const [A, B, C] = SOURCES;

/** Every Anthropic request the mock answered, with its kind. */
interface MockAnthropic {
  kinds: AnthropicRequestKind[];
  bodies: unknown[];
  count(kind: AnthropicRequestKind): number;
}

/** Route api.anthropic.com to the P3-02 responder: classify by phrase, two claims, three sources, two verdicts. */
async function mockAnthropic(context: BrowserContext): Promise<MockAnthropic> {
  const mock: MockAnthropic = {
    kinds: [],
    bodies: [],
    count: (kind) => mock.kinds.filter((k) => k === kind).length,
  };
  await context.route('https://api.anthropic.com/**', (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const body: unknown = request.postDataJSON();
    const kind = requestKind(body);
    mock.kinds.push(kind);
    mock.bodies.push(body);
    const json = (status: number, payload: unknown) =>
      route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(payload) });
    switch (kind) {
      case 'classify':
        return json(
          200,
          classifyMessage(body, (text) => {
            const flagged = FLAGGED.some((phrase) => text.includes(phrase));
            return { relevance: flagged ? 90 : 50, isNews: false, hasCheckableClaims: flagged };
          }),
        );
      case 'claims':
        return json(
          200,
          structuredMessage({
            claims: [
              { claim: 'HR teams would automate interview scheduling first.' },
              { claim: 'Northwind Clinics has an HR director.' },
            ],
          }),
        );
      case 'research':
        return json(
          200,
          researchMessage({
            results: SOURCES.map(({ url, title }) => ({ url, title })),
            notes: SOURCES.map(({ url, passage }) => ({ text: 'Found this.', cites: [{ url, citedText: passage }] })),
          }),
        );
      case 'verdict':
        // Sources are numbered in the order the search returned them: a → s1, b → s2, c → s3.
        return json(
          200,
          structuredMessage(
            {
              verdicts: [
                {
                  claimId: 'c1',
                  verdict: 'supported',
                  explanation: 'Two surveys name interview scheduling.',
                  citations: [
                    { sourceId: 's1', quote: A.quote },
                    { sourceId: 's2', quote: B.quote },
                  ],
                },
                {
                  claimId: 'c2',
                  verdict: 'supported',
                  explanation: 'A staffing page names the role.',
                  citations: [{ sourceId: 's3', quote: C.quote }],
                },
              ],
            },
            { model: 'claude-sonnet-5-5' },
          ),
        );
      default:
        return json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'unexpected request' } });
    }
  });
  return mock;
}

/** Save the Anthropic source from an extension page, and turn Labs → Fact-check on through the options page's switch. */
async function setUp(context: BrowserContext, extensionId: string, opts: { labs: boolean }): Promise<Page> {
  const options = await saveSource(context, extensionId, { kind: 'anthropic', model: null }, API_KEY);
  if (opts.labs) await turnOnLabs(options);
  return options;
}

/** The flagged post came back from the mock classified (its high relevance makes it a pick). */
async function classified(page: Page, mock: MockAnthropic): Promise<void> {
  await expect(linkedinPost(page)).toHaveAttribute('data-unalgo-pick', '');
  expect(mock.count('classify')).toBeGreaterThan(0);
}

/** Price, then Check, then "See result". */
const runCheck = (post: Locator) => runCheckAt(post, PRICE);

test.describe('offer', () => {
  test('test_e2e_labs_off_shows_no_check_button', async ({ context, extensionId, feed }) => {
    const mock = await mockAnthropic(context);
    await setUp(context, extensionId, { labs: false });
    const page = await feed();
    await classified(page, mock);
    await expect(checkButtons(page)).toHaveCount(0);
  });

  test('test_e2e_labs_on_button_only_on_flagged_post', async ({ context, extensionId, feed }) => {
    const mock = await mockAnthropic(context);
    const options = await setUp(context, extensionId, { labs: false });
    const page = await feed();
    await classified(page, mock);
    await expect(checkButtons(page)).toHaveCount(0);

    await turnOnLabs(options);
    await expect(linkedinPost(page).locator('unalgo-post').getByRole('button', { name: CHECK_FACTS })).toBeVisible();
    await expect(checkButtons(page)).toHaveCount(1);
    expect(mock.kinds.filter((k) => k !== 'classify')).toEqual([]);
  });

  test('test_e2e_facebook_friends_post_never_offered', async ({ context, extensionId }) => {
    const mock = await mockAnthropic(context);
    await setUp(context, extensionId, { labs: true });
    const page = await facebookFeed(context);
    const [friends, publicPost] = [0, 1].map((i) => page.locator('[role="feed"] > div').nth(i));
    await expect(publicPost.locator('unalgo-post').getByRole('button', { name: CHECK_FACTS })).toBeVisible();
    // The friends-only post was classified and flagged too, and still never gets the action.
    expect(JSON.stringify(mock.bodies)).toContain(FB_FRIENDS_FLAGGED);
    await expect(friends.locator('unalgo-post').getByRole('button', { name: CHECK_FACTS })).toHaveCount(0);
    await expect(checkButtons(page)).toHaveCount(1);
  });
});

test.describe('price and run', () => {
  test('test_e2e_price_shown_before_any_request', async ({ context, extensionId, feed }) => {
    const mock = await mockAnthropic(context);
    await setUp(context, extensionId, { labs: true });
    const page = await feed();
    const ui = linkedinPost(page).locator('unalgo-post');
    await ui.getByRole('button', { name: CHECK_FACTS }).click();
    await expect(ui.getByText(PRICE)).toBeVisible();
    await expect(ui.getByRole('button', { name: 'Check', exact: true })).toBeFocused();
    expect(mock.count('claims')).toBe(0);
  });

  test('test_e2e_cancel_sends_nothing', async ({ context, extensionId, feed }) => {
    const mock = await mockAnthropic(context);
    await setUp(context, extensionId, { labs: true });
    const page = await feed();
    const ui = linkedinPost(page).locator('unalgo-post');
    await ui.getByRole('button', { name: CHECK_FACTS }).click();
    await expect(ui.getByText(PRICE)).toBeVisible();
    await ui.getByRole('button', { name: 'Cancel' }).click();
    await expect(ui.getByRole('button', { name: CHECK_FACTS })).toBeVisible();
    await expect(ui.getByText(PRICE)).toHaveCount(0);
    expect(mock.kinds.filter((k) => k !== 'classify')).toEqual([]);
    expect(await storedChecks(context)).toEqual({});
  });

  test('test_e2e_check_stores_validated_result', async ({ context, extensionId, feed }) => {
    const mock = await mockAnthropic(context);
    await setUp(context, extensionId, { labs: true });
    const page = await feed();
    await runCheck(linkedinPost(page));

    expect(mock.kinds.filter((k) => k !== 'classify')).toEqual(['claims', 'research', 'verdict']);
    const stored = Object.values(await storedChecks(context));
    expect(stored).toHaveLength(1);
    const [entry] = stored[0]?.entries ?? [];
    expect(entry?.status).toBe('done');
    expect(entry?.result?.claims).toHaveLength(2);
    expect(entry?.result?.claims[0]).toMatchObject({ id: 'c1', verdict: 'supported' });
    expect(entry?.result?.claims[0]?.downgraded).toBeUndefined();
    expect(entry?.result?.claims[1]).toMatchObject({ id: 'c2', verdict: 'unverifiable', downgraded: 'too-few-domains' });
  });

  test('test_e2e_side_panel_shows_result', async ({ context, extensionId, feed }) => {
    await mockAnthropic(context);
    await setUp(context, extensionId, { labs: true });
    const page = await feed();
    await runCheck(linkedinPost(page));

    // The stored entry holds the validated verdicts and quotes either way.
    const [stored] = Object.values(await storedChecks(context));
    const claims = stored?.entries[0]?.result?.claims ?? [];
    expect(claims.map((c) => [c.id, c.verdict])).toEqual([
      ['c1', 'supported'],
      ['c2', 'unverifiable'],
    ]);
    expect(claims[0]?.citations.map((c) => c.quote)).toEqual([A.quote, B.quote]);
    expect(claims[1]?.citations.map((c) => c.quote)).toEqual([C.quote]);

    // The side panel as a page; bringing the feed to the front makes it the panel's active tab.
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await page.bringToFront();
    await expect(panel.getByText('AI-generated')).toBeVisible();
    await expect(panel.getByText('Supported', { exact: true })).toBeVisible();
    await expect(panel.getByText("Can't verify", { exact: true })).toBeVisible();
    for (const { quote } of SOURCES) await expect(panel.getByText(quote, { exact: true })).toBeVisible();

    // P3-06's gesture question: does `sidePanel.open` from the relayed click succeed? Recorded, not required.
    await seeResult(linkedinPost(page).locator('unalgo-post'));
  });
});

test.describe('network', () => {
  test('test_e2e_only_anthropic_and_fixture_hosts_contacted', async ({ context, extensionId, feed }) => {
    const hosts = new Set<string>();
    context.on('request', (request) => {
      const url = new URL(request.url());
      if (url.protocol !== 'chrome-extension:' && url.protocol !== 'data:') hosts.add(url.host);
    });
    const mock = await mockAnthropic(context);
    await setUp(context, extensionId, { labs: true });
    const page = await feed();
    await runCheck(linkedinPost(page));
    await facebookFeed(context);
    await expect.poll(() => mock.count('classify')).toBeGreaterThan(1);

    expect(hosts).toContain('api.anthropic.com');
    expect([...hosts].filter((h) => !['www.linkedin.com', 'www.facebook.com', 'api.anthropic.com'].includes(h))).toEqual([]);
  });
});
