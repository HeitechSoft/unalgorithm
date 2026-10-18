/**
 * What a release ships besides the store zips (ADR 0008): the sideload builds, with the development identity so
 * servers accept their sign-in, and the Firefox sources zip AMO builds from, checked for anything private; and the
 * add-on linter's reviewed warnings, which are all a Firefox build may have.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEV_CHROMIUM_ID, FIREFOX_ADDON_ID, FIREFOX_DEV_ADDON_ID } from '@unalgorithm/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lintProblems } from '../../../scripts/check-firefox-lint.mjs';
import { folderDifferences, reviewerEnv, sourcesProblems, trackedFiles } from '../../../scripts/check-firefox-sources.mjs';
import devKey from '../dev-key.json' with { type: 'json' };
import config, { manifestFor, sideloadManifest } from '../wxt.config.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** The config's `build:manifestGenerated` hook, which changes the manifest WXT generated in place. */
function manifestHook(of: typeof config): (wxt: { config: { browser: string; mode: string } }, manifest: object) => void {
  const hooks = of.hooks as Record<string, (wxt: { config: { browser: string; mode: string } }, manifest: object) => void>;
  const hook = hooks['build:manifestGenerated'];
  if (!hook) throw new Error('no build:manifestGenerated hook');
  return hook;
}

describe('sideload builds', () => {
  it('test_sideload_manifest_has_development_identity', () => {
    expect(devKey.id).toBe(DEV_CHROMIUM_ID);
    // Chrome's store manifest plus the dev key: one zip for Chrome and Edge.
    const chrome = manifestFor('production', 'chrome');
    expect(chrome).not.toHaveProperty('key');
    expect(sideloadManifest(chrome, 'chrome', 'production')).toEqual({ ...chrome, key: devKey.key });
    // Firefox's store manifest with the development add-on id, and nothing else changed.
    const firefox = manifestFor('production', 'firefox');
    expect(firefox.browser_specific_settings?.gecko?.id).toBe(FIREFOX_ADDON_ID);
    const sideloaded = sideloadManifest(firefox, 'firefox', 'production');
    expect(sideloaded.browser_specific_settings?.gecko).toEqual({
      ...firefox.browser_specific_settings?.gecko,
      id: FIREFOX_DEV_ADDON_ID,
    });
    expect({ ...sideloaded, browser_specific_settings: undefined }).toEqual({ ...firefox, browser_specific_settings: undefined });
    expect(sideloaded).not.toHaveProperty('key');
    // Development and e2e builds already have the development identity.
    for (const mode of ['development', 'e2e']) {
      const own = manifestFor(mode, 'chrome');
      expect(sideloadManifest(own, 'chrome', mode)).toBe(own);
    }
  });

  it('test_store_builds_keep_store_identity', () => {
    // Without UA_SIDELOAD, the zips are the store zips: no key, the store add-on id, the store file names.
    expect(config.zip?.artifactTemplate).toBe('unalgorithm-{{version}}-{{browser}}.zip');
    expect(config.outDirTemplate).toBeUndefined();
    const manifest = manifestFor('production', 'chrome') as Record<string, unknown>;
    const hook = manifestHook(config);
    hook({ config: { browser: 'chrome', mode: 'production' } }, manifest);
    expect(manifest).not.toHaveProperty('key');
  });

  it('test_sideload_switch_names_its_own_folder_and_zip', async () => {
    vi.stubEnv('UA_SIDELOAD', '1');
    const { default: sideload } = await import('../wxt.config.ts');
    expect(sideload.outDirTemplate).toBe('{{browser}}-mv{{manifestVersion}}-sideload');
    expect(sideload.zip?.artifactTemplate).toBe('unalgorithm-{{version}}-sideload.zip');
    const hook = manifestHook(sideload);
    const chrome = manifestFor('production', 'chrome') as Record<string, unknown>;
    hook({ config: { browser: 'chrome', mode: 'production' } }, chrome);
    expect(chrome.key).toBe(devKey.key);
    const firefox = manifestFor('production', 'firefox');
    hook({ config: { browser: 'firefox', mode: 'production' } }, firefox);
    expect(firefox.browser_specific_settings?.gecko?.id).toBe(FIREFOX_DEV_ADDON_ID);
  });
});

describe('Firefox sources zip', () => {
  const NEEDED = [
    'docs/amo-build.md',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'LICENSE',
    'apps/extension/package.json',
    'apps/extension/wxt.config.ts',
    'apps/extension/dev-key.json',
  ];

  it('test_sources_zip_config_leaves_out_dot_folders', () => {
    const zip = config.zip;
    expect(zip?.sourcesTemplate).toBe('unalgorithm-{{version}}-sources.zip');
    // Dot folders (the dev profiles in apps/extension/.wxt, .output, .git) never match an include.
    expect(zip?.dotSources ?? false).toBe(false);
    expect(zip?.includeSources).toEqual(
      expect.arrayContaining(['pnpm-lock.yaml', 'docs/amo-build.md', 'apps/extension/**', 'packages/**']),
    );
    // The zip doesn't read .gitignore: the local leftovers it ignores are listed, at any depth.
    expect(zip?.excludeSources).toEqual(
      expect.arrayContaining(['**/test-results/**', '**/playwright-report/**', '**/coverage/**', '**/*.log', '**/*.local']),
    );
  });

  it('test_sources_problems_accepts_the_build_inputs', () => {
    const entries = [
      ...NEEDED,
      '.npmrc',
      '.nvmrc',
      '.pnpmfile.cjs',
      'apps/extension/',
      'apps/extension/src/entrypoints/background.ts',
      'packages/core/src/index.ts',
    ];
    expect(sourcesProblems(entries)).toEqual([]);
  });

  it('test_sources_problems_refuses_private_and_stray_files', () => {
    const problems = (extra: string) => sourcesProblems([...NEEDED, extra]);
    // The dev profile, which keeps a LinkedIn session; the build output; an installed package.
    expect(problems('apps/extension/.wxt/chrome-data/Default/Cookies')).toEqual([
      'apps/extension/.wxt/chrome-data/Default/Cookies: in a dot folder or a dot file',
    ]);
    expect(problems('apps/extension/.output/firefox-mv3/background.js')).toHaveLength(1);
    expect(problems('packages/core/node_modules/zod/index.js')).toEqual([
      'packages/core/node_modules/zod/index.js: an installed package',
    ]);
    // Keys, certificates, env files and archives, wherever they are.
    for (const secret of ['apps/extension/key.pem', 'packages/ai/.env', 'apps/extension/signed.xpi', 'packages/x/a.zip']) {
      expect(problems(secret).length, secret).toBeGreaterThan(0);
    }
    // Anything outside the extension's workspace, or a root file the build doesn't need.
    expect(problems('apps/server/src/index.ts')).toEqual(["apps/server/src/index.ts: outside the extension's workspace"]);
    expect(problems('docs/release.md')).toEqual(["docs/release.md: outside the extension's workspace"]);
    expect(problems('notes.txt')).toEqual(['notes.txt: not a file the build needs']);
    // A zip a reviewer can't build from.
    expect(sourcesProblems(NEEDED.filter((f) => f !== 'pnpm-lock.yaml'))).toEqual(['pnpm-lock.yaml: missing']);
  });

  it('test_sources_problems_refuses_files_git_does_not_track', () => {
    // WXT zips the working tree and never reads .gitignore: a test report, log or local env file left there would ship.
    const committed = [...NEEDED, 'apps/extension/src/entrypoints/background.ts', 'packages/core/src/index.ts'];
    const tracked = new Set(committed);
    expect(sourcesProblems([...committed, 'apps/extension/', 'packages/core/'], tracked)).toEqual([]);
    expect(sourcesProblems([...committed, 'apps/extension/test-results/feed/error-context.md'], tracked)).toEqual([
      'apps/extension/test-results/feed/error-context.md: not in git (a gitignored or untracked local file)',
    ]);
    // A file every other rule accepts is still refused when git doesn't track it.
    expect(sourcesProblems([...committed, 'packages/core/src/scratch.ts'])).toEqual([]);
    expect(sourcesProblems([...committed, 'packages/core/src/scratch.ts'], tracked)).toEqual([
      'packages/core/src/scratch.ts: not in git (a gitignored or untracked local file)',
    ]);
    // A needed file that isn't tracked is refused, not taken as the build input.
    expect(sourcesProblems(committed, new Set(committed.filter((f) => f !== 'apps/extension/wxt.config.ts')))).toEqual([
      'apps/extension/wxt.config.ts: not in git (a gitignored or untracked local file)',
    ]);
  });

  it('test_tracked_files_are_what_git_tracks', () => {
    const root = mkdtempSync(join(tmpdir(), 'ua-tracked-'));
    try {
      // Without git's own variables, which point git elsewhere (a hook sets GIT_INDEX_FILE, for one).
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
      expect(trackedFiles(root, env)).toBeUndefined();
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, stdio: 'ignore' });
      git('init', '-q');
      const write = (path: string) => {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), '');
      };
      writeFileSync(join(root, '.gitignore'), 'test-results\n*.log\n');
      // One tracked file, two gitignored ones and one git doesn't know.
      const files = [
        'apps/extension/wxt.config.ts',
        'apps/extension/test-results/x/trace.md',
        'apps/extension/debug.log',
        'apps/extension/notes.txt',
      ];
      for (const path of files) write(path);
      git('add', '.gitignore', 'apps/extension/wxt.config.ts');
      const tracked = trackedFiles(root, env);
      expect([...(tracked ?? [])].sort()).toEqual(['.gitignore', 'apps/extension/wxt.config.ts']);
      const refused = sourcesProblems(files, tracked).filter((p) => p.includes('not in git'));
      expect(refused.map((p) => p.split(':')[0])).toEqual(files.slice(1));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('test_reviewer_builds_with_the_switch_the_manifest_shows', () => {
    // A store build without sign-in is built without UA_CLOUD, whatever the checking shell has set.
    expect(reviewerEnv(manifestFor('production', 'firefox'), { PATH: '/bin', UA_CLOUD: '1' })).toEqual({ PATH: '/bin' });
    // With sign-in (`identity`), with it.
    vi.stubEnv('UA_CLOUD', '1');
    expect(reviewerEnv(manifestFor('production', 'firefox'), { PATH: '/bin' })).toEqual({ PATH: '/bin', UA_CLOUD: '1' });
  });

  it('test_folder_differences_by_bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'ua-folders-'));
    try {
      const write = (path: string, text: string) => {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      write('a/manifest.json', '{}');
      write('a/chunks/x.js', 'one');
      write('a/only-a.txt', '');
      write('b/manifest.json', '{}');
      write('b/chunks/x.js', 'two');
      write('b/only-b.txt', '');
      expect(folderDifferences(join(root, 'a'), join(root, 'b'))).toEqual([
        'only-a.txt: only in the shipped zip',
        'only-b.txt: only in the rebuild',
        'chunks/x.js: different bytes',
      ]);
      expect(folderDifferences(join(root, 'a'), join(root, 'a'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Firefox add-on lint', () => {
  const zodProbe = { code: 'DANGEROUS_EVAL', message: 'The Function constructor is eval.' };
  const reactHtml = { code: 'UNSAFE_VAR_ASSIGNMENT', message: 'Unsafe assignment to innerHTML' };

  it('test_lint_accepts_only_reviewed_warnings', () => {
    // The production build's report: zod's probe in every bundle, react-dom's innerHTML in the page and content bundles.
    const warnings = [
      { ...zodProbe, file: 'background.js' },
      { ...zodProbe, file: 'content-scripts/facebook.js' },
      { ...zodProbe, file: 'content-scripts/linkedin.js' },
      { ...zodProbe, file: 'chunks/hooks-CmaoERyR.js' },
      { ...reactHtml, file: 'content-scripts/facebook.js' },
      { ...reactHtml, file: 'chunks/hooks-CmaoERyR.js' },
    ];
    expect(lintProblems({ errors: [], notices: [], warnings })).toEqual([]);
  });

  it('test_lint_refuses_errors_notices_and_new_warnings', () => {
    expect(
      lintProblems({
        errors: [{ code: 'ADDON_ID_REQUIRED', message: 'An add-on ID is required.', file: 'manifest.json' }],
        notices: [{ code: 'KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION', message: 'Not supported.', file: 'manifest.json' }],
        warnings: [
          // react-dom's warning in the background, which has no React: not the reviewed one.
          { ...reactHtml, file: 'background.js' },
          // The reviewed code and file, a different message.
          { ...zodProbe, file: 'background.js', message: 'eval can be harmful.' },
          { code: 'MANIFEST_PERMISSIONS', message: 'Unknown permission.', file: 'manifest.json' },
        ],
      }),
    ).toEqual([
      'error ADDON_ID_REQUIRED in manifest.json: An add-on ID is required.',
      'notice KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION in manifest.json: Not supported.',
      'warning UNSAFE_VAR_ASSIGNMENT in background.js: Unsafe assignment to innerHTML',
      'warning DANGEROUS_EVAL in background.js: eval can be harmful.',
      'warning MANIFEST_PERMISSIONS in manifest.json: Unknown permission.',
    ]);
  });
});
