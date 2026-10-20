// Generates THIRD_PARTY_NOTICES.md from the open-source packages that are actually bundled into the extension.
// It runs the production build of every browser target with source maps (UA_LICENSES=1, see
// apps/extension/wxt.config.ts) and with the Cloud card (UA_CLOUD=1, the most a store build can bundle), and lists
// every package those maps reference, so dev-only tools are left out and bundled helpers from devDependencies (WXT's
// runtime) are included. One file goes into every zip, so it fails when the browsers bundle different packages.
// Usage: node scripts/third-party-notices.mjs [--check]
// --check exits non-zero when the committed file is out of date (used in CI).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'THIRD_PARTY_NOTICES.md');
/** Every browser the release zips are built for. */
const BROWSERS = ['chrome', 'edge', 'firefox'];

function* mapFiles(dir) {
  // Sorted, so the output does not depend on the file system's directory order.
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* mapFiles(p);
    else if (p.endsWith('.map')) yield p;
  }
}

/** Absolute package directories referenced by one browser's bundle (one per bundled name@version). */
function bundledDirs(browser) {
  execFileSync('pnpm', ['--filter', '@unalgorithm/extension', 'exec', 'wxt', 'build', '-b', browser], {
    cwd: ROOT,
    env: { ...process.env, UA_LICENSES: '1', UA_CLOUD: '1' },
    // Build output stays quiet; errors still reach the console (and CI logs).
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: process.platform === 'win32',
  });
  const dirs = new Set();
  for (const map of mapFiles(join(ROOT, `apps/extension/.output/${browser}-mv3-licenses`))) {
    const { sources = [] } = JSON.parse(readFileSync(map, 'utf8'));
    for (const source of sources) {
      const at = source.lastIndexOf('node_modules/');
      if (at < 0) continue;
      const parts = source.slice(at + 'node_modules/'.length).split('/');
      const name = parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
      if (name) dirs.add(resolve(dirname(map), source.slice(0, at + 'node_modules/'.length + name.length)));
    }
  }
  return dirs;
}

const perBrowser = BROWSERS.map((browser) => ({ browser, dirs: bundledDirs(browser) }));
const dirs = new Set(perBrowser.flatMap(({ dirs }) => [...dirs]));
const divergent = perBrowser.flatMap(({ browser, dirs: own }) =>
  [...dirs].filter((dir) => !own.has(dir)).map((dir) => `${browser} does not bundle ${dir}`),
);
if (divergent.length) {
  console.error(
    `The browsers bundle different packages, so one THIRD_PARTY_NOTICES.md can't describe every zip:\n${divergent.join('\n')}`,
  );
  process.exit(1);
}

/**
 * Upstream license texts for packages whose npm tarball ships none, copied from their source repositories:
 * github.com/wxt-dev/wxt/blob/main/LICENSE covers the whole WXT monorepo; standard-webhooks/libraries/LICENSE
 * covers its JavaScript library.
 */
const OVERRIDES = {
  wxt: 'wxt.txt',
  '@wxt-dev/browser': 'wxt.txt',
  '@wxt-dev/storage': 'wxt.txt',
  standardwebhooks: 'standardwebhooks.txt',
};

function licenseText(name, dir) {
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  const path = file ? join(dir, file) : OVERRIDES[name] ? join(ROOT, 'scripts/license-overrides', OVERRIDES[name]) : null;
  return path ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n').trim() : null;
}

function homepage(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const url = pkg.homepage ?? repo;
  if (!url) return null;
  return url
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^github:/, 'https://github.com/')
    .replace(/^([\w.-]+\/[\w.-]+)$/, 'https://github.com/$1');
}

const byKey = new Map();
for (const dir of dirs) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  byKey.set(`${pkg.name}@${pkg.version}`, { dir, pkg });
}
const packages = [...byKey.values()]
  .map(({ dir, pkg }) => {
    const name = pkg.name;
    return {
      name,
      version: pkg.version,
      license: pkg.license ?? 'UNKNOWN',
      homepage: homepage(pkg),
      text: licenseText(name, dir),
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'));

let md = `# Third-party notices

The unAlgorithm extension bundles the following open-source software. This file is generated from the build by
\`node scripts/third-party-notices.mjs\`; do not edit it by hand. It is also included in every release zip.

| Package | Version | License |
|---|---|---|
${packages.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`).join('\n')}
`;

for (const p of packages) {
  md += `\n## ${p.name} ${p.version}\n\n`;
  if (p.homepage) md += `${p.homepage}\n\n`;
  md += p.text
    ? `\`\`\`text\n${p.text}\n\`\`\`\n`
    : `License: ${p.license}. The published package includes no license file; see the project homepage for the full text.\n`;
}

if (process.argv.includes('--check')) {
  let current;
  try {
    current = readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    console.error('THIRD_PARTY_NOTICES.md is missing. Run: node scripts/third-party-notices.mjs');
    process.exit(1);
  }
  if (current !== md) {
    console.error('THIRD_PARTY_NOTICES.md is out of date. Run: node scripts/third-party-notices.mjs');
    process.exit(1);
  }
  console.log(`THIRD_PARTY_NOTICES.md is up to date (${packages.length} bundled packages).`);
} else {
  writeFileSync(OUT, md);
  console.log(`Wrote THIRD_PARTY_NOTICES.md (${packages.length} bundled packages).`);
}
