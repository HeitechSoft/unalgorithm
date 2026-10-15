import type { NormalizedUsage, RetrievedSource } from '@unalgorithm/protocol';

export type StructuredMode = 'json-schema' | 'json-schema-loose' | 'json-object' | 'prompt-only' | 'on-device';

export interface StructuredRequest {
  model: string;
  /** Stable across requests so providers can cache it. */
  system: string;
  user: string;
  /** Strict JSON schema (see json-schema.ts). */
  jsonSchema: Record<string, unknown>;
  schemaName: string;
  effort: 'low' | 'medium';
  maxOutputTokens: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * A leading part of `system` that is the same for every user. Adapters with several cache breakpoints cache it
   * separately; others ignore it. When set, `system.startsWith(cachePrefix)` must hold.
   */
  cachePrefix?: string;
}

export interface StructuredResult {
  /** Raw JSON text from the model; the caller validates it. */
  text: string;
  usage: NormalizedUsage;
  /** The model that actually answered. */
  model: string;
  mode: StructuredMode;
}

export interface ResearchRequest {
  model: string;
  system: string;
  user: string;
  /** Tool `max_uses` across the whole call, continuations included. 1..MAX_FACTCHECK_SEARCHES. */
  maxSearches: number;
  blockedDomains: readonly string[];
  effort: 'low' | 'medium';
  maxOutputTokens: number;
  /** Budget for the whole call, continuations included (each continuation gets what is left). Default 120_000. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ResearchResult {
  /** The model's research notes (text blocks joined), clipped to 8,000 characters. Untrusted. */
  notes: string;
  sources: RetrievedSource[];
  usage: NormalizedUsage;
  model: string;
  /** `error_code`s of failed searches, e.g. 'unavailable'. */
  searchErrors: string[];
}

export interface ModelInfo {
  id: string;
  name: string;
  created?: number;
}

/** One way of reaching a model. Every vendor adapter implements this; the orchestrator does the rest. */
export interface AIClient {
  readonly kind: string;
  structured(req: StructuredRequest): Promise<StructuredResult>;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  /** Research with server-side web search. Only adapters that can search implement it (Anthropic in RM1). */
  research?(req: ResearchRequest): Promise<ResearchResult>;
}

/** What a model or endpoint turned out to accept, remembered across service-worker restarts. */
export interface Capabilities {
  noEffort?: boolean;
  noThinkingParam?: boolean;
  mode?: StructuredMode;
}

export interface CapabilityStore {
  get(key: string): Capabilities | undefined;
  set(key: string, caps: Capabilities): void;
}

export function memoryCapabilities(): CapabilityStore {
  const map = new Map<string, Capabilities>();
  return { get: (k) => map.get(k), set: (k, v) => void map.set(k, v) };
}
