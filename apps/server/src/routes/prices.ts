/**
 * The price book's public route (PA-04, decision PD8) and its admin routes (PA-03, decisions PD1, PD9).
 *
 * Public: `GET /prices.json`, the book in use as `/outlets.json` publishes the source list: outside `/v1`, any origin
 * may read it and a cache may keep it for 5 minutes, with an ETag (a hash of the body). It reads no cookie, session or
 * header but `If-None-Match`, sets no cookie and logs nothing of its own. It holds the book alone: no history, no admin.
 * A server that charges nothing (`BILLING=off`) publishes no prices: 404.
 *
 * Admin: guarded as the source list's are (`routes/outlets.ts`).
 *
 * `GET /v1/admin/prices` is what the Pricing page reads: the book in use, as `/prices.json` publishes it, its latest
 * changes with each admin's address, the server's clock and whether it charges. It needs a web session with the admin
 * role. The write, one change to the book, checks the page's own `Origin` first (before the body is read), then the web
 * session and the role; it is refused 409 when the book changed since the page showed it, 404 for a scheduled change
 * that is no longer there, and 400 with the price rules' plain words (`admin/prices.ts`). The history is never
 * published (PD9).
 *
 * The log line names the admin, the action, the task and the book's version: never an amount, a date or an address
 * (every admin line stays ids-only).
 */
import { createRoute } from '@hono/zod-openapi';
import {
  ADMIN_PRICES_PATH,
  AdminPricesSchema,
  PRICES_JSON_PATH,
  PriceChangedSchema,
  PriceChangeRequestSchema,
} from '@unalgorithm/protocol';
import { requireAdmin } from '../admin/access.ts';
import { applyPriceChange, listPriceChanges } from '../admin/prices.ts';
import { ownPageOnly, requireWebSession } from '../auth/web-session.ts';
import type { App, AppDeps } from '../http/app.ts';
import { errorResponse, json, NOT_FOUND } from './openapi.ts';
import { JSON_UTF8, noneMatchHolds, publicHeaders } from './outlets.ts';

/**
 * Mounts `/prices.json` (PD8). Plain `app.get`, as discovery and `/outlets.json`: a page-level path outside the OpenAPI
 * document. The body and its tag come from the store's copy, made when it was (re)loaded, so an answer costs no query.
 */
export function pricePublicRoutes(app: App, { config, prices }: AppDeps): void {
  app.get(PRICES_JSON_PATH, (c) => {
    if (config.billing === 'off') return c.json(NOT_FOUND, 404);
    publicHeaders(c);
    // One read: the body and the tag of the same book.
    const { body, etag } = prices.published();
    c.header('ETag', etag);
    if (noneMatchHolds(c.req.header('If-None-Match'), etag)) return c.body(null, 304);
    return c.json(body, 200, JSON_UTF8);
  });
}

/** Mounts the price book's admin routes on the app. */
export function priceAdminRoutes(app: App, deps: AppDeps): void {
  const { config, db, log, prices } = deps;
  // A GET changes nothing, so it needs no `ownPageOnly`; `requireWebSession` sets `Cache-Control: no-store`.
  const webSession = requireWebSession(deps);
  const adminRole = requireAdmin(deps);

  app.openapi(
    createRoute({
      method: 'get',
      path: ADMIN_PRICES_PATH,
      middleware: [webSession, adminRole] as const,
      responses: {
        200: {
          description: 'The price book in use, its latest changes with who made them, the clock and whether this server charges',
          content: json(AdminPricesSchema),
        },
        401: errorResponse('No web session'),
        403: errorResponse("This account isn't an admin of this server"),
      },
    }),
    async (c) => {
      const body = {
        prices: prices.published().body,
        changes: await listPriceChanges(db.db),
        now: new Date().toISOString(),
        billing: config.billing === 'module',
      };
      return c.json(body, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: ADMIN_PRICES_PATH,
      // The Origin check first, before the body is read, as every admin action's.
      middleware: [ownPageOnly(config.publicOrigin), webSession, adminRole] as const,
      request: { body: { content: json(PriceChangeRequestSchema), required: true } },
      responses: {
        200: { description: "The price book's version now", content: json(PriceChangedSchema) },
        400: errorResponse('The request was not valid, or the change breaks a price rule (the message says which)'),
        401: errorResponse('No web session'),
        403: errorResponse("Not from this server's own page, or this account isn't an admin of this server"),
        404: errorResponse('The scheduled change to cancel or move is no longer on the list'),
        409: errorResponse('The prices changed since the page showed them'),
      },
    }),
    async (c) => {
      const req = c.req.valid('json');
      const adminId = c.get('webUser').userId;
      const outcome = await applyPriceChange(db.db, prices, adminId, req);
      if (!outcome.ok) return c.json(outcome.error, outcome.status);
      // A change that left the book as it was wrote nothing: nothing to log.
      if (outcome.changed) {
        log.info('admin.price_changed', {
          rid: c.get('rid'),
          admin_id: adminId,
          action: req.action,
          ...('task' in req ? { task: req.task } : {}),
          version: outcome.version,
        });
      }
      return c.json({ ok: true as const, version: outcome.version }, 200);
    },
  );
}
