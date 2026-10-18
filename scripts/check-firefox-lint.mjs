// Runs Mozilla's add-on linter (web-ext lint, the checks AMO runs on upload) on a Firefox build and fails on any error
// or notice, and on any warning that is not one of the reviewed ones below.
// Usage: node scripts/check-firefox-lint.mjs <build folder>   (e.g. apps/extension/.output/firefox-mv3)
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Warnings reviewed and accepted, by code, file and message. Each names code that is in the bundle but is safe:
 * - zod probes for `new Function` support when it loads; the extension sets `jitless`, so the probe's answer is never
 *   used and zod never compiles code (src/lib/zod-jitless.ts).
 * - react-dom sets `innerHTML` for `dangerouslySetInnerHTML` and SVG; the extension passes it no HTML.
 */
export const REVIEWED_WARNINGS = [
  {
    code: 'DANGEROUS_EVAL',
    file: /^(background\.js|content-scripts\/(facebook|linkedin)\.js|chunks\/[\w-]+\.js)$/,
    message: 'The Function constructor is eval.',
  },
  {
    code: 'UNSAFE_VAR_ASSIGNMENT',
    file: /^(content-scripts\/(facebook|linkedin)\.js|chunks\/[\w-]+\.js)$/,
    message: 'Unsafe assignment to innerHTML',
  },
];

/**
 * What in a `web-ext lint --output json` report blocks the build: every error and notice, and every warning that no
 * `REVIEWED_WARNINGS` entry matches. Empty when the build may ship.
 */
export function lintProblems(report) {
  const line = (kind, m) => `${kind} ${m.code} in ${m.file ?? '(no file)'}: ${m.message}`;
  const reviewed = (m) =>
    REVIEWED_WARNINGS.some((r) => r.code === m.code && r.file.test(m.file ?? '') && m.message === r.message);
  return [
    ...(report.errors ?? []).map((m) => line('error', m)),
    ...(report.notices ?? []).map((m) => line('notice', m)),
    ...(report.warnings ?? []).filter((m) => !reviewed(m)).map((m) => line('warning', m)),
  ];
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

if (isEntryPoint()) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: node scripts/check-firefox-lint.mjs <build folder>');
    process.exit(2);
  }
  const extension = resolve(import.meta.dirname, '../apps/extension');
  let output;
  try {
    output = execFileSync(
      'pnpm',
      ['exec', 'web-ext', 'lint', '--source-dir', resolve(dir), '--output', 'json', '--no-config-discovery'],
      { cwd: extension, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' },
    );
  } catch (err) {
    // web-ext exits non-zero when it finds errors; its report is still on stdout.
    output = err.stdout ?? '';
  }
  const report = JSON.parse(output);
  const problems = lintProblems(report);
  if (problems.length) {
    console.error(`The Firefox build in ${dir} fails the add-on linter:\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log(`The Firefox build in ${dir} passes the add-on linter (${report.count} reviewed warnings).`);
}
