import { fbBanner } from './synthetic.ts';

/**
 * SYNTHETIC builders for the 2026 home feed as anonymized captures of the live site showed it (October 2026), with
 * invented names and text: every item opens with off-screen aria-hidden filler, the age (or "Ad") after the author's
 * name is SVG text, the message box is wrapped in a div[dir=auto], the action bar carries Facebook's data-ad hooks,
 * and panels have their title behind the filler. The captures themselves are 2026-10-home-*.html.
 */

let n = 0;

/** Off-screen blocks of one word each (distinct words, so they would crowd out real header lines). */
export function filler(count = 11): string {
  return Array.from(
    { length: count },
    (_, i) =>
      `<div aria-hidden="true"><blockquote><span dir="auto"><span>Pinecone${String.fromCharCode(97 + (i % 26))}</span></span></blockquote><div aria-hidden="true" role="button" tabindex="-1"></div></div>`,
  ).join('');
}

/** What the link after the author's name holds: SVG text (ids in LABELS). */
export const svgText = (id: string, attr: 'href' | 'xlink:href' = 'xlink:href') =>
  `<span><span><svg><use ${attr}="#${id}"></use></svg></span></span>`;
export const labelledBy = (id: string) => `<span><span aria-labelledby="${id}"></span></span>`;
/** One character per span, each followed by U+034F. */
export const perCharacter = (text: string) =>
  `<span><span>${[...text].map((c) => `<span>${c}\u034F</span>`).join('')}</span></span>`;

/** The texts SVG labels point at: an age, "Ad", "Sponsored", and reworded ad labels. */
export const LABELS = `<div hidden><svg><text id="SvgT1">9 hours ago</text><text id="SvgT2">Ad</text><text id="SvgT3">Sponsored</text>
<text id="SvgT4">Ad · Paid</text><text id="SvgT5">Sponsored · Paid partnership with Shop Example</text><text id="SvgT6">Promoted</text>
<text id="SvgT7">about an hour ago</text></svg>
<span id="_r_1_" data-ua-hidden="">Ad</span></div>`;

/** One slot of the feed list, around a post marked with the next `aria-posinset`. */
export function item(inner: string): string {
  return `<div><div><span><div><div><div aria-posinset="${++n}"><div><div data-virtualized="false"><div>${inner}</div></div></div></div></div></div></span></div></div>`;
}

/** The action bar: Like, Comment and Share, each with Facebook's data-ad hook. */
export const ACTION_BAR = `<div><div aria-label="Like" role="button" tabindex="0"><div data-ad-rendering-role="like_button"></div><span>Like</span></div><div aria-label="Leave a comment" role="button" tabindex="0"><div data-ad-rendering-role="comment_button"></div><span>Comment</span></div><div aria-label="Share, send this to friends or post it on your profile." role="button" tabindex="0"><div data-ad-rendering-role="share_button"></div><span>Share</span></div></div>`;

export interface PostOptions {
  author: string;
  slot: string;
  text?: string;
  follow?: boolean;
  /** Anything between the author's header and the message, e.g. a split label. */
  extra?: string;
  /** A line above the author, like "Jamie Park commented on this." */
  context?: string;
  /** Media after the message, e.g. a video link. */
  media?: string;
  fillerCount?: number;
  /** The post's menu button ("Actions for this post"), an icon in the header. */
  menu?: boolean;
}

/** A post's own content, without the slot around it. */
export function postBody(o: PostOptions): string {
  const href = `https://www.facebook.com/${o.author.toLowerCase().replace(/\s+/g, '')}`;
  return `${filler(o.fillerCount)}
  ${o.context ? `<div><span dir="auto">${o.context}</span></div>` : ''}
  <div><span><a aria-label="${o.author}" href="${href}" role="link" tabindex="0"><svg aria-label="${o.author}" role="img"></svg></a></span>
  <div><span dir="ltr"><div data-ad-rendering-role="profile_name"><h4><span><span><a href="${href}" role="link" tabindex="0"><b><span>${o.author}</span></b></a></span></span>${o.follow ? '<span><span><span aria-hidden="true">·</span></span><span><div role="button" tabindex="0"><span>Follow</span></div></span></span>' : ''}</h4></div></span>
  <span dir="ltr"><div><span><span><a href="https://www.facebook.com/" role="link" tabindex="0">\u2060${o.slot}</a></span></span><span><span aria-hidden="true">·</span></span><span><svg width="12" role="img" title="Shared with Public"></svg></span>${o.extra ?? ''}</div></span></div>
  ${o.menu ? `<div aria-label="Actions for this post" role="button" tabindex="0"><svg width="20" aria-hidden="true"></svg></div>` : ''}</div>
  ${o.text === undefined ? '' : `<div><div dir="auto"><div data-ad-rendering-role="story_message"><div data-ad-comet-preview="message" data-ad-preview="message"><div dir="auto">${o.text}</div></div></div></div></div>`}
  ${o.media ?? ''}
  ${ACTION_BAR}`;
}

export function post(o: PostOptions): string {
  return item(postBody(o));
}

const profileHref = (name: string) => `https://www.facebook.com/${name.toLowerCase().replace(/\s+/g, '')}`;

/**
 * A post from a group, as the captures show it: the group's name in the name slot (with "· Join" when the account isn't
 * in it), then the member's name, the age and the audience. `follow` puts "· Follow" after the member's name.
 */
export function groupPost(o: {
  group: string;
  member: string;
  slot: string;
  text: string;
  join?: boolean;
  follow?: boolean;
  /** Media after the message, e.g. the member's reel. */
  media?: string;
}): string {
  const group = `https://www.facebook.com/groups/${o.group.toLowerCase().replace(/\s+/g, '')}/`;
  const member = `${group}user/100009/`;
  const button = (label: string) =>
    `<span dir="ltr"><span><span aria-hidden="true">·</span></span><div role="button" tabindex="0"><span>${label}</span></div></span>`;
  return item(`${filler()}
  <div><div aria-hidden="true"><a aria-label="${o.group}" href="${group}" role="link" tabindex="0"><svg aria-hidden="true" role="none"></svg></a></div>
  <div><span dir="ltr"><div data-ad-rendering-role="profile_name"><h4><div dir="ltr"><a href="${group}" role="link" tabindex="0"><span>${o.group}</span></a></div>${o.join ? button('Join') : ''}</h4></div></span>
  <span dir="ltr"><div><span><a href="${member}" role="link" tabindex="0"><span>${o.member}</span></a></span>${o.follow ? button('Follow') : ''}<span><span aria-hidden="true">·</span></span><span><a href="https://www.facebook.com/" role="link" tabindex="0">\u2060${o.slot}</a></span><span><svg width="12" role="img" title="Shared with Public group"></svg></span></div></span></div></div>
  <div><div dir="auto"><div data-ad-rendering-role="story_message"><div data-ad-comet-preview="message" data-ad-preview="message"><div dir="auto">${o.text}</div></div></div></div></div>
  ${o.media ?? ''}
  ${ACTION_BAR}`);
}

export interface SharedOptions {
  /** Whose post it is. */
  author: string;
  text: string;
  /** "· Follow" after the author's name, as for a page the account doesn't follow. */
  follow?: boolean;
  /** Facebook's `profile_name` hook on the shared post's name (the 2026 reel overlay has none). */
  hook?: boolean;
  /** The shared post's name as a plain link in spans, rather than a heading. */
  plainName?: boolean;
  /** `false`: no picture linking to the shared post's author before the name. */
  picture?: boolean;
  /** The shared post's text in Facebook's message box, rather than a plain block. */
  message?: boolean;
}

/**
 * A post shared inside another one (`media` of the sharer's post): its own picture and name heading, "· Follow" when
 * the account doesn't follow its author, its age and its text, as the reel overlay in capture 1 lays them out.
 */
export function sharedCard(o: SharedOptions): string {
  const link = `<span dir="auto"><span><object><a href="${profileHref(o.author)}" role="link" tabindex="0">${o.author}</a></object></span></span>`;
  const name = o.plainName ? link : `<h5 dir="auto">${link}</h5>`;
  const follow = o.follow
    ? `<span dir="auto"><span><span aria-hidden="true">·</span></span><div aria-label="Follow ${o.author}" role="button" tabindex="0">Follow</div></span>`
    : '';
  const text = o.message
    ? `<div data-ad-preview="message"><div dir="auto">${o.text}</div></div>`
    : `<div><span dir="auto">${o.text}</span></div>`;
  const picture =
    o.picture === false
      ? ''
      : `<object><a aria-label="${o.author}" href="${profileHref(o.author)}" role="link" tabindex="0"><svg aria-label="${o.author}" role="img"></svg></a></object>`;
  return `<div><div>${picture}
  <div>${o.hook ? `<div data-ad-rendering-role="profile_name">${name}</div>` : name}${follow}<span dir="auto"><span>3d</span></span></div></div>
  ${text}</div>`;
}

export interface ReelOptions {
  /** Whose reel it is: the name after the reel's caption. */
  creator: string;
  caption: string;
  /** "· Follow" after the creator's name, as for someone the account doesn't follow. */
  follow?: boolean;
  id?: number;
  /** Where the creator's name links to, when not their username (the captures link it to profile.php?id). */
  creatorHref?: string;
}

/**
 * A reel in the feed: the reel's link holds its caption and its creator's picture and name, with "· Follow" when the
 * account doesn't follow the creator (capture 1's first item, 2026-10-reels-1 and -2).
 */
export function reel(o: ReelOptions): string {
  const href = o.creatorHref ?? profileHref(o.creator);
  return `<a aria-label="Reel by ${o.creator}" href="https://www.facebook.com/reel/${o.id ?? 100001}/" role="link" tabindex="0"><div><span dir="auto">${o.caption}</span>
  <div><object><a aria-label="See owner profile" href="${href}" role="link" tabindex="0"><svg aria-label="${o.creator}" role="img"></svg></a></object>
  <h5 dir="auto"><span dir="auto"><object><a href="${href}" role="link" tabindex="0">${o.creator}</a></object></span></h5>${
    o.follow
      ? `<span dir="auto"><span aria-hidden="true">·</span><div aria-label="Follow ${o.creator}" role="button" tabindex="0">Follow</div></span>`
      : ''
  }</div></div></a>`;
}

/** A feed panel: the title is an h3 (People you may know, Reels) or a plain span[dir=auto]. */
export function panel(title: string, kind: 'h3' | 'span', body: string): string {
  const t =
    kind === 'h3'
      ? `<h3 dir="auto"><span dir="auto"><div><svg width="20" aria-hidden="true"></svg><span></span></div>${title}</span></h3>`
      : `<div><span dir="auto">${title}</span></div>`;
  return item(
    `${filler()}<div><div>${t}<div aria-label="Actions for this post" role="button" tabindex="0"><svg width="20" aria-hidden="true"></svg></div></div>${body}</div>`,
  );
}

export const PYMK = panel(
  'People you may know',
  'h3',
  '<div aria-label="People you may know" role="region"><div role="grid"><div role="row"><div role="cell"><a href="https://www.facebook.com/sam.rivera" role="link"><span>Sam Rivera</span></a><div role="button" tabindex="0"><span>Add friend</span></div></div></div></div></div>',
);
export const REELS = panel(
  'Reels',
  'h3',
  '<div aria-label="Reels" role="grid"><div role="row"><div role="gridcell"><a aria-label="Reel by Pat Doe" href="https://www.facebook.com/reel/100000/" role="link"></a></div></div></div>',
);
export const GROUP_SUGGESTIONS = panel(
  'Your group suggestions',
  'span',
  '<div><a href="https://www.facebook.com/groups/100000/" role="link"><span>Trail Runners of the Valley</span></a><div role="button" tabindex="0"><span>Join group</span></div></div>',
);

/** Scrolled far away: Facebook keeps the slot and the post marker but drops the content. */
export const VIRTUALIZED = `<div><div><span><div><div><div aria-posinset="900"><div><div data-virtualized="true"><div hidden=""></div></div></div></div></div></div></span></div></div>`;

/** The home page around the feed list's items: the top bar, the screen-reader "Feed posts" heading, LABELS. */
export function feed(...items: string[]): string {
  return `${fbBanner()}
<div role="main"><div><div><div><h3>Feed posts</h3><div aria-hidden="true"></div><div>${items.join('\n')}</div></div></div></div></div>
${LABELS}`;
}
