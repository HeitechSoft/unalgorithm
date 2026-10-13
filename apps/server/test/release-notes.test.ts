import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { notesFor } from '../../../scripts/release-notes.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORKFLOW = join(REPO_ROOT, '.github/workflows/server-release.yml');

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
    expect(notes.startsWith('### Minor Changes\n\n- 1a2b3c4: Email sign-in and classify over HTTP.\n\n**Install:**')).toBe(true);
    expect(notes).not.toContain('Rate limits per user');
    expect(notes).not.toContain('\r');
    expect(notes).toContain('`ghcr.io/heitechsoft/unalgorithm-server:0.1.0`');
    expect(notes).toContain('`UNALGORITHM_VERSION=0.1.0`');
    expect(notes).toContain('`apps/server/compose.yaml`');
    expect(notes).toContain(
      '`gh attestation verify oci://ghcr.io/heitechsoft/unalgorithm-server:0.1.0 --repo HeitechSoft/unalgorithm`',
    );
    // Nothing from the extension's install text.
    expect(notes).not.toMatch(/chrome|\.zip|SHA256SUMS/);
  });

  it('test_server_tag_fallback_heading', () => {
    // No changelog at all, as for the first server release.
    const notes = notesFor('server-v0.1.0', files({}));
    expect(notes.startsWith('UnAlgorithm Feed server 0.1.0\n\n**Install:**')).toBe(true);
    expect(notes).toContain('ghcr.io/heitechsoft/unalgorithm-server:0.1.0');

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

  it('test_release_notes_import_prints_nothing', () => {
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./scripts/release-notes.mjs')"], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(imported.status, imported.stderr).toBe(0);
    expect(imported.stdout).toBe('');

    // Run as a command, it still prints the notes, reading the changelog from the repository.
    const run = spawnSync(process.execPath, ['scripts/release-notes.mjs', 'server-v9.9.9'], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const readRepo = (path: string) => {
      const file = join(REPO_ROOT, path);
      return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    };
    expect(run.stdout).toBe(`${notesFor('server-v9.9.9', readRepo)}\n`);
    expect(run.stdout.startsWith('UnAlgorithm Feed server 9.9.9\n')).toBe(true);
  });
});

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

/** The workflow's text, the parsed workflow, its one job and that job's steps. */
function loadWorkflow() {
  const text = readFileSync(WORKFLOW, 'utf8');
  const workflow = parse(text);
  const release = workflow.jobs.release;
  const steps: Step[] = release.steps;
  return { text, workflow, release, steps };
}

/** `${{ expression }}` as a workflow writes it (a template literal, so it is not read as a mistyped placeholder). */
const expr = (expression: string) => `$\{{ ${expression} }}`;
/** `${name}` as the shell reads it. */
const shellVar = (name: string) => `$\{${name}}`;

describe('workflow file', () => {
  it('test_server_release_workflow_pins_and_triggers', () => {
    const { text, workflow, release, steps } = loadWorkflow();
    // Server tags only: no branches, no pull requests, no other event.
    expect(workflow.on).toEqual({ push: { tags: ['server-v*.*.*'] } });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(workflow.jobs)).toEqual(['release']);
    expect(release.environment).toBe('release');
    expect(release.permissions).toEqual({
      contents: 'write',
      packages: 'write',
      'id-token': 'write',
      attestations: 'write',
    });

    // Every action is pinned to a full commit SHA, with the version it was in a comment.
    const uses = steps.flatMap((step) => (step.uses ? [step.uses] : []));
    expect(uses.length).toBeGreaterThanOrEqual(7);
    for (const action of uses) expect(action).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    const usesLines = text.split('\n').filter((line) => /^\s*(- )?uses:/.test(line));
    expect(usesLines).toHaveLength(uses.length);
    for (const line of usesLines) expect(line).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+\s*$/);
  });

  it('test_server_release_checks_the_tag_before_pushing', () => {
    const { steps } = loadWorkflow();
    const at = (match: (step: Step) => boolean) => {
      const index = steps.findIndex(match);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };
    const verify = at((step) => step.run?.includes('pnpm check') === true);
    const tagCheck = at((step) => step.id === 'version');
    const login = at((step) => step.uses?.startsWith('docker/login-action@') === true);
    const build = at((step) => step.uses?.startsWith('docker/build-push-action@') === true);
    const attest = at((step) => step.uses?.startsWith('actions/attest-build-provenance@') === true);
    const publish = at((step) => step.run?.includes('gh release create') === true);
    const order = [verify, tagCheck, login, build, attest, publish];
    expect(order).toEqual(order.toSorted((a, b) => a - b));

    // The tag check compares the tag with the server's package version and fails the job otherwise.
    const check = steps[tagCheck]?.run ?? '';
    expect(check).toContain("require('./apps/server/package.json').version");
    expect(check).toContain(`"server-v$version" != "${shellVar('GITHUB_REF_NAME')}"`);
    expect(check).toContain('exit 1');

    // The image goes out under the version and latest, with an SBOM and provenance, and is attested by digest.
    const buildStep = steps[build];
    expect(buildStep?.id).toBe('build');
    expect(buildStep?.with).toMatchObject({
      context: '.',
      file: 'apps/server/Dockerfile',
      push: true,
      sbom: true,
      provenance: 'mode=max',
    });
    const version = expr('steps.version.outputs.version');
    expect(buildStep?.with?.['build-args']).toBe(`VERSION=${version}`);
    expect(String(buildStep?.with?.tags).trim().split('\n')).toEqual([
      `ghcr.io/heitechsoft/unalgorithm-server:${version}`,
      'ghcr.io/heitechsoft/unalgorithm-server:latest',
    ]);
    expect(steps[attest]?.with).toEqual({
      'subject-name': 'ghcr.io/heitechsoft/unalgorithm-server',
      'subject-digest': expr('steps.build.outputs.digest'),
      'push-to-registry': true,
    });

    // The GitHub Release is titled for the server and never takes "Latest" from the extension.
    const notes = steps[publish]?.run ?? '';
    expect(notes).toContain(`node scripts/release-notes.mjs "${shellVar('GITHUB_REF_NAME')}" > release-notes.md`);
    expect(notes).toContain(`--title "UnAlgorithm Feed server ${shellVar('VERSION')}"`);
    expect(notes).toContain('--verify-tag');
    expect(notes).toContain('--latest=false');
  });
});
