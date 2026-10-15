#!/usr/bin/env node
/**
 * Fails if the server's production dependency tree holds third-party code under a licence the server cannot take
 * (ADR 0007: the billing module stays private only while HeitechSoft can license all the server code it builds on).
 * The tree is the production dependencies of @unalgorithm/server and of @unalgorithm/web, whose bundle ships in the
 * server image. Workspace packages are not listed, so the project's own AGPL code never trips the check. Rules:
 * - copyleft (GPL, AGPL and LGPL, in any spelling): always fails; a review cannot clear it;
 * - needs-legal-review (MPL, EPL, CDDL and EUPL): fails unless scripts/license-review.json names the package version;
 * - unknown (no licence, `SEE LICENSE IN …`, an expression that does not parse, or an id outside the allow list):
 *   fails unless scripts/license-review.json names the package version.
 * A licence is an SPDX expression: OR passes when either side passes, AND only when both do.
 * The extension's dependencies are checked by dependency-review.yml, which allows more.
 *
 * Usage: node scripts/check-server-licenses.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** dependency-review.yml's allow list without its copyleft entries, upper-cased (SPDX ids are case-insensitive). */
const ALLOWED = new Set(
  [
    'MIT',
    'MIT-0',
    'ISC',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'Apache-2.0',
    '0BSD',
    'Unlicense',
    'CC0-1.0',
    'BlueOak-1.0.0',
    'Zlib',
    'Python-2.0',
    'CC-BY-4.0',
  ].map((id) => id.toUpperCase()),
);

/** GPL, AGPL and LGPL in SPDX form with any suffix, and spellings such as `GPL`, `GPLv3` and `LGPLv2`. */
const COPYLEFT_ID = /^(A|L)?GPL(?:v?\d|-|$)/i;
/** Weak copyleft, which only a lawyer can clear. */
const WEAK_COPYLEFT_ID = /^(MPL|EPL|CDDL|EUPL)-/i;

/** Severities, from passing to most severe. A review clears every failing severity but COPYLEFT. */
const PASS = 0;
const UNKNOWN = 1;
const NEEDS_LEGAL_REVIEW = 2;
const COPYLEFT = 3;
const RULES = { [UNKNOWN]: 'unknown', [NEEDS_LEGAL_REVIEW]: 'needs-legal-review', [COPYLEFT]: 'copyleft' };

/** The severity of one licence id. */
function judge(id) {
  if (ALLOWED.has(id.toUpperCase())) return PASS;
  if (COPYLEFT_ID.test(id)) return COPYLEFT;
  if (WEAK_COPYLEFT_ID.test(id)) return NEEDS_LEGAL_REVIEW;
  return UNKNOWN;
}

/**
 * The severity of an SPDX expression, by recursive descent:
 * `expr := and (OR and)*`, `and := atom (AND atom)*`, `atom := '(' expr ')' | id [WITH id]`.
 * AND takes its most severe child. OR takes its least severe one, since passing one side is enough, so a failing OR is
 * reported as copyleft only when a review could not clear it either. A leaf is judged by its id before WITH.
 * Throws when the expression does not parse.
 */
function severity(expression) {
  const tokens = expression.match(/[()]|[^\s()]+/g) ?? [];
  let at = 0;
  const isOperator = (token, name) => token?.toUpperCase() === name;
  const take = () => {
    if (at >= tokens.length) throw new Error('unexpected end');
    return tokens[at++];
  };
  const id = () => {
    const token = take();
    if (token === '(' || token === ')' || ['AND', 'OR', 'WITH'].some((name) => isOperator(token, name)))
      throw new Error(`unexpected ${token}`);
    return token;
  };

  function expr() {
    let result = and();
    while (isOperator(tokens[at], 'OR')) {
      at++;
      result = Math.min(result, and());
    }
    return result;
  }
  function and() {
    let result = atom();
    while (isOperator(tokens[at], 'AND')) {
      at++;
      result = Math.max(result, atom());
    }
    return result;
  }
  function atom() {
    if (tokens[at] === '(') {
      at++;
      const result = expr();
      if (take() !== ')') throw new Error('missing )');
      return result;
    }
    const license = id();
    if (isOperator(tokens[at], 'WITH')) {
      at++;
      id();
    }
    return judge(license);
  }

  const result = expr();
  if (at < tokens.length) throw new Error(`unexpected ${tokens[at]}`);
  return result;
}

/** The rule a package version's licence fails, or undefined when it passes. */
function ruleFor(license, reviewed) {
  let level;
  try {
    level = severity(license);
  } catch {
    level = UNKNOWN;
  }
  if (level === PASS || (reviewed && level !== COPYLEFT)) return undefined;
  return RULES[level];
}

/**
 * Judges a `pnpm licenses list --json` report (`{ "<license>": [{ name, versions, license }] }`) against the rules,
 * with `reviewed` holding the reviewed exceptions by `name@version`. Each version of a package is judged on its own.
 */
export function evaluate(report, reviewed) {
  const violations = [];
  for (const packages of Object.values(report)) {
    for (const { name, versions, license = '' } of packages) {
      for (const version of versions) {
        const rule = ruleFor(license, Object.hasOwn(reviewed, `${name}@${version}`));
        if (rule) violations.push({ name, version, license, rule });
      }
    }
  }
  violations.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'));
  return { ok: violations.length === 0, violations };
}

function main() {
  const output = execFileSync(
    'pnpm',
    ['licenses', 'list', '--json', '--prod', '--filter', '@unalgorithm/server...', '--filter', '@unalgorithm/web...'],
    {
      cwd: resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      // pnpm's errors still reach the console (and CI logs).
      stdio: ['ignore', 'pipe', 'inherit'],
      shell: process.platform === 'win32',
    },
  );
  const report = JSON.parse(output);
  const reviewed = JSON.parse(readFileSync(new URL('license-review.json', import.meta.url), 'utf8'));
  if (typeof reviewed !== 'object' || reviewed === null || Array.isArray(reviewed))
    throw new Error('scripts/license-review.json must hold an object');

  const count = Object.values(report).reduce((n, packages) => n + packages.reduce((m, p) => m + p.versions.length, 0), 0);
  const { ok, violations } = evaluate(report, reviewed);
  for (const { name, version, license, rule } of violations) console.log(`${name}@${version}  ${license || '(none)'}  ${rule}`);
  if (ok) {
    console.log(`server licences ok (${count} packages)`);
    return;
  }
  console.log(
    `server licences: ${violations.length} of ${count} packages fail. Copyleft cannot be cleared; the other rules pass ` +
      'only with a reviewed entry in scripts/license-review.json.',
  );
  process.exitCode = 1;
}

function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * True when node runs this file; false when a module imports it (the test does), so importing runs nothing: no pnpm, no
 * exit. Node runs the real path of its entry script while argv keeps the path as given, so a run through a symlinked or
 * junction path compares real paths. Otherwise the check would silently pass.
 */
function isEntryPoint() {
  const entry = process.argv[1];
  return Boolean(entry) && [entry, realPath(entry)].some((path) => pathToFileURL(path).href === import.meta.url);
}

if (isEntryPoint()) {
  try {
    main();
  } catch (err) {
    console.error(`server licence check failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
