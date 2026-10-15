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

/** A website page's full URL. */
export const siteUrl = (doc: Pick<SiteDocument, 'path'>): string => `${WEBSITE_ORIGIN}${doc.path}`;
