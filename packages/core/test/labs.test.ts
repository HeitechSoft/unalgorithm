import type { ServerInfo } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import {
  type AISourceConfig,
  checkCostLine,
  type Device,
  defaultDevice,
  factcheckOffered,
  factcheckPriceLabel,
  jobPriceLabel,
  migrateDevice,
  type PostData,
  perspectivesOffered,
  perspectivesSwitchOn,
  type ServerOffer,
  serverJobPriceLabel,
  serverOfferFrom,
  sourceCapabilities,
  webSearchOrigin,
} from '../src/index.ts';

const ANTHROPIC: AISourceConfig = { kind: 'anthropic', model: null };
const OPENAI: AISourceConfig = { kind: 'openai', model: null };
const SOURCES: Record<string, AISourceConfig> = {
  'on-device': { kind: 'on-device' },
  anthropic: ANTHROPIC,
  openai: OPENAI,
  'openai-compatible': {
    kind: 'openai-compatible',
    preset: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    auth: 'none',
    model: null,
  },
  server: { kind: 'server', baseUrl: 'https://ai.example.org' },
};

type Input = Parameters<typeof factcheckOffered>[0];
const base = (): Input => ({
  device: { aiSource: ANTHROPIC, labs: { factcheck: true, perspectives: false }, webSearch: null },
  post: { platform: 'linkedin' },
  classification: { isNews: false, hasCheckableClaims: true },
});

describe('Labs defaults and migration', () => {
  it('test_default_device_has_factcheck_off', () => {
    expect(defaultDevice('d1').labs.factcheck).toBe(false);
  });

  it('test_migrate_device_adds_labs_and_keeps_fields', () => {
    const stored = { ...defaultDevice('d1'), aiSource: ANTHROPIC, pausedUntil: { linkedin: 'manual', facebook: 5 } };
    delete (stored as Partial<Device>).labs;
    const out = migrateDevice(stored, () => 'new');
    expect(out.labs.factcheck).toBe(false);
    const { labs: _labs, ...rest } = out;
    expect(rest).toEqual(stored);
  });
});

describe('sourceCapabilities', () => {
  it('test_source_capabilities_per_kind', () => {
    expect(sourceCapabilities(null)).toEqual({ classify: false, factcheck: false, perspectives: false, webSearch: false });
    for (const [kind, cfg] of Object.entries(SOURCES)) {
      const caps = sourceCapabilities(cfg);
      const full = kind === 'anthropic' || kind === 'openai';
      expect(caps.perspectives, kind).toBe(full);
      expect(caps.classify, kind).toBe(true);
      expect(caps.factcheck, kind).toBe(full);
      expect(caps.webSearch, kind).toBe(full);
    }
  });
});

describe('factcheckOffered', () => {
  it('test_factcheck_offered_for_checkable_claims_and_news', () => {
    expect(factcheckOffered(base())).toBe(true);
    expect(factcheckOffered({ ...base(), classification: { isNews: true, hasCheckableClaims: false } })).toBe(true);
  });

  it('test_factcheck_not_offered_when_any_condition_fails', () => {
    const b = base();
    const cases: [string, Input][] = [
      ['labs off', { ...b, device: { ...b.device, labs: { factcheck: false, perspectives: true } } }],
      ['on-device source', { ...b, device: { ...b.device, aiSource: { kind: 'on-device' } } }],
      ['no source', { ...b, device: { ...b.device, aiSource: null } }],
      ['no classification', { ...b, classification: undefined }],
      ['neither flag', { ...b, classification: { isNews: false, hasCheckableClaims: false } }],
    ];
    const audiences: PostData['audience'][] = ['friends', 'custom', 'unknown', undefined];
    for (const audience of audiences) {
      const post: Input['post'] = audience ? { platform: 'facebook', audience } : { platform: 'facebook' };
      cases.push([`facebook ${audience ?? 'missing'}`, { ...b, post }]);
    }
    for (const [name, input] of cases) expect(factcheckOffered(input), name).toBe(false);
    expect(factcheckOffered({ ...b, post: { platform: 'facebook', audience: 'public' } })).toBe(true);
  });

  it('test_factcheck_price_label', () => {
    expect(factcheckPriceLabel(ANTHROPIC)).toBe('About $0.12 on your Anthropic account');
    expect(factcheckPriceLabel(OPENAI)).toBe('About $0.09 on your OpenAI account');
    expect(factcheckPriceLabel({ kind: 'on-device' })).toBeNull();
    expect(factcheckPriceLabel(null)).toBeNull();
  });
});

const SERVER: AISourceConfig = { kind: 'server', baseUrl: 'https://ai.example.org' };
const FREE_OFFER: ServerOffer = {
  origin: 'https://ai.example.org',
  billing: false,
  factcheck: true,
  factcheckPrice: null,
  perspectives: false,
  perspectivesPrice: null,
};
const PRICE = { typicalMicros: 240_000, maxMicros: 400_000 };
const PAID_OFFER: ServerOffer = { ...FREE_OFFER, billing: true, factcheckPrice: PRICE };

/** A CL4 discovery document: no `capabilities.factcheck`, no `jobPrices`. */
const CL4_INFO: ServerInfo = {
  v: 1,
  name: 'Example',
  version: '0.1.0',
  source: 'https://example.org/src',
  billing: false,
  capabilities: { classify: true, sync: true },
  auth: { methods: ['email-otp'], authorizePath: '/authorize', tokenPath: '/token' },
  limits: { maxPostsPerRequest: 20 },
};

describe('Server offer', () => {
  it('test_server_offer_from_account', () => {
    expect(serverOfferFrom(null)).toBeNull();
    const origin = 'https://ai.example.org';
    expect(serverOfferFrom({ origin, info: CL4_INFO, needsSignIn: true })).toBeNull();
    expect(serverOfferFrom({ origin, info: CL4_INFO, needsSignIn: false })).toEqual({
      origin,
      billing: false,
      factcheck: false,
      factcheckPrice: null,
      perspectives: false,
      perspectivesPrice: null,
    });
    const info: ServerInfo = {
      ...CL4_INFO,
      billing: true,
      capabilities: { ...CL4_INFO.capabilities, factcheck: true },
      jobPrices: { factcheck: PRICE },
    };
    const offer = serverOfferFrom({ origin, info, needsSignIn: false });
    expect(offer).toEqual({
      origin,
      billing: true,
      factcheck: true,
      factcheckPrice: PRICE,
      perspectives: false,
      perspectivesPrice: null,
    });
    expect(Object.keys(offer ?? {}).sort()).toEqual([
      'billing',
      'factcheck',
      'factcheckPrice',
      'origin',
      'perspectives',
      'perspectivesPrice',
    ]);
  });

  it('test_server_source_capable_when_offered_same_origin', () => {
    expect(sourceCapabilities(SERVER, FREE_OFFER)).toEqual({
      classify: true,
      factcheck: true,
      perspectives: false,
      webSearch: true,
    });
    // A trailing path on the base URL still matches the origin.
    expect(sourceCapabilities({ kind: 'server', baseUrl: 'https://ai.example.org/' }, FREE_OFFER).factcheck).toBe(true);
  });

  it('test_server_source_not_capable_other_origin_or_not_offered', () => {
    const notCapable = { classify: true, factcheck: false, perspectives: false, webSearch: false };
    expect(sourceCapabilities(SERVER, { ...FREE_OFFER, origin: 'https://other.example.org' })).toEqual(notCapable);
    expect(sourceCapabilities(SERVER, { ...FREE_OFFER, factcheck: false })).toEqual(notCapable);
    expect(sourceCapabilities(SERVER, null)).toEqual(notCapable);
    expect(sourceCapabilities(SERVER)).toEqual(notCapable);
    expect(sourceCapabilities({ kind: 'server', baseUrl: 'not a url' }, FREE_OFFER)).toEqual(notCapable);
    // Other kinds ignore the offer.
    expect(sourceCapabilities({ kind: 'on-device' }, FREE_OFFER).factcheck).toBe(false);
    expect(sourceCapabilities(ANTHROPIC, null).factcheck).toBe(true);
  });

  it('test_billing_server_needs_a_price', () => {
    expect(sourceCapabilities(SERVER, { ...PAID_OFFER, factcheckPrice: null }).factcheck).toBe(false);
    expect(sourceCapabilities(SERVER, PAID_OFFER).factcheck).toBe(true);
  });

  it('test_factcheck_offered_server_public_only', () => {
    const input: Input = {
      ...base(),
      device: { aiSource: SERVER, labs: { factcheck: true, perspectives: false }, webSearch: null },
      serverOffer: PAID_OFFER,
    };
    expect(factcheckOffered({ ...input, post: { platform: 'facebook', audience: 'public' } })).toBe(true);
    expect(factcheckOffered({ ...input, post: { platform: 'linkedin' } })).toBe(true);
    expect(factcheckOffered({ ...input, post: { platform: 'facebook', audience: 'friends' } })).toBe(false);
    expect(factcheckOffered({ ...input, serverOffer: undefined })).toBe(false);
  });
});

describe('Price label', () => {
  it('test_factcheck_price_label_server', () => {
    expect(factcheckPriceLabel(SERVER, FREE_OFFER)).toBe('Free on this server');
    expect(factcheckPriceLabel(SERVER, PAID_OFFER)).toBe('About $0.24, at most $0.40');
    expect(factcheckPriceLabel(SERVER, null)).toBeNull();
    expect(factcheckPriceLabel(SERVER, { ...FREE_OFFER, factcheck: false })).toBeNull();
    expect(factcheckPriceLabel(SERVER, { ...PAID_OFFER, factcheckPrice: null })).toBeNull();
    expect(factcheckPriceLabel(ANTHROPIC, PAID_OFFER)).toBe('About $0.12 on your Anthropic account');
  });

  it('test_server_job_price_label', () => {
    // The server branch of `jobPriceLabel`, on its own: the Pricing page's preview shows it (PA-05).
    expect(serverJobPriceLabel({ typicalMicros: 240_000, maxMicros: 400_000 })).toBe('About $0.24, at most $0.40');
    expect(serverJobPriceLabel({ typicalMicros: 270_000, maxMicros: 500_000 })).toBe('About $0.27, at most $0.50');
    const price = PAID_OFFER.factcheckPrice;
    expect(price && serverJobPriceLabel(price)).toBe(factcheckPriceLabel(SERVER, PAID_OFFER));
  });
});

describe('Cost line', () => {
  it('test_check_cost_line_texts', () => {
    expect(checkCostLine({ chargedMicros: 400 })).toBe('Charged <$0.01 to your balance.');
    expect(checkCostLine({ chargedMicros: 190_000 })).toBe('Charged $0.19 to your balance.');
    expect(checkCostLine({ costMicros: 150 })).toBe('This check cost about <$0.01 on your own key.');
    expect(checkCostLine({})).toBeNull();
    expect(checkCostLine({ costMicros: 150, chargedMicros: 190_000 })).toBe('Charged $0.19 to your balance.');
  });
});

describe('Other perspectives', () => {
  const ORIGIN = 'https://ai.example.org';
  const P_PRICE = { typicalMicros: 270_000, maxMicros: 500_000 };
  const P_FREE: ServerOffer = { ...FREE_OFFER, factcheck: false, perspectives: true };
  const P_PAID: ServerOffer = { ...P_FREE, billing: true, perspectivesPrice: P_PRICE };
  const LINK = { url: 'https://news.example.com/a', domain: 'news.example.com' };

  type PInput = Parameters<typeof perspectivesOffered>[0];
  const pbase = (): PInput => ({
    device: { aiSource: ANTHROPIC, labs: { factcheck: false, perspectives: true }, webSearch: null },
    post: { platform: 'linkedin', sharedLink: LINK },
    classification: { isNews: true },
    listReady: true,
  });

  it('test_labs_perspectives_defaults_off_and_migrates', () => {
    expect(defaultDevice('d1').labs).toEqual({ factcheck: false, perspectives: false });
    const stored = { ...defaultDevice('d1'), labs: { factcheck: true } };
    expect(migrateDevice(stored, () => 'new').labs).toEqual({ factcheck: true, perspectives: false });
  });

  it('test_source_capabilities_perspectives', () => {
    expect(sourceCapabilities(ANTHROPIC).perspectives).toBe(true);
    expect(sourceCapabilities(null).perspectives).toBe(false);
    for (const kind of ['openai-compatible', 'on-device']) {
      expect(sourceCapabilities(SOURCES[kind] ?? null, P_PAID).perspectives, kind).toBe(false);
    }
    expect(sourceCapabilities(SERVER, P_FREE)).toEqual({
      classify: true,
      factcheck: false,
      perspectives: true,
      webSearch: true,
    });
    expect(sourceCapabilities(SERVER, P_PAID).perspectives).toBe(true);
    expect(sourceCapabilities(SERVER, { ...P_PAID, perspectivesPrice: null }).perspectives).toBe(false);
    expect(sourceCapabilities(SERVER, { ...P_FREE, perspectives: false }).perspectives).toBe(false);
    expect(sourceCapabilities(SERVER, { ...P_FREE, origin: 'https://other.example.org' }).perspectives).toBe(false);
    expect(sourceCapabilities(SERVER, null).perspectives).toBe(false);
    // Each task needs its own price on a billing server.
    expect(sourceCapabilities(SERVER, { ...P_PAID, factcheck: true }).factcheck).toBe(false);
  });

  it('test_perspectives_switch_on_needs_flag_and_capable_source', () => {
    // As Settings → AI shows the switch: the stored flag alone isn't enough once the source can't compare.
    const on = (aiSource: AISourceConfig | null, webSearch: Device['webSearch'] = null) => ({
      aiSource,
      labs: { factcheck: false, perspectives: true },
      webSearch,
    });
    expect(perspectivesSwitchOn(on(ANTHROPIC))).toBe(true);
    expect(perspectivesSwitchOn(on(OPENAI))).toBe(true);
    expect(perspectivesSwitchOn(on(SOURCES['openai-compatible'] ?? null, { provider: 'brave' }))).toBe(true);
    expect(perspectivesSwitchOn(on(SERVER), P_FREE)).toBe(true);
    expect(perspectivesSwitchOn({ ...on(ANTHROPIC), labs: { factcheck: true, perspectives: false } })).toBe(false);
    expect(perspectivesSwitchOn(on(null))).toBe(false);
    expect(perspectivesSwitchOn(on({ kind: 'on-device' }))).toBe(false);
    expect(perspectivesSwitchOn(on(SOURCES['openai-compatible'] ?? null))).toBe(false);
    expect(perspectivesSwitchOn(on(SERVER))).toBe(false);
    expect(perspectivesSwitchOn(on(SERVER), { ...P_FREE, perspectives: false })).toBe(false);
  });

  it('test_server_offer_from_perspectives_fields', () => {
    const rm2 = serverOfferFrom({ origin: ORIGIN, info: CL4_INFO, needsSignIn: false });
    expect(rm2?.perspectives).toBe(false);
    expect(rm2?.perspectivesPrice).toBeNull();
    const info: ServerInfo = {
      ...CL4_INFO,
      billing: true,
      capabilities: { ...CL4_INFO.capabilities, perspectives: true },
      jobPrices: { perspectives: P_PRICE },
    };
    expect(serverOfferFrom({ origin: ORIGIN, info, needsSignIn: false })).toEqual({
      origin: ORIGIN,
      billing: true,
      factcheck: false,
      factcheckPrice: null,
      perspectives: true,
      perspectivesPrice: P_PRICE,
    });
  });

  it('test_perspectives_offered_happy_path', () => {
    expect(perspectivesOffered(pbase())).toBe(true);
    const http = { url: 'http://x.example/b', domain: 'x.example' };
    expect(perspectivesOffered({ ...pbase(), post: { platform: 'linkedin', sharedLink: http } })).toBe(true);
    const server = { aiSource: SERVER, labs: { factcheck: false, perspectives: true }, webSearch: null };
    expect(perspectivesOffered({ ...pbase(), device: server, serverOffer: P_PAID })).toBe(true);
  });

  it('test_perspectives_offered_each_gate', () => {
    const b = pbase();
    const server = { aiSource: SERVER, labs: { factcheck: false, perspectives: true }, webSearch: null };
    const cases: [string, PInput][] = [
      ['flag off', { ...b, device: { ...b.device, labs: { factcheck: true, perspectives: false } } }],
      ['list not ready', { ...b, listReady: false }],
      [
        'checkable claims only',
        { ...b, classification: { isNews: false, hasCheckableClaims: true } as PInput['classification'] },
      ],
      ['no classification', { ...b, classification: undefined }],
      ['no shared link', { ...b, post: { platform: 'linkedin' } }],
      ['javascript: link', { ...b, post: { platform: 'linkedin', sharedLink: { url: 'javascript:alert(1)', domain: 'x' } } }],
      ['facebook friends', { ...b, post: { platform: 'facebook', audience: 'friends', sharedLink: LINK } }],
      ['facebook missing audience', { ...b, post: { platform: 'facebook', sharedLink: LINK } }],
      ['server without perspectives', { ...b, device: server, serverOffer: { ...PAID_OFFER } }],
    ];
    for (const [name, input] of cases) expect(perspectivesOffered(input), name).toBe(false);
    expect(perspectivesOffered({ ...b, post: { platform: 'facebook', audience: 'public', sharedLink: LINK } })).toBe(true);
    const bad = { url: 'not a url', domain: 'x' };
    expect(perspectivesOffered({ ...b, post: { platform: 'linkedin', sharedLink: bad } })).toBe(false);
  });

  it('test_job_price_label_perspectives', () => {
    expect(jobPriceLabel('perspectives', ANTHROPIC)).toBe('About $0.14 on your Anthropic account');
    expect(jobPriceLabel('perspectives', SERVER, P_FREE)).toBe('Free on this server');
    expect(jobPriceLabel('perspectives', SERVER, P_PAID)).toBe('About $0.27, at most $0.50');
    expect(jobPriceLabel('perspectives', { kind: 'on-device' })).toBeNull();
    expect(jobPriceLabel('perspectives', null)).toBeNull();
    expect(jobPriceLabel('perspectives', SERVER, PAID_OFFER)).toBeNull();
    expect(jobPriceLabel('factcheck', SERVER, P_PAID)).toBeNull();
    expect(jobPriceLabel('factcheck', ANTHROPIC)).toBe('About $0.12 on your Anthropic account');
  });
});

describe('OpenAI and OpenAI-compatible sources (RM4)', () => {
  const NONE = { classify: true, factcheck: false, perspectives: false, webSearch: false };
  const ALL = { classify: true, factcheck: true, perspectives: true, webSearch: true };
  const compat = (baseUrl: string): AISourceConfig => ({
    kind: 'openai-compatible',
    preset: 'custom',
    baseUrl,
    auth: 'none',
    model: null,
  });
  const LOCAL = compat('http://localhost:11434/v1');
  const REMOTE = compat('https://openrouter.ai/api/v1');
  const BRAVE = { provider: 'brave' } as const;
  const TAVILY = { provider: 'tavily' } as const;
  const LINK = { url: 'https://news.example.com/a', domain: 'news.example.com' };
  const P_OFFER: ServerOffer = { ...PAID_OFFER, perspectives: true, perspectivesPrice: PRICE };

  it('test_capabilities_openai_key', () => {
    expect(sourceCapabilities({ kind: 'openai', model: null })).toEqual(ALL);
    expect(sourceCapabilities(OPENAI, null, BRAVE)).toEqual(ALL);
  });

  it('test_capabilities_compat_needs_search_key', () => {
    expect(sourceCapabilities(LOCAL)).toEqual(NONE);
    expect(sourceCapabilities(LOCAL, null, null)).toEqual(NONE);
    expect(sourceCapabilities(LOCAL, null, BRAVE)).toEqual(ALL);
    expect(sourceCapabilities(REMOTE, P_OFFER, TAVILY)).toEqual(ALL);
  });

  it('test_capabilities_other_kinds_unchanged', () => {
    const cases: [AISourceConfig | null, ServerOffer | null][] = [
      [null, null],
      [ANTHROPIC, null],
      [{ kind: 'on-device' }, null],
      [{ kind: 'on-device' }, P_OFFER],
      [SERVER, null],
      [SERVER, FREE_OFFER],
      [SERVER, P_OFFER],
    ];
    for (const [cfg, offer] of cases) {
      const before = sourceCapabilities(cfg, offer);
      for (const ws of [null, BRAVE, TAVILY]) expect(sourceCapabilities(cfg, offer, ws), cfg?.kind).toEqual(before);
    }
    expect(sourceCapabilities(ANTHROPIC, null, BRAVE)).toEqual(ALL);
    expect(sourceCapabilities({ kind: 'on-device' }, null, BRAVE)).toEqual(NONE);
    expect(sourceCapabilities(SERVER, null, BRAVE)).toEqual(NONE);
    expect(sourceCapabilities(SERVER, P_OFFER, BRAVE)).toEqual(ALL);
  });

  it('test_web_search_origin', () => {
    expect(webSearchOrigin('brave')).toBe('https://api.search.brave.com');
    expect(webSearchOrigin('tavily')).toBe('https://api.tavily.com');
  });

  it('test_factcheck_offered_openai_public_only', () => {
    const input: Input = {
      ...base(),
      device: { aiSource: OPENAI, labs: { factcheck: true, perspectives: false }, webSearch: null },
    };
    expect(factcheckOffered(input)).toBe(true);
    expect(factcheckOffered({ ...input, post: { platform: 'facebook', audience: 'friends' } })).toBe(false);
    const labsOff = { ...input.device, labs: { factcheck: false, perspectives: false } };
    expect(factcheckOffered({ ...input, device: labsOff })).toBe(false);
    const compatInput: Input = { ...input, device: { ...input.device, aiSource: REMOTE } };
    expect(factcheckOffered(compatInput)).toBe(false);
    expect(factcheckOffered({ ...compatInput, device: { ...compatInput.device, webSearch: BRAVE } })).toBe(true);
  });

  it('test_perspectives_offered_compat_with_key', () => {
    type PInput = Parameters<typeof perspectivesOffered>[0];
    const input: PInput = {
      device: { aiSource: REMOTE, labs: { factcheck: false, perspectives: true }, webSearch: null },
      post: { platform: 'facebook', audience: 'public', sharedLink: LINK },
      classification: { isNews: true },
      listReady: true,
    };
    expect(perspectivesOffered(input)).toBe(false);
    const withKey: PInput = { ...input, device: { ...input.device, webSearch: TAVILY } };
    expect(perspectivesOffered(withKey)).toBe(true);
    expect(perspectivesOffered({ ...withKey, listReady: false })).toBe(false);
    expect(perspectivesOffered({ ...withKey, post: { ...withKey.post, audience: 'friends' } })).toBe(false);
  });

  it('test_price_label_openai', () => {
    expect(jobPriceLabel('factcheck', OPENAI)).toBe('About $0.09 on your OpenAI account');
    expect(jobPriceLabel('perspectives', OPENAI)).toBe('About $0.10 on your OpenAI account');
    expect(factcheckPriceLabel(OPENAI, null, BRAVE)).toBe('About $0.09 on your OpenAI account');
  });

  it('test_price_label_compat_local_and_remote', () => {
    expect(jobPriceLabel('factcheck', LOCAL, null, BRAVE)).toBe('Free on this computer, plus up to 3 searches on your Brave key');
    expect(jobPriceLabel('perspectives', LOCAL, null, TAVILY)).toBe(
      'Free on this computer, plus up to 5 searches on your Tavily key',
    );
    expect(jobPriceLabel('perspectives', REMOTE, null, TAVILY)).toBe(
      "Your AI provider's usual price, plus up to 5 searches on your Tavily key",
    );
    expect(factcheckPriceLabel(REMOTE, null, BRAVE)).toBe(
      "Your AI provider's usual price, plus up to 3 searches on your Brave key",
    );
    expect(jobPriceLabel('factcheck', LOCAL)).toBeNull();
    expect(jobPriceLabel('perspectives', REMOTE, null, null)).toBeNull();
    expect(jobPriceLabel('factcheck', { kind: 'on-device' }, null, BRAVE)).toBeNull();
    expect(jobPriceLabel('factcheck', ANTHROPIC, null, BRAVE)).toBe('About $0.12 on your Anthropic account');
  });

  it('test_device_web_search_default_and_repair', () => {
    expect(defaultDevice('d').webSearch).toBeNull();
    const stored: Partial<Device> = { ...defaultDevice('d'), aiSource: REMOTE };
    delete stored.webSearch;
    expect(migrateDevice(stored, () => 'new').webSearch).toBeNull();
    expect(migrateDevice({ ...stored, webSearch: { provider: 'bing' } }, () => 'new').webSearch).toBeNull();
    const kept = migrateDevice({ ...stored, webSearch: TAVILY }, () => 'new');
    expect(kept.webSearch).toEqual(TAVILY);
    expect(kept.aiSource).toEqual(REMOTE);
  });
});
