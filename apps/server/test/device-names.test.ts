import { type TokenResponse, TokenResponseSchema } from '@unalgorithm/protocol';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { authCodes, devices } from '../src/db/schema.ts';
import { createTestDb, queryRows } from './support/db.ts';
import {
  authorizeRequest,
  codeExchange,
  codeFrom,
  DEV_EXTENSION_ID,
  pkcePair,
  postAuthorize,
  postToken,
  signInDevice,
  signInWeb,
} from './support/sign-in.ts';
import { createTestApp, testConfig } from './support/test-app.ts';

/** Starting PGlite (Postgres compiled to WebAssembly) takes a moment, more on a busy CI runner. */
const PGLITE_TIMEOUT = 30_000;

const TOM = 'tom@example.com';
const WINDOWS = 'Chrome on Windows';
const LINUX = 'Chrome on Linux';
const NOT_A_NAME = '<img src=x>';
/** What every request that fails its schema answers (CL1-06). */
const NOT_VALID = { code: 'bad-request', message: 'The request was not valid.' };

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/** Apps a test opened, closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function namesApp() {
  const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: TOM }) });
  cleanup.push(() => t.close());
  return t;
}

/** The `devices` row the tokens name. */
async function deviceRow(t: TestApp, tokens: TokenResponse) {
  const [row] = await t.deps.db.db.select().from(devices).where(eq(devices.id, tokens.device_id));
  if (!row) throw new Error('The device was not stored.');
  return row;
}

/** A web session, then a PKCE pair and a code for it, as the sign-in page gets it for the extension. */
async function authorized(t: TestApp) {
  const cookie = await signInWeb(t.app, t.outbox, TOM);
  const { verifier, challenge } = pkcePair();
  const code = await codeFrom(await postAuthorize(t.app, cookie, authorizeRequest(challenge)));
  return { code, verifier };
}

/** The refresh the extension makes, with a name it may not send: a refresh never renames a device. */
async function refreshed(t: TestApp, tokens: TokenResponse): Promise<TokenResponse> {
  const res = await postToken(t.app, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: DEV_EXTENSION_ID,
    device_name: 'Another name',
  });
  expect(res.status).toBe(200);
  return TokenResponseSchema.parse(await res.json());
}

describe('storing the name', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_device_name_stored_at_exchange', async () => {
    const t = await namesApp();
    const tokens = await signInDevice(t.app, t.outbox, TOM, DEV_EXTENSION_ID, WINDOWS);
    expect((await deviceRow(t, tokens)).name).toBe(WINDOWS);
  });

  it('test_device_name_optional', async () => {
    const t = await namesApp();
    const { code, verifier } = await authorized(t);
    const body = codeExchange(code, verifier);
    expect(body).not.toHaveProperty('device_name');

    const res = await postToken(t.app, body);
    expect(res.status).toBe(200);
    expect((await deviceRow(t, TokenResponseSchema.parse(await res.json()))).name).toBeNull();
  });

  it('test_device_name_trimmed', async () => {
    const t = await namesApp();
    const tokens = await signInDevice(t.app, t.outbox, TOM, undefined, `  ${LINUX}  `);
    expect((await deviceRow(t, tokens)).name).toBe(LINUX);
  });

  it('test_invalid_device_name_keeps_code_usable', async () => {
    const t = await namesApp();
    const { code, verifier } = await authorized(t);

    const refused = await postToken(t.app, codeExchange(code, verifier, DEV_EXTENSION_ID, NOT_A_NAME));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual(NOT_VALID);
    // Refused before the handler: the code is not spent and no device was stored.
    const [stored] = await t.deps.db.db.select({ usedAt: authCodes.usedAt }).from(authCodes);
    expect(stored?.usedAt).toBeNull();
    expect(await t.deps.db.db.select().from(devices)).toHaveLength(0);

    // The extension tries again with a name that passes, and the same verifier.
    const res = await postToken(t.app, codeExchange(code, verifier, DEV_EXTENSION_ID, WINDOWS));
    expect(res.status).toBe(200);
    expect((await deviceRow(t, TokenResponseSchema.parse(await res.json()))).name).toBe(WINDOWS);
  });

  it('test_refresh_keeps_device_name', async () => {
    const t = await namesApp();
    const first = await signInDevice(t.app, t.outbox, TOM, DEV_EXTENSION_ID, WINDOWS);
    const second = await refreshed(t, first);
    const third = await refreshed(t, second);

    expect(third.device_id).toBe(first.device_id);
    expect((await deviceRow(t, third)).name).toBe(WINDOWS);
    expect(await t.deps.db.db.select().from(devices)).toHaveLength(1);
  });
});

describe('privacy and schema', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_device_name_not_logged', async () => {
    const t = await namesApp();
    // Every outcome of AC 1 to 5 once, in this app: stored, unnamed, trimmed, refused for its name and retried, then a
    // refresh that sends a name.
    const named = await signInDevice(t.app, t.outbox, TOM, DEV_EXTENSION_ID, WINDOWS);
    await signInDevice(t.app, t.outbox, TOM);
    await signInDevice(t.app, t.outbox, TOM, DEV_EXTENSION_ID, `  ${LINUX}  `);
    const { code, verifier } = await authorized(t);
    expect((await postToken(t.app, codeExchange(code, verifier, DEV_EXTENSION_ID, NOT_A_NAME))).status).toBe(400);
    expect((await postToken(t.app, codeExchange(code, verifier, DEV_EXTENSION_ID, WINDOWS))).status).toBe(200);
    await refreshed(t, named);

    // The sign-in line names the device by its id only.
    const signedIn = t.events().filter((e) => e.event === 'auth.signed_in');
    expect(signedIn).toHaveLength(4);
    for (const line of signedIn) expect(Object.keys(line).sort()).toEqual(['device_id', 'event', 'level', 'rid', 't']);
    for (const line of t.lines) {
      for (const name of [WINDOWS, LINUX, NOT_A_NAME, 'Another name']) expect(line).not.toContain(name);
    }
  });

  it('test_devices_name_column_migrated', async () => {
    const h = await createTestDb();
    cleanup.push(() => h.close());

    const columns = await queryRows(
      h,
      sql`select column_name, data_type, is_nullable, column_default from information_schema.columns
          where table_schema = 'public' and table_name = 'devices' and column_name = 'name'`,
    );
    expect(columns).toEqual([{ column_name: 'name', data_type: 'text', is_nullable: 'YES', column_default: null }]);
  });
});
