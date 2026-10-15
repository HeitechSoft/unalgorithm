import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPAT_PREFERENCES } from '@unalgorithm/ai';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { findHostMarkers } from '../../../scripts/scan-public-repo.mjs';
import { SETUP_LINK_TTL_MS } from '../src/admin/setup.ts';
import { testConfig } from './support/test-app.ts';

/**
 * The self-hosting guide (`docs/self-hosting.md`, CL4-18) stays true: every command, file, variable and default it names
 * is read back from the code, so a change to any of them fails here until the guide follows.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SERVER_DIR = fileURLToPath(new URL('../', import.meta.url));
const GUIDE_PATH = resolve(REPO_ROOT, 'docs/self-hosting.md');
const GUIDE = readFileSync(GUIDE_PATH, 'utf8');
const RELEASE = readFileSync(resolve(REPO_ROOT, 'docs/release.md'), 'utf8');
const ENV_EXAMPLE = readFileSync(resolve(SERVER_DIR, '.env.example'), 'utf8');
const COMPOSE = parse(readFileSync(resolve(SERVER_DIR, 'compose.yaml'), 'utf8')) as {
  services: Record<string, { environment?: Record<string, string> }>;
};

/** The guide's `##` headings, exactly and in this order. */
const HEADINGS = [
  'What you get',
  'What you need',
  '1. Install Docker',
  '2. Get the server files',
  '3. Configure',
  '4. Point your domain at the server',
  '5. Start',
  '6. Turn on AI',
  '7. Become the admin',
  '8. Invite people and set limits',
  '9. Connect the extension',
  '10. Backups',
  '11. Restore after losing the server',
  '12. Alerts and monitoring',
  '13. Upgrade',
  'Using your own HTTPS proxy',
  'Naming',
  'Privacy and your users',
  'Troubleshooting',
];
const RESTORE_HEADING = '11. Restore after losing the server';

/** All-caps names the guide may use although `.env.example` lacks them: the extension's build flag, a list in code. */
const NOT_SETTINGS = ['UA_CLOUD', 'COMPAT_PREFERENCES'];

/** The headings of one level outside fenced code, in order, each with the text up to the next heading of that level or higher. */
function sectionsOf(markdown: string, level: number): [heading: string, body: string][] {
  const found: [string, string[]][] = [];
  let current: string[] | undefined;
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,6}) (.+)$/.exec(line);
    if (heading?.[1] && heading[1].length <= level) {
      current = undefined;
      if (heading[1].length === level) {
        current = [];
        found.push([(heading[2] ?? '').trim(), current]);
      }
    } else current?.push(line);
  }
  return found.map(([heading, body]) => [heading, body.join('\n')]);
}

const GUIDE_SECTIONS = sectionsOf(GUIDE, 2);

/** One `##` section's text, which must exist and hold something. */
function section(heading: string): string {
  const body = GUIDE_SECTIONS.find(([h]) => h === heading)?.[1] ?? '';
  expect(body.trim(), `section "${heading}"`).not.toBe('');
  return body;
}

/** GitHub's anchor for a heading: lowercase, punctuation other than `-` dropped, spaces to `-`. */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
}

interface ComposeCommand {
  verb: string;
  /** The service: the first word after the flags; `-e NAME=v` and `--entrypoint <command>` take their next word. */
  service: string | undefined;
  /** The rest of the line after the command, for what it runs inside the service. */
  rest: string;
}

/** Every `docker compose <verb> …` in a text, up to the end of its inline code, quote, redirect or line. */
function composeCommands(text: string): ComposeCommand[] {
  const commands: ComposeCommand[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const m of line.matchAll(/docker compose (exec|run|logs|stop|start|pull|up)\b/g)) {
      const rest = line.slice((m.index ?? 0) + m[0].length);
      const words = (/^[^`'"&|;<>)]*/.exec(rest)?.[0] ?? '').split(/\s+/).filter(Boolean);
      let service: string | undefined;
      for (let i = 0; i < words.length; i++) {
        const word = words[i] ?? '';
        if (word === '-e' || word === '--entrypoint') i++;
        else if (!word.startsWith('-')) {
          service = word;
          break;
        }
      }
      commands.push({ verb: m[1] ?? '', service, rest });
    }
  }
  return commands;
}

/** A `${NAME:-default}` value's default. */
function composeDefault(value: string | undefined): string {
  return /^\$\{\w+:-(.*)\}$/.exec(value ?? '')?.[1] ?? '';
}

/** The first capture of `pattern` in `text`, which must match. */
function capture(text: string, pattern: RegExp): string {
  const m = pattern.exec(text);
  expect(m?.[1], String(pattern)).toBeDefined();
  return m?.[1] ?? '';
}

describe('docs/self-hosting.md: commands and files', () => {
  it('test_guide_cli_paths_exist', () => {
    const names = [...GUIDE.matchAll(/\bcli\/([\w.-]+)\.ts\b/g)].map((m) => m[1] ?? '');
    expect(names).toEqual(expect.arrayContaining(['check-config', 'route-eval', 'setup-link', 'alerts', 'sync-new-epoch']));
    for (const name of new Set(names)) expect(existsSync(resolve(SERVER_DIR, 'src/cli', `${name}.ts`)), name).toBe(true);
  });

  it('test_guide_backup_scripts_exist', () => {
    const names = [...GUIDE.matchAll(/\/scripts\/([\w.-]+)\.sh\b/g)].map((m) => m[1] ?? '');
    expect(names).toEqual(expect.arrayContaining(['backup', 'restore']));
    for (const name of new Set(names)) expect(existsSync(resolve(SERVER_DIR, 'backup', `${name}.sh`)), name).toBe(true);
  });

  it('test_guide_compose_services_exist', () => {
    const services = Object.keys(COMPOSE.services);
    const commands = composeCommands(GUIDE);
    expect(commands.length).toBeGreaterThan(10);
    for (const { verb, service, rest } of commands) {
      // exec and run need a service; the others act on every service without one.
      if (verb === 'exec' || verb === 'run') expect(service, `docker compose ${verb}${rest}`).toBeDefined();
      if (service !== undefined) expect(services, `docker compose ${verb}${rest}`).toContain(service.replace(/[,.]$/, ''));
    }
    // The profiled key service is named, as it is run.
    expect(commands.map((c) => c.service)).toEqual(expect.arrayContaining(['server', 'backup', 'keygen', 'ollama']));
  });

  it('test_guide_variables_documented', () => {
    const documented = new Set([...ENV_EXAMPLE.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
    const named = new Set([...GUIDE.matchAll(/[A-Z][A-Z0-9]*_[A-Z0-9_]+/g)].map((m) => m[0]));
    expect(named.size).toBeGreaterThan(20);
    expect([...named].filter((name) => !documented.has(name) && !NOT_SETTINGS.includes(name))).toEqual([]);
    expect(documented.has('GOOGLE_CLIENT_ID') && documented.has('GOOGLE_CLIENT_SECRET')).toBe(true);
  });
});

describe('docs/self-hosting.md: facts', () => {
  it('test_guide_numbers_match_code', () => {
    const config = testConfig();
    const backup = COMPOSE.services.backup?.environment;

    expect(Number(capture(section('7. Become the admin'), /within (\d+) minutes/))).toBe(SETUP_LINK_TTL_MS / 60_000);

    const backups = section('10. Backups');
    expect(capture(backups, /at (\d\d:\d\d) UTC/)).toBe(composeDefault(backup?.BACKUP_TIME));
    expect(capture(backups, /the newest (\d+) kept/)).toBe(composeDefault(backup?.BACKUP_KEEP));

    const alerts = section('12. Alerts and monitoring');
    expect(Number(capture(alerts, /disk free under (\d+(?:\.\d+)?) GB/)) * 1e9).toBe(config.alerts.diskFreeMinBytes);
    expect(Number(capture(alerts, /database over (\d+(?:\.\d+)?) GB/)) * 1e9).toBe(config.alerts.databaseMaxBytes);
    expect(Number(capture(alerts, /(\d+) errors in 15 minutes/))).toBe(config.alerts.errorsPer15m);
    expect(Number(capture(alerts, /older than (\d+) hours/)) * 3_600_000).toBe(config.alerts.backupMaxAgeMs);

    const limits = section('8. Invite people and set limits');
    const cap = capture(limits, /`USER_DAILY_POST_CAP`, ([\d,]+) by default/);
    expect(cap).toBe(config.userDailyPostCap.toLocaleString('en-US'));
    const spend = capture(limits, /`DAILY_SPEND_LIMIT_USD`, \$(\d+(?:\.\d+)?) by default/);
    expect(Math.round(Number(spend) * 1_000_000)).toBe(config.dailySpendLimitMicros);

    // The extension's own Ollama preferences, in order, without the untagged names; the first is the example model.
    const tagged = (COMPAT_PREFERENCES.ollama ?? []).filter((model) => model.includes(':'));
    const listed = [...new Set([...section('6. Turn on AI').matchAll(/`([a-z][\w.-]*:[\w.-]+)`/g)].map((m) => m[1]))];
    expect(listed).toEqual(tagged.slice(0, 4));
    expect(listed).toEqual(['llama3.2:3b', 'qwen2.5:7b', 'gemma3:4b', 'llama3.1:8b']);
    expect(capture(section('3. Configure'), /AI_MODEL=([\w.:-]+)/)).toBe(COMPAT_PREFERENCES.ollama?.[0]);
  });
});

describe('docs/self-hosting.md: structure and naming', () => {
  it('test_guide_sections_in_order', () => {
    expect(GUIDE_SECTIONS.map(([heading]) => heading)).toEqual(HEADINGS);
    expect(GUIDE.split(/\r?\n/)[0]).toBe('# Run your own UnAlgorithm Feed server');
  });

  it('test_guide_links_resolve', () => {
    const targets = [...GUIDE.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? '');
    const local = targets.filter((target) => !/^[a-z][a-z\d+.-]*:/i.test(target));
    expect(local.length).toBeGreaterThan(5);
    for (const target of local) {
      const [path = '', anchor] = target.split('#');
      const file = path === '' ? GUIDE_PATH : resolve(dirname(GUIDE_PATH), path);
      expect(relative(REPO_ROOT, file).startsWith('..'), target).toBe(false);
      expect(existsSync(file), target).toBe(true);
      // An anchor into a Markdown file names one of its headings.
      if (anchor !== undefined && file.endsWith('.md')) {
        const slugs = [1, 2, 3, 4].flatMap((level) => sectionsOf(readFileSync(file, 'utf8'), level).map(([h]) => slug(h)));
        expect(slugs, target).toContain(anchor);
      }
    }
  });

  it('test_guide_naming_and_hosts', () => {
    const cloud = /UnAlgorithm\s+Cloud/gi;
    const naming = section('Naming');
    expect(naming.match(cloud)?.length ?? 0).toBeGreaterThan(0);
    expect(GUIDE.match(cloud)?.length).toBe(naming.match(cloud)?.length);

    expect(findHostMarkers(GUIDE)).toEqual([]);
    const ipv4 = [...GUIDE.matchAll(/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.]*\d)/g)].map((m) => m[0]);
    expect(ipv4.filter((address) => address !== '127.0.0.1' && address !== '0.0.0.0')).toEqual([]);
  });

  it('test_guide_extension_and_restore_steps', () => {
    const invite = section('8. Invite people and set limits');
    for (const text of ['UA_CLOUD=1', 'EXTENSION_IDS']) expect(invite).toContain(text);

    const extension = section('9. Connect the extension');
    for (const text of ['UA_CLOUD=1', 'EXTENSION_IDS', 'comma-separated', 'docker compose up -d', 'docs/release.md']) {
      expect(extension).toContain(text);
    }

    // The private key is made by keygen and piped over ssh to the reader's computer, then proved right away.
    const backups = section('10. Backups');
    expect(backups).toMatch(/^ssh .*-T keygen' > backup-private-key\.asc$/m);
    expect(backups).toMatch(/^ssh .*restore\.sh --check \/backups\/<file>' < backup-private-key\.asc$/m);
    expect(backups).toContain('restore.checked');
    const throughBackup = (text: string) => composeCommands(text).filter((c) => c.service === 'backup');
    expect(throughBackup(backups).filter((c) => c.rest.includes('keygen.sh'))).toEqual([]);

    // The public key goes back through keygen's shell (the backup service's /keys is read-only), the file through backup.
    const restore = section(RESTORE_HEADING);
    expect(restore).toContain("--entrypoint sh keygen -c 'cat > /keys/backup-public-key.asc'");
    expect(restore).toContain("docker compose exec -T backup sh -c 'cat > /backups/<file>'");
    expect(restore).toContain('sync-new-epoch.ts');
    expect(restore).toContain('backup.sh --once');
    expect(throughBackup(restore).filter((c) => c.rest.includes('cat > /keys/'))).toEqual([]);
  });
});

describe('docs/release.md', () => {
  it('test_release_doc_links_guide_restore', () => {
    const body = sectionsOf(RELEASE, 3).find(([heading]) => heading === 'After restoring a database')?.[1] ?? '';
    const lines = body.split(/\r?\n/).filter((line) => line.trim() !== '');
    expect(lines).toHaveLength(1);
    expect(body).toContain('(self-hosting.md#11-restore-after-losing-the-server)');
    expect(body).not.toMatch(/docker compose|pnpm /);
    const anchor = capture(body, /self-hosting\.md#([\w-]+)/);
    expect(anchor).toBe(slug(RESTORE_HEADING));
    expect(GUIDE_SECTIONS.map(([heading]) => heading)).toContain(RESTORE_HEADING);
  });
});
