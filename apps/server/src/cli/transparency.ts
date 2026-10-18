import { fileURLToPath } from 'node:url';
import { BUCKET_LABELS, FEATURE_NAMES, LEAN_BUCKETS, markdownCell } from '@unalgorithm/protocol';
import { FACTCHECK_PROMPT_VERSION, PERSPECTIVES_PROMPT_VERSION } from '@unalgorithm/research';
import { type ListAtQuarterEnd, listAtQuarterEnd } from '../admin/outlets.ts';
import { type CheckCounts, checkCounts } from '../admin/queries.ts';
import { enabledRoute, ROUTE_TASKS } from '../ai/routes.ts';
import { type Config, ConfigError, loadConfig, SERVER_VERSION } from '../config.ts';
import { type DbHandle, openPostgres, queryErrorFields } from '../db/client.ts';

/**
 * Prints one quarter's transparency report (F29, P3-70, decisions D89, D90, D108) as Markdown:
 * `node apps/server/src/cli/transparency.ts --quarter 2026-Q4` (or `pnpm transparency`), with the server's own
 * environment; in production, inside the container with
 * `docker compose exec server node apps/server/src/cli/transparency.ts --quarter 2026-Q4`. It reads only what the server
 * keeps without content: the `usage_events` rows of fact-checks and comparisons, the enabled AI routes, the prompt
 * versions and the source list's change history. Counts of checks and people from 1 to 9 print as "fewer than 10". It
 * prints to standard output only, inside a read-only transaction: no file, no row. Corrections, appeals and the audit
 * are added by hand (`docs/site/transparency.md`). Exit code 0 when the report was printed, 1 otherwise.
 */

export interface TransparencyDeps {
  /** Default: a Postgres pool on `config.databaseUrl`, closed before `main` returns. A given handle stays open. */
  db?: DbHandle;
  /** Default: `loadConfig(process.env)`. */
  config?: Config;
  /** Default: standard output. */
  out?: (line: string) => void;
  /** Default: the clock. A quarter is reported only once it has ended. */
  now?: () => Date;
}

const USAGE = 'usage: node apps/server/src/cli/transparency.ts --quarter YYYY-Qn';
const NOT_ENDED = "That quarter hasn't ended yet.";
const NO_VERDICTS = "This server keeps no post, no claim and no one's results, so this report has no verdict counts.";

/** The whole report reads one snapshot, and can write nothing. */
const READ_ONLY = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;

/** `YYYY-Qn` (n 1–4) as its UTC days: `from` inclusive, `to` exclusive. Null for anything else. */
export function quarterRange(quarter: string): { from: Date; to: Date } | null {
  const match = /^(\d{4})-Q([1-4])$/.exec(quarter);
  if (!match) return null;
  const [year, n] = [Number(match[1]), Number(match[2])];
  return { from: new Date(Date.UTC(year, (n - 1) * 3, 1)), to: new Date(Date.UTC(year, n * 3, 1)) };
}

const thousands = new Intl.NumberFormat('en-US');

/** A count of checks or people as published (decision D89): 1 to 9 never print, so no one can be singled out. */
export function shownCount(n: number): string {
  if (n === 0) return '0';
  if (n < 10) return 'fewer than 10';
  return thousands.format(n);
}

export interface ReportInput {
  quarter: string;
  from: Date;
  to: Date;
  /** The server's origin, as `PUBLIC_URL` gives it. */
  origin: string;
  serverVersion: string;
  counts: readonly CheckCounts[];
  /** The enabled AI routes, sorted by task. */
  routes: readonly { task: string; model: string; provider: string }[];
  promptVersions: { factcheck: number; perspectives: number };
  list: ListAtQuarterEnd;
}

const month = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' });
const utcDay = (at: Date) => at.toISOString().slice(0, 10);

/** The table's rows: a label and the count it shows for each feature. */
const ROWS: readonly [string, (c: CheckCounts) => number][] = [
  ['Finished', (c) => c.finished],
  ["Didn't finish", (c) => c.unfinished],
  ['Refused before any AI call', (c) => c.refused],
  ['Web searches', (c) => c.webSearches],
  ['People who used it', (c) => c.people],
];

/** The report as Markdown lines: a `##` section, so each quarter's report is added to the page as printed. */
export function reportMarkdown(r: ReportInput): string[] {
  const last = new Date(r.to.getTime() - 1);
  const counts = (['factcheck', 'perspectives'] as const).map((task) => {
    const found = r.counts.find((c) => c.task === task);
    if (!found) throw new Error(`No counts for ${task}.`);
    return found;
  });
  const models = r.routes.map((route) => `${route.task} ${markdownCell(route.model)} (${markdownCell(route.provider)})`);
  const { version, counts: leans, changes } = r.list;
  return [
    `## ${month.format(r.from)} to ${month.format(last)} ${last.getUTCFullYear()}`,
    '',
    `From ${utcDay(r.from)} to ${utcDay(last)} (UTC), on ${r.origin} (server ${r.serverVersion}).`,
    '',
    `|  | ${FEATURE_NAMES.factcheck} | ${FEATURE_NAMES.perspectives} |`,
    '| --- | ---: | ---: |',
    ...ROWS.map(([label, count]) => `| ${label} | ${counts.map((c) => shownCount(count(c))).join(' | ')} |`),
    '',
    `AI models: ${models.length === 0 ? 'none' : models.join(', ')}.`,
    '',
    `Prompt versions: ${FEATURE_NAMES.factcheck} ${r.promptVersions.factcheck}, ${FEATURE_NAMES.perspectives} ${r.promptVersions.perspectives}.`,
    '',
    `Source list: version ${version} at the end of the quarter; outlets with a lean: ` +
      `${LEAN_BUCKETS.map((b) => `${BUCKET_LABELS[b]} ${leans[b]}`).join(' · ')}; changes this quarter: ` +
      `${changes.add} added, ${changes.edit} edited, ${changes.remove} removed, ${changes.import} imported.`,
    '',
    NO_VERDICTS,
  ];
}

export async function main(argv: readonly string[], deps: TransparencyDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const quarter = argv[1] ?? '';
  const range = argv.length === 2 && argv[0] === '--quarter' ? quarterRange(quarter) : null;
  if (!range) {
    out(USAGE);
    return 1;
  }
  if (range.to.getTime() > (deps.now?.() ?? new Date()).getTime()) {
    out(NOT_ENDED);
    return 1;
  }

  let config: Config;
  try {
    config = deps.config ?? loadConfig(process.env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    // Variable names and rules only, never values.
    out(err.message);
    return 1;
  }

  const handle = deps.db ?? openPostgres(config.databaseUrl);
  try {
    const report = await handle.db.transaction(async (tx) => {
      const counts = await checkCounts(tx, range.from, range.to);
      const routes = [];
      for (const task of [...ROUTE_TASKS].sort()) {
        const route = await enabledRoute(tx, task);
        if (route) routes.push({ task, model: route.model, provider: route.provider });
      }
      const list = await listAtQuarterEnd(tx, range.from, range.to);
      return reportMarkdown({
        quarter,
        ...range,
        origin: new URL(config.publicUrl).origin,
        serverVersion: SERVER_VERSION,
        counts,
        routes,
        promptVersions: { factcheck: FACTCHECK_PROMPT_VERSION, perspectives: PERSPECTIVES_PROMPT_VERSION },
        list,
      });
    }, READ_ONLY);
    for (const line of report) out(line);
    return 0;
  } catch (err) {
    // A database error by name and code only: its message can name a host.
    const { err_name, err_code } = queryErrorFields(err);
    out(`transparency failed: ${err_name}${err_code === undefined ? '' : ` (${err_code})`}`);
    return 1;
  } finally {
    if (!deps.db) await handle.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
