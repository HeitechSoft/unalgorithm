import { getLines, outermost, precedes } from '../shared/dom.ts';
import type { LinkedInMarkers } from './markers/en.ts';
import { SEL } from './selectors.ts';

/**
 * The parts of a post that hold labels and structure (ADR 0009 §9): the header lines above the author, the author's
 * block with its age slot, and the buttons around them. Ad labels are read only here, never in post text, comments or
 * reshared posts, so a post that says "Sponsored by Example Labs" is not an ad.
 *
 * Each part is found by the first locator that works, in a fixed order: LinkedIn's class names (the older layout),
 * then data attributes, then accessible names, then the card's structure. Which one won is recorded (`found`), so a
 * report shows "still works, but the fast path is gone" before detection breaks.
 */

export type LocatorKind = 'class' | 'testid' | 'aria' | 'structure';

/** Longest line that can be an age slot ("Promoted • Partnership with LinkedIn" is 36 characters). */
export const SLOT_LINE_CHARS = 60;

/** A link to a member, a page or a group: the author's block always has one, header lines often do. */
const ACTOR_LINK = `${SEL.profileLink}, ${SEL.groupLink}`;
const BUTTONS = 'button, [role="button"]';

export function isInCommentsArea(el: Element): boolean {
  return !!el.closest(SEL.commentsArea);
}

/** The first action bar button of the post itself (not of a comment). */
export function firstActionButton(root: Element, m: LinkedInMarkers): Element | undefined {
  return Array.from(root.querySelectorAll(m.actionBarSelector)).find((el) => !isInCommentsArea(el));
}

/** A part of the post, and the locator that found it. */
export interface Located {
  el: Element;
  by: LocatorKind;
}

const outsideComments = (root: Element, selector: string) =>
  Array.from(root.querySelectorAll(selector)).find((el) => !isInCommentsArea(el));

/** The post's text box: by its class (older layout), then by LinkedIn's data hooks (2026). */
export function locateText(root: Element): Located | undefined {
  const byClass = outsideComments(root, SEL.textClass);
  if (byClass) return { el: byClass, by: 'class' };
  const byHook = outsideComments(root, SEL.textHook);
  return byHook ? { el: byHook, by: 'testid' } : undefined;
}

/** A row of at least this many buttons and links (Like, Comment, Repost, Send) is an action bar by its shape. */
const BAR_BUTTONS = 3;

/**
 * The action bar by its shape: the last row outside comments with BAR_BUTTONS children that are or hold a button or a
 * link, looked for up to three levels above each button. Works whatever the class names and the words.
 */
function barByStructure(root: Element): Element | undefined {
  let bar: Element | undefined;
  const seen = new Set<Element>();
  for (const button of Array.from(root.querySelectorAll('button'))) {
    if (isInCommentsArea(button)) continue;
    let el = button.parentElement;
    for (let depth = 0; el && el !== root && depth < 3 && !seen.has(el); depth++, el = el.parentElement) {
      seen.add(el);
      const cells = Array.from(el.children).filter((c) => c.matches('button, a[href]') || !!c.querySelector('button'));
      if (cells.length >= BAR_BUTTONS) {
        bar = el;
        break;
      }
    }
  }
  return bar;
}

/**
 * The post's action bar (its first button, for the aria locator): by its class (older layout), by the buttons'
 * accessible names, then by its shape.
 */
export function locateActionBar(root: Element, m: LinkedInMarkers): Located | undefined {
  const byClass = outsideComments(root, SEL.actionBarClass);
  if (byClass) return { el: byClass, by: 'class' };
  const byName = firstActionButton(root, m);
  if (byName) return { el: byName, by: 'aria' };
  const byShape = barByStructure(root);
  return byShape ? { el: byShape, by: 'structure' } : undefined;
}

/**
 * Visible lines of `el` without the text of its buttons ("Follow", "Join", "… more"): buttons are never a headline,
 * an age or a label line.
 */
export function plainLines(el: Element): string[] {
  const lines = getLines(el);
  const buttons = outermost(Array.from(el.querySelectorAll(BUTTONS)));
  if (!buttons.length) return lines;
  const drop = new Map<string, number>();
  for (const b of buttons) for (const l of getLines(b)) drop.set(l, (drop.get(l) ?? 0) + 1);
  return lines.filter((l) => {
    const n = drop.get(l) ?? 0;
    if (n > 0) drop.set(l, n - 1);
    return n === 0;
  });
}

/** True when `line` is `name` or starts with it as whole words ("Jane Doe • 2nd", not "Jane Doesburg"). */
export function startsWithName(line: string, name: string): boolean {
  return !!name && line.startsWith(name) && !/[\p{L}\p{N}]/u.test(line.charAt(name.length));
}

export interface PostHead {
  /** Lines above the author: "Jane Doe likes this", "Followed by Jane Doe", "Suggested". */
  header: string[];
  /** The author's block without its buttons: name, degree, headline, extra links and the age slot. */
  actor: string[];
  /** The last short line of the author's block: the post's age ("3h • Edited"), or an ad's label ("Promoted"). */
  ageSlot?: string;
  /** Buttons before the post's body and outside comments: Follow, Join, the post's menu. */
  buttons: Element[];
  /** Which locator found each part. */
  found: Partial<Record<SlotName, LocatorKind>>;
}

/** The parts located (protocol `SLOT_NAMES`); each is reported as `li.slot.<part>.<locator>` when not found by class. */
export type SlotName = 'actor' | 'header' | 'age' | 'text' | 'action-bar';

/**
 * Observation ids for the parts a later locator found ("still works, but the fast path is gone"). The first locator of
 * each part is LinkedIn's class name, which only the older layout still has.
 */
export function slotObservations(found: PostHead['found']): string[] {
  return (Object.entries(found) as Array<[SlotName, LocatorKind]>)
    .filter(([, by]) => by !== 'class')
    .map(([slot, by]) => `li.slot.${slot}.${by}`);
}

/** A block of the post's head: an element before the body, and its lines without buttons. */
interface Block {
  el: Element;
  lines: string[];
}

const holdsLink = (b: Block) => b.el.matches(ACTOR_LINK) || !!b.el.querySelector(ACTOR_LINK);

/**
 * The head's blocks, in order: the children, before the body, of the body's nearest ancestor that has one with a
 * profile link (the author's). In the 2026 feed that is the header row, a separator and the author's row; in the older
 * layout the header and the actor block; in a flat layout, one block per line. Blocks without text or a profile link,
 * buttons and the card's screen-reader heading are left out.
 */
function headBlocks(root: Element, body: Element, m: LinkedInMarkers): Block[] {
  let child: Element = body;
  for (let parent = body.parentElement; parent; child = parent, parent = parent.parentElement) {
    const blocks: Block[] = [];
    for (let el = parent.firstElementChild; el && el !== child; el = el.nextElementSibling) {
      if (el.matches(BUTTONS) || isInCommentsArea(el)) continue;
      const block = { el, lines: plainLines(el).filter((l) => !m.cardHeading.test(l)) };
      if (block.lines.length || holdsLink(block)) blocks.push(block);
    }
    if (blocks.some(holdsLink) || parent === root) return blocks;
  }
  return [];
}

/** The block that names the author (a line or an accessible name starting with the name from the post's menu). */
function namesAuthor(b: Block, name: string): boolean {
  if (b.lines.some((l) => startsWithName(l, name))) return true;
  const named = [b.el, ...Array.from(b.el.querySelectorAll('[aria-label]'))];
  return named.some((el) => !el.matches(BUTTONS) && startsWithName(el.getAttribute('aria-label')?.trim() ?? '', name));
}

/**
 * The author's block from position `at`: just that block, or in a flat layout (the block is one line, as each line is
 * its own element) the short blocks that follow it, up to the first long one (the post's text).
 */
function actorRun(blocks: Block[], at: number): string[] {
  const first = blocks[at] as Block;
  if (first.lines.length !== 1) return first.lines;
  const lines = [...first.lines];
  for (const b of blocks.slice(at + 1)) {
    if (!b.lines.length || b.lines.some((l) => l.length > SLOT_LINE_CHARS)) break;
    lines.push(...b.lines);
  }
  return lines;
}

/** Index of the last block matching `test`, or -1. */
function lastIndex(blocks: Block[], test: (b: Block) => boolean): number {
  for (let i = blocks.length - 1; i >= 0; i--) if (test(blocks[i] as Block)) return i;
  return -1;
}

/**
 * Buttons that belong to the post's own head: before the body in page order and outside comments. A reshared post
 * inside the card has its own actor and Follow button after the outer text, which must not count.
 */
function headButtons(root: Element, body: Element | undefined): Element[] {
  return Array.from(root.querySelectorAll(BUTTONS)).filter((b) => !isInCommentsArea(b) && (!body || precedes(b, body)));
}

/**
 * Read the head of a post: header lines, the author's block, its age slot and the head's buttons. `author` is the
 * name from the post's menu, when it has one. Read-only.
 */
export function readHead(root: Element, m: LinkedInMarkers, author?: string): PostHead {
  // Where the post's body starts: its text box or, without one (an image or video post), its action bar.
  const text = locateText(root);
  const bar = locateActionBar(root, m);
  const body = text && bar ? (precedes(text.el, bar.el) ? text.el : bar.el) : (text ?? bar)?.el;
  const head: PostHead = { header: [], actor: [], buttons: headButtons(root, body), found: {} };
  if (text) head.found.text = text.by;
  if (bar) head.found['action-bar'] = bar.by;
  const blocks = body ? headBlocks(root, body, m) : [];
  /** In the post's own head: before its body and outside comments (so never a reshared post's or a comment's). */
  const inHead = (el: Element) => !isInCommentsArea(el) && (!body || precedes(el, body));
  const first = (selector: string) => Array.from(root.querySelectorAll(selector)).find(inHead);

  // The author's block. Older layout: its class. 2026: the block that names the author from the post's menu (header
  // rows name someone else, the one who liked or follows). Otherwise: the last block with a profile link before the body.
  const byClass = first(SEL.actorBlock);
  let at = -1;
  if (byClass) {
    head.actor = plainLines(byClass);
    head.found.actor = 'class';
    at = blocks.findIndex((b) => b.el === byClass || b.el.contains(byClass));
  } else {
    at = author ? lastIndex(blocks, (b) => namesAuthor(b, author)) : -1;
    if (at >= 0) head.found.actor = 'aria';
    else {
      at = lastIndex(blocks, holdsLink);
      if (at >= 0) head.found.actor = 'structure';
    }
    if (at >= 0) head.actor = actorRun(blocks, at);
  }

  // Header lines: their class in the older layout, LinkedIn's data hook, or every block above the author's.
  const headerByClass = first(SEL.headerClass);
  const headerByHook = headerByClass ? undefined : first(SEL.headerHook);
  if (headerByClass || headerByHook) {
    head.header = plainLines((headerByClass ?? headerByHook) as Element);
    head.found.header = headerByClass ? 'class' : 'testid';
  } else if (at > 0) {
    head.header = blocks.slice(0, at).flatMap((b) => b.lines);
    if (head.header.length) head.found.header = 'structure';
  }

  // The age slot: its class in the older layout, else the last short line of the author's block (which has at least
  // a name before it).
  const ageByClass = first(SEL.actorSubDescription);
  const ageLines = ageByClass ? plainLines(ageByClass) : [];
  if (ageLines.length) {
    head.ageSlot = ageLines.join(' ');
    head.found.age = 'class';
  } else if (head.actor.length > 1) {
    const short = head.actor.filter((l) => l.length <= SLOT_LINE_CHARS);
    const last = short[short.length - 1];
    if (last !== undefined) {
      head.ageSlot = last;
      head.found.age = 'structure';
    }
  }
  return head;
}
