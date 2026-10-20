/**
 * The links under a finished result (P3-69, decisions D88, D107; ADR 0009 §2): how the feature works, and *Report a
 * wrong verdict* / *Report a mistake*, which open the report page with a correction draft of technical facts only (the
 * feature, the result's prompt version, for UnEcho Chamber which list it used, and which AI made it). Never anything
 * from the post, the result or the person, and never a GitHub form. Also the answers each kind of report takes, and the
 * AI a report names. Outlets are fictional fixtures.
 */
import type { AISourceConfig } from '@unalgorithm/core';
import {
  CLOUD_ORIGIN,
  CORRECTION_CHOICES,
  type FactcheckResult,
  type PerspectivesResult,
  REPORT_CHOICES,
  REPORT_FROM,
  REPORT_KINDS,
} from '@unalgorithm/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  aiKindOf,
  choiceRequired,
  choicesFor,
  correctionDraft,
  correctionVia,
  type SheetLink,
  sheetLinks,
  singleChoice,
  validChoices,
} from '../src/lib/report-links.ts';
import type { FactcheckEntry } from '../src/lib/storage.ts';

const CHECKED_AT = '2026-10-14T09:30:00.000Z';

/** One marker per field that must never reach a link. No spaces, so `+` encoding can't hide one. */
const M = {
  label: 'zzLABELzz',
  claim: 'zzCLAIMzz',
  explanation: 'zzEXPLANATIONzz',
  quote: 'zzQUOTEzz',
  title: 'zzTITLEzz',
  url: 'zzURLzz',
  query: 'zzQUERYzz',
  storyUrl: 'zzSTORYzz',
  outlet: 'zzOUTLETzz',
  outletId: 'zzoutletidzz',
} as const;

function factcheckResult(overrides: Partial<FactcheckResult> = {}): FactcheckResult {
  return {
    v: 1,
    checkedAt: CHECKED_AT,
    model: 'claude-sonnet-5-5',
    promptVersion: 3,
    claims: [
      {
        id: 'c1',
        claim: `The bridge ${M.claim} opened in 1932.`,
        verdict: 'disputed',
        explanation: `Archives ${M.explanation} disagree.`,
        citations: [{ sourceId: 's1', quote: `Opened ${M.quote} in 1931.` }],
      },
    ],
    sources: [
      {
        id: 's1',
        url: `https://archive.example/${M.url}`,
        domain: 'archive.example',
        title: `Bridge ${M.title} history`,
        pageAge: null,
      },
    ],
    ...overrides,
  };
}

function perspectivesResult(overrides: Partial<PerspectivesResult> = {}): PerspectivesResult {
  return {
    v: 1,
    checkedAt: CHECKED_AT,
    model: 'claude-sonnet-5-5',
    promptVersion: 4,
    registryVersion: '57',
    list: 'cloud',
    story: {
      url: `https://story.example/${M.storyUrl}`,
      query: `Harbour bridge ${M.query} reopens`,
      from: '2026-10-09T00:00:00.000Z',
      to: '2026-10-15T00:00:00.000Z',
    },
    coverage: [
      { bucket: 'left', sourceIds: ['s1'] },
      { bucket: 'lean-left', sourceIds: [] },
      { bucket: 'center', sourceIds: ['s2'] },
      { bucket: 'lean-right', sourceIds: [] },
      { bucket: 'right', sourceIds: [] },
    ],
    agreed: [{ text: `Reopened ${M.claim} Monday.`, citations: [{ sourceId: 's1', quote: `Traffic ${M.quote} returned.` }] }],
    differences: [],
    unique: [],
    sources: [
      {
        id: 's1',
        url: `https://northwind.example/${M.url}`,
        domain: 'northwind.example',
        title: `Back ${M.title} in service`,
        pageAge: '2026-10-12T08:00:00.000Z',
        outletId: M.outletId,
        outlet: `Northwind ${M.outlet}`,
        bucket: 'left',
      },
      {
        id: 's2',
        url: `https://meridian.example/${M.url}`,
        domain: 'meridian.example',
        title: `Reopens ${M.title}`,
        pageAge: null,
        outletId: 'meridian-wire',
        outlet: 'Meridian Wire',
        bucket: 'center',
      },
    ],
    ...overrides,
  };
}

const factcheck = (overrides: Partial<FactcheckEntry> = {}): FactcheckEntry => ({
  key: 'li:1' as FactcheckEntry['key'],
  label: `A post ${M.label} about a bridge`,
  startedAt: Date.parse(CHECKED_AT),
  status: 'done',
  result: factcheckResult(),
  ...overrides,
});

const comparison = (overrides: Partial<FactcheckEntry> = {}): FactcheckEntry => ({
  key: 'li:2' as FactcheckEntry['key'],
  task: 'perspectives',
  label: `Harbour ${M.label} bridge`,
  startedAt: Date.parse(CHECKED_AT),
  status: 'done',
  perspectives: perspectivesResult(),
  listWarnings: ['No outlets in Right.'],
  ...overrides,
});

const ANTHROPIC: AISourceConfig = { kind: 'anthropic', model: null };
const CLOUD: AISourceConfig = { kind: 'server', baseUrl: CLOUD_ORIGIN };
const OWN_SERVER: AISourceConfig = { kind: 'server', baseUrl: 'https://ai.example.org' };

const hrefs = (links: SheetLink[]) => links.map((l) => ('href' in l ? l.href : null));

describe('sheet links', () => {
  it('test_correction_draft_carries_versions_only', () => {
    expect(correctionDraft(factcheck(), ANTHROPIC)).toStrictEqual({
      kind: 'correction',
      from: 'sidepanel',
      correction: { feature: 'factcheck', promptVersion: 3, via: 'own-key' },
    });
    expect(correctionDraft(comparison(), CLOUD)).toStrictEqual({
      kind: 'correction',
      from: 'sidepanel',
      correction: { feature: 'perspectives', promptVersion: 4, list: 'cloud', via: 'cloud' },
    });
    const own = correctionDraft(
      comparison({ perspectives: perspectivesResult({ list: 'own', registryVersion: '' }) }),
      OWN_SERVER,
    );
    expect(own?.correction).toStrictEqual({ feature: 'perspectives', promptVersion: 4, list: 'own', via: 'own-server' });
  });

  it('test_sheet_links_never_carry_result_or_post_text', () => {
    const entries = [
      factcheck(),
      comparison(),
      comparison({ perspectives: perspectivesResult({ list: 'own', registryVersion: '' }) }),
    ];
    const domains = [
      ...factcheckResult().sources.map((s) => s.domain),
      ...perspectivesResult().sources.map((s) => s.domain),
      'story.example',
    ];
    const forbidden = [...Object.values(M), CHECKED_AT, CHECKED_AT.slice(0, 10), ...domains, 'registryVersion', 'github.com'];
    for (const entry of entries) {
      const opened: unknown[] = [];
      const links = sheetLinks(entry, (draft) => opened.push(draft), CLOUD);
      expect(links).toHaveLength(2);
      const [how, report] = links as [SheetLink, SheetLink];
      expect('href' in how && new URL(how.href).protocol).toBe('https:');
      // The report is an action in the extension, never a link to a form.
      expect(report).not.toHaveProperty('href');
      if ('onSelect' in report) report.onSelect();
      expect(opened).toHaveLength(1);
      const sent = JSON.stringify([links.map((l) => l.text), hrefs(links), opened]);
      for (const marker of forbidden) expect(sent, `${entry.task ?? 'factcheck'} carries ${marker}`).not.toContain(marker);
    }
  });

  it('test_sheet_links_by_task_and_status', () => {
    const none = vi.fn();
    expect(sheetLinks(factcheck({ status: 'running', result: undefined }), none, null)).toStrictEqual([]);
    expect(sheetLinks(factcheck({ status: 'failed', result: undefined }), none, null)).toStrictEqual([]);
    expect(sheetLinks(factcheck({ status: 'done', result: undefined }), none, null)).toStrictEqual([]);
    expect(sheetLinks(comparison({ status: 'running', perspectives: undefined }), none, null)).toStrictEqual([]);
    expect(sheetLinks(comparison({ status: 'failed', perspectives: undefined }), none, null)).toStrictEqual([]);
    expect(sheetLinks(comparison({ status: 'done', perspectives: undefined }), none, null)).toStrictEqual([]);
    // A comparison never links from a fact-check result, nor the other way round.
    expect(sheetLinks(comparison({ result: factcheckResult(), perspectives: undefined }), none, null)).toStrictEqual([]);
    expect(sheetLinks(factcheck({ result: undefined, perspectives: perspectivesResult() }), none, null)).toStrictEqual([]);

    const fc = sheetLinks(factcheck(), none, ANTHROPIC);
    expect(fc.map((l) => l.text)).toStrictEqual(['How Fact-check works', 'Report a wrong verdict']);
    expect(hrefs(fc)).toStrictEqual(['https://unalgorithmfeed.com/methodology', null]);
    const pc = sheetLinks(comparison(), none, CLOUD);
    expect(pc.map((l) => l.text)).toStrictEqual(['How UnEcho Chamber works', 'Report a mistake']);
    expect(hrefs(pc)).toStrictEqual(['https://unalgorithmfeed.com/methodology', null]);
    expect(none).not.toHaveBeenCalled();
  });
});

describe('the AI a report names', () => {
  it('test_ai_kind_names_a_kind_only', () => {
    expect(aiKindOf(null)).toBe('off');
    expect(aiKindOf({ kind: 'on-device' })).toBe('on-device');
    expect(aiKindOf(ANTHROPIC)).toBe('own-key');
    expect(aiKindOf({ kind: 'openai', model: null })).toBe('own-key');
    expect(
      aiKindOf({ kind: 'openai-compatible', preset: 'ollama', baseUrl: 'http://localhost:11434/v1', auth: 'none', model: 'm' }),
    ).toBe('own-key');
    expect(aiKindOf(CLOUD)).toBe('cloud');
    expect(aiKindOf({ kind: 'server', baseUrl: `${CLOUD_ORIGIN}/` })).toBe('cloud');
    expect(aiKindOf(OWN_SERVER)).toBe('own-server');
    expect(aiKindOf({ kind: 'server', baseUrl: 'not a url' })).toBe('own-server');
    // A result being corrected was made by a sending source; with the source now off, the person's own key.
    expect(correctionVia(null)).toBe('own-key');
    expect(correctionVia({ kind: 'on-device' })).toBe('own-key');
    expect(correctionVia(CLOUD)).toBe('cloud');
  });
});

describe('answers each kind takes', () => {
  it('test_choices_by_kind', () => {
    for (const kind of REPORT_KINDS.filter((k) => k !== 'correction')) expect(choicesFor({ kind })).toBe(REPORT_CHOICES[kind]);
    expect(choicesFor({ kind: 'correction', correction: { feature: 'factcheck' } })).toBe(CORRECTION_CHOICES.factcheck);
    expect(choicesFor({ kind: 'correction', correction: { feature: 'perspectives' } })).toBe(CORRECTION_CHOICES.perspectives);
    expect(choicesFor({ kind: 'correction' })).toEqual([]);
    expect(REPORT_KINDS.filter(singleChoice)).toEqual(['wrong-call', 'correction', 'other']);
    // Required, except a detection report from the in-feed card or a tab that didn't answer.
    const optional = REPORT_KINDS.flatMap((kind) =>
      REPORT_FROM.filter((from) => !choiceRequired({ kind, from })).map((f) => `${kind}/${f}`),
    );
    expect(optional).toEqual(['detection/popup-no-script', 'detection/notice']);
  });

  it('test_valid_choices', () => {
    const detection = { kind: 'detection' as const, from: 'popup' };
    expect(validChoices(detection, ['ads-showing', 'page-broken'])).toBe(true);
    expect(validChoices(detection, [])).toBe(false);
    expect(validChoices({ ...detection, from: 'notice' }, [])).toBe(true);
    expect(validChoices(detection, ['ads-showing', 'ads-showing'])).toBe(false);
    expect(validChoices(detection, ['verdict-wrong'])).toBe(false);
    const wrongCall = { kind: 'wrong-call' as const, from: 'why' };
    expect(validChoices(wrongCall, ['should-show'])).toBe(true);
    expect(validChoices(wrongCall, ['should-show', 'wrong-reason'])).toBe(false);
    const correction = { kind: 'correction' as const, from: 'sidepanel', correction: { feature: 'perspectives' as const } };
    expect(validChoices(correction, ['outlet-wrong'])).toBe(true);
    expect(validChoices(correction, ['verdict-wrong'])).toBe(false);
  });
});
