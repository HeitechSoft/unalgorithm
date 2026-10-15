import { canonicalText, clipText } from '@unalgorithm/core';
import {
  type FactcheckClaim,
  type FactcheckSource,
  type FactcheckVerdict,
  MAX_CITATIONS_PER_CLAIM,
  MAX_QUOTE_WORDS,
  MIN_INDEPENDENT_DOMAINS,
  type RetrievedSource,
} from '@unalgorithm/protocol';

/**
 * The last gate between a research model and the person: every citation must point at a source retrieved in this run,
 * quote that source's own text, and come from a domain that isn't blocked; a verdict needs two independent domains.
 * Pure functions: nothing here calls a model or fetches anything.
 */

export interface RawVerdict {
  claimId: string;
  verdict: FactcheckVerdict;
  explanation: string;
  citations: { sourceId: string; quote: string }[];
}

export interface ValidationStats {
  /** Citations of the verdicts used by rule 1 (ignored duplicate or unknown-claim verdicts are not counted). */
  raw: number;
  kept: number;
  unknownSource: number;
  blockedSource: number;
  quoteTooLong: number;
  quoteMismatch: number;
  /** Removed by rule 3: repeated (sourceId, quote) pairs and citations over MAX_CITATIONS_PER_CLAIM. */
  duplicate: number;
}

const MAX_QUOTE_CHARS = 300;
const MAX_CLAIM_CHARS = 300;
const MAX_EXPLANATION_CHARS = 280;
const NO_VERDICT = 'No verdict was returned for this claim.';
const TOO_FEW_DOMAINS = "Fewer than two independent sources back this up, so it can't be verified here.";

/** Second-level suffixes under which a registrable domain has three labels. `gc.ca` is deliberately not one. */
const TWO_LEVEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'org.au',
  'gov.au',
  'co.nz',
  'co.jp',
  'com.br',
  'co.in',
]);

export function registrableDomain(host: string): string {
  const labels = host
    .toLowerCase()
    .replace(/^www\./, '')
    .split('.');
  const lastTwo = labels.slice(-2).join('.');
  return TWO_LEVEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

export function isBlocked(domain: string, blocked: readonly string[]): boolean {
  const d = domain.toLowerCase();
  return blocked.some((entry) => d === entry || d.endsWith(`.${entry}`));
}

/** Undo the escaping `neutralize` applies to snippets shown to the verdict model. `&amp;` last, so it isn't decoded twice. */
function decodeEntities(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const QUOTE_MARKS = /["'‘’‚‛“”„‟]/g;

function normalize(text: string): string {
  return canonicalText(text).toLowerCase().replace(QUOTE_MARKS, '').replace(/\s+/g, ' ').trim();
}

/**
 * True when the quote occurs in one of the snippets, up to case, whitespace and quote marks. An inner ellipsis splits
 * the quote into segments that must all occur, in order, in the same snippet. No fuzzy matching.
 */
export function quoteMatches(quote: string, snippets: readonly string[]): boolean {
  // NFKC (inside `normalize`) turns `…` into `...`.
  const q = normalize(quote).replace(/^(?:\.{3}\s*)+|(?:\s*\.{3})+$/g, '');
  const segments = q
    .split(/\s*\.{3}\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return false;
  return snippets.some((snippet) => {
    const text = normalize(snippet);
    let from = 0;
    for (const segment of segments) {
      const at = text.indexOf(segment, from);
      if (at < 0) return false;
      from = at + segment.length;
    }
    return true;
  });
}

function sourceOrder(id: string): number {
  return Number(id.slice(1));
}

export function validateVerdicts(input: {
  claims: readonly { id: string; text: string }[];
  sources: readonly RetrievedSource[];
  verdicts: readonly RawVerdict[];
  blocked: readonly string[];
}): { claims: FactcheckClaim[]; sources: FactcheckSource[]; stats: ValidationStats } {
  const stats: ValidationStats = {
    raw: 0,
    kept: 0,
    unknownSource: 0,
    blockedSource: 0,
    quoteTooLong: 0,
    quoteMismatch: 0,
    duplicate: 0,
  };
  const sourcesById = new Map(input.sources.map((s) => [s.id, s]));
  const cited = new Set<string>();

  const claims = input.claims.map((claim): FactcheckClaim => {
    const text = clipText(claim.text, MAX_CLAIM_CHARS);
    // Rule 1: the first verdict for this claim wins.
    const raw = input.verdicts.find((v) => v.claimId === claim.id);
    if (!raw) {
      return {
        id: claim.id,
        claim: text,
        verdict: 'unverifiable',
        explanation: NO_VERDICT,
        citations: [],
        downgraded: 'no-verdict',
      };
    }
    stats.raw += raw.citations.length;

    // Rule 2: provenance, blocked domains, quote length and quote match.
    const valid: { sourceId: string; quote: string; domain: string }[] = [];
    for (const citation of raw.citations) {
      const source = sourcesById.get(citation.sourceId);
      if (!source) {
        stats.unknownSource++;
        continue;
      }
      if (isBlocked(source.domain, input.blocked)) {
        stats.blockedSource++;
        continue;
      }
      const quote = decodeEntities(citation.quote).trim();
      const words = quote.split(/\s+/).filter(Boolean).length;
      if (words === 0 || words > MAX_QUOTE_WORDS || quote.length > MAX_QUOTE_CHARS) {
        stats.quoteTooLong++;
        continue;
      }
      if (!quoteMatches(quote, source.snippets)) {
        stats.quoteMismatch++;
        continue;
      }
      valid.push({ sourceId: source.id, quote, domain: source.domain });
    }

    // Rule 3: de-duplicate on (sourceId, normalized quote), then cap.
    const seen = new Set<string>();
    const kept: typeof valid = [];
    for (const c of valid) {
      const key = `${c.sourceId}\u0000${normalize(c.quote)}`;
      if (seen.has(key) || kept.length >= MAX_CITATIONS_PER_CLAIM) {
        stats.duplicate++;
        continue;
      }
      seen.add(key);
      kept.push(c);
    }
    stats.kept += kept.length;
    for (const c of kept) cited.add(c.sourceId);

    const out: FactcheckClaim = {
      id: claim.id,
      claim: text,
      verdict: raw.verdict,
      explanation: clipText(raw.explanation, MAX_EXPLANATION_CHARS),
      citations: kept.map(({ sourceId, quote }) => ({ sourceId, quote })),
    };
    // Rule 4: two independent domains, or it can't be verified here.
    const domains = new Set(kept.map((c) => registrableDomain(c.domain)));
    if (domains.size < MIN_INDEPENDENT_DOMAINS && out.verdict !== 'unverifiable') {
      out.verdict = 'unverifiable';
      out.explanation = TOO_FEW_DOMAINS;
      out.downgraded = 'too-few-domains';
    }
    return out;
  });

  const sources = input.sources
    .filter((s) => cited.has(s.id))
    .sort((a, b) => sourceOrder(a.id) - sourceOrder(b.id))
    .map(({ snippets: _snippets, ...source }) => source);
  return { claims, sources, stats };
}
