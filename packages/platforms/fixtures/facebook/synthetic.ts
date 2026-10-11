/**
 * SYNTHETIC Facebook feed items, modelled on the publicly known structure of Facebook's web feed (role="feed",
 * data-ad-* hooks, obfuscated "Sponsored" labels). They exercise every detector but are NOT captures of the live
 * site. Extend them with anonymized captures from scripts/capture/facebook.js before "people you don't follow" is
 * turned on by default for Facebook.
 */

let seq = 0;

export function fbFeed(...items: string[]): string {
  return `<div role="banner"></div>
<div role="main"><div><div role="feed">${items.join('\n')}</div></div></div>
<div role="complementary"><div><h3>Sponsored</h3><div><a href="https://l.facebook.com/l.php?u=https%3A%2F%2Fshop.example%2F">Ad</a></div></div><div><h3>Contacts</h3></div></div>
<div hidden><span id="lbl-sponsored"><span>Spon</span><span data-ua-hidden>q7z</span><span>sored</span></span>
<svg><defs><text id="svg-sponsored">Sponsored</text></defs></svg></div>`;
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
