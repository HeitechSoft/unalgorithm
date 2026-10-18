// Before any Date is made: Toronto is never UTC, so a quarter or a month read in local time shows up as a wrong one.
process.env.TZ = 'America/Toronto';

/**
 * The transparency report (P3-70, decisions D89, D90, D108): one quarter's counts from the rows the server already keeps
 * without content (`usage_events`, `ai_routes`, `outlet_changes`), with small counts of people and checks hidden. Fictional
 * `.example` outlets with `evidence.example` links only; every model is a stored row, never called.
 */
import { randomUUID } from 'node:crypto';
import { FEATURE_NAMES, type LeanBucket, type OfficialOutlet } from '@unalgorithm/protocol';
import { FACTCHECK_PROMPT_VERSION, PERSPECTIVES_PROMPT_VERSION } from '@unalgorithm/research';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ROLE } from '../src/admin/access.ts';
import { listAtQuarterEnd } from '../src/admin/outlets.ts';
import { checkCounts } from '../src/admin/queries.ts';
import { main, quarterRange, shownCount } from '../src/cli/transparency.ts';
import { SERVER_VERSION } from '../src/config.ts';
import type { Db, DbHandle } from '../src/db/client.ts';
import { aiRoutes, devices, outletChanges, usageEvents, user } from '../src/db/schema.ts';
import { createTestDb } from './support/db.ts';
import { scanAllTables } from './support/scan-tables.ts';
import { TEST_PUBLIC_URL, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const USAGE = 'usage: node apps/server/src/cli/transparency.ts --quarter YYYY-Qn';
const NOT_ENDED = "That quarter hasn't ended yet.";
const Q4 = { from: new Date('2026-10-01T00:00:00.000Z'), to: new Date('2027-01-01T00:00:00.000Z') };

/** Databases a test opened, closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function pgliteHandle(): Promise<DbHandle> {
  const handle = await createTestDb();
  cleanup.push(() => handle.close());
  return handle;
}

/** Every identifier a seeded row holds, for the privacy test: addresses, account, device and request ids. */
interface Seeded {
  identifiers: string[];
  /** The seq of December's list change: the list's version at the end of Q4. */
  december?: number;
}

async function addUser(
  db: Db,
  seeded: Seeded,
  email: string,
  role: string | null = null,
): Promise<{ id: string; device: string }> {
  const id = randomUUID();
  const createdAt = new Date('2026-09-01T00:00:00.000Z');
  await db.insert(user).values({ id, name: '', email, emailVerified: true, createdAt, updatedAt: createdAt, role });
  const [device] = await db
    .insert(devices)
    .values({ userId: id, clientId: 'test-extension', name: 'Chrome on Windows', createdAt })
    .returning({ id: devices.id });
  if (!device) throw new Error('No device.');
  seeded.identifiers.push(email, id, device.id);
  return { id, device: device.id };
}

interface UsageRow {
  task: string;
  outcome: string;
  webSearches?: number;
}

/** One usage row as metering writes it, created at `createdAt`: a job's rows have `posts_ok` 0. */
async function addUsage(db: Db, seeded: Seeded, who: { id: string; device: string }, createdAt: string, row: UsageRow) {
  const requestId = randomUUID();
  seeded.identifiers.push(requestId);
  const calls = row.outcome === 'refused-before-call' ? 0 : 1;
  await db.insert(usageEvents).values({
    requestId,
    userId: who.id,
    deviceId: who.device,
    task: row.task,
    model: 'mock-model',
    outcome: row.outcome,
    postsRequested: row.task === 'classify' ? 1 : 0,
    postsOk: row.task === 'classify' && row.outcome === 'ok' ? 1 : 0,
    calls,
    failedCalls: row.outcome === 'failed' ? 1 : 0,
    uncachedInput: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    webSearches: row.webSearches ?? 0,
    estimated: false,
    costMicros: calls * 1000,
    chargeableCostMicros: row.outcome === 'ok' ? 1000 : 0,
    createdAt: new Date(createdAt),
  });
}

/** A fictional outlet as published, with `bucket`'s lean or none. */
function fictional(id: string, bucket: LeanBucket | null, changedOn: string): OfficialOutlet {
  return {
    id,
    name: id.toUpperCase(),
    domains: [`${id}.example`],
    country: 'US',
    lean: bucket === null ? null : { bucket, evidence: [{ url: `https://evidence.example/${id}`, note: 'Fictional.' }] },
    changedOn,
  };
}

/** One history row at `at`, as `applyOutletChange` writes it; answers its seq. */
async function addChange(
  db: Db,
  adminId: string,
  at: string,
  action: 'import' | 'add' | 'edit' | 'remove',
  outletId: string,
  before: LeanBucket | null | undefined,
  after: LeanBucket | null | undefined,
): Promise<number> {
  const day = at.slice(0, 10);
  const [row] = await db
    .insert(outletChanges)
    .values({
      action,
      outletId,
      before: before === undefined ? null : fictional(outletId, before, '2026-09-01'),
      after: after === undefined ? null : fictional(outletId, after, day),
      changedBy: adminId,
      changedAt: new Date(at),
    })
    .returning({ seq: outletChanges.seq });
  if (!row) throw new Error('No change.');
  return row.seq;
}

/** AC 4's history: answers the seq of December's change. */
async function seedHistory(db: Db, adminId: string): Promise<number> {
  await addChange(db, adminId, '2026-09-10T12:00:00.000Z', 'add', 'fx-a', undefined, 'center');
  await addChange(db, adminId, '2026-09-11T12:00:00.000Z', 'add', 'fx-c', undefined, 'right');
  await addChange(db, adminId, '2026-09-12T12:00:00.000Z', 'add', 'fx-d', undefined, 'left');
  await addChange(db, adminId, '2026-11-02T12:00:00.000Z', 'add', 'fx-b', undefined, 'left');
  await addChange(db, adminId, '2026-11-03T12:00:00.000Z', 'edit', 'fx-c', 'right', 'lean-right');
  const december = await addChange(db, adminId, '2026-12-04T12:00:00.000Z', 'remove', 'fx-d', 'left', undefined);
  await addChange(db, adminId, '2027-01-01T00:00:00.000Z', 'add', 'fx-e', undefined, 'right');
  return december;
}

/**
 * AC 2's usage, with rows just outside Q4 and `classify` rows that never count: 12 fact-checks from Ada, Bea and Cat
 * (10 finished, 2 not), one refusal from Dan, and nothing for UnEcho Chamber in the quarter. 22 web searches.
 */
async function seedUsage(db: Db, seeded: Seeded) {
  const ada = await addUser(db, seeded, 'ada@example.com');
  const bea = await addUser(db, seeded, 'bea@example.com');
  const cat = await addUser(db, seeded, 'cat@example.com');
  const dan = await addUser(db, seeded, 'dan@example.com');
  const day = (d: number) => `2026-11-${String(d).padStart(2, '0')}T15:00:00.000Z`;
  const finished = [ada, ada, ada, ada, bea, bea, bea, cat, cat, cat];
  for (const [i, who] of finished.entries()) {
    await addUsage(db, seeded, who, day(i + 1), { task: 'factcheck', outcome: 'ok', webSearches: 2 });
  }
  await addUsage(db, seeded, ada, day(20), { task: 'factcheck', outcome: 'failed', webSearches: 1 });
  await addUsage(db, seeded, bea, day(21), { task: 'factcheck', outcome: 'failed', webSearches: 1 });
  await addUsage(db, seeded, dan, day(22), { task: 'factcheck', outcome: 'refused-before-call' });
  for (let i = 0; i < 3; i++) await addUsage(db, seeded, dan, day(23), { task: 'classify', outcome: 'ok' });
  // Outside the quarter, on both sides.
  await addUsage(db, seeded, dan, '2026-09-30T23:59:59.000Z', { task: 'factcheck', outcome: 'ok', webSearches: 5 });
  await addUsage(db, seeded, dan, '2027-01-01T00:00:00.000Z', { task: 'perspectives', outcome: 'ok', webSearches: 5 });
}

/** Two enabled routes, research and synthesis, and a replaced classify route kept disabled. */
async function seedRoutes(db: Db) {
  await db.insert(aiRoutes).values([
    {
      task: 'synthesis',
      provider: 'openai-compatible',
      model: 'mock-synthesis-model',
      baseUrl: 'http://127.0.0.1:4010/v1',
      effort: 'medium',
      dataPolicy: 'self-hosted',
    },
    { task: 'research', provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium', dataPolicy: 'vendor-zdr' },
    {
      task: 'classify',
      provider: 'anthropic',
      model: 'replaced-classify-model',
      effort: 'low',
      dataPolicy: 'vendor-zdr',
      enabled: false,
    },
  ]);
}

/** Everything a report reads, the admin who made the list's changes included. */
async function seedAll(db: Db): Promise<Seeded> {
  const seeded: Seeded = { identifiers: [] };
  const admin = await addUser(db, seeded, 'admin@example.com', ADMIN_ROLE);
  await seedUsage(db, seeded);
  await seedRoutes(db);
  seeded.december = await seedHistory(db, admin.id);
  return seeded;
}

/** `main` with a PGlite database and the test config; answers its exit code and what it printed. */
async function run(argv: readonly string[], now: string, handle?: DbHandle): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const code = await main(argv, {
    db: handle,
    config: testConfig(),
    out: (line) => lines.push(line),
    now: () => new Date(now),
  });
  return { code, text: lines.join('\n') };
}

describe('counts', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_check_counts_quarter_bounds', async () => {
    const { db } = await pgliteHandle();
    const seeded: Seeded = { identifiers: [] };
    const ada = await addUser(db, seeded, 'ada@example.com');
    for (const at of [
      '2026-09-30T23:59:59.000Z',
      '2026-10-01T00:00:00.000Z',
      '2026-12-31T23:59:59.999Z',
      '2027-01-01T00:00:00.000Z',
    ]) {
      await addUsage(db, seeded, ada, at, { task: 'factcheck', outcome: 'ok', webSearches: 1 });
      await addUsage(db, seeded, ada, at, { task: 'perspectives', outcome: 'failed', webSearches: 3 });
    }
    expect(await checkCounts(db, Q4.from, Q4.to)).toStrictEqual([
      { task: 'factcheck', finished: 2, unfinished: 0, refused: 0, webSearches: 2, people: 1 },
      { task: 'perspectives', finished: 0, unfinished: 2, refused: 0, webSearches: 6, people: 1 },
    ]);
  });

  it('test_check_counts_by_outcome_and_people', async () => {
    const { db } = await pgliteHandle();
    await seedUsage(db, { identifiers: [] });
    expect(await checkCounts(db, Q4.from, Q4.to)).toStrictEqual([
      { task: 'factcheck', finished: 10, unfinished: 2, refused: 1, webSearches: 22, people: 3 },
      { task: 'perspectives', finished: 0, unfinished: 0, refused: 0, webSearches: 0, people: 0 },
    ]);
    // An empty quarter: both tasks, all zeros.
    const q2 = quarterRange('2026-Q2');
    if (!q2) throw new Error('No quarter.');
    expect(await checkCounts(db, q2.from, q2.to)).toStrictEqual([
      { task: 'factcheck', finished: 0, unfinished: 0, refused: 0, webSearches: 0, people: 0 },
      { task: 'perspectives', finished: 0, unfinished: 0, refused: 0, webSearches: 0, people: 0 },
    ]);
  });

  it('test_list_at_quarter_end_from_history', async () => {
    const { db } = await pgliteHandle();
    const admin = await addUser(db, { identifiers: [] }, 'admin@example.com', ADMIN_ROLE);
    const december = await seedHistory(db, admin.id);
    expect(await listAtQuarterEnd(db, Q4.from, Q4.to)).toStrictEqual({
      version: String(december),
      counts: { left: 1, 'lean-left': 0, center: 1, 'lean-right': 1, right: 0 },
      changes: { import: 0, add: 1, edit: 1, remove: 1 },
    });
    // Before any change: version '0', nothing listed.
    const q2 = quarterRange('2026-Q2');
    if (!q2) throw new Error('No quarter.');
    expect(await listAtQuarterEnd(db, q2.from, q2.to)).toStrictEqual({
      version: '0',
      counts: { left: 0, 'lean-left': 0, center: 0, 'lean-right': 0, right: 0 },
      changes: { import: 0, add: 0, edit: 0, remove: 0 },
    });
  });
});

describe('report', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_shown_count_hides_small_numbers', () => {
    expect(shownCount(0)).toBe('0');
    expect(shownCount(1)).toBe('fewer than 10');
    expect(shownCount(9)).toBe('fewer than 10');
    expect(shownCount(10)).toBe('10');
    expect(shownCount(1234)).toBe('1,234');
    expect(quarterRange('2026-Q4')).toStrictEqual(Q4);
    expect(quarterRange('2027-Q1')).toStrictEqual({
      from: new Date('2027-01-01T00:00:00.000Z'),
      to: new Date('2027-04-01T00:00:00.000Z'),
    });
    for (const bad of ['2026-Q0', '2026-Q5', '2026Q4', '26-Q4', '2026-q4', ' 2026-Q4']) expect(quarterRange(bad), bad).toBeNull();
  });

  it('test_transparency_prints_quarter_report', async () => {
    const handle = await pgliteHandle();
    const { december } = await seedAll(handle.db);
    const { code, text } = await run(['--quarter', '2026-Q4'], '2027-01-02T00:00:00.000Z', handle);
    expect(code).toBe(0);
    const lines = text.split('\n');
    expect(lines[0]).toBe('## October to December 2026');
    expect(lines).toContain(
      `From 2026-10-01 to 2026-12-31 (UTC), on ${new URL(TEST_PUBLIC_URL).origin} (server ${SERVER_VERSION}).`,
    );
    const table = lines.filter((line) => line.startsWith('|'));
    expect(table).toStrictEqual([
      `|  | ${FEATURE_NAMES.factcheck} | ${FEATURE_NAMES.perspectives} |`,
      '| --- | ---: | ---: |',
      '| Finished | 10 | 0 |',
      "| Didn't finish | fewer than 10 | 0 |",
      '| Refused before any AI call | fewer than 10 | 0 |',
      '| Web searches | 22 | 0 |',
      '| People who used it | fewer than 10 | 0 |',
    ]);
    expect(lines).toContain(
      'AI models: research claude-sonnet-5-5 (anthropic), synthesis mock-synthesis-model (openai-compatible).',
    );
    expect(text).not.toContain('replaced-classify-model');
    expect(lines).toContain(
      `Prompt versions: ${FEATURE_NAMES.factcheck} ${FACTCHECK_PROMPT_VERSION}, ${FEATURE_NAMES.perspectives} ${PERSPECTIVES_PROMPT_VERSION}.`,
    );
    expect(lines).toContain(
      `Source list: version ${december} at the end of the quarter; outlets with a lean: Left 1 · Leans left 0 · Center 1 · ` +
        'Leans right 1 · Right 0; changes this quarter: 1 added, 1 edited, 1 removed, 0 imported.',
    );
    expect(lines.at(-1)).toBe("This server keeps no post, no claim and no one's results, so this report has no verdict counts.");
  });

  it('test_transparency_refuses_open_or_bad_quarter', async () => {
    expect(await run(['--quarter', '2026-Q4'], '2026-12-31T23:59:59.999Z')).toStrictEqual({ code: 1, text: NOT_ENDED });
    for (const argv of [
      ['--quarter', '2026-Q5'],
      [],
      ['--quarter'],
      ['2026-Q4'],
      ['--quarter', '2026-Q4', 'extra'],
      ['--year', '2026-Q4'],
    ]) {
      expect(await run(argv, '2027-01-02T00:00:00.000Z'), argv.join(' ')).toStrictEqual({ code: 1, text: USAGE });
    }
  });

  it('test_transparency_report_is_content_free_and_read_only', async () => {
    const handle = await pgliteHandle();
    const seeded = await seedAll(handle.db);
    expect(seeded.identifiers.length).toBeGreaterThan(20);
    const before = await scanAllTables(handle);
    const { code, text } = await run(['--quarter', '2026-Q4'], '2027-01-02T00:00:00.000Z', handle);
    expect(code).toBe(0);
    for (const id of seeded.identifiers) expect(text, id).not.toContain(id);
    expect(text).not.toMatch(/@/);
    expect(await scanAllTables(handle)).toStrictEqual(before);
  });
});
