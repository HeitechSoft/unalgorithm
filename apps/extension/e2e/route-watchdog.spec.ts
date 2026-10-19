import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page, Request } from '@playwright/test';
import { type MockOpenAI, startMockOpenAI } from '@unalgorithm/ai/testing';
import { REPORTS_PATH } from '@unalgorithm/protocol';
import { signedInShell } from '../../../packages/platforms/fixtures/linkedin/y2026.ts';
import { expect, reportGuard, test } from './fixtures.ts';
import { E2E_REPORTS_PORT, reportRows } from './server-harness.ts';
import { useLocalServer } from './server-lifecycle.ts';
import { allowServer } from './server-sign-in.ts';

/**
 * Route gating with the real LinkedIn adapter (ADR 0009 §3), on the anonymized "For you" capture served at an address
 * unAlgorithm doesn't know as the feed, `/feed/newname/` (a candidate route):
 * - with the main feed list there (a strong home signature), the controller starts and the report says `route-new`;
 * - without it (`data-testid="mainFeed"` and any `FeedType_MAIN_FEED` card keys stripped), the read-only watchdog
 *   raises `feed-not-started` after its 5 s and 12 s probes of visible time: the "isn't running" card, the popup and
 *   the toolbar say so, nothing is hidden and nothing goes to the AI;
 * - on a profile address the same page gets nothing at all;
 * - the card's *Let us know* opens the report page with the finding, and *Send report* posts exactly what it shows,
 *   to a canned answer here and to the real server's table with `UA_SERVER_E2E=1`.
 */

const here = dirname(fileURLToPath(import.meta.url));
/**
 * The capture with the label words its scrambler destroyed put back, as its golden does
 * (packages/platforms/test/golden/linkedin/2026-10-foryou-1.expect.json): otherwise its two "Partnership with" ads
 * read as a new ad label, and the healthy page would raise a card of its own.
 */
const CAPTURE = [
  { from: 'Promoted • Xxxxxxxxxxx xxxx', to: 'Promoted • Partnership with', count: 2 },
  { from: '>finds this xxxxx<', to: '>finds this funny<', count: 1 },
].reduce(
  (html, { from, to, count }) => {
    const found = html.split(from).length - 1;
    if (found !== count) throw new Error(`The capture has ${found} of "${from}", not ${count}.`);
    return html.replaceAll(from, to);
  },
  readFileSync(resolve(here, '../../../packages/platforms/fixtures/linkedin/2026-10-foryou-1.html'), 'utf8'),
);
/** The capture without what makes a strong home signature: the case where the controller doesn't start. */
const WITHOUT_SIGNATURE = CAPTURE.replaceAll('data-testid="mainFeed"', '').replaceAll('FeedType_MAIN_FEED', 'FeedType_X');

const NEW_ADDRESS = 'https://www.linkedin.com/feed/newname/';
const PROFILE = 'https://www.linkedin.com/in/someone/';
const REF = '7KQ3-M2PA';
/** Where the e2e builds send reports (`wxt.config.ts`'s `E2E_REPORTS_URL`). */
const REPORTS_AT = `http://127.0.0.1:${E2E_REPORTS_PORT}${REPORTS_PATH}`;
const CARD_TITLE = "unAlgorithm isn't running on this feed";
/** The watchdog's second probe is at 12 s of visible time; the card can't come sooner. */
const SECOND_PROBE_MS = 12_000;

/**
 * A LinkedIn page around the capture, in the signed-in shell. The capture keeps its layout as attributes (blocks and
 * what was invisible, docs/fixtures.md); the style gives them back, so the browser's own `innerText` reads the page as
 * LinkedIn's did.
 */
function linkedinPage(main: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Feed | LinkedIn</title>
<style>
  body { margin: 0; background: #f4f2ee; color: #191919; font: 14px/1.4 -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 560px; margin: 24px auto; }
  [data-ua-block] { display: block; }
  [data-ua-hidden] { display: none; }
</style></head><body>${signedInShell(main)}</body></html>`;
}

/** Serves `html` for every LinkedIn address, then opens `url` in a new page. */
async function open(context: BrowserContext, url: string, html: string): Promise<Page> {
  await context.route('https://www.linkedin.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: html }),
  );
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

/** The report page the next action opens. */
function nextReportPage(context: BrowserContext): Promise<Page> {
  return context.waitForEvent('page', { predicate: (p) => new URL(p.url()).pathname === '/report.html', timeout: 15_000 });
}

/** The popup, looking at the feed tab: opened in a tab of its own, then the feed brought to the front. */
async function popupOn(context: BrowserContext, extensionId: string, feed: Page): Promise<Page> {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await feed.bringToFront();
  await expect(popup.getByRole('switch', { name: 'unAlgorithm on LinkedIn' })).toBeVisible();
  return popup;
}

/** The exact body the report page shows under *Show exactly what's sent*. */
async function shownBody(report: Page): Promise<string> {
  await report.getByText("Show exactly what's sent").click();
  return (await report.getByRole('region', { name: "What we'll send" }).locator('pre').textContent()) ?? '';
}

/** The plain lines of *What we'll send*. */
const sendLines = (report: Page) => report.getByRole('region', { name: "What we'll send" }).getByRole('listitem');

/** The in-feed card, inside our page layer's shadow root. */
const card = (page: Page) => page.locator('unalgo-layer').getByRole('region', { name: 'unAlgorithm' });

/** What unAlgorithm put into the page itself: its fold marks and per-post hosts. The page layer isn't counted. */
const marks = (page: Page) => page.locator('[data-unalgo], unalgo-post').count();

/** The toolbar button's title for the LinkedIn tab. */
async function toolbarTitle(context: BrowserContext): Promise<string> {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  return sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
    return chrome.action.getTitle({ tabId: tab?.id ?? -1 });
  });
}

/**
 * Settings → AI set to a local OpenAI-compatible server (the mock), so a page that sends posts to the AI shows up in
 * its request log. Returns how many requests the mock had before any feed opened (the connection test's).
 */
async function aiOnMock(context: BrowserContext, extensionId: string, ai: MockOpenAI): Promise<number> {
  await context.route('http://127.0.0.1:*/**', (route) => route.continue());
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html#/ai`);
  const result = await options.evaluate(async (baseUrl) => {
    const config = { kind: 'openai-compatible', preset: 'custom', baseUrl, auth: 'none', model: null };
    const tested = await chrome.runtime.sendMessage({ type: 'testSource', config });
    if (tested?.ok) await chrome.runtime.sendMessage({ type: 'saveSource', config: { ...config, model: tested.model } });
    return tested;
  }, ai.baseUrl);
  expect(result).toMatchObject({ ok: true, model: 'mock-model' });
  await options.close();
  return ai.bodies.length;
}

/** The watchdog's card on the capture without its signature, at the new address. Returns the feed page. */
async function watchdogCard(context: BrowserContext): Promise<Page> {
  const started = Date.now();
  const page = await open(context, NEW_ADDRESS, linkedinPage(WITHOUT_SIGNATURE));
  await expect(card(page)).toBeVisible({ timeout: 25_000 });
  // Only after the second probe: the watchdog never guesses from one look.
  expect(Date.now() - started).toBeGreaterThanOrEqual(SECOND_PROBE_MS);
  return page;
}

test.describe('route gating on the real adapter', () => {
  let ai: MockOpenAI;

  test.beforeAll(async () => {
    ai = await startMockOpenAI();
  });
  test.afterAll(() => ai.close());

  test('test_strong_signature_at_a_new_address_starts_and_reports_route_new', async ({ context, extensionId }) => {
    test.setTimeout(90_000);
    const before = await aiOnMock(context, extensionId, ai);
    const page = await open(context, NEW_ADDRESS, linkedinPage(CAPTURE));
    // The controller runs: it folds the capture's ads and sends posts to the AI, as on /feed/.
    await expect(page.locator('[data-unalgo="collapsed"]').first()).toBeAttached({ timeout: 15_000 });
    await expect.poll(() => ai.bodies.length, { timeout: 15_000 }).toBeGreaterThan(before);
    // Its health checks (every 10 s visible) record the new address. Past two of them, no card: it's report-only.
    await page.waitForTimeout(22_000);
    await expect(card(page)).toHaveCount(0);

    const popup = await popupOn(context, extensionId, page);
    await expect(popup.getByText(/posts? hidden on this page/)).toBeVisible();
    await expect(popup.getByText(CARD_TITLE)).toHaveCount(0);
    const opened = nextReportPage(context);
    await popup.getByRole('button', { name: 'Report a problem' }).click();
    const report = await opened;
    await expect(sendLines(report).filter({ hasText: /^Page: LinkedIn home feed \(a new address: newname\)/ })).toHaveCount(1);
    await expect(
      sendLines(report).filter({ hasText: "unAlgorithm noticed: LinkedIn's feed is at an address unAlgorithm didn't know" }),
    ).toHaveCount(1);
    const json = JSON.parse(await shownBody(report)) as {
      page: Record<string, unknown>;
      health: { status: string; issues: string[] };
      detection: { counts: Record<string, number> };
    };
    expect(json.page).toMatchObject({ platform: 'linkedin', route: 'feed-candidate', feedWord: 'newname' });
    expect(json.health.issues).toContain('route-new');
    expect(json.health.status).toBe('ok');
    expect(json.detection.counts.hidden).toBeGreaterThan(0);
    await report.getByRole('button', { name: 'Cancel' }).click();
  });

  test('test_no_signature_watchdog_card_popup_and_nothing_touched', async ({ context, extensionId }) => {
    test.setTimeout(90_000);
    const before = await aiOnMock(context, extensionId, ai);
    const page = await watchdogCard(context);
    await expect(card(page).getByText(CARD_TITLE)).toBeVisible();
    await expect(card(page).getByText('LinkedIn seems to have changed this page, so your feed shows as usual.')).toBeVisible();
    await expect(card(page).getByText('Nothing is sent unless you choose to.')).toBeVisible();
    // Read-only: no fold, no per-post UI, and no post went to the AI.
    expect(await marks(page)).toBe(0);
    expect(ai.bodies.length).toBe(before);
    expect(await toolbarTitle(context)).toBe("unAlgorithm isn't running on this LinkedIn page");

    // The popup says it too, and never "Go to feed" on the feed.
    const popup = await popupOn(context, extensionId, page);
    await expect(popup.getByText(CARD_TITLE)).toBeVisible();
    await expect(popup.getByRole('button', { name: 'Let us know' })).toBeVisible();
    await expect(popup.getByText('Go to feed')).toHaveCount(0);
    await expect(popup.getByText(/posts? hidden on this page/)).toHaveCount(0);

    // Still nothing touched once the watchdog has stopped (25 s visible).
    await page.waitForTimeout(8_000);
    expect(await marks(page)).toBe(0);
    expect(ai.bodies.length).toBe(before);
    expect(reportGuard(context).sent.size).toBe(0);
  });

  test('test_profile_address_gets_no_card', async ({ context, extensionId }) => {
    test.setTimeout(90_000);
    const page = await open(context, PROFILE, linkedinPage(WITHOUT_SIGNATURE));
    // Past both probes and the watchdog's stop: a profile is never a feed candidate, so nothing watched it.
    await page.waitForTimeout(22_000);
    await expect(page.locator('unalgo-layer')).toHaveCount(0);
    expect(await marks(page)).toBe(0);
    const popup = await popupOn(context, extensionId, page);
    await expect(popup.getByText('unAlgorithm works on your home feed.')).toBeVisible();
    await expect(popup.getByText(CARD_TITLE)).toHaveCount(0);
    expect(await toolbarTitle(context)).not.toContain("isn't running");
  });
});

/** *Let us know* on the card: the report page with the watchdog's finding; returns it with the exact body shown. */
async function letUsKnow(context: BrowserContext, page: Page): Promise<{ report: Page; body: string }> {
  const opened = nextReportPage(context);
  await card(page).getByRole('button', { name: 'Let us know' }).click();
  const report = await opened;
  await expect(report.getByRole('heading', { level: 1, name: 'Report a problem' })).toBeFocused();
  await expect(sendLines(report).filter({ hasText: /^Page: LinkedIn home feed \(a new address: newname\)/ })).toHaveCount(1);
  await expect(
    sendLines(report).filter({ hasText: "unAlgorithm noticed: LinkedIn's feed is on a page unAlgorithm doesn't recognise" }),
  ).toHaveCount(1);
  await expect(sendLines(report).filter({ hasText: 'Reported from a note in the feed' })).toHaveCount(1);
  const body = await shownBody(report);
  const json = JSON.parse(body) as Record<string, unknown> & {
    page: Record<string, unknown>;
    health: Record<string, unknown>;
    detection: { counts: Record<string, number>; landmarks?: Record<string, number> };
  };
  expect(json).toMatchObject({ v: 1, kind: 'detection', from: 'notice', choices: [] });
  expect(json.page).toMatchObject({ platform: 'linkedin', route: 'feed-candidate', feedWord: 'newname', lang: 'en' });
  expect(json.health).toEqual({ status: 'not-started', issues: ['feed-not-started'], degraded: [] });
  // Counts and landmarks only: the watchdog keeps no statistics and reads no post's words.
  expect(Object.keys(json.detection).sort()).toEqual(['counts', 'landmarks']);
  expect(json.detection.counts.posts).toBeGreaterThanOrEqual(2);
  // Nothing from the page itself: no name, link, card key or the address beyond its one word.
  expect(body).not.toMatch(/linkedin\.com|componentkey|update-card-focus|k10000\d|Xxxx|\/feed\/newname/);
  return { report, body };
}

test('test_let_us_know_sends_the_watchdog_finding_as_shown', async ({ context }) => {
  test.setTimeout(90_000);
  const requests: Request[] = [];
  await context.route(REPORTS_AT, (route) => {
    requests.push(route.request());
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, ref: REF }) });
  });
  const page = await watchdogCard(context);
  const { report, body } = await letUsKnow(context, page);
  // Opening the page, reading it and waiting send nothing.
  await report.waitForTimeout(500);
  expect(requests).toHaveLength(0);

  // From the card, the finding speaks for itself: no answer needed.
  await report.getByRole('button', { name: 'Send report' }).click();
  await expect(report.getByRole('heading', { name: 'Thanks, we got it.' })).toBeFocused();
  await expect(report.getByText(REF)).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]?.postData()).toBe(body);
  expect(reportGuard(context).sent.get(JSON.parse(body).id as string)).toBe(1);

  // Sent: the card goes away on its tab, and stays away for 7 days on LinkedIn.
  await expect(card(page)).toHaveCount(0);
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const snoozed = await sw.evaluate(async () => {
    const { device } = await chrome.storage.local.get('device');
    return (device as { notices?: { snoozed?: Record<string, { until: number }> } } | undefined)?.notices?.snoozed;
  });
  const until = snoozed?.['linkedin:not-running']?.until ?? 0;
  expect(until - Date.now()).toBeGreaterThan(6.9 * 24 * 3_600_000);
});

/**
 * With the real server at the e2e builds' report address. Needs Postgres and Mailpit (`apps/server/compose.dev.yaml`
 * locally, service containers in CI), so it runs only with `UA_SERVER_E2E=1`.
 */
test.describe('with the server', () => {
  test.skip(process.env.UA_SERVER_E2E !== '1', 'needs Postgres and Mailpit');

  const started = useLocalServer({ PORT: String(E2E_REPORTS_PORT) });

  test('test_watchdog_report_row_matches_what_was_shown', async ({ context, extensionId }) => {
    test.setTimeout(90_000);
    const { server } = started();
    await allowServer(context, extensionId);
    const page = await watchdogCard(context);
    const { report, body } = await letUsKnow(context, page);
    await report.getByRole('button', { name: 'Send report' }).click();
    await expect(report.getByRole('heading', { name: 'Thanks, we got it.' })).toBeVisible();
    const ref = (await report.locator('.report-ref').textContent()) ?? '';

    const shown = JSON.parse(body) as Record<string, unknown> & {
      env: Record<string, unknown>;
      page: Record<string, unknown>;
      health: Record<string, unknown>;
      detection: Record<string, unknown>;
    };
    const row = (await reportRows(server)).find((r) => r.id === shown.id);
    expect(row).toMatchObject({
      ref,
      kind: 'detection',
      from: 'notice',
      choices: [],
      channel: shown.env.channel,
      listed: true,
      extension: shown.env.extension,
      browser: shown.env.browser,
      browser_major: shown.env.browserMajor,
      platform: 'linkedin',
      adapter: shown.page.adapter,
      // The first issue in priority order names the group on the admin page.
      topic: 'feed-not-started',
      unknown_codes: 0,
      message: null,
      contact: null,
    });
    // Stored as shown, the new address's one word included: every code is in the registry.
    expect(row?.details).toEqual({ page: shown.page, health: shown.health, detection: shown.detection });
    expect(row?.details.page).toMatchObject({ route: 'feed-candidate', feedWord: 'newname' });
    expect(server.logs()).not.toContain(shown.id as string);
  });
});
