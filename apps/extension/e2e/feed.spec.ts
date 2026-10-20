import { type MockOpenAI, startMockOpenAI } from '@unalgorithm/ai/testing';
import {
  FRIEND_POST,
  FRIEND_RESHARE,
  fbFeed,
  JOINED_GROUP_MEMBER_FOLLOW,
  NOT_FOLLOWED_PAGE_POST,
  REELS_TRAY,
  SPONSORED_SPLIT,
  SUGGESTED_PAGE_POST,
  UNJOINED_GROUP_POST,
} from '../../../packages/platforms/fixtures/facebook/synthetic.ts';
import { expect, groupHiddenPosts, markTopicMore, settled, test } from './fixtures.ts';

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
  const stub = promoted.locator('unalgo-post');
  await expect(stub.getByText('Promoted', { exact: true })).toBeVisible();
  await stub.getByRole('button', { name: /^Show / }).click();
  await expect(promoted).toHaveAttribute('data-unalgo', 'revealed');
  await expect(promoted.locator('unalgo-post').getByRole('button', { name: 'Hide again' })).toBeVisible();
});

test('LinkedIn: each hidden post has its own line; grouping them is a switch that applies at once', async ({
  context,
  extensionId,
  feed,
}) => {
  const page = await feed();
  // The fixture feed's last hidden post folds last: from then on, every post that will be hidden is.
  await expect(page.locator('[componentkey="update-card-focusFFFkeyCompanyNF006"]')).toHaveAttribute('data-unalgo', 'collapsed');
  const folded = await page.locator('[data-unalgo="collapsed"]').count();
  expect(folded).toBeGreaterThan(2);
  const why = page.locator('[data-unalgo="collapsed"] unalgo-post').getByRole('button', { name: /Why was this hidden/ });
  const showAll = page.getByRole('button', { name: /^Show all \d+ hidden posts$/ });
  // By default, each hidden post its own line with Why? and Show, even those hidden one after another.
  await expect(why).toHaveCount(folded);
  await expect(page.locator('[data-unalgo-run]')).toHaveCount(0);
  await expect(showAll).toHaveCount(0);
  // Settings → Display → Group hidden posts in a row: the open feed merges them into one line each run.
  await groupHiddenPosts(context, extensionId);
  await expect(page.locator('[data-unalgo-run="member"]').first()).toBeAttached();
  await expect(showAll.first()).toBeVisible();
  await expect(page.locator('[data-unalgo="collapsed"]')).toHaveCount(folded);
  // Off again: every hidden post has its own line again.
  await groupHiddenPosts(context, extensionId, false);
  await expect(page.locator('[data-unalgo-run]')).toHaveCount(0);
  await expect(showAll).toHaveCount(0);
  await expect(why).toHaveCount(folded);
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

test('Facebook: hides noise and pages you don’t follow; keeps friends, their shares and your groups', async ({ context }) => {
  await context.route('https://www.facebook.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>body{font:14px sans-serif;background:#f0f2f5}[role=feed]>div{background:#fff;margin:8px auto;max-width:560px;padding:12px;border-radius:8px}</style></head><body>${fbFeed(FRIEND_POST, SPONSORED_SPLIT, SUGGESTED_PAGE_POST, REELS_TRAY, UNJOINED_GROUP_POST, FRIEND_RESHARE, NOT_FOLLOWED_PAGE_POST, JOINED_GROUP_MEMBER_FOLLOW)}</body></html>`,
    }),
  );
  const page = await context.newPage();
  await page.goto('https://www.facebook.com/');
  const items = page.locator('[role="feed"] > div');
  for (const i of [1, 2, 3, 4, 6]) await expect(items.nth(i)).toHaveAttribute('data-unalgo', 'collapsed');
  // A friend's post, a friend sharing a page's post (the Follow button is the page's), and a group the account is in.
  for (const i of [0, 5, 7]) await expect(items.nth(i)).not.toHaveAttribute('data-unalgo', /.+/);
  await expect(items.nth(6).locator('unalgo-post').getByText('Not followed', { exact: true })).toBeVisible();
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
