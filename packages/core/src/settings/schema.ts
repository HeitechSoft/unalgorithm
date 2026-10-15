import { NOISE_LABELS, type PLATFORMS } from '@unalgorithm/protocol';
import { z } from 'zod';
import { AISourceConfigSchema } from '../ai-source.ts';

/**
 * Synced settings (Phase 2 syncs them field by field). Objects are "loose" so a field written by a newer
 * version survives an older one reading and saving it. User-edited lists are maps keyed by stable ids so two
 * devices can add entries at the same time without overwriting each other.
 */
export const SETTINGS_VERSION = 1;

export const PRESETS = ['light', 'balanced', 'calm'] as const;
export type Preset = (typeof PRESETS)[number];
export type PresetOrCustom = Preset | 'custom';

export const FilterTogglesSchema = z.looseObject({
  sponsored: z.boolean(),
  suggested: z.boolean(),
  networkActivity: z.boolean(),
  reshares: z.boolean(),
  notFollowed: z.boolean(),
  unjoinedGroups: z.boolean(),
  reels: z.boolean(),
  modules: z.boolean(),
});
export type FilterToggles = z.infer<typeof FilterTogglesSchema>;
export const FILTER_KEYS = [
  'sponsored',
  'suggested',
  'networkActivity',
  'reshares',
  'notFollowed',
  'unjoinedGroups',
  'reels',
  'modules',
] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

const noiseShape = Object.fromEntries(NOISE_LABELS.map((l) => [l, z.boolean()])) as Record<
  (typeof NOISE_LABELS)[number],
  z.ZodBoolean
>;

export const AiFiltersSchema = z.looseObject({
  noise: z.looseObject(noiseShape),
  /** Hide posts the AI rates below the relevance cutoff ("off-topic"). */
  lowRelevance: z.boolean(),
});
export type AiFilters = z.infer<typeof AiFiltersSchema>;

/** An author the user always shows or always hides. `match` is from `authorKey()`. */
export const PersonRuleSchema = z.object({
  label: z.string().max(120),
  match: z.string().max(300),
  addedAt: z.number(),
});
export type PersonRule = z.infer<typeof PersonRuleSchema>;

export const PlatformSettingsSchema = z.looseObject({
  enabled: z.boolean(),
  preset: z.enum([...PRESETS, 'custom']),
  filters: FilterTogglesSchema,
  ai: AiFiltersSchema,
  alwaysShow: z.record(z.string(), PersonRuleSchema),
  alwaysHide: z.record(z.string(), PersonRuleSchema),
});
export type PlatformSettings = z.infer<typeof PlatformSettingsSchema>;

export const TopicSchema = z.object({
  label: z.string().trim().min(1).max(40),
  /** Whole-word, case-insensitive matches used when AI is off (and as a hint when it is on). */
  keywords: z.array(z.string().trim().min(1).max(40)).max(40),
  addedAt: z.number(),
});
export type Topic = z.infer<typeof TopicSchema>;

export const KeywordSchema = z.object({ label: z.string().trim().min(1).max(60), addedAt: z.number() });
export type Keyword = z.infer<typeof KeywordSchema>;

export const DISPLAY_MODES = ['collapse', 'hide', 'dim'] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];

export const SettingsSchema = z.looseObject({
  version: z.literal(SETTINGS_VERSION),
  platforms: z.looseObject({
    linkedin: PlatformSettingsSchema,
    facebook: PlatformSettingsSchema,
  } satisfies Record<(typeof PLATFORMS)[number], typeof PlatformSettingsSchema>),
  display: z.looseObject({
    mode: z.enum(DISPLAY_MODES),
    showReason: z.boolean(),
    showAuthor: z.boolean(),
    /** Merge hidden posts that sit next to each other into one line ("3 hidden"). */
    groupRuns: z.boolean(),
    forYou: z.enum(['ring', 'label', 'off']),
    badgeCount: z.boolean(),
    tips: z.boolean(),
  }),
  interests: z.looseObject({
    more: z.record(z.string(), TopicSchema),
    less: z.record(z.string(), TopicSchema),
    about: z.string().max(500),
    highlightWords: z.record(z.string(), KeywordSchema),
    muteWords: z.record(z.string(), KeywordSchema),
  }),
  highlights: z.looseObject({
    enabled: z.boolean(),
    amount: z.enum(['fewer', 'standard', 'more']),
  }),
  ai: z.looseObject({
    /** Below this relevance a post counts as off-topic. */
    relevanceCutoff: z.number().int().min(0).max(100),
    /** Posts per day for sources that cost money (your key, Cloud). Local sources are uncapped. */
    dailyCap: z.number().int().min(0).max(5000),
    redactMentions: z.boolean(),
    learnFromFeedback: z.boolean(),
  }),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Experimental features, per device: Labs flags are never synced (DeviceSchema is never synced or exported). */
export const LabsSchema = z.looseObject({ factcheck: z.boolean() });
export type Labs = z.infer<typeof LabsSchema>;

/** Device-local state, never synced or exported. */
export const DeviceSchema = z.looseObject({
  version: z.literal(1),
  deviceId: z.string(),
  aiSource: AISourceConfigSchema.nullable(),
  onboarding: z.looseObject({
    completedAt: z.number().nullable(),
    step: z.string().nullable(),
    setupBannerDismissed: z.boolean(),
    coachMarkShown: z.looseObject({ linkedin: z.boolean(), facebook: z.boolean() }),
  }),
  /** Per-site pause: null = running, a timestamp = paused until then, 'manual' = paused until turned back on. */
  pausedUntil: z.looseObject({
    linkedin: z.union([z.null(), z.number(), z.literal('manual')]),
    facebook: z.union([z.null(), z.number(), z.literal('manual')]),
  }),
  dev: z.looseObject({ debugOverlay: z.boolean() }),
  labs: LabsSchema,
});
export type Device = z.infer<typeof DeviceSchema>;

export function highlightThreshold(amount: Settings['highlights']['amount']): number {
  return amount === 'fewer' ? 80 : amount === 'more' ? 60 : 70;
}

export function isPaused(device: Pick<Device, 'pausedUntil'>, platform: (typeof PLATFORMS)[number], now = Date.now()): boolean {
  const until = device.pausedUntil[platform];
  return until === 'manual' || (typeof until === 'number' && until > now);
}
