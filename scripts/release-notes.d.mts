/** Types for release-notes.mjs, so the strict server tsconfig (no allowJs) accepts its test's import. */

/**
 * The GitHub Release notes for a tag: `server-v<version>` reads `apps/server/CHANGELOG.md` and adds the server install
 * text; any other tag (`v<version>`) reads `apps/extension/CHANGELOG.md` and adds the extension install text.
 * `readFile` takes a path from the repository root and returns the file's text, or undefined for a missing file.
 */
export function notesFor(tag: string, readFile: (path: string) => string | undefined): string;
