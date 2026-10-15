/**
 * Scores `runFactcheck` on the fact-check eval set (F10, F25): verdict agreement, slant-flipped pair consistency, strict
 * citation provenance, live cited links and the real cost per check; `trustGates` turns a report into the RM4 verdict. Items run one at a time, so a live run never spends in parallel. A failure
 * is reported by item id and short codes (`verdict disputed not supported`, `error overloaded`), never by post text or
 * a provider's message. An error that measures the provider rather than the model (busy, unreachable, a refused key)
 * is listed in `providerErrors` and its item is left out of every ratio.
 */
import { type AIClient, AIError } from '@unalgorithm/ai';
import { neutralize } from '@unalgorithm/core';
import {
  type AIErrorCode,
  costMicros,
  type FactcheckResult,
  type FactcheckVerdict,
  type LinkStatus,
  type NormalizedUsage,
  type RetrievedSource,
  ZERO_USAGE,
} from '@unalgorithm/protocol';
import { type FactcheckDeps, type FactcheckRun, type LinkChecker, runFactcheck } from '../src/factcheck.ts';
import type { Retriever } from '../src/retriever.ts';
import { citationProblem } from '../src/validate.ts';
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
  /** Pairs with identical first-claim verdicts / pairs scored (1 when none). */
  pairConsistency: number;
  /** Pairs whose twins were both scored. */
  pairsScored: number;
  /** Shown citations that `traceCitations` traces to what the retriever returned in that run / shown (1 when none). */
  provenance: number;
  /** Citations shown over the run: the provenance ratio's denominator. */
  citationsShown: number;
  /** Cited URLs by link status, summed over items; null when the eval had no link checker. */
  links: { live: number; dead: number; unknown: number } | null;
  /** live / (live + dead); null when both are 0 or without a link checker. Unknown is not in the ratio. */
  liveLinks: number | null;
  /** Σ(stats.raw − stats.kept) / Σ stats.raw (diagnostic; 0 when nothing was cited). */
  droppedCitationRate: number;
  /** Mean spend per scored item at the requested models' prices, failed calls included; undefined when unpriced. */
  meanCostMicros: number | undefined;
  failures: { id: string; reason: string }[];
  providerErrors: AIErrorCode[];
}

export interface FactcheckEvalOptions {
  /** Checks the cited links after each item; the run itself never gets it, so dead citations are counted, not dropped. */
  linkCheck?: LinkChecker;
  /** Per item's link check; default 30 s. */
  linkTimeoutMs?: number;
}

/** RM4's trust gates (F25), and the least a run must measure before a gate can pass. */
export const TRUST_GATES = { slantFlip: 0.95, provenance: 1, liveLinks: 0.97, minPairs: 20, minCited: 20 } as const;

const DEFAULT_LINK_TIMEOUT_MS = 30_000;

const ratio = (num: number, den: number, empty: number) => (den === 0 ? empty : num / den);

/**
 * Pure: the shown citations of `result` and how many trace to `retrieved` (what the retriever returned in that run).
 * A citation traces when its source is in the result, that source's URL is the retrieved one with the same id, and its
 * quote passes `citationProblem` against the retrieved snippets. An independent re-check of `validateVerdicts`.
 */
export function traceCitations(
  result: FactcheckResult,
  retrieved: readonly RetrievedSource[],
): { shown: number; traced: number } {
  const shownSources = new Map(result.sources.map((s) => [s.id, s]));
  const recorded = new Map(retrieved.map((s) => [s.id, s]));
  let shown = 0;
  let traced = 0;
  for (const claim of result.claims) {
    for (const citation of claim.citations) {
      shown++;
      const source = shownSources.get(citation.sourceId);
      const original = recorded.get(citation.sourceId);
      if (source && original && source.url === original.url && citationProblem(citation.quote, original.snippets) === null) {
        traced++;
      }
    }
  }
  return { shown, traced };
}

/** Asks `linkCheck` about `urls` once; a URL it leaves out, or every URL when it rejects, counts as unknown. */
export async function checkCitedLinks(
  urls: readonly string[],
  linkCheck: LinkChecker,
  timeoutMs: number,
): Promise<{ live: number; dead: number; unknown: number; deadUrls: Set<string> }> {
  const counts = { live: 0, dead: 0, unknown: 0, deadUrls: new Set<string>() };
  const distinct = [...new Set(urls)];
  if (distinct.length === 0) return counts;
  let statuses: ReadonlyMap<string, LinkStatus> = new Map();
  try {
    statuses = await linkCheck(distinct, AbortSignal.timeout(timeoutMs));
  } catch {
    // A broken or slow checker answers nothing: every URL stays unknown.
  }
  for (const url of distinct) {
    const status = statuses.get(url);
    if (status === 'live') counts.live++;
    else if (status === 'dead') {
      counts.dead++;
      counts.deadUrls.add(url);
    } else counts.unknown++;
  }
  return counts;
}

export async function runFactcheckEval(
  deps: FactcheckDeps,
  items: readonly FactcheckEvalItem[] = FACTCHECK_EVAL_SET,
  opts: FactcheckEvalOptions = {},
): Promise<FactcheckEvalReport> {
  // The run never checks links itself: a checker in deps would drop dead citations before they are counted.
  const { linkCheck: _dropped, ...runDeps } = deps;
  /** A clone of every source the retriever returned for the current item, so a later mutation changes nothing. */
  let recorded: RetrievedSource[] = [];
  const retriever: Retriever = {
    async retrieve(req) {
      const res = await deps.retriever.retrieve(req);
      recorded.push(...structuredClone(res.sources));
      return res;
    },
  };
  const links = opts.linkCheck ? { live: 0, dead: 0, unknown: 0 } : null;
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
    recorded = [];
    try {
      run = await runFactcheck({ ...item.post, ref: item.id }, { ...runDeps, retriever }, { onUsage });
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
    const trace = traceCitations(result, recorded);
    shown += trace.shown;
    traced += trace.traced;
    if (links && opts.linkCheck) {
      const citedIds = new Set(result.claims.flatMap((c) => c.citations.map((x) => x.sourceId)));
      const cited = result.sources.filter((s) => citedIds.has(s.id));
      const checked = await checkCitedLinks(
        cited.map((s) => s.url),
        opts.linkCheck,
        opts.linkTimeoutMs ?? DEFAULT_LINK_TIMEOUT_MS,
      );
      links.live += checked.live;
      links.dead += checked.dead;
      links.unknown += checked.unknown;
      for (const s of cited) if (checked.deadUrls.has(s.url)) failures.push({ id: item.id, reason: `dead link ${s.id}` });
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
    pairsScored: pairs,
    provenance: ratio(traced, shown, 1),
    citationsShown: shown,
    links,
    liveLinks: links && links.live + links.dead > 0 ? links.live / (links.live + links.dead) : null,
    droppedCitationRate: ratio(raw - kept, raw, 0),
    meanCostMicros: cost === undefined || scored === 0 ? undefined : Math.round(cost / scored),
    failures,
    providerErrors: [...providerErrors],
  };
}

/** A gate's measured value and threshold; `passed` is null when the run did not measure enough to judge it. */
export interface GateResult {
  value: number | null;
  min: number;
  passed: boolean | null;
}

/** Pure: RM4's three trust gates on a report. No gate passes on what it did not measure; `passed` needs all three. */
export function trustGates(r: FactcheckEvalReport): {
  slantFlip: GateResult;
  provenance: GateResult;
  liveLinks: GateResult;
  passed: boolean;
} {
  const gate = (value: number | null, min: number, measured: boolean): GateResult => ({
    value,
    min,
    passed: measured && value !== null ? value >= min : null,
  });
  const answered = r.links ? r.links.live + r.links.dead : 0;
  const slantFlip = gate(r.pairConsistency, TRUST_GATES.slantFlip, r.pairsScored >= TRUST_GATES.minPairs);
  const provenance = gate(r.provenance, TRUST_GATES.provenance, r.citationsShown >= TRUST_GATES.minCited);
  const liveLinks = gate(
    r.links && answered > 0 ? r.links.live / answered : null,
    TRUST_GATES.liveLinks,
    r.links !== null && answered >= TRUST_GATES.minCited && r.links.unknown <= answered,
  );
  const passed = slantFlip.passed === true && provenance.passed === true && liveLinks.passed === true;
  return { slantFlip, provenance, liveLinks, passed };
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
