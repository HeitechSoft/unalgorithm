import type { BrowserContext, Page, Route } from '@playwright/test';
import { CLAIMS_PHRASE, type MockOpenAI, type MockVerdict, startMockOpenAI } from '@unalgorithm/ai/testing';
import {
  mockResponsesAnswer,
  type ResponsesRequestKind,
  researchResponse,
  responsesRequestKind,
  structuredResponse,
} from '@unalgorithm/ai/testing/openai-responses';
import { LEAN_BUCKETS } from '@unalgorithm/protocol';
import {
  CHECK_FACTS,
  CORS,
  checkButtons,
  expect,
  FACTCHECK_SOURCES,
  FB_FRIENDS_FLAGGED,
  FB_PUBLIC_FLAGGED,
  FLAGGED,
  facebookFeed,
  linkedinPost,
  runCheck,
  saveSource,
  test,
  turnOnLabs,
} from './fixtures.ts';
import {
  compare,
  coverageHit,
  coveredBucketFor,
  coveredBucketInQuery,
  domainsOf,
  expectComparisonSheet,
  facebookPosts,
  first8,
  LINK_POST_TEXT,
  LINK_URL,
  PERSPECTIVES,
  perspectivesButton,
  today,
} from './perspectives-fixtures.ts';

/**
 * Fact-check and UnEcho Chamber end to end on RM4's own-key modes (P3-47): the real extension in Chromium on an own
 * OpenAI key (a mocked api.openai.com) and on an OpenAI-compatible server (the mock OpenAI server on 127.0.0.1) with a
 * Brave key entered in Settings → AI (a mocked api.search.brave.com). The e2e build has both hosts from the start,
 * since Playwright can't answer a permission prompt. Every other request is aborted by the fixtures. No server, no Docker.
 */

/** Keys only the mocks ever see. */
const OPENAI_KEY = `sk-proj-E2E${'O'.repeat(40)}`;
const BRAVE_KEY = `BSA-E2E${'B'.repeat(24)}`;
const OPENAI_SOURCE = { kind: 'openai', model: null };

const PRICE = {
  openaiFactcheck: 'About $0.09 on your OpenAI account',
  openaiPerspectives: 'About $0.10 on your OpenAI account',
  compatFactcheck: 'Free on this computer, plus up to 3 searches on your Brave key',
  compatPerspectives: 'Free on this computer, plus up to 5 searches on your Brave key',
};
const NEEDS_KEY = 'Needs a web search key (above).';

/** The flagged LinkedIn post's whole text and author, and the Facebook link share's author: none may reach a search. */
const LINKEDIN_POST_TEXT = 'Which HR task would you automate first if you had an AI assistant for a month?';
const LINKEDIN_AUTHOR = 'Morgan Ellis';
const LINK_AUTHOR = 'Sam Ortiz';

const [A, B, C] = FACTCHECK_SOURCES;

/** Two claims, each searchable without the post's text. */
const CLAIMS = [
  { claim: 'HR teams would automate interview scheduling first.' },
  { claim: 'Northwind Clinics has an HR director.' },
];

/** The classifier: the specs' flagged posts make checkable claims, and the Facebook link share is news. */
function verdict(text: string): MockVerdict {
  const flagged = FLAGGED.some((phrase) => text.includes(phrase));
  return {
    relevance: flagged ? 90 : 50,
    noise: [],
    topics: ['other'],
    isNews: text.includes(FB_PUBLIC_FLAGGED),
    hasCheckableClaims: flagged,
  };
}

const json = (route: Route, status: number, payload: unknown) =>
  route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(payload) });

// ---------- api.openai.com ----------

interface MockOpenAIApi {
  kinds: ResponsesRequestKind[];
  bodies: Record<string, unknown>[];
  /** The requests from index `from` on, classify excluded (classify bodies carry post text by design). */
  runs(from?: number): { kind: ResponsesRequestKind; body: Record<string, unknown> }[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A research body's `allowed_domains` filter: a bucket search has one, the fact-check search none. */
function allowedDomains(body: Record<string, unknown>): string[] | undefined {
  const [tool] = Array.isArray(body.tools) ? body.tools : [];
  const domains = isRecord(tool) && isRecord(tool.filters) ? tool.filters.allowed_domains : undefined;
  return Array.isArray(domains) ? domains.map(String) : undefined;
}

/** The fact-check search: two completed searches over the three sources, then a text citing each one's passage. */
function factcheckResearch(): Record<string, unknown> {
  let text = '';
  const citations = FACTCHECK_SOURCES.map(({ url, title, passage }) => {
    const start = text.length;
    text += `${passage} `;
    return { url, title, start, end: start + passage.length };
  });
  return researchResponse({ searches: [{ urls: [A.url, B.url] }, { urls: [C.url] }], text: text.trim(), citations });
}

/** One bucket search: the covered bucket's article (dated in its path: OpenAI's sources carry no date), else nothing. */
function bucketResearch(domains: string[]): Record<string, unknown> {
  const bucket = coveredBucketFor(domains);
  if (!bucket)
    return researchResponse({ searches: [{ urls: [] }], text: 'No coverage found.', citations: [], model: 'gpt-5-mini' });
  const hit = coverageHit(bucket);
  return researchResponse({
    searches: [{ urls: [hit.url] }],
    text: hit.passage,
    citations: [{ url: hit.url, title: hit.title, start: 0, end: hit.passage.length }],
    model: 'gpt-5-mini',
  });
}

/** Route api.openai.com: the model list, and every Responses call by its kind (P3-42's builders); each body recorded. */
async function mockOpenAIApi(context: BrowserContext): Promise<MockOpenAIApi> {
  const mock: MockOpenAIApi = {
    kinds: [],
    bodies: [],
    runs: (from = 0) =>
      mock.kinds
        .map((kind, i) => ({ kind, body: mock.bodies[i] ?? {} }))
        .slice(from)
        .filter((r) => r.kind !== 'classify'),
  };
  await context.route('https://api.openai.com/**', (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const { pathname } = new URL(request.url());
    if (request.method() === 'GET' && pathname === '/v1/models')
      return json(route, 200, {
        object: 'list',
        data: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano'].map((id) => ({ id, object: 'model', created: 0, owned_by: 'openai' })),
      });
    if (request.method() !== 'POST' || pathname !== '/v1/responses')
      return json(route, 404, { error: { message: 'Not found.', type: 'invalid_request_error' } });
    const parsed: unknown = request.postDataJSON();
    const body = isRecord(parsed) ? parsed : {};
    const kind = responsesRequestKind(body);
    mock.kinds.push(kind);
    mock.bodies.push(body);
    switch (kind) {
      case 'classify':
        return json(route, 200, mockResponsesAnswer(body, verdict));
      case 'claims':
        return json(route, 200, structuredResponse({ claims: CLAIMS }));
      case 'research': {
        const domains = allowedDomains(body);
        return json(route, 200, domains ? bucketResearch(domains) : factcheckResearch());
      }
      case 'verdict':
        // Sources in the order the searches found them: a → s1, b → s2, c → s3.
        return json(
          route,
          200,
          structuredResponse(
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
            { model: 'gpt-5' },
          ),
        );
      case 'story':
      case 'comparison':
        // The RM3 answers: the link's title as the query; every source matched, agreed across the first two.
        return json(route, 200, mockResponsesAnswer(body));
      default:
        return json(route, 400, { error: { message: 'Unexpected request.', type: 'invalid_request_error' } });
    }
  });
  return mock;
}

// ---------- api.search.brave.com ----------

interface MockBrave {
  queries: string[];
  keys: (string | undefined)[];
}

/**
 * A bucket search (a `site:` clause) finds the covered bucket's article dated today, nothing for a gap; any other
 * search (a claim, or the key's test search) the three fact-check sources, whose passages the compat verdicts quote.
 */
function braveResults(q: string): unknown[] {
  if (q.includes('site:')) {
    const bucket = coveredBucketInQuery(q);
    if (!bucket) return [];
    const hit = coverageHit(bucket);
    return [{ url: hit.url, title: hit.title, description: hit.passage, page_age: today() }];
  }
  return FACTCHECK_SOURCES.map(({ url, title, passage }) => ({ url, title, description: passage }));
}

/** Route api.search.brave.com's web search, recording each `q` and `x-subscription-token`. */
async function mockBrave(context: BrowserContext): Promise<MockBrave> {
  const mock: MockBrave = { queries: [], keys: [] };
  await context.route('https://api.search.brave.com/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(request.url());
    if (request.method() !== 'GET' || url.pathname !== '/res/v1/web/search') return json(route, 404, { error: 'not found' });
    mock.queries.push(url.searchParams.get('q') ?? '');
    mock.keys.push((await request.allHeaders())['x-subscription-token']);
    return json(route, 200, { web: { results: braveResults(url.searchParams.get('q') ?? '') } });
  });
  return mock;
}

// ---------- setup ----------

/** Test and save the OpenAI key from an extension page (the model comes from the mocked list), and turn a switch on. */
async function setUpOpenAI(context: BrowserContext, extensionId: string, labs: 'Fact-check' | 'UnEcho Chamber') {
  const options = await saveSource(context, extensionId, OPENAI_SOURCE, OPENAI_KEY, { test: true });
  await turnOnLabs(options, labs);
  return options;
}

/** Save the mock server as an OpenAI-compatible source (no web search key yet). Returns Settings → AI. */
function saveCompat(context: BrowserContext, extensionId: string, ai: MockOpenAI): Promise<Page> {
  const config = { kind: 'openai-compatible', preset: 'custom', baseUrl: ai.baseUrl, auth: 'none', model: 'mock-model' };
  return saveSource(context, extensionId, config);
}

/** Settings → AI → Web search key → Brave → key → Save, through the UI. */
async function saveBraveKey(options: Page): Promise<void> {
  await options.getByRole('radio', { name: /^Brave/ }).check();
  await options.getByLabel('Brave API key').fill(BRAVE_KEY);
  await options.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(options.getByText('Connected · Brave', { exact: true })).toBeVisible();
  await expect(options.getByText('Brave key saved', { exact: true })).toBeVisible();
}

/** The side panel as a page; bringing the feed to the front makes it the panel's active tab. */
async function sidePanel(context: BrowserContext, extensionId: string, feed: Page): Promise<Page> {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await feed.bringToFront();
  return panel;
}

// ---------- OpenAI key ----------

test.describe('OpenAI key', () => {
  test('test_e2e_openai_factcheck_price_then_result', async ({ context, extensionId, feed }) => {
    const ai = await mockOpenAIApi(context);
    await setUpOpenAI(context, extensionId, 'Fact-check');
    const page = await feed();
    await expect(linkedinPost(page).locator('unalgo-post').getByRole('button', { name: CHECK_FACTS })).toBeVisible();
    await expect(checkButtons(page)).toHaveCount(1);

    // The price first, and nothing but classification before the confirm.
    await runCheck(linkedinPost(page), PRICE.openaiFactcheck, () => expect(ai.runs()).toEqual([]));
    expect(ai.runs().map((r) => r.kind)).toEqual(['claims', 'research', 'verdict']);

    const panel = await sidePanel(context, extensionId, page);
    await expect(panel.getByText('AI-generated')).toBeVisible();
    await expect(panel.getByText('Supported', { exact: true })).toBeVisible();
    // One source for the second claim is one domain: shown as "Can't verify".
    await expect(panel.getByText("Can't verify", { exact: true })).toBeVisible();
    for (const { url, quote } of FACTCHECK_SOURCES) {
      await expect(panel.getByText(quote, { exact: true })).toBeVisible();
      await expect(panel.locator(`a[href="${url}"]`).first()).toBeVisible();
    }
  });

  test('test_e2e_openai_friends_only_has_no_button', async ({ context, extensionId }) => {
    const ai = await mockOpenAIApi(context);
    await setUpOpenAI(context, extensionId, 'Fact-check');
    const page = await facebookFeed(context);
    const { friends, share } = facebookPosts(page);
    await expect(share.locator('unalgo-post').getByRole('button', { name: CHECK_FACTS })).toBeVisible();
    // The friends-only post was classified and flagged too, and still never gets the action.
    expect(JSON.stringify(ai.bodies)).toContain(FB_FRIENDS_FLAGGED);
    await expect(friends.locator('unalgo-post').getByRole('button', { name: CHECK_FACTS })).toHaveCount(0);
    await expect(checkButtons(page)).toHaveCount(1);
  });

  test('test_e2e_openai_perspectives_link_only', async ({ context, extensionId }) => {
    const ai = await mockOpenAIApi(context);
    await setUpOpenAI(context, extensionId, PERSPECTIVES);
    const page = await facebookFeed(context);
    const { share } = facebookPosts(page);
    let from = 0;
    await compare(share, PRICE.openaiPerspectives, () => {
      from = ai.kinds.length;
      expect(ai.runs()).toEqual([]);
    });

    const runs = ai.runs(from);
    const of = (kind: ResponsesRequestKind) => runs.filter((r) => r.kind === kind).map((r) => JSON.stringify(r.body));
    expect(of('story')).toHaveLength(1);
    expect(of('research')).toHaveLength(LEAN_BUCKETS.length);
    expect(of('comparison')).toHaveLength(1);
    expect(runs).toHaveLength(LEAN_BUCKETS.length + 2);
    for (const body of [...of('story'), ...of('comparison')]) expect(body).toContain(LINK_URL);
    for (const { body } of runs) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(LINK_POST_TEXT);
      expect(text).not.toContain(LINK_AUTHOR);
      expect(text).not.toContain('utm_source');
    }

    await expectComparisonSheet(await sidePanel(context, extensionId, page));
  });
});

// ---------- OpenAI-compatible with a Brave key ----------

test.describe('OpenAI-compatible with a Brave key', () => {
  let ai: MockOpenAI;

  test.beforeEach(async ({ context }) => {
    ai = await startMockOpenAI({ verdict });
    // The flagged LinkedIn post is one sentence, so the mock's claim (the post's first sentence) would be its whole
    // text: its claims answer is replaced by two claims of their own. Everything else reaches the mock server.
    await context.route('http://127.0.0.1:*/**', (route) => {
      if (!(route.request().postData() ?? '').includes(CLAIMS_PHRASE)) return route.continue();
      return json(route, 200, {
        model: 'mock-model',
        choices: [{ message: { content: JSON.stringify({ claims: CLAIMS }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 100 },
      });
    });
  });
  test.afterEach(() => ai.close());

  test('test_e2e_compat_needs_search_key_then_offers', async ({ context, extensionId, feed }) => {
    const brave = await mockBrave(context);
    const options = await saveCompat(context, extensionId, ai);
    await expect(options.getByText(NEEDS_KEY, { exact: true })).toHaveCount(2);
    await expect(options.getByRole('switch', { name: 'Fact-check' })).toBeDisabled();
    const page = await feed();
    await expect(linkedinPost(page)).toHaveAttribute('data-unalgo-pick', '');
    await expect(checkButtons(page)).toHaveCount(0);

    await saveBraveKey(options);
    // The key's one test search: a fixed word, never post content.
    expect(brave.queries).toEqual(['UnAlgorithm']);
    expect(brave.keys).toEqual([BRAVE_KEY]);
    await expect(options.getByText(NEEDS_KEY, { exact: true })).toHaveCount(0);
    await turnOnLabs(options);

    const ui = linkedinPost(page).locator('unalgo-post');
    await ui.getByRole('button', { name: CHECK_FACTS }).click();
    await expect(ui.getByText(PRICE.compatFactcheck, { exact: true })).toBeVisible();
    expect(brave.queries).toHaveLength(1);
  });

  test('test_e2e_compat_factcheck_brave_requests', async ({ context, extensionId, feed }) => {
    const brave = await mockBrave(context);
    const options = await saveCompat(context, extensionId, ai);
    await saveBraveKey(options);
    await turnOnLabs(options);
    const page = await feed();
    let from = 0;
    await runCheck(linkedinPost(page), PRICE.compatFactcheck, () => {
      from = brave.queries.length;
    });

    const searches = brave.queries.slice(from);
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.length).toBeLessThanOrEqual(3);
    expect(new Set(brave.keys)).toEqual(new Set([BRAVE_KEY]));
    for (const q of brave.queries) {
      expect(q).not.toContain(LINKEDIN_POST_TEXT);
      expect(q).not.toContain(LINKEDIN_AUTHOR);
    }
    // The search key only ever goes to Brave.
    for (const body of ai.bodies) expect(body).not.toContain(BRAVE_KEY);

    // Each claim is supported by the first two sources, quoted with their first 8 words (the mock's verdicts).
    const panel = await sidePanel(context, extensionId, page);
    await expect(panel.getByText('AI-generated')).toBeVisible();
    await expect(panel.getByText('Supported', { exact: true }).first()).toBeVisible();
    for (const source of [A, B]) {
      await expect(panel.getByText(first8(source.passage), { exact: true }).first()).toBeVisible();
      await expect(panel.locator(`a[href="${source.url}"]`).first()).toBeVisible();
    }
  });

  test('test_e2e_compat_perspectives_one_search_per_bucket', async ({ context, extensionId }) => {
    const brave = await mockBrave(context);
    const options = await saveCompat(context, extensionId, ai);
    await saveBraveKey(options);
    await turnOnLabs(options, PERSPECTIVES);
    const page = await facebookFeed(context);
    const { friends, share } = facebookPosts(page);
    await expect(perspectivesButton(friends)).toHaveCount(0);
    let from = 0;
    await compare(share, PRICE.compatPerspectives, () => {
      from = brave.queries.length;
    });

    // Counted from the confirm (the key's test search came before it): one search per bucket, on its two domains.
    const searches = brave.queries.slice(from);
    expect(searches).toHaveLength(LEAN_BUCKETS.length);
    const searched = searches.map((q) => {
      const sites = [...q.matchAll(/site:([^\s)]+)/g)].map((m) => m[1]).sort();
      expect(sites).toHaveLength(2);
      return LEAN_BUCKETS.find((b) => domainsOf(b).sort().join(',') === sites.join(','));
    });
    expect([...searched].sort()).toEqual([...LEAN_BUCKETS].sort());
    for (const q of searches) {
      expect(q).not.toContain(LINK_POST_TEXT);
      expect(q).not.toContain(LINK_AUTHOR);
    }

    await expectComparisonSheet(await sidePanel(context, extensionId, page));
  });
});
