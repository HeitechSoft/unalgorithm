import { type AIClient, AIError } from '@unalgorithm/ai';
import type { SourceList } from '@unalgorithm/outlets';
import { aiBucketSearcher, providerBucketSearcher } from './coverage.ts';
import { FACTCHECK_MODELS, type FactcheckDeps } from './factcheck.ts';
import { PERSPECTIVES_MODELS, type PerspectivesDeps } from './perspectives.ts';
import { aiRetriever } from './retriever.ts';
import { type SearchProvider, type SearchProviderId, searchRetriever } from './search.ts';

/**
 * The one place an own-key research mode becomes pipeline deps, so the extension and the trust-eval runner build exactly
 * the same thing. Own keys have no cost ceiling, and the browser never fetches a link: no `maxCostMicros`, `linkCheck`
 * or `resolveLink`.
 */
export type OwnKeyMode =
  | { kind: 'anthropic' }
  | { kind: 'openai' }
  | { kind: 'openai-compatible'; model: string; search: SearchProvider };

/** Decision D43: claims and story query on the small model, research and verdicts on the large one. */
export const OPENAI_FACTCHECK_MODELS = { claims: 'gpt-5-mini', research: 'gpt-5', verdict: 'gpt-5' } as const;
export const OPENAI_PERSPECTIVES_MODELS = { query: 'gpt-5-mini', search: 'gpt-5-mini', compare: 'gpt-5' } as const;

/** A search provider's failure, tagged so the extension can name the search key, not the AI, in its message. */
export class WebSearchFailure extends AIError {
  readonly provider: SearchProviderId;

  constructor(provider: SearchProviderId, cause: AIError) {
    super(cause.code, cause.message, {
      cause,
      ...(cause.usage ? { usage: cause.usage } : {}),
      ...(cause.retryAfterMs !== undefined ? { retryAfterMs: cause.retryAfterMs } : {}),
    });
    this.name = 'WebSearchFailure';
    this.provider = provider;
  }
}

/** `provider` with every AIError its search throws rethrown as a WebSearchFailure (an abort passes through as is). */
function tagFailures(provider: SearchProvider): SearchProvider {
  return {
    id: provider.id,
    async search(query, opts) {
      try {
        return await provider.search(query, opts);
      } catch (err) {
        if (err instanceof AIError && !(err instanceof WebSearchFailure)) throw new WebSearchFailure(provider.id, err);
        throw err;
      }
    },
  };
}

export function factcheckDepsForMode(client: AIClient, mode: OwnKeyMode): FactcheckDeps {
  switch (mode.kind) {
    case 'anthropic':
      return { client, retriever: aiRetriever(client, FACTCHECK_MODELS.research) };
    case 'openai':
      return {
        client,
        retriever: aiRetriever(client, OPENAI_FACTCHECK_MODELS.research),
        models: { ...OPENAI_FACTCHECK_MODELS },
      };
    case 'openai-compatible':
      // The search step has zero usage, priced at the model as on the server (P3-17).
      return {
        client,
        retriever: searchRetriever(tagFailures(mode.search)),
        models: { claims: mode.model, research: mode.model, verdict: mode.model },
      };
  }
}

export function perspectivesDepsForMode(client: AIClient, mode: OwnKeyMode, registry: SourceList): PerspectivesDeps {
  switch (mode.kind) {
    case 'anthropic':
      return { client, searcher: aiBucketSearcher(client, PERSPECTIVES_MODELS.search), registry };
    case 'openai':
      return {
        client,
        searcher: aiBucketSearcher(client, OPENAI_PERSPECTIVES_MODELS.search),
        registry,
        models: { ...OPENAI_PERSPECTIVES_MODELS },
      };
    case 'openai-compatible':
      return {
        client,
        searcher: providerBucketSearcher(tagFailures(mode.search)),
        registry,
        models: { query: mode.model, search: mode.model, compare: mode.model },
      };
  }
}
