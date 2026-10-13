// Prints the GitHub Release notes for a version tag: the CHANGELOG section for that version and the install text.
// Extension tags (v0.1.0) read apps/extension/CHANGELOG.md; server tags (server-v0.1.0) read apps/server/CHANGELOG.md.
// Usage: node scripts/release-notes.mjs v0.1.0
//        node scripts/release-notes.mjs server-v0.1.0
import { existsSync, readFileSync, realpathSync } from 'node:fs';
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

function extensionNotes(version, readFile) {
  const notes = changelogSection(readFile('apps/extension/CHANGELOG.md'), version);
  return `${notes || `UnAlgorithm Feed ${version}`}

**Install:** download \`unalgorithm-${version}-chrome.zip\`, unzip it, open \`chrome://extensions\`, turn on
Developer mode and choose **Load unpacked**. Verify the download against \`SHA256SUMS.txt\` and the build provenance
attestation (\`gh attestation verify <zip> --repo HeitechSoft/unalgorithm\`).`;
}

function serverNotes(version, readFile) {
  const notes = changelogSection(readFile('apps/server/CHANGELOG.md'), version);
  return `${notes || `UnAlgorithm Feed server ${version}`}

**Install:** pull \`${SERVER_IMAGE}:${version}\`, or set \`UNALGORITHM_VERSION=${version}\` in the \`.env\` next to
\`apps/server/compose.yaml\` and run \`docker compose pull && docker compose up -d\`. Verify the image against its build
provenance attestation (\`gh attestation verify oci://${SERVER_IMAGE}:${version} --repo HeitechSoft/unalgorithm\`).`;
}

/**
 * The release notes for `tag`. `readFile` takes a path from the repository root and returns the file's text, or
 * undefined when there is no such file.
 */
export function notesFor(tag, readFile) {
  return tag.startsWith(SERVER_TAG)
    ? serverNotes(tag.slice(SERVER_TAG.length), readFile)
    : extensionNotes(tag.replace(/^v/, ''), readFile);
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
  console.log(notesFor(process.argv[2] ?? '', readFile));
}
