import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_DELETE_PATH,
  ACCOUNT_DEVICE_REVOKE_PATH,
  ACCOUNT_DEVICES_PATH,
  ACCOUNT_EXPORT_PATH,
  ACCOUNT_PAGE_PATH,
  AccountDevicesResponseSchema,
  AccountExportSchema,
  chromiumRedirectUri,
  DeleteAccountRequestSchema,
  DeviceNameSchema,
  EMAIL_OTP_METHOD,
  FIREFOX_ADDON_ID,
  GOOGLE_METHOD,
  geckoRedirectUri,
  OkResponseSchema,
  PASSKEY_METHOD,
  RevokeDeviceRequestSchema,
  ServerInfoSchema,
  TokenRequestSchema,
  tickHlc,
} from '../src/index.ts';

const DEV_ID = 'aokmlebkpkeniofcnbeajmgabinicggm';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const DEVICE = '0190f5c8-3b1e-7c2a-9d4e-123456789abc';
const OTHER_DEVICE = '0190f5c8-3b1e-7c2a-9d4e-123456789abd';
const SPACE = '0190f5c8-3b1e-7c2a-9d4e-0000000000a1';
const AT = '2026-10-14T09:30:00.000Z';
const LATER = '2026-10-21T09:30:00.000Z';

describe('device names', () => {
  it('test_device_name_accepts_plain_names', () => {
    for (const name of ['Chrome on Windows', 'Edge on macOS (work)', 'Chrome sur Linux', 'Firefox on Linux']) {
      expect(DeviceNameSchema.parse(name), name).toBe(name);
    }
    for (const bad of ['', '   ', 'x'.repeat(61), '<script>', 'a\nb']) {
      expect(DeviceNameSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(DeviceNameSchema.parse('x'.repeat(60))).toBe('x'.repeat(60));
    expect(DeviceNameSchema.parse('  Chrome  ')).toBe('Chrome');
  });

  it('test_token_request_device_name_optional', () => {
    const code = {
      grant_type: 'authorization_code',
      code: 'c'.repeat(32),
      code_verifier: VERIFIER,
      client_id: DEV_ID,
      redirect_uri: chromiumRedirectUri(DEV_ID),
    } as const;
    expect(TokenRequestSchema.parse(code)).toEqual(code);
    expect(TokenRequestSchema.parse({ ...code, device_name: ' Chrome on Windows ' })).toEqual({
      ...code,
      device_name: 'Chrome on Windows',
    });
    expect(TokenRequestSchema.safeParse({ ...code, device_name: '<b>' }).success).toBe(false);
    // A refresh never names the device: the field is dropped, not refused.
    const refresh = { grant_type: 'refresh_token', refresh_token: 'r'.repeat(43), client_id: DEV_ID } as const;
    const parsed = TokenRequestSchema.parse({ ...refresh, device_name: 'Chrome on Windows' });
    expect(parsed).toEqual(refresh);
    expect(parsed).not.toHaveProperty('device_name');
  });

  it('test_token_request_device_name_from_firefox', () => {
    const code = {
      grant_type: 'authorization_code',
      code: 'c'.repeat(32),
      code_verifier: VERIFIER,
      client_id: FIREFOX_ADDON_ID,
      redirect_uri: geckoRedirectUri(FIREFOX_ADDON_ID),
    } as const;
    expect(TokenRequestSchema.parse({ ...code, device_name: 'Firefox on Linux' })).toEqual({
      ...code,
      device_name: 'Firefox on Linux',
    });
    const refresh = { grant_type: 'refresh_token', refresh_token: 'r'.repeat(43), client_id: FIREFOX_ADDON_ID } as const;
    expect(TokenRequestSchema.parse({ ...refresh, device_name: 'Firefox on Linux' })).toEqual(refresh);
  });
});

describe('devices', () => {
  const device = { id: DEVICE, name: 'Chrome on Windows', createdAt: AT, lastUsedAt: LATER, current: true };

  it('test_account_devices_response_shape', () => {
    expect([ACCOUNT_DEVICES_PATH, ACCOUNT_DEVICE_REVOKE_PATH]).toEqual(['/v1/account/devices', '/v1/account/devices/revoke']);
    const older = { id: OTHER_DEVICE, name: null, createdAt: AT, lastUsedAt: null, current: false };
    const body = { v: 1, devices: [device, older] };
    expect(AccountDevicesResponseSchema.parse(body)).toEqual(body);
    for (const createdAt of ['2026-10-14', 'yesterday', '']) {
      const bad = { v: 1, devices: [{ ...device, createdAt }] };
      expect(AccountDevicesResponseSchema.safeParse(bad).success, createdAt).toBe(false);
    }
    expect(AccountDevicesResponseSchema.safeParse({ v: 1, devices: [{ ...device, id: 'dev-1' }] }).success).toBe(false);
    expect(AccountDevicesResponseSchema.safeParse({ v: 1, devices: [{ ...device, name: '<b>' }] }).success).toBe(false);
    expect(AccountDevicesResponseSchema.safeParse({ v: 1, devices: Array(201).fill(device) }).success).toBe(false);
  });

  it('test_revoke_and_delete_requests', () => {
    expect(RevokeDeviceRequestSchema.parse({ device_id: DEVICE })).toEqual({ device_id: DEVICE });
    for (const device_id of ['', 'dev-1', `${DEVICE}0`]) {
      expect(RevokeDeviceRequestSchema.safeParse({ device_id }).success, device_id).toBe(false);
    }
    expect(OkResponseSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(OkResponseSchema.safeParse({ ok: false }).success).toBe(false);

    expect([ACCOUNT_EXPORT_PATH, ACCOUNT_DELETE_PATH]).toEqual(['/v1/account/export', '/v1/account/delete']);
    expect(DeleteAccountRequestSchema.parse({ confirm: '  Tester@Example.com ' })).toEqual({
      confirm: 'Tester@Example.com',
    });
    expect(DeleteAccountRequestSchema.safeParse({ confirm: 'ab' }).success).toBe(false);
    expect(DeleteAccountRequestSchema.safeParse({ confirm: '  ab  ' }).success).toBe(false);
    expect(DeleteAccountRequestSchema.safeParse({ confirm: 'x'.repeat(321) }).success).toBe(false);
  });
});

describe('export', () => {
  const example = {
    v: 1,
    exportedAt: LATER,
    server: { name: 'Local server', origin: 'http://127.0.0.1:8787', version: '0.1.0' },
    account: { email: 'tester@localhost', createdAt: AT, linkedProviders: ['google'] },
    devices: [
      { id: DEVICE, name: 'Chrome on Windows', createdAt: AT, lastUsedAt: LATER, revokedAt: null, revokedReason: null },
      { id: OTHER_DEVICE, name: null, createdAt: AT, lastUsedAt: null, revokedAt: LATER, revokedReason: 'sign-out' },
    ],
    passkeys: [{ name: 'Laptop', createdAt: AT, deviceType: 'multiDevice', backedUp: true }],
    sessions: [{ createdAt: AT, expiresAt: LATER, ipAddress: '127.0.0.1', userAgent: 'Mozilla/5.0' }],
    usage: [{ day: '2026-10-14', task: 'classify', requests: 3, postsRequested: 30, postsOk: 29 }],
    sync: {
      spaces: [
        {
          id: SPACE,
          kind: 'user',
          items: [
            {
              collection: 'settings',
              key: 'display.mode',
              deleted: false,
              value: { mode: 'hide', more: [1, null] },
              hlc: tickHlc(undefined, DEVICE, 1_760_000_000_000),
              updatedAt: AT,
            },
            {
              collection: 'settings',
              key: 'interests.more.ai-tech',
              deleted: true,
              hlc: tickHlc(undefined, DEVICE, 1_760_000_000_001),
              updatedAt: LATER,
            },
          ],
        },
      ],
    },
    billing: null,
  };

  it('test_account_export_accepts_local_addresses', () => {
    expect(AccountExportSchema.parse(example)).toEqual(example);
    // The same export from a server with a billing module, which reports what it holds.
    const billed = { ...example, billing: { balanceMicros: 1_200_000, ledger: [{ kind: 'grant', at: AT }] } };
    expect(AccountExportSchema.parse(billed)).toEqual(billed);
    expect(AccountExportSchema.safeParse({ ...example, exportedAt: '2026-10-14' }).success).toBe(false);
    expect(AccountExportSchema.safeParse({ ...example, usage: [{ ...example.usage[0], day: '14/10/2026' }] }).success).toBe(
      false,
    );
    expect(AccountExportSchema.safeParse({ ...example, usage: [{ ...example.usage[0], requests: -1 }] }).success).toBe(false);
  });

  it('test_account_export_strips_secret_fields', () => {
    const secrets = {
      token: 't',
      refreshToken: 'r',
      publicKey: 'k',
      credentialID: 'c',
      password: 'p',
      codeHash: 'h',
      tokenHash: 'h',
    };
    const withSecrets = {
      ...example,
      ...secrets,
      server: { ...example.server, ...secrets },
      account: { ...example.account, ...secrets },
      devices: example.devices.map((d) => ({ ...d, ...secrets })),
      passkeys: example.passkeys.map((p) => ({ ...p, ...secrets })),
      sessions: example.sessions.map((s) => ({ ...s, ...secrets })),
      usage: example.usage.map((u) => ({ ...u, ...secrets })),
      sync: {
        ...secrets,
        spaces: example.sync.spaces.map((s) => ({ ...s, ...secrets, items: s.items.map((i) => ({ ...i, ...secrets })) })),
      },
    };
    const parsed = AccountExportSchema.parse(withSecrets);
    expect(parsed).toEqual(example);
    const dump = JSON.stringify(parsed);
    for (const key of Object.keys(secrets)) expect(dump, key).not.toContain(`"${key}"`);
  });
});

describe('discovery', () => {
  it('test_sign_in_method_names', () => {
    expect([EMAIL_OTP_METHOD, GOOGLE_METHOD, PASSKEY_METHOD]).toEqual(['email-otp', 'google', 'passkey']);
    expect(ACCOUNT_PAGE_PATH).toBe('/account');
    const info = {
      v: 1,
      name: 'Example server',
      version: '0.1.0',
      source: 'https://github.com/example/unalgorithm/tree/v0.1.0',
      billing: false,
      capabilities: { classify: true, sync: true },
      auth: {
        methods: [EMAIL_OTP_METHOD, GOOGLE_METHOD, PASSKEY_METHOD],
        authorizePath: '/authorize',
        tokenPath: '/v1/auth/token',
      },
      limits: { maxPostsPerRequest: 12 },
    };
    expect(ServerInfoSchema.parse(info).auth.methods).toEqual(['email-otp', 'google', 'passkey']);
  });
});

describe('boundaries', () => {
  it('test_account_contract_does_not_import_server', async () => {
    // server.ts imports DeviceNameSchema from account.ts; the reverse import would be a cycle.
    const source = await readFile(join(import.meta.dirname, '../src/account.ts'), 'utf8');
    const specifiers = [
      ...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm),
      ...source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
    ].map((m) => m[1]);
    expect(specifiers).toContain('zod');
    expect(specifiers).not.toContain('./server.ts');
    expect(specifiers).not.toContain('./index.ts');
    expect(source).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
  });
});
