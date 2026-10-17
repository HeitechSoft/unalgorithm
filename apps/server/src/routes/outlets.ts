/**
 * The source list's admin routes (P3-73, decisions D93–D95), guarded as `routes/admin.ts`'s actions are. `GET
 * /v1/admin/outlets` is what the source control page reads: the list as published and its latest changes, each with the
 * admin's address; it needs a web session with the admin role. The two writes, a change to one outlet and the import of
 * the candidate list into an empty list, check the page's own `Origin` first (before the body is read), then the web
 * session and the role. Each is published at once and recorded in the history (`admin/outlets.ts`).
 *
 * Log lines name the admin, the action and the outlet by id, with the list's version or the count imported; never a
 * name, a web address or an evidence link (not personal, but every admin line stays ids-only), never an address.
 */
import { createRoute } from '@hono/zod-openapi';
import { bundledCandidates } from '@unalgorithm/outlets';
import {
  ADMIN_OUTLETS_IMPORT_PATH,
  ADMIN_OUTLETS_PATH,
  AdminOutletsSchema,
  OutletChangedSchema,
  OutletChangeRequestSchema,
} from '@unalgorithm/protocol';
import { z } from 'zod';
import { requireAdmin } from '../admin/access.ts';
import { applyOutletChange, importCandidates, listChanges, readOfficialList } from '../admin/outlets.ts';
import { ownPageOnly, requireWebSession } from '../auth/web-session.ts';
import type { App, AppDeps } from '../http/app.ts';
import { errorResponse, json } from './openapi.ts';

/** The import takes no options: an empty JSON object. */
const ImportRequestSchema = z.strictObject({});

/** Mounts the source list's admin routes on the app. */
export function outletAdminRoutes(app: App, deps: AppDeps): void {
  const { config, db, log } = deps;
  // A GET changes nothing, so it needs no `ownPageOnly`; `requireWebSession` sets `Cache-Control: no-store`.
  const webSession = requireWebSession(deps);
  const adminRole = requireAdmin(deps);
  const pageOnly = ownPageOnly(config.publicOrigin);
  const writeRefusals = {
    400: errorResponse('The request was not valid, or the change would break a rule of the list'),
    401: errorResponse('No web session'),
    403: errorResponse("Not from this server's own page, or this account isn't an admin of this server"),
  };
  const changed = { description: "The list's version now", content: json(OutletChangedSchema) };

  app.openapi(
    createRoute({
      method: 'get',
      path: ADMIN_OUTLETS_PATH,
      middleware: [webSession, adminRole] as const,
      responses: {
        200: {
          description: 'The source list as published, and its latest changes with who made them',
          content: json(AdminOutletsSchema),
        },
        401: errorResponse('No web session'),
        403: errorResponse("This account isn't an admin of this server"),
      },
    }),
    async (c) => {
      // One snapshot, so the changes shown end at the list's version.
      const body = await db.db.transaction(
        async (tx) => ({ list: await readOfficialList(tx), changes: await listChanges(tx, { withBy: true }) }),
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
      return c.json(body, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: ADMIN_OUTLETS_PATH,
      // The Origin check first, before the body is read, as every admin action's.
      middleware: [pageOnly, webSession, adminRole] as const,
      request: { body: { content: json(OutletChangeRequestSchema), required: true } },
      responses: {
        200: changed,
        ...writeRefusals,
        404: errorResponse('No outlet has this id'),
        409: errorResponse('The list changed since the page showed it'),
      },
    }),
    async (c) => {
      const req = c.req.valid('json');
      const adminId = c.get('webUser').userId;
      const outcome = await applyOutletChange(db.db, adminId, req);
      if (!outcome.ok) return c.json(outcome.error, outcome.status);
      // An edit that changed nothing kept the version: nothing to log.
      if (outcome.version !== req.baseVersion) {
        log.info('admin.outlet_changed', {
          rid: c.get('rid'),
          admin_id: adminId,
          action: req.action,
          outlet_id: req.action === 'remove' ? req.id : req.outlet.id,
          version: outcome.version,
        });
      }
      return c.json({ ok: true as const, version: outcome.version }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: ADMIN_OUTLETS_IMPORT_PATH,
      middleware: [pageOnly, webSession, adminRole] as const,
      request: { body: { content: json(ImportRequestSchema), required: true } },
      responses: { 200: changed, ...writeRefusals },
    }),
    async (c) => {
      const candidates = bundledCandidates();
      // A build whose candidate file fails its schema: the seed test catches it first.
      if (!candidates) throw new Error('The bundled candidate list is not valid.');
      const adminId = c.get('webUser').userId;
      const outcome = await importCandidates(db.db, adminId, candidates);
      if (!outcome.ok) return c.json(outcome.error, outcome.status);
      log.info('admin.outlets_imported', {
        rid: c.get('rid'),
        admin_id: adminId,
        outlets: candidates.outlets.length,
        version: outcome.version,
      });
      return c.json({ ok: true as const, version: outcome.version }, 200);
    },
  );
}
