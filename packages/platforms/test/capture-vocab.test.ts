import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { feed, post } from '../fixtures/facebook/live2026.ts';
import { facebookAdapter } from '../src/facebook/adapter.ts';
import { FACEBOOK_EN } from '../src/facebook/markers/en.ts';
import { LINKEDIN_EN } from '../src/linkedin/markers/en.ts';
import type { LabelPattern } from '../src/shared/labels.ts';

/**
 * Capture hardening (ADR 0009 §9, phase C). The capture scripts scramble every word they don't keep, so a label the
 * KEEP list lacks reaches the fixtures as "Xxxxxxxxxxx xxxx", and detection is tested against something LinkedIn never
 * showed: in 2026-10 that was "Partnership with" and "funny". Every word the adapters' markers read must therefore be
 * kept. The scripts themselves, and the fixture checker, are run here as the maintainer runs them.
 */
const REPO = join(import.meta.dirname, '../../..');
const source = (platform: 'linkedin' | 'facebook') => readFileSync(join(REPO, 'scripts/capture', `${platform}.js`), 'utf8');

/** The script's KEEP list, read the way check-fixtures.mjs reads it. */
function keepOf(platform: 'linkedin' | 'facebook'): RegExp {
  const literal = /const KEEP =\s*\/(.+)\/([a-z]*);/.exec(source(platform));
  if (!literal?.[1]) throw new Error(`no KEEP list in scripts/capture/${platform}.js`);
  return new RegExp(literal[1], literal[2]);
}

const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
/** Every word of a label pattern: heads, tails, the words that make it something else, and the prefix. */
const patternWords = (p: LabelPattern) =>
  [...p.heads, ...(p.tails ?? []), ...(p.notTails ?? []), p.prefix ?? ''].flatMap(wordsOf);
/** The words a regex marker matches in text: its letters, without escapes or character classes; "likes?" is both forms. */
const regexWords = (r: RegExp) =>
  wordsOf(
    r.source
      .replace(/\\[a-zA-Z]/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/([a-z]+)s\?/gi, '$1 $1s'),
  );

/** What each adapter reads in text: label patterns, panel titles, header sentences, ages, and Facebook's ad buttons. */
const VOCABULARY: Record<'linkedin' | 'facebook', Record<string, string[]>> = {
  linkedin: {
    labels: Object.values(LINKEDIN_EN.labels).flatMap(patternWords),
    'panel titles': regexWords(LINKEDIN_EN.module),
    'header sentences': [LINKEDIN_EN.activity, LINKEDIN_EN.followedBy, LINKEDIN_EN.repost].flatMap(regexWords),
    ages: regexWords(LINKEDIN_EN.ageWord),
  },
  facebook: {
    labels: Object.values(FACEBOOK_EN.labels).flatMap(patternWords),
    'panel titles': Object.values(FACEBOOK_EN.modules).flatMap(patternWords),
    'header sentences': [
      FACEBOOK_EN.suggestedHeader,
      FACEBOOK_EN.activity,
      FACEBOOK_EN.reshare,
      FACEBOOK_EN.paidPartnership,
    ].flatMap(regexWords),
    ages: regexWords(FACEBOOK_EN.ageWords),
    'ad buttons': regexWords(FACEBOOK_EN.ctaButtons),
    audiences: Object.values(FACEBOOK_EN.audience).flatMap(regexWords),
  },
};

describe('the capture scripts keep every word detection reads', () => {
  it.each(
    Object.entries(VOCABULARY).flatMap(([platform, kinds]) =>
      Object.entries(kinds).map(([kind, words]) => [platform, kind, words] as const),
    ),
  )('%s: %s', (platform, _kind, words) => {
    expect(words.length).toBeGreaterThan(0);
    const keep = keepOf(platform as 'linkedin' | 'facebook');
    expect([...new Set(words)].filter((w) => !keep.test(w))).toEqual([]);
  });

  it('the vocabulary includes the words the 2026-10 captures lost', () => {
    expect(VOCABULARY.linkedin.labels).toEqual(expect.arrayContaining(['partnership', 'with']));
    expect(VOCABULARY.linkedin['header sentences']).toContain('funny');
    expect(VOCABULARY.facebook.ages).toEqual(expect.arrayContaining(['ago', 'yesterday']));
  });
});

/** Run a capture script on the current document, as pasted into DevTools; resolves with what it copied. */
async function capture(platform: 'linkedin' | 'facebook', items = '30'): Promise<{ html: string; console: string[] }> {
  const logged: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logged.push(args.join(' ')));
  vi.stubGlobal('prompt', () => items);
  vi.stubGlobal('alert', () => undefined);
  const copied = new Promise<string>((resolve) => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => resolve(text) },
    });
  });
  // The scripts are plain browser JavaScript, not modules: run them as DevTools would.
  new Function(source(platform))();
  const html = await copied;
  log.mockRestore();
  return { html, console: logged };
}

/** jsdom has no layout: give every element a size, as the browser would, so only really hidden ones are marked. */
function withLayout() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 100,
    height: 20,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 100,
    bottom: 20,
    toJSON: () => ({}),
  } as DOMRect);
}

/** Run scripts/check-fixtures.mjs on `files` in a new folder; its exit code and output. */
function checkFixtures(files: Record<string, string>, arg?: (dir: string) => string) {
  const dir = mkdtempSync(join(tmpdir(), 'ua-fixtures-'));
  try {
    for (const [name, html] of Object.entries(files)) writeFileSync(join(dir, name), html);
    const run = spawnSync(process.execPath, [join(REPO, 'scripts/check-fixtures.mjs'), arg ? arg(dir) : dir], {
      encoding: 'utf8',
    });
    return { code: run.status, out: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the capture scripts', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en';
    withLayout();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('LinkedIn: keeps labels and ages, fakes names, keys, test ids and ids, and leaves out what unAlgorithm folded', async () => {
    document.body.innerHTML = `<main><div role="list" data-testid="mainFeed">
      <div role="listitem"><div aria-label="Start a post">Start a post</div></div>
      <div><div role="listitem" componentkey="update-card-focusAbCdEf123FeedType_MAIN_FEED_RELEVANCE">
        <h2>Feed post</h2>
        <p><span>Followed by <a href="https://www.linkedin.com/in/jane-doe/">Jane Doe</a></span></p>
        <div aria-label="Riley Quinn 2nd"><p>Riley Quinn</p><p>• 2nd</p><p>Founder at Example Labs</p><p>3h • Edited •</p></div>
        <div componentkey="ZW5jb2RlZA==urn:li:comment:(groupPost:123-456)"><p>Promoted • Brand new thing</p></div>
        <div data-testid="expandable-text-box"><span>Our quiet launch went well.</span></div>
        <button aria-labelledby="send-label"><svg><use href="#icon-send"></use></svg></button>
        <div data-testid="EgsIgMC33-commentListAbC123"><p>Pat Lee</p></div>
        <div data-testid="feed-card-Id98765"></div>
      </div></div>
      <div data-unalgo="collapsed"><div role="listitem" componentkey="update-card-focusZZZ"><p>Hidden ad by Secret Co</p></div></div>
      <unalgo-post><p>Our own UI</p></unalgo-post>
    </div></main>
    <span id="send-label">Send to Morgan</span>
    <svg><symbol id="icon-send"><title>Morgan</title></symbol></svg>`;
    const { html, console: logged } = await capture('linkedin');

    expect(html).toMatch(/^<!-- captured \d{4}-\d{2}-\d{2} lang=en -->/);
    expect(html).toContain('>3h • Edited •<');
    expect(html).toContain('>Followed by <');
    expect(html).toContain('>Feed post<');
    for (const name of [
      'Riley',
      'Quinn',
      'Jane',
      'Morgan',
      'Pat',
      'Secret',
      'launch',
      'jane-doe',
      'AbCdEf',
      'urn:li:comment',
      'ZW5j',
    ])
      expect(html).not.toContain(name);
    // The folded item and our own element are left out, and the console says so.
    expect(html).not.toContain('Xxxxxx xx by');
    expect(html).not.toContain('unalgo');
    expect(html.match(/role="listitem"/g)).toHaveLength(2);
    expect(logged.join('\n')).toContain('Left out 1 items unAlgorithm folded away.');
    // Keys and test ids: the card key's prefix and feed sort stay, everything else is a stable fake.
    expect(html).toMatch(/componentkey="update-card-focus\d+FeedType_MAIN_FEED_RELEVANCE"/);
    expect(html).toMatch(/componentkey="k\d+"/);
    expect(html).toContain('data-testid="mainFeed"');
    expect(html).toContain('data-testid="expandable-text-box"');
    expect(html).toMatch(/data-testid="x-commentList\d+"/);
    expect(html).toMatch(/data-testid="t\d+"/);
    // References to labels and icons keep pointing at the appendix, under the same fake ids.
    const labelledBy = /aria-labelledby="(id\d+)"/.exec(html)?.[1];
    const use = /<use href="#(id\d+)"/.exec(html)?.[1];
    expect(html).toContain(`<span id="${labelledBy}">Send to Xxxxxx</span>`);
    expect(html).toContain(`<symbol id="${use}"`);
    // A label with a scrambled word is pointed out in the console, never in what is copied.
    expect(logged.join('\n')).toContain('Promoted • Xxxxx xxx xxxxx');
    expect(html).not.toContain('Short header lines');
    expect(checkFixtures({ 'capture.html': html })).toEqual({ code: 0, out: 'fixtures:check ok\n' });
  });

  it('Facebook: keeps "Ad", ages in words and their SVG references, fakes ids, and leaves out what unAlgorithm folded', async () => {
    document.body.innerHTML = `<div role="main"><div><h3>Feed posts</h3><div aria-hidden="true"></div><div>
      <div><div aria-posinset="1" aria-describedby="_r_5_">
        <div data-ad-rendering-role="profile_name"><h4><a href="https://www.facebook.com/riley.chen"><b><span>Riley Chen</span></b></a></h4></div>
        <a href="https://www.facebook.com/?__cft__[0]=AZ"><span><svg><use xlink:href="#SvgT1"></use></svg></span></a>
        <div data-ad-preview="message"><div dir="auto">Tomatoes, finally.</div></div>
      </div></div>
      <div><div aria-posinset="2">
        <h4><a href="https://www.facebook.com/shopexample">Shop Example</a></h4>
        <a href="https://www.facebook.com/"><span><svg><use href="#SvgT2"></use></svg></span></a>
        <span>Sponsored · Brand deal</span>
        <div data-ad-preview="message"><div dir="auto">Autumn sale.</div></div>
      </div></div>
      <div data-unalgo="hidden"><div aria-posinset="3"><span>Folded post by Secret Co</span></div></div>
    </div></div></div>
    <div hidden><svg><text id="SvgT1">about an hour ago</text><text id="SvgT2">Ad</text><text id="SvgT3">9 hours ago</text></svg>
    <span id="_r_5_">Shared by Riley</span></div>`;
    const { html, console: logged } = await capture('facebook');

    for (const name of ['Riley', 'Chen', 'Tomatoes', 'shopexample', 'Secret', '_r_5_', 'SvgT1', '__cft__'])
      expect(html).not.toContain(name);
    expect(html).toContain('>Feed posts<');
    expect(html.match(/aria-posinset/g)).toHaveLength(2);
    // "Ad" and the age are SVG text elsewhere in the page: the <use> keeps pointing at their copies in the appendix.
    const [hour, ad] = [...html.matchAll(/<use href="#(id\d+)"/g)].map((m) => m[1]);
    expect(html).toMatch(new RegExp(`<text id="${hour}"[^>]*>about an hour ago</text>`));
    expect(html).toMatch(new RegExp(`<text id="${ad}"[^>]*>Ad</text>`));
    const describedBy = /aria-describedby="(id\d+)"/.exec(html)?.[1];
    expect(html).toContain(`<span id="${describedBy}"`);
    expect(logged.join('\n')).toContain('Sponsored · Xxxxx xxxx');
    expect(logged.join('\n')).toContain('Left out 1 items unAlgorithm folded away.');
    expect(checkFixtures({ 'capture.html': html })).toEqual({ code: 0, out: 'fixtures:check ok\n' });
  });

  it('Facebook: copies a label drawn through a chain of <use> whole, scrambled, and the copy reads as the page did', async () => {
    // Since 2026-10 the age and "Ad" are a <use> of an <svg> holding another <use>, 7 references deep, before the <text>.
    const steps = (name: string, label: string) =>
      `${Array.from({ length: 6 }, (_, i) => `<svg id="${name}${i + 1}" aria-label="Riley Chen"><use href="#${name}${i + 2}"></use></svg>`).join('')}<svg><text id="${name}7">${label}</text></svg>`;
    const slot = (id: string) => `<span><span><svg><use xlink:href="#${id}"></use></svg></span></span>`;
    document.body.innerHTML = `${feed(
      post({ author: 'Gadget Daily', text: 'Autumn sale.', slot: slot('AdStep1') }),
      post({ author: 'Riley Chen', text: 'Tomatoes, finally.', slot: slot('AgeStep1') }),
    )}<div hidden>${steps('AdStep', 'Ad')}${steps('AgeStep', 'October 5 at 3:45 PM')}</div>`;
    const { html } = await capture('facebook');

    for (const name of ['Riley', 'Chen', 'Gadget', 'Tomatoes', 'AdStep', 'AgeStep', 'October']) expect(html).not.toContain(name);
    expect(checkFixtures({ 'capture.html': html })).toEqual({ code: 0, out: 'fixtures:check ok\n' });
    // Each chain is copied to its end, under the same fakes as the references to it.
    document.body.innerHTML = html;
    const ends = Array.from(document.querySelectorAll('[aria-posinset]')).map((item) => {
      let use = item.querySelector('use');
      for (let hops = 1; use; hops++) {
        const target = document.getElementById((use.getAttribute('href') ?? '').replace(/^#/, ''));
        if (!target?.querySelector('use')) return [hops, target?.textContent];
        use = target.querySelector('use');
      }
      return null;
    });
    expect(ends).toEqual([
      [7, 'Ad'],
      [7, 'Xxxxxxx 0 xx 0:00 XX'],
    ]);
    const scope = facebookAdapter.feedScope(document) as HTMLElement;
    const [ad, age] = facebookAdapter
      .findItems(scope)
      .map((el) => facebookAdapter.inspect(el, { markers: FACEBOOK_EN, now: new Date(2026, 9, 19) }))
      .map((r) => (r.kind === 'post' ? r.post : null));
    expect(ad?.evidence).toContainEqual({ signal: 'sponsored', detector: 'fb.sponsored.slot-label', strength: 'strong' });
    expect(age?.evidence).toEqual([]);
  });

  it('every word the adapters read comes through a capture unscrambled', async () => {
    for (const platform of ['linkedin', 'facebook'] as const) {
      const words = [...new Set(Object.values(VOCABULARY[platform]).flat())];
      const lines = words.map((w) => `<p>${w}</p>`).join('');
      document.body.innerHTML =
        platform === 'linkedin'
          ? `<main><div role="list" data-testid="mainFeed"><div role="listitem">${lines}</div></div></main>`
          : `<div role="main"><div role="feed"><div>${lines}</div></div></div>`;
      const { html } = await capture(platform);
      expect(words.filter((w) => !new RegExp(`>${w}<`, 'i').test(html))).toEqual([]);
      vi.unstubAllGlobals();
    }
  });
});

describe('check-fixtures.mjs', () => {
  const CAPTURE = '<!-- captured 2026-10-19 lang=en -->\n<main><p>Xxxx Xxxxx</p><p>Promoted • Partnership with</p></main>';

  it('passes an anonymized capture, React ids and Facebook routes, given a folder or one file', () => {
    const ok = `${CAPTURE}<a href="https://www.facebook.com/profile.php?id=100001" aria-labelledby="_R_3aqmhlaal5bb6ismj5ilipam_ id100002"></a><div id="right_rail_container"></div>`;
    expect(checkFixtures({ 'a.html': ok }).code).toBe(0);
    expect(checkFixtures({ 'a.html': ok }, (dir) => join(dir, 'a.html')).code).toBe(0);
  });

  it('refuses an unscrambled word in the text, a label, a link or an id', () => {
    for (const leak of [
      '<p>Morgan</p>',
      '<a aria-label="Morgan Ellis"></a>',
      '<a href="https://www.linkedin.com/in/morgan-ellis/"></a>',
      '<span id="morgan_ellis_label"></span>',
      '<span aria-labelledby="name-morgan"></span>',
    ]) {
      const run = checkFixtures({ 'leak.html': `${CAPTURE}${leak}` });
      expect([leak, run.code, run.out]).toEqual([leak, 1, expect.stringMatching(/unscrambled word\(s\): .*[Mm]organ/)]);
    }
  });

  it('refuses anything that came from a problem report a user sent', () => {
    for (const report of [
      '<!-- unAlgorithm problem report, LinkedIn -->',
      '<!-- ref 7KQ3-M2PA -->',
      '<div data-ua-state="hidden"><p>Xxxx</p></div>',
    ]) {
      const run = checkFixtures({ 'report.html': `${CAPTURE}${report}` });
      expect([report, run.code, run.out]).toEqual([
        report,
        1,
        expect.stringContaining('looks like a problem report a user sent'),
      ]);
    }
  });
});
