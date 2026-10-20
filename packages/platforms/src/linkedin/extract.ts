import { atLeast, cyrb53, type Evidence, type ModuleInfo, NO_SIGNALS, type PostData, signalStrength } from '@unalgorithm/core';
import type { MediaKind, PostKey } from '@unalgorithm/protocol';
import {
  accessibleName,
  ageToHours,
  getLines,
  linkDomain,
  linkedNames,
  outermost,
  richText,
  textOf,
  walkText,
} from '../shared/dom.ts';
import { type LabelHit, labelStrength, matchLabel } from '../shared/labels.ts';
import type { LinkedInMarkers } from './markers/en.ts';
import { CARD_KEY_PREFIX, FEED_TYPE_SUFFIX, POST_ROOT_SELECTOR, POST_URN_RE, SEL, URN_ATTRIBUTES } from './selectors.ts';
import { isInCommentsArea, type PostHead, readHead, slotObservations, startsWithName } from './slots.ts';

const ORIGIN = 'https://www.linkedin.com';

/** Drop the "… more" button label LinkedIn renders inside clamped text boxes. */
const stripMore = (t: string) => t.replace(/\s*(?:…|\.{3})\s*(?:see\s+)?more\s*$/i, '').trim();

/** Top-level feed items that look like posts (outermost only, so a reshared inner post is not separate). */
export function findPostRoots(root: ParentNode): HTMLElement[] {
  return outermost(Array.from(root.querySelectorAll<HTMLElement>(POST_ROOT_SELECTOR)));
}

/** Visible lines without the screen-reader "Feed post" heading the 2026 feed puts first. */
export function contentLines(root: Element, m: LinkedInMarkers): string[] {
  const lines = getLines(root);
  return lines.length && lines[0] && m.cardHeading.test(lines[0]) ? lines.slice(1) : lines;
}

/**
 * The card's opaque key, without the feed's sort that the "For you" feed appends ("…FeedType_MAIN_FEED_RELEVANCE"),
 * so a post keeps its id whichever way the feed is sorted.
 */
function cardKey(root: Element): string | undefined {
  const key = root.getAttribute('componentkey');
  return key?.startsWith(CARD_KEY_PREFIX) ? key.slice(CARD_KEY_PREFIX.length).replace(FEED_TYPE_SUFFIX, '') : undefined;
}

function permalinkUrn(root: Element): string | undefined {
  const link = root.querySelector<HTMLAnchorElement>('a[href*="/feed/update/urn"]');
  return POST_URN_RE.exec(decodeURIComponent(link?.getAttribute('href') ?? ''))?.[0];
}

export type HeaderKind = 'suggested' | 'activity' | 'repost' | null;

interface HeaderRead {
  kind: Exclude<HeaderKind, null>;
  strength: 'strong' | 'medium';
  /** The suggested label was a near miss ("Suggested by your network"). */
  near?: boolean;
}

/** What a header line says about why the post is shown, and how sure that is. Only ever given header lines. */
function readHeaderLine(line: string, m: LinkedInMarkers): HeaderRead | null {
  // A header line is short; a long one is post text, and capping it keeps the patterns below linear.
  const t = line.slice(0, 300).replace(/\s+/g, ' ').trim();
  const suggested = matchLabel(t, m.labels.suggested);
  if (suggested)
    return { kind: 'suggested', strength: labelStrength(suggested), ...(suggested.match === 'near' ? { near: true } : {}) };
  if (m.repost.test(t)) return { kind: 'repost', strength: 'strong' };
  if (m.followedBy.test(t) || m.activity.test(t)) return { kind: 'activity', strength: 'strong' };
  return null;
}

/** The kind of a header line above the author ("Jane likes this", "Followed by Jane", "Suggested"), if it is one. */
export function classifyHeader(text: string | undefined, m: LinkedInMarkers): HeaderKind {
  return text ? (readHeaderLine(text, m)?.kind ?? null) : null;
}

const HEADER_SIGNAL = { suggested: 'suggested', activity: 'networkActivity', repost: 'reshare' } as const;

/** A Follow button among the post's head buttons ("Follow Jane Doe", "+ Follow"); never one inside a reshared post. */
function hasFollowButton(head: PostHead, m: LinkedInMarkers): boolean {
  return head.buttons.some((b) => {
    const label = b.getAttribute('aria-label')?.trim() ?? '';
    return m.followAria.test(label) || matchLabel(getLines(b).join(' '), m.labels.follow)?.match === 'exact';
  });
}

function extractGroup(root: Element, m: LinkedInMarkers): PostData['group'] {
  const link = Array.from(root.querySelectorAll(`${m.groupLinkSelector}, ${SEL.groupLink}`)).find((a) => !isInCommentsArea(a));
  if (!link) return undefined;
  const name = m.groupLabel.exec(link.getAttribute('aria-label')?.trim() ?? '')?.[1]?.trim() || getLines(link)[0];
  const join = Array.from(root.querySelectorAll('button, a')).some((b) => {
    if (isInCommentsArea(b)) return false;
    return m.joinAria.test(b.getAttribute('aria-label')?.trim() ?? '') || m.joinButton.test(getLines(b).join(' '));
  });
  return { ...(name ? { name } : {}), joined: !join };
}

interface Actor {
  name: string;
  url?: string;
  degree?: string;
  isCompany: boolean;
}

/** The author's name from the post's menu button ("Open control menu for post by Jane Doe"). */
export function nameFromMenu(root: Element, m: LinkedInMarkers): string | undefined {
  const label = root.querySelector(m.authorMenuSelector)?.getAttribute('aria-label');
  return label?.replace(m.authorMenuPrefix, '').trim() || undefined;
}

function extractActor(root: Element, header: string | undefined, lines: string[], m: LinkedInMarkers): Actor {
  const menuName = nameFromMenu(root, m);
  const titleEl = root.querySelector(SEL.actorTitle);
  const profileLinks = Array.from(root.querySelectorAll<HTMLAnchorElement>(SEL.profileLink)).filter((a) => !isInCommentsArea(a));
  const linkEl =
    root.querySelector<HTMLAnchorElement>(SEL.actorLink) ??
    (menuName
      ? profileLinks.find((a) => (a.getAttribute('aria-label') ?? '').includes(menuName) || getLines(a)[0] === menuName)
      : undefined) ??
    profileLinks.find((a) => {
      const t = getLines(a).join(' ');
      return t.length > 0 && !header?.includes(t); // skip the header's link to whoever liked it
    });
  const href = linkEl?.getAttribute('href') ?? undefined;
  const url = href ? new URL(href, ORIGIN).href.split('?')[0] : undefined;
  const isCompany = !!url && /\/(company|showcase|school)\//.test(url);

  let name = menuName ?? '';
  let titleText = '';
  if (titleEl) {
    titleText = getLines(titleEl).join(' ');
    const visible = titleEl.querySelector('[aria-hidden="true"]');
    if (!name) name = (visible ? getLines(visible)[0] : getLines(titleEl)[0]) ?? '';
  } else if (linkEl && !name) {
    titleText = getLines(linkEl).join(' ');
    name = getLines(linkEl)[0] ?? '';
  }
  name = name
    .replace(/\s*•.*$/, '')
    .replace(m.degree, '')
    .trim();

  const actorLabel = name
    ? Array.from(root.querySelectorAll('[aria-label]'))
        .map((e) => e.getAttribute('aria-label') ?? '')
        .find((l) => l.startsWith(name) && (/\b(1st|2nd|3rd\+?)\s*$/.test(l) || m.followingLabel.test(l)))
    : undefined;
  let degree = m.degree.exec(textOf(root, SEL.actorSupplementary) ?? titleText)?.[1] ?? m.degree.exec(actorLabel ?? '')?.[1];
  if (!degree) {
    const nameIdx = name ? lines.findIndex((l) => l.startsWith(name)) : -1;
    const near = nameIdx >= 0 ? lines.slice(nameIdx, nameIdx + 3) : lines.slice(0, 10);
    const line = near.find((l) => /^•?\s*(1st|2nd|3rd\+?)$/.test(l) || (!!name && l.startsWith(name) && m.degree.test(l)));
    degree = line ? m.degree.exec(line)?.[1] : undefined;
    // Someone you follow without being connected: "• Following" where the degree would be.
    if (!degree && (m.followingLabel.test(actorLabel ?? '') || near.some((l) => m.followingBadge.test(l)))) degree = 'following';
  }
  return { name, ...(url ? { url } : {}), ...(degree ? { degree } : {}), isCompany };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "3h", "Yesterday", "Oct 5" (as shown next to the author) to age in hours. */
export function parseAge(line: string, m: LinkedInMarkers, now = new Date()): { text: string; hours?: number } | undefined {
  const rel = m.age.exec(line);
  if (rel?.[1] && rel[2]) return { text: `${rel[1]}${rel[2]}`, hours: ageToHours(Number(rel[1]), rel[2]) };
  const word = m.ageWord.exec(line);
  if (word?.[1]) {
    const w = word[1].toLowerCase();
    return { text: word[1], hours: w === 'yesterday' ? 24 : w === 'today' ? 6 : 0 };
  }
  const date = m.ageDate.exec(line);
  if (date?.[1] && date[2]) {
    const month = MONTHS.indexOf(date[1].slice(0, 3).toLowerCase());
    let when = new Date(date[3] ? Number(date[3]) : now.getFullYear(), month, Number(date[2]));
    if (!date[3] && when.getTime() > now.getTime()) when = new Date(now.getFullYear() - 1, month, Number(date[2]));
    return {
      text: (line.includes('•') ? line.slice(0, line.indexOf('•')) : line).trim(),
      hours: Math.max(0, Math.round((now.getTime() - when.getTime()) / 3_600_000)),
    };
  }
  return undefined;
}

/** The age anywhere near the top: only for a post whose head has no age slot (a layout we can't read the head of). */
function ageNearTop(root: Element, lines: string[], m: LinkedInMarkers, now: Date) {
  const sources = [textOf(root, SEL.actorSubDescription), ...lines.slice(0, 14)].filter((s): s is string => !!s);
  for (const s of sources) {
    const age = parseAge(s, m, now);
    if (age) return age;
  }
  return undefined;
}

/** The post's own text boxes, never the comments under it. */
function textBoxes(root: Element): Element[] {
  return outermost(Array.from(root.querySelectorAll(SEL.text))).filter((el) => !isInCommentsArea(el));
}

/** Not post text: the comment list, the comment editor and the action bar. */
const NOT_POST_TEXT = `${SEL.commentsArea}, [contenteditable="true"], [role="textbox"]`;

function extractText(root: Element, m: LinkedInMarkers): { text: string; mentions: string[] } {
  // LinkedIn keeps the full text in the DOM and only clamps it visually; drop the "… more" label from the end.
  const boxes = textBoxes(root);
  const blocks = boxes.map((el) => stripMore(richText(el))).filter(Boolean);
  const unique = [...new Set(blocks)];
  if (unique.length) {
    const text = unique.length === 1 ? (unique[0] ?? '') : `${unique[0]}\n\n[Shared post]\n${unique.slice(1).join('\n\n')}`;
    return { text, mentions: linkedNames(boxes, isProfileHref) };
  }
  // No text box (image, video or poll posts on some layouts). Read only what comes after the post's age line, so the
  // author's name and headline and the group name are never taken for post text, and skip the comments, the comment
  // editor and the action bar, so other people's words are never read as the post. No age line: no text.
  const lines = walkText(root, `${NOT_POST_TEXT}, ${m.actionBarSelector}`)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const ageAt = lines.findIndex((l) => parseAge(l, m) !== undefined);
  if (ageAt < 0) return { text: '', mentions: [] };
  const text = lines
    .slice(ageAt + 1)
    .filter((l) => l.length > 40)
    .join('\n')
    .slice(0, 4000);
  // Tagged people in that text: any profile link on the card whose name appears in it.
  const mentions = text ? linkedNames([root], isProfileHref).filter((n) => text.includes(n)) : [];
  return { text, mentions };
}

const PROFILE_HREF = /(?:^|linkedin\.com)\/(?:in|company|school|showcase)\//;
const isProfileHref = (href: string) => PROFILE_HREF.test(href);

function extractMedia(root: Element): MediaKind {
  if (Array.from(root.querySelectorAll(SEL.eventLink)).some((a) => !isInCommentsArea(a))) return 'event';
  if (root.querySelector(SEL.video)) return 'video';
  if (root.querySelector(SEL.document)) return 'document';
  if (root.querySelector(SEL.poll)) return 'poll';
  if (root.querySelector(SEL.article)) return 'link';
  if (root.querySelector(SEL.image)) return 'image';
  return 'none';
}

/** First link in the post that leads off LinkedIn (a shared article), for UnEcho Chamber later. */
function extractSharedLink(root: Element): PostData['sharedLink'] {
  for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    if (isInCommentsArea(a)) continue;
    const href = a.getAttribute('href') ?? '';
    const domain = linkDomain(href, ORIGIN);
    if (!domain || /(^|\.)linkedin\.com$|^lnkd\.in$/.test(domain)) continue;
    const title = getLines(a)[0];
    return { url: new URL(href, ORIGIN).href, domain, ...(title && title.length > 3 ? { title: title.slice(0, 300) } : {}) };
  }
  return undefined;
}

/** The 2026 card's screen-reader heading ("Feed post"), which posts and feed panels both have. */
function hasCardHeading(el: Element, m: LinkedInMarkers): boolean {
  return Array.from(el.querySelectorAll('h2, h3, [role="heading"]'))
    .slice(0, 3)
    .some((h) => m.cardHeading.test(getLines(h).join(' ')));
}

/**
 * Feed modules (People You May Know, jobs, games...) that are not posts. Needs positive evidence: a known module
 * title, or a 2026 card (its key or its "Feed post" heading) with content but no author menu, no post text and no action
 * bar (every real post has Like/Comment/Repost buttons, even image-only ones).
 */
export function moduleInfo(el: Element, m: LinkedInMarkers): ModuleInfo | undefined {
  const lines = contentLines(el, m);
  const titled = lines.slice(0, 2).find((l) => m.module.test(l));
  if (titled) return { kind: moduleKind(titled), title: titled };
  if (
    (cardKey(el) || hasCardHeading(el, m)) &&
    lines.length &&
    !el.querySelector(m.authorMenuSelector) &&
    !el.querySelector(SEL.text) &&
    !el.querySelector(m.actionBarSelector)
  ) {
    return { kind: 'promo', ...(lines[0] ? { title: lines[0] } : {}) };
  }
  return undefined;
}

function moduleKind(title: string): ModuleInfo['kind'] {
  const t = title.toLowerCase();
  if (t.includes('people you may know')) return 'people-you-may-know';
  if (t.includes('job') || t.includes('hiring')) return 'jobs';
  if (t.includes('game') || t.includes('puzzle')) return 'games';
  if (t.includes('group')) return 'groups';
  if (t.includes('page')) return 'pages';
  if (t.includes('newsletter')) return 'newsletters';
  return 'other';
}

/**
 * Stable id. Older layouts carry the URN in data attributes; the 2026 feed has none, but its card key is stable
 * across reloads. Last resort: a hash of the author and the start of the text (never ages or counts, which change).
 */
export function postId(root: Element, actorName: string, text: string): PostKey {
  const key = cardKey(root);
  if (key) return `li:${permalinkUrn(root) ?? `ck:${key}`}`;
  for (const attr of URN_ATTRIBUTES) {
    const hit = POST_URN_RE.exec(root.getAttribute(attr) ?? '');
    if (hit) return `li:${hit[0]}`;
  }
  for (const attr of URN_ATTRIBUTES) {
    const inner = root.querySelector(`[${attr}*="urn:li:"]`);
    const hit = POST_URN_RE.exec(inner?.getAttribute(attr) ?? '');
    if (hit) return `li:${hit[0]}`;
  }
  const link = permalinkUrn(root);
  if (link) return `li:${link}`;
  return `li:h:${cyrb53(`${actorName}\u0000${text.slice(0, 200)}`)}`;
}

function permalinkFor(id: string, actorUrl: string | undefined): string | undefined {
  const urn = id.slice(3);
  if (urn.startsWith('urn:li:')) return `${ORIGIN}/feed/update/${urn}/`;
  if (actorUrl) {
    const base = actorUrl.endsWith('/') ? actorUrl : `${actorUrl}/`;
    return /\/in\//.test(base) ? `${base}recent-activity/all/` : `${base}posts/`;
  }
  return undefined;
}

/** Ad labels found in the post's label positions: the strong ones by position, and the first near miss. */
interface AdLabels {
  strong: Array<'li.promoted.age-slot' | 'li.promoted.header' | 'li.promoted.actor'>;
  /** The first near-miss label, normalised (its in-memory hash feeds `ad-label-near-miss`). */
  near?: string;
  /** What the age slot itself matched, if anything. */
  slot: LabelHit | null;
}

/**
 * Read "Promoted" where LinkedIn puts it (ADR 0009 §9): the age slot, header lines, the author's block (not the
 * author's own name) and the accessible names of the head's buttons. Never post text, comments or reshared posts.
 *
 * The author's block also holds their headline, which may start with a label word ("Sponsored Products Manager at
 * Amazon", "Sponsored by Specialized | Pro cyclist"), so a line there other than the age slot counts only as a label
 * would read: the bare label, or the label and a separator ("Promoted • Partnership with LinkedIn", moved up a line).
 * Otherwise a known tail would hide a member's post, and a near miss shared by two of their posts would say ads are
 * getting through on a healthy feed.
 */
function readAdLabels(head: PostHead, author: string, m: LinkedInMarkers): AdLabels {
  const out: AdLabels = { strong: [], slot: null };
  const read = (text: string, at: AdLabels['strong'][number], labelOnly = false) => {
    const hit = matchLabel(text, m.labels.promoted);
    if (!hit || (labelOnly && hit.match !== 'exact' && !hit.separated)) return null;
    if (hit.match !== 'near') {
      if (!out.strong.includes(at)) out.strong.push(at);
    } else out.near ??= hit.label;
    return hit;
  };
  if (head.ageSlot !== undefined) out.slot = read(head.ageSlot, 'li.promoted.age-slot');
  for (const line of head.header) read(line, 'li.promoted.header');
  for (const line of head.actor)
    if (line !== head.ageSlot && !startsWithName(line, author)) read(line, 'li.promoted.actor', true);
  for (const button of head.buttons) read(accessibleName(button), 'li.promoted.header');
  return out;
}

/** One post as read, and what was noticed on the way (registry observation ids, never content). */
export interface ReadPost {
  post: PostData;
  observations: string[];
}

/** Read one LinkedIn post. Read-only: never clicks, scrolls or changes the page. */
export function readPost(root: HTMLElement, m: LinkedInMarkers, now = new Date()): ReadPost {
  const lines = contentLines(root, m);
  const head = readHead(root, m, nameFromMenu(root, m));
  const actor = extractActor(root, head.header.join(' ') || undefined, lines, m);
  const { text, mentions } = extractText(root, m);
  const id = postId(root, actor.name, text);
  const evidence: Evidence[] = [];
  const observations = new Set<string>();
  /** One entry per detector, at its strongest. */
  const add = (e: Evidence) => {
    const at = evidence.findIndex((x) => x.detector === e.detector);
    if (at < 0) evidence.push(e);
    else if (atLeast(e.strength, (evidence[at] as Evidence).strength)) evidence[at] = e;
  };

  // Ads: a label where LinkedIn puts it. A near miss is medium evidence, and with no post age (weak) it still hides.
  const ads = readAdLabels(head, actor.name, m);
  for (const detector of ads.strong) add({ signal: 'sponsored', detector, strength: 'strong' });
  if (ads.near !== undefined && !ads.strong.length) {
    add({ signal: 'sponsored', detector: 'li.promoted.near', strength: 'medium' });
    observations.add('li.label.promoted.near');
  }
  const slotAge = head.ageSlot !== undefined ? parseAge(head.ageSlot, m, now) : undefined;
  // With an age slot, its line is the post's age; a headline such as "3D printing" is never read as one.
  const age = head.ageSlot !== undefined ? slotAge : ageNearTop(root, lines, m, now);
  if (head.ageSlot !== undefined && !age && !ads.strong.length)
    add({ signal: 'sponsored', detector: 'li.age-slot.no-age', strength: 'weak' });
  if (head.ageSlot !== undefined && !slotAge && !ads.slot) observations.add('li.slot.age.unrecognised');

  // Header lines: why LinkedIn shows the post. One it doesn't recognise is counted, never guessed at.
  let contextLine: string | undefined;
  let headerKnown = false;
  let headerUnknown = false;
  for (const line of head.header) {
    const why = readHeaderLine(line, m);
    if (why || matchLabel(line, m.labels.promoted)) headerKnown = true;
    else headerUnknown = true;
    if (!why) continue;
    contextLine ??= line;
    if (why.near) observations.add('li.label.suggested.near');
    add({ signal: HEADER_SIGNAL[why.kind], detector: `li.header.${why.kind}`, strength: why.strength });
  }
  if (headerUnknown) observations.add('li.header.unknown');

  const follow = hasFollowButton(head, m);
  const relationship = follow
    ? 'not-followed'
    : actor.degree === '1st' || actor.degree === 'following' || (actor.isCompany && !!actor.url)
      ? 'followed'
      : 'unknown';
  if (follow) add({ signal: 'relationship', detector: 'li.follow-button', strength: 'strong' });

  const group = extractGroup(root, m);
  if (group && !group.joined) add({ signal: 'unjoinedGroup', detector: 'li.group.join-button', strength: 'strong' });

  const shows = (signal: Evidence['signal']) => atLeast(signalStrength(evidence, signal), 'medium');
  const sponsored = shows('sponsored');
  // Looks like an ad without its label: LinkedIn shows no age on ads, and asks you to follow their author.
  const adCue = !age && follow && !sponsored;
  if (adCue) observations.add('li.ad-cue');

  // Which locators found the post's parts: a later one means LinkedIn's markup moved on (ADR 0009 §9, phase B).
  for (const o of slotObservations(head.found)) observations.add(o);
  if (!head.found.text && text) observations.add('li.slot.text.structure');

  const sharedLink = extractSharedLink(root);
  const found = actor.name.length > 0;
  const post: PostData = {
    id,
    platform: 'linkedin',
    ...(permalinkFor(id, actor.url) ? { permalink: permalinkFor(id, actor.url) } : {}),
    author: {
      ...(found ? { name: actor.name } : {}),
      ...(actor.url ? { url: actor.url } : {}),
      kind: !found ? 'unknown' : actor.isCompany ? 'page' : 'person',
      relationship,
    },
    ...(group ? { group } : {}),
    ...(contextLine ? { contextLine } : {}),
    signals: {
      ...NO_SIGNALS,
      sponsored,
      suggested: shows('suggested'),
      networkActivity: shows('networkActivity'),
      reshare: shows('reshare'),
      unjoinedGroup: shows('unjoinedGroup'),
    },
    evidence,
    text,
    textComplete: true,
    ...(mentions.length ? { mentions } : {}),
    media: extractMedia(root),
    ...(sharedLink ? { sharedLink } : {}),
    ...(age ? { age } : {}),
    quality: {
      authorFound: found,
      textFound: text.length > 0,
      ...(ads.near !== undefined && !ads.strong.length ? { adNearMiss: cyrb53(ads.near) } : {}),
      ...(adCue ? { adCue } : {}),
      ...(headerKnown ? { headerKnown } : {}),
      ...(headerUnknown ? { headerUnknown } : {}),
    },
  };
  return { post, observations: [...observations] };
}

/** Read one LinkedIn post (`readPost` without what was noticed). Read-only. */
export function extractPost(root: HTMLElement, m: LinkedInMarkers, now = new Date()): PostData {
  return readPost(root, m, now).post;
}
