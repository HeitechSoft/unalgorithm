import { describe, expect, it } from 'vitest';
import { feed, post, svgText } from '../../fixtures/facebook/live2026.ts';
import {
  AD_2026,
  FRIEND_POST,
  FRIEND_POST_2026,
  fbBanner,
  fbCheckpoint,
  fbFeed,
  fbFeed2026,
  fbLoggedOut,
} from '../../fixtures/facebook/synthetic.ts';
import { facebookAdapter } from '../../src/facebook/adapter.ts';
import { classifyFacebookRoute } from '../../src/facebook/routes.ts';
import { reportRouteOf, routeOf } from '../../src/shared/route.ts';

const at = (path: string, host = 'www.facebook.com') => new URL(`https://${host}${path}`);

describe('Facebook routes (ADR 0009 §3)', () => {
  it.each([
    ['/', 'feed'],
    ['/home.php', 'feed'],
    ['/?sk=h_chr', 'feed'],
    ['/?filter=all&sk=h_chr', 'feed'],
    ['/home.php?sk=h_nor', 'feed'],
    ['/home', 'feed-candidate'],
    ['/home/', 'feed-candidate'],
    ['/feed', 'feed-candidate'],
    ['/feed/x', 'feed-candidate'],
    ['/feeds/', 'feed-candidate'],
    ['/feeds/h_chr', 'feed-candidate'],
    ['/feed/x/y', 'not-feed'],
    ['/feed/Latest', 'not-feed'],
    ['/feed/123', 'not-feed'],
    ['/janedoe', 'not-feed'],
    ['/profile.php', 'not-feed'],
    ['/groups/1', 'not-feed'],
    ['/groups/feed/', 'not-feed'],
    ['/watch', 'not-feed'],
    ['/watch/?ref=tab', 'not-feed'],
    ['/marketplace/toronto', 'not-feed'],
    ['/pages/Some-Page/1', 'not-feed'],
    ['/reel/100000/', 'not-feed'],
    ['/home.php/', 'not-feed'],
  ])('%s is %s', (path, route) => {
    expect(classifyFacebookRoute(at(path))).toBe(route);
  });

  it("checks the host exactly: Facebook's own hosts only", () => {
    expect(classifyFacebookRoute(at('/', 'facebook.com'))).toBe('feed');
    expect(classifyFacebookRoute(at('/', 'web.facebook.com'))).toBe('feed');
    for (const host of [
      'evilfacebook.com',
      'facebook.com.example.org',
      'l.facebook.com',
      'developers.facebook.com',
      'www.linkedin.com',
    ])
      expect(classifyFacebookRoute(at('/', host)), host).toBe('not-feed');
  });

  it('keeps isFeedPage as "the route is the feed", and reports candidates in the wire\'s words', () => {
    for (const path of ['/', '/home.php', '/?sk=h_chr', '/home', '/feed/x', '/janedoe']) {
      const url = at(path);
      expect(facebookAdapter.isFeedPage(url), path).toBe(classifyFacebookRoute(url) === 'feed');
      expect(routeOf(facebookAdapter, url)).toBe(classifyFacebookRoute(url));
    }
    expect(reportRouteOf(facebookAdapter, at('/?sk=h_chr'))).toEqual({ route: 'feed' });
    expect(reportRouteOf(facebookAdapter, at('/feeds/friends/'))).toEqual({ route: 'feed-candidate', feedWord: 'friends' });
    // A candidate whose word doesn't fit the wire is still reported, without the word.
    expect(reportRouteOf(facebookAdapter, at('/feeds/h_chr'))).toEqual({ route: 'feed-candidate' });
    expect(reportRouteOf(facebookAdapter, at('/janedoe'))).toEqual({ route: 'other' });
  });
});

describe('Facebook home signature', () => {
  it('is strong with the Home tab current and the feed list, in either layout', () => {
    for (const html of [fbFeed2026(FRIEND_POST_2026, AD_2026), fbFeed(FRIEND_POST)]) {
      document.body.innerHTML = html;
      expect(facebookAdapter.homeSignature?.(document)).toBe('strong');
    }
  });

  it('accepts a current tab named Home whatever its address, and an absolute link to /', () => {
    document.body.innerHTML = fbFeed2026(FRIEND_POST_2026).replace(
      'aria-label="Home" href="/"',
      'aria-label="Home" href="?ref=bookmarks"',
    );
    expect(facebookAdapter.homeSignature?.(document)).toBe('strong');
    document.body.innerHTML = fbFeed2026(FRIEND_POST_2026).replace(
      'aria-label="Home" href="/"',
      'aria-label="Accueil" href="https://www.facebook.com/"',
    );
    expect(facebookAdapter.homeSignature?.(document)).toBe('strong');
  });

  it('is weak with the feed list but no current Home tab, and finds 3 posts without the heading', () => {
    document.body.innerHTML = fbFeed2026(FRIEND_POST_2026).replace(fbBanner(), fbBanner(null));
    expect(facebookAdapter.homeSignature?.(document)).toBe('weak');
    const three = feed(
      post({ author: 'Riley Chen', slot: svgText('SvgT1'), text: 'One.' }),
      post({ author: 'Sam Ortiz', slot: svgText('SvgT1'), text: 'Two.' }),
      post({ author: 'Morgan Lee', slot: svgText('SvgT1'), text: 'Three.' }),
    ).replace('<h3>Feed posts</h3>', '');
    document.body.innerHTML = three.replace(fbBanner(), fbBanner(null));
    expect(facebookAdapter.homeSignature?.(document)).toBe('weak');
  });

  it('is null without a feed list, even with the Home tab current', () => {
    document.body.innerHTML = `${fbBanner()}<div role="main"><div><h2>Riley Chen</h2><div>Photos</div></div></div>`;
    expect(facebookAdapter.homeSignature?.(document)).toBeNull();
    document.body.innerHTML = fbLoggedOut();
    expect(facebookAdapter.homeSignature?.(document)).toBeNull();
  });
});

describe('Facebook signed-in shell', () => {
  it('is signed in with the top bar linking to the app, in any language', () => {
    document.body.innerHTML = fbFeed2026(FRIEND_POST_2026);
    expect(facebookAdapter.signedIn?.(document)).toBe(true);
    document.body.innerHTML = fbFeed2026(FRIEND_POST_2026).replaceAll(
      /aria-label="(Home|Video|Marketplace|Groups)"/g,
      'aria-label="x"',
    );
    expect(facebookAdapter.signedIn?.(document)).toBe(true);
    // A page with no feed yet, still signed in: a missing feed there is breakage.
    document.body.innerHTML = `${fbBanner(null)}<div role="main"></div>`;
    expect(facebookAdapter.signedIn?.(document)).toBe(true);
  });

  it('is not signed in on the logged-out page, a checkpoint or a cookie wall', () => {
    document.body.innerHTML = fbLoggedOut();
    expect(facebookAdapter.signedIn?.(document)).toBe(false);
    document.body.innerHTML = fbCheckpoint();
    expect(facebookAdapter.signedIn?.(document)).toBe(false);
    // The cookie wall is a dialog over the logged-out page.
    document.body.innerHTML = `${fbLoggedOut()}<div role="dialog" aria-modal="true"><h2>Allow the use of cookies?</h2><div role="button">Allow all cookies</div></div>`;
    expect(facebookAdapter.signedIn?.(document)).toBe(false);
    // Even a page that somehow shows the app's links asks for a password when signed out.
    document.body.innerHTML = `${fbBanner()}${fbLoggedOut()}`;
    expect(facebookAdapter.signedIn?.(document)).toBe(false);
  });

  it('counts the landmarks the route checks use in probe()', () => {
    document.body.innerHTML = fbFeed2026(FRIEND_POST_2026);
    const scope = facebookAdapter.feedScope(document);
    expect(facebookAdapter.probe(document, scope)).toMatchObject({ homeNav: 1, signedIn: 1, lists: 1, items: 1 });
    document.body.innerHTML = fbLoggedOut();
    expect(facebookAdapter.probe(document, null)).toMatchObject({ homeNav: 0, signedIn: 0, lists: 0, items: 0 });
  });
});
