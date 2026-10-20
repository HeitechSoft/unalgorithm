/**
 * The browser's built-in AI (`LanguageModel`, ADR 0003) with a stand-in Prompt API. Chromium builds without Google's
 * on-device runtime say a model is `available` and answer every prompt from a stand-in that echoes it; the client must
 * report that as a browser without a working model, never as a request someone rejected.
 */
import { buildInterestProfile, defaultSettings } from '@unalgorithm/core';
import type { PostForAI } from '@unalgorithm/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isNoWorkingModel, NO_WORKING_MODEL, onDeviceClient } from '../src/chrome-builtin/index.ts';
import { AIError, classifyPosts, describeError, type StructuredRequest } from '../src/index.ts';

const profile = buildInterestProfile(defaultSettings());
const OPTS = { model: 'chrome-built-in', profile, compact: true, nonce: 'n0nce' };
/** A direct client request, for errors classifyPosts would wrap. */
const REQ: StructuredRequest = {
  model: 'chrome-built-in',
  system: 's',
  user: 'u',
  jsonSchema: {},
  schemaName: 'x',
  effort: 'low',
  maxOutputTokens: 300,
};

const post = (ref: string): PostForAI => ({
  ref,
  platform: 'linkedin',
  text: `Post ${ref} about AI agents`,
  textComplete: true,
  authorKind: 'person',
  isReshare: false,
  media: 'none',
});

const item = (id: string) => ({
  id,
  topics: ['ai'],
  noise: [],
  reason: 'About AI.',
  relevance: 80,
  isNews: false,
  hasCheckableClaims: false,
});

/** What Chromium's stand-in model answers: the formatted prompt, then a tail that satisfies the schema. */
const echo = (system: string, user: string) =>
  `CPU backendFastest inferenceTopK: 64, Temp: 1System: ${system} End.User: ${user} End.Model: {"results":[]}`;

type Answer = (user: string, system: string) => string | Error;

/** A Prompt API whose sessions answer with `answer`. Counts sessions so tests can check every clone is destroyed. */
function stubLanguageModel(answer: Answer, opts: { createError?: Error } = {}) {
  const state = { created: 0, cloned: 0, destroyed: 0, constraints: [] as unknown[] };
  vi.stubGlobal('LanguageModel', {
    async availability() {
      return 'available';
    },
    async create(o: { initialPrompts?: { content: string }[] }) {
      if (opts.createError) throw opts.createError;
      state.created++;
      const system = o.initialPrompts?.[0]?.content ?? '';
      return {
        async prompt() {
          throw new Error('the base session is never prompted');
        },
        async clone() {
          state.cloned++;
          return {
            async prompt(user: string, p?: { responseConstraint?: unknown }) {
              state.constraints.push(p?.responseConstraint);
              const a = answer(user, system);
              if (a instanceof Error) throw a;
              return a;
            },
            async clone() {
              throw new Error('clones are not cloned');
            },
            destroy() {
              state.destroyed++;
            },
          };
        },
        destroy() {},
      };
    },
  });
  return state;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('on-device client', () => {
  it('test_on_device_echo_means_no_working_model', async () => {
    const state = stubLanguageModel((user, system) => echo(system, user));
    const out = await classifyPosts(onDeviceClient(), [post('p1'), post('p2')], OPTS);
    for (const ref of ['p1', 'p2']) {
      const r = out.byRef.get(ref);
      expect(r?.ok, ref).toBe(false);
      const error = (r as { error: AIError }).error;
      expect(error.code).toBe('not-available');
      expect(error.message).toBe(NO_WORKING_MODEL);
      expect(isNoWorkingModel(error)).toBe(true);
    }
    // The whole run stops at the first answer: no per-post retries against a model that isn't there.
    expect(out.calls).toBe(1);
    expect(out.failedCalls).toBe(1);
    expect(state.constraints).toHaveLength(1);
    expect(state.constraints[0]).toMatchObject({ type: 'object' });
    expect(state.destroyed).toBe(state.cloned);
    // What a person would have read before: the browser "rejected the request".
    expect(describeError('not-available')).not.toMatch(/rejected/);
  });

  it('test_on_device_plain_text_answer_is_no_working_model', async () => {
    stubLanguageModel(() => 'User: Reply with the single word: yes End.Model: ');
    const out = await classifyPosts(onDeviceClient(), [post('p1')], OPTS);
    expect(isNoWorkingModel((out.byRef.get('p1') as { error: AIError }).error)).toBe(true);
  });

  it('test_on_device_json_answer_classifies', async () => {
    const state = stubLanguageModel(() => `\n  ${JSON.stringify({ results: [item('p1'), item('p2')] })}\n`);
    const client = onDeviceClient();
    const out = await classifyPosts(client, [post('p1'), post('p2')], OPTS);
    expect(out.byRef.get('p1')).toMatchObject({ ok: true, classification: { relevance: 80, topics: ['ai'] } });
    expect(out.byRef.get('p2')?.ok).toBe(true);
    expect(out.mode).toBe('on-device');
    expect(out.model).toBe('chrome-built-in');
    expect(out.failedCalls).toBe(0);
    // One base session per system prompt; one clone per call, destroyed after it.
    await classifyPosts(client, [post('p1')], OPTS);
    expect(state.created).toBe(1);
    expect(state.cloned).toBe(2);
    expect(state.destroyed).toBe(2);
  });

  it('test_on_device_cut_off_answer_is_truncated', async () => {
    const state = stubLanguageModel(() => '{"results":[{"id":"p1","topics":["ai"');
    const out = await classifyPosts(onDeviceClient(), [post('p1'), post('p2')], OPTS);
    // A cut-off answer is about this call's posts: the batch is split, then each post fails on its own.
    expect(out.calls).toBe(3);
    for (const ref of ['p1', 'p2']) {
      const error = (out.byRef.get(ref) as { error: AIError }).error;
      expect(error.code, ref).toBe('truncated');
      expect(isNoWorkingModel(error)).toBe(false);
    }
    expect(state.destroyed).toBe(state.cloned);
  });

  it('test_on_device_prompt_errors_map_to_codes', async () => {
    for (const [name, code] of [
      ['QuotaExceededError', 'context-overflow'],
      ['NotSupportedError', 'unsupported'],
      ['AbortError', 'timeout'],
      ['OperationError', 'unknown'],
    ] as const) {
      const state = stubLanguageModel(() => new DOMException('stand-in', name));
      const err = await onDeviceClient()
        .structured(REQ)
        .catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(AIError);
      expect((err as AIError).code, name).toBe(code);
      expect(state.destroyed, name).toBe(1);
    }
  });

  it('test_on_device_create_errors_map_to_codes', async () => {
    stubLanguageModel(() => '{}', { createError: new DOMException('stand-in', 'NotSupportedError') });
    const client = onDeviceClient();
    await expect(client.structured(REQ)).rejects.toMatchObject({ code: 'unsupported' });
    // A failed create keeps no session: the next call tries again.
    const state = stubLanguageModel(() => '{}');
    await expect(client.structured(REQ)).resolves.toMatchObject({ text: '{}', mode: 'on-device' });
    expect(state.created).toBe(1);
  });

  it('test_on_device_without_prompt_api', async () => {
    const out = await classifyPosts(onDeviceClient(), [post('p1')], OPTS);
    const error = (out.byRef.get('p1') as { error: AIError }).error;
    expect(error.code).toBe('not-available');
    expect(isNoWorkingModel(error)).toBe(false);
  });
});
