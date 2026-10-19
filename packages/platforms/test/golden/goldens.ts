import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  feed,
  GROUP_SUGGESTIONS,
  labelledBy,
  PYMK,
  perCharacter,
  post,
  REELS,
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

/** The nine Facebook captures as one page, as the feed was scrolled: the first, with the others' items and labels. */
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
  golden('facebook/2026-10-home', facebookAdapter, () =>
    facebookHome(Array.from({ length: 9 }, (_, i) => facebookCapture(i + 1))),
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
