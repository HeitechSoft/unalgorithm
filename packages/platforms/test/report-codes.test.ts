import {
  DETECTOR_IDS,
  LANDMARK_KEYS,
  OBSERVATION_IDS,
  PLATFORM_PREFIX,
  type PlatformId,
  platformIds,
  SLOT_LOCATORS,
  SLOT_NAMES,
  STRATEGY_IDS,
} from '@unalgorithm/protocol';
import { beforeAll, describe, expect, it } from 'vitest';
import { facebookAdapter } from '../src/facebook/adapter.ts';
import { linkedinAdapter } from '../src/linkedin/adapter.ts';
import { judgeGolden, loadGolden, mountGolden, readGoldenPage } from '../src/testing/golden.ts';
import { MUTATIONS, runMutation } from '../src/testing/mutate.ts';
import type { AdapterIds, PlatformAdapter } from '../src/types.ts';
import { GOLDENS, readExpect } from './golden/goldens.ts';

/**
 * The code registry against the adapters (ADR 0009 §4). The Cloud stores only ids the registry lists, so an adapter
 * may emit nothing else; and an id the registry lists but nothing emits is either kept for a reason written here or
 * dead weight in every report's allow-list.
 *
 * What is emitted is read from the golden pages' expect files (golden.test.ts keeps them true) and from the mutation
 * suite run on the pages built from the builders, which are quick to read: a fallback strategy or a near-miss label
 * only shows when the markup changes.
 */
const ADAPTERS: ReadonlyArray<[PlatformId, PlatformAdapter]> = [
  ['linkedin', linkedinAdapter as PlatformAdapter],
  ['facebook', facebookAdapter as PlatformAdapter],
];

/** Registry ids no golden page or mutation emits, each with the reason it is kept. */
const RESERVED: Readonly<Record<string, string>> = {
  'li.promoted.line': 'linkedin@2026.10 and older: an ad label anywhere in the first 16 lines, removed for false positives',
  'li.promoted.text': 'linkedin@2026.10 and older: an ad label in any text node, removed for false positives',
  'li.promoted.header': '"Promoted" as a header line above the author: in the unit tests, on no captured page yet',
  'li.label.suggested.near': 'a reworded "Suggested" header: in the unit tests, on no captured page yet',
  'li.item.multi-post':
    'the guard for an item holding two posts: card keys keep LinkedIn items whole under every mutation (discover.test.ts)',
  'fb.item.multi-post':
    'the guard for an item holding several posts: on a whole page another strategy separates them first (discovery.test.ts)',
  'li.slot.header.testid': "LinkedIn's data hook for the header line: older markup, on no captured page",
  'fb.sponsored.paid-partnership': '"Paid partnership" on a header line: in the unit tests, on no captured page yet',
  'fb.sponsored.header': '"Sponsored" as a header button\'s name: in the unit tests, on no captured page yet',
  'fb.label.suggested.near': 'Facebook\'s "Suggested" header stays a sentence pattern, so it has no near miss',
  'fb.offscreen': 'counted by the feed controller from pending results with offscreen set, not emitted by inspect',
  'fb.slot.header-buttons.structure': 'header buttons that lost their role: in the unit tests (labels.test.ts) only',
  composer: 'a route-check landmark no probe returns yet',
};

/** Slot × locator pairs an adapter doesn't have: the registry lists them all, so a new locator needs no registry change. */
function slotReserve(ids: AdapterIds, platform: PlatformId): string[] {
  const prefix = PLATFORM_PREFIX[platform];
  return SLOT_NAMES.flatMap((slot) => SLOT_LOCATORS.map((loc) => `${prefix}.slot.${slot}.${loc}`)).filter(
    (id) => !ids.observations.includes(id),
  );
}

interface Seen {
  detectors: Set<string>;
  observations: Set<string>;
  strategies: Set<string>;
}

const seen: Record<PlatformId, Seen> = {
  linkedin: { detectors: new Set(), observations: new Set(), strategies: new Set() },
  facebook: { detectors: new Set(), observations: new Set(), strategies: new Set() },
};

function note(
  platform: PlatformId,
  result: { emitted: { detectors: object; observations: object }; discovery: { strategy: string } | null },
) {
  for (const id of Object.keys(result.emitted.detectors)) seen[platform].detectors.add(id);
  for (const id of Object.keys(result.emitted.observations)) seen[platform].observations.add(id);
  if (result.discovery) seen[platform].strategies.add(result.discovery.strategy);
}

describe('the protocol registry and the adapters', { timeout: 60_000 }, () => {
  beforeAll(() => {
    for (const golden of GOLDENS) note(golden.adapter.id, readExpect(golden.name));
    // Markup and label mutations of the small pages: false-positive probes must change nothing, and a route move reads
    // nothing new.
    const mutations = MUTATIONS.filter((m) => m.group === 'markup' || m.group === 'label');
    for (const golden of GOLDENS.filter((g) => g.html.length < 100_000 && !readExpect(g.name).setup.slice)) {
      const { setup } = readExpect(golden.name);
      const template = loadGolden(golden.html, setup);
      const mounted = mountGolden(template, setup);
      const read = readGoldenPage(golden.adapter, setup);
      const before = judgeGolden(golden.adapter, setup, mounted, read);
      for (const m of mutations) {
        const run = runMutation({ adapter: golden.adapter, setup, template, before, unchanged: { mounted, read } }, m);
        if (run.after) note(golden.adapter.id, run.after);
      }
    }
    // As in mutation.test.ts: jsdom is slow on the Windows runner, so the timeout is about the machine, not the code.
  }, 180_000);

  it.each(ADAPTERS)("%s: the adapter's ids are all in the registry", (platform, adapter) => {
    const ids = adapter.ids as AdapterIds;
    expect(platformIds(DETECTOR_IDS, platform)).toEqual(expect.arrayContaining([...ids.detectors]));
    expect(platformIds(OBSERVATION_IDS, platform)).toEqual(expect.arrayContaining([...ids.observations]));
    // Every strategy of the platform, cheapest first, as the registry orders them.
    expect([...ids.strategies]).toEqual(platformIds(STRATEGY_IDS, platform));
    expect(LANDMARK_KEYS).toEqual(expect.arrayContaining([...ids.landmarks]));
  });

  it.each(ADAPTERS)('%s: emits only ids it declares', (platform, adapter) => {
    const ids = adapter.ids as AdapterIds;
    expect([...seen[platform].detectors].filter((id) => !ids.detectors.includes(id))).toEqual([]);
    expect([...seen[platform].observations].filter((id) => !ids.observations.includes(id))).toEqual([]);
    expect([...seen[platform].strategies].filter((id) => !ids.strategies.includes(id))).toEqual([]);
  });

  it.each(ADAPTERS)('%s: every registry id is emitted by a golden page or a mutation, or reserved', (platform, adapter) => {
    const reserved = new Set([...Object.keys(RESERVED), ...slotReserve(adapter.ids as AdapterIds, platform)]);
    const missing = (registry: readonly string[], emitted: Set<string>) =>
      platformIds(registry, platform).filter((id) => !emitted.has(id) && !reserved.has(id));
    expect(missing(DETECTOR_IDS, seen[platform].detectors)).toEqual([]);
    expect(missing(OBSERVATION_IDS, seen[platform].observations)).toEqual([]);
    expect(missing(STRATEGY_IDS, seen[platform].strategies)).toEqual([]);
  });

  it('every landmark key is returned by some adapter, or reserved', () => {
    const returned = new Set(ADAPTERS.flatMap(([, a]) => [...(a.ids as AdapterIds).landmarks]));
    expect(LANDMARK_KEYS.filter((k) => !returned.has(k) && !(k in RESERVED))).toEqual([]);
  });

  it('a reserved id is in the registry and is really never emitted, so the list stays true', () => {
    const registry = new Set<string>([...DETECTOR_IDS, ...OBSERVATION_IDS, ...STRATEGY_IDS, ...LANDMARK_KEYS]);
    const returned = new Set(ADAPTERS.flatMap(([, a]) => [...(a.ids as AdapterIds).landmarks]));
    for (const id of Object.keys(RESERVED)) {
      expect(registry.has(id), id).toBe(true);
      const all = [
        ...seen.linkedin.detectors,
        ...seen.linkedin.observations,
        ...seen.facebook.detectors,
        ...seen.facebook.observations,
      ];
      expect(all.includes(id) || returned.has(id), `${id} is emitted: take it off the reserved list`).toBe(false);
    }
  });
});
