import type { ModuleInfo } from '@unalgorithm/core';
import type { LabelPattern } from '../../shared/labels.ts';

/**
 * English text markers for Facebook. Facebook obfuscates some labels (notably "Sponsored"), so markers are matched
 * against text normalized and rebuilt from visible characters, never against raw HTML.
 *
 * Labels are `LabelPattern`s (shared/labels.ts), read only in label positions: a reworded label that keeps its head
 * ("Ad · Paid") still counts, as weaker evidence, and gets reported. Sentence markers stay regexes, read on header
 * lines only.
 */
export const FACEBOOK_EN = {
  labels: {
    /**
     * The ad label: "Sponsored", "Ad" since 2026, "Sponsored · Paid partnership". Up to two unknown words after it
     * ("Ad · Paid") make a near miss: medium evidence, which hides only together with the missing timestamp.
     */
    sponsored: { id: 'sponsored', heads: ['sponsored', 'ad'], tails: ['paid partnership'], nearWords: 2 },
    /** "Follow" and "+ Follow" (punctuation is ignored), never "Following". */
    follow: { id: 'follow', heads: ['follow'], nearWords: 0 },
    join: { id: 'join', heads: ['join', 'join group'], prefix: 'request to', nearWords: 0 },
  } satisfies Record<string, LabelPattern>,
  /** Branded content, read on header lines: "Paid partnership with Brand". */
  paidPartnership: /^paid partnership\b/i,
  /** Header lines that mark a recommendation rather than something you follow. */
  suggestedHeader:
    /^(suggested for you|suggested post|suggested posts|recommended for you|suggested from .+|because you (follow|like|viewed) .+)$/i,
  /** "Jane Doe commented on this.", "Jane Doe reacted to Alex's post." */
  activity:
    /^.+?\s(?:commented on|reacted to|replied to|was tagged in|was mentioned in|likes?|loves?|is interested in|answered)\s+(?:this|a|an|.+?['’]s)\b.*$/i,
  reshare: /^.+?\sshared\s+(?:a|an|this|.+?['’]s)\s+(?:post|memory|reel|video|link|photo|event)\b.*$/i,
  /** Ages without a digit in the slot where a post shows its age ("2h" and "October 5 at 3:00 PM" have digits). */
  ageWords: /\bago$|^(just now|now|yesterday|today)\b/i,
  seeMore: /^see more$/i,
  ctaButtons:
    /^(shop now|learn more|sign up|book now|download|get offer|apply now|install now|contact us|send message|subscribe|watch more|order now|get quote|get directions|buy tickets|see menu|play game|use app|donate now|listen now)$/i,
  /** Titles of feed panels that are not posts, matched exactly (or with a known tail) on the panel's first heading. */
  modules: {
    'people-you-may-know': { id: 'people-you-may-know', heads: ['people you may know'], nearWords: 0 },
    reels: { id: 'reels', heads: ['reels', 'short videos'], tails: ['and short videos'], nearWords: 0 },
    groups: {
      id: 'groups',
      heads: ['suggested groups', 'groups you may like', 'suggested for you in groups', 'your group suggestions'],
      nearWords: 0,
    },
    pages: { id: 'pages', heads: ['suggested pages', 'pages you may like'], nearWords: 0 },
    stories: { id: 'stories', heads: ['stories'], nearWords: 0 },
    games: { id: 'games', heads: ['games', 'instant games'], nearWords: 0 },
    promo: {
      id: 'promo',
      heads: ['marketplace', "today's picks", 'today’s picks', 'todays picks', 'events you may like'],
      nearWords: 0,
    },
  } satisfies Partial<Record<ModuleInfo['kind'], LabelPattern>>,
  audience: {
    public: /^shared with public$/i,
    friends: /^shared with (your |.+['’]s )?friends( of friends)?$/i,
    custom: /^shared with (custom|only me|.+)$/i,
  },
  /** Action-bar words, for the locale self-test. */
  chrome: /^(like|comment|share|send)$/i,
  /** The action bar's first button, when Facebook's own hook for it is missing. */
  like: /^like$/i,
};

export type FacebookMarkers = typeof FACEBOOK_EN;
