/**
 * `pnpm eval:trust`: RM4's trust gates per own-key AI mode (F25). It builds a mode's deps exactly as the extension does
 * (`factcheckDepsForMode` / `perspectivesDepsForMode`), runs the fact-check or Other perspectives eval, checks the cited
 * links through the server's SSRF-safe egress fetcher (the only code allowed to fetch a retrieved URL) and exits on the
 * gates.
 *
 * - No `--live`: the deterministic mocks for every mode (the mode only labels the report). Spends nothing, reads no
 *   environment variable and checks no link: a harness check, so no gate line says PASSED or FAILED.
 * - `--live`: the mode's real client on keys from the environment, the smoke items (`--all`: the whole set). This spends
 *   real money on the operator's accounts: typing `--live` is that choice (decision D16); it never prompts. Run it only
 *   with the key owner's approval (decision D50).
 *
 * Output names items by id and short codes, never post text, a link or a key. Exit 0 when the run passed, 1 when it did
 * not, 2 for a usage or environment error.
 */
import { fileURLToPath } from 'node:url';
import { type AIClient, anthropicClient, memoryCapabilities, openaiClient, openaiCompatibleClient } from '@unalgorithm/ai';
import { formatPrice } from '@unalgorithm/core';
import { bundledRegistry, usableRegistry } from '@unalgorithm/outlets';
import {
  FACTCHECK_TYPICAL_COST_MICROS,
  OPENAI_FACTCHECK_TYPICAL_COST_MICROS,
  OPENAI_PERSPECTIVES_TYPICAL_COST_MICROS,
  PERSPECTIVES_TYPICAL_COST_MICROS,
} from '@unalgorithm/protocol';
import {
  createSearchProvider,
  factcheckDepsForMode,
  type LinkChecker,
  type OwnKeyMode,
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
import { SERVER_VERSION } from '../config.ts';
import { createEgress } from '../net/egress.ts';

export interface TrustEvalDeps {
  /** The AI and search transport of a live run. Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Default: `createEgress({ publicUrl: 'http://localhost', ... }).checkLinks`. */
  linkCheck?: LinkChecker;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** The pipeline's clock on a live run. Default: the pipeline's own. */
  now?: () => Date;
}

type Mode = 'anthropic' | 'openai' | 'compat';
type Task = 'factcheck' | 'perspectives';
type Env = Record<string, string | undefined>;

export const USAGE = [
  'usage: pnpm eval:trust --mode anthropic|openai|compat [--task factcheck|perspectives] [--live [--all]]',
  '  --live env: anthropic  ANTHROPIC_API_KEY',
  '              openai     OPENAI_API_KEY',
  '              compat     COMPAT_BASE_URL, COMPAT_MODEL, [COMPAT_API_KEY], SEARCH_PROVIDER=brave|tavily, SEARCH_API_KEY',
].join('\n');

export const NO_REGISTRY = 'Other perspectives needs a reviewed outlet registry; this build has none.';

const MODES: readonly Mode[] = ['anthropic', 'openai', 'compat'];
const TASKS: readonly Task[] = ['factcheck', 'perspectives'];

interface Args {
  mode: Mode;
  task: Task;
  live: boolean;
  all: boolean;
}

function parseArgs(argv: readonly string[]): Args | null {
  let mode: Mode | undefined;
  let task: Task = 'factcheck';
  let live = false;
  let all = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--live') live = true;
    else if (arg === '--all') all = true;
    else if (arg === '--mode') {
      const value = argv[++i];
      if (!MODES.includes(value as Mode)) return null;
      mode = value as Mode;
    } else if (arg === '--task') {
      const value = argv[++i];
      if (!TASKS.includes(value as Task)) return null;
      task = value as Task;
    } else return null;
  }
  if (!mode || (all && !live)) return null;
  return { mode, task, live, all };
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
      return { client, ownKey: { kind: 'openai-compatible', model, search }, spend };
    }
  }
}

function fixed(value: number | null): string {
  return value === null ? 'none' : value.toFixed(2);
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

  // Perspectives shows leans only from a reviewed registry (no fixture): checked before any key is read.
  const registry = live && !factcheck ? usableRegistry(bundledRegistry()) : null;
  if (live && !factcheck && !registry) {
    err(NO_REGISTRY);
    return 2;
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
    if (report.providerErrors.length > 0) return 1;
    return live && all ? (gates.passed ? 0 : 1) : report.provenance === 1 ? 0 : 1;
  }

  const items = all || !live ? PERSPECTIVES_EVAL_SET : PERSPECTIVES_EVAL_SET.filter((i) => i.smoke);
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
