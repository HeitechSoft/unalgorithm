/** Whole-word, case-insensitive keyword matching that works for any language's letters and digits. */

const cache = new Map<string, RegExp | null>();

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A regex matching any of the keywords as whole words or phrases. Keywords that are all capitals and at most
 * four letters (AI, EV, SEO) match case-sensitively so "ai" inside ordinary words or "said" never triggers them.
 */
export function keywordRegex(keywords: readonly string[]): RegExp | null {
  const key = keywords.join('\u0000');
  if (cache.has(key)) return cache.get(key) ?? null;
  const parts = keywords
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => {
      const body = escapeRegex(k).replace(/\s+/g, '\\s+');
      return /^[A-Z]{2,4}s?$/.test(k) ? `(?-i:${body})` : body;
    });
  let re: RegExp | null = null;
  if (parts.length) {
    try {
      re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
    } catch {
      // Inline modifiers need a recent engine; fall back to plain case-insensitive matching.
      re = new RegExp(
        `(?<![\\p{L}\\p{N}])(?:${keywords.map((k) => escapeRegex(k.trim()).replace(/\s+/g, '\\s+')).join('|')})(?![\\p{L}\\p{N}])`,
        'iu',
      );
    }
  }
  if (cache.size > 200) cache.clear();
  cache.set(key, re);
  return re;
}

/** The first keyword found in the text, as written in the text, or undefined. */
export function findKeyword(text: string, keywords: readonly string[]): string | undefined {
  const re = keywordRegex(keywords);
  return re ? (re.exec(text)?.[0] ?? undefined) : undefined;
}
