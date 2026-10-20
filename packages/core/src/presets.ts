import { NOISE_LABELS, type NoiseLabel, type PlatformId } from '@unalgorithm/protocol';
import {
  type AiFilters,
  FILTER_KEYS,
  type FilterToggles,
  type PlatformSettings,
  type Preset,
  type PresetOrCustom,
} from './settings/schema.ts';

function noise(on: readonly NoiseLabel[]): AiFilters['noise'] {
  return Object.fromEntries(NOISE_LABELS.map((l) => [l, on.includes(l)])) as AiFilters['noise'];
}

/**
 * What each strength hides. Light: just the clutter. Balanced: what you did not ask for. Calm: only what matters.
 *
 * Every platform hides the same today. A new platform keeps "people and pages you don't follow" out of Balanced until
 * its detection passes the live accuracy check (docs/fixtures.md); Facebook's stayed out until settings version 2.
 * Turning it on later moves people still on the old Balanced with a settings migration (settings/migrate.ts).
 */
export function presetValues(_platform: PlatformId, preset: Preset): { filters: FilterToggles; ai: AiFilters } {
  switch (preset) {
    case 'light':
      return {
        filters: {
          sponsored: true,
          modules: true,
          suggested: false,
          networkActivity: false,
          unjoinedGroups: false,
          notFollowed: false,
          reels: false,
          reshares: false,
        },
        ai: { noise: noise([]), lowRelevance: false },
      };
    case 'balanced':
      return {
        filters: {
          sponsored: true,
          modules: true,
          suggested: true,
          networkActivity: true,
          unjoinedGroups: true,
          notFollowed: true,
          reels: false,
          reshares: false,
        },
        ai: { noise: noise(['engagement-bait', 'rage-bait', 'clickbait']), lowRelevance: false },
      };
    case 'calm':
      return {
        filters: {
          sponsored: true,
          modules: true,
          suggested: true,
          networkActivity: true,
          unjoinedGroups: true,
          notFollowed: true,
          reels: true,
          reshares: true,
        },
        ai: { noise: noise(NOISE_LABELS), lowRelevance: true },
      };
  }
}

/** The preset these toggles match exactly, or 'custom'. */
export function presetOf(platform: PlatformId, ps: Pick<PlatformSettings, 'filters' | 'ai'>): PresetOrCustom {
  for (const preset of ['balanced', 'light', 'calm'] as const) {
    const v = presetValues(platform, preset);
    const same =
      FILTER_KEYS.every((k) => v.filters[k] === ps.filters[k]) &&
      NOISE_LABELS.every((l) => v.ai.noise[l] === ps.ai.noise[l]) &&
      v.ai.lowRelevance === ps.ai.lowRelevance;
    if (same) return preset;
  }
  return 'custom';
}

/** Apply a preset to a platform, keeping everything that is not part of a preset (exceptions, on/off). */
export function applyPreset(platform: PlatformId, ps: PlatformSettings, preset: Preset): PlatformSettings {
  const v = presetValues(platform, preset);
  return {
    ...ps,
    preset,
    filters: { ...ps.filters, ...v.filters },
    ai: { ...ps.ai, lowRelevance: v.ai.lowRelevance, noise: { ...ps.ai.noise, ...v.ai.noise } },
  };
}

/** One sentence describing a preset, for the Strength control. The same on every platform. */
export function presetSummary(_platform: PlatformId, preset: PresetOrCustom): string {
  switch (preset) {
    case 'light':
      return 'Hides ads and feed panels like People You May Know. Everything else stays.';
    case 'balanced':
      return "Also hides suggested posts, activity from your network, groups you're not in and people you don't follow.";
    case 'calm':
      return 'Shows only people, pages and groups you follow, without Reels or reshares.';
    case 'custom':
      return 'Your own mix of filters.';
  }
}
