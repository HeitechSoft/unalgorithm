import { classifyMessage, requestKind } from '@unalgorithm/ai/testing/anthropic';
import type { EgressRequest, EgressResponse } from '../egress-proxy.ts';
import { LINKEDIN_FLAGGED, linkedinShell } from '../fixtures.ts';
import { aria, click, fill, fixturePage, launchFirefox, pageText, send, text } from './driver.ts';
import { expect, GRANT_REQUESTS, LINKEDIN_FEED, markTopicMore, test } from './fixtures.ts';

/**
 * The person's own Anthropic key in Firefox (ADR 0008): "Test and save" asks Firefox for the data-collection consent
 * that sending post text to Anthropic needs, in the same click, and the feed is then labelled through a mocked
 * api.anthropic.com that the profile's proxy answers over TLS. Withdrawing the consent stops the AI, as a removed host
 * permission does. Firefox shows its consent prompt as browser UI, which automation can't answer, so this profile has
 * Firefox's own test pref that grants permission requests without the prompt; the request itself is the extension's.
 */
const API_KEY = `sk-ant-api03-E2E${'K'.repeat(40)}`;
const FRIEND = '[componentkey="update-card-focusEEEkeyFirstDegree5"]';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };

/** api.anthropic.com as the specs' mock answers it: the model list, and classify batches by phrase. */
function anthropic(request: EgressRequest): EgressResponse {
  const json = (body: unknown): EgressResponse => ({
    status: 200,
    headers: { ...CORS, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (request.method === 'OPTIONS') return { status: 204, headers: CORS };
  if (request.method === 'GET' && new URL(request.url).pathname === '/v1/models') {
    const data = ['claude-haiku-5-5'].map((id) => ({ type: 'model', id, display_name: id, created_at: '2026-01-01T00:00:00Z' }));
    return json({ data, has_more: false, first_id: 'claude-haiku-5-5', last_id: 'claude-haiku-5-5' });
  }
  const body: unknown = JSON.parse(request.body || '{}');
  if (requestKind(body) !== 'classify') return { status: 400, headers: CORS, body: 'unexpected request' };
  return json(
    classifyMessage(body, (postText) => ({
      relevance: postText.includes(LINKEDIN_FLAGGED) ? 90 : 50,
      isNews: false,
      hasCheckableClaims: false,
    })),
  );
}

test('test_firefox_own_key_asks_consent_and_labels', async () => {
  test.setTimeout(120_000);
  const firefox = await launchFirefox({ prefs: GRANT_REQUESTS });
  try {
    firefox.proxy.route('https://api.anthropic.com/', anthropic);
    const options = await firefox.open('options.html#/ai');
    const consent = () => options.evaluate(async () => (await browser.permissions.getAll()).data_collection ?? null);
    expect(await consent()).toEqual([]);

    // The person's click asks for the consent with the key's test; Anthropic gets the post text (other people's posts),
    // nothing about the person or the account.
    await click(options, text('Your own API key'));
    await fill(options, 'API key', API_KEY);
    await click(options, aria('button', 'Test and save'));
    await expect.poll(() => pageText(options), { timeout: 20_000 }).toContain('Connected');
    expect((await consent())?.sort()).toEqual(['personalCommunications', 'websiteContent']);
    // The AI highlights by relevance once the person has said what they want.
    await markTopicMore(firefox);

    const feed = await fixturePage(firefox, LINKEDIN_FEED, linkedinShell());
    await feed.waitForSelector(`${FRIEND}[data-unalgo-pick=""]`, { timeout: 20_000 });
    const sent = firefox.proxy.requests.filter((r) => r.url === 'https://api.anthropic.com/v1/messages');
    expect(sent.some((r) => r.body.includes(LINKEDIN_FLAGGED))).toBe(true);
    for (const r of sent) {
      expect(r.body).not.toContain('Morgan Ellis');
      expect(r.headers['x-api-key']).toBe(API_KEY);
    }
    // TLS was opened only for the routed host: nothing else of the profile left the computer over HTTPS.
    expect(firefox.proxy.refused.filter((target) => !/mozilla\.(com|net|org)/.test(target))).toEqual([]);

    // Consent withdrawn in Firefox's add-on settings: the source stops, as for a removed host permission.
    await options.evaluate(() => browser.permissions.remove({ data_collection: ['personalCommunications'] }));
    const config = { kind: 'anthropic', model: null };
    expect(await send(options, { type: 'testSource', config, apiKey: API_KEY })).toMatchObject({
      ok: false,
      error: { code: 'host-permission' },
    });
  } finally {
    await firefox.close();
  }
});
