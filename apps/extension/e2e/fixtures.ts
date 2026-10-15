import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, test as base, chromium, type Locator, type Page } from '@playwright/test';
import { FRIEND_POST, fbFeed, ORGANIC_LINK_SHARE } from '../../../packages/platforms/fixtures/facebook/synthetic.ts';
import {
  COMPANY_NOT_FOLLOWED,
  FIRST_DEGREE_POST,
  FOLLOWED_BY_POST,
  feed2026,
  HIRING_PROMO,
  JOINED_GROUP_POST,
  LIKES_GROUP_POST,
  POST_WITH_COMMENTS,
  PROMOTED_FOLLOWS_PAGE,
  UNJOINED_GROUP_POST,
} from '../../../packages/platforms/fixtures/linkedin/y2026.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const EXTENSION_PATH = resolve(here, '../.output/chrome-mv3-e2e');
const devKey = JSON.parse(readFileSync(resolve(here, '../dev-key.json'), 'utf8')) as { id: string };

/** A LinkedIn-like page built from anonymized fixtures, with just enough styling to look like cards. */
export function linkedinShell(scheme: 'light' | 'dark' = 'light'): string {
  const cards = feed2026(
    FIRST_DEGREE_POST,
    PROMOTED_FOLLOWS_PAGE,
    POST_WITH_COMMENTS,
    FOLLOWED_BY_POST,
    HIRING_PROMO,
    LIKES_GROUP_POST,
    JOINED_GROUP_POST,
    UNJOINED_GROUP_POST,
    COMPANY_NOT_FOLLOWED,
  );
  const dark = scheme === 'dark';
  return `<!doctype html><html lang="en" class="${dark ? 'theme--dark' : ''}"><head><meta charset="utf-8"><title>Feed | LinkedIn</title>
<style>
  body { margin: 0; background: ${dark ? '#000' : '#f4f2ee'}; color: ${dark ? '#e9e9e9' : '#191919'}; font: 14px/1.4 -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 560px; margin: 24px auto; }
  [role="listitem"] { display: block; background: ${dark ? '#1b1f23' : '#fff'}; border-radius: 8px; margin: 0 0 8px; padding: 12px 16px; box-shadow: 0 0 0 1px rgb(0 0 0 / .08); }
  [role="listitem"] h2 { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  button { background: none; border: 0; color: inherit; font: inherit; }
  p { margin: 2px 0; }
</style></head><body>${cards}</body></html>`;
}

/**
 * A persistent context on a temporary profile with the e2e build of the extension loaded. No real network at all:
 * every request other than the extension's own is aborted unless a test routes it.
 */
export async function launchExtensionContext(): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    viewport: { width: 1280, height: 860 },
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('chrome-extension://') || url.startsWith('data:')) return route.continue();
    return route.abort();
  });
  return context;
}

/** The loaded extension's id, read from its service worker; always the id of the e2e build's dev key. */
export async function extensionIdOf(context: BrowserContext): Promise<string> {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  if (id !== devKey.id) throw new Error(`unexpected extension id ${id}`);
  return id;
}

/** The fixture LinkedIn feed (`linkedinShell`) in a new page of `context`; the `feed` fixture, for any context. */
export async function linkedinFeed(context: BrowserContext, scheme: 'light' | 'dark' = 'light'): Promise<Page> {
  await context.route('https://www.linkedin.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: linkedinShell(scheme) }),
  );
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/feed/');
  return page;
}

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
  feed: (scheme?: 'light' | 'dark') => Promise<Page>;
}>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  context: async ({}, use) => {
    const context = await launchExtensionContext();
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    await use(await extensionIdOf(context));
  },
  feed: async ({ context }, use) => {
    await use((scheme = 'light') => linkedinFeed(context, scheme));
  },
});

export const expect = test.expect;

/** Fact-check (P3-09, P3-24): the action's name, and phrases of the posts the specs' mocks flag with `hasCheckableClaims`. */
export const CHECK_FACTS = 'Check facts';
export const LINKEDIN_FLAGGED = 'Which HR task would you automate first';
export const FB_PUBLIC_FLAGGED = 'city transit funding';
export const FB_FRIENDS_FLAGGED = 'garden finally produced tomatoes';
export const FLAGGED = [LINKEDIN_FLAGGED, FB_PUBLIC_FLAGGED, FB_FRIENDS_FLAGGED];

/** The LinkedIn fixture feed's flagged first-degree post. */
export const linkedinPost = (page: Page) => page.locator('[componentkey="update-card-focusEEEkeyFirstDegree5"]');

/** Turns Labs → Fact-check on through the options page's switch (on `#/labs`), which must be enabled and off. */
export async function turnOnLabs(options: Page): Promise<void> {
  const toggle = options.getByRole('switch', { name: 'Fact-check' });
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
}

/** A Facebook-like feed: the friends-only post first, then the public link share. */
export async function facebookFeed(context: BrowserContext): Promise<Page> {
  await context.route('https://www.facebook.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Facebook</title></head><body>${fbFeed(FRIEND_POST, ORGANIC_LINK_SHARE)}</body></html>`,
    }),
  );
  const page = await context.newPage();
  await page.goto('https://www.facebook.com/');
  return page;
}

/**
 * Clicks "See result" on a checked post and records P3-06's gesture question as an annotation: does `sidePanel.open`
 * from the relayed click succeed? A refusal shows the toolbar hint; either outcome passes.
 */
export async function seeResult(ui: Locator): Promise<void> {
  await ui.getByRole('button', { name: 'See result' }).click();
  const hint = ui.getByText('Open UnAlgorithm from the toolbar to see it.');
  const refused = await hint.waitFor({ timeout: 2_000 }).then(
    () => true,
    () => false,
  );
  test.info().annotations.push({ type: 'sidePanel.open', description: refused ? 'refused' : 'opened' });
}
