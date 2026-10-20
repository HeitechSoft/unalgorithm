// Prints the GitHub Release notes for a version tag: the CHANGELOG section for that version, then the extension's
// install text or the server's source line. The extension's text names the release's files: the store uploads for
// Chrome, Edge and Firefox with the Firefox sources zip, the Chrome and Edge sideload zip, and the signed Firefox file
// when AMO signed one; without it, Firefox users get the firefox zip as a temporary add-on. It mentions the sideload
// zip's sign-in only when that build has one (the Cloud card, UA_CLOUD=1).
// Extension tags (v0.1.0) read apps/extension/CHANGELOG.md; server tags (server-v0.1.0) read apps/server/CHANGELOG.md.
// Usage: node scripts/release-notes.mjs v0.1.0          (after `pnpm zip`: it reads apps/extension/.output)
//        node scripts/release-notes.mjs server-v0.1.0
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVER_TAG = 'server-v';
const SERVER_IMAGE = 'ghcr.io/heitechsoft/unalgorithm-server';

/** The `## <version>` section of a changelog without its heading; empty when the file or the section is missing. */
function changelogSection(text, version) {
  if (text === undefined) return '';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim();
}

/** The files `pnpm zip` makes for every extension release, without the signed Firefox file, which needs AMO. */
export function releaseAssets(version) {
  return ['chrome', 'edge', 'firefox', 'sources', 'sideload'].map((name) => `unalgorithm-${version}-${name}.zip`);
}

/** Where `pnpm zip` leaves the Chrome and Edge sideload build, from the repository root. */
export const SIDELOAD_MANIFEST = 'apps/extension/.output/chrome-mv3-sideload/manifest.json';

/**
 * True when the sideload build can sign in to an unAlgorithm server: only a build with the Cloud card (`UA_CLOUD=1`)
 * asks for `identity`. False when its manifest is missing or unreadable.
 */
function sideloadSignsIn(readFile) {
  try {
    const manifest = JSON.parse(readFile(SIDELOAD_MANIFEST) ?? '{}');
    return [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])].includes('identity');
  } catch {
    return false;
  }
}

function extensionNotes(version, readFile, assets) {
  const notes = changelogSection(readFile('apps/extension/CHANGELOG.md'), version);
  const file = (name) => `unalgorithm-${version}-${name}`;
  const xpi = assets.includes(file('firefox-sideload.xpi'));
  const id = sideloadSignsIn(readFile)
    ? 'It has the development id, so unAlgorithm servers accept its\n  sign-in.'
    : 'It has the development id.';
  return `${notes || `unAlgorithm Feed ${version}`}

**Install:** from the Chrome Web Store, Microsoft Edge Add-ons or Firefox Add-ons once each has reviewed this version.
From this release:
- Chrome or Edge: download \`${file('sideload.zip')}\`, unzip it, open \`chrome://extensions\` or \`edge://extensions\`,
  turn on Developer mode and choose **Load unpacked**. ${id}
- Firefox: ${
    xpi
      ? `open \`${file('firefox-sideload.xpi')}\` in Firefox and add it. Mozilla signed it, with the development id.`
      : `until Firefox Add-ons has this version, try it as a temporary add-on, which Firefox keeps until it restarts
  (it keeps for good only add-ons that Mozilla signed): download \`${file('firefox.zip')}\`, open \`about:debugging\`,
  choose **This Firefox**, then **Load Temporary Add-on…**, and select the zip.`
  }

\`${file('chrome.zip')}\`, \`${file('edge.zip')}\` and \`${file('firefox.zip')}\` are the files sent to each store, and
\`${file('sources.zip')}\` is the source Firefox Add-ons builds the Firefox zip from. Verify any download against
\`SHA256SUMS.txt\` and the build provenance attestation (\`gh attestation verify <file> --repo HeitechSoft/unalgorithm\`).`;
}

function serverNotes(version, readFile) {
  const notes = changelogSection(readFile('apps/server/CHANGELOG.md'), version);
  return `${notes || `unAlgorithm Feed server ${version}`}

**Source:** [server-v${version}](https://github.com/HeitechSoft/unalgorithm/tree/server-v${version}), under
AGPL-3.0-only. The server image (\`${SERVER_IMAGE}\`) is private: HeitechSoft builds it for unAlgorithm Cloud.`;
}

/**
 * The release notes for `tag`. `readFile` takes a path from the repository root and returns the file's text, or
 * undefined when there is no such file: the changelog, and for an extension tag the sideload build's manifest
 * (`SIDELOAD_MANIFEST`). `assets` names the files an extension release carries (`releaseAssets` when left out).
 */
export function notesFor(tag, readFile, assets) {
  if (tag.startsWith(SERVER_TAG)) return serverNotes(tag.slice(SERVER_TAG.length), readFile);
  const version = tag.replace(/^v/, '');
  return extensionNotes(version, readFile, assets ?? releaseAssets(version));
}

function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * True when node runs this file; false when a module imports it (the test does), so importing prints nothing. Node runs
 * the real path of its entry script while argv keeps the path as given, so a run through a symlinked or junction path
 * compares real paths.
 */
function isEntryPoint() {
  const entry = process.argv[1];
  return Boolean(entry) && [entry, realPath(entry)].some((path) => pathToFileURL(path).href === import.meta.url);
}

if (isEntryPoint()) {
  const root = resolve(import.meta.dirname, '..');
  const readFile = (path) => {
    const file = resolve(root, path);
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  };
  const tag = process.argv[2] ?? '';
  // The files `pnpm zip` and the signing step left for this version.
  const output = resolve(root, 'apps/extension/.output');
  const prefix = `unalgorithm-${tag.replace(/^v/, '')}-`;
  const assets = existsSync(output) ? readdirSync(output).filter((name) => name.startsWith(prefix)) : undefined;
  console.log(notesFor(tag, readFile, assets));
}
