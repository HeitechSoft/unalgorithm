import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyPreset, defaultSettings, type PostData, ruleFilter } from '@unalgorithm/core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  feed,
  groupPost,
  perCharacter,
  post,
  type ReelOptions,
  reel,
  type SharedOptions,
  sharedCard,
  svgText,
} from '../../fixtures/facebook/live2026.ts';
import * as legacy from '../../fixtures/facebook/synthetic.ts';
import { facebookAdapter } from '../../src/facebook/adapter.ts';
import { FACEBOOK_EN } from '../../src/facebook/markers/en.ts';

/**
 * "People and pages you don't follow" in Balanced (settings version 2). On the live feed a Follow button in the post's
 * own header meant the account doesn't follow its author, in 45 of 45 items; friends and followed pages show none. These
 * are the posts that must stay whatever else they hold: a friend's post, a followed page or person, a group the account
 * is in, a friend sharing a page's post or reel, a friend's reel. A stranger's own reel is expected to have its Follow
 * button in the reel, after the creator's name, and none in the header (inferred from the captured reel shares; none
 * has been captured): it counts there only when the creator is the post's author, by profile address when both have one.
 */
const ctx = { markers: FACEBOOK_EN, now: new Date(2026, 9, 19) };
const balanced = defaultSettings().platforms.facebook;
const light = applyPreset('facebook', balanced, 'light');
const calm = applyPreset('facebook', balanced, 'calm');

function read(html: string, page: (...items: string[]) => string = feed): PostData {
  document.body.innerHTML = page(html);
  const scope = facebookAdapter.feedScope(document) as HTMLElement;
  const [el, ...rest] = facebookAdapter.findItems(scope);
  expect(rest).toHaveLength(0);
  const r = facebookAdapter.inspect(el as HTMLElement, ctx);
  if (r.kind !== 'post') throw new Error(`expected a post, got ${r.kind}`);
  return r.post;
}

/** The decision on Light, Balanced and Calm, and the relationship read: `show/unknown`, `not-followed/not-followed`. */
function decisions(p: PostData): string[] {
  return [light, balanced, calm].map((ps) => `${ruleFilter(p, ps)?.reason ?? 'show'}/${p.author.relationship}`);
}

const AGE = svgText('SvgT1');
const friend = (o: Partial<Parameters<typeof post>[0]> = {}) => ({
  author: 'Riley Chen',
  slot: perCharacter('3d'),
  text: 'Tomatoes, finally.',
  ...o,
});

describe('Facebook: people and pages you don’t follow, on Balanced', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en';
  });

  it('folds a page or person shown with a Follow button in the post’s header, on Balanced and Calm only', () => {
    for (const html of [
      post({ author: 'Gadget Daily', slot: AGE, text: 'Six phones compared.', follow: true }),
      post({
        author: 'Gadget Daily',
        slot: AGE,
        follow: true,
        media: '<div><a href="https://www.facebook.com/photo/?fbid=1"><img width="500"></a></div>',
      }),
      post({ author: 'Gadget Daily', slot: AGE, text: 'Six phones compared.', follow: true }).replace(
        '<div role="button" tabindex="0"><span>Follow</span></div>',
        '<div aria-label="Follow Gadget Daily" role="button" tabindex="0"><span>+ Follow</span></div>',
      ),
    ]) {
      const p = read(html);
      expect(p.evidence).toContainEqual({ signal: 'relationship', detector: 'fb.follow-button', strength: 'strong' });
      expect(decisions(p)).toEqual(['show/not-followed', 'not-followed/not-followed', 'not-followed/not-followed']);
    }
    expect(decisions(read(legacy.FOLLOW_PAGE_2026, legacy.fbFeed2026))).toEqual([
      'show/not-followed',
      'not-followed/not-followed',
      'not-followed/not-followed',
    ]);
  });

  it('keeps friends’ posts: no Follow button, whatever the post holds', () => {
    for (const html of [
      post(friend()),
      // Text that reads like a header line or a label.
      post(friend({ text: 'Follow us on our trip! Riley commented on this. Sponsored by nobody.' })),
      // A photo with no message box, so the header is found by structure.
      post(
        friend({ text: undefined, media: '<div><a href="https://www.facebook.com/photo/?fbid=2"><img width="500"></a></div>' }),
      ),
      // A link to a page in the text, and a link card after it.
      post(
        friend({
          text: 'Thanks <a href="https://www.facebook.com/gadgetdaily">Gadget Daily</a> for the tips.',
          media:
            '<a href="https://l.facebook.com/l.php?u=https%3A%2F%2Fnews.example.com%2F"><span>news.example.com</span><span>Follow the story</span></a>',
        }),
      ),
    ]) {
      expect(decisions(read(html))).toEqual(['show/unknown', 'show/unknown', 'show/unknown']);
    }
    for (const html of [legacy.FRIEND_POST, legacy.TRUNCATED_POST]) {
      expect(decisions(read(html, legacy.fbFeed))).toEqual(['show/unknown', 'show/unknown', 'show/unknown']);
    }
    expect(decisions(read(legacy.FRIEND_POST_2026, legacy.fbFeed2026))).toEqual(['show/unknown', 'show/unknown', 'show/unknown']);
  });

  it('keeps followed pages and people you follow without being friends: no Follow button, or "Following"', () => {
    const followed = post({ author: 'City Library', slot: AGE, text: 'Open late on Thursdays.' });
    const following = post({ author: 'Sam Ortiz', slot: AGE, text: 'New photos from the coast.', follow: true }).replace(
      '<span>Follow</span>',
      '<span>Following</span>',
    );
    for (const html of [followed, following]) {
      expect(decisions(read(html))).toEqual(['show/unknown', 'show/unknown', 'show/unknown']);
    }
  });

  it('keeps posts from groups the account is in, even with a Follow button after the member', () => {
    for (const follow of [false, true]) {
      const p = read(
        groupPost({ group: 'Hiking Ontario', member: 'Alex Kim', slot: AGE, text: 'Meetup Saturday at 9.', follow }),
      );
      expect(p.group?.joined).toBe(true);
      expect(p.evidence.map((e) => e.detector)).not.toContain('fb.follow-button');
      expect(decisions(p)).toEqual(['show/unknown', 'show/unknown', 'show/unknown']);
    }
    // Groups it isn't in fold as such, on Balanced: never as "not followed".
    const unjoined = read(
      groupPost({ group: 'Hiking Ontario', member: 'Alex Kim', slot: AGE, text: 'Trail report.', join: true }),
    );
    expect(decisions(unjoined)).toEqual(['show/unknown', 'unjoined-group/unknown', 'unjoined-group/unknown']);
    for (const html of [legacy.JOINED_GROUP_POST, legacy.JOINED_GROUP_MEMBER_FOLLOW]) {
      expect(decisions(read(html, legacy.fbFeed))).toEqual(['show/unknown', 'show/unknown', 'show/unknown']);
    }
  });

  describe('keeps a friend’s share of a post from a page the account doesn’t follow', () => {
    const shared = (o: Partial<SharedOptions> = {}): SharedOptions => ({
      author: 'Funny Page',
      text: 'A cat that thinks it is a dog.',
      follow: true,
      ...o,
    });
    const cases: [string, string][] = [
      [
        'with their own words, the shared post named by Facebook’s hook',
        post(friend({ text: 'This made me laugh.', media: sharedCard(shared({ hook: true })) })),
      ],
      [
        'with their own words, the shared post’s name a plain heading',
        post(friend({ text: 'This made me laugh.', media: sharedCard(shared()) })),
      ],
      [
        'without words of their own, hook',
        post(friend({ text: undefined, media: sharedCard(shared({ hook: true, message: true })) })),
      ],
      [
        'without words of their own, plain heading',
        post(friend({ text: undefined, media: sharedCard(shared({ message: true })) })),
      ],
      ['without words of their own, plain heading and text', post(friend({ text: undefined, media: sharedCard(shared()) }))],
      // The shared post's name a plain link, not a heading: its picture and its name both name someone else.
      [
        'with their own words, the shared post’s name a plain link',
        post(friend({ text: 'This made me laugh.', media: sharedCard(shared({ plainName: true })) })),
      ],
      [
        'without words of their own, plain link and Facebook’s message box',
        post(friend({ text: undefined, media: sharedCard(shared({ plainName: true, message: true })) })),
      ],
      [
        'without words of their own, plain link with the hook, and the message box',
        post(friend({ text: undefined, media: sharedCard(shared({ plainName: true, hook: true, message: true })) })),
      ],
      [
        'without words of their own, plain link and no picture, and the message box',
        post(friend({ text: undefined, media: sharedCard(shared({ plainName: true, picture: false, message: true })) })),
      ],
      [
        'without words of their own, a heading and no picture, and the message box',
        post(friend({ text: undefined, media: sharedCard(shared({ picture: false, message: true })) })),
      ],
    ];

    it.each(cases)('%s', (_name, html) => {
      const p = read(html);
      expect(p.author.name).toBe('Riley Chen');
      expect(p.evidence.map((e) => e.detector)).not.toContain('fb.follow-button');
      expect(decisions(p).slice(0, 2)).toEqual(['show/unknown', 'show/unknown']);
    });

    it('in the older layout too', () => {
      const p = read(legacy.FRIEND_RESHARE, legacy.fbFeed);
      expect(decisions(p)).toEqual(['show/unknown', 'show/unknown', 'reshare/unknown']);
    });
  });

  it('keeps friends’ reels, their own or shared from someone the account doesn’t follow, until Calm', () => {
    const own = post(friend({ text: undefined, media: reel({ creator: 'Riley Chen', caption: 'Beach day.' }) }));
    const shared = post(
      friend({ text: 'Watch this.', media: reel({ creator: 'Trick Shots', caption: 'Ten in a row.', follow: true }) }),
    );
    const sharedBare = post(
      friend({ text: undefined, media: reel({ creator: 'Trick Shots', caption: 'Ten in a row.', follow: true }) }),
    );
    for (const html of [own, shared, sharedBare]) {
      const p = read(html);
      expect(p.media).toBe('reel');
      expect(decisions(p)).toEqual(['show/unknown', 'show/unknown', 'reel/unknown']);
    }
  });

  describe('reels: folds a stranger’s own reel, never someone else’s reel shared by an account the person follows', () => {
    /** "Follow" in the reel, after the creator's name: Facebook shows none next to the author's name on a reel post. */
    const stranger = (o: Partial<ReelOptions> = {}) =>
      reel({ creator: 'Trick Shots', caption: 'Ten in a row.', follow: true, id: 100003, ...o });
    const NOT_FOLLOWED = ['show/not-followed', 'not-followed/not-followed', 'reel/not-followed'];
    const SHOWN = ['show/unknown', 'show/unknown', 'reel/unknown'];

    it.each<[string, string]>([
      ['without words', post({ author: 'Trick Shots', slot: AGE, media: stranger() })],
      ['with words of their own', post({ author: 'Trick Shots', slot: AGE, text: 'New trick.', media: stranger() })],
      // The same profile address under a longer name in the reel.
      [
        'its profile named differently in the reel',
        post({
          author: 'Trick Shots',
          slot: AGE,
          media: stranger({ creator: 'Trick Shots Official', creatorHref: 'https://www.facebook.com/trickshots/' }),
        }),
      ],
      [
        '"+ Follow" in the reel, named for the creator',
        post({ author: 'Trick Shots', slot: AGE, media: stranger() }).replace('>Follow</div>', '>+ Follow</div>'),
      ],
    ])('a stranger’s reel, %s: not followed, folded on Balanced', (_name, html) => {
      const p = read(html);
      expect(p.author.name).toBe('Trick Shots');
      expect(p.media).toBe('reel');
      expect(p.evidence).toContainEqual({ signal: 'relationship', detector: 'fb.follow-button', strength: 'strong' });
      expect(decisions(p)).toEqual(NOT_FOLLOWED);
    });

    it.each<[string, string]>([
      ['a friend’s own reel', post(friend({ text: undefined, media: reel({ creator: 'Riley Chen', caption: 'Beach day.' }) }))],
      ['a friend sharing a stranger’s reel, with words of their own', post(friend({ text: 'Watch this.', media: stranger() }))],
      ['a friend sharing a stranger’s reel, without words', post(friend({ text: undefined, media: stranger() }))],
      // As the live captures show it: the creator linked to profile.php?id.
      [
        'a friend sharing a stranger’s reel linked to profile.php',
        post(friend({ text: undefined, media: stranger({ creatorHref: 'https://www.facebook.com/profile.php?id=100077' }) })),
      ],
      [
        'a followed page’s own reel',
        post({ author: 'City Library', slot: AGE, media: reel({ creator: 'City Library', caption: 'Story time.' }) }),
      ],
      [
        'a followed page’s own reel, "Following" in it',
        post({
          author: 'City Library',
          slot: AGE,
          media: reel({ creator: 'City Library', caption: 'Story time.', follow: true }).replace('>Follow<', '>Following<'),
        }),
      ],
      ['a followed page sharing a stranger’s reel', post({ author: 'City Library', slot: AGE, media: stranger() })],
      // The same name at another address may be another account: a name never outweighs two different addresses.
      [
        'a reel by the author’s name linked elsewhere (profile.php)',
        post({
          author: 'Trick Shots',
          slot: AGE,
          media: stranger({ creatorHref: 'https://www.facebook.com/profile.php?id=100077' }),
        }),
      ],
      ...(['without words', 'with words of their own'] as const).map((how): [string, string] => [
        `a friend sharing a reel by a same-named account they don’t follow, ${how}`,
        post(
          friend({
            text: how === 'without words' ? undefined : 'My campaign page.',
            media: reel({
              creator: 'Riley Chen',
              caption: 'Vote.',
              follow: true,
              creatorHref: 'https://www.facebook.com/profile.php?id=61550000000001',
            }),
          }),
        ),
      ]),
      // No picture or name in the reel: nothing in it says whose the button is, whoever the post names before it.
      [
        'a reel that names no one',
        post({
          author: 'Trick Shots',
          slot: AGE,
          text: 'Tagging <a href="https://www.facebook.com/trickshots">Trick Shots</a> again.',
          media: stranger(),
        })
          .replace(/<object><a aria-label="See owner profile".*?<\/object>/s, '')
          .replace(/<h5 dir="auto">.*?<\/h5>/s, ''),
      ],
    ])('%s: shown on Balanced', (_name, html) => {
      const p = read(html);
      expect(p.media).toBe('reel');
      expect(p.evidence.map((e) => e.detector)).not.toContain('fb.follow-button');
      expect(decisions(p)).toEqual(SHOWN);
    });

    it('keeps a member’s own reel in a group the account is in; a group it isn’t in folds as such', () => {
      const own = reel({
        creator: 'Alex Kim',
        caption: 'Summit.',
        follow: true,
        creatorHref: 'https://www.facebook.com/groups/hikingontario/user/100009/',
      });
      const joined = read(
        groupPost({ group: 'Hiking Ontario', member: 'Alex Kim', slot: AGE, text: 'Made it.', follow: true, media: own }),
      );
      expect(joined.group?.joined).toBe(true);
      expect(decisions(joined)).toEqual(SHOWN);
      const unjoined = read(
        groupPost({ group: 'Hiking Ontario', member: 'Alex Kim', slot: AGE, text: 'Made it.', join: true, media: own }),
      );
      expect(decisions(unjoined)).toEqual(['show/unknown', 'unjoined-group/unknown', 'unjoined-group/unknown']);
    });

    it('never reads a Follow button in a comment as the author’s, even under a reel', () => {
      const comment =
        '<div aria-label="Comment by Trick Shots" role="article"><a href="https://www.facebook.com/reel/100009/"><h5><object><a href="https://www.facebook.com/trickshots">Trick Shots</a></object></h5><div role="button" tabindex="0">Follow</div></a></div>';
      const p = read(post({ author: 'Trick Shots', slot: AGE, text: 'New trick.', media: comment }));
      expect(p.author.relationship).toBe('unknown');
    });

    // Whether the account follows this poster was not recorded: the captures show only that its name has no Follow
    // button next to it, and the reel's creator (another account) has one.
    it.each([1, 2])(
      'keeps the live capture 2026-10-reels-%i: an account with no Follow next to its name sharing another creator’s reel',
      (n) => {
        const html = readFileSync(join(import.meta.dirname, `../../fixtures/facebook/2026-10-reels-${n}.html`), 'utf8');
        const p = read(html, (item) => item);
        expect(p.media).toBe('reel');
        expect(p.evidence.map((e) => e.detector)).not.toContain('fb.follow-button');
        expect(decisions(p)).toEqual(SHOWN);
      },
    );
  });

  it('still folds activity on a page’s post as activity, and ads as ads', () => {
    const activity = read(
      post({ author: 'Policy Watch', slot: AGE, text: 'Zoning.', follow: true, context: 'Jamie Park commented on this.' }),
    );
    expect(decisions(activity)).toEqual(['show/not-followed', 'network-activity/not-followed', 'network-activity/not-followed']);
    const ad = read(post({ author: 'Shop Example', slot: svgText('SvgT2'), text: 'Autumn sale.', follow: true }));
    expect(decisions(ad)).toEqual(['sponsored/not-followed', 'sponsored/not-followed', 'sponsored/not-followed']);
  });

  it('turns the rule off where the page can’t be read whole: cautious mode and relationship trouble', () => {
    const p = read(post({ author: 'Gadget Daily', slot: AGE, text: 'Six phones compared.', follow: true }));
    expect(ruleFilter(p, balanced, undefined, true)).toBeNull();
    expect(ruleFilter(p, balanced, new Set(['relationship']))).toBeNull();
    expect(ruleFilter(p, { ...balanced, filters: { ...balanced.filters, notFollowed: false } })).toBeNull();
  });
});
