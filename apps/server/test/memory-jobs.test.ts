import { readFileSync } from 'node:fs';
import {
  FACTCHECK_JOB_TTL_MS,
  FactcheckJobRequestSchema,
  FactcheckJobSchema,
  type FactcheckResult,
  ServerInfoSchema,
} from '@unalgorithm/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJobStore, JobCancelled, type JobStoreOptions } from '../src/jobs/memory-jobs.ts';

const ID = '7d1f3c2a-4b5e-4f60-8a71-9b2c3d4e5f60';
const RESULT: FactcheckResult = {
  v: 1,
  checkedAt: '2026-10-15T12:00:00.000Z',
  model: 'claude-test',
  promptVersion: 1,
  claims: [],
  sources: [],
};
const POST = {
  ref: 'p1',
  platform: 'facebook',
  text: 'The moon is made of cheese.',
  textComplete: true,
  authorKind: 'person',
  isReshare: false,
  media: 'none',
  audience: 'public',
};

function store(opts: Partial<JobStoreOptions> = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const jobs = createJobStore<string>({ ttlMs: 60_000, maxRunning: 8, maxKeptPerUser: 5, now: clock.now, ...opts });
  return { jobs, clock };
}

function started(r: ReturnType<ReturnType<typeof store>['jobs']['start']>) {
  if (!r.ok) throw new Error(`start refused: ${r.reason}`);
  return r;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('fact-check job contract', () => {
  it('test_factcheck_job_request_schema', () => {
    const parsed = FactcheckJobRequestSchema.parse({ v: 1, post: { ...POST, author: 'someone' } });
    expect(parsed.post).not.toHaveProperty('author');
    expect(parsed.post.text).toBe(POST.text);
    const { text: _text, ...noText } = POST;
    expect(FactcheckJobRequestSchema.safeParse({ v: 1, post: noText }).success).toBe(false);
  });

  it('test_factcheck_job_schema_status_rules', () => {
    const ok = (j: object) => FactcheckJobSchema.safeParse({ v: 1, id: ID, ...j }).success;
    expect(ok({ status: 'done', result: RESULT, billing: { chargedMicros: 240_000, balanceMicros: 1 } })).toBe(true);
    expect(ok({ status: 'running' })).toBe(true);
    expect(ok({ status: 'failed', error: { code: 'not-available', message: 'down' } })).toBe(true);
    expect(ok({ status: 'cancelled' })).toBe(true);
    expect(ok({ status: 'done' })).toBe(false);
    expect(ok({ status: 'failed' })).toBe(false);
    expect(ok({ status: 'running', result: RESULT })).toBe(false);
  });

  it('test_server_info_optional_factcheck_fields', () => {
    const cl4 = {
      v: 1,
      name: 'Test server',
      version: '0.1.0',
      source: 'https://example.com/source',
      billing: false,
      capabilities: { classify: true, sync: true },
      auth: { methods: ['email-otp'], authorizePath: '/authorize', tokenPath: '/v1/auth/token' },
      limits: { maxPostsPerRequest: 12 },
    };
    expect(ServerInfoSchema.parse(cl4).jobPrices).toBeUndefined();
    const next = ServerInfoSchema.parse({
      ...cl4,
      billing: true,
      capabilities: { ...cl4.capabilities, factcheck: true },
      jobPrices: { factcheck: { typicalMicros: 240_000, maxMicros: 400_000 } },
    });
    expect(next.capabilities.factcheck).toBe(true);
    expect(next.jobPrices?.factcheck).toEqual({ typicalMicros: 240_000, maxMicros: 400_000 });
    expect(ServerInfoSchema.safeParse({ ...cl4, jobPrices: { factcheck: { typicalMicros: -1, maxMicros: 0 } } }).success).toBe(
      false,
    );
  });
});

describe('in-memory job store', () => {
  it('test_job_store_start_limits', () => {
    const { jobs } = store({ maxRunning: 2 });
    const a = started(jobs.start('alice'));
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(jobs.start('alice')).toEqual({ ok: false, reason: 'busy-user' });
    const b = started(jobs.start('bob'));
    expect(b.id).not.toBe(a.id);
    expect(jobs.start('carol')).toEqual({ ok: false, reason: 'busy-server' });
    expect(jobs.running).toBe(2);
    jobs.finish(a.id, { status: 'done', result: 'r' });
    const a2 = started(jobs.start('alice'));
    expect(new Set([a.id, b.id, a2.id]).size).toBe(3);
  });

  it('test_job_store_view_owner_only_and_expiry', () => {
    const { jobs, clock } = store();
    const { id } = started(jobs.start('alice'));
    expect(jobs.view(id, 'alice')).toEqual({ id, status: 'running' });
    jobs.finish(id, { status: 'done', result: 'r', billing: { chargedMicros: 5, balanceMicros: 10 } });
    expect(jobs.view(id, 'alice')).toEqual({
      id,
      status: 'done',
      result: 'r',
      billing: { chargedMicros: 5, balanceMicros: 10 },
    });
    expect(jobs.view(id, 'bob')).toBeUndefined();
    expect(jobs.view(crypto.randomUUID(), 'alice')).toBeUndefined();
    clock.advance(60_001);
    expect(jobs.view(id, 'alice')).toBeUndefined();
    expect(jobs.size).toBe(0);
  });

  it('test_job_store_view_expires_without_further_calls', () => {
    vi.useFakeTimers();
    const handles: { hasRef?: () => boolean }[] = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms: number) => {
      const h = real(fn, ms);
      handles.push(h as unknown as { hasRef?: () => boolean });
      return h;
    }) as typeof setTimeout);
    const jobs = createJobStore<string>({ ttlMs: FACTCHECK_JOB_TTL_MS, maxRunning: 8, maxKeptPerUser: 5 });
    const { id } = started(jobs.start('alice'));
    jobs.finish(id, { status: 'done', result: 'claims derived from a post' });
    expect(jobs.size).toBe(1);
    expect(handles).toHaveLength(1);
    expect(handles[0]?.hasRef?.()).toBe(false);
    vi.advanceTimersByTime(FACTCHECK_JOB_TTL_MS - 1);
    expect(jobs.size).toBe(1);
    vi.advanceTimersByTime(1);
    expect(jobs.size).toBe(0);
  });

  it('test_job_store_wait_for', async () => {
    vi.useFakeTimers();
    const { jobs } = store();
    const a = started(jobs.start('alice'));
    const ended = jobs.waitFor(a.id, 'alice', 20_000);
    jobs.finish(a.id, { status: 'done', result: 'r' });
    await expect(ended).resolves.toEqual({ id: a.id, status: 'done', result: 'r' });

    const b = started(jobs.start('alice'));
    const timedOut = jobs.waitFor(b.id, 'alice', 20_000);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(timedOut).resolves.toEqual({ id: b.id, status: 'running' });

    const abort = new AbortController();
    const aborted = jobs.waitFor(b.id, 'alice', 20_000, abort.signal);
    abort.abort();
    await expect(aborted).resolves.toEqual({ id: b.id, status: 'running' });

    expect(await jobs.waitFor(b.id, 'bob', 20_000)).toBeUndefined();
    const pre = new AbortController();
    pre.abort();
    await expect(jobs.waitFor(b.id, 'alice', 20_000, pre.signal)).resolves.toEqual({ id: b.id, status: 'running' });
  });

  it('test_job_store_cancel', () => {
    const { jobs } = store();
    const a = started(jobs.start('alice'));
    expect(jobs.cancel(a.id, 'bob')).toBe(false);
    expect(a.signal.aborted).toBe(false);
    expect(jobs.cancel(a.id, 'alice')).toBe(true);
    expect(a.signal.aborted).toBe(true);
    expect(a.signal.reason).toBeInstanceOf(JobCancelled);
    jobs.finish(a.id, { status: 'cancelled' });
    expect(jobs.view(a.id, 'alice')?.status).toBe('cancelled');
    expect(jobs.cancel(a.id, 'alice')).toBe(false);
  });

  it('test_job_store_abort_all_and_drain', async () => {
    vi.useFakeTimers();
    const { jobs } = store();
    const a = started(jobs.start('alice'));
    const b = started(jobs.start('bob'));
    const reason = new Error('stopping');
    jobs.abortAll(reason);
    expect(a.signal.reason).toBe(reason);
    expect(b.signal.reason).toBe(reason);

    let drained = false;
    const drain = jobs.drain(30_000).then(() => (drained = true));
    jobs.finish(a.id, { status: 'cancelled' });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);
    jobs.finish(b.id, { status: 'failed', error: { code: 'not-available', message: 'stopped' } });
    await drain;
    expect(jobs.running).toBe(0);

    started(jobs.start('carol'));
    let late = false;
    const timed = jobs.drain(5_000).then(() => (late = true));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(late).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await timed;
    await expect(store().jobs.drain(1_000)).resolves.toBeUndefined();
  });

  it('test_job_store_keeps_five_ended_per_user', () => {
    const { jobs, clock } = store();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const { id } = started(jobs.start('alice'));
      jobs.finish(id, { status: 'done', result: `r${i}` });
      ids.push(id);
      clock.advance(1);
    }
    const { id: bobs } = started(jobs.start('bob'));
    jobs.finish(bobs, { status: 'cancelled' });
    expect(jobs.view(ids[0] as string, 'alice')).toBeUndefined();
    for (const id of ids.slice(1)) expect(jobs.view(id, 'alice')?.status).toBe('done');
    expect(jobs.view(bobs, 'bob')?.status).toBe('cancelled');
    expect(jobs.size).toBe(6);
  });

  it('test_job_store_discard', () => {
    const { jobs } = store();
    const { id } = started(jobs.start('alice'));
    jobs.discard(id);
    expect(jobs.view(id, 'alice')).toBeUndefined();
    expect(jobs.size).toBe(0);
    expect(jobs.running).toBe(0);
    expect(jobs.start('alice').ok).toBe(true);
  });
});

describe('privacy', () => {
  it('test_job_store_has_no_storage_or_log_imports', () => {
    const source = readFileSync(new URL('../src/jobs/memory-jobs.ts', import.meta.url), 'utf8');
    const imports = source.split('\n').filter((line) => /^\s*(import|export)\b.*\bfrom\b|^\s*import\s*['"(]/.test(line));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      expect(line).not.toMatch(/graphile-worker|['"]\.\/worker(\.ts)?['"]|jobs\/worker|\/db\/|['"]\.\.\/db['"]|log(\.ts)?['"]/);
    }
    expect(source).not.toMatch(/console\.|\bimport\(/);
  });
});
