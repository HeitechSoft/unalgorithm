import type { ServerInfo } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import {
  type AISourceConfig,
  type Device,
  defaultDevice,
  factcheckOffered,
  factcheckPriceLabel,
  jobPriceLabel,
  migrateDevice,
  type PostData,
  perspectivesOffered,
  type ServerOffer,
  serverOfferFrom,
  sourceCapabilities,
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
  device: { aiSource: ANTHROPIC, labs: { factcheck: true, perspectives: false } },
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
      expect(caps.perspectives, kind).toBe(kind === 'anthropic');
      expect(caps.classify, kind).toBe(true);
      expect(caps.factcheck, kind).toBe(kind === 'anthropic');
      expect(caps.webSearch, kind).toBe(kind === 'anthropic');
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
      ['openai source', { ...b, device: { ...b.device, aiSource: OPENAI } }],
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
    expect(factcheckPriceLabel(OPENAI)).toBeNull();
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
    expect(sourceCapabilities(OPENAI, FREE_OFFER).factcheck).toBe(false);
    expect(sourceCapabilities(ANTHROPIC, null).factcheck).toBe(true);
  });

  it('test_billing_server_needs_a_price', () => {
    expect(sourceCapabilities(SERVER, { ...PAID_OFFER, factcheckPrice: null }).factcheck).toBe(false);
    expect(sourceCapabilities(SERVER, PAID_OFFER).factcheck).toBe(true);
  });

  it('test_factcheck_offered_server_public_only', () => {
    const input: Input = {
      ...base(),
      device: { aiSource: SERVER, labs: { factcheck: true, perspectives: false } },
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
});

describe('Other perspectives', () => {
  const ORIGIN = 'https://ai.example.org';
  const P_PRICE = { typicalMicros: 270_000, maxMicros: 500_000 };
  const P_FREE: ServerOffer = { ...FREE_OFFER, factcheck: false, perspectives: true };
  const P_PAID: ServerOffer = { ...P_FREE, billing: true, perspectivesPrice: P_PRICE };
  const LINK = { url: 'https://news.example.com/a', domain: 'news.example.com' };

  type PInput = Parameters<typeof perspectivesOffered>[0];
  const pbase = (): PInput => ({
    device: { aiSource: ANTHROPIC, labs: { factcheck: false, perspectives: true } },
    post: { platform: 'linkedin', sharedLink: LINK },
    classification: { isNews: true },
    registryReady: true,
  });

  it('test_labs_perspectives_defaults_off_and_migrates', () => {
    expect(defaultDevice('d1').labs).toEqual({ factcheck: false, perspectives: false });
    const stored = { ...defaultDevice('d1'), labs: { factcheck: true } };
    expect(migrateDevice(stored, () => 'new').labs).toEqual({ factcheck: true, perspectives: false });
  });

  it('test_source_capabilities_perspectives', () => {
    expect(sourceCapabilities(ANTHROPIC).perspectives).toBe(true);
    expect(sourceCapabilities(null).perspectives).toBe(false);
    for (const kind of ['openai', 'openai-compatible', 'on-device']) {
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
    const server = { aiSource: SERVER, labs: { factcheck: false, perspectives: true } };
    expect(perspectivesOffered({ ...pbase(), device: server, serverOffer: P_PAID })).toBe(true);
  });

  it('test_perspectives_offered_each_gate', () => {
    const b = pbase();
    const server = { aiSource: SERVER, labs: { factcheck: false, perspectives: true } };
    const cases: [string, PInput][] = [
      ['flag off', { ...b, device: { ...b.device, labs: { factcheck: true, perspectives: false } } }],
      ['registry not ready', { ...b, registryReady: false }],
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
    expect(jobPriceLabel('perspectives', OPENAI)).toBeNull();
    expect(jobPriceLabel('perspectives', null)).toBeNull();
    expect(jobPriceLabel('perspectives', SERVER, PAID_OFFER)).toBeNull();
    expect(jobPriceLabel('factcheck', SERVER, P_PAID)).toBeNull();
    expect(jobPriceLabel('factcheck', ANTHROPIC)).toBe('About $0.12 on your Anthropic account');
  });
});
