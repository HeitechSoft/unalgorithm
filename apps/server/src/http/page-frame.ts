/**
 * The frame of the server's own pages, shared by `mountWeb` (apps/web's built `index.html`) and the pages a billing module
 * renders through its host (CL5-03): one CSP, one missing-build answer, and for module pages apps/web's frame and
 * stylesheet around escaped HTML, with no script. A module never writes its own escaper, frame or CSP.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from 'hono';
import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { Config } from '../config.ts';
import type { Logger } from '../log.ts';

/** Larger request bodies outside `/v1` and `/api/auth` are refused: the server's own pages take none. */
export const MAX_PAGE_BODY_BYTES = 16 * 1024;

export interface ModulePage {
  /** The tab title before " · <instance name>". */
  title: string;
  /** The line under the heading, as on apps/web's pages. */
  intro: string;
  /** The page body, built with host.html (escaped; hono's tag may return a Promise); a plain string is refused. */
  main: HtmlEscapedString | Promise<HtmlEscapedString>;
  /** Default 200. */
  status?: 200 | 400 | 403 | 404 | 409 | 429 | 502 | 503;
  /** Extra origins a form on the page may submit to or be redirected to, e.g. 'https://checkout.stripe.com'. */
  formActions?: readonly string[];
}

/** An https origin with no path: nothing that could end the directive or add another. */
const HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/;

/**
 * The CSP of the server's own pages: scripts, styles and requests from this origin only, nothing inline, never in a
 * frame, forms to this origin plus `formActions`. Chrome applies `form-action` to the redirect after a form submission,
 * so a POST answered with a 303 to a payment page needs that page's origin listed.
 */
export function pageCsp(formActions: readonly string[] = []): string {
  for (const origin of formActions) {
    if (!HTTPS_ORIGIN.test(origin)) throw new TypeError('form actions must be https origins');
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    ["form-action 'self'", ...formActions].join(' '),
  ].join('; ');
}

/** apps/web's built index.html, or null when there is no build (ENOENT/ENOTDIR); other errors throw. */
export async function readWebIndex(webDist: string): Promise<string | null> {
  try {
    return await readFile(join(webDist, 'index.html'), 'utf8');
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

const LINK_TAG = /<link\b[^>]*>/gi;
const ATTRIBUTE = /([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
/** Vite's hashed stylesheet names. */
const BUILT_STYLESHEET = /^\/assets\/[A-Za-z0-9._-]+\.css$/;

/** The stylesheet hrefs of that index: only `/assets/<name>.css` paths, in document order. */
export function webStylesheets(indexHtml: string): string[] {
  const hrefs: string[] = [];
  for (const [tag] of indexHtml.matchAll(LINK_TAG)) {
    const attrs = new Map<string, string>();
    for (const m of tag.matchAll(ATTRIBUTE)) attrs.set((m[1] ?? '').toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '');
    const href = attrs.get('href') ?? '';
    // No `..` anywhere, even inside a name the pattern allows.
    if (attrs.get('rel')?.toLowerCase() === 'stylesheet' && BUILT_STYLESHEET.test(href) && !href.includes('..')) {
      hrefs.push(href);
    }
  }
  return hrefs;
}

/** The loggers that already said the build is missing: each says it once. */
const missingLogged = new WeakSet<Logger>();

/** 503 `Build apps/web first`, logging `web.missing` once per logger. */
export function webMissing(c: Context, { config, log }: { config: Pick<Config, 'webDist'>; log: Logger }): Response {
  if (!missingLogged.has(log)) log.warn('web.missing', { web_dist: config.webDist });
  missingLogged.add(log);
  return c.text('Build apps/web first', 503);
}

/**
 * A module's page in apps/web's frame (`Page.tsx`'s class names, so the built stylesheet styles it) under `pageCsp`,
 * with no script. The referrer meta overrides the server's global `Referrer-Policy: no-referrer` for this page only: a
 * form POST from a no-referrer document carries `Origin: null`, which `ownPage` refuses, while `same-origin` sends the
 * real origin here and still no Referer elsewhere. (A `Referrer-Policy` header set here would be overwritten by
 * `secureHeaders`, which writes after the route.)
 */
export async function renderModulePage(
  c: Context,
  deps: { config: Pick<Config, 'webDist' | 'instanceName' | 'sourceUrl'>; log: Logger },
  page: ModulePage,
): Promise<Response> {
  const main: unknown = await page.main;
  // For JavaScript callers the types cannot stop: only hono's tag marks its result as escaped.
  if (!(typeof main === 'object' && main !== null && (main as { isEscaped?: unknown }).isEscaped === true)) {
    throw new TypeError('page.main must be built with host.html');
  }
  const csp = pageCsp(page.formActions);
  const index = await readWebIndex(deps.config.webDist);
  if (index === null) return webMissing(c, deps);
  const { instanceName, sourceUrl } = deps.config;
  const body = await html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="same-origin">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><link rel="icon" href="data:,"><title>${page.title} · ${instanceName}</title>
${webStylesheets(index).map((href) => html`<link rel="stylesheet" href="${href}">`)}</head>
<body><div class="web-page"><main class="web-main"><header class="web-header"><h1>${instanceName}</h1><p>${page.intro}</p></header>
${main}</main><footer class="web-footer">${instanceName} · <a href="${sourceUrl}" target="_blank" rel="noreferrer">Source</a></footer></div></body></html>`;
  c.header('Content-Security-Policy', csp);
  c.header('Cache-Control', 'no-store');
  return c.html(body, page.status ?? 200);
}
