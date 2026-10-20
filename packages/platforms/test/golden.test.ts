import { existsSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkAdapterContract } from '../src/testing/contract.ts';
import { GOLDEN_PRESETS, type GoldenResult, restoreCapture, runGolden } from '../src/testing/golden.ts';
import { expectPath, GOLDENS, type GoldenFile, readExpect } from './golden/goldens.ts';

/**
 * Golden captures (ADR 0009 §9, phase C): each page in test/golden/goldens.ts, read the way the feed controller reads
 * it, must give exactly what its `*.expect.json` says: every row's decision on Light, Balanced and Calm, the post ids
 * (stable across a second read), health at 20 s of visible time, the discovery strategy, the route facts, and the ids
 * it emits. After a deliberate change, rewrite the files with `GOLDEN_UPDATE=1` and review the diff.
 */
const UPDATE = process.env.GOLDEN_UPDATE === '1';

/** biome's line width, so a rewritten expect file is already formatted as `pnpm lint` wants it. */
const LINE_WIDTH = 130;

/**
 * JSON as biome formats it: objects one key per line, arrays of plain values on one line when they fit (with the text
 * before them and a trailing comma), otherwise one item per line.
 */
function formatJson(value: unknown, indent = '', lead = 0): string {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    const flat = `[${value.map((v) => formatJson(v, inner)).join(', ')}]`;
    if (value.every((v) => v === null || typeof v !== 'object') && lead + flat.length + 1 <= LINE_WIDTH) return flat;
    return `[\n${value.map((v) => inner + formatJson(v, inner, inner.length)).join(',\n')}\n${indent}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    const lines = entries.map(([k, v]) => {
      const key = `${inner}${JSON.stringify(k)}: `;
      return key + formatJson(v, inner, key.length);
    });
    return `{\n${lines.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

/** The part of an expect file the page must give (its setup and notes are for reading it). */
const resultOf = ({ setup: _setup, notes: _notes, ...result }: GoldenFile): GoldenResult => result;

// jsdom reads the 300 KB LinkedIn captures slowly, more so while other suites run: the timeout is about the machine.
describe('golden pages', { timeout: 60_000 }, () => {
  it.each(GOLDENS.map((g) => [g.name, g] as const))('%s gives what its expect file says', (name, golden) => {
    if (!existsSync(expectPath(name))) throw new Error(`${name}: no expect file; write its setup and run with GOLDEN_UPDATE=1`);
    const file = readExpect(name);
    const result = runGolden(golden.adapter, golden.html, file.setup);
    if (UPDATE) {
      const rows = result.decisions.balanced.length;
      const notes = Array.from({ length: rows }, (_, i) => file.notes?.[i] ?? '');
      writeFileSync(expectPath(name), `${formatJson({ setup: file.setup, notes, ...result })}\n`);
      return;
    }
    expect(result).toEqual(resultOf(file));
    expect(file.notes).toHaveLength(result.decisions.balanced.length);
  });

  it('every golden reads its ids the same twice, and no adapter call throws', () => {
    for (const { name } of GOLDENS) {
      const file = readExpect(name);
      expect([name, file.idsStable, file.errors]).toEqual([name, true, {}]);
      for (const preset of GOLDEN_PRESETS) expect(file.decisions[preset]).toHaveLength(file.ids.length);
    }
  });

  it.each(GOLDENS.map((g) => [g.name, g] as const))('%s keeps the adapter contract', (name, golden) => {
    const html = restoreCapture(golden.html, readExpect(name).setup);
    expect(checkAdapterContract(golden.adapter, html)).toEqual([]);
  });
});

describe('golden expectations carried over from the capture tests', () => {
  it('the LinkedIn "For you" captures decide as the live page showed, on Balanced', () => {
    const tally = (rows: readonly string[]) =>
      rows.reduce<Record<string, number>>((n, r) => {
        const decision = r.split('/')[0] as string;
        n[decision] = (n[decision] ?? 0) + 1;
        return n;
      }, {});
    // The counts behind capture-2026-10.test.ts's per-item lists.
    expect(tally(readExpect('linkedin/2026-10-foryou-1').decisions.balanced)).toEqual({
      '-': 5,
      show: 8,
      sponsored: 6,
      'network-activity': 6,
      panel: 2,
      'not-followed': 1,
    });
    expect(tally(readExpect('linkedin/2026-10-foryou-2').decisions.light)).toEqual({ '-': 5, sponsored: 7, panel: 3, show: 17 });
  });

  it("the nine Facebook captures give the live session's 17 of 17; the whole page, every capture's rows", () => {
    const rows = (name: RegExp) => GOLDENS.filter((g) => name.test(g.name)).flatMap((g) => readExpect(g.name).decisions.balanced);
    const nine = rows(/^facebook\/2026-10-home-\d$/);
    expect(nine.filter((r) => r !== '-')).toHaveLength(17);
    // The reel items from later loads: two reels shared with no words of the poster's own stay, the Reels panel folds.
    const reels = rows(/^facebook\/2026-10-reels-\d$/);
    expect(reels).toEqual(['show/unknown', 'show/unknown', 'panel']);
    expect(readExpect('facebook/2026-10-home').decisions.balanced).toEqual([...nine, ...reels]);
  });
});
