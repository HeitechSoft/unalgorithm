import { type MockOpenAI, startMockOpenAI } from '@unalgorithm/ai/testing';
import {
  FRIEND_POST,
  fbFeed,
  REELS_TRAY,
  SPONSORED_SPLIT,
  SUGGESTED_PAGE_POST,
  UNJOINED_GROUP_POST,
} from '../../../packages/platforms/fixtures/facebook/synthetic.ts';
import { expect, markTopicMore, settled, test } from './fixtures.ts';

test('opens onboarding on install', async ({ context, extensionId }) => {
  await expect
    .poll(() => context.pages().some((p) => p.url() === `chrome-extension://${extensionId}/onboarding.html`))
    .toBe(true);
});

test('LinkedIn: folds away noise, keeps people you follow, and Show reveals', async ({ feed }) => {
  const page = await feed();
  const friend = page.locator('[componentkey="update-card-focusEEEkeyFirstDegree5"]');
  const promoted = page.locator('[componentkey="update-card-focusBBBkeyPromoted0002"]');
  await expect(promoted).toHaveAttribute('data-unalgo', 'collapsed');
  await expect(friend).not.toHaveAttribute('data-unalgo', /.+/);
  // Adjacent hidden posts merge into one line.
  await expect(page.locator('[data-unalgo-run="member"]').first()).toBeAttached();
  const stub = promoted.locator('unalgo-post');
  await expect(stub.getByText('Promoted', { exact: true })).toBeVisible();
  await stub.getByRole('button', { name: /^Show / }).click();
  await expect(promoted).toHaveAttribute('data-unalgo', 'revealed');
  await expect(promoted.locator('unalgo-post').getByRole('button', { name: 'Hide again' })).toBeVisible();
});

test('LinkedIn: Why? explains, and "Stop hiding" changes the rule live with Undo', async ({ feed }) => {
  const page = await feed();
  const promoted = page.locator('[componentkey="update-card-focusBBBkeyPromoted0002"]');
  await promoted
    .locator('unalgo-post')
    .getByRole('button', { name: /Why was this hidden/ })
    .click();
  // By name: the first-fold tip is a dialog on the same stub.
  const pop = promoted.locator('unalgo-post').getByRole('dialog', { name: 'Promoted post' });
  await expect(pop.getByText('Promoted post')).toBeVisible();
  await settled(pop);
  await pop.getByRole('button', { name: 'Stop hiding ads' }).click();
  await expect(promoted).not.toHaveAttribute('data-unalgo', /.+/);
  const undo = page.locator('unalgo-layer').getByRole('button', { name: 'Undo' });
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(promoted).toHaveAttribute('data-unalgo', 'collapsed');
});

test('Facebook: hides Sponsored, Suggested, Reels tray and unjoined groups; keeps friends', async ({ context }) => {
  await context.route('https://www.facebook.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>body{font:14px sans-serif;background:#f0f2f5}[role=feed]>div{background:#fff;margin:8px auto;max-width:560px;padding:12px;border-radius:8px}</style></head><body>${fbFeed(FRIEND_POST, SPONSORED_SPLIT, SUGGESTED_PAGE_POST, REELS_TRAY, UNJOINED_GROUP_POST)}</body></html>`,
    }),
  );
  const page = await context.newPage();
  await page.goto('https://www.facebook.com/');
  const items = page.locator('[role="feed"] > div');
  await expect(items.nth(0)).not.toHaveAttribute('data-unalgo', /.+/);
  for (const i of [1, 2, 3, 4]) await expect(items.nth(i)).toHaveAttribute('data-unalgo', 'collapsed');
  await expect(page.locator('[role="complementary"] [data-unalgo]')).toHaveCount(1);
});

test.describe('AI through a local OpenAI-compatible server', () => {
  let ai: MockOpenAI;

  test.beforeAll(async () => {
    ai = await startMockOpenAI();
  });
  test.afterAll(() => ai.close());

  test('classifies posts ahead of the viewport, highlights picks, and never sends author names', async ({
    context,
    extensionId,
    feed,
  }) => {
    await context.route('http://127.0.0.1:*/**', (route) => route.continue());
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html#/ai`);
    const result = await options.evaluate(async (baseUrl) => {
      const config = { kind: 'openai-compatible', preset: 'custom', baseUrl, auth: 'none', model: null };
      const test = await chrome.runtime.sendMessage({ type: 'testSource', config });
      if (test?.ok) await chrome.runtime.sendMessage({ type: 'saveSource', config: { ...config, model: test.model } });
      return test;
    }, ai.baseUrl);
    expect(result).toMatchObject({ ok: true, model: 'mock-model' });
    // The AI highlights by relevance once the person has said what they want.
    await markTopicMore(context, extensionId);

    const page = await feed();
    const friend = page.locator('[componentkey="update-card-focusEEEkeyFirstDegree5"]');
    await expect(friend).toHaveAttribute('data-unalgo-pick', '');
    await expect(friend.locator('unalgo-post').getByText('For you')).toBeVisible();
    expect(ai.bodies.length).toBeGreaterThan(0);
    for (const b of ai.bodies) {
      expect(b).not.toContain('Morgan Ellis');
      expect(b).not.toContain('linkedin.com/in/');
    }
  });
});
