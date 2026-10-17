import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_SIDE_RATIO, MIN_OUTLETS_PER_BUCKET } from '@unalgorithm/outlets';
import {
  BUCKET_LABELS,
  CLAIM_CACHE_TTL_MS,
  CORRECTIONS_PAGE,
  EVALS_PAGE,
  LEAN_BUCKETS,
  MAX_FACTCHECK_CLAIMS,
  MAX_FACTCHECK_SEARCHES,
  MAX_QUOTE_WORDS,
  MAX_SOURCES_PER_BUCKET,
  METHODOLOGY_PAGE,
  MIN_INDEPENDENT_DOMAINS,
  PERSPECTIVES_WINDOW_DAYS,
  PROMPTS_PAGE,
  SOURCE_LIST_PAGE_URL,
} from '@unalgorithm/protocol';
import { TRUST_GATES } from '@unalgorithm/research/eval';
import { PERSPECTIVES_TRUST_GATES } from '@unalgorithm/research/eval/perspectives';
import { VERDICT_LABELS } from '@unalgorithm/ui';
import { describe, expect, it } from 'vitest';

/**
 * The public methodology (F29, P3-68): `docs/site/methodology.md`, which the website renders at `/methodology`. Every
 * number it states is built here from the constant the code runs on, so a change to a limit, a window, a threshold or a
 * gate fails this test until the page says the new number. The wording itself is a draft for Tom's sign-off (D110).
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string) => readFileSync(join(REPO_ROOT, file), 'utf8').replace(/\r\n/g, '\n');
/** The text with every run of whitespace made one space, so line wrapping never matters. */
const flat = (text: string) => text.replace(/\s+/g, ' ');

const md = read(METHODOLOGY_PAGE.source);
const text = flat(md);

/** One section, from its heading line to the next heading of the same or a higher level. */
function section(heading: string): string {
  const level = /^#+/.exec(heading)?.[0].length ?? 0;
  const start = md.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThan(-1);
  const rest = md.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`^#{1,${level}} `, 'm'));
  return flat(next === -1 ? rest : rest.slice(0, next));
}

const percent = (ratio: number) => `${Math.round(ratio * 100)} %`;

describe('methodology', () => {
  it('test_methodology_headings', () => {
    expect(md.split('\n')[0]).toBe(`# ${METHODOLOGY_PAGE.title}`);
    const headings = md.split('\n').filter((line) => /^#{2,3} /.test(line));
    for (const heading of [
      '## When they run',
      '## Fact-check',
      '## UnEcho Chamber',
      '### Where leans come from',
      "### When a list isn't balanced",
      '## How we test',
      '## Known limits',
      '## Mistakes and appeals',
    ]) {
      expect(headings, heading).toContain(heading);
    }
    // Both lean sections belong to UnEcho Chamber.
    const unecho = headings.indexOf('## UnEcho Chamber');
    expect(headings.indexOf('### Where leans come from')).toBeGreaterThan(unecho);
    expect(headings.indexOf("### When a list isn't balanced")).toBeGreaterThan(unecho);
    expect(headings.indexOf('## How we test')).toBeGreaterThan(headings.indexOf("### When a list isn't balanced"));
  });

  it('test_methodology_numbers_match_the_code', () => {
    for (const phrase of [
      `at most ${MAX_FACTCHECK_CLAIMS} claims`,
      `at most ${MAX_FACTCHECK_SEARCHES}`,
      `${MAX_QUOTE_WORDS} words`,
      `${MIN_INDEPENDENT_DOMAINS} independent`,
      `± ${PERSPECTIVES_WINDOW_DAYS} days`,
      `${CLAIM_CACHE_TTL_MS / 3_600_000} hours`,
      `at most ${MAX_SOURCES_PER_BUCKET} sources`,
      `fewer than ${MIN_OUTLETS_PER_BUCKET} outlets`,
      `more than ${MAX_SIDE_RATIO} times`,
    ]) {
      expect(text, phrase).toContain(phrase);
    }
    // The trust gates, as the evaluations page states them.
    const gates = new Set(
      [
        TRUST_GATES.slantFlip,
        TRUST_GATES.provenance,
        TRUST_GATES.liveLinks,
        PERSPECTIVES_TRUST_GATES.provenance,
        PERSPECTIVES_TRUST_GATES.leanIntegrity,
        PERSPECTIVES_TRUST_GATES.liveLinks,
      ].map(percent),
    );
    expect([...gates].sort()).toEqual(['100 %', '95 %', '97 %']);
    const testing = section('## How we test');
    for (const gate of gates) expect(testing, gate).toContain(gate);
    expect(testing).toContain(`leans from the list ${percent(PERSPECTIVES_TRUST_GATES.leanIntegrity)}`);
  });

  it('test_methodology_names_verdicts_buckets_lists_and_settings', () => {
    const verdicts = section('### Verdicts');
    for (const { label } of Object.values(VERDICT_LABELS)) expect(verdicts, label).toContain(label);
    expect(verdicts).toContain(`When the sources don't settle a claim, the verdict is ${VERDICT_LABELS.unverifiable.label}.`);

    const leans = section('### Where leans come from');
    // The five buckets, in display order.
    let from = 0;
    for (const bucket of LEAN_BUCKETS) {
      const at = leans.indexOf(BUCKET_LABELS[bucket], from);
      expect(at, bucket).toBeGreaterThanOrEqual(from);
      from = at + BUCKET_LABELS[bucket].length;
    }
    expect(leans).toContain("UnAlgorithm Cloud's source list");
    expect(leans).toContain('your own list');
    expect(leans).toMatch(/\bnever\b[^.]*\bAI\b/i);
    expect(leans).toContain(SOURCE_LIST_PAGE_URL);

    for (const setting of ['Settings → AI → Fact-check', 'Settings → AI → UnEcho Chamber']) {
      expect(text, setting).toContain(setting);
    }
  });

  it('test_methodology_links_exist_and_no_registry', () => {
    const links = [...md.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? '');
    for (const page of [PROMPTS_PAGE, EVALS_PAGE, CORRECTIONS_PAGE]) {
      const file = page.source.slice(page.source.lastIndexOf('/') + 1);
      expect(links, file).toContain(file);
    }
    // Every relative link points at a file in this repo (the website maps them to its pages).
    for (const link of links.filter((l) => !/^https?:/.test(l))) {
      const path = link.split('#')[0] ?? '';
      expect(existsSync(join(REPO_ROOT, dirname(METHODOLOGY_PAGE.source), path)), link).toBe(true);
    }
    expect(text).not.toMatch(/registry/i);
    expect(text).not.toMatch(/panel/i);
  });
});
