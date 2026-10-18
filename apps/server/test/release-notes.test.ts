import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { notesFor, releaseAssets, SIDELOAD_MANIFEST } from '../../../scripts/release-notes.mjs';
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

/** The sideload manifest of a build with the Cloud card (UA_CLOUD=1): Chrome asks for `identity` at sign-in. */
const CLOUD_SIDELOAD_MANIFEST = JSON.stringify({ permissions: ['storage', 'alarms'], optional_permissions: ['identity'] });
/** The same build without the Cloud card, as a release builds it until `release.yml` sets UA_CLOUD: no sign-in. */
const STORE_SIDELOAD_MANIFEST = JSON.stringify({ permissions: ['storage'], optional_permissions: ['scripting'] });

describe('release notes', () => {
  it('test_server_tag_notes_from_changelog', () => {
    const notes = notesFor('server-v0.1.0', files({ 'apps/server/CHANGELOG.md': SERVER_CHANGELOG }));

    // The 0.1.0 section only: not the heading, not the newer 0.2.0 section.
    expect(notes.startsWith('### Minor Changes\n\n- 1a2b3c4: Email sign-in and classify over HTTP.\n\n**Source:**')).toBe(true);
    expect(notes).not.toContain('Rate limits per user');
    expect(notes).not.toContain('\r');
    // The source this release is built from, under the AGPL. The image is private (unAlgorithm Cloud's), so nothing
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
    expect(notes.startsWith('unAlgorithm Feed server 0.1.0\n\n**Source:**')).toBe(true);
    expect(notes).toContain('/tree/server-v0.1.0)');

    // A changelog without that version: the same fallback. The extension's changelog is never read for a server tag.
    const missing = notesFor(
      'server-v0.3.0',
      files({ 'apps/server/CHANGELOG.md': SERVER_CHANGELOG, 'apps/extension/CHANGELOG.md': EXTENSION_CHANGELOG }),
    );
    expect(missing.startsWith('unAlgorithm Feed server 0.3.0\n\n')).toBe(true);
  });

  it('test_extension_tag_notes_name_every_release_file', () => {
    const read = files({
      'apps/extension/CHANGELOG.md': EXTENSION_CHANGELOG,
      'apps/server/CHANGELOG.md': SERVER_CHANGELOG,
      [SIDELOAD_MANIFEST]: CLOUD_SIDELOAD_MANIFEST,
    });

    // The changelog section, then how to install from the stores or from this release, and what every file is.
    expect(notesFor('v0.2.0', read)).toBe(
      `### Minor Changes

- 1a2b3c4: Hide suggested posts on Facebook.

### Patch Changes

- 5d6e7f8: Calmer popup copy.

**Install:** from the Chrome Web Store, Microsoft Edge Add-ons or Firefox Add-ons once each has reviewed this version.
From this release:
- Chrome or Edge: download \`unalgorithm-0.2.0-sideload.zip\`, unzip it, open \`chrome://extensions\` or \`edge://extensions\`,
  turn on Developer mode and choose **Load unpacked**. It has the development id, so unAlgorithm servers accept its
  sign-in.
- Firefox: until Firefox Add-ons has this version, try it as a temporary add-on, which Firefox keeps until it restarts
  (it keeps for good only add-ons that Mozilla signed): download \`unalgorithm-0.2.0-firefox.zip\`, open \`about:debugging\`,
  choose **This Firefox**, then **Load Temporary Add-on…**, and select the zip.

\`unalgorithm-0.2.0-chrome.zip\`, \`unalgorithm-0.2.0-edge.zip\` and \`unalgorithm-0.2.0-firefox.zip\` are the files sent to each store, and
\`unalgorithm-0.2.0-sources.zip\` is the source Firefox Add-ons builds the Firefox zip from. Verify any download against
\`SHA256SUMS.txt\` and the build provenance attestation (\`gh attestation verify <file> --repo HeitechSoft/unalgorithm\`).`,
    );
    // No changelog section: the fallback heading, and the same files.
    const fallback = notesFor('v0.3.0', read);
    expect(fallback.startsWith('unAlgorithm Feed 0.3.0\n\n**Install:**')).toBe(true);
    for (const asset of releaseAssets('0.3.0')) expect(fallback).toContain(`\`${asset}\``);
    expect(releaseAssets('0.3.0')).toEqual([
      'unalgorithm-0.3.0-chrome.zip',
      'unalgorithm-0.3.0-edge.zip',
      'unalgorithm-0.3.0-firefox.zip',
      'unalgorithm-0.3.0-sources.zip',
      'unalgorithm-0.3.0-sideload.zip',
    ]);
    expect(fallback).not.toContain('.xpi');
  });

  it('test_extension_notes_offer_signed_firefox_file', () => {
    // When AMO signed the Firefox sideload build, the release carries it and the notes point Firefox users to it.
    const assets = [...releaseAssets('0.3.0'), 'unalgorithm-0.3.0-firefox-sideload.xpi'];
    const notes = notesFor('v0.3.0', files({}), assets);
    expect(notes).toContain(
      '- Firefox: open `unalgorithm-0.3.0-firefox-sideload.xpi` in Firefox and add it. Mozilla signed it, with the development id.',
    );
    // The signed file replaces the temporary add-on.
    expect(notes).not.toMatch(/about:debugging|Temporary Add-on/);
    // A server tag never lists extension files, whatever the folder holds.
    expect(notesFor('server-v0.3.0', files({}), assets)).not.toMatch(/\.zip|\.xpi/);
  });

  it('test_extension_notes_mention_sign_in_only_when_the_build_has_it', () => {
    const chromeLine = (manifest?: string) => {
      const notes = notesFor('v0.3.0', files(manifest === undefined ? {} : { [SIDELOAD_MANIFEST]: manifest }));
      return notes.slice(notes.indexOf('- Chrome or Edge:'), notes.indexOf('- Firefox:'));
    };
    // Built with the Cloud card, the sideload zip signs in with the development id, which servers accept.
    expect(chromeLine(CLOUD_SIDELOAD_MANIFEST)).toContain(
      'It has the development id, so unAlgorithm servers accept its\n  sign-in.',
    );
    // `identity` granted with the extension counts the same.
    expect(chromeLine(JSON.stringify({ permissions: ['identity'] }))).toContain('accept its\n  sign-in.');
    // Without the Cloud card the build has no sign-in, so the notes promise none. Nor when the manifest is missing (no
    // `pnpm zip` yet) or unreadable.
    for (const manifest of [STORE_SIDELOAD_MANIFEST, undefined, '{', 'null']) {
      const line = chromeLine(manifest);
      expect(line, String(manifest)).toContain('**Load unpacked**. It has the development id.\n');
      expect(line, String(manifest)).not.toMatch(/sign-in|unAlgorithm server/);
    }
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
    expect(run.stdout.startsWith('unAlgorithm Feed server 9.9.9\n')).toBe(true);
  });
});
