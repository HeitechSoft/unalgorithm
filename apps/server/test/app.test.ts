import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoute } from '@hono/zod-openapi';
import { AIError, describeError } from '@unalgorithm/ai';
import { AI_ERROR_CODES, type AIErrorCode, SERVER_INFO_PATH, ServerErrorSchema, ServerInfoSchema } from '@unalgorithm/protocol';
import { HTTPException } from 'hono/http-exception';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { noopBilling } from '../src/billing/provider.ts';
import { ConfigError, SERVER_VERSION } from '../src/config.ts';
import { httpStatusFor } from '../src/http/app.ts';
import { getClientIp } from '../src/http/middleware.ts';
import { startServer } from '../src/index.ts';
import { createTestDb } from './support/db.ts';
import { captureLog } from './support/log.ts';
import { DEV_EXTENSION_ID, DEV_EXTENSION_ORIGIN, SEND_CODE } from './support/sign-in.ts';
import { createTestApp, type TestAppOptions, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT, PROCESS_TIMEOUT, SPAWN_TIMEOUT } from './support/timeouts.ts';

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));
/** The entry point, by absolute path: the test must not depend on the folder Vitest runs in. */
const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const OTHER_ORIGIN = `chrome-extension://${'b'.repeat(32)}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Servers and databases a test opened, closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function testApp(options?: TestAppOptions) {
  const t = await createTestApp(options);
  cleanup.push(t.close);
  return t;
}

describe('health and discovery', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_health_ok_and_db_down', async () => {
    const t = await testApp();
    const ok = await t.app.request('/health');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, version: SERVER_VERSION });
    expect(SERVER_VERSION).toBe('0.1.0');

    await t.deps.db.close();
    const down = await t.app.request('/health');
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ ok: false });
    const failed = t.events().find((e) => e.event === 'health.db_failed');
    expect(failed?.level).toBe('error');
    expect(typeof failed?.err_name).toBe('string');
  });

  it('test_well_known_valid_document', async () => {
    const config = testConfig({ INSTANCE_NAME: 'Example AI' });
    const t = await testApp({ config });
    const res = await t.app.request(SERVER_INFO_PATH, { headers: { Origin: 'https://any.example' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    // Security headers apply to every response.
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');

    const doc = ServerInfoSchema.parse(await res.json());
    expect(doc.name).toBe('Example AI');
    expect(doc.billing).toBe(false);
    expect(doc.limits.maxPostsPerRequest).toBe(12);
    expect(doc.auth.tokenPath).toBe('/v1/auth/token');
    expect(doc).toEqual({
      v: 1,
      name: 'Example AI',
      version: SERVER_VERSION,
      source: config.sourceUrl,
      billing: false,
      capabilities: { classify: true, sync: true },
      auth: { methods: ['email-otp', 'passkey'], authorizePath: '/authorize', tokenPath: '/v1/auth/token' },
      limits: { maxPostsPerRequest: 12 },
    });

    // The flag is the provider's to set: a billing module that advertises itself turns it on.
    const billed = await testApp({ config, billing: { ...noopBilling, id: 'fake', advertised: true } });
    const billedDoc = ServerInfoSchema.parse(await (await billed.app.request(SERVER_INFO_PATH)).json());
    expect(billedDoc.billing).toBe(true);
  });

  it('test_well_known_name_defaults_to_host', async () => {
    const t = await testApp({ config: testConfig({ INSTANCE_NAME: undefined, PUBLIC_URL: 'https://ai.example.org' }) });
    const doc = ServerInfoSchema.parse(await (await t.app.request(SERVER_INFO_PATH)).json());
    expect(doc.name).toBe('ai.example.org');
  });

  it('test_well_known_name_fallback_fits_schema', async () => {
    // The host stands in for the name only while it fits the document's 80 characters; a longer one must be named.
    const host = `${'a'.repeat(60)}.${'b'.repeat(7)}.example.org`;
    expect(host).toHaveLength(80);
    const t = await testApp({ config: testConfig({ INSTANCE_NAME: undefined, PUBLIC_URL: `https://${host}` }) });
    expect(ServerInfoSchema.parse(await (await t.app.request(SERVER_INFO_PATH)).json()).name).toBe(host);

    const longer = { INSTANCE_NAME: undefined, PUBLIC_URL: `https://b${host}` };
    expect(() => testConfig(longer)).toThrow(ConfigError);
    const named = await testApp({ config: testConfig({ ...longer, INSTANCE_NAME: 'Long host' }) });
    expect(ServerInfoSchema.parse(await (await named.app.request(SERVER_INFO_PATH)).json()).name).toBe('Long host');
  });

  it('test_server_source_never_hardcodes_cloud_name', async () => {
    const srcDir = join(SERVER_DIR, 'src');
    const files = (await readdir(srcDir, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
    // The walk must reach the files this ticket added, or the check below proves nothing.
    expect(files).toContain(join(srcDir, 'index.ts'));
    expect(files).toContain(join(srcDir, 'http', 'app.ts'));
    const offenders: string[] = [];
    for (const file of files) {
      if (/UnAlgorithm\s+Cloud/i.test(await readFile(file, 'utf8'))) offenders.push(file);
    }
    // The hosted service gets its name from its own INSTANCE_NAME, like every other server.
    expect(offenders).toEqual([]);
  });
});

describe('CORS', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_cors_allows_configured_extension_only', async () => {
    const t = await testApp();
    t.app.get('/v1/limited', () => {
      throw new AIError('rate-limit', 'x', { retryAfterMs: 2000 });
    });
    const preflight = (origin: string) =>
      t.app.request('/v1/anything', {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
      });

    const dev = await preflight(DEV_EXTENSION_ORIGIN);
    expect(dev.status).toBe(204);
    expect(dev.headers.get('access-control-allow-origin')).toBe(DEV_EXTENSION_ORIGIN);
    expect(dev.headers.get('access-control-allow-methods')).toBe('GET,POST,OPTIONS');
    expect(dev.headers.get('access-control-allow-headers')).toBe('authorization,content-type');
    expect(dev.headers.get('access-control-max-age')).toBe('600');
    // Bearer tokens, not cookies.
    expect(dev.headers.get('access-control-allow-credentials')).toBeNull();

    for (const origin of [OTHER_ORIGIN, 'https://evil.example']) {
      expect((await preflight(origin)).headers.get('access-control-allow-origin')).toBeNull();
    }

    // Actual responses carry the header too, error bodies included, so the extension can read them.
    const notFound = await t.app.request('/v1/anything', { headers: { Origin: DEV_EXTENSION_ORIGIN } });
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get('access-control-allow-origin')).toBe(DEV_EXTENSION_ORIGIN);

    // A cross-origin fetch reads only exposed headers: Retry-After must be one, or the extension cannot honour it.
    const limited = await t.app.request('/v1/limited', { headers: { Origin: DEV_EXTENSION_ORIGIN } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('access-control-allow-origin')).toBe(DEV_EXTENSION_ORIGIN);
    expect(limited.headers.get('retry-after')).toBe('2');
    expect(limited.headers.get('access-control-expose-headers')).toBe('Retry-After');
    expect(
      (await t.app.request('/v1/limited', { headers: { Origin: OTHER_ORIGIN } })).headers.get('access-control-allow-origin'),
    ).toBeNull();

    // The allowlist is the configured one: a second id is admitted once it is listed.
    const both = await testApp({ config: testConfig({ EXTENSION_IDS: `${DEV_EXTENSION_ID},${'b'.repeat(32)}` }) });
    const other = await both.app.request('/v1/anything', {
      method: 'OPTIONS',
      headers: { Origin: OTHER_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    expect(other.headers.get('access-control-allow-origin')).toBe(OTHER_ORIGIN);
  });
});

describe('logging and IP', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_request_log_has_no_query_or_body', async () => {
    const t = await testApp();
    await t.app.request('/health?token=SECRET123');
    const first = t.events().filter((e) => e.event === 'http');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ level: 'info', method: 'GET', path: '/health', status: 200 });
    expect(Object.keys(first[0] ?? {}).sort()).toEqual(['event', 'level', 'method', 'ms', 'path', 'rid', 'status', 't']);
    expect(t.lines.join('')).not.toContain('SECRET123');

    const res = await t.app.request('/v1/x', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'AGENT-MARKER',
        'x-request-id': 'CLIENT-RID',
        'x-forwarded-for': '203.0.113.9',
      },
      body: JSON.stringify({ posts: [{ text: 'CANARY post text' }] }),
    });
    // Our own request id, never the client's.
    const rid = res.headers.get('x-request-id');
    expect(rid).toMatch(UUID);
    const second = t.events().filter((e) => e.event === 'http');
    expect(second).toHaveLength(2);
    expect(second[1]).toMatchObject({ method: 'POST', path: '/v1/x', status: 404, rid });
    expect(second[1]?.rid).not.toBe(second[0]?.rid);

    const all = t.lines.join('');
    for (const text of ['CANARY', 'AGENT-MARKER', 'CLIENT-RID', '203.0.113.9']) expect(all).not.toContain(text);
  });

  it('test_client_ip_one_hop_takes_rightmost', async () => {
    const withIpRoute = async (trustProxy: 'none' | 'one-hop') => {
      const t = await testApp({ config: testConfig({ TRUST_PROXY: trustProxy }) });
      t.app.get('/ip', (c) => c.json({ ip: getClientIp(c) }));
      return t;
    };
    /** `socket` stands in for the Node request that @hono/node-server passes as the app's environment. */
    const ipOf = async (t: Awaited<ReturnType<typeof withIpRoute>>, headers: Record<string, string>, socket?: string) => {
      const env = socket ? { incoming: { socket: { remoteAddress: socket } } } : undefined;
      return ((await (await t.app.request('/ip', { headers }, env)).json()) as { ip: string | null }).ip;
    };
    const forwarded = { 'X-Forwarded-For': '203.0.113.9, 198.51.100.7' };

    const oneHop = await withIpRoute('one-hop');
    expect(await ipOf(oneHop, forwarded)).toBe('198.51.100.7');
    expect(await ipOf(oneHop, forwarded, '127.0.0.1')).toBe('198.51.100.7');
    // No header: the socket address, or null when there is no socket (as in most tests).
    expect(await ipOf(oneHop, {}, '127.0.0.1')).toBe('127.0.0.1');
    expect(await ipOf(oneHop, {})).toBeNull();
    // A right-most entry that is not an address is never used as one.
    expect(await ipOf(oneHop, { 'X-Forwarded-For': '203.0.113.9, nonsense' }, '127.0.0.1')).toBe('127.0.0.1');

    const none = await withIpRoute('none');
    expect(await ipOf(none, forwarded)).toBeNull();
    expect(await ipOf(none, forwarded, '192.0.2.10')).toBe('192.0.2.10');
  });
});

describe('errors', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_ai_error_maps_status_and_retry_after', async () => {
    const t = await testApp();
    t.app.get('/v1/limited', () => {
      throw new AIError('rate-limit', 'x', { retryAfterMs: 5000 });
    });
    t.app.get('/v1/denied', () => {
      throw new AIError('permission', 'provider said: CANARY');
    });

    const res = await t.app.request('/v1/limited');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('5');
    const body = ServerErrorSchema.parse(await res.json());
    expect(body).toEqual({ code: 'rate-limit', message: describeError('rate-limit', 'Test server') });
    const logged = t.events().find((e) => e.event === 'http.error');
    expect(logged).toMatchObject({ rid: res.headers.get('x-request-id'), err_name: 'AIError', err_code: 'rate-limit' });

    const denied = await t.app.request('/v1/denied');
    expect(denied.status).toBe(403);
    expect(denied.headers.get('retry-after')).toBeNull();
    expect(await denied.json()).toEqual({ code: 'permission', message: describeError('permission', 'Test server') });
    expect(t.lines.join('')).not.toContain('CANARY');

    const table: Partial<Record<AIErrorCode, number>> = {
      'bad-request': 400,
      'auth-required': 401,
      auth: 401,
      permission: 403,
      'insufficient-credits': 402,
      'rate-limit': 429,
      'cap-reached': 429,
      overloaded: 503,
      'not-available': 503,
      timeout: 504,
    };
    for (const code of AI_ERROR_CODES) expect([code, httpStatusFor(code)]).toEqual([code, table[code] ?? 500]);
  });

  it('test_error_bodies_never_name_another_server', async () => {
    const t = await testApp({ config: testConfig({ INSTANCE_NAME: 'My Server' }) });
    t.app.get('/v1/fail/:code', (c) => {
      throw new AIError(c.req.param('code') as AIErrorCode, 'x');
    });
    for (const code of AI_ERROR_CODES) {
      const res = await t.app.request(`/v1/fail/${code}`);
      const text = await res.text();
      expect([code, res.status]).toEqual([code, httpStatusFor(code)]);
      expect(ServerErrorSchema.parse(JSON.parse(text))).toEqual({ code, message: describeError(code, 'My Server') });
      expect(text).not.toMatch(/UnAlgorithm\s+Cloud/i);
    }
    // The two codes whose text used to name the hosted service now name this server.
    expect(describeError('auth-required', 'My Server')).toBe('Sign in to My Server again.');
    expect(describeError('insufficient-credits', 'My Server')).toBe(
      'Your My Server balance is empty. Add credit, or switch to on-device or your own key.',
    );
  });

  it('test_non_error_throw_is_500_json', async () => {
    const t = await testApp();
    t.app.get('/v1/string', () => {
      throw 'CANARY string';
    });
    t.app.get('/v1/object', () => {
      throw { text: 'CANARY object' };
    });
    for (const path of ['/v1/string', '/v1/object']) {
      const res = await t.app.request(path, { headers: { Origin: DEV_EXTENSION_ORIGIN } });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ code: 'unknown', message: 'Something went wrong on the server.' });
      // Every middleware still applies: CORS (the extension can read it), security headers and the request id.
      expect(res.headers.get('access-control-allow-origin')).toBe(DEV_EXTENSION_ORIGIN);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      const rid = res.headers.get('x-request-id');
      expect(rid).toMatch(UUID);

      const lines = t.events().filter((e) => e.rid === rid);
      expect(lines.filter((e) => e.event === 'http')).toEqual([expect.objectContaining({ path, status: 500 })]);
      expect(lines.filter((e) => e.event === 'http.error')).toEqual([
        expect.objectContaining({ level: 'error', err_name: 'NonError' }),
      ]);
    }
    expect(t.lines.join('')).not.toContain('CANARY');
  });

  it('test_unexpected_error_is_500_and_unlogged_message', async () => {
    const t = await testApp();
    t.app.post('/v1/boom', async (c) => {
      await c.req.text();
      throw new Error('post text: CANARY');
    });
    const res = await t.app.request('/v1/boom', { method: 'POST', body: 'CANARY in the body' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: 'unknown', message: 'Something went wrong on the server.' });
    const logged = t.events().find((e) => e.event === 'http.error');
    expect(logged).toMatchObject({ level: 'error', rid: res.headers.get('x-request-id'), err_name: 'Error' });
    expect(t.lines.join('')).not.toContain('CANARY');
  });

  it('test_invalid_request_is_400_without_echo', async () => {
    const t = await testApp();
    t.app.openapi(
      createRoute({
        method: 'post',
        path: '/v1/echo',
        request: {
          body: { content: { 'application/json': { schema: z.object({ text: z.string().max(5) }) } }, required: true },
        },
        responses: {
          200: { description: 'ok', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } },
        },
      }),
      (c) => c.json({ ok: true }, 200),
    );
    t.app.get('/v1/teapot', () => {
      throw new HTTPException(418, { message: 'CANARY' });
    });
    const post = (body: string) =>
      t.app.request('/v1/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const notValid = { code: 'bad-request', message: 'The request was not valid.' };

    expect((await post('{"text":"ok"}')).status).toBe(200);

    // Schema failures and malformed JSON get one fixed answer: no zod issues, no input.
    const invalid = await post('{"text":"CANARY is too long"}');
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual(notValid);
    const malformed = await post('{"text":"CANARY');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual(notValid);

    // Any other client error Hono raises keeps its status.
    const teapot = await t.app.request('/v1/teapot');
    expect(teapot.status).toBe(418);
    expect(await teapot.json()).toEqual(notValid);
    expect(t.lines.join('')).not.toContain('CANARY');
  });

  it('test_unknown_route_404_body', async () => {
    const t = await testApp();
    for (const path of ['/nope', '/v1/nope', '/.well-known/other.json']) {
      const res = await t.app.request(path);
      expect(res.status).toBe(404);
      expect(ServerErrorSchema.parse(await res.json())).toEqual({ code: 'bad-request', message: 'Not found.' });
    }
  });

  it('test_body_limit_413', async () => {
    const t = await testApp();
    const post = (bytes: number) =>
      t.app.request('/v1/anything', { method: 'POST', headers: { Origin: DEV_EXTENSION_ORIGIN }, body: 'x'.repeat(bytes) });

    const big = await post(200 * 1024);
    expect(big.status).toBe(413);
    expect(ServerErrorSchema.parse(await big.json()).code).toBe('bad-request');
    // Readable by the extension: the refusal carries the CORS header.
    expect(big.headers.get('access-control-allow-origin')).toBe(DEV_EXTENSION_ORIGIN);

    // Under the limit the request goes on to routing.
    expect((await post(100 * 1024)).status).toBe(404);
  });
});

describe('entry', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_start_server_serves_health', async () => {
    const { log, events } = captureLog();
    const server = await startServer(testConfig(), { db: await createTestDb(), port: 0, log });
    cleanup.push(() => server.close());
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const res = await fetch(`${server.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: SERVER_VERSION });

    // Over a real socket the request carries a Content-Length, which the body limit checks before reading.
    const big = await fetch(`${server.url}/v1/anything`, { method: 'POST', body: 'x'.repeat(200 * 1024) });
    expect(big.status).toBe(413);

    // Sign-in is mounted, and a request body survives the copy that sets the client address for Better Auth.
    const send = await fetch(`${server.url}${SEND_CODE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: testConfig().publicOrigin },
      body: JSON.stringify({ email: 'stranger@example.com', type: 'sign-in' }),
    });
    expect(send.status).toBe(200);
    expect(await send.json()).toEqual({ success: true });
    // The auth routes have a body limit of their own, also checked on the Content-Length.
    const bigSend = await fetch(`${server.url}${SEND_CODE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: testConfig().publicOrigin },
      body: JSON.stringify({ email: 'stranger@example.com', type: 'sign-in', pad: 'x'.repeat(32 * 1024) }),
    });
    expect(bigSend.status).toBe(413);

    const started = events().filter((e) => e.event === 'server.started');
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ port: Number(new URL(server.url).port), version: SERVER_VERSION });
    expect(Object.keys(started[0] ?? {}).sort()).toEqual(['event', 'level', 'port', 't', 'version']);

    await expect(server.close()).resolves.toBeUndefined();
    await expect(fetch(`${server.url}/health`)).rejects.toThrow();
  });

  it('test_entry_exits_on_missing_config', { timeout: SPAWN_TIMEOUT }, () => {
    const run = (env: Record<string, string>) =>
      // From a folder outside the repository, so the entry is shown not to depend on the working directory either.
      spawnSync(process.execPath, [ENTRY], { env, cwd: tmpdir(), encoding: 'utf8', timeout: PROCESS_TIMEOUT });

    const empty = run({});
    expect(empty.status).toBe(1);
    expect(empty.stderr).toMatch(/^missing: PUBLIC_URL, DATABASE_URL, BETTER_AUTH_SECRET, SMTP_HOST, MAIL_FROM, AI_PROVIDER$/m);
    expect(empty.stdout).toBe('');

    // Invalid values are reported by name, never by value.
    const short = run({ PUBLIC_URL: 'https://ai.example.org', BETTER_AUTH_SECRET: 'shortQXZ7secret' });
    expect(short.status).toBe(1);
    expect(short.stderr).toMatch(/^invalid: BETTER_AUTH_SECRET \(.+\)$/m);
    expect(short.stderr + short.stdout).not.toContain('shortQXZ7secret');
  });
});
