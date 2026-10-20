/**
 * Language-independent LinkedIn selectors. Each lookup lists class-based selectors first (precise when LinkedIn
 * still renders them) and structural hooks (roles, data-testid, component keys, link patterns) that survive the
 * hashed class names of the 2026 layout. English text and aria-label markers live in `markers/en.ts`.
 */

/** Matches post URNs but not comment URNs like urn:li:comment:(activity:...). */
export const POST_URN_RE = /urn:li:(?:activity|ugcPost|share|aggregate):[\w-]+/;

export const URN_ATTRIBUTES = ['data-urn', 'data-id', 'data-activity-urn'] as const;
const URN_KINDS = ['urn:li:activity:', 'urn:li:ugcPost:', 'urn:li:share:', 'urn:li:aggregate:'];

/** 2026 feed: each post card is a list item keyed by a stable, opaque component key. */
export const CARD_KEY_PREFIX = 'update-card-focus';
/** The "For you" feed ends each card key with the feed's sort, e.g. "FeedType_MAIN_FEED_RELEVANCE". */
export const FEED_TYPE_SUFFIX = /FeedType_[A-Z_]+$/;

export const POST_ROOT_SELECTOR = [
  `[role="listitem"][componentkey^="${CARD_KEY_PREFIX}"]`,
  ...URN_ATTRIBUTES.flatMap((a) => URN_KINDS.map((k) => `[${a}^="${k}"]`)),
  '[data-view-name="feed-full-update"]',
].join(', ');

/** A "For you" card key ends with the main feed's sort: only the home feed has it (ADR 0009 §3, home signature). */
export const MAIN_FEED_KEY = /FeedType_MAIN_FEED_[A-Z_]+$/;

export const SEL = {
  /** The header line's class (older layout) and LinkedIn's data hook for it: the first two locators of the header slot. */
  headerClass: '.update-components-header__text-view, .update-components-header',
  headerHook: '[data-view-name="feed-header-text"]',
  /** The author's block (older layout). */
  actorBlock: '.update-components-actor',
  actorTitle: '.update-components-actor__title, .update-components-actor__name',
  actorDescription: '.update-components-actor__description',
  actorSubDescription: '.update-components-actor__sub-description',
  actorSupplementary: '.update-components-actor__supplementary-actor-info',
  actorLink: 'a.update-components-actor__meta-link, a.update-components-actor__image, a.update-components-actor__container-link',
  profileLink: 'a[href*="/in/"], a[href*="/company/"], a[href*="/school/"], a[href*="/showcase/"]',
  groupLink: 'a[href*="/groups/"]',
  text: '[data-testid="expandable-text-box"], .update-components-text, .feed-shared-update-v2__description, .feed-shared-inline-show-more-text, .feed-shared-text, [data-view-name="feed-commentary"]',
  /** The text box by class name (older layout), then by LinkedIn's data hooks (2026): the text slot's first locators. */
  textClass:
    '.update-components-text, .feed-shared-update-v2__description, .feed-shared-inline-show-more-text, .feed-shared-text',
  textHook: '[data-testid="expandable-text-box"], [data-view-name="feed-commentary"]',
  /** The action bar by class name (older layout). */
  actionBarClass: '.feed-shared-social-action-bar',
  expander: '[data-testid="expandable-text-button"], .feed-shared-inline-show-more-text__see-more-less-toggle',
  reactionsCount: '.social-details-social-counts__reactions-count, [data-view-name="feed-reaction-count"]',
  eventLink: 'a[href*="linkedin.com/events/"], a[href^="/events/"]',
  video: 'video, .update-components-linkedin-video',
  document: '.update-components-document, .document-s-container',
  poll: '.update-components-poll',
  article: '.update-components-article, a[href*="/pulse/"]',
  image: '.update-components-image, .update-components-image__image',
  commentsArea: '[data-testid*="commentList"], .comments-comments-list, .comments-comment-item, [class*="comments-comment"]',
  /** The main feed list; its last child is LinkedIn's empty "load more" marker (see shared/keep-loading.ts). */
  feedList: '[data-testid="mainFeed"]',
} as const;
