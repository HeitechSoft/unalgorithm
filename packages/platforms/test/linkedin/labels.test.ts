import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyPreset, defaultSettings, type PlatformSettings, ruleFilter } from '@unalgorithm/core';
import { describe, expect, it } from 'vitest';
import { feedHtml, PROMOTED_POST, SUGGESTED_POST } from '../../fixtures/linkedin/legacy.ts';
import {
  COMPANY_NOT_FOLLOWED,
  FIRST_DEGREE_POST,
  FOLLOWED_BY_POST,
  feed2026,
  PARTNERSHIP_AD,
} from '../../fixtures/linkedin/y2026.ts';
import { linkedinAdapter } from '../../src/linkedin/adapter.ts';
import { findPostRoots, readPost } from '../../src/linkedin/extract.ts';
import { LINKEDIN_EN } from '../../src/linkedin/markers/en.ts';

/**
 * Ad labels only in label positions (ADR 0009 §9): the age slot, header lines, the author's block and the head's
 * buttons. Never the post's text, so a post that mentions a sponsor is not an ad, and a new label wording is a near
 * miss that is still folded with the weak "no post age" evidence, and reported.
 */
const m = LINKEDIN_EN;
const balanced: PlatformSettings = defaultSettings().platforms.linkedin;
const light = applyPreset('linkedin', balanced, 'light');
const NOW = new Date(2026, 9, 19, 12);

function read(card: string, wrap = feed2026) {
  document.body.innerHTML = wrap(card);
  const roots = findPostRoots(document.body);
  expect(roots).toHaveLength(1);
  return readPost(roots[0] as HTMLElement, m, NOW);
}

/** PARTNERSHIP_AD (an ad run as a person's post, with no age) with another label in its age slot. */
const adLabelled = (label: string) =>
  PARTNERSHIP_AD.replace(/<span>Promoted • Partnership with[\s\S]*?<\/strong><\/a><\/span>/, label);

/** FIRST_DEGREE_POST (a connection's post, "Yesterday") with a header line above the author. */
const withHeader = (line: string) =>
  FIRST_DEGREE_POST.replace('<div class="e0sactor">', `<div class="e0shdr"><p>${line}</p></div><div class="e0sactor">`);

const detectors = (r: ReturnType<typeof read>) => r.post.evidence.map((e) => `${e.detector}:${e.strength}`);

/** Which locator found a part of the post (`li.slot.<part>.<locator>`): recorded on every post, so left out here. */
const LOCATOR = /^li\.slot\.[a-z-]+\.(class|testid|aria|structure)$/;
const noticed = (observations: readonly string[] = []) => observations.filter((o) => !LOCATOR.test(o));

describe('ad labels in the age slot', () => {
  it('"Promoted • Partnership with LinkedIn" is a strong label', () => {
    const r = read(PARTNERSHIP_AD);
    expect(r.post.evidence).toContainEqual({ signal: 'sponsored', detector: 'li.promoted.age-slot', strength: 'strong' });
    expect(r.post.signals.sponsored).toBe(true);
    expect(ruleFilter(r.post, light)?.reason).toBe('sponsored');
    expect(noticed(r.observations)).toEqual([]);
    expect(r.post.quality.adNearMiss).toBeUndefined();
  });

  it('"Promoted • Brand content" with no age is a near miss plus no age: still folded, and noticed', () => {
    const r = read(adLabelled('Promoted • Brand content'));
    expect(detectors(r)).toEqual(expect.arrayContaining(['li.promoted.near:medium', 'li.age-slot.no-age:weak']));
    expect(r.post.evidence.some((e) => e.strength === 'strong' && e.signal === 'sponsored')).toBe(false);
    expect(r.post.signals.sponsored).toBe(true);
    expect(ruleFilter(r.post, balanced)?.reason).toBe('sponsored');
    expect(ruleFilter(r.post, light)?.reason).toBe('sponsored');
    expect(r.observations).toContain('li.label.promoted.near');
    expect(r.post.quality.adNearMiss).toMatch(/^[0-9a-z]+$/);
    // The label isn't an age and isn't unknown: no "unrecognised" observation, and not an unlabelled ad cue.
    expect(r.observations).not.toContain('li.slot.age.unrecognised');
    expect(r.post.quality.adCue).toBeUndefined();
  });

  it('"Promoted | Acme" is a near miss; the same label gives the same in-memory hash, another label another', () => {
    const acme = read(adLabelled('Promoted | Acme'));
    expect(detectors(acme)).toContain('li.promoted.near:medium');
    expect(acme.post.signals.sponsored).toBe(true);
    const again = read(adLabelled('Promoted | Acme'));
    expect(again.post.quality.adNearMiss).toBe(acme.post.quality.adNearMiss);
    expect(read(adLabelled('Promoted | Northwind')).post.quality.adNearMiss).not.toBe(acme.post.quality.adNearMiss);
  });

  it('a near miss alone, on a post with an age, never hides', () => {
    const r = read(withHeader('Promoted | Acme'));
    expect(detectors(r)).toContain('li.promoted.near:medium');
    expect(detectors(r)).not.toContain('li.age-slot.no-age:weak');
    expect(r.post.age?.text).toBe('Yesterday');
    expect(r.post.signals.sponsored).toBe(false);
    expect(ruleFilter(r.post, balanced)).toBeNull();
    expect(r.observations).toContain('li.label.promoted.near');
  });

  it('an unknown line where the age should be is weak evidence and an observation, never enough to hide', () => {
    const r = read(adLabelled('Brand new thing'));
    expect(detectors(r)).toContain('li.age-slot.no-age:weak');
    expect(r.post.signals.sponsored).toBe(false);
    expect(r.observations).toEqual(expect.arrayContaining(['li.slot.age.unrecognised', 'li.ad-cue']));
    // No age and a Follow button, with no label: an ad cue, counted for health only.
    expect(r.post.quality.adCue).toBe(true);
    expect(ruleFilter(r.post, light)).toBeNull();
  });

  it('reads the age from the age slot only, so a headline such as "3D printing" is never an age', () => {
    const r = read(
      adLabelled('Promoted • Brand content').replace('Growth Advisor | Example Consulting', '3D printing for clinics'),
    );
    expect(r.post.age).toBeUndefined();
    expect(r.post.signals.sponsored).toBe(true);
  });
});

describe('ad labels in the other label positions', () => {
  it('a header line, an actor line and a head button name are label positions', () => {
    const header = read(withHeader('Promoted'));
    expect(header.post.evidence).toContainEqual({ signal: 'sponsored', detector: 'li.promoted.header', strength: 'strong' });
    expect(header.post.contextLine).toBeUndefined();
    expect(header.post.quality.headerKnown).toBe(true);

    const actor = read(FIRST_DEGREE_POST.replace('<p>Yesterday •</p>', '<p>Sponsored</p><p>Yesterday •</p>'));
    expect(actor.post.evidence).toContainEqual({ signal: 'sponsored', detector: 'li.promoted.actor', strength: 'strong' });
    expect(actor.post.age?.text).toBe('Yesterday');

    const button = read(
      FIRST_DEGREE_POST.replace(
        '<button aria-label="Open control menu',
        '<button aria-label="Sponsored"></button><button aria-label="Open control menu',
      ),
    );
    expect(button.post.evidence).toContainEqual({ signal: 'sponsored', detector: 'li.promoted.header', strength: 'strong' });
    for (const r of [header, actor, button]) expect(ruleFilter(r.post, light)?.reason).toBe('sponsored');
  });

  it('"Promoted to Director" above the author is a job change, not an ad, and an unknown header line', () => {
    const r = read(withHeader('Promoted to Director'));
    expect(r.post.signals.sponsored).toBe(false);
    expect(r.post.evidence.filter((e) => e.signal === 'sponsored')).toEqual([]);
    expect(r.post.contextLine).toBeUndefined();
    expect(r.post.quality).toMatchObject({ headerUnknown: true });
    expect(r.observations).toContain('li.header.unknown');
    expect(ruleFilter(r.post, balanced)).toBeNull();
    // Nor as the author's headline.
    const headline = read(FIRST_DEGREE_POST.replace('HR Director at Northwind Clinics', 'Promoted to Director of Sales'));
    expect(headline.post.signals.sponsored).toBe(false);
  });

  it("an author's headline that starts with a label word is never an ad label, nor a near miss", () => {
    const headlined = (headline: string, age = true) => {
      const card = FIRST_DEGREE_POST.replace('HR Director at Northwind Clinics', headline);
      return read(age ? card : card.replace('<p>Yesterday •</p>', ''));
    };
    for (const headline of [
      'Sponsored Products Manager at Amazon',
      'Sponsored Content Lead at Acme',
      'Promoted Brand Partnerships Lead',
      'Sponsored by Specialized | Pro cyclist',
      'Promoted by Acme as Ambassador',
    ]) {
      const r = headlined(headline);
      expect(
        r.post.evidence.filter((e) => e.signal === 'sponsored'),
        headline,
      ).toEqual([]);
      expect(r.post.signals.sponsored, headline).toBe(false);
      expect(r.post.quality.adNearMiss, headline).toBeUndefined();
      expect(r.observations, headline).not.toContain('li.label.promoted.near');
      expect(ruleFilter(r.post, light), headline).toBeNull();
    }
    // Without an age line the headline is the block's last short line, so it is read as the age slot: a headline
    // without a separator after the label word is still no near miss, and "no post age" alone never hides.
    for (const headline of ['Sponsored Products Manager at Amazon', 'Sponsored Content Lead at Acme']) {
      const r = headlined(headline, false);
      expect(detectors(r), headline).not.toContain('li.promoted.near:medium');
      expect(r.post.signals.sponsored, headline).toBe(false);
      expect(ruleFilter(r.post, light), headline).toBeNull();
    }
  });

  it('two posts sharing a "Sponsored …" headline raise no "ads may be getting through" on a healthy feed', () => {
    const headline = 'Sponsored Products Manager at Amazon';
    const card = FIRST_DEGREE_POST.replace('HR Director at Northwind Clinics', headline);
    document.body.innerHTML = feed2026(card + card.replace('EEEkeyFirstDegree5', 'EEEkeyFirstDegree6'));
    const roots = findPostRoots(document.body);
    expect(roots).toHaveLength(2);
    for (const root of roots) {
      const r = linkedinAdapter.inspect(root as HTMLElement, { markers: m, now: NOW });
      expect(r.kind === 'post' && r.post.quality.adNearMiss).toBeFalsy();
      expect(r.kind === 'post' && noticed(r.observations)).toEqual([]);
    }
  });

  it("an author whose name starts with a label word isn't an ad", () => {
    const named = COMPANY_NOT_FOLLOWED.replaceAll('Example Robotics', 'Promoted Labs');
    const r = read(named);
    expect(r.post.author.name).toBe('Promoted Labs');
    expect(r.post.signals.sponsored).toBe(false);
    expect(ruleFilter(r.post, light)).toBeNull();
  });

  it('never reads labels in the post text: "Sponsored by Example Labs" or a bold "Promoted" there is not an ad', () => {
    for (const text of ['Sponsored by Example Labs', '<strong>Promoted</strong>', 'Promoted', 'Sponsored']) {
      const card = FIRST_DEGREE_POST.replace(
        'Which HR task would you automate first',
        `Our booth at the fair this week.<br><br>${text}<br><br>Which HR task would you automate first`,
      );
      const r = read(card);
      expect(r.post.text, text).toContain('Our booth');
      expect(r.post.signals.sponsored, text).toBe(false);
      expect(
        r.post.evidence.filter((e) => e.signal === 'sponsored'),
        text,
      ).toEqual([]);
      expect(ruleFilter(r.post, light), text).toBeNull();
    }
  });

  it('never reads labels in comments or in a reshared post', () => {
    const resharedAd = `<div>${PARTNERSHIP_AD.replace(/<div data-lazy-mount-id[\s\S]*?<h2>Feed post<\/h2>/, '').replace(/<div class="e0sbar">[\s\S]*$/, '')}</div>`;
    const card = FIRST_DEGREE_POST.replace('<div class="e0sbar">', `${resharedAd}<div class="e0sbar">`);
    const r = read(card);
    expect(r.post.author.name).toBe('Morgan Ellis');
    expect(r.post.signals.sponsored).toBe(false);
  });
});

describe('header lines', () => {
  it('known lines set the context line and its signal; unknown ones are only counted', () => {
    const known = read(FOLLOWED_BY_POST);
    expect(known.post.contextLine).toBe('Followed by Pat Morgan');
    expect(known.post.quality).toMatchObject({ headerKnown: true });
    expect(known.post.quality.headerUnknown).toBeUndefined();
    expect(known.observations).not.toContain('li.header.unknown');

    const unknown = read(withHeader('New comment in your group'));
    expect(unknown.post.contextLine).toBeUndefined();
    expect(unknown.post.quality).toMatchObject({ headerUnknown: true });
    expect(unknown.observations).toContain('li.header.unknown');
  });

  it('a near-miss "Suggested" line is medium evidence and an observation, not enough to hide', () => {
    const near = read(withHeader('Suggested by your network'));
    expect(near.post.evidence).toContainEqual({ signal: 'suggested', detector: 'li.header.suggested', strength: 'medium' });
    expect(near.post.signals.suggested).toBe(false);
    expect(near.observations).toContain('li.label.suggested.near');
    for (const line of ['Suggested', 'Suggested for you', 'Recommended for you', 'Popular in Toronto', 'Based on your profile']) {
      const r = read(withHeader(line));
      expect(r.post.evidence, line).toContainEqual({ signal: 'suggested', detector: 'li.header.suggested', strength: 'strong' });
      expect(r.post.signals.suggested, line).toBe(true);
    }
  });
});

describe('older layout', () => {
  it('finds the age slot and the header by their class names', () => {
    const promoted = read(PROMOTED_POST, feedHtml);
    expect(promoted.post.evidence).toContainEqual({ signal: 'sponsored', detector: 'li.promoted.age-slot', strength: 'strong' });
    const suggested = read(SUGGESTED_POST, feedHtml);
    expect(suggested.post.contextLine).toBe('Suggested');
    expect(suggested.post.age?.text).toBe('1d');
  });
});

describe('inspect', () => {
  it('returns what it noticed with the post', () => {
    document.body.innerHTML = feed2026(adLabelled('Promoted • Brand content'));
    const [root] = findPostRoots(document.body);
    const r = linkedinAdapter.inspect(root as HTMLElement, { markers: m, now: NOW });
    expect(r.kind).toBe('post');
    expect(r.kind === 'post' && noticed(r.observations)).toEqual(['li.label.promoted.near']);
    document.body.innerHTML = feed2026(FIRST_DEGREE_POST);
    const plain = linkedinAdapter.inspect(findPostRoots(document.body)[0] as HTMLElement, { markers: m, now: NOW });
    expect(plain.kind === 'post' && noticed(plain.observations)).toEqual([]);
  });
});

describe('"For you" captures (2026-10)', { timeout: 30_000 }, () => {
  /**
   * The scrambler kept LinkedIn's labels but not the ages ("3h" became "0x"), nor "Partnership with". Both are put
   * back, so the captures read as the live page did.
   */
  function load(file: string): string {
    return readFileSync(join(import.meta.dirname, '../../fixtures/linkedin', file), 'utf8')
      .replaceAll('Promoted • Xxxxxxxxxxx xxxx', 'Promoted • Partnership with')
      .replace(
        /(<p class="" componentkey="k\d+"><span>)(0{1,2})x( • Edited)?</g,
        (_, open, digits, edited) => `${open}${digits.length * 3}h${edited ?? ''}<`,
      );
  }

  it('finds every ad by its age slot, with no near misses and no unlabelled ad cues', () => {
    for (const [file, ads, unrecognised] of [
      // The first load's "<Name>'s job update" card shows a line about the job where a post's age would be.
      ['2026-10-foryou-1.html', 6, 1],
      ['2026-10-foryou-2.html', 7, 0],
    ] as const) {
      document.body.innerHTML = load(file);
      const scope = linkedinAdapter.feedScope(document) as HTMLElement;
      const seen: string[] = [];
      let sponsored = 0;
      for (const el of linkedinAdapter.findItems(scope)) {
        const r = linkedinAdapter.inspect(el, { markers: m, now: NOW });
        if (r.kind !== 'post') continue;
        seen.push(...noticed(r.observations));
        if (!r.post.signals.sponsored) continue;
        sponsored++;
        expect(r.post.evidence, file).toContainEqual({
          signal: 'sponsored',
          detector: 'li.promoted.age-slot',
          strength: 'strong',
        });
      }
      expect(sponsored, file).toBe(ads);
      expect(seen.filter((o) => o === 'li.slot.age.unrecognised').length, file).toBe(unrecognised);
      expect(
        seen.filter((o) => !['li.slot.age.unrecognised', 'li.header.unknown'].includes(o)),
        file,
      ).toEqual([]);
    }
  });
});
