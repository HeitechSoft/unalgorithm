// Prices in effect never change, a raise gives PRICE_NOTICE_DAYS of notice, and a cut may start at the next 00:00 UTC
// (docs/release.md → Changing a price card). Compares this checkout's CREDIT_PRICE_SCHEDULE with the one at a base
// revision, read from git history:
//
//   node --import ./apps/server/src/require-node.js scripts/check-price-schedule.mjs --base <git revision> [--in-effect-only]
//
// `--in-effect-only` applies the first rule alone (the server release's check). Exit code 0: allowed; 1: a rule fails;
// 2: the check could not run. Needs `pnpm install` (the protocol package imports zod) and a Node.js with type stripping.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const SCHEDULE_FILE = 'packages/protocol/src/price-schedule.ts';
const BILLING_FILE = 'packages/protocol/src/billing.ts';
const USAGE = 'usage: node scripts/check-price-schedule.mjs --base <git revision> [--in-effect-only]';
const SEE = 'see docs/release.md → Changing a price card.';

/**
 * Imports a price-schedule.ts source (as git shows it) from a new temporary directory, which is then removed. The
 * `.mts` extension makes it an ES module whose types Node strips; its `import type` lines are erased, so nothing is
 * resolved. Running base-commit code is acceptable: the base is `main` or a pull request's base commit, both reviewed.
 */
export async function loadScheduleSource(source) {
  const dir = await mkdtemp(join(tmpdir(), 'ua-price-schedule-'));
  try {
    const file = join(dir, 'price-schedule.mts');
    await writeFile(file, source);
    const mod = await import(pathToFileURL(file).href);
    if (!Array.isArray(mod.CREDIT_PRICE_SCHEDULE)) throw new Error('CREDIT_PRICE_SCHEDULE is not an array');
    return { schedule: mod.CREDIT_PRICE_SCHEDULE, noticeDays: mod.PRICE_NOTICE_DAYS };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runGit(args) {
  const { status, stdout } = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return { status, stdout: stdout ?? '' };
}

const wholeDays = (n) => Number.isInteger(n) && n >= 0;

/** `{ base, inEffectOnly }`, or null for anything but `--base <revision>` and an optional `--in-effect-only`. */
function parseArgs(argv) {
  let base;
  let inEffectOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--in-effect-only') inEffectOnly = true;
    else if (argv[i] === '--base' && argv[i + 1]) base = argv[++i];
    else return null;
  }
  return base ? { base, inEffectOnly } : null;
}

/**
 * The CLI. Resolves with the exit code: 0 allowed, 1 a rule fails, 2 the check could not run. `deps` replaces git
 * (`git(args)` → `{ status, stdout }`), this checkout's schedule (`head`: `{ schedule, noticeDays }`), the clock
 * (`now`) and the output (`out`).
 */
export async function main(argv, deps = {}) {
  const { git = runGit, now = new Date(), out = console.log } = deps;
  const args = parseArgs(argv);
  if (!args) {
    out(USAGE);
    return 2;
  }
  const { base, inEffectOnly } = args;

  const protocol = await import('../packages/protocol/src/index.ts');
  const head = deps.head ?? { schedule: protocol.CREDIT_PRICE_SCHEDULE, noticeDays: protocol.PRICE_NOTICE_DAYS };

  const revision = git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  if (revision.status !== 0) {
    out(`The base revision ${base} is not in this checkout: fetch it first (fetch-depth: 0).`);
    return 2;
  }
  const sha = revision.stdout.trim();

  const shown = git(['show', `${sha}:${SCHEDULE_FILE}`]);
  if (shown.status !== 0) {
    const billing = git(['show', `${sha}:${BILLING_FILE}`]);
    if (billing.status === 0 && billing.stdout.includes('CREDIT_PRICE_SCHEDULE')) {
      out(`${SCHEDULE_FILE} is missing at ${base}, whose billing.ts has CREDIT_PRICE_SCHEDULE: cannot compare.`);
      return 2;
    }
    // The first schedule: only its own shape can be checked.
    const problems = protocol.priceScheduleProblems(head.schedule);
    for (const problem of problems) out(problem);
    if (problems.length > 0) return 1;
    out(`No price schedule at ${base}: nothing to compare.`);
    return 0;
  }

  let baseSchedule;
  try {
    baseSchedule = await loadScheduleSource(shown.stdout);
  } catch (err) {
    out(`Could not load the price schedule at ${base}: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  // A NaN would make the notice window empty and pass every raise.
  if (baseSchedule.noticeDays !== undefined && !wholeDays(baseSchedule.noticeDays)) {
    out(`PRICE_NOTICE_DAYS at ${base} must be a whole number of days, 0 or more, not ${String(baseSchedule.noticeDays)}.`);
    return 2;
  }
  if (!wholeDays(head.noticeDays)) {
    out(`PRICE_NOTICE_DAYS in this checkout must be a whole number of days, 0 or more, not ${String(head.noticeDays)}.`);
    return 2;
  }
  // A pull request cannot shorten the notice for its own change: a shorter notice applies from the next one.
  const notice = Math.max(baseSchedule.noticeDays ?? head.noticeDays, head.noticeDays);
  const rules = inEffectOnly ? 'in-effect' : 'all';

  let problems;
  try {
    problems = protocol.checkPriceScheduleChange(baseSchedule.schedule, head.schedule, now, notice, rules);
  } catch (err) {
    out(`Could not compare the price schedule with ${base}: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (problems.length > 0) {
    for (const problem of problems) out(problem);
    out(
      inEffectOnly
        ? `Prices in effect never change: ${SEE}`
        : `Prices in effect never change, and a price raise needs ${notice} days' notice: ${SEE}`,
    );
    return 1;
  }
  const inEffect = head.schedule.filter((entry) => Date.parse(entry.effectiveFrom) <= now.getTime()).length;
  out(`No price in effect changed (${inEffect} of ${head.schedule.length} entries in effect).`);
  return 0;
}

function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * True when node runs this file; false when a module imports it (the test does), so importing prints nothing. Node runs
 * the real path of its entry script while argv keeps the path as given, so a run through a symlinked or junction path
 * compares real paths.
 */
function isEntryPoint() {
  const entry = process.argv[1];
  return Boolean(entry) && [entry, realPath(entry)].some((path) => pathToFileURL(path).href === import.meta.url);
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2));
}
