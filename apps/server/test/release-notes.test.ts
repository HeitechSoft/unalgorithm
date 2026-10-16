import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { notesFor } from '../../../scripts/release-notes.mjs';
import { PROCESS_TIMEOUT, SPAWN_TIMEOUT } from './support/timeouts.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** A readFile over in-memory files by repository path; undefined for any other path, as for a missing file. */
function files(contents: Record<string, string>) {
  const byPath = new Map(Object.entries(contents));
  return (path: string) => byPath.get(path);
}

/** A changelog as the Version PR writes it, with CRLF line ends as a Windows checkout may have them. */
const SERVER_CHANGELOG = [
  '# @unalgorithm/server',
  '',
  '## 0.2.0',
  '',
  '### Minor Changes',
  '',
  '- 9f8e7d6: Rate limits per user.',
  '',
  '## 0.1.0',
  '',
  '### Minor Changes',
  '',
  '- 1a2b3c4: Email sign-in and classify over HTTP.',
  '',
].join('\r\n');

const EXTENSION_CHANGELOG = [
  '# @unalgorithm/extension',
  '',
  '## 0.2.0',
  '',
  '### Minor Changes',
  '',
  '- 1a2b3c4: Hide suggested posts on Facebook.',
  '',
  '### Patch Changes',
  '',
  '- 5d6e7f8: Calmer popup copy.',
  '',
  '## 0.1.0',
  '',
  '### Minor Changes',
  '',
  '- First public preview.',
  '',
].join('\n');

describe('release notes', () => {
  it('test_server_tag_notes_from_changelog', () => {
    const notes = notesFor('server-v0.1.0', files({ 'apps/server/CHANGELOG.md': SERVER_CHANGELOG }));

    // The 0.1.0 section only: not the heading, not the newer 0.2.0 section.
    expect(notes.startsWith('### Minor Changes\n\n- 1a2b3c4: Email sign-in and classify over HTTP.\n\n**Source:**')).toBe(true);
    expect(notes).not.toContain('Rate limits per user');
    expect(notes).not.toContain('\r');
    // The source this release is built from, under the AGPL. The image is private (UnAlgorithm Cloud's), so nothing
    // tells anyone to pull it.
    expect(notes).toContain('(https://github.com/HeitechSoft/unalgorithm/tree/server-v0.1.0)');
    expect(notes).toContain('AGPL-3.0-only');
    expect(notes).toContain('private');
    expect(notes).not.toMatch(/\bpull\b|docker compose|UNALGORITHM_VERSION|gh attestation/);
    // Nothing from the extension's install text.
    expect(notes).not.toMatch(/chrome|\.zip|SHA256SUMS/);
  });

  it('test_server_tag_fallback_heading', () => {
    // No changelog at all, as for the first server release.
    const notes = notesFor('server-v0.1.0', files({}));
    expect(notes.startsWith('UnAlgorithm Feed server 0.1.0\n\n**Source:**')).toBe(true);
    expect(notes).toContain('/tree/server-v0.1.0)');

    // A changelog without that version: the same fallback. The extension's changelog is never read for a server tag.
    const missing = notesFor(
      'server-v0.3.0',
      files({ 'apps/server/CHANGELOG.md': SERVER_CHANGELOG, 'apps/extension/CHANGELOG.md': EXTENSION_CHANGELOG }),
    );
    expect(missing.startsWith('UnAlgorithm Feed server 0.3.0\n\n')).toBe(true);
  });

  it('test_extension_tag_notes_unchanged', () => {
    const read = files({ 'apps/extension/CHANGELOG.md': EXTENSION_CHANGELOG, 'apps/server/CHANGELOG.md': SERVER_CHANGELOG });

    // What scripts/release-notes.mjs printed for v0.2.0 before server tags existed (without console.log's newline).
    expect(notesFor('v0.2.0', read)).toBe(
      `### Minor Changes

- 1a2b3c4: Hide suggested posts on Facebook.

### Patch Changes

- 5d6e7f8: Calmer popup copy.

**Install:** download \`unalgorithm-0.2.0-chrome.zip\`, unzip it, open \`chrome://extensions\`, turn on
Developer mode and choose **Load unpacked**. Verify the download against \`SHA256SUMS.txt\` and the build provenance
attestation (\`gh attestation verify <zip> --repo HeitechSoft/unalgorithm\`).`,
    );
    expect(notesFor('v0.3.0', read)).toBe(
      `UnAlgorithm Feed 0.3.0

**Install:** download \`unalgorithm-0.3.0-chrome.zip\`, unzip it, open \`chrome://extensions\`, turn on
Developer mode and choose **Load unpacked**. Verify the download against \`SHA256SUMS.txt\` and the build provenance
attestation (\`gh attestation verify <zip> --repo HeitechSoft/unalgorithm\`).`,
    );
  });

  it('test_release_notes_import_prints_nothing', { timeout: SPAWN_TIMEOUT }, () => {
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./scripts/release-notes.mjs')"], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: PROCESS_TIMEOUT,
    });
    expect(imported.status, imported.stderr).toBe(0);
    expect(imported.stdout).toBe('');

    // Run as a command, it still prints the notes, reading the changelog from the repository.
    const run = spawnSync(process.execPath, ['scripts/release-notes.mjs', 'server-v9.9.9'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: PROCESS_TIMEOUT,
    });
    expect(run.status, run.stderr).toBe(0);
    const readRepo = (path: string) => {
      const file = join(REPO_ROOT, path);
      return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    };
    expect(run.stdout).toBe(`${notesFor('server-v9.9.9', readRepo)}\n`);
    expect(run.stdout.startsWith('UnAlgorithm Feed server 9.9.9\n')).toBe(true);
  });
});
