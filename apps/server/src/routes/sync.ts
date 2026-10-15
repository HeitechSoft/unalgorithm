/**
 * Sync on the wire (R14, R15), for a signed-in device on every server alike: the spaces an account can read, the
 * changes in a space since a cursor, and pushes of changed items. A changes request with nothing new may wait up to
 * `SYNC_MAX_WAIT_SECONDS`, and is answered the moment another device pushes to the same space (`SpaceNotifier`); no
 * database connection is held while it waits. Sync takes device tokens only: the account page never syncs.
 *
 * Logs hold counts and refusal reasons only, never a key, a value, a space id or an HLC: they describe a person's own
 * settings. Refusals answer fixed messages that echo nothing and name no server.
 */
import { createRoute } from '@hono/zod-openapi';
import { AIError } from '@unalgorithm/ai';
import {
  SYNC_CHANGES_PATH,
  SYNC_PUSH_PATH,
  SYNC_SPACES_PATH,
  SyncChangesQuerySchema,
  SyncChangesResponseSchema,
  type SyncError,
  type SyncErrorCode,
  SyncErrorSchema,
  SyncPushRequestSchema,
  SyncPushResponseSchema,
  SyncSpacesResponseSchema,
} from '@unalgorithm/protocol';
import { createRateLimiter } from '../ai/limits.ts';
import { type DeviceAccount, requireDevice } from '../auth/bearer.ts';
import type { App, AppDeps } from '../http/app.ts';
import { createSpaceNotifier } from '../sync/notifier.ts';
import { applyPush } from '../sync/push.ts';
import { findSpace, listSpaces, readChanges, type SyncPrincipal, SyncRefusal } from '../sync/spaces.ts';
import { errorResponse, json } from './openapi.ts';

/**
 * Changes and pushes a minute per account, together; listing spaces is not limited. Room for a back-to-back 20-second
 * long-poll loop, the extension's 30-second alarm and pushes from two open pages.
 */
export const SYNC_REQUESTS_PER_MINUTE = 120;

const MESSAGES: Record<SyncErrorCode, string> = {
  'resync-required': "Sync must start again from this server's copy.",
  'quota-exceeded': 'Your synced settings are larger than this server allows.',
  'read-only': "This space can't be changed from here.",
  'not-found': 'Not found.',
};

const syncError = (code: SyncErrorCode): SyncError => ({ code, message: MESSAGES[code] });

/** A sync refusal: the `SyncErrorSchema` body. */
const refusalResponse = (description: string) => ({ description, content: json(SyncErrorSchema) });

const principal = ({ userId, deviceId }: DeviceAccount): SyncPrincipal => ({ userId, deviceId });

/** Mounts the spaces, changes and push routes on the app. */
export function syncRoutes(app: App, deps: AppDeps): void {
  const { db, log, syncAccess } = deps;
  const notifier = deps.syncNotifier ?? createSpaceNotifier();
  // A stopping server answers its long-polls at once (their first, empty read) instead of holding the stop open.
  deps.stopping?.addEventListener('abort', () => notifier.close(), { once: true });
  // One per app, so the buckets last as long as the server process; apart from classify's, so sync never uses up AI.
  const limiter = createRateLimiter({ perMinute: SYNC_REQUESTS_PER_MINUTE });

  const takeRequest = (userId: string) => {
    const rate = limiter.take(userId);
    if (!rate.ok) throw new AIError('rate-limit', 'Too many sync requests.', { retryAfterMs: rate.retryAfterMs });
  };

  /** Logs a refusal by its reason: a 410 says why the cursor cannot be trusted, a 413 that a space is full. */
  const logRefusal = (rid: string, err: SyncRefusal) => {
    if (err.status === 410) log.info('sync.resync', { rid, reason: err.reason });
    else if (err.status === 413) log.warn('sync.quota', { rid });
  };

  app.openapi(
    createRoute({
      method: 'get',
      path: SYNC_SPACES_PATH,
      middleware: [requireDevice(deps)] as const,
      responses: {
        200: { description: 'The spaces this account can read', content: json(SyncSpacesResponseSchema) },
        401: errorResponse('No valid device token'),
      },
    }),
    async (c) => {
      c.header('Cache-Control', 'no-store');
      const spaces = await listSpaces(db.db, principal(c.var.account), syncAccess);
      return c.json({ v: 1 as const, spaces }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: SYNC_CHANGES_PATH,
      middleware: [requireDevice(deps)] as const,
      request: { query: SyncChangesQuerySchema },
      responses: {
        200: { description: 'The changes after the cursor, a page at a time', content: json(SyncChangesResponseSchema) },
        400: errorResponse('The request was not valid'),
        401: errorResponse('No valid device token'),
        404: refusalResponse('No such space for this account (not-found)'),
        410: refusalResponse('The cursor cannot be trusted: download the space again from 0 (resync-required)'),
        429: errorResponse('Too many sync requests this minute (rate-limit)'),
      },
    }),
    async (c) => {
      c.header('Cache-Control', 'no-store');
      const rid = c.get('rid');
      const who = principal(c.var.account);
      const q = c.req.valid('query');
      takeRequest(who.userId);
      const found = await findSpace(db.db, q.spaceId, who, syncAccess);
      if (!found) return c.json(syncError('not-found'), 404);
      // Keyed by the stored id, as pushes notify it: the client may write a uuid in either case.
      const spaceId = found.space.id;
      // Before the read: a push that commits between the read and the wait still wakes this request.
      const sub = q.wait > 0 ? notifier.subscribe(spaceId) : undefined;
      try {
        const read = () =>
          readChanges(db.db, spaceId, { epoch: q.epoch, since: q.since, limit: q.limit, snapshot: q.snapshot === '1' });
        let res = await read();
        // Each read is its own transaction, so no connection is held while the request waits.
        if (res.items.length === 0 && sub && (await sub.wait(q.wait * 1000, c.req.raw.signal))) res = await read();
        return c.json(res, 200);
      } catch (err) {
        // `readChanges` refuses with 404 or 410 only.
        if (!(err instanceof SyncRefusal && (err.status === 404 || err.status === 410))) throw err;
        logRefusal(rid, err);
        return c.json(syncError(err.code), err.status);
      } finally {
        sub?.cancel();
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: SYNC_PUSH_PATH,
      // Before the body is read: a caller without a device learns nothing about its request.
      middleware: [requireDevice(deps)] as const,
      // Required: without it, a body that is not declared JSON would skip validation and reach the handler as `{}`.
      request: { body: { content: json(SyncPushRequestSchema), required: true } },
      responses: {
        200: { description: 'One result per item, in request order', content: json(SyncPushResponseSchema) },
        400: errorResponse('The request was not valid'),
        401: errorResponse('No valid device token'),
        403: refusalResponse('This account may only read the space (read-only)'),
        404: refusalResponse('No such space for this account (not-found)'),
        410: refusalResponse('The space started over: download it again from 0 (resync-required)'),
        413: refusalResponse('The push would take the space over its quota (quota-exceeded); nothing was written'),
        429: errorResponse('Too many sync requests this minute (rate-limit)'),
      },
    }),
    async (c) => {
      c.header('Cache-Control', 'no-store');
      const rid = c.get('rid');
      const who = principal(c.var.account);
      const req = c.req.valid('json');
      takeRequest(who.userId);
      try {
        const found = await findSpace(db.db, req.spaceId, who, syncAccess);
        if (!found) return c.json(syncError('not-found'), 404);
        if (found.access === 'read') return c.json(syncError('read-only'), 403);
        const outcome = await applyPush(db.db, who, found.space.id, req);
        const { applied, stale, rejected, replayed } = outcome;
        log.info('sync.push', { rid, applied, stale, rejected, replayed });
        if (applied > 0) notifier.notify(found.space.id);
        return c.json(outcome.response, 200);
      } catch (err) {
        if (!(err instanceof SyncRefusal)) throw err;
        logRefusal(rid, err);
        return c.json(syncError(err.code), err.status);
      }
    },
  );
}
