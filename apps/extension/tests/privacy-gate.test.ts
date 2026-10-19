import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLOUD_ORIGIN,
  REPORT_BACKUP_NIGHTS,
  REPORT_CONTACT_AFTER_HANDLED_DAYS,
  REPORT_CONTACT_KEEP_DAYS,
  REPORT_KEEP_DAYS,
  REPORT_LOCAL_PER_DAY,
  REPORT_LOCAL_PER_HOUR,
  REPORTS_PATH,
  SUPPORT_EMAIL,
} from '@unalgorithm/protocol';
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
    // ADR 0009 adds the problem report tables to "What a server stores".
    const stores = model.slice(model.indexOf('## What a server stores'), model.indexOf('## What a billing module sees'));
    for (const table of [
      'sync_items',
      'sync_spaces',
      'sync_pushes',
      'passkey',
      'problem_reports',
      'report_floors',
      'correction_counts',
    ]) {
      expect(stores.includes(`\`${table}\``), `docs/privacy-model.md's What a server stores names \`${table}\``).toBe(true);
    }
    expect(model).toContain('## Problem reports');
    expect(model).not.toContain('## Diagnostics');
  });
});

/**
 * The problem report gate (ADR 0009 §5): an extension that can send problem reports ships only with a PRIVACY.md whose
 * *Report a problem* section describes them, says where they go, and no longer describes the GitHub issue form that
 * 0.3 opened. The retention it states is the protocol's: the server purges by those constants, and the report page
 * shows them.
 */

/** One run of whitespace as one space, so line wrapping never matters. */
const flat = (text: string) => text.replace(/\s+/g, ' ');

/** The text of PRIVACY.md's `## heading` section, up to the next `## `; empty when the heading isn't a line of its own. */
function privacySection(privacyMd: string, heading: string): string {
  const lines = privacyMd.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return '';
  const next = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return lines.slice(start, next === -1 ? undefined : next).join('\n');
}

/** The files that can send a problem report: a bundle naming the report route, or a source naming its constant. */
function sendsReports(files: Iterable<readonly [string, string]>): string[] {
  return [...files].filter(([, text]) => text.includes(REPORTS_PATH) || /\bREPORTS_(?:URL|PATH)\b/.test(text)).map(([f]) => f);
}

const CLOUD_HOST = new URL(CLOUD_ORIGIN).host;
/** What 0.3's PRIVACY.md said Report a problem did. */
const GITHUB_FORM = 'opens a new GitHub issue form';

/** Why this build may not ship with this PRIVACY.md; empty when it may. */
function reportGateProblems(files: Iterable<readonly [string, string]>, privacyMd: string): string[] {
  const senders = sendsReports(files);
  if (!senders.length) return [];
  const why = `${senders[0]} can send problem reports`;
  const section = privacySection(privacyMd, 'Report a problem');
  const problems: string[] = [];
  if (!section) problems.push(`${why}, but PRIVACY.md has no line "## Report a problem"`);
  else if (!section.includes(CLOUD_HOST)) problems.push(`${why}, but PRIVACY.md's Report a problem doesn't name ${CLOUD_HOST}`);
  if (flat(privacyMd).includes(GITHUB_FORM)) problems.push(`${why}, but PRIVACY.md still says it "${GITHUB_FORM}"`);
  return problems;
}

/** The sentences PRIVACY.md's Report a problem must hold, each built from the constant it states. */
const RETENTION = [
  `A report is deleted ${REPORT_KEEP_DAYS} days after it arrives.`,
  `A reply email is deleted ${REPORT_CONTACT_AFTER_HANDLED_DAYS} days after we answer, and never kept more than ${REPORT_CONTACT_KEEP_DAYS} days after it arrives`,
  `After ${REPORT_KEEP_DAYS} days, a correction remains only as one more in a count for its quarter, feature and outcome`,
  `Deleted reports stay in the encrypted nightly backups for up to ${REPORT_BACKUP_NIGHTS} more nights.`,
  `This browser sends at most ${REPORT_LOCAL_PER_HOUR} reports an hour and ${REPORT_LOCAL_PER_DAY} a day`,
];

/** The retention sentences missing from PRIVACY.md's Report a problem. */
function retentionProblems(privacyMd: string): string[] {
  const section = flat(privacySection(privacyMd, 'Report a problem'));
  return RETENTION.filter((sentence) => !section.includes(sentence));
}

/**
 * The scripts and pages of each build lying in apps/extension/.output (a local build, say), whenever it was made; none
 * when nothing was built. Each file is read without a check first (CodeQL js/file-system-race).
 */
function builtFiles(): [string, string][] {
  const out = join(REPO_ROOT, 'apps/extension/.output');
  let builds: string[];
  try {
    builds = readdirSync(out, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const files: [string, string][] = [];
  for (const build of builds) {
    for (const file of readdirSync(join(out, build), { recursive: true }) as string[]) {
      if (!/\.(js|html)$/.test(file)) continue;
      try {
        files.push([`${build}/${file}`.replaceAll('\\', '/'), readFileSync(join(out, build, file), 'utf8')]);
      } catch {
        // A folder whose name ends like a file: nothing to read.
      }
    }
  }
  return files;
}

/** The extension's own source files. */
function sourceFiles(): [string, string][] {
  const src = join(REPO_ROOT, 'apps/extension/src');
  return (readdirSync(src, { recursive: true }) as string[])
    .filter((file) => /\.tsx?$/.test(file))
    .map((file): [string, string] => [
      relative(REPO_ROOT, join(src, file)).replaceAll('\\', '/'),
      readFileSync(join(src, file), 'utf8'),
    ]);
}

const PRIVACY_WITH_REPORTS = [
  '# unAlgorithm privacy policy',
  '',
  '## Report a problem',
  '',
  `**Where it goes:** to unAlgorithm Cloud (\`${CLOUD_HOST}\`), HeitechSoft's server.`,
  '',
  '## Permissions',
  '',
].join('\r\n');
const PRIVACY_OF_0_3 = [
  '# unAlgorithm privacy policy',
  '',
  '## Report a problem',
  '',
  '**Report a problem** (in the popup, and under *Why? → Wrong call?*) opens a new GitHub issue form in your browser,',
  '',
].join('\n');
const BUNDLE = [['background.js', `const u="${CLOUD_ORIGIN}${REPORTS_PATH}";fetch(u,{method:"POST"})`]] as const;

describe('problem report gate', () => {
  it('test_report_gate_passes_for_this_privacy_policy', () => {
    const privacy = read('PRIVACY.md');
    // The source sends reports (`background/report.ts`), and so does every bundle built from it
    // (`report-bundle.test.ts` builds them and finds the route in background.js): this PRIVACY.md must describe them.
    const sources = sourceFiles();
    expect(sendsReports(sources)).toEqual(['apps/extension/src/background/report.ts']);
    expect(reportGateProblems(sources, privacy)).toEqual([]);
    // Any build lying in apps/extension/.output too, whenever it was made.
    expect(reportGateProblems(builtFiles(), privacy)).toEqual([]);
  });

  it('test_report_gate_refuses_a_policy_without_the_section', () => {
    // A bundle that names the route, with the 0.3 policy: no Cloud, and the GitHub form.
    expect(reportGateProblems(BUNDLE, PRIVACY_OF_0_3)).toEqual([
      `background.js can send problem reports, but PRIVACY.md's Report a problem doesn't name ${CLOUD_HOST}`,
      `background.js can send problem reports, but PRIVACY.md still says it "${GITHUB_FORM}"`,
    ]);
    // No section at all; a heading named inside a paragraph is not the heading.
    expect(reportGateProblems(BUNDLE, `# unAlgorithm privacy policy\n\nSee ## Report a problem at ${CLOUD_HOST}.\n`)).toEqual([
      'background.js can send problem reports, but PRIVACY.md has no line "## Report a problem"',
    ]);
    // The Cloud named elsewhere in the policy doesn't count: the section must say where reports go.
    const elsewhere = PRIVACY_WITH_REPORTS.replace(CLOUD_HOST, 'HeitechSoft').concat(
      `\r\nThe source list comes from ${CLOUD_HOST}.\r\n`,
    );
    expect(reportGateProblems(BUNDLE, elsewhere)).toHaveLength(1);
    // The old sentence anywhere, even wrapped over two lines, still fails.
    const wrapped = `${PRIVACY_WITH_REPORTS}\r\nIt opens a new GitHub\r\nissue form.\r\n`;
    expect(reportGateProblems(BUNDLE, wrapped)).toEqual([
      `background.js can send problem reports, but PRIVACY.md still says it "${GITHUB_FORM}"`,
    ]);
  });

  it('test_report_gate_accepts_the_section_and_ignores_builds_that_cannot_send', () => {
    expect(reportGateProblems(BUNDLE, PRIVACY_WITH_REPORTS)).toEqual([]);
    // A build without the route (0.3) is not this gate's business, whatever the policy says.
    expect(reportGateProblems([['background.js', 'fetch("https://example.com/v1/classify")']], PRIVACY_OF_0_3)).toEqual([]);
    // The e2e build's test address names the route too, and source that imports the constant counts.
    expect(sendsReports([['bg.js', 'fetch("http://127.0.0.1:47911/v1/reports")']])).toEqual(['bg.js']);
    expect(sendsReports([['report.ts', "import { REPORTS_URL } from '@unalgorithm/protocol';"]])).toEqual(['report.ts']);
    expect(sendsReports([['popup.ts', 'const REPORTS_URLS = 1;']])).toEqual([]);
  });

  it('test_privacy_states_the_protocol_retention', () => {
    const privacy = read('PRIVACY.md');
    expect(retentionProblems(privacy)).toEqual([]);
    // Each sentence follows its constant: the policy can't keep an old number once the purge changes.
    const changed = privacy.replace(
      `deleted ${REPORT_KEEP_DAYS} days after it arrives`,
      `deleted ${REPORT_KEEP_DAYS + 30} days after it arrives`,
    );
    expect(retentionProblems(changed)).toEqual([RETENTION[0]]);
    // Only in its own section: the same words elsewhere don't count.
    const moved = privacy.replace('## Report a problem', '## Reporting');
    expect(retentionProblems(moved)).toEqual(RETENTION);
  });

  it('test_retention_is_said_the_same_everywhere', () => {
    // The Cloud's beta notice and the corrections page repeat the numbers; they say what PRIVACY.md and the purge do.
    const notice = flat(read('CLOUD-BETA-NOTICE.md'));
    expect(notice).toContain(
      `Reports are deleted after ${REPORT_KEEP_DAYS} days, a reply email ${REPORT_CONTACT_AFTER_HANDLED_DAYS} days after we answer and never more than ${REPORT_CONTACT_KEEP_DAYS} days after it arrived.`,
    );
    expect(flat(read('docs/site/corrections.md'))).toContain(
      `We keep a correction for ${REPORT_KEEP_DAYS} days, and your email address until ${REPORT_CONTACT_AFTER_HANDLED_DAYS} days after we answer, never more than ${REPORT_CONTACT_KEEP_DAYS} days.`,
    );
  });

  it('test_privacy_report_section_covers_adr_0009', () => {
    // ADR 0009 §5: what PRIVACY.md's Report a problem names, and the owner's decisions (mailbox, person in charge).
    const privacy = read('PRIVACY.md');
    const section = flat(privacySection(privacy, 'Report a problem'));
    for (const phrase of [
      'nothing is sent until you click Send report',
      'Why? → Wrong call?',
      'Report a wrong verdict',
      'Report a mistake',
      'Settings → About',
      'whatever AI you use',
      'Never sent:',
      'From a private window',
      SUPPORT_EMAIL,
      'technical and interaction data',
      'unAlgorithm never asks for it',
      "HeitechSoft's team reads each report",
      'IP address',
      'Origin',
      'midnight UTC',
      'whether it was the first report of its kind that day about that site',
      'in Firefox it holds a random id unique to this install',
      'that it came from a private window',
      'error log can keep your IP address for up to 14 days',
      'HeitechSoft, in Ontario, Canada, is responsible',
      'clicking **Send report** is your consent',
      'email privacy@heitechsoft.com with your reference; we answer within 30 days',
      'Beauharnois, Quebec',
    ]) {
      expect(section, phrase).toContain(phrase);
    }
    // The opening and the device bullets say a report is the one more thing that can be sent.
    expect(flat(privacy.slice(0, privacy.indexOf('## When you turn on AI')))).toContain('or send a problem report');
    // One person in charge, named once, as the Cloud's beta notice names its privacy contact.
    expect(privacy.match(/Tom\s+Heiber/g)).toHaveLength(1);
    expect(flat(privacySection(privacy, 'Changes and contact'))).toContain(
      "Tom Heiber, HeitechSoft's person in charge of the protection of personal information",
    );
    expect(flat(read('CLOUD-BETA-NOTICE.md'))).toContain('Privacy contact: Tom Heiber, HeitechSoft, privacy@heitechsoft.com');
    // The Firefox rule: every build lists the type, it is never asked for, and the permissions row says what it decides.
    expect(flat(privacy)).toContain('Every version also lists *technical and interaction data*');
    expect(flat(privacy)).not.toContain("Versions without the server sign-in don't list it");
    expect(flat(privacy)).toMatch(
      /\| Firefox only, optional: share website content, personal communications and technical and interaction data;/,
    );
  });
});
