/**
 * The server's source list (P3-73): admins add, edit and remove outlets through the admin routes, or import the
 * candidate list into an empty list, and every change lands in the history. Fictional `.example` outlets with
 * `evidence.example` links only, and leans only on those; the import uses the real candidates, which hold none.
 */
import { bundledCandidates, listProblemText } from '@unalgorithm/outlets';
import {
  ACCOUNT_DELETE_PATH,
  ADMIN_OUTLETS_IMPORT_PATH,
  ADMIN_OUTLETS_PATH,
  type AdminOutlets,
  AdminOutletsSchema,
  type OfficialOutlet,
  type OutletInput,
} from '@unalgorithm/protocol';
import { asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ROLE, NOT_ADMIN } from '../src/admin/access.ts';
import { REFUSED } from '../src/auth/web-session.ts';
import { outletChanges, outlets, user } from '../src/db/schema.ts';
import { NOT_FOUND } from '../src/routes/openapi.ts';
import { scanAllTables } from './support/scan-tables.ts';
import { postJson, signInWeb } from './support/sign-in.ts';
import { createTestApp, TEST_PUBLIC_URL, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const ADA = 'ada@example.com';
const BEA = 'bea@example.com';
const NOT_VALID = { code: 'bad-request', message: 'The request was not valid.' };
const LIST_CHANGED = { code: 'bad-request', message: 'The list changed since you opened it. Reload it and try again.' };
const ID_TAKEN = { code: 'bad-request', message: 'An outlet with this id already exists.' };
const NOT_EMPTY = { code: 'bad-request', message: "The source list isn't empty." };

/** A fictional outlet, the only kind a test gives a lean. */
const FX: OutletInput = {
  id: 'fx-news',
  name: 'FX News',
  domains: ['fx-news.example'],
  country: 'US',
  lean: { bucket: 'center', evidence: [{ url: 'https://evidence.example/fx-news', note: 'Fictional.' }] },
};
const FX_LEFT: OutletInput = { ...FX, lean: { bucket: 'lean-left', evidence: [...(FX.lean?.evidence ?? [])] } };

const add = (outlet: unknown, baseVersion: string) => ({ action: 'add', baseVersion, outlet });
const edit = (outlet: unknown, baseVersion: string) => ({ action: 'edit', baseVersion, outlet });
const remove = (id: string, baseVersion: string) => ({ action: 'remove', baseVersion, id });

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/** Apps a test opened, closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function userId(t: TestApp, email: string): Promise<string> {
  const [row] = await t.deps.db.db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (!row) throw new Error('No account.');
  return row.id;
}

/** A test server where Ada is the admin and Bea a member, both signed in on the page (as `admin-actions.test.ts`). */
async function outletApp() {
  const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: `${ADA},${BEA}` }) });
  cleanup.push(() => t.close());
  const admin = await signInWeb(t.app, t.outbox, ADA);
  const member = await signInWeb(t.app, t.outbox, BEA);
  await t.deps.db.db.update(user).set({ role: ADMIN_ROLE }).where(eq(user.email, ADA));
  const adaId = await userId(t, ADA);
  /** A POST from the page (or from `origin`, or with no `Origin` when null) with this session cookie (none when null). */
  const post = (path: string, body: unknown, cookie: string | null = admin, origin: string | null = TEST_PUBLIC_URL) =>
    postJson(t.app, path, body, { ...(origin === null ? {} : { Origin: origin }), ...(cookie ? { Cookie: cookie } : {}) });
  const change = (body: unknown) => post(ADMIN_OUTLETS_PATH, body);
  const get = (cookie: string | null = admin) => t.app.request(ADMIN_OUTLETS_PATH, { headers: cookie ? { Cookie: cookie } : {} });
  /** What the admin page reads, after checking that the contract parses it unchanged. */
  const page = async (cookie = admin): Promise<AdminOutlets> => {
    const res = await get(cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(AdminOutletsSchema.parse(body)).toEqual(body);
    return body as AdminOutlets;
  };
  /** How many rows the two tables hold. */
  const counts = async () => ({
    outlets: (await t.deps.db.db.select({ id: outlets.id }).from(outlets)).length,
    changes: (await t.deps.db.db.select({ seq: outletChanges.seq }).from(outletChanges)).length,
  });
  return { t, admin, member, adaId, post, change, get, page, counts };
}

async function expectAnswer(res: Response, status: number, body: unknown) {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual(body);
}

const ok = (version: string) => ({ ok: true, version });
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The outlet as published on `day`. */
const published = (outlet: OutletInput, day: string): OfficialOutlet => ({ ...outlet, changedOn: day });

describe('edits', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_admin_adds_outlet_with_history', async () => {
    const { change, page } = await outletApp();
    const start = Date.now();
    await expectAnswer(await change(add(FX, '0')), 200, ok('1'));
    const end = Date.now();

    const { list, changes } = await page();
    const [only] = changes;
    if (!only) throw new Error('No change.');
    // Today, in UTC: the change's own day.
    const at = Date.parse(only.at);
    expect(at).toBeGreaterThanOrEqual(start - 1000);
    expect(at).toBeLessThanOrEqual(end + 1000);
    const today = only.at.slice(0, 10);
    expect([dayOf(start), dayOf(end)]).toContain(today);

    expect(list).toEqual({ v: 1, version: '1', updatedAt: only.at, license: 'CC-BY-4.0', outlets: [published(FX, today)] });
    expect(changes).toEqual([
      { seq: 1, at: only.at, action: 'add', outletId: 'fx-news', before: null, after: published(FX, today), by: ADA },
    ]);
  });

  it('test_admin_edits_and_removes_with_history', async () => {
    const { change, page, counts } = await outletApp();
    await expectAnswer(await change(add(FX, '0')), 200, ok('1'));
    await expectAnswer(await change(edit(FX_LEFT, '1')), 200, ok('2'));
    // An edit that changes nothing writes nothing and answers the current version.
    await expectAnswer(await change(edit(FX_LEFT, '2')), 200, ok('2'));
    expect(await counts()).toEqual({ outlets: 1, changes: 2 });
    expect((await page()).list.outlets.map((o) => o.lean?.bucket)).toEqual(['lean-left']);
    await expectAnswer(await change(remove('fx-news', '2')), 200, ok('3'));

    const { list, changes } = await page();
    expect(list.outlets).toEqual([]);
    expect(list.version).toBe('3');
    expect(list.updatedAt).toBe(changes[0]?.at);
    expect(await counts()).toEqual({ outlets: 0, changes: 3 });

    const days = changes.map((c) => c.at.slice(0, 10));
    const [removedOn = '', editedOn = '', addedOn = ''] = days;
    expect(changes).toEqual([
      {
        seq: 3,
        at: expect.any(String),
        action: 'remove',
        outletId: 'fx-news',
        before: published(FX_LEFT, editedOn),
        after: null,
        by: ADA,
      },
      {
        seq: 2,
        at: expect.any(String),
        action: 'edit',
        outletId: 'fx-news',
        before: published(FX, addedOn),
        after: published(FX_LEFT, editedOn),
        by: ADA,
      },
      {
        seq: 1,
        at: expect.any(String),
        action: 'add',
        outletId: 'fx-news',
        before: null,
        after: published(FX, addedOn),
        by: ADA,
      },
    ]);
    expect(removedOn).not.toBe('');
  });

  it('test_outlet_input_refused_by_schema', async () => {
    const { change, counts } = await outletApp();
    const refused = [
      add({ ...FX, lean: { bucket: 'center', evidence: [] } }, '0'),
      add({ ...FX, lean: { bucket: 'center' } }, '0'),
      add(
        { ...FX, lean: { bucket: 'center', evidence: [{ url: 'http://evidence.example/fx-news', note: 'Plain HTTP.' }] } },
        '0',
      ),
      add({ ...FX, domains: ['www.fx-news.example'] }, '0'),
      add({ ...FX, owner: 'Someone' }, '0'),
      add({ ...FX, changedOn: '2026-01-15' }, '0'),
      { ...add(FX, '0'), note: 'Extra.' },
      add(FX, 'latest'),
      { action: 'import', baseVersion: '0', outlet: FX },
      edit({ ...FX, lean: { bucket: 'far-left', evidence: FX.lean?.evidence } }, '0'),
      remove('FX News', '0'),
    ];
    for (const body of refused) await expectAnswer(await change(body), 400, NOT_VALID);
    expect(await counts()).toEqual({ outlets: 0, changes: 0 });
  });

  it('test_outlet_conflicts_refused', async () => {
    const { change, page, counts } = await outletApp();
    await expectAnswer(await change(add(FX, '0')), 200, ok('1'));
    const other = { id: 'fx-other', name: 'FX Other', country: 'CA', lean: null };

    await expectAnswer(await change(add({ ...other, domains: ['fx-news.example'] }, '1')), 400, {
      code: 'bad-request',
      message: listProblemText({ code: 'domain-taken', outletId: 'fx-other' }),
    });
    await expectAnswer(await change(add({ ...other, domains: ['world.fx-news.example'] }, '1')), 400, {
      code: 'bad-request',
      message: listProblemText({ code: 'domain-nested', outletId: 'fx-other' }),
    });
    await expectAnswer(await change(add({ ...FX, name: 'FX News Again', domains: ['fx-again.example'] }, '1')), 400, ID_TAKEN);
    await expectAnswer(await change(edit({ ...other, domains: ['fx-other.example'] }, '1')), 404, NOT_FOUND);
    await expectAnswer(await change(remove('fx-other', '1')), 404, NOT_FOUND);

    // An edit is checked against the rest of the list too.
    await expectAnswer(await change(add({ ...other, domains: ['fx-other.example'] }, '1')), 200, ok('2'));
    await expectAnswer(await change(edit({ ...other, domains: ['fx-other.example', 'fx-news.example'] }, '2')), 400, {
      code: 'bad-request',
      message: listProblemText({ code: 'domain-taken', outletId: 'fx-other' }),
    });

    expect(await counts()).toEqual({ outlets: 2, changes: 2 });
    const { list } = await page();
    expect(list.version).toBe('2');
    expect(list.outlets.map((o) => [o.id, o.domains])).toEqual([
      ['fx-news', ['fx-news.example']],
      ['fx-other', ['fx-other.example']],
    ]);
  });

  it('test_stale_base_version_conflict', async () => {
    const { change, counts } = await outletApp();
    await expectAnswer(await change(add(FX, '0')), 200, ok('1'));
    const other = { id: 'fx-other', name: 'FX Other', domains: ['fx-other.example'], country: 'CA', lean: null };

    await expectAnswer(await change(add(other, '0')), 409, LIST_CHANGED);
    await expectAnswer(await change(edit(FX_LEFT, '0')), 409, LIST_CHANGED);
    await expectAnswer(await change(remove('fx-news', '0')), 409, LIST_CHANGED);
    await expectAnswer(await change(add(other, '2')), 409, LIST_CHANGED);
    // Checked first: a stale change is a 409 even when it would also be refused for another reason.
    await expectAnswer(await change(remove('fx-missing', '0')), 409, LIST_CHANGED);
    expect(await counts()).toEqual({ outlets: 1, changes: 1 });
  });
});

describe('import', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_import_candidates_once_without_leans', async () => {
    const { t, post, page, counts } = await outletApp();
    const candidates = bundledCandidates();
    if (!candidates) throw new Error('The bundled candidate list is not valid.');
    expect(candidates.outlets).toHaveLength(169);
    const ids = candidates.outlets.map((o) => o.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    await expectAnswer(await post(ADMIN_OUTLETS_IMPORT_PATH, { now: true }), 400, NOT_VALID);
    await expectAnswer(await post(ADMIN_OUTLETS_IMPORT_PATH, {}), 200, ok('169'));

    const { list, changes } = await page();
    expect(list.version).toBe('169');
    expect(list.outlets.map((o) => o.id)).toEqual(ids);
    expect(list.outlets.every((o) => o.lean === null)).toBe(true);
    for (const o of list.outlets) {
      const candidate = candidates.outlets.find((c) => c.id === o.id);
      expect(o).toEqual({
        id: candidate?.id,
        name: candidate?.name,
        domains: candidate?.domains,
        country: candidate?.country,
        lean: null,
        changedOn: expect.any(String),
      });
    }
    expect(changes).toHaveLength(169);
    expect(changes.map((c) => c.seq)).toEqual(ids.map((_, i) => 169 - i));
    // One `import` change each, in id order: newest first, so the last id comes first.
    expect(changes.map((c) => c.outletId)).toEqual([...ids].reverse());
    for (const c of changes) {
      expect(c).toMatchObject({ action: 'import', before: null, by: ADA });
      expect(c.after).toEqual(list.outlets.find((o) => o.id === c.outletId));
    }

    const rows = await t.deps.db.db
      .select({ bucket: outlets.bucket, evidence: outlets.evidence })
      .from(outlets)
      .orderBy(asc(outlets.id));
    expect(rows).toHaveLength(169);
    expect(rows.every((r) => r.bucket === null && Array.isArray(r.evidence) && r.evidence.length === 0)).toBe(true);

    await expectAnswer(await post(ADMIN_OUTLETS_IMPORT_PATH, {}), 400, NOT_EMPTY);
    expect(await counts()).toEqual({ outlets: 169, changes: 169 });
    expect((await page()).list.version).toBe('169');
  });
});

describe('guards and privacy', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_outlet_routes_need_origin_session_and_role', async () => {
    const { admin, member, post, get, counts } = await outletApp();
    const routes: [string, unknown][] = [
      [ADMIN_OUTLETS_PATH, add(FX, '0')],
      [ADMIN_OUTLETS_IMPORT_PATH, {}],
    ];

    for (const [path, body] of routes) {
      await expectAnswer(await post(path, body, admin, null), 403, REFUSED);
      await expectAnswer(await post(path, body, admin, 'https://elsewhere.example'), 403, REFUSED);
      // The body is never read before the checks: a nonsense one gets the same refusals, never a 400.
      await expectAnswer(await post(path, { nonsense: true }, admin, null), 403, REFUSED);
      expect((await post(path, body, null)).status).toBe(401);
      expect((await post(path, { nonsense: true }, null)).status).toBe(401);
      await expectAnswer(await post(path, body, member), 403, NOT_ADMIN);
      await expectAnswer(await post(path, { nonsense: true }, member), 403, NOT_ADMIN);
    }
    expect((await get(null)).status).toBe(401);
    await expectAnswer(await get(member), 403, NOT_ADMIN);

    // None of them wrote anything.
    expect(await counts()).toEqual({ outlets: 0, changes: 0 });
  });

  it('test_deleted_admin_leaves_history_without_identity', async () => {
    const { t, admin, member, adaId, change, page } = await outletApp();
    await expectAnswer(await change(add(FX, '0')), 200, ok('1'));
    await expectAnswer(await change(edit(FX_LEFT, '1')), 200, ok('2'));
    const before = await page();
    expect(before.changes.map((c) => c.by)).toEqual([ADA, ADA]);
    await t.deps.db.db.update(user).set({ role: ADMIN_ROLE }).where(eq(user.email, BEA));

    const deleted = await postJson(t.app, ACCOUNT_DELETE_PATH, { confirm: ADA }, { Cookie: admin, Origin: TEST_PUBLIC_URL });
    expect(deleted.status).toBe(200);

    // Every change keeps its data, with no one named.
    const after = await page(member);
    expect(after.list).toEqual(before.list);
    expect(after.changes).toEqual(before.changes.map((c) => ({ ...c, by: null })));
    const rows = await t.deps.db.db.select({ by: outletChanges.changedBy }).from(outletChanges);
    expect(rows).toEqual([{ by: null }, { by: null }]);

    // No table holds the deleted admin's id.
    const holding = [...(await scanAllTables(t.deps.db))].filter(([, json]) => json.includes(adaId)).map(([table]) => table);
    expect(holding).toEqual([]);
  });

  it('test_outlet_change_logs_ids_only', async () => {
    const { t, adaId, change, post } = await outletApp();
    await expectAnswer(await change(add(FX, '0')), 200, ok('1'));
    await expectAnswer(await change(edit(FX_LEFT, '1')), 200, ok('2'));
    await expectAnswer(await change(edit(FX_LEFT, '2')), 200, ok('2'));
    await expectAnswer(await change(remove('fx-news', '2')), 200, ok('3'));
    await expectAnswer(await post(ADMIN_OUTLETS_IMPORT_PATH, {}), 200, ok('172'));

    const lines = t.events().filter((e) => typeof e.event === 'string' && e.event.startsWith('admin.outlet'));
    expect(lines.map(({ rid, t: time, ...rest }) => (typeof rid === 'string' && typeof time === 'string' ? rest : null))).toEqual(
      [
        { level: 'info', event: 'admin.outlet_changed', admin_id: adaId, action: 'add', outlet_id: 'fx-news', version: '1' },
        { level: 'info', event: 'admin.outlet_changed', admin_id: adaId, action: 'edit', outlet_id: 'fx-news', version: '2' },
        { level: 'info', event: 'admin.outlet_changed', admin_id: adaId, action: 'remove', outlet_id: 'fx-news', version: '3' },
        { level: 'info', event: 'admin.outlets_imported', admin_id: adaId, outlets: 169, version: '172' },
      ],
    );

    // No name, web address, evidence link or email address in any line.
    const candidates = bundledCandidates()?.outlets ?? [];
    const words = ['FX News', 'fx-news.example', 'evidence.example', '@', ...candidates.flatMap((o) => [o.name, ...o.domains])];
    expect(t.lines.filter((line) => words.some((w) => line.includes(w)))).toEqual([]);
  });
});
