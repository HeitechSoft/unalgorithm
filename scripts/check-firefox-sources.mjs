// Checks the sources zip that goes to Firefox Add-ons (AMO) with each Firefox zip, as AMO's review needs it:
// 1. It holds what the build needs and nothing else: no dot folder (the dev profiles in apps/extension/.wxt keep
//    sign-ins), no build output, no node_modules, no key, certificate or env file, nothing outside the extension's
//    workspace, and only files git tracks. WXT zips the working tree and never reads .gitignore, so without that rule
//    a local test report, log or env file would ship.
// 2. Built from its own files the way a reviewer builds it (docs/amo-build.md: `pnpm install --frozen-lockfile`, then
//    the Firefox build, with UA_CLOUD=1 when the shipped manifest has the `identity` permission), it gives the shipped
//    Firefox zip, file for file and byte for byte.
// Usage: node scripts/check-firefox-sources.mjs [--list-only]   (after `pnpm zip`; needs the unzip command)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The only files at the root of the zip: what pnpm needs to install the workspace, and the licence. */
const ROOT_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.nvmrc',
  '.pnpmfile.cjs',
  'tsconfig.base.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'README.md',
];
/** The build instructions, the only file outside the extension's workspace. */
const INSTRUCTIONS = 'docs/amo-build.md';
/** Without these the reviewer can't build at all. */
const REQUIRED = [
  INSTRUCTIONS,
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'LICENSE',
  'apps/extension/package.json',
  'apps/extension/wxt.config.ts',
  'apps/extension/dev-key.json',
];
const SECRET_FILE = /(^|\/)(\.env[^/]*|[^/]+\.(pem|key|p12|pfx|crx|xpi|zip))$/i;

/**
 * Why the sources zip with these entries (paths as `unzip -Z1` lists them) may not go to AMO; empty when it may. With
 * `tracked`, the files git tracks (`trackedFiles`), every other file is refused too: a gitignored or untracked local
 * file is never source a reviewer needs.
 */
export function sourcesProblems(entries, tracked) {
  const files = entries.filter((e) => !e.endsWith('/'));
  const problems = [];
  for (const file of files) {
    if (tracked && !tracked.has(file)) problems.push(`${file}: not in git (a gitignored or untracked local file)`);
    const parts = file.split('/');
    if (parts.length === 1 && !ROOT_FILES.includes(file)) problems.push(`${file}: not a file the build needs`);
    else if (parts.length > 1 && file !== INSTRUCTIONS && !file.startsWith('apps/extension/') && !file.startsWith('packages/'))
      problems.push(`${file}: outside the extension's workspace`);
    if (parts.some((p, i) => p.startsWith('.') && !(i === 0 && ROOT_FILES.includes(p))))
      problems.push(`${file}: in a dot folder or a dot file`);
    if (parts.includes('node_modules')) problems.push(`${file}: an installed package`);
    if (SECRET_FILE.test(file)) problems.push(`${file}: a key, certificate, archive or env file`);
  }
  for (const file of REQUIRED) if (!files.includes(file)) problems.push(`${file}: missing`);
  return problems;
}

/**
 * The files git tracks in the checkout at `root`, as `git ls-files` lists them (from `root`, with forward slashes), or
 * undefined when `root` has no `.git`. `env` is git's environment, so `GIT_INDEX_FILE` there names another index.
 */
export function trackedFiles(root, env = process.env) {
  if (!existsSync(join(root, '.git'))) return undefined;
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return new Set(listed.split('\0').filter(Boolean));
}

/** Every file under `dir`, as paths relative to it with forward slashes, sorted. */
function filesUnder(dir) {
  const out = [];
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(dir, path).replaceAll('\\', '/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** The files that differ between two folders: missing from one, or not the same bytes. */
export function folderDifferences(a, b) {
  const left = filesUnder(a);
  const right = filesUnder(b);
  const differences = [
    ...left.filter((f) => !right.includes(f)).map((f) => `${f}: only in the shipped zip`),
    ...right.filter((f) => !left.includes(f)).map((f) => `${f}: only in the rebuild`),
  ];
  for (const f of left.filter((x) => right.includes(x))) {
    if (!readFileSync(join(a, f)).equals(readFileSync(join(b, f)))) differences.push(`${f}: different bytes`);
  }
  return differences;
}

function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** True when node runs this file; false when a test imports it. */
function isEntryPoint() {
  const entry = process.argv[1];
  return Boolean(entry) && [entry, realPath(entry)].some((path) => pathToFileURL(path).href === import.meta.url);
}

function run(command, args, cwd, env = process.env) {
  execFileSync(command, args, { cwd, env, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
}

/** The environment a reviewer builds with: UA_CLOUD=1 exactly when the shipped add-on can sign in (docs/amo-build.md). */
export function reviewerEnv(manifest, env) {
  const { UA_CLOUD: _ignored, ...rest } = env;
  return manifest.permissions?.includes('identity') ? { ...rest, UA_CLOUD: '1' } : rest;
}

/** Lists and rebuilds the zips in apps/extension/.output; returns the exit code. */
function main(listOnly) {
  const root = resolve(import.meta.dirname, '..');
  const { version } = JSON.parse(readFileSync(join(root, 'apps/extension/package.json'), 'utf8'));
  const output = join(root, 'apps/extension/.output');
  const sourcesZip = join(output, `unalgorithm-${version}-sources.zip`);
  const firefoxZip = join(output, `unalgorithm-${version}-firefox.zip`);

  const entries = execFileSync('unzip', ['-Z1', sourcesZip], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  const tracked = trackedFiles(root);
  if (!tracked) console.warn(`No .git in ${root}: the sources zip's files are not checked against git.`);
  const problems = sourcesProblems(entries, tracked);
  if (problems.length) {
    console.error(`${relative(root, sourcesZip)} can't go to AMO:\n${problems.join('\n')}`);
    return 1;
  }
  const inGit = tracked ? ', all in git' : '';
  console.log(`${relative(root, sourcesZip)}: ${entries.length} entries${inGit}, nothing private, everything the build needs.`);
  if (listOnly) return 0;

  const work = mkdtempSync(join(tmpdir(), 'ua-amo-sources-'));
  try {
    const src = join(work, 'src');
    const shipped = join(work, 'shipped');
    run('unzip', ['-q', sourcesZip, '-d', src], root);
    run('unzip', ['-q', firefoxZip, '-d', shipped], root);
    // As a reviewer builds it: the lockfile's versions, then the Firefox build with the switch the manifest shows.
    const manifest = JSON.parse(readFileSync(join(shipped, 'manifest.json'), 'utf8'));
    run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], src);
    run(
      'pnpm',
      ['--filter', '@unalgorithm/extension', 'exec', 'wxt', 'build', '-b', 'firefox'],
      src,
      reviewerEnv(manifest, process.env),
    );
    const differences = folderDifferences(shipped, join(src, 'apps/extension/.output/firefox-mv3'));
    if (differences.length) {
      console.error(`The rebuild from the sources zip differs from ${relative(root, firefoxZip)}:\n${differences.join('\n')}`);
      return 1;
    }
    console.log(`Rebuilt from the sources zip, the Firefox build matches ${relative(root, firefoxZip)} byte for byte.`);
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (isEntryPoint()) process.exitCode = main(process.argv.includes('--list-only'));
