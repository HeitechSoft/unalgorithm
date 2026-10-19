import type { NormalizedUsage } from '@unalgorithm/protocol';
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
 * The message of the error a browser gets when its Prompt API answers without a model behind it. Chromium builds
 * without Google's on-device runtime say `availability()` is `available` (the model component downloads all the same)
 * but answer every prompt from a stand-in that echoes it back: "CPU backend…System: … End.User: … End.Model: {…}"
 * (Chromium's `services/on_device_model/fake`). ADR 0003.
 */
export const NO_WORKING_MODEL = 'This browser has no working on-device model.';

/** True for the error a browser without a working on-device model gets (`NO_WORKING_MODEL`). */
export function isNoWorkingModel(err: unknown): boolean {
  return err instanceof AIError && err.code === 'not-available' && err.message === NO_WORKING_MODEL;
}

/** The Prompt API's DOMExceptions, as AI errors. */
function promptError(err: unknown): AIError {
  if (err instanceof AIError) return err;
  const name = (err as { name?: string })?.name;
  if (name === 'QuotaExceededError')
    return new AIError('context-overflow', 'Too much text for the on-device model.', { cause: err });
  if (name === 'NotSupportedError') return new AIError('unsupported', 'The on-device model cannot do this.', { cause: err });
  if (name === 'AbortError') return new AIError('timeout', 'The on-device model took too long.', { cause: err });
  return new AIError('unknown', String(err), { cause: err });
}

/**
 * Throws when an answer shows there is no working model. With `responseConstraint` a model can only answer with the
 * schema's JSON object, so an answer that doesn't even start as one came from no model (`NO_WORKING_MODEL`), and the
 * source cannot work: `not-available` stops the run and pauses AI. One that starts as JSON but doesn't parse was cut
 * off, which is about this call's posts (`truncated` splits the batch).
 */
function checkAnswer(text: string, usage: NormalizedUsage): void {
  const body = text.trim();
  if (!body.startsWith('{')) throw new AIError('not-available', NO_WORKING_MODEL, { usage });
  try {
    JSON.parse(body);
  } catch (cause) {
    throw new AIError('truncated', "The on-device model's answer was cut off.", { usage, cause });
  }
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
    base = undefined;
    const session = await lm.create({ ...LANGS, initialPrompts: [{ role: 'system', content: system }] });
    base = { system, session };
    return session;
  }

  async function run(req: StructuredRequest): Promise<StructuredResult> {
    let session: LanguageModelSession;
    try {
      session = await (await baseSession(req.system)).clone(req.signal ? { signal: req.signal } : {});
    } catch (err) {
      throw promptError(err);
    }
    let text: string;
    try {
      text = await session.prompt(req.user, {
        responseConstraint: req.jsonSchema,
        ...(req.signal ? { signal: req.signal } : {}),
      });
    } catch (err) {
      throw promptError(err);
    } finally {
      session.destroy();
    }
    const usage: NormalizedUsage = {
      uncachedInput: Math.ceil(req.user.length / 4),
      cacheRead: Math.ceil(req.system.length / 4),
      cacheWrite: 0,
      output: Math.ceil(text.length / 4),
      webSearches: 0,
      estimated: true,
    };
    // After the `try`: these errors are about the answer, not the call.
    checkAnswer(text, usage);
    return { text, usage, model: 'chrome-built-in', mode: 'on-device' };
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
