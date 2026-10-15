import { FactcheckSourceSchema, MAX_RETRIEVED_SOURCES, type RetrievedSource } from '@unalgorithm/protocol';

export const MAX_SNIPPET_CHARS = 600;
export const MAX_NOTES_CHARS = 8_000;
const MAX_URL_CHARS = 2_048;

/** The `www.`-less lowercased hostname of an http(s) URL of at most 2,048 characters, or undefined. */
export function sourceDomain(url: string): string | undefined {
  if (url.length > MAX_URL_CHARS) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/**
 * The sources of one research answer, shared by every research adapter: first-seen order, ids `s1`.., deduplicated by
 * `key(url)`, capped at MAX_RETRIEVED_SOURCES and schema-safe (FactcheckSourceSchema). Sources come only from search
 * results: a citation only adds a snippet to an existing source, never creates one.
 */
export function createSourceCollector(key: (url: string) => string = (url) => url): {
  addResult(r: { url: string; title: string; pageAge: string | null }): void;
  /** Adds a cited passage to the source with this URL (if any), and fills its title when that is empty. */
  addSnippet(url: string, text: string, title?: string): void;
  sources(): RetrievedSource[];
} {
  const byKey = new Map<string, RetrievedSource>();
  const seen = new Set<string>();
  return {
    addResult(r) {
      const k = key(r.url);
      if (seen.has(k)) return;
      seen.add(k);
      if (byKey.size >= MAX_RETRIEVED_SOURCES) return;
      const domain = sourceDomain(r.url);
      if (!domain) return;
      const source = {
        id: `s${byKey.size + 1}`,
        url: r.url,
        domain,
        title: (r.title ?? '').slice(0, 300),
        pageAge: r.pageAge ? r.pageAge.slice(0, 64) : null,
      };
      if (!FactcheckSourceSchema.safeParse(source).success) return;
      byKey.set(k, { ...source, snippets: [] });
    },
    addSnippet(url, text, title) {
      const source = byKey.get(key(url));
      if (!source) return;
      if (!source.title && title) source.title = title.slice(0, 300);
      const snippet = text.slice(0, MAX_SNIPPET_CHARS);
      if (snippet && !source.snippets.includes(snippet)) source.snippets.push(snippet);
    },
    sources: () => [...byKey.values()],
  };
}
