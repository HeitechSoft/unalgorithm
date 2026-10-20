import AxeBuilder from '@axe-core/playwright';
import type { BrowserContext, Page, Request } from '@playwright/test';
import { REPORTS_PATH } from '@unalgorithm/protocol';
import {
  COMPANY_NOT_FOLLOWED,
  FIRST_DEGREE_POST,
  FOLLOWED_BY_POST,
  FOLLOWING_POST,
  feed2026,
  PARTNERSHIP_AD,
  POST_WITH_COMMENTS,
  signedInShell,
} from '../../../packages/platforms/fixtures/linkedin/y2026.ts';
import { expect, reportGuard, test } from './fixtures.ts';
import { E2E_REPORTS_PORT } from './server-harness.ts';

/**
 * The in-feed notice card with the real LinkedIn adapter and controller (ADR 0009 §3), in Chromium and Edge:
 * - two ads labelled "Promoted • Brand content", a near miss of LinkedIn's ad label, raise *Some ads may be getting
 *   through* after two health checks, while the ads stay folded (the near miss plus "no post age" still hides);
 * - *Not now* puts it away for 24 hours on LinkedIn: after a reload the issue is still found (the popup says so), but
 *   no card comes back;
 * - *Let us know* opens the report page with the finding, and sending it changes nothing about what is hidden: it only
 *   keeps the card away for 7 days;
 * - a feed where nearly everything would hide stops hiding at the first check, and *Filtering is paused on this page*
 *   comes with it, saying how to try again: the pause holds until the page reloads;
 * - axe checks the card inside our open shadow root, contrast included, in light and dark.
 */

const FEED = 'https://www.linkedin.com/feed/';
const REF = '7KQ3-M2PA';
/** Where the e2e builds send reports (`wxt.config.ts`'s `E2E_REPORTS_URL`). */
const REPORTS_AT = `http://127.0.0.1:${E2E_REPORTS_PORT}${REPORTS_PATH}`;
/**
 * Health checks run every 10 s of visible time; a card needs its issue in two checks in a row, except over-filtering,
 * which holds until a reload and shows its card at once.
 */
const CHECK_MS = 10_000;

/** PARTNERSHIP_AD (an ad run as a person's post, no age) with a new label wording in its age slot, under its own key. */
const brandAd = (n: number) =>
  PARTNERSHIP_AD.replace(
    /<span>Promoted • Partnership with[\s\S]*?<\/strong><\/a><\/span>/,
    'Promoted • Brand content',
  ).replaceAll('JJJkeyPartnerAd01', `JJJkeyBrandAd00${n}`);
const brandAdAt = (page: Page, n: number) => page.locator(`[componentkey^="update-card-focusJJJkeyBrandAd00${n}"]`);

/** A healthy feed but for the two near-miss ads. */
const NEAR_MISS = [FIRST_DEGREE_POST, brandAd(1), FOLLOWING_POST, POST_WITH_COMMENTS, brandAd(2), COMPANY_NOT_FOLLOWED];

/**
 * One post you'd keep and 21 "Followed by …" posts Balanced folds as network activity: 21 of 22 is over Balanced's 90%,
 * so detection looks wrong and the page stops hiding (`over-filtering`).
 */
const OVER_FILTERED = [
  FIRST_DEGREE_POST,
  ...Array.from({ length: 21 }, (_, i) => FOLLOWED_BY_POST.replaceAll('AAAkeyFollowedBy01', `AAAkeyFollowedBy${100 + i}`)),
];

/** A LinkedIn-like page of `cards` in the signed-in shell, styled like cards in either theme. */
function linkedinPage(cards: readonly string[], scheme: 'light' | 'dark'): string {
  const dark = scheme === 'dark';
  return `<!doctype html><html lang="en" class="${dark ? 'theme--dark' : ''}"><head><meta charset="utf-8"><title>Feed | LinkedIn</title>
<style>
  body { margin: 0; background: ${dark ? '#000' : '#f4f2ee'}; color: ${dark ? '#e9e9e9' : '#191919'}; font: 14px/1.4 -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 560px; margin: 24px auto; }
  a { color: inherit; }
  [role="listitem"] { display: block; background: ${dark ? '#1b1f23' : '#fff'}; border-radius: 8px; margin: 0 0 8px; padding: 12px 16px; box-shadow: 0 0 0 1px rgb(0 0 0 / .08); }
  [role="listitem"] h2 { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  button { background: none; border: 0; color: inherit; font: inherit; }
  p { margin: 2px 0; }
</style></head><body>${signedInShell(feed2026(...cards))}</body></html>`;
}

async function openFeed(context: BrowserContext, cards: readonly string[], scheme: 'light' | 'dark' = 'light'): Promise<Page> {
  await context.route('https://www.linkedin.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: linkedinPage(cards, scheme) }),
  );
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await page.goto(FEED);
  return page;
}

/** The card's landmark, inside our page layer's shadow root. */
const card = (page: Page) => page.locator('unalgo-layer').getByRole('region', { name: 'unAlgorithm' });

/** The popup, looking at the feed tab: opened in a tab of its own, then the feed brought to the front. */
async function popupOn(context: BrowserContext, extensionId: string, feed: Page): Promise<Page> {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await feed.bringToFront();
  await expect(popup.getByRole('switch', { name: 'unAlgorithm on LinkedIn' })).toBeVisible();
  return popup;
}

/** The snoozes in device settings, read through the service worker. */
async function snoozes(context: BrowserContext): Promise<Record<string, { until: number; adapter: string }>> {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  return sw.evaluate(async () => {
    const { device } = await chrome.storage.local.get('device');
    return (
      (device as { notices?: { snoozed?: Record<string, { until: number; adapter: string }> } } | undefined)?.notices?.snoozed ??
      {}
    );
  });
}

/**
 * Serious and critical axe problems in our page layer (WCAG 2.2 AA), with the card showing. axe reads into the open
 * shadow root; the check fails unless contrast was actually measured on the card's text in there.
 */
async function layerProblems(page: Page, where: string): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .include('unalgo-layer')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const inShadow = (nodes: { target: unknown[] }[]) => nodes.some((n) => Array.isArray(n.target[0]));
  const contrast = results.passes.find((r) => r.id === 'color-contrast');
  expect(contrast && inShadow(contrast.nodes), `${where}: axe measured no contrast inside the shadow root`).toBe(true);
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${where}: ${v.id} (${v.impact}) ${v.nodes.map((n) => JSON.stringify(n.target)).join(' | ')}`);
}

test('test_near_miss_ad_labels_raise_ads_through_and_not_now_keeps_it_away', async ({ context, extensionId }) => {
  test.setTimeout(120_000);
  const started = Date.now();
  const page = await openFeed(context, NEAR_MISS);
  // The near miss still folds both ads (medium label evidence plus the weak "no post age").
  for (const n of [1, 2]) await expect(brandAdAt(page, n)).toHaveAttribute('data-unalgo', 'collapsed', { timeout: 15_000 });
  await expect(page.locator('[componentkey="update-card-focusEEEkeyFirstDegree5"]')).not.toHaveAttribute('data-unalgo', /.+/);

  await expect(card(page)).toBeVisible({ timeout: 35_000 });
  // Two checks in a row: never at the first one.
  expect(Date.now() - started).toBeGreaterThanOrEqual(2 * CHECK_MS);
  await expect(card(page).getByText('Some ads may be getting through')).toBeVisible();
  await expect(card(page).getByText('LinkedIn may have changed how it labels ads.')).toBeVisible();
  await expect(card(page).getByRole('status')).toContainText('Some ads may be getting through');
  // The card doesn't take the focus from the page.
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  // Reporting changes nothing about hiding: the ads are still folded under the card.
  for (const n of [1, 2]) await expect(brandAdAt(page, n)).toHaveAttribute('data-unalgo', 'collapsed');
  expect(await layerProblems(page, 'ads-through (light)')).toEqual([]);

  // Not now: gone, and kept away for 24 hours on LinkedIn, under this detection version.
  await card(page).getByRole('button', { name: 'Not now' }).click();
  await expect(card(page)).toHaveCount(0);
  await expect.poll(async () => (await snoozes(context))['linkedin:ads-through']?.until ?? 0).toBeGreaterThan(Date.now());
  const snooze = (await snoozes(context))['linkedin:ads-through'];
  expect((snooze?.until ?? 0) - Date.now()).toBeGreaterThan(23.9 * 3_600_000);
  expect(snooze?.until ?? 0).toBeLessThanOrEqual(Date.now() + 24 * 3_600_000);
  expect(snooze?.adapter).toMatch(/^linkedin@/);

  // A reload: past two checks again, the ads are folded and the issue is found, but no card comes back.
  await page.reload();
  for (const n of [1, 2]) await expect(brandAdAt(page, n)).toHaveAttribute('data-unalgo', 'collapsed', { timeout: 15_000 });
  await page.waitForTimeout(2 * CHECK_MS + 3_000);
  await expect(card(page)).toHaveCount(0);
  const popup = await popupOn(context, extensionId, page);
  // The popup shows the same state whatever the snoozes.
  await expect(popup.getByText('Some ads may be getting through')).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Let us know' })).toBeVisible();
});

test('test_let_us_know_from_the_card_sends_the_finding_and_hides_nothing_more_or_less', async ({ context }) => {
  test.setTimeout(90_000);
  const requests: Request[] = [];
  await context.route(REPORTS_AT, (route) => {
    requests.push(route.request());
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, ref: REF }) });
  });
  const page = await openFeed(context, NEAR_MISS);
  await expect(card(page)).toBeVisible({ timeout: 35_000 });
  const folded = async () =>
    page
      .locator('[data-unalgo]')
      .evaluateAll((els) => els.map((el) => `${el.getAttribute('componentkey')}=${el.getAttribute('data-unalgo')}`));
  const before = await folded();

  const opened = context.waitForEvent('page', { predicate: (p) => new URL(p.url()).pathname === '/report.html' });
  await card(page).getByRole('button', { name: 'Let us know' }).click();
  const report = await opened;
  const lines = report.getByRole('region', { name: "What we'll send" }).getByRole('listitem');
  await expect(lines.filter({ hasText: 'Reported from a note in the feed' })).toHaveCount(1);
  await expect(lines.filter({ hasText: /^unAlgorithm noticed: .*some ads are labelled in a new way/ })).toHaveCount(1);
  await report.getByText("Show exactly what's sent").click();
  const body = (await report.getByRole('region', { name: "What we'll send" }).locator('pre').textContent()) ?? '';
  const json = JSON.parse(body) as {
    from: string;
    health: { issues: string[] };
    detection: { counts: Record<string, number>; hiddenBy?: Record<string, number>; observations?: Record<string, number> };
  };
  expect(json.from).toBe('notice');
  expect(json.health.issues).toContain('ad-label-near-miss');
  expect(json.detection.hiddenBy?.sponsored).toBe(2);
  expect(json.detection.observations?.['li.label.promoted.near']).toBe(2);
  // The label itself, its hash and the posts' words never leave: only the codes and counts above.
  expect(body).not.toMatch(/Brand content|BrandAd|Dana Whitfield|linkedin\.com/);
  await report.getByRole('button', { name: 'Send report' }).click();
  await expect(report.getByRole('heading', { name: 'Thanks, we got it.' })).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]?.postData()).toBe(body);
  expect(reportGuard(context).sent.get(JSON.parse(body).id as string)).toBe(1);

  // Sent: the card goes away for 7 days, and every post is folded or shown exactly as before.
  await expect(card(page)).toHaveCount(0);
  expect((await snoozes(context))['linkedin:ads-through']?.until ?? 0).toBeGreaterThan(Date.now() + 6.9 * 24 * 3_600_000);
  expect(await folded()).toEqual(before);
  for (const n of [1, 2]) await expect(brandAdAt(page, n)).toHaveAttribute('data-unalgo', 'collapsed');
});

for (const scheme of ['light', 'dark'] as const) {
  test(`test_over_filtering_pauses_and_shows_the_paused_card_at_once (${scheme})`, async ({ context }) => {
    test.setTimeout(90_000);
    const page = await openFeed(context, OVER_FILTERED, scheme);
    const folded = page.locator('[data-unalgo="collapsed"]');
    await expect(folded.first()).toBeAttached({ timeout: 15_000 });
    // The first check finds nearly everything hidden: the page stops hiding (fail open), and the card says so at once.
    await expect(folded).toHaveCount(0, { timeout: 20_000 });
    await expect(card(page)).toBeVisible({ timeout: 2_000 });
    await expect(card(page).getByText('Filtering is paused on this page')).toBeVisible();
    await expect(
      card(page).getByText(
        "unAlgorithm would have hidden too many posts, so it's showing every post. Reload the page to try again.",
      ),
    ).toBeVisible();
    await expect(card(page).getByRole('button', { name: 'Let us know' })).toBeVisible();
    await expect(card(page).getByRole('button', { name: 'Dismiss' })).toBeVisible();
    // The pause holds: later checks fold nothing again.
    await page.waitForTimeout(CHECK_MS + 1_000);
    await expect(folded).toHaveCount(0);
    // The card's colours follow the page's theme.
    expect(await page.locator('unalgo-layer').evaluate((el) => getComputedStyle(el).getPropertyValue('--ua-scheme').trim())).toBe(
      scheme,
    );
    expect(await layerProblems(page, `paused (${scheme})`)).toEqual([]);

    // Escape inside the card means Not now.
    await card(page).getByRole('button', { name: 'Let us know' }).focus();
    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveCount(0);
  });
}
