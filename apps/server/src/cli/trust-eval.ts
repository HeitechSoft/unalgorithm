/**
 * `pnpm eval:trust`: RM4's trust gates per own-key AI mode (F25). It builds a mode's deps exactly as the extension does
 * (`factcheckDepsForMode` / `perspectivesDepsForMode`), runs the fact-check or UnEcho Chamber eval, checks the cited
 * links through the server's SSRF-safe egress fetcher (the only code allowed to fetch a retrieved URL) and exits on the
 * gates.
 *
 * - No `--live`: the deterministic mocks for every mode (the mode only labels the report). Spends nothing, reads no
 *   environment variable and checks no link: a harness check, so no gate line says PASSED or FAILED.
 * - `--live`: the mode's real client on keys from the environment, the smoke items (`--all`: the whole set). This spends
 *   real money on the operator's accounts: typing `--live` is that choice (decision D16); it never prompts. Run it only
 *   with the key owner's approval (decision D50).
 * - `--record` (only with `--live --all`; a smoke or offline run is not a measurement): appends the run, passed or
 *   failed, to `packages/research/eval/results.json` as one content-free record (decision D81), for the evaluations
 *   page. A run that hit provider errors measured the provider, not the feature, so it is not recorded.
 * - `--list <file>` (live UnEcho Chamber runs, which need it): a saved copy of a server's `/outlets.json`, whose leans
 *   people set with evidence. It must parse, have no list problem and at least one lean; its balance warnings are
 *   printed before the run, and its version is the record's `registryVersion`. Offline runs use the fictional fixture.
 *
 * Output names items by id and short codes, never post text, a link or a key. Exit 0 when the run passed, 1 when it did
 * not, 2 for a usage or environment error.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type AIClient, anthropicClient, memoryCapabilities, openaiClient, openaiCompatibleClient } from '@unalgorithm/ai';
import { formatPrice } from '@unalgorithm/core';
import { listBalance, listProblems, listProblemText, officialSourceList, type SourceList } from '@unalgorithm/outlets';
import {
  FACTCHECK_TYPICAL_COST_MICROS,
  FEATURE_NAMES,
  OfficialListSchema,
  OPENAI_FACTCHECK_TYPICAL_COST_MICROS,
  OPENAI_PERSPECTIVES_TYPICAL_COST_MICROS,
  PERSPECTIVES_TYPICAL_COST_MICROS,
} from '@unalgorithm/protocol';
import {
  createSearchProvider,
  FACTCHECK_PROMPT_VERSION,
  factcheckDepsForMode,
  type LinkChecker,
  type OwnKeyMode,
  PERSPECTIVES_PROMPT_VERSION,
  perspectivesDepsForMode,
  type SearchProvider,
} from '@unalgorithm/research';
import { FACTCHECK_EVAL_SET, type GateResult, mockDepsFor, runFactcheckEval, trustGates } from '@unalgorithm/research/eval';
import {
  mockPerspectivesDepsFor,
  PERSPECTIVES_EVAL_SET,
  perspectivesTrustGates,
  runPerspectivesEval,
} from '@unalgorithm/research/eval/perspectives';
import {
  EVAL_RESULTS_FILE,
  type EvalRecord,
  factcheckRecord,
  parseEvalResults,
  perspectivesRecord,
  type RecordMeta,
} from '@unalgorithm/research/eval/results';
import { SERVER_VERSION } from '../config.ts';
import { createEgress } from '../net/egress.ts';

export interface TrustEvalDeps {
  /** The AI and search transport of a live run. Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Default: `createEgress({ publicUrl: 'http://localhost', ... }).checkLinks`. */
  linkCheck?: LinkChecker;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** The pipeline's clock on a live run, and the recorded run's day. Default: the pipeline's own / the system clock. */
  now?: () => Date;
  /** Where `--record` appends. Default: EVAL_RESULTS_FILE (`packages/research/eval/results.json`). */
  resultsFile?: URL;
}

type Mode = 'anthropic' | 'openai' | 'compat';
type Task = 'factcheck' | 'perspectives';
type Env = Record<string, string | undefined>;

export const USAGE = [
  'usage: pnpm eval:trust --mode anthropic|openai|compat [--task factcheck|perspectives] [--live [--all [--record]]]',
  '                       [--list <file>]',
  '  --live env: anthropic  ANTHROPIC_API_KEY',
  '              openai     OPENAI_API_KEY',
  '              compat     COMPAT_BASE_URL, COMPAT_MODEL, [COMPAT_API_KEY], SEARCH_PROVIDER=brave|tavily, SEARCH_API_KEY',
  '  --record    appends the full run, passed or failed, to packages/research/eval/results.json',
  "  --list      perspectives --live only: a saved copy of a server's /outlets.json, the run's source list",
].join('\n');

/** A live UnEcho Chamber run without `--list` (the name is kept from the registry it once needed). */
export const NO_REGISTRY = `${FEATURE_NAMES.perspectives} needs a source list with leans: pass --list <file>, a saved copy of a server's /outlets.json.`;
export const BAD_LIST = "The --list file isn't a source list: pass a saved copy of a server's /outlets.json.";
export const EMPTY_LIST = "The --list file's source list has no outlets with a lean.";
export const RECORDED =
  'Recorded in packages/research/eval/results.json. Run pnpm format and pnpm docs:site, then commit both files.';
export const NOT_RECORDED = 'Not recorded: the run hit provider errors.';

const MODES: readonly Mode[] = ['anthropic', 'openai', 'compat'];
const TASKS: readonly Task[] = ['factcheck', 'perspectives'];

interface Args {
  mode: Mode;
  task: Task;
  live: boolean;
  all: boolean;
  record: boolean;
  /** The `--list` file's path. */
  list: string | undefined;
}

function parseArgs(argv: readonly string[]): Args | null {
  let mode: Mode | undefined;
  let task: Task = 'factcheck';
  let live = false;
  let all = false;
  let record = false;
  let list: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--live') live = true;
    else if (arg === '--all') all = true;
    else if (arg === '--record') record = true;
    else if (arg === '--mode') {
      const value = argv[++i];
      if (!MODES.includes(value as Mode)) return null;
      mode = value as Mode;
    } else if (arg === '--task') {
      const value = argv[++i];
      if (!TASKS.includes(value as Task)) return null;
      task = value as Task;
    } else if (arg === '--list') {
      list = argv[++i];
      if (!list) return null;
    } else return null;
  }
  if (!mode || (all && !live) || (record && !(live && all))) return null;
  if (list !== undefined && !(live && task === 'perspectives')) return null;
  return { mode, task, live, all, record, list };
}

class EnvError extends Error {}

/** A set variable's trimmed value; a missing one is an EnvError naming the variable only, never a value. */
function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new EnvError(`A live run on this mode needs ${name} in the environment.`);
  return value;
}

const PROVIDER_NAME = { brave: 'Brave', tavily: 'Tavily' } as const;

interface LiveSetup {
  client: AIClient;
  ownKey: OwnKeyMode;
  /** The spend line's tail after `on <mode>`. */
  spend: (n: number, task: Task) => string;
  /** compat: which search key the run uses (recorded; the endpoint and model never are). */
  searchProvider?: keyof typeof PROVIDER_NAME;
}

function liveSetup(mode: Mode, env: Env, doFetch: typeof fetch | undefined): LiveSetup {
  const transport = doFetch ? { fetch: doFetch } : {};
  const capabilities = memoryCapabilities();
  switch (mode) {
    case 'anthropic': {
      const client = anthropicClient({ apiKey: required(env, 'ANTHROPIC_API_KEY'), capabilities, ...transport });
      const spend = (n: number, task: Task) =>
        `, about ${formatPrice(n * (task === 'factcheck' ? FACTCHECK_TYPICAL_COST_MICROS : PERSPECTIVES_TYPICAL_COST_MICROS))} on your Anthropic account.`;
      return { client, ownKey: { kind: 'anthropic' }, spend };
    }
    case 'openai': {
      const client = openaiClient({ apiKey: required(env, 'OPENAI_API_KEY'), capabilities, ...transport });
      const spend = (n: number, task: Task) =>
        `, about ${formatPrice(n * (task === 'factcheck' ? OPENAI_FACTCHECK_TYPICAL_COST_MICROS : OPENAI_PERSPECTIVES_TYPICAL_COST_MICROS))} on your OpenAI account.`;
      return { client, ownKey: { kind: 'openai' }, spend };
    }
    case 'compat': {
      const baseUrl = required(env, 'COMPAT_BASE_URL');
      const model = required(env, 'COMPAT_MODEL');
      const provider = required(env, 'SEARCH_PROVIDER');
      if (provider !== 'brave' && provider !== 'tavily') throw new EnvError('SEARCH_PROVIDER must be brave or tavily.');
      const search: SearchProvider = createSearchProvider({
        provider,
        apiKey: required(env, 'SEARCH_API_KEY'),
        ...transport,
      });
      const apiKey = env.COMPAT_API_KEY?.trim();
      const client = openaiCompatibleClient({ baseUrl, capabilities, ...(apiKey ? { apiKey } : {}), ...transport });
      // Research searches 3 times per check; perspectives once per lean bucket.
      const spend = (n: number, task: Task) =>
        `: your endpoint's own price, plus up to ${n * (task === 'factcheck' ? 3 : 5)} searches on your ${PROVIDER_NAME[provider]} key.`;
      return { client, ownKey: { kind: 'openai-compatible', model, search }, spend, searchProvider: provider };
    }
  }
}

function fixed(value: number | null): string {
  return value === null ? 'none' : value.toFixed(2);
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : 'error');

/** The `--list` file as the run's source list, or the line saying why it can't be one. Reads the file only. */
function readList(path: string): SourceList | string {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return BAD_LIST;
  }
  const parsed = OfficialListSchema.safeParse(raw);
  if (!parsed.success) return BAD_LIST;
  const [problem] = listProblems(parsed.data.outlets);
  if (problem) return `The --list file's source list needs fixing: ${listProblemText(problem)}`;
  const list = officialSourceList(parsed.data);
  return listBalance(list).empty ? EMPTY_LIST : list;
}

/** Appends `record` to the results file, written as the CLI always writes it (`pnpm format` then normalises it). */
function appendRecord(file: URL, record: EvalRecord): void {
  const records = parseEvalResults(readFileSync(file, 'utf8'));
  records.push(record);
  writeFileSync(file, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
}

/** One gate line: measured → PASSED/FAILED; offline → never either; else why it was not measured. */
function gateLine(name: string, g: GateResult, showMin: boolean, notMeasured: string, offline: boolean): string {
  if (offline) return `${name} ${fixed(g.value)} (offline mock, not measured)`;
  if (g.passed === null) return `${name} not measured (${notMeasured})`;
  return `${name} ${fixed(g.value)}${showMin ? ` (min ${g.min.toFixed(2)})` : ''} ${g.passed ? 'PASSED' : 'FAILED'}`;
}

export async function main(argv: readonly string[], env: Env, deps: TrustEvalDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const args = parseArgs(argv);
  if (!args) {
    err(USAGE);
    return 2;
  }
  const { mode, task, live, all } = args;
  const factcheck = task === 'factcheck';

  // A live UnEcho Chamber run reads leans people set, from the --list file (never the fixture): checked before any key
  // is read.
  let registry: SourceList | null = null;
  if (live && !factcheck) {
    if (args.list === undefined) {
      err(NO_REGISTRY);
      return 2;
    }
    const list = readList(args.list);
    if (typeof list === 'string') {
      err(list);
      return 2;
    }
    registry = list;
  }

  // A run that could not be recorded must not spend: the results file is checked before any key is read.
  const resultsFile = deps.resultsFile ?? EVAL_RESULTS_FILE;
  if (args.record) {
    try {
      parseEvalResults(readFileSync(resultsFile, 'utf8'));
    } catch (e) {
      err(`Cannot record: ${errorText(e)}`);
      return 2;
    }
  }

  let setup: LiveSetup | null = null;
  if (live) {
    try {
      setup = liveSetup(mode, env, deps.fetch);
    } catch (e) {
      if (!(e instanceof EnvError)) throw e;
      err(e.message);
      return 2;
    }
  }

  const smoke = live && !all;
  const offline = !live;
  const linkCheck = live
    ? (deps.linkCheck ?? createEgress({ publicUrl: 'http://localhost', version: SERVER_VERSION }).checkLinks)
    : undefined;
  const opts = linkCheck ? { linkCheck } : {};
  const clock = deps.now ? { now: deps.now } : {};
  const why = (fallback: string) => (smoke ? 'smoke run' : fallback);
  const linksWhy = why('too few links answered');

  /** What the record says about the run besides its report; the day is the one the run ended on. */
  const meta = (promptVersion: number, registryVersion?: string): RecordMeta => ({
    mode,
    ...(setup?.searchProvider ? { searchProvider: setup.searchProvider } : {}),
    ranOn: deps.now?.() ?? new Date(),
    promptVersion,
    ...(registryVersion === undefined ? {} : { registryVersion }),
    serverVersion: SERVER_VERSION,
  });
  /**
   * `--record`, after the gates: appends the run's record, passed or failed, unless provider errors left items
   * unmeasured. False when the file could not be read or written.
   */
  const save = (providerErrors: number, build: () => EvalRecord): boolean => {
    if (providerErrors > 0) {
      out(NOT_RECORDED);
      return true;
    }
    try {
      appendRecord(resultsFile, build());
    } catch (e) {
      err(`Not recorded: ${errorText(e)}`);
      return false;
    }
    out(RECORDED);
    return true;
  };

  if (factcheck) {
    const items = all || !live ? FACTCHECK_EVAL_SET : FACTCHECK_EVAL_SET.filter((i) => i.smoke);
    if (setup) out(`Live run: ${items.length} checks on ${mode}${setup.spend(items.length, task)}`);
    const runDeps = setup ? { ...factcheckDepsForMode(setup.client, setup.ownKey), ...clock } : mockDepsFor(FACTCHECK_EVAL_SET);
    const report = await runFactcheckEval(runDeps, items, opts);
    out(JSON.stringify(report, null, 2));
    const gates = trustGates(report);
    out(gateLine('slant flip', gates.slantFlip, true, why('too few pairs scored'), offline));
    out(gateLine('provenance', gates.provenance, false, why('too few citations shown'), offline));
    out(gateLine('live links', gates.liveLinks, true, linksWhy, offline));
    const recorded = () => factcheckRecord(report, gates, meta(FACTCHECK_PROMPT_VERSION));
    if (args.record && !save(report.providerErrors.length, recorded)) return 2;
    if (report.providerErrors.length > 0) return 1;
    return live && all ? (gates.passed ? 0 : 1) : report.provenance === 1 ? 0 : 1;
  }

  const items = all || !live ? PERSPECTIVES_EVAL_SET : PERSPECTIVES_EVAL_SET.filter((i) => i.smoke);
  const warnings = registry ? listBalance(registry).warnings : [];
  if (warnings.length > 0) out(`The source list isn't balanced: ${warnings.join(' ')}`);
  if (setup) out(`Live run: ${items.length} comparisons on ${mode}${setup.spend(items.length, task)}`);
  const runDeps =
    setup && registry
      ? { ...perspectivesDepsForMode(setup.client, setup.ownKey, registry), ...clock }
      : mockPerspectivesDepsFor(PERSPECTIVES_EVAL_SET);
  const report = await runPerspectivesEval(runDeps, items, opts);
  out(JSON.stringify(report, null, 2));
  const gates = perspectivesTrustGates(report);
  out(gateLine('provenance', gates.provenance, false, why('too few citations shown'), offline));
  out(gateLine('lean integrity', gates.leanIntegrity, false, why('too few sources shown'), offline));
  out(gateLine('live links', gates.liveLinks, true, linksWhy, offline));
  const recorded = () => perspectivesRecord(report, gates, meta(PERSPECTIVES_PROMPT_VERSION, registry?.version));
  if (args.record && !save(report.providerErrors.length, recorded)) return 2;
  if (report.providerErrors.length > 0) return 1;
  if (live && all) return gates.passed ? 0 : 1;
  return report.provenance === 1 && report.leanIntegrity === 1 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      // By name only: a message can hold a URL or a provider's text.
      console.error(`eval:trust failed: ${e instanceof Error ? e.name : 'error'}`);
      process.exitCode = 1;
    },
  );
}
