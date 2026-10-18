import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import {
  type AnthropicRequestKind,
  classifyMessage,
  requestKind,
  researchMessage,
  structuredMessage,
} from '@unalgorithm/ai/testing/anthropic';
import { FIXTURE_MARKER } from '@unalgorithm/outlets/testing';
import { LEAN_BUCKETS } from '@unalgorithm/protocol';
import {
  answerAnthropicModels,
  CORS,
  type ExtensionBrowser,
  expect,
  extensionPath,
  FB_PUBLIC_FLAGGED,
  facebookFeed,
  LINKEDIN_FLAGGED,
  linkedinPost,
  saveSource,
  seeResult,
  test,
  turnOnLabs,
} from './fixtures.ts';
import {
  type COVERED,
  compare as compareAt,
  coverageHit,
  coveredBucketFor,
  domainsOf,
  expectComparisonSheet,
  facebookPosts,
  first8,
  LINK_POST_TEXT,
  LINK_TITLE,
  LINK_URL,
  PERSPECTIVES,
  PERSPECTIVES_START,
  perspectivesButton,
  today,
} from './perspectives-fixtures.ts';

/**
 * UnEcho Chamber end to end on the person's own Anthropic key (P3-41, RM3): the real extension in Chromium, built in
 * e2e mode (so unAlgorithm Cloud's list, the default choice, is the fictional fixture), goes from the public Facebook
 * link share to the comparison in the side panel, with nothing but a mocked api.anthropic.com answered through
 * `context.route`. Every other request is aborted by the fixtures. No server, no Docker.
 */

/** An Anthropic-shaped key: only the mock ever sees it. */
const API_KEY = `sk-ant-api03-E2E${'P'.repeat(40)}`;
const PRICE = 'About $0.14 on your Anthropic account';
/** The project's store build, as `pnpm zip` leaves it (CI builds it before the end-to-end tests). */
const storeBuild = (browser: ExtensionBrowser) =>
  resolve(dirname(fileURLToPath(import.meta.url)), `../.output/${browser === 'edge' ? 'edge' : 'chrome'}-mv3`);

interface MockAnthropic {
  kinds: AnthropicRequestKind[];
  bodies: Record<string, unknown>[];
  /** The requests of the comparison: every one but `classify`. */
  comparison(): { kind: AnthropicRequestKind; body: Record<string, unknown> }[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The text of a messages body's first user turn. */
function userText(body: Record<string, unknown>): string {
  const user = (Array.isArray(body.messages) ? body.messages : []).find((m) => isRecord(m) && m.role === 'user');
  const content: unknown = isRecord(user) ? user.content : undefined;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((b) => (isRecord(b) && typeof b.text === 'string' ? b.text : '')).join('') : '';
}

/** A research request's web search tool. */
function searchTool(body: Record<string, unknown>): Record<string, unknown> {
  const [tool] = Array.isArray(body.tools) ? body.tools : [];
  return isRecord(tool) ? tool : {};
}

/** The source tags of a comparison request: id → domain. */
function sourceTags(user: string): Map<string, string> {
  return new Map([...user.matchAll(/<source_\w+ id="(s\d+)"[^>]*? domain="([^"]+)"/g)].map(([, id = '', d = '']) => [id, d]));
}

/**
 * Route api.anthropic.com by request kind: the public link share is news, nothing else is; the story query; per
 * bucket search, one dated article on Left, Center and Right and nothing on the two lean buckets; a comparison that
 * matches every source, agrees across Left and Center, frames differently and has one point only Right reported.
 */
async function mockAnthropic(context: BrowserContext): Promise<MockAnthropic> {
  const mock: MockAnthropic = {
    kinds: [],
    bodies: [],
    comparison: () => mock.kinds.flatMap((kind, i) => (kind === 'classify' ? [] : [{ kind, body: mock.bodies[i] ?? {} }])),
  };
  await context.route('https://api.anthropic.com/**', (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (answerAnthropicModels(route)) return;
    const parsed: unknown = request.postDataJSON();
    const body = isRecord(parsed) ? parsed : {};
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
            // The link share and the flagged LinkedIn post are picks (so a test sees they were classified); only the
            // link share is news.
            const news = text.includes(FB_PUBLIC_FLAGGED);
            return { relevance: news || text.includes(LINKEDIN_FLAGGED) ? 90 : 50, isNews: news, hasCheckableClaims: false };
          }),
        );
      case 'story':
        return json(200, structuredMessage({ query: 'city transit budget approved' }));
      case 'research': {
        const domains = searchTool(body).allowed_domains;
        const bucket = coveredBucketFor(Array.isArray(domains) ? domains.map(String) : []);
        if (!bucket) return json(200, researchMessage({ results: [], notes: [{ text: 'No coverage found.' }], searches: 1 }));
        const hit = coverageHit(bucket);
        return json(
          200,
          researchMessage({
            results: [{ url: hit.url, title: hit.title, pageAge: today() }],
            notes: [{ text: 'The council approved the budget.', cites: [{ url: hit.url, citedText: hit.passage }] }],
            searches: 1,
          }),
        );
      }
      case 'comparison': {
        const tags = sourceTags(userText(body));
        const idOf = (bucket: (typeof COVERED)[number]) =>
          [...tags].find(([, domain]) => domain === new URL(coverageHit(bucket).url).hostname)?.[0] ?? '';
        const cite = (bucket: (typeof COVERED)[number]) => ({
          sourceId: idOf(bucket),
          quote: first8(coverageHit(bucket).passage),
        });
        return json(
          200,
          structuredMessage(
            {
              matched: [...tags.keys()],
              agreed: [{ text: 'The city council approved the transit budget.', citations: [cite('left'), cite('center')] }],
              differences: [
                {
                  kind: 'framing',
                  text: 'Some coverage leads with new routes, some with cost.',
                  citations: [cite('center'), cite('right')],
                },
              ],
              unique: [{ text: 'The budget raises a transit levy.', citations: [cite('right')] }],
            },
            { model: 'claude-sonnet-5-5' },
          ),
        );
      }
      default:
        return json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'unexpected request' } });
    }
  });
  return mock;
}

/** Save the Anthropic source from an extension page; with `labs`, turn UnEcho Chamber on. */
async function setUp(context: BrowserContext, extensionId: string, opts: { labs: boolean }): Promise<Page> {
  const options = await saveSource(context, extensionId, { kind: 'anthropic', model: null }, API_KEY);
  if (opts.labs) await turnOnLabs(options, PERSPECTIVES);
  return options;
}

/** UnEcho Chamber on the link share: the price, then Compare, then "See result". */
const compare = (share: Locator) => compareAt(share, PRICE);

test('test_e2e_perspectives_offer_follows_labs_and_audience', async ({ context, extensionId, feed }) => {
  const mock = await mockAnthropic(context);
  const options = await setUp(context, extensionId, { labs: false });
  const linkedin = await feed();
  const facebook = await facebookFeed(context);
  const { friends, share } = facebookPosts(facebook);

  // UnEcho Chamber off: both feeds classified (their picks marked), and no post offers UnEcho Chamber.
  await expect(linkedinPost(linkedin)).toHaveAttribute('data-unalgo-pick', '');
  await expect(share).toHaveAttribute('data-unalgo-pick', '');
  for (const page of [linkedin, facebook])
    await expect(page.locator('unalgo-post').getByRole('button', { name: PERSPECTIVES_START })).toHaveCount(0);

  // UnEcho Chamber on: only the public link share the mock called news gets it.
  await turnOnLabs(options, PERSPECTIVES);
  await expect(perspectivesButton(share)).toBeVisible();
  await expect(perspectivesButton(friends)).toHaveCount(0);
  await expect(facebook.locator('unalgo-post').getByRole('button', { name: PERSPECTIVES_START })).toHaveCount(1);
  await expect(linkedin.locator('unalgo-post').getByRole('button', { name: PERSPECTIVES_START })).toHaveCount(0);
  // Offered, never started: nothing but classification reached the model.
  expect(mock.comparison()).toEqual([]);
});

test('test_e2e_perspectives_own_key_result_with_gaps', async ({ context, extensionId }) => {
  await mockAnthropic(context);
  await setUp(context, extensionId, { labs: true });
  const facebook = await facebookFeed(context);
  const { share } = facebookPosts(facebook);
  await compare(share);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await facebook.bringToFront();
  const sheet = await expectComparisonSheet(panel);
  await expect(sheet.getByRole('region', { name: 'Differences' }).getByText('Framing', { exact: true })).toBeVisible();
  const only = sheet.getByRole('region', { name: 'Only one side reported' });
  await expect(only.getByText('Right', { exact: true })).toBeVisible();
  await expect(only.locator('blockquote')).toHaveText([first8(coverageHit('right').passage)]);

  await seeResult(share.locator('unalgo-post'));
});

test('test_e2e_perspectives_only_link_leaves', async ({ context, extensionId }) => {
  const mock = await mockAnthropic(context);
  await setUp(context, extensionId, { labs: true });
  const { share } = facebookPosts(await facebookFeed(context));
  await compare(share);

  const requests = mock.comparison();
  const of = (kind: AnthropicRequestKind) => requests.filter((r) => r.kind === kind).map((r) => r.body);
  expect(requests).toHaveLength(7);
  expect(of('story')).toHaveLength(1);
  expect(of('comparison')).toHaveLength(1);

  // One search per bucket, each on exactly that bucket's two fixture domains, one search each.
  const research = of('research').map(searchTool);
  expect(research).toHaveLength(5);
  for (const tool of research) expect(tool.max_uses).toBe(1);
  const searched = research.map((tool) => [...(tool.allowed_domains as string[])].sort());
  expect(searched.sort()).toEqual(LEAN_BUCKETS.map((b) => domainsOf(b).sort()).sort());
  for (const domains of searched) expect(domains).toHaveLength(2);

  // Only the link and its title: never the post's text, never the link's tracking parameter.
  for (const { body } of requests) {
    const text = JSON.stringify(body);
    expect(text).not.toContain(LINK_POST_TEXT);
    expect(text).not.toContain('utm_source');
  }
  const story = JSON.stringify(of('story')[0]);
  expect(story).toContain(LINK_URL);
  expect(story).toContain(LINK_TITLE);
});

test('test_e2e_store_build_has_no_fixture_registry', ({ extensionBrowser }) => {
  const store = storeBuild(extensionBrowser);
  test.skip(!existsSync(store), `no store build in ${store} (CI builds it with \`pnpm zip\`)`);
  // The fixture's names and domains are built at run time, so the marker in its evidence notes marks it in a bundle;
  // the e2e build, which holds the fixture, shows the marker finds it.
  const markers = [FIXTURE_MARKER];
  const holding = (dir: string) => files(dir).filter((file) => markers.some((m) => readFileSync(file, 'latin1').includes(m)));
  expect(holding(extensionPath(extensionBrowser)).length).toBeGreaterThan(0);
  expect(holding(store)).toEqual([]);
});

/** Every file under `dir`. */
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}
