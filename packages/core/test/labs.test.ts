import { describe, expect, it } from 'vitest';
import {
  type AISourceConfig,
  type Device,
  defaultDevice,
  factcheckOffered,
  factcheckPriceLabel,
  migrateDevice,
  type PostData,
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
