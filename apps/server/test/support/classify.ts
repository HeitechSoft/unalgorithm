import { CLASSIFY_PATH, type InterestProfile, type PostForAI } from '@unalgorithm/protocol';
import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import type { Db } from '../../src/db/client.ts';
import { usageEvents } from '../../src/db/schema.ts';
import type { App } from '../../src/http/app.ts';
import { DEV_EXTENSION_ORIGIN, postJson } from './sign-in.ts';

/** A plain interest profile for classify requests whose profile does not matter to the test. */
export const TEST_PROFILE: InterestProfile = {
  v: 1,
  interests: ['automation', 'hiring'],
  lessOf: ['politics'],
  about: 'I lead a small engineering team.',
  examples: [],
};

/**
 * A post as the extension sends it to a server, LinkedIn unless `over` says otherwise. The extension's refs are
 * batch-local (`p1`…); these are distinctive (`ref-<key>`) so one that leaks into a prompt or a log shows.
 */
export async function serverPost(key: string, text: string, over: Partial<PostForAI> = {}): Promise<PostForAI> {
  return {
    ref: `ref-${key}`,
    platform: 'linkedin',
    text,
    textComplete: true,
    authorKind: 'person',
    isReshare: false,
    media: 'none',
    ...over,
  };
}

/** A classify request body for these posts; `extra` adds fields at the top level. */
export function classifyBody(posts: PostForAI[], profile: InterestProfile = TEST_PROFILE, extra: Record<string, unknown> = {}) {
  return { v: 1, posts, profile, profileHash: 'h1', locale: 'en-CA', ...extra };
}

/** `POST /v1/classify` from the extension with this access token, or without one when `token` is null. */
export function postClassify(app: App, body: unknown, token: string | null): Promise<Response> {
  return postJson(app, CLASSIFY_PATH, body, {
    Origin: DEV_EXTENSION_ORIGIN,
    ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
  });
}

/** The one usage row of the request that got `res`, found by its `X-Request-Id`. */
export async function usageRowOf(db: Db, res: Response) {
  const rid = res.headers.get('x-request-id') ?? '';
  const rows = await db.select().from(usageEvents).where(eq(usageEvents.requestId, rid));
  expect(rows).toHaveLength(1);
  return rows[0]!;
}
