import { cyrb53, type Evidence, type ModuleInfo, NO_SIGNALS, type PostData } from '@unalgorithm/core';
import type { MediaKind, PostKey } from '@unalgorithm/protocol';
import {
  ageToHours,
  getLines,
  hasTextNode,
  linkDomain,
  linkedNames,
  outermost,
  precedes,
  richText,
  textOf,
  walkText,
} from '../shared/dom.ts';
import type { LinkedInMarkers } from './markers/en.ts';
import { CARD_KEY_PREFIX, POST_ROOT_SELECTOR, POST_URN_RE, SEL, URN_ATTRIBUTES } from './selectors.ts';

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

function cardKey(root: Element): string | undefined {
  const key = root.getAttribute('componentkey');
  return key?.startsWith(CARD_KEY_PREFIX) ? key.slice(CARD_KEY_PREFIX.length) : undefined;
}

function permalinkUrn(root: Element): string | undefined {
  const link = root.querySelector<HTMLAnchorElement>('a[href*="/feed/update/urn"]');
  return POST_URN_RE.exec(decodeURIComponent(link?.getAttribute('href') ?? ''))?.[0];
}

function isInCommentsArea(el: Element): boolean {
  return !!el.closest(SEL.commentsArea);
}

export type HeaderKind = 'suggested' | 'activity' | 'repost' | null;

export function classifyHeader(text: string | undefined, m: LinkedInMarkers): HeaderKind {
  if (!text) return null;
  const t = text.replace(/\s+/g, ' ').trim();
  if (m.suggested.test(t)) return 'suggested';
  if (m.repost.test(t)) return 'repost';
  if (m.followedBy.test(t)) return 'activity';
  if (m.activity.test(t)) return 'activity';
  return null;
}

/** Header line above the actor ("Jane likes this", "Followed by Jane", "Suggested"), only if it is one. */
function findHeader(root: Element, lines: string[], m: LinkedInMarkers): string | undefined {
  const fromClass = textOf(root, SEL.header);
  if (fromClass && classifyHeader(fromClass, m)) return fromClass;
  const first = lines[0];
  if (first && (classifyHeader(first, m) || m.promoted.test(first))) return first;
  return undefined;
}

/** The first text box of the post itself (not of a reshared post or a comment). */
function firstTextBox(root: Element): Element | undefined {
  return Array.from(root.querySelectorAll(SEL.text)).find((el) => !isInCommentsArea(el));
}

/**
 * Buttons that belong to the post's own header: before the post text in page order and outside comments.
 * A reshared post inside the card has its own actor and Follow button after the outer text, which must not count.
 */
function headerButtons(root: Element, m: LinkedInMarkers): Element[] {
  const text = firstTextBox(root);
  const bar = Array.from(root.querySelectorAll(m.actionBarSelector)).find((el) => !isInCommentsArea(el));
  const limit = text ?? bar;
  return Array.from(root.querySelectorAll('button, [role="button"]')).filter(
    (b) => !isInCommentsArea(b) && (!limit || precedes(b, limit)),
  );
}

function hasFollowButton(root: Element, m: LinkedInMarkers): boolean {
  return headerButtons(root, m).some((b) => {
    const label = b.getAttribute('aria-label')?.trim() ?? '';
    return m.followAria.test(label) || m.followButton.test(getLines(b).join(' '));
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

function nameFromMenu(root: Element, m: LinkedInMarkers): string | undefined {
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
        .find((l) => l.startsWith(name) && /\b(1st|2nd|3rd\+?)\s*$/.test(l))
    : undefined;
  let degree = m.degree.exec(textOf(root, SEL.actorSupplementary) ?? titleText)?.[1] ?? m.degree.exec(actorLabel ?? '')?.[1];
  if (!degree) {
    const nameIdx = name ? lines.findIndex((l) => l.startsWith(name)) : -1;
    const near = nameIdx >= 0 ? lines.slice(nameIdx, nameIdx + 3) : lines.slice(0, 10);
    const line = near.find((l) => /^•?\s*(1st|2nd|3rd\+?)$/.test(l) || (!!name && l.startsWith(name) && m.degree.test(l)));
    degree = line ? m.degree.exec(line)?.[1] : undefined;
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
      text: line.replace(/\s*•.*$/, '').trim(),
      hours: Math.max(0, Math.round((now.getTime() - when.getTime()) / 3_600_000)),
    };
  }
  return undefined;
}

function extractAge(root: Element, lines: string[], m: LinkedInMarkers, now: Date) {
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

/** First link in the post that leads off LinkedIn (a shared article), for "Other perspectives" later. */
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

/**
 * Feed modules (People You May Know, jobs, games...) that are not posts. Needs positive evidence: a known module
 * title, or a 2026 card with content but no author menu, no post text and no action bar (every real post has
 * Like/Comment/Repost buttons, even image-only ones).
 */
export function moduleInfo(el: Element, m: LinkedInMarkers): ModuleInfo | undefined {
  const lines = contentLines(el, m);
  const titled = lines.slice(0, 2).find((l) => m.module.test(l));
  if (titled) return { kind: moduleKind(titled), title: titled };
  if (
    cardKey(el) &&
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

/** Read one LinkedIn post. Read-only: never clicks, scrolls or changes the page. */
export function extractPost(root: HTMLElement, m: LinkedInMarkers, now = new Date()): PostData {
  const lines = contentLines(root, m);
  const header = findHeader(root, lines, m);
  const actor = extractActor(root, header, lines, m);
  const { text, mentions } = extractText(root, m);
  const id = postId(root, actor.name, text);
  const evidence: Evidence[] = [];

  const sponsoredLine = lines.slice(0, 16).some((l) => m.promoted.test(l));
  const sponsored = sponsoredLine || hasTextNode(root, m.promoted, 300);
  if (sponsored)
    evidence.push({ signal: 'sponsored', detector: sponsoredLine ? 'li.promoted.line' : 'li.promoted.text', strength: 'strong' });

  const kind = header && !m.promoted.test(header) ? classifyHeader(header, m) : null;
  if (kind === 'suggested') evidence.push({ signal: 'suggested', detector: 'li.header.suggested', strength: 'strong' });
  if (kind === 'activity') evidence.push({ signal: 'networkActivity', detector: 'li.header.activity', strength: 'strong' });
  if (kind === 'repost') evidence.push({ signal: 'reshare', detector: 'li.header.repost', strength: 'strong' });

  const follow = hasFollowButton(root, m);
  const relationship = follow
    ? 'not-followed'
    : actor.degree === '1st' || (actor.isCompany && !!actor.url)
      ? 'followed'
      : 'unknown';
  if (follow) evidence.push({ signal: 'relationship', detector: 'li.follow-button', strength: 'strong' });

  const group = extractGroup(root, m);
  if (group && !group.joined) evidence.push({ signal: 'unjoinedGroup', detector: 'li.group.join-button', strength: 'strong' });

  const age = extractAge(root, lines, m, now);
  const sharedLink = extractSharedLink(root);
  const found = actor.name.length > 0;
  return {
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
    ...(header && !m.promoted.test(header) ? { contextLine: header } : {}),
    signals: {
      ...NO_SIGNALS,
      sponsored,
      suggested: kind === 'suggested',
      networkActivity: kind === 'activity',
      reshare: kind === 'repost',
      unjoinedGroup: !!group && !group.joined,
    },
    evidence,
    text,
    textComplete: true,
    ...(mentions.length ? { mentions } : {}),
    media: extractMedia(root),
    ...(sharedLink ? { sharedLink } : {}),
    ...(age ? { age } : {}),
    quality: { authorFound: found, textFound: text.length > 0 },
  };
}
