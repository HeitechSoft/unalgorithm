/**
 * Leak scan for problem reports (ADR 0009 §4): everything in a fixture page that names, quotes or points at someone or
 * something, which a report must never carry. Text runs (names, headlines, post text), link addresses and their
 * slug-like parts, LinkedIn URNs, component keys, Facebook's numeric ids, and labels read by screen readers. A
 * report's JSON is then searched for each, as it is: codes and keys are lowercase words, so a fixture's capitalised
 * words and longer runs can only be there if something copied them.
 */

/** Words the page and the wire legitimately share, as whole tokens: route classes, platform names, plain counts. */
const SHARED_WORDS = new Set([
  'feed',
  'home',
  'linkedin',
  'facebook',
  'post',
  'posts',
  'items',
  'update',
  'company',
  'groups',
  'group',
  'reel',
  'reels',
  'photo',
  'true',
  'false',
]);

/** Shorter runs are too generic to tell copying from coincidence ("Like", "1h"). */
const MIN_TEXT = 5;

/**
 * Text that can only be in a report if it was copied: with a capital, a space or a digit (names, sentences), or long.
 * A lowercase fragment like "sored" (Facebook splits "Sponsored" to hide it) is part of a code word by chance.
 */
function telling(text: string): boolean {
  return (
    text.length >= MIN_TEXT &&
    /\p{L}/u.test(text) &&
    !SHARED_WORDS.has(text.toLowerCase()) &&
    (/[\p{Lu}\s\d]/u.test(text) || text.length >= 12)
  );
}

function addParts(out: Set<string>, value: string): void {
  const v = value.trim();
  if (!v || SHARED_WORDS.has(v.toLowerCase())) return;
  out.add(v);
  try {
    const url = new URL(v, 'https://example.invalid/');
    for (const part of url.pathname.split('/')) {
      // Slugs and ids: anything with a hyphen, a dot or digits, or long enough to be a name.
      if (part.length >= 4 && !SHARED_WORDS.has(part.toLowerCase()) && (/[-.\d]/.test(part) || part.length >= 8)) out.add(part);
    }
    for (const [, param] of url.searchParams) if (param.length >= 4 && !SHARED_WORDS.has(param.toLowerCase())) out.add(param);
  } catch {
    // Not an address: the value alone is enough.
  }
  for (const urn of v.match(/urn:li:[\w:-]+/g) ?? []) out.add(urn);
  for (const digits of v.match(/\d{6,}/g) ?? []) out.add(digits);
}

/** Every token of `html` that must never appear in a report. */
export function forbiddenTokens(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = new Set<string>();
  const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (telling(text)) out.add(text);
  }
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const name of ['href', 'src', 'componentkey', 'data-urn', 'data-id', 'id', 'aria-label', 'title', 'alt']) {
      const value = el.getAttribute(name);
      if (!value) continue;
      if (name === 'aria-label' || name === 'title' || name === 'alt') {
        if (telling(value.trim())) out.add(value.trim());
      } else addParts(out, value);
    }
  }
  return [...out].filter((t) => t.length >= 4);
}

/** The tokens of `tokens` found in `json`. Empty when the report carries nothing from the page. */
export function leaks(json: string, tokens: readonly string[]): string[] {
  return tokens.filter((t) => json.includes(t) || json.includes(JSON.stringify(t).slice(1, -1)));
}

/**
 * The tokens of `tokens` found in a report, all but its `id`. The background makes the id with `crypto.randomUUID()`
 * and the schema holds it to a UUID, so it carries nothing from the page, but its 32 random hex digits can spell a
 * fixture's number by chance ("9999" from a permalink, about one run in forty for the synthetic Facebook feed).
 */
export function reportLeaks(report: { id: string }, tokens: readonly string[]): string[] {
  const { id: _random, ...rest } = report;
  return leaks(JSON.stringify(rest), tokens);
}
