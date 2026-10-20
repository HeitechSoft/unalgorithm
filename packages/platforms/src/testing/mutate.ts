import type { PlatformId } from '@unalgorithm/protocol';
import type { PlatformAdapter } from '../types.ts';
import {
  GOLDEN_PRESETS,
  type GoldenRead,
  type GoldenResult,
  type GoldenSetup,
  judgeGolden,
  type MountedGolden,
  mountGolden,
  readGolden,
} from './golden.ts';

/**
 * The mutation suite (ADR 0009 §9, phase C): each golden page is changed the ways a platform might change it (markup,
 * labels, addresses) and the ways it might trick a careless reader (false positives), then read again. Each run gets a
 * verdict:
 *
 * - `survived`: every row is decided as before, on every preset;
 * - `flagged`: some decisions changed, and health or a report-only issue or observation says so, so reports tell us;
 * - `silent`: decisions changed and nothing says so (CI fails);
 * - `over-hide`: a row that was shown is now hidden (CI fails): hiding a wanted post costs more trust than showing an ad.
 *
 * A mutation that changes nothing on a page (`apply` returns 0, or `route` returns null) is skipped there.
 */

/** What a mutation may do to decisions: nothing at all; change them only if something says so; or hide more. */
export type MutationExpect = 'same' | 'same-or-flagged' | 'may-hide-more';
export type Verdict = 'survived' | 'flagged' | 'silent' | 'over-hide';

export interface Mutation {
  id: string;
  /** What it does, in a few words, for the verdict matrix. */
  title: string;
  group: 'markup' | 'label' | 'false-positive' | 'route';
  platforms: readonly PlatformId[];
  expect: MutationExpect;
  /**
   * Change the page; `list` is the golden's feed list. Returns how many nodes it changed (0: nothing to change on this
   * page, skipped).
   */
  apply?(doc: Document, list: Element, platform: PlatformId): number;
  /** Move the page to another address; null when this one has no such move. */
  route?(url: URL): URL | null;
}

const BOTH: readonly PlatformId[] = ['linkedin', 'facebook'];
const LINKEDIN: readonly PlatformId[] = ['linkedin'];
const FACEBOOK: readonly PlatformId[] = ['facebook'];

/** A post's own text box, on either platform (older and 2026 markup). */
const TEXT_BOX =
  '[data-testid="expandable-text-box"], .update-components-text, [data-view-name="feed-commentary"], [data-ad-preview="message"], [data-ad-comet-preview="message"]';
/** Comments, on either platform. */
const COMMENTS = '[data-testid*="commentList"], .comments-comments-list, [role="article"], [aria-label^="Comment by"]';
/** Where a label never is: a post's text and its comments. */
const NOT_A_LABEL = `${TEXT_BOX}, ${COMMENTS}`;
/** The words of an ad label, as a label starts. */
const AD_HEAD = /^(Promoted|Sponsored|Ad)(?![\p{L}\p{N}])/u;
/** Every label a mutation plays with. */
const LABEL_HEAD = /^(Promoted|Sponsored|Ad|Suggested|Follow)(?![\p{L}\p{N}])/u;
/**
 * A post's age as each platform shows it ("3h", "3h • Edited", "Yesterday", "9 hours ago"), and as the 2026-10
 * capture script scrambled LinkedIn's ("0x").
 */
const AGE =
  /^(\d{1,2} ?(s|m|min|h|hr|d|w|mo|y|yr)\b|0{1,2}x\b|just now\b|yesterday\b|\d+ (minutes?|hours?|days?) ago$|an? (minute|hour|day) ago$)/i;
/** Label separators, each swapped for the next. */
const SEPARATORS = ['•', '·', '|', '—'] as const;
/** The words a false-positive probe writes where they are not labels. */
const PROBE_WORDS = ['Promoted', 'Sponsored by Example Labs', 'Suggested', 'Follow', 'Ad'] as const;
/** Real headlines that start with a label word: one with a label's known tail, one a near miss would match. */
const PROBE_HEADLINES = ['Sponsored by Example Labs | Pro cyclist', 'Sponsored Products Manager at Example Labs'] as const;
/** A link to a person's or a page's profile: the author's name line. */
const PROFILE_LINK = 'a[href*="/in/"], a[href*="/company/"], a[href*="/school/"], a[href*="/showcase/"]';
/** Sentences of network activity and reposts, by their verb. */
const HEADER_VERB =
  /(^|\s)(likes?|loves?|celebrates?|supports?|finds this|commented on|reacted to|replied to|reposted|shared|follows?)(?=\s|$|\.)/i;
const FOLLOWED_BY = /^Followed by\b/i;
/** LinkedIn's post menu, Repost and Send buttons by name, and what a redesign might call them instead. */
const MENU_NAMES: ReadonlyArray<[RegExp, string]> = [
  [/^Open control menu for post by /, 'Post options: '],
  [/^Hide post by /, 'Not interested: '],
  [/^Repost$/, 'Share again'],
  [/^Send( in a private message)?$/, 'Message'],
];
/** A short age as LinkedIn writes it ("3h", "2d • Edited"), and its unit in words. */
const SHORT_AGE = /^(\d{1,2}) ?(s|m|h|d|w|mo|yr|y)\b/;
const AGE_WORDS: Readonly<Record<string, string>> = {
  s: 'seconds',
  m: 'minutes',
  h: 'hours',
  d: 'days',
  w: 'weeks',
  mo: 'months',
  y: 'years',
  yr: 'years',
};
/** The action bar's buttons by name, on both platforms, and what a redesign might call them instead. */
const ACTION_NAMES: ReadonlyArray<[RegExp, string]> = [
  [/^Comment$/, 'Write a comment'],
  [/^Leave a comment$/, 'Write a comment'],
  [/^Repost$/, 'Share again'],
  [/^Send( in a private message)?$/, 'Message'],
  [/^Share\b.*/, 'Pass it on'],
  [/^React Like$/, 'Like it'],
  [/^Like$/, 'Like it'],
  [/^Reaction button state/, 'Reactions'],
];

/**
 * Text nodes under `root`, outside SVG. An SVG `<text>` (Facebook draws "Ad" and ages that way, and the capture script
 * copies them into the appendix, where they parse as plain `<text>` elements) is handled as a whole element.
 */
function textNodes(root: Node): Text[] {
  const doc = root.ownerDocument ?? (root as Document);
  const out: Text[] = [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.parentElement?.closest('svg, text')) out.push(n as Text);
  }
  return out;
}

/** Text in a label position: a short line outside post text and comments. */
function labelText(node: Text, max = 60): string | null {
  const text = (node.nodeValue ?? '').trim();
  if (!text || text.length > max || node.parentElement?.closest(NOT_A_LABEL)) return null;
  return text;
}

/** SVG `<text>` labels (Facebook draws "Ad" and ages that way), outside post text. */
function svgTexts(doc: Document): Element[] {
  return Array.from(doc.querySelectorAll('text')).filter((t) => !t.closest(NOT_A_LABEL));
}

/** Remove an attribute everywhere it appears. */
function dropAttribute(doc: Document, name: string): number {
  const els = Array.from(doc.body.querySelectorAll(`[${name}]`));
  for (const el of els) el.removeAttribute(name);
  return els.length;
}

/** A stable stand-in for a class name: the same name always gets the same hash. */
function rehash(token: string): string {
  let h = 0x811c9dc5;
  for (const c of token) h = Math.imul(h ^ (c.codePointAt(0) ?? 0), 0x01000193);
  return `h${(h >>> 0).toString(36)}`;
}

/** Wrap `el` in a new `div` and return the wrapper. */
function wrap(el: Element): Element {
  const wrapper = el.ownerDocument.createElement('div');
  el.replaceWith(wrapper);
  wrapper.append(el);
  return wrapper;
}

/** Visible text of an element without layout: hidden elements and SVG left out. */
function visibleText(el: Element): string {
  if (el.matches('[hidden], [data-ua-hidden], [aria-hidden="true"], svg')) return '';
  let out = '';
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType === Node.TEXT_NODE) out += c.nodeValue ?? '';
    else if (c.nodeType === Node.ELEMENT_NODE) out += visibleText(c as Element);
  }
  return out.trim();
}

/**
 * Drop every hook each platform's fast path keys on: LinkedIn's component keys, test ids, view names and list roles;
 * Facebook's data-ad-* hooks, post markers and feed role.
 */
function dropHooks(doc: Document): number {
  let n = 0;
  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const hook =
        ['componentkey', 'data-testid', 'data-view-name', 'data-sdui-screen', 'aria-posinset'].includes(attr.name) ||
        attr.name.startsWith('data-ad-') ||
        (attr.name === 'role' && ['list', 'listitem', 'feed'].includes(attr.value));
      if (!hook) continue;
      el.removeAttribute(attr.name);
      n++;
    }
  }
  return n;
}

/** The posts' text boxes, outermost, outside comments. */
function postTextBoxes(doc: Document): Element[] {
  return Array.from(doc.body.querySelectorAll(TEXT_BOX)).filter(
    (box) => !box.parentElement?.closest(TEXT_BOX) && !box.closest(COMMENTS),
  );
}

/**
 * Each post's age or ad label element (a text's parent, a slot link, an SVG label's link): the first one in each row
 * that is outside post text and comments.
 */
function ageOrLabel(row: Element): Element | null {
  for (const node of textNodes(row)) {
    const text = labelText(node);
    if (text && (AGE.test(text) || AD_HEAD.test(text)) && node.parentElement) return node.parentElement;
  }
  // Facebook's slot link: SVG text (or an aria-labelledby label) after the author's name.
  for (const a of Array.from(row.querySelectorAll('a'))) {
    if (a.closest(NOT_A_LABEL)) continue;
    if (a.querySelector('use, [aria-labelledby]') || /^(Sponsored|Ad)$/.test(a.getAttribute('aria-label') ?? '')) return a;
  }
  return null;
}

/**
 * The first text of a post's headline: the nearest line with text and no link above the post's age, in the author's
 * block (a link line such as "View my newsletter" is passed over), or null for a post without an age (an ad) or when
 * the author's name comes first.
 */
function headlineOf(row: Element): Text | null {
  const age = ageOrLabel(row);
  if (!age || !AGE.test(visibleText(age))) return null;
  for (let line: Element = age; line !== row && line.parentElement; line = line.parentElement) {
    for (let above = line.previousElementSibling; above; above = above.previousElementSibling) {
      if (!visibleText(above)) continue;
      if (above.matches(PROFILE_LINK) || above.querySelector(PROFILE_LINK)) return null;
      if (above.matches('a') || above.querySelector('a')) continue;
      return textNodes(above).find((t) => (t.nodeValue ?? '').trim()) ?? null;
    }
  }
  return null;
}

/** The line holding `el`, moved before the line above it in its block (the author's name, a headline). */
function moveLineUp(el: Element, row: Element): boolean {
  for (let line: Element | null = el; line && line !== row; line = line.parentElement) {
    let above = line.previousElementSibling;
    while (above && !visibleText(above)) above = above.previousElementSibling;
    if (above) {
      above.before(line);
      return true;
    }
  }
  return false;
}

/** The posts' "Comment" buttons (one per post-level action bar, the outermost element of each), outside comments. */
function commentButtons(doc: Document): Element[] {
  const found = Array.from(
    doc.body.querySelectorAll(
      'button[aria-label="Comment"], [role="button"][aria-label="Comment"], [aria-label="Leave a comment"], [data-ad-rendering-role="comment_button"]',
    ),
  ).filter((b) => !b.closest(COMMENTS));
  const set = new Set(found);
  return found.filter((b) => {
    for (let p = b.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
    return true;
  });
}

/** HTML for a comment by someone else holding `lines`, in each platform's comment markup. */
function commentHtml(lines: readonly string[], platform: PlatformId): string {
  const body = lines.map((l) => `<div data-ua-block="">${l}</div>`).join('');
  return platform === 'linkedin'
    ? `<div data-testid="x-commentList100999"><div><a href="https://www.linkedin.com/in/xxxx-xxxxx/"><p>Xxxx Xxxxx • 2nd</p></a><div data-testid="expandable-text-box"><span>${body}</span></div><button aria-label="Reply">Reply</button></div></div>`
    : `<div><ul><li><div role="article" aria-label="Comment by Xxxx Xxxxx"><a href="https://www.facebook.com/xxxx.xxxxx" role="link"><span>Xxxx Xxxxx</span></a><div dir="auto">${body}</div><div role="button" tabindex="0">Reply</div></div></li></ul></div>`;
}

/**
 * Every mutation, in the order the matrix shows them: markup, labels, false positives, addresses. Markup and label
 * changes may change decisions only if something says so; false-positive probes must change nothing.
 */
export const MUTATIONS: readonly Mutation[] = [
  // ---------- markup ----------
  {
    id: 'rehash-classes',
    title: 'every class name hashed anew',
    group: 'markup',
    platforms: BOTH,
    expect: 'same-or-flagged',
    apply(doc) {
      let n = 0;
      for (const el of Array.from(doc.body.querySelectorAll('[class]'))) {
        const tokens = Array.from(el.classList);
        if (!tokens.length) continue;
        el.setAttribute('class', tokens.map(rehash).join(' '));
        n++;
      }
      return n;
    },
  },
  {
    id: 'drop-componentkey',
    title: 'componentkey attributes dropped',
    group: 'markup',
    platforms: LINKEDIN,
    expect: 'same-or-flagged',
    apply: (doc) => dropAttribute(doc, 'componentkey'),
  },
  {
    id: 'drop-data-testid',
    title: 'data-testid attributes dropped',
    group: 'markup',
    platforms: LINKEDIN,
    expect: 'same-or-flagged',
    apply: (doc) => dropAttribute(doc, 'data-testid'),
  },
  {
    id: 'drop-data-view-name',
    title: 'data-view-name attributes dropped',
    group: 'markup',
    platforms: LINKEDIN,
    expect: 'same-or-flagged',
    apply: (doc) => dropAttribute(doc, 'data-view-name'),
  },
  {
    id: 'drop-data-sdui-screen',
    title: 'data-sdui-screen attributes dropped',
    group: 'markup',
    platforms: LINKEDIN,
    expect: 'same-or-flagged',
    apply: (doc) => dropAttribute(doc, 'data-sdui-screen'),
  },
  {
    id: 'drop-data-ad',
    title: "Facebook's data-ad-* hooks dropped",
    group: 'markup',
    platforms: FACEBOOK,
    expect: 'same-or-flagged',
    apply(doc) {
      let n = 0;
      for (const el of Array.from(doc.body.querySelectorAll('*'))) {
        for (const attr of Array.from(el.attributes)) {
          if (!attr.name.startsWith('data-ad-')) continue;
          el.removeAttribute(attr.name);
          n++;
        }
      }
      return n;
    },
  },
  {
    id: 'drop-aria-posinset',
    title: 'aria-posinset dropped',
    group: 'markup',
    platforms: FACEBOOK,
    expect: 'same-or-flagged',
    apply: (doc) => dropAttribute(doc, 'aria-posinset'),
  },
  {
    id: 'drop-role-feed',
    title: 'role="feed" dropped',
    group: 'markup',
    platforms: FACEBOOK,
    expect: 'same-or-flagged',
    apply(doc) {
      const els = Array.from(doc.body.querySelectorAll('[role="feed"]'));
      for (const el of els) el.removeAttribute('role');
      return els.length;
    },
  },
  {
    id: 'drop-role-listitem',
    title: 'role="listitem" dropped',
    group: 'markup',
    platforms: LINKEDIN,
    expect: 'same-or-flagged',
    apply(doc) {
      const els = Array.from(doc.body.querySelectorAll('[role="listitem"]'));
      for (const el of els) el.removeAttribute('role');
      return els.length;
    },
  },
  {
    id: 'rename-card-key',
    title: 'the update-card-focus key prefix renamed',
    group: 'markup',
    platforms: LINKEDIN,
    expect: 'same-or-flagged',
    apply(doc) {
      const els = Array.from(doc.body.querySelectorAll('[componentkey^="update-card-focus"]'));
      for (const el of els)
        el.setAttribute('componentkey', `feed-unit-focus${el.getAttribute('componentkey')?.slice('update-card-focus'.length)}`);
      return els.length;
    },
  },
  {
    id: 'wrap-each-item',
    title: 'each item in one more wrapper',
    group: 'markup',
    platforms: BOTH,
    expect: 'same-or-flagged',
    apply(_doc, list) {
      const rows = Array.from(list.children);
      for (const row of rows) wrap(row);
      return rows.length;
    },
  },
  {
    id: 'wrap-list',
    title: 'the feed list in one more wrapper',
    group: 'markup',
    platforms: BOTH,
    expect: 'same-or-flagged',
    apply(_doc, list) {
      wrap(list);
      return 1;
    },
  },
  {
    id: 'wrap-list-items',
    title: 'one wrapper between the list and all its items',
    group: 'markup',
    platforms: BOTH,
    expect: 'same-or-flagged',
    apply(doc, list) {
      if (!list.children.length) return 0;
      const wrapper = doc.createElement('div');
      wrapper.append(...Array.from(list.childNodes));
      list.append(wrapper);
      return 1;
    },
  },
  {
    id: 'unwrap-one-level',
    title: "each item's outer wrapper removed",
    group: 'markup',
    platforms: BOTH,
    expect: 'same-or-flagged',
    apply(_doc, list) {
      let n = 0;
      for (const row of Array.from(list.children)) {
        const only = row.firstElementChild;
        const ownText = Array.from(row.childNodes).some((c) => c.nodeType === Node.TEXT_NODE && c.nodeValue?.trim());
        if (!only || row.childElementCount !== 1 || ownText) continue;
        row.replaceWith(only);
        n++;
      }
      return n;
    },
  },
  {
    id: 'drop-sr-headings',
    title: 'screen-reader "Feed post(s)" headings dropped',
    group: 'markup',
    platforms: BOTH,
    expect: 'same-or-flagged',
    apply(doc) {
      const headings = Array.from(doc.body.querySelectorAll('h2, h3, [role="heading"]')).filter((h) =>
        /^feed posts?$/i.test((h.textContent ?? '').trim()),
      );
      for (const h of headings) h.remove();
      return headings.length;
    },
  },
  {
    id: 'reorder-actor',
    title: 'the age or ad label moved up a line (above the headline or the name)',
    group: 'markup',
    platforms: BOTH,
    expect: 'same-or-flagged',
    apply(_doc, list) {
      let n = 0;
      for (const row of Array.from(list.children)) {
        const slot = ageOrLabel(row);
        if (slot && moveLineUp(slot, row)) n++;
      }
      return n;
    },
  },

  {
    id: 'rename-action-buttons',
    title: "the action bar's buttons renamed",
    group: 'markup',
    platforms: BOTH,
    expect: 'same-or-flagged',
    apply(doc) {
      let n = 0;
      for (const el of Array.from(doc.body.querySelectorAll('[aria-label]'))) {
        const label = el.getAttribute('aria-label') ?? '';
        const renamed = ACTION_NAMES.find(([from]) => from.test(label));
        if (!renamed || el.closest(COMMENTS)) continue;
        el.setAttribute('aria-label', label.replace(renamed[0], renamed[1]));
        n++;
      }
      return n;
    },
  },

  {
    id: 'drop-all-hooks',
    title: 'every hook the fast path keys on dropped at once',
    group: 'markup',
    platforms: BOTH,
    expect: 'same-or-flagged',
    apply: dropHooks,
  },
  {
    id: 'menus-renamed',
    title: 'card keys, list marks, the post menu, Repost and Send all changed: only the screen-reader headings are left',
    group: 'markup',
    platforms: LINKEDIN,
    expect: 'same-or-flagged',
    apply(doc, list) {
      let n = 0;
      for (const el of Array.from(doc.body.querySelectorAll('[componentkey^="update-card-focus"]'))) {
        el.setAttribute('componentkey', `feed-unit-focus${el.getAttribute('componentkey')?.slice('update-card-focus'.length)}`);
        n++;
      }
      for (const attr of ['data-testid', 'role']) if (list.hasAttribute(attr)) list.removeAttribute(attr);
      for (const el of Array.from(doc.body.querySelectorAll('[aria-label]'))) {
        const label = el.getAttribute('aria-label') ?? '';
        const renamed = MENU_NAMES.find(([from]) => from.test(label));
        if (!renamed || el.closest(COMMENTS)) continue;
        el.setAttribute('aria-label', label.replace(renamed[0], renamed[1]));
        n++;
      }
      return n;
    },
  },

  // ---------- labels ----------
  {
    id: 'decoy-spans',
    title: 'hidden decoy letters inside labels',
    group: 'label',
    platforms: BOTH,
    expect: 'same-or-flagged',
    apply(doc) {
      let n = 0;
      for (const node of textNodes(doc.body)) {
        const text = labelText(node);
        const head = text ? LABEL_HEAD.exec(text)?.[1] : undefined;
        if (!head || head.length < 2) continue;
        const raw = node.nodeValue ?? '';
        const at = raw.indexOf(head) + Math.ceil(head.length / 2);
        const decoy = doc.createElement('span');
        decoy.setAttribute('data-ua-hidden', '');
        decoy.textContent = 'q';
        const rest = node.splitText(at);
        rest.before(decoy);
        n++;
      }
      return n;
    },
  },
  {
    id: 'label-suffix',
    title: 'a new word after Promoted, Sponsored or Ad',
    group: 'label',
    platforms: BOTH,
    expect: 'same-or-flagged',
    apply(doc) {
      let n = 0;
      const suffix = (text: string) => text.replace(AD_HEAD, '$1 · Paid');
      for (const node of textNodes(doc.body)) {
        const text = labelText(node);
        if (!text || !AD_HEAD.test(text)) continue;
        node.nodeValue = (node.nodeValue ?? '').replace(text, suffix(text));
        n++;
      }
      for (const t of svgTexts(doc)) {
        const text = (t.textContent ?? '').trim();
        if (!AD_HEAD.test(text) || text.length > 60) continue;
        t.textContent = suffix(text);
        n++;
      }
      for (const el of Array.from(doc.body.querySelectorAll('[aria-label]'))) {
        const label = el.getAttribute('aria-label') ?? '';
        if (!AD_HEAD.test(label) || label.length > 60 || el.closest(NOT_A_LABEL)) continue;
        el.setAttribute('aria-label', suffix(label));
        n++;
      }
      return n;
    },
  },
  {
    id: 'separator-swap',
    title: 'label separators swapped (• · | —)',
    group: 'label',
    platforms: BOTH,
    expect: 'same-or-flagged',
    apply(doc) {
      let n = 0;
      const swap = (text: string) =>
        text.replace(
          /[•·|—]/g,
          (c) => SEPARATORS[(SEPARATORS.indexOf(c as (typeof SEPARATORS)[number]) + 1) % SEPARATORS.length] ?? c,
        );
      for (const node of textNodes(doc.body)) {
        const text = labelText(node);
        if (!text || !/[•·|—]/.test(text)) continue;
        node.nodeValue = swap(node.nodeValue ?? '');
        n++;
      }
      for (const t of svgTexts(doc)) {
        const text = t.textContent ?? '';
        if (!/[•·|—]/.test(text) || text.length > 60) continue;
        t.textContent = swap(text);
        n++;
      }
      return n;
    },
  },
  {
    id: 'age-reworded',
    title: 'post ages written a new way ("3 hours", "about an hour")',
    group: 'label',
    platforms: BOTH,
    expect: 'same-or-flagged',
    apply(doc) {
      let n = 0;
      for (const node of textNodes(doc.body)) {
        const text = labelText(node);
        if (!text || !SHORT_AGE.test(text)) continue;
        node.nodeValue = (node.nodeValue ?? '').replace(
          SHORT_AGE,
          (_m, v: string, unit: string) => `${v} ${AGE_WORDS[unit] ?? unit}`,
        );
        n++;
      }
      for (const t of svgTexts(doc)) {
        const text = (t.textContent ?? '').trim();
        if (!/ ago$/.test(text) || text.length > 40) continue;
        t.textContent = text.replace(/ ago$/, '');
        n++;
      }
      return n;
    },
  },
  {
    id: 'follow-variants',
    title: '"+ Follow" buttons named "Follow <name>"',
    group: 'label',
    platforms: BOTH,
    expect: 'same',
    apply(doc) {
      let n = 0;
      for (const button of Array.from(doc.body.querySelectorAll('button, [role="button"]'))) {
        if (button.closest(NOT_A_LABEL) || visibleText(button) !== 'Follow') continue;
        const node = textNodes(button).find((t) => t.nodeValue?.trim() === 'Follow');
        if (!node) continue;
        node.nodeValue = (node.nodeValue ?? '').replace('Follow', '+ Follow');
        if (!/^Follow\s\S/.test(button.getAttribute('aria-label') ?? '')) button.setAttribute('aria-label', 'Follow Xxxxx Xxxxx');
        n++;
      }
      return n;
    },
  },
  {
    id: 'unknown-header-verb',
    title: 'a header line with a verb never seen before',
    group: 'label',
    platforms: BOTH,
    expect: 'same-or-flagged',
    apply(doc) {
      let n = 0;
      for (const node of textNodes(doc.body)) {
        const text = labelText(node, 80);
        if (!text || node.parentElement?.closest('button, [role="button"]')) continue;
        const raw = node.nodeValue ?? '';
        if (FOLLOWED_BY.test(text)) node.nodeValue = raw.replace(/Followed by/i, 'Boosted by');
        else if (HEADER_VERB.test(text)) node.nodeValue = raw.replace(HEADER_VERB, '$1boosted');
        else continue;
        n++;
      }
      return n;
    },
  },

  // ---------- false positives: label words where labels never are ----------
  {
    id: 'fp-text-lines',
    title: 'label words as lines of post text',
    group: 'false-positive',
    platforms: BOTH,
    expect: 'same',
    apply(doc) {
      const boxes = postTextBoxes(doc);
      for (const box of boxes) {
        const lines = PROBE_WORDS.map((w) => {
          const line = doc.createElement('div');
          line.setAttribute('data-ua-block', '');
          line.textContent = w;
          return line;
        });
        box.prepend(...lines);
      }
      return boxes.length;
    },
  },
  {
    id: 'fp-text-bold',
    title: 'label words as bold runs in post text',
    group: 'false-positive',
    platforms: BOTH,
    expect: 'same',
    apply(doc) {
      const boxes = postTextBoxes(doc);
      for (const box of boxes) {
        const runs = PROBE_WORDS.flatMap((w) => {
          const b = doc.createElement('strong');
          b.textContent = w;
          return [b, doc.createTextNode(' ')];
        });
        const first = box.querySelector('span, div, p') ?? box;
        first.prepend(...runs);
      }
      return boxes.length;
    },
  },
  {
    id: 'fp-link-card',
    title: 'label words as a link card title',
    group: 'false-positive',
    platforms: BOTH,
    expect: 'same',
    apply(doc) {
      const boxes = postTextBoxes(doc);
      for (const box of boxes) {
        const card = doc.createElement('a');
        card.setAttribute('href', 'https://example.com/article');
        for (const w of PROBE_WORDS) {
          const line = doc.createElement('div');
          line.setAttribute('data-ua-block', '');
          line.textContent = w;
          card.append(line);
        }
        box.after(card);
      }
      return boxes.length;
    },
  },
  {
    id: 'fp-headline',
    title: "label words at the start of the author's headline",
    group: 'false-positive',
    platforms: LINKEDIN,
    expect: 'same',
    apply(_doc, list) {
      let n = 0;
      for (const row of Array.from(list.children)) {
        const headline = headlineOf(row);
        if (!headline) continue;
        // Each probe on every other post, so posts share a headline as one author's posts do.
        headline.nodeValue = PROBE_HEADLINES[n % PROBE_HEADLINES.length] as string;
        n++;
      }
      return n;
    },
  },
  {
    id: 'fp-comments',
    title: 'label words in a comment',
    group: 'false-positive',
    platforms: BOTH,
    expect: 'same',
    apply(doc, _list, platform) {
      const buttons = commentButtons(doc);
      for (const button of buttons) {
        const bar = button.parentElement?.parentElement ?? button.parentElement ?? button;
        const holder = doc.createElement('div');
        holder.innerHTML = commentHtml(PROBE_WORDS, platform);
        bar.after(...Array.from(holder.childNodes));
      }
      return buttons.length;
    },
  },

  // ---------- addresses ----------
  {
    id: 'route-new-word',
    title: 'the feed moved to a new address word',
    group: 'route',
    platforms: BOTH,
    expect: 'same-or-flagged',
    route(url) {
      const moved = new URL(url);
      if (/(^|\.)linkedin\.com$/.test(url.hostname)) moved.pathname = '/feed/highlights/';
      else moved.pathname = '/feeds/highlights';
      moved.search = '';
      return moved.href === url.href ? null : moved;
    },
  },
  {
    id: 'route-home',
    title: 'the feed moved to /home',
    group: 'route',
    platforms: BOTH,
    expect: 'same-or-flagged',
    route(url) {
      const moved = new URL(url);
      moved.pathname = /(^|\.)linkedin\.com$/.test(url.hostname) ? '/home/' : '/home';
      moved.search = '';
      return moved.href === url.href ? null : moved;
    },
  },
];

/** A row's visible outcome: the reasons it is hidden for, or '' when it shows. */
function outcome(row: string): string {
  const hidden = row
    .split('+')
    .map((part) => part.split('/')[0] ?? '')
    .filter((d) => !['show', '-', 'pending', 'offscreen', 'ignore', ''].includes(d));
  return [...new Set(hidden)].sort().join('+');
}

/** What the page says after a change that it didn't say before: a health status, new issues, new observations. */
export function flags(before: GoldenResult, after: GoldenResult): string[] {
  const out = new Set<string>();
  for (const preset of GOLDEN_PRESETS) {
    const b = before.health[preset];
    const a = after.health[preset];
    if (a.status !== 'ok' && a.status !== 'off' && a.status !== b.status) out.add(`status ${a.status}`);
    for (const issue of a.issues) if (!b.issues.includes(issue)) out.add(issue);
  }
  for (const [id, n] of Object.entries(after.emitted.observations)) if (n > (before.emitted.observations[id] ?? 0)) out.add(id);
  return [...out];
}

/**
 * The verdict for one mutation of one golden, comparing each row's visible outcome (shown, or hidden and why) on every
 * preset. A row's relationship or kind may change without a verdict: only what the person sees counts.
 */
export function verdict(before: GoldenResult, after: GoldenResult, m: Pick<Mutation, 'expect'>): Verdict {
  let changed = false;
  let hidesMore = false;
  for (const preset of GOLDEN_PRESETS) {
    const b = before.decisions[preset];
    const a = after.decisions[preset];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const was = outcome(b[i] ?? '');
      const now = outcome(a[i] ?? '');
      if (was === now) continue;
      // A row that was shown and is now hidden: allowed only where the mutation may hide more.
      if (was === '' && m.expect === 'may-hide-more') continue;
      changed = true;
      if (was === '') hidesMore = true;
    }
  }
  if (!changed) return 'survived';
  if (hidesMore) return 'over-hide';
  return flags(before, after).length ? 'flagged' : 'silent';
}

/**
 * Whether a verdict is fine for the mutation: never `silent` or `over-hide`, and a `same` mutation (a false-positive
 * probe, a label variant that must read the same) must survive.
 */
export function acceptable(v: Verdict, m: Pick<Mutation, 'expect'>): boolean {
  if (v === 'silent' || v === 'over-hide') return false;
  return m.expect !== 'same' || v === 'survived';
}

/** One golden ready to mutate: parsed once, and read before any change. */
export interface MutationBase {
  adapter: PlatformAdapter;
  setup: GoldenSetup;
  template: Document;
  before: GoldenResult;
  /** The unchanged page as mounted and read: route mutations judge it again at another address without reading it. */
  unchanged?: { mounted: MountedGolden; read: GoldenRead };
}

export interface MutationRun {
  mutation: Mutation;
  /** Nodes changed (1 for a route move); 0 when the mutation doesn't apply here. */
  changed: number;
  verdict: Verdict | null;
  /** What the page says that it didn't before (for a `flagged` verdict). */
  flags: string[];
  after: GoldenResult | null;
}

/** Mount the golden afresh, apply one mutation and read the page again (or judge it at the new address). */
export function runMutation(base: MutationBase, m: Mutation, doc: Document = document): MutationRun {
  const skip: MutationRun = { mutation: m, changed: 0, verdict: null, flags: [], after: null };
  if (!m.platforms.includes(base.adapter.id)) return skip;
  let after: GoldenResult;
  let changed: number;
  if (m.route) {
    const url = m.route(new URL(base.setup.url));
    if (!url) return skip;
    if (!base.unchanged) throw new Error(`${m.id}: a route move needs the unchanged page as read`);
    after = judgeGolden(base.adapter, base.setup, base.unchanged.mounted, base.unchanged.read, { url });
    changed = 1;
  } else {
    const mounted = mountGolden(base.template, base.setup, doc);
    changed = m.apply?.(doc, mounted.list, base.adapter.id) ?? 0;
    if (!changed) return skip;
    after = readGolden(base.adapter, base.setup, mounted, {}, doc);
  }
  const v = verdict(base.before, after, m);
  return { mutation: m, changed, verdict: v, flags: v === 'flagged' ? flags(base.before, after) : [], after };
}
