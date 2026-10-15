import { type AIClient, AIError, toStrictJsonSchema } from '@unalgorithm/ai';
import { canonicalText, clipText, makeNonce } from '@unalgorithm/core';
import type { Registry } from '@unalgorithm/outlets';
import {
  LEAN_BUCKETS,
  type LeanBucket,
  MAX_MODEL_CHARS,
  PERSPECTIVES_WINDOW_DAYS,
  type PerspectivesResult,
  type SharedLink,
  SharedLinkSchema,
} from '@unalgorithm/protocol';
import { type BucketSearcher, type CoverageSearch, publishedAt, searchBuckets } from './coverage.ts';
import {
  buildComparisonUser,
  buildStoryUser,
  COMPARISON_SYSTEM,
  ComparisonSchema,
  PERSPECTIVES_PROMPT_VERSION,
  STORY_SYSTEM,
  StoryQuerySchema,
} from './perspectives-prompts.ts';
import { startRun, structuredStep, type UsageReport, untilAborted } from './run.ts';
import { type ComparisonStats, validateComparison } from './validate-perspectives.ts';

/**
 * "Other perspectives" (RM3): the one pipeline the extension (own key) and the server both run. From a shared link only
 * (URL and link-card title, never post text): canonical URL and ± 3-day window, a neutral story query from a small
 * model, one search per lean bucket on registry outlets, a comparison of the matched coverage with no tools, and the
 * validator. Lean labels come only from the registry the caller passes; no model is told about sides.
 */

export const PERSPECTIVES_MODELS = {
  query: 'claude-haiku-5-5',
  search: 'claude-haiku-5-5',
  compare: 'claude-sonnet-5-5',
} as const;

/** Same MV3 reasoning as FACTCHECK_DEADLINE_MS: a run ends inside a service worker's 5-minute message event. */
export const PERSPECTIVES_DEADLINE_MS = 240_000;

const MAX_QUERY_CHARS = 200;
const DAY_MS = 86_400_000;
const TIMEOUT_MESSAGE = 'The comparison took too long.';
const STORY_JSON_SCHEMA = toStrictJsonSchema(StoryQuerySchema);
const COMPARISON_JSON_SCHEMA = toStrictJsonSchema(ComparisonSchema);

export interface PerspectivesDeps {
  /** The story query and the comparison (structured, no tools). */
  client: AIClient;
  searcher: BucketSearcher;
  /** A registry already accepted by `usableRegistry`. */
  registry: Registry;
  models?: Partial<Record<keyof typeof PERSPECTIVES_MODELS, string>>;
  /** The server's canonical-URL resolution (P3-32); default none (the browser never fetches a link). Never throws. */
  resolveLink?: (url: string, signal: AbortSignal) => Promise<string | null>;
  now?: () => Date;
  nonce?: string;
  /** Default PERSPECTIVES_DEADLINE_MS; short in tests. */
  deadlineMs?: number;
  /** Stop before a model call once the run has cost this much (priced runs only). Default: none (own key). */
  maxCostMicros?: number;
}

export interface PerspectivesOptions {
  signal?: AbortSignal;
  /** Called after every model call and every bucket search, failed ones too. */
  onUsage?: (u: UsageReport) => void;
}

export interface PerspectivesRun {
  result: PerspectivesResult;
  /** Every call's cost at the requested models' prices; undefined when one of them has no price card. */
  costMicros: number | undefined;
  stats: {
    search: CoverageSearch['dropped'] & { failed: LeanBucket[]; unsearched: LeanBucket[] };
    comparison: ComparisonStats | null;
  };
}

/** Per-click ids that can identify the person who clicked, removed with every `utm_*` parameter. */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'li_fat_id',
  'igshid',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'mkt_tok',
]);

const isTracking = (name: string): boolean => {
  const key = name.toLowerCase();
  return key.startsWith('utm_') || TRACKING_PARAMS.has(key);
};

/**
 * http(s) only, ≤ 2,048 characters; host lowercased; default port, fragment and tracking parameters removed; null when
 * not a URL. The extension runs it before a link leaves the browser on the server path too (P3-38, decision D35).
 */
export function canonicalLink(raw: string): string | null {
  if (raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  const tracking = [...url.searchParams.keys()].filter(isTracking);
  // Deleting the last parameter also drops the `?`.
  for (const name of new Set(tracking)) url.searchParams.delete(name);
  return url.href.length <= 2048 ? url.href : null;
}

/** anchor = the URL's date when not after now, else now; from = anchor − 3 days; to = min(anchor + 3 days, now). */
export function storyWindow(url: string, now: Date): { from: Date; to: Date } {
  const dated = publishedAt(null, url, now);
  const anchor = dated && dated <= now ? dated : now;
  const span = PERSPECTIVES_WINDOW_DAYS * DAY_MS;
  return {
    from: new Date(anchor.getTime() - span),
    to: new Date(Math.min(anchor.getTime() + span, now.getTime())),
  };
}

const cleanQuery = (text: string): string => clipText(canonicalText(text).trim(), MAX_QUERY_CHARS);

export async function runPerspectives(
  link: SharedLink,
  deps: PerspectivesDeps,
  opts: PerspectivesOptions = {},
): Promise<PerspectivesRun> {
  // Step 1: a shared link and nothing else (a `text` field is refused, not stripped).
  const parsed = SharedLinkSchema.safeParse(link);
  const shared = parsed.success ? canonicalLink(parsed.data.url) : null;
  if (!parsed.success || !shared) throw new AIError('bad-request', 'This link cannot be compared.');
  const title = parsed.data.title;

  const models = { ...PERSPECTIVES_MODELS, ...deps.models };
  const nonce = deps.nonce ?? makeNonce();
  const now = deps.now ?? (() => new Date());
  const { registry } = deps;
  const guard = startRun({
    deadlineMs: deps.deadlineMs ?? PERSPECTIVES_DEADLINE_MS,
    timeoutMessage: TIMEOUT_MESSAGE,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(deps.maxCostMicros !== undefined ? { maxCostMicros: deps.maxCostMicros } : {}),
    ...(opts.onUsage ? { onUsage: opts.onUsage } : {}),
  });

  try {
    // Step 2: the server's resolution, when given; any failure keeps the link as shared.
    let url = shared;
    if (deps.resolveLink) {
      try {
        const resolved = await untilAborted(deps.resolveLink(shared, guard.signal), guard.signal);
        url = (resolved ? canonicalLink(resolved) : null) ?? shared;
      } catch {
        url = shared;
      }
    }
    guard.signal.throwIfAborted();

    // Step 3.
    const at = now();
    const { from, to } = storyWindow(url, at);

    // Step 4: the story query, from the URL and the title only.
    const story = await structuredStep(guard, deps.client, models.query, StoryQuerySchema, {
      system: STORY_SYSTEM,
      user: buildStoryUser({ url, title }, nonce),
      jsonSchema: STORY_JSON_SCHEMA,
      schemaName: 'perspectives_story',
      effort: 'low',
      maxOutputTokens: 200,
      timeoutMs: 30_000,
    });
    const query = cleanQuery(story.data.query) || cleanQuery(title ?? '');
    if (!query) throw new AIError('bad-request', 'This link has no story to compare.');

    // Step 5: one search per bucket; a provider search has zero usage, so it costs nothing.
    guard.checkCeiling();
    const coverage = await untilAborted(
      searchBuckets({
        query,
        from,
        to,
        registry,
        searcher: deps.searcher,
        nonce,
        now: at,
        exclude: url,
        signal: guard.signal,
        onUsage: (u) => guard.record(models.search, u.usage, u.failed),
      }),
      guard.signal,
    );
    const searchStats = { ...coverage.dropped, failed: coverage.failed, unsearched: coverage.unsearched };
    const base = {
      v: 1 as const,
      checkedAt: at.toISOString(),
      promptVersion: PERSPECTIVES_PROMPT_VERSION,
      registryVersion: registry.meta.version,
      story: { url, query, from: from.toISOString(), to: to.toISOString() },
    };

    // Step 6: nothing found, nothing to compare.
    if (coverage.sources.length === 0) {
      return {
        result: {
          ...base,
          model: clipText(story.model, MAX_MODEL_CHARS),
          coverage: LEAN_BUCKETS.map((bucket) => ({ bucket, sourceIds: [] })),
          agreed: [],
          differences: [],
          unique: [],
          sources: [],
        },
        costMicros: guard.cost,
        stats: { search: searchStats, comparison: null },
      };
    }

    // Step 7: the comparison, with no tools, then the validator.
    guard.checkCeiling();
    const comparison = await structuredStep(guard, deps.client, models.compare, ComparisonSchema, {
      system: COMPARISON_SYSTEM,
      user: buildComparisonUser({ url, title, query }, coverage.sources, nonce),
      jsonSchema: COMPARISON_JSON_SCHEMA,
      schemaName: 'perspectives_comparison',
      effort: 'medium',
      maxOutputTokens: 2_000,
      timeoutMs: 60_000,
    });
    const { stats, ...validated } = validateComparison({ sources: coverage.sources, comparison: comparison.data });
    return {
      result: { ...base, model: clipText(comparison.model, MAX_MODEL_CHARS), ...validated },
      costMicros: guard.cost,
      stats: { search: searchStats, comparison: stats },
    };
  } finally {
    guard.dispose();
  }
}
