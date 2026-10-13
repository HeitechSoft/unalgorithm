import { describe, expect, it } from 'vitest';
import {
  AuthorizeRequestSchema,
  AuthorizeResponseSchema,
  ClassifyRequestSchema,
  chromiumRedirectUri,
  compareHlc,
  costMicros,
  EMAIL_OTP_METHOD,
  ExtensionIdSchema,
  formatHlc,
  PostForAISchema,
  parseHlc,
  platformOfKey,
  RevokeRequestSchema,
  ServerErrorSchema,
  ServerInfoSchema,
  serverMayReceive,
  TokenRequestSchema,
  TokenResponseSchema,
  tickHlc,
  toPostRef,
  uuidv7,
} from '../src/index.ts';

describe('post refs', () => {
  it('hashes post keys so servers never see platform ids', async () => {
    const ref = await toPostRef('li:urn:li:activity:7001');
    expect(ref).toMatch(/^pk_[A-Za-z0-9_-]{43}$/);
    expect(ref).not.toContain('7001');
    expect(await toPostRef('li:urn:li:activity:7001')).toBe(ref);
  });

  it('finds the platform of a key', () => {
    expect(platformOfKey('fb:123')).toBe('facebook');
    expect(platformOfKey('li:ck:abc')).toBe('linkedin');
    expect(platformOfKey('xx:1')).toBeUndefined();
  });
});

describe('hybrid logical clock', () => {
  it('orders stamps by time, then counter, as plain strings', () => {
    const a = tickHlc(undefined, 'devA', 1000);
    const b = tickHlc(a, 'devA', 1000);
    const c = tickHlc(b, 'devA', 999); // clock went backwards: still increases
    expect(compareHlc(a, b)).toBe(-1);
    expect(compareHlc(b, c)).toBe(-1);
    expect(parseHlc(c)).toEqual({ ms: 1000, counter: 2, device: 'devA' });
    expect(formatHlc(parseHlc(c))).toBe(c);
  });
});

describe('uuidv7', () => {
  it('is time ordered', () => {
    expect(uuidv7(1000) < uuidv7(2000)).toBe(true);
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('cost', () => {
  it('prices Haiku 5.5 classification at well under a cent per batch', () => {
    const micros = costMicros('claude-haiku-5-5', {
      uncachedInput: 2400,
      cacheRead: 1500,
      cacheWrite: 0,
      output: 360,
      webSearches: 0,
      estimated: false,
    });
    expect(micros).toBe(435);
    expect(
      costMicros('unknown-model', { uncachedInput: 1, cacheRead: 0, cacheWrite: 0, output: 0, webSearches: 0, estimated: false }),
    ).toBeUndefined();
  });
});

describe('contracts', () => {
  it('rejects author names smuggled into a classify request', () => {
    const base = {
      v: 1,
      profile: { v: 1, interests: [], lessOf: [], about: '', examples: [] },
      profileHash: 'x',
      locale: 'en',
    };
    const post = {
      ref: 'p1',
      platform: 'linkedin',
      text: 'hi',
      textComplete: true,
      authorKind: 'person',
      isReshare: false,
      media: 'none',
    };
    expect(ClassifyRequestSchema.safeParse({ ...base, posts: [post] }).success).toBe(true);
    const parsed = ClassifyRequestSchema.parse({ ...base, posts: [{ ...post, authorName: 'Jane Doe' }] });
    expect(JSON.stringify(parsed)).not.toContain('Jane Doe');
  });
});

const DEV_ID = 'aokmlebkpkeniofcnbeajmgabinicggm';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('discovery', () => {
  const info = {
    v: 1,
    name: 'Example server',
    version: '0.1.0',
    source: 'https://github.com/example/unalgorithm/tree/v0.1.0',
    billing: false,
    capabilities: { classify: true, sync: false },
    auth: { methods: ['email-otp'], authorizePath: '/authorize', tokenPath: '/v1/auth/token' },
    limits: { maxPostsPerRequest: 12 },
  };

  it('test_server_info_accepts_full_document', () => {
    expect(ServerInfoSchema.parse(info)).toEqual(info);
  });

  it('test_server_info_accepts_new_sign_in_methods', () => {
    // A method this client does not know is no reason to refuse the server; it checks for the one it supports.
    const later = { ...info, auth: { ...info.auth, methods: ['email-otp', 'passkey'] } };
    expect(ServerInfoSchema.parse(later).auth.methods).toEqual(['email-otp', 'passkey']);
    expect(ServerInfoSchema.parse(later).auth.methods).toContain(EMAIL_OTP_METHOD);
    expect(ServerInfoSchema.safeParse({ ...info, auth: { ...info.auth, methods: ['passkey'] } }).success).toBe(true);
    // Still bounded: no empty or oversized names, and no endless list.
    for (const methods of [[''], ['x'.repeat(41)], Array.from({ length: 11 }, (_, i) => `m${i}`)]) {
      expect(ServerInfoSchema.safeParse({ ...info, auth: { ...info.auth, methods } }).success).toBe(false);
    }
  });

  it('test_server_info_rejects_bad_fields', () => {
    expect(ServerInfoSchema.safeParse({ ...info, limits: { maxPostsPerRequest: 13 } }).success).toBe(false);
    expect(ServerInfoSchema.safeParse({ ...info, name: '' }).success).toBe(false);
    expect(ServerInfoSchema.safeParse({ ...info, source: 'not a url' }).success).toBe(false);
    expect(ServerInfoSchema.safeParse({ ...info, auth: { ...info.auth, methods: [] } }).success).toBe(false);
    expect(ServerInfoSchema.safeParse({ ...info, source: 'javascript:alert(1)' }).success).toBe(false);
    expect(ServerInfoSchema.safeParse({ ...info, source: 'data:text/html,x' }).success).toBe(false);
    for (const path of ['//evil.example/token', '/\\evil.example/token', '/\t/evil.example/token', 'v1/auth/token']) {
      expect(ServerInfoSchema.safeParse({ ...info, auth: { ...info.auth, tokenPath: path } }).success).toBe(false);
      expect(ServerInfoSchema.safeParse({ ...info, auth: { ...info.auth, authorizePath: path } }).success).toBe(false);
    }
  });
});

describe('ids and redirects', () => {
  it('test_extension_id_schema', () => {
    expect(ExtensionIdSchema.safeParse(DEV_ID).success).toBe(true);
    expect(ExtensionIdSchema.safeParse(DEV_ID.slice(1)).success).toBe(false);
    expect(ExtensionIdSchema.safeParse(`q${DEV_ID.slice(1)}`).success).toBe(false);
    expect(ExtensionIdSchema.safeParse(DEV_ID.toUpperCase()).success).toBe(false);
  });

  it('test_chromium_redirect_uri', () => {
    expect(chromiumRedirectUri(DEV_ID)).toBe('https://aokmlebkpkeniofcnbeajmgabinicggm.chromiumapp.org/');
  });
});

describe('auth contracts', () => {
  const code = {
    grant_type: 'authorization_code',
    code: 'c'.repeat(32),
    code_verifier: VERIFIER,
    client_id: DEV_ID,
    redirect_uri: chromiumRedirectUri(DEV_ID),
  };

  it('test_token_request_grants', () => {
    expect(TokenRequestSchema.safeParse(code).success).toBe(true);
    expect(
      TokenRequestSchema.safeParse({ grant_type: 'refresh_token', refresh_token: 'r'.repeat(43), client_id: DEV_ID }).success,
    ).toBe(true);
    expect(TokenRequestSchema.safeParse({ ...code, code_verifier: 'a'.repeat(42) }).success).toBe(false);
    expect(TokenRequestSchema.safeParse({ ...code, code_verifier: 'a'.repeat(129) }).success).toBe(false);
    expect(TokenRequestSchema.safeParse({ ...code, code_verifier: `${'a'.repeat(42)}+` }).success).toBe(false);
    expect(TokenRequestSchema.safeParse({ ...code, grant_type: 'password' }).success).toBe(false);
  });

  const req = {
    client_id: DEV_ID,
    redirect_uri: chromiumRedirectUri(DEV_ID),
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 's'.repeat(32),
  };

  it('test_authorize_request_rejects_plain_and_short', () => {
    expect(AuthorizeRequestSchema.safeParse(req).success).toBe(true);
    expect(AuthorizeRequestSchema.safeParse({ ...req, code_challenge_method: 'plain' }).success).toBe(false);
    expect(AuthorizeRequestSchema.safeParse({ ...req, code_challenge: CHALLENGE.slice(1) }).success).toBe(false);
    expect(AuthorizeRequestSchema.safeParse({ ...req, state: 's'.repeat(15) }).success).toBe(false);
  });

  it('test_authorize_request_binds_redirect_uri', () => {
    const otherId = 'b'.repeat(32);
    for (const redirect_uri of ['https://evil.example/cb', 'javascript:alert(1)', chromiumRedirectUri(otherId)]) {
      const result = AuthorizeRequestSchema.safeParse({ ...req, redirect_uri });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['redirect_uri']);
    }
  });

  it('test_authorize_response_redirect_is_chromiumapp', () => {
    const redirect = `${chromiumRedirectUri(DEV_ID)}?code=${'c'.repeat(43)}&state=${'s'.repeat(32)}`;
    expect(AuthorizeResponseSchema.safeParse({ redirect }).success).toBe(true);
    expect(AuthorizeResponseSchema.safeParse({ redirect: 'javascript:alert(1)' }).success).toBe(false);
    expect(AuthorizeResponseSchema.safeParse({ redirect: 'https://evil.example/?code=x' }).success).toBe(false);
    expect(AuthorizeResponseSchema.safeParse({ redirect: redirect.replace('https:', 'http:') }).success).toBe(false);
  });

  it('test_refresh_token_bounds_match_everywhere', () => {
    const tokens = {
      access_token: 'a.b.c',
      token_type: 'Bearer',
      expires_in: 900,
      refresh_token: 'r'.repeat(43),
      device_id: '0190a5b4-8c1e-7000-8000-000000000000',
      account: { email: 'reader@example.com' },
    };
    expect(TokenResponseSchema.safeParse(tokens).success).toBe(true);
    const long = 'r'.repeat(201);
    expect(TokenResponseSchema.safeParse({ ...tokens, refresh_token: long }).success).toBe(false);
    expect(TokenRequestSchema.safeParse({ grant_type: 'refresh_token', refresh_token: long, client_id: DEV_ID }).success).toBe(
      false,
    );
    expect(RevokeRequestSchema.safeParse({ refresh_token: long, client_id: DEV_ID }).success).toBe(false);
  });

  it('test_server_error_schema', () => {
    expect(ServerErrorSchema.safeParse({ code: 'auth-required', message: 'Sign in again.' }).success).toBe(true);
    expect(ServerErrorSchema.safeParse({ code: 'teapot', message: '' }).success).toBe(false);
  });
});

describe('audience', () => {
  const post = {
    ref: 'p1',
    platform: 'facebook',
    text: 'hi',
    textComplete: true,
    authorKind: 'person',
    isReshare: false,
    media: 'none',
  };

  it('test_post_for_ai_audience_optional_enum', () => {
    expect(PostForAISchema.parse({ ...post, audience: 'friends' }).audience).toBe('friends');
    expect(PostForAISchema.safeParse(post).success).toBe(true);
    expect(PostForAISchema.safeParse({ ...post, audience: 'everyone' }).success).toBe(false);
  });

  it('test_server_may_receive_only_public_facebook_posts', () => {
    expect(serverMayReceive({ platform: 'linkedin' })).toBe(true);
    expect(serverMayReceive({ platform: 'facebook', audience: 'public' })).toBe(true);
    for (const audience of ['friends', 'custom', 'unknown', undefined] as const)
      expect(serverMayReceive({ platform: 'facebook', audience })).toBe(false);
  });
});
