/** Types for check-server-licenses.mjs, so the strict server tsconfig (no allowJs) accepts its test's import. */

/** Why a package version fails: `copyleft` always fails; a reviewed entry clears the other two. */
export type LicenseRule = 'copyleft' | 'needs-legal-review' | 'unknown';

/** One package of `pnpm licenses list --json`, which groups packages by licence. */
export interface LicensedPackage {
  name: string;
  versions: string[];
  /** An SPDX expression, or whatever the package declares. */
  license: string;
}

export interface LicenseViolation {
  name: string;
  version: string;
  license: string;
  rule: LicenseRule;
}

/**
 * Judges a `pnpm licenses list --json` report, with `reviewed` holding the reviewed exceptions by `name@version` (the
 * contents of scripts/license-review.json).
 */
export function evaluate(
  report: Record<string, LicensedPackage[]>,
  reviewed: Record<string, string>,
): { ok: boolean; violations: LicenseViolation[] };
