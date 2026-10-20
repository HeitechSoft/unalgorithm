/** Hooks Facebook renders for ads previews and the story layout; they also mark ordinary posts. */
export const FB_SEL = {
  feed: '[role="feed"]',
  post: '[aria-posinset]',
  message: '[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-ad-rendering-role="story_message"]',
  profileName: '[data-ad-rendering-role="profile_name"]',
  likeButton: '[data-ad-rendering-role="like_button"]',
  shareButton: '[data-ad-rendering-role="share_button"]',
  heading: 'h2, h3, h4',
  button: 'button, [role="button"]',
  permalink:
    'a[href*="/posts/"], a[href*="story_fbid="], a[href*="/permalink/"], a[href*="/reel/"], a[href*="/videos/"], a[href*="/photo"]',
  outboundLink: 'a[href*="l.facebook.com/l.php"], a[href^="https://l.facebook.com/"]',
  groupLink: 'a[href*="/groups/"]',
  audience: '[aria-label^="Shared with"], [title^="Shared with"]',
  /** Slots Facebook keeps but empties once they scroll far away. */
  virtualized: '[data-virtualized="true"]',
} as const;

export const FB_ORIGIN = 'https://www.facebook.com';

/** Hosts that serve the Facebook web app (the content script runs on www only; the others redirect there). */
export const FACEBOOK_HOSTS: ReadonlySet<string> = new Set(['facebook.com', 'www.facebook.com', 'web.facebook.com']);

/** Profile and page links (tags), not hashtags, groups, media, outbound or Facebook's own pages. */
export function isFacebookProfileHref(href: string): boolean {
  let u: URL;
  try {
    u = new URL(href, FB_ORIGIN);
  } catch {
    return false;
  }
  if (!/(^|\.)facebook\.com$/.test(u.hostname) || u.hostname.startsWith('l.')) return false;
  if (u.pathname === '/profile.php') return true;
  // Members tagged in group posts, and classic page URLs.
  if (/^\/groups\/[^/]+\/user\/[^/]+/.test(u.pathname) || /^\/pages\/[^/]+\/\d+/.test(u.pathname)) return true;
  const first = u.pathname.split('/').filter(Boolean)[0] ?? '';
  return (
    !!first &&
    !/^(hashtag|groups|events|watch|reel|reels|photo|photos|videos|stories|marketplace|gaming|ads|pages|help|policies|privacy|login|l\.php|share|sharer\.php)$/i.test(
      first,
    )
  );
}
