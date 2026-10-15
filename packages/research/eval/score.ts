/**
 * Scores `runFactcheck` on the fact-check eval set (F10): verdict agreement, slant-flipped pair consistency, citation
 * provenance and the real cost per check. Items run one at a time, so a live run never spends in parallel. A failure
 * is reported by item id and short codes (`verdict disputed not supported`, `error overloaded`), never by post text or
 * a provider's message. An error that measures the provider rather than the model (busy, unreachable, a refused key)
 * is listed in `providerErrors` and its item is left out of every ratio.
 */
import { type AIClient, AIError } from '@unalgorithm/ai';
import { neutralize } from '@unalgorithm/core';
import {
  type AIErrorCode,
  costMicros,
  type FactcheckVerdict,
  type NormalizedUsage,
  type RetrievedSource,
  ZERO_USAGE,
} from '@unalgorithm/protocol';
import { type FactcheckDeps, type FactcheckRun, runFactcheck } from '../src/factcheck.ts';
import type { Retriever } from '../src/retriever.ts';
import { FACTCHECK_EVAL_SET, type FactcheckEvalItem } from './factcheck-set.ts';

export { FACTCHECK_EVAL_SET, type FactcheckEvalItem } from './factcheck-set.ts';

/** Errors about the provider's state, not the model's answer: such an item measured nothing. */
export const PROVIDER_ERROR_CODES: ReadonlySet<AIErrorCode> = new Set<AIErrorCode>([
  'overloaded',
  'network',
  'auth',
  'quota',
  'rate-limit',
  'timeout',
]);

export interface FactcheckEvalReport {
  total: number;
  /** Items whose first claim's verdict is in `expect` / items scored. */
  agreement: number;
  /** Pairs with identical first-claim verdicts / pairs scored. */
  pairConsistency: number;
  /** Shown citations whose sourceId is in result.sources / shown citations (1 when none). */
  provenance: number;
  /** Σ(stats.raw − stats.kept) / Σ stats.raw (diagnostic; 0 when nothing was cited). */
  droppedCitationRate: number;
  /** Mean spend per scored item at the requested models' prices, failed calls included; undefined when unpriced. */
  meanCostMicros: number | undefined;
  failures: { id: string; reason: string }[];
  providerErrors: AIErrorCode[];
}

const ratio = (num: number, den: number, empty: number) => (den === 0 ? empty : num / den);

export async function runFactcheckEval(
  deps: FactcheckDeps,
  items: readonly FactcheckEvalItem[] = FACTCHECK_EVAL_SET,
): Promise<FactcheckEvalReport> {
  const failures: FactcheckEvalReport['failures'] = [];
  const providerErrors = new Set<AIErrorCode>();
  /** First-claim verdict of every scored item (undefined when it had none). */
  const verdicts = new Map<string, FactcheckVerdict | undefined>();
  let agreed = 0;
  let shown = 0;
  let traced = 0;
  let raw = 0;
  let kept = 0;
  let cost: number | undefined = 0;

  for (const item of items) {
    let itemCost: number | undefined = 0;
    const onUsage = ({ model, usage }: { model: string; usage: NormalizedUsage }) => {
      const c = costMicros(model, usage);
      itemCost = itemCost === undefined || c === undefined ? undefined : itemCost + c;
    };
    let run: FactcheckRun;
    try {
      run = await runFactcheck({ ...item.post, ref: item.id }, deps, { onUsage });
    } catch (err) {
      const code: AIErrorCode = err instanceof AIError ? err.code : 'unknown';
      failures.push({ id: item.id, reason: `error ${code}` });
      if (PROVIDER_ERROR_CODES.has(code)) {
        providerErrors.add(code);
        continue;
      }
      verdicts.set(item.id, undefined);
      cost = cost === undefined || itemCost === undefined ? undefined : cost + itemCost;
      continue;
    }
    cost = cost === undefined || itemCost === undefined ? undefined : cost + itemCost;

    const { result, stats } = run;
    const sourceIds = new Set(result.sources.map((s) => s.id));
    for (const claim of result.claims) {
      for (const citation of claim.citations) {
        shown++;
        if (sourceIds.has(citation.sourceId)) traced++;
      }
    }
    raw += stats.raw;
    kept += stats.kept;

    const verdict = result.claims[0]?.verdict;
    verdicts.set(item.id, verdict);
    if (verdict === undefined) failures.push({ id: item.id, reason: 'no claims' });
    else if (item.expect.includes(verdict)) agreed++;
    else failures.push({ id: item.id, reason: `verdict ${verdict} not ${item.expect.join('|')}` });
  }

  let pairs = 0;
  let consistent = 0;
  for (const item of items) {
    if (!item.pair || item.id > item.pair || !verdicts.has(item.id) || !verdicts.has(item.pair)) continue;
    pairs++;
    const a = verdicts.get(item.id);
    const b = verdicts.get(item.pair);
    if (a !== undefined && a === b) consistent++;
    else failures.push({ id: item.id, reason: `pair ${item.pair} ${a ?? 'none'} vs ${b ?? 'none'}` });
  }

  const scored = verdicts.size;
  return {
    total: items.length,
    agreement: ratio(agreed, scored, 0),
    pairConsistency: ratio(consistent, pairs, 1),
    provenance: ratio(traced, shown, 1),
    droppedCitationRate: ratio(raw - kept, raw, 0),
    meanCostMicros: cost === undefined || scored === 0 ? undefined : Math.round(cost / scored),
    failures,
    providerErrors: [...providerErrors],
  };
}

export interface MockOptions {
  /** The verdict given for an item's claim; undefined (the default) gives `expect[0]`. */
  verdict?: (item: FactcheckEvalItem) => FactcheckVerdict | undefined;
  /** An error thrown at the item's first call instead of answering. */
  fail?: (item: FactcheckEvalItem) => AIError | undefined;
  /** Overrides of the research call's usage (cost tests). */
  researchUsage?: Partial<NormalizedUsage>;
}

/** Usage chosen so a mock check costs about 113,000 micros at the default models' prices, near the typical $0.12. */
const CLAIMS_USAGE: NormalizedUsage = { ...ZERO_USAGE, uncachedInput: 1_000, output: 100 };
const RESEARCH_USAGE: NormalizedUsage = { ...ZERO_USAGE, uncachedInput: 30_000, output: 1_500, webSearches: 3 };
const VERDICT_USAGE: NormalizedUsage = { ...ZERO_USAGE, uncachedInput: 2_000, output: 400 };

const CLAIM_TAG = /\[eval (fc-\d+)\]/;

function evidence(id: string, n: number): string {
  return `Records reviewed for item ${id} address this claim in source ${n}.`;
}

/** Deterministic fake client + retriever built from the set: two sources on different domains per item, verdict = expect[0]. */
export function mockDepsFor(items: readonly FactcheckEvalItem[], opts: MockOptions = {}): FactcheckDeps {
  const byText = items.map((item) => ({ item, fenced: neutralize(item.post.text) }));
  const byId = new Map(items.map((item) => [item.id, item]));
  const itemIn = (text: string) => {
    const id = CLAIM_TAG.exec(text)?.[1];
    const item = id ? byId.get(id) : undefined;
    if (!item) throw new AIError('bad-request', 'The mock got a claim from outside the eval set.');
    return item;
  };

  const client: AIClient = {
    kind: 'eval-mock',
    async structured(req) {
      if (req.schemaName === 'factcheck_claims') {
        const item = byText.find((x) => req.user.includes(x.fenced))?.item;
        if (!item) throw new AIError('bad-request', 'The mock got a post from outside the eval set.');
        const error = opts.fail?.(item);
        if (error) throw error;
        const claims = [{ claim: `[eval ${item.id}] The main claim of this post.` }];
        return { text: JSON.stringify({ claims }), usage: CLAIMS_USAGE, model: req.model, mode: 'json-schema' };
      }
      const item = itemIn(req.user);
      const verdict = opts.verdict?.(item) ?? item.expect[0] ?? 'unverifiable';
      const citations = [1, 2].map((n) => ({ sourceId: `s${n}`, quote: `Records reviewed for item ${item.id}` }));
      const verdicts = [{ claimId: 'c1', verdict, explanation: 'Mock verdict from the eval set.', citations }];
      return { text: JSON.stringify({ verdicts }), usage: VERDICT_USAGE, model: req.model, mode: 'json-schema' };
    },
    async listModels() {
      return [];
    },
  };

  const retriever: Retriever = {
    async retrieve(req) {
      const item = itemIn(req.claims[0]?.text ?? '');
      const sources: RetrievedSource[] = (['example.com', 'example.org'] as const).map((domain, i) => ({
        id: `s${i + 1}`,
        url: `https://${item.id}.${domain}/evidence`,
        domain: `${item.id}.${domain}`,
        title: `Evidence ${i + 1} for ${item.id}`,
        pageAge: null,
        snippets: [evidence(item.id, i + 1)],
      }));
      return {
        notes: `c1: both sources address item ${item.id}.`,
        sources,
        usage: { ...RESEARCH_USAGE, ...opts.researchUsage },
        model: 'claude-sonnet-5-5',
      };
    },
  };

  return { client, retriever, now: () => new Date('2026-10-15T12:00:00.000Z') };
}
