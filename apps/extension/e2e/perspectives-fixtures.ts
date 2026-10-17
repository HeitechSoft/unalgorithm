import type { Locator, Page } from '@playwright/test';
import { FIXTURE_LIST } from '@unalgorithm/outlets/testing';
import { BUCKET_LABELS, LEAN_BUCKETS, type LeanBucket } from '@unalgorithm/protocol';
import { expect } from './fixtures.ts';

/**
 * Shared by the two UnEcho Chamber end-to-end specs (P3-41): the Facebook link share's link, the fictional
 * fixture list's buckets and the coverage the mocks return for them, and the side-panel sheet's checks. Every
 * outlet is a fixture outlet on `*.example`: no real outlet, no real lean.
 */

/** The feature's name: the AI pane switch's, the feed row's and the side-panel sheet's. */
export const PERSPECTIVES = 'UnEcho Chamber';
/** The in-feed start button's accessible name: the visible "UnEcho Chamber", then what it does (D74). */
export const PERSPECTIVES_START = 'UnEcho Chamber: see how outlets across the spectrum covered this story';
/** `ORGANIC_LINK_SHARE` (Facebook, public): its text, which never leaves for a comparison, and its shared link. */
export const LINK_POST_TEXT = 'Interesting read on city transit funding.';
export const LINK_URL = 'news.example.com/transit';
export const LINK_TITLE = 'City approves new transit budget';

/** The buckets the mocks find coverage in; the other two are gaps. */
export const COVERED = ['left', 'center', 'right'] as const satisfies readonly LeanBucket[];
export const GAPS = LEAN_BUCKETS.filter((b) => !(COVERED as readonly LeanBucket[]).includes(b));

const PASSAGES: Record<(typeof COVERED)[number], string> = {
  left: 'The city council approved the new transit budget on Tuesday after a long debate.',
  center: 'Council members voted to approve the transit budget, which adds bus routes next year.',
  right: 'The approved transit budget raises the city transit levy for property owners.',
};

/** A bucket's fixture domains, in list order. */
export function domainsOf(bucket: LeanBucket): string[] {
  return FIXTURE_LIST.outlets.filter((o) => o.lean?.bucket === bucket).flatMap((o) => o.domains);
}

/** Today in UTC, `YYYY-MM-DD`: inside the story's window, which ends now (the link carries no date). */
export const today = (): string => new Date().toISOString().slice(0, 10);

/** The first 8 words of a passage: the quote the comparison mocks cite. */
export const first8 = (text: string): string => text.trim().split(/\s+/).slice(0, 8).join(' ');

export interface CoverageHit {
  bucket: (typeof COVERED)[number];
  url: string;
  title: string;
  passage: string;
  /** The fixture outlet's name on the list. */
  outlet: string;
}

/**
 * The one article a covered bucket's search returns, on the bucket's first domain. Dated today in its path too, for a
 * search that returns no date (OpenAI's).
 */
export function coverageHit(bucket: (typeof COVERED)[number]): CoverageHit {
  const domain = domainsOf(bucket)[0] ?? '';
  const outlet = FIXTURE_LIST.outlets.find((o) => o.domains.includes(domain))?.name ?? '';
  return {
    bucket,
    url: `https://${domain}/${today().replaceAll('-', '/')}/transit-budget`,
    title: `Transit budget approved: ${outlet}`,
    passage: PASSAGES[bucket],
    outlet,
  };
}

/** The covered bucket whose domains are exactly `domains`, or undefined (a gap bucket, or not a bucket at all). */
export function coveredBucketFor(domains: readonly string[]): (typeof COVERED)[number] | undefined {
  const key = [...domains].sort().join(',');
  return COVERED.find((b) => domainsOf(b).sort().join(',') === key);
}

/** The bucket `query`'s `site:` clause names (SearXNG), when it is a covered one. */
export function coveredBucketInQuery(query: string): (typeof COVERED)[number] | undefined {
  return COVERED.find((b) => domainsOf(b).every((d) => query.includes(`site:${d}`)));
}

/**
 * The side panel (opened as a page; the feed brought to the front so it is the panel's active tab) shows the
 * comparison: coverage under Left, Center and Right, "No coverage found" under the two gaps, the agreed point quoting
 * the Left and Center sources, the registry line and the AI-generated badge. Returns the sheet.
 */
export async function expectComparisonSheet(panel: Page): Promise<Locator> {
  const sheet = panel.getByRole('region', { name: PERSPECTIVES });
  await expect(sheet.getByText('AI-generated', { exact: true })).toBeVisible({ timeout: 10_000 });
  const bucket = (b: LeanBucket) =>
    sheet
      .locator('.ua-perspectives-bucket')
      .filter({ has: panel.locator('.ua-perspectives-bucket-label').getByText(BUCKET_LABELS[b], { exact: true }) });
  for (const b of COVERED) {
    const hit = coverageHit(b);
    await expect(bucket(b).locator(`a[href="${hit.url}"]`)).toBeVisible();
    await expect(bucket(b).getByText(hit.outlet, { exact: true })).toBeVisible();
  }
  for (const b of GAPS) await expect(bucket(b).getByText('No coverage found', { exact: true })).toBeVisible();

  const agreed = sheet.getByRole('region', { name: 'Agreed across sides' });
  await expect(agreed.locator('blockquote')).toHaveText([first8(PASSAGES.left), first8(PASSAGES.center)]);
  await expect(
    sheet.getByText(
      `Leans come from the UnAlgorithm outlet registry (${FIXTURE_LIST.version}), reviewed by people, never from AI.`,
      { exact: true },
    ),
  ).toBeVisible();
  return sheet;
}

/** A Facebook post's UnEcho Chamber button. */
export const perspectivesButton = (post: Locator): Locator =>
  post.locator('unalgo-post').getByRole('button', { name: PERSPECTIVES_START, exact: true });

/** The Facebook fixture feed's two posts: friends-only first, then the public link share. */
export function facebookPosts(page: Page): { friends: Locator; share: Locator } {
  const [friends, share] = [0, 1].map((i) => page.locator('[role="feed"] > div').nth(i)) as [Locator, Locator];
  return { friends, share };
}

/** UnEcho Chamber on the link share: the price line `price`, `beforeConfirm`, then Compare, then "See result". */
export async function compare(share: Locator, price: string, beforeConfirm?: () => unknown): Promise<void> {
  const ui = share.locator('unalgo-post');
  await perspectivesButton(share).click();
  await expect(ui.getByText(price, { exact: true })).toBeVisible();
  await expect(ui.getByRole('button', { name: 'Compare', exact: true })).toBeFocused();
  await beforeConfirm?.();
  await ui.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(ui.getByRole('button', { name: 'See result' })).toBeVisible({ timeout: 20_000 });
}
