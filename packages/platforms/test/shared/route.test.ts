import { FeedWordSchema } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import {
  facebookAdapter,
  linkedinAdapter,
  type PlatformAdapter,
  type RouteClass,
  reportRouteOf,
  routeOf,
  routeWord,
} from '../../src/index.ts';

const url = (path: string) => new URL(path, 'https://www.linkedin.com');
type Routing = Pick<PlatformAdapter, 'classifyRoute' | 'isFeedPage'>;

/** An adapter that classes /feed/ as the feed and /feed/<word>/ as a candidate. */
const classifying: Routing = {
  isFeedPage: (u) => u.pathname === '/feed/',
  classifyRoute: (u): RouteClass =>
    u.pathname === '/feed/' ? 'feed' : routeWord(u, { prefixes: ['/feed/'], deny: ['saved'] }) ? 'feed-candidate' : 'not-feed',
};

describe('routeOf', () => {
  it('test_uses_classify_route_or_is_feed_page', () => {
    expect(routeOf(classifying, url('/feed/'))).toBe('feed');
    expect(routeOf(classifying, url('/feed/latest/'))).toBe('feed-candidate');
    expect(routeOf(classifying, url('/in/jane-doe/'))).toBe('not-feed');
    // Without classifyRoute, isFeedPage decides, and nothing is ever a candidate.
    const old: Routing = { isFeedPage: (u) => u.pathname === '/feed/' };
    expect(routeOf(old, url('/feed/'))).toBe('feed');
    expect(routeOf(old, url('/feed/latest/'))).toBe('not-feed');
  });

  it('test_a_throwing_adapter_is_not_the_feed', () => {
    const broken: Routing = {
      isFeedPage: () => true,
      classifyRoute: () => {
        throw new Error('selector broke');
      },
    };
    expect(routeOf(broken, url('/feed/'))).toBe('not-feed');
    expect(
      routeOf(
        {
          isFeedPage: () => {
            throw new Error('x');
          },
        },
        url('/feed/'),
      ),
    ).toBe('not-feed');
  });

  it('test_shipped_adapters_know_their_feed', () => {
    expect(routeOf(linkedinAdapter, new URL('https://www.linkedin.com/feed/'))).toBe('feed');
    expect(routeOf(linkedinAdapter, new URL('https://www.linkedin.com/in/jane-doe-123/'))).toBe('not-feed');
    expect(routeOf(facebookAdapter, new URL('https://www.facebook.com/'))).toBe('feed');
    expect(routeOf(facebookAdapter, new URL('https://www.facebook.com/groups/123/'))).toBe('not-feed');
  });

  it('test_report_route', () => {
    expect(reportRouteOf(classifying, url('/feed/'))).toEqual({ route: 'feed' });
    expect(reportRouteOf(classifying, url('/feed/foryou/?trk=nav#top'))).toEqual({ route: 'feed-candidate', feedWord: 'foryou' });
    expect(reportRouteOf(classifying, url('/in/jane-doe-123/'))).toEqual({ route: 'other' });
    // A candidate whose word the wire won't carry is still a candidate, without the word.
    const loose: Routing = { isFeedPage: () => false, classifyRoute: () => 'feed-candidate' };
    expect(reportRouteOf(loose, url('/'))).toEqual({ route: 'feed-candidate' });
    expect(reportRouteOf(loose, url('/feed/news/'))).toEqual({ route: 'feed-candidate' });
    expect(reportRouteOf(loose, url('/in/jane-doe/'))).toEqual({ route: 'feed-candidate' });
  });
});

describe('routeWord', () => {
  it('test_words_of_candidate_addresses', () => {
    expect(routeWord(url('/feed/foryou/'))).toBe('foryou');
    expect(routeWord(url('/feed/foryou'))).toBe('foryou');
    expect(routeWord(url('/feed/new-name2/'))).toBe('new-name2');
    expect(routeWord(url('/home/'))).toBe('home');
    expect(routeWord(url('/home/latest/'))).toBe('latest');
    expect(routeWord(new URL('https://www.facebook.com/feeds/friends'))).toBe('friends');
    expect(routeWord(new URL('https://www.facebook.com/home'))).toBe('home');
    // Only the path counts: never the query or the fragment.
    expect(routeWord(url('/feed/foryou/?highlightedUpdateUrns=urn%3Ali%3Aactivity%3A1#jane'))).toBe('foryou');
    expect(routeWord('https://www.linkedin.com/feed/foryou/')).toBe('foryou');
  });

  it('test_no_word_for_people_posts_or_deep_paths', () => {
    for (const path of [
      '/',
      '/feed/update/urn:li:activity:7381234567890123456/',
      '/feed/update/',
      '/feed/hashtag/',
      '/feed/hashtag/ai/',
      '/feed/following/',
      '/feed/saved/',
      '/feed/news/',
      '/in/jane-doe-123/',
      '/in/jane-doe-123',
      '/company/acme/',
      '/groups/123/',
      '/jane.doe',
      '/feed/ForYou/',
      '/feed/a/',
      `/feed/a${'b'.repeat(25)}/`,
      '/feed/jane_doe/',
      '/feed/2026/',
      '/home.php',
      '/feed/foryou/more/',
    ]) {
      expect(routeWord(url(path)), path).toBeUndefined();
    }
    expect(routeWord(url(`/feed/a${'b'.repeat(24)}/`))).toBe(`a${'b'.repeat(24)}`);
    expect(routeWord('not a url')).toBeUndefined();
  });

  it('test_prefixes_and_deny', () => {
    expect(routeWord(url('/home/latest/'), { prefixes: ['/feed/'] })).toBeUndefined();
    expect(routeWord(url('/feed/latest/'), { prefixes: ['feed'] })).toBe('latest');
    expect(routeWord(url('/feed/latest/'), { deny: ['latest'] })).toBeUndefined();
    // The wire's deny list applies whatever the adapter passes.
    expect(routeWord(url('/feed/update/'), { prefixes: ['/feed/'], deny: [] })).toBeUndefined();
  });

  it('test_every_word_fits_the_wire', () => {
    const paths = ['/feed/foryou/', '/home/', '/home/x1/', '/feeds/friends/', '/feed/new-name2/', '/feed/latest'];
    for (const path of paths) {
      const word = routeWord(url(path));
      expect(word, path).toBeDefined();
      expect(FeedWordSchema.safeParse(word).success, path).toBe(true);
    }
  });
});
