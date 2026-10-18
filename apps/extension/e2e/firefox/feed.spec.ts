import { type MockOpenAI, startMockOpenAI } from '@unalgorithm/ai/testing';
import {
  FRIEND_POST,
  fbFeed,
  REELS_TRAY,
  SPONSORED_SPLIT,
  SUGGESTED_PAGE_POST,
  UNJOINED_GROUP_POST,
} from '../../../../packages/platforms/fixtures/facebook/synthetic.ts';
import { aria, attribute, click, count, fill, fixturePage, hrefOf, pageText, text, visible } from './driver.ts';
import { allowLocal, expect, test } from './fixtures.ts';

/**
 * The extension in Firefox (ADR 0008), without a server: the install, the rules on both fixture feeds and AI through a
 * local OpenAI-compatible server, as `../feed.spec.ts` checks Chromium and Edge.
 */

const FRIEND = '[componentkey="update-card-focusEEEkeyFirstDegree5"]';
const PROMOTED = '[componentkey="update-card-focusBBBkeyPromoted0002"]';

test('test_firefox_install_opens_onboarding', async ({ firefox }) => {
  expect(firefox.id).toBe('feed-dev@unalgorithmfeed.com');
  expect(firefox.base).toMatch(/^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(await hrefOf(firefox.onboarding)).toBe(`${firefox.base}/onboarding.html`);
  await visible(firefox.onboarding, aria('button', 'Get started'));
  // The sidebar stays closed at install (`open_at_install: false`), and the toolbar button is on the toolbar.
  const page = await firefox.open('popup.html');
  expect(await page.evaluate(() => browser.sidebarAction.isOpen({}))).toBe(false);
  expect(await page.evaluate(() => browser.action.getUserSettings())).toMatchObject({ isOnToolbar: true });
});

test('test_firefox_linkedin_rules_fold_noise_and_show_reveals', async ({ feed }) => {
  const page = await feed();
  await page.waitForSelector(`${PROMOTED}[data-unalgo="collapsed"]`);
  expect(await attribute(page, FRIEND, 'data-unalgo')).toBeNull();
  // Adjacent hidden posts merge into one line.
  await page.waitForSelector('[data-unalgo-run="member"]');
  const stub = `${PROMOTED} unalgo-post >>> `;
  await visible(page, `${stub}${text('Promoted')}`);
  await click(page, `${stub}${aria('button', 'Show Promoted post from Northwind Analytics')}`);
  await page.waitForSelector(`${PROMOTED}[data-unalgo="revealed"]`);
  await visible(page, `${stub}${aria('button', 'Hide again')}`);
});

test('test_firefox_facebook_rules_keep_friends', async ({ firefox }) => {
  const page = await fixturePage(
    firefox,
    'https://www.facebook.com/',
    `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>${fbFeed(FRIEND_POST, SPONSORED_SPLIT, SUGGESTED_PAGE_POST, REELS_TRAY, UNJOINED_GROUP_POST)}</body></html>`,
  );
  const item = (i: number) => `[role="feed"] > div:nth-child(${i + 1})`;
  for (const i of [1, 2, 3, 4]) await page.waitForSelector(`${item(i)}[data-unalgo="collapsed"]`);
  expect(await attribute(page, item(0), 'data-unalgo')).toBeNull();
  expect(await count(page, '[role="complementary"] [data-unalgo]')).toBe(1);
});

test.describe('AI through a local OpenAI-compatible server', () => {
  let ai: MockOpenAI;

  test.beforeAll(async () => {
    ai = await startMockOpenAI();
  });
  test.afterAll(() => ai.close());

  test('test_firefox_local_ai_labels_and_never_sends_authors', async ({ firefox, feed }) => {
    // The background's requests reach the mock only through the profile's proxy, which records them.
    allowLocal(firefox);
    const options = await firefox.open('options.html#/ai');
    const consent = () => options.evaluate(async () => (await browser.permissions.getAll()).data_collection?.sort());
    // A model on this computer asks for the consent to send post text like any other: it is outside the browser. The
    // click on Test and save asks for it with the host, and the test and the save follow.
    await click(options, text('Local or self-hosted'));
    await fill(options, 'Address', ai.baseUrl);
    await click(options, aria('button', 'Test and save'));
    await expect.poll(() => pageText(options), { timeout: 20_000 }).toContain('Connected');
    expect(await consent()).toEqual(['personalCommunications', 'websiteContent']);

    const page = await feed();
    await page.waitForSelector(`${FRIEND}[data-unalgo-pick=""]`, { timeout: 20_000 });
    await expect.poll(() => pageText(page)).toContain('For you');
    expect(ai.bodies.length).toBeGreaterThan(0);
    for (const body of ai.bodies) {
      expect(body).not.toContain('Morgan Ellis');
      expect(body).not.toContain('linkedin.com/in/');
    }
    // Every model request went through the proxy from the background, with Firefox's own extension origin.
    const chats = firefox.proxy.requests.filter((r) => r.url === `${ai.baseUrl}/chat/completions`);
    expect(chats.length).toBe(ai.bodies.length);
    for (const chat of chats) expect(chat.headers.origin).toBe(firefox.base);
  });
});
