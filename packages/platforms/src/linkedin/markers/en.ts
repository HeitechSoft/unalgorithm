import type { LabelPattern } from '../../shared/labels.ts';

/**
 * Ad labels (ADR 0009 §9), read only in label positions: the age slot, header lines, actor lines and the accessible
 * names of header buttons, never post text. "Promoted", "Promoted by Acme" and "Promoted • Partnership with LinkedIn"
 * (an ad run as a person's post) are strong evidence; a new wording such as "Promoted • Brand content" is a near miss,
 * which still hides with the weak "no post age" evidence and is reported. "Promoted to Director" is a job change, and
 * a headline such as "Sponsored Products Manager at Amazon" is no near miss: one needs a separator after the head.
 */
const PROMOTED: LabelPattern = {
  id: 'promoted',
  heads: ['promoted', 'sponsored'],
  tails: ['by', 'partnership with'],
  notTails: ['to', 'as', 'at', 'in', 'from', 'on'],
  nearWords: 4,
  nearAfterSeparator: true,
};

/**
 * The "Suggested" header line, with the heads of the regex it replaces. "Popular in Toronto" and "Based on your
 * profile and activity" name a place or a reason after the head, so `in`, `on`, `profile` and `activity` are tails.
 */
const SUGGESTED: LabelPattern = {
  id: 'suggested',
  heads: ['suggested', 'suggested for you', 'recommended for you', 'popular', 'based on your'],
  tails: ['in', 'on', 'profile', 'activity'],
  nearWords: 3,
};

/** The Follow button's text ("Follow", "+ Follow"); "Following" is a different word, so it never matches. */
const FOLLOW: LabelPattern = { id: 'follow', heads: ['follow'], prefix: '+ ', nearWords: 0 };

/**
 * English text and aria-label markers for LinkedIn. To support another UI language, copy this file, translate
 * the patterns from a captured fixture in that language, and register it in `LINKEDIN_MARKERS` in `./index.ts`.
 */
export const LINKEDIN_EN = {
  /** Screen-reader heading at the top of every 2026 feed card. */
  cardHeading: /^feed post$/i,
  /** The post's own menu button: the most reliable author source in the 2026 feed. */
  authorMenuSelector: 'button[aria-label^="Open control menu for post by "], button[aria-label^="Hide post by "]',
  authorMenuPrefix: /^(open control menu for post by|hide post by)\s+/i,
  /** Tolerant label patterns (shared/labels.ts). The capture scripts' KEEP lists must hold every head and tail word. */
  labels: { promoted: PROMOTED, suggested: SUGGESTED, follow: FOLLOW },
  /**
   * "Jane Doe likes this", "Jane and 3 others celebrate this", "Jane Doe commented on this", "Jane follows Acme".
   * Anchored on "this" (or an object after "follows") so an author named "Max Likes" is not read as activity.
   * Read on header lines only.
   */
  activity:
    /^.+?\s(?:likes?|loves?|celebrates?|supports?|reacted to|commented on|replied to|was mentioned in|was tagged in|contributed to|voted (?:in|on))\s+this\b.*$|^.+?\sfinds? this (?:insightful|funny|curious|interesting|love)\b.*$|^.+?\s(?:follows?|is following)\s+\S.*$/i,
  /** "Followed by Jane Doe" (someone you know follows the author). Header lines only. */
  followedBy: /^followed by\b/i,
  /** "Jane Doe reposted this". Header lines only. */
  repost: /\sreposted( this)?$/i,
  degree: /\b(1st|2nd|3rd\+?)\b/,
  /** "• Following" in place of the degree, for people you follow without being connected to them. */
  followingBadge: /^•?\s*following$/i,
  /** The author's label then ends "… Following" instead of "… 2nd". */
  followingLabel: /\sfollowing\s*$/i,
  age: /^(\d+)\s*(s|m|min|mins|h|hr|hrs|d|w|mo|yr|y)\b/i,
  ageWord: /^(just now|today|yesterday)\b/i,
  ageDate: /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?\s*(?:•|$)/i,
  followAria: /^follow\b/i,
  groupLabel: /^view group:\s*(.+)$/i,
  groupLinkSelector: 'a[aria-label^="View group"]',
  joinButton: /^\+?\s*join$/i,
  joinAria: /^(join|request to join)\b/i,
  /** Action bar buttons: every real post has them, feed modules do not. */
  actionBarSelector:
    'button[aria-label="Comment"], [aria-label^="Reaction button state"], button[aria-label^="React Like"], button[aria-label="Repost"]',
  /**
   * One button of each post-level action bar (comments have Reply, never these), counted to find an item that holds
   * several posts.
   */
  postCommentSelector: 'button[aria-label="Comment"]',
  postRepostSelector: 'button[aria-label="Repost"]',
  /** Repost and Send: only a post's own action bar has them, so they anchor item discovery (comments have neither). */
  shareSelector: 'button[aria-label="Repost"], [aria-label="Send"], button[aria-label^="Send in a private message"]',
  /** Lines in the actor block that are buttons or links, not a headline. */
  notHeadline:
    /^(follow|\+ follow|following|join|connect|subscribe|visit my website|visit website|book an appointment|view my .+|promoted|edited)$/i,
  /** Titles of feed modules that are not posts. Event recommendations are intentionally not listed. */
  module:
    /^(people you may know|jobs recommended for you|recommended jobs|pages you may (like|be interested in)|groups you may like|newsletters? (you may like|for you)|recommended newsletters|add to your feed|today[’']s puzzles?|today[’']s games|play (today[’']s|the) games?|linkedin games|see who[’']s hiring)$/i,
  /** Words that only appear in English UI chrome, for the locale self-test. */
  chrome: /^(like|comment|repost|send)$/i,
};

export type LinkedInMarkers = typeof LINKEDIN_EN;
