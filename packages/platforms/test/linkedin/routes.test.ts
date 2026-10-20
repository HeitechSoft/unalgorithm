import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DETECTOR_IDS, LANDMARK_KEYS, OBSERVATION_IDS, STRATEGY_IDS } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import * as legacy from '../../fixtures/linkedin/legacy.ts';
import { feedHtml } from '../../fixtures/linkedin/legacy.ts';
import * as y2026 from '../../fixtures/linkedin/y2026.ts';
import {
  FIRST_DEGREE_POST,
  FOLLOWED_BY_POST,
  feed2026,
  guestShell,
  PROFILE_PAGE,
  PROMOTED_FOLLOWS_PAGE,
  signedInShell,
} from '../../fixtures/linkedin/y2026.ts';
import { linkedinAdapter } from '../../src/linkedin/adapter.ts';
import { LINKEDIN_STRATEGIES } from '../../src/linkedin/discover.ts';
import { LINKEDIN_IDS } from '../../src/linkedin/ids.ts';
import { classifyLinkedInRoute, linkedinHomeSignature, linkedinSignedIn } from '../../src/linkedin/routes.ts';
import { reportRouteOf } from '../../src/shared/route.ts';

const at = (address: string) => new URL(address, 'https://www.linkedin.com');
const capture = (file: string) => readFileSync(join(import.meta.dirname, '../../fixtures/linkedin', file), 'utf8');

/** Load `html` as the whole page body and return the document. */
function page(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

describe('LinkedIn routes (ADR 0009 §3)', () => {
  it('classes each address as the feed, a candidate or not the feed', () => {
    const table: Array<[string, string]> = [
      ['/feed/', 'feed'],
      ['/feed', 'feed'],
      ['/feed/?sortBy=RECENT', 'feed'],
      ['/feed/foryou/', 'feed'],
      ['/feed/foryou', 'feed'],
      // Where the feed might move next: LinkedIn's own words for a feed, never a person or a post.
      ['/', 'feed-candidate'],
      ['/feed/latest/', 'feed-candidate'],
      ['/feed/following-feed/', 'feed-candidate'],
      ['/home/', 'feed-candidate'],
      ['/home', 'feed-candidate'],
      ['/home/foryou/', 'feed-candidate'],
      ['/feed/update/urn:li:activity:1/', 'not-feed'],
      ['/feed/update/', 'not-feed'],
      ['/feed/hashtag/x/', 'not-feed'],
      ['/feed/hashtag/', 'not-feed'],
      ['/feed/following/', 'not-feed'],
      ['/feed/followers/', 'not-feed'],
      ['/feed/saved/', 'not-feed'],
      ['/feed/news/', 'not-feed'],
      ['/feed/foryou/x/', 'not-feed'],
      ['/feed/Latest/', 'not-feed'],
      ['/feed/x/', 'not-feed'],
      ['/feedback/', 'not-feed'],
      ['/in/jane-doe/', 'not-feed'],
      ['/company/x/', 'not-feed'],
      ['/groups/123/', 'not-feed'],
      ['/jobs/', 'not-feed'],
      ['/mynetwork/', 'not-feed'],
    ];
    for (const [path, route] of table) expect(classifyLinkedInRoute(at(path)), path).toBe(route);
  });

  it('checks the host exactly', () => {
    expect(classifyLinkedInRoute(new URL('https://linkedin.com/feed/'))).toBe('feed');
    expect(classifyLinkedInRoute(new URL('https://ca.linkedin.com/feed/'))).toBe('feed');
    for (const host of ['notlinkedin.com', 'linkedin.com.example.org', 'www.linkedin.co', 'example.com'])
      expect(classifyLinkedInRoute(new URL(`https://${host}/feed/`)), host).toBe('not-feed');
  });

  it('wires the routes into the adapter: isFeedPage is the feed class, and reports carry only a feed word', () => {
    expect(linkedinAdapter.classifyRoute).toBe(classifyLinkedInRoute);
    expect(linkedinAdapter.isFeedPage(at('/feed/foryou/'))).toBe(true);
    expect(linkedinAdapter.isFeedPage(at('/feed/latest/'))).toBe(false);
    expect(linkedinAdapter.isFeedPage(new URL('https://notlinkedin.com/feed/'))).toBe(false);
    expect(reportRouteOf(linkedinAdapter, at('/feed/latest/?trk=x'))).toEqual({ route: 'feed-candidate', feedWord: 'latest' });
    expect(reportRouteOf(linkedinAdapter, at('/'))).toEqual({ route: 'feed-candidate' });
    expect(reportRouteOf(linkedinAdapter, at('/feed/foryou/'))).toEqual({ route: 'feed' });
    expect(reportRouteOf(linkedinAdapter, at('/in/jane-doe/'))).toEqual({ route: 'other' });
  });
});

describe('home signature', () => {
  it('is strong on the "For you" captures, which have the main feed list', () => {
    for (const file of ['2026-10-foryou-1.html', '2026-10-foryou-2.html'])
      expect(linkedinHomeSignature(page(capture(file))), file).toBe('strong');
  });

  it('is strong on a card keyed for the main feed even without the feed list', () => {
    const keyed = FOLLOWED_BY_POST.replace('focusAAAkeyFollowedBy01', 'focusAAAkeyFollowedBy01FeedType_MAIN_FEED_RELEVANCE');
    expect(linkedinHomeSignature(page(`<main><div>${keyed}</div></main>`))).toBe('strong');
    // Another feed's sort is not the home feed.
    const other = FOLLOWED_BY_POST.replace('focusAAAkeyFollowedBy01', 'focusAAAkeyFollowedBy01FeedType_HASHTAG');
    expect(linkedinHomeSignature(page(`<main><div>${other}</div></main>`))).toBeNull();
  });

  it('is weak for a list of posts without the main feed markers, and null on a profile', () => {
    const list = `<main><div>${FOLLOWED_BY_POST}${PROMOTED_FOLLOWS_PAGE}${FIRST_DEGREE_POST}</div></main>`;
    expect(linkedinHomeSignature(page(list))).toBe('weak');
    expect(linkedinHomeSignature(page(signedInShell(PROFILE_PAGE)))).toBeNull();
    expect(linkedinHomeSignature(page(guestShell('<main><h1>Welcome to your professional community</h1></main>')))).toBeNull();
  });
});

describe('signed-in shell', () => {
  it("finds LinkedIn's global navigation by where its links go", () => {
    expect(linkedinSignedIn(page(signedInShell(feed2026(FIRST_DEGREE_POST))))).toBe(true);
    expect(linkedinSignedIn(page(signedInShell(PROFILE_PAGE)))).toBe(true);
    // Relative links and any language work the same.
    const relative = '<nav><a href="/mynetwork/">Mon réseau</a><a href="/messaging/">Messagerie</a></nav><main></main>';
    expect(linkedinSignedIn(page(relative))).toBe(true);
  });

  it('is false on the guest pages, a sign-in page and a bare feed', () => {
    expect(linkedinSignedIn(page(guestShell('<main><form><input type="email"></form></main>')))).toBe(false);
    expect(linkedinSignedIn(page(feed2026(FIRST_DEGREE_POST)))).toBe(false);
    // Links inside the page's main content (a profile's Message button) are not the navigation.
    expect(linkedinSignedIn(page(PROFILE_PAGE))).toBe(false);
    // One section alone, or links to another site, are not enough.
    expect(linkedinSignedIn(page('<nav><a href="/messaging/">Messaging</a></nav>'))).toBe(false);
    expect(
      linkedinSignedIn(
        page('<nav><a href="https://example.com/mynetwork/">a</a><a href="https://example.com/messaging/">b</a></nav>'),
      ),
    ).toBe(false);
  });

  it('adds the signed-in shell to the landmark counts', () => {
    const doc = page(signedInShell(feed2026(FIRST_DEGREE_POST)));
    expect(linkedinAdapter.probe(doc, linkedinAdapter.feedScope(doc))).toMatchObject({ signedIn: 1, feedList: 1, postRoots: 1 });
    const bare = page(feed2026(FIRST_DEGREE_POST));
    expect(linkedinAdapter.probe(bare, linkedinAdapter.feedScope(bare))).toMatchObject({ signedIn: 0 });
  });
});

describe('ids', () => {
  it('lists only ids the protocol registry knows, and the adapter carries them', () => {
    expect(linkedinAdapter.ids).toBe(LINKEDIN_IDS);
    for (const id of LINKEDIN_IDS.detectors) expect(DETECTOR_IDS as readonly string[], id).toContain(id);
    for (const id of LINKEDIN_IDS.observations) expect(OBSERVATION_IDS, id).toContain(id);
    for (const id of LINKEDIN_IDS.strategies) expect(STRATEGY_IDS as readonly string[], id).toContain(id);
    for (const key of LINKEDIN_IDS.landmarks) expect(LANDMARK_KEYS as readonly string[], key).toContain(key);
    for (const id of [...LINKEDIN_IDS.detectors, ...LINKEDIN_IDS.observations, ...LINKEDIN_IDS.strategies])
      expect(id.startsWith('li.'), id).toBe(true);
  });

  it('lists every landmark probe returns', () => {
    const doc = page(signedInShell(feed2026(FIRST_DEGREE_POST)));
    expect(Object.keys(linkedinAdapter.probe(doc, linkedinAdapter.feedScope(doc))).sort()).toEqual(
      [...LINKEDIN_IDS.landmarks].sort(),
    );
  });

  it('lists the discovery strategies in their order', () => {
    expect([...LINKEDIN_IDS.strategies]).toEqual([...LINKEDIN_STRATEGIES]);
  });

  it('emits only listed ids on every fixture, healthy or mutated', { timeout: 30_000 }, () => {
    const pages = [
      feed2026(
        ...Object.values(y2026).filter((v): v is string => typeof v === 'string' && v.startsWith('<div data-lazy-mount-id')),
      ),
      feedHtml(...Object.values(legacy).filter((v): v is string => typeof v === 'string')),
      capture('2026-10-foryou-1.html'),
      capture('2026-10-foryou-2.html').replaceAll('componentkey="update-card-focus', 'componentkey="feed-unit-focus'),
    ];
    const seen = { detectors: new Set<string>(), observations: new Set<string>() };
    for (const html of pages) {
      const doc = page(html);
      const scope = linkedinAdapter.feedScope(doc) as HTMLElement;
      for (const el of linkedinAdapter.findItems(scope)) {
        const r = linkedinAdapter.inspect(el, { markers: linkedinAdapter.markersFor('en'), now: new Date(2026, 9, 19) });
        if (r.kind === 'pending') continue;
        for (const o of r.observations ?? []) seen.observations.add(o);
        if (r.kind === 'post') for (const e of r.post.evidence) seen.detectors.add(e.detector);
      }
      expect(LINKEDIN_IDS.strategies as readonly string[]).toContain(linkedinAdapter.discovery?.()?.strategy);
    }
    for (const id of seen.detectors) expect(LINKEDIN_IDS.detectors as readonly string[], id).toContain(id);
    for (const id of seen.observations) expect(LINKEDIN_IDS.observations as readonly string[], id).toContain(id);
    expect(seen.detectors.size).toBeGreaterThan(5);
  });

  it('has a detection version newer than 0.3.1 shipped (linkedin@2026.10.1)', () => {
    expect(linkedinAdapter.version).toBe('linkedin@2026.10.2');
  });
});
