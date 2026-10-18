/**
 * The one place that knows which browser runs the extension (ADR 0008). Firefox is decided at build time; Chrome or
 * Edge at run time, from the brand names, because Edge users can also install the Chrome Web Store build. Workspace
 * packages stay browser-neutral: callers pass them the labels from here. Imports nothing, so any bundle can use it.
 */

export type BrowserKind = 'chrome' | 'edge' | 'firefox';

/**
 * What the kind is decided from. Tests pass their own. WXT sets `import.meta.env.BROWSER` per build (a string in
 * Vitest too, where its boolean `FIREFOX` arrives as the string "false").
 */
export interface BrowserFacts {
  /** A Firefox build. */
  firefox: boolean;
  /** `navigator.userAgentData` brand names: Chromium only, empty in Firefox. */
  brands: readonly string[];
}

/** Not in TypeScript's DOM lib. Brand names only: no version, no user agent string. */
type UserAgentData = { brands?: readonly { brand: string }[] } | undefined;

/** This browser's brand names, e.g. ['Chromium', 'Microsoft Edge', 'Not=A?Brand']; empty when it doesn't say. */
export function brandNames(): string[] {
  const data = (globalThis.navigator as { userAgentData?: UserAgentData } | undefined)?.userAgentData;
  return data?.brands?.map((b) => b.brand) ?? [];
}

/** Chrome, Edge or Firefox. Other Chromium browsers run the Chrome build, so they count as Chrome. */
export function browserKind(
  facts: BrowserFacts = { firefox: import.meta.env.BROWSER === 'firefox', brands: brandNames() },
): BrowserKind {
  if (facts.firefox) return 'firefox';
  return facts.brands.includes('Microsoft Edge') ? 'edge' : 'chrome';
}

const LABELS: Readonly<Record<BrowserKind, string>> = { chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox' };

/** The browser's short name for copy: "Chrome", "Edge" or "Firefox". */
export function browserLabel(kind: BrowserKind): string {
  return LABELS[kind];
}

/**
 * "Firefox 147", "Edge 141" or "Chrome 141" for problem reports: the name and major version only, from the user agent
 * string the page already sees. "unknown" when it names none of them.
 */
export function browserVersion(userAgent: string): string {
  for (const [name, pattern] of [
    ['Firefox', /Firefox\/(\d+)/],
    ['Edge', /Edg\/(\d+)/],
    ['Chrome', /Chrome\/(\d+)/],
  ] as const) {
    const major = userAgent.match(pattern)?.[1];
    if (major) return `${name} ${major}`;
  }
  return 'unknown';
}
