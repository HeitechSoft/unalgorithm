/** Types for check-firefox-lint.mjs, so the extension's tests can import it. */

/** A message of a `web-ext lint --output json` report. */
export interface LintMessage {
  code: string;
  message: string;
  file?: string;
}

/** A warning reviewed and accepted, by code, file and message. */
export interface ReviewedWarning {
  code: string;
  file: RegExp;
  message: string;
}

export const REVIEWED_WARNINGS: readonly ReviewedWarning[];

/**
 * What in a `web-ext lint --output json` report blocks the build: every error and notice, and every warning no
 * reviewed warning matches. Empty when the build may ship.
 */
export function lintProblems(report: { errors?: LintMessage[]; notices?: LintMessage[]; warnings?: LintMessage[] }): string[];
