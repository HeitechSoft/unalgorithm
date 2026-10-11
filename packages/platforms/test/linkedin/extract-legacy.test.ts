import { defaultSettings, type PlatformSettings, ruleFilter } from '@unalgorithm/core';
import { beforeEach, describe, expect, it } from 'vitest';
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
import { linkedinAdapter } from '../../src/linkedin/adapter.ts';
import { extractPost, findPostRoots, moduleInfo } from '../../src/linkedin/extract.ts';
import { LINKEDIN_EN } from '../../src/linkedin/markers/en.ts';

const m = LINKEDIN_EN;

function load(...items: string[]) {
  document.body.innerHTML = feedHtml(...items);
  return findPostRoots(document.body);
}

function only(item: string) {
  const roots = load(item);
  expect(roots).toHaveLength(1);
  return extractPost(roots[0] as HTMLElement, m, new Date(2026, 9, 10, 12));
}

const base = defaultSettings().platforms.linkedin;
// Strict "not followed" mode is tested explicitly below; these cases check each other filter on its own.
const li: PlatformSettings = { ...base, filters: { ...base.filters, notFollowed: false } };
const withFilters = (f: Partial<PlatformSettings['filters']>): PlatformSettings => ({ ...li, filters: { ...li.filters, ...f } });

describe('findPostRoots (legacy layout)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns one outermost root per feed item, ignoring nested urn elements and modules', () => {
    const roots = load(NORMAL_POST, PROMOTED_POST, PYMK_MODULE, EVENT_POST, NEW_LAYOUT_POST);
    expect(roots.map((r) => extractPost(r, m).id)).toEqual([
      'li:urn:li:activity:7001',
      'li:urn:li:activity:7002',
      'li:urn:li:activity:7007',
      'li:urn:li:activity:7010',
    ]);
  });

  it('does not treat comment urns as posts', () => {
    expect(load(`<div data-id="urn:li:comment:(activity:7001,99)">A comment</div>`)).toHaveLength(0);
  });
});

describe('extractPost (legacy layout)', () => {
  it('reads author, relationship, age and full text', () => {
    const p = only(NORMAL_POST);
    expect(p).toMatchObject({
      id: 'li:urn:li:activity:7001',
      permalink: 'https://www.linkedin.com/feed/update/urn:li:activity:7001/',
      author: { name: 'Priya Shah', url: 'https://www.linkedin.com/in/priyashah', kind: 'person', relationship: 'followed' },
      age: { text: '3h', hours: 3 },
      media: 'none',
      textComplete: true,
      quality: { authorFound: true, textFound: true },
    });
    expect(p.contextLine).toBeUndefined();
    expect(p.text).toContain('start with the boring paperwork');
    expect(p.text).toContain('\n');
  });

  it('detects promoted posts', () => {
    const p = only(PROMOTED_POST);
    expect(p.signals.sponsored).toBe(true);
    expect(p.author.kind).toBe('page');
    expect(p.author.relationship).toBe('not-followed');
    expect(ruleFilter(p, li)?.reason).toBe('sponsored');
  });

  it('detects suggested posts', () => {
    const p = only(SUGGESTED_POST);
    expect(p.contextLine).toBe('Suggested');
    expect(ruleFilter(p, li)?.reason).toBe('suggested');
  });

  it('separates the "likes this" header from the real author', () => {
    const p = only(ACTIVITY_POST);
    expect(p.contextLine).toBe('Jane Doe likes this');
    expect(p.author).toMatchObject({ name: 'Sam Lee', url: 'https://www.linkedin.com/in/samlee' });
    expect(ruleFilter(p, li)?.reason).toBe('network-activity');
  });

  it('keeps network-activity posts when you already follow the author', () => {
    const p = only(ACTIVITY_FOLLOWED_AUTHOR);
    expect(p.contextLine).toBe('Jane Doe commented on this');
    expect(ruleFilter(p, li)).toBeNull();
  });

  it('only hides connection reposts when that toggle is on', () => {
    const p = only(CONNECTION_REPOST);
    expect(ruleFilter(p, li)).toBeNull();
    expect(ruleFilter(p, withFilters({ reshares: true }))?.reason).toBe('reshare');
  });

  it('strict mode hides authors with a Follow button', () => {
    expect(ruleFilter(only(CONNECTION_REPOST), withFilters({ notFollowed: true }))?.reason).toBe('not-followed');
    expect(ruleFilter(only(NORMAL_POST), withFilters({ notFollowed: true }))).toBeNull();
  });

  it('turning a filter off shows the post', () => {
    expect(ruleFilter(only(PROMOTED_POST), withFilters({ sponsored: false }))).toBeNull();
    expect(ruleFilter(only(SUGGESTED_POST), withFilters({ suggested: false }))).toBeNull();
    expect(ruleFilter(only(ACTIVITY_POST), withFilters({ networkActivity: false }))).toBeNull();
  });

  it('marks posts with a LinkedIn event as event media', () => {
    expect(only(EVENT_POST).media).toBe('event');
  });

  it('falls back to structure and text when LinkedIn class names are missing', () => {
    const p = only(NEW_LAYOUT_POST);
    expect(p.id).toBe('li:urn:li:activity:7010');
    expect(p.author.name).toBe('Robin Chen');
    expect(p.age?.text).toBe('4h');
    expect(p.text).toContain('first ML engineer in Springfield');
  });
});

describe('moduleInfo (legacy layout)', () => {
  it('recognizes People You May Know and ignores posts', () => {
    document.body.innerHTML = feedHtml(PYMK_MODULE, NORMAL_POST);
    const container = document.querySelector('.scaffold-finite-scroll__content') as Element;
    expect(moduleInfo(container.children[0] as Element, m)).toEqual({
      kind: 'people-you-may-know',
      title: 'People you may know',
    });
    expect(moduleInfo(container.children[1] as Element, m)).toBeUndefined();
  });

  it('finds modules placed between posts', () => {
    document.body.innerHTML = feedHtml(NORMAL_POST, PYMK_MODULE, SUGGESTED_POST);
    const scope = linkedinAdapter.feedScope(document) as HTMLElement;
    const items = linkedinAdapter.findItems(scope);
    const modules = linkedinAdapter.siblingModules?.(items, { markers: m, now: new Date() }) ?? [];
    expect(modules.map((x) => x.module.kind)).toEqual(['people-you-may-know']);
  });
});
