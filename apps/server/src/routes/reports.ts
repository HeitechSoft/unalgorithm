/**
 * `POST /v1/reports` (ADR 0009 §6): problem reports from the extension's report page, with no account, cookie or token.
 * The one anonymous write route, and the exception to "every `/v1` route needs a token, a session or a secret", so it
 * is mounted only with `REPORTS=on` (HeitechSoft's hosted server sets it, since the extension sends its reports there
 * only): a self-hosted server gets no anonymous write route.
 * What bounds it instead: an extension page's Origin (`extensionOriginOnly`, before the body is read), a 16 KiB body,
 * the schema and registry, and limits and caps that keep no address (`reports/limits.ts`).
 *
 * The body is read here rather than by a request schema, so a body that isn't JSON gets the report route's own 400
 * (`REPORT_ERRORS.invalid`), never a zod issue or another route's wording. Every answer is `Cache-Control: no-store`.
 */
import { createRoute } from '@hono/zod-openapi';
import { MAX_REPORT_BODY_BYTES, REPORT_ERRORS, REPORTS_PATH, ReportAcceptedSchema } from '@unalgorithm/protocol';
import { bodyLimit } from 'hono/body-limit';
import type { App, AppDeps } from '../http/app.ts';
import { extensionOriginOnly, getClientIp } from '../http/middleware.ts';
import { countReportsSince, receiveReport } from '../reports/intake.ts';
import { createReportLimits, type ReportLimits } from '../reports/limits.ts';
import { errorResponse, json } from './openapi.ts';

/** `application/json`, with or without parameters (`; charset=utf-8`). */
const JSON_TYPE = /^application\/json\s*(;.*)?$/i;

/** The limits a report route uses: `deps.reportLimits`, or new ones on the app's database and configuration. */
function reportLimitsFor({ config, db, reportLimits }: Pick<AppDeps, 'config' | 'db' | 'reportLimits'>): ReportLimits {
  return (
    reportLimits ??
    createReportLimits({
      perHour: config.reports.perHour,
      dailyMax: config.reports.dailyMax,
      countSince: (since) => countReportsSince(db.db, since),
    })
  );
}

/** Mounts `POST /v1/reports`; the caller mounts it only when `config.reports.enabled`. */
export function reportRoutes(app: App, deps: AppDeps): void {
  const { config, db, log } = deps;
  const limits = reportLimitsFor(deps);
  const accepted = (description: string) => ({ description, content: json(ReportAcceptedSchema) });

  app.openapi(
    createRoute({
      method: 'post',
      path: REPORTS_PATH,
      description:
        'A problem report (`ProblemReportSchema` in packages/protocol) from an extension page. Anonymous: no account, ' +
        'cookie or token. Mounted only with REPORTS=on.',
      // The Origin first, before the body is read; then the report's own size limit, answered as JSON the page reads.
      middleware: [
        extensionOriginOnly(),
        bodyLimit({ maxSize: MAX_REPORT_BODY_BYTES, onError: (c) => c.json(REPORT_ERRORS.tooLarge, 413) }),
      ] as const,
      responses: {
        200: accepted('A report with this id was already stored: its reference'),
        201: accepted('Stored: the reference the person can quote'),
        400: errorResponse('Not JSON, or not a problem report'),
        403: errorResponse("Not from an extension page, or a correction from an extension this server doesn't list"),
        413: errorResponse('Larger than 16 KiB'),
        429: errorResponse('Too many reports from this network, or from everyone, for now; Retry-After says when'),
        503: errorResponse("The server's daily limit of reports is reached; Retry-After says when (00:00 UTC)"),
      },
    }),
    async (c) => {
      c.header('Cache-Control', 'no-store');
      if (!JSON_TYPE.test(c.req.header('content-type') ?? '')) return c.json(REPORT_ERRORS.invalid, 400);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(REPORT_ERRORS.invalid, 400);
      }
      const answer = await receiveReport(
        { db: db.db, config, log, limits },
        // `extensionOriginOnly` let only an extension's Origin through.
        { body, origin: c.req.header('origin') ?? '', ip: getClientIp(c) },
      );
      switch (answer.outcome) {
        case 'accepted':
          return c.json(answer.body, answer.status);
        case 'refused':
          return c.json(answer.body, answer.status);
        case 'wait':
          c.header('Retry-After', String(Math.max(1, Math.ceil(answer.retryAfterMs / 1000))));
          return c.json(answer.body, answer.status);
      }
    },
  );
}
