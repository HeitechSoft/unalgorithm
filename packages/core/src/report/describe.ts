import {
  type AuthorKind,
  type CORRECTION_VIA,
  type COUNT_KEYS,
  type DEGRADED_SIGNALS,
  type DETECTOR_IDS,
  type ERROR_OPS,
  FEATURE_NAMES,
  type FILTER_REASONS,
  type LANDMARK_KEYS,
  type ListKind,
  type MediaKind,
  type MODULE_KINDS,
  PLATFORM_NAMES,
  type ProblemReport,
  type REPORT_FROM,
  type REPORT_ISSUES,
  type REPORT_PRESETS,
  type ReportAiKind,
  type ReportBrowser,
  type ReportChannel,
  type ReportCorrection,
  type ReportRoute,
  SLOT_LOCATORS,
  SLOT_NAMES,
  type STRATEGY_IDS,
  type TextBucket,
} from '@unalgorithm/protocol';

type Labels<T extends readonly string[]> = Readonly<Record<T[number], string>>;

const SLOT_WORDS: Labels<typeof SLOT_NAMES> = {
  actor: 'author',
  text: 'text',
  'action-bar': 'action buttons',
  age: 'post age',
  header: 'header',
  'header-buttons': 'header buttons',
  'nested-post': 'shared post',
};
const LOCATOR_WORDS: Labels<typeof SLOT_LOCATORS> = {
  class: 'class name',
  testid: 'test id',
  aria: 'accessible name',
  structure: 'page structure',
};
const slotObservations = Object.fromEntries(
  (['li', 'fb'] as const).flatMap((p) =>
    SLOT_NAMES.flatMap((slot) =>
      SLOT_LOCATORS.map((loc) => [`${p}.slot.${slot}.${loc}`, `${SLOT_WORDS[slot]} found by ${LOCATOR_WORDS[loc]}`]),
    ),
  ),
);

const CHOICE = {
  'ads-showing': 'Ads are still showing',
  'unwanted-showing': "Posts I didn't want are still showing",
  'wanted-hidden': 'Posts I wanted are hidden',
  'not-working': "unAlgorithm isn't doing anything on this page",
  'page-broken': 'The page looks broken or slow',
  other: 'Something else',
  'should-show': "This post shouldn't have been hidden",
  'wrong-reason': 'It was hidden for the wrong reason',
  'verdict-wrong': 'The verdict is wrong',
  'source-wrong': "A source is wrong or doesn't say that",
  'comparison-wrong': 'The comparison is wrong or unfair',
  'outlet-wrong': 'An outlet or its lean is wrong',
  'sign-in-sync': 'Signing in or sync',
  ai: `AI labels, ${FEATURE_NAMES.factcheck} or ${FEATURE_NAMES.perspectives}`,
  credits: 'Credits',
} as const;

/**
 * Every word `describeReport` uses, by code: the report page's preview, the email fallback and the admin page all read
 * the same lines, and tests pin them. `{site}` is the platform's name. A code missing here is shown as it is.
 */
export const REPORT_LINE_COPY = {
  channels: {
    'chrome-store': 'from the Chrome Web Store',
    'edge-store': 'from Microsoft Edge Add-ons',
    'firefox-store': 'from Firefox Add-ons',
    sideload: 'installed from a file',
    development: 'development build',
    other: '',
  } satisfies Labels<readonly ReportChannel[]>,
  browsers: { chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox', other: 'Another browser, version' } satisfies Labels<
    readonly ReportBrowser[]
  >,
  from: {
    popup: 'the toolbar menu',
    'popup-banner': "the toolbar menu's paused banner",
    'popup-no-script': "the toolbar menu, where unAlgorithm wasn't running",
    notice: 'a note in the feed',
    why: 'Why? on a post',
    settings: 'Settings',
    sidepanel: 'the side panel',
  } satisfies Labels<typeof REPORT_FROM>,
  routes: {
    feed: '{site} home feed',
    'feed-candidate': '{site} home feed (a new address)',
    other: "a {site} page that isn't the feed",
    unknown: '{site}, page not checked',
  } satisfies Labels<readonly ReportRoute[]>,
  /** The candidate route with its word. */
  newAddress: '{site} home feed (a new address: {word})',
  presets: { light: 'Light', balanced: 'Balanced', calm: 'Calm', custom: 'Custom' } satisfies Labels<typeof REPORT_PRESETS>,
  ai: {
    off: 'AI off',
    'on-device': 'on-device AI',
    'own-key': 'AI with your own key',
    'own-server': 'AI on your own server',
    cloud: 'AI from unAlgorithm Cloud',
  } satisfies Labels<readonly ReportAiKind[]>,
  issues: {
    'no-feed': "{site}'s feed wasn't found on the page",
    'no-items': 'the feed showed no posts unAlgorithm could read',
    'author-detection': "unAlgorithm couldn't tell who wrote most posts",
    'text-detection': "unAlgorithm couldn't read the text of most posts",
    'stuck-skeletons': 'some posts stayed loading',
    'module-overmatch': 'too many items looked like feed panels',
    'sponsored-overmatch': 'too many posts looked like ads',
    'over-filtering': 'almost every post would have been hidden',
    'unsupported-locale': "{site} is in a language unAlgorithm doesn't read yet",
    'feed-not-started': "{site}'s feed is on a page unAlgorithm doesn't recognise",
    'route-new': "{site}'s feed is at an address unAlgorithm didn't know",
    'no-content-script': "unAlgorithm wasn't running on the page",
    'adapter-error': 'unAlgorithm hit errors reading the page',
    'ad-label-near-miss': 'some ads are labelled in a new way',
    'no-ads-seen': 'no ads found on this page',
    'ad-cue-unlabelled': 'some posts look like ads without an ad label',
    'header-unrecognised': "many lines above posts weren't recognised",
    'items-not-growing': 'new posts stopped being picked up while scrolling',
    'multi-post-items': 'some items held several posts',
    'fallback-discovery': 'posts were found a backup way',
    'load-more-missing': "the point that loads more posts wasn't found",
  } satisfies Labels<typeof REPORT_ISSUES>,
  degraded: {
    sponsored: 'ad detection',
    suggested: 'suggested-post detection',
    networkActivity: 'network activity detection',
    reshare: 'repost detection',
    unjoinedGroup: 'group detection',
    reel: 'reel detection',
    relationship: 'who you follow',
  } satisfies Labels<typeof DEGRADED_SIGNALS>,
  choices: CHOICE as Readonly<Record<string, string>>,
  /** Folded posts by reason, as counts ("5 ads"). */
  reasons: {
    sponsored: 'ads',
    suggested: 'suggested',
    'network-activity': 'network activity',
    reshare: 'reposts',
    'unjoined-group': "from groups you haven't joined",
    reel: 'reels',
    'not-followed': 'not followed',
    module: 'feed panels',
    'always-hide': 'hidden by you',
    'muted-keyword': 'muted words',
    'less-like-this': 'less like this',
    noise: 'noise (AI)',
    'low-relevance': 'off-topic (AI)',
  } satisfies Labels<typeof FILTER_REASONS>,
  /** One post's reason ("hidden as Suggested"). */
  reason: {
    sponsored: 'an ad',
    suggested: 'Suggested',
    'network-activity': 'network activity',
    reshare: 'a repost',
    'unjoined-group': "a group you haven't joined",
    reel: 'a reel',
    'not-followed': 'not followed',
    module: 'a feed panel',
    'always-hide': 'an author you hide',
    'muted-keyword': 'a muted word',
    'less-like-this': 'less like this',
    noise: 'noise',
    'low-relevance': 'off-topic',
  } satisfies Labels<typeof FILTER_REASONS>,
  sources: { rule: 'by a rule', user: 'by your own lists', ai: 'by AI' },
  detectors: {
    'li.follow-button': 'Follow button',
    'li.group.join-button': 'Join button',
    'li.header.activity': 'network activity line',
    'li.header.repost': 'repost line',
    'li.header.suggested': 'suggested header',
    'li.promoted.line': 'ad label line',
    'li.promoted.text': 'ad label in the text',
    'li.promoted.age-slot': 'ad label',
    'li.promoted.header': 'ad label above the post',
    'li.promoted.actor': 'ad label by the author',
    'li.promoted.near': 'a label like an ad label',
    'li.age-slot.no-age': 'no post age',
    'fb.follow-button': 'Follow button',
    'fb.header.activity': 'friend activity line',
    'fb.header.suggested': 'suggested header',
    'fb.join-button': 'Join button',
    'fb.reshare': 'share line',
    'fb.sponsored.adlink': 'link to ad settings',
    'fb.sponsored.aria-label': 'ad label',
    'fb.sponsored.cta': 'shopping-style button',
    'fb.sponsored.labelledby': 'linked ad label',
    'fb.sponsored.no-timestamp': 'no post time',
    'fb.sponsored.paid-partnership': 'paid partnership label',
    'fb.sponsored.rendered-label': 'ad label as shown',
    'fb.sponsored.slot-label': 'ad label where the time goes',
    'fb.sponsored.near': 'a label like an ad label',
    'fb.sponsored.header': 'ad label above the post',
  } satisfies Labels<typeof DETECTOR_IDS>,
  observations: {
    'li.label.promoted.near': 'a label like an ad label',
    'li.label.suggested.near': 'a header like Suggested',
    'li.slot.age.unrecognised': 'an unrecognised line where the age goes',
    'li.header.unknown': 'an unrecognised line above a post',
    'li.ad-cue': 'a post like an ad without a label',
    'li.item.multi-post': 'an item holding several posts',
    'fb.label.sponsored.near': 'a label like an ad label',
    'fb.label.suggested.near': 'a header like Suggested',
    'fb.slot.age.unrecognised': 'an unrecognised line where the time goes',
    'fb.header.unknown': 'an unrecognised line above a post',
    'fb.item.multi-post': 'an item holding several posts',
    'fb.offscreen': 'posts scrolled away',
    ...slotObservations,
  } as Readonly<Record<string, string>>,
  strategies: {
    'li.items.card-key': 'post cards',
    'li.items.feed-list': 'the feed list',
    'li.items.anatomy': 'post buttons and menus',
    'li.items.sr-heading': 'screen-reader headings',
    'fb.items.role-feed': 'the feed',
    'fb.items.heading-list': 'the list after the feed heading',
    'fb.items.posinset': 'numbered posts',
    'fb.items.anatomy': 'post buttons and names',
  } satisfies Labels<typeof STRATEGY_IDS>,
  counts: {
    items: 'items',
    posts: 'posts',
    modules: 'panels',
    pending: 'still loading',
    offscreen: 'scrolled away',
    hidden: 'folded away',
    classified: 'checked by AI',
    unknownAuthor: 'without a known author',
  } satisfies Labels<typeof COUNT_KEYS>,
  landmarks: {
    main: 'main area',
    feedList: 'feed list',
    postRoots: 'post cards',
    authorMenus: 'post menus',
    textBoxes: 'text boxes',
    feeds: 'feeds',
    lists: 'feed lists',
    items: 'items',
    posinset: 'numbered items',
    messages: 'post texts',
    profileNames: 'author names',
    homeNav: 'home link',
    signedIn: 'signed-in bar',
    composer: 'post box',
  } satisfies Labels<typeof LANDMARK_KEYS>,
  errors: {
    feedScope: 'finding the feed',
    findItems: 'finding posts',
    inspect: 'reading posts',
    itemRootOf: 'matching posts',
    probe: 'counting page parts',
  } satisfies Labels<typeof ERROR_OPS>,
  modules: {
    'people-you-may-know': 'People you may know',
    reels: 'Reels',
    stories: 'Stories',
    jobs: 'Jobs',
    games: 'Games',
    groups: 'Groups',
    pages: 'Pages',
    newsletters: 'Newsletters',
    'sponsored-rail': 'Ads beside the feed',
    promo: 'Promotions',
    other: 'another panel',
  } satisfies Labels<typeof MODULE_KINDS>,
  media: {
    none: '',
    image: 'an image',
    video: 'a video',
    reel: 'a reel',
    document: 'a document',
    link: 'a link',
    poll: 'a poll',
    event: 'an event',
    other: 'other media',
  } satisfies Labels<readonly MediaKind[]>,
  text: { none: 'no text', short: 'short text', long: 'long text' } satisfies Labels<readonly TextBucket[]>,
  via: { 'own-key': 'your own key', 'own-server': 'your own server', cloud: 'unAlgorithm Cloud' } satisfies Labels<
    typeof CORRECTION_VIA
  >,
  lists: { cloud: "unAlgorithm Cloud's source list", own: 'your own source list' } satisfies Labels<readonly ListKind[]>,
  privateWindow: 'From a private window, so nothing about the page.',
  noIssues: 'unAlgorithm noticed nothing wrong',
  noContact: 'No reply email',
} as const;

const C = REPORT_LINE_COPY;

/**
 * A report as `describeReport` reads it: the wire report, or what the server stored (no id, the message and contact
 * from their own columns).
 */
export type DescribableReport = Pick<ProblemReport, 'kind' | 'choices' | 'env'> &
  Partial<Pick<ProblemReport, 'page' | 'health' | 'detection' | 'post' | 'private'>> & {
    from?: string | null;
    correction?: Omit<ReportCorrection, 'message' | 'contact'> & { message?: string | null; contact?: string | null };
  };

const label = (table: Readonly<Record<string, string>>, code: string): string => table[code] ?? code;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function languageName(lang: string): string {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(lang);
    if (name && name !== lang) return `in ${name}`;
  } catch {
    // An unknown subtag: show it as it is.
  }
  return `language ${lang}`;
}

function authorPhrase(kind: AuthorKind, relationship: string): string {
  if (kind === 'unknown') return 'not found';
  if (kind === 'group') return 'a group';
  const who = kind === 'page' ? 'a page' : 'a person';
  if (relationship === 'followed') return `${who} you follow`;
  if (relationship === 'not-followed') return `${who} you don't follow`;
  return who;
}

function countLine(d: NonNullable<DescribableReport['detection']>): string {
  const c = d.counts;
  const parts: string[] = [];
  if (c.posts !== undefined) parts.push(plural(c.posts, 'post', 'posts'));
  if (c.modules !== undefined) parts.push(plural(c.modules, 'panel', 'panels'));
  if (c.items !== undefined && c.posts === undefined && c.modules === undefined) parts.push(plural(c.items, 'item', 'items'));
  if (c.hidden) {
    const by = Object.entries(d.hiddenBy ?? {}).filter(([, n]) => n > 0);
    const detail = by.length ? ` (${by.map(([reason, n]) => `${n} ${label(C.reasons, reason)}`).join(', ')})` : '';
    parts.push(`${c.hidden} ${C.counts.hidden}${detail}`);
  }
  for (const [key, n] of Object.entries(c)) {
    if (['items', 'posts', 'modules', 'hidden'].includes(key) || !n) continue;
    parts.push(`${n} ${label(C.counts, key)}`);
  }
  return `On this page: ${parts.length ? parts.join(', ') : 'nothing counted'}`;
}

const tally = (table: Readonly<Record<string, string>>, rec: Readonly<Record<string, number>> | undefined): string[] =>
  Object.entries(rec ?? {})
    .filter(([, n]) => n > 0)
    .map(([code, n]) => `${label(table, code)} ${n}`);

/**
 * The report in plain lines (ADR 0009 §2, "What we'll send"): versions, browser, where it started, the page, the
 * person's settings, what unAlgorithm noticed, the counts and rules, their answer, and the post or the correction. The
 * report page shows them, *Email it instead* puts them in the body, and the admin page shows them over the raw details.
 * `words: false` leaves out a correction's message and reply email (the admin page shows those on their own).
 */
export function describeReport(report: DescribableReport, opts: { words?: boolean } = {}): string[] {
  const lines: string[] = [];
  const { env, page } = report;
  const site = page ? PLATFORM_NAMES[page.platform] : 'the site';
  const withSite = (text: string) => text.replaceAll('{site}', site);

  const channel = C.channels[env.channel];
  const detection = page ? ` · ${site} detection ${page.adapter.split('@')[1]}` : '';
  lines.push(`unAlgorithm ${env.extension}${channel ? ` ${channel}` : ''}${detection}`);
  lines.push(`${C.browsers[env.browser]} ${env.browserMajor}`);
  if (report.from) lines.push(`Reported from ${label(C.from, report.from)}`);
  if (report.private) lines.push(C.privateWindow);

  if (page) {
    const where =
      page.route === 'feed-candidate' && page.feedWord ? C.newAddress.replace('{word}', page.feedWord) : C.routes[page.route];
    const lang = page.lang === 'unknown' ? '' : `, ${languageName(page.lang)}`;
    lines.push(`Page: ${withSite(where)}${lang}`);
    lines.push(`Your settings: ${C.presets[page.preset]}, ${C.ai[page.ai]}${page.paused ? `, paused on ${site}` : ''}`);
  }
  if (report.health) {
    const { issues, degraded } = report.health;
    lines.push(issues.length ? `unAlgorithm noticed: ${issues.map((i) => withSite(label(C.issues, i))).join('; ')}` : C.noIssues);
    if (degraded.length)
      lines.push(`Switched off on this page to be safe: ${degraded.map((d) => label(C.degraded, d)).join(', ')}`);
  }
  const d = report.detection;
  if (d) {
    lines.push(countLine(d));
    const rules = tally(C.detectors, d.detectors);
    if (rules.length) lines.push(`Detection rules that matched: ${rules.join(', ')}`);
    const seen = tally(C.observations, d.observations);
    if (seen.length) lines.push(`Also noticed: ${seen.join(', ')}`);
    if (d.strategy) lines.push(`Posts found by: ${label(C.strategies, d.strategy)}`);
    const errors = tally(C.errors, d.errors);
    if (errors.length) lines.push(`Errors caught: ${errors.join(', ')}`);
    const landmarks = tally(C.landmarks, d.landmarks);
    if (landmarks.length) lines.push(`Page parts counted: ${landmarks.join(', ')}`);
  }

  const c = report.correction;
  if (c) {
    const name = FEATURE_NAMES[c.feature];
    const article = /^[AEIOU]/.test(name) ? 'an' : 'a';
    const details = [`prompt version ${c.promptVersion}`, ...(c.list ? [C.lists[c.list]] : [])].join(', ');
    lines.push(`About: ${article} ${name} result (${details}), made with ${C.via[c.via]}`);
  }
  if (report.choices.length) lines.push(`Your answer: ${report.choices.map((choice) => label(C.choices, choice)).join('; ')}`);

  const p = report.post;
  if (p) {
    const evidence = p.evidence.map((e) => `${label(C.detectors, e.detector)} (${e.strength})`);
    const media = C.media[p.media];
    const parts = [
      `hidden as ${label(C.reason, p.reason)} ${C.sources[p.source]}`,
      ...(p.module ? [`panel: ${label(C.modules, p.module)}`] : []),
      `seen: ${evidence.length ? evidence.join(', ') : 'nothing recorded'}`,
      `author: ${authorPhrase(p.authorKind, p.relationship)}`,
      ...(media ? [`with ${media}`] : []),
      C.text[p.text],
    ];
    lines.push(`The post: ${parts.join('; ')}.`);
  }
  if (c && opts.words !== false) {
    if (c.message) lines.push(`In your own words: ${c.message}`);
    lines.push(c.contact ? `Reply to: ${c.contact}` : C.noContact);
  }
  return lines;
}
