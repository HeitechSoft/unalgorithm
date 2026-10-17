import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toStrictJsonSchema } from '@unalgorithm/ai';
import { formatPrice } from '@unalgorithm/core';
import {
  EVALS_PAGE,
  markdownCell,
  PROMPTS_PAGE,
  type RetrievedCoverageSource,
  type RetrievedSource,
} from '@unalgorithm/protocol';
import { describe, expect, it, vi } from 'vitest';
import { FACTCHECK_EVAL_SET } from '../eval/factcheck-set.ts';
import { PERSPECTIVES_EVAL_SET } from '../eval/perspectives-set.ts';
import { evalsMarkdown, main, promptsMarkdown } from '../eval/publish.ts';
import { EVAL_RESULTS_FILE, type EvalRecord, parseEvalResults } from '../eval/results.ts';
import { BLOCKLIST, type BlockedDomain } from '../src/blocklist.ts';
import { FACTCHECK_RETRIEVAL } from '../src/factcheck.ts';
import {
  BUCKET_SEARCH_SYSTEM,
  buildBucketSearchUser,
  buildComparisonUser,
  buildStoryUser,
  COMPARISON_SYSTEM,
  ComparisonSchema,
  PERSPECTIVES_PROMPT_VERSION,
  STORY_SYSTEM,
  StoryQuerySchema,
} from '../src/perspectives-prompts.ts';
import {
  buildClaimsUser,
  buildResearchUser,
  buildVerdictUser,
  CLAIMS_SYSTEM,
  ClaimsSchema,
  FACTCHECK_PROMPT_VERSION,
  RESEARCH_SYSTEM,
  VERDICT_SYSTEM,
  VerdictsSchema,
} from '../src/prompts.ts';

/** The published prompts and evaluations pages (P3-65, F29): generated from the code, with a drift test per file. */
const REPO_ROOT = new URL('../../../', import.meta.url);
/** The committed file with Windows line endings made `\n`; '' when it is missing, so the drift message still shows. */
const committed = (path: string): string => {
  const url = new URL(path, REPO_ROOT);
  return existsSync(url) ? readFileSync(url, 'utf8').replace(/\r\n/g, '\n') : '';
};

/** The examples the prompts page builds its requests from (decision D80), restated here so the test checks them. */
const fc02 = FACTCHECK_EVAL_SET.find((item) => item.id === 'fc-02');
const pv01 = PERSPECTIVES_EVAL_SET.find((item) => item.id === 'pv-01');
if (!fc02 || !pv01) throw new Error('The example eval items fc-02 and pv-01 must exist.');
const CLAIMS = [{ id: 'c1', text: 'Mount Everest stands about 8,849 metres above sea level.' }];
const SOURCE: RetrievedSource = {
  id: 's1',
  url: 'https://encyclopedia.example/everest',
  domain: 'encyclopedia.example',
  title: 'Mount Everest',
  pageAge: null,
  snippets: ['Mount Everest is 8,849 metres (29,032 ft) above sea level.'],
};
const QUERY = 'Council vote on the river bridge plan';
const COVERAGE: RetrievedCoverageSource = {
  id: 's1',
  url: 'https://left-a.example/2026/10/14/council-bridge-vote',
  domain: 'left-a.example',
  title: 'Council votes on the river bridge plan',
  pageAge: '2026-10-14',
  snippets: ['The council voted 7 to 2 to fund the bridge.'],
  outletId: 'fx-left-a',
  outlet: 'Fixture Left A',
  bucket: 'left',
};

/** The committed live results, as `pnpm docs:site` reads them. */
const committedResults = (): EvalRecord[] => parseEvalResults(readFileSync(EVAL_RESULTS_FILE, 'utf8'));

/** Made-up records for the live runs section: never written to results.json. */
const OLDER_RUN: EvalRecord = {
  task: 'factcheck',
  mode: 'openai',
  ranOn: '2026-11-02',
  promptVersion: 2,
  serverVersion: '0.3.1',
  items: 56,
  gates: {
    slantFlip: { value: 0.98, min: 0.95, passed: true },
    provenance: { value: 1, min: 1, passed: true },
    liveLinks: { value: 0.91, min: 0.97, passed: false },
  },
  passed: false,
  agreement: 0.875,
  meanCostMicros: 90_000,
};
const NEWER_RUN: EvalRecord = {
  task: 'factcheck',
  mode: 'compat',
  searchProvider: 'tavily',
  ranOn: '2026-11-20',
  promptVersion: 2,
  serverVersion: '0.3.2',
  items: 56,
  gates: {
    slantFlip: { value: 1, min: 0.95, passed: true },
    provenance: { value: 1, min: 1, passed: true },
    liveLinks: { value: null, min: 0.97, passed: null },
  },
  passed: false,
  agreement: 1,
  meanCostMicros: null,
};
const PERSPECTIVES_RUN: EvalRecord = {
  task: 'perspectives',
  mode: 'anthropic',
  ranOn: '2026-12-01',
  promptVersion: 1,
  registryVersion: '1.0.0',
  serverVersion: '0.4.0',
  items: 10,
  gates: {
    provenance: { value: 1, min: 1, passed: true },
    leanIntegrity: { value: 1, min: 1, passed: true },
    liveLinks: { value: 0.99, min: 0.97, passed: true },
  },
  passed: true,
  agreement: 0.9,
  meanCostMicros: 41_000,
};

/** Each Markdown table's rows (header first), as written: consecutive lines that start with `|`. */
function tables(markdown: string): string[][] {
  const found: string[][] = [];
  let current: string[] = [];
  for (const line of markdown.split('\n')) {
    if (line.startsWith('|')) current.push(line);
    else if (current.length > 0) {
      found.push(current);
      current = [];
    }
  }
  if (current.length > 0) found.push(current);
  return found;
}

/** The cells of a `| a | b |` row, split as GFM does: on every `|` not escaped by a backslash. */
function cells(row: string): string[] {
  const out: string[] = [];
  let cell = '';
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '\\') {
      cell += c + (row[i + 1] ?? '');
      i++;
    } else if (c === '|') {
      out.push(cell.trim());
      cell = '';
    } else cell += c;
  }
  out.push(cell.trim());
  return out.slice(1, -1);
}

/** The page's lines from the heading `start` up to the next heading of its level or higher outside a code fence. */
function section(markdown: string, start: string): string {
  const lines = markdown.split('\n');
  const from = lines.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const level = start.indexOf(' ');
  let fenced = false;
  let end = lines.length;
  for (let i = from + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^`{3,}/.test(line)) fenced = !fenced;
    const hashes = /^(#+) /.exec(line)?.[1]?.length;
    if (!fenced && hashes !== undefined && hashes <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(from, end).join('\n');
}

/** The rows of `markdown`'s tables whose first cell is `id`. */
const rowsFor = (markdown: string, id: string): string[] =>
  tables(markdown)
    .flat()
    .filter((row) => cells(row)[0] === id);

describe('drift', () => {
  it('test_published_prompts_match_the_code', () => {
    expect(committed(PROMPTS_PAGE.source), `${PROMPTS_PAGE.source} is out of date: run pnpm docs:site`).toBe(promptsMarkdown());
  });

  it('test_published_evals_match_the_code', () => {
    expect(committed(EVALS_PAGE.source), `${EVALS_PAGE.source} is out of date: run pnpm docs:site`).toBe(
      evalsMarkdown(committedResults()),
    );
  });
});

describe('content', () => {
  it('test_prompts_page_holds_every_system_prompt_and_schema', () => {
    const page = promptsMarkdown();
    expect(page.split('\n')[0]).toBe('# Published prompts');
    for (const prompt of [
      CLAIMS_SYSTEM,
      RESEARCH_SYSTEM,
      VERDICT_SYSTEM,
      STORY_SYSTEM,
      BUCKET_SEARCH_SYSTEM,
      COMPARISON_SYSTEM,
    ]) {
      expect(page).toContain(`\`\`\`text\n${prompt}\n\`\`\``);
    }
    const window = { from: new Date('2026-10-11T00:00:00Z'), to: new Date('2026-10-17T00:00:00Z') };
    const requests = [
      buildClaimsUser({ ...fc02.post, ref: 'p1' }, 'NONCE'),
      buildResearchUser(CLAIMS, 'NONCE', FACTCHECK_RETRIEVAL.searches(1)),
      buildVerdictUser(CLAIMS, [SOURCE], 'c1: s1 gives 8,849 metres.', 'NONCE'),
      buildStoryUser(pv01.link, 'NONCE'),
      buildBucketSearchUser(QUERY, window.from, window.to, 'NONCE'),
      buildComparisonUser({ ...pv01.link, query: QUERY }, [COVERAGE], 'NONCE'),
    ];
    for (const request of requests) expect(page).toContain(`\`\`\`text\n${request}\n\`\`\``);
    expect(requests[4]).toContain('from 2026-10-11 to 2026-10-17');
    // The example post and source reach the page only through the builders, fenced with the placeholder nonce.
    expect(page).toContain('<post_NONCE platform="linkedin">');
    expect(page).toContain('outlet="Fixture Left A" domain="left-a.example"');
    expect(page).not.toMatch(/bucket="|"left"/);
    for (const schema of [ClaimsSchema, VerdictsSchema, StoryQuerySchema, ComparisonSchema]) {
      expect(page).toContain(`\`\`\`json\n${JSON.stringify(toStrictJsonSchema(schema), null, 2)}\n\`\`\``);
    }
    expect(page.match(/^#### Answer format$/gm)).toHaveLength(4);
  });

  it('test_prompts_page_versions_and_models', () => {
    const page = promptsMarkdown();
    expect([FACTCHECK_PROMPT_VERSION, PERSPECTIVES_PROMPT_VERSION]).toEqual([2, 1]);
    const factcheck = section(page, '## Fact-check');
    const perspectives = section(page, '## UnEcho Chamber');
    expect(factcheck).toContain('Prompt version 2');
    expect(perspectives).toContain('Prompt version 1');
    expect(factcheck).not.toContain('Prompt version 1');
    expect(factcheck).toContain('| Step | Anthropic | OpenAI |');
    for (const row of [
      '| Step 1: pick the claims | Claude Haiku 5.5 | gpt-5-mini |',
      '| Step 2: research | Claude Sonnet 5.5 | gpt-5 |',
      '| Step 3: verdicts | Claude Sonnet 5.5 | gpt-5 |',
    ]) {
      expect(factcheck).toContain(row);
    }
    for (const row of [
      '| Step 1: the search query | Claude Haiku 5.5 | gpt-5-mini |',
      '| Step 2: one search per lean bucket | Claude Haiku 5.5 | gpt-5-mini |',
      '| Step 3: the comparison | Claude Sonnet 5.5 | gpt-5 |',
    ]) {
      expect(perspectives).toContain(row);
    }
    // The limits come from the constants.
    expect(factcheck).toContain('at most 3 claims');
    expect(factcheck).toContain('25 words');
    expect(perspectives).toContain('± 3 days');
    expect(page).toContain('Fact-check and UnEcho Chamber');
  });

  it('test_prompts_page_blocklist_empty_and_listed', () => {
    expect(BLOCKLIST).toHaveLength(0);
    const empty = section(promptsMarkdown(), '### Sites never cited');
    expect(empty).toContain('Status: draft.');
    expect(empty).toContain('None yet. The list is reviewed by people before anything is added.');
    expect(tables(empty)).toHaveLength(0);

    const blocklist: BlockedDomain[] = [
      { domain: 'satire.example', category: 'satire', evidence: 'https://satire.example/about', addedOn: '2026-10-01' },
    ];
    const listed = section(promptsMarkdown({ blocklist }), '### Sites never cited');
    expect(listed).not.toContain('None yet.');
    expect(tables(listed)).toEqual([
      [
        '| Domain | Kind | Evidence | Added |',
        '| --- | --- | --- | --- |',
        '| satire.example | Satire | [https://satire.example/about](https://satire.example/about) | 2026-10-01 |',
      ],
    ]);
  });

  it('test_evals_page_counts_items_and_gates', () => {
    const page = evalsMarkdown();
    expect(page.split('\n')[0]).toBe('# Evaluations and trust gates');
    expect(FACTCHECK_EVAL_SET).toHaveLength(56);
    expect(PERSPECTIVES_EVAL_SET).toHaveLength(10);
    const factcheck = section(page, '## Fact-check evaluation set');
    const perspectives = section(page, '## UnEcho Chamber evaluation set');
    expect(factcheck).toContain(`${FACTCHECK_EVAL_SET.length} posts`);
    expect(factcheck).toContain(`${FACTCHECK_EVAL_SET.filter((item) => item.pair).length / 2} slant-flipped pairs`);
    expect(factcheck).toContain('20 slant-flipped pairs');
    expect(perspectives).toContain(`${PERSPECTIVES_EVAL_SET.length} shared links`);
    expect(perspectives).toContain('`.example`');
    // The page says every outlet is fictional: keep it true.
    for (const item of PERSPECTIVES_EVAL_SET) expect(new URL(item.link.url).hostname, item.id).toMatch(/\.example$/);
    for (const item of FACTCHECK_EVAL_SET) expect(rowsFor(factcheck, item.id), item.id).toHaveLength(1);
    for (const item of PERSPECTIVES_EVAL_SET) expect(rowsFor(perspectives, item.id), item.id).toHaveLength(1);
    expect(rowsFor(factcheck, 'fc-15')[0]).toContain('| fc-16 |');
    expect(rowsFor(perspectives, 'pv-01')[0]).toContain('`left`, `lean-left`, `center`, `lean-right`, `right`');

    const gates = section(page, '## Trust gates');
    expect(gates).toContain('| Feature | Gate | Must reach | Measured only with |');
    for (const row of [
      '| Fact-check | Same verdict on slant-flipped twins | 95 % | at least 20 pairs |',
      '| Fact-check | Citations traced to a source found in that run | 100 % | at least 20 citations |',
      '| Fact-check | Cited links still live | 97 % | at least 20 answered links |',
      '| UnEcho Chamber | Citations traced to a source found in that run | 100 % | at least 10 citations |',
      '| UnEcho Chamber | Leans from the registry | 100 % | at least 10 sources |',
      '| UnEcho Chamber | Cited links still live | 97 % | at least 10 answered links |',
    ]) {
      expect(gates).toContain(row);
    }
    // The sets are linked from docs/site/, relative to the file.
    expect(page).toContain('(../../packages/research/eval/factcheck-set.ts)');
    expect(page).toContain('(../../packages/research/eval/perspectives-set.ts)');
  });

  it('test_markdown_cell_escapes_table_breakers', () => {
    expect(markdownCell('a|b\nc <x> *y*')).toBe('a\\|b c \\<x\\> \\*y\\*');
    expect(markdownCell('\\ _ ` [ ] \r\n')).toBe('\\\\ \\_ \\` \\[ \\]  ');
    const pipes: BlockedDomain[] = [
      { domain: 'a|b.example', category: 'content-farm', evidence: 'https://a.example/x|y (z)', addedOn: '2026-10-01' },
    ];
    for (const page of [
      promptsMarkdown(),
      promptsMarkdown({ blocklist: pipes }),
      evalsMarkdown(),
      evalsMarkdown([OLDER_RUN, NEWER_RUN, PERSPECTIVES_RUN]),
    ]) {
      for (const [header, delimiter, ...rows] of tables(page)) {
        expect(header && delimiter).toBeTruthy();
        const width = cells(header ?? '').length;
        expect(cells(delimiter ?? '')).toHaveLength(width);
        for (const row of rows) expect(cells(row).length, row).toBeLessThanOrEqual(width);
      }
    }
  });

  it('test_published_pages_deterministic', () => {
    const prompts = promptsMarkdown();
    const evals = evalsMarkdown();
    expect(promptsMarkdown()).toBe(prompts);
    expect(evalsMarkdown()).toBe(evals);
    vi.useFakeTimers();
    try {
      for (const now of ['2020-01-01T00:00:00Z', '2031-07-15T12:34:56Z']) {
        vi.setSystemTime(new Date(now));
        expect(promptsMarkdown(), now).toBe(prompts);
        expect(evalsMarkdown(), now).toBe(evals);
      }
    } finally {
      vi.useRealTimers();
    }
    for (const page of [prompts, evals]) {
      expect(page.endsWith('\n')).toBe(true);
      expect(page.endsWith('\n\n')).toBe(false);
      expect(page).not.toContain('\r');
    }
  });
});

describe('results', () => {
  it('test_parse_eval_results_rejects_bad_records', () => {
    expect(parseEvalResults('[]')).toEqual([]);
    expect(parseEvalResults(` [${JSON.stringify(OLDER_RUN)}]\r\n`)).toEqual([OLDER_RUN]);
    expect(() => parseEvalResults('[{"task":"factcheck"}]')).toThrow(/\[0\]\.mode/);
    expect(() => parseEvalResults('not json')).toThrow(/not JSON/);
    expect(() => parseEvalResults('{}')).toThrow(Error);
    // Content-free by schema: no field beyond decision D81's, and every value inside its range.
    const bad: [string, unknown][] = [
      ['failures', { ...OLDER_RUN, failures: [{ id: 'fc-01', reason: 'dead link s1' }] }],
      ['url', { ...OLDER_RUN, url: 'https://ai.example/v1' }],
      ['ranOn', { ...OLDER_RUN, ranOn: '2026-11-02T10:00:00Z' }],
      ['agreement', { ...OLDER_RUN, agreement: 1.5 }],
      ['gates.fluency', { ...OLDER_RUN, gates: { fluency: { value: 1, min: 1, passed: true } } }],
      ['gates.provenance.note', { ...OLDER_RUN, gates: { provenance: { value: 1, min: 1, passed: true, note: 'x' } } }],
      ['mode', { ...OLDER_RUN, mode: 'gemini' }],
      ['meanCostMicros', { ...OLDER_RUN, meanCostMicros: 1.5 }],
    ];
    for (const [what, record] of bad) {
      expect(() => parseEvalResults(JSON.stringify([OLDER_RUN, record])), what).toThrow(/\[1\]/);
    }
  });

  it('test_evals_page_live_runs_section', () => {
    const empty = evalsMarkdown([]);
    expect(evalsMarkdown()).toBe(empty);
    const none = section(empty, '## Live runs');
    expect(none).toContain('No live run has been published yet.');
    expect(none).toContain('every run is published here, passed or failed');
    expect(tables(none)).toHaveLength(0);
    // After the gates, before the sets.
    expect(empty.indexOf('## Trust gates')).toBeLessThan(empty.indexOf('## Live runs'));
    expect(empty.indexOf('## Live runs')).toBeLessThan(empty.indexOf('## Fact-check evaluation set'));

    const page = evalsMarkdown([OLDER_RUN, NEWER_RUN]);
    const live = section(page, '## Live runs');
    expect(live).not.toContain('No live run has been published yet.');
    expect(tables(live)).toEqual([
      [
        '| Date | AI | Prompt version | Items | Same verdict on twins | Citations traced | Cited links live | Agreement | Mean cost |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        '| 2026-11-20 | Your own AI server with Tavily | 2 | 56 | 1.00 PASSED | 1.00 PASSED | not measured | 100 % | not priced |',
        `| 2026-11-02 | OpenAI | 2 | 56 | 0.98 PASSED | 1.00 PASSED | 0.91 FAILED | 88 % | ${formatPrice(90_000)} |`,
      ],
    ]);
    expect(formatPrice(90_000)).toBe('$0.09');
    expect(section(page, '### Fact-check')).toContain('| 2026-11-20 |');
    expect(section(page, '### UnEcho Chamber')).toContain('No live run of UnEcho Chamber has been published yet.');
    // Newest first whatever the file's order; on the same day the later entry comes first.
    expect(evalsMarkdown([NEWER_RUN, OLDER_RUN])).toBe(page);
    const sameDay = { ...OLDER_RUN, mode: 'anthropic' as const };
    const rows = tables(section(evalsMarkdown([OLDER_RUN, sameDay]), '## Live runs'))[0] ?? [];
    expect(rows.slice(2).map((row) => cells(row)[1])).toEqual(['Anthropic', 'OpenAI']);

    const both = section(evalsMarkdown([PERSPECTIVES_RUN, OLDER_RUN]), '## Live runs');
    const [factcheck, perspectives] = tables(both);
    expect(factcheck).toHaveLength(3);
    expect(perspectives).toEqual([
      '| Date | AI | Prompt version | Items | Citations traced | Leans from the registry | Cited links live | Agreement | Mean cost |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      `| 2026-12-01 | Anthropic | 1 | 10 | 1.00 PASSED | 1.00 PASSED | 0.99 PASSED | 90 % | ${formatPrice(41_000)} |`,
    ]);
    expect(both.indexOf('### Fact-check')).toBeLessThan(both.indexOf('### UnEcho Chamber'));
  });
});

describe('cli', () => {
  it('test_publish_main_writes_both_pages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unalgorithm-docs-site-'));
    try {
      const lines: string[] = [];
      expect(main({ out: (line) => lines.push(line), root: pathToFileURL(dir) })).toBe(0);
      expect(lines).toEqual([`Wrote ${PROMPTS_PAGE.source}`, `Wrote ${EVALS_PAGE.source}`]);
      const prompts = await readFile(join(dir, 'docs', 'site', 'prompts.md'), 'utf8');
      const evals = await readFile(join(dir, 'docs', 'site', 'evals.md'), 'utf8');
      expect(prompts.split('\n')[0]).toBe('# Published prompts');
      expect(evals.split('\n')[0]).toBe('# Evaluations and trust gates');
      expect(prompts).toBe(promptsMarkdown());
      expect(evals).toBe(evalsMarkdown(committedResults()));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
