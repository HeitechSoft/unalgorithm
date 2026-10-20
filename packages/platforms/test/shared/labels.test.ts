import { describe, expect, it } from 'vitest';
import {
  accessibleName,
  type LabelPattern,
  labelStrength,
  MAX_LABEL_CHARS,
  matchAnyLabel,
  matchLabel,
  normaliseLabel,
  normalizeText,
} from '../../src/index.ts';

/** The patterns ADR 0009 §9 describes, as the adapters will define them. */
const PROMOTED: LabelPattern = {
  id: 'promoted',
  heads: ['promoted', 'sponsored'],
  tails: ['by', 'partnership with'],
  notTails: ['to', 'as', 'at', 'in', 'from', 'on'],
  nearWords: 4,
};
const SPONSORED: LabelPattern = { id: 'sponsored', heads: ['sponsored', 'ad'], tails: ['paid partnership'], nearWords: 2 };
const FOLLOW: LabelPattern = { id: 'follow', heads: ['follow'], prefix: '+ ', nearWords: 0 };
const SUGGESTED: LabelPattern = {
  id: 'suggested',
  heads: ['suggested', 'suggested for you', 'recommended for you'],
  nearWords: 3,
};
const JOIN: LabelPattern = { id: 'join', heads: ['join'], prefix: 'request to', nearWords: 0 };

const match = (text: string, pattern: LabelPattern) => matchLabel(text, pattern)?.match ?? null;

describe('normaliseLabel', () => {
  it('test_normalises_labels', () => {
    expect(normaliseLabel('  • Promoted • ')).toBe('Promoted');
    expect(normaliseLabel('· Ad ·')).toBe('Ad');
    expect(normaliseLabel('\u200BPro\u034Fmo\u200Dted\uFEFF')).toBe('Promoted');
    expect(normaliseLabel('Promoted •\u00A0Partnership\n with  LinkedIn')).toBe('Promoted • Partnership with LinkedIn');
    expect(normaliseLabel('Ｐｒｏｍｏｔｅｄ')).toBe('Promoted');
    expect(normaliseLabel('\u2014 | : ·')).toBe('');
    // Case is kept: the hash of a near miss is taken from what the page shows.
    expect(normaliseLabel('PROMOTED')).toBe('PROMOTED');
  });
});

describe('matchLabel', () => {
  it('test_linkedin_promoted', () => {
    expect(match('Promoted', PROMOTED)).toBe('exact');
    expect(match('Sponsored', PROMOTED)).toBe('exact');
    expect(match('Promoted •', PROMOTED)).toBe('exact');
    expect(match('PROMOTED', PROMOTED)).toBe('exact');
    expect(match('Promoted by Acme', PROMOTED)).toBe('known');
    expect(matchLabel('Promoted • Partnership with LinkedIn', PROMOTED)).toEqual({
      id: 'promoted',
      match: 'known',
      head: 'promoted',
      tail: 'partnership with',
      extra: 1,
      label: 'Promoted • Partnership with LinkedIn',
      separated: true,
    });
    expect(matchLabel('Promoted by Acme', PROMOTED)).toMatchObject({ match: 'known', separated: false });
    expect(matchLabel('Promoted', PROMOTED)).toMatchObject({ match: 'exact', separated: false });
    expect(match('Promoted \u2013 Partnership with LinkedIn', PROMOTED)).toBe('known');
    expect(matchLabel('Promoted • Brand content', PROMOTED)).toMatchObject({ match: 'near', extra: 2 });
    expect(matchLabel('Promoted | Acme', PROMOTED)).toMatchObject({ match: 'near', extra: 1 });
    for (const sep of ['·', '•', '|', ':', '-', '\u2013', '\u2014'])
      expect(match(`Promoted ${sep} Acme`, PROMOTED), sep).toBe('near');
    expect(match('Promoted • one two three four', PROMOTED)).toBe('near');
    expect(match('Promoted • one two three four five', PROMOTED)).toBeNull();
    // Not ad labels: a job change, a longer word, a sentence that only starts the same.
    expect(match('Promoted to Director', PROMOTED)).toBeNull();
    expect(match('Promoted • to Director of Sales', PROMOTED)).toBeNull();
    expect(match('Promoted as team lead', PROMOTED)).toBeNull();
    expect(match('Promotedness', PROMOTED)).toBeNull();
    expect(match('Jane Doe • Promoted', PROMOTED)).toBeNull();
    expect(match('', PROMOTED)).toBeNull();
    expect(match(`Promoted by ${'a'.repeat(MAX_LABEL_CHARS)}`, PROMOTED)).toBeNull();
  });

  it('test_near_miss_after_a_separator_only', () => {
    const strict: LabelPattern = { ...PROMOTED, nearAfterSeparator: true };
    for (const label of [
      'Promoted • Brand content',
      'Promoted | Acme',
      'Promoted · Paid',
      'Promoted — Brand content',
      '• Promoted: Acme',
    ]) {
      expect(match(label, strict), label).toBe('near');
    }
    // A line that only starts with the head word, such as an author's headline, is no near miss (without the option,
    // each one is).
    for (const label of ['Sponsored Products Manager at Amazon', 'Promoted Brand content', 'Promoted, Acme']) {
      expect(match(label, strict), label).toBeNull();
      expect(match(label, PROMOTED), label).toBe('near');
    }
    // Exact and known labels don't need one.
    expect(match('Promoted', strict)).toBe('exact');
    expect(match('Promoted by Acme', strict)).toBe('known');
    expect(match('Promoted • Partnership with LinkedIn', strict)).toBe('known');
    // With a prefix, the separator comes after the head, not after the prefix.
    const join: LabelPattern = { id: 'join', heads: ['join'], prefix: 'request to', nearWords: 2, nearAfterSeparator: true };
    expect(match('Request to join · Group', join)).toBe('near');
    expect(match('Request to join the group', join)).toBeNull();
  });

  it('test_facebook_sponsored', () => {
    expect(match('Sponsored', SPONSORED)).toBe('exact');
    expect(match('Ad', SPONSORED)).toBe('exact');
    expect(matchLabel('Ad · Paid', SPONSORED)).toMatchObject({ match: 'near', extra: 1 });
    expect(match('Ad · Paid partnership', SPONSORED)).toBe('known');
    expect(match('Sponsored · Paid partnership with Acme', SPONSORED)).toBe('known');
    expect(match('Ad · Paid · Extra', SPONSORED)).toBe('near');
    expect(match('Ad · Paid · Extra · More', SPONSORED)).toBeNull();
    expect(match('Add friend', SPONSORED)).toBeNull();
    expect(match('Ads', SPONSORED)).toBeNull();
  });

  it('test_follow_join_and_suggested', () => {
    expect(match('Follow', FOLLOW)).toBe('exact');
    expect(match('+ Follow', FOLLOW)).toBe('exact');
    expect(match('+Follow', FOLLOW)).toBe('exact');
    expect(match('Following', FOLLOW)).toBeNull();
    expect(match('Followed by Jane Doe', FOLLOW)).toBeNull();
    expect(match('Follow Jane Doe', FOLLOW)).toBeNull();
    expect(match('Join', JOIN)).toBe('exact');
    expect(match('Request to join', JOIN)).toBe('exact');
    expect(match('Joined', JOIN)).toBeNull();
    // The longest head wins: "Suggested for you" is exact, not "Suggested" plus two words.
    expect(matchLabel('Suggested for you', SUGGESTED)).toMatchObject({ match: 'exact', head: 'suggested for you' });
    expect(matchLabel('Suggested posts for you', SUGGESTED)).toMatchObject({ match: 'near', head: 'suggested', extra: 3 });
  });

  it('test_hidden_and_look_alike_characters', () => {
    expect(match('Pro\u200Bmo\u200Cted', PROMOTED)).toBe('exact');
    expect(match('Promo\u034Fted', PROMOTED)).toBe('exact');
    expect(match('Spon\u00ADsored', SPONSORED)).toBe('exact');
    expect(match('\u2066Sponsored\u2069', SPONSORED)).toBe('exact');
    expect(match('Ｐｒｏｍｏｔｅｄ • Brand content', PROMOTED)).toBe('near');
    // Disguised copies of one label hash alike: the normalised label is the same.
    const plain = matchLabel('Promoted • Brand content', PROMOTED)?.label;
    expect(matchLabel('Promoted •\u200B Brand\u034F content •', PROMOTED)?.label).toBe(plain);
  });

  it('test_strength_and_first_match', () => {
    const near = matchLabel('Ad · Paid', SPONSORED);
    const known = matchLabel('Ad · Paid partnership', SPONSORED);
    const exact = matchLabel('Ad', SPONSORED);
    expect([near, known, exact].map((hit) => hit && labelStrength(hit))).toEqual(['medium', 'strong', 'strong']);
    // A known label wins over another pattern's near miss; otherwise the first pattern given wins.
    expect(matchAnyLabel('Sponsored by Acme', [SPONSORED, PROMOTED])).toMatchObject({ id: 'promoted', match: 'known' });
    expect(matchAnyLabel('Sponsored', [SPONSORED, PROMOTED])).toMatchObject({ id: 'sponsored', match: 'exact' });
    expect(matchAnyLabel('Sponsored · Acme', [SPONSORED, PROMOTED])).toMatchObject({ id: 'sponsored', match: 'near' });
    expect(matchAnyLabel('Like', [SPONSORED, PROMOTED, FOLLOW])).toBeNull();
  });
});

describe('accessibleName', () => {
  const html = (markup: string): HTMLElement => {
    document.body.innerHTML = markup;
    return document.getElementById('el') as HTMLElement;
  };

  it('test_labelledby_reads_hidden_targets', () => {
    expect(
      accessibleName(
        html(
          '<span id="a" hidden>Spon</span><span id="b" style="display:none">sored</span><a id="el" aria-labelledby="a b">x</a>',
        ),
      ),
    ).toBe('Spon sored');
    expect(accessibleName(html('<span id="a" aria-label="Sponsored">S</span><a id="el" aria-labelledby="a">x</a>'))).toBe(
      'Sponsored',
    );
    // A missing or self target falls through to the next source.
    expect(accessibleName(html('<a id="el" aria-labelledby="nowhere el" aria-label="Ad">x</a>'))).toBe('Ad');
  });

  it('test_name_sources_in_order', () => {
    expect(accessibleName(html('<button id="el" aria-label="Hide post by Jane">Hide</button>'))).toBe('Hide post by Jane');
    expect(accessibleName(html('<img id="el" alt="Ad choices" title="x">'))).toBe('Ad choices');
    expect(
      accessibleName(html('<button id="el" title="More"><span>+</span> <span>Follow</span><span hidden>secret</span></button>')),
    ).toBe('+ Follow');
    expect(accessibleName(html('<button id="el" title="Close"><svg><title>Dismiss</title></svg></button>'))).toBe('Dismiss');
    expect(accessibleName(html('<button id="el" title="More options"></button>'))).toBe('More options');
    expect(accessibleName(html('<div id="el"></div>'))).toBe('');
    expect(accessibleName(html('<button id="el" aria-label="Fol\u034Flow\u200B"></button>'))).toBe('Follow');
  });

  it('test_normalize_text_strips_grapheme_joiner', () => {
    expect(normalizeText('Spon\u034Fsored')).toBe('Sponsored');
    expect(normalizeText(' a\u200B  b ')).toBe('a b');
  });
});
