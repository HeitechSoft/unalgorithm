import { type AddressInfo, createServer } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DbHandle, openPglite, openPostgres } from '../src/db/client.ts';
import { startServer } from '../src/index.ts';
import { createJobRegistry, type JobHandler, type JobRegistry, startJobs } from '../src/jobs/worker.ts';
import type { Logger } from '../src/log.ts';
import { queryRows } from './support/db.ts';
import { captureLog } from './support/log.ts';
import { createPostgresTestDb, TEST_DATABASE_URL } from './support/postgres.ts';
import { testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

/** How long a queued job may take to reach its handler (AC 4). */
const PICKUP_MS = 5_000;

/** Handles, runners and databases a test opened, closed or dropped after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const noop: JobHandler = async () => {};

/** Whether the database has graphile-worker's schema, which only a started worker creates. */
async function hasWorkerSchema(db: DbHandle): Promise<boolean> {
  const rows = await queryRows(db, sql`select to_regnamespace('graphile_worker')::text as schema`);
  return rows[0]?.schema !== null;
}

/** Keys a line may have. graphile-worker's own lines (`jobs.log`) have no others: never its message. */
const WORKER_LOG_KEYS = new Set(['t', 'level', 'event', 'task', 'job_id', 'err_name', 'err_code', 'err_stack']);

describe('registry', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_registry_rejects_bad_names_and_schedules', () => {
    const jobs = createJobRegistry();
    for (const name of [
      'Bad Name',
      'billing',
      'billing.',
      '.x',
      'billing.X',
      'billing..x',
      '1billing.x',
      'billing.x_y',
      'billing.-x',
      '',
    ])
      expect(() => jobs.task(name, noop), name).toThrow(TypeError);
    jobs.task('billing.x', noop);
    jobs.task('billing.expire-lots', noop);
    jobs.task('a.b2.c-3', noop);
    expect(() => jobs.task('billing.x', noop)).toThrow(TypeError);

    expect(() => jobs.cron('unknown.task', '* * * * *')).toThrow(TypeError);
    // A bad schedule fails here, not when the server starts.
    expect(() => jobs.cron('billing.x', 'not a cron')).toThrow();
    expect(() => jobs.cron('billing.x', '* * * *')).toThrow();
    expect(() => jobs.cron('billing.x', '61 * * * *')).toThrow();
    jobs.cron('billing.x', '0 3 * * *');
    // One schedule per task: graphile-worker tells cron items apart by their task.
    expect(() => jobs.cron('billing.x', '30 3 * * *')).toThrow(TypeError);
    jobs.cron('billing.expire-lots', '*/15 * * * *');
  });

  it('test_registry_frozen_after_start', async () => {
    const db = await openPglite();
    cleanup.push(() => db.close());
    const { log } = captureLog();
    const jobs = createJobRegistry();
    jobs.task('test.echo', noop);

    const running = await startJobs(db, jobs, log);
    expect(() => jobs.task('test.other', noop)).toThrow();
    expect(() => jobs.cron('test.echo', '* * * * *')).toThrow();
    // A registry starts once: a second runner would take the same jobs.
    await expect(startJobs(db, jobs, log)).rejects.toThrow();

    await expect(running.stop()).resolves.toBeUndefined();
    await expect(running.stop()).resolves.toBeUndefined();
  });
});

describe('pglite', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_pglite_disables_jobs', async () => {
    const db = await openPglite();
    cleanup.push(() => db.close());
    const { log, events } = captureLog();
    const jobs = createJobRegistry();
    const handler = vi.fn<JobHandler>(async () => {});
    jobs.task('test.echo', handler);
    jobs.cron('test.echo', '* * * * *');

    const running = await startJobs(db, jobs, log);
    await expect(running.addJob('test.echo', { n: 1 })).resolves.toBeUndefined();
    await expect(running.stop()).resolves.toBeUndefined();

    expect(events()).toEqual([expect.objectContaining({ event: 'jobs.disabled', reason: 'pglite' })]);
    expect(handler).not.toHaveBeenCalled();
    expect(await hasWorkerSchema(db)).toBe(false);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('runner', { timeout: PGLITE_TIMEOUT }, () => {
  /** A fresh Postgres database and a handle on it, both cleaned up after the test. */
  async function postgres(prefix = 'ua_jobs') {
    const pg = await createPostgresTestDb(prefix);
    cleanup.push(() => pg.drop());
    const db = openPostgres(pg.url);
    cleanup.push(() => db.close());
    if (db.kind !== 'postgres') throw new Error('expected a Postgres handle');
    return { pg, db };
  }

  async function start(db: DbHandle, jobs: JobRegistry, log: Logger) {
    const running = await startJobs(db, jobs, log);
    // Before the database closes: the worker shares its pool.
    cleanup.push(() => running.stop());
    return running;
  }

  it('test_no_tasks_starts_nothing', async () => {
    const { db } = await postgres();
    const { log, events } = captureLog();
    const running = await start(db, createJobRegistry(), log);
    // Not even a connection.
    expect(db.pool.totalCount).toBe(0);
    expect(await hasWorkerSchema(db)).toBe(false);
    expect(events()).toEqual([]);
    await expect(running.addJob('test.echo', { n: 1 })).resolves.toBeUndefined();
    await expect(running.stop()).resolves.toBeUndefined();
  });

  it('test_job_runs_with_payload', async () => {
    const { db } = await postgres();
    const { log, events } = captureLog();
    const jobs = createJobRegistry();
    const calls: { payload: unknown; signal: AbortSignal }[] = [];
    jobs.task('test.echo', async (payload, ctx) => {
      calls.push({ payload, signal: ctx.signal });
      ctx.log.info('test.echo.ran');
    });
    jobs.cron('test.echo', '0 3 * * *');

    // graphile-worker warns on the console about a pool without error listeners on its connections.
    const consoleWarn = vi.spyOn(console, 'warn');
    cleanup.push(async () => consoleWarn.mockRestore());
    const running = await start(db, jobs, log);
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(events().filter((e) => e.event === 'jobs.started')).toEqual([
      expect.objectContaining({ level: 'info', tasks: 1, schedules: 1 }),
    ]);
    expect(await hasWorkerSchema(db)).toBe(true);
    await running.addJob('test.echo', { n: 1 });
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: PICKUP_MS, interval: 20 });
    expect(calls[0]?.payload).toEqual({ n: 1 });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);

    // stop() waits for the job in flight, which logs when it returns.
    await expect(running.stop()).resolves.toBeUndefined();
    await expect(running.stop()).resolves.toBeUndefined();
    const done = events().filter((e) => e.event === 'jobs.task.done');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ level: 'info', task: 'test.echo', job_id: expect.any(String), ms: expect.any(Number) });
    // The handler's logger names its task.
    expect(events().find((e) => e.event === 'test.echo.ran')).toMatchObject({ task: 'test.echo' });
    for (const line of events().filter((e) => e.event === 'jobs.log'))
      for (const key of Object.keys(line)) expect([key, WORKER_LOG_KEYS.has(key)]).toEqual([key, true]);
  });

  it('test_failed_job_logs_no_message', async () => {
    const { db } = await postgres();
    const { log, lines, events } = captureLog();
    const jobs = createJobRegistry();
    jobs.task('test.fail', async () => {
      throw new Error('secret text');
    });

    const running = await start(db, jobs, log);
    await running.addJob('test.fail', { n: 1 });
    await vi.waitFor(() => expect(events().some((e) => e.event === 'jobs.task.failed')).toBe(true), {
      timeout: PICKUP_MS,
      interval: 20,
    });
    await running.stop();

    const failed = events().filter((e) => e.event === 'jobs.task.failed');
    for (const line of failed)
      expect(line).toMatchObject({ level: 'error', task: 'test.fail', job_id: expect.any(String), err_name: 'Error' });
    expect(lines.join('')).not.toContain('secret text');
    for (const line of events().filter((e) => e.event === 'jobs.log'))
      for (const key of Object.keys(line)) expect([key, WORKER_LOG_KEYS.has(key)]).toEqual([key, true]);

    // The job stays queued for a retry, and the error graphile-worker keeps with it holds no message either.
    const kept = await queryRows(db, sql`select attempts, last_error from graphile_worker._private_jobs`);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.attempts).toBeGreaterThanOrEqual(1);
    expect(String(kept[0]?.last_error)).not.toContain('secret text');
  });

  it('test_server_starts_and_stops_with_jobs', async () => {
    const pg = await createPostgresTestDb('ua_jobs_server');
    cleanup.push(() => pg.drop());
    const { log } = captureLog();

    const db = openPostgres(pg.url);
    cleanup.push(() => db.close());
    const server = await startServer(testConfig(), { db, port: 0, log });
    cleanup.push(() => server.close());
    const res = await fetch(`${server.url}/health`);
    expect(res.status).toBe(200);
    await expect(server.close()).resolves.toBeUndefined();
    if (db.kind !== 'postgres') throw new Error('expected a Postgres handle');
    expect(db.pool.totalCount).toBe(0);

    // A port that is taken: the start fails after the jobs started, and the pool is closed.
    const held = createServer();
    await new Promise<void>((resolve) => held.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise((resolve) => held.close(resolve)));
    const { port } = held.address() as AddressInfo;
    const again = openPostgres(pg.url);
    cleanup.push(() => again.close());
    await expect(startServer(testConfig(), { db: again, port, log })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    if (again.kind !== 'postgres') throw new Error('expected a Postgres handle');
    expect(again.pool.totalCount).toBe(0);
    expect(again.pool.ending).toBe(true);
  });
});
