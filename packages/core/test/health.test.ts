/**
 * Breakage checks (ADR 0009 §3): each check just below and just above its threshold, visible time, and the live
 * numbers the thresholds were chosen from (LinkedIn 25% ads with Balanced hiding 75%; Facebook about 18% ads).
 */
import { ISSUE_PRIORITY, type PlatformId, REPORT_ISSUES } from '@unalgorithm/protocol';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  EMPTY_WATCH,
  evaluateHealth,
  HELD_ISSUES,
  type HealthHold,
  type HealthInput,
  type HealthIssue,
  type HealthReport,
  type HealthSample,
  type HealthWatch,
  heldIssues,
  holdAfter,
  type ItemFacts,
  multiPostCount,
  NO_SIGNALS,
  noticeFor,
  noticeKinds,
  type PostData,
  postFacts,
  START_GRACE_MS,
  steadyNotices,
  tallyIds,
  VisibleClock,
  watchFrom,
} from '../src/index.ts';

const sample = (over: Partial<HealthSample> = {}): HealthSample => ({
  kind: 'post',
  authorFound: true,
  textFound: true,
  sponsored: false,
  hidden: false,
  ageMs: 1000,
  near: true,
  ...over,
});

/** `n` samples; `over(i)` changes the i-th. */
const many = (n: number, over: (i: number) => Partial<HealthSample> = () => ({})) =>
  Array.from({ length: n }, (_, i) => sample(over(i)));

const watch = (over: Partial<HealthWatch>): HealthWatch => ({ ...EMPTY_WATCH, ...over });

/** Every report evaluated in this file, to check the issues against the registry at the end. */
const seen: HealthReport[] = [];

function run(over: Partial<HealthInput> = {}): HealthReport {
  const r = evaluateHealth({
    platform: 'linkedin',
    feedFound: true,
    visibleMs: 20_000,
    samples: many(12),
    localeSupported: true,
    preset: 'balanced',
    signedIn: true,
    ...over,
  });
  seen.push(r);
  return r;
}

const issues = (over: Partial<HealthInput> = {}) => run(over).issues;

function post(over: Partial<PostData> = {}, quality: Partial<PostData['quality']> = {}): PostData {
  return {
    id: 'li:urn:li:activity:1',
    platform: 'linkedin',
    author: { name: 'Jane Doe', kind: 'person', relationship: 'followed' },
    signals: { ...NO_SIGNALS },
    evidence: [],
    text: 'We moved our forms online.',
    textComplete: true,
    media: 'none',
    quality: { authorFound: true, textFound: true, ...quality },
    ...over,
  };
}

describe('health issues are the registry', () => {
  it('test_health_issue_type_is_the_registry', () => {
    expectTypeOf<HealthIssue>().toEqualTypeOf<(typeof REPORT_ISSUES)[number]>();
  });
});

describe("health: today's checks", () => {
  it('stops hiding when nearly everything would be hidden', () => {
    expect(run({ samples: many(20, () => ({ hidden: true })) }).status).toBe('broken');
  });

  it('keeps hiding on a feed that is mostly noise, and never counts ads', () => {
    // A LinkedIn feed where Balanced hides 17 of 20 posts (85%) is normal, not broken.
    expect(issues({ samples: many(20, (i) => ({ hidden: i < 17 })) })).not.toContain('over-filtering');
    // 18 of 20 is exactly Balanced's 90%, still fine; 19 of 20 (95%) is past it.
    expect(issues({ samples: many(20, (i) => ({ hidden: i < 18 })) })).not.toContain('over-filtering');
    const nearlyAll = run({ samples: many(20, (i) => ({ hidden: i < 19 })) });
    expect(nearlyAll.status).toBe('broken');
    expect(nearlyAll.notice).toBe('paused');
    // Hidden ads don't count toward it: 8 ads and 11 of 12 other posts hidden is 55%, not 95%.
    const withAds = many(20, (i) => (i < 8 ? { hidden: true, sponsored: true } : { hidden: i < 19 }));
    expect(issues({ samples: withAds })).not.toContain('over-filtering');
    // Light still stops past half.
    expect(issues({ samples: many(20, (i) => ({ hidden: i < 11 })), preset: 'light' })).toContain('over-filtering');
    // It needs 20 judged items: 19 all hidden is too few to tell.
    expect(issues({ samples: many(19, () => ({ hidden: true })) })).not.toContain('over-filtering');
  });

  it('switches off relationship rules when authors cannot be found', () => {
    expect(issues({ samples: many(10, (i) => ({ authorFound: i >= 5 })) })).not.toContain('author-detection');
    const r = run({ samples: many(10, (i) => ({ authorFound: i >= 6 })) });
    expect(r.issues).toEqual(['author-detection']);
    expect(r.status).toBe('degraded');
    expect(r.degraded).toEqual(['relationship']);
    expect(r.notice).toBeUndefined();
    // Nine posts are too few to judge.
    expect(issues({ samples: many(9, () => ({ authorFound: false })) })).toEqual([]);
  });

  it('test_text_detection_threshold', () => {
    expect(issues({ samples: many(10, (i) => ({ textFound: i >= 6 })) })).toEqual([]);
    const r = run({ samples: many(10, (i) => ({ textFound: i >= 7 })) });
    expect(r.issues).toEqual(['text-detection']);
    expect(r.status).toBe('broken');
    expect(r.notice).toBe('paused');
  });

  it('test_module_overmatch_threshold', () => {
    expect(issues({ samples: many(10, (i) => (i < 5 ? { kind: 'module' } : {})) })).toEqual([]);
    const r = run({ samples: many(10, (i) => (i < 6 ? { kind: 'module' } : {})) });
    expect(r.issues).toEqual(['module-overmatch']);
    expect(r.notice).toBe('paused');
  });

  it('is patient before the feed appears, in visible time', () => {
    expect(run({ feedFound: false, visibleMs: 3000, samples: [] }).status).toBe('ok');
    expect(issues({ feedFound: false, visibleMs: START_GRACE_MS - 1, samples: [] })).toEqual([]);
    const r = run({ feedFound: false, visibleMs: START_GRACE_MS, samples: [] });
    expect(r.issues).toEqual(['no-feed']);
    expect(r.status).toBe('broken');
    // Absence never raises the in-feed card.
    expect(r.notice).toBeUndefined();
  });

  it('test_no_feed_needs_a_signed_in_page', () => {
    // A login page, a checkpoint or a consent wall has no feed and no signed-in shell: nothing is wrong.
    const r = run({ feedFound: false, visibleMs: 60_000, samples: [], signedIn: false });
    expect(r).toStrictEqual({ status: 'ok', issues: [], degraded: [] });
  });

  it('test_no_items_threshold', () => {
    expect(issues({ samples: [], visibleMs: START_GRACE_MS - 1 })).toEqual([]);
    const r = run({ samples: [], visibleMs: START_GRACE_MS });
    expect(r.issues).toEqual(['no-items']);
    expect(r.status).toBe('broken');
    expect(r.notice).toBeUndefined();
  });

  it('test_unsupported_locale', () => {
    expect(run({ localeSupported: false, errors: 5 })).toStrictEqual({
      status: 'unsupported-locale',
      issues: ['unsupported-locale'],
      degraded: [],
    });
  });
});

describe('health: ADR 0009 checks', () => {
  it('test_adapter_error_breaks_after_three', () => {
    expect(issues({ errors: 2 })).toEqual([]);
    const r = run({ errors: 3 });
    expect(r.issues).toEqual(['adapter-error']);
    expect(r.status).toBe('broken');
    expect(r.notice).toBe('paused');
    // A feedScope that throws looks like no feed: the exceptions still say why, before the 10 s grace.
    const noFeed = run({ errors: 3, feedFound: false, visibleMs: 1000, samples: [] });
    expect(noFeed.issues).toEqual(['adapter-error']);
    expect(noFeed.notice).toBe('paused');
  });

  it('test_stuck_skeletons_counts_only_items_near_the_viewport_long_enough', () => {
    const stuck = (n: number, over: Partial<HealthSample> = {}) =>
      many(10, (i) => (i < n ? { kind: 'pending', near: true, nearMs: 15_000, ...over } : {}));
    expect(issues({ samples: stuck(3) })).toEqual([]); // 30% is not more than 30%
    const r = run({ samples: stuck(4) });
    expect(r.issues).toEqual(['stuck-skeletons']);
    // Report only: it no longer switches anything off.
    expect(r.status).toBe('ok');
    expect(r.notice).toBeUndefined();
    expect(issues({ samples: stuck(4, { nearMs: 14_999 }) })).toEqual([]);
    // Far from the viewport, however old: the platform hasn't filled it in yet, by design.
    expect(issues({ samples: stuck(4, { near: false, nearMs: 0, ageMs: 120_000 }) })).toEqual([]);
    // Without nearMs, the age stands in.
    expect(issues({ samples: stuck(4, { nearMs: undefined, ageMs: 15_000 }) })).toEqual(['stuck-skeletons']);
  });

  it('test_emptied_slots_count_by_their_last_decision', () => {
    const emptied = (n: number, over: Partial<HealthSample> = {}) => many(n, () => ({ offscreen: true, near: false, ...over }));
    // Facebook after Show all made the page tall (2026-10-20, live): the shown posts far above were emptied, the 19
    // hidden ones around the viewport were not. Counted by their last decision that is 19 of 29, not 19 of 19.
    expect(issues({ samples: [...many(19, () => ({ hidden: true })), ...emptied(10)] })).toEqual([]);
    // ...and the other way: everything shown makes the page taller still, and Facebook empties most of the hidden
    // posts too. Five left on the page are too few to judge alone; with the 20 emptied ones it stays over the limit.
    expect(issues({ samples: [...many(5, () => ({ hidden: true })), ...emptied(20, { hidden: true })] })).toEqual([
      'over-filtering',
    ]);
    // An emptied panel is still a panel, and an emptied post keeps what was read of it.
    expect(issues({ samples: [...many(4), ...emptied(6, { kind: 'module' })] })).toEqual(['module-overmatch']);
    expect(issues({ samples: [...many(3), ...emptied(7, { textFound: false })] })).toEqual(['text-detection']);
    expect(issues({ samples: [...many(4), ...emptied(6, { authorFound: false })] })).toEqual(['author-detection']);
  });

  it('test_emptied_slots_never_read_stay_out', () => {
    // Emptied before it was read as a post or a panel: no decision to count, and never a stuck skeleton however long
    // it sits near the viewport.
    const neverRead = (n: number) => many(n, () => ({ kind: 'pending', offscreen: true, near: true, nearMs: 60_000 }));
    expect(issues({ samples: [...many(1, () => ({ kind: 'pending', nearMs: 20_000 })), ...many(9), ...neverRead(5)] })).toEqual(
      [],
    );
    // 3 stuck of the 9 items counted is a third: with the 5 never-read slots counted it would be 3 of 14.
    const stuck = [...many(3, () => ({ kind: 'pending', nearMs: 20_000 })), ...many(6), ...neverRead(5)];
    expect(issues({ samples: stuck })).toEqual(['stuck-skeletons']);
    // 19 hidden posts and 10 never-read slots: 19 judged items, too few for over-filtering.
    expect(issues({ samples: [...many(19, () => ({ hidden: true })), ...neverRead(10)] })).toEqual([]);
    // Emptied slots alone still mean the feed has items.
    expect(issues({ samples: neverRead(5) })).toEqual([]);
  });

  it('test_sponsored_overmatch_needs_twenty_posts', () => {
    // 10 posts at 50% (the old rule fired from 40% over 10): none.
    expect(issues({ samples: many(10, (i) => ({ sponsored: i < 5 })) })).toEqual([]);
    expect(issues({ samples: many(19, () => ({ sponsored: true })) })).toEqual([]);
    expect(issues({ samples: many(20, (i) => ({ sponsored: i < 10 })) })).toEqual([]);
    const r = run({ samples: many(20, (i) => ({ sponsored: i < 11 })) });
    expect(r.issues).toEqual(['sponsored-overmatch']);
    expect(r.degraded).toEqual(['sponsored']);
    expect(r.status).toBe('degraded');
    expect(r.notice).toBeUndefined();
  });

  it('test_ad_label_near_miss_needs_a_repeat', () => {
    expect(issues({ watch: watch({ nearMissRepeat: 1, postsSeen: 10 }) })).toEqual([]);
    const r = run({ watch: watch({ nearMissRepeat: 2, postsSeen: 10 }) });
    expect(r.issues).toEqual(['ad-label-near-miss']);
    // A near miss with weak evidence still hides, so nothing is switched off: the card only says so.
    expect(r.status).toBe('ok');
    expect(r.notice).toBe('ads-through');
  });

  it('test_no_ads_seen_per_platform', () => {
    expect(issues({ watch: watch({ postsSeen: 39 }) })).toEqual([]);
    expect(issues({ watch: watch({ postsSeen: 40 }) })).toEqual(['no-ads-seen']);
    expect(issues({ watch: watch({ postsSeen: 40, sponsoredSeen: 1 }) })).toEqual([]);
    const facebook = (postsSeen: number) => issues({ platform: 'facebook', watch: watch({ postsSeen }) });
    expect(facebook(49)).toEqual([]);
    expect(facebook(50)).toEqual(['no-ads-seen']);
  });

  it('test_ad_cue_unlabelled_threshold', () => {
    expect(issues({ watch: watch({ postsSeen: 20, adCueOnly: 2 }) })).toEqual([]);
    expect(issues({ watch: watch({ postsSeen: 20, adCueOnly: 3 }) })).toEqual(['ad-cue-unlabelled']);
    expect(issues({ watch: watch({ postsSeen: 19, adCueOnly: 3 }) })).toEqual([]);
    // A labelled ad was seen: labels work.
    expect(issues({ watch: watch({ postsSeen: 20, adCueOnly: 3, sponsoredSeen: 1 }) })).toEqual([]);
  });

  it('test_header_unrecognised_threshold', () => {
    expect(issues({ watch: watch({ postsSeen: 15, headersUnknown: 3 }) })).toEqual([]);
    expect(issues({ watch: watch({ postsSeen: 15, headersUnknown: 4 }) })).toEqual(['header-unrecognised']);
    // At least half of the header lines: 4 of 8 is half, 4 of 9 isn't.
    expect(issues({ watch: watch({ postsSeen: 15, headersUnknown: 4, headersKnown: 4 }) })).toEqual(['header-unrecognised']);
    expect(issues({ watch: watch({ postsSeen: 15, headersUnknown: 4, headersKnown: 5 }) })).toEqual([]);
    expect(issues({ watch: watch({ postsSeen: 14, headersUnknown: 6 }) })).toEqual([]);
  });

  it('test_items_not_growing_threshold', () => {
    const scrolled = (over: Partial<HealthWatch>) =>
      issues({ watch: watch({ scrolledScreens: 5, grownScreens: 4, newItemsWhileScrolling: 0, ...over }) });
    expect(scrolled({})).toEqual(['items-not-growing']);
    expect(scrolled({ scrolledScreens: 4.9 })).toEqual([]);
    expect(scrolled({ grownScreens: 3.9 })).toEqual([]);
    expect(scrolled({ newItemsWhileScrolling: 1 })).toEqual([]);
    expect(run({ watch: watch({ scrolledScreens: 5, grownScreens: 4 }) }).status).toBe('ok');
  });

  it('test_phase_b_report_only_issues', () => {
    expect(issues({ multiPost: 0 })).toEqual([]);
    expect(issues({ multiPost: 1 })).toEqual(['multi-post-items']);
    expect(issues({ loadMore: { expected: true, missingForMs: 29_999 } })).toEqual([]);
    expect(issues({ loadMore: { expected: true, missingForMs: 30_000 } })).toEqual(['load-more-missing']);
    expect(issues({ loadMore: { expected: false, missingForMs: 600_000 } })).toEqual([]);
    // A fallback strategy winning is cautious mode: rules are switched off, so the page is degraded.
    const fallback = run({ fallback: true });
    expect(fallback.issues).toEqual(['fallback-discovery']);
    expect(fallback.status).toBe('degraded');
    expect(fallback.notice).toBeUndefined();
  });

  it('test_route_new_is_report_only', () => {
    const r = run({ routeNew: true });
    expect(r).toStrictEqual({ status: 'ok', issues: ['route-new'], degraded: [] });
  });
});

describe('health: a held pause', () => {
  const held: HealthIssue[] = ['over-filtering'];

  it('test_held_over_filtering_stays_whatever_the_samples_say', () => {
    expect(HELD_ISSUES).toEqual(['over-filtering']);
    // Every post shows, and the page that grew empties or refills its slots: fine shares, too few to judge, nothing
    // on the page at all. The page stays paused, with its card.
    for (const samples of [many(30), many(20, (i) => ({ hidden: i < 5 })), many(5, () => ({ hidden: true }))]) {
      const r = run({ samples, held });
      expect(r).toStrictEqual({ status: 'broken', issues: ['over-filtering'], degraded: [], notice: 'paused' });
    }
    expect(run({ samples: [], visibleMs: 1000, held }).issues).toEqual(['over-filtering']);
    expect(run({ samples: [], held }).issues).toEqual(['no-items', 'over-filtering']);
    expect(run({ feedFound: false, samples: [], held })).toMatchObject({ status: 'broken', notice: 'paused' });
    // Markers that stop reading (`markersFor` throwing looks like an unsupported language) don't end it either.
    expect(run({ localeSupported: false, held })).toMatchObject({ status: 'broken', notice: 'paused' });
  });

  it('test_held_over_filtering_keeps_its_place_among_the_issues', () => {
    // Held or found afresh, the report reads the same, so the controller sees no change and redraws nothing.
    const found = run({ samples: many(20, () => ({ hidden: true })), watch: watch({ nearMissRepeat: 2 }), held });
    const heldOnly = run({ samples: many(5), watch: watch({ nearMissRepeat: 2 }), held });
    expect(found.issues).toEqual(['over-filtering', 'ad-label-near-miss']);
    expect(heldOnly).toStrictEqual(found);
  });

  it('test_a_hold_ends_only_with_a_reload_or_a_settings_change', () => {
    // Check after check, as the controller runs them; a page load starts with no hold.
    let hold: HealthHold | null = null;
    const check = (samples: HealthSample[], settings = 'balanced') => {
      const r = run({ samples, held: heldIssues(hold, settings) });
      hold = holdAfter(hold, r, settings);
      return r;
    };
    expect(check(many(20, (i) => ({ hidden: i < 10 }))).status).toBe('ok');
    expect(hold).toBeNull();
    expect(check(many(20, () => ({ hidden: true }))).issues).toEqual(['over-filtering']);
    expect(hold).toStrictEqual({ issues: ['over-filtering'], settings: 'balanced' });
    // Forty checks later, whatever the page did meanwhile, it is still paused: it never folds and opens again.
    const pages = [many(20, (i) => ({ hidden: i < 10 })), many(5), many(30), many(19, () => ({ hidden: true }))];
    for (let i = 0; i < 40; i++) expect(check(pages[i % pages.length] ?? []).status).toBe('broken');
    // The person changes a setting: the page is judged afresh, and folds again if it looks right.
    expect(
      check(
        many(20, (i) => ({ hidden: i < 10 })),
        'balanced, reels off',
      ),
    ).toStrictEqual({
      status: 'ok',
      issues: [],
      degraded: [],
    });
    expect(hold).toBeNull();
    // A reload starts with no hold.
    expect(heldIssues(null, 'balanced')).toEqual([]);
  });

  it('test_only_over_filtering_is_held', () => {
    const textBroken = run({ samples: many(10, (i) => ({ textFound: i >= 7 })) });
    expect(textBroken.status).toBe('broken');
    expect(holdAfter(null, textBroken, 's')).toBeNull();
    expect(holdAfter(null, run({ errors: 3 }), 's')).toBeNull();
    expect(holdAfter(null, run({ samples: many(10, (i) => (i < 6 ? { kind: 'module' } : {})) }), 's')).toBeNull();
    // Held with something else: only the held issue is kept.
    const both = run({ samples: many(20, (i) => ({ hidden: true, textFound: i >= 15 })) });
    expect(both.issues).toEqual(['text-detection', 'over-filtering']);
    expect(holdAfter(null, both, 's')).toStrictEqual({ issues: ['over-filtering'], settings: 's' });
  });
});

describe('health: visible time', () => {
  it('test_visible_clock_counts_only_visible_time', () => {
    let now = 1_000;
    const clock = new VisibleClock(false, () => now);
    now += 60_000; // a background tab for a minute
    expect(clock.ms()).toBe(0);
    clock.setVisible(true);
    now += 4_000;
    expect(clock.ms()).toBe(4_000);
    clock.setVisible(false);
    now += 30_000;
    clock.setVisible(false); // repeated events change nothing
    expect(clock.ms()).toBe(4_000);
    clock.setVisible(true);
    clock.setVisible(true);
    now += 6_000;
    expect(clock.ms()).toBe(10_000);
    expect(clock.visible).toBe(true);
  });

  it('test_hidden_tab_never_reaches_no_feed', () => {
    let now = 0;
    const clock = new VisibleClock(true, () => now);
    now += 5_000;
    clock.setVisible(false);
    now += 120_000;
    // Two minutes on the clock, five seconds of it visible: the page still has time to load its feed.
    expect(issues({ feedFound: false, samples: [], visibleMs: clock.ms() })).toEqual([]);
    clock.setVisible(true);
    now += 5_000;
    expect(issues({ feedFound: false, samples: [], visibleMs: clock.ms() })).toEqual(['no-feed']);
  });
});

describe('health: the live numbers', () => {
  /** LinkedIn For you, 2026-10-18: 20 posts, 5 of them ads, Balanced folding 15 (the 5 ads and 10 more). */
  function linkedinFeed(labels: 'working' | 'broken') {
    const ads = labels === 'working';
    const samples = many(20, (i) => (i < 5 ? { sponsored: ads, hidden: ads } : { hidden: i < 15 }));
    const facts: ItemFacts[] = Array.from({ length: 20 }, (_, i) =>
      i < 5 ? { kind: 'post', sponsored: ads, adCue: !ads } : { kind: 'post' },
    );
    return { samples, watch: watchFrom(facts) };
  }

  it('test_linkedin_twenty_posts_five_ads_is_ok', () => {
    expect(run(linkedinFeed('working'))).toStrictEqual({ status: 'ok', issues: [], degraded: [] });
  });

  it('test_linkedin_ad_labels_broken_is_ad_cue_unlabelled', () => {
    const r = run(linkedinFeed('broken'));
    expect(r.issues).toEqual(['ad-cue-unlabelled']);
    // Report only, until calibrated on more captures: no card, nothing switched off.
    expect(r.status).toBe('ok');
    expect(r.notice).toBeUndefined();
  });

  it('test_two_equal_near_miss_labels_raise_the_card', () => {
    const facts = (a: string, b: string) => [
      postFacts(post({}, { adNearMiss: a })),
      postFacts(post({ id: 'li:urn:li:activity:2' }, { adNearMiss: b })),
      ...Array.from({ length: 8 }, () => postFacts(post())),
    ];
    const same = run({ watch: watchFrom(facts('h:promoted-brand-content', 'h:promoted-brand-content')) });
    expect(same.issues).toEqual(['ad-label-near-miss']);
    expect(same.notice).toBe('ads-through');
    // Two different near misses are one-off lines, not a changed label template.
    expect(run({ watch: watchFrom(facts('h:one', 'h:two')) }).issues).toEqual([]);
  });

  it('test_facebook_far_away_pending_is_not_an_issue', () => {
    // Facebook, 45 items: 8 ads, 30% of the items still loading far below the viewport.
    const samples = many(45, (i) =>
      i < 14
        ? { kind: 'pending', near: false, nearMs: 0, ageMs: 60_000 }
        : i < 22
          ? { sponsored: true, hidden: true }
          : { hidden: i < 28 },
    );
    const facts: ItemFacts[] = Array.from({ length: 31 }, (_, i) => ({ kind: 'post', sponsored: i < 8 }));
    expect(run({ platform: 'facebook', samples, watch: watchFrom(facts) })).toStrictEqual({
      status: 'ok',
      issues: [],
      degraded: [],
    });
  });

  it('test_forty_linkedin_posts_without_ads', () => {
    const facts: ItemFacts[] = Array.from({ length: 40 }, () => ({ kind: 'post' }));
    const r = run({ samples: many(30), watch: watchFrom(facts) });
    expect(r.issues).toEqual(['no-ads-seen']);
    expect(r.status).toBe('ok');
    // The popup says so; the feed doesn't.
    expect(r.notice).toBeUndefined();
  });
});

describe('notices from issues', () => {
  it('test_notice_for_priorities', () => {
    expect(noticeFor(['ad-label-near-miss', 'over-filtering'], 'broken')).toBe('paused');
    expect(noticeFor(['ad-label-near-miss', 'adapter-error', 'feed-not-started'], 'broken')).toBe('not-running');
    expect(noticeFor(['ad-label-near-miss'], 'ok')).toBe('ads-through');
    expect(noticeFor(['feed-not-started'], 'not-started')).toBe('not-running');
    expect(noticeKinds(['ad-label-near-miss', 'text-detection', 'feed-not-started'], 'broken')).toEqual([
      'not-running',
      'paused',
      'ads-through',
    ]);
    // `paused` needs the page to be broken by positive evidence.
    expect(noticeFor(['over-filtering'], 'degraded')).toBeUndefined();
    // Absence never raises a card, broken or not.
    for (const absent of ['no-feed', 'no-items', 'no-ads-seen', 'stuck-skeletons', 'items-not-growing']) {
      expect(noticeFor([absent], 'broken'), absent).toBeUndefined();
    }
    expect(noticeFor([], 'ok')).toBeUndefined();
  });

  it('test_a_held_issue_shows_its_card_at_once', () => {
    // Over-filtering holds until the page reloads: its card is due at the first check that finds it.
    expect(steadyNotices({ issues: ['over-filtering'], status: 'broken' }, [])).toEqual(['paused']);
    // Every other cause waits for a second check in a row.
    expect(steadyNotices({ issues: ['text-detection'], status: 'broken' }, [])).toEqual([]);
    expect(steadyNotices({ issues: ['text-detection'], status: 'broken' }, ['paused'])).toEqual(['paused']);
    expect(steadyNotices({ issues: ['adapter-error'], status: 'broken' }, [])).toEqual([]);
    expect(steadyNotices({ issues: ['ad-label-near-miss'], status: 'ok' }, [])).toEqual([]);
    expect(steadyNotices({ issues: ['ad-label-near-miss'], status: 'ok' }, ['ads-through'])).toEqual(['ads-through']);
    expect(steadyNotices({ issues: ['over-filtering', 'ad-label-near-miss'], status: 'broken' }, [])).toEqual(['paused']);
    // A card that was raised but whose issue cleared isn't due.
    expect(steadyNotices({ issues: [], status: 'ok' }, ['paused'])).toEqual([]);
  });

  it('test_health_report_carries_the_top_notice', () => {
    const r = run({ errors: 3, watch: watch({ nearMissRepeat: 3 }) });
    expect(r.issues).toEqual(['adapter-error', 'ad-label-near-miss']);
    expect(r.notice).toBe('paused');
  });
});

describe('page-load facts', () => {
  it('test_post_facts_keep_flags_and_ids_only', () => {
    const p = post(
      {
        signals: { ...NO_SIGNALS, sponsored: true },
        evidence: [
          { signal: 'sponsored', detector: 'li.promoted.near', strength: 'medium' },
          { signal: 'sponsored', detector: 'li.age-slot.no-age', strength: 'weak' },
          { signal: 'sponsored', detector: 'li.promoted.near', strength: 'medium' },
        ],
      },
      { adNearMiss: 'h:1', adCue: true, headerUnknown: true },
    );
    const f = postFacts(p, ['li.label.promoted.near', 'li.label.promoted.near']);
    expect(f).toStrictEqual({
      kind: 'post',
      sponsored: true,
      adNearMiss: 'h:1',
      adCue: true,
      headerUnknown: true,
      detectors: ['li.promoted.near', 'li.age-slot.no-age'],
      observations: ['li.label.promoted.near'],
    });
    expect(JSON.stringify(f)).not.toContain('Jane');
    expect(JSON.stringify(f)).not.toContain('forms');
  });

  it('test_watch_from_facts', () => {
    const facts: ItemFacts[] = [
      { kind: 'post', sponsored: true, adCue: true },
      { kind: 'post', adCue: true, headerKnown: true },
      { kind: 'post', adNearMiss: 'a', headerUnknown: true },
      { kind: 'post', adNearMiss: 'a' },
      { kind: 'post', adNearMiss: 'b' },
      { kind: 'module', sponsored: true },
      { kind: 'ignore', observations: ['li.item.multi-post'] },
    ];
    expect(watchFrom(facts, { scrolledScreens: 2, grownScreens: 1, newItemsWhileScrolling: 3 })).toStrictEqual({
      postsSeen: 5,
      sponsoredSeen: 1,
      nearMissRepeat: 2,
      // An ad cue on a labelled ad isn't an unlabelled one.
      adCueOnly: 1,
      headersKnown: 1,
      headersUnknown: 1,
      scrolledScreens: 2,
      grownScreens: 1,
      newItemsWhileScrolling: 3,
    });
    expect(multiPostCount(facts)).toBe(1);
    expect(watchFrom([])).toStrictEqual(EMPTY_WATCH);
  });

  it('test_tally_ids_counts_each_item_once', () => {
    const facts: ItemFacts[] = [
      { kind: 'post', detectors: ['li.follow-button', 'li.promoted.age-slot'], observations: ['li.header.unknown'] },
      { kind: 'post', detectors: ['li.follow-button'] },
      { kind: 'ignore', observations: ['li.item.multi-post'] },
    ];
    expect(tallyIds(facts, 'detectors')).toStrictEqual({ 'li.follow-button': 2, 'li.promoted.age-slot': 1 });
    expect(tallyIds(facts, 'observations')).toStrictEqual({ 'li.header.unknown': 1, 'li.item.multi-post': 1 });
  });
});

describe('every issue is in the registry', () => {
  it('test_evaluated_issues_are_registry_codes', () => {
    const platforms: PlatformId[] = ['linkedin', 'facebook'];
    for (const platform of platforms) run({ platform, watch: watch({ postsSeen: 60 }), fallback: true, multiPost: 2 });
    const produced = new Set(seen.flatMap((r) => r.issues));
    // This file reaches every issue the health check can raise; the other two come from the watchdog and the popup.
    expect([...produced].sort()).toEqual(
      REPORT_ISSUES.filter((i) => !['feed-not-started', 'no-content-script'].includes(i)).sort(),
    );
    for (const i of produced) expect(ISSUE_PRIORITY).toContain(i);
  });
});
