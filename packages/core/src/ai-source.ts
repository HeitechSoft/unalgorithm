import type { JobPrice, ServerInfo } from '@unalgorithm/protocol';
import { z } from 'zod';

/** OpenAI-compatible endpoints we ship presets for. `custom` is any other server. */
export const COMPAT_PRESETS = ['ollama', 'lmstudio', 'gemini', 'openrouter', 'groq', 'heitech-private', 'custom'] as const;
export type CompatPreset = (typeof COMPAT_PRESETS)[number];

/**
 * Where AI runs. Device-local (never synced): each machine chooses its own source, and keys never leave it.
 * `server` covers both UnAlgorithm Cloud and self-hosted UnAlgorithm servers (Phase 2).
 */
export const AISourceConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('on-device') }),
  z.object({ kind: z.literal('anthropic'), model: z.string().nullable() }),
  z.object({ kind: z.literal('openai'), model: z.string().nullable() }),
  z.object({
    kind: z.literal('openai-compatible'),
    preset: z.enum(COMPAT_PRESETS),
    baseUrl: z.string().url(),
    auth: z.enum(['none', 'bearer']),
    model: z.string().nullable(),
  }),
  z.object({ kind: z.literal('server'), baseUrl: z.string().url() }),
]);
export type AISourceConfig = z.infer<typeof AISourceConfigSchema>;
export type AISourceKind = AISourceConfig['kind'];

/** Per-source limits. Local models get smaller batches and longer timeouts. */
export const SOURCE_LIMITS: Record<
  AISourceKind,
  { batch: number; concurrency: number; timeoutMs: number; maxPostChars: number }
> = {
  'on-device': { batch: 2, concurrency: 1, timeoutMs: 60_000, maxPostChars: 1200 },
  anthropic: { batch: 6, concurrency: 2, timeoutMs: 30_000, maxPostChars: 2000 },
  openai: { batch: 6, concurrency: 2, timeoutMs: 30_000, maxPostChars: 2000 },
  'openai-compatible': { batch: 4, concurrency: 1, timeoutMs: 60_000, maxPostChars: 2000 },
  // One server request can make several provider calls; must exceed the server's 25 s request deadline (CL1-14) and
  // nginx's 60 s proxy_read_timeout (CL1-33), so the extension never gives up on (and re-sends) a batch still metered.
  server: { batch: 8, concurrency: 2, timeoutMs: 90_000, maxPostChars: 2000 },
};

/** Stable id for caches and capability learning: kind plus endpoint. */
export function sourceId(cfg: AISourceConfig): string {
  switch (cfg.kind) {
    case 'openai-compatible':
      return `compat:${cfg.baseUrl}`;
    case 'server':
      return `server:${cfg.baseUrl}`;
    default:
      return cfg.kind;
  }
}

/** True when the source runs on this computer or the user's own network: no per-call cost, no daily cap. */
export function isLocalSource(cfg: AISourceConfig): boolean {
  if (cfg.kind === 'on-device') return true;
  if (cfg.kind !== 'openai-compatible') return false;
  try {
    const host = new URL(cfg.baseUrl).hostname;
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '[::1]' ||
      host.endsWith('.local') ||
      /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  } catch {
    return false;
  }
}

/** What a source can do, task by task. Capabilities decide which buttons appear. */
export interface SourceCapabilities {
  classify: boolean;
  factcheck: boolean;
  perspectives: boolean;
  webSearch: boolean;
}

/** What the signed-in server offers, derived from its discovery document. No email, device id or token. */
export interface ServerOffer {
  origin: string;
  billing: boolean;
  factcheck: boolean;
  factcheckPrice: JobPrice | null;
  perspectives: boolean;
  perspectivesPrice: JobPrice | null;
}

/** Null without an account or while it needs signing in again. */
export function serverOfferFrom(account: { origin: string; info: ServerInfo; needsSignIn: boolean } | null): ServerOffer | null {
  if (!account || account.needsSignIn) return null;
  const { origin, info } = account;
  return {
    origin,
    billing: info.billing,
    factcheck: info.capabilities.factcheck === true,
    factcheckPrice: info.jobPrices?.factcheck ?? null,
    perspectives: info.capabilities.perspectives === true,
    perspectivesPrice: info.jobPrices?.perspectives ?? null,
  };
}

/** An on-demand job task a server may offer. */
export type ServerJobTask = 'factcheck' | 'perspectives';

/** The price a server offer carries for `task` (null when it advertises none). */
export function offerPrice(task: ServerJobTask, offer: ServerOffer): JobPrice | null {
  return task === 'factcheck' ? offer.factcheckPrice : offer.perspectivesPrice;
}

/** True when `offer` is for this server source's origin and it offers `task` (with a price on a billing server). */
function serverCan(task: ServerJobTask, baseUrl: string, offer: ServerOffer | null): boolean {
  if (!offer?.[task] || (offer.billing && offerPrice(task, offer) === null)) return false;
  try {
    return offer.origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/** In-extension web search for OpenAI-compatible sources (F24). SearXNG stays server-only. */
export const WEB_SEARCH_PROVIDERS = ['brave', 'tavily'] as const;
export type WebSearchProviderId = (typeof WEB_SEARCH_PROVIDERS)[number];
/** Device-local, never synced or exported; the key itself is a secret in IndexedDB (`search:<provider>`, P3-45). */
export const WebSearchKeySchema = z.object({ provider: z.enum(WEB_SEARCH_PROVIDERS) });
export type WebSearchKey = z.infer<typeof WebSearchKeySchema>;

const WEB_SEARCH: Record<WebSearchProviderId, { name: string; origin: string }> = {
  brave: { name: 'Brave', origin: 'https://api.search.brave.com' },
  tavily: { name: 'Tavily', origin: 'https://api.tavily.com' },
};

/** The API origin each provider is reached at; the optional host permission asked for from a click (P3-45). */
export function webSearchOrigin(p: WebSearchProviderId): string {
  return WEB_SEARCH[p].origin;
}

/** The provider's name as shown to people: "Brave", "Tavily". */
export function webSearchName(p: WebSearchProviderId): string {
  return WEB_SEARCH[p].name;
}

/**
 * No source can do nothing; an own Anthropic or OpenAI key classifies, fact-checks and compares perspectives with its
 * provider's web search; an OpenAI-compatible source does so only with this device's web search key (`webSearch`,
 * ignored for every other kind); a server source does each job task its signed-in server offers (`offer`, ignored for
 * every other kind); on-device only classifies.
 */
export function sourceCapabilities(
  cfg: AISourceConfig | null,
  offer: ServerOffer | null = null,
  webSearch: WebSearchKey | null = null,
): SourceCapabilities {
  const all = { classify: true, factcheck: true, perspectives: true, webSearch: true };
  if (!cfg) return { classify: false, factcheck: false, perspectives: false, webSearch: false };
  if (cfg.kind === 'anthropic' || cfg.kind === 'openai') return all;
  if (cfg.kind === 'openai-compatible' && webSearch) return all;
  if (cfg.kind === 'server') {
    const factcheck = serverCan('factcheck', cfg.baseUrl, offer);
    const perspectives = serverCan('perspectives', cfg.baseUrl, offer);
    return { classify: true, factcheck, perspectives, webSearch: factcheck || perspectives };
  }
  return { classify: true, factcheck: false, perspectives: false, webSearch: false };
}
