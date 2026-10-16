/**
 * The website's pages built from this repo's Markdown (R47a). The website (a separate repo that includes this one as a
 * submodule) imports these to make each page from its `source` at its `path`, to run its drift check on them and to
 * link them in its legal footer; the extension links the same URLs. `test/site.test.ts` keeps each `source` real and its
 * first heading equal to `title`.
 */

/** The product website. `cloud.unalgorithm.app` is UnAlgorithm Cloud, never the website. */
export const WEBSITE_ORIGIN = 'https://unalgorithmfeed.com';

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
 * Text for one cell of a Markdown table in a generated site page: line breaks become spaces; \ | * _ ` [ ] < > are
 * escaped. The one escape every generated page uses, so text from a set or a registry can never add a cell, a link, a
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
