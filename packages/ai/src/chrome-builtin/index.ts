import { AIError } from '../errors.ts';
import type { AIClient, StructuredRequest, StructuredResult } from '../types.ts';

/** Minimal typings for the browser's built-in Prompt API (`LanguageModel`: Chrome's Gemini Nano, Edge's preview). */
interface LanguageModelSession {
  prompt(input: string, opts?: { responseConstraint?: unknown; signal?: AbortSignal }): Promise<string>;
  clone(opts?: { signal?: AbortSignal }): Promise<LanguageModelSession>;
  destroy(): void;
}

interface LanguageModelStatic {
  availability(opts?: Record<string, unknown>): Promise<'unavailable' | 'downloadable' | 'downloading' | 'available'>;
  create(opts?: {
    initialPrompts?: { role: 'system' | 'user' | 'assistant'; content: string }[];
    expectedInputs?: { type: 'text'; languages: string[] }[];
    expectedOutputs?: { type: 'text'; languages: string[] }[];
    monitor?: (m: EventTarget) => void;
    signal?: AbortSignal;
  }): Promise<LanguageModelSession>;
}

export type OnDeviceAvailability = 'no-api' | 'unavailable' | 'downloadable' | 'downloading' | 'available';

const LANGS = {
  expectedInputs: [{ type: 'text' as const, languages: ['en'] }],
  expectedOutputs: [{ type: 'text' as const, languages: ['en'] }],
};

function api(): LanguageModelStatic | undefined {
  return (globalThis as { LanguageModel?: LanguageModelStatic }).LanguageModel;
}

export async function onDeviceAvailability(): Promise<OnDeviceAvailability> {
  const lm = api();
  if (!lm) return 'no-api';
  try {
    return await lm.availability(LANGS);
  } catch {
    return 'unavailable';
  }
}

/**
 * Start (or finish) the one-time model download. Must be called from a click: the browser requires a user gesture.
 * `onProgress` receives 0..1.
 */
export async function downloadOnDeviceModel(onProgress: (p: number) => void): Promise<void> {
  const lm = api();
  if (!lm) throw new AIError('not-available', "This browser doesn't have built-in AI.");
  const session = await lm.create({
    ...LANGS,
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => onProgress((e as Event & { loaded: number }).loaded));
    },
  });
  session.destroy();
}

/**
 * The browser's on-device model: free, private, offline. One base session per system prompt; each batch runs in a
 * clone, which is the on-device equivalent of prompt caching. Calls run one at a time.
 */
export function onDeviceClient(): AIClient {
  let base: { system: string; session: LanguageModelSession } | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  async function baseSession(system: string): Promise<LanguageModelSession> {
    const lm = api();
    if (!lm) throw new AIError('not-available', "This browser doesn't have built-in AI.");
    if (base?.system === system) return base.session;
    base?.session.destroy();
    const session = await lm.create({ ...LANGS, initialPrompts: [{ role: 'system', content: system }] });
    base = { system, session };
    return session;
  }

  async function run(req: StructuredRequest): Promise<StructuredResult> {
    const session = await (await baseSession(req.system)).clone(req.signal ? { signal: req.signal } : {});
    try {
      const text = await session.prompt(req.user, {
        responseConstraint: req.jsonSchema,
        ...(req.signal ? { signal: req.signal } : {}),
      });
      return {
        text,
        usage: {
          uncachedInput: Math.ceil(req.user.length / 4),
          cacheRead: Math.ceil(req.system.length / 4),
          cacheWrite: 0,
          output: Math.ceil(text.length / 4),
          webSearches: 0,
          estimated: true,
        },
        model: 'chrome-built-in',
        mode: 'on-device',
      };
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === 'QuotaExceededError')
        throw new AIError('context-overflow', 'Too much text for the on-device model.', { cause: err });
      if (name === 'NotSupportedError') throw new AIError('unsupported', 'The on-device model cannot do this.', { cause: err });
      if (name === 'AbortError') throw new AIError('timeout', 'The on-device model took too long.', { cause: err });
      throw new AIError('unknown', String(err), { cause: err });
    } finally {
      session.destroy();
    }
  }

  return {
    kind: 'on-device',
    structured(req) {
      const next = chain.then(() => run(req));
      chain = next.catch(() => undefined);
      return next;
    },
    async listModels() {
      return [{ id: 'chrome-built-in', name: 'Built-in AI' }];
    },
  };
}
