// @vitest-environment node
/**
 * What the built extension can send problem reports to (ADR 0009 §1, §2): the production builds for Chrome, Edge and
 * Firefox, built here into a temporary folder, name no GitHub issue form anywhere, and only the background knows the
 * report route, at unAlgorithm Cloud's address; only the e2e build points at the test server. Each build takes a few
 * seconds.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { CLOUD_ORIGIN, REPORTS_PATH, SOURCE_REPO } from '@unalgorithm/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2E_REPORTS_URL } from '../wxt.config.ts';

const ROOT = join(import.meta.dirname, '..');
const BUILDS = [
  { browser: 'chrome', mode: 'production' },
  { browser: 'edge', mode: 'production' },
  { browser: 'firefox', mode: 'production' },
  { browser: 'chrome', mode: 'e2e' },
] as const;

let out: string;

/** `wxt build` into `out`, with the switches a store build is made without (the release's `pnpm zip` sets none). */
function build(browser: string, mode: string): string {
  const script = `import { build } from 'wxt';
await build({ root: process.cwd(), browser: ${JSON.stringify(browser)}, mode: ${JSON.stringify(mode)}, outDir: ${JSON.stringify(out)}, logger: { info() {}, debug() {}, log() {}, success() {}, box() {}, warn: console.warn, error: console.error, fatal: console.error, level: 0 } });`;
  const env = { ...process.env };
  for (const name of ['UA_CLOUD', 'UA_SIDELOAD', 'UA_LICENSES']) delete env[name];
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`wxt build -b ${browser} --mode ${mode} failed:\n${res.stderr}\n${res.stdout}`);
  const dir = join(out, `${browser}-mv3${mode === 'production' ? '' : `-${mode}`}`);
  expect(statSync(dir).isDirectory(), dir).toBe(true);
  return dir;
}

/** Every text file of a build, by its path inside the build. */
function textFiles(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(js|html|json|css|md|txt)$/.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(relative(dir, path).replaceAll('\\', '/'), readFileSync(path, 'utf8'));
  }
  return files;
}

const built = new Map<string, Map<string, string>>();

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'ua-report-bundle-'));
  for (const { browser, mode } of BUILDS) built.set(`${browser}/${mode}`, textFiles(build(browser, mode)));
}, 240_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

describe('built bundles', () => {
  it('test_no_github_issue_form_in_any_bundle', () => {
    for (const [name, files] of built) {
      for (const [file, text] of files) {
        // The licence notices name projects' own issue trackers; the extension's never.
        expect(text.includes(`${SOURCE_REPO.replace('https://', '')}/issues`), `${name} ${file}`).toBe(false);
        if (!file.endsWith('.md') && !file.endsWith('.txt')) expect(text.includes('issues/new'), `${name} ${file}`).toBe(false);
      }
    }
  });

  it('test_production_bundles_post_only_to_the_cloud', () => {
    for (const { browser, mode } of BUILDS.filter((b) => b.mode === 'production')) {
      const files = built.get(`${browser}/${mode}`) as Map<string, string>;
      const naming = [...files].filter(([, text]) => text.includes(REPORTS_PATH)).map(([file]) => file);
      expect(naming, browser).toEqual(['background.js']);
      const background = files.get('background.js') as string;
      expect(background, browser).toContain(CLOUD_ORIGIN);
      expect(background, browser).not.toContain(E2E_REPORTS_URL);
      expect(background, browser).not.toContain(new URL(E2E_REPORTS_URL).host);
      // The report page is in every build, and holds no address to send to.
      expect(files.has('report.html'), browser).toBe(true);
    }
  });

  it('test_only_the_e2e_build_points_at_the_test_server', () => {
    const files = built.get('chrome/e2e') as Map<string, string>;
    expect(files.get('background.js')).toContain(E2E_REPORTS_URL);
    expect([...files].filter(([, text]) => text.includes(REPORTS_PATH)).map(([file]) => file)).toEqual(['background.js']);
  });
});
