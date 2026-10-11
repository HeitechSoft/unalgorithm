/**
 * English text markers for Facebook. Facebook obfuscates some labels (notably "Sponsored"), so markers are matched
 * against text normalized and rebuilt from visible characters, never against raw HTML.
 */
export const FACEBOOK_EN = {
  sponsored: /^sponsored$/i,
  paidPartnership: /^paid partnership\b/i,
  /** Header lines that mark a recommendation rather than something you follow. */
  suggestedHeader:
    /^(suggested for you|suggested post|suggested posts|recommended for you|suggested from .+|because you (follow|like|viewed) .+)$/i,
  /** "Jane Doe commented on this.", "Jane Doe reacted to Alex's post." */
  activity:
    /^.+?\s(?:commented on|reacted to|replied to|was tagged in|was mentioned in|likes?|loves?|is interested in|answered)\s+(?:this|a|an|.+?['’]s)\b.*$/i,
  reshare: /^.+?\sshared\s+(?:a|an|this|.+?['’]s)\s+(?:post|memory|reel|video|link|photo|event)\b.*$/i,
  follow: /^\+?\s*follow$/i,
  join: /^(join|join group|request to join)$/i,
  seeMore: /^see more$/i,
  ctaButtons:
    /^(shop now|learn more|sign up|book now|download|get offer|apply now|install now|contact us|send message|subscribe|watch more|order now|get quote|get directions|buy tickets|see menu|play game|use app|donate now|listen now)$/i,
  /** Headings of feed panels that are not posts. */
  modules: {
    'people-you-may-know': /^people you may know$/i,
    reels: /^(reels( and short videos)?|short videos)$/i,
    groups: /^(suggested groups|groups you may like|suggested for you in groups)$/i,
    pages: /^(suggested pages|pages you may like)$/i,
    stories: /^stories$/i,
    games: /^(games|instant games)$/i,
    promo: /^(marketplace|today'?s picks|events you may like)$/i,
  } as const,
  audience: {
    public: /^shared with public$/i,
    friends: /^shared with (your )?friends( of friends)?$/i,
    custom: /^shared with (custom|only me|.+)$/i,
  },
  /** Action-bar words, for the locale self-test. */
  chrome: /^(like|comment|share|send)$/i,
};

export type FacebookMarkers = typeof FACEBOOK_EN;
