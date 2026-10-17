/**
 * The price-schedule check (CL2-26): the CLI that CI runs against the base commit, the workflows that run it, and the
 * release procedure it enforces. Every case injects `now` at a fixed instant; none reads the clock for a price.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CREDIT_PRICE_SCHEDULE, type CreditPriceScheduleEntry, PRICE_NOTICE_DAYS } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadScheduleSource, main } from '../../../scripts/check-price-schedule.mjs';
import { PROCESS_TIMEOUT, SPAWN_TIMEOUT } from './support/timeouts.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts/check-price-schedule.mjs');
const REQUIRE_NODE = join(REPO_ROOT, 'apps/server/src/require-node.js');
const SCHEDULE_FILE = 'packages/protocol/src/price-schedule.ts';
const BILLING_FILE = 'packages/protocol/src/billing.ts';
/** This checkout's price-schedule.ts, as `git show` would print it. */
const REAL_SOURCE = readFileSync(join(REPO_ROOT, SCHEDULE_FILE), 'utf8');

const NOW = new Date('2026-10-14T12:00:00Z');
const SHA = '0123456789abcdef0123456789abcdef01234567';
const CLOSING =
  "Prices in effect never change, and a price raise needs 30 days' notice: see docs/release.md → Changing a price card.";

function entry(effectiveFrom: string, multiplier: number): CreditPriceScheduleEntry {
  return {
    effectiveFrom,
    cards: { classify: { multiplier, referenceModel: 'claude-haiku-5-5', referenceCostMicrosPer1000: 73_000 } },
  };
}
const A = entry('2026-10-01T00:00:00Z', 2);
const B = entry('2026-11-15T00:00:00Z', 2.5);

/** A price-schedule.ts source with these entries and notice, in the file's shape (types and an `import type`). */
function scheduleSource(entries: CreditPriceScheduleEntry[], noticeDays = '30'): string {
  return [
    "import type { CreditPriceSchedule } from './billing.ts';",
    `export const PRICE_NOTICE_DAYS = ${noticeDays};`,
    `export const CREDIT_PRICE_SCHEDULE: CreditPriceSchedule = ${JSON.stringify(entries)};`,
    '',
  ].join('\n');
}

/** A git that knows one revision, `main`, holding `files` (repository path → text). */
function fakeGit(files: Record<string, string>) {
  return (args: readonly string[]) => {
    const [command, ...rest] = args;
    if (command === 'rev-parse') {
      return rest.at(-1) === 'main^{commit}' ? { status: 0, stdout: `${SHA}\n` } : { status: 1, stdout: '' };
    }
    if (command === 'show') {
      const text = files[String(rest[0]).replace(`${SHA}:`, '')];
      return text === undefined ? { status: 128, stdout: '' } : { status: 0, stdout: text };
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

/** Runs the CLI against a base `main` holding `files`; resolves with the exit code and the lines printed. */
async function run(
  argv: string[],
  files: Record<string, string>,
  { head = { schedule: CREDIT_PRICE_SCHEDULE, noticeDays: PRICE_NOTICE_DAYS }, now = NOW } = {},
) {
  const lines: string[] = [];
  const code = await main(argv, { git: fakeGit(files), head, now, out: (line) => lines.push(line) });
  return { code, lines };
}

const atBase = (source: string) => ({ [SCHEDULE_FILE]: source });
const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith('ua-price-schedule-'));

describe('cli', () => {
  it('test_cli_exit_codes', async () => {
    expect(await run(['--base', 'main'], atBase(REAL_SOURCE))).toEqual({
      code: 0,
      lines: ['No price in effect changed (1 of 2 entries in effect).'],
    });

    const changed = REAL_SOURCE.replace('multiplier: 2,', 'multiplier: 2.5,');
    expect(changed).not.toBe(REAL_SOURCE);
    expect(await run(['--base', 'main'], atBase(changed))).toEqual({
      code: 1,
      lines: ['2026-10-01T00:00:00Z: this price is in effect and cannot change; add a new dated entry instead', CLOSING],
    });

    expect(await run(['--base', 'nope'], atBase(REAL_SOURCE))).toEqual({
      code: 2,
      lines: ['The base revision nope is not in this checkout: fetch it first (fetch-depth: 0).'],
    });
    const usage = 'usage: node scripts/check-price-schedule.mjs --base <git revision> [--in-effect-only]';
    expect(await run([], atBase(REAL_SOURCE))).toEqual({ code: 2, lines: [usage] });
    expect(await run(['--base'], atBase(REAL_SOURCE))).toEqual({ code: 2, lines: [usage] });
  });

  it('test_cli_first_schedule_and_moved_file', async () => {
    expect(await run(['--base', 'main'], {})).toEqual({ code: 0, lines: ['No price schedule at main: nothing to compare.'] });
    // The first schedule is still checked for its own shape.
    expect(await run(['--base', 'main'], {}, { head: { schedule: [], noticeDays: 30 } })).toEqual({
      code: 1,
      lines: ['the schedule is empty'],
    });
    expect(await run(['--base', 'main'], { [BILLING_FILE]: 'export const CREDIT_PRICE_SCHEDULE = [];\n' })).toEqual({
      code: 2,
      lines: [
        'packages/protocol/src/price-schedule.ts is missing at main, whose billing.ts has CREDIT_PRICE_SCHEDULE: cannot compare.',
      ],
    });
  });

  it('test_cli_uses_the_longer_notice', async () => {
    const base = atBase(scheduleSource([A], '45'));
    // 31.5 days out: allowed under 30 days' notice, not under the base's 45.
    const raise = await run(['--base', 'main'], base, { head: { schedule: [A, entry(B.effectiveFrom, 2.5)], noticeDays: 30 } });
    expect(raise.code).toBe(1);
    expect(raise.lines[0]).toContain("a price raise needs 45 days' notice");
    expect(raise.lines.at(-1)).toContain("needs 45 days' notice");
    const cut = await run(['--base', 'main'], base, { head: { schedule: [A, entry(B.effectiveFrom, 1.5)], noticeDays: 30 } });
    expect(cut.code).toBe(0);

    expect(
      await run(['--base', 'main'], atBase(REAL_SOURCE), { head: { schedule: CREDIT_PRICE_SCHEDULE, noticeDays: Number.NaN } }),
    ).toEqual({ code: 2, lines: ['PRICE_NOTICE_DAYS in this checkout must be a whole number of days, 0 or more, not NaN.'] });
    expect(await run(['--base', 'main'], atBase(scheduleSource([A], '-1')))).toEqual({
      code: 2,
      lines: ['PRICE_NOTICE_DAYS at main must be a whole number of days, 0 or more, not -1.'],
    });
  });

  it('test_cli_in_effect_only', async () => {
    // A raise 14 days out: the release check does not measure notice; the merge check does.
    const raise = { head: { schedule: [A, entry(B.effectiveFrom, 2.5)], noticeDays: 30 }, now: new Date('2026-11-01T00:00:00Z') };
    expect((await run(['--base', 'main', '--in-effect-only'], atBase(scheduleSource([A])), raise)).code).toBe(0);
    expect((await run(['--base', 'main'], atBase(scheduleSource([A])), raise)).code).toBe(1);

    // B, in effect since 15 November, is gone from the head.
    const removed = { head: { schedule: [A], noticeDays: 30 }, now: new Date('2026-11-20T00:00:00Z') };
    expect(await run(['--in-effect-only', '--base', 'main'], atBase(scheduleSource([A, B])), removed)).toEqual({
      code: 1,
      lines: [
        '2026-11-15T00:00:00Z: this price is in effect and cannot be removed',
        'Prices in effect never change: see docs/release.md → Changing a price card.',
      ],
    });
  });

  it('test_load_schedule_source_reads_real_file', async () => {
    const before = leftovers();
    expect(await loadScheduleSource(REAL_SOURCE)).toEqual({ schedule: CREDIT_PRICE_SCHEDULE, noticeDays: PRICE_NOTICE_DAYS });
    expect(leftovers().filter((name) => !before.includes(name))).toEqual([]);
    await expect(loadScheduleSource('export const CREDIT_PRICE_SCHEDULE = 1;\n')).rejects.toThrow('not an array');
    expect(leftovers().filter((name) => !before.includes(name))).toEqual([]);
  });

  it('test_price_schedule_file_has_no_runtime_import', () => {
    const imports = REAL_SOURCE.split('\n').filter((line) => /^\s*import\b/.test(line));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^\s*import type\b/);
    expect(REAL_SOURCE).not.toContain('require(');
  });
});

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

/** `${{ expression }}` as a workflow writes it (a template literal, so it is not read as a mistyped placeholder). */
const expr = (expression: string) => `$\{{ ${expression} }}`;
const workflow = (name: string) => parse(readFileSync(join(REPO_ROOT, '.github/workflows', name), 'utf8'));

describe('ci', () => {
  it('test_ci_runs_price_schedule_check', () => {
    const ci = workflow('ci.yml');
    expect(ci.on.push).toEqual({ branches: ['main'] });
    expect('pull_request' in ci.on).toBe(true);
    const job = ci.jobs['price-schedule'];
    expect(job['runs-on']).toBe('ubuntu-latest');
    const steps: Step[] = job.steps;
    expect(steps.find((step) => step.uses?.startsWith('actions/checkout@'))?.with?.['fetch-depth']).toBe(0);
    const install = steps.findIndex((step) => step.run === 'pnpm install --frozen-lockfile');
    const check = steps.findIndex((step) => step.run?.includes('scripts/check-price-schedule.mjs') === true);
    expect(install).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(install);
    expect(steps[check]?.run).toContain('scripts/check-price-schedule.mjs --base "$BASE_SHA"');
    expect(steps[check]?.run).not.toContain('--in-effect-only');
    expect(steps[check]?.env?.BASE_SHA).toBe(expr('github.event.pull_request.base.sha || github.event.before'));
  });

  it('test_cli_against_head_passes', { timeout: SPAWN_TIMEOUT }, () => {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(REQUIRE_NODE).href, SCRIPT, '--base', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: PROCESS_TIMEOUT,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    // HEAD has the schedule: the real git read it and compared it, never the "nothing to compare" fallback, which
    // would also exit 0 if `git show` failed.
    expect(result.stdout).toMatch(/^No price in effect changed \(\d+ of \d+ entries in effect\)\.$/m);
    expect(result.stdout).not.toContain('nothing to compare');
  });
});

describe('docs', () => {
  it('test_release_doc_describes_dated_prices', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs/release.md'), 'utf8').replaceAll('\r\n', '\n');
    const start = doc.indexOf('\n## Changing a price card\n');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = doc.indexOf('\n## ', start + 1);
    const section = (end < 0 ? doc.slice(start) : doc.slice(start, end)).toLowerCase();
    for (const term of [
      'CREDIT_PRICE_SCHEDULE',
      'PRICE_NOTICE_DAYS',
      'price-schedule',
      '00:00 UTC',
      'STARTER_CREDIT',
      '--in-effect-only',
      're-run',
      'no rollback',
      'Price cuts',
      'next 00:00 UTC',
    ]) {
      expect(section, term).toContain(term.toLowerCase());
    }
    expect(section).not.toContain('credit_price_cards');
    expect(section).not.toContain('rollback puts');
  });
});
