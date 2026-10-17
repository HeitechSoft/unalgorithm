/**
 * Published live eval results (F29, decision D81): one content-free record per full live run (`pnpm eval:trust --live
 * --all --record`), passed or failed, kept in `results.json` and shown on the evaluations page. A record holds only
 * what the schema below names: never an item id, a failure reason, model text, a URL, the compat endpoint or model, a
 * key or an environment value. The gates are copied from `trustGates` / `perspectivesTrustGates`, never re-scored here.
 */
import { z } from 'zod';
import type { PerspectivesEvalReport, perspectivesTrustGates } from './perspectives-score.ts';
import type { FactcheckEvalReport, trustGates } from './score.ts';

export const GATE_NAMES = ['slantFlip', 'provenance', 'liveLinks', 'leanIntegrity'] as const;
export type GateName = (typeof GATE_NAMES)[number];
const Gate = z.strictObject({ value: z.number().min(0).max(1).nullable(), min: z.number(), passed: z.boolean().nullable() });

export const EvalRecordSchema = z.strictObject({
  task: z.enum(['factcheck', 'perspectives']),
  mode: z.enum(['anthropic', 'openai', 'compat']),
  /** compat only: which search key the run used. Never the endpoint's address or model name. */
  searchProvider: z.enum(['brave', 'tavily']).optional(),
  ranOn: z.iso.date(),
  promptVersion: z.number().int().min(1),
  /** perspectives only: the reviewed registry's version. */
  registryVersion: z.string().max(40).optional(),
  serverVersion: z.string().max(40),
  items: z.number().int().min(1),
  gates: z.partialRecord(z.enum(GATE_NAMES), Gate),
  passed: z.boolean(),
  /** factcheck: share of items whose first verdict was accepted; perspectives: share whose covered buckets matched. */
  agreement: z.number().min(0).max(1),
  meanCostMicros: z.number().int().min(0).nullable(),
});
export type EvalRecord = z.infer<typeof EvalRecordSchema>;
export const EvalResultsSchema = z.array(EvalRecordSchema);

/** `packages/research/eval/results.json`. */
export const EVAL_RESULTS_FILE: URL = new URL('./results.json', import.meta.url);

/** What a run knows about itself besides its report. `ranOn` is stored as its UTC day only. */
export interface RecordMeta {
  mode: EvalRecord['mode'];
  searchProvider?: NonNullable<EvalRecord['searchProvider']>;
  ranOn: Date;
  promptVersion: number;
  registryVersion?: string;
  serverVersion: string;
}

type Gates = EvalRecord['gates'];

/** The record's fields in the schema's order; optional ones only when given. Parsed, so nothing invalid is written. */
function record(
  task: EvalRecord['task'],
  meta: RecordMeta,
  r: { total: number; meanCostMicros: number | undefined },
  gates: Gates,
  passed: boolean,
  agreement: number,
): EvalRecord {
  return EvalRecordSchema.parse({
    task,
    mode: meta.mode,
    ...(meta.searchProvider ? { searchProvider: meta.searchProvider } : {}),
    ranOn: meta.ranOn.toISOString().slice(0, 10),
    promptVersion: meta.promptVersion,
    ...(meta.registryVersion !== undefined ? { registryVersion: meta.registryVersion } : {}),
    serverVersion: meta.serverVersion,
    items: r.total,
    gates,
    passed,
    agreement,
    meanCostMicros: r.meanCostMicros === undefined ? null : Math.round(r.meanCostMicros),
  });
}

/** A gate's three fields, and nothing else the result may carry. */
const copy = ({ value, min, passed }: { value: number | null; min: number; passed: boolean | null }) => ({ value, min, passed });

/** A fact-check run's record: the report's counts and `trustGates`' results; its failures and links stay out. */
export function factcheckRecord(r: FactcheckEvalReport, g: ReturnType<typeof trustGates>, meta: RecordMeta): EvalRecord {
  const gates = { slantFlip: copy(g.slantFlip), provenance: copy(g.provenance), liveLinks: copy(g.liveLinks) };
  return record('factcheck', meta, r, gates, g.passed, r.agreement);
}

/** An UnEcho Chamber run's record: `perspectivesTrustGates`' results, agreement = items whose covered buckets matched. */
export function perspectivesRecord(
  r: PerspectivesEvalReport,
  g: ReturnType<typeof perspectivesTrustGates>,
  meta: RecordMeta,
): EvalRecord {
  const gates = { provenance: copy(g.provenance), leanIntegrity: copy(g.leanIntegrity), liveLinks: copy(g.liveLinks) };
  return record('perspectives', meta, r, gates, g.passed, r.coverageMatch);
}

/** `[0].gates.slantFlip` from a schema issue's path. */
function pathText(path: readonly PropertyKey[]): string {
  return path
    .map((key) => (typeof key === 'number' ? `[${key}]` : `.${String(key)}`))
    .join('')
    .replace(/^\./, '');
}

/** JSON text → records; throws an Error naming the first schema problem's path. */
export function parseEvalResults(text: string): EvalRecord[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('The eval results file is not JSON.');
  }
  const parsed = EvalResultsSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue ? pathText(issue.path) : '';
    throw new Error(`The eval results file is invalid at ${at || 'the top level'}: ${issue?.message ?? 'unknown problem'}`);
  }
  return parsed.data;
}
