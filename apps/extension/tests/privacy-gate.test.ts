import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The privacy gate (CL3-24): a store build that carries the server card (sign-in and sync, `UA_CLOUD=1` in
 * `release.yml`) ships only with a PRIVACY.md that describes them, in the same release (docs/release.md, *Before a
 * store build carries the Cloud card*). The PRIVACY.md text is drafted privately with the store answers (CL3-25), so
 * this test is what stops the flag being flipped first.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8');

/** `UA_CLOUD: "1"`, `UA_CLOUD: '1'`, `UA_CLOUD: 1` or `UA_CLOUD=1`, as a step's `env` or a shell assignment sets it. */
const CLOUD_FLAG = /\bUA_CLOUD\s*(?::\s*|=)(?:"1"|'1'|1(?![\w.]))/;

/** What PRIVACY.md must hold before the flag is set: two headings, each a line of its own, and a permissions row. */
const REQUIRED_LINES = ['## When you sign in to an unAlgorithm server', '### Sync between your computers'];
const REQUIRED_ROW = '| Alarms';

/** Why this workflow may not ship with this PRIVACY.md; empty when it may. */
function privacyGateProblems(workflowYaml: string, privacyMd: string): string[] {
  if (!CLOUD_FLAG.test(workflowYaml)) return [];
  const lines = privacyMd.split(/\r?\n/).map((line) => line.trim());
  const problems = REQUIRED_LINES.filter((line) => !lines.includes(line)).map(
    (line) => `release.yml sets UA_CLOUD=1, but PRIVACY.md has no line "${line}"`,
  );
  if (!lines.some((line) => line.startsWith(REQUIRED_ROW))) {
    problems.push(`release.yml sets UA_CLOUD=1, but PRIVACY.md's permissions table has no "${REQUIRED_ROW}" row`);
  }
  return problems;
}

const WORKFLOW_WITHOUT_FLAG = ['      - name: Build zip', '        run: pnpm zip', ''].join('\n');
const WORKFLOW_WITH_FLAG = [
  '      - name: Build zip',
  '        run: pnpm zip',
  '        env:',
  '          UA_CLOUD: "1"',
  '',
].join('\n');

/** PRIVACY.md as it is today: no sign-in or sync sections and no Alarms row. */
const PRIVACY_WITHOUT_SECTIONS = [
  '# unAlgorithm privacy policy',
  '',
  '## When you turn on AI',
  '',
  '## Permissions',
  '',
  '| Permission | Why |',
  '|---|---|',
  '| Storage | To keep your settings and statistics in your browser |',
  '',
].join('\n');

/** PRIVACY.md as the release that sets the flag has it, with CRLF line ends as a Windows checkout may. */
const PRIVACY_WITH_SECTIONS = [
  '# unAlgorithm privacy policy',
  '',
  '## When you sign in to an unAlgorithm server',
  '',
  '### Sync between your computers',
  '',
  '## Permissions',
  '',
  '| Permission | Why |',
  '|---|---|',
  '| Storage | To keep your settings and statistics in your browser |',
  '| Alarms | To sync your settings every 30 seconds while sync is on |',
  '',
].join('\r\n');

describe('release gate', () => {
  it('test_privacy_gate_passes_without_cloud_flag', () => {
    // A renamed or moved workflow fails here loudly (the read throws) instead of silently passing the gate.
    const workflow = read('.github/workflows/release.yml');
    expect(workflow).toContain('pnpm zip');
    expect(privacyGateProblems(workflow, read('PRIVACY.md'))).toEqual([]);
  });

  it('test_privacy_gate_refuses_cloud_without_sections', () => {
    const problems = privacyGateProblems(WORKFLOW_WITH_FLAG, PRIVACY_WITHOUT_SECTIONS);
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toContain('## When you sign in to an unAlgorithm server');
    expect(problems.join('\n')).toContain('### Sync between your computers');
    expect(problems.join('\n')).toContain('| Alarms');
    // The flag in each spelling the gate knows, and only the flag: the same workflow without it passes.
    for (const flag of ['UA_CLOUD: "1"', "UA_CLOUD: '1'", 'UA_CLOUD: 1', 'UA_CLOUD=1 pnpm zip']) {
      expect(privacyGateProblems(`        ${flag}\n`, PRIVACY_WITHOUT_SECTIONS), flag).toHaveLength(3);
    }
    for (const notFlag of ['UA_CLOUD: "0"', 'UA_CLOUD: 10', 'UA_CLOUD: 1.5']) {
      expect(privacyGateProblems(`        ${notFlag}\n`, PRIVACY_WITHOUT_SECTIONS), notFlag).toEqual([]);
    }
    expect(privacyGateProblems(WORKFLOW_WITHOUT_FLAG, PRIVACY_WITHOUT_SECTIONS)).toEqual([]);
    // A heading mentioned inside a paragraph is not the heading.
    const mentioned = `${PRIVACY_WITHOUT_SECTIONS}See ## When you sign in to an unAlgorithm server.\n`;
    expect(privacyGateProblems(WORKFLOW_WITH_FLAG, mentioned)).toHaveLength(3);
  });

  it('test_privacy_gate_accepts_cloud_with_sections', () => {
    expect(privacyGateProblems(WORKFLOW_WITH_FLAG, PRIVACY_WITH_SECTIONS)).toEqual([]);
  });
});

describe('docs inventory', () => {
  it('test_privacy_model_names_personal_tables', () => {
    const model = read('docs/privacy-model.md');
    for (const table of ['sync_items', 'sync_spaces', 'sync_pushes', 'passkey']) {
      expect(model.includes(`\`${table}\``), `docs/privacy-model.md names \`${table}\``).toBe(true);
    }
  });
});
