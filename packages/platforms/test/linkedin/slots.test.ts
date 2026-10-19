import { defaultSettings, ruleFilter } from '@unalgorithm/core';
import { describe, expect, it } from 'vitest';
import { feedHtml, NORMAL_POST, SUGGESTED_POST } from '../../fixtures/linkedin/legacy.ts';
import { FIRST_DEGREE_POST, FOLLOWED_BY_POST, feed2026, PARTNERSHIP_AD } from '../../fixtures/linkedin/y2026.ts';
import { findPostRoots, readPost } from '../../src/linkedin/extract.ts';
import { LINKEDIN_IDS } from '../../src/linkedin/ids.ts';
import { LINKEDIN_EN } from '../../src/linkedin/markers/en.ts';
import { type LocatorKind, readHead, type SlotName, slotObservations } from '../../src/linkedin/slots.ts';

/**
 * Layered slot locators (ADR 0009 §9, phase B): each part of a post is found by LinkedIn's class name, then a data
 * hook, then an accessible name, then the card's structure, and a report learns which one it took.
 */
const m = LINKEDIN_EN;
const NOW = new Date(2026, 9, 19, 12);
const LOCATOR = /^li\.slot\.[a-z-]+\.(class|testid|aria|structure)$/;

function read(card: string, wrap = feed2026) {
  document.body.innerHTML = wrap(card);
  const [root] = findPostRoots(document.body);
  return readPost(root as HTMLElement, m, NOW);
}
const locators = (r: ReturnType<typeof read>) => r.observations.filter((o) => LOCATOR.test(o)).sort();

describe('slot locators', () => {
  it('2026 layout: the parts are found by data hooks, accessible names and structure, and recorded', () => {
    expect(locators(read(FIRST_DEGREE_POST))).toEqual([
      'li.slot.action-bar.aria',
      'li.slot.actor.aria',
      'li.slot.age.structure',
      'li.slot.text.testid',
    ]);
    expect(locators(read(FOLLOWED_BY_POST))).toContain('li.slot.header.structure');
  });

  it('older layout: every part has its class name, so nothing is recorded', () => {
    expect(locators(read(NORMAL_POST, feedHtml))).toEqual([]);
    expect(locators(read(SUGGESTED_POST, feedHtml))).toEqual([]);
  });

  it("without the post's menu, the author's block is found by its profile link", () => {
    const noMenu = PARTNERSHIP_AD.replace(/<button aria-label="(Open control menu for post|Hide post) by [^"]*"><\/button>/g, '');
    const r = read(noMenu);
    expect(locators(r)).toContain('li.slot.actor.structure');
    expect(r.post.evidence).toContainEqual({ signal: 'sponsored', detector: 'li.promoted.age-slot', strength: 'strong' });
  });

  it('without action bar labels, the bar is found by its shape and the head still ends there', () => {
    const relabelled = FIRST_DEGREE_POST.replace(/<div data-testid="expandable-text-box">[\s\S]*?<\/div>/, '<img alt="">')
      .replace('aria-label="Reaction button state: no reaction"', 'aria-label="React"')
      .replace('aria-label="Comment"', 'aria-label="Reply to post"')
      .replace('aria-label="Repost"', 'aria-label="Share again"');
    const r = read(relabelled);
    expect(locators(r)).toContain('li.slot.action-bar.structure');
    expect(r.post.age?.text).toBe('Yesterday');
    expect(r.post.author.name).toBe('Morgan Ellis');
  });

  it('without the text box hook, the text is read after the age line, and that is recorded', () => {
    const r = read(FIRST_DEGREE_POST.replace('data-testid="expandable-text-box"', 'data-x="1"'));
    expect(r.post.text).toContain('Which HR task would you automate first');
    expect(locators(r)).toContain('li.slot.text.structure');
    expect(r.post.age?.text).toBe('Yesterday');
  });

  it("finds a header line by LinkedIn's data hook", () => {
    const hooked = FIRST_DEGREE_POST.replace(
      '<div class="e0sactor">',
      '<div data-view-name="feed-header-text"><span>Jane Doe likes this</span></div><div class="e0sactor">',
    );
    const r = read(hooked);
    expect(r.post.contextLine).toBe('Jane Doe likes this');
    expect(locators(r)).toContain('li.slot.header.testid');
    expect(ruleFilter(r.post, defaultSettings().platforms.linkedin)).toBeNull(); // a connection's post stays
  });

  it('every locator id the code can record is a listed observation', () => {
    const kinds: Record<SlotName, LocatorKind[]> = {
      actor: ['class', 'aria', 'structure'],
      header: ['class', 'testid', 'structure'],
      age: ['class', 'structure'],
      text: ['class', 'testid'],
      'action-bar': ['class', 'aria', 'structure'],
    };
    const ids = new Set<string>(['li.slot.text.structure']);
    for (const [slot, list] of Object.entries(kinds) as Array<[SlotName, LocatorKind[]]>)
      for (const by of list) for (const id of slotObservations({ [slot]: by })) ids.add(id);
    for (const id of ids) expect(LINKEDIN_IDS.observations as readonly string[], id).toContain(id);
  });
});

describe('readHead', () => {
  it('splits the head into header lines, the author block and its age slot', () => {
    document.body.innerHTML = feed2026(FOLLOWED_BY_POST);
    const [root] = findPostRoots(document.body);
    const head = readHead(root as HTMLElement, m, 'Riley Quinn');
    expect(head.header).toEqual(['Followed by Pat Morgan']);
    expect(head.actor).toEqual(['Riley Quinn', '• 2nd', 'Founder @ Example Labs', 'Visit my website', '22h • Edited •']);
    expect(head.ageSlot).toBe('22h • Edited •');
    // Follow and the menu buttons, not the action bar.
    expect(head.buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Follow Riley Quinn',
      'Open control menu for post by Riley Quinn',
      'Hide post by Riley Quinn',
    ]);
  });
});
