import {
  CORRECTION_CHOICES,
  COUNT_KEYS,
  DEGRADED_SIGNALS,
  DETECTOR_IDS,
  ERROR_OPS,
  FILTER_REASONS,
  LANDMARK_KEYS,
  MAX_CORRECTION_MESSAGE,
  OBSERVATION_IDS,
  type ProblemReport,
  ProblemReportSchema,
  REPORT_CHOICES,
  REPORT_FROM,
  REPORT_ISSUES,
  ReportMessageSchema,
  ReportPostSchema,
  STRATEGY_IDS,
  MODULE_KINDS as WIRE_MODULE_KINDS,
} from '@unalgorithm/protocol';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  cleanReportMessage,
  describeReport,
  type FilterReason,
  MODULE_KINDS,
  type ModuleKind,
  NO_SIGNALS,
  type PostData,
  REPORT_LINE_COPY,
  SHORT_TEXT_CHARS,
  summarizePostForReport,
  textBucket,
} from '../src/index.ts';

describe('cleanReportMessage', () => {
  it('test_masks_contacts_links_and_handles', () => {
    expect(cleanReportMessage('Write to jane.doe@example.org about it')).toBe('Write to [email] about it');
    expect(cleanReportMessage('Call 416-555-0123 or +44 20 7946 0958')).toBe('Call [phone] or [phone]');
    expect(cleanReportMessage('See https://www.linkedin.com/in/jane-doe-123/?trk=feed')).toBe('See [link: linkedin.com]');
    expect(cleanReportMessage('Source: HTTP://Example.org/a')).toBe('Source: [link: example.org]');
    expect(cleanReportMessage('Look at www.example.com/a/b?c=1 please')).toBe('Look at [link: example.com] please');
    expect(cleanReportMessage('As @janedoe and @jane.doe said')).toBe('As @someone and @someone said');
    // A masked link isn't masked twice.
    expect(cleanReportMessage('https://www.example.com/x')).toBe('[link: example.com]');
  });

  it('test_masks_links_without_a_scheme_and_profile_addresses', () => {
    const cases: [string, string][] = [
      // Profile and post links typed without https:// or www.
      ['Ask Jane Doe at linkedin.com/in/janedoe', 'Ask Jane Doe at [link: linkedin.com]'],
      ['facebook.com/profile.php?id=100001234567', '[link: facebook.com]'],
      ['m.facebook.com/jane.doe.5/posts/123', '[link: facebook.com]'],
      ['linkedin.com/feed/update/urn:li:activity:7123456789012345678/', '[link: linkedin.com]'],
      ['lnkd.in/abc123 and fb.me/xyz and fb.com/jane', '[link: lnkd.in] and [link: fb.me] and [link: fb.com]'],
      // A profile or post address on its own.
      ['her page /in/jane-doe-123/ says so', 'her page [link] says so'],
      ['see /posts/jane-doe_activity-71234 there', 'see [link] there'],
      ['profile.php?id=100001234567', '[link]'],
      ['the post urn:li:activity:7123456789012345678 is wrong', 'the post [link] is wrong'],
      // A personal subdomain keeps only the site, with a scheme or without.
      ['https://jane-doe.substack.com/p/x', '[link: substack.com]'],
      ['jane-doe.substack.com/p/x', '[link: substack.com]'],
      ['Read jane-doe.substack.com today', 'Read [link: substack.com] today'],
      ['https://news.bbc.co.uk/2/hi/a.stm', '[link: bbc.co.uk]'],
      ['www.cbc.ca', '[link: cbc.ca]'],
      // An address with no site says nothing about one.
      ['http://localhost:3000/x', '[link]'],
      // Sentence punctuation after a link stays.
      ['It says so on linkedin.com/in/janedoe.', 'It says so on [link: linkedin.com].'],
      ['Is it on example.org/a?', 'Is it on [link: example.org]?'],
    ];
    for (const [typed, clean] of cases) {
      expect(cleanReportMessage(typed), typed).toBe(clean);
      // The raw text is refused on the wire, so the server's check catches a sender that skipped the cleaning.
      if (/\/|\?|urn:/.test(typed)) expect(ReportMessageSchema.safeParse(typed).success, typed).toBe(false);
      expect(ReportMessageSchema.safeParse(clean).success, clean).toBe(true);
    }
  });

  it('test_leaves_ordinary_words_alone', () => {
    for (const text of [
      'The verdict says e.g. and i.e. wrongly.',
      'It cites the U.S. Census, not Statistics Canada.',
      'Visit example.org for the source.',
      'A 3.5/5 rating and v1.2.3 are not links.',
      'It was 50/50, and/or worse.',
      'He was promoted to Director in 2024.',
    ]) {
      expect(cleanReportMessage(text), text).toBe(text);
    }
  });

  it('test_strips_invisible_and_control_characters', () => {
    for (const hidden of [
      '\u200B',
      '\u200C',
      '\u200D',
      '\u200E',
      '\u200F',
      '\u202A',
      '\u202E',
      '\u2066',
      '\u2069',
      '\uFEFF',
      '\u034F',
      '\u00AD',
      '\u2060',
    ]) {
      expect(cleanReportMessage(`Ja${hidden}ne`), JSON.stringify(hidden)).toBe('Jane');
    }
    expect(cleanReportMessage('evil\u202Etxt.exe')).toBe('eviltxt.exe');
    expect(cleanReportMessage('a\u0000b\u0007c\u001Bd\u007Fe\u0085f')).toBe('abcdef');
    expect(cleanReportMessage('one\r\ntwo\rthree\tfour')).toBe('one\ntwo\nthree four');
    expect(cleanReportMessage('  one  \n\n\n\n  two   three  ')).toBe('one\n\ntwo three');
    // NFKC: look-alike letters become plain ones, so the masks see them.
    expect(cleanReportMessage('ＡＢＣ 𝓙𝓪𝓷𝓮')).toBe('ABC Jane');
    expect(cleanReportMessage('jane＠example．org')).toBe('[email]');
  });

  it('test_caps_without_splitting_a_character', () => {
    expect(cleanReportMessage('a'.repeat(5000))).toHaveLength(MAX_CORRECTION_MESSAGE);
    const emoji = cleanReportMessage(`a${'😀'.repeat(600)}`);
    expect(emoji.length).toBeLessThanOrEqual(MAX_CORRECTION_MESSAGE);
    expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(cleanReportMessage(`${'a'.repeat(998)} b`)).toBe(`${'a'.repeat(998)} b`);
    expect(cleanReportMessage(`${'a'.repeat(999)} bcd`)).toBe('a'.repeat(999));
  });

  it('test_cleaned_messages_fit_the_wire', () => {
    const nasty = [
      'Plain words.',
      'Mixed\r\n\r\n\r\nlines\twith\u0000junk\u202E and https://example.com/x?y=1#z',
      `${'long '.repeat(400)}https://example.org`,
      'Contact jane@example.org, +1 (416) 555-0123, @jane, www.example.com',
      'linkedin.com/in/jane, /in/jane, profile.php?id=1, urn:li:activity:1, jane.example.substack.com.',
      '\uFEFF\u200B  leading and trailing  \u200B\n',
      `${'😀'.repeat(700)}`,
    ];
    for (const text of nasty) {
      const clean = cleanReportMessage(text);
      expect(ReportMessageSchema.safeParse(clean).success, text.slice(0, 40)).toBe(true);
      // Cleaning twice changes nothing: the server's second pass stores what the person saw.
      expect(cleanReportMessage(clean)).toBe(clean);
    }
    expect(cleanReportMessage(' \u200B\n\t ')).toBe('');
  });
});

/** A post full of things a report must never carry. */
const LEAKY: PostData = {
  id: 'li:urn:li:activity:7381234567890123456',
  platform: 'linkedin',
  permalink: 'https://www.linkedin.com/feed/update/urn:li:activity:7381234567890123456/',
  author: {
    name: 'Jane Q. Doe',
    url: 'https://www.linkedin.com/in/jane-doe-123/',
    kind: 'person',
    relationship: 'not-followed',
  },
  group: { name: 'Toronto Gardeners Club', joined: false },
  contextLine: 'Robert Smith likes this',
  signals: { ...NO_SIGNALS, suggested: true },
  evidence: [
    { signal: 'suggested', detector: 'li.header.suggested', strength: 'strong' },
    { signal: 'relationship', detector: 'li.follow-button', strength: 'strong' },
    { signal: 'suggested', detector: 'li.header.suggested', strength: 'strong' },
  ],
  text: 'Thrilled to announce that Jane Q. Doe joined Acme Widgets as VP of Sprockets! Call 416-555-0123. #hiring',
  textComplete: true,
  mentions: ['Robert Smith', 'Acme Widgets'],
  lang: 'en',
  media: 'image',
  sharedLink: { url: 'https://acme-widgets.example/careers?ref=li', domain: 'acme-widgets.example', title: 'Careers at Acme' },
  age: { text: '3h', hours: 3 },
  quality: { authorFound: true, textFound: true, adNearMiss: 'h:1a2b3c', adCue: true, headerKnown: true },
};

describe('summarizePostForReport', () => {
  it('test_summary_never_carries_content', () => {
    const summary = summarizePostForReport(LEAKY, { reason: 'suggested', source: 'rule' });
    expect(summary).toStrictEqual({
      reason: 'suggested',
      source: 'rule',
      evidence: [
        { detector: 'li.header.suggested', strength: 'strong' },
        { detector: 'li.follow-button', strength: 'strong' },
      ],
      authorKind: 'person',
      relationship: 'not-followed',
      media: 'image',
      text: 'short',
    });
    expect(ReportPostSchema.safeParse(summary).success).toBe(true);
    const json = JSON.stringify(summary);
    for (const leak of [
      'Jane',
      'Doe',
      'Robert',
      'Acme',
      'Toronto',
      'Sprockets',
      'hiring',
      '416',
      '7381234567890123456',
      'urn:li',
      'linkedin.com',
      'https',
      'acme-widgets',
      'Careers',
      '3h',
      'h:1a2b3c',
    ]) {
      expect(json, leak).not.toContain(leak);
    }
  });

  it('test_summary_of_a_panel_and_odd_evidence', () => {
    const panel = summarizePostForReport(null, {
      reason: 'module',
      source: 'rule',
      module: { kind: 'people-you-may-know', title: 'People you may know: Jane Doe and 3 others' },
    });
    expect(panel).toStrictEqual({
      reason: 'module',
      source: 'rule',
      evidence: [],
      authorKind: 'unknown',
      relationship: 'unknown',
      media: 'none',
      text: 'none',
      module: 'people-you-may-know',
    });
    expect(JSON.stringify(panel)).not.toContain('Jane');
    // An id that doesn't fit the wire (an adapter bug, or a name) is left out rather than spoil the report.
    const odd: PostData = {
      ...LEAKY,
      evidence: [
        { signal: 'sponsored', detector: 'li.jane doe', strength: 'strong' },
        { signal: 'sponsored', detector: 'Promoted by Acme', strength: 'strong' },
        ...Array.from({ length: 30 }, (_, i) => ({
          signal: 'sponsored' as const,
          detector: `li.d${i}`,
          strength: 'weak' as const,
        })),
      ],
    };
    const summary = summarizePostForReport(odd, { reason: 'sponsored', source: 'rule' });
    expect(summary.evidence).toHaveLength(24);
    expect(summary.evidence[0]).toEqual({ detector: 'li.d0', strength: 'weak' });
    expect(ReportPostSchema.safeParse(summary).success).toBe(true);
  });

  it('test_text_bucket', () => {
    expect(textBucket(undefined)).toBe('none');
    expect(textBucket('  \n ')).toBe('none');
    expect(textBucket('a'.repeat(SHORT_TEXT_CHARS - 1))).toBe('short');
    expect(textBucket('a'.repeat(SHORT_TEXT_CHARS))).toBe('long');
  });
});

const ENV = { extension: '0.4.1', channel: 'chrome-store', browser: 'chrome', browserMajor: 141 } as const;
const PAGE = {
  platform: 'linkedin',
  adapter: 'linkedin@2026.11.0',
  route: 'feed-candidate',
  feedWord: 'foryou',
  lang: 'en',
  preset: 'balanced',
  ai: 'off',
  paused: false,
} as const;
const ID = '0b6f7d3c-5a2e-4f1b-9c8d-7e6a5b4c3d2e';
const report = (r: unknown): ProblemReport => ProblemReportSchema.parse(r);

describe('describeReport', () => {
  it('test_describe_detection', () => {
    const lines = describeReport(
      report({
        v: 1,
        id: ID,
        kind: 'detection',
        from: 'notice',
        choices: ['ads-showing'],
        env: ENV,
        page: PAGE,
        health: { status: 'not-started', issues: ['feed-not-started'], degraded: [] },
        detection: {
          counts: { items: 24, posts: 22, modules: 2, hidden: 15, pending: 1 },
          hiddenBy: { sponsored: 5, 'not-followed': 5, 'network-activity': 5 },
          detectors: { 'li.promoted.age-slot': 5, 'li.follow-button': 12 },
          landmarks: { main: 1, feedList: 1 },
          observations: { 'li.label.promoted.near': 2 },
          errors: { inspect: 3 },
          strategy: 'li.items.anatomy',
        },
      }),
    );
    expect(lines).toStrictEqual([
      'unAlgorithm 0.4.1 from the Chrome Web Store · LinkedIn detection 2026.11.0',
      'Chrome 141',
      'Reported from a note in the feed',
      'Page: LinkedIn home feed (a new address: foryou), in English',
      'Your settings: Balanced, AI off',
      "unAlgorithm noticed: LinkedIn's feed is on a page unAlgorithm doesn't recognise",
      'On this page: 22 posts, 2 panels, 15 folded away (5 ads, 5 not followed, 5 network activity), 1 still loading',
      'Detection rules that matched: ad label 5, Follow button 12',
      'Also noticed: a label like an ad label 2',
      'Posts found by: post buttons and menus',
      'Errors caught: reading posts 3',
      'Page parts counted: main area 1, feed list 1',
      'Your answer: Ads are still showing',
    ]);
  });

  it('test_describe_wrong_call', () => {
    const lines = describeReport(
      report({
        v: 1,
        id: ID,
        kind: 'wrong-call',
        from: 'why',
        choices: ['should-show'],
        env: { ...ENV, channel: 'firefox-store', browser: 'firefox', browserMajor: 147 },
        page: { ...PAGE, route: 'feed', feedWord: undefined, lang: 'fr', preset: 'calm', ai: 'own-key', paused: true },
        health: { status: 'degraded', issues: ['author-detection'], degraded: ['relationship'] },
        detection: { counts: { posts: 1, modules: 0 } },
        post: summarizePostForReport(LEAKY, { reason: 'suggested', source: 'rule' }),
      }),
    );
    expect(lines).toStrictEqual([
      'unAlgorithm 0.4.1 from Firefox Add-ons · LinkedIn detection 2026.11.0',
      'Firefox 147',
      'Reported from Why? on a post',
      'Page: LinkedIn home feed, in French',
      'Your settings: Calm, AI with your own key, paused on LinkedIn',
      "unAlgorithm noticed: unAlgorithm couldn't tell who wrote most posts",
      'Switched off on this page to be safe: who you follow',
      'On this page: 1 post, 0 panels',
      "Your answer: This post shouldn't have been hidden",
      "The post: hidden as Suggested by a rule; seen: suggested header (strong), Follow button (strong); author: a person you don't follow; with an image; short text.",
    ]);
  });

  it('test_describe_correction', () => {
    const r = report({
      v: 1,
      id: ID,
      kind: 'correction',
      from: 'sidepanel',
      choices: ['outlet-wrong'],
      env: { ...ENV, channel: 'edge-store', browser: 'edge' },
      correction: {
        feature: 'perspectives',
        promptVersion: 2,
        list: 'cloud',
        via: 'own-server',
        message: 'The outlet leans the other way.',
        contact: 'ann@example.org',
      },
    });
    expect(describeReport(r)).toStrictEqual([
      'unAlgorithm 0.4.1 from Microsoft Edge Add-ons',
      'Edge 141',
      'Reported from the side panel',
      "About: an UnEcho Chamber result (prompt version 2, unAlgorithm Cloud's source list), made with your own server",
      'Your answer: An outlet or its lean is wrong',
      'In your own words: The outlet leans the other way.',
      'Reply to: ann@example.org',
    ]);
    // The admin page shows the words and the address on their own.
    expect(describeReport(r, { words: false })).toHaveLength(5);
    const { contact: _contact, ...noContact } = r.correction!;
    expect(describeReport({ ...r, correction: noContact }).at(-1)).toBe('No reply email');
    const factcheck = { feature: 'factcheck', promptVersion: 3, via: 'cloud', message: 'x' } as const;
    expect(describeReport({ ...r, choices: ['verdict-wrong'], correction: factcheck })[3]).toBe(
      'About: a Fact-check result (prompt version 3), made with unAlgorithm Cloud',
    );
  });

  it('test_describe_other_private_and_stored', () => {
    expect(
      describeReport(
        report({ v: 1, id: ID, kind: 'other', from: 'settings', choices: ['ai'], env: { ...ENV, channel: 'sideload' } }),
      ),
    ).toStrictEqual([
      'unAlgorithm 0.4.1 installed from a file',
      'Chrome 141',
      'Reported from Settings',
      'Your answer: AI labels, Fact-check or UnEcho Chamber',
    ]);
    expect(
      describeReport(
        report({
          v: 1,
          id: ID,
          kind: 'detection',
          from: 'popup',
          choices: ['not-working'],
          private: true,
          env: { ...ENV, channel: 'other', browser: 'other' },
        }),
      ),
    ).toStrictEqual([
      'unAlgorithm 0.4.1',
      'Another browser, version 141',
      'Reported from the toolbar menu',
      'From a private window, so nothing about the page.',
      "Your answer: unAlgorithm isn't doing anything on this page",
    ]);
    // What the server stored: no id, an unknown origin, codes this version doesn't know shown as they are.
    expect(
      describeReport({
        kind: 'detection',
        from: null,
        choices: ['brand-new-choice'],
        env: ENV,
        page: { ...PAGE, route: 'unknown', feedWord: undefined, lang: 'unknown' },
        health: { status: 'ok', issues: ['brand-new-issue'], degraded: [] },
      }),
    ).toStrictEqual([
      'unAlgorithm 0.4.1 from the Chrome Web Store · LinkedIn detection 2026.11.0',
      'Chrome 141',
      'Page: LinkedIn, page not checked',
      'Your settings: Balanced, AI off',
      'unAlgorithm noticed: brand-new-issue',
      'Your answer: brand-new-choice',
    ]);
  });

  it('test_line_copy_covers_the_registry', () => {
    const missing = (table: Readonly<Record<string, string>>, codes: readonly string[]) => codes.filter((c) => !(c in table));
    expect(missing(REPORT_LINE_COPY.issues, REPORT_ISSUES)).toEqual([]);
    expect(
      missing(REPORT_LINE_COPY.choices, [...Object.values(REPORT_CHOICES).flat(), ...Object.values(CORRECTION_CHOICES).flat()]),
    ).toEqual([]);
    expect(missing(REPORT_LINE_COPY.from, REPORT_FROM)).toEqual([]);
    expect(missing(REPORT_LINE_COPY.reasons, FILTER_REASONS)).toEqual([]);
    expect(missing(REPORT_LINE_COPY.reason, FILTER_REASONS)).toEqual([]);
    expect(missing(REPORT_LINE_COPY.modules, WIRE_MODULE_KINDS)).toEqual([]);
    expect(missing(REPORT_LINE_COPY.detectors, DETECTOR_IDS)).toEqual([]);
    expect(missing(REPORT_LINE_COPY.observations, OBSERVATION_IDS)).toEqual([]);
    expect(missing(REPORT_LINE_COPY.strategies, STRATEGY_IDS)).toEqual([]);
    expect(missing(REPORT_LINE_COPY.counts, COUNT_KEYS)).toEqual([]);
    expect(missing(REPORT_LINE_COPY.landmarks, LANDMARK_KEYS)).toEqual([]);
    expect(missing(REPORT_LINE_COPY.errors, ERROR_OPS)).toEqual([]);
    expect(missing(REPORT_LINE_COPY.degraded, DEGRADED_SIGNALS)).toEqual([]);
    expect(REPORT_LINE_COPY.observations['li.slot.actor.structure']).toBe('author found by page structure');
  });
});

describe('registry mirrors core', () => {
  it('test_filter_reasons_and_module_kinds_match_core', () => {
    // The wire's lists are written out in protocol (which imports nothing); these keep them equal to core's.
    expectTypeOf<(typeof FILTER_REASONS)[number]>().toEqualTypeOf<FilterReason>();
    expectTypeOf<(typeof WIRE_MODULE_KINDS)[number]>().toEqualTypeOf<ModuleKind>();
    expect([...WIRE_MODULE_KINDS]).toEqual([...MODULE_KINDS]);
  });
});
