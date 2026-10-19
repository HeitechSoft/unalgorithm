import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from 'puppeteer-core';
import {
  COMPANY_NOT_FOLLOWED,
  FIRST_DEGREE_POST,
  FOLLOWED_BY_POST,
  FOLLOWING_POST,
  feed2026,
  PARTNERSHIP_AD,
  POST_WITH_COMMENTS,
  signedInShell,
} from '../../../../packages/platforms/fixtures/linkedin/y2026.ts';
import {
  aria,
  attribute,
  click,
  count,
  type FirefoxProfile,
  fixturePage,
  launchFirefox,
  pageText,
  reload,
  sleep,
} from './driver.ts';
import { expect, test } from './fixtures.ts';

/**
 * The in-feed notice card in Firefox (ADR 0009 §3), as `../notice.spec.ts` checks Chromium and Edge, with the real
 * LinkedIn adapter and controller: two "Promoted • Brand content" ads (a near miss of the ad label) stay folded and
 * raise *Some ads may be getting through* after two health checks; *Not now* keeps it away after a reload; a feed where
 * nearly everything would hide stops hiding and shows *Filtering is paused on this page* at the second check. axe
 * checks the card inside our open shadow root, contrast included, in light and dark.
 */

const FEED = 'https://www.linkedin.com/feed/';
/** Health checks run every 10 s of visible time; a card needs its issue in two checks in a row. */
const CHECK_MS = 10_000;
const LAYER = 'unalgo-layer >>> ';
/** Firefox's colour scheme for web content (`prefers-color-scheme`); BiDi has no media emulation. */
const DARK = { 'layout.css.prefers-color-scheme.content-override': 0, 'ui.prefersReducedMotion': 1 };
const AXE_SOURCE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

/** PARTNERSHIP_AD with a new label wording in its age slot, under its own key (as `../notice.spec.ts` builds it). */
const brandAd = (n: number) =>
  PARTNERSHIP_AD.replace(
    /<span>Promoted • Partnership with[\s\S]*?<\/strong><\/a><\/span>/,
    'Promoted • Brand content',
  ).replaceAll('JJJkeyPartnerAd01', `JJJkeyBrandAd00${n}`);
const brandAdAt = (n: number) => `[componentkey^="update-card-focusJJJkeyBrandAd00${n}"]`;
const NEAR_MISS = [FIRST_DEGREE_POST, brandAd(1), FOLLOWING_POST, POST_WITH_COMMENTS, brandAd(2), COMPANY_NOT_FOLLOWED];
/** One post you'd keep and 21 "Followed by …" posts Balanced folds: over Balanced's 90%, so the page stops hiding. */
const OVER_FILTERED = [
  FIRST_DEGREE_POST,
  ...Array.from({ length: 21 }, (_, i) => FOLLOWED_BY_POST.replaceAll('AAAkeyFollowedBy01', `AAAkeyFollowedBy${100 + i}`)),
];

function linkedinPage(cards: readonly string[], scheme: 'light' | 'dark'): string {
  const dark = scheme === 'dark';
  return `<!doctype html><html lang="en" class="${dark ? 'theme--dark' : ''}"><head><meta charset="utf-8"><title>Feed | LinkedIn</title>
<style>
  body { margin: 0; background: ${dark ? '#000' : '#f4f2ee'}; color: ${dark ? '#e9e9e9' : '#191919'}; font: 14px/1.4 sans-serif; }
  main { max-width: 560px; margin: 24px auto; }
  [role="listitem"] { display: block; background: ${dark ? '#1b1f23' : '#fff'}; border-radius: 8px; margin: 0 0 8px; padding: 12px 16px; }
  [role="listitem"] h2 { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  button { background: none; border: 0; color: inherit; font: inherit; }
  p { margin: 2px 0; }
</style></head><body>${signedInShell(feed2026(...cards))}</body></html>`;
}

const openFeed = (profile: FirefoxProfile, cards: readonly string[], scheme: 'light' | 'dark' = 'light') =>
  fixturePage(profile, FEED, linkedinPage(cards, scheme));

/** Whether the card is on the page, with `title`. */
const cardShows = async (page: Page, title: string) =>
  (await count(page, `${LAYER}${aria('region', 'unAlgorithm')}`)) === 1 && (await pageText(page)).includes(title);

/** The snoozes in device settings, read from an extension page. */
async function snoozes(profile: FirefoxProfile): Promise<Record<string, { until: number; adapter: string }>> {
  const page = await profile.open('options.html');
  try {
    return await page.evaluate(async () => {
      const { device } = await browser.storage.local.get('device');
      return (
        (device as { notices?: { snoozed?: Record<string, { until: number; adapter: string }> } } | undefined)?.notices
          ?.snoozed ?? {}
      );
    });
  } finally {
    await page.close();
  }
}

/**
 * Serious and critical axe problems in our page layer (WCAG 2.2 AA), with the card showing, and whether axe measured
 * contrast on text inside its open shadow root (a check that saw nothing proves nothing).
 */
async function layerProblems(page: Page): Promise<{ problems: string[]; contrastInShadow: boolean }> {
  if (!(await page.evaluate(() => 'axe' in window))) await page.evaluate(AXE_SOURCE);
  return page.evaluate(async () => {
    type Node = { target: unknown[] };
    type Result = { id: string; impact?: string | null; nodes: Node[] };
    const axe = (
      window as unknown as { axe: { run(c: unknown, o: unknown): Promise<{ violations: Result[]; passes: Result[] }> } }
    ).axe;
    const results = await axe.run(
      { include: [['unalgo-layer']] },
      { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } },
    );
    const contrast = results.passes.find((r) => r.id === 'color-contrast');
    return {
      problems: results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id} (${v.impact}) ${v.nodes.map((n) => JSON.stringify(n.target)).join(' | ')}`),
      contrastInShadow: !!contrast?.nodes.some((n) => Array.isArray(n.target[0])),
    };
  });
}

test('test_firefox_near_miss_ads_through_card_and_not_now', async ({ firefox }) => {
  test.setTimeout(150_000);
  const started = Date.now();
  const page = await openFeed(firefox, NEAR_MISS);
  // Both near-miss ads stay folded.
  for (const n of [1, 2]) await page.waitForSelector(`${brandAdAt(n)}[data-unalgo="collapsed"]`, { timeout: 15_000 });
  expect(await attribute(page, '[componentkey="update-card-focusEEEkeyFirstDegree5"]', 'data-unalgo')).toBeNull();

  await expect.poll(() => cardShows(page, 'Some ads may be getting through'), { timeout: 35_000 }).toBe(true);
  // Two checks in a row: never at the first one.
  expect(Date.now() - started).toBeGreaterThanOrEqual(2 * CHECK_MS);
  expect(await pageText(page)).toContain('LinkedIn may have changed how it labels ads.');
  expect(await pageText(page)).toContain('Nothing is sent unless you choose to.');
  for (const n of [1, 2]) expect(await attribute(page, brandAdAt(n), 'data-unalgo')).toBe('collapsed');
  expect(await page.$eval('unalgo-layer', (el) => getComputedStyle(el).getPropertyValue('--ua-scheme').trim())).toBe('light');
  const { problems, contrastInShadow } = await layerProblems(page);
  expect(contrastInShadow).toBe(true);
  expect(problems, problems.join('\n')).toEqual([]);

  // Not now, a real click: gone, and kept away for 24 hours on LinkedIn.
  await click(page, `${LAYER}${aria('button', 'Not now')}`);
  await expect.poll(() => count(page, `${LAYER}${aria('region', 'unAlgorithm')}`)).toBe(0);
  await expect.poll(async () => (await snoozes(firefox))['linkedin:ads-through']?.until ?? 0).toBeGreaterThan(Date.now());
  const snooze = (await snoozes(firefox))['linkedin:ads-through'];
  expect((snooze?.until ?? 0) - Date.now()).toBeGreaterThan(23.9 * 3_600_000);
  expect(snooze?.adapter).toMatch(/^linkedin@/);

  // A reload: past two checks again the ads are folded, and no card comes back.
  await page.bringToFront();
  await reload(page);
  for (const n of [1, 2]) await page.waitForSelector(`${brandAdAt(n)}[data-unalgo="collapsed"]`, { timeout: 15_000 });
  await sleep(2 * CHECK_MS + 3_000);
  expect(await cardShows(page, 'Some ads may be getting through')).toBe(false);
  expect(await count(page, `${LAYER}${aria('region', 'unAlgorithm')}`)).toBe(0);
});

test('test_firefox_over_filtering_paused_card_in_dark', async () => {
  test.setTimeout(150_000);
  const firefox = await launchFirefox({ prefs: DARK });
  try {
    const page = await openFeed(firefox, OVER_FILTERED, 'dark');
    expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
    await page.waitForSelector('[data-unalgo="collapsed"]', { timeout: 15_000 });
    // The first check stops hiding at once (fail open), with no card yet.
    await expect.poll(() => count(page, '[data-unalgo="collapsed"]'), { timeout: 20_000 }).toBe(0);
    expect(await count(page, `${LAYER}${aria('region', 'unAlgorithm')}`)).toBe(0);
    // The second check: the card.
    await expect.poll(() => cardShows(page, 'Filtering is paused on this page'), { timeout: 15_000 }).toBe(true);
    expect(await pageText(page)).toContain(
      "LinkedIn looks different today, so we're showing every post rather than hide the wrong ones.",
    );
    expect(await count(page, '[data-unalgo="collapsed"]')).toBe(0);
    expect(await page.$eval('unalgo-layer', (el) => getComputedStyle(el).getPropertyValue('--ua-scheme').trim())).toBe('dark');
    const { problems, contrastInShadow } = await layerProblems(page);
    expect(contrastInShadow).toBe(true);
    expect(problems, problems.join('\n')).toEqual([]);
    // ✕ is Not now too.
    await click(page, `${LAYER}${aria('button', 'Dismiss')}`);
    await expect.poll(() => count(page, `${LAYER}${aria('region', 'unAlgorithm')}`)).toBe(0);
  } finally {
    await firefox.close();
  }
});
