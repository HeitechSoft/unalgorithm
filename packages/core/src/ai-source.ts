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
  };
}

/** True when `offer` is for this server source's origin and it offers fact-check (with a price on a billing server). */
function serverCanFactcheck(baseUrl: string, offer: ServerOffer | null): boolean {
  if (!offer?.factcheck || (offer.billing && offer.factcheckPrice === null)) return false;
  try {
    return offer.origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * No source can do nothing; an own Anthropic key classifies and fact-checks with web search; a server source
 * fact-checks when its signed-in server offers it (`offer`, ignored for every other kind); every other kind only
 * classifies for now (openai and openai-compatible: RM4).
 */
export function sourceCapabilities(cfg: AISourceConfig | null, offer: ServerOffer | null = null): SourceCapabilities {
  if (!cfg) return { classify: false, factcheck: false, perspectives: false, webSearch: false };
  if (cfg.kind === 'anthropic') return { classify: true, factcheck: true, perspectives: false, webSearch: true };
  if (cfg.kind === 'server') {
    const factcheck = serverCanFactcheck(cfg.baseUrl, offer);
    return { classify: true, factcheck, perspectives: false, webSearch: factcheck };
  }
  return { classify: true, factcheck: false, perspectives: false, webSearch: false };
}
