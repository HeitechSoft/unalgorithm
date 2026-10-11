import { defaultSettings, type PlatformSettings, ruleFilter, toPostForAI } from '@unalgorithm/core';
import { describe, expect, it } from 'vitest';
import {
  COMPANY_NOT_FOLLOWED,
  FIRST_DEGREE_POST,
  FOLLOWED_BY_POST,
  feed2026,
  HIRING_PROMO,
  JOINED_GROUP_POST,
  LIKES_GROUP_POST,
  POST_WITH_COMMENTS,
  PROMOTED_FOLLOWS_PAGE,
  UNJOINED_GROUP_POST,
} from '../../fixtures/linkedin/y2026.ts';
import { linkedinAdapter } from '../../src/linkedin/adapter.ts';
import { classifyHeader, extractPost, findPostRoots, moduleInfo, parseAge } from '../../src/linkedin/extract.ts';
import { LINKEDIN_EN } from '../../src/linkedin/markers/en.ts';
import { checkAdapterContract } from '../../src/testing/contract.ts';

const m = LINKEDIN_EN;
const li: PlatformSettings = defaultSettings().platforms.linkedin;

function only(item: string) {
  document.body.innerHTML = feed2026(item);
  const roots = findPostRoots(document.body);
  expect(roots).toHaveLength(1);
  const root = roots[0] as HTMLElement;
  return { root, post: extractPost(root, m, new Date(2026, 9, 8, 12)) };
}

describe('2026 feed layout', () => {
  it('finds one root per post card and skips the "Start a post" composer', () => {
    document.body.innerHTML = feed2026(FOLLOWED_BY_POST, PROMOTED_FOLLOWS_PAGE, HIRING_PROMO, FIRST_DEGREE_POST);
    expect(findPostRoots(document.body)).toHaveLength(4);
  });

  it('uses the stable card key as the id and links to the author when there is no URN', () => {
    const { post } = only(FOLLOWED_BY_POST);
    expect(post.id).toBe('li:ck:AAAkeyFollowedBy01');
    expect(post.permalink).toBe('https://www.linkedin.com/in/riley-quinn/recent-activity/all/');
  });

  it('"Followed by X" posts from 2nd-degree authors are network activity', () => {
    const { post } = only(FOLLOWED_BY_POST);
    expect(post).toMatchObject({
      author: { name: 'Riley Quinn', url: 'https://www.linkedin.com/in/riley-quinn/', relationship: 'not-followed' },
      contextLine: 'Followed by Pat Morgan',
      age: { text: '22h' },
    });
    expect(post.signals.networkActivity).toBe(true);
    expect(post.text).toMatch(/^Small teams can ship fast\./);
    expect(post.text).toMatch(/to a week\.$/);
    expect(ruleFilter(post, li)?.reason).toBe('network-activity');
  });

  it('promoted posts are ads even with a "follows this page" header', () => {
    const { post } = only(PROMOTED_FOLLOWS_PAGE);
    expect(post.signals.sponsored).toBe(true);
    expect(post.author.kind).toBe('page');
    expect(post.permalink).toBe('https://www.linkedin.com/company/northwind-analytics/posts/');
    expect(ruleFilter(post, li)?.reason).toBe('sponsored');
  });

  it('group posts surfaced by a like are network activity', () => {
    const { post } = only(LIKES_GROUP_POST);
    expect(post.author.name).toBe('Jordan Blake');
    expect(post.age?.text).toBe('Oct 5');
    expect(ruleFilter(post, li)?.reason).toBe('network-activity');
  });

  it('cards with no author, no post text and no action bar are feed modules', () => {
    const { root } = only(HIRING_PROMO);
    expect(moduleInfo(root, m)).toEqual({ kind: 'jobs', title: "See who's hiring" });
    expect(moduleInfo(only(FIRST_DEGREE_POST).root, m)).toBeUndefined();
  });

  it('keeps posts from 1st-degree connections', () => {
    const { post } = only(FIRST_DEGREE_POST);
    expect(post.author).toMatchObject({ name: 'Morgan Ellis', relationship: 'followed' });
    expect(post.age).toEqual({ text: 'Yesterday', hours: 24 });
    expect(post.contextLine).toBeUndefined();
    expect(ruleFilter(post, li)).toBeNull();
  });

  it('hides header-less posts from pages you do not follow (Balanced on LinkedIn)', () => {
    const { post } = only(COMPANY_NOT_FOLLOWED);
    expect(post.author).toMatchObject({ name: 'Example Robotics', relationship: 'not-followed' });
    expect(ruleFilter(post, li)?.reason).toBe('not-followed');
    expect(ruleFilter(post, { ...li, filters: { ...li.filters, notFollowed: false } })).toBeNull();
  });

  it('reads post text without comments', () => {
    const { post } = only(POST_WITH_COMMENTS);
    expect(post.text).toBe(
      'We moved our onboarding forms online and cut the paperwork from three days to one. What should we automate next?',
    );
  });

  it('hides posts in groups you have not joined, and keeps groups you are in', () => {
    const unjoined = only(UNJOINED_GROUP_POST).post;
    expect(unjoined.group).toEqual({ name: 'Example Product Guild', joined: false });
    expect(ruleFilter(unjoined, li)?.reason).toBe('unjoined-group');
    const joined = only(JOINED_GROUP_POST).post;
    expect(joined.group).toEqual({ name: 'Example Product Guild', joined: true });
    expect(ruleFilter(joined, li)).toBeNull();
    expect(only(FIRST_DEGREE_POST).post.group).toBeUndefined();
  });

  it('passes the adapter contract (read-only, stable ids, outermost items)', () => {
    const html = feed2026(FOLLOWED_BY_POST, PROMOTED_FOLLOWS_PAGE, HIRING_PROMO, FIRST_DEGREE_POST, POST_WITH_COMMENTS);
    expect(checkAdapterContract(linkedinAdapter, html)).toEqual([]);
  });
});

describe('privacy of what the AI could see', () => {
  it('never reads comments as the post text, even when the post has no text box of its own', () => {
    const noOwnText = POST_WITH_COMMENTS.replace(/<div data-testid="expandable-text-box">[\s\S]*?<\/div>/, '');
    const { post } = only(noOwnText);
    expect(post.text).not.toMatch(/Benefits enrolment|Reminders to managers|payroll|Pat Lee|Sam Rivera|Chris Novak/);
  });

  it('lists tagged people so they can be masked before AI', () => {
    const tagged = FIRST_DEGREE_POST.replace(
      'Which HR task',
      'Thanks <a href="https://www.linkedin.com/in/casey-brooks/">Casey Brooks</a> and <a href="https://www.linkedin.com/feed/hashtag/hr/">#hr</a>. Which HR task',
    );
    const { post } = only(tagged);
    expect(post.mentions).toEqual(['Casey Brooks']);
    const masked = toPostForAI(post, { ref: 'p1', redactMentions: true }).text;
    expect(masked).toContain('Thanks @someone and #hr.');
    expect(masked).not.toContain('Casey');
    expect(toPostForAI(post, { ref: 'p1', redactMentions: false }).text).toContain('Casey Brooks');
  });
});

describe('regressions fixed in the port', () => {
  it('does not read an author whose name contains a verb as network activity', () => {
    expect(classifyHeader('Max Likes', m)).toBeNull();
    expect(classifyHeader('Joy Follows', m)).toBeNull();
    expect(classifyHeader('Jane Doe likes this', m)).toBe('activity');
    expect(classifyHeader('Jane Doe and 3 others celebrate this', m)).toBe('activity');
    expect(classifyHeader('Jane Doe follows Acme Corp', m)).toBe('activity');
    expect(classifyHeader('Jane Doe reposted this', m)).toBe('repost');
  });

  it('ignores a Follow button inside a reshared post', () => {
    const inner = `<div class="reshared"><div aria-label="Sam Stranger 3rd+"><a href="https://www.linkedin.com/in/sam-stranger/"><p>Sam Stranger</p></a></div>
      <button aria-label="Follow Sam Stranger">Follow</button><div data-testid="expandable-text-box"><span>Inner text</span></div></div>`;
    const html = FIRST_DEGREE_POST.replace('<div class="e0sbar">', `${inner}<div class="e0sbar">`);
    const { post } = only(html);
    expect(post.author.relationship).toBe('followed');
  });

  it('does not treat an image-only post as a module when the author menu label changes', () => {
    const imageOnly = FIRST_DEGREE_POST.replace(
      /aria-label="(Open control menu|Hide post) for post by [^"]*"/g,
      'aria-label="More"',
    ).replace(/<div data-testid="expandable-text-box">[\s\S]*?<\/div>/, '<img alt="">');
    const { root } = only(imageOnly);
    expect(moduleInfo(root, m)).toBeUndefined();
  });

  it('only runs on the feed itself, never on a single post you opened', () => {
    expect(linkedinAdapter.isFeedPage(new URL('https://www.linkedin.com/feed/'))).toBe(true);
    expect(linkedinAdapter.isFeedPage(new URL('https://www.linkedin.com/feed/update/urn:li:activity:1/'))).toBe(false);
    expect(linkedinAdapter.isFeedPage(new URL('https://www.linkedin.com/in/someone/'))).toBe(false);
  });
});

describe('parseAge', () => {
  const now = new Date(2026, 9, 8, 12, 0);
  it('handles relative, word and date ages', () => {
    expect(parseAge('22h • Edited •', m, now)).toEqual({ text: '22h', hours: 22 });
    expect(parseAge('Yesterday •', m, now)).toEqual({ text: 'Yesterday', hours: 24 });
    expect(parseAge('Oct 5 •', m, now)).toEqual({ text: 'Oct 5', hours: 84 });
    expect(parseAge('Dec 20 •', m, now)?.hours).toBeGreaterThan(24 * 250);
    expect(parseAge('Mr Worldwide SEO', m, now)).toBeUndefined();
  });
});
