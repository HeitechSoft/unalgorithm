import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The privacy gate (CL3-24): a store build that carries the server card (sign-in and sync, `UA_CLOUD=1` in
 * `release.yml`) ships only with a PRIVACY.md that describes them, in the same release (docs/release.md, *Before a
 * store build carries the Cloud card*). The PRIVACY.md text is drafted privately with the store answers (CL3-25), so
 * this test is what stops the flag being flipped first.
 *
 * One switch covers every browser (ADR 0008): `release.yml` builds every zip, Chrome's, Edge's and Firefox's and the
 * sideload builds, in one `pnpm zip` step, and no package script sets the flag itself, so the flag can't reach one
 * store's build without the others' or without this gate.
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

/** A command that builds the extension: `wxt zip` or `wxt build`, or a `pnpm` script named zip or build. */
const BUILD_COMMAND = /\b(?:wxt\s+(?:zip|build)\b|pnpm\s+(?:--filter\s+\S+\s+)?(?:run\s+)?(?:zip|build)(?::[\w:-]+)?(?![\w:-]))/g;

/** Every build command in a workflow's lines, comments left out. */
function buildCommands(workflowYaml: string): string[] {
  return workflowYaml
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .flatMap((line) => line.match(BUILD_COMMAND) ?? []);
}

type Scripts = Record<string, string>;

/**
 * The commands `pnpm zip` runs from the repository root, following `pnpm <script>` and
 * `pnpm --filter @unalgorithm/extension <script>` into the extension's scripts. Each command keeps the environment
 * assignments in front of it (`cross-env UA_SIDELOAD=1 wxt zip`).
 */
function zipCommands(root: Scripts, extension: Scripts): string[] {
  const expand = (scripts: Scripts, name: string, depth: number): string[] => {
    const script = scripts[name];
    if (script === undefined) throw new Error(`no script ${name}`);
    if (depth > 5) throw new Error(`scripts call each other too deep at ${name}`);
    return script.split('&&').flatMap((part) => {
      const command = part.trim();
      const own = /^pnpm\s+(?:run\s+)?([\w:-]+)$/.exec(command);
      if (own?.[1]) return expand(scripts, own[1], depth + 1);
      const filtered = /^pnpm\s+--filter\s+@unalgorithm\/extension\s+(?:run\s+)?([\w:-]+)$/.exec(command);
      if (filtered?.[1]) return expand(extension, filtered[1], depth + 1);
      return [command];
    });
  };
  return expand(root, 'zip', 0);
}

/** Why `pnpm zip` in `release.yml` may not be the one switch for every store build; empty when it is. */
function oneSwitchProblems(workflowYaml: string, root: Scripts, extension: Scripts): string[] {
  const problems: string[] = [];
  const builds = buildCommands(workflowYaml);
  if (builds.length !== 1 || builds[0] !== 'pnpm zip') {
    problems.push(`release.yml must build in one \`pnpm zip\` step; it runs: ${builds.join(', ') || 'no build'}`);
  }
  const commands = zipCommands(root, extension);
  const wxt = commands.filter((c) => /\bwxt\s+(zip|build)\b/.test(c));
  const store = wxt.filter((c) => !c.includes('UA_SIDELOAD=1'));
  const has = (list: string[], test: (c: string) => boolean, what: string) => {
    if (!list.some(test)) problems.push(`pnpm zip builds no ${what}`);
  };
  has(store, (c) => /\bwxt\s+zip\b/.test(c) && !/\s-b\s/.test(c), 'Chrome store zip');
  has(store, (c) => /\bwxt\s+zip\b.*\s-b\s+edge\b/.test(c), 'Edge store zip');
  has(store, (c) => /\bwxt\s+zip\b.*\s-b\s+firefox\b/.test(c), 'Firefox store zip');
  has(wxt, (c) => c.includes('UA_SIDELOAD=1') && /\bwxt\s+zip\b/.test(c) && !/\s-b\s/.test(c), 'Chrome and Edge sideload zip');
  has(wxt, (c) => c.includes('UA_SIDELOAD=1') && /\s-b\s+firefox\b/.test(c), 'Firefox sideload build');
  for (const [where, scripts] of [
    ['package.json', root],
    ['apps/extension/package.json', extension],
  ] as const) {
    for (const [name, script] of Object.entries(scripts)) {
      if (CLOUD_FLAG.test(script)) problems.push(`${where} script "${name}" sets UA_CLOUD itself`);
    }
  }
  return problems;
}

const scriptsOf = (path: string) => (JSON.parse(read(path)) as { scripts: Scripts }).scripts;

describe('one switch for every browser', () => {
  it('test_release_builds_every_browser_in_one_step', () => {
    const problems = oneSwitchProblems(
      read('.github/workflows/release.yml'),
      scriptsOf('package.json'),
      scriptsOf('apps/extension/package.json'),
    );
    expect(problems).toEqual([]);
    // What `pnpm zip` runs today, so a change to the scripts is a change to this test.
    expect(zipCommands(scriptsOf('package.json'), scriptsOf('apps/extension/package.json'))).toEqual([
      'wxt zip',
      'wxt zip -b edge',
      // Firefox's from the repository root, so its sources zip holds the workspace.
      'cd ../..',
      'wxt zip apps/extension -b firefox',
      'cross-env UA_SIDELOAD=1 wxt zip',
      'cross-env UA_SIDELOAD=1 wxt build -b firefox',
    ]);
  });

  it('test_one_switch_refuses_a_build_outside_pnpm_zip', () => {
    const root = scriptsOf('package.json');
    const extension = scriptsOf('apps/extension/package.json');
    // A second build step could take the flag for one store's zip alone.
    for (const extra of ['pnpm zip:firefox', 'pnpm --filter @unalgorithm/extension zip:edge', 'pnpm exec wxt zip -b firefox']) {
      const workflow = `${WORKFLOW_WITHOUT_FLAG}      - name: Again\n        run: ${extra}\n`;
      expect(oneSwitchProblems(workflow, root, extension), extra).toHaveLength(1);
    }
    // A comment naming a command is not a step.
    expect(oneSwitchProblems(`${WORKFLOW_WITHOUT_FLAG}        # then pnpm zip:edge\n`, root, extension)).toEqual([]);
    // A script that sets the flag for one browser, or a `pnpm zip` that leaves a browser out.
    const flagged = { ...extension, 'zip:edge': 'cross-env UA_CLOUD=1 wxt zip -b edge' };
    expect(oneSwitchProblems(WORKFLOW_WITHOUT_FLAG, root, flagged)).toEqual([
      'apps/extension/package.json script "zip:edge" sets UA_CLOUD itself',
    ]);
    const noEdge = { ...extension, 'zip:all': 'pnpm zip && pnpm zip:firefox && pnpm zip:sideload' };
    expect(oneSwitchProblems(WORKFLOW_WITHOUT_FLAG, root, noEdge)).toEqual(['pnpm zip builds no Edge store zip']);
    const noSideload = { ...extension, 'zip:all': 'pnpm zip && pnpm zip:edge && pnpm zip:firefox' };
    expect(oneSwitchProblems(WORKFLOW_WITHOUT_FLAG, root, noSideload)).toEqual([
      'pnpm zip builds no Chrome and Edge sideload zip',
      'pnpm zip builds no Firefox sideload build',
    ]);
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
