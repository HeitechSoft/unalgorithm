import { normalizeText, precedes } from '../shared/dom.ts';
import type { ItemAnatomy } from '../shared/structure.ts';
import type { FacebookObservation } from './ids.ts';
import { FB_SEL, isFacebookProfileHref } from './selectors.ts';

/**
 * Where the parts of a Facebook post are (ADR 0009 §9, phase B). Each part has layered locators: Facebook's own
 * data-ad-* hooks first (they act as test ids), then accessible names, then the page's structure. Class names are
 * generated, so there is no class locator. When a fallback wins, the slot records an observation such as
 * `fb.slot.actor.structure`: detection still works, but the fast path is gone, and reports say so.
 */

export interface ItemSlots {
  root: Element;
  /** The author's name block: `profile_name`, else the first heading. */
  actor: Element | null;
  /** The message box (Facebook's own hooks); posts without text have none. */
  message: Element | null;
  /** A shared post nested inside this one, with its own header. */
  nested: Element | null;
  /** Fallback locators that won. */
  observations: FacebookObservation[];
}

function locate(root: Element): ItemSlots {
  const observations: FacebookObservation[] = [];
  const names = Array.from(root.querySelectorAll(FB_SEL.profileName));
  let actor: Element | null = names[0] ?? null;
  let nested = nestedAround(root, names);
  if (!actor) {
    actor = root.querySelector(FB_SEL.heading);
    if (actor) observations.push('fb.slot.actor.structure');
    nested = actor ? nestedByHeading(root, actor) : null;
    if (nested) observations.push('fb.slot.nested-post.structure');
  }
  return { root, actor, message: root.querySelector(FB_SEL.message), nested, observations };
}

/** The block around a second author's name, up to the first author's: a post shared inside this one. */
function nestedAround(root: Element, names: Element[]): Element | null {
  if (names.length < 2) return null;
  let block = names[1] as Element;
  while (block.parentElement && block.parentElement !== root && !block.parentElement.contains(names[0] as Element))
    block = block.parentElement;
  return block === root ? null : block;
}

/** Without `profile_name` hooks: a later heading that names a person or page by a profile link. */
function nestedByHeading(root: Element, actor: Element): Element | null {
  const second = Array.from(root.querySelectorAll(FB_SEL.heading)).find(
    (h) =>
      h !== actor &&
      precedes(actor, h) &&
      !actor.contains(h) &&
      Array.from(h.querySelectorAll('a[href]')).some((a) => isFacebookProfileHref(a.getAttribute('href') ?? '')),
  );
  return second ? nestedAround(root, [actor, second]) : null;
}

/**
 * The item being read, with its slots located once: `inHeader` and `inNestedPost` run for every element of the item.
 * Set only for the length of a synchronous `withSlots` call.
 */
let reading: ItemSlots | undefined;

/** Runs `read` with the item's slots located once and shared by every helper here. */
export function withSlots<T>(root: Element, read: (slots: ItemSlots) => T): T {
  const outer = reading;
  reading = outer?.root === root ? outer : locate(root);
  try {
    return read(reading);
  } finally {
    reading = outer;
  }
}

export function slotsOf(root: Element): ItemSlots {
  return reading?.root === root ? reading : locate(root);
}

export function messageBox(root: Element): Element | null {
  return slotsOf(root).message;
}

/** The post's own header: everything before the message box, or the author's block when there is none. */
export function inHeader(root: Element, el: Element): boolean {
  const { message, actor } = slotsOf(root);
  // 2026: the message box sits inside a div[dir=auto], which comes "before" it in document order.
  if (message) return precedes(el, message) && !message.contains(el) && !el.contains(message);
  if (!actor) return false;
  const container = actor.parentElement?.parentElement ?? actor;
  return container.contains(el);
}

/** A shared post nested inside this one has its own header; its buttons and labels are not ours. */
export function inNestedPost(root: Element, el: Element): boolean {
  return !!slotsOf(root).nested?.contains(el);
}

/** Comments are nested articles ("Comment by …") or live in a labelled comment section or a list. */
export function inComment(root: Element, el: Element): boolean {
  const article = el.parentElement?.closest('[role="article"]');
  if (article && article !== root && root.contains(article)) return true;
  const section = el.closest('[aria-label*="comment" i], ul');
  return !!section && section !== root && root.contains(section);
}

/** Headings that can name a post's author, a shared post's or a reel's (h5 in the 2026 reel overlay). */
const NAME_HEADINGS = 'h1, h2, h3, h4, h5, h6, [role="heading"]';

/** A heading, or a link to someone's profile itself (their name or picture), not to one of their posts. */
function namesSomeone(el: Element): boolean {
  if (el.matches(NAME_HEADINGS)) return true;
  return el.matches('a[href]') && isFacebookProfileHref(el.getAttribute('href') ?? '') && !el.matches(FB_SEL.permalink);
}

/**
 * Whether a header element goes with the author's name rather than another one: nothing that names someone else (a
 * heading, or a link to a profile) comes between the two. Facebook puts the author's Follow or Join button right after
 * the name (inside its heading since 2026); a post or reel shared inside this one names its own author first, with a
 * picture and a name that may be a heading or a plain link, which the slots don't always mark as nested, and its
 * buttons come after that.
 */
export function besideAuthor(root: Element, el: Element): boolean {
  const { actor } = slotsOf(root);
  if (!actor || actor.contains(el)) return true;
  return !Array.from(root.querySelectorAll(`${NAME_HEADINGS}, a[href]`)).some(
    (h) => !actor.contains(h) && !h.contains(actor) && precedes(actor, h) && precedes(h, el) && namesSomeone(h),
  );
}

/**
 * Buttons in the post's header, outside a nested post: by role (`aria`), and, kept apart, focusable elements that
 * lost their role (`structure`). A caller uses the fallback only when the first set has nothing it recognises, and
 * then records `fb.slot.header-buttons.structure`.
 */
export function headerButtons(root: Element): { buttons: Element[]; fallback: Element[] } {
  const own = (el: Element) => inHeader(root, el) && !inNestedPost(root, el);
  return {
    buttons: Array.from(root.querySelectorAll(FB_SEL.button)).filter(own),
    fallback: Array.from(root.querySelectorAll('[tabindex]:not([tabindex="-1"]):not(a):not(button):not([role])')).filter(own),
  };
}

/**
 * The header link after the author's name that holds the post's age, or "Ad" on ads. Since 2026 Facebook draws that
 * text as SVG (a `<use>` of a `<text>` elsewhere in the page) and adds an aria-labelledby span only later; friends'
 * posts may spell it one character per span, each followed by U+034F.
 */
export function slotLink(root: Element): Element | null {
  const { actor, message } = slotsOf(root);
  const end = message ?? root.querySelector(FB_SEL.likeButton);
  for (const a of Array.from(root.querySelectorAll('a'))) {
    if (actor && (!precedes(actor, a) || actor.contains(a))) continue;
    if (end && !precedes(a, end)) break;
    if (inNestedPost(root, a)) continue;
    if (a.querySelector('use, [aria-labelledby]') || (a.textContent ?? '').includes('\u034F')) return a;
  }
  return null;
}

/** "Like" in English, the name the action bar's first button has when Facebook's own hook is missing. */
const LIKE = /^like$/i;

/**
 * The item's post-level action bars, outside comments: Facebook's `like_button` hooks (`testid`), else buttons named
 * Like (`aria`). A single post has one; an item with two or more holds several posts.
 */
export function actionBars(root: Element, like: RegExp = LIKE): { count: number; locator: 'testid' | 'aria' | null } {
  const hooks = Array.from(root.querySelectorAll(FB_SEL.likeButton)).filter((b) => !inComment(root, b));
  if (hooks.length) return { count: hooks.length, locator: 'testid' };
  const named = Array.from(root.querySelectorAll(FB_SEL.button)).filter(
    (b) => like.test(normalizeText(b.getAttribute('aria-label') ?? '')) && !inComment(root, b),
  );
  return named.length ? { count: named.length, locator: 'aria' } : { count: 0, locator: null };
}

/** True when the element holds any text. Stops at the first it finds. */
function hasText(el: Element, min = 1): boolean {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (normalizeText(n.nodeValue ?? '').length >= min) return true;
  }
  return false;
}

/** A slot Facebook emptied or virtualised once it scrolled far away: nothing to read in it. */
export function isEmptySlot(el: Element): boolean {
  return el.matches(FB_SEL.virtualized) || !!el.querySelector(FB_SEL.virtualized) || !hasText(el);
}

/** What the item looks like, for scoring discovery strategies: a post has an author, an action bar, an age, a menu and text. */
export function itemAnatomy(item: Element): ItemAnatomy {
  return withSlots(item, (slots) => ({
    author: !!slots.actor,
    actionBar: actionBars(item).count > 0,
    ageSlot: !!slotLink(item) || !!item.querySelector(FB_SEL.permalink),
    // The post's menu ("Actions for this post"): an icon-only button in the header.
    menu: Array.from(item.querySelectorAll(FB_SEL.button)).some(
      (b) => !!b.querySelector('svg') && !hasText(b) && inHeader(item, b) && !inNestedPost(item, b),
    ),
    text:
      !!slots.message ||
      Array.from(item.querySelectorAll('div[dir="auto"]')).some(
        (el) => !inHeader(item, el) && normalizeText(el.textContent ?? '').length >= 20,
      ),
  }));
}
