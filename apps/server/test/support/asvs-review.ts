import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/**
 * The checks of an OWASP ASVS 5.0.0 self-review (CL5-11): a Markdown document with one table row per requirement ID of
 * the pinned level 1 and 2 list (`| ID | Status | Evidence | Finding |`) and a findings section of `### ASVS-<L><n> — title`
 * headings with `Severity:`, `Status:`, `Fix:`, `Regression test:` and `Accepted by:` lines. A support module so the
 * private billing review (CL5-26) runs the same checks on its own document and test roots.
 */

export interface ReviewRow {
  id: string;
  status: string;
  evidence: string;
  finding: string;
}

export interface ReviewFinding {
  id: string;
  title: string;
  severity: string;
  status: string;
  fix: string;
  regressionTest: string;
  acceptedBy: string;
}

export interface Review {
  rows: ReviewRow[];
  findings: ReviewFinding[];
}

const REQ_ID = /^V\d+\.\d+\.\d+$/;
const FINDING_ID = /^ASVS-[A-Z]\d+$/;
const STATUSES = new Set(['pass', 'fail', 'n/a']);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const FINDING_STATUSES = new Set(['open', 'fixed', 'accepted']);
const SEVERE = new Set(['critical', 'high']);
/** A test name is a bare identifier; anything else in an evidence cell is a repo path. */
const TEST_NAME = /^[A-Za-z_]\w*$/;
const SKIP_DIRS = new Set(['node_modules', '.output', '.wxt', 'dist', 'coverage', 'test-results', 'playwright-report']);
/** The review's own test holds fixture names; a name found only there is not evidence. */
const SELF = 'asvs-review.test.ts';

/** The requirement IDs of an ID file: every non-empty line that is not a `#` header. */
export function readIdFile(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

const cellsOf = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());

const FIELDS: Record<string, keyof ReviewFinding> = {
  severity: 'severity',
  status: 'status',
  fix: 'fix',
  'regression test': 'regressionTest',
  'accepted by': 'acceptedBy',
};

/** The review's requirement rows (table rows whose first cell is a `V<n>.<n>.<n>` ID) and findings. */
export function parseReview(md: string): Review {
  const rows: ReviewRow[] = [];
  const findings: ReviewFinding[] = [];
  let current: ReviewFinding | undefined;
  for (const line of md.split(/\r?\n/)) {
    const heading = /^###\s+(ASVS-\S*)\s*(?:—|–|-)?\s*(.*)$/.exec(line);
    if (heading) {
      current = {
        id: heading[1] ?? '',
        title: heading[2] ?? '',
        severity: '',
        status: '',
        fix: '',
        regressionTest: '',
        acceptedBy: '',
      };
      findings.push(current);
      continue;
    }
    if (/^#/.test(line)) {
      current = undefined;
      continue;
    }
    if (line.trim().startsWith('|')) {
      const [id = '', status = '', evidence = '', finding = ''] = cellsOf(line);
      if (REQ_ID.test(id)) rows.push({ id, status: status.toLowerCase(), evidence, finding });
      continue;
    }
    const field = /^([A-Za-z ]+):\s*(.*)$/.exec(line.trim());
    const key = field ? FIELDS[(field[1] ?? '').toLowerCase()] : undefined;
    if (current && field && key) {
      const value = (field[2] ?? '').trim();
      current[key] = key === 'severity' || key === 'status' ? value.toLowerCase() : value;
    }
  }
  return { rows, findings };
}

const unquote = (item: string): string => item.trim().replace(/^`|`$/g, '').trim();
const splitEvidence = (cell: string): string[] => cell.split(/;\s*/).map(unquote).filter(Boolean);
const findingIdsOf = (cell: string): string[] =>
  cell
    .split(/[\s;,]+/)
    .map(unquote)
    .filter(Boolean);

/** Every `*.test.ts` and `*.test.mjs` file's text under the test roots, except the review's own test. */
function testSources(repoRoot: string, testRoots: string[]): string[] {
  const sources: string[] = [];
  const walk = (dir: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path);
      } else if (/\.test\.(ts|mjs)$/.test(entry.name) && entry.name !== SELF) {
        sources.push(readFileSync(path, 'utf8'));
      }
    }
  };
  for (const root of testRoots) walk(join(repoRoot, root));
  return sources;
}

/**
 * Everything wrong with `review` against the requirement `ids`: missing, duplicated, unknown or out-of-order IDs, invalid
 * statuses, unsupported verdicts (evidence paths resolved against `repoRoot`, test names searched in the test files under
 * `testRoots`) and incomplete findings. `[]` when the review is complete and its evidence exists.
 */
export function reviewProblems(ids: string[], review: Review, repoRoot: string, testRoots: string[]): string[] {
  const problems: string[] = [];
  const known = new Set(ids);
  const seen = new Map<string, number>();
  for (const row of review.rows) seen.set(row.id, (seen.get(row.id) ?? 0) + 1);
  for (const id of ids) {
    const count = seen.get(id) ?? 0;
    if (count === 0) problems.push(`${id}: missing from the review`);
    if (count > 1) problems.push(`${id}: listed more than once`);
  }
  for (const id of seen.keys()) if (!known.has(id)) problems.push(`${id}: not an ID of the requirement list`);
  const order = [...new Set(review.rows.map((row) => row.id).filter((id) => known.has(id)))];
  const expected = ids.filter((id) => seen.has(id));
  const outOfPlace = order.findIndex((id, i) => id !== expected[i]);
  if (outOfPlace !== -1) problems.push(`${order[outOfPlace]}: out of order (expected ${expected[outOfPlace]} here)`);

  let sources: string[] | undefined;
  const testExists = (name: string): boolean => {
    sources ??= testSources(repoRoot, testRoots);
    const pattern = new RegExp(`\\b${name}\\b`);
    return sources.some((source) => pattern.test(source));
  };
  const evidenceProblem = (item: string): string | undefined => {
    if (TEST_NAME.test(item)) return testExists(item) ? undefined : `test ${item} occurs in no test file`;
    if (isAbsolute(item) || item.split(/[\\/]/).includes('..')) return `${item} is not a repo path`;
    return existsSync(join(repoRoot, item)) ? undefined : `${item} does not exist`;
  };

  const findingIds = new Set(review.findings.map((finding) => finding.id));
  for (const row of review.rows) {
    if (!STATUSES.has(row.status)) problems.push(`${row.id}: status "${row.status}" is not pass, fail or n/a`);
    const evidence = splitEvidence(row.evidence);
    const named = findingIdsOf(row.finding);
    if (row.status === 'pass') {
      if (evidence.length === 0) problems.push(`${row.id}: pass with no evidence`);
      for (const item of evidence) {
        const problem = evidenceProblem(item);
        if (problem) problems.push(`${row.id}: ${problem}`);
      }
    }
    if (row.status === 'n/a' && evidence.length === 0) problems.push(`${row.id}: n/a without a reason`);
    if (row.status === 'fail' && named.length === 0) problems.push(`${row.id}: fail names no finding`);
    for (const id of named) if (!findingIds.has(id)) problems.push(`${row.id}: finding ${id} does not exist`);
  }

  const counted = new Set<string>();
  for (const finding of review.findings) {
    const id = finding.id;
    if (!FINDING_ID.test(id)) problems.push(`${id}: not a finding ID (ASVS-<letter><number>)`);
    if (counted.has(id)) problems.push(`${id}: finding listed more than once`);
    counted.add(id);
    if (!SEVERITIES.has(finding.severity))
      problems.push(`${id}: severity "${finding.severity}" is not critical, high, medium or low`);
    if (!FINDING_STATUSES.has(finding.status)) problems.push(`${id}: status "${finding.status}" is not open, fixed or accepted`);
    if (finding.status === 'fixed') {
      if (finding.fix === '') problems.push(`${id}: fixed without a Fix: line`);
      if (finding.regressionTest === '') problems.push(`${id}: fixed without a regression test`);
      else {
        const problem = evidenceProblem(unquote(finding.regressionTest));
        if (problem) problems.push(`${id}: regression ${problem}`);
      }
    }
    if (finding.status === 'accepted') {
      if (finding.acceptedBy === '') problems.push(`${id}: accepted without an Accepted by: line`);
      if (SEVERE.has(finding.severity)) problems.push(`${id}: a ${finding.severity} finding cannot be accepted`);
    }
  }
  return problems;
}

/** The release gate (CL5-12): every high or critical finding that is not fixed, whatever its other status. */
export function openSevereFindings(review: Review): ReviewFinding[] {
  return review.findings.filter((finding) => SEVERE.has(finding.severity) && finding.status !== 'fixed');
}
