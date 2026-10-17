/**
 * The public source list (P3-67, decision D96): `GET /outlets.json` with its ETag and `GET /outlets/changes.json`, read
 * by any origin with no session, logged only as the `http` line, and never naming who changed what. The outlets are
 * saved through P3-73's admin route; fictional `.example` outlets with `evidence.example` links only.
 */
import {
  ADMIN_OUTLETS_PATH,
  OfficialListSchema,
  OUTLET_CHANGES_JSON_PATH,
  OUTLETS_JSON_PATH,
  OutletChangesSchema,
  type OutletInput,
} from '@unalgorithm/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ROLE } from '../src/admin/access.ts';
import { listVersion } from '../src/admin/outlets.ts';
import { user } from '../src/db/schema.ts';
import { postJson, signInWeb } from './support/sign-in.ts';
import { createTestApp, TEST_PUBLIC_URL, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const ADA = 'ada@example.com';
const JSON_UTF8 = 'application/json; charset=utf-8';
/** An address a proxy would add: never in a log line. */
const FORWARDED = { 'X-Forwarded-For': '203.0.113.7' };

/** Fictional outlets, the only kind a test gives a lean. */
const FX: OutletInput = {
  id: 'fx-news',
  name: 'FX News',
  domains: ['fx-news.example'],
  country: 'US',
  lean: { bucket: 'center', evidence: [{ url: 'https://evidence.example/fx-news', note: 'Fictional.' }] },
};
const FX_OTHER: OutletInput = { id: 'fx-other', name: 'FX Other', domains: ['fx-other.example'], country: 'CA', lean: null };
const FX_LEFT: OutletInput = { ...FX, lean: { bucket: 'lean-left', evidence: [...(FX.lean?.evidence ?? [])] } };

/** Apps a test opened, closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A test server where Ada is the admin, signed in on the page; `change` sends one change through the admin route. */
async function publicApp() {
  const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: ADA }) });
  cleanup.push(() => t.close());
  const admin = await signInWeb(t.app, t.outbox, ADA);
  await t.deps.db.db.update(user).set({ role: ADMIN_ROLE }).where(eq(user.email, ADA));
  const [row] = await t.deps.db.db.select({ id: user.id }).from(user).where(eq(user.email, ADA));
  if (!row) throw new Error('No account.');
  const change = async (body: unknown) => {
    const res = await postJson(t.app, ADMIN_OUTLETS_PATH, body, { Origin: TEST_PUBLIC_URL, Cookie: admin });
    expect(res.status).toBe(200);
  };
  const get = (path: string, headers: Record<string, string> = {}) => Promise.resolve(t.app.request(path, { headers }));
  return { t, admin, adaId: row.id, change, get };
}

/** Two fictional outlets, saved as two changes: the list is at version 2. */
async function withTwoOutlets() {
  const app = await publicApp();
  await app.change({ action: 'add', baseVersion: '0', outlet: FX });
  await app.change({ action: 'add', baseVersion: '1', outlet: FX_OTHER });
  return app;
}

/** The headers every answer of both routes carries. */
function expectPublicHeaders(res: Response) {
  expect(res.headers.get('access-control-allow-origin')).toBe('*');
  expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  expect(res.headers.getSetCookie()).toEqual([]);
}

describe('public JSON', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_public_list_shape_and_headers', async () => {
    const { t, get } = await withTwoOutlets();
    const res = await get(OUTLETS_JSON_PATH, { Origin: 'https://any.example' });
    expect(res.status).toBe(200);
    expectPublicHeaders(res);
    expect(res.headers.get('content-type')).toBe(JSON_UTF8);

    const raw: unknown = await res.json();
    const body = OfficialListSchema.parse(raw);
    // Parsed unchanged: nothing the contract doesn't list.
    expect(body).toEqual(raw);
    const version = await listVersion(t.deps.db.db);
    expect(version).toBe('2');
    expect(body.version).toBe(version);
    expect(body.license).toBe('CC-BY-4.0');
    expect(res.headers.get('etag')).toBe(`"outlets-${version}"`);
    const day = body.updatedAt?.slice(0, 10);
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.outlets).toEqual([
      { ...FX, changedOn: day },
      { ...FX_OTHER, changedOn: day },
    ]);
  });

  it('test_public_list_not_modified_on_matching_etag', async () => {
    const { change, get } = await withTwoOutlets();
    const tag = '"outlets-2"';
    for (const ifNoneMatch of [tag, `W/${tag}`, `"outlets-1", ${tag}`, `W/"outlets-1",W/${tag}`, '*']) {
      const res = await get(OUTLETS_JSON_PATH, { 'If-None-Match': ifNoneMatch });
      expect(res.status, ifNoneMatch).toBe(304);
      expect(await res.text()).toBe('');
      expect(res.headers.get('etag')).toBe(tag);
      expectPublicHeaders(res);
    }
    // A tag of another version, or no tag at all, gets the list.
    for (const ifNoneMatch of ['"outlets-1"', '"outlets-2', 'outlets-2', '"outlets-20"']) {
      const res = await get(OUTLETS_JSON_PATH, { 'If-None-Match': ifNoneMatch });
      expect(res.status, ifNoneMatch).toBe(200);
      expect(OfficialListSchema.parse(await res.json()).version).toBe('2');
    }

    // One more change: the old tag gets the new version.
    await change({ action: 'edit', baseVersion: '2', outlet: FX_LEFT });
    const res = await get(OUTLETS_JSON_PATH, { 'If-None-Match': tag });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"outlets-3"');
    expectPublicHeaders(res);
    const list = OfficialListSchema.parse(await res.json());
    expect(list.version).toBe('3');
    expect(list.outlets.map((o) => o.lean?.bucket ?? null)).toEqual(['lean-left', null]);
  });

  it('test_public_list_empty_server', async () => {
    const t = await createTestApp();
    cleanup.push(() => t.close());
    const res = await t.app.request(OUTLETS_JSON_PATH);
    expect(res.status).toBe(200);
    expectPublicHeaders(res);
    expect(res.headers.get('etag')).toBe('"outlets-0"');
    expect(await res.json()).toEqual({ v: 1, version: '0', updatedAt: null, license: 'CC-BY-4.0', outlets: [] });

    const changes = await t.app.request(OUTLET_CHANGES_JSON_PATH);
    expect(changes.status).toBe(200);
    expect(await changes.json()).toEqual({ v: 1, changes: [] });
  });

  it('test_public_list_ignores_session_and_sets_no_cookie', async () => {
    const { admin, get } = await withTwoOutlets();
    for (const path of [OUTLETS_JSON_PATH, OUTLET_CHANGES_JSON_PATH]) {
      const anonymous = await get(path);
      const signedIn = await get(path, { Cookie: admin });
      expect(anonymous.status, path).toBe(200);
      expect(signedIn.status, path).toBe(200);
      expectPublicHeaders(anonymous);
      expectPublicHeaders(signedIn);
      expect(await signedIn.text()).toBe(await anonymous.text());
    }
    // The 304 too.
    const notModified = await get(OUTLETS_JSON_PATH, { Cookie: admin, 'If-None-Match': '"outlets-2"' });
    expect(notModified.status).toBe(304);
    expectPublicHeaders(notModified);
  });

  it('test_public_changes_without_identities', async () => {
    const { adaId, change, get } = await withTwoOutlets();
    await change({ action: 'edit', baseVersion: '2', outlet: FX_LEFT });
    await change({ action: 'remove', baseVersion: '3', id: 'fx-other' });

    const res = await get(OUTLET_CHANGES_JSON_PATH, { Origin: 'https://any.example' });
    expect(res.status).toBe(200);
    expectPublicHeaders(res);
    expect(res.headers.get('content-type')).toBe(JSON_UTF8);
    // The list's version is the list's: the history has no tag of its own.
    expect(res.headers.get('etag')).toBeNull();

    const text = await res.text();
    expect(text).not.toContain(ADA);
    expect(text).not.toContain(adaId);
    expect(text).not.toContain('"by"');
    const body = JSON.parse(text);
    expect(OutletChangesSchema.parse(body)).toEqual(body);
    const { changes } = OutletChangesSchema.parse(body);
    expect(changes.map((c) => [c.seq, c.action, c.outletId])).toEqual([
      [4, 'remove', 'fx-other'],
      [3, 'edit', 'fx-news'],
      [2, 'add', 'fx-other'],
      [1, 'add', 'fx-news'],
    ]);
    const [removed, edited] = changes;
    expect(removed?.after).toBeNull();
    expect(removed?.before?.name).toBe('FX Other');
    expect(edited?.before?.lean?.bucket).toBe('center');
    expect(edited?.after?.lean?.bucket).toBe('lean-left');
  });

  it('test_public_list_logs_only_http_lines', async () => {
    const { t, admin, get } = await withTwoOutlets();
    const from = t.lines.length;
    await get(OUTLETS_JSON_PATH, FORWARDED);
    await get(OUTLETS_JSON_PATH, { ...FORWARDED, Cookie: admin, 'If-None-Match': '"outlets-2"' });
    await get(OUTLET_CHANGES_JSON_PATH, { ...FORWARDED, Cookie: admin });

    const lines = t.lines.slice(from);
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((e) => [e.event, e.method, e.path, e.status])).toEqual([
      ['http', 'GET', OUTLETS_JSON_PATH, 200],
      ['http', 'GET', OUTLETS_JSON_PATH, 304],
      ['http', 'GET', OUTLET_CHANGES_JSON_PATH, 200],
    ]);
    for (const e of events) {
      expect(Object.keys(e).sort()).toEqual(['event', 'level', 'method', 'ms', 'path', 'rid', 'status', 't']);
    }
    expect(lines.filter((line) => ['203.0.113.7', '127.0.0.1', ADA, 'fx-news'].some((w) => line.includes(w)))).toEqual([]);
  });
});
