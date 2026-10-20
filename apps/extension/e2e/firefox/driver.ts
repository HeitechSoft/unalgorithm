/**
 * Firefox for the end-to-end tests (ADR 0008): Puppeteer over WebDriver BiDi, since Playwright can't install a Firefox
 * add-on. Each profile is a fresh Firefox with the e2e build installed as a temporary add-on (BiDi
 * `webExtension.install`) and its own egress proxy, which every request of the profile goes through, the background's
 * included. Fixture feeds are served at their real addresses by tab request interception, which BiDi does see.
 *
 * Firefox quirks the helpers absorb:
 * - BiDi may open `moz-extension://` pages only when Firefox starts with `--remote-allow-system-access`.
 * - Firefox reports no navigation events for extension pages, so Puppeteer never learns their URL (`page.url()` stays
 *   `about:blank`) and `page.goto` waits for an event that never comes; `navigate` waits on the BiDi command itself.
 * - There are no ARIA snapshots, but `::-p-aria(...)` queries work (BiDi `locateNodes`), also inside the in-feed UI's
 *   shadow roots when reached through `>>>`.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPORTS_PATH } from '@unalgorithm/protocol';
import puppeteer, { type Browser, type ElementHandle, type Page } from 'puppeteer-core';
import { type EgressProxy, proxyPrefs, startEgressProxy } from '../egress-proxy.ts';

const here = dirname(fileURLToPath(import.meta.url));
/** `wxt build -b firefox --mode e2e`: the development add-on id, Cloud on, the e2e host permissions. */
export const FIREFOX_EXTENSION_PATH = resolve(here, '../../.output/firefox-mv3-e2e');
/**
 * The Firefox executable to run: `UA_FIREFOX_BIN` (CI installs a pinned release), else the system Firefox on Linux. Not
 * `UA_FIREFOX`, which is `pnpm dev:firefox`'s and may name a web-ext channel such as `deved` instead of a file.
 */
const FIREFOX = process.env.UA_FIREFOX_BIN?.trim() || '/usr/lib/firefox/firefox';
const AXE_SOURCE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const INSTALL_TIMEOUT_MS = 15_000;
const POLL_MS = 100;

export interface FirefoxProfile {
  browser: Browser;
  /** Every request the profile sent (`requests`), and the routes that answer them. */
  proxy: EgressProxy;
  /** The add-on id Firefox reports: the development id. */
  id: string;
  /** `moz-extension://<uuid>`. The UUID is random per install, as for a person, so servers see a real one. */
  base: string;
  /** The onboarding tab the install opened. */
  onboarding: Page;
  /** Opens an extension page (`options.html#/ai`) in a new tab and waits for it to load. */
  open(path: string): Promise<Page>;
  /**
   * Firefox and its proxy stop; the temporary profile is deleted. Then the e2e guard (ADR 0009 §1): it throws when the
   * profile sent a problem report more often than its page's *Send report* or *Try again* was clicked
   * (`unaskedReports`), whatever the test did.
   */
  close(): Promise<void>;
}

export interface LaunchOptions {
  /** Extra Firefox prefs, e.g. a colour scheme. */
  prefs?: Record<string, unknown>;
}

/**
 * Starts Firefox on a new profile behind a new egress proxy, installs the e2e build and waits for the onboarding tab it
 * opens. Nothing is routed yet: the proxy drops every request until a test adds a route.
 */
export async function launchFirefox(opts: LaunchOptions = {}): Promise<FirefoxProfile> {
  const proxy = await startEgressProxy();
  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch({
      browser: 'firefox',
      executablePath: FIREFOX,
      headless: process.env.UA_HEADED !== '1',
      args: ['--remote-allow-system-access'],
      // The proxy's run certificate is self-signed; this is browser-wide in Firefox, the background included.
      acceptInsecureCerts: true,
      defaultViewport: { width: 1280, height: 860 },
      extraPrefsFirefox: { ...proxyPrefs(proxy.port), ...opts.prefs },
    });
    const id = await browser.installExtension(FIREFOX_EXTENSION_PATH);
    const onboarding = await extensionPage(browser, '/onboarding.html');
    const base = `moz-extension://${new URL(await hrefOf(onboarding)).host}`;
    const opened = browser;
    reportClicks.set(browser, new Map());
    return {
      browser,
      proxy,
      id,
      base,
      onboarding,
      async open(path) {
        const page = await opened.newPage();
        await navigate(page, `${base}/${path}`);
        return page;
      },
      async close() {
        try {
          await opened.close();
        } finally {
          await proxy.close();
        }
        const unasked = unaskedReports({ browser: opened, proxy });
        if (unasked.length) throw new Error(`Problem reports sent without a Send click:\n${unasked.join('\n')}`);
      },
    };
  } catch (err) {
    await browser?.close();
    await proxy.close();
    throw err;
  }
}

/** Where `page` is: read from the page, since Puppeteer doesn't follow extension pages. Empty if it can't be read. */
export function hrefOf(page: Page): Promise<string> {
  return page.evaluate(() => location.href).catch(() => '');
}

/** The tab showing the extension page whose path is `path`, once one does. */
export async function extensionPage(browser: Browser, path: string, timeout = INSTALL_TIMEOUT_MS): Promise<Page> {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (const page of await browser.pages()) {
      const href = await hrefOf(page);
      if (href.startsWith('moz-extension://') && new URL(href).pathname === path) return page;
    }
    if (Date.now() >= deadline) throw new Error(`No ${path} tab within ${timeout / 1000} s.`);
    await sleep(POLL_MS);
  }
}

/** The page's BiDi browsing context, whose commands wait for the load themselves (see the file comment). */
function contextOf(page: Page) {
  return (
    page.mainFrame() as unknown as {
      browsingContext: {
        navigate(url: string, wait: 'complete'): Promise<void>;
        reload(options: { wait: 'complete' }): Promise<void>;
      };
    }
  ).browsingContext;
}

/** Loads `url` in `page` and waits for the load event: extension pages through BiDi directly, others by `page.goto`. */
export async function navigate(page: Page, url: string): Promise<void> {
  if (url.startsWith('moz-extension://')) await contextOf(page).navigate(url, 'complete');
  else await page.goto(url);
}

/** Reloads a page and waits for the load event. (Navigating to the same URL with a hash would not reload it.) */
export async function reload(page: Page): Promise<void> {
  await contextOf(page).reload({ wait: 'complete' });
}

/** A message to the background from an extension page, as the extension's own pages send them. */
export function send<T = unknown>(page: Page, message: object): Promise<T> {
  return page.evaluate((m) => chrome.runtime.sendMessage(m), message) as Promise<T>;
}

/** A page at `url` whose HTML is `html`, served by intercepting the tab's own request so content scripts match. */
export async function fixturePage(profile: FirefoxProfile, url: string, html: string): Promise<Page> {
  const page = await profile.browser.newPage();
  const origin = new URL(url).origin;
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const target = request.url();
    if (target.startsWith(`${origin}/`)) return void request.respond({ status: 200, contentType: 'text/html', body: html });
    // The extension's own files (styles, fonts) and inline data; everything else stays offline.
    if (/^(moz-extension|data|blob):/.test(target)) return void request.continue();
    return void request.abort();
  });
  await page.goto(url);
  return page;
}

/**
 * The selector for the element with ARIA `role` and exactly this accessible name (any name when left out). Prefix it
 * with `<host> >>> ` to look inside a shadow root.
 */
export function aria(role: string, name?: string): string {
  return `::-p-aria(${name === undefined ? '' : `[name=${JSON.stringify(name)}]`}[role=${JSON.stringify(role)}])`;
}

/** The selector for the smallest elements whose text contains `text`. */
export function text(value: string): string {
  return `::-p-text(${JSON.stringify(value)})`;
}

/**
 * The e2e guard in Firefox (ADR 0009 §1), as `fixtures.ts` keeps it for Chromium: a problem report may leave the
 * browser only after the person clicked *Send report* (or *Try again*) on that report's page. Every such click a test
 * makes goes through `click`, with trusted input, and is counted here by the report id in the page's address; every
 * POST to the report route the profile's proxy saw, the background's included, is counted by the id in its body.
 */
const reportClicks = new WeakMap<Browser, Map<string, number>>();
const SEND_BUTTONS = new Set([aria('button', 'Send report'), aria('button', 'Try again')]);

/** The report id of a report page, from its address; null for any other page. */
async function reportPageId(page: Page): Promise<string | null> {
  const href = await hrefOf(page);
  if (!href.startsWith('moz-extension://')) return null;
  const url = new URL(href);
  return url.pathname === '/report.html' ? url.hash.slice(1) : null;
}

/** Reports the profile sent more often than their Send button was clicked: empty when every report was asked for. */
export function unaskedReports(profile: Pick<FirefoxProfile, 'browser' | 'proxy'>): string[] {
  const clicks = reportClicks.get(profile.browser) ?? new Map<string, number>();
  const sent = new Map<string, number>();
  for (const r of profile.proxy.requests) {
    if (r.method !== 'POST' || new URL(r.url).pathname !== REPORTS_PATH) continue;
    let id = '?';
    try {
      id = String((JSON.parse(r.body) as { id?: unknown }).id ?? '?');
    } catch {
      // Not a report body: counted under '?', which no click ever covers.
    }
    sent.set(id, (sent.get(id) ?? 0) + 1);
  }
  return [...sent]
    .filter(([id, n]) => n > (clicks.get(id) ?? 0))
    .map(([id, n]) => `${id}: ${n} sent, ${clicks.get(id) ?? 0} clicked`);
}

/** Clicks the element, once it is visible, enabled and still, with trusted input (a user action to Firefox). */
export async function click(page: Page, selector: string): Promise<void> {
  const report = SEND_BUTTONS.has(selector) ? await reportPageId(page) : null;
  await page.locator(selector).click();
  if (report === null) return;
  const clicks = reportClicks.get(page.browser());
  clicks?.set(report, (clicks.get(report) ?? 0) + 1);
}

/**
 * Types `value` into the field whose `<label>` (or `aria-label`) is `label`, replacing what it held. Found by its label
 * rather than by role, since a password field has no ARIA role.
 */
export async function fill(page: Page, label: string, value: string): Promise<void> {
  const found = await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll('label')].find((l) => l.textContent?.trim() === name)?.control ??
      [...document.querySelectorAll('input, textarea')].find((f) => f.getAttribute('aria-label') === name),
    {},
    label,
  );
  const field = found.asElement() as ElementHandle<Element> | null;
  if (!field) throw new Error(`No field labelled ${label}.`);
  await field.asLocator().fill(value);
}

/** Waits until an element matching `selector` is visible. */
export async function visible(page: Page, selector: string, timeout?: number): Promise<void> {
  await page.waitForSelector(selector, { visible: true, ...(timeout === undefined ? {} : { timeout }) });
}

/** How many elements match `selector` right now. */
export async function count(page: Page, selector: string): Promise<number> {
  return (await page.$$(selector)).length;
}

/** The text of the page and of every open shadow root in it, for `toContain` checks. */
export function pageText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts = [document.body.innerText];
    const walk = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll('*')) {
        if (!el.shadowRoot) continue;
        parts.push(el.shadowRoot.textContent ?? '');
        walk(el.shadowRoot);
      }
    };
    walk(document);
    return parts.join('\n');
  });
}

/** The value of attribute `name` on the first element matching `selector`, or null. */
export function attribute(page: Page, selector: string, name: string): Promise<string | null> {
  return page.evaluate((s, n) => document.querySelector(s)?.getAttribute(n) ?? null, selector, name);
}

/**
 * Serious and critical axe violations on the page (WCAG 2.2 AA tags), as `a11y.spec.ts` checks Chromium. axe-core is
 * evaluated into the page over BiDi, which the page's CSP doesn't govern.
 */
export async function axeProblems(page: Page): Promise<string[]> {
  if (!(await page.evaluate(() => 'axe' in window))) await page.evaluate(AXE_SOURCE);
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: AxeLike }).axe;
    const results = await axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
    });
    return results.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map(
        (v) =>
          `${v.id} (${v.impact}) ${v.nodes
            .slice(0, 3)
            .map((n) => n.target.join(' '))
            .join(' | ')}`,
      );
  });
}

/** The part of axe-core's API the check uses. */
interface AxeLike {
  run(
    context: Document,
    options: { runOnly: { type: 'tag'; values: string[] } },
  ): Promise<{ violations: { id: string; impact?: string | null; nodes: { target: string[] }[] }[] }>;
}

/** `Firefox on Linux`: the device name the extension gives itself on this computer (`device-name.ts`). */
export function firefoxDeviceName(): string {
  const os = { linux: 'Linux', win32: 'Windows', darwin: 'macOS' }[process.platform as string] ?? process.platform;
  return `Firefox on ${os}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
