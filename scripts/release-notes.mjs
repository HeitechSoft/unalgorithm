// Prints the CHANGELOG section for a version tag (e.g. v0.1.0), for GitHub Release notes.
// Usage: node scripts/release-notes.mjs v0.1.0
import { existsSync, readFileSync } from 'node:fs';

const tag = process.argv[2] ?? '';
const version = tag.replace(/^v/, '');
const file = 'apps/extension/CHANGELOG.md';

let notes = '';
if (existsSync(file)) {
  const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start >= 0) {
    const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
    notes = lines
      .slice(start + 1, end < 0 ? undefined : end)
      .join('\n')
      .trim();
  }
}

console.log(`${notes || `UnAlgorithm ${version}`}

**Install:** download \`unalgorithm-${version}-chrome.zip\`, unzip it, open \`chrome://extensions\`, turn on
Developer mode and choose **Load unpacked**. Verify the download against \`SHA256SUMS.txt\` and the build provenance
attestation (\`gh attestation verify <zip> --repo HeitechSoft/unalgorithm\`).`);
