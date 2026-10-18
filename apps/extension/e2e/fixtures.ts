import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, test as base, chromium, type Locator, type Page, type Route } from '@playwright/test';
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
/** The Chromium browsers the Playwright projects load the extension into (Firefox has its own driver, `firefox/`). */
export type ExtensionBrowser = 'chromium' | 'edge';
/** The e2e build each browser loads: `wxt build --mode e2e` and `wxt build -b edge --mode e2e`. */
export function extensionPath(browser: ExtensionBrowser): string {
  return resolve(here, `../.output/${browser === 'edge' ? 'edge' : 'chrome'}-mv3-e2e`);
}
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

const VIEWPORT = { width: 1280, height: 860 };

/**
 * A persistent context on a temporary profile with the browser's e2e build of the extension loaded. No real network at
 * all: every request other than the extension's own is aborted unless a test routes it.
 *
 * Chromium is Playwright's own unless `UA_CHROMIUM` names another Chromium binary; it loads the build with
 * `--load-extension`. Edge is the installed Microsoft Edge (Playwright's `msedge` channel) unless `UA_EDGE` names a
 * binary. Branded Edge ignores `--load-extension`, so the build is loaded over the DevTools pipe Playwright already
 * holds (`Extensions.loadUnpacked`), which needs `--enable-unsafe-extension-debugging` and Playwright's default
 * `--disable-extensions` left out. The dev key gives the same extension id either way.
 */
export async function launchExtensionContext(browser: ExtensionBrowser = 'chromium'): Promise<BrowserContext> {
  const path = extensionPath(browser);
  const context =
    browser === 'edge'
      ? await chromium.launchPersistentContext('', {
          ...(process.env.UA_EDGE ? { executablePath: process.env.UA_EDGE } : { channel: 'msedge' }),
          viewport: VIEWPORT,
          ignoreDefaultArgs: ['--disable-extensions'],
          args: ['--enable-unsafe-extension-debugging'],
        })
      : await chromium.launchPersistentContext('', {
          ...(process.env.UA_CHROMIUM ? { executablePath: process.env.UA_CHROMIUM } : { channel: 'chromium' }),
          viewport: VIEWPORT,
          args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`],
        });
  if (browser === 'edge') {
    try {
      const session = await context.browser()?.newBrowserCDPSession();
      if (!session) throw new Error('Edge gave no DevTools session to load the extension through.');
      const { id } = (await session.send('Extensions.loadUnpacked', { path })) as { id: string };
      if (id !== devKey.id) throw new Error(`unexpected extension id ${id}`);
      await session.detach();
    } catch (err) {
      await context.close();
      throw err;
    }
  }
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

export const test = base.extend<
  {
    context: BrowserContext;
    extensionId: string;
    feed: (scheme?: 'light' | 'dark') => Promise<Page>;
  },
  {
    /** The project's browser (`playwright.config.ts`); a worker fixture, so `beforeAll` can launch it too. */
    extensionBrowser: ExtensionBrowser;
  }
>({
  extensionBrowser: ['chromium', { option: true, scope: 'worker' }],
  context: async ({ extensionBrowser }, use) => {
    const context = await launchExtensionContext(extensionBrowser);
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

/**
 * Waits for the CSS transitions on `el` and inside it to end; call it on a popover before clicking in it. A Why?
 * popover scales in for about 400 ms, and Playwright retries a click on a button that is still moving, scrolling it
 * a different way each time: its fourth try calls `scrollIntoView({ block: 'start' })`. The popover is anchored to
 * its stub, so that scrolls the whole feed (640 px here) and the click point lands on a post further down. On a slow
 * runner the first three tries all saw the button moving.
 */
export async function settled(el: Locator): Promise<void> {
  await el.evaluate((node) => Promise.allSettled(node.getAnimations({ subtree: true }).map((a) => a.finished)));
}

/**
 * Opens Settings → AI (`#/ai`) and saves the AI source `config` (with `apiKey`, if any) from it. With `test`, the
 * source is tested first and saved with the model the test picked, as the AI pane does. Returns the options page.
 */
export async function saveSource(
  context: BrowserContext,
  extensionId: string,
  config: Record<string, unknown>,
  apiKey?: string,
  opts: { test?: boolean } = {},
): Promise<Page> {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html#/ai`);
  const saved = await options.evaluate(
    async ([config, apiKey, test]) => {
      const key = apiKey ? { apiKey } : {};
      const tested = test ? await chrome.runtime.sendMessage({ type: 'testSource', config, ...key }) : null;
      if (tested && !tested.ok) return tested;
      const model = tested?.model ? { model: tested.model } : {};
      return chrome.runtime.sendMessage({ type: 'saveSource', config: { ...config, ...model }, ...key });
    },
    [config, apiKey, opts.test ?? false] as const,
  );
  expect(saved).toMatchObject({ ok: true });
  return options;
}

/** Turns a switch on the AI pane (`#/ai`; default Fact-check) on through the options page; it must be enabled and off. */
export async function turnOnLabs(options: Page, name: 'Fact-check' | 'UnEcho Chamber' = 'Fact-check'): Promise<void> {
  const toggle = options.getByRole('switch', { name });
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
  const hint = ui.getByText('Open unAlgorithm from the toolbar to see it.');
  const refused = await hint.waitFor({ timeout: 2_000 }).then(
    () => true,
    () => false,
  );
  test.info().annotations.push({ type: 'sidePanel.open', description: refused ? 'refused' : 'opened' });
}

/** CORS headers for mocked provider answers. */
export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
};

/**
 * Answers the AI pane's model list (`GET /v1/models`) on a mocked api.anthropic.com, so a mock records only the
 * requests that carry a post or a link. The specs save the source and turn the switches on from the AI pane (P3-64),
 * whose model picker asks for the list. Returns false for any other request.
 */
export function answerAnthropicModels(route: Route): boolean {
  const request = route.request();
  if (request.method() !== 'GET' || new URL(request.url()).pathname !== '/v1/models') return false;
  const data = ['claude-haiku-5-5', 'claude-sonnet-5-5'].map((id) => ({
    type: 'model',
    id,
    display_name: id,
    created_at: '2026-01-01T00:00:00Z',
  }));
  void route.fulfill({
    status: 200,
    headers: CORS,
    contentType: 'application/json',
    body: JSON.stringify({ data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null }),
  });
  return true;
}

/** The three web pages the fact-check mocks find: the passage each one's search result carries, and the quote cited. */
export const FACTCHECK_SOURCES = [
  {
    url: 'https://a.example/hr-automation',
    title: 'HR automation survey',
    passage: 'Most HR teams surveyed said they would automate interview scheduling first.',
    quote: 'would automate interview scheduling first',
  },
  {
    url: 'https://b.example/hr-report',
    title: 'HR technology report',
    passage: 'Interview scheduling is the task HR leaders most often hand to software.',
    quote: 'Interview scheduling is the task HR leaders most often hand to software',
  },
  {
    url: 'https://c.example/clinics',
    title: 'Clinic staffing notes',
    passage: 'Northwind Clinics employs an HR director for its regional offices.',
    quote: 'Northwind Clinics employs an HR director',
  },
] as const;

/** Every "Check facts" button on a page. */
export const checkButtons = (page: Page) => page.locator('unalgo-post').getByRole('button', { name: CHECK_FACTS });

/** "Check facts", the price line `price`, `beforeConfirm`, then Check, then "See result". */
export async function runCheck(post: Locator, price: string, beforeConfirm?: () => unknown): Promise<void> {
  const ui = post.locator('unalgo-post');
  await ui.getByRole('button', { name: CHECK_FACTS }).click();
  await expect(ui.getByText(price)).toBeVisible();
  await beforeConfirm?.();
  await ui.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(ui.getByRole('button', { name: 'See result' })).toBeVisible({ timeout: 20_000 });
}

export interface StoredEntry {
  status: string;
  result?: {
    claims: { id: string; verdict: string; downgraded?: string; citations: { sourceId: string; quote: string }[] }[];
    sources: { id: string; url: string; domain: string }[];
  };
}

/** Every fact-check entry in session storage, read through the service worker. */
export async function storedChecks(context: BrowserContext): Promise<Record<string, { entries: StoredEntry[] }>> {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  return sw.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    return Object.fromEntries(Object.entries(all).filter(([key]) => key.startsWith('factcheck:')));
  }) as Promise<Record<string, { entries: StoredEntry[] }>>;
}
