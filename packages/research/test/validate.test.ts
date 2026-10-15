import {
  FactcheckResultSchema,
  FactcheckSourceSchema,
  type FactcheckVerdict,
  MAX_CITATIONS_PER_CLAIM,
  type RetrievedSource,
} from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import { BLOCKLIST, BLOCKLIST_STATUS, blockedDomains } from '../src/blocklist.ts';
import { quoteMatches, type RawVerdict, registrableDomain, validateVerdicts } from '../src/validate.ts';

function source(id: string, domain: string, snippets: string[]): RetrievedSource {
  return { id, url: `https://${domain}/${id}`, domain, title: `Title ${id}`, pageAge: null, snippets };
}

function publicSource(id: string, domain: string) {
  const { snippets: _snippets, ...rest } = source(id, domain, []);
  return rest;
}

const SOURCES: RetrievedSource[] = [
  source('s1', 'www.example.com', ['The bridge opened in 1932 after four years of work.', 'It cost AT&T nothing.']),
  source('s2', 'news.other.org', ['Officials confirmed the bridge opened in 1932.', 'Traffic “doubled” within a year.']),
  source('s3', 'news.example.com', ['A second page says the bridge opened in 1932 too.']),
  source('s4', 'theonion.example', ['The bridge opened in 1932, sources say.']),
  source('s5', 'www.theonion.example', ['The bridge opened in 1932, sources say.']),
  source('s10', 'third.net', ['Construction started in 1928 and ended in 1932.']),
];
const CLAIMS = [{ id: 'c1', text: 'The bridge opened in 1932.' }];
const BLOCKED = ['theonion.example'];
const TOO_FEW = "Fewer than two independent sources back this up, so it can't be verified here.";

function verdict(citations: RawVerdict['citations'], v: FactcheckVerdict = 'supported', claimId = 'c1'): RawVerdict {
  return { claimId, verdict: v, explanation: 'Two outlets report the same opening year.', citations };
}

function run(verdicts: RawVerdict[], claims = CLAIMS, sources = SOURCES) {
  return validateVerdicts({ claims, sources, verdicts, blocked: BLOCKED });
}

function wrap(out: ReturnType<typeof run>) {
  return {
    v: 1 as const,
    checkedAt: '2026-10-15T12:00:00.000Z',
    model: 'claude-test',
    promptVersion: 1,
    claims: out.claims,
    sources: out.sources,
  };
}

const TWO_DOMAINS = [
  { sourceId: 's1', quote: 'the bridge opened in 1932' },
  { sourceId: 's2', quote: 'confirmed the bridge opened in 1932' },
];

describe('contract', () => {
  it('test_factcheck_result_schema_accepts_validator_output', () => {
    const fixtures: RawVerdict[][] = [
      [verdict(TWO_DOMAINS)],
      [verdict([{ sourceId: 's1', quote: 'four years of work' }])],
      [],
      [verdict([...TWO_DOMAINS, { sourceId: 's9', quote: 'x' }, { sourceId: 's4', quote: 'sources say' }])],
      [
        verdict([
          { sourceId: 's1', quote: 'AT&amp;T nothing' },
          { sourceId: 's10', quote: 'ended in 1932' },
        ]),
      ],
      [
        verdict([
          { sourceId: 's1', quote: 'the bridge opened' },
          { sourceId: 's2', quote: 'the bridge opened' },
          { sourceId: 's3', quote: 'the bridge opened' },
          { sourceId: 's10', quote: 'ended in 1932' },
          { sourceId: 's1', quote: 'four years' },
        ]),
        { ...verdict(TWO_DOMAINS, 'disputed', 'c2'), explanation: 'e'.repeat(500) },
      ],
    ];
    const claims = [
      { id: 'c1', text: 'The bridge opened in 1932.' },
      { id: 'c2', text: 'x'.repeat(400) },
    ];
    for (const verdicts of fixtures) {
      const parsed = FactcheckResultSchema.safeParse(wrap(run(verdicts, claims)));
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });

  it('test_factcheck_source_schema_rejects_non_http_urls', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com/file']) {
      expect(FactcheckSourceSchema.safeParse({ ...publicSource('s1', 'example.com'), url }).success).toBe(false);
    }
    expect(FactcheckSourceSchema.safeParse(publicSource('s1', 'example.com')).success).toBe(true);
  });

  it('test_factcheck_result_schema_rejects_four_claims', () => {
    const claim = { id: 'c1', claim: 'x', verdict: 'unverifiable', explanation: 'x', citations: [] };
    const result = { ...wrap(run([])), claims: [claim, claim, claim, claim] };
    expect(FactcheckResultSchema.safeParse(result).success).toBe(false);
    expect(FactcheckResultSchema.safeParse({ ...result, claims: [claim, claim, claim] }).success).toBe(true);
  });
});

describe('provenance', () => {
  it('test_validate_drops_citation_to_unknown_source', () => {
    const out = run([verdict([{ sourceId: 's9', quote: 'the bridge opened in 1932' }])]);
    expect(out.claims[0]?.citations).toEqual([]);
    expect(out.stats.unknownSource).toBe(1);
  });

  it('test_validate_drops_citation_to_blocked_domain_and_subdomain', () => {
    const out = run([
      verdict([
        { sourceId: 's4', quote: 'sources say' },
        { sourceId: 's5', quote: 'sources say' },
      ]),
    ]);
    expect(out.claims[0]?.citations).toEqual([]);
    expect(out.stats.blockedSource).toBe(2);
    expect(out.sources).toEqual([]);
  });
});

describe('quotes', () => {
  it('test_quote_matches_ignoring_case_whitespace_and_curly_quotes', () => {
    expect(quoteMatches('TRAFFIC   "doubled"\n within', ['Traffic “doubled” within a year.'])).toBe(true);
    expect(quoteMatches("it's here", ['It’s here now'])).toBe(true);
    expect(quoteMatches('traffic halved', ['Traffic “doubled” within a year.'])).toBe(false);
    const out = run([verdict([{ sourceId: 's2', quote: 'Traffic "DOUBLED"  within a year' }])]);
    expect(out.claims[0]?.citations).toEqual([{ sourceId: 's2', quote: 'Traffic "DOUBLED"  within a year' }]);
  });

  it('test_quote_with_escaped_entities_matches_and_is_stored_decoded', () => {
    const out = run([verdict([{ sourceId: 's1', quote: 'It cost AT&amp;T nothing' }])]);
    expect(out.claims[0]?.citations).toEqual([{ sourceId: 's1', quote: 'It cost AT&T nothing' }]);
    expect(out.stats.quoteMismatch).toBe(0);
  });

  it('test_validate_drops_quote_found_only_in_another_source', () => {
    const out = run([verdict([{ sourceId: 's1', quote: 'Officials confirmed the bridge opened' }])]);
    expect(out.claims[0]?.citations).toEqual([]);
    expect(out.stats.quoteMismatch).toBe(1);
  });

  it('test_validate_drops_26_word_over_300_char_and_empty_quotes', () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
    const long = 'a'.repeat(301);
    const snippets = [words(26), long, 'filler'];
    const sources = [source('s1', 'a.com', snippets), source('s2', 'b.com', snippets)];
    const out = run(
      [
        verdict([
          { sourceId: 's1', quote: words(26) },
          { sourceId: 's1', quote: long },
          { sourceId: 's2', quote: '   ' },
          { sourceId: 's2', quote: '' },
        ]),
      ],
      CLAIMS,
      sources,
    );
    expect(out.claims[0]?.citations).toEqual([]);
    expect(out.stats.quoteTooLong).toBe(4);
    expect(run([verdict([{ sourceId: 's1', quote: words(25) }])], CLAIMS, sources).stats.kept).toBe(1);
  });

  it('test_quote_ellipsis_segments_must_match_in_order_in_one_snippet', () => {
    const snippets = ['The bridge opened in 1932 after four years of work.', 'Officials were pleased.'];
    expect(quoteMatches('the bridge opened … four years', snippets)).toBe(true);
    expect(quoteMatches('the bridge opened ... four years', snippets)).toBe(true);
    expect(quoteMatches('…the bridge opened in 1932...', snippets)).toBe(true);
    expect(quoteMatches('four years … the bridge opened', snippets)).toBe(false);
    expect(quoteMatches('the bridge opened … officials were pleased', snippets)).toBe(false);
    expect(quoteMatches('…', snippets)).toBe(false);
  });
});

describe('domains', () => {
  it('test_validate_downgrades_single_domain_support', () => {
    const out = run([
      verdict([
        { sourceId: 's1', quote: 'the bridge opened in 1932' },
        { sourceId: 's3', quote: 'the bridge opened in 1932 too' },
      ]),
    ]);
    const claim = out.claims[0];
    expect(claim?.verdict).toBe('unverifiable');
    expect(claim?.downgraded).toBe('too-few-domains');
    expect(claim?.explanation).toBe(TOO_FEW);
    expect(claim?.citations).toHaveLength(2);
  });

  it('test_registrable_domain_two_level_suffix_and_www', () => {
    expect(registrableDomain('news.bbc.co.uk')).toBe('bbc.co.uk');
    expect(registrableDomain('www.example.com')).toBe('example.com');
    expect(registrableDomain('WWW.News.Example.COM')).toBe('example.com');
    expect(registrableDomain('www.statcan.gc.ca')).toBe('gc.ca');
  });

  it('test_validate_keeps_support_with_two_domains', () => {
    const claim = run([verdict(TWO_DOMAINS)]).claims[0];
    expect(claim?.verdict).toBe('supported');
    expect(claim?.downgraded).toBeUndefined();
    expect(claim).not.toHaveProperty('downgraded');
    expect(claim?.explanation).toBe('Two outlets report the same opening year.');
  });
});

describe('claims and output', () => {
  it('test_validate_missing_verdict_is_unverifiable_no_verdict', () => {
    expect(run([]).claims).toEqual([
      {
        id: 'c1',
        claim: 'The bridge opened in 1932.',
        verdict: 'unverifiable',
        explanation: 'No verdict was returned for this claim.',
        citations: [],
        downgraded: 'no-verdict',
      },
    ]);
  });

  it('test_validate_ignores_unknown_claim_id', () => {
    const out = run([verdict(TWO_DOMAINS, 'disputed', 'c9')]);
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0]?.downgraded).toBe('no-verdict');
    expect(out.stats.raw).toBe(0);
    const first = run([verdict(TWO_DOMAINS, 'disputed'), verdict([], 'supported')]);
    expect(first.claims[0]?.verdict).toBe('disputed');
    expect(first.stats.raw).toBe(2);
  });

  it('test_validate_dedupes_and_caps_citations_lists_only_cited_sources', () => {
    const out = run([
      verdict([
        { sourceId: 's10', quote: 'ended in 1932' },
        { sourceId: 's2', quote: 'the bridge opened in 1932' },
        { sourceId: 's2', quote: 'The  Bridge opened in 1932' },
        { sourceId: 's1', quote: 'the bridge opened in 1932' },
        { sourceId: 's1', quote: 'four years of work' },
        { sourceId: 's3', quote: 'a second page' },
      ]),
    ]);
    const claim = out.claims[0];
    expect(claim?.citations).toHaveLength(MAX_CITATIONS_PER_CLAIM);
    expect(claim?.citations.map((c) => c.sourceId)).toEqual(['s10', 's2', 's1', 's1']);
    expect(out.stats.duplicate).toBe(2);
    expect(out.sources).toEqual([
      publicSource('s1', 'www.example.com'),
      publicSource('s2', 'news.other.org'),
      publicSource('s10', 'third.net'),
    ]);
  });

  it('test_validate_clips_explanation', () => {
    const out = run([{ ...verdict(TWO_DOMAINS), explanation: 'e'.repeat(400) }]);
    expect(out.claims[0]?.explanation).toBe('e'.repeat(280));
    expect(run([], [{ id: 'c1', text: 'c'.repeat(400) }]).claims[0]?.claim).toHaveLength(300);
  });

  it('test_validate_stats_add_up', () => {
    const out = run([
      verdict([
        { sourceId: 's1', quote: 'the bridge opened in 1932' },
        { sourceId: 's1', quote: 'the bridge opened in 1932' },
        { sourceId: 's2', quote: 'confirmed the bridge' },
        { sourceId: 's3', quote: 'a second page' },
        { sourceId: 's10', quote: 'ended in 1932' },
        { sourceId: 's2', quote: 'traffic doubled within' },
        { sourceId: 's9', quote: 'anything' },
        { sourceId: 's4', quote: 'sources say' },
        { sourceId: 's1', quote: 'not in the page' },
        { sourceId: 's1', quote: '' },
      ]),
      verdict([{ sourceId: 's1', quote: 'ignored duplicate verdict' }]),
      verdict([{ sourceId: 's1', quote: 'unknown claim' }], 'supported', 'c9'),
    ]);
    const { raw, kept, unknownSource, blockedSource, quoteTooLong, quoteMismatch, duplicate } = out.stats;
    expect(raw).toBe(10);
    expect({ kept, unknownSource, blockedSource, quoteTooLong, quoteMismatch, duplicate }).toEqual({
      kept: 4,
      unknownSource: 1,
      blockedSource: 1,
      quoteTooLong: 1,
      quoteMismatch: 1,
      duplicate: 2,
    });
    expect(kept + unknownSource + blockedSource + quoteTooLong + quoteMismatch + duplicate).toBe(raw);
  });
});

describe('blocklist', () => {
  it('test_blocklist_entries_are_well_formed_and_draft_rules_hold', () => {
    expect(BLOCKLIST.length).toBeLessThanOrEqual(50);
    const seen = new Set<string>();
    for (const entry of BLOCKLIST) {
      expect(entry.domain).toMatch(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/);
      expect(entry.domain.startsWith('www.')).toBe(false);
      expect(seen.has(entry.domain)).toBe(false);
      seen.add(entry.domain);
      expect(entry.category).toBe('satire');
      expect(new URL(entry.evidence).protocol).toBe('https:');
      expect(entry.addedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(BLOCKLIST.some((e) => e.category === 'content-farm')).toBe(false);
    if (BLOCKLIST_STATUS.status === 'reviewed') {
      expect(BLOCKLIST_STATUS.reviewedBy).not.toBeNull();
      expect(BLOCKLIST_STATUS.reviewedOn).not.toBeNull();
    }
    expect(blockedDomains()).toEqual([...seen].sort());
  });
});
