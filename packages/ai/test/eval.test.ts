import { NOISE_LABELS, type NoiseLabel, PostForAISchema, ZERO_USAGE } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import { EVAL_PROFILE, EVAL_SET, type EvalItem } from '../eval/classify-set.ts';
import { runClassifyEval } from '../eval/score.ts';
import { AIError } from '../src/errors.ts';
import type { AIClient, StructuredRequest } from '../src/types.ts';

const byId = new Map(EVAL_SET.map((item) => [item.id, item]));

/** Common first names: one followed by a capitalised word reads as a person's full name. */
const FIRST_NAMES = [
  'James',
  'John',
  'Robert',
  'Michael',
  'David',
  'William',
  'Richard',
  'Thomas',
  'Daniel',
  'Mark',
  'Peter',
  'Paul',
  'Mary',
  'Patricia',
  'Jennifer',
  'Linda',
  'Elizabeth',
  'Sarah',
  'Jessica',
  'Karen',
  'Emma',
  'Anna',
  'Maria',
  'Laura',
  'Sophie',
];
const FULL_NAME = new RegExp(`\\b(?:${FIRST_NAMES.join('|')})\\s+[A-Z][a-z]+`);

/**
 * An AI client that answers every post of a request with `answer(item)`, found by the post's ref in the user turn.
 * Each call reports 100 input and 20 output tokens.
 */
function fakeClient(answer: (item: EvalItem) => { relevance: number; noise: NoiseLabel[] }) {
  const requests: StructuredRequest[] = [];
  const client: AIClient = {
    kind: 'fake',
    async structured(req) {
      requests.push(req);
      const results = [...req.user.matchAll(/ id="(e\d{2})"/g)].map(([, id = '']) => {
        const item = byId.get(id);
        if (!item) throw new Error(`unknown ref ${id}`);
        const { relevance, noise } = answer(item);
        return { id, topics: ['eval'], noise, reason: 'Fake verdict.', relevance, isNews: false, hasCheckableClaims: false };
      });
      return {
        text: JSON.stringify({ results }),
        usage: { ...ZERO_USAGE, uncachedInput: 100, output: 20 },
        model: 'answered-model',
        mode: 'json-schema',
      };
    },
    async listModels() {
      return [];
    },
  };
  return { client, requests };
}

/** A failure reason: one or more short codes, comma-separated. */
const CODE = '(?:relevance \\d{1,3} not (?:high|low)|missing [a-z-]+|unexpected [a-z-]+|error [a-z-]+|no result)';
const REASON = new RegExp(`^${CODE}(?:, ${CODE})*$`);

describe('set', () => {
  it('test_eval_set_composition', () => {
    expect(EVAL_SET).toHaveLength(30);
    expect(EVAL_SET.map((item) => item.id)).toEqual(Array.from({ length: 30 }, (_, i) => `e${String(i + 1).padStart(2, '0')}`));

    expect(EVAL_SET.filter((item) => item.expect.relevance === 'high')).toHaveLength(12);
    expect(EVAL_SET.filter((item) => item.expect.relevance === 'low')).toHaveLength(18);
    expect(EVAL_SET.filter((item) => item.expect.noise.length > 0).length).toBeGreaterThanOrEqual(8);
    for (const label of NOISE_LABELS) {
      expect(
        EVAL_SET.some((item) => item.expect.noise.includes(label)),
        label,
      ).toBe(true);
    }
    // A label is never both expected and ruled out.
    for (const item of EVAL_SET) {
      expect(
        item.expect.noise.filter((label) => item.expect.notNoise.includes(label)),
        item.id,
      ).toEqual([]);
    }

    const facebook = EVAL_SET.filter((item) => item.post.platform === 'facebook');
    expect(facebook).toHaveLength(6);
    for (const item of facebook) expect(item.post.audience, item.id).toBe('public');
    for (const item of EVAL_SET.filter((i) => i.post.platform !== 'facebook')) {
      expect(item.post.platform, item.id).toBe('linkedin');
    }

    for (const item of EVAL_SET) expect(PostForAISchema.safeParse({ ...item.post, ref: item.id }).success, item.id).toBe(true);

    expect(EVAL_PROFILE).toEqual({
      v: 1,
      interests: ['cloud costs', 'hiring', 'ai agents', 'local food'],
      lessOf: ['crypto'],
      about: '',
      examples: [],
    });
  });

  it('test_eval_set_is_invented', () => {
    // The guard itself catches what it is meant to.
    expect(FULL_NAME.test('Thanks to Sarah Jones for the tip.')).toBe(true);
    expect(FULL_NAME.test('Thanks to the team for the tip.')).toBe(false);

    for (const item of EVAL_SET) {
      const texts = [item.post.text, item.post.link?.domain ?? '', item.post.link?.title ?? ''];
      for (const text of texts) {
        expect(text, item.id).not.toMatch(/http/i);
        expect(text, item.id).not.toMatch(/www\./i);
        expect(text, item.id).not.toContain('@');
        expect(text, item.id).not.toMatch(/\d{7,}/);
        expect(text, item.id).not.toMatch(FULL_NAME);
      }
      // A shared link names only a reserved example domain.
      if (item.post.link) expect(item.post.link.domain, item.id).toMatch(/^example\.(?:org|net|com)$/);
    }
  });
});

describe('scoring', () => {
  it('test_perfect_client_scores_one', async () => {
    const { client, requests } = fakeClient((item) => ({
      relevance: item.expect.relevance === 'high' ? 90 : 10,
      noise: [...item.expect.noise],
    }));
    const report = await runClassifyEval(client, 'eval-model');

    expect(report).toMatchObject({ agreement: 1, passed: 30, total: 30, failures: [], providerErrors: [], model: 'eval-model' });
    // Five batches of six, each with the eval profile, every token counted.
    expect(requests).toHaveLength(5);
    for (const req of requests) {
      expect([...req.user.matchAll(/ id="(e\d{2})"/g)]).toHaveLength(6);
      expect(req.model).toBe('eval-model');
      expect(req.system).toContain('cloud costs');
      expect(req.system).toContain('crypto');
    }
    expect(report.usage).toEqual({ ...ZERO_USAGE, uncachedInput: 500, output: 100 });
  });

  it('test_flat_client_scores_zero_with_codes', async () => {
    const { client } = fakeClient(() => ({ relevance: 50, noise: [] }));
    const report = await runClassifyEval(client, 'eval-model');

    expect(report).toMatchObject({ agreement: 0, passed: 0, total: 30, providerErrors: [] });
    expect(report.failures.map((f) => f.id)).toEqual(EVAL_SET.map((item) => item.id));
    for (const { id, reason } of report.failures) {
      expect(reason, id).toMatch(REASON);
      const item = byId.get(id);
      expect(reason, id).toContain(`relevance 50 not ${item?.expect.relevance}`);
      for (const label of item?.expect.noise ?? []) expect(reason, id).toContain(`missing ${label}`);
    }
    // Every code is short and none quotes a post.
    const reasons = report.failures.map((f) => f.reason).join('\n');
    for (const item of EVAL_SET) expect(reasons).not.toContain(item.post.text.slice(0, 20));

    // A label the item rules out is reported by name.
    const ruledOut = EVAL_SET.find((item) => item.expect.notNoise.length > 0);
    const label = ruledOut?.expect.notNoise[0] ?? 'rage-bait';
    const tagged = await runClassifyEval(fakeClient(() => ({ relevance: 50, noise: [label] })).client, 'eval-model');
    expect(tagged.failures.find((f) => f.id === ruledOut?.id)?.reason).toContain(`unexpected ${label}`);

    // A provider error is reported by its code, never its message.
    const failing: AIClient = {
      kind: 'fake',
      async structured() {
        throw new AIError('overloaded', 'Overloaded while reading the post about cloud costs.');
      },
      async listModels() {
        return [];
      },
    };
    const errors = await runClassifyEval(failing, 'eval-model');
    expect(errors.agreement).toBe(0);
    expect(new Set(errors.failures.map((f) => f.reason))).toEqual(new Set(['error overloaded']));
  });

  it('test_provider_errors_reported_apart', async () => {
    // A provider that is busy for one batch only: those items fail, and the report says the provider failed.
    const { client: perfect } = fakeClient((item) => ({
      relevance: item.expect.relevance === 'high' ? 90 : 10,
      noise: [...item.expect.noise],
    }));
    let calls = 0;
    const flaky: AIClient = {
      kind: 'fake',
      async structured(req) {
        calls++;
        if (calls === 2) throw new AIError('rate-limit', 'Slow down.');
        return perfect.structured(req);
      },
      async listModels() {
        return [];
      },
    };
    const busy = await runClassifyEval(flaky, 'eval-model');
    expect(busy).toMatchObject({ passed: 24, total: 30, providerErrors: ['rate-limit'] });
    expect(busy.failures.map((f) => f.reason)).toEqual(Array(6).fill('error rate-limit'));

    // An answer the model got wrong is about the posts, not the provider: a failure, but not a provider error.
    const garbled: AIClient = {
      kind: 'fake',
      async structured() {
        return { text: 'not json', usage: ZERO_USAGE, model: 'answered-model', mode: 'json-schema' };
      },
      async listModels() {
        return [];
      },
    };
    const wrong = await runClassifyEval(garbled, 'eval-model');
    expect(wrong).toMatchObject({ agreement: 0, providerErrors: [] });
    expect(new Set(wrong.failures.map((f) => f.reason))).toEqual(new Set(['error bad-request']));
  });
});
