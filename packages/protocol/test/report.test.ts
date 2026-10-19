import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ADMIN_REPORT_ROUTE,
  ADMIN_REPORTS_DELETE_PATH,
  ADMIN_REPORTS_FLOOR_PATH,
  ADMIN_REPORTS_FORGET_CONTACT_PATH,
  ADMIN_REPORTS_HANDLE_PATH,
  ADMIN_REPORTS_PATH,
  ADMIN_REPORTS_SUMMARY_PATH,
  adapterOrder,
  adapterPlatform,
  CLOUD_ORIGIN,
  FEED_WORD_DENY,
  latestAdapterOrder,
  MAX_CORRECTION_MESSAGE,
  MAX_REPORT_BODY_BYTES,
  type ProblemReport,
  ProblemReportSchema,
  parseReportRef,
  quarterOf,
  REPORT_BACKUP_NIGHTS,
  REPORT_CONTACT_AFTER_HANDLED_DAYS,
  REPORT_CONTACT_KEEP_DAYS,
  REPORT_ERRORS,
  REPORT_KEEP_DAYS,
  type REPORT_KINDS,
  REPORT_LOCAL_PER_DAY,
  REPORT_LOCAL_PER_HOUR,
  REPORT_REF_PATTERN,
  REPORTS_PATH,
  REPORTS_URL,
  ReportAcceptedSchema,
  reportFailure,
  reportRef,
  ServerErrorSchema,
} from '../src/index.ts';

/** ADR 0009 §2's example: LinkedIn moved the feed to a new address, and ads still show. */
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
const { feedWord: _word, ...PAGE_FEED_BASE } = PAGE;
/** The same page on the address unAlgorithm knows. */
const PAGE_FEED = { ...PAGE_FEED_BASE, route: 'feed' } as const;
const HEALTH = { status: 'not-started', issues: ['feed-not-started', 'route-new'], degraded: [] };
const DETECTION = {
  counts: { items: 24, posts: 22, modules: 2, hidden: 15 },
  hiddenBy: { sponsored: 5, 'not-followed': 5, 'network-activity': 5 },
  detectors: { 'li.promoted.age-slot': 5, 'li.follow-button': 12 },
  landmarks: { main: 1, feedList: 1, postRoots: 22 },
  observations: { 'li.label.promoted.near': 2 },
  errors: { inspect: 0 },
  strategy: 'li.items.card-key',
};
const POST = {
  reason: 'suggested',
  source: 'rule',
  evidence: [{ detector: 'li.header.suggested', strength: 'strong' }],
  authorKind: 'person',
  relationship: 'not-followed',
  media: 'none',
  text: 'long',
} as const;
const CORRECTION = {
  feature: 'factcheck',
  promptVersion: 3,
  via: 'cloud',
  message: 'The claim was about 2024, not 2023.\nThe second source says the opposite.',
  contact: 'ann@example.org',
} as const;

const base = { v: 1, id: '0b6f7d3c-5a2e-4f1b-9c8d-7e6a5b4c3d2e', env: ENV } as const;
const EXAMPLES = {
  detection: {
    ...base,
    kind: 'detection',
    from: 'popup',
    choices: ['ads-showing'],
    page: PAGE,
    health: HEALTH,
    detection: DETECTION,
  },
  'wrong-call': {
    ...base,
    kind: 'wrong-call',
    from: 'why',
    choices: ['should-show'],
    page: PAGE_FEED,
    health: { status: 'ok', issues: [], degraded: [] },
    detection: DETECTION,
    post: POST,
  },
  correction: { ...base, kind: 'correction', from: 'sidepanel', choices: ['verdict-wrong'], correction: CORRECTION },
  other: { ...base, kind: 'other', from: 'settings', choices: ['sign-in-sync'] },
} as const satisfies Record<(typeof REPORT_KINDS)[number], unknown>;

/** A copy of `report` with `path` (dot-separated) set to `value`; `undefined` removes it. */
function withValue(report: unknown, path: string, value: unknown): unknown {
  const copy = structuredClone(report) as Record<string, unknown>;
  const keys = path.split('.');
  let at: Record<string, unknown> = copy;
  for (const key of keys.slice(0, -1)) at = at[key] as Record<string, unknown>;
  const last = keys.at(-1) as string;
  if (value === undefined) delete at[last];
  else at[last] = value;
  return copy;
}

const accepts = (report: unknown) => ProblemReportSchema.safeParse(report).success;

describe('report constants', () => {
  it('test_report_destination_and_limits', () => {
    expect(REPORTS_PATH).toBe('/v1/reports');
    expect(REPORTS_URL).toBe('https://cloud.unalgorithm.app/v1/reports');
    expect(REPORTS_URL.startsWith(CLOUD_ORIGIN)).toBe(true);
    expect(MAX_REPORT_BODY_BYTES).toBe(16_384);
    expect(MAX_CORRECTION_MESSAGE).toBe(1000);
    // ADR 0009, owner decisions: what PRIVACY.md states (its privacy-gate test pins the document to these).
    expect({ REPORT_KEEP_DAYS, REPORT_CONTACT_KEEP_DAYS, REPORT_CONTACT_AFTER_HANDLED_DAYS, REPORT_BACKUP_NIGHTS }).toEqual({
      REPORT_KEEP_DAYS: 90,
      REPORT_CONTACT_KEEP_DAYS: 60,
      REPORT_CONTACT_AFTER_HANDLED_DAYS: 30,
      REPORT_BACKUP_NIGHTS: 14,
    });
    expect([REPORT_LOCAL_PER_HOUR, REPORT_LOCAL_PER_DAY]).toEqual([3, 10]);
    expect([
      ADMIN_REPORTS_PATH,
      ADMIN_REPORTS_SUMMARY_PATH,
      ADMIN_REPORT_ROUTE,
      ADMIN_REPORTS_HANDLE_PATH,
      ADMIN_REPORTS_FLOOR_PATH,
      ADMIN_REPORTS_FORGET_CONTACT_PATH,
      ADMIN_REPORTS_DELETE_PATH,
    ]).toEqual([
      '/v1/admin/reports',
      '/v1/admin/reports/summary',
      '/v1/admin/reports/{id}',
      '/v1/admin/reports/handle',
      '/v1/admin/reports/floor',
      '/v1/admin/reports/forget-contact',
      '/v1/admin/reports/delete',
    ]);
  });
});

describe('ProblemReportSchema', () => {
  it('test_accepts_each_kind_unchanged', () => {
    for (const [kind, example] of Object.entries(EXAMPLES)) {
      const parsed = ProblemReportSchema.safeParse(example);
      expect(parsed.error?.issues, kind).toBeUndefined();
      // No transforms: what the person saw in "Show exactly what's sent" is what the server parses.
      expect(parsed.data, kind).toStrictEqual(JSON.parse(JSON.stringify(example)));
    }
  });

  it('test_accepts_reports_without_page_facts', () => {
    // Settings → About, or a tab whose content script didn't answer: the page wasn't checked.
    const unchecked = { ...PAGE_FEED, route: 'unknown', lang: 'unknown' };
    expect(accepts({ ...EXAMPLES.detection, from: 'settings', page: unchecked, health: undefined, detection: undefined })).toBe(
      true,
    );
    // ...and from the notice card or a silent tab, a detection report needs no choice.
    expect(accepts({ ...EXAMPLES.detection, from: 'notice', choices: [] })).toBe(true);
    // A private window (Mozilla 6.3): only the versions and the person's choices.
    const privately = { ...base, kind: 'detection', from: 'popup', choices: ['ads-showing'], private: true };
    expect(accepts(privately)).toBe(true);
    expect(accepts({ ...privately, kind: 'wrong-call', from: 'why', choices: ['should-show'] })).toBe(true);
    expect(accepts({ ...privately, page: PAGE })).toBe(false);
    expect(accepts({ ...privately, detection: DETECTION })).toBe(false);
    expect(accepts({ ...privately, private: false })).toBe(false);
    // Off LinkedIn and Facebook, the popup's "Report a problem" is about something else, with no page.
    expect(accepts({ ...EXAMPLES.other, from: 'popup', choices: ['ai'] })).toBe(true);
    // Firefox carries its add-on id so the server can tell a listed build.
    expect(accepts(withValue(EXAMPLES.other, 'env', { ...ENV, browser: 'firefox', client: 'feed@unalgorithmfeed.com' }))).toBe(
      true,
    );
  });

  it('test_refuses_page_addresses', () => {
    const refused: Array<[string, unknown]> = [
      ['page.route', '/feed/foryou/'],
      ['page.route', 'not-feed'],
      ['page.adapter', 'linkedin@2026.11.0/feed'],
      ['page.adapter', 'https://www.linkedin.com/feed/'],
      ['page.feedWord', '/in/jane-doe-123'],
      ['page.feedWord', 'in/jane-doe-123'],
      ['page.feedWord', 'foryou?trk=nav'],
      ['page.feedWord', 'foryou#x'],
      ['page.feedWord', 'https://www.linkedin.com/feed/foryou/'],
      ['page.feedWord', 'ForYou'],
      ['page.feedWord', 'a'],
      ['page.feedWord', `a${'b'.repeat(25)}`],
      ['page.lang', 'en-US'],
      ['page.lang', 'https:'],
      ['from', 'https://example.org'],
      ['detection.strategy', 'https://x'],
    ];
    for (const [path, value] of refused)
      expect(accepts(withValue(EXAMPLES.detection, path, value)), `${path}=${value}`).toBe(false);
    // Words that name posts, hashtags or people lists are never a feed word.
    for (const word of FEED_WORD_DENY) expect(accepts(withValue(EXAMPLES.detection, 'page.feedWord', word)), word).toBe(false);
    // A feed word only comes with a candidate route.
    expect(accepts(withValue(EXAMPLES.detection, 'page.route', 'feed'))).toBe(false);
    expect(accepts(withValue(EXAMPLES.detection, 'page.feedWord', `a${'b'.repeat(24)}`))).toBe(true);
    expect(accepts(withValue(EXAMPLES.detection, 'page.feedWord', 'new-name2'))).toBe(true);
  });

  it('test_refuses_codes_that_could_carry_words', () => {
    const refused: Array<[string, unknown]> = [
      ['choices', ['Ads showing']],
      ['choices', ['ads showing']],
      ['choices', ['ads-showing', 'ads-showing']],
      ['choices', ['a', 'b', 'c', 'd', 'e', 'f', 'g']],
      ['choices', [`a${'b'.repeat(40)}`]],
      ['from', 'Popup'],
      ['health.issues', ['Feed-Not-Started']],
      ['health.issues', ['feed not started']],
      ['health.degraded', ['network-activity ']],
      ['detection.hiddenBy', { 'Not followed': 1 }],
      ['detection.detectors', { 'li.jane doe': 1 }],
      ['detection.detectors', { 'li.Jane-Doe': 1 }],
      ['detection.detectors', { 'xx.follow-button': 1 }],
      ['detection.detectors', { 'li.a.b.c.d.e.f': 1 }],
      ['detection.detectors', { [`li.${'a'.repeat(62)}`]: 1 }],
      ['detection.counts', { 'jane-doe': 1 }],
      ['detection.counts', { posts: -1 }],
      ['detection.counts', { posts: 1.5 }],
      ['detection.counts', { posts: 1_000_001 }],
      ['detection.landmarks', { 'main area': 1 }],
      ['detection.errors', { 'TypeError: x': 1 }],
      ['detection.observations', { 'https://x': 1 }],
    ];
    for (const [path, value] of refused) {
      expect(accepts(withValue(EXAMPLES.detection, path, value)), `${path}=${JSON.stringify(value)}`).toBe(false);
    }
    // `__proto__` as a key (JSON.parse makes it an own key) is dropped by zod before any pattern runs: never kept.
    const proto = JSON.parse(JSON.stringify(EXAMPLES.detection).replace('"main":1', '"__proto__":1'));
    expect(Object.keys(proto.detection.landmarks)).toContain('__proto__');
    const parsed = ProblemReportSchema.parse(proto);
    expect(Object.getOwnPropertyNames(parsed.detection?.landmarks)).toEqual(['feedList', 'postRoots']);
    expect(Object.getPrototypeOf(parsed.detection?.landmarks)).toBe(Object.prototype);
    // The longest id is 64 characters.
    expect(accepts(withValue(EXAMPLES.detection, 'detection.detectors', { [`li.${'a'.repeat(61)}`]: 1 }))).toBe(true);
  });

  it('test_refuses_records_over_their_caps', () => {
    const many = (n: number, id: (i: number) => string) => Object.fromEntries(Array.from({ length: n }, (_, i) => [id(i), 1]));
    const detector = (i: number) => `li.d${i}`;
    expect(accepts(withValue(EXAMPLES.detection, 'detection.detectors', many(64, detector)))).toBe(true);
    expect(accepts(withValue(EXAMPLES.detection, 'detection.detectors', many(65, detector)))).toBe(false);
    expect(accepts(withValue(EXAMPLES.detection, 'detection.observations', many(33, detector)))).toBe(false);
    expect(
      accepts(
        withValue(
          EXAMPLES.detection,
          'detection.landmarks',
          many(17, (i) => `k${i}`),
        ),
      ),
    ).toBe(false);
    expect(
      accepts(
        withValue(
          EXAMPLES.detection,
          'detection.counts',
          many(17, (i) => `k${i}`),
        ),
      ),
    ).toBe(false);
    expect(
      accepts(
        withValue(
          EXAMPLES.detection,
          'detection.hiddenBy',
          many(17, (i) => `r${i}`),
        ),
      ),
    ).toBe(false);
    expect(
      accepts(
        withValue(
          EXAMPLES.detection,
          'detection.errors',
          many(9, (i) => `op${i}`),
        ),
      ),
    ).toBe(false);
    expect(
      accepts(
        withValue(
          EXAMPLES.detection,
          'health.issues',
          Array.from({ length: 17 }, (_, i) => `i${i}`),
        ),
      ),
    ).toBe(false);
    expect(
      accepts(
        withValue(
          EXAMPLES.detection,
          'health.degraded',
          Array.from({ length: 9 }, (_, i) => `d${i}`),
        ),
      ),
    ).toBe(false);
    const evidence = (n: number) => Array.from({ length: n }, (_, i) => ({ detector: `li.e${i}`, strength: 'weak' }));
    expect(accepts(withValue(EXAMPLES['wrong-call'], 'post.evidence', evidence(24)))).toBe(true);
    expect(accepts(withValue(EXAMPLES['wrong-call'], 'post.evidence', evidence(25)))).toBe(false);
  });

  it('test_kind_rules', () => {
    const wrongCall = EXAMPLES['wrong-call'];
    for (const part of ['page', 'post', 'health', 'detection']) {
      expect(accepts(withValue(wrongCall, part, undefined)), `wrong-call without ${part}`).toBe(false);
    }
    expect(accepts(withValue(wrongCall, 'choices', []))).toBe(false);
    expect(accepts(withValue(EXAMPLES.detection, 'page', undefined))).toBe(false);
    expect(accepts(withValue(EXAMPLES.detection, 'health', undefined))).toBe(false);
    expect(accepts(withValue(EXAMPLES.detection, 'detection', undefined))).toBe(false);
    expect(accepts({ ...EXAMPLES.detection, post: POST })).toBe(false);
    expect(accepts({ ...EXAMPLES.detection, correction: CORRECTION })).toBe(false);
    // A correction is about an AI result, never the page it was on.
    expect(accepts({ ...EXAMPLES.correction, page: PAGE_FEED })).toBe(false);
    expect(accepts({ ...EXAMPLES.correction, post: POST })).toBe(false);
    expect(accepts({ ...EXAMPLES.correction, detection: DETECTION })).toBe(false);
    expect(accepts(withValue(EXAMPLES.correction, 'correction', undefined))).toBe(false);
    expect(accepts(withValue(EXAMPLES.correction, 'choices', []))).toBe(false);
    expect(accepts(withValue(EXAMPLES.other, 'choices', []))).toBe(false);
    expect(accepts({ ...EXAMPLES.other, post: POST })).toBe(false);
    // The adapter belongs to the page's platform.
    expect(accepts(withValue(EXAMPLES.detection, 'page.adapter', 'facebook@2026.11.0'))).toBe(false);
    expect(accepts(withValue(EXAMPLES.detection, 'page.platform', 'facebook'))).toBe(false);
    // Only UnEcho Chamber names a source list.
    expect(accepts(withValue(EXAMPLES.correction, 'correction.list', 'cloud'))).toBe(false);
    const perspectives = { ...CORRECTION, feature: 'perspectives', list: 'own', via: 'own-key' };
    expect(accepts({ ...EXAMPLES.correction, choices: ['outlet-wrong'], correction: perspectives })).toBe(true);
  });

  it('test_correction_message_and_contact', () => {
    const message = (m: unknown) => accepts(withValue(EXAMPLES.correction, 'correction.message', m));
    expect(message('x')).toBe(true);
    expect(message('a'.repeat(MAX_CORRECTION_MESSAGE))).toBe(true);
    expect(message('a'.repeat(MAX_CORRECTION_MESSAGE + 1))).toBe(false);
    expect(message('')).toBe(false);
    expect(message(' \n ')).toBe(false);
    expect(message('Line one\nLine two')).toBe(true);
    for (const control of ['\r', '\t', '\u0000', '\u001b[31m', '\u0085'])
      expect(message(`a${control}b`), JSON.stringify(control)).toBe(false);
    // A cleaned message never holds a web address (cleanReportMessage keeps only its host).
    expect(message('See https://example.com/a?b=c')).toBe(false);
    expect(message('See HTTP://example.com')).toBe(false);
    expect(message('See [link: example.com]')).toBe(true);
    // Nor a link without a scheme, nor a profile or post address on its own.
    for (const link of [
      'Ask her at linkedin.com/in/janedoe',
      'facebook.com/profile.php?id=100001234567',
      'lnkd.in/abc123',
      'her page /in/jane-doe-123/',
      '/posts/jane-doe_activity-71234',
      'profile.php?id=100001234567',
      'urn:li:activity:7123456789012345678',
    ])
      expect(message(link), link).toBe(false);
    for (const words of ['Visit example.org for the source.', 'It was 50/50, and/or worse.', 'A 3.5/5 rating.', '[link]'])
      expect(message(words), words).toBe(true);
    expect(accepts(withValue(EXAMPLES.correction, 'correction.contact', undefined))).toBe(true);
    for (const contact of ['not-an-address', 'ann@', `${'a'.repeat(250)}@example.org`, 'ann@example.org\nBcc: x@y.z']) {
      expect(accepts(withValue(EXAMPLES.correction, 'correction.contact', contact)), contact).toBe(false);
    }
  });

  it('test_refuses_bad_versions_and_env', () => {
    const refused: Array<[string, unknown]> = [
      ['v', 2],
      ['id', 'not-a-uuid'],
      ['kind', 'bug'],
      ['env.extension', '0.4.1-beta+https://x'],
      ['env.extension', '1'],
      ['env.channel', 'github'],
      ['env.browser', 'safari'],
      ['env.browserMajor', -1],
      ['env.browserMajor', 141.5],
      ['env.client', 'aokmlebkpkeniofcnbeajmgabinicggm'],
      ['page.adapter', 'linkedin@26.11.0'],
      ['page.adapter', 'linkedin'],
      ['page.preset', 'strict'],
      ['page.ai', 'openai'],
    ];
    for (const [path, value] of refused)
      expect(accepts(withValue(EXAMPLES.detection, path, value)), `${path}=${value}`).toBe(false);
    for (const version of ['0.4.1', '1.0', '0.4.1.2'])
      expect(accepts(withValue(EXAMPLES.detection, 'env.extension', version))).toBe(true);
  });

  it('test_strips_unknown_keys', () => {
    const extra = {
      ...EXAMPLES.detection,
      url: 'https://www.linkedin.com/in/jane-doe-123/',
      page: { ...PAGE, title: 'Jane Doe | LinkedIn', path: '/feed/foryou/' },
      env: { ...ENV, os: 'Windows', userAgent: 'Mozilla/5.0' },
      detection: { ...DETECTION, html: '<div>Jane Doe</div>' },
    };
    const parsed = ProblemReportSchema.parse(extra);
    expect(parsed).toStrictEqual(ProblemReportSchema.parse(EXAMPLES.detection));
    expect(JSON.stringify(parsed)).not.toMatch(/jane|windows|mozilla|<div/i);
  });

  it('test_largest_report_fits_the_body_limit', () => {
    // Every record at its cap with the longest ids and keys: a valid report is never refused as too large.
    const id = (prefix: string, i: number) => `${prefix}${String(i).padStart(2, '0')}`.padEnd(64, 'x');
    const key = (i: number) => `k${String(i).padStart(2, '0')}`.padEnd(32, 'x');
    const code = (i: number) => `c${String(i).padStart(2, '0')}`.padEnd(40, 'x');
    const record = (n: number, name: (i: number) => string) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [name(i), 1_000_000]));
    const largest = {
      ...EXAMPLES['wrong-call'],
      choices: Array.from({ length: 6 }, (_, i) => code(i)),
      from: code(99),
      env: { ...ENV, extension: '12345.12345.12345.12345', browserMajor: 9999, client: `${'a'.repeat(60)}@unalgorithmfeed.com` },
      health: {
        status: 'unsupported-locale',
        issues: Array.from({ length: 16 }, (_, i) => code(i)),
        degraded: Array.from({ length: 8 }, (_, i) => key(i)),
      },
      detection: {
        counts: record(16, key),
        hiddenBy: record(16, code),
        detectors: record(64, (i) => id('li.d', i)),
        landmarks: record(16, key),
        observations: record(32, (i) => id('li.o', i)),
        errors: record(8, key),
        strategy: id('li.s', 0),
      },
      post: {
        ...POST,
        reason: code(98),
        module: code(97),
        evidence: Array.from({ length: 24 }, (_, i) => ({ detector: id('li.e', i), strength: 'medium' })),
      },
    };
    expect(ProblemReportSchema.safeParse(largest).error?.issues).toBeUndefined();
    expect(new TextEncoder().encode(JSON.stringify(largest)).length).toBeLessThan(MAX_REPORT_BODY_BYTES);
    // A correction's 1000 characters, at 3 bytes each, fit too.
    const words = { ...EXAMPLES.correction, correction: { ...CORRECTION, message: '語'.repeat(MAX_CORRECTION_MESSAGE) } };
    expect(accepts(words)).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(words)).length).toBeLessThan(MAX_REPORT_BODY_BYTES);
  });

  it('test_schema_converts_to_json_schema', () => {
    // The server documents the route with OpenAPI: nothing in the schema may be unrepresentable.
    expect(() => z.toJSONSchema(ProblemReportSchema)).not.toThrow();
    expect(() => z.toJSONSchema(ReportAcceptedSchema)).not.toThrow();
  });

  it('test_report_type_is_the_parsed_shape', () => {
    const report: ProblemReport = ProblemReportSchema.parse(EXAMPLES.correction);
    expect(report.correction?.feature).toBe('factcheck');
  });
});

describe('report helpers', () => {
  it('test_adapter_order_vectors', () => {
    expect(adapterOrder('linkedin@2026.10.2')).toBe(2026010002);
    expect(adapterOrder('facebook@2026.11.0')).toBe(2026011000);
    expect(adapterOrder('linkedin@2027.1.15')).toBe(2027001015);
    expect(adapterOrder('facebook@2026.10.999')).toBe(2026010999);
    // Orders compare like the versions: 2026.9.9 is older than 2026.10.0, and a new year beats any month.
    const versions = ['linkedin@2026.9.9', 'linkedin@2026.10.0', 'linkedin@2026.10.2', 'linkedin@2026.12.1', 'linkedin@2027.1.0'];
    const orders = versions.map(adapterOrder) as number[];
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    for (const bad of ['', 'linkedin', 'linkedin@2026.10', 'linkedin@2026.100.1', 'twitter@2026.10.2', 'linkedin@2026.10.2x']) {
      expect(adapterOrder(bad), bad).toBeNull();
    }
    expect(adapterPlatform('facebook@2026.10.3')).toBe('facebook');
    expect(adapterPlatform('linkedin@2026.10.2')).toBe('linkedin');
    expect(adapterPlatform('linkedin')).toBeNull();
  });

  it('test_latest_adapter_order_is_the_end_of_this_month', () => {
    expect(latestAdapterOrder(Date.UTC(2026, 9, 19, 15))).toBe(2026010999);
    expect(latestAdapterOrder(new Date(Date.UTC(2026, 9, 31, 23, 59)))).toBe(2026010999);
    expect(latestAdapterOrder(Date.UTC(2026, 10, 1, 0, 30))).toBe(2026011999);
    expect(latestAdapterOrder(Date.UTC(2026, 11, 31))).toBe(2026012999);
    // A version dated this month is never after it; one dated next month is until that month begins.
    expect(adapterOrder('linkedin@2026.10.2') as number).toBeLessThanOrEqual(latestAdapterOrder(Date.UTC(2026, 9, 1)));
    expect(adapterOrder('linkedin@2026.11.0') as number).toBeGreaterThan(latestAdapterOrder(Date.UTC(2026, 9, 31, 23)));
  });

  it('test_quarter_of_vectors', () => {
    expect(quarterOf(new Date(Date.UTC(2026, 9, 18, 12)))).toBe('2026-Q4');
    expect(quarterOf(Date.UTC(2027, 0, 1, 0, 0, 0))).toBe('2027-Q1');
    expect(quarterOf(Date.UTC(2027, 2, 31, 23, 59, 59, 999))).toBe('2027-Q1');
    expect(quarterOf(Date.UTC(2027, 3, 1))).toBe('2027-Q2');
    expect(quarterOf(Date.UTC(2027, 5, 30, 23))).toBe('2027-Q2');
    expect(quarterOf(Date.UTC(2027, 6, 1))).toBe('2027-Q3');
    expect(quarterOf(Date.UTC(2027, 8, 30, 23))).toBe('2027-Q3');
    expect(quarterOf(Date.UTC(2026, 11, 31, 23, 59))).toBe('2026-Q4');
  });

  it('test_report_reference', () => {
    expect(reportRef(new Uint8Array(5))).toBe('0000-0000');
    expect(reportRef(new Uint8Array([255, 255, 255, 255, 255]))).toBe('ZZZZ-ZZZZ');
    // 40 bits, most significant first: 0x0000000001 is the last digit 1; 0x8000000000 the first digit's top bit.
    expect(reportRef(new Uint8Array([0, 0, 0, 0, 1]))).toBe('0000-0001');
    expect(reportRef(new Uint8Array([128, 0, 0, 0, 0]))).toBe('G000-0000');
    for (let i = 0; i < 200; i++) {
      const ref = reportRef(crypto.getRandomValues(new Uint8Array(5)));
      expect(ref).toMatch(REPORT_REF_PATTERN);
      expect(parseReportRef(ref)).toBe(ref);
    }
    expect(() => reportRef(new Uint8Array(4))).toThrow(TypeError);
    // As a person might type it in an email.
    expect(parseReportRef('7kq3 m2pa')).toBe('7KQ3-M2PA');
    expect(parseReportRef(' 7KQ3M2PA ')).toBe('7KQ3-M2PA');
    expect(parseReportRef('7KQ3-M2PO')).toBe('7KQ3-M2P0');
    expect(parseReportRef('7KQ3-M2PI')).toBe('7KQ3-M2P1');
    expect(parseReportRef('7KQ3-M2PL')).toBe('7KQ3-M2P1');
    for (const bad of ['', '7KQ3-M2P', '7KQ3-M2PAA', '7KQ3-M2PU', '7KQ3_M2PA', 'https://x'])
      expect(parseReportRef(bad), bad).toBeNull();
  });

  it('test_report_accepted_schema', () => {
    expect(ReportAcceptedSchema.parse({ ok: true, ref: '7KQ3-M2PA' })).toEqual({ ok: true, ref: '7KQ3-M2PA' });
    // A newer server may add fields; they are stripped, never refused.
    expect(ReportAcceptedSchema.parse({ ok: true, ref: '7KQ3-M2PA', receivedAt: '2026-10-18T12:00:00Z' })).toEqual({
      ok: true,
      ref: '7KQ3-M2PA',
    });
    for (const bad of [
      { ok: false, ref: '7KQ3-M2PA' },
      { ok: true, ref: '7kq3-m2pa' },
      { ok: true, ref: '7KQ3-M2PU' },
      { ok: true, ref: '7KQ3M2PA' },
      { ok: true },
    ]) {
      expect(ReportAcceptedSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('test_report_errors_and_failures', () => {
    for (const [name, error] of Object.entries(REPORT_ERRORS))
      expect(ServerErrorSchema.safeParse(error).success, name).toBe(true);
    // The page tells an unlisted build (email instead) from any other refusal by the body's code.
    expect(new Set(Object.values(REPORT_ERRORS).filter((e) => e.code === REPORT_ERRORS.unlisted.code)).size).toBe(1);
    expect(reportFailure(429, REPORT_ERRORS.rateLimit)).toBe('rate-limit');
    expect(reportFailure(503, REPORT_ERRORS.unavailable)).toBe('unavailable');
    expect(reportFailure(503, null)).toBe('unavailable');
    expect(reportFailure(403, REPORT_ERRORS.unlisted)).toBe('unlisted');
    expect(reportFailure(403, REPORT_ERRORS.origin)).toBe('refused');
    for (const status of [400, 404, 413]) expect(reportFailure(status, REPORT_ERRORS.invalid), String(status)).toBe('refused');
    // Any 5xx passes (a database failure, the proxy during a deploy): Try again is offered, with or without a body.
    for (const [status, body] of [
      [500, { code: 'internal' }],
      [502, null],
      [504, null],
      [500, 'not json'],
    ] as const)
      expect(reportFailure(status, body), String(status)).toBe('unavailable');
    expect(reportFailure(403, 'permission')).toBe('refused');
    expect(reportFailure(403, undefined)).toBe('refused');
  });
});
