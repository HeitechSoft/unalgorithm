import { AIError } from '@unalgorithm/ai';
import { EVAL_SET } from '@unalgorithm/ai/eval';
import { type MockVerdict, startMockOpenAI } from '@unalgorithm/ai/testing';
import { neutralize, PROMPT_VERSION } from '@unalgorithm/core';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { type AiRoute, resolveRoute, syncRouteFromConfig } from '../src/ai/routes.ts';
import { main } from '../src/cli/route-eval.ts';
import type { Db } from '../src/db/client.ts';
import { aiRoutes } from '../src/db/schema.ts';
import { createTestDb } from './support/db.ts';
import { captureLog } from './support/log.ts';
import { testConfig } from './support/test-app.ts';

/** Starting PGlite (Postgres compiled to WebAssembly) takes a moment, more on a busy CI runner. */
const PGLITE_TIMEOUT = 30_000;

/** Mocks and databases a test opened, closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** The eval items by their text as the mock reads it out of the prompt (escaped and trimmed by `neutralize`). */
const byText = new Map(EVAL_SET.map((item) => [neutralize(item.post.text), item]));

/** A provider that gives every eval post the answer its labels expect. */
function perfectVerdict(text: string): MockVerdict {
  const item = byText.get(text);
  if (!item) throw new Error('The mock was sent a post that is not in the eval set.');
  return { relevance: item.expect.relevance === 'high' ? 90 : 10, noise: [...item.expect.noise], topics: ['eval'] };
}

/**
 * A migrated database whose classify route is the mock provider's (stored as the server stores it at startup), and
 * `run()`, which runs `route-eval` against it with its output in `lines`. `env` adds server variables.
 */
async function setup(opts: { verdict?: (text: string) => MockVerdict; env?: Record<string, string> } = {}) {
  const mock = await startMockOpenAI(opts.verdict ? { verdict: opts.verdict } : {});
  cleanup.push(() => mock.close());
  const handle = await createTestDb();
  cleanup.push(() => handle.close());
  const config = testConfig({ AI_BASE_URL: mock.baseUrl, ...opts.env });
  const { log } = captureLog();
  const route = await syncRouteFromConfig(handle.db, config, log);
  const lines: string[] = [];
  const run = () => main([], { db: handle, config, out: (line) => lines.push(line) });
  return { db: handle.db, config, log, route, lines, run, mock };
}

async function routeRow(db: Db, id: string): Promise<AiRoute | undefined> {
  const [row] = await db.select().from(aiRoutes).where(eq(aiRoutes.id, id));
  return row;
}

async function notAvailable(promise: Promise<unknown>): Promise<void> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AIError);
  expect((err as AIError).code).toBe('not-available');
}

/** No output line quotes a post. */
function expectNoPostText(lines: string[]): void {
  const output = lines.join('\n');
  for (const item of EVAL_SET) expect(output).not.toContain(item.post.text.slice(0, 24));
}

describe('gate', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_route_eval_passes_and_opens_gate', async () => {
    const { db, config, log, route, lines, run, mock } = await setup({ verdict: perfectVerdict });
    await notAvailable(resolveRoute(db, 'classify', config.routeEvalMinAgreement, log));

    expect(await run()).toBe(0);
    expect(lines[0]).toMatch(/^route openai-compatible\/mock-model: agreement 1\.00 \(30\/30\), min 0\.80, PASSED, cost /);
    expect(lines).toHaveLength(1);
    // Five batches of six posts.
    expect(mock.bodies).toHaveLength(5);

    const row = await routeRow(db, route.id);
    expect(row?.evalAgreement).toBe(1);
    expect(row?.evalPromptVersion).toBe(PROMPT_VERSION);
    expect(row?.evalPassedAt).toBeInstanceOf(Date);
    expect((await resolveRoute(db, 'classify', config.routeEvalMinAgreement, log)).id).toBe(route.id);
  });

  it('test_route_eval_fails_below_min', async () => {
    const { db, config, log, route, lines, run } = await setup();

    expect(await run()).toBe(1);
    expect(lines[0]).toMatch(/^route openai-compatible\/mock-model: agreement 0\.\d\d \(\d+\/30\), min 0\.80, FAILED, cost /);
    // One line per failed item, with its id and short codes.
    const failures = lines.slice(1);
    expect(failures.length).toBeGreaterThan(0);
    for (const line of failures) expect(line).toMatch(/^ {2}e\d{2}: [a-z]/);
    expectNoPostText(lines);

    const row = await routeRow(db, route.id);
    expect(row?.evalPassedAt).toBeNull();
    expect(row?.evalAgreement).toBeLessThan(0.8);
    expect(row?.evalPromptVersion).toBe(PROMPT_VERSION);
    await notAvailable(resolveRoute(db, 'classify', config.routeEvalMinAgreement, log));
  });

  it('test_route_eval_uses_configured_min', async () => {
    const { db, config, log, route, lines, run } = await setup({ env: { ROUTE_EVAL_MIN_AGREEMENT: '0' } });
    expect(config.routeEvalMinAgreement).toBe(0);

    expect(await run()).toBe(0);
    const summary = lines[0]?.match(/agreement (\d\.\d\d) \((\d+)\/30\), min 0\.00, PASSED/);
    expect(summary).not.toBeNull();

    const row = await routeRow(db, route.id);
    // The measured agreement is stored, not the minimum.
    expect(row?.evalAgreement).toBeCloseTo(Number(summary?.[2]) / 30, 5);
    expect(row?.evalAgreement).toBeLessThan(0.8);
    expect(row?.evalPassedAt).toBeInstanceOf(Date);
    expect((await resolveRoute(db, 'classify', 0, log)).id).toBe(route.id);
    // The server's own minimum decides on every request: the default one still refuses this route.
    await notAvailable(resolveRoute(db, 'classify', 0.8, log));
  });

  it('test_route_eval_without_route', async () => {
    const handle = await createTestDb();
    cleanup.push(() => handle.close());
    const lines: string[] = [];

    expect(await main([], { db: handle, config: testConfig(), out: (line) => lines.push(line) })).toBe(1);
    expect(lines.join('\n')).toContain('no classify route');
  });

  it('test_route_eval_takes_no_flags', async () => {
    const lines: string[] = [];
    // The minimum is ROUTE_EVAL_MIN_AGREEMENT, the server's own; there is no flag to pass a lower one.
    expect(await main(['--min', '0.5'], { config: testConfig(), out: (line) => lines.push(line) })).toBe(1);
    expect(lines.join('\n')).toContain('ROUTE_EVAL_MIN_AGREEMENT');
  });
});
