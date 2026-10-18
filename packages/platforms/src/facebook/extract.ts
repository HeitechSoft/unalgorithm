import { cyrb53, type Evidence, type ModuleInfo, NO_SIGNALS, type PostData } from '@unalgorithm/core';
import type { MediaKind, PostKey } from '@unalgorithm/protocol';
import { getLines, linkDomain, linkedNames, normalizeText, precedes, richText } from '../shared/dom.ts';
import type { FacebookMarkers } from './markers/en.ts';

const ORIGIN = 'https://www.facebook.com';

/** Hooks Facebook renders for ads previews and the story layout; they also mark ordinary posts. */
export const FB_SEL = {
  feed: '[role="feed"]',
  post: '[aria-posinset]',
  message: '[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-ad-rendering-role="story_message"]',
  profileName: '[data-ad-rendering-role="profile_name"]',
  heading: 'h2, h3, h4',
  button: 'button, [role="button"]',
  permalink:
    'a[href*="/posts/"], a[href*="story_fbid="], a[href*="/permalink/"], a[href*="/reel/"], a[href*="/videos/"], a[href*="/photo"]',
  /** Inside a header link: the 2026 timestamp's age ("6 hours ago") or, on ads, "Ad". */
  timestampLabel: '[aria-labelledby]',
  outboundLink: 'a[href*="l.facebook.com/l.php"], a[href^="https://l.facebook.com/"]',
  groupLink: 'a[href*="/groups/"]',
  audience: '[aria-label^="Shared with"], [title^="Shared with"]',
} as const;

/** Elements Facebook renders but hides (anti-adblock decoys). The capture script marks them `data-ua-hidden`. */
function isHidden(el: Element): boolean {
  if (el.hasAttribute('data-ua-hidden') || el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
  const view = el.ownerDocument.defaultView;
  const html = el as HTMLElement;
  if (!view || typeof html.getClientRects !== 'function' || html.getClientRects().length === 0) return false;
  const s = view.getComputedStyle(el);
  return s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0 || s.fontSize === '0px';
}

/** Text built only from characters a person can see, so "Spo<hidden>x</hidden>nsored" reads "Sponsored". */
function visibleText(root: Element, limit = 40): string {
  let out = '';
  let nodes = 0;
  const visit = (n: Node) => {
    if (nodes++ > limit) return;
    if (n.nodeType === Node.TEXT_NODE) {
      out += n.nodeValue ?? '';
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as Element;
    if (isHidden(el)) return;
    // Facebook draws some labels as SVG <use> pointing at a <text> elsewhere in the page.
    if (el.tagName.toLowerCase() === 'use') {
      const ref = el.getAttribute('href') ?? el.getAttribute('xlink:href');
      const target = ref?.startsWith('#') ? el.ownerDocument.getElementById(ref.slice(1)) : null;
      if (target) out += target.textContent ?? '';
      return;
    }
    for (const c of Array.from(el.childNodes)) visit(c);
  };
  visit(root);
  return normalizeText(out).replace(/\s+/g, '');
}

function messageBox(root: Element): Element | null {
  return root.querySelector(FB_SEL.message);
}

/** The post's own header: everything before the message box (or the first 30 % of the item if there is none). */
function inHeader(root: Element, el: Element): boolean {
  const msg = messageBox(root);
  if (msg) return precedes(el, msg) && !msg.contains(el);
  const author = root.querySelector(FB_SEL.profileName) ?? root.querySelector(FB_SEL.heading);
  if (!author) return false;
  const container = author.parentElement?.parentElement ?? author;
  return container.contains(el);
}

/** A shared post nested inside this one has its own header; its buttons and labels are not ours. */
function inNestedPost(root: Element, el: Element): boolean {
  const names = Array.from(root.querySelectorAll(FB_SEL.profileName));
  if (names.length < 2) return false;
  const second = names[1] as Element;
  let block: Element | null = second;
  while (block?.parentElement && block.parentElement !== root && !block.parentElement.contains(names[0] as Element))
    block = block.parentElement;
  return !!block && block !== root && block.contains(el);
}

function headerButtons(root: Element): Element[] {
  return Array.from(root.querySelectorAll(FB_SEL.button)).filter((b) => inHeader(root, b) && !inNestedPost(root, b));
}

function label(el: Element): string {
  return normalizeText(el.getAttribute('aria-label') ?? getLines(el).join(' '));
}

/** Sponsored detection: several independent detectors, each with a strength. Weak signals never hide alone. */
function sponsoredEvidence(root: Element, m: FacebookMarkers): Evidence[] {
  const ev: Evidence[] = [];
  const doc = root.ownerDocument;
  const headerEls = Array.from(root.querySelectorAll('a, span, div')).filter(
    (el) => inHeader(root, el) && !inNestedPost(root, el),
  );

  // 1. aria-label / aria-labelledby resolving to "Sponsored".
  for (const el of headerEls) {
    const own = el.getAttribute('aria-label');
    if (own && m.sponsored.test(normalizeText(own))) {
      ev.push({ signal: 'sponsored', detector: 'fb.sponsored.aria-label', strength: 'strong' });
      break;
    }
    const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
    const text = ids
      .map((id) => doc.getElementById(id))
      .filter((x): x is HTMLElement => !!x)
      .map((x) => visibleText(x))
      .join('');
    if (text && m.sponsored.test(text)) {
      ev.push({ signal: 'sponsored', detector: 'fb.sponsored.labelledby', strength: 'strong' });
      break;
    }
  }
  // 2. Links to Facebook's ad transparency pages.
  if (
    headerEls.some((el) => el.tagName === 'A' && /\/ads\/(about|preferences)|\/ad_?choices/.test(el.getAttribute('href') ?? ''))
  ) {
    ev.push({ signal: 'sponsored', detector: 'fb.sponsored.adlink', strength: 'strong' });
  }
  // 3. "Paid partnership" (branded content).
  if (headerEls.some((el) => el.childElementCount === 0 && m.paidPartnership.test(normalizeText(el.textContent ?? '')))) {
    ev.push({ signal: 'sponsored', detector: 'fb.sponsored.paid-partnership', strength: 'strong' });
  }
  // 4. The label rebuilt from visible characters only (defeats letters split across hidden decoy spans).
  const small = headerEls.filter(
    (el) => el.tagName === 'SPAN' && el.querySelectorAll('*').length <= 40 && (el.textContent?.length ?? 0) <= 60,
  );
  if (small.some((el) => m.sponsored.test(visibleText(el))))
    ev.push({ signal: 'sponsored', detector: 'fb.sponsored.rendered-label', strength: 'medium' });
  // 5. A call-to-action button with an outbound link (weak: organic shares can have these too).
  const cta = Array.from(root.querySelectorAll(`${FB_SEL.button}, a`)).some(
    (b) => !inNestedPost(root, b) && m.ctaButtons.test(label(b)),
  );
  if (cta && root.querySelector(FB_SEL.outboundLink))
    ev.push({ signal: 'sponsored', detector: 'fb.sponsored.cta', strength: 'weak' });
  // 6. No timestamp/permalink where organic posts have one (weak). Since 2026 the timestamp links to "/" until
  //    hovered and its age is an aria-labelledby span inside the link, so that counts as a timestamp too.
  const timestamp =
    !!root.querySelector(FB_SEL.permalink) ||
    headerEls.some((el) => el.tagName === 'A' && !!el.querySelector(FB_SEL.timestampLabel));
  if (!timestamp) ev.push({ signal: 'sponsored', detector: 'fb.sponsored.no-timestamp', strength: 'weak' });
  return ev;
}

export function isSponsored(ev: Evidence[]): boolean {
  const s = ev.filter((e) => e.signal === 'sponsored');
  const strong = s.filter((e) => e.strength === 'strong').length;
  const medium = s.filter((e) => e.strength === 'medium').length;
  const weak = s.filter((e) => e.strength === 'weak').length;
  return strong >= 1 || medium >= 2 || (medium >= 1 && weak >= 1);
}

function headerLines(root: Element): string[] {
  const msg = messageBox(root);
  const lines: string[] = [];
  for (const el of Array.from(root.querySelectorAll('span, h2, h3, h4, div[dir="auto"]'))) {
    if (el.childElementCount > 3) continue;
    if (msg && !precedes(el, msg)) break;
    if (inNestedPost(root, el)) continue;
    const t = normalizeText(el.textContent ?? '');
    if (t && t.length < 120 && !lines.includes(t)) lines.push(t);
    if (lines.length > 20) break;
  }
  return lines;
}

function authorOf(root: Element): { name?: string; url?: string } {
  const box = root.querySelector(FB_SEL.profileName) ?? root.querySelector(FB_SEL.heading);
  const link = box?.querySelector<HTMLAnchorElement>('a[href]') ?? (box?.closest('a[href]') as HTMLAnchorElement | null);
  const name = normalizeText((box ? getLines(box)[0] : undefined) ?? link?.textContent ?? '');
  const href = link?.getAttribute('href');
  let url: string | undefined;
  if (href && href !== '#') {
    try {
      const u = new URL(href, ORIGIN);
      if (u.hostname.endsWith('facebook.com')) {
        const id = u.searchParams.get('id');
        url = `${ORIGIN}${u.pathname.replace(/\/+$/, '')}${u.pathname.includes('profile.php') && id ? `?id=${id}` : ''}`;
      }
    } catch {
      // ignore
    }
  }
  return { ...(name ? { name } : {}), ...(url ? { url } : {}) };
}

/**
 * Facebook's own id for the post, from its permalink; a stable hash otherwise (never ages or counts). Since 2026 most
 * posts have no id up front: the timestamp links to "/?__cft__…" (an opaque tracking token) until hovered, and the
 * post node carries no id. Photo, video and reel links still do, and are read here.
 */
export function postIdFrom(root: Element, author: string, text: string, media: string): PostKey {
  for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>(FB_SEL.permalink))) {
    if (inNestedPost(root, a)) continue;
    const href = a.getAttribute('href') ?? '';
    const m =
      /story_fbid=([\w]+)/.exec(href) ??
      /\/posts\/(pfbid\w+|\d+)/.exec(href) ??
      /\/permalink\/(\d+)/.exec(href) ??
      /\/reel\/(\d+)/.exec(href) ??
      /\/videos\/(\d+)/.exec(href) ??
      /[?&]fbid=(\d+)/.exec(href);
    if (m?.[1]) return `fb:${m[1]}`;
  }
  return `fb:h:${cyrb53(`${author}\u0000${text.slice(0, 200)}\u0000${media}`)}`;
}

/**
 * Deletes the query parameters whose names `drop` picks. The names are read with `forEach`: in a Firefox content
 * script `URL` comes through an Xray wrapper, whose `URLSearchParams` iterators can't be spread or looped over.
 */
function dropParams(u: URL, drop: (key: string) => boolean): void {
  const keys: string[] = [];
  u.searchParams.forEach((_value, key) => {
    keys.push(key);
  });
  for (const key of keys) if (drop(key)) u.searchParams.delete(key);
}

function permalinkOf(root: Element): string | undefined {
  const a = Array.from(root.querySelectorAll<HTMLAnchorElement>(FB_SEL.permalink)).find(
    (x) => !inNestedPost(root, x) && x.getAttribute('href') !== '#',
  );
  if (!a) return undefined;
  try {
    const u = new URL(a.getAttribute('href') ?? '', ORIGIN);
    dropParams(u, (k) => k.startsWith('__'));
    return u.href;
  } catch {
    return undefined;
  }
}

function sharedLinkOf(root: Element): PostData['sharedLink'] {
  const a = root.querySelector<HTMLAnchorElement>(FB_SEL.outboundLink);
  if (!a) return undefined;
  try {
    const target = new URL(a.getAttribute('href') ?? '', ORIGIN).searchParams.get('u');
    if (!target) return undefined;
    const u = new URL(target);
    dropParams(u, (k) => /^(utm_|fbclid)/.test(k));
    const domain = linkDomain(u.href, ORIGIN);
    if (!domain) return undefined;
    const pieces = Array.from(a.querySelectorAll('span, div'))
      .filter((el) => el.childElementCount === 0)
      .map((el) => normalizeText(el.textContent ?? ''));
    const title = [...pieces, ...getLines(a)].find((l) => l.length > 8 && !l.toLowerCase().includes(domain));
    return { url: u.href, domain, ...(title ? { title: title.slice(0, 300) } : {}) };
  } catch {
    return undefined;
  }
}

function mediaOf(root: Element): MediaKind {
  if (root.querySelector('a[href*="/reel/"]')) return 'reel';
  if (root.querySelector('video')) return 'video';
  if (root.querySelector(FB_SEL.outboundLink)) return 'link';
  if (root.querySelector('a[href*="/events/"]')) return 'event';
  if (
    Array.from(root.querySelectorAll('img')).some(
      (img) => Number(img.getAttribute('width') ?? 0) > 120 || img.closest('a[href*="/photo"]'),
    )
  )
    return 'image';
  return 'none';
}

/** The post's text, whether it is complete, and the element it came from (where tagged names are looked up). */
function textOf(root: Element, m: FacebookMarkers): { text: string; complete: boolean; source: Element | null } {
  const box = messageBox(root);
  const expander = Array.from(root.querySelectorAll(FB_SEL.button)).some(
    (b) => m.seeMore.test(label(b)) && (!box || box.contains(b) || precedes(box, b)),
  );
  if (box) {
    const text = richText(box)
      .replace(/\s*(?:…|\.{3})?\s*see more\s*$/i, '')
      .trim();
    return { text, complete: !expander, source: box };
  }
  // No message box: the longest dir=auto block outside the header that is not part of a comment.
  const blocks = Array.from(root.querySelectorAll('div[dir="auto"]'))
    .filter((el) => !inHeader(root, el) && !inComment(root, el))
    .map((el) => ({ el, text: normalizeText(el.textContent ?? '') }))
    .sort((a, b) => b.text.length - a.text.length);
  const best = blocks[0];
  return { text: (best?.text ?? '').slice(0, 4000), complete: !expander, source: best?.el ?? null };
}

/** Comments are nested articles ("Comment by …") or live in a labelled comment section. */
function inComment(root: Element, el: Element): boolean {
  const article = el.parentElement?.closest('[role="article"]');
  if (article && article !== root && root.contains(article)) return true;
  const section = el.closest('[aria-label*="comment" i], ul');
  return !!section && section !== root && root.contains(section);
}

/** Profile and page links (tags), not hashtags, groups, media, outbound or Facebook's own pages. */
function isFacebookProfileHref(href: string): boolean {
  let u: URL;
  try {
    u = new URL(href, 'https://www.facebook.com');
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

/** A feed panel rather than a post: its heading names a known panel and it has no message box. */
export function moduleOf(root: Element, m: FacebookMarkers): ModuleInfo | undefined {
  if (messageBox(root)) return undefined;
  for (const h of Array.from(root.querySelectorAll('h2, h3, h4, span[dir="auto"]')).slice(0, 8)) {
    const t = normalizeText(h.textContent ?? '');
    for (const [kind, re] of Object.entries(m.modules) as [ModuleInfo['kind'], RegExp][]) {
      if (re.test(t)) return { kind, title: t };
    }
  }
  return undefined;
}

/** Read one Facebook feed item into a post. Read-only: never clicks "See more" or anything else. */
export function extractFacebookPost(root: HTMLElement, m: FacebookMarkers): PostData {
  const author = authorOf(root);
  const lines = headerLines(root);
  const evidence = sponsoredEvidence(root, m);
  const sponsored = isSponsored(evidence);
  const suggested = lines.some((l) => m.suggestedHeader.test(l));
  if (suggested) evidence.push({ signal: 'suggested', detector: 'fb.header.suggested', strength: 'strong' });
  const activity = lines.find(
    (l) => m.activity.test(l) && (!author.name || !l.startsWith(`${author.name} `) || /\b(this|'s)\b/.test(l)),
  );
  const reshare = lines.some((l) => m.reshare.test(l)) || root.querySelectorAll(FB_SEL.profileName).length > 1;
  if (activity) evidence.push({ signal: 'networkActivity', detector: 'fb.header.activity', strength: 'strong' });
  if (reshare) evidence.push({ signal: 'reshare', detector: 'fb.reshare', strength: 'medium' });

  const buttons = headerButtons(root);
  const follow = buttons.some((b) => m.follow.test(label(b)));
  const join = buttons.some((b) => m.join.test(label(b)));
  if (follow) evidence.push({ signal: 'relationship', detector: 'fb.follow-button', strength: 'strong' });
  if (join) evidence.push({ signal: 'unjoinedGroup', detector: 'fb.join-button', strength: 'strong' });

  const groupLink = Array.from(root.querySelectorAll<HTMLAnchorElement>(FB_SEL.groupLink)).find(
    (a) => inHeader(root, a) && !inNestedPost(root, a),
  );
  const groupName = groupLink ? normalizeText(getLines(groupLink)[0] ?? '') : undefined;

  const audienceEl = root.querySelector(FB_SEL.audience);
  const audienceLabel = normalizeText(audienceEl?.getAttribute('aria-label') ?? audienceEl?.getAttribute('title') ?? '');
  const audience = !audienceLabel
    ? 'unknown'
    : m.audience.public.test(audienceLabel)
      ? 'public'
      : m.audience.friends.test(audienceLabel)
        ? 'friends'
        : 'custom';

  const { text, complete, source } = textOf(root, m);
  const mentions = source ? linkedNames([source], isFacebookProfileHref) : [];
  const media = mediaOf(root);
  const id = postIdFrom(root, author.name ?? '', text, media);
  const permalink = permalinkOf(root);
  const sharedLink = sharedLinkOf(root);
  return {
    id,
    platform: 'facebook',
    ...(permalink ? { permalink } : {}),
    author: {
      ...author,
      kind: groupLink && !author.name ? 'group' : 'unknown',
      relationship: follow ? 'not-followed' : 'unknown',
    },
    ...(groupLink ? { group: { ...(groupName ? { name: groupName } : {}), joined: !join } } : {}),
    ...(activity ? { contextLine: activity } : suggested ? { contextLine: lines.find((l) => m.suggestedHeader.test(l)) } : {}),
    signals: {
      ...NO_SIGNALS,
      sponsored,
      suggested,
      networkActivity: !!activity,
      reshare,
      unjoinedGroup: !!groupLink && join,
      reel: media === 'reel',
    },
    evidence,
    text,
    textComplete: complete,
    ...(mentions.length ? { mentions } : {}),
    media,
    ...(sharedLink ? { sharedLink } : {}),
    audience,
    quality: { authorFound: !!author.name, textFound: text.length > 0 || media !== 'none' },
  };
}
