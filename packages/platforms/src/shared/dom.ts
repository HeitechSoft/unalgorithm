const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'BR',
  'BUTTON',
  'DD',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TD',
  'TH',
  'TR',
  'UL',
]);

/** Our own injected elements are never read as post content. */
export const OWN_TAGS = new Set(['UNALGO-POST', 'UNALGO-LAYER']);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'TEMPLATE', ...OWN_TAGS]);

/**
 * `innerText` without layout: block elements (and elements marked `data-ua-block`, which the fixture capture
 * script adds to anything rendered as a block) start new lines. Works on collapsed posts and in jsdom.
 */
export function walkText(root: Node, skip?: string): string {
  let out = '';
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (SKIP_TAGS.has(el.tagName) || el.hasAttribute('hidden') || el.hasAttribute('data-ua-hidden')) return;
    if (skip && el !== root && el.matches(skip)) return;
    if (el.classList.contains('visually-hidden')) return;
    const block = BLOCK_TAGS.has(el.tagName) || el.hasAttribute('data-ua-block');
    if (block) out += '\n';
    for (const child of Array.from(el.childNodes)) visit(child);
    if (block) out += '\n';
  };
  visit(root);
  return out;
}

/**
 * Trimmed, non-empty lines of an element's visible text. Uses the browser's `innerText` (which skips text the page
 * hides with CSS) when the element is rendered, and the layout-independent `walkText` for posts we collapsed
 * (their content is display:none) and in tests.
 */
export function getLines(el: Element): string[] {
  const html = el as HTMLElement;
  const rendered =
    typeof html.innerText === 'string' &&
    !html.closest('[data-unalgo]') &&
    typeof html.getClientRects === 'function' &&
    html.getClientRects().length > 0;
  return (rendered ? html.innerText : walkText(el))
    .split('\n')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Full text content (including CSS-clamped "…see more" text), keeping paragraph breaks. */
export function richText(el: Element): string {
  return walkText(el)
    .split('\n')
    .map((s) => s.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Text of the first matching element, joined into one line, or undefined. */
export function textOf(root: ParentNode, selector: string): string | undefined {
  const el = root.querySelector(selector);
  if (!el) return undefined;
  const lines = getLines(el);
  return lines.length ? lines.join(' ') : undefined;
}

/**
 * Names of people and pages linked inside post text (tags and mentions). Read-only. They are kept only so they can
 * be masked before text goes to an AI; LinkedIn and Facebook show tags as plain linked names, without an "@".
 */
export function linkedNames(boxes: readonly Element[], isProfileHref: (href: string) => boolean): string[] {
  const names = new Set<string>();
  for (const box of boxes) {
    for (const a of Array.from(box.querySelectorAll('a[href]'))) {
      const name = normalizeText(a.textContent ?? '');
      if (name.length >= 2 && name.length <= 80 && !name.startsWith('#') && isProfileHref(a.getAttribute('href') ?? ''))
        names.add(name);
    }
  }
  return [...names];
}

/** Elements not nested inside another element of the list. */
export function outermost<T extends Element>(els: T[]): T[] {
  const set = new Set<Element>(els);
  return els.filter((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
    return true;
  });
}

/** True if any text node under root (scanning at most `limit` nodes) matches the pattern exactly. */
export function hasTextNode(root: Node, pattern: RegExp, limit = 400): boolean {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n = 0;
  for (let node = walker.nextNode(); node && n < limit; node = walker.nextNode(), n++) {
    const t = node.nodeValue?.replace(/\s+/g, ' ').trim();
    if (t && pattern.test(t)) return true;
  }
  return false;
}

/** Normalize text from the page: NFKC, no zero-width, bidi or grapheme-joiner (U+034F) characters, single spaces. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|\u034F/g, '')
    .replace(/[ \t ]+/g, ' ')
    .trim();
}

/**
 * An element's accessible name, roughly as a screen reader computes it: the elements `aria-labelledby` names (read even
 * when hidden, as the spec says: platforms hide labels there), then `aria-label`, an image's `alt`, the visible text,
 * an SVG's `<title>`, then `title`. Normalized; empty when it has none. Read-only.
 */
export function accessibleName(el: Element): string {
  const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  if (ids.length) {
    const root = el.getRootNode() as Document | ShadowRoot;
    const byId = (id: string) =>
      (typeof root.getElementById === 'function' ? root.getElementById(id) : null) ?? el.ownerDocument.getElementById(id);
    const named = normalizeText(
      ids
        .map((id) => byId(id))
        .filter((target): target is HTMLElement => !!target && target !== el)
        .map((target) => target.getAttribute('aria-label') || target.textContent || '')
        .join(' '),
    );
    if (named) return named;
  }
  const label = normalizeText(el.getAttribute('aria-label') ?? '');
  if (label) return label;
  if (el.tagName === 'IMG' || el.tagName === 'AREA' || (el.tagName === 'INPUT' && el.getAttribute('type') === 'image')) {
    const alt = normalizeText(el.getAttribute('alt') ?? '');
    if (alt) return alt;
  }
  const text = normalizeText(walkText(el).replace(/\s+/g, ' '));
  if (text) return text;
  const svgTitle = el.tagName.toLowerCase() === 'svg' ? el.querySelector('title') : el.querySelector('svg title');
  const titled = normalizeText(svgTitle?.textContent ?? '');
  if (titled) return titled;
  return normalizeText(el.getAttribute('title') ?? '');
}

/** True when `a` comes before `b` in document order. */
export function precedes(a: Node, b: Node): boolean {
  return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

const AGE_UNIT_HOURS: Record<string, number> = {
  s: 1 / 3600,
  m: 1 / 60,
  min: 1 / 60,
  mins: 1 / 60,
  h: 1,
  hr: 1,
  hrs: 1,
  d: 24,
  w: 168,
  mo: 720,
  y: 8760,
  yr: 8760,
};

export function ageToHours(value: number, unit: string): number | undefined {
  const h = AGE_UNIT_HOURS[unit.toLowerCase()];
  return h === undefined ? undefined : value * h;
}

/** Luminance (0-1) of a CSS color string like "rgb(27, 31, 35)". */
export function luminance(color: string): number | undefined {
  const m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(color);
  if (!m) return undefined;
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** "Hostname" of an absolute http(s) link, without "www.". */
export function linkDomain(href: string, base: string): string | undefined {
  try {
    const u = new URL(href, base);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    return u.hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}
