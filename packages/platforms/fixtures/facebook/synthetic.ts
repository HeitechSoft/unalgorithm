/**
 * SYNTHETIC Facebook feed items, modelled on the publicly known structure of Facebook's web feed (role="feed",
 * data-ad-* hooks, obfuscated "Sponsored" labels). They exercise every detector but are NOT captures of the live
 * site. Extend them with anonymized captures from scripts/capture/facebook.js before "people you don't follow" is
 * turned on by default for Facebook.
 */

let seq = 0;

/**
 * Facebook's top bar when signed in: the Home tab (marked current on the feed) and links to the app's sections, then
 * the account controls. `current: null` is any other page.
 */
export function fbBanner(current: 'home' | null = 'home'): string {
  return `<div role="banner"><div><a aria-label="Facebook" href="/" role="link"><svg></svg></a><input type="search" aria-label="Search Facebook"></div>
<div role="navigation" aria-label="Facebook"><ul>
<li><a aria-label="Home" href="/" role="link"${current === 'home' ? ' aria-current="page"' : ''}><svg></svg></a></li>
<li><a aria-label="Video" href="/watch/?ref=tab" role="link"><svg></svg></a></li>
<li><a aria-label="Marketplace" href="/marketplace/?ref=app_tab" role="link"><svg></svg></a></li>
<li><a aria-label="Groups" href="/groups/feed/" role="link"><svg></svg></a></li>
</ul></div>
<div role="navigation" aria-label="Account controls and settings"><div aria-label="Your profile" role="button" tabindex="0"><svg></svg></div></div></div>`;
}

/**
 * Facebook while signed out: the login page, which also links to Marketplace and Groups (in its footer, not in a
 * navigation landmark). Its cookie wall and checkpoints are the same kind of page: no feed, and no reason to report.
 */
export function fbLoggedOut(): string {
  return `<div><div><h2>Connect with friends and the world around you on Facebook.</h2></div>
<div><form action="/login/?privacy_mutation_token=x" method="post"><input type="text" name="email" placeholder="Email or phone number"><input type="password" name="pass" placeholder="Password"><button name="login" type="submit">Log in</button></form>
<a href="/recover/initiate/">Forgot password?</a><a href="/r.php" role="button">Create new account</a></div></div>
<footer><ul><li><a href="/marketplace/">Marketplace</a></li><li><a href="/watch/">Video</a></li><li><a href="/groups/explore/">Groups</a></li></ul></footer>`;
}

/** A security checkpoint: a logo in a banner and a form, no navigation and no feed. */
export function fbCheckpoint(): string {
  return `<div role="banner"><a aria-label="Facebook" href="/" role="link"><svg></svg></a></div>
<div role="main"><h2>Confirm it's you</h2><form action="/checkpoint/?next" method="post"><button type="submit">Continue</button></form></div>`;
}

const RAIL_AND_LABELS = `<div role="complementary"><div><h3>Sponsored</h3><div><a href="https://l.facebook.com/l.php?u=https%3A%2F%2Fshop.example%2F">Ad</a></div></div><div><h3>Contacts</h3></div></div>
<div hidden><span id="lbl-sponsored"><span>Spon</span><span data-ua-hidden>q7z</span><span>sored</span></span>
<span id="lbl-ad">Ad</span><span id="lbl-time">6 hours ago</span>
<svg><defs><text id="svg-sponsored">Sponsored</text></defs></svg></div>`;

export function fbFeed(...items: string[]): string {
  return `${fbBanner()}
<div role="main"><div><div role="feed">${items.join('\n')}</div></div></div>
${RAIL_AND_LABELS}`;
}

/**
 * The 2026 home feed as seen on the live site (October 2026): no role="feed". Screen-reader headings label each
 * section of the main column; the feed list is the unlabelled block after "Feed posts" (and a spacer). Items far
 * from the viewport are emptied or left as virtualized placeholders until they scroll back.
 */
export function fbFeed2026(...items: string[]): string {
  return `${fbBanner()}
<div role="main"><div><div>
  <div><h3>Create a post</h3><div><div role="button"><span>What's on your mind?</span></div></div></div>
  <div><h3>Stories</h3><div><a href="https://www.facebook.com/stories/123/"><span>Story</span></a></div></div>
  <div><h3>Feed posts</h3><div aria-hidden="true"></div><div>${items.join('\n')}</div></div>
</div></div></div>
${RAIL_AND_LABELS}`;
}

interface HeaderOpts {
  author: string;
  href?: string;
  context?: string;
  follow?: boolean;
  join?: boolean;
  group?: string;
  sponsored?: 'aria' | 'labelledby' | 'split' | 'svg' | 'adlink';
  permalink?: string | null;
  audience?: 'Public' | 'Friends';
}

function header(o: HeaderOpts): string {
  const sponsored =
    o.sponsored === 'aria'
      ? '<a aria-label="Sponsored" href="#" role="link"><span></span></a>'
      : o.sponsored === 'labelledby'
        ? '<span><span aria-labelledby="lbl-sponsored"></span></span>'
        : o.sponsored === 'split'
          ? '<span><span>S</span><span data-ua-hidden>x</span><span>pon</span><span data-ua-hidden>q</span><span>sored</span></span>'
          : o.sponsored === 'svg'
            ? '<span><svg><use href="#svg-sponsored"></use></svg></span>'
            : o.sponsored === 'adlink'
              ? '<a href="https://www.facebook.com/ads/about/?entry_product=ad_preferences"><span>·</span></a>'
              : '';
  const permalink =
    o.permalink === null
      ? ''
      : `<a href="${o.permalink ?? `https://www.facebook.com/someone/posts/${1000 + ++seq}`}" role="link"><span>2h</span></a>`;
  return `<div>
  ${o.context ? `<div><span dir="auto">${o.context}</span></div>` : ''}
  <div data-ad-rendering-role="profile_name"><h4><span><a href="${o.href ?? `https://www.facebook.com/${o.author.toLowerCase().replace(/\s+/g, '.')}`}" role="link"><strong><span>${o.author}</span></strong></a></span></h4></div>
  ${o.group ? `<a href="https://www.facebook.com/groups/${o.group.toLowerCase().replace(/\s+/g, '')}/" role="link"><span>${o.group}</span></a>` : ''}
  <div>${permalink}${sponsored}<span aria-label="Shared with ${o.audience ?? 'Public'}" role="img"></span></div>
  ${o.follow ? '<div role="button" tabindex="0"><span>Follow</span></div>' : ''}
  ${o.join ? '<div role="button" tabindex="0" aria-label="Join group"><span>Join</span></div>' : ''}
</div>`;
}

function message(text: string, seeMore = false): string {
  return `<div data-ad-preview="message"><div dir="auto">${text}${seeMore ? '… <div role="button" tabindex="0">See more</div>' : ''}</div></div>`;
}

function actions(): string {
  return '<div><div role="button" aria-label="Like"><span>Like</span></div><div role="button" aria-label="Comment"><span>Comment</span></div><div role="button" aria-label="Share"><span>Share</span></div></div>';
}

function item(inner: string): string {
  return `<div><div><div aria-posinset="${++seq}" aria-describedby="d${seq}"><div>${inner}</div></div></div></div>`;
}

export const FRIEND_POST = item(
  header({ author: 'Riley Chen', audience: 'Friends', permalink: 'https://www.facebook.com/riley.chen/posts/pfbid0aBcD123' }) +
    message('Our garden finally produced tomatoes this year. Twelve of them, to be exact.') +
    actions(),
);

export const SUGGESTED_PAGE_POST = item(
  header({ author: 'Gadget Daily', context: 'Suggested for you', follow: true }) +
    message('You will not believe what this phone can do. Comment YES if you want one.') +
    actions(),
);

export const SPONSORED_ARIA = item(
  header({ author: 'Shop Example', sponsored: 'aria', permalink: null }) + message('New autumn collection is here.') + actions(),
);
export const SPONSORED_LABELLEDBY = item(
  header({ author: 'Shop Example', sponsored: 'labelledby', permalink: null }) + message('Free shipping this week.') + actions(),
);
export const SPONSORED_SPLIT = item(
  header({ author: 'Shop Example', sponsored: 'split', permalink: null }) + message('Try it free for 30 days.') + actions(),
);
export const SPONSORED_SVG = item(
  header({ author: 'Shop Example', sponsored: 'svg', permalink: null }) + message('Limited time offer.') + actions(),
);
export const SPONSORED_ADLINK = item(
  header({ author: 'Shop Example', sponsored: 'adlink', permalink: null }) + message('See the new range.') + actions(),
);

/** An organic link share with a "Learn more" button: CTA alone must never hide it. */
export const ORGANIC_LINK_SHARE = item(
  header({ author: 'Sam Ortiz', permalink: 'https://www.facebook.com/sam.ortiz/posts/555' }) +
    message('Interesting read on city transit funding.') +
    '<a href="https://l.facebook.com/l.php?u=https%3A%2F%2Fnews.example.com%2Ftransit%3Futm_source%3Dfb&amp;h=AT0"><span>news.example.com</span><span>City approves new transit budget</span></a><div role="button"><span>Learn more</span></div>' +
    actions(),
);

export const FRIEND_ACTIVITY = item(
  header({
    author: 'Policy Watch',
    context: 'Jamie Park commented on this.',
    permalink: 'https://www.facebook.com/policywatch/posts/777',
  }) +
    message('The new zoning rules take effect next month.') +
    actions(),
);

export const UNJOINED_GROUP_POST = item(
  header({
    author: 'Alex Kim',
    group: 'Hiking Ontario',
    join: true,
    permalink: 'https://www.facebook.com/groups/hikingontario/permalink/8888/',
  }) +
    message('Trail report: the falls are stunning right now.') +
    actions(),
);

export const JOINED_GROUP_POST = item(
  header({
    author: 'Alex Kim',
    group: 'Hiking Ontario',
    permalink: 'https://www.facebook.com/groups/hikingontario/permalink/9999/',
  }) +
    message('Meetup this Saturday at 9.') +
    actions(),
);

/** A friend sharing a stranger's post: the stranger's Follow button belongs to the nested post. */
export const FRIEND_RESHARE = item(
  header({ author: 'Riley Chen', permalink: 'https://www.facebook.com/riley.chen/posts/4444', audience: 'Friends' }) +
    message('This made me laugh.') +
    `<div><div data-ad-rendering-role="profile_name"><h4><a href="https://www.facebook.com/funny.page"><span>Funny Page</span></a></h4></div><div role="button"><span>Follow</span></div><div dir="auto">A cat that thinks it is a dog.</div></div>` +
    actions(),
);

export const TRUNCATED_POST = item(
  header({ author: 'Morgan Lee', permalink: 'https://www.facebook.com/morgan.lee/posts/321' }) +
    message('Long thoughts on parenting teenagers in a world of phones. Where to begin', true) +
    actions(),
);

export const REELS_TRAY = `<div><div><h3><span>Reels and short videos</span></h3><a href="https://www.facebook.com/reel/111"><span>Reel</span></a><a href="https://www.facebook.com/reel/222"><span>Reel</span></a></div></div>`;
export const PYMK = `<div><div><h3><span>People you may know</span></h3><div role="button"><span>Add friend</span></div></div></div>`;
export const SKELETON = `<div><div aria-busy="true"><div></div></div></div>`;

/**
 * A 2026 feed item: the post sits several wrappers down, its timestamp (or "Ad" label) is an aria-labelledby span in
 * a link that points at "/" until hovered, and the audience is an SVG title. Photo posts link each photo up front.
 */
function item2026(o: {
  author: string;
  label: 'ad' | 'time';
  audience: string;
  text: string;
  follow?: boolean;
  photo?: string;
}): string {
  const n = ++seq;
  return `<div><div><span><div><div><div aria-posinset="${n}"><div><div data-virtualized="false"><div>
  <div><a aria-label="${o.author}" href="https://www.facebook.com/${o.author.toLowerCase().replace(/\s+/g, '.')}" role="link"><svg role="img" aria-label="${o.author}"></svg></a></div>
  <div data-ad-rendering-role="profile_name"><h4><span><span><div><a href="https://www.facebook.com/${o.author.toLowerCase().replace(/\s+/g, '.')}?__cft__[0]=AZ" role="link"><b><span>${o.author}</span></b></a></div></span></span>${o.follow ? '<span><span><span></span><span>·</span></span><span><div role="button" tabindex="0"><span>Follow</span></div></span></span>' : ''}</h4></div>
  <div><a href="https://www.facebook.com/?__cft__[0]=AZ&amp;__tn__=%2CO%2CP-R" role="link" target="_blank"><span><span aria-labelledby="lbl-${o.label}"></span></span></a>
  <span> · </span><svg role="img" title="Shared with ${o.audience}"></svg></div>
  <div data-ad-rendering-role="story_message"><div data-ad-comet-preview="message" data-ad-preview="message"><div dir="auto">${o.text}</div></div></div>
  ${o.photo ? `<div><a href="https://www.facebook.com/photo/?fbid=${o.photo}&amp;set=a.${o.photo}0&amp;__cft__[0]=AZ&amp;__tn__=EH-R" role="link"><img alt="" src="https://scontent.example/p.jpg" width="500"></a></div>` : ''}
  ${actions()}
</div></div></div></div></div></div></span></div></div>`;
}

export const FRIEND_POST_2026 = item2026({
  author: 'Riley Chen',
  label: 'time',
  audience: "Riley's friends",
  text: 'Our garden finally produced tomatoes this year.',
});
export const AD_2026 = item2026({ author: 'Shop Example', label: 'ad', audience: 'Public', text: 'New autumn collection.' });
export const FOLLOW_PAGE_2026 = item2026({
  author: 'Gadget Daily',
  label: 'time',
  audience: 'Public',
  text: 'You will not believe what this phone can do.',
  follow: true,
});
export const PHOTO_POST_2026 = item2026({
  author: 'Morgan Lee',
  label: 'time',
  audience: 'Public',
  text: 'First snow on the ridge.',
  photo: '2026101601',
});
/** Scrolled far away: Facebook keeps the slot and the post marker but drops the content. */
export const VIRTUALIZED_2026 = `<div><div><span><div><div><div aria-posinset="${++seq}"><div><div data-virtualized="true"><div hidden=""></div></div></div></div></div></div></span></div></div>`;
/** Scrolled further away: an empty slot. */
export const EMPTIED_2026 = '<div></div>';
