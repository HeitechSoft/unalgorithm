import { describe, expect, it } from 'vitest';
import type { NormalizedUsage } from '../src/index.ts';
import {
  AuthorizeRequestSchema,
  AuthorizeResponseSchema,
  ChromiumIdSchema,
  ClassifyRequestSchema,
  ClassifyResponseSchema,
  ClientIdSchema,
  ClientKindSchema,
  chromiumRedirectUri,
  clientKind,
  compareHlc,
  costMicros,
  DEV_CHROMIUM_ID,
  EMAIL_OTP_METHOD,
  FIREFOX_ADDON_ID,
  FIREFOX_DEV_ADDON_ID,
  formatHlc,
  GeckoIdSchema,
  geckoRedirectUri,
  MAX_MODEL_CHARS,
  MAX_POSTS_PER_REQUEST,
  OPENAI_FACTCHECK_TYPICAL_COST_MICROS,
  PostForAISchema,
  PRICE_CARDS,
  parseHlc,
  platformOfKey,
  RevokeRequestSchema,
  redirectUriFor,
  ServerErrorSchema,
  ServerInfoSchema,
  serverMayReceive,
  TokenRequestSchema,
  TokenResponseSchema,
  tickHlc,
  uuidv7,
} from '../src/index.ts';

describe('post refs', () => {
  it('test_classify_response_is_bounded', () => {
    // A server's answer is read into the extension's storage, so nothing in it is unbounded (a 4 MiB model name).
    const ok = {
      ref: 'p1',
      status: 'ok',
      classification: { relevance: 50, noise: [], topics: [], reason: 'r', isNews: false, hasCheckableClaims: false },
    };
    const answer = (over: Record<string, unknown> = {}, source: Record<string, unknown> = {}) => ({
      v: 1,
      results: [ok],
      source: { kind: 'server', model: 'm', promptVersion: 1, ...source },
      ...over,
    });
    expect(ClassifyResponseSchema.safeParse(answer()).success).toBe(true);
    expect(ClassifyResponseSchema.safeParse(answer({}, { model: 'm'.repeat(MAX_MODEL_CHARS) })).success).toBe(true);
    expect(ClassifyResponseSchema.safeParse(answer({}, { model: 'm'.repeat(4 * 1024 * 1024) })).success).toBe(false);
    expect(ClassifyResponseSchema.safeParse(answer({}, { model: 'm'.repeat(MAX_MODEL_CHARS + 1) })).success).toBe(false);
    expect(ClassifyResponseSchema.safeParse(answer({}, { kind: 'k'.repeat(41) })).success).toBe(false);
    const many = Array.from({ length: MAX_POSTS_PER_REQUEST }, (_, i) => ({ ...ok, ref: `p${i + 1}` }));
    expect(ClassifyResponseSchema.safeParse(answer({ results: many })).success).toBe(true);
    expect(ClassifyResponseSchema.safeParse(answer({ results: [...many, ok] })).success).toBe(false);
    expect(ClassifyResponseSchema.safeParse(answer({ results: [{ ...ok, ref: 'r'.repeat(65) }] })).success).toBe(false);
    const error = (message: string) => answer({ results: [{ ref: 'p1', status: 'error', message }] });
    expect(ClassifyResponseSchema.safeParse(error('Try again later.')).success).toBe(true);
    expect(ClassifyResponseSchema.safeParse(error('e'.repeat(501))).success).toBe(false);
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

  const usage = (u: Partial<NormalizedUsage>): NormalizedUsage => ({
    uncachedInput: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    webSearches: 0,
    estimated: false,
    ...u,
  });

  it('never rounds an exact whole micro-dollar up', () => {
    expect(costMicros('claude-haiku-5-5', usage({ output: 246 }))).toBe(123);
    expect(costMicros('claude-sonnet-5-5', usage({ uncachedInput: 23, cacheRead: 1000 }))).toBe(246);
    expect(costMicros('claude-haiku-5-5', usage({ uncachedInput: 1856, cacheRead: 440, cacheWrite: 1728, output: 208 }))).toBe(
      510,
    );
    expect(costMicros('claude-haiku-5-5', usage({ webSearches: 3 }))).toBe(30_000);
    // A fraction of a micro-dollar still rounds up.
    expect(costMicros('claude-haiku-5-5', usage({ uncachedInput: 1 }))).toBe(1);
  });

  it('matches exact integer arithmetic on random usage', () => {
    // Thousandths of a micro-dollar per token: input, output, cache read, cache write. A web search is 10,000 µ$.
    const milli: Record<string, readonly number[]> = {
      'claude-haiku-5-5': [100, 500, 10, 125],
      'claude-sonnet-5-5': [2000, 10_000, 200, 2500],
      'claude-opus-5-5': [4000, 20_000, 200, 5000],
    };
    let seed = 42;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    for (const [model, [inp = 0, out = 0, read = 0, write = 0]] of Object.entries(milli)) {
      for (let i = 0; i < 20_000; i++) {
        const u = usage({
          uncachedInput: rand(4000),
          cacheRead: rand(3000),
          cacheWrite: rand(3000),
          output: rand(3000),
          webSearches: rand(3),
        });
        const exact =
          u.uncachedInput * inp + u.output * out + u.cacheRead * read + u.cacheWrite * write + u.webSearches * 10_000_000;
        if (costMicros(model, u) !== Math.ceil(exact / 1000))
          expect({ model, u, got: costMicros(model, u) }).toBe(Math.ceil(exact / 1000));
      }
    }
  });
});

describe('price cards', () => {
  const usage = (u: Partial<NormalizedUsage>): NormalizedUsage => ({
    uncachedInput: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    webSearches: 0,
    estimated: false,
    ...u,
  });

  it('test_openai_cards_and_typical_cost', () => {
    expect(costMicros('gpt-5', usage({ uncachedInput: 30_000, output: 1_500, webSearches: 3 }))).toBe(82_500);
    // The reference fact-check usage at OPENAI_FACTCHECK_MODELS (claims gpt-5-mini, research and verdict gpt-5).
    const reference = [
      costMicros('gpt-5-mini', usage({ uncachedInput: 1_000, output: 100 })),
      costMicros('gpt-5', usage({ uncachedInput: 30_000, output: 1_500, webSearches: 3 })),
      costMicros('gpt-5', usage({ uncachedInput: 2_000, output: 400 })),
    ];
    expect(reference).toEqual([450, 82_500, 6_500]);
    const total = reference.reduce<number>((a, b) => a + (b ?? Number.NaN), 0);
    expect(total).toBe(89_450);
    expect(OPENAI_FACTCHECK_TYPICAL_COST_MICROS).toBe(Math.ceil(total / 10_000) * 10_000);
    expect(costMicros('gpt-5-mini', usage({ cacheRead: 1_000 }))).toBe(25);
    expect(costMicros('gpt-5', usage({ cacheRead: 1_000, cacheWrite: 1_000 }))).toBe(125);
  });

  it('test_existing_price_cards_unchanged', () => {
    expect(PRICE_CARDS['claude-haiku-5-5']).toEqual({
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      webSearch: 0.01,
    });
    expect(PRICE_CARDS['claude-sonnet-5-5']).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, webSearch: 0.01 });
    expect(PRICE_CARDS['claude-opus-5-5']).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, webSearch: 0.01 });
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
const UUID_ID = '{12345678-1234-1234-1234-123456789abc}';
/** sha1('feed@unalgorithmfeed.com'), as Firefox's getRedirectURL() puts it. */
const ADDON_REDIRECT = 'https://fa1fc373df59566227d5f6860e1bb584c0410048.extensions.allizom.org/';
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

  it('test_server_info_clients_optional', () => {
    // A server from before Firefox leaves the list out; that means Chromium clients only.
    expect(ServerInfoSchema.parse(info).auth.clients).toBeUndefined();
    for (const clients of [['chromium'], ['gecko'], ['chromium', 'gecko']]) {
      const parsed = ServerInfoSchema.parse({ ...info, auth: { ...info.auth, clients } });
      expect(parsed.auth.clients).toEqual(clients);
      expect(ServerInfoSchema.parse(parsed)).toEqual(parsed);
    }
  });

  it('test_server_info_drops_unknown_clients', () => {
    // A newer server may accept kinds this client has never heard of: they are dropped, and the document still parses.
    const later = { ...info, auth: { ...info.auth, clients: ['chromium', 'webkit', 'gecko'] } };
    const parsed = ServerInfoSchema.parse(later);
    expect(parsed.auth.clients).toEqual(['chromium', 'gecko']);
    // Stored accounts keep the parsed document and parse it again.
    expect(ServerInfoSchema.parse(parsed)).toEqual(parsed);
    // Nothing known left reads as missing, never as an empty list a second parse would refuse.
    const foreign = ServerInfoSchema.parse({ ...info, auth: { ...info.auth, clients: ['webkit'] } });
    expect(foreign.auth.clients).toBeUndefined();
    expect(ServerInfoSchema.safeParse(foreign).success).toBe(true);
  });

  it('test_server_info_rejects_bad_clients', () => {
    const many = Array.from({ length: 11 }, () => 'gecko');
    for (const clients of [[], [''], ['x'.repeat(41)], many, [1], 'gecko', null]) {
      const result = ServerInfoSchema.safeParse({ ...info, auth: { ...info.auth, clients } });
      expect(result.success, JSON.stringify(clients)).toBe(false);
    }
  });
});

describe('ids and redirects', () => {
  /** Valid add-on ids: Firefox's pattern ignores case, and the part before @ may be empty. */
  const GECKO_IDS = [
    FIREFOX_ADDON_ID,
    FIREFOX_DEV_ADDON_ID,
    UUID_ID,
    UUID_ID.toUpperCase(),
    'FEED@UNALGORITHMFEED.COM',
    'a.b-c_d@x.y',
    '@x',
    'a@b',
    `${'a'.repeat(68)}@example.com`, // 80 characters
  ];
  const NOT_IDS = [
    '',
    'feed',
    'feed@',
    'a b@c',
    'x@y,z',
    'a@b@c',
    'ü@x.y',
    'feed@unalgorithmfeed.com/',
    ' feed@unalgorithmfeed.com',
    'feed@unalgorithmfeed.com\n',
    `${'a'.repeat(69)}@example.com`, // 81 characters
    '{1234}',
    '{12345678-1234-1234-1234-123456789abg}',
    '12345678-1234-1234-1234-123456789abc',
    '{12345678-1234-1234-1234-123456789abc',
    '{12345678123412341234123456789abc}',
    DEV_ID.slice(1),
    `q${DEV_ID.slice(1)}`,
    DEV_ID.toUpperCase(),
    `${DEV_ID}a`,
  ];

  it('test_chromium_id_schema', () => {
    expect(ChromiumIdSchema.safeParse(DEV_ID).success).toBe(true);
    expect(ChromiumIdSchema.safeParse('p'.repeat(32)).success).toBe(true);
    for (const id of [...NOT_IDS, ...GECKO_IDS]) expect(ChromiumIdSchema.safeParse(id).success, id).toBe(false);
  });

  it('test_gecko_id_schema', () => {
    expect(`${'a'.repeat(68)}@example.com`).toHaveLength(80);
    for (const id of GECKO_IDS) expect(GeckoIdSchema.safeParse(id).success, id).toBe(true);
    for (const id of [...NOT_IDS, DEV_ID]) expect(GeckoIdSchema.safeParse(id).success, id).toBe(false);
  });

  it('test_client_id_schema_takes_both_kinds', () => {
    for (const id of [DEV_ID, ...GECKO_IDS]) expect(ClientIdSchema.safeParse(id).success, id).toBe(true);
    for (const id of NOT_IDS) expect(ClientIdSchema.safeParse(id).success, id).toBe(false);
  });

  it('test_client_kind', () => {
    expect(ClientKindSchema.options).toEqual(['chromium', 'gecko']);
    expect(clientKind(DEV_ID)).toBe('chromium');
    for (const id of GECKO_IDS) expect(clientKind(id), id).toBe('gecko');
    for (const id of NOT_IDS) expect(clientKind(id), id).toBeNull();
    // Total: whatever arrives in a request body, it answers without throwing.
    for (const value of [undefined, null, 5, {}, [], Symbol('id')]) expect(clientKind(value as unknown as string)).toBeNull();
  });

  it('test_known_ids', () => {
    expect(DEV_CHROMIUM_ID).toBe(DEV_ID);
    expect(clientKind(DEV_CHROMIUM_ID)).toBe('chromium');
    expect(FIREFOX_ADDON_ID).toBe('feed@unalgorithmfeed.com');
    expect(FIREFOX_DEV_ADDON_ID).toBe('feed-dev@unalgorithmfeed.com');
    expect(clientKind(FIREFOX_ADDON_ID)).toBe('gecko');
    expect(clientKind(FIREFOX_DEV_ADDON_ID)).toBe('gecko');
  });

  it('test_chromium_redirect_uri', () => {
    expect(chromiumRedirectUri(DEV_ID)).toBe('https://aokmlebkpkeniofcnbeajmgabinicggm.chromiumapp.org/');
  });

  it('test_gecko_redirect_uri', () => {
    expect(geckoRedirectUri(FIREFOX_ADDON_ID)).toBe(ADDON_REDIRECT);
    expect(geckoRedirectUri(FIREFOX_DEV_ADDON_ID)).toBe(
      'https://050785fd621b7eeb0c98874aa5418eafb61158f5.extensions.allizom.org/',
    );
    expect(geckoRedirectUri(UUID_ID)).toBe('https://81128efacdb47fdc8641a8913694f8bd997543a4.extensions.allizom.org/');
    // Firefox hashes runtime.id exactly as given: the same id in other case is another address.
    expect(geckoRedirectUri(FIREFOX_ADDON_ID.toUpperCase())).not.toBe(ADDON_REDIRECT);
  });

  it('test_redirect_uri_for', () => {
    expect(redirectUriFor(DEV_ID)).toBe(chromiumRedirectUri(DEV_ID));
    expect(redirectUriFor(FIREFOX_ADDON_ID)).toBe(ADDON_REDIRECT);
    for (const id of GECKO_IDS) expect(redirectUriFor(id), id).toBe(geckoRedirectUri(id));
    for (const id of NOT_IDS) expect(redirectUriFor(id), id).toBeNull();
    for (const value of [undefined, null, 5, {}, [], Symbol('id')]) {
      expect(redirectUriFor(value as unknown as string)).toBeNull();
    }
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

  it('test_token_request_takes_firefox_ids', () => {
    const firefox = { ...code, client_id: FIREFOX_ADDON_ID, redirect_uri: ADDON_REDIRECT };
    expect(TokenRequestSchema.parse(firefox)).toEqual(firefox);
    const refresh = { grant_type: 'refresh_token', refresh_token: 'r'.repeat(43), client_id: FIREFOX_ADDON_ID };
    expect(TokenRequestSchema.parse(refresh)).toEqual(refresh);
    expect(TokenRequestSchema.safeParse({ ...refresh, client_id: UUID_ID }).success).toBe(true);
    for (const client_id of ['feed@', `${'a'.repeat(69)}@example.com`, DEV_ID.toUpperCase()]) {
      expect(TokenRequestSchema.safeParse({ ...firefox, client_id }).success, client_id).toBe(false);
      expect(TokenRequestSchema.safeParse({ ...refresh, client_id }).success, client_id).toBe(false);
    }
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
    for (const redirect_uri of [
      'https://evil.example/cb',
      'javascript:alert(1)',
      chromiumRedirectUri(otherId),
      geckoRedirectUri(FIREFOX_ADDON_ID),
      chromiumRedirectUri(DEV_ID).slice(0, -1),
      `${chromiumRedirectUri(DEV_ID)}cb`,
    ]) {
      const result = AuthorizeRequestSchema.safeParse({ ...req, redirect_uri });
      expect(result.success, redirect_uri).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['redirect_uri']);
    }
  });

  it('test_authorize_request_binds_firefox_redirect_uri', () => {
    const firefox = { ...req, client_id: FIREFOX_ADDON_ID, redirect_uri: ADDON_REDIRECT };
    expect(AuthorizeRequestSchema.parse(firefox)).toEqual(firefox);
    expect(
      AuthorizeRequestSchema.safeParse({ ...req, client_id: UUID_ID, redirect_uri: geckoRedirectUri(UUID_ID) }).success,
    ).toBe(true);
    for (const redirect_uri of [
      // Another kind's address, another add-on's hash, or this hash anywhere but Firefox's form.
      chromiumRedirectUri(DEV_ID),
      geckoRedirectUri(FIREFOX_DEV_ADDON_ID),
      geckoRedirectUri(FIREFOX_ADDON_ID.toUpperCase()),
      ADDON_REDIRECT.toUpperCase().replace('HTTPS', 'https'),
      ADDON_REDIRECT.slice(0, -1),
      ADDON_REDIRECT.replace('https:', 'http:'),
      ADDON_REDIRECT.replace('extensions.allizom.org', 'example.com'),
      'http://127.0.0.1/mozoauth2/fa1fc373df59566227d5f6860e1bb584c0410048',
    ]) {
      const result = AuthorizeRequestSchema.safeParse({ ...firefox, redirect_uri });
      expect(result.success, redirect_uri).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['redirect_uri']);
    }
  });

  it('test_authorize_request_check_survives_bad_client_id', () => {
    // zod still runs the redirect check after client_id fails: it must refuse, not throw.
    for (const client_id of ['nope', 'feed@', DEV_ID.toUpperCase(), `${'a'.repeat(69)}@example.com`, 5, null, {}, []]) {
      for (const redirect_uri of [ADDON_REDIRECT, chromiumRedirectUri(DEV_ID), chromiumRedirectUri(String(client_id))]) {
        const result = AuthorizeRequestSchema.safeParse({ ...req, client_id, redirect_uri });
        expect(result.success, `${String(client_id)} ${redirect_uri}`).toBe(false);
        expect(result.error?.issues.map((issue) => issue.path[0])).toContain('client_id');
      }
    }
    // A request with nothing valid in it is refused too.
    for (const body of [{}, { client_id: undefined, redirect_uri: undefined }, { redirect_uri: null }, null, 'x']) {
      expect(AuthorizeRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it('test_authorize_response_redirect_is_extension_host', () => {
    const query = `?code=${'c'.repeat(43)}&state=${'s'.repeat(32)}`;
    for (const redirect of [`${chromiumRedirectUri(DEV_ID)}${query}`, `${ADDON_REDIRECT}${query}`]) {
      expect(AuthorizeResponseSchema.safeParse({ redirect }).success, redirect).toBe(true);
      expect(AuthorizeResponseSchema.safeParse({ redirect: redirect.replace('https:', 'http:') }).success).toBe(false);
    }
    const hash = 'fa1fc373df59566227d5f6860e1bb584c0410048';
    for (const redirect of [
      'javascript:alert(1)',
      'https://evil.example/?code=x',
      `https://${'a'.repeat(31)}.chromiumapp.org/${query}`,
      `https://${hash.slice(1)}.extensions.allizom.org/${query}`,
      `https://${hash}0.extensions.allizom.org/${query}`,
      `https://${hash.slice(1)}g.extensions.allizom.org/${query}`,
      `https://${hash}.extensions.allizom.org.evil.example/${query}`,
      `https://x.${hash}.extensions.allizom.org/${query}`,
      `https://${hash}.allizom.org/${query}`,
      `https://evil.example/${hash}.extensions.allizom.org/${query}`,
      // Firefox's loopback form is not one we hand out.
      `http://127.0.0.1/mozoauth2/${hash}${query}`,
      `https://127.0.0.1/mozoauth2/${hash}${query}`,
      `moz-extension://12345678-1234-1234-1234-123456789abc/${query}`,
    ]) {
      expect(AuthorizeResponseSchema.safeParse({ redirect }).success, redirect).toBe(false);
    }
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

  it('test_revoke_request_takes_both_kinds', () => {
    for (const client_id of [DEV_ID, FIREFOX_ADDON_ID, UUID_ID]) {
      expect(RevokeRequestSchema.safeParse({ refresh_token: 'r'.repeat(43), client_id }).success, client_id).toBe(true);
    }
    for (const client_id of ['feed@', 'nope', DEV_ID.toUpperCase()]) {
      expect(RevokeRequestSchema.safeParse({ refresh_token: 'r'.repeat(43), client_id }).success, client_id).toBe(false);
    }
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
