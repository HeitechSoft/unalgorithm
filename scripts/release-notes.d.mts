/** Types for release-notes.mjs, so the strict server tsconfig (no allowJs) accepts its test's import. */

/**
 * The GitHub Release notes for a tag: `server-v<version>` reads `apps/server/CHANGELOG.md` and adds the server install
 * text; any other tag (`v<version>`) reads `apps/extension/CHANGELOG.md` and adds the extension install text, which
 * names the release's files and mentions the sideload zip's sign-in only when `SIDELOAD_MANIFEST` asks for `identity`.
 * `readFile` takes a path from the repository root and returns the file's text, or undefined for a missing file.
 * `assets` is the extension release's file names (`releaseAssets(version)` when left out).
 */
export function notesFor(tag: string, readFile: (path: string) => string | undefined, assets?: readonly string[]): string;

/** The zips `pnpm zip` makes for every extension release: the three store uploads, the Firefox sources and the sideload. */
export function releaseAssets(version: string): string[];

/** The Chrome and Edge sideload build's manifest, from the repository root, as `pnpm zip` leaves it. */
export const SIDELOAD_MANIFEST: string;
