/** Types for scan-public-repo.mjs, so the strict server tsconfig (no allowJs) accepts its test's import. */

export type FindingKind = 'public-ipv4' | 'host-marker' | 'extra-marker' | 'secret-path' | 'binary-file';

/** One scan finding, as formatFinding prints it. */
export interface Finding {
  /** Path from the repository root, or `path #<n>` when the path itself holds an address or an extra marker. */
  file: string;
  /** 1-based line in the file (in the commit's version of it, for history); absent for a path finding. */
  line?: number;
  /** The commit that added the line, for a history finding. */
  commit?: string;
  kind: FindingKind;
  /** The matched text of a generic host marker. Never printed for any other kind. */
  text?: string;
  /** The pattern's line in PUBLIC_SCAN_EXTRA_PATTERNS, for an extra marker. */
  marker?: number;
}

/** A host marker found in a text: a generic one with its matched text, an extra one with its number only. */
export type MarkerFinding =
  | { line: number; kind: 'host-marker'; text: string }
  | { line: number; kind: 'extra-marker'; marker: number };

export function isPublicIPv4(address: string): boolean;
export function findPublicIPv4(text: string, allowlist?: ReadonlySet<string>): string[];
export function parseIpAllowlist(text: string): Set<string>;
export function findHostMarkers(text: string, options?: { generic?: boolean }): MarkerFinding[];
export function findSecretPaths(paths: readonly string[]): string[];
export function formatFinding(finding: Finding): string;
/** The text of a file's bytes (UTF-8, or UTF-16 with or without a byte order mark), or undefined for binary bytes. */
export function decodeText(bytes: Uint8Array): string | undefined;
