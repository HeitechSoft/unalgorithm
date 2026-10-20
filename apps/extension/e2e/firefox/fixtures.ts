import { test as base, expect } from '@playwright/test';
import { AUTHORIZE_PAGE_PATH } from '@unalgorithm/protocol';
import type { Page } from 'puppeteer-core';
import { FRIEND_POST, fbFeed, ORGANIC_LINK_SHARE } from '../../../../packages/platforms/fixtures/facebook/synthetic.ts';
import { linkedinShell, UNMENTIONED_TOPIC } from '../fixtures.ts';
import { clearMailbox, latestSignInCode } from '../server-harness.ts';
import {
  aria,
  axeProblems,
  click,
  type FirefoxProfile,
  fill,
  fixturePage,
  launchFirefox,
  pageText,
  text,
  visible,
} from './driver.ts';

export { expect };

/** The LinkedIn fixture feed's address: the content script's match. */
export const LINKEDIN_FEED = 'https://www.linkedin.com/feed/';

/**
 * Firefox's own test pref: the add-on's permission and data-collection consent requests are granted without the
 * prompt, which is browser UI that automation can't answer. The requests are still the extension's, from a click. Every
 * profile that turns on AI or signs in to a server needs it, since a server on this computer asks too (ADR 0008).
 */
export const GRANT_REQUESTS = { 'extensions.webextOptionalPermissionPrompts': false };

export const test = base.extend<{
  /** A fresh Firefox with the e2e build installed, closed after the test. */
  firefox: FirefoxProfile;
  /** The fixture LinkedIn feed (`linkedinShell`) in a new tab. */
  feed: (scheme?: 'light' | 'dark') => Promise<Page>;
}>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  firefox: async ({}, use) => {
    const profile = await launchFirefox({ prefs: GRANT_REQUESTS });
    await use(profile);
    await profile.close();
  },
  feed: async ({ firefox }, use) => {
    await use((scheme = 'light') => fixturePage(firefox, LINKEDIN_FEED, linkedinShell(scheme)));
  },
});

/**
 * Lets the profile reach anything on `http://127.0.0.1:*` (a local server, a mock AI provider) through its proxy, as
 * `allowServer` routes Chromium. `record` receives each request's URL and body (empty without one).
 */
export function allowLocal(profile: FirefoxProfile, record?: (url: string, body: string) => void): () => void {
  return profile.proxy.route(/^http:\/\/127\.0\.0\.1:\d+\//, (request) => {
    record?.(request.url, request.body);
    return 'forward';
  });
}

/**
 * Firefox's technical and interaction data for the add-on, turned on as a person who left the install prompt's choice on
 * (or turned it on in Firefox's add-ons page) has it. A temporary add-on gets no install prompt, so it starts without
 * it, and the add-on itself never asks for it (ADR 0008): the test asks, from a button it adds to an extension page and
 * clicks, since Firefox takes a request only from a user action. The profile needs `GRANT_REQUESTS`. With it, a sign-in
 * sends the device's name.
 */
export async function keepTechnicalData(profile: FirefoxProfile): Promise<void> {
  const page = await profile.open('options.html');
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.textContent = 'Keep technical data';
    button.addEventListener('click', () => void browser.permissions.request({ data_collection: ['technicalAndInteraction'] }));
    document.body.prepend(button);
  });
  await click(page, aria('button', 'Keep technical data'));
  await expect.poll(() => grantedTypes(page)).toContain('technicalAndInteraction');
  await page.close();
}

/** The data-collection types Firefox reports as granted, sorted. */
export function grantedTypes(page: Page): Promise<string[]> {
  return page.evaluate(async () => [...((await browser.permissions.getAll()).data_collection ?? [])].sort());
}

/**
 * Signs the profile in to a local server from Settings → AI, as a person does on Firefox: the server card and its
 * address, who receives posts, then "Sign in and turn on", which opens the server's sign-in page in Firefox's own
 * sign-in window (`identity.launchWebAuthFlow`, the shipped path). The emailed code is read from Mailpit; the page's
 * redirect to `https://<sha1 of the add-on id>.extensions.allizom.org/` ends the window. The click asks for Firefox's
 * data-collection consent, a server on this computer included, so the profile is launched with `GRANT_REQUESTS`, and the
 * test checks the consent was given, and that technical and interaction data was left as it was. The caller lets the
 * profile reach the server first (`allowLocal`). Returns the options page, left on the AI pane.
 */
export async function signInFromSettings(
  profile: FirefoxProfile,
  serverUrl: string,
  email: string,
  /** Runs on the sign-in page once the Email field is visible ('email') and once the code field is visible ('code'). */
  onStep?: (step: 'email' | 'code', page: Page) => Promise<void>,
): Promise<Page> {
  const host = new URL(serverUrl).host;
  await clearMailbox();

  const options = await profile.open('options.html#/ai');
  await click(options, text('unAlgorithm server'));
  await fill(options, 'Server address', serverUrl);
  await click(options, aria('button', 'Continue'));
  await expect
    .poll(() => pageText(options))
    .toContain(`goes from your browser to ${host}. That server is run by its owner, not HeitechSoft`);

  const before = await grantedTypes(options);
  const authorize = `${serverUrl}${AUTHORIZE_PAGE_PATH}`;
  const window = profile.browser.waitForTarget((t) => t.url().startsWith(authorize), { timeout: 15_000 });
  await click(options, aria('button', 'Sign in and turn on'));
  const signIn = await (await window).asPage();
  if (!signIn) throw new Error('The sign-in window has no page.');
  await visible(signIn, aria('textbox', 'Email'));
  await onStep?.('email', signIn);
  await fill(signIn, 'Email', email);
  await click(signIn, aria('button', 'Send code'));
  await visible(signIn, aria('textbox', '6-digit code'));
  await onStep?.('code', signIn);
  await fill(signIn, '6-digit code', await latestSignInCode());
  await click(signIn, aria('button', 'Sign in'));
  await expect.poll(() => pageText(options), { timeout: 15_000 }).toContain(`Signed in as ${email}`);
  // The sign-in click asked for every type a server gets (post text, people's names, the account) and nothing else:
  // technical and interaction data stays as the person left it.
  expect(await grantedTypes(options)).toEqual([...new Set([...before, ...SERVER_CONSENT])].sort());
  return options;
}

/** The data-collection consent a server sign-in asks for, sorted. */
export const SERVER_CONSENT = ['authenticationInfo', 'personalCommunications', 'personallyIdentifyingInfo', 'websiteContent'];

/** No serious or critical axe violations. Soft, so a test goes on. */
export async function expectAccessible(page: Page): Promise<void> {
  const problems = await axeProblems(page);
  expect.soft(problems, problems.join('\n')).toEqual([]);
}

/**
 * Opens a confirm dialog with a click on `opener` and checks it as a modal, as `expectDialogTrapsFocus` does in
 * Chromium: the focus starts on "Cancel"; pressing Tab as many times as the dialog has `controls`, plus one, never
 * focuses anything behind it; the Escape key closes it.
 */
export async function expectDialogTrapsFocus(page: Page, opener: string, controls: number): Promise<void> {
  await click(page, opener);
  await page.waitForSelector('dialog[open]');
  await expect.poll(() => focusIn(page)).toBe('Cancel');
  for (let press = 0; press <= controls; press++) {
    await page.keyboard.press('Tab');
    expect(await focusIn(page)).not.toBe('behind');
  }
  await page.keyboard.press('Escape');
  await expect.poll(() => page.$('dialog[open]')).toBeNull();
}

/** The focused button's text when it is in the open dialog, 'nothing' when the page has no focus, else 'behind'. */
function focusIn(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) return 'nothing';
    if (!document.querySelector('dialog[open]')?.contains(active)) return 'behind';
    return active instanceof HTMLButtonElement ? (active.textContent ?? '').trim() : 'dialog';
  });
}

/** The Facebook fixture feed's address. */
export const FACEBOOK_FEED = 'https://www.facebook.com/';
/** The Facebook fixture feed's posts, in order: friends-only first, then the public link share. */
export const facebookPost = (index: number): string => `[role="feed"] > div:nth-child(${index + 1})`;

/** The Facebook fixture feed with the friends-only post and the public link share, as `facebookFeed` serves Chromium. */
export function facebookFeed(profile: FirefoxProfile): Promise<Page> {
  return fixturePage(
    profile,
    FACEBOOK_FEED,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Facebook</title></head><body>${fbFeed(FRIEND_POST, ORGANIC_LINK_SHARE)}</body></html>`,
  );
}

/**
 * Marks the topic `label` More in Settings → Interests, as `markTopicMore` in `../fixtures.ts` does in Chromium. The AI
 * highlights and hides posts by relevance only once the person has said what they want, so a spec that waits for an AI
 * pick marks a topic first: by default one no fixture post mentions, so the pick is the AI's.
 */
export async function markTopicMore(profile: FirefoxProfile, label = UNMENTIONED_TOPIC): Promise<void> {
  const page = await profile.open('options.html#/interests');
  const name = `More: ${label}`;
  await click(page, aria('button', name));
  // Pressed once the settings are stored.
  await page.waitForFunction(
    (n) => document.querySelector(`[aria-label="${n}"]`)?.getAttribute('aria-pressed') === 'true',
    {},
    name,
  );
  await page.close();
}

/** A switch on the AI pane, which must be enabled and off, turned on from the options page. */
export async function turnOnLabs(options: Page, name: 'Fact-check' | 'UnEcho Chamber'): Promise<void> {
  const toggle = await options.waitForSelector(aria('switch', name));
  expect(await toggle?.evaluate((el) => [el.getAttribute('aria-checked'), (el as HTMLButtonElement).disabled])).toEqual([
    'false',
    false,
  ]);
  await click(options, aria('switch', name));
  await expect.poll(() => toggle?.evaluate((el) => el.getAttribute('aria-checked'))).toBe('true');
}

/**
 * "See result" on a post whose check is done. Firefox's sidebar can't be opened from a click relayed by a content
 * script, and a test can't open it at all, so the post says how: with the shortcut the person has, or from the toolbar.
 */
export async function seeResultHint(feed: Page, post: string): Promise<void> {
  await click(feed, `${post} unalgo-post >>> ${aria('button', 'See result')}`);
  // The manifest's suggested key, as Firefox shows it (`MacCtrl` is the Control key on a Mac).
  const shortcut = process.platform === 'darwin' ? 'Control+Shift+U' : 'Alt+Shift+U';
  await expect
    .poll(() => pageText(feed))
    .toContain(`Press ${shortcut} to see it, or open unAlgorithm from the toolbar and choose Open Highlights.`);
}
