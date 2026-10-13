import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluate } from '../../../scripts/check-server-licenses.mjs';

/** The rule `pkg@1.0.0` fails under `license`, or 'ok', from a `pnpm licenses list --json` report of that package alone. */
function ruleOf(license: string, reviewed: Record<string, string> = {}) {
  const { ok, violations } = evaluate({ [license]: [{ name: 'pkg', versions: ['1.0.0'], license }] }, reviewed);
  expect(ok).toBe(violations.length === 0);
  expect(violations.length).toBeLessThanOrEqual(1);
  return violations[0]?.rule ?? 'ok';
}

describe('rules', () => {
  it('test_permissive_licences_pass', () => {
    const result = evaluate(
      {
        MIT: [
          { name: 'hono', versions: ['4.13.13'], license: 'MIT' },
          { name: '@better-auth/utils', versions: ['0.4.2', '0.5.0'], license: 'MIT' },
        ],
        'Apache-2.0': [{ name: 'drizzle-orm', versions: ['0.45.4'], license: 'Apache-2.0' }],
        'MIT-0': [{ name: 'nodemailer', versions: ['10.1.0'], license: 'MIT-0' }],
        Unlicense: [{ name: 'fast-sha256', versions: ['1.3.0'], license: 'Unlicense' }],
      },
      {},
    );
    expect(result).toEqual({ ok: true, violations: [] });
    expect(evaluate({}, {})).toEqual({ ok: true, violations: [] });
  });

  it('test_copyleft_fails_and_cannot_be_reviewed', () => {
    for (const license of ['GPL-3.0-only', 'LGPL-2.1-or-later', 'AGPL-3.0-only', 'GPLv3', 'GPL', 'LGPLv2', 'GPL-2.0+']) {
      const reviewed = { 'pkg@1.0.0': `${license} approved by a lawyer, 2026-11-02` };
      expect([license, ruleOf(license)]).toEqual([license, 'copyleft']);
      expect([license, ruleOf(license, reviewed)]).toEqual([license, 'copyleft']);
    }

    // Each version is its own finding, named as the review file would name it.
    const result = evaluate({ 'GPL-3.0-only': [{ name: 'gpl-pkg', versions: ['1.0.0', '2.0.0'], license: 'GPL-3.0-only' }] }, {});
    expect(result).toEqual({
      ok: false,
      violations: [
        { name: 'gpl-pkg', version: '1.0.0', license: 'GPL-3.0-only', rule: 'copyleft' },
        { name: 'gpl-pkg', version: '2.0.0', license: 'GPL-3.0-only', rule: 'copyleft' },
      ],
    });

    // Ids that only resemble the GPL family are not copyleft: they are outside the allow list.
    expect(ruleOf('GPLOK-1.0')).toBe('unknown');
  });

  it('test_mpl_needs_review', () => {
    expect(ruleOf('MPL-2.0')).toBe('needs-legal-review');
    expect(ruleOf('MPL-2.0', { 'pkg@1.0.0': 'MPL-2.0 approved by a lawyer, 2026-11-02' })).toBe('ok');
    // A review names one version of one package.
    expect(ruleOf('MPL-2.0', { 'pkg@1.0.1': 'MPL-2.0 approved by a lawyer, 2026-11-02' })).toBe('needs-legal-review');
    expect(ruleOf('MPL-2.0', { 'other@1.0.0': 'MPL-2.0 approved by a lawyer, 2026-11-02' })).toBe('needs-legal-review');
    for (const license of ['EPL-2.0', 'CDDL-1.1', 'EUPL-1.2'])
      expect([license, ruleOf(license)]).toEqual([license, 'needs-legal-review']);

    // The committed review file holds one reason per package version, and nothing else.
    const committed: unknown = JSON.parse(readFileSync(new URL('../../../scripts/license-review.json', import.meta.url), 'utf8'));
    expect(committed).toBeTypeOf('object');
    for (const [key, reason] of Object.entries(committed as object)) {
      expect(key).toMatch(/^(@[^/@]+\/)?[^/@]+@\S+$/);
      expect(reason).toBeTypeOf('string');
    }
  });

  it('test_spdx_or_and_expressions', () => {
    expect(ruleOf('(MIT OR GPL-3.0)')).toBe('ok');
    expect(ruleOf('(MIT OR GPL-3.0) AND Apache-2.0')).toBe('ok');
    expect(ruleOf('MIT OR Apache-2.0')).toBe('ok');
    expect(ruleOf('(MIT AND GPL-2.0)')).toBe('copyleft');
    // AND binds tighter than OR, and parentheses group: the AND needs its GPL child to pass.
    expect(ruleOf('GPL-3.0-only AND (MIT OR Apache-2.0)')).toBe('copyleft');
    expect(ruleOf('GPL-3.0-only OR MIT AND Apache-2.0')).toBe('ok');
    expect(ruleOf('(GPL-3.0-only OR MIT) AND MPL-2.0')).toBe('needs-legal-review');
    // A leaf is judged by its id before WITH.
    expect(ruleOf('Apache-2.0 WITH LLVM-exception')).toBe('ok');
    expect(ruleOf('GPL-2.0-only WITH Classpath-exception-2.0')).toBe('copyleft');

    // A failing AND takes its most severe failing child, and a review cannot clear one with a copyleft child.
    const reviewed = { 'pkg@1.0.0': 'MPL-2.0 approved by a lawyer, 2026-11-02' };
    expect(ruleOf('MPL-2.0 AND GPL-3.0-only')).toBe('copyleft');
    expect(ruleOf('MPL-2.0 AND GPL-3.0-only', reviewed)).toBe('copyleft');
    expect(ruleOf('MPL-2.0 AND LicenseRef-Custom')).toBe('needs-legal-review');
    // A failing OR is cleared by its easiest child, so it is reported as that child: a review clears it.
    expect(ruleOf('GPL-3.0-only OR MPL-2.0')).toBe('needs-legal-review');
    expect(ruleOf('GPL-3.0-only OR MPL-2.0', reviewed)).toBe('ok');
  });

  it('test_unknown_licences_fail', () => {
    for (const license of ['UNKNOWN', 'SEE LICENSE IN LICENSE.md', '', 'LicenseRef-Proprietary', 'WTFPL']) {
      expect([license, ruleOf(license)]).toEqual([license, 'unknown']);
      expect([license, ruleOf(license, { 'pkg@1.0.0': 'reviewed, 2026-11-02' })]).toEqual([license, 'ok']);
    }
    // Expressions that do not parse.
    for (const license of ['(MIT', 'MIT)', 'MIT OR', 'AND MIT', 'MIT Apache-2.0', 'MIT WITH', '()'])
      expect([license, ruleOf(license)]).toEqual([license, 'unknown']);
  });
});
