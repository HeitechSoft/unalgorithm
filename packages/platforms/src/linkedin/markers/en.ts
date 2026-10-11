/**
 * English text and aria-label markers for LinkedIn. To support another UI language, copy this file, translate
 * the patterns from a captured fixture in that language, and register it in `MARKERS` in `../adapter.ts`.
 */
export const LINKEDIN_EN = {
  /** Screen-reader heading at the top of every 2026 feed card. */
  cardHeading: /^feed post$/i,
  /** The post's own menu button: the most reliable author source in the 2026 feed. */
  authorMenuSelector: 'button[aria-label^="Open control menu for post by "], button[aria-label^="Hide post by "]',
  authorMenuPrefix: /^(open control menu for post by|hide post by)\s+/i,
  promoted: /^(promoted|sponsored)(\s+by\b.*)?$/i,
  suggested: /^(suggested|suggested for you|recommended for you|popular (in|on) .+|based on your (profile|activity).*)$/i,
  /**
   * "Jane Doe likes this", "Jane and 3 others celebrate this", "Jane Doe commented on this", "Jane follows Acme".
   * Anchored on "this" (or an object after "follows") so an author named "Max Likes" is not read as activity.
   */
  activity:
    /^.+?\s(?:likes?|loves?|celebrates?|supports?|reacted to|commented on|replied to|was mentioned in|was tagged in|contributed to|voted (?:in|on))\s+this\b.*$|^.+?\sfinds? this (?:insightful|funny|curious|interesting|love)\b.*$|^.+?\s(?:follows?|is following)\s+\S.*$/i,
  /** "Followed by Jane Doe" (someone you know follows the author). */
  followedBy: /^followed by\b/i,
  repost: /\sreposted( this)?$/i,
  degree: /\b(1st|2nd|3rd\+?)\b/,
  age: /^(\d+)\s*(s|m|min|mins|h|hr|hrs|d|w|mo|yr|y)\b/i,
  ageWord: /^(just now|today|yesterday)\b/i,
  ageDate: /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?\s*(?:•|$)/i,
  followButton: /^\+?\s*follow$/i,
  followAria: /^follow\b/i,
  groupLabel: /^view group:\s*(.+)$/i,
  groupLinkSelector: 'a[aria-label^="View group"]',
  joinButton: /^\+?\s*join$/i,
  joinAria: /^(join|request to join)\b/i,
  /** Action bar buttons: every real post has them, feed modules do not. */
  actionBarSelector:
    'button[aria-label="Comment"], [aria-label^="Reaction button state"], button[aria-label^="React Like"], button[aria-label="Repost"]',
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
