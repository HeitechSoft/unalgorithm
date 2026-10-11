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
  server: { batch: 8, concurrency: 2, timeoutMs: 30_000, maxPostChars: 2000 },
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
