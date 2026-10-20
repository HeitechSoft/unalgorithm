/** Types for check-firefox-sources.mjs, so the extension's tests can import it. */

/**
 * Why a sources zip with these entries (paths as `unzip -Z1` lists them) may not go to AMO; empty when it may. With
 * `tracked` (`trackedFiles`), any file git doesn't track is refused too.
 */
export function sourcesProblems(entries: readonly string[], tracked?: ReadonlySet<string>): string[];

/**
 * The files git tracks in the checkout at `root`, as `git ls-files` lists them, or undefined when `root` has no `.git`.
 * `env` is git's environment (`process.env` when left out).
 */
export function trackedFiles(root: string, env?: Readonly<Record<string, string | undefined>>): Set<string> | undefined;

/** The files that differ between two folders: missing from one, or not the same bytes. */
export function folderDifferences(a: string, b: string): string[];

/** The environment a reviewer builds with: `env` with UA_CLOUD=1 exactly when the manifest has `identity`. */
export function reviewerEnv(
  manifest: { permissions?: readonly string[] },
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined>;
