import type { NoticeKind, PlatformId, ReportIssue } from '@unalgorithm/protocol';
import { noticeFor } from './health/notices.ts';
import type { PostSignals } from './post.ts';
import type { PresetOrCustom } from './settings/schema.ts';

export * from './health/notices.ts';
export * from './health/visible-clock.ts';
export * from './health/watch.ts';

/**
 * Everything the breakage checks can say about a page (ADR 0009 §3). The protocol registry's list, so a report never
 * carries an issue the Cloud doesn't know: a new issue goes into `REPORT_ISSUES` first.
 */
export type HealthIssue = ReportIssue;

/** A signal (or the follow relationship) the rules stop trusting on a page. */
export type DegradedSignal = keyof PostSignals | 'relationship';

export interface HealthSample {
  /**
   * `offscreen`: a slot the platform emptied or virtualised after it scrolled away. It keeps its last decision and is
   * left out of every ratio, so a long Facebook session doesn't look like a page of skeletons.
   */
  kind: 'post' | 'module' | 'pending' | 'offscreen';
  authorFound: boolean;
  textFound: boolean;
  sponsored: boolean;
  /** Would be hidden by the current settings. */
  hidden: boolean;
  /** How long ago the item was first seen, in visible time. */
  ageMs: number;
  /** Near the viewport now: the platform fills in items as they come near, so only these can be stuck. */
  near: boolean;
  /** How long it has been near the viewport without a break, in visible time; `ageMs` when absent. */
  nearMs?: number;
}

/**
 * Counts over the whole page load, as opposed to the rolling window of samples: under-detection only shows over many
 * posts. Kept on the device; none of them goes into a report.
 */
export interface HealthWatch {
  /** Posts read on this page load. */
  postsSeen: number;
  /** Of those, posts detected as ads. */
  sponsoredSeen: number;
  /** The most posts sharing one near-miss ad label (by its in-memory hash). */
  nearMissRepeat: number;
  /** Posts that look like ads without an ad label (LinkedIn: no post age and a Follow button), and aren't ads. */
  adCueOnly: number;
  /** Posts with a header line the markers recognise, and posts with one they don't. */
  headersKnown: number;
  headersUnknown: number;
  /** Since the last new item: screens the person scrolled, screens the feed grew, and items found meanwhile. */
  scrolledScreens: number;
  grownScreens: number;
  newItemsWhileScrolling: number;
}

export const EMPTY_WATCH: HealthWatch = {
  postsSeen: 0,
  sponsoredSeen: 0,
  nearMissRepeat: 0,
  adCueOnly: 0,
  headersKnown: 0,
  headersUnknown: 0,
  scrolledScreens: 0,
  grownScreens: 0,
  newItemsWhileScrolling: 0,
};

export interface HealthInput {
  platform: PlatformId;
  feedFound: boolean;
  /** Time the page has been visible since detection started: every time limit counts visible time only. */
  visibleMs: number;
  samples: readonly HealthSample[];
  localeSupported: boolean;
  preset: PresetOrCustom;
  /**
   * A signed-in page shell is present (`adapter.signedIn`). Without it a missing feed is a login page, a checkpoint or
   * a consent wall, not breakage.
   */
  signedIn: boolean;
  /** Adapter exceptions caught on this page (counted per operation, never their messages). */
  errors?: number;
  /** Running on an address unAlgorithm didn't know, because the page had a strong home signature. */
  routeNew?: boolean;
  /** A fallback item discovery strategy is winning: cautious mode. */
  fallback?: boolean;
  /** Items found holding several posts (they never hide). */
  multiPost?: number;
  /** Whether the adapter has a load-more marker, and how long (visible time) it has been missing. */
  loadMore?: { expected: boolean; missingForMs: number };
  watch?: HealthWatch;
}

export interface HealthReport {
  /**
   * ok; degraded (some rules switched off); broken (stop hiding on this page); unsupported-locale; not-started (the
   * watchdog found a feed that unAlgorithm didn't start on).
   */
  status: 'ok' | 'degraded' | 'broken' | 'unsupported-locale' | 'not-started';
  issues: HealthIssue[];
  /** Signals the rules should stop trusting on this page (fail open). */
  degraded: DegradedSignal[];
  /** The breakage notice these issues raise (`noticeFor`), whatever the snoozes. */
  notice?: NoticeKind;
}

export const HEALTHY: HealthReport = { status: 'ok', issues: [], degraded: [] };

/**
 * Share of items that may be hidden before we suspect detection is wrong and stop hiding. Ads don't count: they have
 * their own over-match check (`sponsored-overmatch`). Balanced allows 90%: a LinkedIn feed of mostly suggested,
 * promoted and unfollowed posts really is that noisy, so only a page where nearly everything hides looks broken.
 */
const OVER_FILTER_LIMIT: Record<PresetOrCustom, number> = { light: 0.5, balanced: 0.9, calm: 0.95, custom: 0.9 };

/** Visible time before a missing feed or an empty one counts as broken. */
export const START_GRACE_MS = 10_000;
/** Adapter exceptions on one page that mean detection is broken. */
export const ADAPTER_ERROR_LIMIT = 3;
/** Visible time near the viewport after which a skeleton counts as stuck. */
export const STUCK_MS = 15_000;
/** Visible time without a load-more marker before it counts as missing. */
export const LOAD_MORE_MISSING_MS = 30_000;
/**
 * Posts with no ad among them before `no-ads-seen`. LinkedIn showed 25% ads and Facebook about 18% in the live
 * session, so either run happens about once in 100,000 page loads while detection works.
 */
export const NO_ADS_POSTS: Record<PlatformId, number> = { linkedin: 40, facebook: 50 };

/** Issues that stop hiding on the page. */
const BROKEN = new Set<HealthIssue>([
  'no-feed',
  'no-items',
  'adapter-error',
  'over-filtering',
  'module-overmatch',
  'text-detection',
]);

const share = (n: number, of: number) => (of > 0 ? n / of : 0);

/**
 * Decide whether detection on this page can be trusted, from a rolling window of recent items and counts over the page
 * load. When in doubt we show posts: hiding a friend's post by mistake costs far more trust than showing an ad. Pure;
 * the thresholds are ADR 0009 §3's, chosen from the live numbers.
 */
export function evaluateHealth(input: HealthInput): HealthReport {
  if (!input.localeSupported) return { status: 'unsupported-locale', issues: ['unsupported-locale'], degraded: [] };
  const issues: HealthIssue[] = [];
  const degraded = new Set<DegradedSignal>();
  const done = () => report(issues, degraded, input.fallback === true);

  if ((input.errors ?? 0) >= ADAPTER_ERROR_LIMIT) issues.push('adapter-error');
  if (input.routeNew) issues.push('route-new');
  if (input.fallback) issues.push('fallback-discovery');
  if (!input.feedFound) {
    if (input.visibleMs >= START_GRACE_MS && input.signedIn) issues.push('no-feed');
    return done();
  }
  if (input.samples.length === 0) {
    if (input.visibleMs >= START_GRACE_MS) issues.push('no-items');
    return done();
  }

  const counted = input.samples.filter((s) => s.kind !== 'offscreen');
  const posts = counted.filter((s) => s.kind === 'post');
  const stuck = counted.filter((s) => s.kind === 'pending' && s.near && (s.nearMs ?? s.ageMs) >= STUCK_MS).length;
  if (share(stuck, counted.length) > 0.3) issues.push('stuck-skeletons');
  if (posts.length >= 10) {
    if (share(posts.filter((p) => !p.authorFound).length, posts.length) > 0.5) {
      issues.push('author-detection');
      degraded.add('relationship');
    }
    if (share(posts.filter((p) => !p.textFound).length, posts.length) > 0.6) issues.push('text-detection');
  }
  // Over 20 posts, not 10: at LinkedIn's 25% ad rate, "more than 40% over 10" tripped in 7.8% of healthy windows.
  if (posts.length >= 20 && share(posts.filter((p) => p.sponsored).length, posts.length) > 0.5) {
    issues.push('sponsored-overmatch');
    degraded.add('sponsored');
  }
  const judged = counted.filter((s) => s.kind !== 'pending');
  if (judged.length >= 10 && share(judged.filter((s) => s.kind === 'module').length, judged.length) > 0.5) {
    issues.push('module-overmatch');
  }
  const overFiltered = share(judged.filter((s) => s.hidden && !s.sponsored).length, judged.length);
  if (judged.length >= 20 && overFiltered > OVER_FILTER_LIMIT[input.preset]) issues.push('over-filtering');

  const w = input.watch ?? EMPTY_WATCH;
  // Ad labels are templates and repeat; a one-off line that looks like one doesn't.
  if (w.nearMissRepeat >= 2) issues.push('ad-label-near-miss');
  if (w.postsSeen >= NO_ADS_POSTS[input.platform] && w.sponsoredSeen === 0) issues.push('no-ads-seen');
  if (w.postsSeen >= 20 && w.sponsoredSeen === 0 && w.adCueOnly >= 3) issues.push('ad-cue-unlabelled');
  if (w.postsSeen >= 15 && w.headersUnknown >= 4 && w.headersUnknown >= w.headersKnown) issues.push('header-unrecognised');
  if (w.scrolledScreens >= 5 && w.grownScreens >= 4 && w.newItemsWhileScrolling === 0) issues.push('items-not-growing');
  if ((input.multiPost ?? 0) > 0) issues.push('multi-post-items');
  if (input.loadMore?.expected && input.loadMore.missingForMs >= LOAD_MORE_MISSING_MS) issues.push('load-more-missing');
  return done();
}

/**
 * Broken when an issue stops hiding; degraded when rules were switched off (a degraded signal, or cautious mode);
 * otherwise ok, even with issues that are only for reports and the popup.
 */
function report(issues: HealthIssue[], degraded: Set<DegradedSignal>, cautious: boolean): HealthReport {
  const status = issues.some((i) => BROKEN.has(i)) ? 'broken' : degraded.size > 0 || cautious ? 'degraded' : 'ok';
  const notice = noticeFor(issues, status);
  return { status, issues, degraded: [...degraded], ...(notice ? { notice } : {}) };
}
