import { atLeast, cyrb53, type Evidence, type ModuleInfo, NO_SIGNALS, type PostData, signalStrength } from '@unalgorithm/core';
import type { MediaKind, PostKey } from '@unalgorithm/protocol';
import { accessibleName, getLines, linkDomain, linkedNames, normalizeText, precedes, richText } from '../shared/dom.ts';
import { type LabelHit, type LabelPattern, matchLabel } from '../shared/labels.ts';
import type { FacebookDetector, FacebookObservation } from './ids.ts';
import type { FacebookMarkers } from './markers/en.ts';
import { FB_ORIGIN, FB_SEL, isFacebookProfileHref } from './selectors.ts';
import {
  headerButtons,
  type ItemSlots,
  inComment,
  inHeader,
  inNestedPost,
  messageBox,
  slotLink,
  slotsOf,
  withSlots,
} from './slots.ts';

export { FB_SEL } from './selectors.ts';

/** Evidence from one of the ids the adapter declares (ids.ts), so nothing outside the registry is ever emitted. */
function ev(signal: Evidence['signal'], detector: FacebookDetector, strength: Evidence['strength']): Evidence {
  return { signal, detector, strength };
}

/**
 * Elements Facebook renders but hides (anti-adblock decoys). The capture script marks them `data-ua-hidden`.
 * An element's own display:none is checked before layout, because such an element has no client rects either.
 * Without rects, the other styles are not trusted: everything inside an item we folded has none, and display is
 * not inherited, so a folded item's labels still read as they look on screen.
 */
function isHidden(el: Element): boolean {
  if (el.hasAttribute('data-ua-hidden') || el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
  const view = el.ownerDocument.defaultView;
  if (!view) return false;
  // With no style sheet, only the element's own style can hide it: skip getComputedStyle, which may recalculate
  // styles (and takes a millisecond a call in jsdom, where the captures are tested).
  if (el.ownerDocument.styleSheets.length === 0 && !el.hasAttribute('style')) return false;
  const s = view.getComputedStyle(el);
  if (s.display === 'none') return true;
  const html = el as HTMLElement;
  if (typeof html.getClientRects !== 'function' || html.getClientRects().length === 0) return false;
  return s.visibility === 'hidden' || Number(s.opacity) === 0 || s.fontSize === '0px';
}

/** Without spaces and U+034F, an invisible joiner Facebook puts after each character of some labels. */
function squash(s: string): string {
  return s.replace(/\s|\u034F/g, '');
}

/**
 * Text built only from characters a person can see, so "Spo<hidden>x</hidden>nsored" reads "Sponsored".
 * `hiddenRoot` reads a root that is itself hidden, as an aria-labelledby target may be.
 */
function visibleText(root: Element, limit = 40, hiddenRoot = false): string {
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
    if (!(hiddenRoot && el === root) && isHidden(el)) return;
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
  return normalizeText(out);
}

/** The visible text of the elements an element's aria-labelledby names (read even when they are hidden). */
function labelledText(el: Element): string {
  const doc = el.ownerDocument;
  return (el.getAttribute('aria-labelledby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => doc.getElementById(id))
    .filter((x): x is HTMLElement => !!x)
    .map((x) => visibleText(x, 40, true))
    .join('');
}

/**
 * The label `text` is, as the page shows it or with its spaces removed (letters spread across spans, "S p o n s o r e
 * d"). A full match (exact or known) wins over a near miss.
 */
function labelHit(text: string, pattern: LabelPattern): LabelHit | null {
  const shown = matchLabel(text, pattern);
  if (shown && shown.match !== 'near') return shown;
  const squashed = matchLabel(squash(text), pattern);
  if (squashed && squashed.match !== 'near') return squashed;
  return shown ?? squashed;
}

const isFull = (hit: LabelHit | null): boolean => !!hit && hit.match !== 'near';

function label(el: Element): string {
  return normalizeText(el.getAttribute('aria-label') ?? getLines(el).join(' '));
}

/** A button whose aria-label or visible text is exactly the label ("Follow", "+ Follow"; never "Following"). */
function isButton(el: Element, pattern: LabelPattern): boolean {
  const own = el.getAttribute('aria-label');
  return (!!own && isFull(matchLabel(normalizeText(own), pattern))) || isFull(matchLabel(getLines(el).join(' '), pattern));
}

/** What the slot link says, from its SVG text, its aria-labelledby label or its visible characters. */
function slotLabel(a: Element): string {
  const doc = a.ownerDocument;
  for (const use of Array.from(a.querySelectorAll('use'))) {
    const ref = use.getAttribute('href') ?? use.getAttribute('xlink:href');
    const target = ref?.startsWith('#') ? doc.getElementById(ref.slice(1)) : null;
    const text = target && !isHidden(use.closest('svg') ?? use) ? normalizeText(target.textContent ?? '') : '';
    if (text) return text;
  }
  for (const el of [a, ...Array.from(a.querySelectorAll('[aria-labelledby]'))]) {
    const text = labelledText(el);
    if (text) return text;
  }
  return visibleText(a);
}

const isNameLink = (a: Element) => {
  const href = a.getAttribute('href') ?? '';
  return isFacebookProfileHref(href) || /\/groups\//.test(href);
};

/**
 * The author's name block (or a wrapper of it), or a link to a person, page or group: a near miss there is a name
 * ("Ad Astra"), not a label, and must never raise "Some ads may be getting through".
 */
function inName(root: Element, el: Element): boolean {
  const { actor } = slotsOf(root);
  if (actor && (actor.contains(el) || el.contains(actor))) return true;
  const link = el.closest('a[href]');
  if (link && root.contains(link) && isNameLink(link)) return true;
  return Array.from(el.querySelectorAll('a[href]')).some(isNameLink);
}

interface AdLabels {
  evidence: Evidence[];
  /** A near-miss ad label ("Ad · Paid"): the age slot's first, else the first in another label position. */
  near?: LabelHit;
  /** The age slot holds something that is neither an age nor an ad label. */
  ageUnrecognised: boolean;
}

/**
 * Sponsored detection: several independent detectors, each with a strength. Weak signals never hide alone. Labels
 * are read only in label positions (ADR 0009 §9): the age slot, the header's elements and its buttons, never the
 * post's text, comments or a nested post.
 */
function sponsoredEvidence(root: Element, m: FacebookMarkers): AdLabels {
  const out: Evidence[] = [];
  const pattern = m.labels.sponsored;
  const nearMisses: LabelHit[] = [];
  /** A full label; a near miss outside names is kept for the one medium `fb.sponsored.near`. */
  const full = (hit: LabelHit | null, el: Element): boolean => {
    if (hit?.match === 'near' && !inName(root, el)) nearMisses.push(hit);
    return isFull(hit);
  };
  const headerEls = Array.from(root.querySelectorAll('a, span, div')).filter(
    (el) => inHeader(root, el) && !inNestedPost(root, el),
  );

  // 1. aria-label / aria-labelledby naming the label.
  for (const el of headerEls) {
    const own = el.getAttribute('aria-label');
    if (own && full(labelHit(normalizeText(own), pattern), el)) {
      out.push(ev('sponsored', 'fb.sponsored.aria-label', 'strong'));
      break;
    }
    const text = labelledText(el);
    if (text && full(labelHit(text, pattern), el)) {
      out.push(ev('sponsored', 'fb.sponsored.labelledby', 'strong'));
      break;
    }
  }
  // 2. Links to Facebook's ad transparency pages.
  if (
    headerEls.some((el) => el.tagName === 'A' && /\/ads\/(about|preferences)|\/ad_?choices/.test(el.getAttribute('href') ?? ''))
  ) {
    out.push(ev('sponsored', 'fb.sponsored.adlink', 'strong'));
  }
  // 3. "Paid partnership" (branded content).
  if (headerEls.some((el) => el.childElementCount === 0 && m.paidPartnership.test(normalizeText(el.textContent ?? '')))) {
    out.push(ev('sponsored', 'fb.sponsored.paid-partnership', 'strong'));
  }
  // 4. The label rebuilt from visible characters only (defeats letters split across hidden decoy spans).
  const small = headerEls.filter(
    (el) => el.tagName === 'SPAN' && el.querySelectorAll('*').length <= 40 && (el.textContent?.length ?? 0) <= 60,
  );
  if (small.some((el) => full(labelHit(visibleText(el), pattern), el)))
    out.push(ev('sponsored', 'fb.sponsored.rendered-label', 'medium'));
  // 5. A header button named by the label. Buttons with an aria-label or aria-labelledby were read in 1.
  for (const b of headerButtons(root).buttons) {
    if (b.tagName !== 'BUTTON' && (b.hasAttribute('aria-label') || b.hasAttribute('aria-labelledby'))) continue;
    if (full(labelHit(accessibleName(b), pattern), b)) {
      out.push(ev('sponsored', 'fb.sponsored.header', 'strong'));
      break;
    }
  }
  // 6. A call-to-action button with an outbound link (weak: organic shares can have these too).
  const cta = Array.from(root.querySelectorAll(`${FB_SEL.button}, a`)).some(
    (b) => !inNestedPost(root, b) && m.ctaButtons.test(label(b)),
  );
  if (cta && root.querySelector(FB_SEL.outboundLink)) out.push(ev('sponsored', 'fb.sponsored.cta', 'weak'));
  // 7. The label where organic posts show their age: the link after the author's name (strong).
  const slot = slotLink(root);
  const age = slot ? slotLabel(slot) : '';
  const slotHit = age ? labelHit(age, pattern) : null;
  if (isFull(slotHit)) out.push(ev('sponsored', 'fb.sponsored.slot-label', 'strong'));
  // 8. No timestamp/permalink where organic posts have one (weak). Since 2026 the timestamp links to "/" until
  //    hovered and its age is SVG text (later also an aria-labelledby span): an age there counts; a label, or words
  //    that are no age, do not.
  const isAge = !!age && !slotHit && (/\d/.test(age) || m.ageWords.test(age));
  if (!root.querySelector(FB_SEL.permalink) && !isAge) out.push(ev('sponsored', 'fb.sponsored.no-timestamp', 'weak'));
  // 9. A near miss ("Ad · Paid"): medium, so with the missing timestamp it still hides, and the change is reported.
  const near = slotHit?.match === 'near' ? slotHit : nearMisses[0];
  if (near) out.push(ev('sponsored', 'fb.sponsored.near', 'medium'));
  return { evidence: out, ...(near ? { near } : {}), ageUnrecognised: !!age && !slotHit && !isAge };
}

/** True when the evidence is enough to hide a post as an ad: core's rule, the same on every platform. */
export function isSponsored(ev: Evidence[]): boolean {
  return atLeast(signalStrength(ev, 'sponsored'), 'medium');
}

function headerLines(root: Element): string[] {
  const msg = messageBox(root);
  const lines: string[] = [];
  for (const el of Array.from(root.querySelectorAll('span, h2, h3, h4, div[dir="auto"]'))) {
    if (el.childElementCount > 3) continue;
    // 2026: the message box sits inside a div[dir=auto], which comes "before" it in document order.
    if (msg && el.contains(msg)) continue;
    if (msg && !precedes(el, msg)) break;
    // Off-screen aria-hidden blocks of filler words at the top of every 2026 item.
    if (el.closest('[aria-hidden="true"]')) continue;
    if (inNestedPost(root, el)) continue;
    const t = normalizeText(el.textContent ?? '');
    if (t && t.length < 120 && !lines.includes(t)) lines.push(t);
    if (lines.length > 20) break;
  }
  return lines;
}

/** Lines above the author's name ("Jamie Park commented on this."), for telling known header lines from new ones. */
function contextLines(root: Element): string[] {
  const { actor } = slotsOf(root);
  if (!actor) return [];
  const lines: string[] = [];
  for (const el of Array.from(root.querySelectorAll('span[dir="auto"], div[dir="auto"], h2, h3, h4'))) {
    if (!precedes(el, actor)) break;
    if (el.contains(actor) || el.childElementCount > 3 || el.closest('[aria-hidden="true"]') || inNestedPost(root, el)) continue;
    const t = normalizeText(el.textContent ?? '');
    if (t && t.length < 120 && !lines.includes(t)) lines.push(t);
  }
  return lines;
}

function authorOf(root: Element): { name?: string; url?: string } {
  const box = slotsOf(root).actor;
  const link = box?.querySelector<HTMLAnchorElement>('a[href]') ?? (box?.closest('a[href]') as HTMLAnchorElement | null);
  const name = normalizeText((box ? getLines(box)[0] : undefined) ?? link?.textContent ?? '');
  const href = link?.getAttribute('href');
  let url: string | undefined;
  if (href && href !== '#') {
    try {
      const u = new URL(href, FB_ORIGIN);
      if (u.hostname.endsWith('facebook.com')) {
        const id = u.searchParams.get('id');
        url = `${FB_ORIGIN}${u.pathname.replace(/\/+$/, '')}${u.pathname.includes('profile.php') && id ? `?id=${id}` : ''}`;
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
    const u = new URL(a.getAttribute('href') ?? '', FB_ORIGIN);
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
    const target = new URL(a.getAttribute('href') ?? '', FB_ORIGIN).searchParams.get('u');
    if (!target) return undefined;
    const u = new URL(target);
    dropParams(u, (k) => /^(utm_|fbclid)/.test(k));
    const domain = linkDomain(u.href, FB_ORIGIN);
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

/** Elements that can title a feed panel, in page order. */
const PANEL_TITLES = 'h1, h2, h3, h4, h5, h6, [role="heading"], span[dir="auto"]';

/** The panel's title: the first heading a screen reader would read (not aria-hidden filler) that has a name. */
function panelTitle(root: Element): string | undefined {
  for (const h of Array.from(root.querySelectorAll(PANEL_TITLES))) {
    if (h.closest('[aria-hidden="true"], [hidden], [data-ua-hidden]')) continue;
    const name = accessibleName(h);
    if (name) return name;
  }
  return undefined;
}

/** A feed panel rather than a post: its title names a known panel and it has no message box. */
export function moduleOf(root: Element, m: FacebookMarkers): ModuleInfo | undefined {
  if (messageBox(root)) return undefined;
  const title = panelTitle(root);
  if (!title) return undefined;
  for (const [kind, pattern] of Object.entries(m.modules) as [ModuleInfo['kind'], LabelPattern][]) {
    if (isFull(matchLabel(title, pattern))) return { kind, title };
  }
  return undefined;
}

/** One post as read, and what the adapter noticed while reading it (ids only, for health and reports). */
export interface FacebookRead {
  post: PostData;
  observations: FacebookObservation[];
}

/** Read one Facebook feed item into a post. Read-only: never clicks "See more" or anything else. */
export function readFacebookPost(root: HTMLElement, m: FacebookMarkers): FacebookRead {
  return withSlots(root, (slots) => readPost(root, m, slots));
}

/** Read one Facebook feed item into a post (without the observations). */
export function extractFacebookPost(root: HTMLElement, m: FacebookMarkers): PostData {
  return readFacebookPost(root, m).post;
}

function readPost(root: HTMLElement, m: FacebookMarkers, slots: ItemSlots): FacebookRead {
  const observations = new Set<FacebookObservation>(slots.observations);
  const author = authorOf(root);
  const lines = headerLines(root);
  const ads = sponsoredEvidence(root, m);
  const evidence = ads.evidence;
  if (ads.near) observations.add('fb.label.sponsored.near');
  if (ads.ageUnrecognised) observations.add('fb.slot.age.unrecognised');
  const sponsored = isSponsored(evidence);
  const suggested = lines.some((l) => m.suggestedHeader.test(l));
  if (suggested) evidence.push(ev('suggested', 'fb.header.suggested', 'strong'));
  const activity = lines.find(
    (l) => m.activity.test(l) && (!author.name || !l.startsWith(`${author.name} `) || /\b(this|'s)\b/.test(l)),
  );
  const reshare = lines.some((l) => m.reshare.test(l)) || root.querySelectorAll(FB_SEL.profileName).length > 1;
  if (activity) evidence.push(ev('networkActivity', 'fb.header.activity', 'strong'));
  if (reshare) evidence.push(ev('reshare', 'fb.reshare', 'medium'));

  const context = contextLines(root);
  const known = context.filter((l) => m.suggestedHeader.test(l) || m.activity.test(l) || m.reshare.test(l));
  const headerUnknown = context.length > known.length;
  if (headerUnknown) observations.add('fb.header.unknown');

  // Header buttons by role; buttons that lost their role only when those have none, which reports say.
  const { buttons, fallback } = headerButtons(root);
  const pressed = (pattern: LabelPattern): boolean => {
    if (buttons.some((b) => isButton(b, pattern))) return true;
    if (!fallback.some((b) => isButton(b, pattern))) return false;
    observations.add('fb.slot.header-buttons.structure');
    return true;
  };
  const follow = pressed(m.labels.follow);
  const join = pressed(m.labels.join);
  if (follow) evidence.push(ev('relationship', 'fb.follow-button', 'strong'));
  if (join) evidence.push(ev('unjoinedGroup', 'fb.join-button', 'strong'));

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
  // Text without Facebook's message box: found by structure, and the header with it.
  if (!slots.message && text) {
    observations.add('fb.slot.text.structure');
    observations.add('fb.slot.header.structure');
  }
  const mentions = source ? linkedNames([source], isFacebookProfileHref) : [];
  const media = mediaOf(root);
  const id = postIdFrom(root, author.name ?? '', text, media);
  const permalink = permalinkOf(root);
  const sharedLink = sharedLinkOf(root);
  const post: PostData = {
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
    quality: {
      authorFound: !!author.name,
      textFound: text.length > 0 || media !== 'none',
      // In memory only, never sent: two posts with the same near-miss label raise `ad-label-near-miss`.
      ...(ads.near ? { adNearMiss: cyrb53(ads.near.label) } : {}),
      ...(context.length ? { headerKnown: known.length > 0, headerUnknown } : {}),
    },
  };
  return { post, observations: [...observations] };
}
