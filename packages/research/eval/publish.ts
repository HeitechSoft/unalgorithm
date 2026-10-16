/**
 * `pnpm docs:site`: writes the published prompts and evaluations pages (F29, decision D80) from the code, so they never
 * drift from what runs. Every prompt, example request, answer schema, model, limit, eval item and gate is printed from
 * the code that defines it; nothing is copied by hand. `test/published.test.ts` fails whenever a committed page differs
 * from what this generates. Both pages are pure and deterministic: nothing reads the clock, the environment or the
 * network.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { modelLabel, toStrictJsonSchema } from '@unalgorithm/ai';
import { FIXTURE_REGISTRY } from '@unalgorithm/outlets/testing';
import {
  EVALS_PAGE,
  FACTCHECK_VERDICTS,
  FEATURE_NAMES,
  MAX_FACTCHECK_CLAIMS,
  MAX_FACTCHECK_SEARCHES,
  MAX_QUOTE_WORDS,
  MIN_INDEPENDENT_DOMAINS,
  markdownCell,
  PERSPECTIVES_WINDOW_DAYS,
  PROMPTS_PAGE,
  type RetrievedCoverageSource,
  type RetrievedSource,
} from '@unalgorithm/protocol';
import type { z } from 'zod';
import { BLOCKLIST, BLOCKLIST_STATUS, type BlockedDomain } from '../src/blocklist.ts';
import { FACTCHECK_MODELS, FACTCHECK_RETRIEVAL } from '../src/factcheck.ts';
import { OPENAI_FACTCHECK_MODELS, OPENAI_PERSPECTIVES_MODELS } from '../src/modes.ts';
import { PERSPECTIVES_MODELS, storyWindow } from '../src/perspectives.ts';
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
import { FACTCHECK_EVAL_SET } from './factcheck-set.ts';
import { PERSPECTIVES_TRUST_GATES } from './perspectives-score.ts';
import { PERSPECTIVES_EVAL_SET } from './perspectives-set.ts';
import { TRUST_GATES } from './score.ts';

/** The nonce every example request shows, the placeholder the system prompts name. */
const NONCE = 'NONCE';
const FACTCHECK = FEATURE_NAMES.factcheck;
const PERSPECTIVES = FEATURE_NAMES.perspectives;

/** The page: its blocks one blank line apart, ending with one `\n`. */
const page = (blocks: readonly string[]): string => `${blocks.join('\n\n')}\n`;

/** A fenced block its content can never close: the fence is longer than any run of backticks inside. */
function fence(lang: string, body: string): string {
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((run) => run[0].length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${body}\n${ticks}`;
}

/** A Markdown table of cells already made safe (`markdownCell`, or fixed text). */
function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

/** A link destination that can neither end the link nor split a table row. */
const linkTarget = (url: string): string =>
  url.replace(/[\s()<>|\\`]/g, (c) => (c === '(' ? '%28' : c === ')' ? '%29' : encodeURIComponent(c)));

const code = (id: string): string => `\`${id}\``;
const percent = (ratio: number): string => `${Math.round(ratio * 100)} %`;

interface Step<Model extends string> {
  title: string;
  model: Model;
  system: string;
  request: string;
  /** The structured answer the step asks for; a search step has none and says what it keeps instead. */
  answer: z.ZodType | string;
}

/** The models table: a row per step, by AI provider. */
function modelsTable<Model extends string>(
  steps: readonly Step<Model>[],
  anthropic: Readonly<Record<Model, string>>,
  openai: Readonly<Record<Model, string>>,
): string {
  return table(
    ['Step', 'Anthropic', 'OpenAI'],
    steps.map((s) => [
      markdownCell(s.title),
      markdownCell(modelLabel(anthropic[s.model])),
      markdownCell(modelLabel(openai[s.model])),
    ]),
  );
}

function stepBlocks(step: Step<string>): string[] {
  return [
    `### ${step.title}`,
    '#### System prompt',
    fence('text', step.system),
    '#### Example request',
    fence('text', step.request),
    ...(typeof step.answer === 'string'
      ? [step.answer]
      : ['#### Answer format', fence('json', JSON.stringify(toStrictJsonSchema(step.answer), null, 2))]),
  ];
}

function evalItem<T extends { id: string }>(set: readonly T[], id: string): T {
  const item = set.find((i) => i.id === id);
  if (!item) throw new Error(`The example eval item ${id} is missing.`);
  return item;
}

function factcheckSteps(): Step<keyof typeof FACTCHECK_MODELS>[] {
  const post = { ...evalItem(FACTCHECK_EVAL_SET, 'fc-02').post, ref: 'p1' };
  const claims = [{ id: 'c1', text: 'Mount Everest stands about 8,849 metres above sea level.' }];
  const source: RetrievedSource = {
    id: 's1',
    url: 'https://encyclopedia.example/everest',
    domain: 'encyclopedia.example',
    title: 'Mount Everest',
    pageAge: null,
    snippets: ['Mount Everest is 8,849 metres (29,032 ft) above sea level.'],
  };
  return [
    {
      title: 'Step 1: pick the claims',
      model: 'claims',
      system: CLAIMS_SYSTEM,
      request: buildClaimsUser(post, NONCE),
      answer: ClaimsSchema,
    },
    {
      title: 'Step 2: research',
      model: 'research',
      system: RESEARCH_SYSTEM,
      request: buildResearchUser(claims, NONCE, FACTCHECK_RETRIEVAL.searches(claims.length)),
      answer:
        "This step has no answer format: it keeps the model's notes and the search results it cited, with the passages it quoted from them.",
    },
    {
      title: 'Step 3: verdicts',
      model: 'verdict',
      system: VERDICT_SYSTEM,
      request: buildVerdictUser(claims, [source], 'c1: s1 gives 8,849 metres.', NONCE),
      answer: VerdictsSchema,
    },
  ];
}

function perspectivesSteps(): Step<keyof typeof PERSPECTIVES_MODELS>[] {
  const { link } = evalItem(PERSPECTIVES_EVAL_SET, 'pv-01');
  const query = 'Council vote on the river bridge plan';
  // The window a run on this link computes the day after the link's date (2026-10-14 ± the window).
  const { from, to } = storyWindow(link.url, new Date('2026-10-17T00:00:00Z'));
  const host = new URL(link.url).hostname;
  const outlet = FIXTURE_REGISTRY.outlets.find((o) => o.domains.includes(host));
  if (!outlet?.lean) throw new Error(`The fixture registry has no labelled outlet for ${host}.`);
  const source: RetrievedCoverageSource = {
    id: 's1',
    url: link.url,
    domain: host,
    title: 'Council votes on the river bridge plan',
    pageAge: '2026-10-14',
    snippets: ['The council voted 7 to 2 to fund the bridge.'],
    outletId: outlet.id,
    outlet: outlet.name,
    bucket: outlet.lean.bucket,
  };
  return [
    {
      title: 'Step 1: the search query',
      model: 'query',
      system: STORY_SYSTEM,
      request: buildStoryUser(link, NONCE),
      answer: StoryQuerySchema,
    },
    {
      title: 'Step 2: one search per lean bucket',
      model: 'search',
      system: BUCKET_SEARCH_SYSTEM,
      request: buildBucketSearchUser(query, from, to, NONCE),
      answer:
        'This step has no answer format: it keeps only the search results the model cited and the passages it quoted; anything else the model writes is dropped.',
    },
    {
      title: 'Step 3: the comparison',
      model: 'compare',
      system: COMPARISON_SYSTEM,
      request: buildComparisonUser({ ...link, query }, [source], NONCE),
      answer: ComparisonSchema,
    },
  ];
}

const BLOCK_KINDS: Readonly<Record<BlockedDomain['category'], string>> = { satire: 'Satire', 'content-farm': 'Content farm' };

function blocklistBlocks(blocklist: readonly BlockedDomain[]): string[] {
  const { status, reviewedBy, reviewedOn } = BLOCKLIST_STATUS;
  const reviewed = reviewedBy && reviewedOn ? `, reviewed by ${markdownCell(reviewedBy)} on ${reviewedOn}` : '';
  return [
    '### Sites never cited',
    `A fact-check never cites these sites: satire sites, whose own about or disclaimer page says they publish satire, and content farms. Each entry links the page that shows why. Status: ${status}${reviewed}.`,
    blocklist.length === 0
      ? 'None yet. The list is reviewed by people before anything is added.'
      : table(
          ['Domain', 'Kind', 'Evidence', 'Added'],
          blocklist.map((entry) => [
            markdownCell(entry.domain),
            BLOCK_KINDS[entry.category],
            `[${markdownCell(entry.evidence)}](${linkTarget(entry.evidence)})`,
            markdownCell(entry.addedOn),
          ]),
        ),
  ];
}

/**
 * The published prompts page (PROMPTS_PAGE.source): pure and deterministic, so a test can compare it with the file.
 * `blocklist` exists for the test of a non-empty list; the page uses the default.
 */
export function promptsMarkdown(opts: { blocklist?: readonly BlockedDomain[] } = {}): string {
  const factcheck = factcheckSteps();
  const perspectives = perspectivesSteps();
  return page([
    `# ${PROMPTS_PAGE.title}`,
    `These are the exact instructions UnAlgorithm Feed gives AI models for ${FACTCHECK} and ${PERSPECTIVES}. This page is generated from the code in \`packages/research\` by \`pnpm docs:site\`, and a test fails whenever the page and the code differ.`,
    `Whatever a stranger wrote that is sent to a model (a post, a shared link, the passages a search found) goes inside tags carrying a code that changes with every request, written \`${NONCE}\` below. It is escaped so it can never close or forge those tags, and every prompt tells the model that what is inside them is data, never instructions. The search steps read web pages through the AI provider's own search tool, and their prompts say those pages are untrusted too.`,

    `## ${FACTCHECK}`,
    `Prompt version ${FACTCHECK_PROMPT_VERSION}.`,
    modelsTable(factcheck, FACTCHECK_MODELS, OPENAI_FACTCHECK_MODELS),
    "On your own AI server, every step uses that server's model, and step 2 has no AI call: each claim is sent as a search query with your Brave or Tavily key, and the verdict step reads the results. An UnAlgorithm server uses the routes its operator has eval-gated, and with a search provider its step 2 works the same way.",
    `Limits: at most ${MAX_FACTCHECK_CLAIMS} claims per post; a search budget of ${FACTCHECK_RETRIEVAL.searches(1)} searches for one claim, never more than ${MAX_FACTCHECK_SEARCHES}; quotes of at most ${MAX_QUOTE_WORDS} words; citations from at least ${MIN_INDEPENDENT_DOMAINS} independent sites, or the verdict becomes \`unverifiable\`.`,
    'The example requests are built by the same code as real ones, from the evaluation post `fc-02`, with one claim and one made-up source.',
    ...factcheck.flatMap(stepBlocks),
    ...blocklistBlocks(opts.blocklist ?? BLOCKLIST),

    `## ${PERSPECTIVES}`,
    `Prompt version ${PERSPECTIVES_PROMPT_VERSION}.`,
    modelsTable(perspectives, PERSPECTIVES_MODELS, OPENAI_PERSPECTIVES_MODELS),
    `No prompt names a side. Code picks the outlet sites each search may use, the dates (± ${PERSPECTIVES_WINDOW_DAYS} days around the link's date) and each source's lean bucket, from the outlet registry; no model is told a bucket or a lean. On your own AI server, every step uses that server's model, and with a search key (or a server's search provider) step 2 has no AI call: the story query is sent as one search per lean bucket.`,
    'The example requests are built by the same code as real ones, from the evaluation link `pv-01`, with one made-up source from a fictional outlet.',
    ...perspectives.flatMap(stepBlocks),
  ]);
}

const twin = (pair: string | undefined): string => (pair ? markdownCell(pair) : '—');
const yesNo = (flag: boolean | undefined): string => (flag ? 'Yes' : 'No');
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function gatesBlocks(): string[] {
  const fc = TRUST_GATES;
  const pv = PERSPECTIVES_TRUST_GATES;
  const traced = 'Citations traced to a source found in that run';
  const live = 'Cited links still live';
  return [
    '## Trust gates',
    'A run passes only when every gate of its feature passes, and a gate passes only when the run measured enough (the last column). Slant-flipped twins are two posts that state the same fact, one approvingly and one disapprovingly. A link is answered when the check found it live or dead.',
    table(
      ['Feature', 'Gate', 'Must reach', 'Measured only with'],
      [
        [FACTCHECK, 'Same verdict on slant-flipped twins', percent(fc.slantFlip), `at least ${fc.minPairs} pairs`],
        [FACTCHECK, traced, percent(fc.provenance), `at least ${fc.minCited} citations`],
        [FACTCHECK, live, percent(fc.liveLinks), `at least ${fc.minCited} answered links`],
        [PERSPECTIVES, traced, percent(pv.provenance), `at least ${pv.minCited} citations`],
        [PERSPECTIVES, 'Leans from the registry', percent(pv.leanIntegrity), `at least ${pv.minCited} sources`],
        [PERSPECTIVES, live, percent(pv.liveLinks), `at least ${pv.minCited} answered links`],
      ],
    ),
  ];
}

function factcheckSetBlocks(): string[] {
  const set = FACTCHECK_EVAL_SET;
  const pairs = set.filter((i) => i.pair).length / 2;
  const injected = set.filter((i) => i.injected).length;
  const smoke = set.filter((i) => i.smoke).length;
  return [
    `## ${FACTCHECK} evaluation set`,
    `${plural(set.length, 'post', 'posts')}, all written for testing: ${plural(pairs, 'slant-flipped pair', 'slant-flipped pairs')} (${pairs * 2} posts) that must get the same verdict, ${plural(injected, 'post that carries', 'posts that carry')} an instruction aimed at the AI, which the verdict must ignore, and ${plural(smoke, 'smoke item', 'smoke items')} that a short live run checks. A post's accepted verdicts are every verdict a careful checker could defend for its main claim, best first.`,
    table(
      ['Verdict expected first', 'Posts'],
      FACTCHECK_VERDICTS.map((verdict) => [code(verdict), String(set.filter((i) => i.expect[0] === verdict).length)]),
    ),
    '### The posts',
    table(
      ['Id', 'Post', 'Accepted verdicts', 'Twin', 'Instruction inside'],
      set.map((i) => [
        markdownCell(i.id),
        markdownCell(i.post.text),
        i.expect.map(code).join(', '),
        twin(i.pair),
        yesNo(i.injected),
      ]),
    ),
  ];
}

function perspectivesSetBlocks(): string[] {
  const set = PERSPECTIVES_EVAL_SET;
  const pairs = set.filter((i) => i.pair).length / 2;
  const injected = set.filter((i) => i.injected).length;
  const smoke = set.filter((i) => i.smoke).length;
  return [
    `## ${PERSPECTIVES} evaluation set`,
    `${plural(set.length, 'shared link', 'shared links')}, all written for testing: ${plural(pairs, 'mirror pair', 'mirror pairs')} (the same story shared from outlets in opposite lean buckets) that must find the same coverage, ${plural(injected, 'link whose title carries', 'links whose titles carry')} an instruction aimed at the AI, and ${plural(smoke, 'smoke item', 'smoke items')} that a short live run checks. Every outlet is fictional: each site ends in \`.example\`, a name reserved for examples that no real outlet can have. Expected coverage lists the lean buckets a run must find coverage in; every other bucket must show as a gap.`,
    '### The links',
    table(
      ['Id', 'Link title', 'Link', 'Expected coverage', 'Twin', 'Instruction inside'],
      set.map((i) => [
        markdownCell(i.id),
        markdownCell(i.link.title ?? '(no title)'),
        markdownCell(i.link.url),
        i.expectCovered.map(code).join(', '),
        twin(i.pair),
        yesNo(i.injected),
      ]),
    ),
  ];
}

/** The published evaluations page (EVALS_PAGE.source), from the eval sets and the trust gates. Pure and deterministic. */
export function evalsMarkdown(): string {
  return page([
    `# ${EVALS_PAGE.title}`,
    `This is how UnAlgorithm Feed tests ${FACTCHECK} and ${PERSPECTIVES} before a prompt or a model changes: each runs on a fixed set of test items, and the run must pass the trust gates below. Every item is written for testing, with no real post, person or outlet. This page is generated from the code by \`pnpm docs:site\`, and a test fails whenever the page and the code differ.`,
    `The sets are in [\`factcheck-set.ts\`](../../packages/research/eval/factcheck-set.ts) and [\`perspectives-set.ts\`](../../packages/research/eval/perspectives-set.ts).`,
    ...gatesBlocks(),
    ...factcheckSetBlocks(),
    ...perspectivesSetBlocks(),
  ]);
}

/** Writes both pages under the repository root; prints each path written. Exit 0, or 1 when a write fails. */
export function main(io: { out(line: string): void; root?: URL } = { out: (line: string) => console.log(line) }): number {
  const given = io.root ?? new URL('../../../', import.meta.url);
  const root = given.href.endsWith('/') ? given : new URL(`${given.href}/`);
  for (const [source, markdown] of [
    [PROMPTS_PAGE.source, promptsMarkdown()],
    [EVALS_PAGE.source, evalsMarkdown()],
  ] as const) {
    const file = new URL(source, root);
    try {
      mkdirSync(new URL('./', file), { recursive: true });
      writeFileSync(file, markdown, 'utf8');
    } catch (e) {
      console.error(`Could not write ${source}: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    io.out(`Wrote ${source}`);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
