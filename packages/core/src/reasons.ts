import type { NoiseLabel, PlatformId } from '@unalgorithm/protocol';
import type { ModuleInfo } from './post.ts';

/** Why a feed item is hidden. */
export type RuleReason =
  | 'sponsored'
  | 'suggested'
  | 'network-activity'
  | 'reshare'
  | 'unjoined-group'
  | 'reel'
  | 'not-followed'
  | 'module';
export type UserReason = 'always-hide' | 'muted-keyword' | 'less-like-this';
export type AiReason = 'noise' | 'low-relevance';
export type FilterReason = RuleReason | UserReason | AiReason;

export interface FilterDecision {
  reason: FilterReason;
  /** Who made the call: a page rule, the user's own lists/feedback, or AI (AI decisions are always labelled). */
  source: 'rule' | 'user' | 'ai';
  noise?: NoiseLabel[];
  /** Matched keyword for muted-keyword, and the topic it belongs to. */
  keyword?: string;
  topic?: string;
  module?: ModuleInfo;
}

const NOISE_NAMES: Record<NoiseLabel, string> = {
  'engagement-bait': 'Engagement bait',
  'rage-bait': 'Rage bait',
  clickbait: 'Clickbait',
  promotional: 'Promotional',
  'low-effort': 'Low effort',
};

export function noiseName(label: NoiseLabel): string {
  return NOISE_NAMES[label];
}

/** Short chip label, in the platform's own wording where it has one ("Promoted" on LinkedIn, "Sponsored" on Facebook). */
export function reasonLabel(d: FilterDecision, platform: PlatformId): string {
  const fb = platform === 'facebook';
  switch (d.reason) {
    case 'sponsored':
      return fb ? 'Sponsored' : 'Promoted';
    case 'suggested':
      return fb ? 'Suggested for you' : 'Suggested';
    case 'network-activity':
      return fb ? 'Friend activity' : 'Activity';
    case 'reshare':
      return fb ? 'Share' : 'Repost';
    case 'unjoined-group':
      return 'Group';
    case 'reel':
      return 'Reels';
    case 'not-followed':
      return 'Not followed';
    case 'module':
      return d.module?.title || 'Feed panel';
    case 'always-hide':
      return 'Hidden by you';
    case 'muted-keyword':
      return d.topic ? `Muted: ${d.topic}` : `Muted: ${d.keyword ?? 'keyword'}`;
    case 'less-like-this':
      return 'Less like this';
    case 'noise':
      return d.noise?.[0] ? noiseName(d.noise[0]) : 'Noise';
    case 'low-relevance':
      return 'Off-topic';
  }
}

/** Stable grouping key for stats ("12 Suggested, 9 Promoted"). */
export function reasonKey(d: FilterDecision): string {
  return d.reason === 'noise' && d.noise?.[0] ? `noise:${d.noise[0]}` : d.reason;
}
