import { afterEach, describe, expect, it } from 'vitest';
import { AUTH_PURGE_SCHEDULE, AUTH_PURGE_TASK, purgeExpiredAuthRows, registerAuthJobs } from '../src/auth/purge.ts';
import type { DbHandle } from '../src/db/client.ts';
import { authCodes, devices, refreshTokens, user, verification } from '../src/db/schema.ts';
import { createJobRegistry, type JobHandler, type JobRegistry } from '../src/jobs/worker.ts';
import { createTestDb } from './support/db.ts';
import { captureLog } from './support/log.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function testDb(): Promise<DbHandle> {
  const h = await createTestDb();
  cleanup.push(() => h.close());
  return h;
}

/** An account with one device; refresh tokens, extension codes and verification rows on either side of `now`. */
async function seed(h: DbHandle, now: number) {
  const at = (offsetMs: number) => new Date(now + offsetMs);
  const created = at(-90 * DAY_MS);
  await h.db
    .insert(user)
    .values({ id: 'u1', name: '', email: 'tom@example.com', emailVerified: true, createdAt: created, updatedAt: created });
  const [device] = await h.db
    .insert(devices)
    .values({ userId: 'u1', clientId: 'c'.repeat(32) })
    .returning({ id: devices.id });
  if (!device) throw new Error('No device.');
  const token = (name: string, expiresAt: Date, usedAt: Date | null = null) => ({
    deviceId: device.id,
    tokenHash: name,
    expiresAt,
    usedAt,
  });
  await h.db
    .insert(refreshTokens)
    .values([
      token('expired-spent', at(-1), at(-30 * DAY_MS)),
      token('expired-unused', at(-DAY_MS)),
      token('live-spent', at(DAY_MS), at(-MINUTE_MS)),
      token('live', at(60 * DAY_MS)),
    ]);
  const code = (codeHash: string, expiresAt: Date) => ({
    codeHash,
    userId: 'u1',
    clientId: 'c'.repeat(32),
    redirectUri: 'https://example.chromiumapp.org/',
    codeChallenge: 'x'.repeat(43),
    expiresAt,
  });
  await h.db.insert(authCodes).values([code('expired-code', at(-MINUTE_MS)), code('live-code', at(MINUTE_MS))]);
  const row = (id: string, expiresAt: Date) => ({ id, identifier: `sign-in-otp-${id}`, value: 'hash:0', expiresAt });
  await h.db.insert(verification).values([row('expired-otp', at(-MINUTE_MS)), row('live-otp', at(4 * MINUTE_MS))]);
}

describe('purge', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_purge_deletes_expired_auth_rows', async () => {
    const h = await testDb();
    await seed(h, NOW);

    expect(await purgeExpiredAuthRows(h.db, NOW)).toEqual({ refreshTokens: 2, authCodes: 1, verification: 1 });
    // A spent token stays until its own expiry: a copy of it coming back is still caught as reuse.
    expect((await h.db.select().from(refreshTokens)).map((r) => r.tokenHash).sort()).toEqual(['live', 'live-spent']);
    expect((await h.db.select().from(authCodes)).map((r) => r.codeHash)).toEqual(['live-code']);
    expect((await h.db.select().from(verification)).map((r) => r.id)).toEqual(['live-otp']);
    // The device and the account are not touched, and a second run finds nothing.
    expect(await h.db.select().from(devices)).toHaveLength(1);
    expect(await purgeExpiredAuthRows(h.db, NOW)).toEqual({ refreshTokens: 0, authCodes: 0, verification: 0 });
  });

  it('test_register_auth_jobs', async () => {
    const h = await testDb();
    // The task deletes by the clock: rows on either side of it.
    await seed(h, Date.now());
    const tasks = new Map<string, JobHandler>();
    const schedules: [string, string][] = [];
    const recording: JobRegistry = {
      task: (name, handler) => tasks.set(name, handler),
      cron: (task, match) => schedules.push([task, match]),
    };
    registerAuthJobs(recording, { db: h.db });
    expect([...tasks.keys()]).toEqual([AUTH_PURGE_TASK]);
    expect(schedules).toEqual([[AUTH_PURGE_TASK, AUTH_PURGE_SCHEDULE]]);
    expect(AUTH_PURGE_TASK).toBe('auth.purge-expired');
    expect(AUTH_PURGE_SCHEDULE).toBe('23 * * * *');

    // It logs the counts only.
    const { log, events } = captureLog();
    await tasks.get(AUTH_PURGE_TASK)?.({}, { signal: new AbortController().signal, log });
    expect(events()).toEqual([
      expect.objectContaining({ event: 'auth.purged', refresh_tokens: 2, auth_codes: 1, verification: 1 }),
    ]);

    // A real registry takes the task once.
    const jobs = createJobRegistry();
    registerAuthJobs(jobs, { db: h.db });
    expect(() => registerAuthJobs(jobs, { db: h.db })).toThrow(TypeError);
  });
});
