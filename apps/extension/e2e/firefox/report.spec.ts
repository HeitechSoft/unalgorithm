import { REPORTS_PATH } from '@unalgorithm/protocol';
import type { Page } from 'puppeteer-core';
import { E2E_REPORTS_PORT, reportRows } from '../server-harness.ts';
import { useLocalServer } from '../server-lifecycle.ts';
import { aria, click, count, extensionPage, type FirefoxProfile, pageText, send, unaskedReports, visible } from './driver.ts';
import { allowLocal, expect, grantedTypes, keepTechnicalData, test } from './fixtures.ts';

/**
 * Problem reports in Firefox (ADR 0009 §5). A temporary add-on gets no install prompt, so it starts as a person who
 * turned technical and interaction data off: the report page offers *Email this report* instead of sending, sends
 * nothing and never asks for the type. Once the type is allowed (the existing test-button pattern, `keepTechnicalData`),
 * *Send report* comes back on the open page and the report goes out through the profile's egress proxy, to a canned
 * answer here and to the real server with `UA_SERVER_E2E=1`.
 */

const REF = '7KQ3-M2PA';
const FIREFOX_TECHNICAL = 'Firefox is set not to share technical data from unAlgorithm.';

/** Every report request the profile made, answered or not. */
const reportRequests = (profile: FirefoxProfile) =>
  profile.proxy.requests.filter((r) => r.method === 'POST' && new URL(r.url).pathname === REPORTS_PATH);

/** Settings → About → Report a problem, as a person starts one in Firefox; the report page it opens. */
async function reportFromSettings(profile: FirefoxProfile): Promise<Page> {
  const options = await profile.open('options.html#/about');
  await click(options, aria('button', 'Report a problem'));
  const report = await extensionPage(profile.browser, '/report.html');
  await visible(report, aria('radio', 'LinkedIn'));
  return report;
}

/** The answers: LinkedIn, then "Ads are still showing". */
async function answer(report: Page): Promise<void> {
  await click(report, aria('radio', 'LinkedIn'));
  await click(report, aria('checkbox', 'Ads are still showing'));
}

test('test_firefox_without_technical_data_offers_email_and_sends_nothing', async ({ firefox }) => {
  // Anything sent would be recorded and answered; nothing may be.
  firefox.proxy.route(/^http:\/\/127\.0\.0\.1:\d+\//, () => ({
    status: 201,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
    body: JSON.stringify({ ok: true, ref: REF }),
  }));
  const report = await reportFromSettings(firefox);
  expect(await grantedTypes(report)).not.toContain('technicalAndInteraction');
  await answer(report);
  await expect.poll(() => pageText(report)).toContain(FIREFOX_TECHNICAL);
  expect(await pageText(report)).toContain(
    'Email this report instead, or allow Technical and interaction data in Firefox: menu → Add-ons and themes → unAlgorithm → Permissions.',
  );
  expect(await count(report, aria('button', 'Send report'))).toBe(0);
  const href = await report.$eval(aria('link', 'Email this report'), (a) => a.getAttribute('href') ?? '');
  expect(href.startsWith('mailto:support@heitechsoft.com?subject=unAlgorithm%20report&body=')).toBe(true);
  expect(decodeURIComponent(href.split('&body=')[1] ?? '')).toContain('Your answer: Ads are still showing');
  // Nothing sent, and the type was never asked for.
  expect(reportRequests(firefox)).toEqual([]);
  expect(await grantedTypes(report)).not.toContain('technicalAndInteraction');

  // Allowed in Firefox (here by the test's own button, as a person does in the add-ons page): Send comes back on the
  // open page, and sends this report once.
  await keepTechnicalData(firefox);
  await visible(report, aria('button', 'Send report'));
  await click(report, aria('button', 'Send report'));
  await expect.poll(() => pageText(report)).toContain('Thanks, we got it.');
  const sent = reportRequests(firefox);
  expect(sent).toHaveLength(1);
  const body = JSON.parse(sent[0]?.body ?? '{}') as { kind: string; from: string; env: { browser: string; client?: string } };
  expect(body).toMatchObject({ kind: 'detection', from: 'settings', env: { browser: 'firefox' } });
  // The add-on id lets the server tell a listed build; nothing else in the body names this install. Firefox's Origin
  // header does (its UUID is random per install): the server only checks that it is an extension page.
  expect(body.env.client).toBe(firefox.id);
  expect(String(sent[0]?.headers.origin)).toBe(firefox.base);
  // The guard counted the click, so the profile closes cleanly.
  expect(unaskedReports(firefox)).toEqual([]);
  expect(sent[0]?.headers).not.toHaveProperty('cookie');
  expect(sent[0]?.headers).not.toHaveProperty('authorization');
});

test('test_firefox_guard_catches_a_report_sent_without_a_click', async ({ firefox }) => {
  firefox.proxy.route(/^http:\/\/127\.0\.0\.1:\d+\//, () => ({
    status: 201,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
    body: JSON.stringify({ ok: true, ref: REF }),
  }));
  await keepTechnicalData(firefox);
  const report = await reportFromSettings(firefox);
  await answer(report);
  const body = await report.$eval('pre', (pre) => pre.textContent ?? '');
  const { id } = JSON.parse(body) as { id: string };
  // What a bug would do: the page asks the background to send with no click on Send report.
  expect(await send(report, { type: 'sendReport', id, body })).toEqual({ ok: true, ref: REF });
  expect(reportRequests(firefox)).toHaveLength(1);
  expect(unaskedReports(firefox)).toEqual([`${id}: 1 sent, 0 clicked`]);
  // Forgotten here, so this test's own teardown (the same guard) passes.
  firefox.proxy.requests.length = 0;
});

test.describe('with the server', () => {
  test.skip(process.env.UA_SERVER_E2E !== '1', 'needs Postgres and Mailpit');

  const started = useLocalServer({ PORT: String(E2E_REPORTS_PORT) });

  test('test_firefox_report_reaches_the_server', async ({ firefox }) => {
    const { server } = started();
    allowLocal(firefox);
    await keepTechnicalData(firefox);
    const report = await reportFromSettings(firefox);
    await answer(report);
    const body = await report.$eval('pre', (pre) => pre.textContent ?? '');
    await click(report, aria('button', 'Send report'));
    await expect.poll(() => pageText(report)).toContain('Thanks, we got it.');
    const shown = JSON.parse(body) as { id: string; env: { browser: string } };
    const row = (await reportRows(server)).find((r) => r.id === shown.id);
    expect(row).toMatchObject({
      kind: 'detection',
      from: 'settings',
      browser: 'firefox',
      listed: true,
      choices: ['ads-showing'],
    });
    expect(row?.details).toEqual({ page: JSON.parse(body).page });
    expect(reportRequests(firefox)).toHaveLength(1);
  });
});
