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

export const POST_ROOT_SELECTOR = [
  `[role="listitem"][componentkey^="${CARD_KEY_PREFIX}"]`,
  ...URN_ATTRIBUTES.flatMap((a) => URN_KINDS.map((k) => `[${a}^="${k}"]`)),
  '[data-view-name="feed-full-update"]',
].join(', ');

export const SEL = {
  header: '.update-components-header__text-view, .update-components-header, [data-view-name="feed-header-text"]',
  actorTitle: '.update-components-actor__title, .update-components-actor__name',
  actorDescription: '.update-components-actor__description',
  actorSubDescription: '.update-components-actor__sub-description',
  actorSupplementary: '.update-components-actor__supplementary-actor-info',
  actorLink: 'a.update-components-actor__meta-link, a.update-components-actor__image, a.update-components-actor__container-link',
  profileLink: 'a[href*="/in/"], a[href*="/company/"], a[href*="/school/"], a[href*="/showcase/"]',
  groupLink: 'a[href*="/groups/"]',
  text: '[data-testid="expandable-text-box"], .update-components-text, .feed-shared-update-v2__description, .feed-shared-inline-show-more-text, .feed-shared-text, [data-view-name="feed-commentary"]',
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
