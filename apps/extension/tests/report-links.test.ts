/**
 * The links under a finished result (P3-69, decisions D88, D107): how the feature works, and the correction form on
 * GitHub prefilled with technical facts only (the feature's name, the extension's version, the result's prompt version
 * and, for UnEcho Chamber, which list it used). Never anything from the post, the result or the person. Outlets are
 * fictional fixtures.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FactcheckResult, PerspectivesResult } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import { correctionUrl, LIST_OPTIONS, sheetLinks } from '../src/lib/report-links.ts';
import type { FactcheckEntry } from '../src/lib/storage.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string) => readFileSync(join(REPO_ROOT, file), 'utf8').replace(/\r\n/g, '\n');

const CHECKED_AT = '2026-10-14T09:30:00.000Z';
const VERSION = '0.3.0';

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

/** A URL's query as an object, failing on a repeated key. */
function queryOf(href: string): Record<string, string> {
  const params = new URL(href).searchParams;
  const keys = [...params.keys()];
  expect(new Set(keys).size).toBe(keys.length);
  return Object.fromEntries(params);
}

describe('report links', () => {
  it('test_correction_url_carries_versions_only', () => {
    const fc = new URL(correctionUrl({ task: 'factcheck', extensionVersion: VERSION, promptVersion: 2 }));
    expect(fc.origin).toBe('https://github.com');
    expect(fc.pathname).toBe('/HeitechSoft/unalgorithm/issues/new');
    expect(fc.hash).toBe('');
    expect(queryOf(fc.href)).toStrictEqual({
      template: 'correction.yml',
      feature: 'Fact-check',
      version: VERSION,
      prompt: '2',
    });

    const own = new URL(correctionUrl({ task: 'perspectives', extensionVersion: VERSION, promptVersion: 5, list: 'own' }));
    expect(own.origin).toBe('https://github.com');
    expect(own.pathname).toBe('/HeitechSoft/unalgorithm/issues/new');
    expect(queryOf(own.href)).toStrictEqual({
      template: 'correction.yml',
      feature: 'UnEcho Chamber',
      version: VERSION,
      prompt: '5',
      list: 'My own list',
    });

    const cloud = correctionUrl({ task: 'perspectives', extensionVersion: VERSION, promptVersion: 5, list: 'cloud' });
    expect(queryOf(cloud).list).toBe("UnAlgorithm Cloud's list");
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
    const forbidden = [...Object.values(M), CHECKED_AT, CHECKED_AT.slice(0, 10), ...domains];
    for (const entry of entries) {
      const links = sheetLinks(entry, VERSION);
      expect(links).toHaveLength(2);
      for (const link of links) {
        const decoded = decodeURIComponent(link.href);
        for (const marker of forbidden) {
          expect(decoded, `${link.text} carries ${marker}`).not.toContain(marker);
          expect(link.text).not.toContain(marker);
        }
        expect(decoded).not.toContain('registryVersion');
        expect(new URL(link.href).protocol).toBe('https:');
      }
    }
  });

  it('test_sheet_links_by_task_and_status', () => {
    expect(sheetLinks(factcheck({ status: 'running', result: undefined }), VERSION)).toStrictEqual([]);
    expect(sheetLinks(factcheck({ status: 'failed', result: undefined }), VERSION)).toStrictEqual([]);
    expect(sheetLinks(factcheck({ status: 'done', result: undefined }), VERSION)).toStrictEqual([]);
    expect(sheetLinks(comparison({ status: 'running', perspectives: undefined }), VERSION)).toStrictEqual([]);
    expect(sheetLinks(comparison({ status: 'failed', perspectives: undefined }), VERSION)).toStrictEqual([]);
    expect(sheetLinks(comparison({ status: 'done', perspectives: undefined }), VERSION)).toStrictEqual([]);
    // A comparison never links from a fact-check result, nor the other way round.
    expect(sheetLinks(comparison({ result: factcheckResult(), perspectives: undefined }), VERSION)).toStrictEqual([]);
    expect(sheetLinks(factcheck({ result: undefined, perspectives: perspectivesResult() }), VERSION)).toStrictEqual([]);

    expect(sheetLinks(factcheck(), VERSION)).toStrictEqual([
      { text: 'How Fact-check works', href: 'https://unalgorithmfeed.com/methodology' },
      {
        text: 'Report a wrong verdict',
        href: correctionUrl({ task: 'factcheck', extensionVersion: VERSION, promptVersion: 3 }),
      },
    ]);
    expect(sheetLinks(comparison(), VERSION)).toStrictEqual([
      { text: 'How UnEcho Chamber works', href: 'https://unalgorithmfeed.com/methodology' },
      {
        text: 'Report a mistake',
        href: correctionUrl({ task: 'perspectives', extensionVersion: VERSION, promptVersion: 4, list: 'cloud' }),
      },
    ]);
    const own = sheetLinks(comparison({ perspectives: perspectivesResult({ list: 'own', registryVersion: '' }) }), VERSION);
    expect(queryOf(own[1]!.href).list).toBe('My own list');
  });

  it('test_prefilled_keys_are_form_fields', () => {
    const form = read('.github/ISSUE_TEMPLATE/correction.yml');
    const ids = [...form.matchAll(/^\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
    expect(ids).toEqual(expect.arrayContaining(['feature', 'version', 'prompt', 'list']));

    const listBlock = form.slice(form.search(/^\s*id:\s*list\s*$/m)).split(/^\s*- type:/m)[0] as string;
    const optionsBlock = listBlock.slice(listBlock.search(/^\s*options:\s*$/m)).split(/^\s*validations:/m)[0] as string;
    const options = [...optionsBlock.matchAll(/^\s*- (.+?)\s*$/gm)].map((m) => m[1]);
    expect(options).toStrictEqual(Object.values(LIST_OPTIONS));

    const featureBlock = form.slice(form.search(/^\s*id:\s*feature\s*$/m)).split(/^\s*- type:/m)[0] as string;
    const features = [...featureBlock.matchAll(/^\s+- (.+?)\s*$/gm)].map((m) => m[1]);

    for (const href of [
      ...sheetLinks(factcheck(), VERSION),
      ...sheetLinks(comparison(), VERSION),
      ...sheetLinks(comparison({ perspectives: perspectivesResult({ list: 'own', registryVersion: '' }) }), VERSION),
    ]
      .map((l) => l.href)
      .filter((h) => h.includes('/issues/new'))) {
      const query = queryOf(href);
      expect(query.template).toBe('correction.yml');
      for (const key of Object.keys(query).filter((k) => k !== 'template')) expect(ids).toContain(key);
      expect(features).toContain(query.feature);
      if (query.list) expect(options).toContain(query.list);
    }
  });
});
