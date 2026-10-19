import {
  LEAN_BUCKETS,
  LIST_KINDS,
  MAX_OUTLET_DOMAINS,
  NOISE_LABELS,
  type NoticeKind,
  OutletDomainSchema,
  type PLATFORMS,
  type PlatformId,
} from '@unalgorithm/protocol';
import { z } from 'zod';
import { AISourceConfigSchema, WebSearchKeySchema } from '../ai-source.ts';

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

/**
 * One outlet of the person's own UnEcho Chamber list (decision D100); the map key is its id. No evidence: the lean is
 * the person's own call, which no one reviews.
 */
export const OwnOutletSchema = z.object({
  name: z.string().trim().min(1).max(120),
  domains: z.array(OutletDomainSchema).min(1).max(MAX_OUTLET_DOMAINS),
  /** null: listed without a lean, so never searched. */
  bucket: z.enum(LEAN_BUCKETS).nullable(),
  addedAt: z.number(),
});
export type OwnOutlet = z.infer<typeof OwnOutletSchema>;

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
  /**
   * UnEcho Chamber's source list: which list it uses, and the person's own (synced like the rest; the UnEcho Chamber
   * switch itself stays device-local, `device.labs.perspectives`). At most MAX_LIST_OUTLETS outlets in use: the editor
   * keeps to it, and a list over it is a list problem, never a broken setting.
   */
  perspectives: z.looseObject({
    /** Which list UnEcho Chamber uses (decision D100). */
    list: z.enum(LIST_KINDS),
    outlets: z.record(z.string(), OwnOutletSchema),
  }),
});
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * The Fact-check and UnEcho Chamber switches, per device (named `labs` from when they were Labs features; P3-64 kept
 * the name and values): never synced (DeviceSchema is never synced or exported).
 */
export const LabsSchema = z.looseObject({ factcheck: z.boolean(), perspectives: z.boolean() });
export type Labs = z.infer<typeof LabsSchema>;

/** A notice snooze's key: the platform and the notice kind, `linkedin:ads-through`. */
export type NoticeSnoozeKey = `${PlatformId}:${NoticeKind}`;
export const NoticeSnoozeKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}:[a-z][a-z0-9-]{0,39}$/);
export function noticeSnoozeKey(platform: PlatformId, kind: NoticeKind): NoticeSnoozeKey {
  return `${platform}:${kind}`;
}

/**
 * The in-feed breakage notices (ADR 0009 §3), per device: Settings → Display's "Tell me when something breaks", and
 * the snoozes *Not now* (24 hours) and a sent report (7 days) set. A snooze names the adapter version it was set under
 * and ends early when that changes. Device-local like everything here: shared by this browser's tabs, never synced.
 */
export const NoticePrefsSchema = z.looseObject({
  enabled: z.boolean(),
  snoozed: z.record(NoticeSnoozeKeySchema, z.looseObject({ until: z.number(), adapter: z.string().max(64) })),
});
export type NoticePrefs = z.infer<typeof NoticePrefsSchema>;

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
  /** The web search key this device uses with an OpenAI-compatible source (which provider; the key is a secret). */
  webSearch: WebSearchKeySchema.nullable(),
  notices: NoticePrefsSchema,
});
export type Device = z.infer<typeof DeviceSchema>;

export function highlightThreshold(amount: Settings['highlights']['amount']): number {
  return amount === 'fewer' ? 80 : amount === 'more' ? 60 : 70;
}

export function isPaused(device: Pick<Device, 'pausedUntil'>, platform: (typeof PLATFORMS)[number], now = Date.now()): boolean {
  const until = device.pausedUntil[platform];
  return until === 'manual' || (typeof until === 'number' && until > now);
}
