// Before any Date is made: Toronto is never UTC, so a day read in local time shows up as a wrong one.
process.env.TZ = 'America/Toronto';

/**
 * The problem reports admin routes (ADR 0009 §7): who may call them, the summary, a group's pages, one report in full,
 * and the four actions. Reports are written straight into the table, at chosen times; the people are fictional.
 */
import {
  ADMIN_OVERVIEW_PATH,
  ADMIN_REPORTS_DELETE_PATH,
  ADMIN_REPORTS_FLOOR_PATH,
  ADMIN_REPORTS_FORGET_CONTACT_PATH,
  ADMIN_REPORTS_HANDLE_PATH,
  ADMIN_REPORTS_PAGE_PATH,
  ADMIN_REPORTS_PATH,
  ADMIN_REPORTS_SUMMARY_PATH,
  AdminOverviewSchema,
  type AdminReportDetail,
  AdminReportDetailSchema,
  type AdminReportList,
  AdminReportListSchema,
  type AdminReportsSummary,
  AdminReportsSummarySchema,
  adminReportPath,
  REPORT_GROUP_DAYS,
  reportGroupKey,
} from '@unalgorithm/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ROLE, NOT_ADMIN } from '../src/admin/access.ts';
import { REFUSED } from '../src/auth/web-session.ts';
import { problemReports, reportFloors, user } from '../src/db/schema.ts';
import { hourOf } from '../src/reports/intake.ts';
import { NOT_FOUND } from '../src/routes/openapi.ts';
import { correctionDetails, insertReport, report, reportApp } from './support/reports.ts';
import { postJson, signInWeb } from './support/sign-in.ts';
import { TEST_PUBLIC_URL } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const ADA = 'ada@example.com';
const BEA = 'bea@example.com';
const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOT_VALID = { code: 'bad-request', message: 'The request was not valid.' };
const OK = { ok: true };

/** Apps a test opened, closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A report app where Ada is the admin and Bea a member, both signed in on the page. */
async function adminApp(env: Record<string, string | undefined> = {}) {
  const r = await reportApp({ SIGNUP_ALLOWLIST: `${ADA},${BEA}`, ...env });
  cleanup.push(() => r.t.close());
  const admin = await signInWeb(r.app, r.t.outbox, ADA);
  const member = await signInWeb(r.app, r.t.outbox, BEA);
  await r.db.update(user).set({ role: ADMIN_ROLE }).where(eq(user.email, ADA));
  const [ada] = await r.db.select({ id: user.id }).from(user).where(eq(user.email, ADA));
  if (!ada) throw new Error('No account.');
  const get = (path: string, cookie: string | null = admin) => r.app.request(path, { headers: cookie ? { Cookie: cookie } : {} });
  const post = (path: string, body: unknown, cookie: string | null = admin, origin: string | null = TEST_PUBLIC_URL) =>
    postJson(r.app, path, body, { ...(origin === null ? {} : { Origin: origin }), ...(cookie ? { Cookie: cookie } : {}) });
  const read = async <T>(path: string, schema: { parse(v: unknown): T }): Promise<T> => {
    const res = await get(path);
    expect(res.status, path).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(schema.parse(body)).toEqual(body);
    return body as T;
  };
  return { ...r, admin, member, adaId: ada.id, get, post, read };
}

async function expectAnswer(res: Response, status: number, body: unknown) {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual(body);
}

const thisHour = () => hourOf(Date.now());

describe('access', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_report_admin_routes_need_an_admin', async () => {
    const a = await adminApp();
    const id = await insertReport(a.db, thisHour());
    for (const path of [ADMIN_REPORTS_SUMMARY_PATH, ADMIN_REPORTS_PATH, adminReportPath(id)]) {
      const none = await a.get(path, null);
      expect(none.status, path).toBe(401);
      expect(none.headers.get('Cache-Control')).toBe('no-store');
      await expectAnswer(await a.get(path, a.member), 403, NOT_ADMIN);
      expect((await a.get(path)).status, path).toBe(200);
    }
    const actions: [string, unknown][] = [
      [ADMIN_REPORTS_HANDLE_PATH, { ids: [id], handled: true, resolution: 'fixed' }],
      [ADMIN_REPORTS_FLOOR_PATH, { platform: 'linkedin', adapter: 'linkedin@2026.10.3' }],
      [ADMIN_REPORTS_FORGET_CONTACT_PATH, { id }],
      [ADMIN_REPORTS_DELETE_PATH, { ids: [id] }],
    ];
    for (const [path, body] of actions) {
      // Another origin, or none, is refused before the session or the body is looked at.
      await expectAnswer(await a.post(path, body, a.admin, 'https://evil.example'), 403, REFUSED);
      await expectAnswer(await a.post(path, body, a.admin, null), 403, REFUSED);
      expect((await a.post(path, body, null)).status, path).toBe(401);
      await expectAnswer(await a.post(path, body, a.member), 403, NOT_ADMIN);
    }
    // Nothing changed.
    const [row] = await a.db.select().from(problemReports);
    expect(row).toMatchObject({ handledAt: null });
    expect(await a.db.select().from(reportFloors)).toEqual([]);
    // The page itself is public, like /admin: its routes guard the data.
    const page = await a.app.request(ADMIN_REPORTS_PAGE_PATH);
    expect(page.status).toBe((await a.app.request('/admin')).status);
  });

  it('test_report_admin_refuses_bad_input', async () => {
    const a = await adminApp();
    await expectAnswer(await a.get(`${ADMIN_REPORTS_PATH}/not-a-uuid`), 400, NOT_VALID);
    await expectAnswer(await a.get(adminReportPath('00000000-0000-4000-8000-000000000000')), 404, NOT_FOUND);
    await expectAnswer(await a.get(`${ADMIN_REPORTS_SUMMARY_PATH}?days=91`), 400, NOT_VALID);
    await expectAnswer(await a.get(`${ADMIN_REPORTS_PATH}?status=closed`), 400, NOT_VALID);
    await expectAnswer(await a.get(`${ADMIN_REPORTS_PATH}?group=nope`), 400, NOT_VALID);
    await expectAnswer(await a.post(ADMIN_REPORTS_HANDLE_PATH, { handled: true }), 400, NOT_VALID);
    await expectAnswer(await a.post(ADMIN_REPORTS_HANDLE_PATH, { ids: [crypto.randomUUID()], handled: true }), 400, NOT_VALID);
    await expectAnswer(
      await a.post(ADMIN_REPORTS_FLOOR_PATH, { platform: 'linkedin', adapter: 'facebook@2026.10.3' }),
      400,
      NOT_VALID,
    );
    await expectAnswer(await a.post(ADMIN_REPORTS_FORGET_CONTACT_PATH, { id: crypto.randomUUID() }), 404, NOT_FOUND);
  });
});

describe('reading', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_report_summary', async () => {
    const a = await adminApp({ REPORTS_DAILY_MAX: '500' });
    const now = Date.now();
    const today = thisHour();
    const linkedin = {
      platform: 'linkedin',
      adapter: 'linkedin@2026.10.2',
      kind: 'detection',
      topic: 'ad-label-near-miss',
    } as const;
    await insertReport(a.db, today);
    await insertReport(a.db, today, { firstFromNetwork: false });
    await insertReport(a.db, new Date(today.getTime() - 3 * DAY), { handledAt: new Date(), resolution: 'fixed' });
    // An open report older than the 30 days shown still makes its group show.
    await insertReport(a.db, new Date(today.getTime() - 40 * DAY), { topic: 'feed-not-started' });
    await insertReport(a.db, today, {
      kind: 'correction',
      platform: null,
      adapter: null,
      adapterOrder: null,
      topic: 'factcheck',
      details: correctionDetails(),
    });
    // Unlisted and development reports are not in the groups.
    await insertReport(a.db, today, { listed: false });
    await insertReport(a.db, new Date(today.getTime() - 8 * DAY), { listed: false });
    await insertReport(a.db, today, { channel: 'development' });
    await a.db
      .insert(reportFloors)
      .values({ platform: 'facebook', adapter: 'facebook@2026.10.1', adapterOrder: 2026010001, setAt: new Date(now) });

    const s = await a.read<AdminReportsSummary>(ADMIN_REPORTS_SUMMARY_PATH, AdminReportsSummarySchema);
    expect(s).toMatchObject({ enabled: true, today: 5, dailyMax: 500, unlisted7d: 1 });
    expect(s.days).toHaveLength(30);
    expect(s.days.at(-1)).toEqual({ day: new Date(now).toISOString().slice(0, 10), linkedin: 2, facebook: 0, other: 1 });
    expect(s.days.reduce((n, d) => n + d.linkedin, 0)).toBe(3);
    // Open groups first, the latest first, then by key.
    expect(s.groups.map((g) => [g.key, g.total, g.open, g.networks])).toEqual([
      [reportGroupKey(linkedin), 3, 2, 2],
      [reportGroupKey({ ...linkedin, platform: null, adapter: null, kind: 'correction', topic: 'factcheck' }), 1, 1, 1],
      [reportGroupKey({ ...linkedin, topic: 'feed-not-started' }), 1, 1, 1],
    ]);
    const group = s.groups.find((g) => g.key === reportGroupKey(linkedin));
    expect(group?.perDay).toHaveLength(REPORT_GROUP_DAYS);
    expect(group?.perDay.at(-1)).toBe(2);
    expect(group?.perDay.at(-4)).toBe(1);
    expect(group?.lastAt).toBe(today.toISOString());
    expect(s.floors).toEqual([{ platform: 'facebook', adapter: 'facebook@2026.10.1', setAt: new Date(now).toISOString() }]);

    // With development builds, and fewer days.
    const dev = await a.read<AdminReportsSummary>(`${ADMIN_REPORTS_SUMMARY_PATH}?days=7&dev=1`, AdminReportsSummarySchema);
    expect(dev.days).toHaveLength(7);
    expect(dev.groups.find((g) => g.key === reportGroupKey(linkedin))?.total).toBe(4);
  });

  it('test_report_list_pages_and_ref_lookup', async () => {
    const a = await adminApp();
    const hour = thisHour();
    // 60 in this hour, then 3 an hour earlier: more than a page share one time.
    const recent = [];
    for (let i = 0; i < 60; i++) recent.push(await insertReport(a.db, hour));
    const earlier = [];
    for (let i = 0; i < 3; i++) earlier.push(await insertReport(a.db, new Date(hour.getTime() - HOUR)));
    const other = await insertReport(a.db, hour, { topic: 'no-feed' });
    const group = reportGroupKey({
      platform: 'linkedin',
      adapter: 'linkedin@2026.10.2',
      kind: 'detection',
      topic: 'ad-label-near-miss',
    });

    const seen: string[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const query: string = `${ADMIN_REPORTS_PATH}?group=${encodeURIComponent(group)}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
      const page: AdminReportList = await a.read(query, AdminReportListSchema);
      seen.push(...page.rows.map((r) => r.id));
      before = page.nextBefore;
      pages += 1;
    } while (before !== null && pages < 5);
    expect(pages).toBe(2);
    // Every row once, newest first.
    expect(seen).toHaveLength(63);
    expect(new Set(seen).size).toBe(63);
    expect(seen.slice(0, 60).sort()).toEqual([...recent].sort());
    expect(seen.slice(60).sort()).toEqual([...earlier].sort());
    expect(seen).not.toContain(other);

    // Open only by default; a handled row shows with `handled` or `all`.
    await a.db.update(problemReports).set({ handledAt: new Date(), resolution: 'fixed' }).where(eq(problemReports.id, other));
    const open = await a.read<AdminReportList>(ADMIN_REPORTS_PATH, AdminReportListSchema);
    expect(open.rows.map((r) => r.id)).not.toContain(other);
    const handled = await a.read<AdminReportList>(`${ADMIN_REPORTS_PATH}?status=handled`, AdminReportListSchema);
    expect(handled.rows.map((r) => [r.id, r.resolution])).toEqual([[other, 'fixed']]);

    // A reference finds its report, whatever its status; typed by a person, the page parses it first.
    const [row] = await a.db.select({ ref: problemReports.ref }).from(problemReports).where(eq(problemReports.id, other));
    const found = await a.read<AdminReportList>(`${ADMIN_REPORTS_PATH}?ref=${row?.ref}`, AdminReportListSchema);
    expect(found).toEqual({ rows: [expect.objectContaining({ id: other, ref: row?.ref })], nextBefore: null });
    const none = await a.read<AdminReportList>(`${ADMIN_REPORTS_PATH}?ref=0000-0000`, AdminReportListSchema);
    expect(none).toEqual({ rows: [], nextBefore: null });
  });

  it('test_report_detail', async () => {
    const a = await adminApp();
    // Through the route, as the extension sends it, then read back.
    const sent = report('correction', {
      correction: {
        feature: 'perspectives',
        promptVersion: 2,
        list: 'cloud',
        via: 'own-key',
        message: 'The comparison left out the second outlet.',
        contact: 'ann@example.org',
      },
      choices: ['comparison-wrong'],
    });
    expect((await a.send(sent)).status).toBe(201);
    await a.post(ADMIN_REPORTS_HANDLE_PATH, { ids: [sent.id], handled: true, resolution: 'corrected' });
    const d = await a.read<AdminReportDetail>(adminReportPath(sent.id), AdminReportDetailSchema);
    expect(d).toMatchObject({
      id: sent.id,
      kind: 'correction',
      listed: true,
      hasMessage: true,
      hasContact: true,
      message: 'The comparison left out the second outlet.',
      contact: 'ann@example.org',
      unknownCodes: 0,
      resolution: 'corrected',
      handledBy: { id: a.adaId, email: ADA },
      details: { correction: { feature: 'perspectives', promptVersion: 2, list: 'cloud', via: 'own-key' } },
    });
    expect(d.lines[0]).toBe('unAlgorithm 0.4.1 from the Chrome Web Store');
    expect(d.lines).toContain('Chrome 141');
    // The page shows the words and the address on their own: not in the lines.
    expect(d.lines.join('\n')).not.toContain('second outlet');
    expect(d.lines.join('\n')).not.toContain('ann@example.org');
    expect(d.lines.some((line) => line.startsWith('About: an UnEcho Chamber result'))).toBe(true);

    const detection = report('detection');
    expect((await a.send(detection)).status).toBe(201);
    const dd = await a.read<AdminReportDetail>(adminReportPath(detection.id), AdminReportDetailSchema);
    expect(dd.lines.some((line) => line.startsWith('On this page: 22 posts, 2 panels, 15 folded away'))).toBe(true);
    expect(dd).toMatchObject({ message: null, contact: null, handledBy: null });
  });

  it('test_report_overview_counts', async () => {
    const a = await adminApp();
    await insertReport(a.db, thisHour());
    await insertReport(a.db, new Date(Date.now() - 3 * DAY));
    await insertReport(a.db, thisHour(), { handledAt: new Date(), resolution: 'fixed' });
    await insertReport(a.db, thisHour(), { listed: false });
    await insertReport(a.db, thisHour(), { channel: 'development' });
    const overview = await a.read(ADMIN_OVERVIEW_PATH, AdminOverviewSchema);
    expect(overview.reports).toEqual({ enabled: true, open: 2, last24h: 2 });

    // With REPORTS off the page still reads what is kept, and says it's off.
    const off = await adminApp({ REPORTS: 'off' });
    expect((await off.read(ADMIN_OVERVIEW_PATH, AdminOverviewSchema)).reports).toEqual({ enabled: false, open: 0, last24h: 0 });
    expect((await off.read(ADMIN_REPORTS_SUMMARY_PATH, AdminReportsSummarySchema)).enabled).toBe(false);
  });
});

describe('actions', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_report_handle_by_ids_and_group', async () => {
    const a = await adminApp();
    const hour = thisHour();
    const inGroup = [await insertReport(a.db, hour), await insertReport(a.db, new Date(hour.getTime() - DAY))];
    const alreadyHandled = await insertReport(a.db, hour, { handledAt: new Date(hour), resolution: 'duplicate' });
    const otherTopic = await insertReport(a.db, hour, { topic: 'no-feed' });
    const otherVersion = await insertReport(a.db, hour, { adapter: 'linkedin@2026.10.3', adapterOrder: 2026010003 });
    const group = reportGroupKey({
      platform: 'linkedin',
      adapter: 'linkedin@2026.10.2',
      kind: 'detection',
      topic: 'ad-label-near-miss',
    });

    await expectAnswer(await a.post(ADMIN_REPORTS_HANDLE_PATH, { group, handled: true, resolution: 'fixed' }), 200, OK);
    const state = async () =>
      Object.fromEntries((await a.db.select().from(problemReports)).map((r) => [r.id, [r.resolution, r.handledBy === a.adaId]]));
    expect(await state()).toEqual({
      [inGroup[0] as string]: ['fixed', true],
      [inGroup[1] as string]: ['fixed', true],
      // A resolution is never overwritten by a group action.
      [alreadyHandled]: ['duplicate', false],
      [otherTopic]: [null, false],
      [otherVersion]: [null, false],
    });

    // Reopen one by id, then handle it again with another resolution.
    await expectAnswer(await a.post(ADMIN_REPORTS_HANDLE_PATH, { ids: [inGroup[0]], handled: false }), 200, OK);
    const [reopened] = await a.db
      .select()
      .from(problemReports)
      .where(eq(problemReports.id, inGroup[0] as string));
    expect(reopened).toMatchObject({ handledAt: null, handledBy: null, resolution: null });
    await a.post(ADMIN_REPORTS_HANDLE_PATH, { ids: [inGroup[0], otherTopic], handled: true, resolution: 'cant-reproduce' });
    expect(await state()).toMatchObject({
      [inGroup[0] as string]: ['cant-reproduce', true],
      [otherTopic]: ['cant-reproduce', true],
    });

    const lines = a.t.events().filter((e) => e.event === 'admin.reports_handled');
    expect(lines.map((e) => [e.by, e.handled, e.count])).toEqual([
      ['group', true, 2],
      ['ids', false, 1],
      ['ids', true, 2],
    ]);
    expect(lines.every((e) => e.admin_id === a.adaId)).toBe(true);
  });

  it('test_report_floor_marks_older_reports', async () => {
    const a = await adminApp();
    const hour = thisHour();
    const older = await insertReport(a.db, hour);
    const handledOlder = await insertReport(a.db, hour, { handledAt: new Date(hour), resolution: 'fixed' });
    const same = await insertReport(a.db, hour, { adapter: 'linkedin@2026.10.3', adapterOrder: 2026010003 });
    const facebook = await insertReport(a.db, hour, {
      platform: 'facebook',
      adapter: 'facebook@2026.9.1',
      adapterOrder: 2026009001,
    });

    await expectAnswer(await a.post(ADMIN_REPORTS_FLOOR_PATH, { platform: 'linkedin', adapter: 'linkedin@2026.10.3' }), 200, OK);
    const rows = Object.fromEntries((await a.db.select().from(problemReports)).map((r) => [r.id, r.resolution]));
    expect(rows).toEqual({ [older]: 'older-version', [handledOlder]: 'fixed', [same]: null, [facebook]: null });
    const summary = await a.read<AdminReportsSummary>(ADMIN_REPORTS_SUMMARY_PATH, AdminReportsSummarySchema);
    expect(summary.floors.map((f) => [f.platform, f.adapter])).toEqual([['linkedin', 'linkedin@2026.10.3']]);

    // A new report below the floor arrives handled.
    const below = report('detection');
    expect((await a.send(below)).status).toBe(201);
    const [stored] = await a.db.select().from(problemReports).where(eq(problemReports.id, below.id));
    expect(stored?.resolution).toBe('older-version');

    // Moving the floor replaces it; clearing it removes it, and what it marked stays handled.
    await a.post(ADMIN_REPORTS_FLOOR_PATH, { platform: 'linkedin', adapter: 'linkedin@2026.10.4' });
    const [moved] = await a.db.select().from(reportFloors);
    expect(moved).toMatchObject({ adapter: 'linkedin@2026.10.4', adapterOrder: 2026010004, setBy: a.adaId });
    await expectAnswer(await a.post(ADMIN_REPORTS_FLOOR_PATH, { platform: 'linkedin', adapter: null }), 200, OK);
    expect(await a.db.select().from(reportFloors)).toEqual([]);
    const [kept] = await a.db.select().from(problemReports).where(eq(problemReports.id, same));
    expect(kept?.resolution).toBe('older-version');
    expect(
      a.t
        .events()
        .filter((e) => e.event === 'admin.report_floor_set')
        .map((e) => [e.adapter, e.count]),
    ).toEqual([
      ['linkedin@2026.10.3', 1],
      ['linkedin@2026.10.4', 1],
      [null, 0],
    ]);
  });

  it('test_report_forget_contact_and_delete', async () => {
    const a = await adminApp();
    const sent = report('correction');
    expect((await a.send(sent)).status).toBe(201);
    const keep = await insertReport(a.db, thisHour());
    await expectAnswer(await a.post(ADMIN_REPORTS_FORGET_CONTACT_PATH, { id: sent.id }), 200, OK);
    const [forgotten] = await a.db.select().from(problemReports).where(eq(problemReports.id, sent.id));
    expect(forgotten).toMatchObject({ contact: null, message: 'The claim was about 2024, not 2023.' });

    await expectAnswer(await a.post(ADMIN_REPORTS_DELETE_PATH, { ids: [sent.id, crypto.randomUUID()] }), 200, OK);
    expect((await a.db.select({ id: problemReports.id }).from(problemReports)).map((r) => r.id)).toEqual([keep]);
    await expectAnswer(await a.get(adminReportPath(sent.id)), 404, NOT_FOUND);

    // Ids and counts only: never a report's id, reference, words or address.
    const lines = a.t.lines.filter((line) => line.includes('admin.report'));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain(sent.id);
      expect(line).not.toContain('ann@example.org');
      expect(line).not.toContain('2024');
    }
    expect(a.t.events().find((e) => e.event === 'admin.reports_deleted')).toMatchObject({ count: 1 });
  });
});
