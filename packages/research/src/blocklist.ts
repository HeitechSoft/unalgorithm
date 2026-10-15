/**
 * Domains a fact-check never cites: satire sites (their own about or disclaimer page says they publish satire) and
 * content farms. Reviewable data, not editorial judgment: every entry carries the evidence page that justifies it.
 *
 * Seed rule: an entry is added only after its evidence page has been opened and the satire statement seen there,
 * never from memory. Content farms are added by review with evidence. The seed ships empty for that review.
 */

export interface BlockedDomain {
  /** Lowercase, no scheme, no `www.`. Subdomains are blocked too. */
  domain: string;
  category: 'satire' | 'content-farm';
  /** https URL showing why (for satire: the site's own about or disclaimer page). */
  evidence: string;
  /** YYYY-MM-DD */
  addedOn: string;
}

export const BLOCKLIST_STATUS: { status: 'draft' | 'reviewed'; reviewedBy: string | null; reviewedOn: string | null } = {
  status: 'draft',
  reviewedBy: null,
  reviewedOn: null,
};

export const BLOCKLIST: readonly BlockedDomain[] = [];

/** The blocked domains, sorted. */
export function blockedDomains(): string[] {
  return BLOCKLIST.map((entry) => entry.domain).sort();
}
