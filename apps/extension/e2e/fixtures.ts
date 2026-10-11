import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, test as base, chromium, type Page } from '@playwright/test';
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

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
  feed: (scheme?: 'light' | 'dark') => Promise<Page>;
}>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      viewport: { width: 1280, height: 860 },
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    // No real network at all: everything is aborted unless a test serves it.
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('chrome-extension://') || url.startsWith('data:')) return route.continue();
      return route.abort();
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const id = new URL(sw.url()).host;
    if (id !== devKey.id) throw new Error(`unexpected extension id ${id}`);
    await use(id);
  },
  feed: async ({ context }, use) => {
    await use(async (scheme = 'light') => {
      await context.route('https://www.linkedin.com/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: linkedinShell(scheme) }),
      );
      const page = await context.newPage();
      await page.goto('https://www.linkedin.com/feed/');
      return page;
    });
  },
});

export const expect = test.expect;
