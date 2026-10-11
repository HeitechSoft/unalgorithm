import { type Classification, NOISE_LABELS, type PlatformId } from '@unalgorithm/protocol';
import { findKeyword } from './keywords.ts';
import { adjustRelevance, type LearnedPrefs } from './learn.ts';
import type { ModuleInfo, PostData } from './post.ts';
import type { FilterDecision } from './reasons.ts';
import { authorKey, type DegradedSignals, moduleFilter, ruleFilter } from './rules.ts';
import { highlightThreshold, type Settings } from './settings/schema.ts';

export type FeedItem = { kind: 'post'; post: PostData } | { kind: 'module'; platform: PlatformId; module: ModuleInfo };

export interface Highlight {
  source: 'ai' | 'keywords' | 'feedback';
  relevance?: number;
  /** Interest labels or keywords that matched, for the "For you" row. */
  matched: string[];
}

export interface Decision {
  filter: FilterDecision | null;
  highlight: Highlight | null;
  /** Relevance after learned topic weights, when AI classified the post. */
  adjustedRelevance?: number;
}

export interface DecideInput {
  item: FeedItem;
  settings: Settings;
  classification?: Classification;
  /** False when the AI source is off, paused or failing: AI-only filters are skipped (rules still apply). */
  aiActive: boolean;
  learned?: LearnedPrefs;
  /** The user's explicit vote on this exact post. */
  vote?: 'more' | 'less';
  degraded?: DegradedSignals;
}

const NO_DECISION: Decision = { filter: null, highlight: null };

function topicMatch(text: string, topics: Settings['interests']['more']): { label: string; keyword: string } | undefined {
  for (const t of Object.values(topics)) {
    const keyword = findKeyword(text, [t.label, ...t.keywords]);
    if (keyword) return { label: t.label, keyword };
  }
  return undefined;
}

/**
 * The single place that decides what happens to a feed item. Order: feed panels, the user's own vote and lists,
 * page rules, muted words, then AI. Highlights ("For you") only go to items that are shown.
 */
export function decide(input: DecideInput): Decision {
  const { item, settings } = input;
  if (item.kind === 'module') {
    const ps = settings.platforms[item.platform];
    return { filter: ps.enabled ? moduleFilter(item.module, ps) : null, highlight: null };
  }
  const { post } = item;
  const ps = settings.platforms[post.platform];
  if (!ps.enabled) return NO_DECISION;

  if (input.vote === 'less') return { filter: { reason: 'less-like-this', source: 'user' }, highlight: null };

  const rule = ruleFilter(post, ps, input.degraded);
  if (rule) return { filter: rule, highlight: null };
  const pinned = Object.values(ps.alwaysShow).some((r) => r.match === authorKey(post));

  if (!pinned) {
    const muteWords = Object.values(settings.interests.muteWords).map((k) => k.label);
    const muted = muteWords.length ? findKeyword(post.text, muteWords) : undefined;
    if (muted) return { filter: { reason: 'muted-keyword', source: 'user', keyword: muted }, highlight: null };
    const less = topicMatch(post.text, settings.interests.less);
    if (less) {
      return {
        filter: { reason: 'muted-keyword', source: 'user', keyword: less.keyword, topic: less.label },
        highlight: null,
      };
    }
  }

  const c = input.classification;
  const learned = settings.ai.learnFromFeedback ? input.learned?.weights : undefined;
  const adjusted = c ? adjustRelevance(c.relevance, c.topics, learned ?? {}) : undefined;

  if (c && input.aiActive && !pinned) {
    const noise = c.noise.filter((l) => ps.ai.noise[l]);
    if (noise.length) {
      const ordered = NOISE_LABELS.filter((l) => noise.includes(l));
      return { filter: { reason: 'noise', source: 'ai', noise: ordered }, highlight: null, adjustedRelevance: adjusted };
    }
    if (ps.ai.lowRelevance && adjusted !== undefined && adjusted < settings.ai.relevanceCutoff && input.vote !== 'more') {
      return { filter: { reason: 'low-relevance', source: 'ai' }, highlight: null, adjustedRelevance: adjusted };
    }
  }

  return { filter: null, highlight: highlightFor(post, settings, c, adjusted, input.vote), adjustedRelevance: adjusted };
}

function highlightFor(
  post: PostData,
  settings: Settings,
  c: Classification | undefined,
  adjusted: number | undefined,
  vote: DecideInput['vote'],
): Highlight | null {
  if (!settings.highlights.enabled || settings.display.forYou === 'off') return null;
  if (vote === 'more') return { source: 'feedback', matched: [] };
  const words = Object.values(settings.interests.highlightWords).map((k) => k.label);
  const word = words.length ? findKeyword(post.text, words) : undefined;
  if (word) return { source: 'keywords', matched: [word] };
  if (c && adjusted !== undefined) {
    return adjusted >= highlightThreshold(settings.highlights.amount)
      ? { source: 'ai', relevance: adjusted, matched: c.topics }
      : null;
  }
  const topic = topicMatch(post.text, settings.interests.more);
  return topic ? { source: 'keywords', matched: [topic.label] } : null;
}
