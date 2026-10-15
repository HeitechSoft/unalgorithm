import { type AIClient, AIError } from '@unalgorithm/ai';
import type { NormalizedUsage, RetrievedSource } from '@unalgorithm/protocol';
import { buildResearchUser, RESEARCH_SYSTEM } from './prompts.ts';

export interface RetrieveRequest {
  claims: readonly { id: string; text: string }[];
  maxSearches: number;
  blockedDomains: readonly string[];
  nonce: string;
  signal?: AbortSignal;
}

export interface RetrieveResult {
  /** Untrusted: written by a model that read web pages. */
  notes: string;
  sources: RetrievedSource[];
  usage: NormalizedUsage;
  /** The model that answered. */
  model: string;
}

/** Finds sources for the claims. RM1 researches through Anthropic web search; RM2 adds a search-provider retriever. */
export interface Retriever {
  retrieve(req: RetrieveRequest): Promise<RetrieveResult>;
}

/** Research through `client.research` (Anthropic web search). Throws AIError('unsupported') when the client has none. */
export function aiRetriever(client: AIClient, model: string): Retriever {
  const research = client.research?.bind(client);
  if (!research) throw new AIError('unsupported', 'This AI source cannot search the web, so it cannot fact-check.');
  return {
    async retrieve(req) {
      const res = await research({
        model,
        system: RESEARCH_SYSTEM,
        user: buildResearchUser(req.claims, req.nonce),
        maxSearches: req.maxSearches,
        blockedDomains: req.blockedDomains,
        effort: 'medium',
        maxOutputTokens: 2_000,
        timeoutMs: 120_000,
        ...(req.signal ? { signal: req.signal } : {}),
      });
      return { notes: res.notes, sources: res.sources, usage: res.usage, model: res.model };
    },
  };
}
