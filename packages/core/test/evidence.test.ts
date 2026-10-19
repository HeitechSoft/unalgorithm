import { describe, expect, it } from 'vitest';
import { atLeast, type Evidence, type Strength, signalStrength } from '../src/index.ts';

const ev = (detector: string, strength: Strength, signal: Evidence['signal'] = 'sponsored'): Evidence => ({
  signal,
  detector,
  strength,
});

/**
 * Facebook's ad rule as `isSponsored` in packages/platforms/src/facebook/extract.ts has it today (copied, since core
 * can't import an adapter): `signalStrength` must agree with it exactly, so the adapter can switch with no change.
 */
function facebookIsSponsored(e: Evidence[]): boolean {
  const s = e.filter((x) => x.signal === 'sponsored');
  const strong = s.filter((x) => x.strength === 'strong').length;
  const medium = s.filter((x) => x.strength === 'medium').length;
  const weak = s.filter((x) => x.strength === 'weak').length;
  return strong >= 1 || medium >= 2 || (medium >= 1 && weak >= 1);
}

describe('signalStrength', () => {
  it('test_combines_evidence', () => {
    expect(signalStrength([], 'sponsored')).toBeNull();
    expect(signalStrength([ev('fb.sponsored.slot-label', 'strong')], 'sponsored')).toBe('strong');
    expect(signalStrength([ev('a', 'medium'), ev('b', 'medium')], 'sponsored')).toBe('medium');
    expect(signalStrength([ev('a', 'medium'), ev('b', 'weak')], 'sponsored')).toBe('medium');
    expect(signalStrength([ev('a', 'medium')], 'sponsored')).toBe('weak');
    expect(signalStrength([ev('a', 'weak'), ev('b', 'weak'), ev('c', 'weak')], 'sponsored')).toBe('weak');
    expect(signalStrength([ev('a', 'weak'), ev('b', 'strong')], 'sponsored')).toBe('strong');
    // Only the asked signal counts.
    const mixed = [ev('li.follow-button', 'strong', 'relationship'), ev('li.age-slot.no-age', 'weak')];
    expect(signalStrength(mixed, 'sponsored')).toBe('weak');
    expect(signalStrength(mixed, 'relationship')).toBe('strong');
    expect(signalStrength(mixed, 'suggested')).toBeNull();
  });

  it('test_at_least', () => {
    const order: (Strength | null)[] = [null, 'weak', 'medium', 'strong'];
    for (const [i, s] of order.entries()) {
      for (const [j, min] of (['weak', 'medium', 'strong'] as const).entries()) {
        expect(atLeast(s, min), `${s} >= ${min}`).toBe(i >= j + 1);
      }
    }
  });

  it('test_facebook_ad_cases', () => {
    const cases: Array<[string, Evidence[], boolean]> = [
      ['"Ad" where the time goes', [ev('fb.sponsored.slot-label', 'strong'), ev('fb.sponsored.no-timestamp', 'weak')], true],
      ['aria-label "Sponsored"', [ev('fb.sponsored.aria-label', 'strong')], true],
      ['labelled by a hidden "Sponsored"', [ev('fb.sponsored.labelledby', 'strong')], true],
      ['a link to ad preferences', [ev('fb.sponsored.adlink', 'strong')], true],
      ['"Paid partnership"', [ev('fb.sponsored.paid-partnership', 'strong')], true],
      [
        'the label rebuilt from visible letters, no timestamp',
        [ev('fb.sponsored.rendered-label', 'medium'), ev('fb.sponsored.no-timestamp', 'weak')],
        true,
      ],
      [
        'the rebuilt label and a shop button',
        [ev('fb.sponsored.rendered-label', 'medium'), ev('fb.sponsored.cta', 'weak')],
        true,
      ],
      ['the rebuilt label alone', [ev('fb.sponsored.rendered-label', 'medium')], false],
      [
        'a shop button and no timestamp (an organic share)',
        [ev('fb.sponsored.cta', 'weak'), ev('fb.sponsored.no-timestamp', 'weak')],
        false,
      ],
      ['no timestamp only', [ev('fb.sponsored.no-timestamp', 'weak')], false],
      [
        'a near-miss label and no timestamp ("Ad · Paid")',
        [ev('fb.sponsored.near', 'medium'), ev('fb.sponsored.no-timestamp', 'weak')],
        true,
      ],
      ['a near-miss label alone', [ev('fb.sponsored.near', 'medium')], false],
      ['only other signals', [ev('fb.follow-button', 'strong', 'relationship'), ev('fb.reshare', 'medium', 'reshare')], false],
      ['nothing', [], false],
    ];
    for (const [name, evidence, sponsored] of cases) {
      expect(atLeast(signalStrength(evidence, 'sponsored'), 'medium'), name).toBe(sponsored);
      expect(facebookIsSponsored(evidence), name).toBe(sponsored);
    }
  });

  it('test_matches_facebook_rule_exhaustively', () => {
    // Every mix of up to three strong, medium and weak detectors, with noise from another signal.
    for (let strong = 0; strong <= 3; strong++) {
      for (let medium = 0; medium <= 3; medium++) {
        for (let weak = 0; weak <= 3; weak++) {
          const evidence = [
            ...Array.from({ length: strong }, (_, i) => ev(`s${i}`, 'strong')),
            ...Array.from({ length: medium }, (_, i) => ev(`m${i}`, 'medium')),
            ...Array.from({ length: weak }, (_, i) => ev(`w${i}`, 'weak')),
            ev('fb.header.suggested', 'strong', 'suggested'),
          ];
          expect(atLeast(signalStrength(evidence, 'sponsored'), 'medium'), `${strong}/${medium}/${weak}`).toBe(
            facebookIsSponsored(evidence),
          );
        }
      }
    }
  });
});
