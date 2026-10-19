import type { BrowserContext, Page, Request, Route } from '@playwright/test';
import { REPORT_ERRORS, REPORTS_PATH } from '@unalgorithm/protocol';
import { expect, reportGuard, settled, test } from './fixtures.ts';
import { E2E_REPORTS_PORT, reportRows } from './server-harness.ts';
import { useLocalServer } from './server-lifecycle.ts';
import { allowServer, signInFromSettings } from './server-sign-in.ts';

/**
 * Problem reports in Chromium and Edge (ADR 0009 §2): the popup's *Report a problem* and *Why? → Wrong call?* open the
 * report page with a draft of the page; a missing answer is said and focused; *Send report* posts exactly the body the
 * page shows, once per click (the fixtures' guard fails any test where a report goes out without one); the server's
 * refusals and a dropped connection each have their state, and *Try again* sends the same report. The first group
 * answers for the server at the e2e builds' report address; the second runs the real server there (Postgres and
 * Mailpit, `UA_SERVER_E2E=1`) and reads back the stored row.
 */

const REF = '7KQ3-M2PA';
/** Where the e2e builds send reports (`wxt.config.ts`'s `E2E_REPORTS_URL`). */
const REPORTS_AT = `http://127.0.0.1:${E2E_REPORTS_PORT}${REPORTS_PATH}`;
const PROMOTED = '[componentkey="update-card-focusBBBkeyPromoted0002"]';

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

/** The exact body the page shows under *Show exactly what's sent*. */
async function shownBody(report: Page): Promise<string> {
  await report.getByText("Show exactly what's sent").click();
  return (await report.getByRole('region', { name: "What we'll send" }).locator('pre').textContent()) ?? '';
}

/** Answers report requests from the e2e builds' address with `answer`, recording each request. */
async function answerReports(context: BrowserContext, answer: (route: Route, n: number) => unknown): Promise<Request[]> {
  const seen: Request[] = [];
  await context.route(REPORTS_AT, (route) => {
    seen.push(route.request());
    return answer(route, seen.length);
  });
  return seen;
}

const accepted = (route: Route) =>
  route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, ref: REF }) });

test.describe('the report page', () => {
  test('test_popup_report_choice_required_then_sent_as_shown', async ({ context, extensionId, feed }) => {
    const requests = await answerReports(context, accepted);
    const page = await feed();
    await expect(page.locator(PROMOTED)).toHaveAttribute('data-unalgo', 'collapsed');
    const popup = await popupOn(context, extensionId, page);
    const opened = nextReportPage(context);
    await popup.getByRole('button', { name: 'Report a problem' }).click();
    const report = await opened;
    await expect(report).toHaveTitle('Report a problem · unAlgorithm');
    await expect(report.getByRole('heading', { level: 1, name: 'Report a problem' })).toBeFocused();
    // Opened beside the feed tab, which it can go back to.
    expect(await report.evaluate(async () => (await chrome.tabs.getCurrent())?.openerTabId)).toBeDefined();

    // No answer yet: said next to the question, with the focus there, and nothing sent.
    await report.getByRole('button', { name: 'Send report' }).click();
    await expect(report.getByText('Choose at least one')).toBeVisible();
    await expect(report.getByRole('checkbox', { name: 'Ads are still showing' })).toBeFocused();
    expect(requests).toHaveLength(0);

    await report.getByRole('checkbox', { name: 'Ads are still showing' }).check();
    const lines = report.getByRole('region', { name: "What we'll send" }).getByRole('listitem');
    await expect(lines.filter({ hasText: 'Your answer: Ads are still showing' })).toHaveCount(1);
    await expect(lines.filter({ hasText: 'Page: LinkedIn home feed' })).toHaveCount(1);
    const body = await shownBody(report);
    await report.getByRole('button', { name: 'Send report' }).click();
    await expect(report.getByRole('heading', { name: 'Thanks, we got it.' })).toBeFocused();
    await expect(report.getByText(REF)).toBeVisible();

    // One request, the very body shown, to the one address, as JSON and nothing else that identifies anyone.
    expect(requests).toHaveLength(1);
    const [sent] = requests as [Request];
    expect(sent.method()).toBe('POST');
    expect(sent.postData()).toBe(body);
    const headers = await sent.allHeaders();
    expect(headers['content-type']).toBe('application/json');
    expect(headers).not.toHaveProperty('authorization');
    expect(headers).not.toHaveProperty('cookie');
    expect(headers).not.toHaveProperty('referer');
    const json = JSON.parse(body) as Record<string, unknown>;
    expect(json).toMatchObject({ v: 1, kind: 'detection', from: 'popup', choices: ['ads-showing'] });
    expect(json.page).toMatchObject({ platform: 'linkedin', route: 'feed', lang: 'en' });
    expect(body).not.toMatch(/Morgan Ellis|linkedin\.com\/in\/|update-card-focus|urn:li/);
    // The guard saw it, after its click.
    expect(reportGuard(context).sent.get(json.id as string)).toBe(1);

    // Back to the feed: the report tab closes.
    await report.getByRole('button', { name: 'Back to LinkedIn' }).click();
    await expect.poll(() => report.isClosed()).toBe(true);
  });

  test('test_wrong_call_carries_the_post_facts_without_the_post', async ({ context, feed }) => {
    const requests = await answerReports(context, accepted);
    const page = await feed();
    const promoted = page.locator(PROMOTED);
    await promoted
      .locator('unalgo-post')
      .getByRole('button', { name: /Why was this hidden/ })
      .click();
    const pop = promoted.locator('unalgo-post').getByRole('dialog', { name: 'Promoted post' });
    await settled(pop);
    const opened = nextReportPage(context);
    await pop.getByRole('button', { name: 'Wrong call?' }).click();
    const report = await opened;
    await expect(report.getByRole('radio', { name: "This post shouldn't have been hidden" })).toBeVisible();
    await expect(
      report
        .getByRole('region', { name: "What we'll send" })
        .getByRole('listitem')
        .filter({ hasText: /^The post: hidden as an ad/ }),
    ).toHaveCount(1);
    const body = await shownBody(report);
    const json = JSON.parse(body) as { kind: string; from: string; post: Record<string, unknown> };
    expect(json.kind).toBe('wrong-call');
    expect(json.from).toBe('why');
    expect(json.post).toMatchObject({ reason: 'sponsored', source: 'rule' });
    // Never the post's key, text, author or link.
    expect(body).not.toMatch(/BBBkeyPromoted0002|li:ck:|update-card-focus|linkedin\.com\/(in|company)\//);
    await report.getByRole('button', { name: 'Send report' }).click();
    await expect(report.getByText('Choose one')).toBeVisible();
    await report.getByRole('radio', { name: "This post shouldn't have been hidden" }).check();
    await report.getByRole('button', { name: 'Send report' }).click();
    await expect(report.getByRole('heading', { name: 'Thanks, we got it.' })).toBeVisible();
    expect(JSON.parse(requests[0]?.postData() ?? '{}')).toMatchObject({ kind: 'wrong-call', choices: ['should-show'] });
  });

  test('test_rate_limit_and_dropped_connection_then_try_again', async ({ context, extensionId, feed }) => {
    const requests = await answerReports(context, (route, n) => {
      if (n === 1)
        return route.fulfill({
          status: 429,
          headers: { 'retry-after': '1800' },
          contentType: 'application/json',
          body: JSON.stringify(REPORT_ERRORS.rateLimit),
        });
      if (n === 2) return route.abort('connectionreset');
      return accepted(route);
    });
    const page = await feed();
    const popup = await popupOn(context, extensionId, page);
    const opened = nextReportPage(context);
    await popup.getByRole('button', { name: 'Report a problem' }).click();
    const report = await opened;
    await report.getByRole('checkbox', { name: 'The page looks broken or slow' }).check();
    await report.getByRole('button', { name: 'Send report' }).click();
    await expect(report.getByRole('heading', { name: "You've sent several reports in a short time." })).toBeFocused();
    await expect(report.getByText('Please try again in about an hour.')).toBeVisible();
    expect(requests).toHaveLength(1);

    await report.getByRole('button', { name: 'Try again' }).click();
    await expect(report.getByRole('heading', { name: "Couldn't send the report." })).toBeVisible();
    await expect(report.getByText('Check your internet connection, then try again.')).toBeVisible();
    expect(requests).toHaveLength(2);

    await report.getByRole('button', { name: 'Try again' }).click();
    await expect(report.getByRole('heading', { name: 'Thanks, we got it.' })).toBeVisible();
    // One request per click, never more, the same report each time.
    expect(requests).toHaveLength(3);
    expect(new Set(requests.map((r) => r.postData())).size).toBe(1);
  });

  test('test_refused_report_offers_email', async ({ context, extensionId, feed }) => {
    await answerReports(context, (route) =>
      route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify(REPORT_ERRORS.invalid) }),
    );
    const page = await feed();
    const popup = await popupOn(context, extensionId, page);
    const opened = nextReportPage(context);
    await popup.getByRole('button', { name: 'Report a problem' }).click();
    const report = await opened;
    await report.getByRole('checkbox', { name: 'Something else' }).check();
    await report.getByRole('button', { name: 'Send report' }).click();
    await expect(report.getByRole('heading', { name: "This report couldn't be sent." })).toBeVisible();
    const email = report.getByRole('link', { name: 'Email it instead' });
    const href = (await email.getAttribute('href')) ?? '';
    expect(href.startsWith('mailto:support@heitechsoft.com?subject=unAlgorithm%20report&body=')).toBe(true);
    expect(decodeURIComponent(href.split('&body=')[1] ?? '')).toContain('Your answer: Something else');
    await expect(report.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  });

  test('test_no_report_without_a_click', async ({ context, extensionId, feed }) => {
    const requests = await answerReports(context, accepted);
    const page = await feed();
    const popup = await popupOn(context, extensionId, page);
    const opened = nextReportPage(context);
    await popup.getByRole('button', { name: 'Report a problem' }).click();
    const report = await opened;
    await report.getByRole('checkbox', { name: 'Ads are still showing' }).check();
    // Opening, answering, reading the body and cancelling send nothing.
    await shownBody(report);
    await report.waitForTimeout(500);
    await report.getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => report.isClosed()).toBe(true);
    expect(requests).toHaveLength(0);
    expect(reportGuard(context).sent.size).toBe(0);
  });
});

/**
 * With the real server at the e2e builds' report address. Needs Postgres and Mailpit (`apps/server/compose.dev.yaml`
 * locally, service containers in CI) and the built `apps/web` for the sign-in, so it runs only with `UA_SERVER_E2E=1`.
 */
test.describe('with the server', () => {
  test.skip(process.env.UA_SERVER_E2E !== '1', 'needs Postgres and Mailpit');

  const started = useLocalServer({ PORT: String(E2E_REPORTS_PORT) });

  test('test_server_row_equals_the_shown_body', async ({ context, extensionId, feed }) => {
    const { server } = started();
    await allowServer(context, extensionId);
    const page = await feed();
    const popup = await popupOn(context, extensionId, page);
    const opened = nextReportPage(context);
    await popup.getByRole('button', { name: 'Report a problem' }).click();
    const report = await opened;
    await report.getByRole('checkbox', { name: 'Posts I wanted are hidden' }).check();
    const body = await shownBody(report);
    await report.getByRole('button', { name: 'Send report' }).click();
    await expect(report.getByRole('heading', { name: 'Thanks, we got it.' })).toBeVisible();
    const ref = (await report.locator('.report-ref').textContent()) ?? '';
    expect(ref).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

    const shown = JSON.parse(body) as Record<string, unknown> & { env: Record<string, unknown>; page: Record<string, unknown> };
    const row = (await reportRows(server)).find((r) => r.id === shown.id);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      ref,
      kind: shown.kind,
      from: shown.from,
      choices: shown.choices,
      channel: shown.env.channel,
      listed: true,
      extension: shown.env.extension,
      browser: shown.env.browser,
      browser_major: shown.env.browserMajor,
      platform: shown.page.platform,
      adapter: shown.page.adapter,
      unknown_codes: 0,
      message: null,
      contact: null,
    });
    expect(row?.details).toEqual({ page: shown.page, health: shown.health, detection: shown.detection });
    // The server logged the report by its codes only.
    expect(server.logs()).not.toContain(shown.id as string);
  });

  test('test_side_panel_correction_with_words', async ({ context, extensionId, feed }) => {
    const { server } = started();
    await allowServer(context, extensionId);
    const page = await feed();
    // A finished fact-check on the feed tab, as the background keeps it for the side panel.
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
      const result = {
        v: 1,
        checkedAt: new Date().toISOString(),
        model: 'claude-sonnet-5-5',
        promptVersion: 3,
        claims: [
          { id: 'c1', claim: 'The bridge opened in 1932.', verdict: 'supported', explanation: 'Archives agree.', citations: [] },
        ],
        sources: [],
      };
      const entry = { key: 'li:1', label: 'A post about a bridge', startedAt: Date.now(), status: 'done', result };
      await chrome.storage.session.set({ [`factcheck:${tab?.id}`]: { entries: [entry] } });
    });
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await page.bringToFront();
    const opened = nextReportPage(context);
    await panel.getByRole('button', { name: 'Report a wrong verdict' }).click();
    const report = await opened;
    await report.getByRole('radio', { name: 'The verdict is wrong' }).check();
    await report
      .getByRole('textbox', { name: 'In your own words' })
      .fill('The bridge opened in 1931. Write to me at ada@example.org');
    await report.getByRole('textbox', { name: 'Email for a reply (optional)' }).fill('tester@example.com');
    const body = await shownBody(report);
    expect(JSON.parse(body).correction).toMatchObject({
      feature: 'factcheck',
      promptVersion: 3,
      message: 'The bridge opened in 1931. Write to me at [email]',
    });
    await report.getByRole('button', { name: 'Send report' }).click();
    await expect(
      report.getByText('We review every correction. If you left an email, we reply within 5 business days.'),
    ).toBeVisible();
    const shown = JSON.parse(body) as { id: string };
    const row = (await reportRows(server)).find((r) => r.id === shown.id);
    expect(row).toMatchObject({
      kind: 'correction',
      from: 'sidepanel',
      choices: ['verdict-wrong'],
      listed: true,
      message: 'The bridge opened in 1931. Write to me at [email]',
      contact: 'tester@example.com',
    });
    expect(row?.details).not.toHaveProperty('page');
  });

  test('test_signed_in_report_carries_no_token_or_cookie', async ({ context, extensionId, feed }) => {
    test.setTimeout(120_000);
    const { server } = started();
    const reportHeaders: Record<string, string>[] = [];
    await allowServer(context, extensionId, (url) => void url);
    context.on('request', (request) => {
      if (new URL(request.url()).pathname === REPORTS_PATH && request.method() === 'POST')
        void request.allHeaders().then((h) => reportHeaders.push(h));
    });
    await signInFromSettings(context, extensionId, server.url, 'tester@example.com');
    const page = await feed();
    const popup = await popupOn(context, extensionId, page);
    const opened = nextReportPage(context);
    await popup.getByRole('button', { name: 'Report a problem' }).click();
    const report = await opened;
    await report.getByRole('checkbox', { name: 'Ads are still showing' }).check();
    const body = await shownBody(report);
    await report.getByRole('button', { name: 'Send report' }).click();
    await expect(report.getByRole('heading', { name: 'Thanks, we got it.' })).toBeVisible();
    await expect.poll(() => reportHeaders.length).toBe(1);
    const [headers] = reportHeaders as [Record<string, string>];
    expect(headers).not.toHaveProperty('authorization');
    expect(headers).not.toHaveProperty('cookie');
    expect(headers.origin).toBe(`chrome-extension://${extensionId}`);
    // The report says the AI is the person's own server, never which one.
    expect(JSON.parse(body).page.ai).toBe('own-server');
    expect(body).not.toContain(new URL(server.url).host);
  });
});
