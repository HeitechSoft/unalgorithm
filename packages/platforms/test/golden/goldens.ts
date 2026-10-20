import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  feed,
  GROUP_SUGGESTIONS,
  groupPost,
  labelledBy,
  PYMK,
  perCharacter,
  post,
  REELS,
  reel,
  sharedCard,
  svgText,
  VIRTUALIZED,
} from '../../fixtures/facebook/live2026.ts';
import * as fb from '../../fixtures/facebook/synthetic.ts';
import {
  ACTIVITY_FOLLOWED_AUTHOR,
  ACTIVITY_POST,
  CONNECTION_REPOST,
  EVENT_POST,
  feedHtml,
  NEW_LAYOUT_POST,
  NORMAL_POST,
  PROMOTED_POST,
  PYMK_MODULE,
  SUGGESTED_POST,
} from '../../fixtures/linkedin/legacy.ts';
import {
  COMPANY_NOT_FOLLOWED,
  FIRST_DEGREE_POST,
  FOLLOWED_BY_POST,
  FOLLOWING_POST,
  feed2026,
  HIRING_PROMO,
  JOINED_GROUP_POST,
  LIKES_GROUP_POST,
  PARTNERSHIP_AD,
  POST_WITH_COMMENTS,
  PROMOTED_FOLLOWS_PAGE,
  signedInShell,
  UNJOINED_GROUP_POST,
} from '../../fixtures/linkedin/y2026.ts';
import { facebookAdapter } from '../../src/facebook/adapter.ts';
import { linkedinAdapter } from '../../src/linkedin/adapter.ts';
import type { GoldenResult, GoldenSetup } from '../../src/testing/golden.ts';
import type { PlatformAdapter } from '../../src/types.ts';

/**
 * Every golden page (ADR 0009 §9, phase C): the anonymized captures, as committed, and synthetic pages built from the
 * fixture builders. Each has `<platform>/<name>.expect.json` next to this file: its setup (address, feed list, labels
 * put back) and what it must give. Run `GOLDEN_UPDATE=1 pnpm vitest run packages/platforms/test/golden.test.ts` to
 * rewrite the results after a deliberate change, then review the diff like code.
 */
export interface GoldenCase {
  /** `<platform>/<name>`. */
  name: string;
  adapter: PlatformAdapter;
  /** The page, read or built the first time it is asked for (a mutation worker needs only its own). */
  readonly html: string;
}

function golden(name: string, adapter: PlatformAdapter, build: () => string): GoldenCase {
  let html: string | undefined;
  return {
    name,
    adapter,
    get html() {
      html ??= build();
      return html;
    },
  };
}

/** An expect file: the setup, a note per row for the reader, and the result. */
export interface GoldenFile extends GoldenResult {
  setup: GoldenSetup;
  /** What each row is, in a few words (not checked: for whoever reviews a diff). */
  notes: string[];
}

const FIXTURES = join(import.meta.dirname, '../../fixtures');
const capture = (platform: string, file: string) => readFileSync(join(FIXTURES, platform, file), 'utf8');

export const expectPath = (name: string) => join(import.meta.dirname, `${name}.expect.json`);
export const readExpect = (name: string): GoldenFile => JSON.parse(readFileSync(expectPath(name), 'utf8')) as GoldenFile;

/**
 * A capture's fakes made its own, for a page made of captures from several runs of the capture script: since 2026-10-19
 * each run numbers its element ids (`id100001`) and the ids in its links (`/reel/100002/`) from the start, so the
 * `run`-th capture's are moved past the others'.
 */
const ownFakes = (html: string, run: number) =>
  html
    .replace(/(["#\s])(id\d{6})(?=["\s])/g, `$1$2r${run}`)
    .replace(
      /href="([^"]*)"/g,
      (_, href: string) => `href="${href.replace(/\b1\d{5}\b/g, (id) => `${Number(id) + run * 100_000}`)}"`,
    );

/** Facebook captures as one page, as the feed was scrolled: the first, with the others' items and labels. */
function facebookHome(pages: readonly string[]): string {
  const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
  const listOf = (doc: Document) => doc.querySelector('[role="main"] h3 + div + div') as Element;
  const [first, ...rest] = pages.map(parse);
  if (!first) return '';
  for (const page of rest) {
    listOf(first).append(...Array.from(listOf(page).children).map((el) => first.importNode(el, true)));
    for (const labels of Array.from(page.querySelectorAll('[data-ua-external]')))
      first.body.append(first.importNode(labels, true));
  }
  return first.body.innerHTML;
}

/**
 * The `feed-full-update` layout as a page of its own (one layout per page, as LinkedIn serves them): NEW_LAYOUT_POST
 * three times, with its id and its invented author changed.
 */
const newLayout = (urn: string, name: string, slug: string) =>
  NEW_LAYOUT_POST.replace('activity:7010', `activity:${urn}`)
    .replaceAll('Robin Chen', name)
    .replace('/in/newlayout', `/in/${slug}`);

const facebookCapture = (n: number) => capture('facebook', `2026-10-home-${n}.html`);
/** Feed items with a reel link, captured one at a time on later loads of the feed (2026-10-19, evening). */
const REEL_CAPTURES = 3;
const reelCapture = (n: number) => capture('facebook', `2026-10-reels-${n}.html`);

export const GOLDENS: readonly GoldenCase[] = [
  golden('linkedin/2026-10-foryou-1', linkedinAdapter, () => capture('linkedin', '2026-10-foryou-1.html')),
  golden('linkedin/2026-10-foryou-2', linkedinAdapter, () => capture('linkedin', '2026-10-foryou-2.html')),
  golden('linkedin/classic-2026', linkedinAdapter, () =>
    signedInShell(
      feed2026(
        FOLLOWED_BY_POST,
        PROMOTED_FOLLOWS_PAGE,
        LIKES_GROUP_POST,
        UNJOINED_GROUP_POST,
        JOINED_GROUP_POST,
        HIRING_PROMO,
        FIRST_DEGREE_POST,
        COMPANY_NOT_FOLLOWED,
        PARTNERSHIP_AD,
        FOLLOWING_POST,
        POST_WITH_COMMENTS,
      ),
    ),
  ),
  golden('linkedin/legacy', linkedinAdapter, () =>
    feedHtml(
      NORMAL_POST,
      PROMOTED_POST,
      SUGGESTED_POST,
      ACTIVITY_POST,
      ACTIVITY_FOLLOWED_AUTHOR,
      CONNECTION_REPOST,
      EVENT_POST,
      PYMK_MODULE,
    ),
  ),
  golden('linkedin/feed-full-update', linkedinAdapter, () =>
    feedHtml(
      newLayout('7010', 'Robin Chen', 'newlayout'),
      newLayout('7011', 'Casey Lin', 'casey-lin'),
      newLayout('7012', 'Drew Patel', 'drew-patel'),
    ),
  ),
  ...Array.from({ length: 9 }, (_, i) => golden(`facebook/2026-10-home-${i + 1}`, facebookAdapter, () => facebookCapture(i + 1))),
  ...Array.from({ length: REEL_CAPTURES }, (_, i) =>
    golden(`facebook/2026-10-reels-${i + 1}`, facebookAdapter, () => reelCapture(i + 1)),
  ),
  // Every 2026-10 capture of the home feed as one page: the nine of one scroll, then the reel items from later loads.
  golden('facebook/2026-10-home', facebookAdapter, () =>
    facebookHome([
      ...Array.from({ length: 9 }, (_, i) => facebookCapture(i + 1)),
      ...Array.from({ length: REEL_CAPTURES }, (_, i) => ownFakes(reelCapture(i + 1), i + 1)),
    ]),
  ),
  golden('facebook/classic-2026', facebookAdapter, () =>
    feed(
      post({ author: 'Gadget Daily', slot: svgText('SvgT1'), text: 'Six phones compared.', follow: true, menu: true }),
      post({ author: 'Shop Example', slot: svgText('SvgT2'), text: 'Autumn sale.' }),
      post({ author: 'Riley Chen', slot: perCharacter('3d'), text: 'Tomatoes, finally. Twelve of them, to be exact.' }),
      PYMK,
      post({
        author: 'Policy Watch',
        slot: svgText('SvgT1'),
        text: 'The new zoning rules take effect next month.',
        context: 'Jamie Park commented on this.',
      }),
      post({ author: 'Shop Example', slot: svgText('SvgT3'), text: 'Free shipping this week.' }),
      post({ author: 'Morgan Lee', slot: svgText('SvgT7'), text: 'First snow on the ridge this morning.', menu: true }),
      REELS,
      post({ author: 'Shop Example', slot: labelledBy('_r_1_'), text: 'Try it free for 30 days.' }),
      post({ author: 'Sam Ortiz', slot: svgText('SvgT1'), text: 'Interesting read on city transit funding.' }),
      GROUP_SUGGESTIONS,
      VIRTUALIZED,
    ),
  ),
  // Balanced's "people and pages you don't follow" (settings version 2): what it hides, and what must stay.
  golden('facebook/not-followed-2026', facebookAdapter, () => {
    const friend = { author: 'Riley Chen', slot: perCharacter('3d') };
    const age = svgText('SvgT1');
    const photo = '<div><a href="https://www.facebook.com/photo/?fbid=2026101902" role="link"><img alt="" width="500"></a></div>';
    const funny = { author: 'Funny Page', text: 'A cat that thinks it is a dog.', follow: true };
    return feed(
      post({ ...friend, text: 'Tomatoes, finally. Twelve of them, to be exact.' }),
      post({ author: 'Gadget Daily', slot: age, text: 'Six phones compared.', follow: true, menu: true }),
      post({ author: 'City Library', slot: age, text: 'Open late on Thursdays from next week.' }),
      post({ author: 'Sam Ortiz', slot: age, text: 'New photos from the coast.', follow: true }).replace(
        '<span>Follow</span>',
        '<span>Following</span>',
      ),
      groupPost({ group: 'Hiking Ontario', member: 'Alex Kim', slot: age, text: 'Meetup Saturday at 9.', follow: true }),
      groupPost({ group: 'Trail Runners', member: 'Casey Brooks', slot: age, text: 'Race report from Sunday.', join: true }),
      post({ ...friend, text: 'This made me laugh.', media: sharedCard({ ...funny, hook: true }) }),
      post({ ...friend, media: sharedCard({ ...funny, message: true }) }),
      post({ ...friend, media: reel({ creator: 'Riley Chen', caption: 'Beach day.' }) }),
      post({
        ...friend,
        text: 'Watch this.',
        media: reel({ creator: 'Trick Shots', caption: 'Ten in a row.', follow: true, id: 100002 }),
      }),
      post({ author: 'Gadget Daily', slot: age, follow: true, media: photo }),
      post({ author: 'Shop Example', slot: svgText('SvgT2'), text: 'Autumn sale.' }),
      post({ ...friend, media: sharedCard({ ...funny, plainName: true, message: true }) }),
    );
  }),
  // Reels on Balanced: a stranger's own reel (Follow in the reel, the creator at the poster's address: an inferred
  // layout, not yet captured) is folded as not followed; reels from friends, followed pages and groups the account is
  // in stay, and so does someone the account follows sharing a stranger's reel, or a same-named account's. Calm hides
  // them all.
  golden('facebook/reels-2026', facebookAdapter, () => {
    const friend = { author: 'Riley Chen', slot: perCharacter('3d') };
    const age = svgText('SvgT1');
    const stranger = (id: number, creatorHref?: string) =>
      reel({ creator: 'Trick Shots', caption: 'Ten in a row.', follow: true, id, ...(creatorHref ? { creatorHref } : {}) });
    const byId = 'https://www.facebook.com/profile.php?id=2026101977';
    // A member's own reel, linked to them as a member of the group.
    const summit = (id: number, group: string) =>
      reel({
        creator: 'Alex Kim',
        caption: 'Summit.',
        follow: true,
        id,
        creatorHref: `https://www.facebook.com/groups/${group}/user/100009/`,
      });
    return feed(
      post({ ...friend, text: 'Tomatoes, finally. Twelve of them, to be exact.' }),
      post({ author: 'Trick Shots', slot: age, media: stranger(2026101911) }),
      post({ author: 'Trick Shots', slot: age, text: 'New trick.', media: stranger(2026101912) }),
      post({ ...friend, media: reel({ creator: 'Riley Chen', caption: 'Beach day.', id: 2026101913 }) }),
      post({ ...friend, text: 'Watch this.', media: stranger(2026101914) }),
      post({ ...friend, media: stranger(2026101915, byId) }),
      post({
        author: 'City Library',
        slot: age,
        media: reel({ creator: 'City Library', caption: 'Story time.', id: 2026101916 }),
      }),
      post({ author: 'City Library', slot: age, media: stranger(2026101917, byId) }),
      groupPost({
        group: 'Hiking Ontario',
        member: 'Alex Kim',
        slot: age,
        text: 'Made it.',
        follow: true,
        media: summit(2026101918, 'hikingontario'),
      }),
      groupPost({
        group: 'Trail Runners',
        member: 'Alex Kim',
        slot: age,
        text: 'Made it.',
        join: true,
        media: summit(2026101919, 'trailrunners'),
      }),
      // The same name at another address: maybe the friend's own Page, maybe someone else. Never theirs by name alone.
      post({
        ...friend,
        text: 'My campaign page.',
        media: reel({ creator: 'Riley Chen', caption: 'Vote.', follow: true, id: 2026101920, creatorHref: byId }),
      }),
      REELS,
    );
  }),
  golden('facebook/legacy', facebookAdapter, () =>
    fb.fbFeed(
      fb.FRIEND_POST,
      fb.SUGGESTED_PAGE_POST,
      fb.SPONSORED_ARIA,
      fb.SPONSORED_LABELLEDBY,
      fb.SPONSORED_SPLIT,
      fb.SPONSORED_SVG,
      fb.SPONSORED_ADLINK,
      fb.ORGANIC_LINK_SHARE,
      fb.FRIEND_ACTIVITY,
      fb.UNJOINED_GROUP_POST,
      fb.JOINED_GROUP_POST,
      fb.FRIEND_RESHARE,
      fb.TRUNCATED_POST,
      fb.REELS_TRAY,
      fb.PYMK,
      fb.SKELETON,
    ),
  ),
];
