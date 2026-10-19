/**
 * Report drafts from a feed tab (ADR 0009 §2, §4): built from every LinkedIn and Facebook fixture (the anonymized
 * captures and the fictional builders), each is a valid report once the background adds its versions and the person
 * answers, and none carries anything from the page: no name, text, link, URN, component key or id
 * (`tests/support/leak-scan.ts`). A private window's draft holds nothing about the page, and the route class and its
 * word come from the address alone.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDevice, defaultSettings, EMPTY_LEARNED } from '@unalgorithm/core';
import { facebookAdapter, linkedinAdapter, type PlatformAdapter } from '@unalgorithm/platforms';
import { ProblemReportSchema, type ReportEnv, uuid } from '@unalgorithm/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fbLive from '../../../packages/platforms/fixtures/facebook/live2026.ts';
import * as fbSynthetic from '../../../packages/platforms/fixtures/facebook/synthetic.ts';
import * as liLegacy from '../../../packages/platforms/fixtures/linkedin/legacy.ts';
import * as li2026 from '../../../packages/platforms/fixtures/linkedin/y2026.ts';
import { checkDraft } from '../src/background/report.ts';
import { type Bridge, type Entry, FeedController, type Runtime } from '../src/content/feed-controller.ts';
import { buildReportDraft, type DraftPage, detectionFacts, healthFacts, pageFacts, primaryLang } from '../src/content/report.ts';
import { startWatchdog } from '../src/content/watchdog.ts';
import type { ReportDraftInput } from '../src/lib/messages.ts';
import { choicesFor } from '../src/lib/report-links.ts';
import type { ReportDraft } from '../src/lib/storage.ts';
import { forbiddenTokens, leaks } from './support/leak-scan.ts';

const FIXTURES = join(import.meta.dirname, '../../../packages/platforms/fixtures');
const ENV: ReportEnv = { extension: '0.4.0', channel: 'development', browser: 'chrome', browserMajor: 141 };

// jsdom has no IntersectionObserver: report every item as near and on screen.
class FakeIO {
  constructor(private cb: IntersectionObserverCallback) {}
  root = null;
  observe(el: Element) {
    queueMicrotask(() => this.cb([{ target: el, isIntersecting: true } as unknown as IntersectionObserverEntry], this as never));
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

function runtime(): Runtime {
  return {
    settings: defaultSettings(),
    device: defaultDevice('dev1'),
    learned: EMPTY_LEARNED,
    votes: {},
    serverOffer: null,
    officialList: { list: null, checkedAt: 0 },
  };
}

const bridge = (): Bridge => ({
  classify: vi.fn(async () => ({ results: [] })),
  pushTabState: vi.fn(),
  vote: vi.fn(async () => undefined),
  settingsAction: vi.fn(async () => null),
  coachMarkShown: vi.fn(),
  openSettings: vi.fn(),
  report: vi.fn(),
  factcheck: vi.fn(),
  openFactcheck: vi.fn(async () => true),
  perspectives: vi.fn(),
});

const mountUi = (e: Entry) => {
  const host = document.createElement('unalgo-post');
  const container = document.createElement('div');
  host.attachShadow({ mode: 'open' }).append(container);
  e.el.appendChild(host);
  return { host, container };
};

/** Every string a fixture module exports that is markup (a card, an item, a panel). */
const markup = (mod: Record<string, unknown>) =>
  Object.values(mod).filter((v): v is string => typeof v === 'string' && v.trimStart().startsWith('<'));

interface Fixture {
  name: string;
  adapter: PlatformAdapter;
  url: string;
  html: string;
}

const FEEDS: Fixture[] = [
  ...['2026-10-foryou-1.html', '2026-10-foryou-2.html'].map((file) => ({
    name: `linkedin ${file}`,
    adapter: linkedinAdapter as PlatformAdapter,
    url: 'https://www.linkedin.com/feed/foryou/',
    html: readFileSync(join(FIXTURES, 'linkedin', file), 'utf8'),
  })),
  {
    name: 'linkedin y2026 builders',
    adapter: linkedinAdapter as PlatformAdapter,
    url: 'https://www.linkedin.com/feed/',
    html: li2026.feed2026(...markup(li2026).filter((s) => s.includes('update-card-focus'))),
  },
  {
    name: 'linkedin legacy builders',
    adapter: linkedinAdapter as PlatformAdapter,
    url: 'https://www.linkedin.com/feed/',
    html: liLegacy.feedHtml(...markup(liLegacy)),
  },
  ...Array.from({ length: 9 }, (_, i) => ({
    name: `facebook 2026-10-home-${i + 1}.html`,
    adapter: facebookAdapter as PlatformAdapter,
    url: 'https://www.facebook.com/',
    html: readFileSync(join(FIXTURES, 'facebook', `2026-10-home-${i + 1}.html`), 'utf8'),
  })),
  {
    name: 'facebook synthetic builders',
    adapter: facebookAdapter as PlatformAdapter,
    url: 'https://www.facebook.com/',
    html: fbSynthetic.fbFeed(...markup(fbSynthetic).filter((s) => !s.includes('2026'))),
  },
  {
    name: 'facebook 2026 builders',
    adapter: facebookAdapter as PlatformAdapter,
    url: 'https://www.facebook.com/',
    html: fbSynthetic.fbFeed2026(
      fbSynthetic.FRIEND_POST_2026,
      fbSynthetic.AD_2026,
      fbSynthetic.FOLLOW_PAGE_2026,
      fbSynthetic.PHOTO_POST_2026,
    ),
  },
  {
    name: 'facebook live builders',
    adapter: facebookAdapter as PlatformAdapter,
    url: 'https://www.facebook.com/',
    html: fbLive.feed(...markup(fbLive).filter((s) => s.includes('aria-posinset') || s.includes('<h3') || s.includes('<span>'))),
  },
];

function pageOf(f: Fixture, over: Partial<DraftPage> = {}): DraftPage {
  return {
    adapter: f.adapter,
    url: new URL(f.url),
    lang: 'en',
    settings: defaultSettings(),
    device: defaultDevice('dev1'),
    incognito: false,
    ...over,
  };
}

/** The draft as the background keeps it and the person sends it: versions added, the first answer chosen. */
function completed(draft: ReportDraftInput) {
  const stored = checkDraft({ ...draft, v: 1, id: uuid(), env: ENV } as ReportDraft);
  expect(stored, JSON.stringify(draft)).not.toBeNull();
  const report = { ...(stored as ReportDraft), choices: choicesFor(draft).slice(0, 1) };
  return ProblemReportSchema.parse(report);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date(2026, 9, 19, 12));
  vi.stubGlobal('IntersectionObserver', FakeIO);
  document.documentElement.lang = 'en';
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('drafts from every fixture', () => {
  for (const f of FEEDS) {
    // The captures are large pages for jsdom: reading them and 25 s of health checks take a few seconds.
    it(`test_drafts_valid_and_content_free (${f.name})`, { timeout: 60_000 }, async () => {
      document.body.innerHTML = f.html;
      const controller = new FeedController(f.adapter, bridge(), mountUi);
      controller.start(runtime());
      await vi.advanceTimersByTimeAsync(25_000);
      const tokens = forbiddenTokens(f.html);
      expect(tokens.length, 'the fixture has text and links to scan for').toBeGreaterThan(5);

      const detection = buildReportDraft(controller, { kind: 'detection', from: 'popup' }, pageOf(f));
      const reports = [completed(detection)];
      expect(reports[0]?.detection?.counts.items, 'the controller read the fixture').toBeGreaterThan(0);

      const hidden = controller.buildState().hiddenItems ?? [];
      for (const h of hidden) {
        const draft = buildReportDraft(controller, { kind: 'wrong-call', from: 'why', key: h.id }, pageOf(f));
        expect(draft.kind, h.id).toBe('wrong-call');
        const report = completed(draft);
        reports.push(report);
        // The lookup key never travels.
        expect(JSON.stringify(report)).not.toContain(h.id);
      }
      for (const report of reports) expect(leaks(JSON.stringify(report), tokens), f.name).toEqual([]);
      controller.stop();
    });
  }

  it('test_wrong_call_on_a_vanished_post_becomes_a_detection_report', () => {
    const f = FEEDS[2] as Fixture;
    document.body.innerHTML = f.html;
    const controller = new FeedController(f.adapter, bridge(), mountUi);
    controller.start(runtime());
    const draft = buildReportDraft(controller, { kind: 'wrong-call', from: 'why', key: 'li:ck:gone' }, pageOf(f));
    expect(draft.kind).toBe('detection');
    expect(draft).not.toHaveProperty('post');
    expect(draft.from).toBe('why');
    controller.stop();
  });

  it('test_watchdog_and_idle_pages_make_valid_drafts', async () => {
    const f = FEEDS[2] as Fixture;
    document.body.innerHTML = f.html;
    const page = pageOf(f, { url: new URL('https://www.linkedin.com/feed/newname/') });
    const watchdog = startWatchdog({ adapter: linkedinAdapter, onFeedLike: () => undefined });
    await vi.advanceTimersByTimeAsync(13_000);
    const watched = completed(buildReportDraft(watchdog, { kind: 'detection', from: 'notice', notice: 'not-running' }, page));
    expect(watched.page).toMatchObject({ route: 'feed-candidate', feedWord: 'newname' });
    expect(watched.health).toEqual({ status: 'not-started', issues: ['feed-not-started'], degraded: [] });
    expect(Object.keys(watched.detection?.counts ?? {}).sort()).toEqual(['items', 'modules', 'pending', 'posts']);
    watchdog.stop();

    // Not the feed and not watched: nothing checked the page, nothing counted.
    const idle = completed(
      buildReportDraft(
        null,
        { kind: 'detection', from: 'popup' },
        pageOf(f, { url: new URL('https://www.linkedin.com/in/morgan-ellis/') }),
      ),
    );
    expect(idle.page?.route).toBe('other');
    expect(idle.health).toEqual({ status: 'not-started', issues: [], degraded: [] });
    expect(idle.detection).toEqual({ counts: {} });
    expect(JSON.stringify(idle)).not.toContain('morgan');
  });
});

describe('private windows', () => {
  it('test_incognito_drafts_carry_no_page_data', async () => {
    const f = FEEDS[2] as Fixture;
    document.body.innerHTML = f.html;
    const controller = new FeedController(f.adapter, bridge(), mountUi);
    controller.start(runtime());
    await vi.advanceTimersByTimeAsync(1000);
    const key = controller.buildState().hiddenItems?.[0]?.id;
    expect(key).toBeDefined();
    for (const opts of [
      { kind: 'detection' as const, from: 'popup' as const },
      { kind: 'wrong-call' as const, from: 'why' as const, key },
    ]) {
      const draft = buildReportDraft(controller, opts, pageOf(f, { incognito: true }));
      expect(draft).toEqual({ kind: opts.kind, from: opts.from, private: true });
      const report = completed(draft);
      for (const part of ['page', 'health', 'detection', 'post']) expect(report).not.toHaveProperty(part);
    }
    controller.stop();
  });
});

describe('route classes and words', () => {
  const li = { ...FEEDS[2], adapter: linkedinAdapter } as Fixture;
  const fb = { ...FEEDS[4], adapter: facebookAdapter } as Fixture;
  const routeOf = (f: Fixture, url: string) => {
    const { route, feedWord } = pageFacts(pageOf(f, { url: new URL(url) }));
    return feedWord ? `${route}:${feedWord}` : route;
  };

  it('test_linkedin_routes', () => {
    expect(routeOf(li, 'https://www.linkedin.com/feed/')).toBe('feed');
    expect(routeOf(li, 'https://www.linkedin.com/feed/foryou/')).toBe('feed');
    expect(routeOf(li, 'https://www.linkedin.com/feed/newname/?trk=x')).toBe('feed-candidate:newname');
    expect(routeOf(li, 'https://www.linkedin.com/')).toBe('feed-candidate');
    expect(routeOf(li, 'https://www.linkedin.com/home/')).toBe('feed-candidate:home');
    // A post, a hashtag, people you follow, a profile: never the feed, never a word.
    for (const url of [
      'https://www.linkedin.com/feed/update/urn:li:activity:7123/',
      'https://www.linkedin.com/feed/hashtag/ai/',
      'https://www.linkedin.com/feed/following/',
      'https://www.linkedin.com/in/morgan-ellis/',
      'https://www.linkedin.com/company/example-robotics/',
    ])
      expect(routeOf(li, url), url).toBe('other');
  });

  it('test_facebook_routes', () => {
    expect(routeOf(fb, 'https://www.facebook.com/')).toBe('feed');
    expect(routeOf(fb, 'https://www.facebook.com/home.php?sk=h_chr')).toBe('feed');
    expect(routeOf(fb, 'https://www.facebook.com/home')).toBe('feed-candidate:home');
    expect(routeOf(fb, 'https://www.facebook.com/feeds/latest')).toBe('feed-candidate:latest');
    for (const url of [
      'https://www.facebook.com/groups/100000/',
      'https://www.facebook.com/riley.chen',
      'https://www.facebook.com/watch/',
    ])
      expect(routeOf(fb, url), url).toBe('other');
  });

  it('test_language_is_the_primary_subtag', () => {
    expect(primaryLang('en-GB')).toBe('en');
    expect(primaryLang('FR')).toBe('fr');
    expect(primaryLang('zh_Hant_TW')).toBe('zh');
    expect(primaryLang('')).toBe('unknown');
    expect(primaryLang('x-pig-latin')).toBe('unknown');
    expect(primaryLang('english')).toBe('unknown');
  });

  it('test_settings_facts', () => {
    const settings = defaultSettings();
    settings.platforms.linkedin.filters.reels = !settings.platforms.linkedin.filters.reels;
    const device = {
      ...defaultDevice('dev1'),
      aiSource: { kind: 'anthropic' as const, model: null },
      pausedUntil: { linkedin: 'manual' as const, facebook: null },
    };
    expect(pageFacts(pageOf(li, { settings, device, lang: 'en-US' }))).toEqual({
      platform: 'linkedin',
      adapter: linkedinAdapter.version,
      route: 'feed',
      lang: 'en',
      preset: 'custom',
      ai: 'own-key',
      paused: true,
    });
  });
});

describe('the leak scan', () => {
  it('test_leak_scan_finds_copied_content', () => {
    const tokens = forbiddenTokens(FEEDS[2]?.html ?? '');
    // Names, post text, profile slugs and component keys from the fictional builders.
    expect(tokens).toEqual(expect.arrayContaining(['Morgan Ellis', 'morgan-ellis', 'update-card-focusEEEkeyFirstDegree5']));
    expect(leaks(JSON.stringify({ author: 'Morgan Ellis' }), tokens)).toContain('Morgan Ellis');
    expect(leaks(JSON.stringify({ link: '/in/morgan-ellis/' }), tokens)).toContain('morgan-ellis');
    const legacy = forbiddenTokens(FEEDS[3]?.html ?? '');
    expect(legacy.some((t) => t.startsWith('urn:li:activity:'))).toBe(true);
    // Codes and counts alone are not leaks.
    expect(leaks(JSON.stringify({ route: 'feed', reason: 'sponsored', detector: 'li.follow-button', n: 12 }), tokens)).toEqual(
      [],
    );
  });
});

describe('fitting the wire', () => {
  it('test_codes_that_dont_fit_are_left_out', () => {
    expect(
      healthFacts({
        status: 'broken',
        issues: ['over-filtering', 'Not A Code', 'over-filtering', ...Array.from({ length: 20 }, (_, i) => `issue-${i}`)],
        degraded: ['sponsored', 'bad key!'],
      } as never),
    ).toEqual({
      status: 'broken',
      issues: ['over-filtering', ...Array.from({ length: 15 }, (_, i) => `issue-${i}`)],
      degraded: ['sponsored'],
    });
    expect(
      detectionFacts({
        counts: { items: 3.7, posts: -1, 'not a key': 2, hidden: Number.NaN },
        landmarks: {},
        detectors: { 'li.follow-button': 2, 'https://example.com': 1 },
        observations: {},
        strategy: 'Morgan Ellis',
      }),
    ).toEqual({ counts: { items: 3 }, detectors: { 'li.follow-button': 2 } });
  });
});
