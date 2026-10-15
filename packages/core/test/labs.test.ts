import type { ServerInfo } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import {
  type AISourceConfig,
  type Device,
  defaultDevice,
  factcheckOffered,
  factcheckPriceLabel,
  migrateDevice,
  type PostData,
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
  device: { aiSource: ANTHROPIC, labs: { factcheck: true } },
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
      expect(caps.perspectives, kind).toBe(false);
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
      ['labs off', { ...b, device: { ...b.device, labs: { factcheck: false } } }],
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
const FREE_OFFER: ServerOffer = { origin: 'https://ai.example.org', billing: false, factcheck: true, factcheckPrice: null };
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
    });
    const info: ServerInfo = {
      ...CL4_INFO,
      billing: true,
      capabilities: { ...CL4_INFO.capabilities, factcheck: true },
      jobPrices: { factcheck: PRICE },
    };
    const offer = serverOfferFrom({ origin, info, needsSignIn: false });
    expect(offer).toEqual({ origin, billing: true, factcheck: true, factcheckPrice: PRICE });
    expect(Object.keys(offer ?? {}).sort()).toEqual(['billing', 'factcheck', 'factcheckPrice', 'origin']);
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
    const input: Input = { ...base(), device: { aiSource: SERVER, labs: { factcheck: true } }, serverOffer: PAID_OFFER };
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
