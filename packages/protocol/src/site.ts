/**
 * The website's pages built from this repo's Markdown (R47a). The website (a separate repo that includes this one as a
 * submodule) imports these to make each page from its `source` at its `path`, to run its drift check on them and to
 * link them in its legal footer; the extension links the same URLs. `test/site.test.ts` keeps each `source` real and its
 * first heading equal to `title`.
 */
import { OUTLETS_PAGE_PATH } from './outlets.ts';

/** The product website. `cloud.unalgorithm.app` is UnAlgorithm Cloud, never the website. */
export const WEBSITE_ORIGIN = 'https://unalgorithmfeed.com';

/** UnAlgorithm Cloud, HeitechSoft's server: the one origin the extension names "UnAlgorithm Cloud". */
export const CLOUD_ORIGIN = 'https://cloud.unalgorithm.app';
/** UnAlgorithm Cloud's public source list page (decision D97): on the Cloud, not the website, so it never lags the list. */
export const SOURCE_LIST_PAGE_URL = `${CLOUD_ORIGIN}${OUTLETS_PAGE_PATH}`;

/** The open-source repository, where issues are filed ("Report a problem", the correction form). */
export const SOURCE_REPO = 'https://github.com/HeitechSoft/unalgorithm';

export interface SiteDocument {
  /** The Markdown file, relative to this repo's root. */
  readonly source: string;
  /** The page's path on the website. */
  readonly path: `/${string}`;
  /** The page's title: the source's first heading. */
  readonly title: string;
  /** What a link to the page says (the extension's consent step, the website's footer). */
  readonly linkText: string;
}

export const CLOUD_BETA_NOTICE = {
  source: 'CLOUD-BETA-NOTICE.md',
  path: '/cloud/beta-privacy',
  title: 'UnAlgorithm Cloud beta privacy notice',
  linkText: 'Beta privacy notice',
} as const satisfies SiteDocument;

export const CLOUD_BETA_TERMS = {
  source: 'CLOUD-BETA-TERMS.md',
  path: '/cloud/beta-terms',
  title: 'UnAlgorithm Cloud beta terms',
  linkText: 'Beta terms',
} as const satisfies SiteDocument;

/** The Cloud beta's documents, in the order they are linked. */
export const CLOUD_BETA_DOCUMENTS: readonly SiteDocument[] = [CLOUD_BETA_NOTICE, CLOUD_BETA_TERMS];

/**
 * "How credits work" (R30, CL2-14). Its source is a template: the website fills its `{{name}}` placeholders with
 * `creditsMarkdown(source, CREDIT_PRICE_SCHEDULE, buildTime)` from `@unalgorithm/core`, which fails on an unknown or
 * left-over placeholder, so every figure on the page comes from the price schedule the Cloud charges by. The `pricingUrl`
 * the Cloud sends is `siteUrl(CREDITS_PAGE)`.
 */
export const CREDITS_PAGE = {
  source: 'docs/site/credits.md',
  path: '/credits',
  title: 'How credits work',
  linkText: 'How credits work',
} as const satisfies SiteDocument;

/**
 * "Published prompts" (F29, P3-65, decision D83): generated, never edited by hand. `pnpm docs:site` writes it from the
 * prompts, builders, schemas, models and limits in `@unalgorithm/research`, and a test fails when the file differs.
 */
export const PROMPTS_PAGE = {
  source: 'docs/site/prompts.md',
  path: '/methodology/prompts',
  title: 'Published prompts',
  linkText: 'Prompts',
} as const satisfies SiteDocument;

/** "Evaluations and trust gates" (F29, P3-65): both eval sets in full and the gates, generated as PROMPTS_PAGE is. */
export const EVALS_PAGE = {
  source: 'docs/site/evals.md',
  path: '/methodology/evals',
  title: 'Evaluations and trust gates',
  linkText: 'Evaluations',
} as const satisfies SiteDocument;

/**
 * "How Fact-check and UnEcho Chamber work" (F29, P3-68): the methodology, written by hand. Every number it states is
 * pinned to the code by the extension's `methodology-doc.test.ts`. It links the generated pages above and UnAlgorithm
 * Cloud's source list (`SOURCE_LIST_PAGE_URL`), which is not a site document: it lives on the Cloud (decision D97).
 */
export const METHODOLOGY_PAGE = {
  source: 'docs/site/methodology.md',
  path: '/methodology',
  title: 'How Fact-check and UnEcho Chamber work',
  linkText: 'Methodology',
} as const satisfies SiteDocument;

/** "Corrections and appeals" (F30, P3-68): how to ask for a correction or appeal a source list entry, and the audit. */
export const CORRECTIONS_PAGE = {
  source: 'docs/site/corrections.md',
  path: '/corrections',
  title: 'Corrections and appeals',
  linkText: 'Corrections and appeals',
} as const satisfies SiteDocument;

/** The website footer's "How checks work" links, in order (P3-70 appends the transparency reports). */
export const METHODOLOGY_DOCUMENTS: readonly SiteDocument[] = [METHODOLOGY_PAGE, PROMPTS_PAGE, EVALS_PAGE, CORRECTIONS_PAGE];

/**
 * Text for one cell of a Markdown table in a generated site page: line breaks become spaces; \ | * _ ` [ ] < > are
 * escaped. The one escape every generated page uses, so text from a set or a source list can never add a cell, a link, a
 * tag or emphasis. Not for a code span, where a backslash shows as itself.
 */
export function markdownCell(text: string): string {
  return text.replace(/\r\n|[\r\n]/g, ' ').replace(/[\\|*_`[\]<>]/g, '\\$&');
}

/** The website footer's Cloud links, in order: the beta notice and terms, then "How credits work". */
export const CLOUD_FOOTER_LINKS: readonly SiteDocument[] = [...CLOUD_BETA_DOCUMENTS, CREDITS_PAGE];

/**
 * `/pricing` (CL5-09): a prerendered page that leads to "How credits work", so there is one pricing page. The website
 * renders it with `<meta http-equiv="refresh" content="0; url={to}">`, a canonical link to `to` and a plain link saying
 * `linkText` (it works without script); a static site needs no server redirect.
 */
export const PRICING_REDIRECT = {
  path: '/pricing',
  to: CREDITS_PAGE.path,
  linkText: 'Pricing and credits',
} as const;

/** The "Pricing" link of the website's footer and home page: to "How credits work", never to `/pricing`. */
export const PRICING_FOOTER_LINK = { linkText: 'Pricing', path: CREDITS_PAGE.path } as const;

/** A website page's full URL. */
export const siteUrl = (doc: Pick<SiteDocument, 'path'>): string => `${WEBSITE_ORIGIN}${doc.path}`;
