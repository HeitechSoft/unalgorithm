import type { StatsFs } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ADMIN_OVERVIEW_PATH, AdminOverviewSchema, OpsStatusSchema } from '@unalgorithm/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ROLE } from '../src/admin/access.ts';
import type { Db } from '../src/db/client.ts';
import { user } from '../src/db/schema.ts';
import { createLogger } from '../src/log.ts';
import { createErrorWindow, ERROR_WINDOW_MINUTES } from '../src/ops/error-window.ts';
import { databaseBytes, readBackupStatuses, readDiskUsage, readOpsStatus } from '../src/ops/status.ts';
import { createTestDb } from './support/db.ts';
import { captureLog } from './support/log.ts';
import { signInWeb } from './support/sign-in.ts';
import { createTestApp, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const MINUTE = 60_000;
const ADA = 'ada@example.com';
const GB = 1_000_000_000;
/** In every status file a test writes, so a log line holding a file's content shows up. */
const CANARY = 'CANARY-ops-7Q2';

/** Folders, databases and apps a test opened, removed or closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A new empty temporary folder (an absolute path). */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ua-ops-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A status file as backup.sh writes it: one JSON line. */
function statusLine(kind: string, fields: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    v: 1,
    kind,
    ok: true,
    finished_at: '2026-10-14T03:17:42Z',
    last_success_at: '2026-10-14T03:17:42Z',
    file: 'unalgorithm-20261014T031700Z.dump.gpg',
    bytes: 123_456,
    error: null,
    ...fields,
  })}\n`;
}

/** A `statfs` answer of `free` bytes free of `total`, in 4 KiB blocks. */
function fsStats(free: number, total: number): StatsFs {
  const bsize = 4096;
  return { type: 0, bsize, blocks: total / bsize, bfree: free / bsize, bavail: free / bsize, files: 0, ffree: 0 };
}

const unreadable = (kind: string) => ({
  kind,
  ok: false,
  finishedAt: null,
  lastSuccessAt: null,
  bytes: null,
  error: 'unreadable',
});

/** A database whose every query fails, with a message that must never be logged. */
const brokenDb = {
  execute: () => Promise.reject(Object.assign(new Error(`relation ${CANARY} broke`), { code: '58000' })),
} as unknown as Db;

describe('errors', () => {
  it('test_error_window_counts_last_15_minutes', () => {
    expect(ERROR_WINDOW_MINUTES).toBe(15);
    const start = Date.UTC(2026, 9, 14, 12, 0, 0);
    const window = createErrorWindow();
    expect(window.count(start)).toBe(0);
    for (let i = 0; i < 3; i++) window.record(start + i * 1000);
    expect(window.count(start + 30_000)).toBe(3);
    expect(window.count(start + 14 * MINUTE + 59_000)).toBe(3);
    expect(window.count(start + 15 * MINUTE)).toBe(0);

    // One a minute for 20 minutes: the last 15 count.
    const spread = createErrorWindow();
    for (let m = 0; m < 20; m++) spread.record(start + m * MINUTE);
    expect(spread.count(start + 19 * MINUTE)).toBe(15);
    expect(spread.count(start + 19 * MINUTE + 59_000)).toBe(15);
    expect(spread.count(start + 25 * MINUTE)).toBe(9);
  });

  it('test_logger_on_error_counts_error_lines_only', () => {
    let calls = 0;
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', sink: (line) => lines.push(line), onError: () => calls++ });
    log.debug('a.debug');
    log.info('a.info');
    log.warn('a.warn');
    expect(calls).toBe(0);
    log.error('a.error');
    expect(calls).toBe(1);
    const child = log.child({ rid: 'r1' }).child({ step: 2 });
    child.info('b.info');
    child.warn('b.warn');
    child.error('b.error');
    expect(calls).toBe(2);
    // The lines themselves are unchanged.
    expect(JSON.parse(lines.at(-1) ?? '')).toMatchObject({ level: 'error', event: 'b.error', rid: 'r1', step: 2 });
    expect(lines).toHaveLength(7);

    // The test logger counts into its window.
    const capture = captureLog();
    capture.log.child({ rid: 'x' }).error('c.error');
    capture.log.warn('c.warn');
    expect(capture.errors.count()).toBe(1);
  });
});

describe('backups', () => {
  it('test_read_backup_statuses_valid_and_unreadable', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'local.json'), statusLine('local'));
    await writeFile(
      join(dir, 'offsite.json'),
      statusLine('offsite', { ok: false, finished_at: '2026-10-14T04:00:00Z', file: null, bytes: null, error: 'copy' }),
    );
    expect(await readBackupStatuses(dir)).toEqual([
      {
        kind: 'local',
        ok: true,
        finishedAt: '2026-10-14T03:17:42Z',
        lastSuccessAt: '2026-10-14T03:17:42Z',
        bytes: 123_456,
        error: null,
      },
      {
        kind: 'offsite',
        ok: false,
        finishedAt: '2026-10-14T04:00:00Z',
        lastSuccessAt: '2026-10-14T03:17:42Z',
        bytes: null,
        error: 'copy',
      },
    ]);

    expect(await readBackupStatuses(join(dir, 'missing'))).toEqual([]);

    const bad = await tempDir();
    // Valid but for its size: 5,000 bytes, the line padded with spaces.
    await writeFile(join(bad, 'big.json'), statusLine('big').padEnd(5000, ' '));
    await writeFile(join(bad, 'nojson.json'), `not json ${CANARY}`);
    await writeFile(join(bad, 'v2.json'), statusLine('v2', { v: 2 }));
    await writeFile(join(bad, 'oops.json'), statusLine('oops', { ok: false, error: 'oops' }));
    await writeFile(join(bad, 'local.json'), statusLine('offsite'));
    expect(await readBackupStatuses(bad)).toEqual(['big', 'local', 'nojson', 'oops', 'v2'].map(unreadable));

    // In a folder of their own: Windows and macOS file names ignore case.
    const ignored = await tempDir();
    await writeFile(join(ignored, 'Local.json'), statusLine('local'));
    await writeFile(join(ignored, 'notes.txt'), CANARY);
    expect(await readBackupStatuses(ignored)).toEqual([]);

    const many = await tempDir();
    const kinds = Array.from({ length: 12 }, (_, i) => `k${String(i).padStart(2, '0')}`);
    for (const kind of kinds) await writeFile(join(many, `${kind}.json`), statusLine(kind));
    const statuses = await readBackupStatuses(many);
    expect(statuses.map((s) => s.kind)).toEqual(kinds.slice(0, 10));
    expect(statuses.every((s) => s.ok && !('file' in s))).toBe(true);
  });
});

describe('disk and database', () => {
  it('test_read_disk_usage_picks_fullest_filesystem', async () => {
    const answers: Record<string, StatsFs> = { '/': fsStats(40 * GB, 100 * GB), '/backup-status': fsStats(8 * GB, 50 * GB) };
    const statfs = async (path: string) => {
      const answer = answers[path];
      if (!answer) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
      return answer;
    };
    expect(await readDiskUsage(['/', '/backup-status'], statfs)).toEqual({ freeBytes: 8 * GB, totalBytes: 50 * GB });
    expect(await readDiskUsage(['/', '/gone'], statfs)).toEqual({ freeBytes: 40 * GB, totalBytes: 100 * GB });
    expect(await readDiskUsage(['/gone', '/also-gone'], statfs)).toBeNull();

    const real = await readDiskUsage([tmpdir()]);
    expect(real?.freeBytes).toBeGreaterThan(0);
    expect(real?.totalBytes).toBeGreaterThanOrEqual(real?.freeBytes ?? Number.POSITIVE_INFINITY);
    expect(Number.isSafeInteger(real?.totalBytes)).toBe(true);
  });

  it('test_database_bytes_and_failure', { timeout: PGLITE_TIMEOUT }, async () => {
    const handle = await createTestDb();
    cleanup.push(() => handle.close());
    const { log, events, lines } = captureLog();
    const bytes = await databaseBytes(handle.db, log);
    expect(Number.isSafeInteger(bytes)).toBe(true);
    expect(bytes).toBeGreaterThan(0);
    expect(lines).toEqual([]);

    expect(await databaseBytes(brokenDb, log)).toBeNull();
    expect(events()).toEqual([expect.objectContaining({ level: 'warn', event: 'ops.database_size_failed', err_code: '58000' })]);
    expect(lines.join('')).not.toContain(CANARY);
    expect(lines.join('')).not.toContain('broke');
  });
});

describe('status and route', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_read_ops_status_defaults', async () => {
    const handle = await createTestDb();
    cleanup.push(() => handle.close());
    const { log } = captureLog();
    const errors = createErrorWindow();
    const now = Date.UTC(2026, 9, 14, 12, 0, 0);
    errors.record(now - MINUTE);
    const statfs = async () => fsStats(8 * GB, 50 * GB);
    const status = await readOpsStatus({ db: handle.db, config: {}, log, errors, statfs, now });
    expect(OpsStatusSchema.parse(status)).toEqual(status);
    expect(status).toMatchObject({ diskFreeBytes: 8 * GB, diskTotalBytes: 50 * GB, errors15m: 1, backups: null, openAlerts: [] });
    expect(status.databaseBytes).toBeGreaterThan(0);

    // Every read failing still answers, with nulls.
    const failing = async () => Promise.reject(new Error('no statfs'));
    const empty = await readOpsStatus({ db: brokenDb, config: {}, log, errors, statfs: failing, now });
    expect(OpsStatusSchema.parse(empty)).toEqual(empty);
    expect(empty).toMatchObject({ diskFreeBytes: null, diskTotalBytes: null, databaseBytes: null, backups: null });

    // A watched but empty folder, and the alerts CL4-15 passes.
    const dir = await tempDir();
    const openedAt = '2026-10-14T11:00:00.000Z';
    const watched = await readOpsStatus({
      db: handle.db,
      config: { backupStatusDir: join(dir, 'status') },
      log,
      errors,
      statfs,
      now,
      alerts: async () => [{ key: 'disk-free-low', level: 'warning', openedAt }],
    });
    expect(watched.backups).toEqual([]);
    expect(watched.openAlerts).toEqual([{ key: 'disk-free-low', level: 'warning', openedAt }]);
  });

  it('test_admin_overview_reports_ops', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'local.json'), statusLine('local'));
    const t = await adminApp({ BACKUP_STATUS_DIR: dir });

    const before = AdminOverviewSchema.parse(await (await t.get(ADMIN_OVERVIEW_PATH)).json());
    expect(before.ops).not.toBeNull();
    expect(before.ops?.errors15m).toBe(0);

    expect((await t.app.request('/v1/test-boom')).status).toBe(500);
    expect(
      t
        .events()
        .filter((e) => e.level === 'error')
        .map((e) => e.event),
    ).toEqual(['http.error']);

    const res = await t.get(ADMIN_OVERVIEW_PATH);
    expect(res.status).toBe(200);
    const overview = AdminOverviewSchema.parse(await res.json());
    expect(overview.ops?.errors15m).toBe(1);
    expect(overview.ops?.backups).toEqual([
      {
        kind: 'local',
        ok: true,
        finishedAt: '2026-10-14T03:17:42Z',
        lastSuccessAt: '2026-10-14T03:17:42Z',
        bytes: 123_456,
        error: null,
      },
    ]);
    expect(overview.ops?.databaseBytes).toBeGreaterThan(0);
    expect(overview.ops?.openAlerts).toEqual([]);
    expect(overview.users).toBe(1);
  });

  it('test_ops_logs_hold_no_content', async () => {
    const dir = await tempDir();
    const statusDir = join(dir, 'status');
    await mkdir(statusDir);
    await writeFile(join(statusDir, 'local.json'), statusLine('local', { note: CANARY }));
    await writeFile(join(statusDir, 'offsite.json'), `{"v":1,"kind":"offsite","note":"${CANARY}"`);
    await writeFile(join(statusDir, 'big.json'), CANARY.repeat(500));
    const t = await adminApp({ BACKUP_STATUS_DIR: statusDir });
    await t.app.request('/v1/test-boom');
    const overview = AdminOverviewSchema.parse(await (await t.get(ADMIN_OVERVIEW_PATH)).json());
    expect(overview.ops?.backups?.map((b) => [b.kind, b.error])).toEqual([
      ['big', 'unreadable'],
      ['local', null],
      ['offsite', 'unreadable'],
    ]);
    // The database size failing logs its line, without the error's message.
    await readOpsStatus({
      db: brokenDb,
      config: t.deps.config,
      log: t.deps.log,
      errors: createErrorWindow(),
    });
    expect(t.events().some((e) => e.event === 'ops.database_size_failed')).toBe(true);

    const all = t.lines.join('');
    expect(all).not.toContain(CANARY);
    expect(all).not.toContain(basename(dir));
    expect(all).not.toContain('local.json');
    // The http.error line's stack frames hold package directories with an `@` (`hono@4.13.13`); every other field none.
    const withoutStacks = t.events().map(({ err_stack: _stack, ...fields }) => JSON.stringify(fields));
    expect(withoutStacks.filter((line) => line.includes('@'))).toEqual([]);
  });
});

/**
 * A test server whose only account, Ada, is the admin and signed in on the page; `env` adds variables. Its
 * `/v1/test-boom` throws an error whose message holds the canary and the status folder.
 */
async function adminApp(env: Record<string, string>) {
  const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: ADA, ...env }) });
  cleanup.push(() => t.close());
  t.app.get('/v1/test-boom', () => {
    throw new Error(`boom ${CANARY} ${env.BACKUP_STATUS_DIR}`);
  });
  const admin = await signInWeb(t.app, t.outbox, ADA);
  await t.deps.db.db.update(user).set({ role: ADMIN_ROLE }).where(eq(user.email, ADA));
  const get = (path: string) => t.app.request(path, { headers: { Cookie: admin } });
  return { ...t, get };
}
