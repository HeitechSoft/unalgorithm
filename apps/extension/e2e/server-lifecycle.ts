import { type MockOpenAI, startMockOpenAI } from '@unalgorithm/ai/testing';
import { expect, test } from './fixtures.ts';
import { databaseExists, type LocalServer, startLocalServer } from './server-harness.ts';

/** A running server and the mock AI provider it classifies through. */
export interface StartedServer {
  ai: MockOpenAI;
  server: LocalServer;
}

/**
 * A real server and its mock AI provider for the enclosing `test.describe` (CL1-20): started in `beforeAll`, with `env`
 * added to the server's (`startLocalServer`), and stopped in `afterAll`, also when a test failed. `afterAll` then checks
 * the cleanup (`test_harness_cleans_up`, `test_credits_harness_cleans_up`): the process exited and the run's own
 * `ua_e2e_*` database is gone. Returns the running pair for the group's tests; `route-eval` has already used the mock.
 */
export function useLocalServer(env?: Readonly<Record<string, string>>): () => StartedServer {
  let ai: MockOpenAI | undefined;
  let server: LocalServer | undefined;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    ai = await startMockOpenAI();
    server = await startLocalServer({ aiBaseUrl: ai.baseUrl, env });
  });

  test.afterAll(async () => {
    test.setTimeout(60_000);
    try {
      await server?.stop();
    } finally {
      await ai?.close();
    }
    if (!server) return;
    expect(server.exited()).toBe(true);
    expect(server.database).toMatch(/^ua_e2e_[0-9a-f]{12}$/);
    expect(new URL(server.env.DATABASE_URL ?? '').pathname).toBe(`/${server.database}`);
    expect(await databaseExists(server.database)).toBe(false);
  });

  return () => {
    if (!ai || !server) throw new Error('beforeAll did not start the server');
    return { ai, server };
  };
}
