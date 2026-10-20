/**
 * The problem reports admin routes (ADR 0009 §7), guarded as `routes/admin.ts`'s are: the reads need a web session with
 * the admin role; the four actions check the page's own `Origin` first (before the body is read), then the session and
 * the role. Always mounted: with `REPORTS=off` the summary says `enabled: false`, and reports kept from before can still
 * be read, handled and deleted until the purge removes them.
 *
 * The reads log only the app's `http` line, since their answers hold people's words. The actions' lines name the admin
 * by id and carry counts only: never a report's id, reference, words or reply address.
 */
import { createRoute } from '@hono/zod-openapi';
import {
  ADMIN_REPORT_ROUTE,
  ADMIN_REPORTS_DELETE_PATH,
  ADMIN_REPORTS_FLOOR_PATH,
  ADMIN_REPORTS_FORGET_CONTACT_PATH,
  ADMIN_REPORTS_HANDLE_PATH,
  ADMIN_REPORTS_PATH,
  ADMIN_REPORTS_SUMMARY_PATH,
  AdminOkSchema,
  AdminReportDetailSchema,
  AdminReportListSchema,
  AdminReportsListQuerySchema,
  AdminReportsSummarySchema,
  DeleteReportsRequestSchema,
  ForgetContactRequestSchema,
  HandleReportsRequestSchema,
  REPORT_KEEP_DAYS,
  SetFloorRequestSchema,
} from '@unalgorithm/protocol';
import { z } from 'zod';
import { requireAdmin } from '../admin/access.ts';
import { ownPageOnly, requireWebSession } from '../auth/web-session.ts';
import type { App, AppDeps } from '../http/app.ts';
import {
  deleteReports,
  forgetContact,
  handleReports,
  listReports,
  reportDetail,
  reportsSummary,
  setFloor,
} from '../reports/admin.ts';
import { errorResponse, json, NOT_FOUND } from './openapi.ts';

/** `?days=30&dev=1`: days of daily counts (reports are kept 90), and whether development builds count. */
const SummaryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(REPORT_KEEP_DAYS).default(30),
  dev: z.enum(['0', '1']).default('0'),
});

const IdParamsSchema = z.object({ id: z.uuid() });

/** Mounts the problem reports admin routes on the app. */
export function reportAdminRoutes(app: App, deps: AppDeps): void {
  const { config, db, log } = deps;
  // A GET changes nothing, so it needs no `ownPageOnly`; `requireWebSession` sets `Cache-Control: no-store`.
  const webSession = requireWebSession(deps);
  const adminRole = requireAdmin(deps);
  const pageOnly = ownPageOnly(config.publicOrigin);
  const refusals = {
    400: errorResponse('The request was not valid'),
    401: errorResponse('No web session'),
    403: errorResponse("This account isn't an admin of this server"),
  };
  const actionRefusals = {
    400: errorResponse('The request was not valid'),
    401: errorResponse('No web session'),
    403: errorResponse("Not from this server's own page, or this account isn't an admin of this server"),
  };
  const done = { description: 'Done', content: json(AdminOkSchema) };
  const ok = { ok: true as const };

  // Before `{id}`: `summary` would otherwise reach the detail route as an id.
  app.openapi(
    createRoute({
      method: 'get',
      path: ADMIN_REPORTS_SUMMARY_PATH,
      middleware: [webSession, adminRole] as const,
      request: { query: SummaryQuerySchema },
      responses: {
        200: { description: 'Daily counts, groups and "Fixed in" floors', content: json(AdminReportsSummarySchema) },
        ...refusals,
      },
    }),
    async (c) => {
      const { days, dev } = c.req.valid('query');
      return c.json(await reportsSummary(db.db, config, { days, dev: dev === '1' }), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: ADMIN_REPORTS_PATH,
      middleware: [webSession, adminRole] as const,
      request: { query: AdminReportsListQuerySchema },
      responses: {
        200: { description: "A page of reports, newest first, and the next page's cursor", content: json(AdminReportListSchema) },
        ...refusals,
      },
    }),
    async (c) => c.json(await listReports(db.db, c.req.valid('query')), 200),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: ADMIN_REPORT_ROUTE,
      middleware: [webSession, adminRole] as const,
      request: { params: IdParamsSchema },
      responses: {
        200: { description: 'One report in full', content: json(AdminReportDetailSchema) },
        ...refusals,
        404: errorResponse('No report has this id'),
      },
    }),
    async (c) => {
      const detail = await reportDetail(db.db, c.req.valid('param').id);
      return detail ? c.json(detail, 200) : c.json(NOT_FOUND, 404);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: ADMIN_REPORTS_HANDLE_PATH,
      // The Origin check first, before the body is read, as every admin action's.
      middleware: [pageOnly, webSession, adminRole] as const,
      request: { body: { content: json(HandleReportsRequestSchema), required: true } },
      responses: { 200: done, ...actionRefusals },
    }),
    async (c) => {
      const req = c.req.valid('json');
      const adminId = c.get('webUser').userId;
      const changed = await handleReports(db.db, adminId, req);
      log.info('admin.reports_handled', {
        rid: c.get('rid'),
        admin_id: adminId,
        handled: req.handled,
        by: req.group === undefined ? 'ids' : 'group',
        count: changed,
      });
      return c.json(ok, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: ADMIN_REPORTS_FLOOR_PATH,
      middleware: [pageOnly, webSession, adminRole] as const,
      request: { body: { content: json(SetFloorRequestSchema), required: true } },
      responses: { 200: done, ...actionRefusals },
    }),
    async (c) => {
      const req = c.req.valid('json');
      const adminId = c.get('webUser').userId;
      const marked = await setFloor(db.db, adminId, req);
      log.info('admin.report_floor_set', {
        rid: c.get('rid'),
        admin_id: adminId,
        platform: req.platform,
        adapter: req.adapter,
        count: marked,
      });
      return c.json(ok, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: ADMIN_REPORTS_FORGET_CONTACT_PATH,
      middleware: [pageOnly, webSession, adminRole] as const,
      request: { body: { content: json(ForgetContactRequestSchema), required: true } },
      responses: { 200: done, ...actionRefusals, 404: errorResponse('No report has this id') },
    }),
    async (c) => {
      const { id } = c.req.valid('json');
      if (!(await forgetContact(db.db, id))) return c.json(NOT_FOUND, 404);
      log.info('admin.report_contact_forgotten', { rid: c.get('rid'), admin_id: c.get('webUser').userId });
      return c.json(ok, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: ADMIN_REPORTS_DELETE_PATH,
      middleware: [pageOnly, webSession, adminRole] as const,
      request: { body: { content: json(DeleteReportsRequestSchema), required: true } },
      responses: { 200: done, ...actionRefusals },
    }),
    async (c) => {
      const { ids } = c.req.valid('json');
      const deleted = await deleteReports(db.db, ids);
      log.info('admin.reports_deleted', { rid: c.get('rid'), admin_id: c.get('webUser').userId, count: deleted });
      return c.json(ok, 200);
    },
  );
}
