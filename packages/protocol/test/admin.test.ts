import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as admin from '../src/admin.ts';
import {
  ADMIN_INVITE_REMOVE_PATH,
  ADMIN_INVITES_PATH,
  ADMIN_OVERVIEW_PATH,
  ADMIN_PAGE_PATH,
  ADMIN_REPORTS_PAGE_PATH,
  ADMIN_SETUP_PATH,
  ADMIN_SOURCES_PAGE_PATH,
  ADMIN_USER_ACCESS_ROUTE,
  ADMIN_USER_CAP_ROUTE,
  ADMIN_USER_ROLE_ROUTE,
  ADMIN_USERS_PATH,
  AdminOkSchema,
  AdminOverviewSchema,
  AdminReportDetailSchema,
  AdminReportListSchema,
  AdminReportRowSchema,
  AdminReportsListQuerySchema,
  AdminReportsSummarySchema,
  AdminUserSchema,
  AdminUsersSchema,
  adminReportPath,
  adminUserActionPath,
  BackupStatusSchema,
  DeleteReportsRequestSchema,
  ForgetContactRequestSchema,
  HandleReportsRequestSchema,
  InviteRequestSchema,
  InviteSchema,
  OpenAlertSchema,
  OpsStatusSchema,
  parseReportGroupKey,
  REPORT_GROUP_DAYS,
  ReportGroupSchema,
  reportGroupKey,
  SETUP_PAGE_PATH,
  SetAccessRequestSchema,
  SetCapRequestSchema,
  SetFloorRequestSchema,
  SetRoleRequestSchema,
  SetupRequestSchema,
  UsageDaySchema,
} from '../src/index.ts';

const AT = '2026-10-14T12:00:00Z';

const user = {
  id: 'u_1-A',
  email: 'ann@example.org',
  role: 'admin',
  access: 'active',
  createdAt: AT,
  lastActiveAt: null,
  activeDevices: 2,
  postsToday: 14,
  posts30Days: 410,
  costMicros30Days: 29_930,
  dailyPostCap: null,
};

const day = (d: string) => ({ day: d, posts: 3, requests: 1, costMicros: 219 });

const ops = {
  diskFreeBytes: 10_000_000_000,
  diskTotalBytes: 40_000_000_000,
  databaseBytes: 52_000_000,
  errors15m: 0,
  backups: [
    { kind: 'local', ok: true, finishedAt: AT, lastSuccessAt: AT, bytes: 4_000_000, error: null },
    { kind: 'offsite', ok: false, finishedAt: AT, lastSuccessAt: null, bytes: null, error: 'copy' },
  ],
  openAlerts: [{ key: 'backup-offsite', level: 'critical', openedAt: AT }],
};

const overview = (extra: Record<string, unknown> = {}) => ({
  version: '0.2.0',
  users: 3,
  today: day('2026-10-14'),
  last30Days: [day('2026-10-13'), day('2026-10-14')],
  spendLimitMicros: 50_000_000,
  breakerTripped: false,
  defaultDailyPostCap: 2000,
  ops: null,
  ...extra,
});

const backup = (extra: Record<string, unknown> = {}) => ({
  kind: 'local',
  ok: true,
  finishedAt: AT,
  lastSuccessAt: AT,
  bytes: 1,
  error: null,
  ...extra,
});

describe('admin paths', () => {
  it('test_admin_paths_exact_values', () => {
    expect({
      SETUP_PAGE_PATH,
      ADMIN_PAGE_PATH,
      ADMIN_SOURCES_PAGE_PATH,
      ADMIN_REPORTS_PAGE_PATH,
      ADMIN_SETUP_PATH,
      ADMIN_OVERVIEW_PATH,
      ADMIN_USERS_PATH,
      ADMIN_INVITES_PATH,
      ADMIN_INVITE_REMOVE_PATH,
      ADMIN_USER_CAP_ROUTE,
      ADMIN_USER_ACCESS_ROUTE,
      ADMIN_USER_ROLE_ROUTE,
    }).toEqual({
      SETUP_PAGE_PATH: '/setup',
      ADMIN_PAGE_PATH: '/admin',
      ADMIN_SOURCES_PAGE_PATH: '/admin/sources',
      ADMIN_REPORTS_PAGE_PATH: '/admin/reports',
      ADMIN_SETUP_PATH: '/v1/admin/setup',
      ADMIN_OVERVIEW_PATH: '/v1/admin/overview',
      ADMIN_USERS_PATH: '/v1/admin/users',
      ADMIN_INVITES_PATH: '/v1/admin/invites',
      ADMIN_INVITE_REMOVE_PATH: '/v1/admin/invites/remove',
      ADMIN_USER_CAP_ROUTE: '/v1/admin/users/{userId}/cap',
      ADMIN_USER_ACCESS_ROUTE: '/v1/admin/users/{userId}/access',
      ADMIN_USER_ROLE_ROUTE: '/v1/admin/users/{userId}/role',
    });
  });

  it('test_admin_user_action_path_rejects_bad_ids', () => {
    expect(adminUserActionPath('u_1-A', 'cap')).toBe('/v1/admin/users/u_1-A/cap');
    expect(adminUserActionPath('u_1-A', 'access')).toBe('/v1/admin/users/u_1-A/access');
    expect(adminUserActionPath('u_1-A', 'role')).toBe('/v1/admin/users/u_1-A/role');
    expect(adminUserActionPath('a'.repeat(64), 'cap')).toBe(`/v1/admin/users/${'a'.repeat(64)}/cap`);
    for (const bad of ['', 'a/b', '..', 'a%2F', 'a b', 'x'.repeat(65)]) {
      let thrown: unknown;
      try {
        adminUserActionPath(bad, 'cap');
      } catch (error) {
        thrown = error;
      }
      expect(thrown, JSON.stringify(bad)).toBeInstanceOf(TypeError);
      const message = (thrown as TypeError).message;
      expect(message).toBe('Not a user id.');
      if (bad !== '') expect(message).not.toContain(bad);
    }
  });
});

describe('admin schemas', () => {
  it('test_admin_user_schema_bounds', () => {
    expect(AdminUserSchema.parse(user)).toEqual(user);
    expect(AdminUserSchema.safeParse({ ...user, role: 'user', access: 'removed', dailyPostCap: 0 }).success).toBe(true);
    expect(AdminUserSchema.safeParse({ ...user, lastActiveAt: AT, dailyPostCap: 2_147_483_647 }).success).toBe(true);
    expect(AdminUserSchema.safeParse({ ...user, postsToday: -1 }).success).toBe(false);
    expect(AdminUserSchema.safeParse({ ...user, role: 'owner' }).success).toBe(false);
    expect(AdminUserSchema.safeParse({ ...user, access: 'suspended' }).success).toBe(false);
    expect(AdminUserSchema.safeParse({ ...user, dailyPostCap: 1.5 }).success).toBe(false);
    expect(AdminUserSchema.safeParse({ ...user, dailyPostCap: 2_147_483_648 }).success).toBe(false);
  });

  it('test_admin_users_schema_limits', () => {
    const invite = { email: 'bo@example.org', createdAt: AT };
    const list = (users: number, invites: number) => ({
      users: Array.from({ length: users }, () => user),
      truncated: false,
      invites: Array.from({ length: invites }, () => invite),
      defaultDailyPostCap: 2000,
    });
    expect(AdminUsersSchema.safeParse(list(1000, 1000)).success).toBe(true);
    expect(AdminUsersSchema.safeParse(list(1001, 0)).success).toBe(false);
    expect(AdminUsersSchema.safeParse(list(0, 1001)).success).toBe(false);
  });

  it('test_admin_overview_schema_ops_nullable', () => {
    expect(AdminOverviewSchema.safeParse(overview()).success).toBe(true);
    expect(AdminOverviewSchema.parse(overview({ ops })).ops).toEqual(ops);
    expect(AdminOverviewSchema.safeParse(overview({ ops: { ...ops, backups: null } })).success).toBe(true);
    const days31 = Array.from({ length: 31 }, () => day('2026-10-14'));
    expect(AdminOverviewSchema.safeParse(overview({ last30Days: days31 })).success).toBe(true);
    const days32 = Array.from({ length: 32 }, () => day('2026-10-14'));
    expect(AdminOverviewSchema.safeParse(overview({ last30Days: days32 })).success).toBe(false);
    expect(AdminOverviewSchema.safeParse(overview({ today: day('2026-10-14T00:00:00Z') })).success).toBe(false);
    expect(UsageDaySchema.safeParse(day('2026-10-14T00:00:00Z')).success).toBe(false);
  });

  it('test_admin_overview_reports_optional', () => {
    // ADR 0009 §7: absent on servers older than reports, so the admin page keeps working against them.
    expect(AdminOverviewSchema.parse(overview()).reports).toBeUndefined();
    const reports = { enabled: true, open: 7, last24h: 3 };
    expect(AdminOverviewSchema.parse(overview({ reports })).reports).toEqual(reports);
    expect(AdminOverviewSchema.safeParse(overview({ reports: { ...reports, enabled: false, open: 0 } })).success).toBe(true);
    expect(AdminOverviewSchema.safeParse(overview({ reports: { ...reports, open: -1 } })).success).toBe(false);
    expect(AdminOverviewSchema.safeParse(overview({ reports: { enabled: true } })).success).toBe(false);
  });

  it('test_backup_status_schema_kinds_and_errors', () => {
    expect(BackupStatusSchema.safeParse(backup({ kind: 'local' })).success).toBe(true);
    expect(BackupStatusSchema.safeParse(backup({ kind: 'offsite' })).success).toBe(true);
    expect(BackupStatusSchema.safeParse(backup({ kind: 'Local' })).success).toBe(false);
    expect(BackupStatusSchema.safeParse(backup({ kind: '../x' })).success).toBe(false);
    expect(BackupStatusSchema.safeParse(backup({ kind: `a${'b'.repeat(32)}` })).success).toBe(false);
    expect(BackupStatusSchema.safeParse(backup({ kind: `a${'b'.repeat(31)}` })).success).toBe(true);
    expect(BackupStatusSchema.safeParse(backup({ ok: false, error: 'oops' })).success).toBe(false);
  });

  it('test_admin_request_schemas', () => {
    for (const cap of [null, 0, 2_147_483_647]) {
      expect(SetCapRequestSchema.safeParse({ dailyPostCap: cap }).success, String(cap)).toBe(true);
    }
    for (const cap of [-1, 1.5, 2_147_483_648, '5']) {
      expect(SetCapRequestSchema.safeParse({ dailyPostCap: cap }).success, String(cap)).toBe(false);
    }
    for (const role of ['admin', 'user']) expect(SetRoleRequestSchema.safeParse({ role }).success).toBe(true);
    for (const role of ['owner', 'Admin', '']) expect(SetRoleRequestSchema.safeParse({ role }).success).toBe(false);
    for (const access of ['active', 'removed']) {
      expect(SetAccessRequestSchema.safeParse({ access }).success).toBe(true);
    }
    for (const access of ['suspended', 'Active', '']) {
      expect(SetAccessRequestSchema.safeParse({ access }).success).toBe(false);
    }
    expect(InviteRequestSchema.safeParse({ email: 'bo@example.org' }).success).toBe(true);
    expect(InviteRequestSchema.safeParse({ email: 'not-an-address' }).success).toBe(false);
    const long = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(58)}.org`;
    expect(long).toHaveLength(255);
    expect(InviteRequestSchema.safeParse({ email: long }).success).toBe(false);
    expect(InviteRequestSchema.safeParse({ email: long.slice(1) }).success).toBe(true);
    const token = `${'A'.repeat(40)}_-9`;
    expect(SetupRequestSchema.safeParse({ token }).success).toBe(true);
    expect(SetupRequestSchema.safeParse({ token: token.slice(1) }).success).toBe(false);
    expect(SetupRequestSchema.safeParse({ token: `${token}A` }).success).toBe(false);
    expect(SetupRequestSchema.safeParse({ token: `${token.slice(1)}+` }).success).toBe(false);
    expect(AdminOkSchema.safeParse({ ok: true }).success).toBe(true);
    expect(AdminOkSchema.safeParse({ ok: false }).success).toBe(false);
  });
});

describe('problem report admin (ADR 0009 §7)', () => {
  const REPORT_ID = '0b6f7d3c-5a2e-4f1b-9c8d-7e6a5b4c3d2e';
  const row = {
    id: REPORT_ID,
    ref: '7KQ3-M2PA',
    receivedAt: '2026-10-18T12:00:00Z',
    kind: 'detection',
    from: 'notice',
    channel: 'chrome-store',
    listed: true,
    extension: '0.4.1',
    browser: 'chrome',
    browserMajor: 141,
    platform: 'linkedin',
    adapter: 'linkedin@2026.11.0',
    topic: 'feed-not-started',
    choices: [],
    firstFromNetwork: true,
    handledAt: null,
    resolution: null,
    hasMessage: false,
    hasContact: false,
  };
  const group = {
    key: 'linkedin|linkedin@2026.11.0|detection|feed-not-started',
    platform: 'linkedin',
    adapter: 'linkedin@2026.11.0',
    kind: 'detection',
    topic: 'feed-not-started',
    total: 7,
    open: 7,
    networks: 5,
    lastAt: AT,
    perDay: Array.from({ length: REPORT_GROUP_DAYS }, (_, i) => (i === 13 ? 7 : 0)),
  };

  it('test_report_group_keys_round_trip', () => {
    const parts = { platform: 'linkedin', adapter: 'linkedin@2026.11.0', kind: 'detection', topic: 'feed-not-started' } as const;
    expect(reportGroupKey(parts)).toBe(group.key);
    expect(parseReportGroupKey(group.key)).toEqual(parts);
    // Corrections and other reports have no platform; a report may have no topic.
    const correction = { platform: null, adapter: null, kind: 'correction', topic: 'factcheck' } as const;
    expect(reportGroupKey(correction)).toBe('||correction|factcheck');
    expect(parseReportGroupKey('||correction|factcheck')).toEqual(correction);
    expect(parseReportGroupKey('facebook|facebook@2026.10.3|other|')).toEqual({
      platform: 'facebook',
      adapter: 'facebook@2026.10.3',
      kind: 'other',
      topic: null,
    });
    for (const bad of ['', 'linkedin|x|detection|a', 'linkedin||bug|a', 'linkedin||detection|Jane Doe', 'a|b|c|d|e']) {
      expect(parseReportGroupKey(bad), bad).toBeNull();
    }
  });

  it('test_admin_report_schemas', () => {
    const summary = {
      enabled: true,
      today: 12,
      dailyMax: 1000,
      unlisted7d: 1,
      days: [{ day: '2026-10-18', linkedin: 9, facebook: 2, other: 1 }],
      groups: [group],
      floors: [{ platform: 'linkedin', adapter: 'linkedin@2026.10.2', setAt: AT }],
    };
    expect(AdminReportsSummarySchema.parse(summary)).toEqual(summary);
    expect(ReportGroupSchema.safeParse({ ...group, perDay: [1, 2] }).success).toBe(false);
    expect(ReportGroupSchema.safeParse({ ...group, key: 'linkedin|Jane|detection|x' }).success).toBe(false);
    expect(AdminReportRowSchema.parse(row)).toEqual(row);
    expect(AdminReportRowSchema.safeParse({ ...row, ref: '7kq3-m2pa' }).success).toBe(false);
    expect(AdminReportRowSchema.safeParse({ ...row, resolution: 'wontfix' }).success).toBe(false);
    expect(AdminReportListSchema.safeParse({ rows: [row], nextBefore: null }).success).toBe(true);
    expect(AdminReportListSchema.safeParse({ rows: Array.from({ length: 51 }, () => row), nextBefore: null }).success).toBe(
      false,
    );
    const detail = {
      ...row,
      kind: 'correction',
      from: 'sidepanel',
      platform: null,
      adapter: null,
      topic: 'factcheck',
      choices: ['verdict-wrong'],
      hasMessage: true,
      hasContact: true,
      details: { correction: { feature: 'factcheck', promptVersion: 3, via: 'cloud' } },
      unknownCodes: 0,
      message: 'Wrong year.',
      contact: 'ann@example.org',
      lines: ['unAlgorithm 0.4.1 from the Chrome Web Store'],
      handledBy: null,
    };
    expect(AdminReportDetailSchema.parse(detail)).toEqual(detail);
    // The stored details never repeat the message or the contact (they are their own columns).
    const withWords = { ...detail, details: { correction: { ...detail.details.correction, message: 'x', contact: 'a@b.co' } } };
    expect(AdminReportDetailSchema.parse(withWords).details).toEqual(detail.details);
    expect(AdminReportDetailSchema.safeParse({ ...detail, contact: 'not an address' }).success).toBe(false);
    expect(AdminReportsListQuerySchema.parse({})).toEqual({ status: 'open' });
    expect(AdminReportsListQuerySchema.safeParse({ ref: '7KQ3-M2PA', status: 'all' }).success).toBe(true);
    expect(AdminReportsListQuerySchema.safeParse({ status: 'closed' }).success).toBe(false);
  });

  it('test_admin_report_requests', () => {
    expect(HandleReportsRequestSchema.safeParse({ ids: [REPORT_ID], handled: true, resolution: 'fixed' }).success).toBe(true);
    expect(HandleReportsRequestSchema.safeParse({ group: group.key, handled: true, resolution: 'corrected' }).success).toBe(true);
    expect(HandleReportsRequestSchema.safeParse({ ids: [REPORT_ID], handled: false }).success).toBe(true);
    for (const bad of [
      { ids: [REPORT_ID], group: group.key, handled: true, resolution: 'fixed' },
      { handled: true, resolution: 'fixed' },
      { ids: [REPORT_ID], handled: true },
      { ids: [REPORT_ID], handled: false, resolution: 'fixed' },
      { ids: [], handled: false },
      { ids: ['1'], handled: false },
      { ids: Array.from({ length: 501 }, () => REPORT_ID), handled: false },
      { ids: [REPORT_ID], handled: true, resolution: 'wontfix' },
    ]) {
      expect(HandleReportsRequestSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
    expect(SetFloorRequestSchema.safeParse({ platform: 'linkedin', adapter: 'linkedin@2026.11.0' }).success).toBe(true);
    expect(SetFloorRequestSchema.safeParse({ platform: 'linkedin', adapter: null }).success).toBe(true);
    expect(SetFloorRequestSchema.safeParse({ platform: 'linkedin', adapter: 'facebook@2026.11.0' }).success).toBe(false);
    expect(SetFloorRequestSchema.safeParse({ platform: 'linkedin', adapter: '2026.11.0' }).success).toBe(false);
    expect(ForgetContactRequestSchema.safeParse({ id: REPORT_ID }).success).toBe(true);
    expect(ForgetContactRequestSchema.safeParse({ id: 'x' }).success).toBe(false);
    expect(DeleteReportsRequestSchema.safeParse({ ids: Array.from({ length: 100 }, () => REPORT_ID) }).success).toBe(true);
    expect(DeleteReportsRequestSchema.safeParse({ ids: Array.from({ length: 101 }, () => REPORT_ID) }).success).toBe(false);
    expect(DeleteReportsRequestSchema.safeParse({ ids: [] }).success).toBe(false);
  });

  it('test_admin_report_path_rejects_bad_ids', () => {
    expect(adminReportPath(REPORT_ID)).toBe(`/v1/admin/reports/${REPORT_ID}`);
    for (const bad of ['', 'summary', '../users', `${REPORT_ID}/x`]) {
      expect(() => adminReportPath(bad), bad).toThrow(new TypeError('Not a report id.'));
    }
  });
});

describe('content-free contract', () => {
  it('test_admin_schemas_field_sets', () => {
    const fields = Object.fromEntries(
      Object.entries({
        AdminUserSchema,
        InviteSchema,
        AdminUsersSchema,
        UsageDaySchema,
        BackupStatusSchema,
        OpenAlertSchema,
        OpsStatusSchema,
        AdminOverviewSchema,
        SetCapRequestSchema,
        SetAccessRequestSchema,
        SetRoleRequestSchema,
        InviteRequestSchema,
        SetupRequestSchema,
        AdminOkSchema,
      }).map(([name, schema]) => [name, Object.keys(schema.shape)]),
    );
    const objectSchemas = Object.entries(admin).filter(([, value]) => value instanceof z.ZodObject);
    expect(objectSchemas.map(([name]) => name).sort()).toEqual(Object.keys(fields).sort());
    expect(fields).toMatchInlineSnapshot(`
      {
        "AdminOkSchema": [
          "ok",
        ],
        "AdminOverviewSchema": [
          "version",
          "users",
          "today",
          "last30Days",
          "spendLimitMicros",
          "breakerTripped",
          "defaultDailyPostCap",
          "ops",
          "reports",
        ],
        "AdminUserSchema": [
          "id",
          "email",
          "role",
          "access",
          "createdAt",
          "lastActiveAt",
          "activeDevices",
          "postsToday",
          "posts30Days",
          "costMicros30Days",
          "dailyPostCap",
        ],
        "AdminUsersSchema": [
          "users",
          "truncated",
          "invites",
          "defaultDailyPostCap",
        ],
        "BackupStatusSchema": [
          "kind",
          "ok",
          "finishedAt",
          "lastSuccessAt",
          "bytes",
          "error",
        ],
        "InviteRequestSchema": [
          "email",
        ],
        "InviteSchema": [
          "email",
          "createdAt",
        ],
        "OpenAlertSchema": [
          "key",
          "level",
          "openedAt",
        ],
        "OpsStatusSchema": [
          "diskFreeBytes",
          "diskTotalBytes",
          "databaseBytes",
          "errors15m",
          "backups",
          "openAlerts",
        ],
        "SetAccessRequestSchema": [
          "access",
        ],
        "SetCapRequestSchema": [
          "dailyPostCap",
        ],
        "SetRoleRequestSchema": [
          "role",
        ],
        "SetupRequestSchema": [
          "token",
        ],
        "UsageDaySchema": [
          "day",
          "posts",
          "requests",
          "costMicros",
        ],
      }
    `);
  });
});
