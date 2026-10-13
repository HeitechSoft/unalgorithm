import { PROMPT_VERSION } from '@unalgorithm/core';
import { and, eq } from 'drizzle-orm';
import type { AiRoute } from '../../src/ai/routes.ts';
import type { Db } from '../../src/db/client.ts';
import { aiRoutes } from '../../src/db/schema.ts';
import { testConfig } from './test-app.ts';

/**
 * Tests only: an enabled route that has passed its eval for the current prompt version, so `resolveRoute` serves it
 * without an eval run. This is the one way past the eval gate, and nothing under `src` imports it. The default is the
 * test server's own provider (the mock OpenAI-compatible server, CL1-02); `overrides` change any column, including the
 * eval ones, to seed a route the gate refuses. The enabled route for the same task, if any, is disabled first.
 */
export async function seedPassingRoute(db: Db, overrides: Partial<typeof aiRoutes.$inferInsert> = {}): Promise<AiRoute> {
  const { ai } = testConfig();
  const values = {
    task: 'classify',
    provider: ai.provider,
    model: ai.model,
    baseUrl: ai.baseUrl ?? null,
    effort: 'low',
    dataPolicy: ai.dataPolicy,
    evalPassedAt: new Date(),
    evalAgreement: 1,
    evalPromptVersion: PROMPT_VERSION,
    ...overrides,
  };
  return db.transaction(async (tx) => {
    await tx
      .update(aiRoutes)
      .set({ enabled: false })
      .where(and(eq(aiRoutes.task, values.task), eq(aiRoutes.enabled, true)));
    const [route] = await tx.insert(aiRoutes).values(values).returning();
    if (!route) throw new Error('The route was not inserted.');
    return route;
  });
}
