import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openSevereFindings, parseReview, readIdFile, reviewProblems } from './support/asvs-review.ts';

/**
 * The OWASP ASVS 5.0.0 level 2 self-review (CL5-11): the requirement list is the pinned standard's, and the checks of
 * `support/asvs-review.ts` catch an incomplete or unsupported review. The real review (`docs/security/asvs-l2.md`) is run
 * through the same checks once it merges; until then only the fixtures are.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ID_FILE = 'docs/security/asvs-5.0.0-l1-l2-ids.txt';
const REVIEW_FILE = 'docs/security/asvs-l2.md';
const TEST_ROOTS = ['apps', 'packages'];
const CSV_SHA256 = '6124dba176dc563f66363a11ae0c47f9b86b8a4a84c66a793670bd196ed86cd5';

/** Paths and a test name that exist in this repo, for the fixtures' evidence. */
const PATH = 'apps/server/src/auth';
const TEST = 'test_revoked_device_is_401';
const IDS = ['V1.1.1', 'V1.1.2', 'V2.1.1', 'V2.2.1'];

function review(rows: string[], findings = ''): string {
  return [
    '# Review',
    '',
    '| ID | Status | Evidence | Finding |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    '## Findings',
    '',
    findings,
  ].join('\n');
}

const GOOD_ROWS = [
  `| V1.1.1 | pass | \`${PATH}\`; \`${TEST}\` | |`,
  '| V1.1.2 | n/a | no file upload | |',
  '| V2.1.1 | fail | | ASVS-F1 |',
  `| V2.2.1 | pass | ${PATH} | ASVS-F2 |`,
];
const GOOD_FINDINGS = [
  '### ASVS-F1 — Something small',
  '',
  'Severity: low',
  'Status: open',
  '',
  '### ASVS-F2 — Something fixed',
  '',
  'Severity: medium',
  'Status: fixed',
  'Fix: GHSA-xxxx-xxxx-xxxx, server-v1.2.3',
  `Regression test: ${TEST}`,
].join('\n');

const problemsOf = (md: string): string[] => reviewProblems(IDS, parseReview(md), REPO_ROOT, TEST_ROOTS);

describe('requirement list', () => {
  it('test_asvs_id_file_is_253_level_1_2_ids', () => {
    const text = readFileSync(`${REPO_ROOT}${ID_FILE}`, 'utf8');
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(254);
    expect(lines[0]).toMatch(/^# /);
    expect(lines[0]).toContain('v5.0.0_release');
    expect(lines[0]).toContain('OWASP_Application_Security_Verification_Standard_5.0.0_en.csv');
    expect(lines[0]).toContain(CSV_SHA256);
    const ids = readIdFile(text);
    expect(ids).toHaveLength(253);
    for (const id of ids) expect(id).toMatch(/^V\d+\.\d+\.\d+$/);
    expect(new Set(ids).size).toBe(253);
    expect(ids[0]).toBe('V1.1.1');
  });
});

describe('review completeness', () => {
  it('test_asvs_review_fixture_without_problems', () => {
    expect(problemsOf(review(GOOD_ROWS, GOOD_FINDINGS))).toEqual([]);
  });

  it('test_asvs_review_problems_reported', () => {
    const cases: Array<[string, string, RegExp]> = [
      ['missing ID', review(GOOD_ROWS.slice(0, 3), GOOD_FINDINGS), /V2\.2\.1.*missing/],
      ['duplicated ID', review([...GOOD_ROWS, GOOD_ROWS[3] ?? ''], GOOD_FINDINGS), /V2\.2\.1.*more than once/],
      ['unknown ID', review([...GOOD_ROWS, '| V99.1.1 | n/a | no such thing | |'], GOOD_FINDINGS), /V99\.1\.1.*not an ID/],
      ['pass without evidence', review(['| V1.1.1 | pass | | |', ...GOOD_ROWS.slice(1)], GOOD_FINDINGS), /V1\.1\.1.*no evidence/],
      [
        'missing evidence path',
        review(['| V1.1.1 | pass | apps/server/src/no-such-file.ts | |', ...GOOD_ROWS.slice(1)], GOOD_FINDINGS),
        /V1\.1\.1.*no-such-file\.ts.*does not exist/,
      ],
      [
        'unknown test name',
        review(['| V1.1.1 | pass | test_no_such_test_anywhere | |', ...GOOD_ROWS.slice(1)], GOOD_FINDINGS),
        /V1\.1\.1.*test_no_such_test_anywhere.*no test file/,
      ],
      [
        'n/a without a reason',
        review([GOOD_ROWS[0] ?? '', '| V1.1.2 | n/a | | |', ...GOOD_ROWS.slice(2)], GOOD_FINDINGS),
        /V1\.1\.2.*reason/,
      ],
      [
        'fail without an existing finding',
        review([...GOOD_ROWS.slice(0, 2), '| V2.1.1 | fail | | ASVS-F9 |', GOOD_ROWS[3] ?? ''], GOOD_FINDINGS),
        /V2\.1\.1.*ASVS-F9/,
      ],
      [
        'fixed finding without a regression test',
        review(GOOD_ROWS, GOOD_FINDINGS.replace(`Regression test: ${TEST}`, '')),
        /ASVS-F2.*regression test/,
      ],
      [
        'accepted finding without Accepted by',
        review(GOOD_ROWS, GOOD_FINDINGS.replace('Status: open', 'Status: accepted')),
        /ASVS-F1.*Accepted by/,
      ],
      [
        'accepted high finding',
        review(
          GOOD_ROWS,
          GOOD_FINDINGS.replace(
            'Severity: low\nStatus: open',
            'Severity: high\nStatus: accepted\nAccepted by: Tom Heiber, 2026-10-15',
          ),
        ),
        /ASVS-F1.*high.*cannot be accepted/,
      ],
      [
        'critical accepted finding',
        review(
          GOOD_ROWS,
          GOOD_FINDINGS.replace(
            'Severity: low\nStatus: open',
            'Severity: critical\nStatus: accepted\nAccepted by: Tom Heiber, 2026-10-15',
          ),
        ),
        /ASVS-F1.*critical.*cannot be accepted/,
      ],
    ];
    for (const [name, md, expected] of cases) {
      const problems = problemsOf(md);
      expect(
        problems.some((p) => expected.test(p)),
        `${name}: ${JSON.stringify(problems)}`,
      ).toBe(true);
    }
  });

  it('test_asvs_review_reports_order_status_and_finding_shape', () => {
    const swapped = [GOOD_ROWS[1] ?? '', GOOD_ROWS[0] ?? '', ...GOOD_ROWS.slice(2)];
    expect(problemsOf(review(swapped, GOOD_FINDINGS)).join('\n')).toMatch(/order/);
    const badStatus = ['| V1.1.1 | maybe | x | |', ...GOOD_ROWS.slice(1)];
    expect(problemsOf(review(badStatus, GOOD_FINDINGS)).join('\n')).toMatch(/V1\.1\.1.*status/);
    const badId = GOOD_FINDINGS.replace('### ASVS-F1', '### ASVS-1').concat('\n\n### ASVS-F1 — x\n\nSeverity: low\nStatus: open');
    expect(problemsOf(review(GOOD_ROWS, badId)).join('\n')).toMatch(/ASVS-1.*ID/);
    const noSeverity = GOOD_FINDINGS.replace('Severity: low\n', '');
    expect(problemsOf(review(GOOD_ROWS, noSeverity)).join('\n')).toMatch(/ASVS-F1.*severity/);
  });

  it('test_asvs_review_accepts_private_finding_ids', () => {
    const md = review(
      [...GOOD_ROWS.slice(0, 2), '| V2.1.1 | fail | | ASVS-C1 |', GOOD_ROWS[3] ?? ''],
      `${GOOD_FINDINGS}\n\n### ASVS-C1 — A private finding\n\nSeverity: high\nStatus: open\n`,
    );
    const parsed = parseReview(md);
    expect(reviewProblems(IDS, parsed, REPO_ROOT, TEST_ROOTS)).toEqual([]);
    expect(openSevereFindings(parsed).map((f) => f.id)).toEqual(['ASVS-C1']);
  });
});

describe('gate', () => {
  const gated = process.env.ASVS_GATE === '1';
  const withFinding = (severity: string): string =>
    review(
      [...GOOD_ROWS.slice(0, 2), '| V2.1.1 | fail | | ASVS-F3 |', GOOD_ROWS[3] ?? ''],
      `${GOOD_FINDINGS}\n\n### ASVS-F3 — Open\n\nSeverity: ${severity}\nStatus: open\n`,
    );

  describe('test_no_open_severe_findings_when_gated', () => {
    it('an open high or critical finding fails the gate, an open medium or low one does not', () => {
      expect(openSevereFindings(parseReview(withFinding('high'))).map((f) => f.id)).toEqual(['ASVS-F3']);
      expect(openSevereFindings(parseReview(withFinding('critical'))).map((f) => f.id)).toEqual(['ASVS-F3']);
      expect(openSevereFindings(parseReview(withFinding('medium')))).toEqual([]);
      expect(openSevereFindings(parseReview(withFinding('low')))).toEqual([]);
      expect(openSevereFindings(parseReview(review(GOOD_ROWS, GOOD_FINDINGS)))).toEqual([]);
    });

    it.skipIf(!gated)('the review has no open high or critical finding (ASVS_GATE=1)', () => {
      let md: string;
      try {
        md = readFileSync(`${REPO_ROOT}${REVIEW_FILE}`, 'utf8');
      } catch {
        throw new Error(`${REVIEW_FILE} is missing: a gated release needs the review`);
      }
      expect(openSevereFindings(parseReview(md))).toEqual([]);
    });
  });
});
